// ElkPlacement
//
// 职责：调 elkjs 摆位，拿到每个节点的 x/y/w/h（局部坐标）。
//      不关心 lane、不关心 pool 堆叠、不关心边。
//
// 输入：每个 process 内的节点 + 边的 source/target（用于让 ELK 算分层）
// 输出：每个 node id 的 {x, y, w, h} 局部坐标（pool 原点 0,0），+ bounds。
//      ELK 输出的 edges 直接丢弃，EdgeRouter 自己路由。

import { getElk } from '../layout/elk-singleton.ts';
import type { FlowNodeType } from '../loader/types.ts';
import type { ElkShape, NodeBox } from './types.ts';

export interface PlacementInputNode {
  id: string;
  type: FlowNodeType;
  w: number;
  h: number;
  /**
   * leaf lane index（0=最上 lane）。仅 hasLanes 时有意义。
   * 用于给 ELK 传 partitioning.partition hint，让 ELK 在 layer 排序与 crossing minimization 时
   * 把同 lane 的节点视作一组——减少跨 lane 的层间穿插。Y 仍由 LaneConstrainer 最终决定。
   */
  laneIndex?: number;
  /**
   * 'first' / 'last' 时把 layer constraint 传给 ELK，强制 start/end event 在最左/最右 layer。
   * 解 F1（主流方向一致）。
   */
  layerConstraint?: 'first' | 'last';
}

export interface PlacementInputEdge {
  id: string;
  source: string;
  target: string;
}

export interface PlacementInput {
  processId: string;
  nodes: PlacementInputNode[];
  edges: PlacementInputEdge[];
  /**
   * 是否有 lane（Stage 2 会 snap Y 到 lane 中线）。有 lane 时必须禁用 ELK 的长链 wrap —
   * 否则 ELK 会把链折到第二行，X 坐标错位；Stage 2 snap Y 后变成同一行节点 X 重叠。
   */
  hasLanes?: boolean;
  /**
   * 是否有 boundary event handler。handler 由 S5 摆到 host 下方，wrap 后第二行 task 会和
   * 第一行 task 的 handler 撞车，所以这种 pool 也禁用 wrap（13-boundary-events-all 场景）。
   */
  hasBoundaryHandlers?: boolean;
}

export interface PlacementOutput {
  processId: string;
  nodes: Map<string, NodeBox>;
  bounds: { width: number; height: number };
  /** M8 诊断快照：用于事后分析宽度构成 / 层结构。仅 trace 用，不影响坐标。 */
  shape: ElkShape;
}

const ELK_OPTIONS_BASE = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
  'elk.spacing.nodeNode': '60',
  'elk.spacing.componentComponent': '50',
  'elk.layered.spacing.nodeNodeBetweenLayers': '100',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.alignment': 'CENTER',
};

// 无 lane 的 pool：允许长链 wrap，避免画布超宽。
const ELK_OPTIONS_NO_LANE = {
  ...ELK_OPTIONS_BASE,
  // 4.0 让 4-8 节点单行链不 wrap，>15 节点的 13-boundary 才会折成 snake。
  'elk.aspectRatio': '4.0',
  'elk.layered.wrapping.strategy': 'MULTI_EDGE',
  'elk.layered.wrapping.additionalEdgeSpacing': '30',
};

// 有 lane 的 pool：禁用 wrap，aspectRatio 拉大让 ELK 别折行。
const ELK_OPTIONS_LANES = {
  ...ELK_OPTIONS_BASE,
  'elk.aspectRatio': '100.0',
  'elk.layered.wrapping.strategy': 'OFF',
};

// 有 boundary handler 的 pool：禁用 wrap，aspectRatio 适中。
// wrap 后第二行 task 会和第一行 task 的 handler 撞车（handler 由 S5 摆到 host 下方）。
const ELK_OPTIONS_HANDLERS = {
  ...ELK_OPTIONS_BASE,
  'elk.aspectRatio': '8.0',
  'elk.layered.wrapping.strategy': 'OFF',
};

