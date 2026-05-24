// Pipeline 胶水：串联 stages。
//
// 实际执行顺序（文件名按职责命名，不再带 s1/s4b 前缀）：
//   Loader                                         (JSON → BpmnModel)
//   → SubprocessLayout (recursive, depth-first)    (展开 subprocess 内部局部坐标 + bbox)
//   → ElkPlacement (per proc)                      (节点局部坐标)
//   → LaneConstrainer (per proc)                   (Y snap 到 lane 中线)
//   → PoolComposer (compose)                       (多 pool 垂直堆叠 → 绝对坐标)
//   → SubprocessTranslator                         (subprocess 内部局部 → 绝对坐标，递归)
//   → mini ElkPlacement (per handler subgraph)     (boundary handler 子图)
//   → DecorationPlacer                             (boundary event 骑边 + handler 平移)
//   → ArtifactPlacer                               (dataObject / textAnnotation 上下方)
//   → PoolOverflowRebalancer                       (BE/handler/artifact 溢出 pool 时整体下推 + 撑宽)
//   → EdgeRouter                                   (所有节点位置已知后路由 edges)
//   → AssociationRouter                            (artifact ↔ host 的 association 边)
//   → Merger                                       (所有输出 → LayoutedGraph JSON)
//   → Serializer (在 service.ts 中)                 (JSON → BPMN 2.0 XML)
//
// 约束：本文件只做装配，不写算法逻辑。

import { loadFixture } from './loader/loader.ts';
import type { BpmnModel, ProcessUnit, SequenceFlow, Decoration } from './loader/types.ts';
import { nodeSizeOf, ioSpecDataObjectBoxes, ioSpecExtraBelow, layoutHeightWithIoSpec } from './layout/node-sizes.ts';
import { leafLaneOrder, nodeToLeafLane } from './layout/lane-resolver.ts';
import {
  createStageSnapshot,
  edgeRouteToSnapshotInput,
  snapshotFromLayoutedGraph,
  type SnapshotEdge,
  type SnapshotEdgeInput,
  type SnapshotNodeMeta,
  type SnapshotRect,
  type StageSnapshot,
} from './debug/ai-debug.ts';
import type { LayoutedGraph } from './serializer/types/elk-output.ts';
import { boundaryRuleFor, type BpmnEdgeKind } from './stages/bpmn-rules.ts';
// 所有 stage 入口从契约注册表 (./stages/index.ts) 单点 import
import {
  // SubprocessLayout
  collectSubprocessLayouts,
  type SubprocessLayout,
  SUBPROCESS_PADDING_TOP, SUBPROCESS_PADDING_BOTTOM,
  SUBPROCESS_PADDING_LEFT, SUBPROCESS_PADDING_RIGHT,
  // SubprocessTranslator
  translateSubprocesses,
  // PoolOverflowRebalancer
  rebalancePoolOverflow,
  // ElkPlacement
  elkPlacement,
  type PlacementInput,
  // LaneConstrainer
  laneConstrain,
  // Compactor (B2)
  compact,
  // PoolComposer
  poolCompose,
  type ComposeInputPool,
  // DecorationPlacer
  placeDecorations,
  type HandlerSubgraph,
  // ArtifactPlacer
  placeArtifacts,
  type ArtifactInputArtifact,
  type ArtifactInputAssociation,
  // EdgeRouter
  routeEdges,
  type RouteInput,
  type RouteInputEdge,
  type RouteInputNode,
  type RouteInputObstacle,
  // AssociationRouter
  routeAssociations,
  type AssociationEdgeInput,
  // ConstraintModel
  collectBoundaryConstraints,
  collectBoundaryDecisions,
  collectContainmentConstraints,
  collectPoolStackConstraints,
  collectPoolStackDecisions,
  collectRouteConstraints,
  collectRouteDecisions,
  summarizeConstraints,
  // IncrementalStabilizer
  stabilizeWithPreviousBoxes,
  // Merger
  merge,
  // shared atoms
  type NodeBox,
  type NodeLayoutBox,
  type LayoutConstraint,
  type LayoutConstraintSummary,
  type LayoutDecision,
  type PreviousBoxes,
  type IncrementalNodeMeta,
  type ElkShape,
  type LaneBox,
  type PoolBox,
} from './stages/index.ts';

const MAX_TRACE_DECISIONS = 500;

export interface PipelineTrace {
  routeCount: number;
  byEdgeType: Record<string, number>;
  constraints: LayoutConstraint[];
  constraintSummary: LayoutConstraintSummary;
  decisions: LayoutDecision[];
  decisionCount: number;
  decisionsTruncated: boolean;
  incremental: {
    previousBoxCount: number;
    appliedCount: number;
    skippedCount: number;
  };
  /**
   * M8 诊断快照：每个主流 process 的 ELK 输出形状（layer 数 / 每层节点数 / 宽度构成）。
   * 仅诊断用，不进 LayoutResult / DI XML。subprocess 内部 mini-ELK 与 handler 子图不收集。
   */
  elkShape: ElkShape[];
  /** AI debug bundle snapshots. Only collected when LayoutOptions.debug enables it. */
  stageSnapshots?: StageSnapshot[];
  msPlacement: number;
  msConstrain: number;
  msCompose: number;
  msHandlers: number;
  msRoute: number;
  msMerge: number;
  msTotal: number;
}

export interface PipelineOutput {
  graph: LayoutedGraph;
  trace: PipelineTrace;
}

export type PreviousBoxesInput = PreviousBoxes | Record<string, NodeBox>;

export interface LayoutOptions {
  previousBoxes?: PreviousBoxesInput;
  debug?: boolean | { stageSnapshots?: boolean };
}

// BFS from startEvents, do not cross boundary events. Returns main-reachable node ids.
function mainFlowReachable(
  flowNodes: Array<{ id: string; type: string }>,
  sequenceFlows: Array<{ source: string; target: string }>,
): Set<string> {
  const beIds = new Set(flowNodes.filter(n => n.type === 'boundaryEvent').map(n => n.id));
  const adj = new Map<string, string[]>();
  for (const sf of sequenceFlows) {
    if (!adj.has(sf.source)) adj.set(sf.source, []);
    adj.get(sf.source)!.push(sf.target);
  }
  const starts = flowNodes.filter(n => n.type === 'startEvent').map(n => n.id);
  const seen = new Set<string>(starts);
  const q = [...starts];
  while (q.length) {
    const cur = q.shift()!;
    if (beIds.has(cur)) continue;
    for (const nxt of adj.get(cur) ?? []) {
      if (beIds.has(nxt)) continue;
      if (!seen.has(nxt)) { seen.add(nxt); q.push(nxt); }
    }
  }
  return seen;
}

