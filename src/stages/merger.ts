// Merger
//
// 把 stages 1-5 的输出写回 ELK-BPMN JSON。所有节点坐标按**immediate parent 的相对坐标**写
// （diagram-builder 会按 container 链累加 offset 还原绝对坐标）。Edges 用绝对坐标 +
// `_absoluteCoords: true` 标记，让 diagram-builder 跳过 source 节点的容器 offset。
//
// 容器层级：collaboration → participant → (optional inner process) → (optional lane[nested])* → flow node

import type { LayoutedGraph } from '../serializer/types/elk-output.ts';
import type { NodeBox, EdgeRoute, LabelBox, LabelObstacle, LaneBox, PoolBox, Rect, Waypoint } from './types.ts';
import { POOL_HEADER_W } from '../layout/node-sizes.ts';
import { pickLabelPosition } from './label-placer.ts';

export interface MergeInput {
  raw: any;
  /** 所有 flow node 的绝对坐标（含 boundary event） */
  nodes: Map<string, NodeBox>;
  boundaryEventBoxes: Map<string, NodeBox>;
  poolBoxes: Map<string, PoolBox & { name: string; isBlackBox: boolean }>;
  laneBoxes: Map<string, LaneBox & { poolId: string }>;
  routes: Map<string, EdgeRoute>;
  totalBounds: { width: number; height: number };
}

export function merge(input: MergeInput): LayoutedGraph {
  const out = structuredClone(input.raw) as any;
  out.x = 0;
  out.y = 0;
  out.width = input.totalBounds.width;
  out.height = input.totalBounds.height;

  const allNodes = new Map<string, NodeBox>(input.nodes);
  for (const [id, b] of input.boundaryEventBoxes) allNodes.set(id, b);
  const bpmnInfo = new Map<string, BpmnInfo>();
  collectBpmnInfo(out, bpmnInfo);
  const labelContext: MergeLabelContext = {
    placedLabels: [],
    nodeObstacles: collectLabelNodeObstacles(bpmnInfo, allNodes),
    bpmnInfo,
  };

  for (const top of out.children ?? []) {
    const ttype = top?.bpmn?.type;
    if (ttype === 'collaboration') {
      top.x = 0;
      top.y = 0;
      top.width = input.totalBounds.width;
      top.height = input.totalBounds.height;
      for (const part of top.children ?? []) applyParticipant(part, input, allNodes, labelContext);
      for (const e of top.edges ?? []) writeEdgeSection(e, input.routes, allNodes, labelContext);
    } else if (ttype === 'process') {
      const pb = input.poolBoxes.get(top.id);
      if (!pb) continue;
      top.x = pb.x; top.y = pb.y; top.width = pb.w; top.height = pb.h;
      // 顶层 process 里直接的 children
      const baseAbsX = pb.x, baseAbsY = pb.y;
      for (const child of top.children ?? []) writeChild(child, input, allNodes, baseAbsX, baseAbsY, pb.w, /*isLaneParent*/ false);
      for (const e of top.edges ?? []) writeEdgeSection(e, input.routes, allNodes, labelContext);
    }
  }

  // 展开 subprocess 内部 edges：递归遍历整个树
  for (const top of out.children ?? []) writeInnerEdgesRecursive(top, input.routes, allNodes, labelContext);

  return out as LayoutedGraph;
}

function applyParticipant(
  part: any,
  input: MergeInput,
  allNodes: Map<string, NodeBox>,
  labelContext: MergeLabelContext,
) {
  const pb = input.poolBoxes.get(part.id);
  if (!pb) return;
  part.x = pb.x;
  part.y = pb.y;
  part.width = pb.w;
  part.height = pb.h;

  if (part.bpmn?.isBlackBox) return;

  // participant 内可能直接是 lanes/flowNodes，也可能是 process node 再包一层
  let bodyContainer = part;
  let bodyBaseAbsX = pb.x;
  let bodyBaseAbsY = pb.y;

  if (Array.isArray(part.children) && part.children.length === 1 && part.children[0]?.bpmn?.type === 'process') {
    const proc = part.children[0];
    proc.x = 0;
    proc.y = 0;
    proc.width = pb.w;
    proc.height = pb.h;
    bodyContainer = proc;
    // process 这一层 absolute = participant 位置 + process(0,0)
    bodyBaseAbsX = pb.x + 0;
    bodyBaseAbsY = pb.y + 0;
  }

  for (const child of bodyContainer.children ?? []) writeChild(child, input, allNodes, bodyBaseAbsX, bodyBaseAbsY, pb.w, /*isLaneParent*/ false);
  for (const e of bodyContainer.edges ?? []) writeEdgeSection(e, input.routes, allNodes, labelContext);
}

