/**
 * Model Types for BPMN Model Building
 * These types define the intermediate model structure used between
 * layout processing and BPMN XML generation.
 */

import type {
  MessageDefinition,
  SignalDefinition,
  ErrorDefinition,
  EscalationDefinition,
} from '../types/elk-bpmn';

// ============================================================================
// BPMN Model Types
// ============================================================================

export interface BpmnModel {
  definitions: DefinitionsModel;
  diagram: DiagramModel;
}

export interface DefinitionsModel {
  id: string;
  targetNamespace: string;
  exporter: string;
  exporterVersion: string;
  messages: MessageDefinition[];
  signals: SignalDefinition[];
  errors: ErrorDefinition[];
  escalations: EscalationDefinition[];
  rootElements: RootElement[];
}

export type RootElement = CollaborationModel | ProcessModel;

export interface CollaborationModel {
  type: 'collaboration';
  id: string;
  name?: string;
  isClosed?: boolean;
  participants: ParticipantModel[];
  messageFlows: MessageFlowModel[];
}

export interface ParticipantModel {
  id: string;
  name?: string;
  processRef?: string;
  isBlackBox?: boolean;
  participantMultiplicity?: { minimum?: number; maximum?: number };
}

export interface ProcessModel {
  type: 'process';
  id: string;
  name?: string;
  isExecutable?: boolean;
  processType?: string;
  isClosed?: boolean;
  laneSet?: LaneSetInfo;
  flowElements: FlowElementModel[];
  artifacts: ArtifactModel[];
}

export interface DataAssociationModel {
  id: string;
  sourceRef: string;
  targetRef?: string;  // Optional for dataInputAssociation (target is implicit)
}

export interface FlowElementModel {
  type: string;
  id: string;
  name?: string;
  incoming: string[];
  outgoing: string[];
  properties: Record<string, unknown>;
  // For boundary events
  attachedToRef?: string;
  cancelActivity?: boolean;
  // For subprocesses - nested content
  flowElements?: FlowElementModel[];
  artifacts?: ArtifactModel[];
  // For data associations (BPMN spec: child elements of activity)
  dataInputAssociations?: DataAssociationModel[];
  dataOutputAssociations?: DataAssociationModel[];
  // For ioSpecification (BPMN spec: defines task inputs/outputs)
  ioSpecification?: IoSpecificationModel;
}

// ============================================================================
// IoSpecification Types (for task data inputs/outputs)
// ============================================================================

export interface IoSpecificationModel {
  dataInputs: DataInputModel[];
  dataOutputs: DataOutputModel[];
  inputSets: InputSetModel[];
  outputSets: OutputSetModel[];
}

export interface DataInputModel {
  id: string;
  name?: string;
  itemSubjectRef?: string;
  isCollection?: boolean;
}

export interface DataOutputModel {
  id: string;
  name?: string;
  itemSubjectRef?: string;
  isCollection?: boolean;
}

export interface InputSetModel {
  id: string;
  name?: string;
  dataInputRefs: string[];
}

export interface OutputSetModel {
  id: string;
  name?: string;
  dataOutputRefs: string[];
}

export interface ArtifactModel {
  type: string;
  id: string;
  name?: string;
  properties: Record<string, unknown>;
}

export interface MessageFlowModel {
  id: string;
  name?: string;
  sourceRef: string;
  targetRef: string;
  messageRef?: string;
}

export interface SequenceFlowModel {
  id: string;
  name?: string;
  sourceRef: string;
  targetRef: string;
  conditionExpression?: {
    type?: string;
    language?: string;
    body?: string;
  };
  isDefault?: boolean;
}

// ============================================================================
// Diagram Model Types
// ============================================================================

export interface DiagramModel {
  id: string;
  name: string;
  plane: PlaneModel;
}

export interface PlaneModel {
  id: string;
  bpmnElement: string;
  shapes: ShapeModel[];
  edges: EdgeModel[];
}

export interface ShapeModel {
  id: string;
  bpmnElement: string;
  bounds: BoundsModel;
  isExpanded?: boolean;
  isHorizontal?: boolean;
  label?: LabelModel;
}

