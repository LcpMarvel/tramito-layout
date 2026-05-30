// EdgeRouter
//
// 装配 classifier → anchor → channel → path-shaper。
// 输入：全图绝对坐标 + edges。输出：每条 edge 的 EdgeRoute。

import type { FlowNodeType } from '../../loader/types.ts';
import type { Anchor, EdgeRoute, LaneBox, NodeBox, PoolBox, Waypoint } from '../types.ts';
import { classify, type ClassifierEdge, type ClassifierNode } from './classifier.ts';
import { selectAnchors } from './anchor.ts';
import { shapePath } from './path-shaper.ts';
import { allocateChannels, type ChannelEdge } from './channel.ts';
import { detectFanInBundles, type FanInBundle } from './bundle.ts';
import { SHAPER_MARGIN, edgeStyleRules, type BpmnEdgeKind } from '../bpmn-rules.ts';
import { detourAroundLocalObstacles } from './local-obstacle-detour.ts';
import { finalizeRoutePorts, makeBoxPort } from './port.ts';

export interface RouteInputNode {
  box: NodeBox;
  type: FlowNodeType;
  isExpanded?: boolean;
  poolId: string;
  laneId: string | null;
  laneIdx: number | null;
}

export interface RouteInputEdge {
  id: string;
  source: string;
  target: string;
  /** BPMN 语义类别。决定 router 风格（orthogonal / polyline / direct）；与几何 EdgeType 正交。 */
  bpmnType: BpmnEdgeKind;
}

export interface RouteInputObstacle {
  box: NodeBox;
  poolId: string;
}

export interface RouteInput {
  nodes: Map<string, RouteInputNode>;
  edges: RouteInputEdge[];
  laneBoxes: Map<string, LaneBox & { poolId: string }>;
  poolBoxes: Map<string, PoolBox & { name?: string; isBlackBox?: boolean }>;
  /** Non-endpoint visual obstacles, such as ioSpecification data shapes emitted by the serializer. */
  routeObstacles?: RouteInputObstacle[];
}

export interface RouteOutput {
  routes: Map<string, EdgeRoute>;
}

