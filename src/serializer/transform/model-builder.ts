/**
 * Model Builder
 * Builds the intermediate BPMN model from layouted ELK-BPMN graph.
 * This module focuses on building the BPMN process/collaboration structure,
 * while DiagramBuilder handles the visual diagram (shapes and edges).
 */

import type { LayoutedGraph } from '../types/elk-output';
import type {
  MessageDefinition,
  SignalDefinition,
  ErrorDefinition,
  EscalationDefinition,
} from '../types/elk-bpmn';
import { ReferenceResolver } from './reference-resolver';
import { LaneResolver, type LaneSetInfo } from './lane-resolver';
import { DiagramBuilder } from './diagram-builder';
import type {
  BpmnModel,
  DefinitionsModel,
  CollaborationModel,
  ProcessModel,
  FlowElementModel,
  ArtifactModel,
  DiagramModel,
  CollaborationNode,
  ParticipantNode,
  ProcessNode,
  ChildNode,
  BoundaryEventNode,
  EdgeNode,
  ArtifactNode,
  IoSpecificationModel,
} from './model-types';
import type { IoSpecification } from '../types/elk-bpmn';

// Re-export types for external consumers
export type {
  BpmnModel,
  DefinitionsModel,
  CollaborationModel,
  ProcessModel,
  FlowElementModel,
  ArtifactModel,
  DiagramModel,
  ShapeModel,
  EdgeModel,
  BoundsModel,
  PointModel,
  LabelModel,
  PlaneModel,
  ParticipantModel,
  MessageFlowModel,
  SequenceFlowModel,
  DataAssociationModel,
  RootElement,
  IoSpecificationModel,
  DataInputModel,
  DataOutputModel,
  InputSetModel,
  OutputSetModel,
} from './model-types';

// ============================================================================
// Model Builder
// ============================================================================

export class ModelBuilder {
  private refResolver: ReferenceResolver;
  private laneResolver: LaneResolver;
  private diagramBuilder: DiagramBuilder;

  constructor() {
    this.refResolver = new ReferenceResolver();
    this.laneResolver = new LaneResolver();
    this.diagramBuilder = new DiagramBuilder();
  }

  /**
   * Build the complete BPMN model from a layouted graph
   */
  build(graph: LayoutedGraph): BpmnModel {
    // Reset resolvers
    this.laneResolver.reset();

    // Resolve references first
    this.refResolver.resolve(graph);

    // Build definitions model
    const definitions = this.buildDefinitions(graph);

    // Build diagram model using DiagramBuilder
    const diagram = this.diagramBuilder.build(graph, definitions);

    return { definitions, diagram };
  }

  /**
   * Get the reference resolver
   */
  getRefResolver(): ReferenceResolver {
    return this.refResolver;
  }

  /**
   * Build definitions model
   */
  private buildDefinitions(graph: LayoutedGraph): DefinitionsModel {
    const definitions: DefinitionsModel = {
      id: graph.id,
      targetNamespace: graph.bpmn?.targetNamespace ?? 'http://bpmn.io/schema/bpmn',
      exporter: graph.bpmn?.exporter ?? 'bpmn-elk-layout',
      exporterVersion: graph.bpmn?.exporterVersion ?? '1.0.0',
      messages: graph.messages ?? [],
      signals: graph.signals ?? [],
      errors: graph.errors ?? [],
      escalations: graph.escalations ?? [],
      rootElements: [],
    };

    // Process top-level children
    for (const child of graph.children) {
      const bpmnType = (child as { bpmn: { type: string } }).bpmn?.type;

      if (!bpmnType) {
        throw new Error(`Invalid graph child: missing bpmn.type property for node ${(child as any).id}`);
      }

      if (bpmnType === 'collaboration') {
        definitions.rootElements.push(this.buildCollaboration(child as CollaborationNode));

        // Also add processes for each non-black-box participant
        const collab = child as CollaborationNode;
        for (const participant of collab.children ?? []) {
          if (!participant.bpmn?.isBlackBox) {
            const processId = participant.bpmn?.processRef ?? `Process_${participant.id}`;
            definitions.rootElements.push(
              this.buildProcessFromParticipant(participant, processId)
            );
          }
        }
      } else if (bpmnType === 'process') {
        definitions.rootElements.push(this.buildProcess(child as ProcessNode));
      } else {
        throw new Error(`Invalid top-level element type: "${bpmnType}". Only "process" or "collaboration" are allowed at the top level.`);
      }
    }

    if (definitions.rootElements.length === 0) {
      throw new Error('Cannot create BPMN definitions: no valid process or collaboration found in the graph.');
    }

    return definitions;
  }

