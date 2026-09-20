// LaneConstrainer
//
// 职责：把 Stage 1 给的节点 Y 重写进所属 lane。简单 lane 居中；分支 lane 保留多行。
//      算 leaf lane 的 Y band（top, bottom, centerY, height）一并输出。
//
// lane partitioning 只能作为 ELK hint，最终 Y band 仍由这里显式计算和 snap。

import type { FlowNodeType, Lane } from '../loader/types.ts';
import type { LaneBox, NodeBox } from './types.ts';
import { LANE_PAD, LANE_MIN_H, POOL_PAD_X, ioSpecExtraBelow, isGatewayType, eventLabelSize } from '../layout/node-sizes.ts';
import { allLaneOrder, leafLaneOrder, nodeToLeafLane } from '../layout/lane-resolver.ts';
import { linearOrder } from './compactor.ts';

export interface LaneNodeMeta {
  type: FlowNodeType;
  name?: string;
  ioInputCount?: number;
  ioOutputCount?: number;
  ioInputNames?: readonly string[];
  ioOutputNames?: readonly string[];
}

export interface LaneEdgeInfo {
  source: string;
  target: string;
  id?: string;
}

export interface LaneConstrainInput {
  /** 来自 Stage 1，pool-local 坐标 */
  nodes: Map<string, NodeBox>;
  /** Stage 1 输出的 pool 宽度（X 不变；用来确定 pool 宽度） */
  width: number;
  /** Stage 1 输出的 pool 高度；无 lane 时直接作为 pool 高度，避免重复估算 layout-only reserve。 */
  height?: number;
  /** Loader 给的扁平 lane 列表（可能嵌套） */
  lanes: Lane[];
  /** 节点元信息：用于预测节点 label（gateway 上方、event 下方）占用空间 */
  nodeMeta?: Map<string, LaneNodeMeta>;
  /** 同 pool 内的 sequenceFlows：用于预测 forward-skip arch 的上凸高度 */
  edges?: LaneEdgeInfo[];
  /** 挂了 boundary event 的 host 节点 id：B1 要 BE 半内半外骑 host 底边，lane 底部要预留净空 */
  boundaryHosts?: ReadonlySet<string>;
  /** 语义回边（BackEdgeResolver）：无 lane pool 的纯链 Y snap 判链时剔除 */
  backEdgeIds?: ReadonlySet<string>;
  /** BE host → 其 handler 节点组：脊柱走廊守卫用——handler 组挡住同排脊柱对的直线走廊时整组下移 */
  handlerGroups?: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface LaneConstrainOutput {
  /** node id → 新 NodeBox（Y snap 到所属 lane 内部；必要时修复同 lane 内重叠） */
  nodes: Map<string, NodeBox>;
  /** lane id（含中间层）→ Y band。中间 lane = 其叶子后代的 union */
  laneBoxes: Map<string, LaneBox>;
  /** leaf lane id 顺序（从上到下） */
  leafOrder: string[];
  /** 全部 lane id（含中间层），DFS document 顺序，parent 在 children 之前 */
  allLanes: string[];
  /** pool 高度 = 各 leaf lane 高度之和 */
  poolHeight: number;
  /** pool 宽度，跟输入一致 */
  poolWidth: number;
  /** snake 折行 lane 的成员行方向表（仅 snake 触发时存在）：edge-router 分类要用 */
  nodeRowDir?: Map<string, 1 | -1>;
}

// 行高 / 距节点净空：与 serializer/diagram-builder 的 label 盒一致（行数 × 行高见
// node-sizes 的 eventLabelSize——label 宽度封顶 200，别再按 100 宽估算行数）。
const LABEL_LINE_H = 14;
const LABEL_NODE_GAP = 4;
// path-shaper 常量复刻：避障 margin + 边 label 的留空
const ARCH_CLEAR_MARGIN = 16;
const ARCH_BASE_OFFSET = 24;
const CHANNEL_GAP = 18;
const EDGE_LABEL_ABOVE_GAP = 5;
const MULTI_ROW_CENTER_GAP = 90;
const MULTI_ROW_MIN_MEMBERS = 3;
const LANE_ROW_GAP = 56;
const MIN_X_GAP = 30;

function isEventType(t: FlowNodeType): boolean {
  return t === 'startEvent' || t === 'endEvent'
    || t === 'intermediateCatchEvent' || t === 'intermediateThrowEvent';
}

/**
 * 脊柱走廊守卫：同排相邻脊柱对（BFS 最短路径上的连续节点，|Δcy| ≤ 60）的直线走廊里
 * 若卡着某个 BE 的 handler 组（17 的 取消补偿、23 的 shipping_status handler），脊柱边
 * 只能绕顶（F14 的 C 族）。把整组 handler 下移到走廊带之下（保持组内相对位置），
 * N1 撞节点就整组回退——让不出干净走廊就保持原样，不制造硬违例。
 */
const SPINE_CORRIDOR_SHIFT_GAP = 20;
function clearSpineCorridorOfHandlers(
  nodes: Map<string, NodeBox>,
  edges: LaneEdgeInfo[] | undefined,
  handlerGroups: ReadonlyMap<string, ReadonlySet<string>> | undefined,
  boundaryHosts: ReadonlySet<string> | undefined,
): { nodes: Map<string, NodeBox>; maxBottom: number } {
  if (!edges || edges.length === 0 || !handlerGroups || handlerGroups.size === 0) {
    return { nodes, maxBottom: 0 };
  }
  const handlerOf = new Map<string, string>(); // nodeId → hostId
  for (const [host, members] of handlerGroups) for (const id of members) handlerOf.set(id, host);

  // BFS 最短脊柱（同 F14）：从所有 start 到所有 end 取第一条找到的；无 start/end 就无脊柱可守
  const inDeg = new Map<string, number>();
  const outAdj = new Map<string, string[]>();
  for (const e of edges) {
    if (!nodes.has(e.source) || !nodes.has(e.target)) continue;
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
    if (!outAdj.has(e.source)) outAdj.set(e.source, []);
    outAdj.get(e.source)!.push(e.target);
  }
  const isEnd = (id: string) => (outAdj.get(id) ?? []).length === 0;
  let spine: string[] = [];
  for (const id of nodes.keys()) {
    if ((inDeg.get(id) ?? 0) > 0) continue;
    const parent = new Map<string, string>();
    const queue = [id];
    const seen = new Set([id]);
    let hit: string | null = null;
    while (queue.length > 0 && hit === null) {
      const u = queue.shift()!;
      if (u !== id && isEnd(u)) { hit = u; break; }
      for (const v of outAdj.get(u) ?? []) {
        if (seen.has(v)) continue;
        seen.add(v);
        parent.set(v, u);
        queue.push(v);
      }
    }
    if (hit !== null) {
      const path = [hit];
      let cur = hit;
      while (cur !== id) { cur = parent.get(cur)!; path.unshift(cur); }
      if (path.length > spine.length) spine = path;
    }
  }
  if (spine.length < 2) return { nodes, maxBottom: 0 };
  const spineSet = new Set(spine);

  const out = new Map(nodes);
  const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  let maxBottom = 0;
  for (let i = 0; i + 1 < spine.length; i++) {
    const ub = out.get(spine[i]!)!;
    const vb = out.get(spine[i + 1]!)!;
    const uCy = ub.y + ub.h / 2;
    const vCy = vb.y + vb.h / 2;
    // 严格同排才移：cy 不同（如 23 的 36px 差）时脊柱边本来就画不直（模板 Z），
    // 移 handler 救不了它，只会白吃 F10/F13 代价。
    if (Math.abs(uCy - vCy) > 4) continue;
    if (ub.x >= vb.x) continue;               // 脊柱应 LTR，回绕段不是直线走廊
    const bandTop = Math.min(ub.y, vb.y);
    const bandBottom = Math.max(ub.y + ub.h, vb.y + vb.h);
    const xLo = ub.x + ub.w;
    const xHi = vb.x;
    if (xHi <= xLo) continue;

    // 找出所有与走廊相交的 handler 组（按 host 去重）
    const blockingHosts = new Set<string>();
    for (const [id, b] of out) {
      const host = handlerOf.get(id);
      if (!host || spineSet.has(id)) continue;
      if (overlaps(b, { x: xLo, y: bandTop, w: xHi - xLo, h: bandBottom - bandTop })) blockingHosts.add(host);
    }
    for (const host of blockingHosts) {
      const members = [...handlerGroups.get(host)!].filter(id => out.has(id));
      if (members.length === 0) continue;
      const groupMinTop = Math.min(...members.map(id => out.get(id)!.y));
      const groupMinX = Math.min(...members.map(id => out.get(id)!.x));
      // host 挂 BE 时多留 BE 净空：handler 下移后 BE 骑 host 底边，其 label 在 BE 下方
      // 还要 18+4+14——17 初版只留 20px，handler 顶正好压进 取消边界 的 label 区（L2）。
      const beReserve = boundaryHosts?.has(host) ? 36 : 0;
      const dy = bandBottom + SPINE_CORRIDOR_SHIFT_GAP + beReserve - groupMinTop;
      if (dy <= 0) continue;
      const hostBox = out.get(host);
      // 下移同时锚回 host 左下（BE→handler 短潜行，不横跨整个容器底——17 的 取消补偿
      // 光下移不挪 X 时 handler 漂在右下、BE 线拉满底边，用户目检打回）。X 撞了就只下移。
      const dx = hostBox ? hostBox.x - groupMinX : 0;
      const trialAt = (ddx: number) => members.map(id => {
        const b = out.get(id)!;
        return { id, box: { ...b, x: b.x + ddx, y: b.y + dy } };
      });
      const memberSet = new Set(members);
      const fits = (trial: { id: string; box: NodeBox }[]) =>
        trial.every(t => [...out].every(([oid, ob]) => memberSet.has(oid) || !overlaps(t.box, ob)));
      const trialAnchored = dx !== 0 ? trialAt(dx) : null;
      const trial = trialAnchored && fits(trialAnchored) ? trialAnchored : trialAt(0);
      if (!fits(trial)) continue; // 让不开就保持原样（handler 排布是 P3 定的，不硬来）
      for (const t of trial) {
        out.set(t.id, t.box);
        maxBottom = Math.max(maxBottom, t.box.y + t.box.h);
      }
    }
  }
  return { nodes: out, maxBottom };
}

/** 无 lane pool 的纯链 Y snap：按连通分量各自判定——剔语义回边后是全覆盖纯链的分量，
 *  其成员 cy snap 到分量中位数（X 不动）。78 的主流链 + 游离事件子流程各自成链，
 *  不能要求整池纯链。 */
function snapNoLanePureChain(
  nodes: Map<string, NodeBox>,
  edges: LaneEdgeInfo[] | undefined,
  backEdgeIds: ReadonlySet<string> | undefined,
  boundaryHosts: ReadonlySet<string> | undefined,
): Map<string, NodeBox> {
  if (!edges || edges.length === 0) return new Map(nodes);
  if (boundaryHosts && boundaryHosts.size > 0) return new Map(nodes);
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const id of nodes.keys()) parent.set(id, id);
  for (const e of edges) {
    if (!nodes.has(e.source) || !nodes.has(e.target)) continue;
    parent.set(find(e.source), find(e.target));
  }
  const comps = new Map<string, string[]>();
  for (const id of nodes.keys()) {
    const r = find(id);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r)!.push(id);
  }
  const out = new Map(nodes);
  for (const members of comps.values()) {
    const memberSet = new Set(members);
    const subNodes = new Map(members.map(id => [id, nodes.get(id)!] as const));
    const subEdges = edges.filter(e => memberSet.has(e.source) && memberSet.has(e.target));
    const order = linearOrder(subNodes, subEdges, backEdgeIds);
    if (!order) continue;
    const cys = order.map(id => nodes.get(id)!.y + nodes.get(id)!.h / 2).sort((a, b) => a - b);
    const medianCy = cys[Math.floor(cys.length / 2)]!;
    for (const id of members) {
      const b = out.get(id)!;
      const cy = b.y + b.h / 2;
      if (Math.abs(cy - medianCy) > 0.5) out.set(id, { ...b, y: medianCy - b.h / 2 });
    }
  }
  return out;
}