export function routeEdges(input: RouteInput): RouteOutput {
  // 1) Classify
  const classifierNodes = new Map<string, ClassifierNode>();
  for (const [id, n] of input.nodes) {
    classifierNodes.set(id, {
      box: n.box,
      type: n.type,
      poolId: n.poolId,
      laneId: n.laneId,
      laneIdx: n.laneIdx,
    });
  }
  const edgeTypes = new Map<string, ReturnType<typeof classify>>();
  for (const e of input.edges) {
    edgeTypes.set(e.id, classify(e as ClassifierEdge, classifierNodes));
  }

  // 1b) Fan-in 归一识别（拓扑）：哪些 edge 属于「共 sink 的归一束」。成员从 lane 摊开桶里
  //     剔除（excludeIds），并在 busifyFanInToSink 里被重写成共享干线。
  const nodeTypeOf = new Map<string, FlowNodeType>();
  for (const [id, n] of input.nodes) nodeTypeOf.set(id, n.type);
  const bundles = detectFanInBundles(
    input.edges.map(e => ({ id: e.id, source: e.source, target: e.target, edgeType: edgeTypes.get(e.id)! })),
    nodeTypeOf,
  );
  const bundledIds = new Set<string>();
  for (const b of bundles) for (const id of b.memberIds) bundledIds.add(id);

  // 2) 分配通道
  const channelInputs: ChannelEdge[] = input.edges.map(e => ({
    id: e.id,
    edgeType: edgeTypes.get(e.id)!,
    sourceX: input.nodes.get(e.source)!.box.x,
  }));
  const channelAssignments = allocateChannels(channelInputs, bundledIds);

  // 3) 对每条 edge 选锚点 + 算路径
  const routes = new Map<string, EdgeRoute>();
  for (const e of input.edges) {
    const edgeType = edgeTypes.get(e.id)!;
    const anchors = selectAnchors(edgeType);
    const src = input.nodes.get(e.source)!;
    const tgt = input.nodes.get(e.target)!;
    const assignment = channelAssignments.get(e.id) ?? { channel: 0, total: 1 };
    const channel = assignment.channel;
    const channelTotal = assignment.total;

    // 跨 lane / 跨 pool 给出 gap 区间，让 PathShaper 中段走 gap 中间
    let gap: { top: number; bottom: number } | undefined;
    if (edgeType.startsWith('cross-lane')) {
      const srcLane = src.laneId ? input.laneBoxes.get(src.laneId) : undefined;
      const tgtLane = tgt.laneId ? input.laneBoxes.get(tgt.laneId) : undefined;
      if (srcLane && tgtLane) {
        if (edgeType === 'cross-lane-down') {
          gap = { top: srcLane.bottom, bottom: tgtLane.top };
        } else {
          gap = { top: tgtLane.bottom, bottom: srcLane.top };
        }
      }
    } else if (edgeType.startsWith('cross-pool')) {
      const srcPool = input.poolBoxes.get(src.poolId);
      const tgtPool = input.poolBoxes.get(tgt.poolId);
      if (srcPool && tgtPool) {
        if (edgeType === 'cross-pool-down') {
          gap = { top: srcPool.y + srcPool.h, bottom: tgtPool.y };
        } else {
          gap = { top: tgtPool.y + tgtPool.h, bottom: srcPool.y };
        }
      }
    }

    // 1 档避障：把潜在挡道节点的 bbox 喂给 PathShaper。
    //   - 同 pool edge：只看同 pool 节点（back-edge arch / forward-step 用）
    //   - 跨 pool edge（messageFlow）：必须看所有节点。fixture 31 的 message flow 跨 pool 走
    //     polyline preferDirect 直线时，会穿过中间 pool 的 task；若 obstacles 不含跨 pool
    //     节点，segmentHitsObstacle 永远查不到这条违例。
    // 排除"既装得下 src 又装得下 tgt"的节点——那是 src/tgt 的父容器（展开 subprocess /
    // 顶层 pool 等），不应被视为障碍。
    const isCrossPool = src.poolId !== tgt.poolId;
    const obstacles = collectObstacles(input, e, src, tgt, isCrossPool);

    const styleRule = edgeStyleRules[e.bpmnType];
    const resolvedAnchors = resolveAnchorsForGeometry(edgeType, anchors, src.box, tgt.box);
    const waypoints = shapePath({
      edgeType,
      sourceAnchor: resolvedAnchors.source,
      targetAnchor: resolvedAnchors.target,
      source: src.box,
      target: tgt.box,
      channel,
      channelTotal,
      gap,
      obstacles,
      routerStyle: styleRule.routerStyle,
      directTolerance: styleRule.directTolerance,
      forwardSkipObstacleSide: preferForwardSkipBelow(edgeType, src, tgt, obstacles) ? 'below' : 'above',
    });

    const sourceSide = inferEndpointSide(src.box, waypoints[0]!, resolvedAnchors.source);
    const targetSide = inferEndpointSide(tgt.box, waypoints[waypoints.length - 1]!, resolvedAnchors.target);
    routes.set(e.id, {
      edgeId: e.id,
      edgeType,
      sourcePort: makeBoxPort(e.source, sourceSide, waypoints[0]!),
      targetPort: makeBoxPort(e.target, targetSide, waypoints[waypoints.length - 1]!),
      waypoints,
      channel,
    });
  }

  // B1: Bus routing。共 source 的多条 forward-step edge 各自走独立 Z 形时 trunkX 不同，
  // 视觉上像"放射状"；统一 trunkX 到组内最小（最靠近 source）能合成"共干→分叉"形态。
  // 仅处理 forward-step（4 wp 标准 Z）的同 source 组；branch-up/down 已经在共 anchor 上自然合干。
  busifyForwardStep(routes, input);
  // Fan-in 归一：共 sink 的 gateway 出边聚成一根共享干线、单点进入（镜像 busifyForwardStep）。
  // 返回真正被重写的 edge——只有它们跳过 detour（撞节点而保留原路由的成员仍需 detour）。
  const fannedInIds = busifyFanInToSink(routes, input, bundles);
  detourRoutesAroundLocalObstacles(routes, input, fannedInIds);
  finalizeRoutePortsForRoutes(routes, input);

  return { routes };
}