// 从 BE 出发收集 handler 子图：BFS through outgoing edges，不越界进入 main flow / 其他 handler。
interface CollectedSubgraph {
  beId: string;
  hostId: string;
  nodes: Set<string>;
  edges: SequenceFlow[];
}
function collectHandlerSubgraph(
  beId: string,
  hostId: string,
  allFlows: SequenceFlow[],
  mainReachable: Set<string>,
  alreadyClaimed: Set<string>,
): CollectedSubgraph {
  const adj = new Map<string, SequenceFlow[]>();
  for (const sf of allFlows) {
    if (!adj.has(sf.source)) adj.set(sf.source, []);
    adj.get(sf.source)!.push(sf);
  }
  const nodes = new Set<string>();
  const edges: SequenceFlow[] = [];
  // 起点是 BE 直接 target（不是 BE 自己）
  const q: string[] = [];
  for (const sf of adj.get(beId) ?? []) {
    if (mainReachable.has(sf.target)) continue; // rejoin，跳过
    if (alreadyClaimed.has(sf.target)) continue;
    q.push(sf.target);
    edges.push(sf);
  }
  while (q.length) {
    const cur = q.shift()!;
    if (nodes.has(cur)) continue;
    if (mainReachable.has(cur)) continue;
    if (alreadyClaimed.has(cur)) continue;
    nodes.add(cur);
    for (const sf of adj.get(cur) ?? []) {
      edges.push(sf);
      if (!mainReachable.has(sf.target) && !nodes.has(sf.target) && !alreadyClaimed.has(sf.target)) {
        q.push(sf.target);
      }
    }
  }
  return { beId, hostId, nodes, edges };
}

