// EdgeBundler: 拓扑识别 fan-in bundle（共 target 的归一束）。
//
// 这是 index.ts 里 busifyForwardStep（共 source 聚 forward-step）的镜像：
// 多条决策分支（gateway 出边）汇入同一个 sink 时，应聚成一根共享干线、单点进入，
// 而不是各自横穿画布、骑在 lane 分隔线上（fixture 39 的驳回归一诉求）。
//
// 判据纯拓扑、不读 label：
//   - **触发**：sink 的入边里有 ≥2 条「长程」（cross-lane / back）——避免误触本地并行
//     汇合（join gateway 的入边多是同区域短边、且来自 task）。
//   - **成员**：该 sink 所有「gateway 出发」的入边。gateway 是结构节点类型，捕获所有
//     分支/驳回边（含 gw_gm→end 这种同 lane 短驳回），而 task 出发的主流入边
//     （archive→end）不纳入——它留在原侧，保证 reject 落到「另一侧」。

import type { FlowNodeType } from '../../loader/types.ts';
import type { EdgeType } from '../types.ts';

export interface BundleEdge {
  id: string;
  source: string;
  target: string;
  edgeType: EdgeType;
}

export interface FanInBundle {
  sinkId: string;
  /** 归一束成员 edge id（均为 gateway 出发的入边） */
  memberIds: string[];
}

// 「长程」入边：跨 lane 或 back。只用于判定某 sink 是否值得归一，不直接当成员集合。
const LONG_RANGE_TYPES: ReadonlySet<EdgeType> = new Set<EdgeType>([
  'cross-lane-down',
  'cross-lane-up',
  'back-edge-up-left',
  'back-edge-down-left',
  'back-row-down',
  'back-row-up',
]);

function isGatewayType(type: FlowNodeType | undefined): boolean {
  return type === 'exclusiveGateway'
    || type === 'parallelGateway'
    || type === 'inclusiveGateway'
    || type === 'eventBasedGateway'
    || type === 'complexGateway';
}

export function detectFanInBundles(
  edges: BundleEdge[],
  nodeTypeOf: Map<string, FlowNodeType>,
): FanInBundle[] {
  const incomingByTarget = new Map<string, BundleEdge[]>();
  for (const e of edges) {
    if (!incomingByTarget.has(e.target)) incomingByTarget.set(e.target, []);
    incomingByTarget.get(e.target)!.push(e);
  }

  const bundles: FanInBundle[] = [];
  for (const [sinkId, incoming] of incomingByTarget) {
    const longRange = incoming.filter(e => LONG_RANGE_TYPES.has(e.edgeType));
    if (longRange.length < 2) continue; // 触发门槛：≥2 条长程入边才算 fan-in sink

    const members = incoming.filter(e => isGatewayType(nodeTypeOf.get(e.source)));
    if (members.length < 2) continue;

    bundles.push({ sinkId, memberIds: members.map(m => m.id) });
  }
  return bundles;
}