export interface EdgeModel {
  id: string;
  bpmnElement: string;
  waypoints: PointModel[];
  label?: LabelModel;
}

export interface BoundsModel {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PointModel {
  x: number;
  y: number;
}

export interface LabelModel {
  bounds?: BoundsModel;
}

// ============================================================================
// Lane Types (re-export from lane-resolver)
// ============================================================================

export interface LaneSetInfo {
  id: string;
  lanes: LaneInfo[];
}

export interface LaneInfo {
  id: string;
  name?: string;
  flowNodeRefs: string[];
  childLaneSet?: LaneSetInfo;
}

// ============================================================================
// Internal Node Types (for parsing layouted graph)
// ============================================================================

export interface CollaborationNode {
  id: string;
  bpmn?: { type: 'collaboration'; name?: string; isClosed?: boolean };
  children?: ParticipantNode[];
  edges?: MessageFlowEdge[];
}

export interface ParticipantNode {
  id: string;
  bpmn?: {
    type: 'participant';
    name?: string;
    processRef?: string;
    isBlackBox?: boolean;
    participantMultiplicity?: { minimum?: number; maximum?: number };
  };
  children?: ChildNode[];
  edges?: EdgeNode[];
}

export interface ProcessNode {
  id: string;
  bpmn?: {
    type: 'process';
    name?: string;
    isExecutable?: boolean;
    processType?: string;
    isClosed?: boolean;
  };
  children?: ChildNode[];
  edges?: EdgeNode[];
  artifacts?: ArtifactNode[];
}

export interface ChildNode {
  id: string;
  bpmn?: { type: string; name?: string; isExpanded?: boolean; [key: string]: unknown };
  children?: ChildNode[];
  edges?: EdgeNode[];
  boundaryEvents?: BoundaryEventNode[];
}

export interface BoundaryEventNode {
  id: string;
  attachedToRef: string;
  bpmn?: { type: 'boundaryEvent'; name?: string; isInterrupting?: boolean; cancelActivity?: boolean; [key: string]: unknown };
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface EdgeNode {
  id: string;
  sources: string[];
  targets: string[];
  bpmn?: { type: string; name?: string; conditionExpression?: object; isDefault?: boolean; messageRef?: string };
  sections?: Array<{ startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; bendPoints?: Array<{ x: number; y: number }> }>;
  labels?: Array<{ x?: number; y?: number; width?: number; height?: number }>;
}

export interface MessageFlowEdge {
  id: string;
  sources: string[];
  targets: string[];
  bpmn?: { type: 'messageFlow'; name?: string; messageRef?: string };
  sections?: Array<{ startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; bendPoints?: Array<{ x: number; y: number }> }>;
  labels?: Array<{ x?: number; y?: number; width?: number; height?: number }>;
}

export interface ArtifactNode {
  id: string;
  bpmn?: { type: string; name?: string; [key: string]: unknown };
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface LayoutedNode {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  bpmn?: { type: string; name?: string; isExpanded?: boolean };
  children?: LayoutedNode[];
  edges?: LayoutedEdge[];
  boundaryEvents?: Array<{ id: string; x?: number; y?: number; width?: number; height?: number; bpmn?: { type: string; name?: string; [k: string]: unknown }; labels?: Array<{ text?: string; x?: number; y?: number; width?: number; height?: number }> }>;
  labels?: Array<{ text?: string; x?: number; y?: number; width?: number; height?: number }>;
}

export interface LayoutedEdge {
  id: string;
  sources: string[];
  targets: string[];
  sections: Array<{
    startPoint: { x: number; y: number };
    endPoint: { x: number; y: number };
    bendPoints?: Array<{ x: number; y: number }>;
  }>;
  labels?: Array<{ x?: number; y?: number; width?: number; height?: number }>;
}

// ============================================================================
// Position Tracking Types (for diagram building)
// ============================================================================

export interface NodePosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NodeOffset {
  x: number;
  y: number;
}

export interface NodeBpmnInfo {
  type?: string;
  /** True when the node is an expanded container (subprocess that holds children) */
  isExpanded?: boolean;
}
