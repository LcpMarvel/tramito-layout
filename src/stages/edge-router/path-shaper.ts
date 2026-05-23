// Stage 4c: PathShaper
//
// 给定 (sourceAnchor, targetAnchor, sourceBox, targetBox, channel)，
// 生成 waypoints。形状决策来自 EdgeType + BPMN semantic style。

import type { Anchor, EdgeType, Waypoint } from '../types.ts';
import { anchorPoint } from './anchor.ts';
import type { NodeBox } from '../types.ts';
import {
  CHANNEL_GAP, BE_CHANNEL_GAP, ARCH_BASE_OFFSET, VERTICAL_STUB, ARCH_CLEAR_MARGIN,
  CROSS_LANE_UP_MIN_START_STUB, SHAPER_MARGIN,
  type RouterStyle,
} from '../bpmn-rules.ts';

export interface PathShapeInput {
  edgeType: EdgeType;
  sourceAnchor: Anchor;
  targetAnchor: Anchor;
  source: NodeBox;
  target: NodeBox;
  channel: number;
  /** 同一 bucket 内的 edge 总数，用于在 corridor 里居中分布 */
  channelTotal?: number;
  /** 跨 lane / 跨 pool 时用，确定中段走在哪一行 */
  gap?: { top: number; bottom: number };
  /** 1 档避障：source/target 之外的所有节点 bbox，用于让拱形清开中间节点 */
  obstacles?: NodeBox[];
  /**
   * BPMN 路由风格（A3）：
   *   - 'orthogonal'（默认）：sequence flow / boundary connector，走完整的 Z/L/拱形决策
   *   - 'polyline'：message flow，端点若已经接近对齐（≤ directTolerance）直接画 2-point 直线，
   *     否则退化到 orthogonal——让 message flow 在 pool 对齐时简洁、错位时仍能避障
   *   - 'direct'：association / compensationAssociation，永远 2-point 直线
   */
  routerStyle?: RouterStyle;
  directTolerance?: number;
  /** Same-row forward skip routes normally arch above; gateway fan-out labels sit above, so some routes prefer below. */
  forwardSkipObstacleSide?: 'above' | 'below';
}

