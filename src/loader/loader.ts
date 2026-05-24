import type {
  BpmnModel,
  ProcessUnit,
  Lane,
  FlowNode,
  FlowNodeType,
} from './types.ts';

interface RawNode {
  id: string;
  width?: number;
  height?: number;
  bpmn?: any;
  labels?: any[];
  children?: RawNode[];
  edges?: RawEdge[];
  boundaryEvents?: RawNode[];
  attachedToRef?: string;
  layoutOptions?: any;
}

interface RawEdge {
  id: string;
  sources: string[];
  targets: string[];
  bpmn?: any;
  labels?: any[];
}

interface RawDefinitions {
  id: string;
  children: RawNode[];
}

export function loadFixture(fixturePath: string, json: unknown): BpmnModel {
  assertRawDefinitions(fixturePath, json);
  const def = json;
  const model: BpmnModel = {
    fixture: fixturePath,
    processes: [],
    collaborationMessageFlows: [],
  };

  for (const top of def.children) {
    const type = top.bpmn?.type;
    if (type === 'collaboration') {
      for (const child of top.children ?? []) {
        if (child.bpmn?.type === 'participant') {
          model.processes.push(loadParticipant(child));
        } else {
          throw new Error(
            `[loader] unexpected non-participant inside collaboration: id=${child.id} type=${child.bpmn?.type}`,
          );
        }
      }
      for (const edge of top.edges ?? []) {
        const et = edge.bpmn?.type;
        if (et === 'messageFlow') {
          const { source, target } = readEdgeEndpoints(edge);
          model.collaborationMessageFlows.push({
            id: edge.id,
            source,
            target,
          });
        } else if (et === 'association' || et === 'dataInputAssociation' || et === 'dataOutputAssociation') {
          if (model.processes[0]) {
            const { source, target } = readEdgeEndpoints(edge);
            model.processes[0].decorations.push({
              kind: 'association',
              id: edge.id,
              subtype: et,
              source,
              target,
              associationDirection: edge.bpmn?.associationDirection ?? 'None',
            });
          }
        } else {
          throw new Error(
            `[loader] unknown collaboration edge type: ${et} (id=${edge.id})`,
          );
        }
      }
    } else if (type === 'process') {
      model.processes.push(loadProcess(top, /* isBlackBox */ false));
    } else {
      throw new Error(`[loader] unknown top-level type: ${type} (id=${top.id})`);
    }
  }

  return model;
}

function loadParticipant(raw: RawNode): ProcessUnit {
  const isBlackBox = raw.bpmn?.isBlackBox === true || !raw.children || raw.children.length === 0;
  if (isBlackBox) {
    return {
      id: raw.id,
      name: raw.bpmn?.name ?? raw.id,
      isBlackBox: true,
      lanes: [],
      flowNodes: [],
      sequenceFlows: [],
      subProcesses: [],
      decorations: [],
    };
  }
  const children = raw.children!;
  if (children.length === 1 && children[0]!.bpmn?.type === 'process') {
    const inner = children[0]!;
    return loadProcessBody(inner, raw.id, raw.bpmn?.name ?? inner.bpmn?.name ?? raw.id, false);
  }
  return loadProcessBody(raw, raw.id, raw.bpmn?.name ?? raw.id, false);
}

function loadProcess(raw: RawNode, isBlackBox: boolean): ProcessUnit {
  return loadProcessBody(raw, raw.id, raw.bpmn?.name ?? raw.id, isBlackBox);
}

function loadProcessBody(
  raw: RawNode,
  id: string,
  name: string,
  isBlackBox: boolean,
): ProcessUnit {
  const unit: ProcessUnit = {
    id,
    name,
    isBlackBox,
    lanes: [],
    flowNodes: [],
    sequenceFlows: [],
    subProcesses: [],
    decorations: [],
  };

  walkChildren(raw.children ?? [], unit, /* parentLaneId */ null);

  for (const edge of raw.edges ?? []) {
    const et = edge.bpmn?.type;
    if (et === 'sequenceFlow') {
      const { source, target } = readEdgeEndpoints(edge);
      unit.sequenceFlows.push({
        id: edge.id,
        source,
        target,
        isDefault: edge.bpmn?.isDefault === true,
      });
    } else if (et === 'association' || et === 'dataInputAssociation' || et === 'dataOutputAssociation') {
      const { source, target } = readEdgeEndpoints(edge);
      unit.decorations.push({
        kind: 'association',
        id: edge.id,
        subtype: et,
        source,
        target,
        associationDirection: edge.bpmn?.associationDirection ?? 'None',
      });
    } else if (et === 'messageFlow') {
      const { source, target } = readEdgeEndpoints(edge);
      unit.decorations.push({
        kind: 'messageFlow',
        id: edge.id,
        source,
        target,
      });
    } else {
      throw new Error(`[loader] unknown edge type: ${et} (id=${edge.id})`);
    }
  }

  return unit;
}

function assertRawDefinitions(fixturePath: string, json: unknown): asserts json is RawDefinitions {
  if (!isRecord(json)) {
    throw new Error(`[loader] ${fixturePath} must be a BPMN definitions object`);
  }
  if (!Array.isArray(json.children)) {
    throw new Error(`[loader] ${fixturePath} must contain a children array`);
  }
}

