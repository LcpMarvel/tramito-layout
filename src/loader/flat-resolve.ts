// 扁平输入的「归属解析」单点：node → 所属子流程 / 所属泳池 的推断逻辑，flat-builder 与 validate-flat 共用。
//
// WHY 抽出来：构造器（flatToNested）和校验器（validateFlat）都要回答「这节点在哪个子流程 / 哪个池」。
// 两边各写一份必然漂移（实测：构造器吞了的节点，校验器看不到、报不出错）。单点定义 + 环守卫，
// 保证「校验器判定的归属」与「构造器实际放置的归属」永远一致。
//
// 环守卫（seen）：attachedTo / parent 形成环（自指或互指）时，递归会爆栈把进程跑死——而这是用户可改的
// 输入错。这里遇环安全返回 null/undefined（当作顶层），把「报错」让给 validate-flat 的 REFERENCE_CYCLE，
// 符合「坏输入产出可校验形态、不 throw」的约定。

import { SUBPROCESS_TYPES } from './validate-graph.ts';
import type { FlatBpmn, FlatNode, FlatLane, FlatPool } from './flat-types.ts';

export const SINGLE_PROCESS_ID = 'process_root';

export interface FlatResolver {
  nodes: FlatNode[];
  edges: FlatBpmn['edges'] extends infer E ? NonNullable<E> : never;
  pools: FlatPool[];
  lanes: FlatLane[];
  hasPools: boolean;
  nodeById: Map<string, FlatNode>;
  laneById: Map<string, FlatLane>;
  isBoundary: (n: FlatNode) => boolean;
  /** node.parent 指向一个存在的「子流程类型」节点。parent 指向 task 等非子流程 → 不算 inner（让 validate 报错）。 */
  isInner: (n: FlatNode) => boolean;
  /** 节点所在最内层子流程 id（不在任何子流程内则 null）。boundary 跟随宿主；环安全返回 null。 */
  subOf: (id: string) => string | null;
  /** 节点所属泳池 id。boundary 跟随宿主；内部节点继承父子流程；endpoint 是 pool id 本身也算它自己；环安全返回 undefined。 */
  poolOfNode: (id: string) => string | undefined;
}

export function createFlatResolver(flat: FlatBpmn): FlatResolver {
  const nodes = Array.isArray(flat.nodes) ? flat.nodes : [];
  const edges = (Array.isArray(flat.edges) ? flat.edges : []) as FlatResolver['edges'];
  const pools = Array.isArray(flat.pools) ? flat.pools : [];
  const lanes = Array.isArray(flat.lanes) ? flat.lanes : [];
  const hasPools = pools.length > 0;

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const laneById = new Map(lanes.map((l) => [l.id, l]));

  const isBoundary = (n: FlatNode) =>
    n.type === 'boundaryEvent' || (typeof n.attachedTo === 'string' && n.attachedTo.length > 0);

  const isInner = (n: FlatNode) => {
    if (typeof n.parent !== 'string') return false;
    const p = nodeById.get(n.parent);
    return p !== undefined && SUBPROCESS_TYPES.has(p.type);
  };

  const subOf = (id: string): string | null => {
    const seen = new Set<string>();
    let cur: string | undefined = id;
    while (cur !== undefined) {
      if (seen.has(cur)) return null; // 环：当作顶层，REFERENCE_CYCLE 留给校验
      seen.add(cur);
      const n = nodeById.get(cur);
      if (!n) return null;
      if (isBoundary(n) && typeof n.attachedTo === 'string') {
        cur = n.attachedTo;
        continue;
      }
      return isInner(n) ? n.parent! : null;
    }
    return null;
  };

  const resolvesToHost = (id: string) => nodeById.has(id) || pools.some((p) => p.id === id);

  const poolOfNode = (id: string): string | undefined => {
    const seen = new Set<string>();
    let cur: string | undefined = id;
    while (cur !== undefined) {
      if (pools.some((p) => p.id === cur)) return cur; // pool 本身作端点（黑盒池 messageFlow）
      if (seen.has(cur)) return undefined; // 环：归属未知，REFERENCE_CYCLE 留给校验
      seen.add(cur);
      const n = nodeById.get(cur);
      if (!n) return undefined;
      // 宿主能解析才跟随；attachedTo 悬空时退化为按 boundary 自身 pool/lane 归属，使其在 body 现身（不静默丢）。
      if (isBoundary(n) && typeof n.attachedTo === 'string' && resolvesToHost(n.attachedTo)) {
        cur = n.attachedTo;
        continue;
      }
      if (isInner(n)) {
        cur = n.parent!;
        continue;
      }
      if (n.pool) return n.pool;
      if (n.lane) {
        const lane = laneById.get(n.lane);
        if (lane?.pool) return lane.pool;
      }
      if (!hasPools) return SINGLE_PROCESS_ID;
      if (pools.length === 1) return pools[0]!.id;
      return undefined; // 多池但无归属：NODE_POOL_UNRESOLVED 由校验报出
    }
    return undefined;
  };

  return {
    nodes,
    edges,
    pools,
    lanes,
    hasPools,
    nodeById,
    laneById,
    isBoundary,
    isInner,
    subOf,
    poolOfNode,
  };
}