export function shapePath(input: PathShapeInput): Waypoint[] {
  const { sourceAnchor, targetAnchor, source, target, channel } = input;
  const start = anchorPoint(source, sourceAnchor);
  const end = anchorPoint(target, targetAnchor);

  // A3 + C2-A: routerStyle === 'direct' → 2-point 直线，但端点间若穿过障碍 → 退回 orthogonal
  // 用于 association / compensationAssociation：BPMN 规范画虚线时不强制正交，但 BPMN 工具
  // 通常也不会让 association 直接穿任务框（视觉冲突）。所以"direct"实际是"prefer direct"。
  if (input.routerStyle === 'direct') {
    if (!segmentHitsObstacle(start, end, input.obstacles, input.source, input.target)) {
      return [start, end];
    }
    // fall through 走 orthogonal，让下面的 case 1-6 选合适的折线形状
  }

  // A3 + C2-A: routerStyle === 'polyline' + 端点接近对齐 → 2-point 直线，但同样要查避障
  // fixture 31 的 msgflow_order_request 命中此分支：客户 task → 跨 pool task，X 错位 < 30px
  // 触发 preferDirect，但直线段穿过中间 pool 的某个 task → E2 违例。
  // 加 segmentHitsObstacle 检测，命中则 fall through 让 orthogonal 接管。
  if (input.routerStyle === 'polyline' && input.directTolerance !== undefined) {
    const dx = Math.abs(start.x - end.x);
    const dy = Math.abs(start.y - end.y);
    const xAligned =
      (sourceAnchor === 'bottom' && targetAnchor === 'top' && dx <= input.directTolerance)
      || (sourceAnchor === 'top' && targetAnchor === 'bottom' && dx <= input.directTolerance);
    const yAligned =
      (sourceAnchor === 'right' && targetAnchor === 'left' && dy <= input.directTolerance)
      || (sourceAnchor === 'left' && targetAnchor === 'right' && dy <= input.directTolerance);
    if ((xAligned || yAligned) && !segmentHitsObstacle(start, end, input.obstacles, input.source, input.target)) {
      return [start, end];
    }
    // 否则 fall through 走 orthogonal——polyline 错位太多或被障碍挡时正交更可读
  }

  // 1. straight：同 cy 的 right↔left
  if (sourceAnchor === 'right' && targetAnchor === 'left' && approxEq(start.y, end.y)) {
    // 但若中间有 obstacle 节点的 X 区间挡着，直线会穿过它 → 改走上拱形
    // （forward-skip：gateway 跳过中间 task 直连后续节点是常见 BPMN 模式）
    if (hasObstacleInForwardPath(start, end, input.obstacles, input.source, input.target)) {
      if (input.forwardSkipObstacleSide === 'below') {
        let archY = clearObstaclesBelow(
          Math.max(start.y, end.y) + ARCH_BASE_OFFSET + channel * CHANNEL_GAP,
          start.x, end.x, input.obstacles, input.source, input.target,
        );
        archY = Math.max(archY, input.source.y + input.source.h + SHAPER_MARGIN, input.target.y + input.target.h + SHAPER_MARGIN);
        const archStart = { x: input.source.x + input.source.w / 2, y: input.source.y + input.source.h };
        const archEnd = { x: input.target.x + input.target.w / 2, y: input.target.y + input.target.h };
        return [archStart, { x: archStart.x, y: archY }, { x: archEnd.x, y: archY }, archEnd];
      }
      let archY = clearObstaclesAbove(
        Math.min(start.y, end.y) - ARCH_BASE_OFFSET - channel * CHANNEL_GAP,
        start.x, end.x, input.obstacles, input.source, input.target,
      );
      archY = Math.min(archY, input.source.y - SHAPER_MARGIN, input.target.y - SHAPER_MARGIN);
      const archStart = { x: input.source.x + input.source.w / 2, y: input.source.y };
      const archEnd = { x: input.target.x + input.target.w / 2, y: input.target.y };
      return [archStart, { x: archStart.x, y: archY }, { x: archEnd.x, y: archY }, archEnd];
    }
    return [start, end];
  }
  // 2. straight vertical：同 cx 的 bottom→top（含 branch / cross-lane / cross-pool 直对齐时）
  // C2-A: 若垂直线穿过中间节点（fixture 31 cross-pool 直对齐时跨过中间 pool 的 task），
  // 改走 Z 形：从 source 出发先竖直一段，横向推到障碍外，再竖直到 target 上方，最后横入。
  if (sourceAnchor === 'bottom' && targetAnchor === 'top' && approxEq(start.x, end.x)) {
    if (!segmentHitsObstacle(start, end, input.obstacles, input.source, input.target)) {
      return [start, end];
    }
    return detourVerticalAroundObstacle(start, end, input.obstacles, input.source, input.target);
  }
  if (sourceAnchor === 'top' && targetAnchor === 'bottom' && approxEq(start.x, end.x)) {
    if (!segmentHitsObstacle(start, end, input.obstacles, input.source, input.target)) {
      return [start, end];
    }
    return detourVerticalAroundObstacle(start, end, input.obstacles, input.source, input.target);
  }

  // 3. Z 形：right ↔ left 但 cy 不同
  if (sourceAnchor === 'right' && targetAnchor === 'left') {
    // 默认中点；若中点垂直段穿过中间节点的 X 区间，提前推到障碍外。
    // 不做这一步时，下游 routeAroundLocalObstacles 会"水平段+垂直段都各自滑动"，
    // 把 Z 拐成绕过障碍上方/下方的 5~6 段路径（fixture 17 的 cancel→end 即是）。
    const midX = clearVerticalAtMidX(
      (start.x + end.x) / 2, start.y, end.y,
      input.obstacles, input.source, input.target,
    );
    return [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end];
  }

  // 4. L 形：跨 lane / 跨 pool / branch / boundary→handler 等 bottom↔top
  if (sourceAnchor === 'bottom' && targetAnchor === 'top') {
    // 中段 Y：若给了 gap，走 gap 中线；否则 (start+end)/2
    let midY = (start.y + end.y) / 2;
    if (input.gap) {
      midY = input.gap.top + (input.gap.bottom - input.gap.top) * 0.5 + channel * CHANNEL_GAP - (channelCount(input) - 1) * CHANNEL_GAP / 2;
    } else if (input.edgeType === 'boundary-to-handler' && (input.channelTotal ?? 1) > 1) {
      // BE→handler corridor 多条平行；按 channel 在 [start.y, end.y] 范围内居中分布
      const total = input.channelTotal!;
      midY = (start.y + end.y) / 2 + (channel - (total - 1) / 2) * BE_CHANNEL_GAP;
    }
    return [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end];
  }
  if (sourceAnchor === 'top' && targetAnchor === 'bottom') {
    let midY = (start.y + end.y) / 2;
    if (input.gap) {
      midY = input.gap.top + (input.gap.bottom - input.gap.top) * 0.5 + channel * CHANNEL_GAP - (channelCount(input) - 1) * CHANNEL_GAP / 2;
    }
    if (input.edgeType === 'cross-lane-up') {
      midY = Math.max(
        end.y + VERTICAL_STUB,
        Math.min(midY, start.y - CROSS_LANE_UP_MIN_START_STUB),
      );
    }
    return [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end];
  }

  if ((sourceAnchor === 'bottom' || sourceAnchor === 'top') && targetAnchor === 'left') {
    let midY = (start.y + end.y) / 2;
    if (input.gap) {
      midY = input.gap.top + (input.gap.bottom - input.gap.top) * 0.5 + channel * CHANNEL_GAP - (channelCount(input) - 1) * CHANNEL_GAP / 2;
    }
    const approachX = end.x - VERTICAL_STUB;
    return [start, { x: start.x, y: midY }, { x: approachX, y: midY }, { x: approachX, y: end.y }, end];
  }

  // 5. 拱形上方：bottom↔bottom（back-edge-up-left）
  //    source 在右下，target 在左上：先出 source 底，绕到 source 下方，平移到 target 下方，进 target 底
  if (sourceAnchor === 'bottom' && targetAnchor === 'bottom') {
    let archY = Math.max(start.y, end.y) + ARCH_BASE_OFFSET + channel * CHANNEL_GAP;
    // 1 档避障：让拱形 Y 低于所有中间节点的 bottom
    archY = clearObstaclesBelow(archY, start.x, end.x, input.obstacles, input.source, input.target);
    return [start, { x: start.x, y: archY }, { x: end.x, y: archY }, end];
  }

  // 6. 拱形下方：top↔top（back-edge-down-left）
  if (sourceAnchor === 'top' && targetAnchor === 'top') {
    let archY = Math.min(start.y, end.y) - ARCH_BASE_OFFSET - channel * CHANNEL_GAP;
    archY = clearObstaclesAbove(archY, start.x, end.x, input.obstacles, input.source, input.target);
    return [start, { x: start.x, y: archY }, { x: end.x, y: archY }, end];
  }

  // 兜底：直连（不应到这里）
  return [start, end];
}

