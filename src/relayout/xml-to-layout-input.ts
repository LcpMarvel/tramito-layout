import BpmnModdle from 'bpmn-moddle';
import type { ElkBpmnGraph } from '../serializer/types/elk-bpmn.ts';

type ModdleNode = Record<string, unknown> & { $type?: string; id?: string; name?: string };

const FLOW_NODE_TYPES = new Set([
  'startEvent',
  'endEvent',
  'intermediateCatchEvent',
  'intermediateThrowEvent',
  'boundaryEvent',
  'task',
  'userTask',
  'serviceTask',
  'sendTask',
  'receiveTask',
  'scriptTask',
  'manualTask',
  'businessRuleTask',
  'callActivity',
  'subProcess',
  'adHocSubProcess',
  'transaction',
  'exclusiveGateway',
  'parallelGateway',
  'inclusiveGateway',
  'eventBasedGateway',
  'complexGateway',
]);

const ARTIFACT_TYPES = new Set([
  'dataObject',
  'dataObjectReference',
  'dataStoreReference',
  'textAnnotation',
  'group',
]);

export interface XmlLayoutExtraction {
  rawJson: ElkBpmnGraph;
  semanticIds: Set<string>;
}

export async function xmlToLayoutInput(xml: string): Promise<XmlLayoutExtraction> {
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(xml);
  const definitions = asNode(rootElement, 'definitions');
  const rootElements = arrayOfNodes(definitions.rootElements);
  const semanticIds = collectSemanticIds(definitions);
  const processes = rootElements.filter((node) => localType(node) === 'process');
  const collaborations = rootElements.filter((node) => localType(node) === 'collaboration');
  const processById = new Map(processes.map((process) => [requireId(process, 'process'), process]));

  const rawJson = {
    id: definitions.id ?? 'Definitions',
    bpmn: {
      targetNamespace: stringProp(definitions, 'targetNamespace') ?? 'http://bpmn.io/schema/bpmn',
      exporter: stringProp(definitions, 'exporter'),
      exporterVersion: stringProp(definitions, 'exporterVersion'),
    },
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': 60,
      'elk.layered.spacing.nodeNodeBetweenLayers': 100,
    },
    messages: rootElements
      .filter((node) => localType(node) === 'message')
      .map((node) => ({ id: requireId(node, 'message'), name: node.name })),
    signals: rootElements
      .filter((node) => localType(node) === 'signal')
      .map((node) => ({ id: requireId(node, 'signal'), name: node.name })),
    errors: rootElements
      .filter((node) => localType(node) === 'error')
      .map((node) => ({ id: requireId(node, 'error'), name: node.name, errorCode: stringProp(node, 'errorCode') })),
    escalations: rootElements
      .filter((node) => localType(node) === 'escalation')
      .map((node) => ({ id: requireId(node, 'escalation'), name: node.name, escalationCode: stringProp(node, 'escalationCode') })),
    children: [] as unknown[],
  };

  if (collaborations.length > 0) {
    rawJson.children = collaborations.map((collaboration) => buildCollaboration(collaboration, processById));
  } else {
    rawJson.children = processes.map((process) => buildProcess(process));
  }

  return { rawJson: rawJson as ElkBpmnGraph, semanticIds };
}

function buildCollaboration(collaboration: ModdleNode, processById: Map<string, ModdleNode>) {
  const participants = arrayOfNodes(collaboration.participants).map((participant) => {
    const processRef = refId(participant.processRef);
    const process = processRef ? processById.get(processRef) : undefined;
    const isBlackBox = !process;
    return {
      id: requireId(participant, 'participant'),
      bpmn: {
        type: 'participant' as const,
        name: participant.name,
        processRef,
        isBlackBox,
      },
      layoutOptions: {
        'elk.partitioning.activate': true,
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
      },
      children: process ? buildProcessChildren(process) : [],
      edges: process ? buildProcessEdges(process) : [],
    };
  });

  return {
    id: requireId(collaboration, 'collaboration'),
    bpmn: {
      type: 'collaboration' as const,
      name: collaboration.name,
      isClosed: booleanProp(collaboration, 'isClosed'),
    },
    children: participants,
    edges: arrayOfNodes(collaboration.messageFlows).map((flow) => ({
      id: requireId(flow, 'messageFlow'),
      sources: [requireRef(flow, 'sourceRef', 'messageFlow')] as [string],
      targets: [requireRef(flow, 'targetRef', 'messageFlow')] as [string],
      bpmn: {
        type: 'messageFlow' as const,
        name: flow.name,
        messageRef: refId(flow.messageRef),
      },
      labels: flow.name ? [{ text: flow.name }] : undefined,
    })),
  };
}