export function laneConstrain(input: LaneConstrainInput): LaneConstrainOutput {
  const { nodes, lanes, width, nodeMeta, edges } = input;

  // 没有 lane 的 pool：原样返回，poolHeight 由节点决定。
  // 例外：纯链（剔语义回边后 in/out ≤1 全覆盖）做中位 cy snap——ELK 在带回边的链上会
  // 把节点摆成 ±25px 错层（回边拉拽分层），主流相邻边各吃一个 2 弯 Z（78 的 F14）。
  // 与 subprocess-layout 的内链 snap 同一规则。有 BE host 不折腾（净空关系）。
  if (lanes.length === 0) {
    let poolHeight = input.height;
    if (poolHeight === undefined) {
      poolHeight = 0;
      for (const [nodeId, b] of nodes) {
        const meta = nodeMeta?.get(nodeId);
        poolHeight = Math.max(poolHeight, b.y + b.h + ioSpecExtraBelow(
          meta?.ioInputCount ?? 0,
          meta?.ioOutputCount ?? 0,
          meta?.ioInputNames,
          meta?.ioOutputNames,
          b.w,
        ));
      }
    }
    const snapped = snapNoLanePureChain(nodes, edges, input.backEdgeIds, input.boundaryHosts);
    const guarded = clearSpineCorridorOfHandlers(snapped, edges, input.handlerGroups, input.boundaryHosts);
    if (guarded.maxBottom > 0) poolHeight = Math.max(poolHeight, guarded.maxBottom);
    return {
      nodes: guarded.nodes,
      laneBoxes: new Map(),
      leafOrder: [],
      allLanes: [],
      poolHeight,
      poolWidth: width,
    };
  }

  const leafOrder = leafLaneOrder(lanes);
  const allLanes = allLaneOrder(lanes);
  const nodeLeaf = nodeToLeafLane(lanes, leafOrder);

  // 每个 leaf lane 的高度：综合考虑
  //   1) 成员节点本身 h
  //   2) 节点 label（gateway 名字摆在节点上方、event 名字摆在节点下方）
  //   3) 同 lane 内 forward-skip arch 上凸需要的 headroom（含 arch 上方的 edge label）
  // 节点摆在每条 lane 的 content center；center 不一定等于几何中线，因为 ioSpec 只向
  // task 下方伸展，强行上下对称会把 lane 撑得过高。
  const laneMembers = new Map<string, string[]>();
  for (const laneId of leafOrder) {
    const memberIds: string[] = [];
    for (const [nodeId] of nodes) {
      if (nodeLeaf.get(nodeId) === laneId) memberIds.push(nodeId);
    }
    laneMembers.set(laneId, memberIds);
  }

  // node → leaf lane index(自上而下)。fan-in 走廊方向靠 lane 顺序判定——此刻节点 Y 还是
  // ELK 原值、未 snap 到 lane,用 Y 判上下不可靠(见 estimateFanInCorridorReserve)。
  const laneIndexById = new Map<string, number>(leafOrder.map((id, i) => [id, i]));
  const laneIndexOf = new Map<string, number>();
  for (const [nodeId, laneId] of nodeLeaf) {
    const idx = laneIndexById.get(laneId);
    if (idx !== undefined) laneIndexOf.set(nodeId, idx);
  }

  const laneMetrics = new Map<string, LaneMetric>();
  for (const laneId of leafOrder) {
    const memberIds = laneMembers.get(laneId) ?? [];
    laneMetrics.set(laneId, buildLaneMetric(memberIds, nodes, nodeMeta, edges, laneIndexOf, input.boundaryHosts));
  }

  // Lane Y band：从 y=0 顺序累加（仅叶子）
  const laneBoxes = new Map<string, LaneBox>();
  let cursorY = 0;
  for (const laneId of leafOrder) {
    const metric = laneMetrics.get(laneId)!;
    const h = metric.height;
    laneBoxes.set(laneId, {
      top: cursorY,
      bottom: cursorY + h,
      centerY: cursorY + metric.centerOffset,
      height: h,
    });
    cursorY += h;
  }
  const poolHeight = cursorY;

  // 中间 lane box = 其叶子后代 union。后序遍历填充。
  const leafSet = new Set(leafOrder);
  const childrenBy = new Map<string | null, Lane[]>();
  for (const l of lanes) {
    const k = l.parentLaneId;
    if (!childrenBy.has(k)) childrenBy.set(k, []);
    childrenBy.get(k)!.push(l);
  }
  const laneById = new Map<string, Lane>(lanes.map(l => [l.id, l]));
  function computeIntermediate(laneId: string): LaneBox {
    const existing = laneBoxes.get(laneId);
    if (existing) return existing;
    const kids = childrenBy.get(laneId) ?? [];
    let top = Infinity, bottom = -Infinity;
    for (const k of kids) {
      const kb = leafSet.has(k.id) ? laneBoxes.get(k.id)! : computeIntermediate(k.id);
      if (kb.top < top) top = kb.top;
      if (kb.bottom > bottom) bottom = kb.bottom;
    }
    if (!isFinite(top) || !isFinite(bottom)) {
      // 空 lane（没有任何子 lane，也不是 leaf）— 不应发生
      top = 0; bottom = LANE_MIN_H;
    }
    const box: LaneBox = { top, bottom, centerY: (top + bottom) / 2, height: bottom - top };
    laneBoxes.set(laneId, box);
    return box;
  }
  for (const id of allLanes) if (!leafSet.has(id)) computeIntermediate(id);

  // 节点 Y snap 到所属 lane 的内部行。简单泳道只有一行；分支型泳道会保留 ELK 的多行顺序。
  const outNodes = new Map<string, NodeBox>();
  for (const [nodeId, box] of nodes) {
    const laneId = nodeLeaf.get(nodeId);
    if (!laneId) {
      outNodes.set(nodeId, { ...box });
      continue;
    }
    const band = laneBoxes.get(laneId);
    if (!band) {
      outNodes.set(nodeId, { ...box });
      continue;
    }
    const metric = laneMetrics.get(laneId);
    const rowCenter = metric?.nodeCenterOffset.get(nodeId) ?? metric?.centerOffset ?? (band.height / 2);
    outNodes.set(nodeId, {
      x: metric?.nodeX?.get(nodeId) ?? box.x,
      y: band.top + rowCenter - box.h / 2,
      w: box.w,
      h: box.h,
    });
  }

  resolveLaneOverlaps(outNodes, laneMembers);

  // snake 折行重排过 X 的 lane：pool 宽度按节点实际右缘收紧（不然池子还是单行时的宽度，
  // 宽高比改善全落空）。无 snake 时保持 Stage 1 的宽度输入不动。
  const snaked = [...laneMetrics.values()].some(m => m.nodeX && m.nodeX.size > 0);
  const poolWidth = snaked
    ? Math.max(...Array.from(outNodes.values()).map(b => b.x + b.w), 0) + POOL_PAD_X
    : width;
  // snake lane 的行方向表（奇数行 RTL）：收集自各 snake metric 的成员
  let nodeRowDir: Map<string, 1 | -1> | undefined;
  if (snaked) {
    nodeRowDir = new Map();
    for (const m of laneMetrics.values()) {
      if (!m.nodeX || !m.nodeRowDir) continue;
      for (const [id, dir] of m.nodeRowDir) nodeRowDir.set(id, dir);
    }
  }
  return {
    nodes: outNodes,
    laneBoxes,
    leafOrder,
    allLanes,
    poolHeight,
    poolWidth,
    ...(nodeRowDir ? { nodeRowDir } : {}),
  };
}