function approxEq(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.5;
}

// forward-straight 路径会穿过非 src/tgt 的节点吗？
// 判定：在 [start.x, end.x] X 范围内，有 obstacle 节点的 X 区间与之相交，
// 且 obstacle 的 Y 区间覆盖了 start.y（即水平直线会穿进 obstacle 的 bbox）。
function hasObstacleInForwardPath(
  start: { x: number; y: number },
  end: { x: number; y: number },
  obstacles: NodeBox[] | undefined,
  src: NodeBox, tgt: NodeBox,
): boolean {
  if (!obstacles || obstacles.length === 0) return false;
  const lo = Math.min(start.x, end.x);
  const hi = Math.max(start.x, end.x);
  for (const o of obstacles) {
    if (o === src || o === tgt) continue;
    if (o.x + o.w <= lo || o.x >= hi) continue;     // X 区间不交
    if (start.y < o.y || start.y > o.y + o.h) continue; // Y 不在 bbox 内
    return true;
  }
  return false;
}

// 同一类 channel 在 gap 里居中分布：用实际并行 edge 数（channel.ts 算出来传进来），
// 没传则按单条算（offset=0）。早先这里硬编码 3 会让单条 cross-lane edge 被偏移
// -18px，配上"两 lane 紧贴"的场景（gap.top==gap.bottom）会把 midY 推进 source 节点
// 内部（fixture 26 flow_2 的怪线就是这个原因）。
function channelCount(input: PathShapeInput): number {
  return input.channelTotal ?? 1;
}