export async function runPipeline(
  rawJson: any,
  fixtureLabel = 'request',
  options: LayoutOptions = {},
): Promise<PipelineOutput> {
  const t0 = performance.now();
  const model: BpmnModel = loadFixture(fixtureLabel, rawJson);
  const layoutConstraints: LayoutConstraint[] = [];
  const layoutDecisions: LayoutDecision[] = [];
  const previousBoxes = normalizePreviousBoxes(options.previousBoxes);
  const stageSnapshots = shouldCollectStageSnapshots(options) ? [] as StageSnapshot[] : undefined;
  const debugNodeMeta = stageSnapshots ? collectDebugNodeMeta(model) : undefined;
  const debugInputEdges = stageSnapshots ? collectDebugEdgeInputs(model) : undefined;
  const pushSnapshot = (snapshot: StageSnapshot): void => {
    stageSnapshots?.push(snapshot);
  };

  // ============= SubprocessLayout: 递归展开 subprocess 内部 =============
  // 每个 isExpanded=true 的 subprocess 跑一次 mini ELK，得到内部局部坐标 + bbox。
  // 嵌套：深度优先，最内层先跑，外层用内层 size 作 override。
  const subprocessLayouts = new Map<string, SubprocessLayout>();
  for (const proc of model.processes) {
    if (proc.isBlackBox) continue;
    await collectSubprocessLayouts(proc, subprocessLayouts);
  }

  // ============= ElkPlacement + LaneConstrainer (per pool) =============
  const poolInputs: ComposeInputPool[] = [];
  const mainReachablePerProc = new Map<string, Set<string>>();
  const elkShapes: ElkShape[] = [];
  const debugElkNodes = stageSnapshots ? new Map<string, NodeBox>() : undefined;
  const debugElkPools = stageSnapshots ? new Map<string, SnapshotRect>() : undefined;
  const debugLaneNodes = stageSnapshots ? new Map<string, NodeBox>() : undefined;
  const debugLanePools = stageSnapshots ? new Map<string, SnapshotRect>() : undefined;
  const debugLaneRects = stageSnapshots ? new Map<string, SnapshotRect>() : undefined;
  let msPlacement = 0;
  let msConstrain = 0;
  for (const proc of model.processes) {
    if (proc.isBlackBox || proc.flowNodes.length === 0) {
      poolInputs.push({
        id: proc.id, name: proc.name, isBlackBox: proc.isBlackBox,
        nodes: new Map(), laneBoxes: new Map(), leafOrder: [], allLanes: [], width: 200, height: 60,
      });
      continue;
    }
    let mainReachable = mainFlowReachable(proc.flowNodes, proc.sequenceFlows);
    // Fallback：没有 startEvent 的 process（如纯 event-subprocess 容器），把所有非 BE 节点都纳入 ELK。
    if (mainReachable.size === 0) {
      mainReachable = new Set(proc.flowNodes.filter(n => n.type !== 'boundaryEvent').map(n => n.id));
    }
    mainReachablePerProc.set(proc.id, mainReachable);
    const flowNodesForElk = proc.flowNodes.filter(n => mainReachable.has(n.id));

    // B3: 算 in/out degree——ELK 的 layerConstraint=FIRST 要求 0 入度、LAST 要求 0 出度。
    // BPMN 中偶尔会有"end event 后还连了 boundary 补偿"等异常拓扑（见 fixture 37），不能盲加约束。
    const inDegElk = new Map<string, number>();
    const outDegElk = new Map<string, number>();
    for (const sf of proc.sequenceFlows) {
      if (!mainReachable.has(sf.source) || !mainReachable.has(sf.target)) continue;
      outDegElk.set(sf.source, (outDegElk.get(sf.source) ?? 0) + 1);
      inDegElk.set(sf.target, (inDegElk.get(sf.target) ?? 0) + 1);
    }

    // A1: leaf lane index per node（给 ELK partitioning hint）。无 lane 的 pool 留 undefined。
    let nodeLaneIndex: Map<string, number> | undefined;
    let nodeLeafLaneId: Map<string, string> | undefined;
    if (proc.lanes.length > 0) {
      const order = leafLaneOrder(proc.lanes);
      const indexOf = new Map(order.map((id, i) => [id, i]));
      const nodeLeaf = nodeToLeafLane(proc.lanes, order);
      nodeLeafLaneId = nodeLeaf;
      nodeLaneIndex = new Map();
      for (const n of flowNodesForElk) {
        const lid = nodeLeaf.get(n.id);
        if (lid !== undefined) {
          const idx = indexOf.get(lid);
          if (idx !== undefined) nodeLaneIndex.set(n.id, idx);
        }
      }
    }

    const placementIn: PlacementInput = {
      processId: proc.id,
      hasLanes: proc.lanes.length > 0,
      hasBoundaryHandlers: proc.decorations.some(d => d.kind === 'boundaryEvent'),
      nodes: flowNodesForElk.map(n => {
        // B3: start event 锁最左 layer，end event 锁最右 layer——保证 F1 主流方向一致。
        // 仅当拓扑合规（start 无入边、end 无出边）时加约束；否则 ELK 会抛 UnsupportedConfigurationException。
        let layerConstraint: 'first' | 'last' | undefined;
        if (n.type === 'startEvent' && (inDegElk.get(n.id) ?? 0) === 0) layerConstraint = 'first';
        else if (n.type === 'endEvent' && (outDegElk.get(n.id) ?? 0) === 0) layerConstraint = 'last';

        const laneIndex = nodeLaneIndex?.get(n.id);
        const laneId = nodeLeafLaneId?.get(n.id);
        if (layerConstraint) {
          layoutDecisions.push({
            stage: 'ElkPlacement',
            kind: 'elk-layer',
            subject: { kind: 'node', id: n.id },
            reason: 'BPMN start/end nodes receive ELK layer hints when topology permits',
            input: {
              nodeType: n.type,
              inDegree: inDegElk.get(n.id) ?? 0,
              outDegree: outDegElk.get(n.id) ?? 0,
            },
            output: { layerConstraint },
          });
        }
        if (laneIndex !== undefined) {
          layoutDecisions.push({
            stage: 'ElkPlacement',
            kind: 'elk-lane-partition',
            subject: { kind: 'node', id: n.id },
            reason: 'BPMN lane membership is converted to an ELK partition hint',
            input: { laneId: laneId ?? null },
            output: { laneIndex },
          });
        }

        // 展开 subprocess 用内部 bbox 决定的尺寸（含 padding）
        if (n.isExpanded) {
          const inner = subprocessLayouts.get(n.id);
          if (inner) {
            const h = inner.bounds.height + SUBPROCESS_PADDING_TOP + SUBPROCESS_PADDING_BOTTOM;
            return {
              id: n.id, type: n.type,
              w: inner.bounds.width + SUBPROCESS_PADDING_LEFT + SUBPROCESS_PADDING_RIGHT,
              h,
              layoutH: layoutHeightWithIoSpec(
                h,
                n.ioInputCount,
                n.ioOutputCount,
                n.ioInputNames,
                n.ioOutputNames,
                inner.bounds.width + SUBPROCESS_PADDING_LEFT + SUBPROCESS_PADDING_RIGHT,
              ),
              laneIndex, layerConstraint,
            };
          }
        }
        const size = nodeSizeOf(n.type);
        return {
          id: n.id,
          type: n.type,
          ...size,
          layoutH: layoutHeightWithIoSpec(size.h, n.ioInputCount, n.ioOutputCount, n.ioInputNames, n.ioOutputNames, size.w),
          laneIndex,
          layerConstraint,
        };
      }),
      edges: proc.sequenceFlows
        .filter(sf => mainReachable.has(sf.source) && mainReachable.has(sf.target))
        .map(sf => ({ id: sf.id, source: sf.source, target: sf.target })),
    };
    const tp = performance.now();
    const placement = await elkPlacement(placementIn);
    msPlacement += performance.now() - tp;
    elkShapes.push(placement.shape);
    if (stageSnapshots) {
      mergeNodeBoxes(debugElkNodes!, placement.nodes);
      debugElkPools!.set(proc.id, {
        x: 0,
        y: 0,
        w: placement.bounds.width,
        h: placement.bounds.height,
      });
    }

    const tc = performance.now();
    const nodeMetaForLane = new Map<string, {
      type: typeof proc.flowNodes[number]['type'];
      name?: string;
      ioInputCount?: number;
      ioOutputCount?: number;
      ioInputNames?: readonly string[];
      ioOutputNames?: readonly string[];
    }>();
    for (const fn of proc.flowNodes) {
      nodeMetaForLane.set(fn.id, {
        type: fn.type,
        name: fn.name,
        ioInputCount: fn.ioInputCount,
        ioOutputCount: fn.ioOutputCount,
        ioInputNames: fn.ioInputNames,
        ioOutputNames: fn.ioOutputNames,
      });
    }
    const edgesForLane = proc.sequenceFlows
      .filter(sf => mainReachable.has(sf.source) && mainReachable.has(sf.target))
      .map(sf => ({ source: sf.source, target: sf.target }));
    const constrain = laneConstrain({
      nodes: placement.nodes, width: placement.bounds.width, height: placement.bounds.height, lanes: proc.lanes,
      nodeMeta: nodeMetaForLane,
      edges: edgesForLane,
    });
    msConstrain += performance.now() - tc;

    // B2: 压缩明显的层间空白。Y 不动、节点大小不动，仅减少 X 间距。
    // 跑在 lane-constrainer 后是关键：lane 高度已确定，X 收紧不会让节点出 lane。
    const compacted = compact({
      nodes: constrain.nodes,
      edges: edgesForLane,
      nodeMeta: nodeMetaForLane,
      wrapLinearChain: proc.lanes.length === 0 && proc.decorations.some(d => d.kind === 'boundaryEvent'),
    });
    const finalNodes = compacted.trimmedPx > 0 ? compacted.nodes : constrain.nodes;
    const finalWidth = compacted.trimmedPx > 0
      ? Math.max(...Array.from(finalNodes.values()).map(b => b.x + b.w), 0)
      : constrain.poolWidth;
    const finalHeight = Math.max(
      constrain.poolHeight,
      ...Array.from(finalNodes.values()).map(b => b.y + b.h),
      0,
    );
    if (stageSnapshots) {
      mergeNodeBoxes(debugLaneNodes!, finalNodes);
      debugLanePools!.set(proc.id, { x: 0, y: 0, w: finalWidth, h: finalHeight });
      for (const [laneId, lane] of constrain.laneBoxes) {
        debugLaneRects!.set(laneId, { x: 0, y: lane.top, w: finalWidth, h: lane.height });
      }
    }

    poolInputs.push({
      id: proc.id, name: proc.name, isBlackBox: false,
      nodes: finalNodes, laneBoxes: constrain.laneBoxes,
      leafOrder: constrain.leafOrder, allLanes: constrain.allLanes,
      width: finalWidth, height: finalHeight,
    });
  }
  if (stageSnapshots) {
    pushSnapshot(createStageSnapshot({
      fixture: fixtureLabel,
      stage: 'elk-placement',
      order: stageSnapshots.length,
      nodes: debugElkNodes,
      nodeMeta: debugNodeMeta,
      edges: debugInputEdges,
      pools: debugElkPools,
      notes: ['ELK output uses process-local coordinates before lane snap and pool composition.'],
    }));
    pushSnapshot(createStageSnapshot({
      fixture: fixtureLabel,
      stage: 'lane-constrainer',
      order: stageSnapshots.length,
      nodes: debugLaneNodes,
      nodeMeta: debugNodeMeta,
      edges: debugInputEdges,
      pools: debugLanePools,
      lanes: debugLaneRects,
      notes: ['Lane-constrainer output is still process-local; lane rectangles use local Y bands.'],
    }));
  }

  // ============= PoolComposer =============
  // 提前收集 node → pool 映射用于 cross-pool X 对齐
  const nodeToPoolForCompose = new Map<string, string>();
  for (const proc of model.processes) {
    for (const fn of proc.flowNodes) nodeToPoolForCompose.set(fn.id, proc.id);
  }
  const tCo = performance.now();
  const compose = poolCompose({
    pools: poolInputs,
    messageFlows: model.collaborationMessageFlows,
    nodeToPool: nodeToPoolForCompose,
  });
  const msCompose = performance.now() - tCo;
  layoutConstraints.push(...collectPoolStackConstraints(compose.poolBoxes));
  layoutDecisions.push(...collectPoolStackDecisions(compose.poolBoxes));
  if (stageSnapshots) {
    pushSnapshot(createStageSnapshot({
      fixture: fixtureLabel,
      stage: 'pool-composer',
      order: stageSnapshots.length,
      nodes: compose.nodes,
      nodeMeta: enrichNodeMeta(debugNodeMeta!, compose.nodeToPool, compose.nodeToLane),
      edges: debugInputEdges,
      pools: compose.poolBoxes,
      lanes: laneBandRects(compose.laneBoxes, compose.poolBoxes),
      notes: ['Pool-composer upgrades process-local node and lane coordinates into absolute canvas coordinates.'],
    }));
  }

  // ============= SubprocessTranslator =============
  // 顶层 expanded subprocess 的 abs box 来自 compose.nodes；stage 负责递归内层 + 把
  // SubprocessLayout 局部坐标平移到绝对坐标。
  const topLevelExpansions: Array<{ subId: string; absBox: NodeBox }> = [];
  for (const proc of model.processes) {
    for (const fn of proc.flowNodes) {
      if (!fn.isExpanded) continue;
      if (!subprocessLayouts.has(fn.id)) continue;
      const box = compose.nodes.get(fn.id);
      if (!box) continue;
      topLevelExpansions.push({ subId: fn.id, absBox: box });
    }
  }
  const translated = translateSubprocesses({ subprocessLayouts, topLevelExpansions });
  const expandedInnerNodes = translated.innerNodeBoxes;
  const expandedInnerEdgeIds = translated.innerEdgeIds;
  if (stageSnapshots) {
    const nodes = new Map<string, NodeBox>(compose.nodes);
    mergeNodeBoxes(nodes, expandedInnerNodes);
    pushSnapshot(createStageSnapshot({
      fixture: fixtureLabel,
      stage: 'subprocess-translator',
      order: stageSnapshots.length,
      nodes,
      nodeMeta: enrichNodeMeta(debugNodeMeta!, compose.nodeToPool, compose.nodeToLane),
      edges: debugInputEdges,
      pools: compose.poolBoxes,
      lanes: laneBandRects(compose.laneBoxes, compose.poolBoxes),
      notes: ['Expanded subprocess child nodes are translated from subprocess-local into absolute coordinates.'],
    }));
  }

  // ============= mini ElkPlacement: handler subgraphs =============
  const tH = performance.now();
  const handlerSubgraphs: HandlerSubgraph[] = [];
  const handlerNodeMeta = new Map<string, { hostId: string; procId: string }>();
  const handlerInternalEdges: SequenceFlow[] = [];
  const beToHandlerEntry = new Map<string, string>();  // BE id → handler 入口节点 id（用于 EdgeRouter）

  // compensation BE → 触发的活动是通过 association 而不是 sequenceFlow 连接。
  // 把这些 association 当作 BE→handler 的"虚拟连接边"喂给 EdgeRouter，handler 节点摆位
  // 与普通 handler 子图一致（单节点）。
  // 边的 BPMN 语义类别由 boundaryRuleFor(eventType).connectorKind 决定：
  //   compensation BE → 'compensationAssociation'（direct 直线）
  //   其它（不应该走这条 codepath，仅为类型完备）→ rule 默认值
  const compensationHandlerEdges: { id: string; source: string; target: string; bpmnType: BpmnEdgeKind }[] = [];

  for (const proc of model.processes) {
    if (proc.isBlackBox) continue;
    const mainReachable = mainReachablePerProc.get(proc.id) ?? new Set();
    const claimed = new Set<string>();
    // 预先索引该 proc 内的 association decorations（key=source）
    const assocBySource = new Map<string, { id: string; target: string }[]>();
    for (const d of proc.decorations) {
      if (d.kind !== 'association') continue;
      if (!assocBySource.has(d.source)) assocBySource.set(d.source, []);
      assocBySource.get(d.source)!.push({ id: d.id, target: d.target });
    }
    for (const dec of proc.decorations) {
      if (dec.kind !== 'boundaryEvent') continue;
      const sg = collectHandlerSubgraph(dec.id, dec.host, proc.sequenceFlows, mainReachable, claimed);

      // compensation BE：用 association 找 handler 活动，单节点 handler
      if (sg.nodes.size === 0 && dec.eventType === 'compensation') {
        const assocs = assocBySource.get(dec.id) ?? [];
        const connectorKind = boundaryRuleFor(dec.eventType).connectorKind;
        for (const a of assocs) {
          if (mainReachable.has(a.target) || claimed.has(a.target)) continue;
          sg.nodes.add(a.target);
          // 走 boundary rule 决定的 BPMN 类别（compensation → compensationAssociation，
          // path-shaper 会按 direct 风格画 2-point 直线）
          compensationHandlerEdges.push({ id: a.id, source: dec.id, target: a.target, bpmnType: connectorKind });
        }
      }

      if (sg.nodes.size === 0) continue; // BE 无 handler

      // 找入口节点：BE 直接 target
      const entry = proc.sequenceFlows.find(sf => sf.source === dec.id);
      if (entry) beToHandlerEntry.set(dec.id, entry.target);

      for (const id of sg.nodes) claimed.add(id);
      for (const id of sg.nodes) handlerNodeMeta.set(id, { hostId: dec.host, procId: proc.id });
      for (const e of sg.edges) handlerInternalEdges.push(e);

      // mini ElkPlacement
      const handlerNodes = proc.flowNodes
        .filter(n => sg.nodes.has(n.id))
        .map(n => {
          if (n.isExpanded) {
            const inner = subprocessLayouts.get(n.id);
            if (inner) {
              const h = inner.bounds.height + SUBPROCESS_PADDING_TOP + SUBPROCESS_PADDING_BOTTOM;
              return {
                id: n.id,
                type: n.type,
                w: inner.bounds.width + SUBPROCESS_PADDING_LEFT + SUBPROCESS_PADDING_RIGHT,
                h,
                layoutH: layoutHeightWithIoSpec(
                  h,
                  n.ioInputCount,
                  n.ioOutputCount,
                  n.ioInputNames,
                  n.ioOutputNames,
                  inner.bounds.width + SUBPROCESS_PADDING_LEFT + SUBPROCESS_PADDING_RIGHT,
                ),
              };
            }
          }
          const size = nodeSizeOf(n.type);
          return {
            id: n.id,
            type: n.type,
            ...size,
            layoutH: layoutHeightWithIoSpec(size.h, n.ioInputCount, n.ioOutputCount, n.ioInputNames, n.ioOutputNames, size.w),
          };
        });
      const handlerEdges = sg.edges
        .filter(e => sg.nodes.has(e.source) && sg.nodes.has(e.target))
        .map(e => ({ id: e.id, source: e.source, target: e.target }));
      const placement = await elkPlacement({
        processId: `${proc.id}::handler::${dec.id}`,
        nodes: handlerNodes,
        edges: handlerEdges,
      });
      handlerSubgraphs.push({
        beId: dec.id, hostId: dec.host,
        nodes: placement.nodes,
        width: placement.bounds.width, height: placement.bounds.height,
      });
    }
  }
  const msHandlers = performance.now() - tH;

  // ============= DecorationPlacer =============
  const boundaryEvents: { id: string; hostId: string; idx: number }[] = [];
  for (const proc of model.processes) {
    const byHost = new Map<string, number>();
    for (const dec of proc.decorations) {
      if (dec.kind !== 'boundaryEvent') continue;
      const i = byHost.get(dec.host) ?? 0;
      boundaryEvents.push({ id: dec.id, hostId: dec.host, idx: i });
      byHost.set(dec.host, i + 1);
    }
  }
  const decoration = placeDecorations({
    hostBoxes: compose.nodes,
    boundaryEvents,
    handlerSubgraphs,
  });
  layoutConstraints.push(...collectBoundaryConstraints({ boundaryEvents }));
  layoutDecisions.push(...collectBoundaryDecisions({
    boundaryEvents,
    boundaryEventBoxes: decoration.boundaryEventBoxes,
  }));
  if (stageSnapshots) {
    const nodes = new Map<string, NodeBox>(compose.nodes);
    mergeNodeBoxes(nodes, expandedInnerNodes);
    mergeNodeBoxes(nodes, decoration.boundaryEventBoxes);
    mergeNodeBoxes(nodes, decoration.handlerNodeBoxes);
    pushSnapshot(createStageSnapshot({
      fixture: fixtureLabel,
      stage: 'decoration-placer',
      order: stageSnapshots.length,
      nodes,
      nodeMeta: enrichNodeMeta(debugNodeMeta!, compose.nodeToPool, compose.nodeToLane),
      edges: debugInputEdges,
      pools: compose.poolBoxes,
      lanes: laneBandRects(compose.laneBoxes, compose.poolBoxes),
      notes: ['Boundary events and handler subgraphs are now absolute; edges are not routed yet.'],
    }));
  }

  // ============= ArtifactPlacer =============
  const artifactsIn: ArtifactInputArtifact[] = [];
  const associationsIn: ArtifactInputAssociation[] = [];
  for (const proc of model.processes) {
    for (const dec of proc.decorations) {
      if (dec.kind === 'artifact') {
        artifactsIn.push({ id: dec.id, subtype: dec.subtype, width: dec.width, height: dec.height });
      } else if (dec.kind === 'association') {
        associationsIn.push({ id: dec.id, subtype: dec.subtype, source: dec.source, target: dec.target });
      }
    }
  }
  const artifactOut = placeArtifacts({
    flowNodeBoxes: compose.nodes,
    artifacts: artifactsIn,
    associations: associationsIn,
  });
  if (stageSnapshots) {
    const nodes = new Map<string, NodeBox>(compose.nodes);
    mergeNodeBoxes(nodes, expandedInnerNodes);
    mergeNodeBoxes(nodes, decoration.boundaryEventBoxes);
    mergeNodeBoxes(nodes, decoration.handlerNodeBoxes);
    mergeNodeBoxes(nodes, artifactOut.artifactBoxes);
    pushSnapshot(createStageSnapshot({
      fixture: fixtureLabel,
      stage: 'artifact-placer',
      order: stageSnapshots.length,
      nodes,
      nodeMeta: enrichNodeMeta(debugNodeMeta!, compose.nodeToPool, compose.nodeToLane),
      edges: debugInputEdges,
      pools: compose.poolBoxes,
      lanes: laneBandRects(compose.laneBoxes, compose.poolBoxes),
      notes: ['Artifact nodes are now placed relative to their associated host nodes.'],
    }));
  }

  // ============= PoolOverflowRebalancer =============
  // 收集各类 box → host → pool 的归属映射，喂给 rebalancer。stage 会原地改 box 的 .y / .h /
  // pool 的 .y / .h / .w，并返回新的 totalBounds。
  const artifactHosts = new Map<string, string>();
  for (const [aid, meta] of artifactOut.artifactSides) artifactHosts.set(aid, meta.hostId);
  const boundaryEventHosts = new Map<string, string>();
  for (const be of boundaryEvents) boundaryEventHosts.set(be.id, be.hostId);
  const handlerNodeHosts = new Map<string, string>();
  for (const [nodeId, meta] of handlerNodeMeta) handlerNodeHosts.set(nodeId, meta.hostId);
  const innerNodeOwnerPool = new Map<string, string>();
  for (const proc of model.processes) {
    (function walk(p: ProcessUnit) {
      for (const fn of p.flowNodes) innerNodeOwnerPool.set(fn.id, proc.id);
      for (const sub of p.subProcesses) walk(sub);
    })(proc);
  }
  const nodeLayoutBoxes = new Map<string, NodeLayoutBox>();
  for (const proc of model.processes) {
    for (const fn of proc.flowNodes) {
      const visualBox = compose.nodes.get(fn.id);
      if (!visualBox) continue;
      const extra = ioSpecExtraBelow(fn.ioInputCount, fn.ioOutputCount, fn.ioInputNames, fn.ioOutputNames, visualBox.w);
      if (extra <= 0) continue;
      nodeLayoutBoxes.set(fn.id, {
        visualBox,
        layoutBox: { ...visualBox, y: visualBox.y - extra, h: visualBox.h + extra * 2 },
      });
    }
  }
  const bottomLaneByPool = new Map<string, string>();
  for (const p of poolInputs) {
    const bottomLaneId = p.leafOrder[p.leafOrder.length - 1];
    if (bottomLaneId) bottomLaneByPool.set(p.id, bottomLaneId);
  }

  const rebalanced = rebalancePoolOverflow({
    poolBoxes: compose.poolBoxes,
    totalBounds: compose.totalBounds,
    nodes: compose.nodes,
    laneBoxes: compose.laneBoxes,
    expandedInnerNodes,
    artifactBoxes: artifactOut.artifactBoxes,
    boundaryEventBoxes: decoration.boundaryEventBoxes,
    handlerNodeBoxes: decoration.handlerNodeBoxes,
    nodeToPool: compose.nodeToPool,
    artifactHosts,
    boundaryEventHosts,
    handlerNodeHosts,
    innerNodeOwnerPool,
    nodeLayoutBoxes,
    bottomLaneByPool,
  });
  compose.totalBounds = rebalanced.totalBounds;
  if (stageSnapshots) {
    const nodes = new Map<string, NodeBox>(compose.nodes);
    mergeNodeBoxes(nodes, expandedInnerNodes);
    mergeNodeBoxes(nodes, decoration.boundaryEventBoxes);
    mergeNodeBoxes(nodes, decoration.handlerNodeBoxes);
    mergeNodeBoxes(nodes, artifactOut.artifactBoxes);
    pushSnapshot(createStageSnapshot({
      fixture: fixtureLabel,
      stage: 'pool-overflow-rebalancer',
      order: stageSnapshots.length,
      nodes,
      nodeMeta: enrichNodeMeta(debugNodeMeta!, compose.nodeToPool, compose.nodeToLane),
      edges: debugInputEdges,
      pools: compose.poolBoxes,
      lanes: laneBandRects(compose.laneBoxes, compose.poolBoxes),
      notes: ['Pool overflow rebalancer may mutate pool, lane, host, boundary, handler, and artifact boxes in place.'],
    }));
  }

  // ============= IncrementalStabilizer =============
  const incrementalNodeMeta = new Map<string, IncrementalNodeMeta>();
  for (const [nodeId] of compose.nodes) {
    incrementalNodeMeta.set(nodeId, {
      poolId: compose.nodeToPool.get(nodeId) ?? '',
      laneId: compose.nodeToLane.get(nodeId) ?? null,
    });
  }
  const incremental = stabilizeWithPreviousBoxes({
    nodes: compose.nodes,
    previousBoxes,
    nodeMeta: incrementalNodeMeta,
    poolBoxes: compose.poolBoxes,
    laneBoxes: compose.laneBoxes,
  });
  compose.nodes = incremental.nodes;
  layoutConstraints.push(...incremental.constraints);
  layoutDecisions.push(...incremental.decisions);

  // ============= EdgeRouter =============
  const routeNodes = new Map<string, RouteInputNode>();

  // 主流节点
  for (const proc of model.processes) {
    for (const fn of proc.flowNodes) {
      const box = compose.nodes.get(fn.id);
      if (!box) continue;
      const laneId = compose.nodeToLane.get(fn.id) ?? null;
      const laneIdx = laneId ? (compose.laneIdx.get(laneId) ?? null) : null;
      routeNodes.set(fn.id, {
        box, type: fn.type,
        isExpanded: fn.isExpanded,
        poolId: compose.nodeToPool.get(fn.id) ?? proc.id,
        laneId, laneIdx,
      });
    }
  }
  // 展开 subprocess 内部节点（含递归嵌套）→ routeNodes
  // 通过 subProcesses 链找到承载 proc，借用其 poolId
  const innerNodeOwnerProc = new Map<string, string>(); // inner node id → top-level proc id
  function walkInnerOwners(proc: ProcessUnit, topProcId: string) {
    for (const fn of proc.flowNodes) {
      innerNodeOwnerProc.set(fn.id, topProcId);
    }
    for (const sub of proc.subProcesses) walkInnerOwners(sub, topProcId);
  }
  for (const proc of model.processes) walkInnerOwners(proc, proc.id);

  for (const [innerId, innerBox] of expandedInnerNodes) {
    // 找到节点类型
    let fnType: any = 'task';
    for (const proc of model.processes) {
      const findIn = (p: ProcessUnit): any => {
        for (const f of p.flowNodes) if (f.id === innerId) return f.type;
        for (const s of p.subProcesses) {
          const t = findIn(s);
          if (t) return t;
        }
        return null;
      };
      const t = findIn(proc);
      if (t) { fnType = t; break; }
    }
    const ownerProcId = innerNodeOwnerProc.get(innerId) ?? '';
    routeNodes.set(innerId, {
      box: innerBox,
      type: fnType,
      isExpanded: false,
      poolId: ownerProcId,
      laneId: null,
      laneIdx: null,
    });
  }
  // BE 节点（位置来自 DecorationPlacer）
  for (const [beId, beBox] of decoration.boundaryEventBoxes) {
    // 找 BE 的 host 来推断 pool/lane
    const meta = boundaryEvents.find(b => b.id === beId);
    if (!meta) continue;
    const hostNode = routeNodes.get(meta.hostId);
    routeNodes.set(beId, {
      box: beBox,
      type: 'boundaryEvent',
      isExpanded: false,
      poolId: hostNode?.poolId ?? '',
      laneId: hostNode?.laneId ?? null,
      laneIdx: hostNode?.laneIdx ?? null,
    });
  }
  // handler 节点（位置来自 DecorationPlacer）
  for (const [nodeId, box] of decoration.handlerNodeBoxes) {
    const meta = handlerNodeMeta.get(nodeId);
    if (!meta) continue;
    const hostNode = routeNodes.get(meta.hostId);
    // handler 节点的 type 从原 fixture flowNodes 查
    const fn = model.processes.flatMap(p => p.flowNodes).find(n => n.id === nodeId);
    routeNodes.set(nodeId, {
      box,
      type: fn?.type ?? 'task',
      isExpanded: fn?.isExpanded ?? false,
      poolId: hostNode?.poolId ?? '',
      laneId: hostNode?.laneId ?? null,
      laneIdx: hostNode?.laneIdx ?? null,
    });
  }
  layoutConstraints.push(...collectContainmentConstraints({
    nodes: Array.from(routeNodes, ([id, n]) => ({
      id,
      poolId: n.poolId || null,
      laneId: n.laneId,
    })),
    lanes: Array.from(compose.laneBoxes, ([id, lane]) => ({ id, poolId: lane.poolId })),
  }));

  const routeEdgesList: RouteInputEdge[] = [];
  const innerEdgeIdSet = new Set(expandedInnerEdgeIds);
  // 主流 sequenceFlows
  for (const proc of model.processes) {
    for (const sf of proc.sequenceFlows) {
      if (!routeNodes.has(sf.source) || !routeNodes.has(sf.target)) continue;
      // 跳过已经在 handlerInternalEdges 里的
      if (handlerInternalEdges.some(e => e.id === sf.id)) continue;
      routeEdgesList.push({ id: sf.id, source: sf.source, target: sf.target, bpmnType: 'sequenceFlow' });
    }
  }
  // 展开 subprocess 内部 sequenceFlows
  function walkInnerFlows(proc: ProcessUnit) {
    for (const sub of proc.subProcesses) {
      const parentFn = proc.flowNodes.find(f => f.subProcessId === sub.id);
      if (!parentFn?.isExpanded) continue;
      for (const sf of sub.sequenceFlows) {
        if (!innerEdgeIdSet.has(sf.id)) continue;
        if (!routeNodes.has(sf.source) || !routeNodes.has(sf.target)) continue;
        routeEdgesList.push({ id: sf.id, source: sf.source, target: sf.target, bpmnType: 'sequenceFlow' });
      }
      walkInnerFlows(sub);
    }
  }
  for (const proc of model.processes) walkInnerFlows(proc);
  // handler 子图内部 + BE→handler 入口 都进 router
  for (const sf of handlerInternalEdges) {
    if (!routeNodes.has(sf.source) || !routeNodes.has(sf.target)) continue;
    routeEdgesList.push({ id: sf.id, source: sf.source, target: sf.target, bpmnType: 'sequenceFlow' });
  }
  // compensation BE → handler activity（association，但走 boundary-to-handler 路径）
  for (const ce of compensationHandlerEdges) {
    if (!routeNodes.has(ce.source) || !routeNodes.has(ce.target)) continue;
    routeEdgesList.push({ id: ce.id, source: ce.source, target: ce.target, bpmnType: ce.bpmnType });
  }
  // collaboration messageFlows
  for (const mf of model.collaborationMessageFlows) {
    if (!routeNodes.has(mf.source) || !routeNodes.has(mf.target)) continue;
    routeEdgesList.push({ id: mf.id, source: mf.source, target: mf.target, bpmnType: 'messageFlow' });
  }

  const routeObstacles: RouteInputObstacle[] = [];
  for (const proc of model.processes) {
    (function walk(p: ProcessUnit) {
      for (const fn of p.flowNodes) {
        if (fn.ioInputCount <= 0 && fn.ioOutputCount <= 0) continue;
        const hostBox = compose.nodes.get(fn.id) ?? expandedInnerNodes.get(fn.id);
        if (!hostBox) continue;
        const poolId = compose.nodeToPool.get(fn.id) ?? innerNodeOwnerPool.get(fn.id);
        if (!poolId) continue;
        for (const box of ioSpecDataObjectBoxes(hostBox, fn.ioInputCount, fn.ioOutputCount, fn.ioInputNames, fn.ioOutputNames)) {
          routeObstacles.push({ box, poolId });
        }
      }
      for (const sub of p.subProcesses) walk(sub);
    })(proc);
  }

  const routeInput: RouteInput = {
    nodes: routeNodes,
    edges: routeEdgesList,
    laneBoxes: compose.laneBoxes,
    poolBoxes: compose.poolBoxes,
    routeObstacles,
  };
  const tR = performance.now();
  const routes = routeEdges(routeInput);
  const msRoute = performance.now() - tR;

  // ============= AssociationRouter =============
  const assocEdgesIn: AssociationEdgeInput[] = [];
  for (const assoc of associationsIn) {
    // 找 artifact 端
    const srcSide = artifactOut.artifactSides.get(assoc.source);
    const tgtSide = artifactOut.artifactSides.get(assoc.target);
    const srcBox = artifactOut.artifactBoxes.get(assoc.source) ?? compose.nodes.get(assoc.source);
    const tgtBox = artifactOut.artifactBoxes.get(assoc.target) ?? compose.nodes.get(assoc.target);
    if (!srcBox || !tgtBox) continue;
    if (!srcSide && !tgtSide) continue; // 两端都不是已摆位的 artifact，跳过
    assocEdgesIn.push({
      id: assoc.id,
      sourceId: assoc.source,
      targetId: assoc.target,
      sourceBox: srcBox,
      targetBox: tgtBox,
      srcArtifactSide: srcSide?.side ?? null,
      tgtArtifactSide: tgtSide?.side ?? null,
    });
  }
  const associationObstacles = [
    ...compose.nodes.values(),
    ...decoration.boundaryEventBoxes.values(),
    ...decoration.handlerNodeBoxes.values(),
    ...expandedInnerNodes.values(),
  ];
  const assocRoutes = routeAssociations({ edges: assocEdgesIn, obstacles: associationObstacles });

  // 合并 routes
  const allRoutes = new Map(routes.routes);
  for (const [id, r] of assocRoutes.routes) allRoutes.set(id, r);
  layoutConstraints.push(...collectRouteConstraints(allRoutes));
  layoutDecisions.push(...collectRouteDecisions(allRoutes));
  if (stageSnapshots) {
    const nodes = new Map<string, NodeBox>();
    for (const [id, n] of routeNodes) nodes.set(id, n.box);
    mergeNodeBoxes(nodes, artifactOut.artifactBoxes);
    const routeEdgeMeta = new Map<string, { source: string; target: string; kind: SnapshotEdge['kind'] }>();
    for (const edge of routeEdgesList) {
      routeEdgeMeta.set(edge.id, {
        source: edge.source,
        target: edge.target,
        kind: edgeKindForBpmn(edge.bpmnType),
      });
    }
    for (const edge of assocEdgesIn) {
      routeEdgeMeta.set(edge.id, {
        source: edge.sourceId,
        target: edge.targetId,
        kind: 'association',
      });
    }
    const edgeSnapshots: SnapshotEdgeInput[] = [];
    for (const [id, route] of allRoutes) {
      const meta = routeEdgeMeta.get(id);
      if (!meta) continue;
      edgeSnapshots.push(edgeRouteToSnapshotInput(id, route, meta.source, meta.target, meta.kind));
    }
    pushSnapshot(createStageSnapshot({
      fixture: fixtureLabel,
      stage: 'edge-router',
      order: stageSnapshots.length,
      nodes,
      nodeMeta: routeNodeMeta(routeNodes, debugNodeMeta!),
      edges: edgeSnapshots,
      pools: compose.poolBoxes,
      lanes: laneBandRects(compose.laneBoxes, compose.poolBoxes),
      notes: ['All edge waypoints and ports are absolute coordinates after EdgeRouter plus AssociationRouter.'],
    }));
  }

  // ============= Merger =============
  // 合并所有节点位置 → allNodes（含 handler / artifact / 展开 subprocess 内部）
  const allNodesForMerge = new Map<string, NodeBox>(compose.nodes);
  for (const [id, b] of decoration.handlerNodeBoxes) allNodesForMerge.set(id, b);
  for (const [id, b] of artifactOut.artifactBoxes) allNodesForMerge.set(id, b);
  for (const [id, b] of expandedInnerNodes) allNodesForMerge.set(id, b);

  const tM = performance.now();
  const graph = merge({
    raw: rawJson,
    nodes: allNodesForMerge,
    boundaryEventBoxes: decoration.boundaryEventBoxes,
    poolBoxes: compose.poolBoxes,
    laneBoxes: compose.laneBoxes,
    routes: allRoutes,
    totalBounds: compose.totalBounds,
  });
  const msMerge = performance.now() - tM;
  if (stageSnapshots) {
    pushSnapshot(snapshotFromLayoutedGraph(
      fixtureLabel,
      'merger',
      stageSnapshots.length,
      graph,
      ['Merger writes absolute stage data back into parent-relative LayoutedGraph containers.'],
    ));
  }

  const msTotal = performance.now() - t0;
  const byEdgeType: Record<string, number> = {};
  for (const r of routes.routes.values()) {
    byEdgeType[r.edgeType] = (byEdgeType[r.edgeType] ?? 0) + 1;
  }
  const decisionCount = layoutDecisions.length;

  return {
    graph,
    trace: {
      routeCount: routes.routes.size, byEdgeType,
      constraints: layoutConstraints,
      constraintSummary: summarizeConstraints(layoutConstraints),
      decisions: layoutDecisions.slice(0, MAX_TRACE_DECISIONS),
      decisionCount,
      decisionsTruncated: decisionCount > MAX_TRACE_DECISIONS,
      incremental: {
        previousBoxCount: previousBoxes.size,
        appliedCount: incremental.appliedCount,
        skippedCount: incremental.skippedCount,
      },
      elkShape: elkShapes,
      ...(stageSnapshots ? { stageSnapshots } : {}),
      msPlacement, msConstrain, msCompose, msHandlers, msRoute, msMerge, msTotal,
    },
  };
}

