// Stage 契约注册表（contract registry）
//
// 这是流水线的"单点 surface"——所有 stage 的函数 + Input + Output 类型都从这里 re-export。
// `pipeline.ts` 应该且只应该 import 这一个文件。改任何 stage 签名前，先看这里能不能讲清楚
// 新签名相对旧的差异（否则就是悄悄破坏跨 stage 契约）。
//
// 共享原子类型（NodeBox / LaneBox / PoolBox / Anchor / EdgeType / EdgeRoute / Waypoint）
// 在 ./types.ts，已被各 stage 文件 import 拼装它们自己的 I/O 类型。
//
// 执行顺序（与 pipeline.ts 顶部注释一致）：
//   SubprocessLayout → ElkPlacement → LaneConstrainer → Compactor → PoolComposer →
//   SubprocessTranslator → mini ElkPlacement (handler subgraphs) → DecorationPlacer →
//   ArtifactPlacer → PoolOverflowRebalancer → ConstraintModel / IncrementalStabilizer →
//   EdgeRouter → AssociationRouter → Merger
//
// 注意：执行顺序不是旧设计稿里的概念编号顺序。原因：
// - SubprocessLayout 必须先跑（外层 ELK 需要内层 bbox 当 size override）
// - DecorationPlacer / ArtifactPlacer 必须在 EdgeRouter 之前（否则 BE 与 artifact 位置未知）

// ───────────────────────────────────────────────────────────
// 共享原子（atoms）
// ───────────────────────────────────────────────────────────
export type {
  Rect,
  RectWithId,
  NodeBox,
  NodeLayoutBox,
  LabelBox,
  LabelObstacle,
  LaneBox,
  PoolBox,
  Waypoint,
  Anchor,
  NodePort,
  LayoutSubject,
  LayoutSubjectKind,
  ConstraintStrength,
  LayoutConstraint,
  LayoutConstraintKind,
  LayoutConstraintSummary,
  LayoutTraceValue,
  LayoutDecisionKind,
  LayoutDecision,
  EdgeType,
  EdgeRoute,
  ElkShape,
} from './types.ts';

// ───────────────────────────────────────────────────────────
// SubprocessLayout — 递归 mini-ELK 展开 subprocess 内部，最先跑
// ───────────────────────────────────────────────────────────
export { collectSubprocessLayouts } from './subprocess-layout.ts';
export type { SubprocessLayout } from './subprocess-layout.ts';
export {
  SUBPROCESS_PADDING_TOP,
  SUBPROCESS_PADDING_BOTTOM,
  SUBPROCESS_PADDING_LEFT,
  SUBPROCESS_PADDING_RIGHT,
} from './subprocess-layout.ts';

// ───────────────────────────────────────────────────────────
// SubprocessTranslator — 把 SubprocessLayout 局部坐标平移到绝对（在 PoolComposer 之后跑）
// ───────────────────────────────────────────────────────────
export { translateSubprocesses } from './subprocess-translator.ts';
export type {
  SubprocessTranslateInput,
  SubprocessTranslateOutput,
} from './subprocess-translator.ts';

// ───────────────────────────────────────────────────────────
// ElkPlacement — elkjs 摆位（局部坐标）
// ───────────────────────────────────────────────────────────
export { elkPlacement } from './elk-placement.ts';
export type {
  PlacementInput,
  PlacementInputNode,
  PlacementInputEdge,
  PlacementOutput,
} from './elk-placement.ts';

// ───────────────────────────────────────────────────────────
// LaneConstrainer — Y snap 到 lane 中线，X 不动
// ───────────────────────────────────────────────────────────
export { laneConstrain } from './lane-constrainer.ts';
export type {
  LaneConstrainInput,
  LaneConstrainOutput,
  LaneNodeMeta,
  LaneEdgeInfo,
} from './lane-constrainer.ts';

// ───────────────────────────────────────────────────────────
// Compactor (B2) — 水平压缩明显的层间空白（lane Y 不动）
// ───────────────────────────────────────────────────────────
export { compact } from './compactor.ts';
export type { CompactInput, CompactOutput } from './compactor.ts';

