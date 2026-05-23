// BPMN element-type → XML element 名映射 + event-definition → XML 元素映射。
// 仅保留实际被 serializer 使用的常量。

export const BPMN_ELEMENT_MAP = {
  // Events (bpmn-moddle uses PascalCase)
  startEvent: 'bpmn:StartEvent',
  endEvent: 'bpmn:EndEvent',
  intermediateCatchEvent: 'bpmn:IntermediateCatchEvent',
  intermediateThrowEvent: 'bpmn:IntermediateThrowEvent',
  boundaryEvent: 'bpmn:BoundaryEvent',

  // Tasks
  task: 'bpmn:Task',
  userTask: 'bpmn:UserTask',
  serviceTask: 'bpmn:ServiceTask',
  scriptTask: 'bpmn:ScriptTask',
  businessRuleTask: 'bpmn:BusinessRuleTask',
  sendTask: 'bpmn:SendTask',
  receiveTask: 'bpmn:ReceiveTask',
  manualTask: 'bpmn:ManualTask',

  // Gateways
  exclusiveGateway: 'bpmn:ExclusiveGateway',
  parallelGateway: 'bpmn:ParallelGateway',
  inclusiveGateway: 'bpmn:InclusiveGateway',
  eventBasedGateway: 'bpmn:EventBasedGateway',
  complexGateway: 'bpmn:ComplexGateway',

  // SubProcesses
  subProcess: 'bpmn:SubProcess',
  transaction: 'bpmn:Transaction',
  adHocSubProcess: 'bpmn:AdHocSubProcess',
  eventSubProcess: 'bpmn:SubProcess', // Same element, different attribute

  // Call Activity
  callActivity: 'bpmn:CallActivity',

  // Artifacts
  dataObject: 'bpmn:DataObject',
  dataObjectReference: 'bpmn:DataObjectReference',
  dataInput: 'bpmn:DataInput',
  dataOutput: 'bpmn:DataOutput',
  dataStoreReference: 'bpmn:DataStoreReference',
  textAnnotation: 'bpmn:TextAnnotation',
  group: 'bpmn:Group',

  // Flows
  sequenceFlow: 'bpmn:SequenceFlow',
  messageFlow: 'bpmn:MessageFlow',
  dataInputAssociation: 'bpmn:DataInputAssociation',
  dataOutputAssociation: 'bpmn:DataOutputAssociation',
  association: 'bpmn:Association',

  // Containers
  collaboration: 'bpmn:Collaboration',
  participant: 'bpmn:Participant',
  process: 'bpmn:Process',
  lane: 'bpmn:Lane',
  laneSet: 'bpmn:LaneSet',
} as const;

export const EVENT_DEFINITION_MAP = {
  none: null,
  message: 'bpmn:MessageEventDefinition',
  timer: 'bpmn:TimerEventDefinition',
  error: 'bpmn:ErrorEventDefinition',
  escalation: 'bpmn:EscalationEventDefinition',
  cancel: 'bpmn:CancelEventDefinition',
  compensation: 'bpmn:CompensateEventDefinition',
  conditional: 'bpmn:ConditionalEventDefinition',
  link: 'bpmn:LinkEventDefinition',
  signal: 'bpmn:SignalEventDefinition',
  terminate: 'bpmn:TerminateEventDefinition',
  multiple: null,
  parallelMultiple: null,
} as const;
