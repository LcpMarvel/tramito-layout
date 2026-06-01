// 扁平 ELK-BPMN 输入契约（flat authoring format）。
//
// WHY 存在：嵌套 ELK-BPMN（definitions → process/collaboration → [pool → lane →] children，
// 边按容器分层、boundaryEvent 挂宿主特殊数组、partition 配置……）对 LLM 太难，图一大就在嵌套
// 层级上崩（lane 错放 / boundary 进 children / 边放错层 / 整段 laneSet 被坏 JSON 修复器丢弃）。
// 扁平格式把「归属」全降成节点上的平铺 ID 字段（pool / lane / attachedTo），嵌套交给 flatToNested
// 用代码确定性生成——结构类错误从构造上不可能再发生，且扁平数组对坏 JSON 修复远比深树健壮。
//
// 覆盖范围：单/多 pool、泳道（含嵌套）、event/task/gateway、边界事件、io、messageFlow、
// artifact（dataObject/textAnnotation/group）、association、子流程（subProcess/adHocSubProcess/
// transaction，内部节点用 parent 指向、支持任意层嵌套）。

export interface FlatBpmn {
  /** definitions id，默认 'definitions_1'。 */
  id?: string;
  /** 根 layoutOptions，默认标准 layered/RIGHT。 */
  layoutOptions?: Record<string, unknown>;
  /** 泳池。省略或为空 → 单 process（无协作）。 */
  pools?: FlatPool[];
  /** 泳道。省略 → 不分泳道。每条泳道用 pool 指定归属泳池（单池可省）。 */
  lanes?: FlatLane[];
  /** 流程节点（事件 / 任务 / 网关 / 边界 / artifact）。数组顺序 = 执行先后，决定出图顺序。 */
  nodes: FlatNode[];
  /** 连线。数组顺序 = 执行先后。type 省略时按两端归属自动判定（同池 sequenceFlow / 跨池 messageFlow）。 */
  edges?: FlatEdge[];
}

export interface FlatPool {
  id: string;
  name?: string;
  /** 黑盒池：无内部结构，仅作 messageFlow 端点。 */
  isBlackBox?: boolean;
}

export interface FlatLane {
  id: string;
  name?: string;
  /** 所属泳池 id；多池时必填，单池可省。 */
  pool?: string;
  /** 父泳道 id（嵌套泳道）；顶层泳道省略。 */
  parentLane?: string;
}

export interface FlatNode {
  id: string;
  /** startEvent | endEvent | intermediateCatchEvent | intermediateThrowEvent | task | userTask |
   *  serviceTask | sendTask | receiveTask | scriptTask | manualTask | businessRuleTask | callActivity |
   *  exclusiveGateway | parallelGateway | inclusiveGateway | eventBasedGateway | complexGateway |
   *  subProcess | adHocSubProcess | transaction | dataObject | dataObjectReference | dataStoreReference |
   *  textAnnotation | group | boundaryEvent */
  type: string;
  name?: string;
  /** 归属泳池 id。单池/单 process 可省（自动归入唯一容器）。 */
  pool?: string;
  /** 归属泳道 id。有泳道时填；代码据此塞进 lane.children。 */
  lane?: string;
  /** 事件定义类型：none | message | timer | signal | error | terminate | conditional | link。
   *  事件节点省略时默认 'none'。 */
  eventDefinitionType?: string;
  /** 边界事件宿主节点 id。填了即视为 boundaryEvent，代码会把它挂进宿主的 boundaryEvents 数组。 */
  attachedTo?: string;
  /** 边界事件是否中断宿主（默认 true）。 */
  isInterrupting?: boolean;
  /** exclusiveGateway 的默认分支：指向某条出向 edge 的 id。 */
  default?: string;
  /** 父子流程节点 id：填了表示「本节点在该 subProcess 内部」。系统据此把它收进子流程的 children，
   *  并把两端都在同一子流程内的边收进该子流程的 edges。支持任意层嵌套。 */
  parent?: string;
  /** subProcess 是否展开。有内部节点（被别的 node 用 parent 指向）时自动展开；无内部节点时按本值，默认折叠。 */
  isExpanded?: boolean;
  /** 节点输入/输出物（友好写法）。代码编译成 ioSpecification 的 dataInputs/dataOutputs。 */
  io?: { inputs?: string[]; outputs?: string[] };
  /** artifact（dataObject/textAnnotation/group）尺寸覆盖，可省（用默认尺寸）。 */
  width?: number;
  height?: number;
}

export interface FlatEdge {
  id: string;
  source: string;
  target: string;
  /** sequenceFlow（默认）| messageFlow | association | dataInputAssociation | dataOutputAssociation。
   *  省略时：同池 → sequenceFlow；跨池 → messageFlow（代码自动判定，杜绝跨池 sequenceFlow / 错放）。 */
  type?: string;
  name?: string;
  /** 标记为 exclusiveGateway 的默认分支（与该网关的 default 字段配合）。 */
  isDefault?: boolean;
  /** 条件表达式正文，编译成 conditionExpression.body。 */
  condition?: string;
  /** association 方向：None | One | Both，默认 None。 */
  associationDirection?: string;
}