function resolveAnchorsForGeometry(
  edgeType: ReturnType<typeof classify>,
  anchors: { source: Anchor; target: Anchor },
  source: NodeBox,
  target: NodeBox,
): { source: Anchor; target: Anchor } {
  if (
    (edgeType === 'cross-lane-down' || edgeType === 'cross-lane-up')
    && target.x - (source.x + source.w / 2) >= SHAPER_MARGIN + 30
  ) {
    return { source: anchors.source, target: 'left' };
  }
  return anchors;
}

function preferForwardSkipBelow(
  edgeType: ReturnType<typeof classify>,
  source: RouteInputNode,
  target: RouteInputNode,
  obstacles: NodeBox[],
): boolean {
  if (edgeType !== 'forward-straight') return false;
  if (!isGatewayNode(source)) return false;
  const sourceCy = source.box.y + source.box.h / 2;
  const targetCy = target.box.y + target.box.h / 2;
  if (Math.abs(sourceCy - targetCy) > 0.5) return false;
  const lo = source.box.x + source.box.w;
  const hi = target.box.x;
  return obstacles.some((o) =>
    o.x < hi
    && o.x + o.w > lo
    && sourceCy >= o.y
    && sourceCy <= o.y + o.h
  );
}

function isGatewayNode(node: RouteInputNode): boolean {
  return node.type === 'exclusiveGateway'
    || node.type === 'parallelGateway'
    || node.type === 'inclusiveGateway'
    || node.type === 'eventBasedGateway'
    || node.type === 'complexGateway';
}

function finalizeRoutePortsForRoutes(routes: Map<string, EdgeRoute>, input: RouteInput): void {
  for (const edge of input.edges) {
    const route = routes.get(edge.id);
    const src = input.nodes.get(edge.source);
    const tgt = input.nodes.get(edge.target);
    if (!route || !src || !tgt) continue;

    const finalized = finalizeRoutePorts({
      sourceId: edge.source,
      targetId: edge.target,
      sourceType: src.type,
      targetType: tgt.type,
      sourceBox: src.box,
      targetBox: tgt.box,
      sourceSide: route.sourcePort.side,
      targetSide: route.targetPort.side,
      waypoints: route.waypoints,
    });
    route.waypoints = finalized.waypoints;
    route.sourcePort = finalized.sourcePort;
    route.targetPort = finalized.targetPort;

    // 同 detour 阶段一致的障碍集合；stub 强直可能把 waypoint 推回障碍里，必须能回滚。
    const isCrossPool = src.poolId !== tgt.poolId;
    const stubObstacles = collectObstacles(input, edge, src, tgt, isCrossPool, true);
    ensureTargetArrowTailStub(route, stubObstacles);
  }
}

const TARGET_ARROW_TAIL_STUB = 20;

function ensureTargetArrowTailStub(route: EdgeRoute, obstacles: NodeBox[] = []): void {
  if (route.waypoints.length < 2) return;
  const originalWaypoints = route.waypoints.map((p) => ({ ...p }));
  const originalCrosses = obstacles.length > 0 && routeCrossesObstacles(originalWaypoints, obstacles);
  const endIdx = route.waypoints.length - 1;
  const end = route.waypoints[endIdx]!;
  const prev = route.waypoints[endIdx - 1]!;
  const beforePrev = route.waypoints[endIdx - 2];
  let tailStart: Waypoint;
  let spliceStart = Math.max(1, endIdx - 1);

  switch (route.targetPort.side) {
    case 'top':
      tailStart = { x: end.x, y: Math.min(prev.y, end.y - TARGET_ARROW_TAIL_STUB) };
      break;
    case 'bottom':
      tailStart = { x: end.x, y: Math.max(prev.y, end.y + TARGET_ARROW_TAIL_STUB) };
      break;
    case 'left':
      tailStart = { x: Math.min(prev.x, end.x - TARGET_ARROW_TAIL_STUB), y: end.y };
      break;
    case 'right':
      tailStart = { x: Math.max(prev.x, end.x + TARGET_ARROW_TAIL_STUB), y: end.y };
      break;
  }

  if (beforePrev && pointLiesInsideTailStub(beforePrev, tailStart, end, route.targetPort.side)) {
    spliceStart = Math.max(1, endIdx - 2);
  }

  const replacement: Waypoint[] = [];
  const prefix = route.waypoints[spliceStart - 1];
  if (prefix && !isOrthogonalSegment(prefix, tailStart)) {
    const elbow = elbowIntoTail(prefix, tailStart, route.targetPort.side);
    const prePrefix = route.waypoints[spliceStart - 2];
    if (prePrefix && pointLiesOnOrthogonalSegment(elbow, prePrefix, prefix)) {
      spliceStart = Math.max(1, spliceStart - 1);
    }
    replacement.push(elbow);
  }
  replacement.push(tailStart, end);
  route.waypoints.splice(spliceStart, route.waypoints.length - spliceStart, ...dedupeWaypoints(replacement));
  route.waypoints = dedupeWaypoints(route.waypoints);

  // tail stub 至多挪 20px，但有时刚好把刚被 detour 推开的拐点推回障碍里。若原路径不撞而新路径撞，回滚。
  if (!originalCrosses && obstacles.length > 0 && routeCrossesObstacles(route.waypoints, obstacles)) {
    route.waypoints = originalWaypoints;
  }
}