function buildProcess(process: ModdleNode) {
  return {
    id: requireId(process, 'process'),
    bpmn: {
      type: 'process' as const,
      name: process.name,
      isExecutable: booleanProp(process, 'isExecutable') ?? true,
      processType: stringProp(process, 'processType') as 'None' | 'Public' | 'Private' | undefined,
      isClosed: booleanProp(process, 'isClosed'),
    },
    children: buildProcessChildren(process),
    edges: buildProcessEdges(process),
  };
}

function buildProcessChildren(process: ModdleNode) {
  const flowElements = arrayOfNodes(process.flowElements);
  const nodeById = new Map<string, ModdleNode>();
  const boundaryEvents: ModdleNode[] = [];
  const artifacts = arrayOfNodes(process.artifacts).filter((node) => ARTIFACT_TYPES.has(localType(node)));

  for (const element of flowElements) {
    const type = localType(element);
    if (type === 'boundaryEvent') {
      boundaryEvents.push(element);
    } else if (FLOW_NODE_TYPES.has(type)) {
      nodeById.set(requireId(element, type), element);
    } else if (ARTIFACT_TYPES.has(type)) {
      nodeById.set(requireId(element, type), element);
    }
  }

  const boundaryByHost = new Map<string, ModdleNode[]>();
  for (const boundary of boundaryEvents) {
    const hostId = requireRef(boundary, 'attachedToRef', 'boundaryEvent');
    const bucket = boundaryByHost.get(hostId) ?? [];
    bucket.push(boundary);
    boundaryByHost.set(hostId, bucket);
  }

  const assigned = new Set<string>();
  const laneSets = arrayOfNodes(process.laneSets);
  const laneChildren = laneSets.flatMap((laneSet) =>
    arrayOfNodes(laneSet.lanes).map((lane, index) => buildLane(lane, nodeById, boundaryByHost, assigned, index)),
  );

  const directNodes = Array.from(nodeById.values())
    .filter((node) => !assigned.has(requireId(node, localType(node))))
    .map((node) => buildChildNode(node, boundaryByHost));

  return [...laneChildren, ...directNodes, ...artifacts.map((node) => buildArtifactNode(node))];
}

function buildLane(
  lane: ModdleNode,
  nodeById: Map<string, ModdleNode>,
  boundaryByHost: Map<string, ModdleNode[]>,
  assigned: Set<string>,
  index: number,
): Record<string, unknown> {
  const flowNodeIds = arrayOfNodes(lane.flowNodeRef)
    .map((ref) => refId(ref))
    .filter((id): id is string => id !== undefined);
  const childLaneSet = asOptionalNode(lane.childLaneSet);
  const childLanes: Record<string, unknown>[] = childLaneSet
    ? arrayOfNodes(childLaneSet.lanes).map((child, childIndex) => buildLane(child, nodeById, boundaryByHost, assigned, childIndex))
    : [];
  const children: unknown[] = [...childLanes];

  for (const nodeId of flowNodeIds) {
    const node = nodeById.get(nodeId);
    if (!node || assigned.has(nodeId)) continue;
    children.push(buildChildNode(node, boundaryByHost));
    assigned.add(nodeId);
  }

  return {
    id: requireId(lane, 'lane'),
    bpmn: {
      type: 'lane' as const,
      name: lane.name,
    },
    layoutOptions: { 'elk.partitioning.partition': index },
    children,
  };
}

function buildChildNode(node: ModdleNode, boundaryByHost: Map<string, ModdleNode[]>) {
  const type = localType(node);
  if (ARTIFACT_TYPES.has(type)) return buildArtifactNode(node);

  const id = requireId(node, type);
  const raw: Record<string, unknown> = {
    id,
    bpmn: buildBpmnInfo(node),
    labels: node.name ? [{ text: node.name }] : undefined,
  };
  const nested = buildNestedProcessChildrenAndEdges(node);
  if (nested.children.length > 0) raw.children = nested.children;
  if (nested.edges.length > 0) raw.edges = nested.edges;
  const boundaryEvents = boundaryByHost.get(id);
  if (boundaryEvents && boundaryEvents.length > 0) {
    raw.boundaryEvents = boundaryEvents.map((boundary) => ({
      id: requireId(boundary, 'boundaryEvent'),
      attachedToRef: id,
      bpmn: buildBpmnInfo(boundary),
      labels: boundary.name ? [{ text: boundary.name }] : undefined,
    }));
  }
  return raw;
}