// child 可以是 lane（容器）或 flow node（叶子）
// baseAbsX/Y = 当前容器（participant/process/lane）的绝对左上角
// containerW = 当前容器的内宽（child lane 可填多少宽度）
function writeChild(
  child: any, input: MergeInput, allNodes: Map<string, NodeBox>,
  baseAbsX: number, baseAbsY: number, containerW: number, isLaneParent: boolean,
) {
  if (!child?.bpmn) return;
  if (child.bpmn.type === 'lane') {
    writeLane(child, input, allNodes, baseAbsX, baseAbsY, containerW, isLaneParent);
  } else {
    writeFlowNode(child, allNodes, baseAbsX, baseAbsY);
  }
}

// 子 lane 缩进宽度。父 lane 的 header strip 占 LANE_HEADER_W；子 lane 缩进同样宽度。
const LANE_HEADER_W = 30;

function writeLane(
  lane: any, input: MergeInput, allNodes: Map<string, NodeBox>,
  baseAbsX: number, baseAbsY: number, containerW: number, isLaneParent: boolean,
) {
  const lb = input.laneBoxes.get(lane.id);
  if (!lb) return;
  // 顶层 lane（父是 pool/process）：x=POOL_HEADER_W，让出 pool 左侧 header 给 pool 名字
  // 子 lane（父是另一个 lane）：x=LANE_HEADER_W（让出父 lane 的 header strip）
  const localX = isLaneParent ? LANE_HEADER_W : POOL_HEADER_W;
  const ownW = isLaneParent ? containerW - LANE_HEADER_W : containerW - POOL_HEADER_W;
  lane.x = localX;
  lane.y = lb.top - baseAbsY;
  lane.width = ownW;
  lane.height = lb.height;
  // 嵌套 children
  const laneAbsX = baseAbsX + lane.x;
  const laneAbsY = baseAbsY + lane.y;
  for (const c of lane.children ?? []) writeChild(c, input, allNodes, laneAbsX, laneAbsY, ownW, /*isLaneParent*/ true);
}

function writeFlowNode(node: any, allNodes: Map<string, NodeBox>, baseAbsX: number, baseAbsY: number) {
  const box = allNodes.get(node.id);
  if (box) {
    node.x = box.x - baseAbsX;
    node.y = box.y - baseAbsY;
    node.width = box.w;
    node.height = box.h;
  }
  // boundary events 挂在 node 上；它们的 attachedToRef = node.id
  if (Array.isArray(node.boundaryEvents)) {
    const placedBoundaryLabels: LabelBox[] = [];
    for (const be of node.boundaryEvents) {
      const beBox = allNodes.get(be.id);
      if (beBox) {
        be.x = beBox.x;
        be.y = beBox.y;
        be.width = beBox.w;
        be.height = beBox.h;
        placeBoundaryEventLabel(be, beBox, placedBoundaryLabels);
      }
    }
  }
  // Subprocess：isExpanded=true 时递归 layout 内部 children/edges；否则折叠。
  const isSub = node?.bpmn?.type === 'subProcess'
    || node?.bpmn?.type === 'transaction'
    || node?.bpmn?.type === 'adHocSubProcess'
    || node?.bpmn?.type === 'eventSubProcess';
  if (isSub) {
    const expanded = node?.bpmn?.isExpanded === true;
    if (!expanded) {
      delete node.children;
      delete node.edges;
      return;
    }
    // 展开：内部 children 的 baseAbs = 这个 subprocess 的左上角
    if (box) {
      const childBaseX = box.x;
      const childBaseY = box.y;
      for (const child of node.children ?? []) {
        if (child?.bpmn?.type === 'lane') continue; // subprocess 内不应有 lane
        writeFlowNode(child, allNodes, childBaseX, childBaseY);
      }
    }
    // 内部 edges：routes 已包含；调用方在 merge() 顶层会统一写
  }
}

function writeInnerEdgesRecursive(
  node: any,
  routes: Map<string, EdgeRoute>,
  allNodes: Map<string, NodeBox>,
  labelContext: MergeLabelContext,
) {
  if (!node) return;
  for (const e of node.edges ?? []) writeEdgeSection(e, routes, allNodes, labelContext);
  for (const child of node.children ?? []) writeInnerEdgesRecursive(child, routes, allNodes, labelContext);
}

function writeEdgeSection(
  edge: any,
  routes: Map<string, EdgeRoute>,
  allNodes: Map<string, NodeBox>,
  labelContext: MergeLabelContext,
) {
  const route = routes.get(edge.id);
  if (!route || route.waypoints.length < 2) return;
  assertRoutePortsMatchWaypoints(route);
  const wp = route.waypoints;
  edge.sections = [{
    id: `${edge.id}_section`,
    startPoint: { x: wp[0]!.x, y: wp[0]!.y },
    endPoint: { x: wp[wp.length - 1]!.x, y: wp[wp.length - 1]!.y },
    bendPoints: wp.slice(1, -1).map(p => ({ x: p.x, y: p.y })),
  }];
  edge._absoluteCoords = true;
  placeEdgeLabel(edge, wp, allNodes, labelContext);
}

