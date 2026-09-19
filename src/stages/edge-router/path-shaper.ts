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

const LANE_BOUNDARY_CLEARANCE = 24;
const LANE_BOUNDARY_MIN_STUB = 4;

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
  /**
   * 小台阶 jog 吸收（feedback-2026-06-11 docx#4）：相邻层 Y 差十几 px 的 right→left 边默认走
   * Z 形，画出来像「线在抖」。允许把小 dy 拉成一条水平直线，端点沿各自竖直边微移。
   * gateway 端点必须落菱形顶点（off-center 落斜面判 E1）→ 该端 fixed，直线只能取它的 Y；
   * 两端都 fixed 时无法吸收（保持 Z）。
   */
  absorbSmallJog?: { sourceFixed: boolean; targetFixed: boolean };
}

export function shapePath(input: PathShapeInput): Waypoint[] {
  const { sourceAnchor, targetAnchor, source, target, channel } = input;
  const start = anchorPoint(source, sourceAnchor);
  const end = anchorPoint(target, targetAnchor);

  // A3 + C2-A: routerStyle === 'direct' → 2-point 直线，但端点间若穿过障碍 → 退回 orthogonal
  // 用于 association / compensationAssociation：BPMN 规范画虚线时不强制正交，但 BPMN 工具
  // 通常也不会让 association 直接穿任务框（视觉冲突）。所以"direct"实际是"prefer direct"。
  if (input.routerStyle === 'direct') {
    let directStart = start;
    let directEnd = end;
    // 补偿 association（boundary-to-handler + direct）：锚点表给的是 bottom→top，handler 与
    // host 同排时会画出「从 BE 底部向上钩回 handler 顶」的别扭斜线（33 用户目检）。direct
    // 直线按主导方向选互对的边：横向为主 → BE 右/左出、handler 左/右进；纵向为主保持
    // bottom→top。仅影响 direct 风格；正交的 BE→handler 仍走 dive-first。
    if (input.edgeType === 'boundary-to-handler') {
      ({ start: directStart, end: directEnd } = directCompensationPorts(source, target));
    }
    if (!segmentHitsObstacle(directStart, directEnd, input.obstacles, input.source, input.target)) {
      return [directStart, directEnd];
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
      // 拱的水平段实际画在 source.cx → target.cx（riser 落在节点中线），不是 right/left 锚点
      // 那一段。避障必须按这条真实跨度量——否则贴在节点中线下/上方的 ioSpecification 数据形
      // （fixture 07 task_process 正下的 input_event_form，x 落在锚点跨度外）量不到、被穿过。
      const archStartX = input.source.x + input.source.w / 2;
      const archEndX = input.target.x + input.target.w / 2;
      if (input.forwardSkipObstacleSide === 'below') {
        // 先取「节点底 + margin」地板，再清障——顺序反了的话，地板会把已清好的 archY 顶回到
        // 一个起点在初始 archY 之下、当时没被看见的障碍里（fixture 07：clearObstaclesBelow 从 364
        // 起算清不到 y368 起的 input_extra，随后 max() 把线顶到 390 正落在 input_extra 内）。
        let archY = Math.max(
          Math.max(start.y, end.y) + ARCH_BASE_OFFSET + channel * CHANNEL_GAP,
          input.source.y + input.source.h + SHAPER_MARGIN,
          input.target.y + input.target.h + SHAPER_MARGIN,
        );
        archY = clearObstaclesBelow(archY, archStartX, archEndX, input.obstacles, input.source, input.target);
        const archStart = { x: archStartX, y: input.source.y + input.source.h };
        const archEnd = { x: archEndX, y: input.target.y + input.target.h };
        return [archStart, { x: archStart.x, y: archY }, { x: archEnd.x, y: archY }, archEnd];
      }
      let archY = Math.min(
        Math.min(start.y, end.y) - ARCH_BASE_OFFSET - channel * CHANNEL_GAP,
        input.source.y - SHAPER_MARGIN,
        input.target.y - SHAPER_MARGIN,
      );
      archY = clearObstaclesAbove(archY, archStartX, archEndX, input.obstacles, input.source, input.target);
      const archStart = { x: archStartX, y: input.source.y };
      const archEnd = { x: archEndX, y: input.target.y };
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
    // 3a. 小台阶 jog 吸收：dy 小到两端节点的边带都能消化时，直接拉平成一条水平直线。
    if (input.absorbSmallJog) {
      const flat = absorbSmallJogToStraight(input, start, end);
      if (flat) return flat;
    }
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
    // boundary→handler 的「先潜后横」：handler 行与 host 行垂直重叠时（handler top 高于
    // 泛用 L 的潜行道），泛用 L 的中段必穿 host（midY 落在 host 行内），局部绕障会贴出
    // 「沿 host 边线慢跑 + 末端乱拐」的丑线——80 的 flow_bd_h1 沿 host 底边跑满 100px
    // （用户目检指出）、13 的 flow_timer_non_int 左侧绕 jog。先竖直潜到 BE label 之下，
    // 再水平进 handler 近侧/底边。这条判断只能在这里做——潜行道要避开的是 host 行带，
    // 更早的 stage 不知道 handler 与 host 的垂直关系。
    if (input.edgeType === 'boundary-to-handler') {
      const dive = tryBoundaryDiveFirst(input, start, end);
      if (dive) return dive;
    }
    // 中段 Y：若给了 gap，走 gap 中线；否则 (start+end)/2
    let midY = (start.y + end.y) / 2;
    if (input.gap) {
      midY = gapCorridorY(input, start, sourceAnchor);
    } else if (input.edgeType === 'boundary-to-handler' && (input.channelTotal ?? 1) > 1) {
      // BE→handler corridor 多条平行；按 channel 在 [start.y, end.y] 范围内居中分布
      const total = input.channelTotal!;
      midY = (start.y + end.y) / 2 + (channel - (total - 1) / 2) * BE_CHANNEL_GAP;
    }
    const lPath: Waypoint[] = [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end];
    // 分支 L 中段撞节点时，若 target 明显在右/左侧，改从 source 侧边出、沿 source 行横到
    // target.cx、再竖直入顶——否则下游 detour 会把线绕成「出底边 → 折回 → 横穿自己节点」
    // （62 的 flow_urgent_merge 用户目检：起点应从 紧急通道处理 右边出）。
    if (pathHitsObstacle(lPath, input)) {
      const escape = trySideExitZ(input, 'down');
      if (escape) return escape;
    }
    return lPath;
  }
  if (sourceAnchor === 'top' && targetAnchor === 'bottom') {
    let midY = (start.y + end.y) / 2;
    if (input.gap) {
      midY = gapCorridorY(input, start, sourceAnchor);
    }
    if (input.edgeType === 'cross-lane-up') {
      const minStartStub = shouldRelaxCrossLaneUpStub(input, start)
        ? LANE_BOUNDARY_MIN_STUB
        : CROSS_LANE_UP_MIN_START_STUB;
      midY = Math.max(
        end.y + VERTICAL_STUB,
        Math.min(midY, start.y - minStartStub),
      );
    }
    const lPath: Waypoint[] = [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end];
    if (pathHitsObstacle(lPath, input)) {
      const escape = trySideExitZ(input, 'up');
      if (escape) return escape;
    }
    return lPath;
  }

  if ((sourceAnchor === 'bottom' || sourceAnchor === 'top') && (targetAnchor === 'left' || targetAnchor === 'right')) {
    // 优先简单 L：从 source 出发竖直到 target 的中线 y，再横入 target.left/right。两段都不撞节点才走。
    // cross-lane 边（target 在右上/右下且直上路径空）若无脑塞进 lane gap 走廊，会拐出"倒退进
    // 走廊"的 6 点折线（fixture 41 的 payment→pick / gw→check_stock 等手调推出）。走廊保留给
    // 真正需要避障 / 平行多边的场景——撞节点时回退到下面的走廊路径。
    // target=right：用于双向网关对的回边（fixture 37 审批→审核「拒绝」），从 source 自己的 X
    // 竖上去、横入 target 的右侧——避开正向边占用的 target.cx 竖直走廊（两条线否则叠成一条）。
    const corner = { x: start.x, y: end.y };
    if (
      !segmentHitsObstacle(start, corner, input.obstacles, input.source, input.target)
      && !segmentHitsObstacle(corner, end, input.obstacles, input.source, input.target)
    ) {
      return [start, corner, end];
    }
    // 竖直优先 L 被挡（target lane 把直上路径占了）→ 试水平优先 L：从 source **右**边出，沿
    // source 自己那一行横穿到 target.cx，再单段竖直入 sink 的 bottom(up)/top(down)。源行通常在
    // 较空的下层 lane、远离目标 lane 的密集节点，比钻进目标 lane 的走廊骑分隔线干净得多。
    // 手调 fixture 36 的 fork_to_join / quality_to_join 揭示的就是这个形态。
    // 仍是「两段都不撞节点才走」，撞了回退到下面的走廊。仅 left 进入侧适用（riser 落 sink.cx）。
    if (targetAnchor === 'left') {
      const hFirst = tryHorizontalFirstL(input);
      if (hFirst) return hFirst;
    }
    let midY = (start.y + end.y) / 2;
    if (input.gap) {
      midY = gapCorridorY(input, start, sourceAnchor);
    }
    const approachX = targetAnchor === 'left' ? end.x - VERTICAL_STUB : end.x + VERTICAL_STUB;
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

function pathHitsObstacle(wps: Waypoint[], input: PathShapeInput): boolean {
  for (let i = 0; i < wps.length - 1; i++) {
    if (segmentHitsObstacle(wps[i]!, wps[i + 1]!, input.obstacles, input.source, input.target)) return true;
  }
  return false;
}

// 分支 L 撞节点时的侧边出逃 Z：从 source 朝 target 那一侧的边出（右/左），沿 source 自己
// 那一行横到 target.cx，再竖直入 target 顶（down）/ 底（up）。等价于把 branch 边当
// forward-step 走。只接管 branch-down/up（forward-step 本来就走 Z；cross-lane 有走廊；
// boundary-to-handler 有 dive-first）。
function trySideExitZ(input: PathShapeInput, dir: 'down' | 'up'): Waypoint[] | null {
  if (input.edgeType !== 'branch-down' && input.edgeType !== 'branch-up') return null;
  const s = input.source;
  const t = input.target;
  const srcCy = s.y + s.h / 2;
  const riserX = t.x + t.w / 2;
  const goRight = riserX > s.x + s.w + SHAPER_MARGIN;
  const goLeft = riserX < s.x - SHAPER_MARGIN;
  if (!goRight && !goLeft) return null;
  const enterY = dir === 'down' ? t.y : t.y + t.h;
  // 方向一致性：down 要求 source 行在 target 顶之上，up 反之；否则几何反了，放弃。
  if (dir === 'down' && srcCy >= enterY) return null;
  if (dir === 'up' && srcCy <= enterY) return null;
  const exit = { x: goRight ? s.x + s.w : s.x, y: srcCy };
  const corner = { x: riserX, y: srcCy };
  const enter = { x: riserX, y: enterY };
  if (
    segmentHitsObstacle(exit, corner, input.obstacles, s, t)
    || segmentHitsObstacle(corner, enter, input.obstacles, s, t)
  ) {
    return null;
  }
  return [exit, corner, enter];
}

// 小台阶吸收的触发上限：相邻层 Y 差超过这个值就是真分层，该走 Z 形；以内是布局误差级别的抖动。
const JOG_ABSORB_MAX_DY = 16;

/**
 * 把小 dy 的 right→left 边拉平成一条水平直线。fixed 端（gateway 顶点）锁定直线 Y；两端都
 * 自由时取中点。自由端的落点要在该节点的「边带」内（cy ± min(h*0.3, 14)）——超出边带的
 * 入点太贴节点角、视觉像扎进角落（E3 精神）。端点 x 不变（left/right 边是竖直的，沿边滑 Y
 * 不破坏 E1 贴边）。撞障碍则放弃回退 Z。
 */
function absorbSmallJogToStraight(
  input: PathShapeInput,
  start: Waypoint,
  end: Waypoint,
): Waypoint[] | null {
  const cfg = input.absorbSmallJog!;
  if (cfg.sourceFixed && cfg.targetFixed) return null;
  const dy = Math.abs(start.y - end.y);
  if (dy < 0.5 || dy > JOG_ABSORB_MAX_DY) return null;
  const sharedY = cfg.sourceFixed ? start.y : cfg.targetFixed ? end.y : (start.y + end.y) / 2;
  const band = (b: NodeBox): number => Math.min(b.h * 0.3, 14);
  const sCy = input.source.y + input.source.h / 2;
  const tCy = input.target.y + input.target.h / 2;
  if (!cfg.sourceFixed && Math.abs(sharedY - sCy) > band(input.source)) return null;
  if (!cfg.targetFixed && Math.abs(sharedY - tCy) > band(input.target)) return null;
  const a = { x: start.x, y: sharedY };
  const b = { x: end.x, y: sharedY };
  if (segmentHitsObstacle(a, b, input.obstacles, input.source, input.target)) return null;
  return [a, b];
}

/**
 * 水平优先 L（cross-lane 专用）：source.right →（横）→ sink.cx →（竖）→ sink 的 bottom/top 顶点。
 * 触发条件：target 在 source 右侧足够远 + 两段都不撞节点。否则返回 null，让调用方回退走廊。
 *
 * riser 落在 sink.cx（边中点 / gateway 是底/顶顶点）——**不能**按 channel 错开 X：E1 只认 bbox 边，
 * gateway 偏离顶点的入点会落在菱形斜面（在 bbox 内部）判 E1 违例。多条 cross-lane 边汇到同一 sink
 * 时共用这条末段 riser，视觉上自然读成「归一汇入」，可接受。
 */
function tryHorizontalFirstL(input: PathShapeInput): Waypoint[] | null {
  if (input.edgeType !== 'cross-lane-up' && input.edgeType !== 'cross-lane-down') return null;
  const s = input.source;
  const t = input.target;
  const srcRightX = s.x + s.w;
  const srcCy = s.y + s.h / 2;
  const riserX = t.x + t.w / 2;
  if (riserX <= srcRightX + SHAPER_MARGIN) return null; // 横段必须向右、riser 离开 source 才成立

  const enterY = input.edgeType === 'cross-lane-up' ? t.y + t.h : t.y; // 入 sink 底(上行) / 顶(下行)
  // 竖直 riser 的方向要和 edge 类型一致：上行从源行往上、下行往下；否则几何反了，放弃。
  if (input.edgeType === 'cross-lane-up' && srcCy <= enterY) return null;
  if (input.edgeType === 'cross-lane-down' && srcCy >= enterY) return null;

  const exit = { x: srcRightX, y: srcCy };
  const corner = { x: riserX, y: srcCy };
  const enter = { x: riserX, y: enterY };
  if (
    segmentHitsObstacle(exit, corner, input.obstacles, s, t)
    || segmentHitsObstacle(corner, enter, input.obstacles, s, t)
  ) {
    return null;
  }
  return [exit, corner, enter];
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

function gapCorridorY(input: PathShapeInput, start: Waypoint, sourceAnchor: Anchor): number {
  if (!input.gap) return start.y;
  const centered = input.gap.top + (input.gap.bottom - input.gap.top) * 0.5
    + input.channel * CHANNEL_GAP
    - (channelCount(input) - 1) * CHANNEL_GAP / 2;
  if (!input.edgeType.startsWith('cross-lane')) return centered;

  const gapH = input.gap.bottom - input.gap.top;
  if (gapH > LANE_BOUNDARY_CLEARANCE * 2) return centered;

  const dividerY = (input.gap.top + input.gap.bottom) / 2;
  const distance = LANE_BOUNDARY_CLEARANCE + input.channel * CHANNEL_GAP;
  if (sourceAnchor === 'bottom') {
    const sourceSideY = dividerY - distance;
    return sourceSideY >= start.y + LANE_BOUNDARY_MIN_STUB
      ? sourceSideY
      : dividerY + distance;
  }

  if (sourceAnchor === 'top') {
    const fullStubY = start.y - CROSS_LANE_UP_MIN_START_STUB;
    if (Math.abs(fullStubY - dividerY) >= LANE_BOUNDARY_CLEARANCE) return fullStubY;
    return dividerY + distance;
  }

  return centered;
}

function shouldRelaxCrossLaneUpStub(input: PathShapeInput, start: Waypoint): boolean {
  if (!input.gap || input.edgeType !== 'cross-lane-up') return false;
  if (input.gap.bottom - input.gap.top > LANE_BOUNDARY_CLEARANCE * 2) return false;
  const dividerY = (input.gap.top + input.gap.bottom) / 2;
  const fullStubY = start.y - CROSS_LANE_UP_MIN_START_STUB;
  return Math.abs(fullStubY - dividerY) < LANE_BOUNDARY_CLEARANCE;
}

function clearObstaclesBelow(
  archY: number,
  x1: number, x2: number,
  obstacles: NodeBox[] | undefined,
  src: NodeBox, tgt: NodeBox,
): number {
  if (!obstacles || obstacles.length === 0) return archY;
  const lo = Math.min(x1, x2);
  const hi = Math.max(x1, x2);
  return clearHorizontalArchY(archY, lo, hi, obstacles, src, tgt, 'below');
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
  return clearHorizontalArchY(archY, lo, hi, obstacles, src, tgt, 'above');
}

function clearHorizontalArchY(
  archY: number,
  lo: number,
  hi: number,
  obstacles: NodeBox[],
  src: NodeBox,
  tgt: NodeBox,
  side: 'above' | 'below',
): number {
  for (let iter = 0; iter <= obstacles.length; iter++) {
    let moved = false;
    for (const o of obstacles) {
      if (o === src || o === tgt) continue;
      if (o.x + o.w <= lo || o.x >= hi) continue;
      // 判定带按 ARCH_CLEAR_MARGIN 外扩：archY 擦着障碍边跑（如 fixture 45 回环拱距「客户审核」
      // 底边仅 0.33px）和穿过内部一样要推开——避障只查 bbox 内部时，贴边线视觉上粘在节点上。
      if (archY <= o.y - ARCH_CLEAR_MARGIN || archY >= o.y + o.h + ARCH_CLEAR_MARGIN) continue;
      archY = side === 'above'
        ? o.y - ARCH_CLEAR_MARGIN
        : o.y + o.h + ARCH_CLEAR_MARGIN;
      moved = true;
    }
    if (!moved) return archY;
  }
  throw new Error('[path-shaper] horizontal arch obstacle clearance did not converge');
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
// BE 出边的潜行深度 = BE label 行高(14) + 净空(8)。潜行道必须低于 BE 自己的 label 带
// （label 在 BE 下方 4px 起、高 14），否则水平段会从 label 正中穿过。
const BE_DIVE_CLEAR = 22;

// 「先潜后横」按 handler 行带与 BE 的垂直关系分三形态：
//   A 浅窗：handler 行带与 BE 同排重叠（77 的 记录支付异常）→ 走廊取在「host 底边之下、
//     BE label 之上」的浅窗，能取 BE 底（start.y）就取（零 stub 直行）；近侧进入。
//     浅窗被兄弟 BE/节点挡住时落深窗（13 的横段会穿 消息中断 BE）。
//   B 深窗：handler 在下方且行带含深潜道（label 底 + 净空 + channel 错开）→ 深窗近侧进入。
//   C handler 底在深潜道之上 → 从底边向上进入。
// 任一形态若撞第三方节点 → 继续往下试或回退泛用 L + 局部绕障。
function tryBoundaryDiveFirst(input: PathShapeInput, start: Waypoint, end: Waypoint): Waypoint[] | null {
  const { target, channel } = input;
  const tgtCx = target.x + target.w / 2;
  if (approxEq(start.x, tgtCx)) return null; // 同 cx：泛用竖直直线（case 2）已处理
  const hits = (wps: Waypoint[]): boolean => {
    for (let i = 0; i < wps.length - 1; i++) {
      if (segmentHitsObstacle(wps[i]!, wps[i + 1]!, input.obstacles, input.source, input.target)) return true;
    }
    return false;
  };
  const sideEntry = (corridorY: number): Waypoint[] => {
    const entryX = tgtCx > start.x ? target.x : target.x + target.w;
    const wps: Waypoint[] = [start, { x: start.x, y: corridorY }, { x: entryX, y: corridorY }];
    return wps.filter((p, i) => i === 0 || Math.abs(p.x - wps[i - 1]!.x) > 0.5 || Math.abs(p.y - wps[i - 1]!.y) > 0.5);
  };

  // A 浅窗：host 底 = BE 中心（start.y − 18），F12 净空 +4 → lo = start.y − 14；
  // label 顶 = BE 底 + 4 → hi = start.y + 4。走廊只能落在这个 18px 窗口内。
  const shallowLo = Math.max(start.y - 14, target.y);
  const shallowHi = Math.min(start.y + 4, target.y + target.h);
  if (shallowLo <= shallowHi) {
    const corridorY = Math.min(Math.max(start.y, shallowLo), shallowHi);
    const wps = sideEntry(corridorY);
    if (!hits(wps)) return wps;
  }

  // B 深窗（label 之下，channel 错开）
  const deepY = start.y + BE_DIVE_CLEAR + channel * BE_CHANNEL_GAP;
  if (deepY >= target.y && deepY <= target.y + target.h) {
    const wps = sideEntry(deepY);
    return hits(wps) ? null : wps;
  }
  if (deepY <= target.y) return null; // handler 顶在深潜道之下：泛用 L 的 gap 走得通

  // C 深窗低于 handler 底 → 底边向上进入
  const wps: Waypoint[] = [
    start,
    { x: start.x, y: deepY },
    { x: tgtCx, y: deepY },
    { x: tgtCx, y: target.y + target.h },
  ];
  return hits(wps) ? null : wps;
}

// 补偿 association 的 direct 端点：按源→目标的主导方向选互对的边（横为主走左右边，
// 纵为主走上下边）。仅用于 boundary-to-handler + direct（补偿 BE→补偿活动）。
function directCompensationPorts(source: NodeBox, target: NodeBox): { start: Waypoint; end: Waypoint } {
  const sCx = source.x + source.w / 2;
  const sCy = source.y + source.h / 2;
  const tCx = target.x + target.w / 2;
  const tCy = target.y + target.h / 2;
  const dx = tCx - sCx;
  const dy = tCy - sCy;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { start: anchorPoint(source, 'right'), end: anchorPoint(target, 'left') }
      : { start: anchorPoint(source, 'left'), end: anchorPoint(target, 'right') };
  }
  return dy >= 0
    ? { start: anchorPoint(source, 'bottom'), end: anchorPoint(target, 'top') }
    : { start: anchorPoint(source, 'top'), end: anchorPoint(target, 'bottom') };
}

export function segmentHitsObstacle(
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
