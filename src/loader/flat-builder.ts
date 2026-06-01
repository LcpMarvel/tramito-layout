// flatToNested：把扁平 ELK-BPMN（flat-types.ts）确定性编译成嵌套 ELK-BPMN JSON。
//
// 这是「把嵌套装配从模型手里拿到代码里」的核心：模型只产出平铺的 nodes/edges + 归属 ID 字段，
// 这里按构造生成正确的容器层级——lane.children 分组、boundary 挂宿主、边按两端泳池自动定层、
// partition 配置。因此 LANE_NODE_MISPLACED / BOUNDARY_EVENT_IN_CHILDREN / UNKNOWN_EDGE_TYPE /
// MSGFLOW_NOT_IN_COLLABORATION / SEQFLOW_CROSS_POOL / LANE_PARTITION_INCOMPLETE 这些结构类错误
// 从构造上不可能再发生。产物喂给现有 validateGraph + runPipeline，完全复用下游。
//
// 健壮性约定：本函数不为「语义错」兜底——遇到 attachedTo/lane 指向不存在节点等情况，安全地产出
// 一个能被 validateGraph 抓住并给出可读 feedback 的形态，而不是 throw（早抛留给真正的非法结构）。

import type { FlatBpmn, FlatNode, FlatEdge } from './flat-types.ts';

const DEFAULT_LAYOUT = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.spacing.nodeNode': 50,
  'elk.layered.spacing.nodeNodeBetweenLayers': 80,
} as const;