  /**
   * Build collaboration model
   */
  private buildCollaboration(collab: CollaborationNode): CollaborationModel {
    return {
      type: 'collaboration',
      id: collab.id,
      name: collab.bpmn?.name,
      isClosed: collab.bpmn?.isClosed,
      participants: (collab.children ?? []).map((p) => ({
        id: p.id,
        name: p.bpmn?.name,
        processRef: p.bpmn?.processRef ?? `Process_${p.id}`,
        isBlackBox: p.bpmn?.isBlackBox,
        participantMultiplicity: p.bpmn?.participantMultiplicity,
      })),
      messageFlows: (collab.edges ?? [])
        .map((e) => ({
          id: e.id,
          name: e.bpmn?.name,
          sourceRef: this.requireEdgeEndpoint(e, 'source'),
          targetRef: this.requireEdgeEndpoint(e, 'target'),
          messageRef: e.bpmn?.messageRef,
        })),
    };
  }

  /**
   * Build process model from participant
   */
  private buildProcessFromParticipant(
    participant: ParticipantNode,
    processId: string
  ): ProcessModel {
    const process: ProcessModel = {
      type: 'process',
      id: processId,
      name: participant.bpmn?.name,
      isExecutable: true,
      laneSet: this.laneResolver.resolve(participant),
      flowElements: [],
      artifacts: [],
    };

    // Collect all flow elements
    this.collectFlowElements(participant.children ?? [], process.flowElements);

    // Collect sequence flows
    this.collectSequenceFlows(participant.edges ?? [], process.flowElements);

    // Collect data associations and attach to flow elements (BPMN spec compliance)
    this.collectDataAssociations(participant.edges ?? [], process.flowElements);

    return process;
  }

  /**
   * Build process model
   */
  private buildProcess(processNode: ProcessNode): ProcessModel {
    const process: ProcessModel = {
      type: 'process',
      id: processNode.id,
      name: processNode.bpmn?.name,
      isExecutable: processNode.bpmn?.isExecutable ?? true,
      processType: processNode.bpmn?.processType,
      isClosed: processNode.bpmn?.isClosed,
      laneSet: this.laneResolver.resolve(processNode),
      flowElements: [],
      artifacts: [],
    };

    // Collect all flow elements
    this.collectFlowElements(processNode.children ?? [], process.flowElements);

    // Collect sequence flows
    this.collectSequenceFlows(processNode.edges ?? [], process.flowElements);

    // Collect artifacts
    if (processNode.artifacts) {
      for (const artifact of processNode.artifacts) {
        process.artifacts.push(this.buildArtifact(artifact));
      }
    }

    // Collect associations from edges
    this.collectAssociations(processNode.edges ?? [], process.artifacts);

    // Collect data associations and attach to flow elements (BPMN spec compliance)
    this.collectDataAssociations(processNode.edges ?? [], process.flowElements);

    return process;
  }

  /**
   * Collect flow elements recursively
   */
  private collectFlowElements(children: ChildNode[], elements: FlowElementModel[]): void {
    for (const child of children) {
      // Skip lanes - just traverse their children
      if (child.bpmn?.type === 'lane') {
        this.collectFlowElements(child.children ?? [], elements);
        continue;
      }

      // Skip nested process - traverse its children and edges
      // This handles the case where participant > children > [process > children: [flowNodes]]
      if (child.bpmn?.type === 'process') {
        this.collectFlowElements(child.children ?? [], elements);
        this.collectSequenceFlows(child.edges ?? [], elements);
        continue;
      }

      // Build flow element
      const flowElement = this.buildFlowElement(child);
      elements.push(flowElement);

      // For expanded subprocesses, collect nested elements into the subprocess itself
      if (child.bpmn?.isExpanded && child.children) {
        flowElement.flowElements = [];
        flowElement.artifacts = [];
        this.collectFlowElements(child.children, flowElement.flowElements);
        // Collect nested sequence flows into subprocess
        if (child.edges) {
          this.collectSequenceFlows(child.edges, flowElement.flowElements);
        }
      } else if (child.edges) {
        // Collect nested sequence flows for non-expanded containers
        this.collectSequenceFlows(child.edges, elements);
      }

      // Add boundary events (after subprocess content processing)
      if (child.boundaryEvents) {
        for (const be of child.boundaryEvents) {
          elements.push(this.buildBoundaryEvent(be));
        }
      }
    }
  }