function buildNestedProcessChildrenAndEdges(node: ModdleNode): { children: unknown[]; edges: unknown[] } {
  if (!isSubprocessType(localType(node))) return { children: [], edges: [] };
  const pseudoProcess: ModdleNode = {
    id: node.id,
    flowElements: node.flowElements,
    artifacts: node.artifacts,
    laneSets: node.laneSets,
  };
  return {
    children: buildProcessChildren(pseudoProcess),
    edges: buildProcessEdges(pseudoProcess),
  };
}

function buildArtifactNode(node: ModdleNode) {
  const type = localType(node);
  return {
    id: requireId(node, type),
    bpmn: {
      type,
      name: node.name,
      text: stringProp(node, 'text'),
      textFormat: stringProp(node, 'textFormat'),
      dataObjectRef: refId(node.dataObjectRef),
      dataStoreRef: refId(node.dataStoreRef),
      itemSubjectRef: refId(node.itemSubjectRef),
      isCollection: booleanProp(node, 'isCollection'),
      capacity: numberProp(node, 'capacity'),
      isUnlimited: booleanProp(node, 'isUnlimited'),
      categoryValueRef: refId(node.categoryValueRef),
    },
  };
}

function buildProcessEdges(process: ModdleNode) {
  const flowElements = arrayOfNodes(process.flowElements);
  const sequenceFlows = flowElements
    .filter((element) => localType(element) === 'sequenceFlow')
    .map((flow) => ({
      id: requireId(flow, 'sequenceFlow'),
      sources: [requireRef(flow, 'sourceRef', 'sequenceFlow')] as [string],
      targets: [requireRef(flow, 'targetRef', 'sequenceFlow')] as [string],
      bpmn: {
        type: 'sequenceFlow' as const,
        name: flow.name,
        isDefault: false,
      },
      labels: flow.name ? [{ text: flow.name }] : undefined,
    }));
  const associations = arrayOfNodes(process.artifacts)
    .filter((artifact) => localType(artifact) === 'association')
    .map((association) => ({
      id: requireId(association, 'association'),
      sources: [requireRef(association, 'sourceRef', 'association')] as [string],
      targets: [requireRef(association, 'targetRef', 'association')] as [string],
      bpmn: {
        type: 'association' as const,
        associationDirection: stringProp(association, 'associationDirection') ?? 'None',
      },
    }));
  return [...sequenceFlows, ...associations];
}

function buildBpmnInfo(node: ModdleNode): Record<string, unknown> {
  const type = localType(node);
  const bpmn: Record<string, unknown> = {
    type,
    name: node.name,
  };

  if (type === 'boundaryEvent') {
    bpmn.eventDefinitionType = eventDefinitionType(node);
    bpmn.isInterrupting = booleanProp(node, 'cancelActivity') ?? true;
  } else if (type.endsWith('Event')) {
    bpmn.eventDefinitionType = eventDefinitionType(node);
  } else if (type.endsWith('Gateway')) {
    bpmn.gatewayDirection = stringProp(node, 'gatewayDirection');
  } else if (isSubprocessType(type)) {
    bpmn.isExpanded = booleanProp(node, 'isExpanded') ?? true;
    bpmn.triggeredByEvent = booleanProp(node, 'triggeredByEvent');
  } else if (type === 'callActivity') {
    bpmn.calledElement = stringProp(node, 'calledElement');
    bpmn.calledElementBinding = stringProp(node, 'calledElementBinding');
    bpmn.calledElementVersion = stringProp(node, 'calledElementVersion');
    bpmn.inheritBusinessKey = booleanProp(node, 'inheritBusinessKey');
  }

  const ioSpecification = buildIoSpecification(node);
  if (ioSpecification) bpmn.ioSpecification = ioSpecification;
  const inputAssociations = buildDataInputAssociations(node);
  const outputAssociations = buildDataOutputAssociations(node);
  if (inputAssociations) bpmn.dataInputAssociations = inputAssociations;
  if (outputAssociations) bpmn.dataOutputAssociations = outputAssociations;

  return bpmn;
}