const EVENT_TYPES = new Set([
  'startEvent',
  'endEvent',
  'intermediateCatchEvent',
  'intermediateThrowEvent',
]);
// none 对 catch/boundary 非法（必须有触发器）；start/end/throw 的 none 合法，缺省补 none。
const EVENT_DEF_DEFAULTS_NONE = new Set(['startEvent', 'endEvent', 'intermediateThrowEvent']);
const ARTIFACT_TYPES = new Set([
  'dataObject',
  'dataObjectReference',
  'dataStoreReference',
  'textAnnotation',
  'group',
]);
const ASSOCIATION_TYPES = new Set(['association', 'dataInputAssociation', 'dataOutputAssociation']);

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
  const nodes = Array.isArray(flat.nodes) ? flat.nodes : [];
  const edges = Array.isArray(flat.edges) ? flat.edges : [];
  const pools = Array.isArray(flat.pools) ? flat.pools : [];
  const lanes = Array.isArray(flat.lanes) ? flat.lanes : [];
  const hasPools = pools.length > 0;

  const SINGLE_PROCESS_ID = 'process_root';
  const laneById = new Map(lanes.map((l) => [l.id, l]));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const isBoundary = (n: FlatNode) =>
    n.type === 'boundaryEvent' || (typeof n.attachedTo === 'string' && n.attachedTo.length > 0);

  // 节点 → 所属泳池 id。boundary 跟随宿主；endpoint 是 pool id 本身（黑盒池 messageFlow）也算它自己。
  const poolOfNode = (id: string): string | undefined => {
    if (pools.some((p) => p.id === id)) return id; // pool 本身作端点
    const n = nodeById.get(id);
    if (!n) return undefined;
    if (isBoundary(n) && typeof n.attachedTo === 'string') return poolOfNode(n.attachedTo);
    if (n.pool) return n.pool;
    if (n.lane) {
      const lane = laneById.get(n.lane);
      if (lane?.pool) return lane.pool;
    }
    if (!hasPools) return SINGLE_PROCESS_ID;
    if (pools.length === 1) return pools[0]!.id;
    return undefined; // 多池但无归属：交给下游（边可能跨「未知」池，validate 不拦但布局会归默认）
  };

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
    if (n.type === 'subProcess' || n.type === 'adHocSubProcess' || n.type === 'transaction') {
      bpmn.isExpanded = false; // 二期才支持展开内部流；本期折叠框
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
    return node;
  };

  // boundary 节点先归集到宿主；无 attachedTo 的 boundary 留作普通子节点（让 validate 报错）。
  const boundaryByHost = new Map<string, NestedNode[]>();
  const orphanBoundaries: FlatNode[] = [];
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
      orphanBoundaries.push(n);
    }
  }

  // 普通流程节点（非已归集的 boundary）。
  const flowNodes = nodes.filter((n) => !isBoundary(n) || orphanBoundaries.includes(n));

  // ---- 容器装配 ----
  // 在某 pool（或单 process）内，按 lane 把 flowNodes 分组成 children；无 lane 则平铺。
  const buildContainerChildren = (poolId: string): NestedNode[] => {
    const lanesHere = lanes.filter((l) =>
      hasPools ? l.pool === poolId : true,
    );
    const membersOf = (laneId: string) =>
      flowNodes.filter((n) => {
        if (poolOfNode(n.id) !== poolId) return false;
        return n.lane === laneId;
      });

    if (lanesHere.length === 0) {
      // 无泳道：节点平铺（保持作者数组顺序）。
      return flowNodes.filter((n) => poolOfNode(n.id) === poolId).map(buildNode);
    }

    // 有泳道：按 parentLane 构建泳道树，节点塞进各自 lane.children；partition 按同级序号。
    const childrenLaneIds = (parent: string | undefined) =>
      lanesHere.filter((l) => (l.parentLane ?? undefined) === parent).map((l) => l.id);

    const buildLane = (laneId: string, partition: number): NestedNode => {
      const lane = laneById.get(laneId)!;
      const subLaneIds = childrenLaneIds(laneId);
      const children: NestedNode[] = [];
      if (subLaneIds.length > 0) {
        subLaneIds.forEach((sid, i) => children.push(buildLane(sid, i)));
      } else {
        for (const m of membersOf(laneId)) children.push(buildNode(m));
      }
      return {
        id: lane.id,
        bpmn: { type: 'lane', name: lane.name ?? lane.id },
        layoutOptions: { 'elk.partitioning.partition': partition },
        children,
      };
    };

    const top = childrenLaneIds(undefined).map((lid, i) => buildLane(lid, i));
    // 归属本池但 lane 指向不存在/未在本池声明的节点：直接平铺到 body（validate 会报 LANE_NODE_MISPLACED）。
    const stray = flowNodes
      .filter((n) => poolOfNode(n.id) === poolId && !(n.lane && lanesHere.some((l) => l.id === n.lane)))
      .map(buildNode);
    return [...top, ...stray];
  };

  const hasLanesIn = (poolId: string) =>
    lanes.some((l) => (hasPools ? l.pool === poolId : true));

  // ---- 边分桶 ----
  const collabEdges: NestedEdge[] = [];
  const edgesByPool = new Map<string, NestedEdge[]>();
  const pushPoolEdge = (poolId: string, e: NestedEdge) => {
    const list = edgesByPool.get(poolId) ?? [];
    list.push(e);
    edgesByPool.set(poolId, list);
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

  for (const e of edges) {
    const sp = poolOfNode(e.source);
    const tp = poolOfNode(e.target);
    const explicit = e.type;
    const isAssoc = explicit !== undefined && ASSOCIATION_TYPES.has(explicit);

    if (!hasPools) {
      // 单 process：所有边进该 process。
      const type = explicit ?? 'sequenceFlow';
      pushPoolEdge(SINGLE_PROCESS_ID, { id: e.id, sources: [e.source], targets: [e.target], bpmn: buildEdgeBpmn(e, type) });
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
      const type = explicit ?? 'sequenceFlow';
      const owner = sp ?? tp ?? pools[0]!.id;
      pushPoolEdge(owner, { id: e.id, sources: [e.source], targets: [e.target], bpmn: buildEdgeBpmn(e, type) });
    }
  }

  // ---- 顶层组装 ----
  const rootLayout = flat.layoutOptions ?? { ...DEFAULT_LAYOUT };

  if (!hasPools) {
    const process: NestedNode = {
      id: SINGLE_PROCESS_ID,
      bpmn: { type: 'process', name: flat.id ? undefined : '流程', isExecutable: true },
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
