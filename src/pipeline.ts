// Pipeline 胶水：串联 stages。
//
// 实际执行顺序（每个阶段一个 phase 函数，runPipeline 只编排不写算法）：
//   Loader                                         (JSON → BpmnModel)              phaseLoader
//   → SubprocessLayout (recursive, depth-first)    (展开 subprocess 内部局部坐标 + bbox)
//   → ElkPlacement + LaneConstrainer (per pool)    (节点局部坐标 → Y snap 到 lane 中线)
//   → PoolComposer (compose)                       (多 pool 垂直堆叠 → 绝对坐标)
//   → SubprocessTranslator                         (subprocess 内部局部 → 绝对坐标，递归)
//   → mini ElkPlacement (per handler subgraph)     (boundary handler 子图)
//   → DecorationPlacer                             (boundary event 骑边 + handler 平移)
//   → ArtifactPlacer                               (dataObject / textAnnotation 上下方)
//   → PoolOverflowRebalancer                       (BE/handler/artifact 溢出 pool 时整体下推 + 撑宽)
//   → IncrementalStabilizer                        (previousBoxes 稳定化)
//   → EdgeRouter                                   (所有节点位置已知后路由 edges)
//   → AssociationRouter                            (artifact ↔ host 的 association 边)
//   → Merger                                       (所有输出 → LayoutedGraph JSON)
//   → Serializer (在 service.ts 中)                 (JSON → BPMN 2.0 XML)
//
// 约束：本文件只做装配。phase 之间通过 PipelineContext（plain data）传递；
// 每个 phase 经 runStage 包裹，逃逸错误带权威 stage 名（ICE 归属不依赖 message 前缀）。

import { loadFixture } from './loader/loader.ts';
import type { ValidationProfile } from './loader/validate-graph.ts';
import type { BpmnModel, ProcessUnit, SequenceFlow } from './loader/types.ts';
import { nodeSizeOf, ioSpecDataObjectBoxes, ioSpecExtraBelow, layoutHeightWithIoSpec, taskWidthForLabel, TASK_W, TASK_H } from './layout/node-sizes.ts';
import { leafLaneOrder, nodeToLeafLane } from './layout/lane-resolver.ts';
import { runStage } from './errors.ts';
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
import { boundaryRuleFor, hostWidthForBoundaries, type BpmnEdgeKind } from './stages/bpmn-rules.ts';
// 所有 stage 入口从契约注册表 (./stages/index.ts) 单点 import
import {
  // HandlerSubgraph（纯图算法，已从 pipeline 抽出）
  mainFlowReachable,
  collectHandlerSubgraph,
  // SubprocessLayout
  collectSubprocessLayouts,
  type SubprocessLayout,
  SUBPROCESS_PADDING_TOP, SUBPROCESS_PADDING_BOTTOM,
  SUBPROCESS_PADDING_LEFT, SUBPROCESS_PADDING_RIGHT,
  // SubprocessTranslator
  translateSubprocesses,
  type SubprocessTranslateOutput,
  // PoolOverflowRebalancer
  rebalancePoolOverflow,
  // BackEdgeResolver
  resolveBackEdgesForElk,
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
  type ComposeOutput,
  // DecorationPlacer
  placeDecorations,
  type DecorationOutput,
  // ArtifactPlacer
  placeArtifacts,
  type ArtifactInputArtifact,
  type ArtifactInputAssociation,
  type ArtifactOutput,
  // EdgeRouter
  routeEdges,
  type RouteInput,
  type RouteInputEdge,
  type RouteInputNode,
  type RouteInputObstacle,
  type RouteOutput,
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
  type IncrementalStabilizeOutput,
  // Merger
  merge,
  // shared atoms
  type NodeBox,
  type NodeLayoutBox,
  type EdgeRoute,
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

// handler 节点的 semiInteractive y hint 基值：远大于任何主流节点的自然行 y，
// 让 ELK 在同层排序时把所有 handler 分支排到主流下方（P3 去分片的侧别保证）。
const HANDLER_POSITION_Y_HINT = 100_000;

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
  /** 校验 profile = 源语言。默认 'generation'（最严）；relayout 路径传 'relayout' 跳过生成专属规则。 */
  validationProfile?: ValidationProfile;
}

// ============================================================
// PipelineContext：phase 之间传递的全部 plain data
// ============================================================
//
// 每个 phase 读写这个对象（填自己负责的字，读上游阶段的字），runPipeline 只做装配。
// 字段按执行顺序排列；`!` 标记的由对应 phase 写入、后续 phase 才可读。

interface PipelineContext {
  // —— 输入与贯穿收集器 ——
  rawJson: any;
  fixtureLabel: string;
  model: BpmnModel;
  layoutConstraints: LayoutConstraint[];
  layoutDecisions: LayoutDecision[];
  previousBoxes: PreviousBoxes;
  stageSnapshots?: StageSnapshot[];
  debugNodeMeta?: Map<string, SnapshotNodeMeta>;
  debugInputEdges?: SnapshotEdgeInput[];

  // —— SubprocessLayout ——
  subprocessLayouts: Map<string, SubprocessLayout>;

