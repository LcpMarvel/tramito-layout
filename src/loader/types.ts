// Internal model derived from ELK-BPMN JSON.
// Strips ELK / BPMN cruft; keeps only what the current layout pipeline needs.

export interface BpmnModel {
  fixture: string;
  processes: ProcessUnit[];
  collaborationMessageFlows: MessageFlow[];
}

export interface ProcessUnit {
  id: string;
  name: string;
  isBlackBox: boolean;
  lanes: Lane[];
  flowNodes: FlowNode[];
  sequenceFlows: SequenceFlow[];
  subProcesses: ProcessUnit[]; // recursive
  decorations: Decoration[];
}

export interface Lane {
  id: string;
  name: string;
  memberRefs: string[];
  parentLaneId: string | null;
}

export interface FlowNode {
  id: string;
  type: FlowNodeType;
  name: string;
  subProcessId: string | null;
  boundaryEventIds: string[];
  /** subProcess/transaction/adHocSubProcess/eventSubProcess 时是否展开。其它节点恒为 false。 */
  isExpanded: boolean;
  /** ioSpecification dataInputs / dataOutputs 数量。serializer 会把它们摆到 task 下方两列；
   *  layout 时需要预留垂直空间，否则 lane/pool 兜不住它们。 */
  ioInputCount: number;
  ioOutputCount: number;
  ioInputNames?: string[];
  ioOutputNames?: string[];
}

export type FlowNodeType =
  | 'startEvent'
  | 'endEvent'
  | 'intermediateCatchEvent'
  | 'intermediateThrowEvent'
  | 'boundaryEvent'
  | 'task'
  | 'userTask'
  | 'serviceTask'
  | 'sendTask'
  | 'receiveTask'
  | 'scriptTask'
  | 'manualTask'
  | 'businessRuleTask'
  | 'callActivity'
  | 'subProcess'
  | 'adHocSubProcess'
  | 'transaction'
  | 'exclusiveGateway'
  | 'parallelGateway'
  | 'inclusiveGateway'
  | 'eventBasedGateway'
  | 'complexGateway'
  | 'dataObject'
  | 'dataObjectReference'
  | 'dataStoreReference'
  | 'textAnnotation'
  | 'group'
  | 'other';

export interface SequenceFlow {
  id: string;
  source: string;
  target: string;
  isDefault: boolean;
}

export interface MessageFlow {
  id: string;
  source: string;
  target: string;
}

export type ArtifactSubtype =
  | 'dataObject'
  | 'dataObjectReference'
  | 'dataStoreReference'
  | 'textAnnotation'
  | 'group';

export type AssociationSubtype = 'association' | 'dataInputAssociation' | 'dataOutputAssociation';

export type Decoration =
  | { kind: 'messageFlow'; id: string; source: string; target: string }
  | { kind: 'association'; id: string; subtype: AssociationSubtype; source: string; target: string; associationDirection: string }
  | { kind: 'compensationAssociation'; id: string; source: string; target: string }
  | { kind: 'boundaryEvent'; id: string; host: string; eventType: string; isInterrupting: boolean; outgoingFlowIds: string[] }
  | { kind: 'artifact'; id: string; subtype: ArtifactSubtype; name: string; width: number; height: number };
