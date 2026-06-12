// flatToNested：把扁平 ELK-BPMN（flat-types.ts）确定性编译成嵌套 ELK-BPMN JSON。
//
// 这是「把嵌套装配从模型手里拿到代码里」的核心：模型只产出平铺的 nodes/edges + 归属 ID 字段，
// 这里按构造生成正确的容器层级——lane.children 分组、boundary 挂宿主、边按两端泳池自动定层、
// partition 配置。当输入「引用正确」时，LANE_NODE_MISPLACED / BOUNDARY_EVENT_IN_CHILDREN /
// UNKNOWN_EDGE_TYPE / MSGFLOW_NOT_IN_COLLABORATION / SEQFLOW_CROSS_POOL / LANE_PARTITION_INCOMPLETE
// 这些结构类错误从构造上不会发生。产物喂给现有 validateGraph + runPipeline，完全复用下游。
//
// 健壮性约定：本函数永不 throw、永不死循环（subOf/poolOfNode 在 flat-resolve 里带环守卫）。
// 对「引用错」（attachedTo/parent/lane/pool/parentLane 指向不存在、成环、指向错类型……）不在这里兜底，
// 而是先在 validate-flat 用扁平词汇报清楚错（见 flat.ts）；本函数对这类输入只保证「不丢节点、不崩」：
// 把无法正确归位的节点平铺到最近的容器 body，让校验有据可查，绝不静默吞掉。
//
// 子流程：内部节点用 node.parent 指向子流程节点 id；同 parent 的节点收进该子流程的 children、两端都在
// 该子流程内的边收进它的 edges、isExpanded 置 true。支持任意层嵌套（内部节点本身也可是子流程）。

import type { FlatBpmn, FlatNode, FlatEdge } from './flat-types.ts';
import { createFlatResolver, SINGLE_PROCESS_ID } from './flat-resolve.ts';
import { EVENT_TYPES, SUBPROCESS_TYPES, ARTIFACT_TYPES, ASSOCIATION_EDGE_TYPES } from './validate-graph.ts';

const DEFAULT_LAYOUT = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.spacing.nodeNode': 50,
  'elk.layered.spacing.nodeNodeBetweenLayers': 80,
} as const;

// none 对 catch/boundary 非法（必须有触发器）；start/end/throw 的 none 合法，缺省补 none。
// WHY 本地：这是「哪些事件缺省补 none」的构造规则，与 validate-graph 的 EVENT_DEF_REQUIRED 是不同概念，不复用。
const EVENT_DEF_DEFAULTS_NONE = new Set(['startEvent', 'endEvent', 'intermediateThrowEvent']);
const ASSOCIATION_TYPES = new Set<string>(ASSOCIATION_EDGE_TYPES);

interface NestedNode {
  id: string;
  bpmn: Record<string, unknown>;
  boundaryEvents?: NestedNode[];
  children?: NestedNode[];
  edges?: NestedEdge[];
  layoutOptions?: Record<string, unknown>;
  width?: number;
  height?: number;
}
interface NestedEdge {
  id: string;
  sources: string[];
  targets: string[];
  bpmn: Record<string, unknown>;
}