  // —— ElkPlacement + LaneConstrainer ——
  poolInputs: ComposeInputPool[];
  mainReachablePerProc: Map<string, Set<string>>;
  elkShapes: ElkShape[];

  // —— PoolComposer ——
  compose?: ComposeOutput;

  // —— SubprocessTranslator ——
  expandedInnerNodes?: SubprocessTranslateOutput['innerNodeBoxes'];
  expandedInnerEdgeIds?: SubprocessTranslateOutput['innerEdgeIds'];

  // —— handler 图分析（P3 去分片后不再 mini-ELK，只识别归属） ——
  handlerNodeIdsPerProc: Map<string, Set<string>>;
  handlerNodeMeta: Map<string, { hostId: string; procId: string }>;
  beToHandlerEntry: Map<string, string>;
  compensationHandlerEdges: { id: string; source: string; target: string; bpmnType: BpmnEdgeKind; host: string; procId: string }[];

  // —— DecorationPlacer ——
  boundaryEvents: { id: string; hostId: string; idx: number }[];
  decoration?: DecorationOutput;

  // —— ArtifactPlacer ——
  associationsIn: ArtifactInputAssociation[];
  artifactOut?: ArtifactOutput;

  // —— IncrementalStabilizer ——
  incremental?: IncrementalStabilizeOutput;

  // —— EdgeRouter / AssociationRouter ——
  routes?: RouteOutput;
  allRoutes?: Map<string, EdgeRoute>;
  /** edge-router 的输入快照，association-router 的 debug snapshot 复用（仅 debug 开启时有值） */
  routeNodesForAssoc?: Map<string, RouteInputNode>;
  routeEdgesListForAssoc?: RouteInputEdge[];

  // —— Merger ——
  graph?: LayoutedGraph;

  // —— 计时 ——
  ms: {
    placement: number;
    constrain: number;
    compose: number;
    handlers: number;
    route: number;
    merge: number;
  };
}

export async function runPipeline(
  rawJson: any,
  fixtureLabel = 'request',
  options: LayoutOptions = {},
): Promise<PipelineOutput> {
  const t0 = performance.now();
  const model: BpmnModel = await runStage('loader', () => loadFixture(fixtureLabel, rawJson, {
    validationProfile: options.validationProfile,
  }));
  const stageSnapshots = shouldCollectStageSnapshots(options) ? [] as StageSnapshot[] : undefined;
  const ctx: PipelineContext = {
    rawJson,
    fixtureLabel,
    model,
    layoutConstraints: [],
    layoutDecisions: [],
    previousBoxes: normalizePreviousBoxes(options.previousBoxes),
    stageSnapshots,
    debugNodeMeta: stageSnapshots ? collectDebugNodeMeta(model) : undefined,
    debugInputEdges: stageSnapshots ? collectDebugEdgeInputs(model) : undefined,
    subprocessLayouts: new Map(),
    poolInputs: [],
    mainReachablePerProc: new Map(),
    elkShapes: [],
    handlerNodeIdsPerProc: new Map(),
    handlerNodeMeta: new Map(),
    beToHandlerEntry: new Map(),
    compensationHandlerEdges: [],
    boundaryEvents: [],
    associationsIn: [],
    ms: { placement: 0, constrain: 0, compose: 0, handlers: 0, route: 0, merge: 0 },
  };

  await runStage('subprocess-layout', () => phaseSubprocessLayout(ctx));
  await runStage('graph-analysis', () => phaseGraphAnalysis(ctx));
  await runStage('elk-placement', () => phaseElkPlacementAndLanes(ctx));
  await runStage('pool-composer', () => phasePoolComposer(ctx));
  await runStage('subprocess-translator', () => phaseSubprocessTranslator(ctx));
  await runStage('decoration-placer', () => phaseDecorationPlacer(ctx));
  await runStage('artifact-placer', () => phaseArtifactPlacer(ctx));
  await runStage('pool-overflow-rebalancer', () => phasePoolOverflowRebalancer(ctx));
  await runStage('incremental-stabilizer', () => phaseIncrementalStabilizer(ctx));
  await runStage('edge-router', () => phaseEdgeRouter(ctx));
  await runStage('association-router', () => phaseAssociationRouter(ctx));
  await runStage('merger', () => phaseMerger(ctx));

  const msTotal = performance.now() - t0;
  const byEdgeType: Record<string, number> = {};
  for (const r of ctx.routes!.routes.values()) {
    byEdgeType[r.edgeType] = (byEdgeType[r.edgeType] ?? 0) + 1;
  }
  const decisionCount = ctx.layoutDecisions.length;

  return {
    graph: ctx.graph!,
    trace: {
      routeCount: ctx.routes!.routes.size, byEdgeType,
      constraints: ctx.layoutConstraints,
      constraintSummary: summarizeConstraints(ctx.layoutConstraints),
      decisions: ctx.layoutDecisions.slice(0, MAX_TRACE_DECISIONS),
      decisionCount,
      decisionsTruncated: decisionCount > MAX_TRACE_DECISIONS,
      incremental: {
        previousBoxCount: ctx.previousBoxes.size,
        appliedCount: ctx.incremental!.appliedCount,
        skippedCount: ctx.incremental!.skippedCount,
      },
      elkShape: ctx.elkShapes,
      ...(stageSnapshots ? { stageSnapshots } : {}),
      msPlacement: ctx.ms.placement,
      msConstrain: ctx.ms.constrain,
      msCompose: ctx.ms.compose,
      msHandlers: ctx.ms.handlers,
      msRoute: ctx.ms.route,
      msMerge: ctx.ms.merge,
      msTotal,
    },
  };
}