interface NodeVerticalExtent {
  above: number;
  below: number;
}

interface LaneRow {
  cy: number;
  ids: string[];
  above: number;
  below: number;
}

interface LaneMetric {
  height: number;
  centerOffset: number;
  nodeCenterOffset: Map<string, number>;
  /** snake 折行时重写成员 X（boustrophedon 重排）；其余路径不出现 */
  nodeX?: Map<string, number>;
  /** snake 折行时成员的行方向（奇数行 RTL = -1）：edge 分类器需要——RTL 行内相邻链边
   *  X 反向是刻意折行而非回边（snake 只对无环纯链触发，行内不可能有真回边） */
  nodeRowDir?: Map<string, 1 | -1>;
}

function buildLaneMetric(
  memberIds: string[],
  nodes: Map<string, NodeBox>,
  nodeMeta: Map<string, LaneNodeMeta> | undefined,
  edges: LaneEdgeInfo[] | undefined,
  laneIndexOf: Map<string, number>,
  boundaryHosts: ReadonlySet<string> | undefined,
): LaneMetric {
  if (memberIds.length === 0) {
    return { height: LANE_MIN_H, centerOffset: LANE_MIN_H / 2, nodeCenterOffset: new Map() };
  }

  const extents = new Map<string, NodeVerticalExtent>();
  for (const id of memberIds) {
    extents.set(id, nodeVerticalExtent(nodes.get(id)!, nodeMeta?.get(id)));
  }

  // BE 骑 host 底边的净空预留：BE 中心 = host.bottom，下半身 18 + label(4+14) 垂在 host 外。
  // host 贴 lane 底时这些必出 lane（82/96/99 的 N2/N3）。只在「最下行里有 boundary host」时
  // 补 below——host 在中间行时，BE+label(36) 落在 LANE_ROW_GAP(56) 里，无需预留。
  const boundaryBelow = estimateBoundaryReserve(memberIds, boundaryHosts);

  // 驳回归一走廊预留：本 lane 若含 fan-in sink，edge-router 会在 sink 上/下边贴一根水平走廊
  // （busifyFanInToSink）。lane 默认只按节点尺寸算高、不给走廊留地，走廊+label 会被挤到泳道
  // 分隔线上（fixture 40 的「驳回」字压线）。这里在走廊所在那一侧补一段净空，把分隔线推开。
  const fanIn = estimateFanInCorridorReserve(memberIds, nodes, edges, laneIndexOf);

  // 驳回回边过境走廊预留：本 lane 含一条 cross-lane-up 边的 *源*，且该源被同 lane 右侧成员挡住
  // （horizontal-first-L 走不通）→ edge-router 只剩 gap 走廊一条路，会把横段贴在 divider+24 处、
  // 正好落进顶行节点里（fixture 44「经理审批→提交报销单」驳回：源在 lane 最左、网关在其右，横段
  // 落 y156 切穿源 task）。在顶行上方补一段净空，让走廊跑在节点上方的干净带里（用户手调即此形态：
  // 把泳道弄高、回边在节点上方平移）。与 fanIn.above 同属「顶行上方水平走廊」，取 max 不叠加。
  const transitAbove = estimateBackEdgeTransitReserve(memberIds, nodes, edges, laneIndexOf);
  const topAbove = Math.max(fanIn.above, transitAbove);

  // 纯串行长链 snake 折行（P6）：lane 成员恰为一条前向单链、且单行宽高比 > 6 时，
  // 蛇形拆成多行（偶数行 X 反向 = boustrophedon，换行边垂直短接）、lane 增高。
  // 71 的 26 节点单 lane 30:1 是触发锚点；分支 lane 一律走原逻辑。
  const snake = detectSnakeRows(memberIds, nodes, edges, extents, boundaryHosts);
  if (snake) {
    return buildSnakeMetric(memberIds, nodes, extents, snake);
  }

  // F2：先按「主干（spine）居中 + 分支上下分布」拆行。主干 = 同 lane 内最长的前向路径（按 X 拓扑
  // 序的最长链）；不在主干上的节点按 ELK 给的 cy 落到主干上方 / 下方，填满泳道而不是全挤一行。
  // ELK 自己的 Y 受跨 lane crossing-min 干扰（如本 fixture 把 gateway_department 甩到最上），不能直接
  // 用；这里把主干 snap 成一条对齐的中心行（保 F5），只让真正的分支节点离开中心行。
  // 拆不出分支（纯链）时返回 null，回退原 groupLaneRows——简单 lane 行为不变，blast radius 受控。
  const spineRows = assignSpineAwareRows(memberIds, nodes, extents, edges);
  if (spineRows) {
    for (const row of spineRows) {
      const reserve = estimateForwardArchReserve(row.ids, nodes, edges, nodeMeta);
      if (reserve.above > row.above) row.above = reserve.above;
      if (reserve.below > row.below) row.below = reserve.below;
    }
    if (topAbove > 0) spineRows[0]!.above += topAbove;
    if (fanIn.below > 0) spineRows[spineRows.length - 1]!.below += fanIn.below;
    applyBoundaryReserveToLastRow(spineRows, boundaryHosts, boundaryBelow);
    return buildMultiRowMetric(spineRows);
  }

  const rows = groupLaneRows(memberIds, nodes, extents);
  const shouldKeepRows = rows.length > 1 && memberIds.length >= MULTI_ROW_MIN_MEMBERS;

  if (shouldKeepRows) {
    // arch 是同行 src/tgt 之间的"凸"，必须按该行实际成员预留。原先只给 rows[0] 加 above，
    // 第 2 行以下的 forward-skip arch 会顶出 lane 边界或挤到上一行的 label 上。
    for (const row of rows) {
      const reserve = estimateForwardArchReserve(row.ids, nodes, edges, nodeMeta);
      if (reserve.above > row.above) row.above = reserve.above;
      if (reserve.below > row.below) row.below = reserve.below;
    }
    // 走廊在最上行之上 / 最下行之下，按侧补到对应边缘行。
    if (topAbove > 0) rows[0]!.above += topAbove;
    if (fanIn.below > 0) rows[rows.length - 1]!.below += fanIn.below;
    applyBoundaryReserveToLastRow(rows, boundaryHosts, boundaryBelow);
    return buildMultiRowMetric(rows);
  }

  const archReserve = estimateForwardArchReserve(memberIds, nodes, edges, nodeMeta);
  return buildFlatMetric(memberIds, extents, archReserve, topAbove, fanIn.below + boundaryBelow);
}

