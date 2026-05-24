// LaneConstrainer
//
// 职责：把 Stage 1 给的节点 Y 重写进所属 lane。简单 lane 居中；分支 lane 保留多行。
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
  ioInputNames?: readonly string[];
  ioOutputNames?: readonly string[];
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
const MULTI_ROW_CENTER_GAP = 90;
const MULTI_ROW_MIN_MEMBERS = 3;
const LANE_ROW_GAP = 56;
const MIN_X_GAP = 30;

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
        poolHeight = Math.max(poolHeight, b.y + b.h + ioSpecExtraBelow(
          meta?.ioInputCount ?? 0,
          meta?.ioOutputCount ?? 0,
          meta?.ioInputNames,
          meta?.ioOutputNames,
          b.w,
        ));
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
  const laneMembers = new Map<string, string[]>();
  for (const laneId of leafOrder) {
    const memberIds: string[] = [];
    for (const [nodeId] of nodes) {
      if (nodeLeaf.get(nodeId) === laneId) memberIds.push(nodeId);
    }
    laneMembers.set(laneId, memberIds);
  }

  const laneMetrics = new Map<string, LaneMetric>();
  for (const laneId of leafOrder) {
    const memberIds = laneMembers.get(laneId) ?? [];
    laneMetrics.set(laneId, buildLaneMetric(memberIds, nodes, nodeMeta, edges));
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
      x: box.x,
      y: band.top + rowCenter - box.h / 2,
      w: box.w,
      h: box.h,
    });
  }

  resolveLaneOverlaps(outNodes, laneMembers);

  return {
    nodes: outNodes,
    laneBoxes,
    leafOrder,
    allLanes,
    poolHeight,
    poolWidth: width,
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
}

function buildLaneMetric(
  memberIds: string[],
  nodes: Map<string, NodeBox>,
  nodeMeta: Map<string, LaneNodeMeta> | undefined,
  edges: LaneEdgeInfo[] | undefined,
): LaneMetric {
  if (memberIds.length === 0) {
    return { height: LANE_MIN_H, centerOffset: LANE_MIN_H / 2, nodeCenterOffset: new Map() };
  }

  const extents = new Map<string, NodeVerticalExtent>();
  for (const id of memberIds) {
    extents.set(id, nodeVerticalExtent(nodes.get(id)!, nodeMeta?.get(id)));
  }

  const rows = groupLaneRows(memberIds, nodes, extents);
  const archReserveAbove = estimateForwardArchReserveAbove(memberIds, nodes, edges);
  if (rows[0]) rows[0].above = Math.max(rows[0].above, archReserveAbove);

  const shouldKeepRows = rows.length > 1 && memberIds.length >= MULTI_ROW_MIN_MEMBERS;
  return shouldKeepRows
    ? buildMultiRowMetric(rows)
    : buildFlatMetric(memberIds, extents, archReserveAbove);
}

function nodeVerticalExtent(box: NodeBox, meta: LaneNodeMeta | undefined): NodeVerticalExtent {
  const hHalf = box.h / 2;
  let above = hHalf;
  let below = hHalf;
  if (meta?.name && meta.name.length > 0) {
    const lines = estimateLabelLines(meta.name, LABEL_W);
    const labelH = lines * LABEL_LINE_H;
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
  archReserveAbove: number,
): LaneMetric {
  let above = archReserveAbove;
  let below = 0;
  for (const id of memberIds) {
    const extent = extents.get(id)!;
    above = Math.max(above, extent.above);
    below = Math.max(below, extent.below);
  }
  const contentH = above + below + LANE_PAD * 2;
  const h = Math.max(LANE_MIN_H, contentH);
  const extra = h - contentH;
  const rowCenter = LANE_PAD + extra / 2 + above;
  const nodeCenterOffset = new Map<string, number>();
  for (const id of memberIds) nodeCenterOffset.set(id, rowCenter);
  return { height: h, centerOffset: rowCenter, nodeCenterOffset };
}

function estimateForwardArchReserveAbove(
  memberIds: string[],
  nodes: Map<string, NodeBox>,
  edges: LaneEdgeInfo[] | undefined,
): number {
  if (!edges || edges.length === 0) return 0;
  const archesAbove: { left: number; right: number; obsMaxH: number }[] = [];
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
    archesAbove.push({ left: sRight, right: tLeft, obsMaxH });
  }

  let reserve = 0;
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
    if (need > reserve) reserve = need;
  }
  return reserve;
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
