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
export interface LabelPlaceOptions {
  /**
   * 把 label 锚到靠近 source 的第一段上，而不是最长段的中点。用于 gateway 分支边：分支条件
   * label（充足/不足/已发货…）按 BPMN 惯例贴在网关旁、谁分出来一眼可见，而不是飘到线中段。
   * 手调 fixture 41 揭示。
   */
  anchorNearSource?: boolean;
  /**
   * 同源、同样带 label 的兄弟边路径（merger 预按 source 聚组，≥3 条才给）。
   * 共享出口 stub 时 label 要移到各自第一段独占段（见 firstExclusiveSegment）。
   */
  siblingWaypoints?: Waypoint[][];
}

export function pickLabelPosition(
  waypoints: Waypoint[],
  labelWidth: number,
  labelHeight: number,
  ctx: LabelPlaceContext,
  opts?: LabelPlaceOptions,
): { x: number; y: number } {
  if (waypoints.length < 2) return { x: 0, y: 0 };

  if (opts?.anchorNearSource) {
    return pickNearSource(waypoints, labelWidth, labelHeight, ctx, opts);
  }

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

/**
 * 把 label 贴在靠近 source（网关）的第一段上。沿该段从 source 端外移 ~22px 取锚点，再向两侧
 * 法向偏移让 label 离开流程线；按 L2 > L3 优先级（noNode+noLabel > noNode > noLabel）选最干净的
 * 落点，必要时沿线略微外移 / 换边。撞不开时退回靠 source 的初始候选（最小扰动）。
 */
function pickNearSource(
  waypoints: Waypoint[],
  labelWidth: number,
  labelHeight: number,
  ctx: LabelPlaceContext,
  opts?: LabelPlaceOptions,
): { x: number; y: number } {
  // 跳过过短的引出 stub，取第一段有意义的段（其 wpStart 即更靠 source 的一端）
  let idx = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const len = Math.hypot(waypoints[i + 1]!.x - waypoints[i]!.x, waypoints[i + 1]!.y - waypoints[i]!.y);
    if (len >= 20) { idx = i; break; }
  }
  if (opts?.siblingWaypoints && opts.siblingWaypoints.length >= 2) {
    idx = firstExclusiveSegment(waypoints, opts.siblingWaypoints, idx);
  }
  const a = waypoints[idx]!;
  const b = waypoints[idx + 1]!;
  const segLen = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / segLen;
  const uy = (b.y - a.y) / segLen;
  const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
  const OFFSET = 5;
  // 法向基础距离：让 label 边缘离线 ~OFFSET（竖线用 labelWidth/2，横线用 labelHeight/2）
  const perpBase = horizontal ? labelHeight / 2 + OFFSET : labelWidth / 2 + OFFSET;
  const along = Math.min(22, segLen * 0.5);
  // 法向单位向量（把 along 单位向量旋转 90°）
  const px = -uy;
  const py = ux;

  // 候选优先级：先尽量贴线（perp 距离 extra 小）、再尽量贴网关（alongShift 小），两侧都试过
  // 才放大 perp。这样 label 紧贴线、靠网关；只有近处都被占时才外移（避免一侧近处被挡就甩很远）。
  const candidates: { x: number; y: number }[] = [];
  for (let extra = 0; extra <= 2; extra++) {
    const d = perpBase + extra * (horizontal ? labelHeight + 4 : labelWidth / 2 + 4);
    for (const alongShift of [0, 12, -8, 26, 40]) {
      const t = Math.max(8, Math.min(segLen - 4, along + alongShift));
      const cx0 = a.x + ux * t;
      const cy0 = a.y + uy * t;
      for (const side of [1, -1]) {
        const cx = cx0 + px * side * d;
        const cy = cy0 + py * side * d;
        candidates.push({ x: cx - labelWidth / 2, y: cy - labelHeight / 2 });
      }
    }
  }

  let fallback = candidates[0]!;
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
}

// 同源 ≥3 条带 label 的边共享出口 stub 时（56：8 条同走 (408,562)→(448,562) 再分叉；
// 90：6 条同走一段），每条 label 锚在同一段上必叠（L3）。改锚到「第一段独占段」——
// 中点不在任何兄弟路径上的段（分叉之后的那一段）。
// 出口段不共享则不动（04/42 的扇出各走不同 anchor，近网关摆位本来就错得开）。
function firstExclusiveSegment(waypoints: Waypoint[], siblings: Waypoint[][], fallback: number): number {
  const midOnPolyline = (segIdx: number, poly: Waypoint[]): boolean => {
    const a = waypoints[segIdx]!;
    const b = waypoints[segIdx + 1]!;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    for (let j = 0; j < poly.length - 1; j++) {
      if (pointToSegmentDist(mx, my, poly[j]!, poly[j + 1]!) <= 2) return true;
    }
    return false;
  };
  const sharedExit = siblings.filter(poly => midOnPolyline(0, poly)).length >= 2;
  if (!sharedExit) return fallback;
  for (let i = 1; i < waypoints.length - 1; i++) {
    if (siblings.every(poly => !midOnPolyline(i, poly))) return i;
  }
  return fallback;
}

function pointToSegmentDist(px: number, py: number, a: Waypoint, b: Waypoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - a.x, py - a.y);
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lenSq));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
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