function nodeVerticalExtent(box: NodeBox, meta: LaneNodeMeta | undefined): NodeVerticalExtent {
  const hHalf = box.h / 2;
  let above = hHalf;
  let below = hHalf;
  if (meta?.name && meta.name.length > 0) {
    const labelH = eventLabelSize(meta.name).height;
    if (isGatewayType(meta.type)) {
      above = hHalf + LABEL_NODE_GAP + labelH;
    } else if (isEventType(meta.type)) {
      below = hHalf + LABEL_NODE_GAP + labelH;
    }
  }
  const ioBelow = ioSpecExtraBelow(
    meta?.ioInputCount ?? 0,
    meta?.ioOutputCount ?? 0,
    meta?.ioInputNames,
    meta?.ioOutputNames,
    box.w,
  );
  if (ioBelow > 0) below = Math.max(below, hHalf + ioBelow);
  return { above, below };
}

function groupLaneRows(
  memberIds: string[],
  nodes: Map<string, NodeBox>,
  extents: Map<string, NodeVerticalExtent>,
): LaneRow[] {
  const sorted = memberIds.slice().sort((a, b) => centerY(nodes.get(a)!) - centerY(nodes.get(b)!));
  const rows: LaneRow[] = [];
  for (const id of sorted) {
    const box = nodes.get(id)!;
    const cy = centerY(box);
    const extent = extents.get(id)!;
    const last = rows[rows.length - 1];
    if (last && Math.abs(cy - last.cy) <= MULTI_ROW_CENTER_GAP) {
      last.ids.push(id);
      last.cy = (last.cy * (last.ids.length - 1) + cy) / last.ids.length;
      last.above = Math.max(last.above, extent.above);
      last.below = Math.max(last.below, extent.below);
    } else {
      rows.push({ cy, ids: [id], above: extent.above, below: extent.below });
    }
  }
  return rows;
}

