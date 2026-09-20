// EdgeRouter
//
// 装配 classifier → anchor → channel → path-shaper。
// 输入：全图绝对坐标 + edges。输出：每条 edge 的 EdgeRoute。

import type { FlowNodeType } from '../../loader/types.ts';
import type { Anchor, EdgeRoute, LaneBox, NodeBox, PoolBox, Waypoint } from '../types.ts';
import { classify, type ClassifierEdge, type ClassifierNode } from './classifier.ts';
import { anchorPoint, selectAnchors } from './anchor.ts';
import { shapePath, segmentHitsObstacle } from './path-shaper.ts';
import { allocateChannels, type ChannelEdge } from './channel.ts';
import { detectFanInBundles, type FanInBundle } from './bundle.ts';
import { SHAPER_MARGIN, edgeStyleRules, type BpmnEdgeKind } from '../bpmn-rules.ts';
import { detourAroundLocalObstacles, pointInsideBoxInterior } from './local-obstacle-detour.ts';
import { finalizeRoutePorts, makeBoxPort } from './port.ts';

export interface RouteInputNode {
  box: NodeBox;
  type: FlowNodeType;
  isExpanded?: boolean;
  poolId: string;
  laneId: string | null;
  laneIdx: number | null;
  /** snake 折行 lane 的行方向（见 ClassifierNode.rowDir） */
  rowDir?: 1 | -1;
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
  /** 语义回边集（BackEdgeResolver）：分类的权威依据，几何 dx≤0 只是兜底的代理（见 classifier 注释）。 */
  backEdgeIds?: ReadonlySet<string>;
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
      rowDir: n.rowDir,
      laneIdx: n.laneIdx,
    });
  }
  const edgeTypes = new Map<string, ReturnType<typeof classify>>();
  for (const e of input.edges) {
    edgeTypes.set(e.id, classify(e as ClassifierEdge, classifierNodes, input.backEdgeIds));
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

  // 2b) 发散网关「分叉可见性」：决定哪些 forward-step 出边改从 top/bottom 顶点出（见函数注释）。
  const forkAnchorOverrides = planGatewayForkAnchors(input, edgeTypes);
  // 2c) 双向节点对（2-cycle）：回边改从侧面进 target，避开正向边的竖直走廊（见函数注释）。
  const reversePairTargetOverrides = planReversePairAnchors(input, edgeTypes);
  const endBottomOverrides = planEndBottomAnchors(input, edgeTypes);

  // 3) 对每条 edge 选锚点 + 算路径
  const routes = new Map<string, EdgeRoute>();
  for (const e of input.edges) {
    const edgeType = edgeTypes.get(e.id)!;
    const forkOverride = forkAnchorOverrides.get(e.id);
    const anchors = forkOverride ? { source: forkOverride, target: 'left' as Anchor } : selectAnchors(edgeType);
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
    const geomAnchors = resolveAnchorsForGeometry(edgeType, anchors, src.box, tgt.box, src.rowDir, tgt.rowDir);
    const reverseTargetOverride = reversePairTargetOverrides.get(e.id);
    const endBottomOverride = endBottomOverrides.get(e.id);
    const preBlockAnchors = reverseTargetOverride
      ? { source: geomAnchors.source, target: reverseTargetOverride }
      : endBottomOverride
        ? { source: geomAnchors.source, target: endBottomOverride }
        : geomAnchors;
    const resolvedAnchors = avoidBlockedSourceAnchor(preBlockAnchors, src.box, obstacles);
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
      // gateway 端点必须落菱形顶点（off-center 落斜面判 E1）→ 该端 fixed，直线 Y 只能取它的
      absorbSmallJog: { sourceFixed: isGatewayNode(src), targetFixed: isGatewayNode(tgt) },
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
  // 并行 join 归一总线：≥5 条 task 出发的入边汇到同一 gateway 时，各边 riser 全叠在
  // sink 中线上（72 的 6 路并行：3 条 riser 叠成一根粗管贴在 join 中线上，用户目检"太乱"）。
  // 与 busifyForwardStep 镜像：成员各自朝 sink 侧出，空隙中点的竖直总线收到 sink 中线，
  // 一次横进顶点。04 的 3 路归一（上/左/下顶点分配）成员数不足、不受影响。
  const parallelJoinIds = busifyParallelJoinToGateway(routes, input, fannedInIds);
  const busedIds = new Set([...fannedInIds, ...parallelJoinIds]);
  detourRoutesAroundLocalObstacles(routes, input, busedIds);
  finalizeRoutePortsForRoutes(routes, input);
  // F7：把贴着 lane 分隔线跑的水平边中段推开（跨多 lane 的边走廊有时落在离分隔线几 px 处，
  // 流程线与泳道线粘连难辨）。只动失败段、撞节点就回滚；fan-in 干线已自洽,跳过。
  // **必须放在 finalize 之后**——finalize 的 target arrow tail-stub 对 bottom/top 进入的边会把
  // 倒数第二段强拉到 end.y±20，正好可能落进分隔线净空区（fixture 36 bottom-bottom 拱：节点底
  // 353 + 20 = 373，离分隔线 369 仅 4px），在 finalize 之前 nudge 会被它推回来。
  nudgeHorizontalSegmentsOffDividers(routes, input, busedIds);
  // F8：两条不同 edge 的内部水平段挨太近(dy<10px 且 x 重叠)会叠成一条糊线。把其中一段推开到
  // ≥12px(撞节点回滚)。**必须放在 finalize 之后**——finalize 的 target arrow tail-stub 会把贴近
  // sink 的水平段(如 fan-in 走廊)再挪几 px 凑足 20px 直入,在那之前测的 dy 不作数(fixture 40)。
  nudgeParallelSegmentsApart(routes, input, busedIds);
  // 同 lane back-edge 的拱默认抬到 source 顶上方 ARCH_BASE_OFFSET，lane 顶留白不够时会冲进上邻
  // lane（fixture 40：部门主管 lane 顶=132、task 顶仅 151，拱落 127 再被 divider-nudge 推到 122，
  // 整条线跑进申请人 lane）。把拱夹回 source lane 内。**必须放最后**——divider-nudge 只懂"离分隔
  // 线远"，不懂"留在本 lane"，会把刚夹回来的拱又推出去。
  keepIntraLaneBackEdgeInsideLane(routes, input);

  return { routes };
}

// 拱内部水平段离 lane 顶/底至少留这么多：≥ DIVIDER_NUDGE_TRIGGER(8)，否则会再次触发 divider-nudge。
const INTRA_LANE_BACK_EDGE_CLEAR = 10;

function keepIntraLaneBackEdgeInsideLane(routes: Map<string, EdgeRoute>, input: RouteInput): void {
  for (const edge of input.edges) {
    const route = routes.get(edge.id);
    const src = input.nodes.get(edge.source);
    const tgt = input.nodes.get(edge.target);
    if (!route || !src || !tgt) continue;
    if (src.laneId === null || src.laneId !== tgt.laneId) continue;
    const upArch = route.edgeType === 'back-edge-down-left';   // top↔top → 拱向上(y 变小)
    const downArch = route.edgeType === 'back-edge-up-left';   // bottom↔bottom → 拱向下(y 变大)
    if (!upArch && !downArch) continue;
    const lane = input.laneBoxes.get(src.laneId);
    if (!lane) continue;
    const wps = route.waypoints;
    if (wps.length !== 4) continue; // 只处理标准 4-wp 拱；finalize 改过形状的跳过
    const archY = wps[1]!.y;
    if (Math.abs(wps[2]!.y - archY) > 0.5) continue; // 中段非水平 → 非标准拱
    const clamped = upArch
      ? Math.max(archY, lane.top + INTRA_LANE_BACK_EDGE_CLEAR)
      : Math.min(archY, lane.bottom - INTRA_LANE_BACK_EDGE_CLEAR);
    if (Math.abs(clamped - archY) < 0.5) continue; // 已在 lane 内
    // 夹完拱与两端 riser 之间仍要留高度，否则拱会贴进 source/target 边
    const MIN_RISER = 4;
    if (upArch && clamped > Math.min(wps[0]!.y, wps[3]!.y) - MIN_RISER) continue;
    if (downArch && clamped < Math.max(wps[0]!.y, wps[3]!.y) + MIN_RISER) continue;
    const obstacles = collectObstacles(input, edge, src, tgt, false, true);
    const orig1 = wps[1]!.y;
    const orig2 = wps[2]!.y;
    wps[1]!.y = clamped;
    wps[2]!.y = clamped;
    // 夹回 lane 内若反而撞上拱本要避开的节点，回滚——避障优先于留在 lane。
    if (routeCrossesObstacles(wps, obstacles)) {
      wps[1]!.y = orig1;
      wps[2]!.y = orig2;
    }
  }
}

/**
 * Boundary event 把 source 出边那一侧整条盖住时（fixture 23：3 个 BE 平铺 call activity 底边，
 * back-row-down 的 bottom 锚点正落在中间 BE 体内），从该侧出的第一段必然切 BE（E2），而
 * detour 修不了——端点必须贴 host 边，BE 之间的缝隙只有几 px。翻到对侧出（bottom↔top），
 * 让 path-shaper 的同侧拱（top↔top / bottom↔bottom）绕过 BE 行。
 * 窄触发：锚点被障碍盖住 && 对侧锚点干净 && 翻转后恰好落进 path-shaper 的拱 case。
 */
function avoidBlockedSourceAnchor(
  anchors: { source: Anchor; target: Anchor },
  srcBox: NodeBox,
  obstacles: NodeBox[],
): { source: Anchor; target: Anchor } {
  const flip: Partial<Record<Anchor, Anchor>> = { bottom: 'top', top: 'bottom' };
  const flipped = flip[anchors.source];
  // 只在翻转后形成 top↔top / bottom↔bottom 拱时动——其它组合 path-shaper 没有专门 case，
  // 会跌进直连兜底反而更糟。
  if (!flipped || flipped !== anchors.target) return anchors;
  const cur = anchorPoint(srcBox, anchors.source);
  if (!obstacles.some((o) => pointInsideBoxInterior(cur, o))) return anchors;
  const alt = anchorPoint(srcBox, flipped);
  if (obstacles.some((o) => pointInsideBoxInterior(alt, o))) return anchors;
  return { source: flipped, target: anchors.target };
}

function resolveAnchorsForGeometry(
  edgeType: ReturnType<typeof classify>,
  anchors: { source: Anchor; target: Anchor },
  source: NodeBox,
  target: NodeBox,
  srcRowDir?: 1 | -1,
  tgtRowDir?: 1 | -1,
): { source: Anchor; target: Anchor } {
  // snake RTL 行的行内 forward-straight：source 在 target 右侧——锚点翻成 left→right，
  // 否则默认 right→left 会让直线从 target 左边缘「穿盒而过」（E3 穿盒违例，71 实测 ×10）。
  if (edgeType === 'forward-straight' && srcRowDir === -1 && tgtRowDir === -1) {
    return { source: 'left', target: 'right' };
  }
  if (edgeType === 'cross-lane-down' || edgeType === 'cross-lane-up') {
    const srcCx = source.x + source.w / 2;
    // target 在 source 右侧足够远 → 从 target 左侧进（横段向右、riser 落 source 那一列）。
    if (target.x - srcCx >= SHAPER_MARGIN + 30) {
      return { source: anchors.source, target: 'left' };
    }
    // 镜像，**仅 cross-lane-down**：target 在 source 左侧足够远（源在上、gateway 被甩到下游左侧）
    // → 从 target 右侧进。否则默认 bottom→top 锚点会逼出「下行→左折→再下扎进顶点」的多段抖线
    // （fixture 44 手调揭示：提交报销单→金额判断，gateway 在其左下方，应从 gateway 右侧单 L 进入）。
    // cross-lane-up（自下而上的回环/驳回）不走这条——它的横段会横贯整条上层 lane、撞中间节点，
    // 留给已有的走廊/horizontal-first 逻辑处理（egg-fried-rice / voc 回环即此）。
    if (edgeType === 'cross-lane-down' && srcCx - (target.x + target.w) >= SHAPER_MARGIN + 30) {
      return { source: anchors.source, target: 'right' };
    }
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

/**
 * 发散网关「分叉可见性」：决策网关的多条 forward-step 出边默认全从 right 顶点出，共享同一段
 * 水平干线后才在 trunkX 处分叉——视觉上像「一条线晚分叉」，看不清是网关在分支（fixture 38
 * 「尝味是否合格」手调揭示：两条岔路必须分开）。把*唯一*一条明显向上的支移到 top 顶点、
 * *唯一*一条明显向下的支移到 bottom 顶点，各走干净竖直优先 L，让分叉落在网关本体上。
 *
 * 窄触发，避免动到已被接受的 bus 形态 / 单支网关：
 *   - 仅 gateway 源、且该源 ≥2 条 forward-step 出边时考虑；
 *   - 某侧（上/下）恰好一条出边才移——多条同侧仍走 right bus，否则它们在同一顶点会二次重叠；
 *   - 目标顶点未被该网关其它边占用（loop-back 常占 top，见 fixture 38 flow_47 / 16 flow_41）；
 *   - 移动后竖直优先 L 两段都不撞节点，否则保留原 forward-step（撞了走廊兜底反而更糟）。
 */
function planGatewayForkAnchors(
  input: RouteInput,
  edgeTypes: Map<string, ReturnType<typeof classify>>,
): Map<string, Anchor> {
  const overrides = new Map<string, Anchor>();

  // 按 gateway 源聚 forward-step 出边
  const fwdOut = new Map<string, RouteInputEdge[]>();
  for (const e of input.edges) {
    if (edgeTypes.get(e.id) !== 'forward-step') continue;
    const src = input.nodes.get(e.source);
    if (!src || !isGatewayNode(src)) continue;
    if (!fwdOut.has(e.source)) fwdOut.set(e.source, []);
    fwdOut.get(e.source)!.push(e);
  }

  for (const [gwId, outEdges] of fwdOut) {
    if (outEdges.length < 2) continue;
    const gw = input.nodes.get(gwId)!.box;
    const topY = gw.y;
    const botY = gw.y + gw.h;

    // 该网关已被其它边占用的顶点（含 loop-back 入边的 top/bottom）。用 selectAnchors 基础表估计
    // ——足以捕获 back-edge 的拱形入点（top/top 或 bottom/bottom），那是唯一会和我们抢顶点的形态。
    const used = new Set<Anchor>();
    for (const e of input.edges) {
      const t = edgeTypes.get(e.id)!;
      const a = selectAnchors(t);
      if (e.target === gwId) used.add(a.target);
      if (e.source === gwId && edgeTypes.get(e.id) !== 'forward-step') used.add(a.source);
    }

    // 分侧：仅当目标中心越过对应顶点才算「明显上/下」，保证竖直优先 L 朝正确方向且不扎回网关内
    const above: RouteInputEdge[] = [];
    const below: RouteInputEdge[] = [];
    for (const e of outEdges) {
      const tgt = input.nodes.get(e.target)!.box;
      const tcy = tgt.y + tgt.h / 2;
      if (tcy <= topY) above.push(e);
      else if (tcy >= botY) below.push(e);
    }

    tryMoveUniqueSide(above, 'top', used, overrides, input, gwId);
    tryMoveUniqueSide(below, 'bottom', used, overrides, input, gwId);
  }
  return overrides;
}

function tryMoveUniqueSide(
  side: RouteInputEdge[],
  vertex: Anchor,
  used: Set<Anchor>,
  overrides: Map<string, Anchor>,
  input: RouteInput,
  gwId: string,
): void {
  if (side.length !== 1) return;       // 多条同侧 → 留给 right bus，避免顶点二次重叠
  if (used.has(vertex)) return;        // 顶点被 loop-back 等占用
  const e = side[0]!;
  const gw = input.nodes.get(gwId)!.box;
  const tgt = input.nodes.get(e.target)!.box;
  const startX = gw.x + gw.w / 2;
  const startY = vertex === 'top' ? gw.y : gw.y + gw.h;
  const endX = tgt.x;
  const endY = tgt.y + tgt.h / 2;
  const start = { x: startX, y: startY };
  const corner = { x: startX, y: endY };
  const end = { x: endX, y: endY };
  const obstacles = collectObstacles(input, e, input.nodes.get(e.source)!, input.nodes.get(e.target)!, false);
  if (
    segmentHitsObstacle(start, corner, obstacles, gw, tgt)
    || segmentHitsObstacle(corner, end, obstacles, gw, tgt)
  ) {
    return; // 竖直优先 L 撞节点 → 保留原 forward-step
  }
  overrides.set(e.id, vertex);
}

/**
 * 双向节点对（2-cycle）回边的侧面进入：当 A↔B 两节点间存在一对方向相反的边（审批/驳回回路是
 * 典型——fixture 37「审核问题工单」⇄「审批问题工单」），正向边（cross-lane-down）默认竖直走在
 * target.cx 的走廊里，回边（cross-lane-up）又被拉到同一条 target.cx 竖直走廊上，两条线叠成一条、
 * 两个标签（批准/拒绝）压在一起，看不出是两条边。
 *
 * 修法：把回边（cross-lane-up 那条）改从**侧面**进 target——沿 source 自己的 cx 竖上去，横入
 * target 朝向 source 的那一侧（source 在右→进 target.right，否则 target.left）。正向边保持原走廊，
 * 两条边各占独立竖直 X，自然分开。
 *
 * 窄触发：①回边须 cross-lane-up 且存在反向兄弟边；②两节点 cx 有足够横向错位（对齐时侧进无意义、
 * 且竖直仍会叠），阈值借 SHAPER_MARGIN；③侧面竖直优先 L 两段不撞节点，否则保留原走廊路由。
 */
/**
 * end event 底进规划：end 同时有「左侧同排进边」（如脊柱边，占住 end 左侧进近走廊）
 * 和「下方进边」时，把下方边的 target 锚点改成 bottom——否则 forward-step 的 right→left
 * Z 末段会和脊柱边共线叠走（17 的 取消补偿→结束 与脊柱在 end 左侧叠了 70px，用户目检打回）。
 * 只在 Z 形（source.right → target.cx → target.bottom）两段都无障碍时才改，否则保持默认。
 */
function planEndBottomAnchors(
  input: RouteInput,
  edgeTypes: Map<string, ReturnType<typeof classify>>,
): Map<string, Anchor> {
  const overrides = new Map<string, Anchor>();
  const incoming = new Map<string, RouteInputEdge[]>();
  for (const e of input.edges) {
    if (e.bpmnType !== 'sequenceFlow') continue;
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target)!.push(e);
  }
  for (const [tgtId, edges] of incoming) {
    if (edges.length < 2) continue;
    const tgt = input.nodes.get(tgtId);
    if (!tgt || tgt.type !== 'endEvent') continue;
    const tb = tgt.box;
    const tCy = tb.y + tb.h / 2;
    const hasLeftRowEntry = edges.some(e => {
      const sb = input.nodes.get(e.source)?.box;
      return sb !== undefined
        && sb.x + sb.w <= tb.x + 1
        && Math.abs(sb.y + sb.h / 2 - tCy) <= 60;
    });
    if (!hasLeftRowEntry) continue;
    for (const e of edges) {
      if (edgeTypes.get(e.id) !== 'forward-step') continue;
      const src = input.nodes.get(e.source)!;
      const sb = src.box;
      const srcCy = sb.y + sb.h / 2;
      if (srcCy <= tb.y + tb.h + 4) continue;        // source 严格在 target 下方
      if (tb.x + tb.w / 2 <= sb.x + sb.w) continue;  // target 必须在右侧
      const start = { x: sb.x + sb.w, y: srcCy };
      const corner = { x: tb.x + tb.w / 2, y: srcCy };
      const end = { x: tb.x + tb.w / 2, y: tb.y + tb.h };
      const obstacles = collectObstacles(input, e, src, tgt, false);
      if (segmentHitsObstacle(start, corner, obstacles, sb, tb)) continue;
      if (segmentHitsObstacle(corner, end, obstacles, sb, tb)) continue;
      overrides.set(e.id, 'bottom');
    }
  }
  return overrides;
}

function planReversePairAnchors(
  input: RouteInput,
  edgeTypes: Map<string, ReturnType<typeof classify>>,
): Map<string, Anchor> {
  const overrides = new Map<string, Anchor>();
  const pairKey = (s: string, t: string) => `${s} ${t}`;
  const present = new Set<string>();
  for (const e of input.edges) present.add(pairKey(e.source, e.target));

  for (const e of input.edges) {
    if (edgeTypes.get(e.id) !== 'cross-lane-up') continue;
    if (!present.has(pairKey(e.target, e.source))) continue; // 无反向兄弟边
    const src = input.nodes.get(e.source)!.box; // 回边的 source 在下方
    const tgt = input.nodes.get(e.target)!.box; // target 在上方
    const srcCx = src.x + src.w / 2;
    const tgtCx = tgt.x + tgt.w / 2;
    if (Math.abs(srcCx - tgtCx) < SHAPER_MARGIN) continue; // 几乎对齐 → 侧进无益
    const side: Anchor = srcCx >= tgtCx ? 'right' : 'left';

    // 竖直优先 L：source.top 竖到 target.cy，再横入 target 的 side。两段都不撞节点才改。
    const start = { x: srcCx, y: src.y };
    const enterX = side === 'right' ? tgt.x + tgt.w : tgt.x;
    const end = { x: enterX, y: tgt.y + tgt.h / 2 };
    const corner = { x: srcCx, y: end.y };
    const obstacles = collectObstacles(input, e, input.nodes.get(e.source)!, input.nodes.get(e.target)!, false);
    if (
      segmentHitsObstacle(start, corner, obstacles, src, tgt)
      || segmentHitsObstacle(corner, end, obstacles, src, tgt)
    ) {
      continue;
    }
    overrides.set(e.id, side);
  }
  return overrides;
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

  // stub 必须落在进入侧的外侧（min/max 顺手保「approach 本来就够长就不挪」）。
  // 别按接近方向换侧——RTL 行的鱼钩根因是端口侧别标错（已由 resolveAnchorsForGeometry
  // 的 RTL 锚点翻转修复），在这里换侧会把 stub 点放进目标盒内部（96/98 的 E3 实测）。
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

// F7 通用净空 pass：把任何「内部水平段」中离某条 lane 分隔线 < TRIGGER 的，推到离所有分隔线
// ≥ TARGET（跨多 lane 的边走廊有时正好落在分隔线旁几 px，视觉与泳道线粘连）。只动触发段;
// 推完若撞节点或反而更近别的分隔线则回滚。端点段(连节点的首尾)不动。
const DIVIDER_NUDGE_TRIGGER = 8;
const DIVIDER_NUDGE_TARGET = 10;

function nudgeHorizontalSegmentsOffDividers(
  routes: Map<string, EdgeRoute>,
  input: RouteInput,
  skipIds: ReadonlySet<string>,
): void {
  const dividers: number[] = [];
  for (const [, lb] of input.laneBoxes) dividers.push(lb.top, lb.bottom);
  const uniqDiv = [...new Set(dividers)];
  if (uniqDiv.length === 0) return;

  const nearestDivider = (y: number): number | null => {
    let best: number | null = null;
    let bestD = Infinity;
    for (const d of uniqDiv) {
      const dd = Math.abs(y - d);
      if (dd < bestD) { bestD = dd; best = d; }
    }
    return bestD < DIVIDER_NUDGE_TRIGGER ? best : null;
  };
  const minDivDist = (y: number): number => Math.min(...uniqDiv.map((d) => Math.abs(y - d)));

  for (const edge of input.edges) {
    if (skipIds.has(edge.id)) continue;
    const route = routes.get(edge.id);
    const src = input.nodes.get(edge.source);
    const tgt = input.nodes.get(edge.target);
    if (!route || !src || !tgt) continue;
    const wps = route.waypoints;
    if (wps.length < 4) continue; // 没有"内部"水平段可动
    const obstacles = collectObstacles(input, edge, src, tgt, src.poolId !== tgt.poolId, true);

    // 内部水平段:索引 i..i+1 都不是首尾端点(i>=1 且 i+1<=len-2)
    for (let i = 1; i + 1 <= wps.length - 2; i++) {
      const a = wps[i]!;
      const b = wps[i + 1]!;
      if (Math.abs(a.y - b.y) > 1) continue; // 非水平
      const d = nearestDivider(a.y);
      if (d === null) continue;
      // 候选:分隔线两侧 ±TARGET,挑离所有分隔线最远且不撞节点的
      const cands = [d - DIVIDER_NUDGE_TARGET, d + DIVIDER_NUDGE_TARGET]
        .sort((p, q) => minDivDist(q) - minDivDist(p));
      const origY = a.y;
      for (const cand of cands) {
        if (minDivDist(cand) < DIVIDER_NUDGE_TRIGGER) continue; // 推过去反而贴另一条
        a.y = cand;
        b.y = cand;
        if (!routeCrossesObstacles(wps, obstacles)) break; // 成功
        a.y = origY; b.y = origY; // 回滚,试下一个候选
      }
    }
  }
}

const PARALLEL_MIN_GAP = 10;    // 镜像 evaluator F8_MIN_GAP:dy < 此值即视觉叠线
const PARALLEL_TARGET_GAP = 12; // 推开后留的间距(略高于阈值,留余量)

// F8 净空:把两条不同 edge 的近平行内部水平段推开。只动内部段(两端都非首尾 waypoint),所以端点
// 贴边/末段正交(E1/E3)不受影响;移动后整条路径过 routeCrossesObstacles,撞节点即回滚;推到的新
// Y 若贴近泳道分隔线则放弃(别为修 F8 又破 F7)。单趟贪心:改一段就地更新,后续比较读新值。
function nudgeParallelSegmentsApart(
  routes: Map<string, EdgeRoute>,
  input: RouteInput,
  skipIds: ReadonlySet<string>,
): void {
  const dividers = new Set<number>();
  for (const [, lb] of input.laneBoxes) { dividers.add(lb.top); dividers.add(lb.bottom); }
  const nearDivider = (y: number): boolean =>
    [...dividers].some((d) => Math.abs(y - d) < DIVIDER_NUDGE_TRIGGER);

  // fixed = fan-in 归一走廊段:它是一束 reject 边共用的单根干线,不能拆动,但**会**和别的边
  // (如主流 forward 步降段)叠成近平行——把它当固定锚,只推可动的那条让开(fixture 40:lane
  // 增高后走廊上移,正好和 submit→dept 的步降段并行 dy=8)。
  interface HSeg { wps: Waypoint[]; i: number; obstacles: NodeBox[]; fixed: boolean }
  const segs: HSeg[] = [];
  for (const edge of input.edges) {
    const route = routes.get(edge.id);
    const src = input.nodes.get(edge.source);
    const tgt = input.nodes.get(edge.target);
    if (!route || !src || !tgt) continue;
    const wps = route.waypoints;
    const fixed = skipIds.has(edge.id);
    const obstacles = collectObstacles(input, edge, src, tgt, src.poolId !== tgt.poolId, true);
    const pushIfHorizontal = (i: number, isFixed: boolean) => {
      const a = wps[i]!, b = wps[i + 1]!;
      if (Math.abs(a.y - b.y) > 1) return;       // 非水平
      if (Math.abs(a.x - b.x) < 20) return;      // 太短,F8 也不计
      segs.push({ wps, i, obstacles, fixed: isFixed });
    };
    // 首段（source stub）/ 末段（target stub）/ 整条直行边：不可动（动了破 E1/E3），
    // 但它们是 F8 叠线的另一半——13 就是 handler 拱廊 y=77 贴上 超时处理→超时结束
    // 的两点直行边 y=72，此前 pass 只收内部段，根本看不见这对。收作固定锚让别人让开。
    if (wps.length < 4) {
      pushIfHorizontal(0, true);
      if (wps.length === 3) pushIfHorizontal(1, true);
      continue;
    }
    pushIfHorizontal(0, true);
    pushIfHorizontal(wps.length - 2, true);
    for (let i = 1; i <= wps.length - 3; i++) pushIfHorizontal(i, fixed);
  }

  const xLo = (g: HSeg): number => Math.min(g.wps[g.i]!.x, g.wps[g.i + 1]!.x);
  const xHi = (g: HSeg): number => Math.max(g.wps[g.i]!.x, g.wps[g.i + 1]!.x);
  const xOverlap = (g: HSeg, h: HSeg): number =>
    Math.min(xHi(g), xHi(h)) - Math.max(xLo(g), xLo(h));

  // 把 seg 的水平段推到离 otherY 至少 PARALLEL_TARGET_GAP(朝当前所在的那一侧推远),成功返回 true。
  // 拒绝三种坏落点:贴泳道线、撞节点、或推过去又和**另一条**重叠段挤成新的近平行(否则只是把
  // 糊线从一处搬到另一处——23 那一簇边就是这么越推越糟)。
  const tryShift = (seg: HSeg, otherY: number): boolean => {
    const a = seg.wps[seg.i]!, b = seg.wps[seg.i + 1]!;
    const sign = a.y >= otherY ? 1 : -1;
    const newY = otherY + sign * PARALLEL_TARGET_GAP;
    if (nearDivider(newY)) return false;
    for (const other of segs) {
      if (other === seg) continue;
      if (xOverlap(seg, other) <= 20) continue;
      const odY = Math.abs(newY - other.wps[other.i]!.y);
      if (odY > 0.5 && odY < PARALLEL_MIN_GAP) return false; // 会撞出新的近平行
    }
    const origY = a.y;
    a.y = newY; b.y = newY;
    if (!routeCrossesObstacles(seg.wps, seg.obstacles)) return true;
    a.y = origY; b.y = origY;
    return false;
  };

  // tryShift 推不开（带里挤满，找不到 ≥12px 落点）时的退路：把可动段精确并到另一段的 y 上
  // 共享一根干线。归一的语义本来就把一束画成一根，两束共享一根远好于留 7px 糊线（F8）。
  // 只能在**本 pass** 做：finalize 的 tail-stub 会再挪水平段（99 的 f_l3_timeout 在走廊 pick
  // 时还在 477.5、dy=21.5 无需处理，finalize 后落 463 才和 456 的走廊贴上）——更早的
  // corridor pick / lane reserve 看到的都是会被改写的旧坐标。覆盖 fixture：99（F8 门禁）。
  const tryMergeOnto = (seg: HSeg, otherY: number): boolean => {
    if (seg.fixed) return false;                 // 走廊干线不动，只能别人并它
    if (nearDivider(otherY)) return false;
    for (const other of segs) {
      if (other === seg) continue;
      if (xOverlap(seg, other) <= 20) continue;
      const odY = Math.abs(otherY - other.wps[other.i]!.y);
      if (odY > 0.5 && odY < PARALLEL_MIN_GAP) return false; // 并过去又和第三者挤成新叠线
    }
    const a = seg.wps[seg.i]!, b = seg.wps[seg.i + 1]!;
    const origY2 = a.y;
    a.y = otherY; b.y = otherY;
    if (!routeCrossesObstacles(seg.wps, seg.obstacles)) return true;
    a.y = origY2; b.y = origY2;
    return false;
  };

  for (let p = 0; p < segs.length; p++) {
    for (let q = p + 1; q < segs.length; q++) {
      const s = segs[p]!, t = segs[q]!;
      if (s.fixed && t.fixed) continue; // 两根都不可动(同束走廊段)→ 无能为力
      const dy = Math.abs(s.wps[s.i]!.y - t.wps[t.i]!.y);
      if (dy <= 0.5 || dy >= PARALLEL_MIN_GAP) continue;
      if (xOverlap(s, t) <= 20) continue;
      // 优先推可动的一根;两根都可动则先试 t、再试 s。都不行就保留(F8 软指标,不制造硬违例/新叠线)。
      // 保留之前先试共享干线：精确重合（dy=0）不是 F8 的叠线，视觉是一根而不是两条。
      if (t.fixed) { if (!tryShift(s, t.wps[t.i]!.y)) tryMergeOnto(s, t.wps[t.i]!.y); continue; }
      if (s.fixed) { if (!tryShift(t, s.wps[s.i]!.y)) tryMergeOnto(t, s.wps[s.i]!.y); continue; }
      if (!tryShift(t, s.wps[s.i]!.y) && !tryShift(s, t.wps[t.i]!.y)) {
        if (!tryMergeOnto(t, s.wps[s.i]!.y)) tryMergeOnto(s, t.wps[t.i]!.y);
      }
    }
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
    // source 出边侧由首段几何反推：横向出（straddle 情形，见 buildFanInPathVertical）是 left/right，
    // 竖直 riser 是 top/bottom。硬猜 top/bottom 会把横向出的边标成上/下，端口侧与实际不符。
    const vFallback: Anchor = wps[1]!.y <= m.src.box.y + m.src.box.h / 2 ? 'top' : 'bottom';
    const srcSide = inferEndpointSide(m.src.box, wps[0]!, vFallback);
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

  // ── 次选：竖直总线（bus）。hSide 的 riser 落在各 source.cx——一列同 X 的 task 汇到侧方
  //    sink 时 riser 必穿同列兄弟（72 的 6 路并行归一），hSide 因此整组被拒；而退路的
  //    「上/下走廊」会让每条边各拖一根长 riser 全叠在 sink 中线上（72 用户目检"太乱"）。
  //    改走总线：成员各自朝 sink 侧出、在「源列与 sink 之间的空隙中点」竖直总线上收到
  //    sink 中线、一次横进 sink 顶点——与 fork 侧的 busifyForwardStep 镜像对称。
  const maxSrcRight = Math.max(...members.map((m) => m.src.box.x + m.src.box.w));
  const minSrcLeft = Math.min(...members.map((m) => m.src.box.x));
  const busGapW = sourcesRight ? minSrcLeft - (sinkBox.x + sinkBox.w) : sinkBox.x - maxSrcRight;
  if (busGapW >= 2 * SHAPER_MARGIN) {
    const trunkX = sourcesRight
      ? (sinkBox.x + sinkBox.w + minSrcLeft) / 2
      : (maxSrcRight + sinkBox.x) / 2;
    const entryX = sourcesRight ? sinkBox.x + sinkBox.w : sinkBox.x;
    const built = members.map((m) => ({ m, wps: buildFanInPathBus(m.src.box, trunkX, sinkCy, entryX, sourcesRight) }));
    if (built.every(({ m, wps }) => !routeCrossesObstacles(wps, obstaclesFor(m)))) {
      for (const { m, wps } of built) applyMember(m, wps, hSide, { x: entryX, y: sinkCy });
      return;
    }
  }

  // ── 退路：sink 中线那行被挡 → 走廊放到 sink 与最近障碍行之间的偏移净空，从上/下单点进入。
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

  // 走廊要躲开的 Y：① lane 分隔线（F7：别贴泳道线）② forward 主流边的水平段（③主流优先、
  // 驳回让路：别贴着主流跑）③ 节点行边缘。在净空带里挑离这些都最远的 Y。
  const avoidYs: number[] = [];
  for (const [, lb] of input.laneBoxes) {
    if (lb.poolId === sink.poolId) avoidYs.push(lb.top, lb.bottom);
  }
  for (const e of input.edges) {
    if (memberSet.has(e.id)) continue;
    const r = routes.get(e.id);
    if (!r) continue;
    for (let i = 0; i < r.waypoints.length - 1; i++) {
      const a = r.waypoints[i]!;
      const b = r.waypoints[i + 1]!;
      if (Math.abs(a.y - b.y) > 1) continue;
      if (Math.max(a.x, b.x) <= spanLo + 2 || Math.min(a.x, b.x) >= spanHi - 2) continue;
      avoidYs.push(a.y);
    }
  }
  avoidYs.push(...obstacleTops, ...obstacleBottoms);

  // 走廊带:从 sink 边(留一点)到最近的节点行边。节点行净空不预扣——节点边已进 avoidYs,
  // 交给 picker 自然保持距离;这样 picker 能选中「分隔线 与 节点行」之间那段净空的中点
  // (预扣 GAP 会把这段挤没,逼得走廊只能贴在分隔线一侧)。
  const entryY = below ? sinkBottom : sinkTop;
  let lo: number;
  let hi: number;
  if (below) {
    const nearestTopBelow = obstacleTops.filter((t) => t > sinkBottom + 1);
    const ceil = nearestTopBelow.length ? Math.min(...nearestTopBelow) : sinkBottom + 2 * FANIN_CORRIDOR_FALLBACK;
    lo = sinkBottom + 4;
    hi = ceil;
  } else {
    const nearestBottomAbove = obstacleBottoms.filter((b) => b < sinkTop - 1);
    const floor = nearestBottomAbove.length ? Math.max(...nearestBottomAbove) : sinkTop - 2 * FANIN_CORRIDOR_FALLBACK;
    lo = floor;
    hi = sinkTop - 4;
  }
  const corridorY = pickCleanCorridorY(lo, hi, avoidYs);
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

// 在 [lo,hi] 里挑离所有 avoidYs 都最远的 Y（最大化到最近 avoid 的距离）。
// 候选 = 区间端点 + 相邻 avoid 中点(落在区间内的) + 区间中点。空 avoid 取中点。
function pickCleanCorridorY(lo: number, hi: number, avoidYs: number[]): number {
  if (hi <= lo) return lo;
  const sorted = [...new Set(avoidYs)].sort((a, b) => a - b);
  if (sorted.length === 0) return (lo + hi) / 2;
  const cands = [lo, hi, (lo + hi) / 2];
  for (let i = 0; i < sorted.length - 1; i++) {
    const mid = (sorted[i]! + sorted[i + 1]!) / 2;
    if (mid > lo && mid < hi) cands.push(mid);
  }
  let best = lo;
  let bestDist = -1;
  for (const c of cands) {
    let d = Infinity;
    for (const a of sorted) d = Math.min(d, Math.abs(c - a));
    if (d > bestDist) { bestDist = d; best = c; }
  }
  return best;
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

// 竖直总线：source 朝 sink 侧出 → 总线 X → 收到 sink 中线 → 一次横进 sink 顶点。
// riser 在总线 X（空隙里），不在 source.cx——同列兄弟不会被 riser 穿过（72 的场景）。
function buildFanInPathBus(src: NodeBox, trunkX: number, sinkCy: number, entryX: number, sourcesRight: boolean): Waypoint[] {
  const srcCy = src.y + src.h / 2;
  const exitX = sourcesRight ? src.x : src.x + src.w;
  return dedupeFanInWaypoints([
    { x: exitX, y: srcCy },
    { x: trunkX, y: srcCy },
    { x: trunkX, y: sinkCy },
    { x: entryX, y: sinkCy },
  ]);
}

// 并行 join 归一总线的最少成员数：≤4 时上/左/下三个顶点分配即干净（04 的 3 路归一是
// 参照形态），≥5 才退化成「riser 全叠 sink 中线」的粗管。
const PARALLEL_JOIN_MIN_MEMBERS = 5;

// 共 target 的并行 join 总线（busifyForwardStep 的 join 侧镜像）：≥5 条非 gateway 出发的
// 同 pool 入边汇到同一 gateway sink 时，成员各自朝 sink 侧出、走「源列与 sink 之间空隙
// 中点」的竖直总线、收到 sink 中线一次横进顶点。全组干净才启用（半个总线比没有更乱）。
function busifyParallelJoinToGateway(
  routes: Map<string, EdgeRoute>,
  input: RouteInput,
  alreadyBused: ReadonlySet<string>,
): Set<string> {
  const done = new Set<string>();
  const incoming = new Map<string, RouteInputEdge[]>();
  for (const e of input.edges) {
    if (e.bpmnType !== 'sequenceFlow') continue;
    if (alreadyBused.has(e.id)) continue;
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target)!.push(e);
  }
  for (const [sinkId, members] of incoming) {
    if (members.length < PARALLEL_JOIN_MIN_MEMBERS) continue;
    const sink = input.nodes.get(sinkId);
    if (!sink || !isGatewayNode(sink)) continue;
    const srcs = members.map((m) => input.nodes.get(m.source));
    if (srcs.some((s) => !s || s.poolId !== sink.poolId || isGatewayNode(s) || s.type === 'boundaryEvent')) continue;
    // sink 朝成员那侧的顶点被非成员边占着就不抢（主流入/出口优先）
    const srcMeanCx = avg(srcs.map((s) => s!.box.x + s!.box.w / 2));
    const sinkCx = sink.box.x + sink.box.w / 2;
    const sourcesRight = srcMeanCx > sinkCx;
    const hSide: Anchor = sourcesRight ? 'right' : 'left';
    const occupied = new Set<Anchor>();
    for (const e of input.edges) {
      if (members.some((m) => m.id === e.id)) continue;
      const r = routes.get(e.id);
      if (!r) continue;
      if (e.target === sinkId) occupied.add(r.targetPort.side);
      if (e.source === sinkId) occupied.add(r.sourcePort.side);
    }
    if (occupied.has(hSide)) continue;
    const sinkCy = sink.box.y + sink.box.h / 2;
    const maxSrcRight = Math.max(...srcs.map((s) => s!.box.x + s!.box.w));
    const minSrcLeft = Math.min(...srcs.map((s) => s!.box.x));
    const gapW = sourcesRight ? minSrcLeft - (sink.box.x + sink.box.w) : sink.box.x - maxSrcRight;
    if (gapW < 2 * SHAPER_MARGIN) continue;
    const trunkX = sourcesRight
      ? (sink.box.x + sink.box.w + minSrcLeft) / 2
      : (maxSrcRight + sink.box.x) / 2;
    const entryX = sourcesRight ? sink.box.x + sink.box.w : sink.box.x;
    const built = members.map((m) => {
      const s = input.nodes.get(m.source)!;
      return { m, wps: buildFanInPathBus(s.box, trunkX, sinkCy, entryX, sourcesRight) };
    });
    const clean = built.every(({ m, wps }) => {
      const s = input.nodes.get(m.source)!;
      const obstacles = collectObstacles(input, m, s, sink, false, true);
      return !routeCrossesObstacles(wps, obstacles);
    });
    if (!clean) continue;
    for (const { m, wps } of built) {
      const r = routes.get(m.id)!;
      r.waypoints = wps;
      r.sourcePort = makeBoxPort(m.source, sourcesRight ? 'left' : 'right', wps[0]!);
      r.targetPort = makeBoxPort(m.target, hSide, wps[wps.length - 1]!);
      done.add(m.id);
    }
  }
  return done;
}

// 竖直进入：source → riser 到偏移走廊 → 水平到 sink.cx → 竖直单点进 sink 上/下边。
function buildFanInPathVertical(src: NodeBox, corridorY: number, sinkCx: number, entryY: number): Waypoint[] {
  const srcCx = src.x + src.w / 2;
  const srcCy = src.y + src.h / 2;
  // 走廊高度正好落在 source 自己的 Y 跨度内时（source 与 sink 几乎同高——fixture 40 的 gw_dept：
  // 走廊 y=190 落在网关 166..216 内），竖直 riser 会从节点边折回穿过自己的身体，起点假性贴边、
  // 线压在网关上（用户实测"起点不对"）。改从朝向 sink 的那一侧水平出、直落走廊，省掉退化 riser。
  if (corridorY > src.y && corridorY < src.y + src.h) {
    const exitX = sinkCx >= srcCx ? src.x + src.w : src.x;
    return dedupeFanInWaypoints([
      { x: exitX, y: corridorY },
      { x: sinkCx, y: corridorY },
      { x: sinkCx, y: entryY },
    ]);
  }
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
