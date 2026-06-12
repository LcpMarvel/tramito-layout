// 测试预言机（test oracle）：把嵌套 ELK-BPMN fixture 反推成扁平 FlatBpmn。
//
// 用途单一——给「扁平前门 vs 嵌套入口」等价性测试（flat-equivalence.test.ts）造扁平输入：
// 现有 31 个 fixture 都是嵌套 JSON，逐个手写扁平版既费力又要维护两套。这里在测试期由嵌套确定性
// 反推扁平，再 flatToNested 回去跑同一条管线，断言几何逐点一致——一份 fixture 覆盖两条入口。
//
// 为什么只放 test/、不进 src/：它不是编译路径的一环，是「校验扁平前门」的预言机。把它当生产工具会诱使
// 有人拿去做反向迁移，而它对几何无关字段是有损的（见下）。
//
// 有损 + 严格抛错的边界（与「几何等价」这一断言强绑定）：
//   - 丢弃且安全：definitions/process 的 bpmn 杂项（targetNamespace/exporter/processType/isExecutable…）、
//     triggeredByEvent、loopCharacteristics/multiInstance、calledElement、labels[]、流程节点的 width/height。
//     WHY 安全：loader 的 makeFlowNode 根本不读这些（流程节点尺寸由 type+label 经 node-sizes 重算），
//     elkPlacement 自建 ELK options 完全无视输入 layoutOptions——故这些字段不影响任何坐标。
//   - 必须保留：artifact 的 width/height（loader 会读 child.width ?? 默认）、eventDefinitionType、
//     exclusiveGateway.default、ioSpecification 的输入/输出数量与名字、isExpanded、边的 type/condition/
//     isDefault/associationDirection、以及一切**结构与顺序**（pool/lane 顺序、节点在容器内的顺序、
//     边在各容器内的相对顺序——ELK considerModelOrder=NODES_AND_EDGES 让顺序影响布局）。
//   - 遇到扁平词汇表达不了的结构 → 抛 NotFlatRepresentable（带 reason），由测试登记为「该 fixture 不可
//     扁平表达」并跳过（显式记录，不静默吞）。覆盖：根下不是单一 process/collaboration、participant 里
//     混了非 lane/flow 的东西、一条 lane 同时直挂流程节点又有子 lane（flatToNested 把非叶 lane 的直属
//     成员当 stray，几何会偏）、边非 1:1。

import { EVENT_TYPES, TASK_TYPES, GATEWAY_TYPES, SUBPROCESS_TYPES, ARTIFACT_TYPES, ASSOCIATION_EDGE_TYPES } from '../../src/loader/validate-graph.ts';
import type { FlatBpmn, FlatNode, FlatEdge, FlatLane, FlatPool } from '../../src/loader/flat-types.ts';

export class NotFlatRepresentable extends Error {
  constructor(public reason: string) {
    super(`not flat-representable: ${reason}`);
    this.name = 'NotFlatRepresentable';
  }
}

interface RawNode {
  id: string;
  bpmn?: Record<string, any>;
  width?: number;
  height?: number;
  children?: RawNode[];
  edges?: RawEdge[];
  boundaryEvents?: RawNode[];
  artifacts?: RawNode[];
}
interface RawEdge {
  id: string;
  sources?: string[];
  targets?: string[];
  bpmn?: Record<string, any>;
}

const FLOW_NODE_TYPES = new Set<string>([...EVENT_TYPES, ...TASK_TYPES, ...GATEWAY_TYPES]);
const ASSOC = new Set<string>(ASSOCIATION_EDGE_TYPES);

interface Ctx {
  pool?: string;
  lane?: string;
  parent?: string;
}