// 分支节点离主干至少这么宽算"分到不同行"才有意义——太挤就别拆。
const SPINE_MIN_BRANCHES = 1;

// F2 拆行：主干（最长前向路径）压一条中心行，分支按 ELK cy 落到上 / 下方，各侧再按 X 不重叠贪心打包成行。
// 返回 top→bottom 顺序的行；拆不出分支（纯链 / 信息不足）→ null，让调用方回退原逻辑。
function assignSpineAwareRows(
  memberIds: string[],
  nodes: Map<string, NodeBox>,
  extents: Map<string, NodeVerticalExtent>,
  edges: LaneEdgeInfo[] | undefined,
): LaneRow[] | null {
  if (!edges || memberIds.length < MULTI_ROW_MIN_MEMBERS) return null;
  const memberSet = new Set(memberIds);

  // 只取同 lane、前向（target 在 source 右侧）的边构 DAG——back-edge / 跨 lane 不参与主干判定。
  const adj = new Map<string, string[]>();
  for (const id of memberIds) adj.set(id, []);
  for (const e of edges) {
    if (!memberSet.has(e.source) || !memberSet.has(e.target)) continue;
    if (nodes.get(e.target)!.x <= nodes.get(e.source)!.x) continue;
    adj.get(e.source)!.push(e.target);
  }

  // 按 X 升序做 DAG 最长链 DP（节点数最多者为主干）。
  const order = memberIds.slice().sort((a, b) => nodes.get(a)!.x - nodes.get(b)!.x);
  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();
  for (const id of order) { dist.set(id, dist.get(id) ?? 0); prev.set(id, prev.get(id) ?? null); }
  for (const id of order) {
    const d = dist.get(id)!;
    for (const t of adj.get(id)!) {
      if (d + 1 > (dist.get(t) ?? 0)) { dist.set(t, d + 1); prev.set(t, id); }
    }
  }
  let endNode: string | null = null;
  let best = -1;
  for (const id of order) { const d = dist.get(id)!; if (d > best) { best = d; endNode = id; } }
  const spine = new Set<string>();
  for (let cur = endNode; cur; cur = prev.get(cur) ?? null) spine.add(cur);

  const branches = memberIds.filter((id) => !spine.has(id));
  if (branches.length < SPINE_MIN_BRANCHES || spine.size < 2) return null;

  const spineRow = makeRowFrom([...spine], extents);
  const spineMeanCy = [...spine].reduce((s, id) => s + centerY(nodes.get(id)!), 0) / spine.size;
  const above: string[] = [];
  const below: string[] = [];
  for (const id of branches) (centerY(nodes.get(id)!) < spineMeanCy ? above : below).push(id);

  // 各侧按 X 不重叠贪心打包成若干行（同行节点 X 区间不相交）。
  const aboveRows = packRowsByX(above, nodes, extents);
  const belowRows = packRowsByX(below, nodes, extents);
  return [...aboveRows, spineRow, ...belowRows];
}

function makeRowFrom(ids: string[], extents: Map<string, NodeVerticalExtent>): LaneRow {
  let above = 0;
  let below = 0;
  for (const id of ids) {
    const e = extents.get(id)!;
    if (e.above > above) above = e.above;
    if (e.below > below) below = e.below;
  }
  return { cy: 0, ids, above, below };
}

