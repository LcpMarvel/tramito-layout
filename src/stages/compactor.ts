// Compactor (B2 — yFiles hierarchic.compactionStrategy 的低保真等价)
//
// 在 LaneConstrainer 之后、PoolComposer 之前跑：对每个 pool 内的节点 X 坐标做一次
// "水平压缩"。Y、lane 边界、节点 W/H 全部不动；只把"明显冗余"的层间空白收紧。
//
// 算法（保守版，O(n log n)）：
//   1. 按 X 中心把节点聚成"列"（cx 容差 LAYER_EPS）
//   2. 相邻列的实际间距 = min(右列节点.left) - max(左列节点.right)
//   3. 若该间距 > NORMAL_LAYER_GAP，把右列及之后所有列整体左移到 NORMAL_LAYER_GAP
//
// 为什么不更激进：
//   - 不动 Y 保护 lane-constrainer 的输出（lane 中线还要承担 edge 路由的端点）
//   - 不跨 lane 独立做：lane 内最大 X 间距通常都来自层间，按 pool 整体收紧一致
//   - 跳过 boundary-handler 行：handler 在 host 下方独立子图，列分布跟主流不一致
//
// 触发条件：仅当 pool 内最大列间距 > NORMAL_LAYER_GAP 时启动；否则节省一次扫描。

import type { NodeBox } from './types.ts';
import type { FlowNodeType } from '../loader/types.ts';
import { HANDLER_VERTICAL_GAP } from './bpmn-rules.ts';

export interface CompactInput {
  /** 主流节点（不含 boundary event / handler subgraph 节点） */
  nodes: Map<string, NodeBox>;
  /** 同 pool 内主流 sequenceFlow；用于识别可安全折行的纯单链 */
  edges?: Array<{ source: string; target: string; id?: string }>;
  nodeMeta?: Map<string, { type: FlowNodeType }>;
  /** boundary handler 场景禁用了 ELK wrap，这里只对纯单链补一个保守折行 */
  wrapLinearChain?: boolean;
  /** 语义回边（BackEdgeResolver 判定）：折行判链时视为不存在——
   *  「单链 + 回边」的结构（49 的终检驳回）回边交给 router 正常走拱/走廊，
   *  链本体照样能折；不剔除时 outDeg>1 会让 linearOrder 直接弃权。 */
  backEdgeIds?: ReadonlySet<string>;
  /** subprocess 容器 → 内部 children id 集合。子流程作为整体平移（保持内部相对位置） */
  containerChildren?: Map<string, Set<string>>;
}

export interface CompactOutput {
  nodes: Map<string, NodeBox>;
  /** 实际压缩了多少像素（>0 才说明有改动）。给 trace 用，便于回归排查 */
  trimmedPx: number;
}

const LAYER_EPS = 10;          // 同列容差：cx 差 ≤ 10 视为同列
const NORMAL_LAYER_GAP = 80;   // 期望层间距（ELK 默认 layered.spacing.nodeNodeBetweenLayers=100，留点呼吸）
const TERMINAL_ADJACENCY_GAP = 30;
const LONG_CHAIN_ROW_GAP = HANDLER_VERTICAL_GAP + 180;
// 单行链宽高比超过该值才折行（与 check:layout F4 的 6:1 阈值对齐，留一点余量），
// 折行后目标宽高比 ≤ 4（CLAUDE.md F4 的字面期望）。
const LONG_CHAIN_WRAP_ASPECT = 6;
const LONG_CHAIN_TARGET_ASPECT = 4;
const LONG_CHAIN_MIN_ROW_NODES = 3;
// 纯像素宽高比对短链失真：单行链高度只有一个节点行（~80px），4 节点链 600/80=7.5 也会
// 触发折行，把 01-simple-process 这种最基础直链折出 back edge（F1/F3 回归 + 05/06 E2）。
// 折行只为治「长链」（feedback Problem 2 的 ~20 节点链）；7 取自 09-multiinstance（需要折）
// 与 05-artifacts（不能折，5 节点）之间。
const LONG_CHAIN_MIN_WRAP_NODES = 7;
// 「胖成员链」豁免节点数门槛：74 的 start + 3 个 subprocess + end 只有 5 个节点，
// 但单行 2100px 已经很笨重——问题不是链长而是行宽。绝对宽度门槛让短链照常单排
// （55 的 1440px 不折），只有明确过宽的链才折（≥ 4 节点保证 2+2 起步的行结构）。
const LONG_CHAIN_WRAP_MIN_WIDTH = 1600;
const FAT_CHAIN_MIN_WRAP_NODES = 4;
// 胖成员链的折行触发比长链更严：compactor 量的是节点 bbox（不含 pool 边框 padding），
// evaluator 的 F4 量的是含 pool 框的画布——73 这种 6.5 的刚好「compactor 超线、
// evaluator 本来及格」，折了反而出拱线绕顶。7 = 6 + pool padding 的保守余量。
const FAT_CHAIN_WRAP_ASPECT = 7;