// ───────────────────────────────────────────────────────────
// PoolComposer — 多 pool 垂直堆叠 → 绝对坐标
// ───────────────────────────────────────────────────────────
export { poolCompose } from './pool-composer.ts';
export type {
  ComposeInput,
  ComposeInputPool,
  ComposeOutput,
} from './pool-composer.ts';

// ───────────────────────────────────────────────────────────
// DecorationPlacer — boundary event 骑边 + handler 子图平移
// ───────────────────────────────────────────────────────────
export { placeDecorations } from './decoration-placer.ts';
export type {
  DecorationInput,
  DecorationInputBoundaryEvent,
  DecorationOutput,
  HandlerSubgraph,
} from './decoration-placer.ts';

// ───────────────────────────────────────────────────────────
// ArtifactPlacer — dataObject / textAnnotation 在 host 上下方摆位
// ───────────────────────────────────────────────────────────
export { placeArtifacts } from './artifact-placer.ts';
export type {
  ArtifactInput,
  ArtifactInputArtifact,
  ArtifactInputAssociation,
  ArtifactOutput,
  ArtifactSide,
} from './artifact-placer.ts';

// ───────────────────────────────────────────────────────────
// PoolOverflowRebalancer — DecorationPlacer/ArtifactPlacer 后，pool 上下溢出再排版
// (in-place mutation；详见 ./pool-overflow-rebalancer.ts 注释)
// ───────────────────────────────────────────────────────────
export { rebalancePoolOverflow } from './pool-overflow-rebalancer.ts';
export type {
  PoolOverflowRebalanceInput,
  PoolOverflowRebalanceOutput,
} from './pool-overflow-rebalancer.ts';

// ───────────────────────────────────────────────────────────
// ConstraintModel — 把现有隐式布局规则显式收集成 data/trace
// ───────────────────────────────────────────────────────────
export {
  collectBoundaryConstraints,
  collectBoundaryDecisions,
  collectContainmentConstraints,
  collectPoolStackConstraints,
  collectPoolStackDecisions,
  collectRouteConstraints,
  collectRouteDecisions,
  summarizeConstraints,
} from './constraint-model.ts';
export type {
  BoundaryConstraintInput,
  ContainmentConstraintInput,
  NodeMembership,
} from './constraint-model.ts';

// ───────────────────────────────────────────────────────────
// IncrementalStabilizer — previousBox 稳定：安全时保留历史 X
// ───────────────────────────────────────────────────────────
export { stabilizeWithPreviousBoxes } from './incremental-stabilizer.ts';
export type {
  IncrementalNodeMeta,
  IncrementalStabilizeInput,
  IncrementalStabilizeOutput,
  PreviousBoxes,
} from './incremental-stabilizer.ts';

// ───────────────────────────────────────────────────────────
// EdgeRouter — 主流 sequence + cross-pool message 路由
// 内部子组件（4a Classifier / 4b AnchorSelector / 4c PathShaper / 4d ChannelAllocator）
// 不对 pipeline 暴露，只通过 routeEdges 入口
// ───────────────────────────────────────────────────────────
export { routeEdges } from './edge-router/index.ts';
export type {
  RouteInput,
  RouteInputNode,
  RouteInputEdge,
  RouteInputObstacle,
  RouteOutput,
} from './edge-router/index.ts';

// ───────────────────────────────────────────────────────────
// AssociationRouter — artifact ↔ host 的 association 边路由
// ───────────────────────────────────────────────────────────
export { routeAssociations } from './association-router.ts';
export type {
  AssociationRouteInput,
  AssociationEdgeInput,
  AssociationRouteOutput,
} from './association-router.ts';

// ───────────────────────────────────────────────────────────
// Merger — 所有 stage 输出 → LayoutedGraph JSON
// ───────────────────────────────────────────────────────────
export { merge } from './merger.ts';
export type { MergeInput } from './merger.ts';