function shouldCollectStageSnapshots(options: LayoutOptions): boolean {
  if (options.debug === true) return true;
  if (options.debug && typeof options.debug === 'object') {
    return options.debug.stageSnapshots !== false;
  }
  return false;
}

function mergeNodeBoxes(target: Map<string, NodeBox>, source: Map<string, NodeBox>): void {
  for (const [id, box] of source) target.set(id, box);
}

function collectDebugNodeMeta(model: BpmnModel): Map<string, SnapshotNodeMeta> {
  const meta = new Map<string, SnapshotNodeMeta>();
  const walkProcess = (proc: ProcessUnit, topPoolId: string, parentId: string | null): void => {
    const laneOf = proc.lanes.length > 0
      ? nodeToLeafLane(proc.lanes, leafLaneOrder(proc.lanes))
      : new Map<string, string>();
    for (const node of proc.flowNodes) {
      meta.set(node.id, {
        type: node.type,
        poolId: topPoolId,
        laneId: laneOf.get(node.id) ?? null,
        parentId,
      });
    }
    for (const decoration of proc.decorations) {
      if (decoration.kind === 'boundaryEvent') {
        meta.set(decoration.id, {
          type: 'boundaryEvent',
          poolId: topPoolId,
          laneId: meta.get(decoration.host)?.laneId ?? null,
          parentId: decoration.host,
        });
      } else if (decoration.kind === 'artifact') {
        meta.set(decoration.id, {
          type: decoration.subtype,
          poolId: topPoolId,
          laneId: null,
          parentId,
        });
      }
    }
    for (const sub of proc.subProcesses) walkProcess(sub, topPoolId, sub.id);
  };
  for (const proc of model.processes) walkProcess(proc, proc.id, null);
  return meta;
}