function isOrthogonalSegment(a: Waypoint, b: Waypoint): boolean {
  return Math.abs(a.x - b.x) <= 0.5 || Math.abs(a.y - b.y) <= 0.5;
}

function pointLiesInsideTailStub(point: Waypoint, tailStart: Waypoint, end: Waypoint, side: Anchor): boolean {
  const TOL = 0.5;
  switch (side) {
    case 'top':
    case 'bottom':
      return Math.abs(point.x - end.x) <= TOL
        && point.y >= Math.min(tailStart.y, end.y) - TOL
        && point.y <= Math.max(tailStart.y, end.y) + TOL;
    case 'left':
    case 'right':
      return Math.abs(point.y - end.y) <= TOL
        && point.x >= Math.min(tailStart.x, end.x) - TOL
        && point.x <= Math.max(tailStart.x, end.x) + TOL;
  }
}

function elbowIntoTail(prefix: Waypoint, tailStart: Waypoint, side: Anchor): Waypoint {
  return side === 'top' || side === 'bottom'
    ? { x: prefix.x, y: tailStart.y }
    : { x: tailStart.x, y: prefix.y };
}

function pointLiesOnOrthogonalSegment(point: Waypoint, a: Waypoint, b: Waypoint): boolean {
  const TOL = 0.5;
  if (Math.abs(a.x - b.x) <= TOL) {
    return Math.abs(point.x - a.x) <= TOL
      && point.y >= Math.min(a.y, b.y) - TOL
      && point.y <= Math.max(a.y, b.y) + TOL;
  }
  if (Math.abs(a.y - b.y) <= TOL) {
    return Math.abs(point.y - a.y) <= TOL
      && point.x >= Math.min(a.x, b.x) - TOL
      && point.x <= Math.max(a.x, b.x) + TOL;
  }
  return false;
}

function dedupeWaypoints(points: Waypoint[]): Waypoint[] {
  const out: Waypoint[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - point.x) <= 0.5 && Math.abs(last.y - point.y) <= 0.5) continue;
    out.push(point);
  }
  return out;
}

function detourRoutesAroundLocalObstacles(routes: Map<string, EdgeRoute>, input: RouteInput, skipIds?: ReadonlySet<string>): void {
  for (const edge of input.edges) {
    if (skipIds?.has(edge.id)) continue; // fan-in 干线已聚束并自检过避障，divider/detour 不再插手
    const route = routes.get(edge.id);
    const src = input.nodes.get(edge.source);
    const tgt = input.nodes.get(edge.target);
    if (!route || !src || !tgt) continue;

    const isCrossPool = src.poolId !== tgt.poolId;
    const obstacles = collectObstacles(input, edge, src, tgt, isCrossPool, true);
    const detoured = detourAroundLocalObstacles({
      edgeId: edge.id,
      waypoints: route.waypoints,
      obstacles,
      sourceSelf: src.box,
      targetSelf: tgt.box,
      sourceEndpointCanSlide: !isGatewayNode(src),
      targetEndpointCanSlide: !isGatewayNode(tgt),
    });
    route.waypoints = detoured.waypoints;
    keepCrossLaneRouteOffDivider(route, src, tgt, input.laneBoxes, obstacles);
  }
}