  /**
   * Build a flow element model
   */
  private buildFlowElement(node: ChildNode): FlowElementModel {
    const incoming = this.refResolver.getIncomingSequenceFlows(node.id);
    const outgoing = this.refResolver.getOutgoingSequenceFlows(node.id);

    const flowElement: FlowElementModel = {
      type: node.bpmn?.type ?? 'task',
      id: node.id,
      name: node.bpmn?.name,
      incoming,
      outgoing,
      properties: this.extractProperties(node.bpmn ?? {}),
    };

    // Extract ioSpecification if present (for tasks)
    const ioSpec = (node.bpmn as { ioSpecification?: IoSpecification } | undefined)?.ioSpecification;
    if (ioSpec) {
      flowElement.ioSpecification = this.buildIoSpecification(ioSpec, node.id);

      // Auto-generate dataInputAssociation for only the first dataInput
      // Only the topmost input in the vertical stack gets a dashed line to the task
      const dataInputs = ioSpec.dataInputs ?? [];
      if (dataInputs.length > 0) {
        const firstInput = dataInputs[0];
        if (!firstInput) {
          throw new Error(`Task ${node.id} has an invalid empty dataInputs entry`);
        }
        flowElement.dataInputAssociations = [{
          id: `${firstInput.id ?? `${node.id}_input_0`}_assoc`,
          sourceRef: firstInput.id ?? `${node.id}_input_0`,
          targetRef: node.id,
        }];
      }

      // Auto-generate dataOutputAssociation for only the first dataOutput
      // Only the topmost output in the vertical stack gets a dashed line from the task
      const dataOutputs = ioSpec.dataOutputs ?? [];
      if (dataOutputs.length > 0) {
        const firstOutput = dataOutputs[0];
        if (!firstOutput) {
          throw new Error(`Task ${node.id} has an invalid empty dataOutputs entry`);
        }
        flowElement.dataOutputAssociations = [{
          id: `${firstOutput.id ?? `${node.id}_output_0`}_assoc`,
          sourceRef: node.id,
          targetRef: firstOutput.id ?? `${node.id}_output_0`,
        }];
      }
    }

    return flowElement;
  }

  /**
   * Build ioSpecification model from input
   */
  private buildIoSpecification(ioSpec: IoSpecification, taskId: string): IoSpecificationModel {
    const dataInputs = (ioSpec.dataInputs ?? []).map((di, index) => ({
      id: di.id ?? `${taskId}_input_${index}`,
      name: di.name,
      itemSubjectRef: di.itemSubjectRef,
      isCollection: di.isCollection,
    }));

    const dataOutputs = (ioSpec.dataOutputs ?? []).map((dout, index) => ({
      id: dout.id ?? `${taskId}_output_${index}`,
      name: dout.name,
      itemSubjectRef: dout.itemSubjectRef,
      isCollection: dout.isCollection,
    }));

    // Build inputSets - if not provided, create default one with all inputs
    const inputSets = (ioSpec.inputSets ?? []).map((is, index) => ({
      id: is.id ?? `${taskId}_inputSet_${index}`,
      name: is.name,
      dataInputRefs: is.dataInputRefs ?? [],
    }));
    if (inputSets.length === 0 && dataInputs.length > 0) {
      inputSets.push({
        id: `${taskId}_inputSet_0`,
        name: undefined,
        dataInputRefs: dataInputs.map(di => di.id),
      });
    }

    // Build outputSets - if not provided, create default one with all outputs
    const outputSets = (ioSpec.outputSets ?? []).map((os, index) => ({
      id: os.id ?? `${taskId}_outputSet_${index}`,
      name: os.name,
      dataOutputRefs: os.dataOutputRefs ?? [],
    }));
    if (outputSets.length === 0 && dataOutputs.length > 0) {
      outputSets.push({
        id: `${taskId}_outputSet_0`,
        name: undefined,
        dataOutputRefs: dataOutputs.map(dout => dout.id),
      });
    }

    return {
      dataInputs,
      dataOutputs,
      inputSets,
      outputSets,
    };
  }