export function nestedToFlat(nested: Record<string, any>): FlatBpmn {
  const roots: RawNode[] = Array.isArray(nested.children) ? nested.children : [];
  if (roots.length !== 1) {
    // 根下出现多个元素（如 fixture 把 globalTask 声明摆在 process 旁）扁平表达不了。
    throw new NotFlatRepresentable(`definitions has ${roots.length} root children (expected 1 process/collaboration)`);
  }
  const root = roots[0]!;
  const rootType = root.bpmn?.type;

  const nodes: FlatNode[] = [];
  const edges: FlatEdge[] = [];
  const lanes: FlatLane[] = [];
  const pools: FlatPool[] = [];

  const pushEdge = (e: RawEdge) => {
    const sources = e.sources ?? [];
    const targets = e.targets ?? [];
    if (sources.length !== 1 || targets.length !== 1) {
      throw new NotFlatRepresentable(`edge ${e.id} is not 1:1 (sources=${sources.length}, targets=${targets.length})`);
    }
    const fe: FlatEdge = { id: e.id, source: sources[0]!, target: targets[0]! };
    const b = e.bpmn ?? {};
    if (typeof b.type === 'string') fe.type = b.type;
    if (b.name !== undefined) fe.name = b.name;
    if (b.isDefault) fe.isDefault = true;
    if (b.conditionExpression?.body !== undefined) fe.condition = b.conditionExpression.body;
    if (ASSOC.has(b.type) && b.associationDirection !== undefined) fe.associationDirection = b.associationDirection;
    edges.push(fe);
  };

  // 边界事件：跟随宿主，扁平里用 attachedTo 指回宿主、不带 pool/lane（poolOfNode 会顺 attachedTo 解析）。
  const pushBoundary = (be: RawNode, hostId: string) => {
    const b = be.bpmn ?? {};
    const fn: FlatNode = { id: be.id, type: 'boundaryEvent', attachedTo: hostId };
    if (b.name !== undefined) fn.name = b.name;
    if (b.eventDefinitionType !== undefined) fn.eventDefinitionType = b.eventDefinitionType;
    if (b.isInterrupting === false) fn.isInterrupting = false;
    nodes.push(fn);
  };

  const pushFlowNode = (raw: RawNode, ctx: Ctx) => {
    const b = raw.bpmn ?? {};
    const type = b.type as string;
    const fn: FlatNode = { id: raw.id, type };
    if (b.name !== undefined) fn.name = b.name;
    else if (type === 'textAnnotation' && b.text !== undefined) fn.name = b.text;
    if (ctx.pool !== undefined) fn.pool = ctx.pool;
    if (ctx.lane !== undefined) fn.lane = ctx.lane;
    if (ctx.parent !== undefined) fn.parent = ctx.parent;
    if (b.eventDefinitionType === 'link' || b.linkEventDefinition !== undefined) {
      // link 事件靠 linkEventDefinition.name 配对 throw↔catch（与显示 name 不同），管线据此把本来断开的
      // 组件连成一张图再布局。扁平格式无此字段 → 配对丢失 → 组件断开、几何全变。属真实表达力缺口，登记跳过。
      throw new NotFlatRepresentable(`link event ${raw.id} pairs via linkEventDefinition.name, not modeled in flat`);
    }
    if (EVENT_TYPES.has(type) && b.eventDefinitionType !== undefined) fn.eventDefinitionType = b.eventDefinitionType;
    if (type === 'exclusiveGateway' && b.default !== undefined) fn.default = b.default;
    if (SUBPROCESS_TYPES.has(type) && b.isExpanded !== undefined) fn.isExpanded = b.isExpanded === true;
    const io = b.ioSpecification;
    if (io && (Array.isArray(io.dataInputs) || Array.isArray(io.dataOutputs))) {
      const inputs = (io.dataInputs ?? []).map((d: any) => d?.name ?? '');
      const outputs = (io.dataOutputs ?? []).map((d: any) => d?.name ?? '');
      if (inputs.length || outputs.length) fn.io = { inputs, outputs };
    }
    if (ARTIFACT_TYPES.has(type)) {
      if (raw.width !== undefined) fn.width = raw.width;
      if (raw.height !== undefined) fn.height = raw.height;
    }
    nodes.push(fn);

    for (const be of raw.boundaryEvents ?? []) pushBoundary(be, raw.id);

    if (SUBPROCESS_TYPES.has(type)) {
      // 展开子流程：内部节点用 parent 指回本节点；内部边收进 flat.edges（flatToNested 会按 subOf 归桶）。
      // 子流程内不应出现 lane（loader 同此约定），故内部 ctx.lane 一律清空。
      walkContainer(raw, { pool: ctx.pool, parent: raw.id });
      for (const e of raw.edges ?? []) pushEdge(e);
    }
  };

  // 在某容器（process / participant / subProcess / lane）内按文档顺序分派 children。
  function walkContainer(container: RawNode, ctx: Ctx) {
    const children = container.children ?? [];
    for (const child of children) {
      const type = child.bpmn?.type;
      if (type === 'lane') {
        const sub = child.children ?? [];
        const hasSubLane = sub.some((c) => c.bpmn?.type === 'lane');
        const hasFlow = sub.some((c) => c.bpmn?.type !== 'lane');
        if (hasSubLane && hasFlow) {
          // 混合 lane：flatToNested 把非叶 lane 的直属流程节点当 stray，几何会偏 → 不可扁平表达。
          throw new NotFlatRepresentable(`lane ${child.id} mixes sub-lanes and direct flow nodes`);
        }
        const lane: FlatLane = { id: child.id };
        if (child.bpmn?.name !== undefined) lane.name = child.bpmn.name;
        if (ctx.pool !== undefined) lane.pool = ctx.pool;
        if (ctx.lane !== undefined) lane.parentLane = ctx.lane;
        lanes.push(lane);
        walkContainer(child, { pool: ctx.pool, lane: child.id });
      } else if (
        FLOW_NODE_TYPES.has(type) ||
        SUBPROCESS_TYPES.has(type) ||
        ARTIFACT_TYPES.has(type)
      ) {
        pushFlowNode(child, ctx);
      } else {
        throw new NotFlatRepresentable(`unsupported child type '${type}' (id=${child.id})`);
      }
    }
    // artifact（dataObject/textAnnotation/group）可挂在容器的 artifacts[] 而非 children——loader 两处都读，
    // 故反推也要走这条，否则带 artifacts[] 的 fixture（如 37）会丢掉这些节点。
    for (const a of container.artifacts ?? []) {
      const type = a.bpmn?.type;
      if (!ARTIFACT_TYPES.has(type)) {
        throw new NotFlatRepresentable(`non-artifact '${type}' in artifacts[] (id=${a.id})`);
      }
      pushFlowNode(a, ctx);
    }
  }

  if (rootType === 'process') {
    walkContainer(root, {});
    for (const e of root.edges ?? []) pushEdge(e);
  } else if (rootType === 'collaboration') {
    for (const part of root.children ?? []) {
      if (part.bpmn?.type !== 'participant') {
        throw new NotFlatRepresentable(`collaboration child '${part.bpmn?.type}' is not a participant (id=${part.id})`);
      }
      const pool: FlatPool = { id: part.id };
      if (part.bpmn?.name !== undefined) pool.name = part.bpmn.name;
      if (part.bpmn?.isBlackBox === true) pool.isBlackBox = true;
      pools.push(pool);
      if (part.bpmn?.isBlackBox === true) continue;
      // 有些 fixture 把 participant 写成 participant → <process> → body（显式 process 包一层），
      // 而 flatToNested 产出的是 participant → body 直挂（processRef 另指）。两形态 loader 都吃、几何一致，
      // 但 flat 词汇里没有「process 包装层」这个概念 → 明确登记，而不是冒一句含糊的 unsupported child。
      if ((part.children ?? []).some((c) => c.bpmn?.type === 'process')) {
        throw new NotFlatRepresentable(`participant ${part.id} wraps an explicit <process> element (flat models participant body directly)`);
      }
      walkContainer(part, { pool: part.id });
      for (const e of part.edges ?? []) pushEdge(e);
    }
    for (const e of root.edges ?? []) pushEdge(e);
  } else {
    throw new NotFlatRepresentable(`root child type '${rootType}' (expected process/collaboration)`);
  }

  const flat: FlatBpmn = { nodes };
  if (edges.length) flat.edges = edges;
  if (lanes.length) flat.lanes = lanes;
  if (pools.length) flat.pools = pools;
  return flat;
}