const LANE_DIVIDER_ROUTE_CLEARANCE = 24;

function keepCrossLaneRouteOffDivider(
  route: EdgeRoute,
  src: RouteInputNode,
  tgt: RouteInputNode,
  laneBoxes: Map<string, LaneBox & { poolId: string }>,
  obstacles: NodeBox[],
): void {
  if (!(route.edgeType === 'cross-lane-down' || route.edgeType === 'cross-lane-up')) return;
  if (!src.laneId || !tgt.laneId) return;
  const srcLane = laneBoxes.get(src.laneId);
  const tgtLane = laneBoxes.get(tgt.laneId);
  if (!srcLane || !tgtLane) return;

  const top = route.edgeType === 'cross-lane-down'
    ? srcLane.bottom
    : tgtLane.bottom;
  const bottom = route.edgeType === 'cross-lane-down'
    ? tgtLane.top
    : srcLane.top;
  if (bottom - top > LANE_DIVIDER_ROUTE_CLEARANCE * 2) return;

  const dividerY = (top + bottom) / 2;
  const closeIndexes: number[] = [];
  for (let i = 1; i < route.waypoints.length - 1; i++) {
    if (Math.abs(route.waypoints[i]!.y - dividerY) < LANE_DIVIDER_ROUTE_CLEARANCE) closeIndexes.push(i);
  }
  if (closeIndexes.length === 0) return;

  const firstCloseY = route.waypoints[closeIndexes[0]!]!.y;
  const preferredSign = firstCloseY < dividerY
    ? -1
    : firstCloseY > dividerY
      ? 1
      : route.edgeType === 'cross-lane-down' ? -1 : 1;
  const preferred = candidateCrossLaneDividerRoute(route, closeIndexes, dividerY, preferredSign);
  if (!routeCrossesObstacles(preferred, obstacles)) {
    route.waypoints = preferred;
    return;
  }

  const alternate = candidateCrossLaneDividerRoute(route, closeIndexes, dividerY, -preferredSign);
  if (!routeCrossesObstacles(alternate, obstacles)) {
    route.waypoints = alternate;
    return;
  }
  // 两侧都会穿障碍；divider 净空只是软约束（F 类），保留 detour 之后的原路径，不主动制造硬违例。
}

function candidateCrossLaneDividerRoute(
  route: EdgeRoute,
  closeIndexes: number[],
  dividerY: number,
  sign: number,
): Waypoint[] {
  const waypoints = route.waypoints.map(p => ({ ...p }));
  const sourcePoint = waypoints[0]!;
  const minSourceStub = 4;
  for (const idx of closeIndexes) {
    const point = waypoints[idx]!;
    point.y = dividerY + sign * LANE_DIVIDER_ROUTE_CLEARANCE;
    if (route.sourcePort.side === 'top' && point.y > sourcePoint.y - minSourceStub) {
      point.y = sourcePoint.y - minSourceStub;
    } else if (route.sourcePort.side === 'bottom' && point.y < sourcePoint.y + minSourceStub) {
      point.y = sourcePoint.y + minSourceStub;
    }
  }
  return waypoints;
}

function routeCrossesObstacles(waypoints: Waypoint[], obstacles: NodeBox[]): boolean {
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i]!;
    const b = waypoints[i + 1]!;
    for (const obstacle of obstacles) {
      if (segmentCrossesBoxInterior(a, b, obstacle)) return true;
    }
  }
  return false;
}

function segmentCrossesBoxInterior(a: Waypoint, b: Waypoint, box: NodeBox): boolean {
  const inset = 1;
  const left = box.x + inset;
  const right = box.x + box.w - inset;
  const top = box.y + inset;
  const bottom = box.y + box.h - inset;
  if (left >= right || top >= bottom) return false;

  if (Math.abs(a.y - b.y) <= 1) {
    const y = a.y;
    if (y <= top || y >= bottom) return false;
    return Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right;
  }

  if (Math.abs(a.x - b.x) <= 1) {
    const x = a.x;
    if (x <= left || x >= right) return false;
    return Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom;
  }

  return false;
}