// 把一组节点按 X 升序贪心塞进多行：每行内 X 区间互不相交。返回行数组（顺序无关紧要，仅用于堆叠高度）。
function packRowsByX(
  ids: string[],
  nodes: Map<string, NodeBox>,
  extents: Map<string, NodeVerticalExtent>,
): LaneRow[] {
  if (ids.length === 0) return [];
  const sorted = ids.slice().sort((a, b) => nodes.get(a)!.x - nodes.get(b)!.x);
  const rows: { ids: string[]; maxRight: number }[] = [];
  for (const id of sorted) {
    const b = nodes.get(id)!;
    let placed = false;
    for (const row of rows) {
      if (b.x >= row.maxRight + MIN_X_GAP) { row.ids.push(id); row.maxRight = b.x + b.w; placed = true; break; }
    }
    if (!placed) rows.push({ ids: [id], maxRight: b.x + b.w });
  }
  return rows.map((r) => makeRowFrom(r.ids, extents));
}

function buildMultiRowMetric(rows: LaneRow[]): LaneMetric {
  let contentH = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    contentH += row.above + row.below;
    if (i < rows.length - 1) contentH += LANE_ROW_GAP;
  }
  const baseH = contentH + LANE_PAD * 2;
  const h = Math.max(LANE_MIN_H, baseH);
  const extra = h - baseH;
  let cursor = LANE_PAD + extra / 2;
  const nodeCenterOffset = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const rowCenter = cursor + row.above;
    for (const id of row.ids) nodeCenterOffset.set(id, rowCenter);
    cursor += row.above + row.below + (i < rows.length - 1 ? LANE_ROW_GAP : 0);
  }
  return { height: h, centerOffset: h / 2, nodeCenterOffset };
}

function buildFlatMetric(
  memberIds: string[],
  extents: Map<string, NodeVerticalExtent>,
  archReserve: { above: number; below: number },
  fanInReserveAbove = 0,
  fanInReserveBelow = 0,
): LaneMetric {
  let above = archReserve.above;
  let below = archReserve.below;
  for (const id of memberIds) {
    const extent = extents.get(id)!;
    above = Math.max(above, extent.above);
    below = Math.max(below, extent.below);
  }
  // fan-in 走廊预留是节点外的净空带，加在节点 extent 之上（不是 max——走廊在节点边之外）。
  above += fanInReserveAbove;
  below += fanInReserveBelow;
  const contentH = above + below + LANE_PAD * 2;
  const h = Math.max(LANE_MIN_H, contentH);
  const extra = h - contentH;
  const rowCenter = LANE_PAD + extra / 2 + above;
  const nodeCenterOffset = new Map<string, number>();
  for (const id of memberIds) nodeCenterOffset.set(id, rowCenter);
  return { height: h, centerOffset: rowCenter, nodeCenterOffset };
}

// 同行 src/tgt 间「跳过中间节点」的 forward-skip arch 预留高度。返回 {above, below}：
// 默认凸在行上方；但**源是 gateway 的同 cy forward-skip 在 router 里走下方**（见 edge-router 的
// preferForwardSkipBelow——gateway 出边的 label 占着上方，skip 支让到下方），lane 必须在**下方**
// 给这条 arch 留净空，否则它被挤到 lane 底分隔线上、被 obstacle-clear/nudge 揉成多点折线
// （fixture 43「不加辣」默认支：gateway_11 跳过 task_12 直连 task_8，原先 reserve 全加在上方、
// 节点贴着 lane 底，arch 没地方走）。判据与 preferForwardSkipBelow 对齐：源 gateway → 算 below。
function estimateForwardArchReserve(
  memberIds: string[],
  nodes: Map<string, NodeBox>,
  edges: LaneEdgeInfo[] | undefined,
  nodeMeta: Map<string, LaneNodeMeta> | undefined,
): { above: number; below: number } {
  if (!edges || edges.length === 0) return { above: 0, below: 0 };
  const arches: { left: number; right: number; obsMaxH: number; side: 'above' | 'below' }[] = [];
  const memberSet = new Set(memberIds);
  for (const e of edges) {
    if (!memberSet.has(e.source) || !memberSet.has(e.target)) continue;
    const s = nodes.get(e.source)!;
    const t = nodes.get(e.target)!;
    if (t.x <= s.x) continue;
    const sRight = s.x + s.w;
    const tLeft = t.x;
    let obsMaxH = 0;
    for (const otherId of memberIds) {
      if (otherId === e.source || otherId === e.target) continue;
      const o = nodes.get(otherId)!;
      if (o.x + o.w <= sRight || o.x >= tLeft) continue;
      if (o.h > obsMaxH) obsMaxH = o.h;
    }
    if (obsMaxH === 0) continue;
    const srcType = nodeMeta?.get(e.source)?.type;
    const srcIsGateway = srcType !== undefined && isGatewayType(srcType);
    arches.push({ left: sRight, right: tLeft, obsMaxH, side: srcIsGateway ? 'below' : 'above' });
  }

  let above = 0;
  let below = 0;
  for (let i = 0; i < arches.length; i++) {
    const a = arches[i]!;
    let parallel = 1;
    for (let j = 0; j < arches.length; j++) {
      if (j === i) continue;
      const b = arches[j]!;
      if (a.side === b.side && a.left < b.right && b.left < a.right) parallel++;
    }
    const archClear = a.obsMaxH / 2 + ARCH_CLEAR_MARGIN
      + Math.max(0, parallel - 1) * CHANNEL_GAP;
    const labelClear = LABEL_LINE_H + EDGE_LABEL_ABOVE_GAP;
    const need = Math.max(ARCH_BASE_OFFSET, archClear) + labelClear;
    if (a.side === 'below') { if (need > below) below = need; }
    else if (need > above) above = need;
  }
  return { above, below };
}

// 驳回归一走廊在 sink 所在 lane 内需预留的净空(超出节点 extent + LANE_PAD 的部分)。
// 走廊 offset(~28) + edge label(14) + 离分隔线净空(~10),减去 LANE_PAD 已给的 16,约 36。
const FANIN_CORRIDOR_RESERVE = 36;

