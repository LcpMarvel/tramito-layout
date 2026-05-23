// LabelPlacer — Edge label 防重叠摆位算法（纯函数）。
//
// 抽出位置：原 `src/serializer/transform/diagram-builder.ts` 的 calculateSmartLabelPosition +
// isPointNearNode + labelOverlapsAnyNode + labelOverlapsAnyEdgeLabel + boundsOverlap。
// CLAUDE.md "还没处理的债务" 第 1 条第 5 项：原代码"没有 stage 负责，单独抽一个 label-placer
// stage 比留在 serializer 干净"。
//
// M4 起由 merger 在序列化前调用：输入是 EdgeRouter/AssociationRouter 完成局部绕障和
// gateway endpoint finalization 后的最终 waypoints，serializer 只消费这里写好的 label bounds。
//
// 算法（保留原 serializer 实现的行为，避免 PNG 回归）：
//   1. 找 edge 最长非"靠端点"的 segment
//   2. 沿该 segment 选候选位置；按 CLAUDE.md L2 > L3 优先级：
//      noNode + noLabel > noNode (压 label) > noLabel (压 node) > 初始位置
//   3. 容器节点（pool / lane / process / collaboration / 展开 subProcess）跳过 overlap 检测

import type { LabelBox, LabelObstacle, Rect, Waypoint } from './types.ts';

export interface LabelPlaceContext {
  /** 已放置的 label rect，用于 L3 避免堆叠 */
  placedLabels: LabelBox[];
  /** 叶子节点 bbox 列表，用于 L2 避免压 node（容器节点已剔除） */
  nodeObstacles: LabelObstacle[];
  /** edge 端点节点的 bbox（用于"远离端点"启发式） */
  sourceBox?: Rect;
  targetBox?: Rect;
}

/**
 * 为单条 edge 选择 label 摆位坐标。返回 label 左上角。caller 需要把返回值连同 width/height
 * 写进 `placedLabels` 才能让下一条 edge 看到（避免 L3 堆叠）。
 *
 * 这是从 calculateSmartLabelPosition 1:1 提取的纯函数版本。
 */
export function pickLabelPosition(
  waypoints: Waypoint[],
  labelWidth: number,
  labelHeight: number,
  ctx: LabelPlaceContext,
): { x: number; y: number } {
  if (waypoints.length < 2) return { x: 0, y: 0 };

  // 1. 选 segment：优先"足够长" + 不靠端点节点
  let bestIdx = -1;
  let bestLen = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i]!;
    const b = waypoints[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 30) continue;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const tooCloseSrc = ctx.sourceBox && isPointNearNode(mx, my, ctx.sourceBox, 20);
    const tooCloseTgt = ctx.targetBox && isPointNearNode(mx, my, ctx.targetBox, 20);
    if (!tooCloseSrc && !tooCloseTgt && len > bestLen) { bestLen = len; bestIdx = i; }
  }
  if (bestIdx < 0) {
    for (let i = 0; i < waypoints.length - 1; i++) {
      const len = Math.hypot(waypoints[i + 1]!.x - waypoints[i]!.x, waypoints[i + 1]!.y - waypoints[i]!.y);
      if (len > bestLen) { bestLen = len; bestIdx = i; }
    }
  }
  if (bestIdx < 0) bestIdx = 0;

  const wpStart = waypoints[bestIdx]!;
  const wpEnd = waypoints[bestIdx + 1]!;
  const midX = (wpStart.x + wpEnd.x) / 2;
  const midY = (wpStart.y + wpEnd.y) / 2;
  const dx = wpEnd.x - wpStart.x;
  const dy = wpEnd.y - wpStart.y;
  const isHorizontal = Math.abs(dx) > Math.abs(dy);
  const segmentLength = Math.hypot(dx, dy);
  const OFFSET = 5;

  // 优先级 noNode+noLabel > noNode > noLabel > 初始位置
  const pickBest = (
    candidates: { x: number; y: number }[],
    fallbackInit: { x: number; y: number },
  ): { x: number; y: number } => {
    let fallback = fallbackInit;
    let tier = 0;
    for (const pos of candidates) {
      const rect: LabelBox = { x: pos.x, y: pos.y, width: labelWidth, height: labelHeight };
      const overlapsNode = anyOverlap(rect, ctx.nodeObstacles);
      const overlapsLabel = anyOverlap(rect, ctx.placedLabels);
      if (!overlapsNode && !overlapsLabel) return pos;
      if (!overlapsNode && tier < 2) { fallback = pos; tier = 2; }
      else if (!overlapsLabel && tier < 1) { fallback = pos; tier = 1; }
    }
    return fallback;
  };

  if (isHorizontal) {
    const labelX = midX - labelWidth / 2;
    const baseAbove = midY - labelHeight - OFFSET;
    const baseBelow = midY + OFFSET;
    const candidates: { x: number; y: number }[] = [];
    for (let step = 0; step <= 5; step++) {
      const delta = step * (labelHeight + 4);
      candidates.push({ x: labelX, y: baseAbove - delta });
      candidates.push({ x: labelX, y: baseBelow + delta });
    }
    return pickBest(candidates, candidates[0]!);
  }

  // 竖直段
  const positions = segmentLength > 80
    ? [0.35, 0.5, 0.65, 0.2, 0.8, 0.15, 0.85]
    : [0.5];
  for (const ratio of positions) {
    const testY = wpStart.y + (wpEnd.y - wpStart.y) * ratio - labelHeight / 2;
    const right: LabelBox = { x: midX + OFFSET, y: testY, width: labelWidth, height: labelHeight };
    if (!anyOverlap(right, ctx.nodeObstacles) && !anyOverlap(right, ctx.placedLabels)) {
      return { x: right.x, y: testY };
    }
    const left: LabelBox = { x: midX - labelWidth - OFFSET, y: testY, width: labelWidth, height: labelHeight };
    if (!anyOverlap(left, ctx.nodeObstacles) && !anyOverlap(left, ctx.placedLabels)) {
      return { x: left.x, y: testY };
    }
  }
  // Fallback 扩大搜索范围（fixture 31 多 pool 密集场景）
  const baseLabelY = midY - labelHeight / 2;
  const xOffsets = [OFFSET, OFFSET + 15, OFFSET + 30, OFFSET + 60];
  const candidates: { x: number; y: number }[] = [];
  for (let yOffset = 0; yOffset <= 200; yOffset += 20) {
    for (const xOff of xOffsets) {
      for (const side of [1, -1]) {
        for (const yDir of [0, 1, -1]) {
          const testX = side === 1 ? midX + xOff : midX - labelWidth - xOff;
          const testY = baseLabelY + yDir * yOffset;
          candidates.push({ x: testX, y: testY });
        }
      }
    }
  }
  return pickBest(candidates, { x: midX + OFFSET, y: baseLabelY });
}

// ============================================================
// 几何工具
// ============================================================

function isPointNearNode(x: number, y: number, n: Rect, padding: number): boolean {
  return x >= n.x - padding && x <= n.x + n.width + padding
      && y >= n.y - padding && y <= n.y + n.height + padding;
}

function rectOverlap(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.width < b.x || b.x + b.width < a.x
    || a.y + a.height < b.y || b.y + b.height < a.y
  );
}

function anyOverlap(a: Rect, list: Rect[]): boolean {
  for (const b of list) if (rectOverlap(a, b)) return true;
  return false;
}