export function compact(input: CompactInput): CompactOutput {
  if (input.nodes.size <= 1) {
    return { nodes: new Map(input.nodes), trimmedPx: 0 };
  }

  // 1) 按 cx 排序、聚列
  const entries = Array.from(input.nodes.entries());
  entries.sort(([, a], [, b]) => (a.x + a.w / 2) - (b.x + b.w / 2));

  type Column = { cx: number; ids: string[]; minLeft: number; maxRight: number };
  const columns: Column[] = [];
  for (const [id, box] of entries) {
    const cx = box.x + box.w / 2;
    const last = columns[columns.length - 1];
    if (last && Math.abs(cx - last.cx) <= LAYER_EPS) {
      last.ids.push(id);
      last.minLeft = Math.min(last.minLeft, box.x);
      last.maxRight = Math.max(last.maxRight, box.x + box.w);
      last.cx = (last.cx * (last.ids.length - 1) + cx) / last.ids.length;
    } else {
      columns.push({ cx, ids: [id], minLeft: box.x, maxRight: box.x + box.w });
    }
  }
  if (columns.length < 2) return { nodes: new Map(input.nodes), trimmedPx: 0 };

  // 2) 找最大间距判断是否值得压缩
  let maxGap = 0;
  for (let i = 1; i < columns.length; i++) {
    const gap = columns[i]!.minLeft - columns[i - 1]!.maxRight;
    if (gap > maxGap) maxGap = gap;
  }
  if (maxGap <= NORMAL_LAYER_GAP && !input.wrapLinearChain) {
    const reordered = reorderAdjacentTerminalEvents(new Map(input.nodes), input.edges ?? [], input.nodeMeta);
    return { nodes: reordered.nodes, trimmedPx: reordered.changed ? 1 : 0 };
  }

  // 3) 从左到右压缩：保持每列相对左邻最大间距 ≤ NORMAL_LAYER_GAP
  // 注意 subprocess container 的 X 范围可能横跨多列（其内部子节点在外层 ElkPlacement 里
  // 视为单个大节点参与 layout，所以 container 不会出现在 input.nodes 里跨列；这里不用特别处理）。
  const shifts = new Map<string, number>(); // node id → 累计左移量
  let cumulativeShift = 0;
  for (let i = 1; i < columns.length; i++) {
    const prev = columns[i - 1]!;
    const cur = columns[i]!;
    const actualGap = cur.minLeft - prev.maxRight;
    if (actualGap > NORMAL_LAYER_GAP) {
      const delta = actualGap - NORMAL_LAYER_GAP;
      cumulativeShift += delta;
    }
    if (cumulativeShift > 0) {
      for (const id of cur.ids) shifts.set(id, cumulativeShift);
    }
  }

  // 4) 应用 shift
  const out = new Map<string, NodeBox>();
  for (const [id, box] of input.nodes) {
    const dx = shifts.get(id) ?? 0;
    out.set(id, { x: box.x - dx, y: box.y, w: box.w, h: box.h });
  }

  const reordered = reorderAdjacentTerminalEvents(out, input.edges ?? [], input.nodeMeta);
  const compactedOut = reordered.nodes;

  const wrapped = input.wrapLinearChain
    ? wrapLongLinearChain(compactedOut, input.edges ?? [], input.backEdgeIds)
    : null;
  if (wrapped) {
    const beforeRight = maxRight(input.nodes);
    const afterRight = maxRight(wrapped);
    return { nodes: wrapped, trimmedPx: Math.max(cumulativeShift, beforeRight - afterRight, 1) };
  }

  if (shifts.size === 0 && !reordered.changed) return { nodes: new Map(input.nodes), trimmedPx: 0 };
  return { nodes: compactedOut, trimmedPx: Math.max(cumulativeShift, reordered.changed ? 1 : 0) };
}