function buildIoSpecification(node: ModdleNode) {
  const io = asOptionalNode(node.ioSpecification);
  if (!io) return undefined;
  return {
    dataInputs: arrayOfNodes(io.dataInputs).map((dataInput) => ({
      id: requireId(dataInput, 'dataInput'),
      name: dataInput.name,
      itemSubjectRef: refId(dataInput.itemSubjectRef),
      isCollection: booleanProp(dataInput, 'isCollection'),
    })),
    dataOutputs: arrayOfNodes(io.dataOutputs).map((dataOutput) => ({
      id: requireId(dataOutput, 'dataOutput'),
      name: dataOutput.name,
      itemSubjectRef: refId(dataOutput.itemSubjectRef),
      isCollection: booleanProp(dataOutput, 'isCollection'),
    })),
    inputSets: arrayOfNodes(io.inputSets).map((inputSet) => ({
      id: inputSet.id,
      name: inputSet.name,
      dataInputRefs: arrayOfNodes(inputSet.dataInputRefs)
        .map((ref) => refId(ref))
        .filter((id): id is string => id !== undefined),
    })),
    outputSets: arrayOfNodes(io.outputSets).map((outputSet) => ({
      id: outputSet.id,
      name: outputSet.name,
      dataOutputRefs: arrayOfNodes(outputSet.dataOutputRefs)
        .map((ref) => refId(ref))
        .filter((id): id is string => id !== undefined),
    })),
  };
}

function buildDataInputAssociations(node: ModdleNode) {
  const associations = arrayOfNodes(node.dataInputAssociations);
  if (!Array.isArray(node.dataInputAssociations)) return undefined;
  return associations.map((association) => ({
    id: requireId(association, 'dataInputAssociation'),
    sourceRefs: arrayOfNodes(association.sourceRef)
      .map((ref) => refId(ref))
      .filter((id): id is string => id !== undefined),
    targetRef: refId(association.targetRef),
  }));
}

function buildDataOutputAssociations(node: ModdleNode) {
  const associations = arrayOfNodes(node.dataOutputAssociations);
  if (!Array.isArray(node.dataOutputAssociations)) return undefined;
  return associations.map((association) => ({
    id: requireId(association, 'dataOutputAssociation'),
    sourceRefs: arrayOfNodes(association.sourceRef)
      .map((ref) => refId(ref))
      .filter((id): id is string => id !== undefined),
    targetRef: refId(association.targetRef),
  }));
}

function collectSemanticIds(definitions: ModdleNode): Set<string> {
  const ids = new Set<string>();
  const seen = new Set<unknown>();
  const visit = (value: unknown): void => {
    if (!isRecord(value) || seen.has(value)) return;
    seen.add(value);
    const node = value as ModdleNode;
    if (typeof node.id === 'string') ids.add(node.id);
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('$')) continue;
      if (key === 'diagrams') continue;
      if (Array.isArray(child)) {
        for (const item of child) visit(item);
      } else {
        visit(child);
      }
    }
  };
  for (const rootElement of arrayOfNodes(definitions.rootElements)) visit(rootElement);
  return ids;
}

function eventDefinitionType(node: ModdleNode): string {
  const eventDefinitions = arrayOfNodes(node.eventDefinitions);
  const first = eventDefinitions[0];
  if (!first) return 'none';
  const type = localType(first);
  if (type.endsWith('EventDefinition')) return lowerFirst(type.slice(0, -'EventDefinition'.length));
  return 'none';
}

function localType(node: ModdleNode): string {
  const type = node.$type ?? '';
  const local = type.includes(':') ? type.split(':').pop()! : type;
  return lowerFirst(local);
}

function isSubprocessType(type: string): boolean {
  return type === 'subProcess' || type === 'adHocSubProcess' || type === 'transaction';
}

function lowerFirst(value: string): string {
  if (value.length === 0) return value;
  return value[0]!.toLowerCase() + value.slice(1);
}

function asNode(value: unknown, label: string): ModdleNode {
  if (!isRecord(value)) throw new Error(`[relayout] expected ${label} to be a BPMN moddle object`);
  return value as ModdleNode;
}

function asOptionalNode(value: unknown): ModdleNode | undefined {
  return isRecord(value) ? value as ModdleNode : undefined;
}

function arrayOfNodes(value: unknown): ModdleNode[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => item as ModdleNode);
}

function requireId(node: ModdleNode, label: string): string {
  if (typeof node.id !== 'string' || node.id.length === 0) {
    throw new Error(`[relayout] ${label} is missing required id`);
  }
  return node.id;
}

function requireRef(node: ModdleNode, key: string, label: string): string {
  const id = refId(node[key]);
  if (!id) throw new Error(`[relayout] ${label} ${node.id ?? '<missing id>'} is missing ${key}`);
  return id;
}

function refId(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function stringProp(node: ModdleNode, key: string): string | undefined {
  const value = node[key];
  return typeof value === 'string' ? value : undefined;
}

function booleanProp(node: ModdleNode, key: string): boolean | undefined {
  const value = node[key];
  return typeof value === 'boolean' ? value : undefined;
}

function numberProp(node: ModdleNode, key: string): number | undefined {
  const value = node[key];
  return typeof value === 'number' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