// ============= SubprocessLayout: 递归展开 subprocess 内部 =============
// 每个 isExpanded=true 的 subprocess 跑一次 mini ELK，得到内部局部坐标 + bbox。
// 嵌套：深度优先，最内层先跑，外层用内层 size 作 override。
async function phaseSubprocessLayout(ctx: PipelineContext): Promise<void> {
  for (const proc of ctx.model.processes) {
    if (proc.isBlackBox) continue;
    await collectSubprocessLayouts(proc, ctx.subprocessLayouts);
  }
}

// ============= ElkPlacement + LaneConstrainer (per pool) =============
async function phaseElkPlacementAndLanes(ctx: PipelineContext): Promise<void> {
  const { model, layoutDecisions, stageSnapshots, debugNodeMeta, debugInputEdges } = ctx;
  const debugElkNodes = stageSnapshots ? new Map<string, NodeBox>() : undefined;
  const debugElkPools = stageSnapshots ? new Map<string, SnapshotRect>() : undefined;
  const debugLaneNodes = stageSnapshots ? new Map<string, NodeBox>() : undefined;
  const debugLanePools = stageSnapshots ? new Map<string, SnapshotRect>() : undefined;
  const debugLaneRects = stageSnapshots ? new Map<string, SnapshotRect>() : undefined;

  for (const proc of model.processes) {
    if (proc.isBlackBox || proc.flowNodes.length === 0) {
      ctx.poolInputs.push({
        id: proc.id, name: proc.name, isBlackBox: proc.isBlackBox,
        nodes: new Map(), laneBoxes: new Map(), leafOrder: [], allLanes: [], width: 200, height: 60,
      });
      continue;
    }
    const mainReachable = ctx.mainReachablePerProc.get(proc.id);
    if (!mainReachable) throw new Error(`[pipeline] mainReachable missing for process ${proc.id} (graph-analysis must run before elk-placement)`);
    // P3 去分片：handler 节点并入主图一次 ELK。children 里 handler 节点排在主流之后——
    // considerModelOrder=NODES_AND_EDGES 让 handler 分支落在 host 下方而不是上方。
    const handlerIds = ctx.handlerNodeIdsPerProc.get(proc.id) ?? new Set<string>();
    const flowNodesForElk = [
      ...proc.flowNodes.filter(n => mainReachable.has(n.id)),
      ...proc.flowNodes.filter(n => !mainReachable.has(n.id) && handlerIds.has(n.id)),
    ];
    const elkNodeIds = new Set(flowNodesForElk.map(n => n.id));
    // BE 不是 ELK 节点（它骑在 host 上）：BE→handlerEntry 边以 host 名义喂 ELK，
    // handler 才成为 host 的下游（分层自然成立），汇回主流的边也变普通分层。
    const beHostById = new Map<string, string>();
    for (const d of proc.decorations) {
      if (d.kind === 'boundaryEvent') beHostById.set(d.id, d.host);
    }
    const elkFlows: Array<{ id: string; source: string; target: string; isDefault?: boolean; name?: string }> = [];
    for (const sf of proc.sequenceFlows) {
      const source = beHostById.get(sf.source) ?? sf.source;
      if (!elkNodeIds.has(source) || !elkNodeIds.has(sf.target)) continue;
      elkFlows.push({ id: sf.id, source, target: sf.target, isDefault: sf.isDefault, name: sf.name });
    }
    // compensation BE 的 handler 经 association 连接：补 host→handler 虚拟边，让 ELK 分层带上它
    for (const ce of ctx.compensationHandlerEdges) {
      if (ce.procId !== proc.id) continue;
      if (!elkNodeIds.has(ce.host) || !elkNodeIds.has(ce.target)) continue;
      elkFlows.push({ id: ce.id, source: ce.host, target: ce.target });
    }

    // 自主断环：识别回头边并预反转，保证喂 ELK 的图无环（ELK GREEDY 对双环结构会断错）。
    const { edges: elkEdges, reversedIds: reversedEdgeIds } = resolveBackEdgesForElk(flowNodesForElk, elkFlows);
    for (const sf of elkFlows) {
      if (!reversedEdgeIds.has(sf.id)) continue;
      layoutDecisions.push({
        stage: 'BackEdgeResolver',
        kind: 'back-edge-reverse',
        subject: { kind: 'edge', id: sf.id },
        reason: 'Semantic back-edge detection reversed this loop edge before ELK to keep the fed graph acyclic',
        input: { source: sf.source, target: sf.target, isDefault: sf.isDefault ?? false, label: sf.name ?? null },
        output: { reversedForElk: true },
      });
    }

    // B3: 算 in/out degree——ELK 的 layerConstraint=FIRST 要求 0 入度、LAST 要求 0 出度。
    // BPMN 中偶尔会有"end event 后还连了 boundary 补偿"等异常拓扑（见 fixture 37），不能盲加约束。
    // 用预反转后的有效方向算（ELK 看到的就是这个方向）。
    const inDegElk = new Map<string, number>();
    const outDegElk = new Map<string, number>();
    for (const sf of elkFlows) {
      const src = reversedEdgeIds.has(sf.id) ? sf.target : sf.source;
      const tgt = reversedEdgeIds.has(sf.id) ? sf.source : sf.target;
      outDegElk.set(src, (outDegElk.get(src) ?? 0) + 1);
      inDegElk.set(tgt, (inDegElk.get(tgt) ?? 0) + 1);
    }

    const placementIn: PlacementInput = {
      processId: proc.id,
      hasLanes: proc.lanes.length > 0,
      hasBoundaryHandlers: proc.decorations.some(d => d.kind === 'boundaryEvent'),
      nodes: flowNodesForElk.map((n, nodeIdx) => {
        // handler 节点压到 host 下方（见 elk-placement 的 positionYHint 说明）。
        // 递增值让多个 handler 分支之间保持声明顺序（83 的 5 个 BE 对应 5 条 handler 链）。
        const positionYHint = handlerIds.has(n.id) ? HANDLER_POSITION_Y_HINT + nodeIdx : undefined;
        // B3: start event 锁最左 layer，end event 锁最右 layer——保证 F1 主流方向一致。
        // 仅当拓扑合规（start 无入边、end 无出边）时加约束；否则 ELK 会抛 UnsupportedConfigurationException。
        let layerConstraint: 'first' | 'last' | undefined;
        if (n.type === 'startEvent' && (inDegElk.get(n.id) ?? 0) === 0) layerConstraint = 'first';
        else if (n.type === 'endEvent' && (outDegElk.get(n.id) ?? 0) === 0) layerConstraint = 'last';

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

        // 展开 subprocess 用内部 bbox 决定的尺寸（含 padding）
        if (n.isExpanded) {
          const inner = ctx.subprocessLayouts.get(n.id);
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
              layerConstraint,
              positionYHint,
            };
          }
        }
        const size = nodeSizeOf(n.type);
        // B1：BE 中心要骑在 host 底边上，host 太窄装不下所有 BE 时按 BE 数撑宽
        // （83：5 个 BE 在 100 宽 host 上，后两个中心掉出右边缘）。撑宽必须发生在
        // ELK 之前，lane/pool 尺寸才按真宽算。
        // 长 label 同理撑宽（88 的文字汤：31 字塞 100 宽盒换行 6+ 行溢出盒外）。
        const w = Math.max(
          size.w,
          hostWidthForBoundaries(n.boundaryEventIds.length),
          // 只有盒内文字节点才按 label 撑宽（event/gateway 是外置 label，尺寸有 N4 硬性
          // 36×36 / 50×50——98 的 event 被误撑成 56×36 的教训）。
          size.w === TASK_W && size.h === TASK_H
            ? taskWidthForLabel(n.name, size.w)
            : size.w,
        );
        return {
          id: n.id,
          type: n.type,
          w,
          h: size.h,
          layoutH: layoutHeightWithIoSpec(size.h, n.ioInputCount, n.ioOutputCount, n.ioInputNames, n.ioOutputNames, w),
          layerConstraint,
          positionYHint,
        };
      }),
      edges: elkEdges,
    };
    const tp = performance.now();
    const placement = await elkPlacement(placementIn);
    ctx.ms.placement += performance.now() - tp;
    ctx.elkShapes.push(placement.shape);
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
      boundaryHosts: new Set(proc.flowNodes.filter(fn => fn.boundaryEventIds.length > 0).map(fn => fn.id)),
    });
    ctx.ms.constrain += performance.now() - tc;

    // B2: 压缩明显的层间空白。Y 不动、节点大小不动，仅减少 X 间距。
    // 跑在 lane-constrainer 后是关键：lane 高度已确定，X 收紧不会让节点出 lane。
    // no-lane pool 的 ELK wrap 已全局 OFF（见 elk-placement.ts），超长纯单链统一由
    // compactor 的 wrapLinearChain 保守折行控宽。
    const compacted = compact({
      nodes: constrain.nodes,
      edges: edgesForLane,
      nodeMeta: nodeMetaForLane,
      wrapLinearChain: proc.lanes.length === 0,
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

    ctx.poolInputs.push({
      id: proc.id, name: proc.name, isBlackBox: false,
      nodes: finalNodes, laneBoxes: constrain.laneBoxes,
      leafOrder: constrain.leafOrder, allLanes: constrain.allLanes,
      width: finalWidth, height: finalHeight,
    });
  }
  if (stageSnapshots) {
    pushSnapshot(ctx, createStageSnapshot({
      fixture: ctx.fixtureLabel,
      stage: 'elk-placement',
      order: stageSnapshots.length,
      nodes: debugElkNodes,
      nodeMeta: debugNodeMeta,
      edges: debugInputEdges,
      pools: debugElkPools,
      notes: ['ELK output uses process-local coordinates before lane snap and pool composition.'],
    }));
    pushSnapshot(ctx, createStageSnapshot({
      fixture: ctx.fixtureLabel,
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
}

// ============= PoolComposer =============
function phasePoolComposer(ctx: PipelineContext): void {
  const { model, layoutConstraints, layoutDecisions, stageSnapshots, debugNodeMeta, debugInputEdges } = ctx;
  // 提前收集 node → pool 映射用于 cross-pool X 对齐
  const nodeToPoolForCompose = new Map<string, string>();
  for (const proc of model.processes) {
    for (const fn of proc.flowNodes) nodeToPoolForCompose.set(fn.id, proc.id);
  }
  const tCo = performance.now();
  const compose = poolCompose({
    pools: ctx.poolInputs,
    messageFlows: model.collaborationMessageFlows,
    nodeToPool: nodeToPoolForCompose,
  });
  ctx.ms.compose = performance.now() - tCo;
  ctx.compose = compose;
  layoutConstraints.push(...collectPoolStackConstraints(compose.poolBoxes));
  layoutDecisions.push(...collectPoolStackDecisions(compose.poolBoxes));
  if (stageSnapshots) {
    pushSnapshot(ctx, createStageSnapshot({
      fixture: ctx.fixtureLabel,
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
}

// ============= SubprocessTranslator =============
// 顶层 expanded subprocess 的 abs box 来自 compose.nodes；stage 负责递归内层 + 把
// SubprocessLayout 局部坐标平移到绝对坐标。
function phaseSubprocessTranslator(ctx: PipelineContext): void {
  const { model, stageSnapshots, debugNodeMeta, debugInputEdges } = ctx;
  const compose = ctx.compose!;
  const topLevelExpansions: Array<{ subId: string; absBox: NodeBox }> = [];
  for (const proc of model.processes) {
    for (const fn of proc.flowNodes) {
      if (!fn.isExpanded) continue;
      if (!ctx.subprocessLayouts.has(fn.id)) continue;
      const box = compose.nodes.get(fn.id);
      if (!box) continue;
      topLevelExpansions.push({ subId: fn.id, absBox: box });
    }
  }
  const translated = translateSubprocesses({ subprocessLayouts: ctx.subprocessLayouts, topLevelExpansions });
  ctx.expandedInnerNodes = translated.innerNodeBoxes;
  ctx.expandedInnerEdgeIds = translated.innerEdgeIds;
  if (stageSnapshots) {
    const nodes = new Map<string, NodeBox>(compose.nodes);
    mergeNodeBoxes(nodes, ctx.expandedInnerNodes!);
    pushSnapshot(ctx, createStageSnapshot({
      fixture: ctx.fixtureLabel,
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
}

// ============= 图分析：mainReachable + handler 子图识别（纯图，不摆位） =============
// P3 去分片：handler 节点不再单独 mini-ELK 再平移拼接（主图和 handler 子图各算一套坐标，
// 片与片之间有边就出 N 形回头/出 lane/负坐标——80/96/77/83 一族），而是并入主 ELK 一次摆位。
// 本 phase 只做图分析：
//   - mainReachable（哪些节点是主流；handler 节点 = flowNodes − mainReachable − 游离）
//   - 每个 BE 的 handler 节点集（EdgeRouter 分类、DecorationPlacer 决定骑边侧要用）
//   - BE→handler 入口映射（骑边侧判定）+ compensation BE 的 association 虚拟连接边
function phaseGraphAnalysis(ctx: PipelineContext): void {
  const { model } = ctx;
  for (const proc of model.processes) {
    if (proc.isBlackBox) continue;
    let mainReachable = mainFlowReachable(proc.flowNodes, proc.sequenceFlows);
    // Fallback：没有 startEvent 的 process（如纯 event-subprocess 容器），把所有非 BE 节点都纳入 ELK。
    if (mainReachable.size === 0) {
      mainReachable = new Set(proc.flowNodes.filter(n => n.type !== 'boundaryEvent').map(n => n.id));
    }
    ctx.mainReachablePerProc.set(proc.id, mainReachable);

    const claimed = new Set<string>();
    // 预先索引该 proc 内的 association decorations（key=source）
    const assocBySource = new Map<string, { id: string; target: string }[]>();
    for (const d of proc.decorations) {
      if (d.kind !== 'association') continue;
      if (!assocBySource.has(d.source)) assocBySource.set(d.source, []);
      assocBySource.get(d.source)!.push({ id: d.id, target: d.target });
    }
    const handlerIds = new Set<string>();
    for (const dec of proc.decorations) {
      if (dec.kind !== 'boundaryEvent') continue;
      const sg = collectHandlerSubgraph(dec.id, dec.host, proc.sequenceFlows, mainReachable, claimed);

      // compensation BE → 触发的活动是通过 association 而不是 sequenceFlow 连接。
      // 把 association 当作 BE→handler 的"虚拟连接边"：喂 ELK 时改记 host→handler（让 handler
      // 成为 host 的下游），喂 EdgeRouter 时保持 BE→handler（按 connectorKind 画直线）。
      if (sg.nodes.size === 0 && dec.eventType === 'compensation') {
        const assocs = assocBySource.get(dec.id) ?? [];
        const connectorKind = boundaryRuleFor(dec.eventType).connectorKind;
        for (const a of assocs) {
          if (mainReachable.has(a.target) || claimed.has(a.target)) continue;
          sg.nodes.add(a.target);
          ctx.compensationHandlerEdges.push({ id: a.id, source: dec.id, target: a.target, bpmnType: connectorKind, host: dec.host, procId: proc.id });
        }
      }

      if (sg.nodes.size === 0) continue; // BE 无 handler

      // 找入口节点：BE 直接 target
      const entry = proc.sequenceFlows.find(sf => sf.source === dec.id);
      if (entry) ctx.beToHandlerEntry.set(dec.id, entry.target);

      for (const id of sg.nodes) claimed.add(id);
      for (const id of sg.nodes) ctx.handlerNodeMeta.set(id, { hostId: dec.host, procId: proc.id });
      for (const id of sg.nodes) handlerIds.add(id);
    }
    ctx.handlerNodeIdsPerProc.set(proc.id, handlerIds);
  }
}

// ============= DecorationPlacer =============
function phaseDecorationPlacer(ctx: PipelineContext): void {
  const { model, layoutConstraints, layoutDecisions, stageSnapshots, debugNodeMeta, debugInputEdges } = ctx;
  const compose = ctx.compose!;
  for (const proc of model.processes) {
    const byHost = new Map<string, number>();
    for (const dec of proc.decorations) {
      if (dec.kind !== 'boundaryEvent') continue;
      const i = byHost.get(dec.host) ?? 0;
      ctx.boundaryEvents.push({ id: dec.id, hostId: dec.host, idx: i });
      byHost.set(dec.host, i + 1);
    }
  }
  // BE 骑哪条边朝 handler 入口所在侧定（P3 后 handler 与主图同坐标系，直接读主图坐标）。
  const handlerEntryBoxes = new Map<string, NodeBox>();
  for (const [beId, entryId] of ctx.beToHandlerEntry) {
    const box = compose.nodes.get(entryId);
    if (box) handlerEntryBoxes.set(beId, box);
  }
  for (const ce of ctx.compensationHandlerEdges) {
    const box = compose.nodes.get(ce.target);
    if (box) handlerEntryBoxes.set(ce.source, box);
  }
  const decoration = placeDecorations({
    hostBoxes: compose.nodes,
    boundaryEvents: ctx.boundaryEvents,
    handlerEntryBoxes,
  });
  ctx.decoration = decoration;
  layoutConstraints.push(...collectBoundaryConstraints({ boundaryEvents: ctx.boundaryEvents }));
  layoutDecisions.push(...collectBoundaryDecisions({
    boundaryEvents: ctx.boundaryEvents,
    boundaryEventBoxes: decoration.boundaryEventBoxes,
  }));
  if (stageSnapshots) {
    const nodes = new Map<string, NodeBox>(compose.nodes);
    mergeNodeBoxes(nodes, ctx.expandedInnerNodes!);
    mergeNodeBoxes(nodes, decoration.boundaryEventBoxes);
    pushSnapshot(ctx, createStageSnapshot({
      fixture: ctx.fixtureLabel,
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
}

// ============= ArtifactPlacer =============
function phaseArtifactPlacer(ctx: PipelineContext): void {
  const { model, stageSnapshots, debugNodeMeta, debugInputEdges } = ctx;
  const compose = ctx.compose!;
  const artifactsIn: ArtifactInputArtifact[] = [];
  for (const proc of model.processes) {
    for (const dec of proc.decorations) {
      if (dec.kind === 'artifact') {
        artifactsIn.push({ id: dec.id, subtype: dec.subtype, width: dec.width, height: dec.height });
      } else if (dec.kind === 'association') {
        ctx.associationsIn.push({ id: dec.id, subtype: dec.subtype, source: dec.source, target: dec.target });
      }
    }
  }
  const artifactOut = placeArtifacts({
    flowNodeBoxes: compose.nodes,
    artifacts: artifactsIn,
    associations: ctx.associationsIn,
  });
  ctx.artifactOut = artifactOut;
  if (stageSnapshots) {
    const nodes = new Map<string, NodeBox>(compose.nodes);
    mergeNodeBoxes(nodes, ctx.expandedInnerNodes!);
    mergeNodeBoxes(nodes, ctx.decoration!.boundaryEventBoxes);
    mergeNodeBoxes(nodes, artifactOut.artifactBoxes);
    pushSnapshot(ctx, createStageSnapshot({
      fixture: ctx.fixtureLabel,
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
}

// ============= PoolOverflowRebalancer =============
// 收集各类 box → host → pool 的归属映射，喂给 rebalancer。stage 会原地改 box 的 .y / .h /
// pool 的 .y / .h / .w，并返回新的 totalBounds。
function phasePoolOverflowRebalancer(ctx: PipelineContext): void {
  const { model, stageSnapshots, debugNodeMeta, debugInputEdges } = ctx;
  const compose = ctx.compose!;
  const artifactHosts = new Map<string, string>();
  for (const [aid, meta] of ctx.artifactOut!.artifactSides) artifactHosts.set(aid, meta.hostId);
  const boundaryEventHosts = new Map<string, string>();
  for (const be of ctx.boundaryEvents) boundaryEventHosts.set(be.id, be.hostId);
  const handlerNodeHosts = new Map<string, string>();
  for (const [nodeId, meta] of ctx.handlerNodeMeta) handlerNodeHosts.set(nodeId, meta.hostId);
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
  for (const p of ctx.poolInputs) {
    const bottomLaneId = p.leafOrder[p.leafOrder.length - 1];
    if (bottomLaneId) bottomLaneByPool.set(p.id, bottomLaneId);
  }

  const rebalanced = rebalancePoolOverflow({
    poolBoxes: compose.poolBoxes,
    totalBounds: compose.totalBounds,
    nodes: compose.nodes,
    laneBoxes: compose.laneBoxes,
    expandedInnerNodes: ctx.expandedInnerNodes!,
    artifactBoxes: ctx.artifactOut!.artifactBoxes,
    boundaryEventBoxes: ctx.decoration!.boundaryEventBoxes,
    handlerNodeBoxes: new Map(),
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
    mergeNodeBoxes(nodes, ctx.expandedInnerNodes!);
    mergeNodeBoxes(nodes, ctx.decoration!.boundaryEventBoxes);
    mergeNodeBoxes(nodes, ctx.artifactOut!.artifactBoxes);
    pushSnapshot(ctx, createStageSnapshot({
      fixture: ctx.fixtureLabel,
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
}

// ============= IncrementalStabilizer =============
function phaseIncrementalStabilizer(ctx: PipelineContext): void {
  const { layoutConstraints, layoutDecisions } = ctx;
  const compose = ctx.compose!;
  const incrementalNodeMeta = new Map<string, IncrementalNodeMeta>();
  for (const [nodeId] of compose.nodes) {
    incrementalNodeMeta.set(nodeId, {
      poolId: compose.nodeToPool.get(nodeId) ?? '',
      laneId: compose.nodeToLane.get(nodeId) ?? null,
    });
  }
  const incremental = stabilizeWithPreviousBoxes({
    nodes: compose.nodes,
    previousBoxes: ctx.previousBoxes,
    nodeMeta: incrementalNodeMeta,
    poolBoxes: compose.poolBoxes,
    laneBoxes: compose.laneBoxes,
  });
  ctx.incremental = incremental;
  compose.nodes = incremental.nodes;
  layoutConstraints.push(...incremental.constraints);
  layoutDecisions.push(...incremental.decisions);
}

// ============= EdgeRouter =============
function phaseEdgeRouter(ctx: PipelineContext): void {
  const { model, layoutConstraints } = ctx;
  const compose = ctx.compose!;
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

  for (const [innerId, innerBox] of ctx.expandedInnerNodes!) {
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
  for (const [beId, beBox] of ctx.decoration!.boundaryEventBoxes) {
    // 找 BE 的 host 来推断 pool/lane
    const meta = ctx.boundaryEvents.find(b => b.id === beId);
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
  layoutConstraints.push(...collectContainmentConstraints({
    nodes: Array.from(routeNodes, ([id, n]) => ({
      id,
      poolId: n.poolId || null,
      laneId: n.laneId,
    })),
    lanes: Array.from(compose.laneBoxes, ([id, lane]) => ({ id, poolId: lane.poolId })),
  }));

  const routeEdgesList: RouteInputEdge[] = [];
  const innerEdgeIdSet = new Set(ctx.expandedInnerEdgeIds!);
  // 主流 sequenceFlows
  for (const proc of model.processes) {
    for (const sf of proc.sequenceFlows) {
      if (!routeNodes.has(sf.source) || !routeNodes.has(sf.target)) continue;
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
  // compensation BE → handler activity（association，但走 boundary-to-handler 路径）
  for (const ce of ctx.compensationHandlerEdges) {
    if (!routeNodes.has(ce.source) || !routeNodes.has(ce.target)) continue;
    routeEdgesList.push({ id: ce.id, source: ce.source, target: ce.target, bpmnType: ce.bpmnType });
  }
  // collaboration messageFlows
  for (const mf of model.collaborationMessageFlows) {
    if (!routeNodes.has(mf.source) || !routeNodes.has(mf.target)) continue;
    routeEdgesList.push({ id: mf.id, source: mf.source, target: mf.target, bpmnType: 'messageFlow' });
  }

  const routeObstacles: RouteInputObstacle[] = [];
  const innerNodeOwnerPool = new Map<string, string>();
  for (const proc of model.processes) {
    (function walk(p: ProcessUnit) {
      for (const fn of p.flowNodes) innerNodeOwnerPool.set(fn.id, proc.id);
      for (const sub of p.subProcesses) walk(sub);
    })(proc);
  }
  for (const proc of model.processes) {
    (function walk(p: ProcessUnit) {
      for (const fn of p.flowNodes) {
        if (fn.ioInputCount <= 0 && fn.ioOutputCount <= 0) continue;
        const hostBox = compose.nodes.get(fn.id) ?? ctx.expandedInnerNodes!.get(fn.id);
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
  // artifact（annotation / dataObject）对 sequence flow 同样是障碍——E2 检测把它们当节点。
  // 折行链的回绕下行段会从 annotation 正中穿过（06-artifacts-extended flow_4 切 annotation_sla）。
  // 归属 pool 取 host 节点的 pool。
  for (const [aid, box] of ctx.artifactOut!.artifactBoxes) {
    const hostId = ctx.artifactOut!.artifactSides.get(aid)?.hostId;
    const poolId = hostId ? (compose.nodeToPool.get(hostId) ?? innerNodeOwnerPool.get(hostId)) : undefined;
    if (!poolId) continue;
    routeObstacles.push({ box, poolId });
  }

  const routeInput: RouteInput = {
    nodes: routeNodes,
    edges: routeEdgesList,
    laneBoxes: compose.laneBoxes,
    poolBoxes: compose.poolBoxes,
    routeObstacles,
  };
  ctx.routeNodesForAssoc = routeNodes;
  ctx.routeEdgesListForAssoc = routeEdgesList;
  const tR = performance.now();
  const routes = routeEdges(routeInput);
  ctx.ms.route = performance.now() - tR;
  ctx.routes = routes;
}

// ============= AssociationRouter =============
function phaseAssociationRouter(ctx: PipelineContext): void {
  const { layoutConstraints, layoutDecisions, stageSnapshots, debugNodeMeta } = ctx;
  const compose = ctx.compose!;
  const assocEdgesIn: AssociationEdgeInput[] = [];
  for (const assoc of ctx.associationsIn) {
    // 找 artifact 端
    const srcSide = ctx.artifactOut!.artifactSides.get(assoc.source);
    const tgtSide = ctx.artifactOut!.artifactSides.get(assoc.target);
    const srcBox = ctx.artifactOut!.artifactBoxes.get(assoc.source) ?? compose.nodes.get(assoc.source);
    const tgtBox = ctx.artifactOut!.artifactBoxes.get(assoc.target) ?? compose.nodes.get(assoc.target);
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
    ...ctx.decoration!.boundaryEventBoxes.values(),
    ...ctx.expandedInnerNodes!.values(),
    // artifact 自身（annotation / dataObject）也是障碍：两个 artifact 之间的 association
    // 不能直穿第三个 artifact（06-artifacts-extended 的 E2）。router 会排除边的两端 box。
    ...ctx.artifactOut!.artifactBoxes.values(),
  ];
  const assocRoutes = routeAssociations({ edges: assocEdgesIn, obstacles: associationObstacles });

  // 合并 routes
  const allRoutes = new Map(ctx.routes!.routes);
  for (const [id, r] of assocRoutes.routes) allRoutes.set(id, r);
  ctx.allRoutes = allRoutes;
  layoutConstraints.push(...collectRouteConstraints(allRoutes));
  layoutDecisions.push(...collectRouteDecisions(allRoutes));
  if (stageSnapshots) {
    const nodes = new Map<string, NodeBox>();
    for (const [id, n] of ctx.routeNodesForAssoc!) nodes.set(id, n.box);
    mergeNodeBoxes(nodes, ctx.artifactOut!.artifactBoxes);
    const routeEdgeMeta = new Map<string, { source: string; target: string; kind: SnapshotEdge['kind'] }>();
    for (const edge of ctx.routeEdgesListForAssoc!) {
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
    pushSnapshot(ctx, createStageSnapshot({
      fixture: ctx.fixtureLabel,
      stage: 'edge-router',
      order: stageSnapshots.length,
      nodes,
      nodeMeta: routeNodeMeta(ctx.routeNodesForAssoc!, debugNodeMeta!),
      edges: edgeSnapshots,
      pools: compose.poolBoxes,
      lanes: laneBandRects(compose.laneBoxes, compose.poolBoxes),
      notes: ['All edge waypoints and ports are absolute coordinates after EdgeRouter plus AssociationRouter.'],
    }));
  }
}

// ============= Merger =============
function phaseMerger(ctx: PipelineContext): void {
  const { stageSnapshots } = ctx;
  const compose = ctx.compose!;
  // 合并所有节点位置 → allNodes（含 handler / artifact / 展开 subprocess 内部）
  const allNodesForMerge = new Map<string, NodeBox>(compose.nodes);
  for (const [id, b] of ctx.artifactOut!.artifactBoxes) allNodesForMerge.set(id, b);
  for (const [id, b] of ctx.expandedInnerNodes!) allNodesForMerge.set(id, b);

  const tM = performance.now();
  const graph = merge({
    raw: ctx.rawJson,
    nodes: allNodesForMerge,
    boundaryEventBoxes: ctx.decoration!.boundaryEventBoxes,
    poolBoxes: compose.poolBoxes,
    laneBoxes: compose.laneBoxes,
    routes: ctx.allRoutes!,
    totalBounds: compose.totalBounds,
  });
  ctx.ms.merge = performance.now() - tM;
  ctx.graph = graph;
  if (stageSnapshots) {
    pushSnapshot(ctx, snapshotFromLayoutedGraph(
      ctx.fixtureLabel,
      'merger',
      stageSnapshots.length,
      graph,
      ['Merger writes absolute stage data back into parent-relative LayoutedGraph containers.'],
    ));
  }
}

function shouldCollectStageSnapshots(options: LayoutOptions): boolean {
  if (options.debug === true) return true;
  if (options.debug && typeof options.debug === 'object') {
    return options.debug.stageSnapshots !== false;
  }
  return false;
}

function pushSnapshot(ctx: PipelineContext, snapshot: StageSnapshot): void {
  ctx.stageSnapshots?.push(snapshot);
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