function readEdgeEndpoints(edge: RawEdge): { source: string; target: string } {
  const source = readEdgeEndpoint(edge, 'source');
  const target = readEdgeEndpoint(edge, 'target');
  return { source, target };
}

function readEdgeEndpoint(edge: RawEdge, side: 'source' | 'target'): string {
  const values = side === 'source' ? edge.sources : edge.targets;
  const value = Array.isArray(values) ? values[0] : undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`[loader] edge ${edge.id} missing ${side} endpoint`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walkChildren(
  children: RawNode[],
  unit: ProcessUnit,
  parentLaneId: string | null,
) {
  for (const child of children) {
    const t = child.bpmn?.type as string | undefined;
    if (!t) {
      throw new Error(`[loader] child without bpmn.type: id=${child.id}`);
    }
    if (t === 'lane') {
      const lane: Lane = {
        id: child.id,
        name: child.bpmn?.name ?? child.id,
        memberRefs: [],
        parentLaneId,
      };
      unit.lanes.push(lane);
      const grandChildren = child.children ?? [];
      const beforeCount = unit.flowNodes.length;
      walkChildren(grandChildren, unit, lane.id);
      for (let i = beforeCount; i < unit.flowNodes.length; i++) {
        lane.memberRefs.push(unit.flowNodes[i]!.id);
      }
    } else if (t === 'subProcess' || t === 'adHocSubProcess' || t === 'transaction') {
      const fn = makeFlowNode(child, t as FlowNodeType);
      fn.subProcessId = child.id;
      unit.flowNodes.push(fn);
      const inner = loadProcessBody(child, child.id, child.bpmn?.name ?? child.id, false);
      unit.subProcesses.push(inner);
      collectBoundaryEvents(child, unit);
    } else if (
      t === 'startEvent' ||
      t === 'endEvent' ||
      t === 'intermediateCatchEvent' ||
      t === 'intermediateThrowEvent' ||
      t === 'task' ||
      t === 'userTask' ||
      t === 'serviceTask' ||
      t === 'sendTask' ||
      t === 'receiveTask' ||
      t === 'scriptTask' ||
      t === 'manualTask' ||
      t === 'businessRuleTask' ||
      t === 'callActivity' ||
      t === 'exclusiveGateway' ||
      t === 'parallelGateway' ||
      t === 'inclusiveGateway' ||
      t === 'eventBasedGateway' ||
      t === 'complexGateway'
    ) {
      unit.flowNodes.push(makeFlowNode(child, t as FlowNodeType));
      collectBoundaryEvents(child, unit);
    } else if (t === 'dataObject' || t === 'dataObjectReference' || t === 'dataStoreReference') {
      unit.decorations.push({
        kind: 'artifact',
        id: child.id,
        subtype: t,
        name: child.bpmn?.name ?? child.id,
        width: child.width ?? (t === 'dataStoreReference' ? 50 : 36),
        height: child.height ?? 50,
      });
    } else if (t === 'textAnnotation') {
      unit.decorations.push({
        kind: 'artifact',
        id: child.id,
        subtype: 'textAnnotation',
        name: child.bpmn?.text ?? child.bpmn?.name ?? child.id,
        width: child.width ?? 100,
        height: child.height ?? 40,
      });
    } else if (t === 'group') {
      // Group 是一组节点的包围框，本期暂不渲染（width/height 由 groupedElements 决定，需要单独算）
      unit.decorations.push({
        kind: 'artifact',
        id: child.id,
        subtype: 'group',
        name: child.bpmn?.name ?? child.id,
        width: 0, height: 0,
      });
    } else {
      throw new Error(`[loader] unknown flow node type: ${t} (id=${child.id})`);
    }
  }
}

function makeFlowNode(raw: RawNode, type: FlowNodeType): FlowNode {
  const ioSpec = raw.bpmn?.ioSpecification;
  const dataInputs = Array.isArray(ioSpec?.dataInputs)
    ? ioSpec.dataInputs as Array<{ name?: string }>
    : [];
  const dataOutputs = Array.isArray(ioSpec?.dataOutputs)
    ? ioSpec.dataOutputs as Array<{ name?: string }>
    : [];
  return {
    id: raw.id,
    type,
    name: raw.bpmn?.name ?? raw.id,
    subProcessId: null,
    boundaryEventIds: (raw.boundaryEvents ?? []).map(b => b.id),
    isExpanded: raw.bpmn?.isExpanded === true,
    ioInputCount: dataInputs.length,
    ioOutputCount: dataOutputs.length,
    ioInputNames: dataInputs.map((d) => d.name ?? ''),
    ioOutputNames: dataOutputs.map((d) => d.name ?? ''),
  };
}

function collectBoundaryEvents(host: RawNode, unit: ProcessUnit) {
  for (const be of host.boundaryEvents ?? []) {
    unit.decorations.push({
      kind: 'boundaryEvent',
      id: be.id,
      host: host.id,
      eventType: be.bpmn?.eventDefinitionType ?? 'none',
      isInterrupting: be.bpmn?.isInterrupting !== false,
      outgoingFlowIds: [],
    });
    unit.flowNodes.push({
      id: be.id,
      type: 'boundaryEvent',
      name: be.bpmn?.name ?? be.id,
      subProcessId: null,
      boundaryEventIds: [],
      isExpanded: false,
      ioInputCount: 0,
      ioOutputCount: 0,
    });
  }
}