function busifyForwardStep(routes: Map<string, EdgeRoute>, input: RouteInput): void {
  const groups = new Map<string, string[]>(); // sourceId → edge ids
  for (const e of input.edges) {
    const r = routes.get(e.id);
    if (!r || r.edgeType !== 'forward-step') continue;
    if (r.sourcePort.side !== 'right' || r.targetPort.side !== 'left') continue;
    if (r.waypoints.length !== 4) continue; // 只处理标准 Z 形
    if (!groups.has(e.source)) groups.set(e.source, []);
    groups.get(e.source)!.push(e.id);
  }
  for (const [, edgeIds] of groups) {
    if (edgeIds.length < 2) continue;
    // 共干 X = 组内最靠近 source 的 trunkX，保证不让 trunk 退回 source 之内
    let trunkX = Infinity;
    let minSourceRight = -Infinity;
    for (const eid of edgeIds) {
      const r = routes.get(eid)!;
      const wp1 = r.waypoints[1]!;
      if (wp1.x < trunkX) trunkX = wp1.x;
      const e = input.edges.find(x => x.id === eid)!;
      const srcBox = input.nodes.get(e.source)!.box;
      const srcRight = srcBox.x + srcBox.w;
      if (srcRight > minSourceRight) minSourceRight = srcRight;
    }
    // trunk 需要在 source 右边一段（避免共干贴脸）
    const TRUNK_STUB = 16;
    if (trunkX < minSourceRight + TRUNK_STUB) trunkX = minSourceRight + TRUNK_STUB;
    // 重写每条 edge 的 wp1, wp2：保持 wp0 (start) 和 wp3 (end) 不动，把 wp1.x=wp2.x=trunkX
    for (const eid of edgeIds) {
      const r = routes.get(eid)!;
      const wp0 = r.waypoints[0]!;
      const wp3 = r.waypoints[3]!;
      // 若 target.x 离 trunk 太近，bus routing 反而难看：跳过
      if (wp3.x - trunkX < 8) continue;
      r.waypoints[1] = { x: trunkX, y: wp0.y };
      r.waypoints[2] = { x: trunkX, y: wp3.y };
    }
  }
}

// Fan-in 归一后处理（镜像 busifyForwardStep，但按共 target 聚束）。
// 把每个 bundle 的 gateway 出边重写成「source → 共享干线 → 单点进 sink」。
// 返回真正被重写的 edge id 集合（撞节点而保留原路由的成员不计入）。
function busifyFanInToSink(
  routes: Map<string, EdgeRoute>,
  input: RouteInput,
  bundles: FanInBundle[],
): Set<string> {
  const rewritten = new Set<string>();
  for (const bundle of bundles) applyFanInBundle(routes, input, bundle, rewritten);
  return rewritten;
}

const FANIN_CORRIDOR_GAP = 14;       // 走廊与 sink/障碍行之间的净空
const FANIN_CORRIDOR_FALLBACK = 28;  // 无障碍时走廊离 sink 的默认距离