interface MergeLabelContext {
  placedLabels: LabelBox[];
  nodeObstacles: LabelObstacle[];
  bpmnInfo: Map<string, BpmnInfo>;
}

function placeEdgeLabel(
  edge: any,
  waypoints: Waypoint[],
  allNodes: Map<string, NodeBox>,
  ctx: MergeLabelContext,
): void {
  const label = edge.labels?.[0];
  if (!label) return;
  if (label.x !== undefined && label.y !== undefined) return;

  const sourceId = edge.sources?.[0];
  const targetId = edge.targets?.[0];
  const labelWidth = label.width ?? 50;
  const labelHeight = label.height ?? 14;
  const sourceBox = sourceId ? toNodeRect(allNodes.get(sourceId)) : undefined;
  const targetBox = targetId ? toNodeRect(allNodes.get(targetId)) : undefined;
  const pos = pickLabelPosition(waypoints, labelWidth, labelHeight, {
    placedLabels: ctx.placedLabels,
    nodeObstacles: ctx.nodeObstacles,
    sourceBox,
    targetBox,
  });
  label.x = pos.x;
  label.y = pos.y;
  label.width = labelWidth;
  label.height = labelHeight;
  ctx.placedLabels.push({ x: pos.x, y: pos.y, width: labelWidth, height: labelHeight });
}

type BpmnInfo = { type?: string; isExpanded?: boolean };

function collectLabelNodeObstacles(info: Map<string, BpmnInfo>, allNodes: Map<string, NodeBox>): LabelObstacle[] {
  const obstacles: LabelObstacle[] = [];
  for (const [id, box] of allNodes) {
    const bpmnInfo = info.get(id);
    const type = bpmnInfo?.type;
    if (type === 'participant' || type === 'process' || type === 'lane' || type === 'collaboration') continue;
    if ((type === 'subProcess' || type === 'transaction' || type === 'adHocSubProcess')
        && bpmnInfo?.isExpanded === true) continue;
    obstacles.push({ id, x: box.x, y: box.y, width: box.w, height: box.h });
  }
  return obstacles;
}

function collectBpmnInfo(root: any, out: Map<string, BpmnInfo>): void {
  if (!root) return;
  if (root.id && root.bpmn) out.set(root.id, { type: root.bpmn.type, isExpanded: root.bpmn.isExpanded === true });
  for (const child of root.children ?? []) collectBpmnInfo(child, out);
  for (const boundary of root.boundaryEvents ?? []) collectBpmnInfo(boundary, out);
  for (const artifact of root.artifacts ?? []) collectBpmnInfo(artifact, out);
}

function toNodeRect(box: NodeBox | undefined): Rect | undefined {
  return box ? { x: box.x, y: box.y, width: box.w, height: box.h } : undefined;
}

function assertRoutePortsMatchWaypoints(route: EdgeRoute): void {
  const first = route.waypoints[0];
  const last = route.waypoints[route.waypoints.length - 1];
  if (!first || !last) throw new Error(`[merger] route ${route.edgeId} has incomplete waypoints`);
  if (!samePoint(first, route.sourcePort.point) || !samePoint(last, route.targetPort.point)) {
    throw new Error(`[merger] route ${route.edgeId} port metadata does not match waypoints`);
  }
}

function samePoint(a: Waypoint, b: Waypoint): boolean {
  return Math.abs(a.x - b.x) < 0.001 && Math.abs(a.y - b.y) < 0.001;
}

function placeBoundaryEventLabel(be: any, beBox: NodeBox, placedLabels: LabelBox[]): void {
  const labelText = be.bpmn?.name ?? '';
  if (!labelText) return;

  const labelHeight = 14;
  const labelWidth = estimateBpmnLabelWidth(labelText);
  const labelX = beBox.x + beBox.w / 2 - labelWidth / 2;
  let labelY = beBox.y + beBox.h + 4;
  for (let guard = 0; guard < 10; guard++) {
    const collide = placedLabels.some((p) =>
      rangesOverlap(labelX, labelWidth, p.x, p.width)
      && Math.abs(p.y - labelY) < labelHeight
    );
    if (!collide) break;
    labelY += labelHeight + 4;
  }

  const label = { text: labelText, x: labelX, y: labelY, width: labelWidth, height: labelHeight };
  if (Array.isArray(be.labels) && be.labels.length > 0) {
    be.labels[0] = { ...be.labels[0], ...label };
  } else {
    be.labels = [label];
  }
  placedLabels.push({ x: labelX, y: labelY, width: labelWidth, height: labelHeight });
}

function estimateBpmnLabelWidth(text: string): number {
  let width = 6;
  for (const ch of text) width += /[一-鿿]/.test(ch) ? 12 : 7;
  return Math.max(width, 24);
}

function rangesOverlap(ax: number, aw: number, bx: number, bw: number): boolean {
  return ax < bx + bw && bx < ax + aw;
}