export async function elkPlacement(input: PlacementInput): Promise<PlacementOutput> {
  if (input.nodes.length === 0) {
    return {
      processId: input.processId,
      nodes: new Map(),
      bounds: { width: 0, height: 0 },
      shape: emptyShape(input.processId),
    };
  }

  // 有 lane 时开 partitioning：每个节点带 partition=laneIndex 后，ELK 在 layer assignment 和
  // crossing minimization 时把同 partition 的节点视作一组——减少跨 lane 穿插，给 LaneConstrainer
  // 一个更好的 X 初值（减少其 X 重叠修复 hack 的触发次数）。Y 仍由 LaneConstrainer snap 到 lane 中线。
  //
  // ⚠️ partitioning 和 layerConstraint=FIRST/LAST 互斥：partitioning 强制 partition 顺序，
  // 一旦节点 X 在 partition i 但 i<max_partition，标 LAST 会要求它在最后一层 ↔ 与 partition>i
  // 的节点冲突。所以 lane pool 一旦开 partitioning 就不再加 FIRST/LAST；方向一致性由
  // partition 顺序自然保证（start 总在 partition 内的第一层）。
  const someHasLane = input.nodes.some(n => n.laneIndex !== undefined);
  const baseOptions = input.hasLanes
    ? ELK_OPTIONS_LANES
    : input.hasBoundaryHandlers
      ? ELK_OPTIONS_HANDLERS
      : ELK_OPTIONS_NO_LANE;
  const layoutOptions = someHasLane
    ? { ...baseOptions, 'elk.partitioning.activate': 'true' }
    : baseOptions;

  const elkGraph = {
    id: input.processId || 'root',
    layoutOptions,
    children: input.nodes.map(n => {
      const childLayoutOptions: Record<string, string> = {};
      if (n.laneIndex !== undefined) {
        childLayoutOptions['elk.partitioning.partition'] = String(n.laneIndex);
      }
      // 只在未启用 partitioning 的 graph 加 layerConstraint
      if (!someHasLane) {
        if (n.layerConstraint === 'first') {
          childLayoutOptions['elk.layered.layering.layerConstraint'] = 'FIRST';
        } else if (n.layerConstraint === 'last') {
          childLayoutOptions['elk.layered.layering.layerConstraint'] = 'LAST';
        }
      }
      const child: any = { id: n.id, width: n.w, height: n.h };
      if (Object.keys(childLayoutOptions).length > 0) {
        child.layoutOptions = childLayoutOptions;
      }
      return child;
    }),
    edges: input.edges.map(e => ({
      id: e.id,
      sources: [e.source],
      targets: [e.target],
    })),
  };

  const result = await getElk().layout(elkGraph as any);

  const nodes = new Map<string, NodeBox>();
  for (const c of result.children ?? []) {
    nodes.set(c.id, {
      x: c.x ?? 0,
      y: c.y ?? 0,
      w: c.width ?? 0,
      h: c.height ?? 0,
    });
  }

  const bounds = {
    width: result.width ?? 0,
    height: result.height ?? 0,
  };
  const shape = computeShape(input, nodes, bounds);

  return {
    processId: input.processId,
    nodes,
    bounds,
    shape,
  };
}

function emptyShape(processId: string): ElkShape {
  return {
    processId,
    layerCount: 0,
    perLayerNodeCount: [],
    perLayerMaxNodeWidth: [],
    maxFanOut: 0,
    totalWidth: 0,
    totalHeight: 0,
    nodeWidthSum: 0,
    spacingWidth: 0,
    nodeCount: 0,
  };
}

/**
 * 从 ELK 输出节点位置反推 layer 结构：ELK layered direction=RIGHT 时，同一 layer 节点
 * 的左 X 相同（容差 1px）。fan-out 来自输入 edges 的 source 出度。
 *
 * 仅用于诊断；不影响坐标。
 */
function computeShape(
  input: PlacementInput,
  nodes: Map<string, NodeBox>,
  bounds: { width: number; height: number },
): ElkShape {
  // 按 X 分桶（容差 1px）
  const buckets: Array<{ x: number; nodes: NodeBox[] }> = [];
  const tol = 1;
  for (const box of nodes.values()) {
    const found = buckets.find(b => Math.abs(b.x - box.x) <= tol);
    if (found) found.nodes.push(box);
    else buckets.push({ x: box.x, nodes: [box] });
  }
  buckets.sort((a, b) => a.x - b.x);
  const perLayerNodeCount = buckets.map(b => b.nodes.length);
  const perLayerMaxNodeWidth = buckets.map(b => Math.max(0, ...b.nodes.map(n => n.w)));
  const nodeWidthSum = perLayerMaxNodeWidth.reduce((s, w) => s + w, 0);

  // fan-out（出度）
  const outDeg = new Map<string, number>();
  for (const e of input.edges) outDeg.set(e.source, (outDeg.get(e.source) ?? 0) + 1);
  let maxFanOut = 0;
  for (const v of outDeg.values()) if (v > maxFanOut) maxFanOut = v;

  return {
    processId: input.processId,
    layerCount: buckets.length,
    perLayerNodeCount,
    perLayerMaxNodeWidth,
    maxFanOut,
    totalWidth: bounds.width,
    totalHeight: bounds.height,
    nodeWidthSum,
    spacingWidth: Math.max(0, bounds.width - nodeWidthSum),
    nodeCount: nodes.size,
  };
}