function applyFanInBundle(
  routes: Map<string, EdgeRoute>,
  input: RouteInput,
  bundle: FanInBundle,
  rewritten: Set<string>,
): void {
  const sink = input.nodes.get(bundle.sinkId);
  if (!sink) return;
  const sinkBox = sink.box;

  // 只聚同 pool 成员；cross-pool 归一不在本期范围。
  const members = bundle.memberIds
    .map((id) => {
      const edge = input.edges.find((e) => e.id === id);
      const src = edge ? input.nodes.get(edge.source) : undefined;
      const route = routes.get(id);
      return edge && src && route ? { id, edge, src, route } : null;
    })
    .filter((m): m is { id: string; edge: RouteInputEdge; src: RouteInputNode; route: EdgeRoute } =>
      m !== null && m.src.poolId === sink.poolId);
  if (members.length < 2) return;

  const sinkCx = sinkBox.x + sinkBox.w / 2;
  const sinkCy = sinkBox.y + sinkBox.h / 2;
  const sinkTop = sinkBox.y;
  const sinkBottom = sinkBox.y + sinkBox.h;
  const srcCxs = members.map((m) => m.src.box.x + m.src.box.w / 2);
  const srcMeanCx = avg(srcCxs);
  const srcMeanCy = avg(members.map((m) => m.src.box.y + m.src.box.h / 2));

  // sink 上被「非成员」边（主流入/出口）占用的侧——归一束要避开，落到对侧。
  const memberSet = new Set(members.map((m) => m.id));
  const occupied = new Set<Anchor>();
  for (const e of input.edges) {
    if (memberSet.has(e.id)) continue;
    const r = routes.get(e.id);
    if (!r) continue;
    if (e.target === bundle.sinkId) occupied.add(r.targetPort.side);
    if (e.source === bundle.sinkId) occupied.add(r.sourcePort.side);
  }

  const obstaclesFor = (m: { edge: RouteInputEdge; src: RouteInputNode }): NodeBox[] =>
    collectObstacles(input, m.edge, m.src, sink, m.src.poolId !== sink.poolId, true);

  const applyMember = (
    m: { edge: RouteInputEdge; src: RouteInputNode; route: EdgeRoute },
    wps: Waypoint[],
    entrySide: Anchor,
    entryPoint: Waypoint,
  ): void => {
    const r = m.route;
    r.waypoints = wps;
    const srcSide: Anchor = wps[1]!.y <= m.src.box.y + m.src.box.h / 2 ? 'top' : 'bottom';
    r.sourcePort = makeBoxPort(m.edge.source, srcSide, wps[0]!);
    r.targetPort = makeBoxPort(m.edge.target, entrySide, { x: entryPoint.x, y: entryPoint.y });
    rewritten.add(m.edge.id);
  };

  // ── 首选：从朝向 source 那一侧（左/右）水平进入，共享走廊放在 sink 自己的中线（开阔行）。
  //    这样走廊落在 sink 所在行而非贴着 sink 边/泳道线，最干净。要求该侧空闲且整束都不撞节点。
  const sourcesRight = srcMeanCx > sinkCx;
  const hSide: Anchor = sourcesRight ? 'right' : 'left';
  const hEntryX = sourcesRight ? sinkBox.x + sinkBox.w : sinkBox.x;
  if (!occupied.has(hSide)) {
    const built = members.map((m) => ({ m, wps: buildFanInPathSide(m.src.box, sinkCy, hEntryX) }));
    if (built.every(({ m, wps }) => !routeCrossesObstacles(wps, obstaclesFor(m)))) {
      for (const { m, wps } of built) applyMember(m, wps, hSide, { x: hEntryX, y: sinkCy });
      return;
    }
  }

  // ── 退路：sink 中线那一行被挡 → 走廊放到 sink 与最近障碍行之间的偏移净空，从上/下单点进入。
  const below = srcMeanCy >= sinkCy;
  const spanLo = Math.min(sinkCx, ...srcCxs);
  const spanHi = Math.max(sinkCx, ...srcCxs);
  const memberSrcIds = new Set(members.map((m) => m.edge.source));
  const obstacleTops: number[] = [];
  const obstacleBottoms: number[] = [];
  for (const [id, n] of input.nodes) {
    if (id === bundle.sinkId || memberSrcIds.has(id)) continue;
    if (n.poolId !== sink.poolId) continue;
    if (n.box.x + n.box.w <= spanLo || n.box.x >= spanHi) continue;
    obstacleTops.push(n.box.y);
    obstacleBottoms.push(n.box.y + n.box.h);
  }
  let corridorY: number;
  const entryY = below ? sinkBottom : sinkTop;
  if (below) {
    const nearestTopBelow = obstacleTops.filter((t) => t > sinkBottom + 1);
    const ceil = nearestTopBelow.length ? Math.min(...nearestTopBelow) : sinkBottom + 2 * FANIN_CORRIDOR_FALLBACK;
    corridorY = Math.max((sinkBottom + ceil) / 2, sinkBottom + FANIN_CORRIDOR_GAP);
  } else {
    const nearestBottomAbove = obstacleBottoms.filter((b) => b < sinkTop - 1);
    const floor = nearestBottomAbove.length ? Math.max(...nearestBottomAbove) : sinkTop - 2 * FANIN_CORRIDOR_FALLBACK;
    corridorY = Math.min((sinkTop + floor) / 2, sinkTop - FANIN_CORRIDOR_GAP);
  }
  const entrySide: Anchor = below ? 'bottom' : 'top';
  for (const m of members) {
    const wps = buildFanInPathVertical(m.src.box, corridorY, sinkCx, entryY);
    if (routeCrossesObstacles(wps, obstaclesFor(m))) continue;
    applyMember(m, wps, entrySide, { x: sinkCx, y: entryY });
  }
}

