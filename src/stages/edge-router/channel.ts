// Stage 4d: ChannelAllocator
//
// 给"会并行走同一片空间"的 edge 分配通道编号，避免重叠。当前处理：
//   - back-edge：拱在 spine 之上/之下；按 source.x 排，最左拱最里
//   - cross-lane（同向）：穿 lane gap 时，按 source.x 排
//   - cross-pool（同向）：穿 pool gap 时，按 source.x 排
//   - boundary-to-handler：BE→handler 的水平中段都在 host bottom 和 handler top
//     之间的同一条 corridor 里，多条会叠成同一 Y。按 source.x 排让每条占独立 Y。
//
// 通道编号 0,1,2,...；PathShaper 用编号算出实际的 archY / mid 偏移。

import type { EdgeType } from '../types.ts';

export interface ChannelEdge {
  id: string;
  edgeType: EdgeType;
  // 用于排序
  sourceX: number;
}

export interface ChannelAssignment {
  channel: number;
  /** 同一 bucket 内的 edge 总数，PathShaper 用来居中分布 */
  total: number;
}

// 哪些 EdgeType 共享同一通道空间
function bucketKey(t: EdgeType): string | null {
  switch (t) {
    case 'back-edge-up-left':    return 'back-up';
    case 'back-edge-down-left':  return 'back-down';
    // 跨行回连（含折行的 carriage-return，几何上是 back-row-down）共用「行间走廊」这一个
    // 通道空间——方向相反但中段横线落在同一条 gap 中线上会叠线（47 的 wrap 横线
    // 与两条 back-row-up 的 jog 全叠在 y=220），所以 up/down 进同一个 bucket 摊开。
    case 'back-row-down':        return 'back-row';
    case 'back-row-up':          return 'back-row';
    case 'cross-lane-down':      return 'lane-down';
    case 'cross-lane-up':        return 'lane-up';
    case 'cross-pool-down':      return 'pool-down';
    case 'cross-pool-up':        return 'pool-up';
    case 'boundary-to-handler':  return 'be-handler';
    default: return null;
  }
}

// excludeIds：已被 fan-in bundle 接管的 edge。它们不参与 bucket 摊开——否则「先按 sourceX
// 摊到不同 Y」会和「聚成一根共享干线」打架。被排除的 edge channel 默认 0（见结尾兜底）。
export function allocateChannels(
  edges: ChannelEdge[],
  excludeIds?: ReadonlySet<string>,
): Map<string, ChannelAssignment> {
  const buckets = new Map<string, ChannelEdge[]>();
  for (const e of edges) {
    if (excludeIds?.has(e.id)) continue;
    const key = bucketKey(e.edgeType);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(e);
  }
  const out = new Map<string, ChannelAssignment>();
  for (const [, list] of buckets) {
    list.sort((a, b) => a.sourceX - b.sourceX);
    list.forEach((e, idx) => out.set(e.id, { channel: idx, total: list.length }));
  }
  // 其他类型 channel 默认 0
  for (const e of edges) if (!out.has(e.id)) out.set(e.id, { channel: 0, total: 1 });
  return out;
}