export function flatToNested(flat: FlatBpmn): Record<string, unknown> {
  // 归属解析（isBoundary / isInner / subOf / poolOfNode）单点定义在 flat-resolve，validate-flat 共用同一份，
  // 保证「校验判定的归属」与「这里实际放置的归属」永不漂移，且 subOf/poolOfNode 自带环守卫不会爆栈。
  const r = createFlatResolver(flat);
  const { nodes, edges, pools, lanes, hasPools, nodeById, laneById, isBoundary, isInner, subOf, poolOfNode } = r;

  // ---- 节点编译 ----
  const buildBpmn = (n: FlatNode): Record<string, unknown> => {
    const bpmn: Record<string, unknown> = { type: n.type };
    if (n.name !== undefined) bpmn.name = n.name;
    if (EVENT_TYPES.has(n.type) || n.type === 'boundaryEvent') {
      const edt =
        n.eventDefinitionType ?? (EVENT_DEF_DEFAULTS_NONE.has(n.type) ? 'none' : undefined);
      if (edt !== undefined) bpmn.eventDefinitionType = edt;
    }
    if (n.type === 'exclusiveGateway' && n.default !== undefined) bpmn.default = n.default;
    if (SUBPROCESS_TYPES.has(n.type)) {
      // 显式 isExpanded 优先（含显式 false：折叠但仍保留 children，BPMN 合法）；未声明时按「有无内部节点」缺省。
      bpmn.isExpanded = n.isExpanded !== undefined ? n.isExpanded === true : childrenOfParent.has(n.id);
    }
    if (n.io && (n.io.inputs?.length || n.io.outputs?.length)) {
      const dataInputs = (n.io.inputs ?? []).map((name, i) => ({ id: `${n.id}_di_${i + 1}`, name }));
      const dataOutputs = (n.io.outputs ?? []).map((name, i) => ({ id: `${n.id}_do_${i + 1}`, name }));
      bpmn.ioSpecification = { dataInputs, dataOutputs };
    }
    return bpmn;
  };

  const buildNode = (n: FlatNode): NestedNode => {
    const node: NestedNode = { id: n.id, bpmn: buildBpmn(n) };
    if (ARTIFACT_TYPES.has(n.type)) {
      if (n.width !== undefined) node.width = n.width;
      if (n.height !== undefined) node.height = n.height;
    }
    const bes = boundaryByHost.get(n.id);
    if (bes && bes.length > 0) node.boundaryEvents = bes;
    // 展开的子流程：把内部节点收进 children、内部边收进 edges（递归，支持任意层嵌套）。
    // 结构同 process body，loader 会递归成 subProcesses（见 walkChildren 的 subProcess 分支）。
    const inner = childrenOfParent.get(n.id);
    if (inner && inner.length > 0) {
      node.children = inner.filter((c) => !isBoundary(c)).map(buildNode);
      node.edges = edgesBySub.get(n.id) ?? [];
    }
    return node;
  };

  // boundary 节点先归集到宿主；attachedTo 悬空 / 缺失的 boundary 落入 orphanBoundaries，平铺进 body，
  // 由 validate-flat 报 BOUNDARY_HOST_MISSING / BOUNDARY_NOT_ATTACHED（带原始 attachedTo 值），不静默吞掉。
  const boundaryByHost = new Map<string, NestedNode[]>();
  const orphanBoundaryIds = new Set<string>();
  for (const n of nodes) {
    if (!isBoundary(n)) continue;
    if (typeof n.attachedTo === 'string' && nodeById.has(n.attachedTo)) {
      const be: NestedNode = {
        id: n.id,
        bpmn: {
          type: 'boundaryEvent',
          ...(n.name !== undefined ? { name: n.name } : {}),
          ...(n.eventDefinitionType !== undefined ? { eventDefinitionType: n.eventDefinitionType } : {}),
          isInterrupting: n.isInterrupting !== false,
        },
      };
      const list = boundaryByHost.get(n.attachedTo) ?? [];
      list.push(be);
      boundaryByHost.set(n.attachedTo, list);
    } else {
      orphanBoundaryIds.add(n.id);
    }
  }

  // 子流程内部节点按 parent 归集（含递归：内部节点本身也可是带 children 的子流程）。
  const childrenOfParent = new Map<string, FlatNode[]>();
  for (const n of nodes) {
    if (isBoundary(n) || !isInner(n)) continue;
    const list = childrenOfParent.get(n.parent!) ?? [];
    list.push(n);
    childrenOfParent.set(n.parent!, list);
  }

  // 顶层流程节点：非 boundary、且不在任何子流程内部（内部节点由其父子流程的 children 承载）。
  // 无宿主的 orphan boundary 仍留在顶层，让 validate 报错而不是静默吞掉。
  const flowNodes = nodes.filter(
    (n) => (!isBoundary(n) && !isInner(n)) || orphanBoundaryIds.has(n.id)
  );

  // ---- 容器装配 ----
  // 在某 pool（或单 process）内，按 lane 把 flowNodes 分组成 children；无 lane 则平铺。
  const buildContainerChildren = (poolId: string): NestedNode[] => {
    const lanesHere = lanes.filter((l) =>
      hasPools ? l.pool === poolId : true,
    );
    const inPool = (n: FlatNode) => poolOfNode(n.id) === poolId;

    if (lanesHere.length === 0) {
      // 无泳道：节点平铺（保持作者数组顺序）。
      return flowNodes.filter(inPool).map(buildNode);
    }

    const laneIdsHere = new Set(lanesHere.map((l) => l.id));
    // parentLane 仅当指向本池内存在的泳道才算嵌套；悬空 / 跨池 parentLane 一律视为顶层泳道，
    // 这样该泳道及其成员不会因为 parentLane 写错而整段消失（validate-flat 报 LANE_PARENT_MISSING）。
    const normParent = (l: (typeof lanesHere)[number]) =>
      l.parentLane && laneIdsHere.has(l.parentLane) ? l.parentLane : undefined;
    const childrenLaneIds = (parent: string | undefined) =>
      lanesHere.filter((l) => normParent(l) === parent).map((l) => l.id);

    // placed：被某个叶子泳道收纳的节点 id。未被收纳者（无 lane / lane 悬空 / lane 是非叶子泳道）落到 stray，
    // 绝不静默丢弃——validate-flat 会针对其成因报 LANE_REF_MISSING / LANE_NOT_LEAF。
    // membersOf 只会被叶子泳道调用（buildLane 仅在 subLaneIds 为空时取成员），非叶子泳道的成员自然落 stray。
    const placed = new Set<string>();
    const membersOf = (laneId: string) =>
      flowNodes.filter((n) => inPool(n) && n.lane === laneId);

    const buildLane = (laneId: string, partition: number): NestedNode => {
      const lane = laneById.get(laneId)!;
      const subLaneIds = childrenLaneIds(laneId);
      const children: NestedNode[] = [];
      if (subLaneIds.length > 0) {
        subLaneIds.forEach((sid, i) => children.push(buildLane(sid, i)));
      } else {
        for (const m of membersOf(laneId)) {
          children.push(buildNode(m));
          placed.add(m.id);
        }
      }
      return {
        id: lane.id,
        bpmn: { type: 'lane', name: lane.name ?? lane.id },
        layoutOptions: { 'elk.partitioning.partition': partition },
        children,
      };
    };

    const top = childrenLaneIds(undefined).map((lid, i) => buildLane(lid, i));
    const stray = flowNodes.filter((n) => inPool(n) && !placed.has(n.id)).map(buildNode);
    return [...top, ...stray];
  };

  const hasLanesIn = (poolId: string) =>
    lanes.some((l) => (hasPools ? l.pool === poolId : true));

  // ---- 边分桶 ----
  const collabEdges: NestedEdge[] = [];
  const edgesByPool = new Map<string, NestedEdge[]>();
  const edgesBySub = new Map<string, NestedEdge[]>(); // 子流程内部边（buildNode 读它挂到 subProcess.edges）
  const pushPoolEdge = (poolId: string, e: NestedEdge) => {
    const list = edgesByPool.get(poolId) ?? [];
    list.push(e);
    edgesByPool.set(poolId, list);
  };
  const pushSubEdge = (subId: string, e: NestedEdge) => {
    const list = edgesBySub.get(subId) ?? [];
    list.push(e);
    edgesBySub.set(subId, list);
  };

  const buildEdgeBpmn = (e: FlatEdge, resolvedType: string): Record<string, unknown> => {
    const bpmn: Record<string, unknown> = { type: resolvedType };
    if (e.name !== undefined) bpmn.name = e.name;
    if (e.isDefault) bpmn.isDefault = true;
    if (e.condition !== undefined) bpmn.conditionExpression = { body: e.condition };
    if (ASSOCIATION_TYPES.has(resolvedType)) {
      bpmn.associationDirection = e.associationDirection ?? 'None';
    }
    return bpmn;
  };

  // 进程/子流程内部边只能是 sequenceFlow 或 association；显式 messageFlow 在同一进程作用域内非法，
  // 一律归正成 sequenceFlow（对称于跨池 sequenceFlow→messageFlow 的归正）。validate-flat 报 MSGFLOW_INTRA 告警。
  const intraType = (explicit: string | undefined): string =>
    explicit && explicit !== 'messageFlow' ? explicit : 'sequenceFlow';

  for (const e of edges) {
    const sp = poolOfNode(e.source);
    const tp = poolOfNode(e.target);
    const explicit = e.type;
    const isAssoc = explicit !== undefined && ASSOCIATION_TYPES.has(explicit);

    // 两端在同一个子流程内部 → 归该子流程的 edges（结构同 process body 的边）。
    const ssub = subOf(e.source);
    if (ssub !== null && ssub === subOf(e.target)) {
      pushSubEdge(ssub, { id: e.id, sources: [e.source], targets: [e.target], bpmn: buildEdgeBpmn(e, intraType(explicit)) });
      continue;
    }

    if (!hasPools) {
      // 单 process：所有边进该 process。
      pushPoolEdge(SINGLE_PROCESS_ID, { id: e.id, sources: [e.source], targets: [e.target], bpmn: buildEdgeBpmn(e, intraType(explicit)) });
      continue;
    }

    // 协作模式：跨池或 messageFlow → collaboration；否则归 source 所在 participant。
    const crossPool = sp !== undefined && tp !== undefined && sp !== tp;
    if (explicit === 'messageFlow' || (crossPool && !isAssoc && explicit === undefined) || (crossPool && explicit === 'sequenceFlow')) {
      // 跨池连线只能是 messageFlow：显式 messageFlow、或缺省/被误标 sequenceFlow 的跨池边一律归正。
      collabEdges.push({ id: e.id, sources: [e.source], targets: [e.target], bpmn: buildEdgeBpmn(e, 'messageFlow') });
    } else if (isAssoc && crossPool) {
      collabEdges.push({ id: e.id, sources: [e.source], targets: [e.target], bpmn: buildEdgeBpmn(e, explicit!) });
    } else {
      // 同池内部边（含被误标 messageFlow 的）。owner 用能解析到的那端的池；两端都未知才退到 pools[0]，
      // 此种「池归属未知」的边其端点必然触发 validate-flat 的 NODE_POOL_UNRESOLVED，不会静默错图。
      const owner = sp ?? tp ?? pools[0]!.id;
      pushPoolEdge(owner, { id: e.id, sources: [e.source], targets: [e.target], bpmn: buildEdgeBpmn(e, intraType(explicit)) });
    }
  }

  // ---- 顶层组装 ----
  const rootLayout = flat.layoutOptions ?? { ...DEFAULT_LAYOUT };

  if (!hasPools) {
    const process: NestedNode = {
      id: SINGLE_PROCESS_ID,
      bpmn: { type: 'process', name: '流程', isExecutable: true },
      children: buildContainerChildren(SINGLE_PROCESS_ID),
      edges: edgesByPool.get(SINGLE_PROCESS_ID) ?? [],
    };
    if (hasLanesIn(SINGLE_PROCESS_ID)) {
      process.layoutOptions = { 'elk.partitioning.activate': true };
    }
    return {
      id: flat.id ?? 'definitions_1',
      layoutOptions: rootLayout,
      children: [process],
    };
  }

  const participants: NestedNode[] = pools.map((pool) => {
    if (pool.isBlackBox) {
      return { id: pool.id, bpmn: { type: 'participant', name: pool.name ?? pool.id, isBlackBox: true } };
    }
    const part: NestedNode = {
      id: pool.id,
      bpmn: { type: 'participant', name: pool.name ?? pool.id, processRef: `${pool.id}_process` },
      children: buildContainerChildren(pool.id),
      edges: edgesByPool.get(pool.id) ?? [],
    };
    if (hasLanesIn(pool.id)) {
      part.layoutOptions = { 'elk.partitioning.activate': true, 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT' };
    }
    return part;
  });

  return {
    id: flat.id ?? 'definitions_1',
    layoutOptions: rootLayout,
    children: [
      {
        id: 'collaboration_1',
        bpmn: { type: 'collaboration' },
        children: participants,
        edges: collabEdges,
      },
    ],
  };
}