// 估算本 lane 的 fan-in sink 需要在哪一侧预留走廊净空。
// sink = 被 ≥2 条 backward(source 中心在 sink 右侧)边汇入的成员节点——这正是 edge-router 的
// busifyFanInToSink 识别并聚成水平走廊的「驳回/回环归一」拓扑。走廊朝 source 群所在那一侧贴
// sink 跑:source 多在更下方的 lane → 走廊在下、预留 below,反之预留 above。
// 方向用 **lane 顺序** 判(不是节点 Y):此刻节点 Y 还是 ELK 原值、尚未 snap 到 lane,用 Y 判上下
// 会判反(fixture 40 实测 ELK 把 sink 排得比 source 还低)。backward 判据用 X(ELK 已定、可靠)。
function estimateFanInCorridorReserve(
  memberIds: string[],
  nodes: Map<string, NodeBox>,
  edges: LaneEdgeInfo[] | undefined,
  laneIndexOf: Map<string, number>,
): { above: number; below: number } {
  if (!edges || edges.length === 0) return { above: 0, below: 0 };
  let above = 0;
  let below = 0;
  for (const sinkId of memberIds) {
    const sink = nodes.get(sinkId)!;
    const sinkCx = sink.x + sink.w / 2;
    const sinkIdx = laneIndexOf.get(sinkId);
    if (sinkIdx === undefined) continue;
    const srcLaneIdxs: number[] = [];
    for (const e of edges) {
      if (e.target !== sinkId) continue;
      const s = nodes.get(e.source);
      const sIdx = laneIndexOf.get(e.source);
      if (!s || sIdx === undefined) continue;
      if (s.x + s.w / 2 <= sinkCx) continue; // 只算 source 在 sink 右侧的 backward 边
      srcLaneIdxs.push(sIdx);
    }
    if (srcLaneIdxs.length < 2) continue; // 不足两条 → 不构成归一束
    const meanIdx = srcLaneIdxs.reduce((a, b) => a + b, 0) / srcLaneIdxs.length;
    // 同 lane(meanIdx == sinkIdx)默认走下方——走廊自然贴 sink 底边。
    if (meanIdx >= sinkIdx) below = Math.max(below, FANIN_CORRIDOR_RESERVE);
    else above = Math.max(above, FANIN_CORRIDOR_RESERVE);
  }
  return { above, below };
}

// cross-lane-up 回边过境走廊的净空（同量级于 fan-in 走廊：corridor offset 24 + label 14 ≈ 38，
// 取 36 与 FANIN_CORRIDOR_RESERVE 对齐）。让顶行节点下移 ~36，腾出节点上方的水平带给回边横段。
const BACKEDGE_TRANSIT_RESERVE = 36;

// 估算本 lane 是否需要在顶行上方留「回边过境走廊」净空。
// 触发：本 lane 某成员 S 是一条 cross-lane-up 边的源（target 在更上层 lane，按 lane 顺序判），
// 且 (a) sink 在 S 右侧足够远（→ edge-router 取 target='left'、需要水平过境），
// 且 (b) S 与 sink 之间、与 S 同行的位置上还有别的本 lane 成员挡着（→ horizontal-first-L 走不通，
//        只剩 gap 走廊；走廊默认落 divider+24，会切进顶行节点）。
// 方向用 lane 顺序判（节点 Y 此刻还是 ELK 原值，见 estimateFanInCorridorReserve 同款理由）；
// 横向远近 / 挡道用 X（ELK 已定、可靠）。只算 above（up 边走廊在源行上方）；down 的对称情形暂不处理
// （目前没有 fixture 触发，留待真实用例再加，避免凭空扩大 blast radius）。
function estimateBackEdgeTransitReserve(
  memberIds: string[],
  nodes: Map<string, NodeBox>,
  edges: LaneEdgeInfo[] | undefined,
  laneIndexOf: Map<string, number>,
): number {
  if (!edges || edges.length === 0) return 0;
  const memberSet = new Set(memberIds);
  for (const e of edges) {
    if (!memberSet.has(e.source)) continue;
    const s = nodes.get(e.source);
    const t = nodes.get(e.target);
    const sIdx = laneIndexOf.get(e.source);
    const tIdx = laneIndexOf.get(e.target);
    if (!s || !t || sIdx === undefined || tIdx === undefined) continue;
    if (tIdx >= sIdx) continue; // 目标不在更上层 → 非 cross-lane-up
    const sCx = s.x + s.w / 2;
    const tCx = t.x + t.w / 2;
    // 40 = edge-router resolveAnchorsForGeometry 取 target='left' 的同款门槛(SHAPER_MARGIN 10 + 30)：
    // sink 不在右侧足够远 → 直上 riser 即可，无需水平过境走廊。
    if (tCx <= sCx + 40) continue;
    // S 与 sink 之间是否有同行成员挡道（horizontal-first-L 横段被它穿过 → 失败、回退走廊）
    const blocked = memberIds.some((oid) => {
      if (oid === e.source) return false;
      const o = nodes.get(oid)!;
      return overlapsY(s, o) && o.x + o.w > s.x + s.w && o.x < tCx;
    });
    if (blocked) return BACKEDGE_TRANSIT_RESERVE;
  }
  return 0;
}

// BE 底边净空 = BE 下半身(36/2) + label 距节点(4) + label 行高(14)。与 FANIN_CORRIDOR_RESERVE
// 同量级纯属巧合：一个是"节点外垂下来的装饰"，一个是"贴边的水平走廊"。
const BOUNDARY_BELOW_RESERVE = 36;

function estimateBoundaryReserve(
  memberIds: string[],
  boundaryHosts: ReadonlySet<string> | undefined,
): number {
  if (!boundaryHosts || boundaryHosts.size === 0) return 0;
  return memberIds.some(id => boundaryHosts.has(id)) ? BOUNDARY_BELOW_RESERVE : 0;
}

// 多行时 BE 净空只加在「含 boundary host 的最下行」——host 在中间行时 BE+label 落进行间距，
// 不需要 lane 底部再扩。host 都在上方行时返回 0 的调用方自然不加。
function applyBoundaryReserveToLastRow(
  rows: LaneRow[],
  boundaryHosts: ReadonlySet<string> | undefined,
  reserve: number,
): void {
  if (reserve <= 0 || !boundaryHosts) return;
  const last = rows[rows.length - 1]!;
  if (last.ids.some(id => boundaryHosts.has(id))) last.below += reserve;
}

// ── 纯串行长链 snake 折行（P6）────────────────────────────────────────────
// lane 成员恰为一条前向单链且单行宽高比超阈值时触发：蛇形拆行（奇数行链序从右往左排，
// 换行边垂直短接），lane 增高换宽度收敛。挂 boundary 的成员lane不走 snake（BE 净空与
// 行带逻辑暂不混排，等真实用例）。
const SNAKE_MIN_CHAIN = 7;       // 与 compactor 的 LONG_CHAIN_MIN_WRAP_NODES 同义
const SNAKE_MIN_ROW_NODES = 3;
const SNAKE_WRAP_ASPECT = 6;     // 触发阈值（≈ F4 的 6:1）
const SNAKE_TARGET_ASPECT = 4;   // 折后目标（CLAUDE.md F4 字面期望）
const SNAKE_X_GAP = 60;          // 行内节点 X 间距（≈ ELK nodeNode 同层距）