/** archY 取所有 X 区间内的 obstacle bottom 的最大值 + margin */
function clearObstaclesBelow(
  archY: number,
  x1: number, x2: number,
  obstacles: NodeBox[] | undefined,
  src: NodeBox, tgt: NodeBox,
): number {
  if (!obstacles || obstacles.length === 0) return archY;
  const lo = Math.min(x1, x2);
  const hi = Math.max(x1, x2);
  let need = archY;
  for (const o of obstacles) {
    if (o === src || o === tgt) continue;
    // X 区间不交 → 不挡
    if (o.x + o.w <= lo || o.x >= hi) continue;
    const bottom = o.y + o.h + ARCH_CLEAR_MARGIN;
    if (bottom > need) need = bottom;
  }
  return need;
}

/**
 * Z 形（right→left）的 midX 避障：如果 preferredX 落在某个中间节点的 X 区间内，
 * 且该节点 Y 区间与垂直段 [y1,y2] 重叠，把 midX 推到该节点的外侧。
 *
 * 推的方向选 "离 preferredX 更近且仍落在 src.right..tgt.left 之间" 的那一边；
 * 若两边都越界，挑能落进 src/tgt 之间的那边；都不行则放弃由下游处理。
 */
function clearVerticalAtMidX(
  preferredX: number,
  y1: number, y2: number,
  obstacles: NodeBox[] | undefined,
  src: NodeBox, tgt: NodeBox,
): number {
  if (!obstacles || obstacles.length === 0) return preferredX;
  const yLo = Math.min(y1, y2);
  const yHi = Math.max(y1, y2);
  const MARGIN = SHAPER_MARGIN;
  const srcRight = src.x + src.w;
  const tgtLeft = tgt.x;
  // 多个障碍时反复推，最多遍历 N+1 次。
  for (let iter = 0; iter <= obstacles.length; iter++) {
    let shifted = false;
    for (const o of obstacles) {
      if (o === src || o === tgt) continue;
      if (o.y + o.h <= yLo || o.y >= yHi) continue;          // Y 不重叠 → 不挡
      if (preferredX <= o.x || preferredX >= o.x + o.w) continue;  // X 已在 obstacle 外
      const rightX = o.x + o.w + MARGIN;
      const leftX = o.x - MARGIN;
      const rightOk = rightX <= tgtLeft;
      const leftOk = leftX >= srcRight;
      if (rightOk && leftOk) {
        preferredX = (rightX - preferredX) <= (preferredX - leftX) ? rightX : leftX;
      } else if (rightOk) {
        preferredX = rightX;
      } else if (leftOk) {
        preferredX = leftX;
      } else {
        // 两边都越界（罕见），放弃，让 local-obstacle-detour 接手。
      }
      shifted = true;
    }
    if (!shifted) break;
  }
  return preferredX;
}

function clearObstaclesAbove(
  archY: number,
  x1: number, x2: number,
  obstacles: NodeBox[] | undefined,
  src: NodeBox, tgt: NodeBox,
): number {
  if (!obstacles || obstacles.length === 0) return archY;
  const lo = Math.min(x1, x2);
  const hi = Math.max(x1, x2);
  let need = archY;
  for (const o of obstacles) {
    if (o === src || o === tgt) continue;
    if (o.x + o.w <= lo || o.x >= hi) continue;
    const top = o.y - ARCH_CLEAR_MARGIN;
    if (top < need) need = top;
  }
  return need;
}

/**
 * 垂直线 X 对齐时被中间节点挡住 → 绕过去（C2-A，fixture 31）。
 * 路径：start → (sideX, start.y + stub) → (sideX, end.y - stub) → end，4 wp Z 形。
 * sideX 选离障碍 X 中线更近的那一边（左或右），加 SHAPER_MARGIN 距离。
 * 多个障碍时取"最远那一侧"以一次绕开全部（更稳）。
 */
