// LaneConstrainer
//
// 职责：把 Stage 1 给的节点 Y 重写为所属 lane 的中线 Y。X 完全不动。
//      算 leaf lane 的 Y band（top, bottom, centerY, height）一并输出。
//
// lane partitioning 只能作为 ELK hint，最终 Y band 仍由这里显式计算和 snap。

import type { FlowNodeType, Lane } from '../loader/types.ts';
import type { LaneBox, NodeBox } from './types.ts';
import { LANE_PAD, LANE_MIN_H, ioSpecExtraBelow, isGatewayType } from '../layout/node-sizes.ts';
import { allLaneOrder, leafLaneOrder, nodeToLeafLane } from '../layout/lane-resolver.ts';

export interface LaneNodeMeta {
  type: FlowNodeType;
  name?: string;
  ioInputCount?: number;
  ioOutputCount?: number;
}

export interface LaneEdgeInfo {
  source: string;
  target: string;
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
}

export interface LaneConstrainOutput {
  /** node id → 新 NodeBox（X 不变；Y snap 到所属 lane 中线） */
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
}

// 估算 label 文字会被换行成几行（与 serializer/diagram-builder 中的算法一致）
function estimateLabelLines(text: string, maxWidth: number): number {
  if (!text || maxWidth <= 0) return 1;
  let currentLineWidth = 0;
  let lines = 1;
  for (const ch of text) {
    const charWidth = ch.charCodeAt(0) > 255 ? 14 : 7;
    if (currentLineWidth + charWidth > maxWidth) {
      lines++;
      currentLineWidth = charWidth;
    } else {
      currentLineWidth += charWidth;
    }
  }
  return lines;
}

// diagram-builder 默认 label 宽度 = 100，行高 = 14，距离节点 = 4
const LABEL_W = 100;
const LABEL_LINE_H = 14;
const LABEL_NODE_GAP = 4;
// path-shaper 常量复刻：避障 margin + 边 label 的留空
const ARCH_CLEAR_MARGIN = 16;
const ARCH_BASE_OFFSET = 24;
const CHANNEL_GAP = 18;
const EDGE_LABEL_ABOVE_GAP = 5;

function isEventType(t: FlowNodeType): boolean {
  return t === 'startEvent' || t === 'endEvent'
    || t === 'intermediateCatchEvent' || t === 'intermediateThrowEvent';
}