function reorderAdjacentTerminalEvents(
  nodes: Map<string, NodeBox>,
  edges: Array<{ source: string; target: string }>,
  nodeMeta?: Map<string, { type: FlowNodeType }>,
): { nodes: Map<string, NodeBox>; changed: boolean } {
  if (!nodeMeta || edges.length === 0 || nodes.size < 3) {
    return { nodes, changed: false };
  }

  const rows = groupRows(nodes);
  let changed = false;
  const out = new Map(nodes);

  for (const rowIds of rows) {
    let ordered = rowIds.slice().sort((a, b) => out.get(a)!.x - out.get(b)!.x);
    const originalLefts = ordered.map(id => out.get(id)!.x);
    let rowChanged = false;

    for (const edge of edges) {
      if (nodeMeta.get(edge.target)?.type !== 'endEvent') continue;
      const sourceIdx = ordered.indexOf(edge.source);
      const targetIdx = ordered.indexOf(edge.target);
      if (sourceIdx < 0 || targetIdx < 0 || targetIdx <= sourceIdx + 1) continue;
      const intervening = ordered.slice(sourceIdx + 1, targetIdx);
      if (!intervening.every(id => nodeMeta.get(id)?.type === 'endEvent')) continue;

      ordered = ordered.filter(id => id !== edge.target);
      const insertAfter = ordered.indexOf(edge.source);
      ordered.splice(insertAfter + 1, 0, edge.target);
      rowChanged = true;
    }

    if (!rowChanged) continue;
    changed = true;
    let prevRight = -Infinity;
    for (let i = 0; i < ordered.length; i++) {
      const id = ordered[i]!;
      const box = out.get(id)!;
      const desiredX = originalLefts[i]!;
      const x = i === 0 ? desiredX : Math.max(desiredX, prevRight + TERMINAL_ADJACENCY_GAP);
      out.set(id, { ...box, x });
      prevRight = x + box.w;
    }
  }

  return { nodes: out, changed };
}

function groupRows(nodes: Map<string, NodeBox>): string[][] {
  const ROW_EPS = 4;
  const rows: Array<{ cy: number; ids: string[] }> = [];
  for (const [id, box] of nodes) {
    const cy = box.y + box.h / 2;
    const row = rows.find(r => Math.abs(r.cy - cy) <= ROW_EPS);
    if (row) {
      row.ids.push(id);
      row.cy = (row.cy * (row.ids.length - 1) + cy) / row.ids.length;
    } else {
      rows.push({ cy, ids: [id] });
    }
  }
  return rows.map(r => r.ids);
}