function detectSnakeRows(
  memberIds: string[],
  nodes: Map<string, NodeBox>,
  edges: LaneEdgeInfo[] | undefined,
  extents: Map<string, NodeVerticalExtent>,
  boundaryHosts: ReadonlySet<string> | undefined,
): string[][] | null {
  if (!edges || memberIds.length < SNAKE_MIN_CHAIN) return null;
  if (boundaryHosts && memberIds.some(id => boundaryHosts.has(id))) return null;
  const memberSet = new Set(memberIds);
  // 成员有指向 lane 外的边就不折：snake 会把跨 lane 连接点搬到任意行位（35 实测 F1/F2/F3
  // 全抖）。单 lane pool（71）无边外联不受影响。等真有「lane 内长链 + 少量外联」的
  // 好案例再放宽到「仅链首入/链尾出」。
  for (const e of edges) {
    if (memberSet.has(e.source) !== memberSet.has(e.target)) return null;
  }
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  const next = new Map<string, string>();
  for (const e of edges) {
    if (!memberSet.has(e.source) || !memberSet.has(e.target)) continue;
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
    outDeg.set(e.source, (outDeg.get(e.source) ?? 0) + 1);
    if (next.has(e.source)) return null; // 分叉 → 非纯链
    next.set(e.source, e.target);
  }
  let start: string | undefined;
  for (const id of memberIds) {
    if ((inDeg.get(id) ?? 0) > 1 || (outDeg.get(id) ?? 0) > 1) return null;
    if ((inDeg.get(id) ?? 0) === 0) {
      if (start !== undefined) return null;
      start = id;
    }
  }
  if (!start) return null;
  const order: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = start;
  while (cur) {
    if (seen.has(cur)) return null; // 环
    seen.add(cur);
    order.push(cur);
    cur = next.get(cur);
  }
  if (order.length !== memberIds.length) return null; // 链没盖住全部成员 → 折行会孤立游离节点

  let minX = Infinity;
  let maxX = -Infinity;
  let rowH = 0;
  for (const id of memberIds) {
    const b = nodes.get(id)!;
    minX = Math.min(minX, b.x);
    maxX = Math.max(maxX, b.x + b.w);
    const ex = extents.get(id)!;
    rowH = Math.max(rowH, ex.above + ex.below);
  }
  const contentW = maxX - minX;
  if (contentW / Math.max(rowH + LANE_PAD * 2, LANE_MIN_H) <= SNAKE_WRAP_ASPECT) return null;

  // 最小行数 k：折后宽高比 ≤ 目标即收（行高按多行度量的实际构成算）
  const maxRows = Math.max(2, Math.floor(order.length / SNAKE_MIN_ROW_NODES));
  let k = 2;
  while (k <= maxRows) {
    const rowSize = Math.ceil(order.length / k);
    let maxRowW = 0;
    for (let r = 0; r < k; r++) {
      const ids = order.slice(r * rowSize, (r + 1) * rowSize);
      if (ids.length === 0) continue;
      const w = ids.reduce((s, id) => s + nodes.get(id)!.w, 0) + (ids.length - 1) * SNAKE_X_GAP;
      if (w > maxRowW) maxRowW = w;
    }
    const hAfter = rowH + LANE_PAD * 2 + (k - 1) * LANE_ROW_GAP;
    if (maxRowW / hAfter <= SNAKE_TARGET_ASPECT) break;
    k++;
  }
  k = Math.min(k, maxRows);
  const rowSize = Math.ceil(order.length / k);
  const rows: string[][] = [];
  for (let r = 0; r < k; r++) {
    const ids = order.slice(r * rowSize, (r + 1) * rowSize);
    if (ids.length > 0) rows.push(ids);
  }
  return rows.length >= 2 ? rows : null;
}

function buildSnakeMetric(
  memberIds: string[],
  nodes: Map<string, NodeBox>,
  extents: Map<string, NodeVerticalExtent>,
  rows: string[][],
): LaneMetric {
  const metric = buildMultiRowMetric(rows.map(ids => makeRowFrom(ids, extents)));
  // X 重排（boustrophedon：奇数行链序从右往左排，使相邻行的换行边垂直短接）
  const contentLeft = Math.min(...memberIds.map(id => nodes.get(id)!.x));
  const nodeX = new Map<string, number>();
  rows.forEach((ids, r) => {
    const rowW = ids.reduce((s, id) => s + nodes.get(id)!.w, 0) + (ids.length - 1) * SNAKE_X_GAP;
    if (r % 2 === 0) {
      let cursor = contentLeft;
      for (const id of ids) {
        nodeX.set(id, cursor);
        cursor += nodes.get(id)!.w + SNAKE_X_GAP;
      }
    } else {
      let cursor = contentLeft + rowW;
      for (const id of ids) {
        cursor -= nodes.get(id)!.w;
        nodeX.set(id, cursor);
        cursor -= SNAKE_X_GAP;
      }
    }
  });
  const nodeRowDir = new Map<string, 1 | -1>();
  rows.forEach((ids, r) => {
    for (const id of ids) nodeRowDir.set(id, r % 2 === 0 ? 1 : -1);
  });
  return { ...metric, nodeX, nodeRowDir };
}

function resolveLaneOverlaps(outNodes: Map<string, NodeBox>, laneMembers: Map<string, string[]>): void {
  for (const ids of laneMembers.values()) {
    const ordered = ids.slice().sort((a, b) => outNodes.get(a)!.x - outNodes.get(b)!.x);
    for (let i = 0; i < ordered.length; i++) {
      const cur = outNodes.get(ordered[i]!)!;
      let minX = cur.x;
      for (let j = 0; j < i; j++) {
        const prev = outNodes.get(ordered[j]!)!;
        if (!overlapsY(prev, cur)) continue;
        minX = Math.max(minX, prev.x + prev.w + MIN_X_GAP);
      }
      if (cur.x < minX) cur.x = minX;
    }
  }
}

function centerY(box: NodeBox): number {
  return box.y + box.h / 2;
}

function overlapsY(a: NodeBox, b: NodeBox): boolean {
  return a.y < b.y + b.h && b.y < a.y + a.h;
}