  /**
   * Build a boundary event model
   */
  private buildBoundaryEvent(be: BoundaryEventNode): FlowElementModel {
    const incoming = this.refResolver.getIncomingSequenceFlows(be.id);
    const outgoing = this.refResolver.getOutgoingSequenceFlows(be.id);

    return {
      type: 'boundaryEvent',
      id: be.id,
      name: be.bpmn?.name,
      incoming,
      outgoing,
      attachedToRef: be.attachedToRef,
      cancelActivity: be.bpmn?.isInterrupting ?? be.bpmn?.cancelActivity ?? true,
      properties: this.extractProperties(be.bpmn ?? {}),
    };
  }

  /**
   * Collect sequence flows
   */
  private collectSequenceFlows(edges: EdgeNode[], elements: FlowElementModel[]): void {
    for (const edge of edges) {
      if (edge.bpmn?.type === 'sequenceFlow') {
        elements.push({
          type: 'sequenceFlow',
          id: edge.id,
          name: edge.bpmn?.name,
          incoming: [],
          outgoing: [],
          properties: {
            sourceRef: this.requireEdgeEndpoint(edge, 'source'),
            targetRef: this.requireEdgeEndpoint(edge, 'target'),
            conditionExpression: edge.bpmn?.conditionExpression,
            isDefault: edge.bpmn?.isDefault,
          },
        });
      }
    }
  }

  /**
   * Collect associations from edges
   */
  private collectAssociations(edges: EdgeNode[], artifacts: ArtifactModel[]): void {
    for (const edge of edges) {
      if (edge.bpmn?.type === 'association') {
        artifacts.push({
          type: 'association',
          id: edge.id,
          name: edge.bpmn?.name,
          properties: {
            sourceRef: this.requireEdgeEndpoint(edge, 'source'),
            targetRef: this.requireEdgeEndpoint(edge, 'target'),
            associationDirection: (edge.bpmn as { associationDirection?: string })?.associationDirection ?? 'None',
          },
        });
      }
    }
  }

  /**
   * Collect data associations from edges and attach them to flow elements
   * Per BPMN 2.0 spec: dataInputAssociation/dataOutputAssociation are child elements of Activity
   */
  private collectDataAssociations(edges: EdgeNode[], elements: FlowElementModel[]): void {
    // Build a map of element IDs to their models for quick lookup
    const elementMap = new Map<string, FlowElementModel>();
    for (const element of elements) {
      elementMap.set(element.id, element);
    }

    for (const edge of edges) {
      const edgeType = edge.bpmn?.type;

      if (edgeType === 'dataInputAssociation') {
        // dataInputAssociation: data object (source) -> task (target)
        // The association is a child of the TARGET task
        const targetId = this.requireEdgeEndpoint(edge, 'target');
        const sourceId = this.requireEdgeEndpoint(edge, 'source');
        const targetElement = elementMap.get(targetId);

        if (targetElement) {
          if (!targetElement.dataInputAssociations) {
            targetElement.dataInputAssociations = [];
          }
          targetElement.dataInputAssociations.push({
            id: edge.id,
            sourceRef: sourceId,
          });
        }
      } else if (edgeType === 'dataOutputAssociation') {
        // dataOutputAssociation: task (source) -> data object (target)
        // The association is a child of the SOURCE task
        const sourceId = this.requireEdgeEndpoint(edge, 'source');
        const targetId = this.requireEdgeEndpoint(edge, 'target');
        const sourceElement = elementMap.get(sourceId);

        if (sourceElement) {
          if (!sourceElement.dataOutputAssociations) {
            sourceElement.dataOutputAssociations = [];
          }
          sourceElement.dataOutputAssociations.push({
            id: edge.id,
            sourceRef: sourceId,
            targetRef: targetId,
          });
        }
      }
    }
  }

  private requireEdgeEndpoint(edge: EdgeNode, side: 'source' | 'target'): string {
    const values = side === 'source' ? edge.sources : edge.targets;
    const value = Array.isArray(values) ? values[0] : undefined;
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`[model-builder] ${edge.bpmn?.type ?? 'edge'} ${edge.id} missing ${side} endpoint`);
    }
    return value;
  }

  /**
   * Build an artifact model
   */
  private buildArtifact(artifact: ArtifactNode): ArtifactModel {
    return {
      type: artifact.bpmn?.type ?? 'textAnnotation',
      id: artifact.id,
      name: artifact.bpmn?.name,
      properties: this.extractProperties(artifact.bpmn ?? {}),
    };
  }

  /**
   * Extract properties from bpmn object (excluding type and name)
   */
  private extractProperties(bpmn: Record<string, unknown>): Record<string, unknown> {
    const { type, name, ...rest } = bpmn;
    return rest;
  }
}