export function laneConstrain(input: LaneConstrainInput): LaneConstrainOutput {
  const { nodes, lanes, width, nodeMeta, edges } = input;

  // 没有 lane 的 pool：原样返回，poolHeight 由节点决定。
  if (lanes.length === 0) {
    let poolHeight = input.height;
    if (poolHeight === undefined) {
      poolHeight = 0;
      for (const [nodeId, b] of nodes) {
        const meta = nodeMeta?.get(nodeId);
        poolHeight = Math.max(poolHeight, b.y + b.h + ioSpecExtraBelow(meta?.ioInputCount ?? 0, meta?.ioOutputCount ?? 0));
      }
    }
    return {
      nodes: new Map(nodes),
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
  const laneMetrics = new Map<string, { height: number; centerOffset: number }>();
  for (const laneId of leafOrder) {
    const memberIds: string[] = [];
    for (const [nodeId] of nodes) {
      if (nodeLeaf.get(nodeId) === laneId) memberIds.push(nodeId);
    }
    let above = 0;
    let below = 0;
    for (const id of memberIds) {
      const box = nodes.get(id)!;
      const meta = nodeMeta?.get(id);
      const hHalf = box.h / 2;
      // 默认上下各占一半 h
      let nodeAbove = hHalf;
      let nodeBelow = hHalf;
      if (meta?.name && meta.name.length > 0) {
        const lines = estimateLabelLines(meta.name, LABEL_W);
        const labelH = lines * LABEL_LINE_H;
        if (isGatewayType(meta.type)) {
          // gateway label 摆在节点上方
          nodeAbove = hHalf + LABEL_NODE_GAP + labelH;
        } else if (isEventType(meta.type)) {
          // event label 摆在节点下方
          nodeBelow = hHalf + LABEL_NODE_GAP + labelH;
        }
      }
      const ioBelow = ioSpecExtraBelow(meta?.ioInputCount ?? 0, meta?.ioOutputCount ?? 0);
      if (ioBelow > 0) nodeBelow = Math.max(nodeBelow, hHalf + ioBelow);
      above = Math.max(above, nodeAbove);
      below = Math.max(below, nodeBelow);
    }

    // forward-skip arch：source、target 都在本 lane，t.x > s.x，
    // 中间有"非 src/tgt"的成员节点 X 区间挡道 → 走 arch 上凸。
    // arch 顶点 y = obstacleTop - ARCH_CLEAR_MARGIN
    // 因为节点都 snap 到 laneCenter，相对 laneCenter：obstacleTop = -obstacle.h/2
    //   → arch 离 laneCenter = obstacle.h/2 + ARCH_CLEAR_MARGIN
    //   再加上 arch 上方的 edge label（默认 1 行 14 + 5 gap）
    //   多条 arch 共用同一 X 区间会按 channel 错峰，每多一条 + CHANNEL_GAP
    if (edges && edges.length > 0) {
      // 按 X 区间分桶找平行 arch
      const archesAbove: { left: number; right: number; obsMaxH: number }[] = [];
      const memberSet = new Set(memberIds);
      for (const e of edges) {
        if (!memberSet.has(e.source) || !memberSet.has(e.target)) continue;
        const s = nodes.get(e.source)!;
        const t = nodes.get(e.target)!;
        if (t.x <= s.x) continue; // back / loop 走 back-edge，不在这里处理
        const sRight = s.x + s.w;
        const tLeft = t.x;
        // 中间障碍：其他成员节点的 X 区间 [n.x, n.x+n.w] 与 [sRight, tLeft] 有交
        let obsMaxH = 0;
        for (const otherId of memberIds) {
          if (otherId === e.source || otherId === e.target) continue;
          const o = nodes.get(otherId)!;
          if (o.x + o.w <= sRight || o.x >= tLeft) continue;
          if (o.h > obsMaxH) obsMaxH = o.h;
        }
        if (obsMaxH === 0) continue;
        archesAbove.push({ left: sRight, right: tLeft, obsMaxH });
      }
      // 估算同一 X 区间内并行 arch 数（粗略：两个 arch X 区间相交即视为同 channel bucket）
      for (let i = 0; i < archesAbove.length; i++) {
        let parallel = 1;
        for (let j = 0; j < archesAbove.length; j++) {
          if (j === i) continue;
          const a = archesAbove[i]!, b = archesAbove[j]!;
          if (a.left < b.right && b.left < a.right) parallel++;
        }
        const a = archesAbove[i]!;
        const archAbove = a.obsMaxH / 2 + ARCH_CLEAR_MARGIN
          + Math.max(0, parallel - 1) * CHANNEL_GAP;
        const labelAbove = LABEL_LINE_H + EDGE_LABEL_ABOVE_GAP;
        const need = Math.max(ARCH_BASE_OFFSET, archAbove) + labelAbove;
        if (need > above) above = need;
      }
    }

    const contentH = above + below + LANE_PAD * 2;
    const h = Math.max(LANE_MIN_H, contentH);
    const extra = h - contentH;
    laneMetrics.set(laneId, {
      height: h,
      centerOffset: LANE_PAD + extra / 2 + above,
    });
  }

  // Lane Y band：从 y=0 顺序累加（仅叶子）
  const laneBoxes = new Map<string, LaneBox>();
  let cursorY = 0;
  for (const laneId of leafOrder) {
    const metrics = laneMetrics.get(laneId)!;
    const h = metrics.height;
    laneBoxes.set(laneId, {
      top: cursorY,
      bottom: cursorY + h,
      centerY: cursorY + metrics.centerOffset,
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

  // 节点 Y snap 到所属 lane 中线。无 lane 归属的节点（不应有，但保险）Y 不动。
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
    outNodes.set(nodeId, {
      x: box.x,
      y: band.centerY - box.h / 2,
      w: box.w,
      h: box.h,
    });
  }

  // Y snap 之后：ELK 把同一 lane 内的节点放在不同 Y（不同层），其 X 间距可能小于宽度
  // 之和。snap 到 lane 中线后，X 投影上互相重叠（破坏 N1）。这里按 lane 分组、按 X
  // 升序扫一遍，把右侧节点的 X 顺序推开，保证相邻节点 [x, x+w] 区间互不重叠。
  // 重叠是 ELK 没拿到 lane 信息的硬伤，必须早早检测、当场修复；不留给 EdgeRouter 兜底。
  const MIN_X_GAP = 30;
  const byLane = new Map<string, string[]>();
  for (const [nodeId, ] of outNodes) {
    const laneId = nodeLeaf.get(nodeId);
    if (!laneId) continue;
    if (!byLane.has(laneId)) byLane.set(laneId, []);
    byLane.get(laneId)!.push(nodeId);
  }
  for (const ids of byLane.values()) {
    ids.sort((a, b) => outNodes.get(a)!.x - outNodes.get(b)!.x);
    for (let i = 1; i < ids.length; i++) {
      const prev = outNodes.get(ids[i - 1]!)!;
      const cur = outNodes.get(ids[i]!)!;
      const minX = prev.x + prev.w + MIN_X_GAP;
      if (cur.x < minX) cur.x = minX;
    }
  }

  return {
    nodes: outNodes,
    laneBoxes,
    leafOrder,
    allLanes,
    poolHeight,
    poolWidth: width,
  };
}
