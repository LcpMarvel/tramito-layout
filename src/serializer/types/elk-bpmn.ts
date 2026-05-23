/**
 * ELK-BPMN Input Types
 * Based on elk-bpmn-schema.json v2.0
 */

// ============================================================================
// Root Types
// ============================================================================

export interface ElkBpmnGraph {
  id: string;
  layoutOptions?: ElkLayoutOptions;
  bpmn?: DefinitionsMetadata;
  children: (Collaboration | Process)[];
  messages?: MessageDefinition[];
  signals?: SignalDefinition[];
  errors?: ErrorDefinition[];
  escalations?: EscalationDefinition[];
}

export interface DefinitionsMetadata {
  targetNamespace?: string;
  exporter?: string;
  exporterVersion?: string;
}

// ============================================================================
// Layout Options
// ============================================================================

export interface ElkLayoutOptions {
  'elk.algorithm'?: 'layered' | 'stress' | 'mrtree' | 'radial' | 'force' | 'disco' | 'box' | 'fixed' | 'random';
  'elk.direction'?: 'RIGHT' | 'DOWN' | 'LEFT' | 'UP';
  'elk.spacing.nodeNode'?: number;
  'elk.spacing.edgeNode'?: number;
  'elk.spacing.edgeEdge'?: number;
  'elk.layered.spacing.nodeNodeBetweenLayers'?: number;
  'elk.layered.spacing.edgeNodeBetweenLayers'?: number;
  'elk.layered.spacing.edgeEdgeBetweenLayers'?: number;
  'elk.partitioning.activate'?: boolean;
  'elk.partitioning.partition'?: number;
  'elk.hierarchyHandling'?: 'INCLUDE_CHILDREN' | 'SEPARATE_CHILDREN';
  'elk.layered.crossingMinimization.strategy'?: 'LAYER_SWEEP' | 'INTERACTIVE';
  'elk.layered.nodePlacement.strategy'?: 'SIMPLE' | 'BRANDES_KOEPF' | 'LINEAR_SEGMENTS' | 'NETWORK_SIMPLEX';
  'elk.edgeRouting'?: 'POLYLINE' | 'ORTHOGONAL' | 'SPLINES';
  [key: string]: string | number | boolean | undefined;
}

// ============================================================================
// Global Definitions
// ============================================================================

export interface MessageDefinition {
  id: string;
  name?: string;
}

export interface SignalDefinition {
  id: string;
  name?: string;
}

export interface ErrorDefinition {
  id: string;
  name?: string;
  errorCode?: string;
}

export interface EscalationDefinition {
  id: string;
  name?: string;
  escalationCode?: string;
}

// ============================================================================
// Collaboration & Participant
// ============================================================================

export interface Collaboration {
  id: string;
  bpmn: CollaborationBpmn;
  layoutOptions?: ElkLayoutOptions;
  children: Participant[];
  edges?: MessageFlow[];
}

export interface CollaborationBpmn {
  type: 'collaboration';
  name?: string;
  isClosed?: boolean;
}

export interface Participant {
  id: string;
  width?: number;
  height?: number;
  bpmn: ParticipantBpmn;
  layoutOptions?: ElkLayoutOptions;
  children?: (Lane | FlowNode)[];
  edges?: SequenceFlow[];
}

export interface ParticipantBpmn {
  type: 'participant';
  name?: string;
  processRef?: string;
  isBlackBox?: boolean;
  participantMultiplicity?: {
    minimum?: number;
    maximum?: number;
  };
}

// ============================================================================
// Lane
// ============================================================================

export interface Lane {
  id: string;
  width?: number;
  height?: number;
  bpmn: LaneBpmn;
  layoutOptions?: ElkLayoutOptions & {
    'elk.partitioning.partition'?: number;
  };
  children?: (Lane | FlowNode)[];
}

export interface LaneBpmn {
  type: 'lane';
  name?: string;
}

// ============================================================================
// Process
// ============================================================================

export interface Process {
  id: string;
  bpmn: ProcessBpmn;
  layoutOptions?: ElkLayoutOptions;
  children?: (Lane | FlowNode)[];
  edges?: (SequenceFlow | DataAssociation)[];
  artifacts?: Artifact[];
}

export interface ProcessBpmn {
  type: 'process';
  name?: string;
  isExecutable?: boolean;
  processType?: 'None' | 'Public' | 'Private';
  isClosed?: boolean;
}