function detourVerticalAroundObstacle(
  start: { x: number; y: number },
  end: { x: number; y: number },
  obstacles: NodeBox[] | undefined,
  src: NodeBox, tgt: NodeBox,
): Waypoint[] {
  if (!obstacles || obstacles.length === 0) return [start, end];
  const yLo = Math.min(start.y, end.y);
  const yHi = Math.max(start.y, end.y);
  // 收集所有"在 X=start.x 处挡道"的障碍 X 区间
  let needRightOf = -Infinity;
  let needLeftOf = Infinity;
  let blocked = false;
  for (const o of obstacles) {
    if (o === src || o === tgt) continue;
    if (o.y + o.h <= yLo || o.y >= yHi) continue;     // Y 不挡
    if (o.x + o.w <= start.x || o.x >= start.x) continue;  // 严格 X 在 obstacle 区间内
    if (o.x <= start.x && start.x <= o.x + o.w) {
      blocked = true;
      if (o.x + o.w + SHAPER_MARGIN > needRightOf) needRightOf = o.x + o.w + SHAPER_MARGIN;
      if (o.x - SHAPER_MARGIN < needLeftOf) needLeftOf = o.x - SHAPER_MARGIN;
    }
  }
  if (!blocked) return [start, end];
  // 选离 start.x 更近的那一侧
  const sideX = Math.abs(needRightOf - start.x) <= Math.abs(start.x - needLeftOf) ? needRightOf : needLeftOf;
  // 4-wp Z 形。Stub 让 Z 拐弯不贴脸 source/target（视觉上更明显是"绕路"）
  const stub = VERTICAL_STUB;
  const dy = end.y - start.y;
  const stubA = dy >= 0 ? start.y + stub : start.y - stub;
  const stubB = dy >= 0 ? end.y - stub : end.y + stub;
  return [
    start,
    { x: sideX, y: stubA },
    { x: sideX, y: stubB },
    end,
  ];
}

/**
 * 直线 (start, end) 与任一 obstacle bbox 相交检测（C2-A）。
 * 用于 'direct' / 'polyline' 退化为 2-point 直线前的避障兜底。
 * 算法：Cohen-Sutherland 经典裁剪。bbox 向内缩 EDGE_TOL 避免擦边误判。
 * src/tgt 自身的 bbox 跳过（直线起点 / 终点本来就贴它们）。
 */
const SEGMENT_HIT_TOL = 1;
function segmentHitsObstacle(
  start: { x: number; y: number },
  end: { x: number; y: number },
  obstacles: NodeBox[] | undefined,
  src: NodeBox, tgt: NodeBox,
): boolean {
  if (!obstacles || obstacles.length === 0) return false;
  for (const o of obstacles) {
    if (o === src || o === tgt) continue;
    if (segmentIntersectsBox(start, end, o)) return true;
  }
  return false;
}

function segmentIntersectsBox(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  box: NodeBox,
): boolean {
  const x1 = box.x + SEGMENT_HIT_TOL;
  const y1 = box.y + SEGMENT_HIT_TOL;
  const x2 = box.x + box.w - SEGMENT_HIT_TOL;
  const y2 = box.y + box.h - SEGMENT_HIT_TOL;
  if (x1 >= x2 || y1 >= y2) return false;
  const outcode = (p: { x: number; y: number }): number => {
    let c = 0;
    if (p.x < x1) c |= 1; else if (p.x > x2) c |= 2;
    if (p.y < y1) c |= 4; else if (p.y > y2) c |= 8;
    return c;
  };
  let a = p1, b = p2;
  let ca = outcode(a), cb = outcode(b);
  for (let iter = 0; iter < 4; iter++) {
    if ((ca | cb) === 0) return true;
    if ((ca & cb) !== 0) return false;
    const out = ca !== 0 ? ca : cb;
    let nx: number, ny: number;
    if (out & 8) { nx = a.x + (b.x - a.x) * (y2 - a.y) / (b.y - a.y); ny = y2; }
    else if (out & 4) { nx = a.x + (b.x - a.x) * (y1 - a.y) / (b.y - a.y); ny = y1; }
    else if (out & 2) { ny = a.y + (b.y - a.y) * (x2 - a.x) / (b.x - a.x); nx = x2; }
    else { ny = a.y + (b.y - a.y) * (x1 - a.x) / (b.x - a.x); nx = x1; }
    if (out === ca) { a = { x: nx, y: ny }; ca = outcode(a); }
    else { b = { x: nx, y: ny }; cb = outcode(b); }
  }
  return true;
}