function collectDebugEdgeInputs(model: BpmnModel): SnapshotEdgeInput[] {
  const edges: SnapshotEdgeInput[] = [];
  const walkProcess = (proc: ProcessUnit): void => {
    for (const sf of proc.sequenceFlows) {
      edges.push({ id: sf.id, kind: 'sequenceFlow', source: sf.source, target: sf.target });
    }
    for (const decoration of proc.decorations) {
      if (decoration.kind === 'association' || decoration.kind === 'compensationAssociation') {
        edges.push({ id: decoration.id, kind: 'association', source: decoration.source, target: decoration.target });
      } else if (decoration.kind === 'messageFlow') {
        edges.push({ id: decoration.id, kind: 'messageFlow', source: decoration.source, target: decoration.target });
      }
    }
    for (const sub of proc.subProcesses) walkProcess(sub);
  };
  for (const proc of model.processes) walkProcess(proc);
  for (const mf of model.collaborationMessageFlows) {
    edges.push({ id: mf.id, kind: 'messageFlow', source: mf.source, target: mf.target });
  }
  return edges;
}

function enrichNodeMeta(
  base: Map<string, SnapshotNodeMeta>,
  nodeToPool: Map<string, string>,
  nodeToLane: Map<string, string | null>,
): Map<string, SnapshotNodeMeta> {
  const out = new Map(base);
  for (const [id, poolId] of nodeToPool) {
    const prev = out.get(id) ?? {};
    out.set(id, {
      ...prev,
      poolId,
      laneId: nodeToLane.get(id) ?? prev.laneId ?? null,
    });
  }
  return out;
}