function wrapLongLinearChain(
  nodes: Map<string, NodeBox>,
  edges: Array<{ source: string; target: string }>,
  backEdgeIds?: ReadonlySet<string>,
): Map<string, NodeBox> | null {
  const order = linearOrder(nodes, edges, backEdgeIds);
  if (!order) return null;

  // 宽高比驱动：单行摆得下（≤ 6:1）就不折；要折则选能把宽高比压到 ≤ 4 的最小行数。
  const boxes = Array.from(nodes.values());
  const singleW = Math.max(...boxes.map(b => b.x + b.w)) - Math.min(...boxes.map(b => b.x));
  const singleH = Math.max(...boxes.map(b => b.y + b.h)) - Math.min(...boxes.map(b => b.y));
  if (singleH <= 0) return null;
  const singleAspect = singleW / singleH;
  // 门槛二选一：节点数够（长链，aspect > 6）或单行绝对宽度够宽（胖成员链，aspect > 7）
  const isLongChain = order.length >= LONG_CHAIN_MIN_WRAP_NODES && singleAspect > LONG_CHAIN_WRAP_ASPECT;
  const isFatChain = order.length >= FAT_CHAIN_MIN_WRAP_NODES
    && singleW > LONG_CHAIN_WRAP_MIN_WIDTH
    && singleAspect > FAT_CHAIN_WRAP_ASPECT;
  if (!isLongChain && !isFatChain) return null;

  let rowCount = 2;
  const maxRows = Math.max(2, Math.floor(order.length / LONG_CHAIN_MIN_ROW_NODES));
  while (
    rowCount < maxRows
    && (singleW / rowCount) / (rowCount * LONG_CHAIN_ROW_GAP) > LONG_CHAIN_TARGET_ASPECT
  ) {
    rowCount++;
  }
  if (rowCount < 2) return null;
  const rowSize = Math.ceil(order.length / rowCount);

  const baseX = Math.min(...Array.from(nodes.values()).map(b => b.x));
  const baseY = Math.min(...Array.from(nodes.values()).map(b => b.y));
  const out = new Map(nodes);

  for (let row = 0; row < rowCount; row++) {
    const rowIds = order.slice(row * rowSize, (row + 1) * rowSize);
    if (rowIds.length === 0) continue;
    const rowHeight = Math.max(...rowIds.map(id => nodes.get(id)!.h));
    const centerY = baseY + row * LONG_CHAIN_ROW_GAP + rowHeight / 2;
    let cursorX = baseX;
    for (const id of rowIds) {
      const box = nodes.get(id)!;
      out.set(id, {
        x: cursorX,
        y: centerY - box.h / 2,
        w: box.w,
        h: box.h,
      });
      cursorX += box.w + NORMAL_LAYER_GAP;
    }
  }

  return out;
}

function linearOrder(
  nodes: Map<string, NodeBox>,
  edges: Array<{ source: string; target: string; id?: string }>,
  backEdgeIds?: ReadonlySet<string>,
): string[] | null {
  const nodeIds = new Set(nodes.keys());
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  const next = new Map<string, string>();

  for (const edge of edges) {
    if (edge.id !== undefined && backEdgeIds?.has(edge.id)) continue; // 语义回边不参与判链
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    inDeg.set(edge.target, (inDeg.get(edge.target) ?? 0) + 1);
    outDeg.set(edge.source, (outDeg.get(edge.source) ?? 0) + 1);
    if (next.has(edge.source)) return null;
    next.set(edge.source, edge.target);
  }

  let start: string | undefined;
  for (const id of nodeIds) {
    const inCount = inDeg.get(id) ?? 0;
    const outCount = outDeg.get(id) ?? 0;
    if (inCount > 1 || outCount > 1) return null;
    if (inCount === 0) {
      if (start !== undefined) return null;
      start = id;
    }
  }
  if (!start) return null;

  const order: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = start;
  while (current) {
    if (seen.has(current)) return null;
    seen.add(current);
    order.push(current);
    current = next.get(current);
  }

  return order.length === nodes.size ? order : null;
}

function maxRight(nodes: Map<string, NodeBox>): number {
  return Math.max(...Array.from(nodes.values()).map(b => b.x + b.w), 0);
}