function avg(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

// 水平进入：source 顶/底出发 → riser 到共享走廊 Y(=sink.cy) → 水平沿走廊单点进 sink 左/右边。
// riser 在各 source.cx（横向拉开），水平段共用 corridorY（归一成一根），末段水平入边满足 E3。
function buildFanInPathSide(src: NodeBox, corridorY: number, entryX: number): Waypoint[] {
  const srcCx = src.x + src.w / 2;
  const srcCy = src.y + src.h / 2;
  const startY = corridorY <= srcCy ? src.y : src.y + src.h;
  return dedupeFanInWaypoints([
    { x: srcCx, y: startY },
    { x: srcCx, y: corridorY },
    { x: entryX, y: corridorY },
  ]);
}

// 竖直进入：source → riser 到偏移走廊 → 水平到 sink.cx → 竖直单点进 sink 上/下边。
function buildFanInPathVertical(src: NodeBox, corridorY: number, sinkCx: number, entryY: number): Waypoint[] {
  const srcCx = src.x + src.w / 2;
  const srcCy = src.y + src.h / 2;
  const startY = corridorY <= srcCy ? src.y : src.y + src.h;
  return dedupeFanInWaypoints([
    { x: srcCx, y: startY },
    { x: srcCx, y: corridorY },
    { x: sinkCx, y: corridorY },
    { x: sinkCx, y: entryY },
  ]);
}

function dedupeFanInWaypoints(points: Waypoint[]): Waypoint[] {
  const out: Waypoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) <= 0.5 && Math.abs(last.y - p.y) <= 0.5) continue;
    out.push(p);
  }
  return out;
}

function collectObstacles(
  input: RouteInput,
  edge: RouteInputEdge,
  src: RouteInputNode,
  tgt: RouteInputNode,
  isCrossPool: boolean,
  skipExpandedSubprocess = false,
): NodeBox[] {
  const obstacles: NodeBox[] = [];
  for (const [otherId, n] of input.nodes) {
    if (otherId === edge.source || otherId === edge.target) continue;
    if (!isCrossPool && n.poolId !== src.poolId) continue;
    if (boxContains(n.box, src.box) && boxContains(n.box, tgt.box)) continue;
    if (skipExpandedSubprocess && isExpandedSubprocess(n)) continue;
    obstacles.push(n.box);
  }
  for (const obstacle of input.routeObstacles ?? []) {
    if (!isCrossPool && obstacle.poolId !== src.poolId) continue;
    obstacles.push(obstacle.box);
  }
  return obstacles;
}

function boxContains(outer: NodeBox, inner: NodeBox): boolean {
  return outer.x <= inner.x
    && outer.y <= inner.y
    && outer.x + outer.w >= inner.x + inner.w
    && outer.y + outer.h >= inner.y + inner.h;
}

function inferEndpointSide(box: NodeBox, point: Waypoint, fallback: Anchor): Anchor {
  const TOL = 0.5;
  const onY = point.y >= box.y - TOL && point.y <= box.y + box.h + TOL;
  const onX = point.x >= box.x - TOL && point.x <= box.x + box.w + TOL;
  const onSide = (side: Anchor): boolean => {
    switch (side) {
      case 'left': return Math.abs(point.x - box.x) <= TOL && onY;
      case 'right': return Math.abs(point.x - (box.x + box.w)) <= TOL && onY;
      case 'top': return Math.abs(point.y - box.y) <= TOL && onX;
      case 'bottom': return Math.abs(point.y - (box.y + box.h)) <= TOL && onX;
    }
  };
  if (onSide(fallback)) return fallback;
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    if (onSide(side)) return side;
  }
  return fallback;
}

function isExpandedSubprocess(node: RouteInputNode): boolean {
  return node.isExpanded === true
    && (node.type === 'subProcess'
      || node.type === 'transaction'
      || node.type === 'adHocSubProcess');
}