function routeNodeMeta(
  routeNodes: Map<string, RouteInputNode>,
  base: Map<string, SnapshotNodeMeta>,
): Map<string, SnapshotNodeMeta> {
  const out = new Map(base);
  for (const [id, node] of routeNodes) {
    const prev = out.get(id) ?? {};
    out.set(id, {
      ...prev,
      type: node.type,
      poolId: node.poolId,
      laneId: node.laneId,
    });
  }
  return out;
}

function laneBandRects(
  lanes: Map<string, LaneBox & { poolId: string }>,
  pools: Map<string, PoolBox & { name?: string; isBlackBox?: boolean }>,
): Map<string, SnapshotRect> {
  const out = new Map<string, SnapshotRect>();
  for (const [laneId, lane] of lanes) {
    const pool = pools.get(lane.poolId);
    out.set(laneId, {
      x: pool?.x ?? 0,
      y: lane.top,
      w: pool?.w ?? 0,
      h: lane.height,
    });
  }
  return out;
}

function edgeKindForBpmn(kind: BpmnEdgeKind): SnapshotEdge['kind'] {
  if (kind === 'messageFlow') return 'messageFlow';
  if (kind === 'association'
    || kind === 'compensationAssociation') {
    return 'association';
  }
  return 'sequenceFlow';
}

function normalizePreviousBoxes(input: PreviousBoxesInput | undefined): PreviousBoxes {
  if (!input) return new Map();
  if (input instanceof Map) {
    for (const [id, box] of input) assertValidPreviousBox(id, box);
    return new Map(input);
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('[pipeline] previousBoxes must be an object keyed by node id or a Map');
  }
  const out = new Map<string, NodeBox>();
  for (const [id, value] of Object.entries(input)) {
    assertValidPreviousBox(id, value);
    out.set(id, value);
  }
  return out;
}

function assertValidPreviousBox(id: string, value: unknown): asserts value is NodeBox {
  if (!id) throw new Error('[pipeline] previousBoxes contains an empty node id');
  if (!value || typeof value !== 'object') {
    throw new Error(`[pipeline] previousBoxes.${id} must be a box object`);
  }
  const box = value as Partial<NodeBox>;
  for (const key of ['x', 'y', 'w', 'h'] as const) {
    if (typeof box[key] !== 'number' || !Number.isFinite(box[key])) {
      throw new Error(`[pipeline] previousBoxes.${id}.${key} must be a finite number`);
    }
  }
}
