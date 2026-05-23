// Aesthetic metrics used by scripts/run-metrics.ts.
//
// 跑完整个 pipeline 后，对每个 fixture 算一组指标。供阈值校准和回归用。

import type { EdgeRoute } from '../stages/types.ts';
import type { NodeBox } from '../stages/types.ts';

export interface FixtureMetrics {
  fixture: string;
  /** spine 直度：所有 forward-straight edge 占总数比例（高=好） */
  spineStraightness: number;
  /** 平均 bend 数（每条 edge 的 waypoints.length - 2，0 表示直线） */
  avgEdgeBendCount: number;
  /** 最大 bend 数 */
  maxEdgeBendCount: number;
  /** 长宽比（width/height）；BPMN 偏好横向 */
  aspectRatio: number;
  /** 节点 bbox 之间的重叠数（>0 = 有问题） */
  overlapCount: number;
  /** 平均 edge 长度（waypoint 路径长度） */
  avgEdgeLength: number;
  /** 节点总数 */
  nodeCount: number;
  /** 边总数 */
  edgeCount: number;
}

export interface MetricsInput {
  fixture: string;
  nodes: Map<string, NodeBox>;
  routes: Map<string, EdgeRoute>;
  totalBounds: { width: number; height: number };
}

export function computeMetrics(input: MetricsInput): FixtureMetrics {
  const routes = [...input.routes.values()];
  const edgeCount = routes.length;
  const nodeCount = input.nodes.size;

  // 1. spine straightness：waypoint 数 == 2 的 edge 比例（首末点直线，无 bend）
  const straightCount = routes.filter(r => r.waypoints.length === 2).length;
  const spineStraightness = edgeCount > 0 ? straightCount / edgeCount : 0;

  // 2. bend count：waypoints.length - 2（首末点不算 bend）
  let totalBends = 0;
  let maxBends = 0;
  let totalLen = 0;
  for (const r of routes) {
    const bends = Math.max(0, r.waypoints.length - 2);
    totalBends += bends;
    if (bends > maxBends) maxBends = bends;
    // 边长
    for (let i = 1; i < r.waypoints.length; i++) {
      const a = r.waypoints[i - 1]!;
      const b = r.waypoints[i]!;
      totalLen += Math.hypot(b.x - a.x, b.y - a.y);
    }
  }
  const avgEdgeBendCount = edgeCount > 0 ? totalBends / edgeCount : 0;
  const avgEdgeLength = edgeCount > 0 ? totalLen / edgeCount : 0;

  // 3. aspect ratio
  const aspectRatio = input.totalBounds.height > 0
    ? input.totalBounds.width / input.totalBounds.height
    : 0;

  // 4. overlap：节点两两 bbox 相交
  const arr = [...input.nodes.entries()];
  let overlapCount = 0;
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      const [, a] = arr[i]!;
      const [, b] = arr[j]!;
      if (boxesOverlap(a, b)) overlapCount++;
    }
  }

  return {
    fixture: input.fixture,
    spineStraightness,
    avgEdgeBendCount,
    maxEdgeBendCount: maxBends,
    aspectRatio,
    overlapCount,
    avgEdgeLength,
    nodeCount,
    edgeCount,
  };
}

function boxesOverlap(a: NodeBox, b: NodeBox): boolean {
  // 严格相交（含部分重叠）；touching 边不算
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}