// ============================================================================
// Flow Nodes
// ============================================================================

export interface FlowNode {
  id: string;
  width?: number;
  height?: number;
  bpmn: BpmnEvent | BpmnTask | BpmnGateway | BpmnSubProcess | BpmnCallActivity;
  labels?: Label[];
  ports?: Port[];
  children?: FlowNode[];
  edges?: SequenceFlow[];
  boundaryEvents?: BoundaryEvent[];
}

export interface Label {
  text?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

export interface Port {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

// ============================================================================
// Events
// ============================================================================

export type EventType =
  | 'startEvent'
  | 'endEvent'
  | 'intermediateCatchEvent'
  | 'intermediateThrowEvent'
  | 'boundaryEvent';

export type EventDefinitionType =
  | 'none'
  | 'message'
  | 'timer'
  | 'error'
  | 'escalation'
  | 'cancel'
  | 'compensation'
  | 'conditional'
  | 'link'
  | 'signal'
  | 'terminate'
  | 'multiple'
  | 'parallelMultiple';

export interface BpmnEvent {
  type: EventType;
  eventDefinitionType: EventDefinitionType;
  name?: string;
  isInterrupting?: boolean;
  parallelMultiple?: boolean;
  messageRef?: string;
  signalRef?: string;
  errorRef?: string;
  escalationRef?: string;
  timerEventDefinition?: TimerEventDefinition;
  conditionalEventDefinition?: ConditionalEventDefinition;
  linkEventDefinition?: LinkEventDefinition;
}

export interface BoundaryEvent {
  id: string;
  width?: number;
  height?: number;
  attachedToRef: string;
  bpmn: BoundaryEventBpmn;
  labels?: Label[];
}

export interface BoundaryEventBpmn {
  type: 'boundaryEvent';
  eventDefinitionType: Exclude<EventDefinitionType, 'none' | 'link' | 'terminate'>;
  name?: string;
  isInterrupting?: boolean;
  cancelActivity?: boolean;
  messageRef?: string;
  signalRef?: string;
  errorRef?: string;
  escalationRef?: string;
  timerEventDefinition?: TimerEventDefinition;
  conditionalEventDefinition?: ConditionalEventDefinition;
}

export interface TimerEventDefinition {
  timeDate?: string;
  timeDuration?: string;
  timeCycle?: string;
}

export interface ConditionalEventDefinition {
  condition?: FormalExpression;
}

export interface LinkEventDefinition {
  name?: string;
  source?: string[];
  target?: string;
}

// ============================================================================
// Tasks
// ============================================================================

export type TaskType =
  | 'task'
  | 'userTask'
  | 'serviceTask'
  | 'scriptTask'
  | 'businessRuleTask'
  | 'sendTask'
  | 'receiveTask'
  | 'manualTask';

export interface BpmnTask {
  type: TaskType;
  name?: string;
  documentation?: string;
  // User Task properties
  assignee?: string;
  candidateUsers?: string[];
  candidateGroups?: string[];
  dueDate?: string;
  priority?: string;
  formKey?: string;
  // Service Task properties
  implementation?: string;
  operationRef?: string;
  // Script Task properties
  script?: ScriptDefinition;
  // Send/Receive Task properties
  messageRef?: string;
  instantiate?: boolean;
  // Loop/Multi-instance
  loopCharacteristics?: LoopCharacteristics;
  ioSpecification?: IoSpecification;
}

export interface ScriptDefinition {
  scriptFormat?: string;
  script?: string;
  resultVariable?: string;
}

// ============================================================================
// Gateways
// ============================================================================

export type GatewayType =
  | 'exclusiveGateway'
  | 'parallelGateway'
  | 'inclusiveGateway'
  | 'eventBasedGateway'
  | 'complexGateway';

export type GatewayDirection = 'Unspecified' | 'Converging' | 'Diverging' | 'Mixed';

export interface BpmnGateway {
  type: GatewayType;
  name?: string;
  gatewayDirection?: GatewayDirection;
  default?: string;
  instantiate?: boolean;
  eventGatewayType?: 'Exclusive' | 'Parallel';
  activationCondition?: string;
}

// ============================================================================
// SubProcesses
// ============================================================================

export type SubProcessType = 'subProcess' | 'transaction' | 'adHocSubProcess' | 'eventSubProcess';

export interface BpmnSubProcess {
  type: SubProcessType;
  name?: string;
  triggeredByEvent?: boolean;
  isExpanded?: boolean;
  loopCharacteristics?: LoopCharacteristics;
  // AdHoc SubProcess
  adHocOrdering?: 'Parallel' | 'Sequential';
  adHocCompletionCondition?: string;
  cancelRemainingInstances?: boolean;
  // Transaction
  transactionProtocol?: string;
}

// ============================================================================
// Call Activity
// ============================================================================

export interface BpmnCallActivity {
  type: 'callActivity';
  name?: string;
  calledElement?: string;
  calledElementBinding?: 'latest' | 'deployment' | 'version';
  calledElementVersion?: string;
  inheritBusinessKey?: boolean;
  loopCharacteristics?: LoopCharacteristics;
  inMappings?: ParameterMapping[];
  outMappings?: ParameterMapping[];
}

export interface ParameterMapping {
  source?: string;
  sourceExpression?: string;
  target?: string;
}

// ============================================================================
// Loop Characteristics
// ============================================================================

export interface LoopCharacteristics {
  loopType?: 'standard' | 'multiInstance';
  isSequential?: boolean;
  loopCardinality?: string;
  loopDataInputRef?: string;
  loopDataOutputRef?: string;
  inputDataItem?: string;
  outputDataItem?: string;
  completionCondition?: string;
  loopCondition?: string;
  loopMaximum?: number;
  testBefore?: boolean;
}

// ============================================================================
// IO Specification
// ============================================================================

export interface IoSpecification {
  dataInputs?: DataInput[];
  dataOutputs?: DataOutput[];
  inputSets?: InputSet[];
  outputSets?: OutputSet[];
}

export interface DataInput {
  id?: string;
  name?: string;
  itemSubjectRef?: string;
  isCollection?: boolean;
}

export interface DataOutput {
  id?: string;
  name?: string;
  itemSubjectRef?: string;
  isCollection?: boolean;
}

export interface InputSet {
  id?: string;
  name?: string;
  dataInputRefs?: string[];
}

export interface OutputSet {
  id?: string;
  name?: string;
  dataOutputRefs?: string[];
}

// ============================================================================
// Artifacts
// ============================================================================

export interface Artifact {
  id: string;
  width?: number;
  height?: number;
  bpmn: DataObjectArtifact | DataStoreArtifact | TextAnnotationArtifact | GroupArtifact;
  labels?: Label[];
}

export interface DataObjectArtifact {
  type: 'dataObject' | 'dataObjectReference';
  name?: string;
  dataObjectRef?: string;
  itemSubjectRef?: string;
  isCollection?: boolean;
  dataState?: { name?: string };
}

export interface DataStoreArtifact {
  type: 'dataStoreReference';
  name?: string;
  dataStoreRef?: string;
  capacity?: number;
  isUnlimited?: boolean;
}

export interface TextAnnotationArtifact {
  type: 'textAnnotation';
  text?: string;
  textFormat?: string;
}

export interface GroupArtifact {
  type: 'group';
  name?: string;
  categoryValueRef?: string;
}

// ============================================================================
// Flows (Edges)
// ============================================================================

export interface SequenceFlow {
  id: string;
  sources: [string];
  targets: [string];
  bpmn: SequenceFlowBpmn;
  labels?: Label[];
}

export interface SequenceFlowBpmn {
  type: 'sequenceFlow';
  name?: string;
  conditionExpression?: FormalExpression;
  isDefault?: boolean;
}

export interface MessageFlow {
  id: string;
  sources: [string];
  targets: [string];
  bpmn: MessageFlowBpmn;
  labels?: Label[];
}

export interface MessageFlowBpmn {
  type: 'messageFlow';
  name?: string;
  messageRef?: string;
}

export interface DataAssociation {
  id: string;
  sources: string[];
  targets: string[];
  bpmn: DataAssociationBpmn;
}

export interface DataAssociationBpmn {
  type: 'dataInputAssociation' | 'dataOutputAssociation';
  transformation?: { body?: string };
  assignment?: Array<{ from?: string; to?: string }>;
}

export interface Association {
  id: string;
  sources: string[];
  targets: string[];
  bpmn: AssociationBpmn;
}

export interface AssociationBpmn {
  type: 'association';
  associationDirection?: 'None' | 'One' | 'Both';
}

// ============================================================================
// Common Types
// ============================================================================

export interface FormalExpression {
  type?: string;
  language?: string;
  body?: string;
}

