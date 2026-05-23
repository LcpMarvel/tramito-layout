// BPMN 规则表（A3）
//
// 单一真源：所有 BPMN 相关的视觉/语义常量与策略集中在此。各 stage 从这里 import，
// 不再用文件内 const。这样：
//   1. 设计决策可见——读这一个文件就知道 fixture 02 vs fixture 13 vs fixture 29 的 BPMN
//      规范是怎么落到代码上的，不用爬整个 edge-router/ 目录
//   2. 调参不会漏——改 BOUNDARY_INSET 不再要找四个文件
//   3. 测试可锁——后续要给规则加单元测试时，断言对象就是这张表
//
// 为什么不直接做更激进的"声明式 router"：当前 classifier + path-shaper 已经基于 EdgeType
// 表驱动，规则散落程度不高。这一步只是把"散落的魔数"统一，不改架构。

// ============================================================
// Boundary Event 摆位（CLAUDE.md B1）
// ============================================================

/** Boundary event 半内半外坐在 host 底边时，最左侧 BE 距 host.left 的水平偏移 */
export const BE_INSET = 20;

/** 多个 boundary event 时，相邻两个 BE 中心点的水平间距 */
export const BE_HORIZONTAL_STEP = 40;

// ============================================================
// Boundary handler 子图摆位
// ============================================================

/**
 * Host 底边到 handler 顶边的垂直距离。
 * 100 是给多条 BE→handler 边在 corridor 内分行错开（每条 12px）留余量；
 * 5 条 BE 一起也够。
 */
export const HANDLER_VERTICAL_GAP = 100;

/** 同一 host 下，多个 handler 子图之间的水平间距 */
export const HANDLER_HORIZONTAL_GAP = 40;

/** 不同 host 的 handler 群之间的最小水平间距（避免相邻 host 的 handler 群穿插 → N1） */
export const INTER_HOST_HANDLER_GAP = 40;

// ============================================================
// Artifact (dataObject / textAnnotation) 摆位
// ============================================================

/** Host 边到 artifact 边的垂直距离（artifact 在 host 上方或下方） */
export const ARTIFACT_VERTICAL_GAP = 40;

/** 同侧多个 artifact 的水平间隔 */
export const ARTIFACT_HORIZONTAL_STEP = 20;

// ============================================================
// Edge 路由
// ============================================================

/** 多条并行 edge 之间的 Y 间隔（channel 错开） */
export const CHANNEL_GAP = 18;

/** BE→handler corridor 较窄，用更紧的 channel 间隔 */
export const BE_CHANNEL_GAP = 12;

/** Forward-skip 拱形：第一条拱离 spine 的距离 */
export const ARCH_BASE_OFFSET = 24;

/** 跨 lane / 跨 pool / boundary 出节点后先走的直段长度 */
export const VERTICAL_STUB = 16;

/** 上跨 lane 回连时，source 顶部先向上走一段再横向回连，避免贴着 task 顶边左拐。 */
export const CROSS_LANE_UP_MIN_START_STUB = 32;

/** 拱形避障：拱顶必须比中间节点 bbox 多出这么多像素 */
export const ARCH_CLEAR_MARGIN = 16;

/** Edge 端点 cy 容差（防 ELK 输出 0.5px 偏差导致分类错乱） */
export const EDGE_CY_EPS = 4;

/**
 * 同 lane back-edge 与跨行 back 的临界：
 * 当 |dy| ≥ src.h/2 + tgt.h/2 + BACK_ROW_MIN_GAP 时，按"跨行回连"走 L 形而非拱形。
 */
export const BACK_ROW_MIN_GAP = 40;

/**
 * Gateway 收敛/发散使用 top/bottom port 的临界：
 * 当 |dy| ≥ src.h/2 + tgt.h/2 + BRANCH_MIN_GAP 时，dy 够大走 branch-up/down，
 * 否则走 forward-step Z 形（避免"针眼"近水平的难看路径）。
 */
export const BRANCH_MIN_GAP = 40;

/** PathShaper 内部 X 避障 margin */
export const SHAPER_MARGIN = 10;

// ============================================================
// BPMN 边语义类别 + 路由风格策略（A3 真规则表）
// ============================================================
//
// EdgeType（types.ts）是**几何**分类（forward-step / branch-up / cross-lane-down …），
// 决定锚点和 waypoint 形状；BpmnEdgeKind 是**语义**分类（sequenceFlow / messageFlow /
// association / compensationAssociation / boundaryConnector），决定路由风格 + 渲染样式。
//
// 两个维度正交：一条 BPMN messageFlow（语义）几何上可能是 cross-pool-down（几何）。
// shapePath 根据 routerStyle 决定 waypoint 形状；serializer 根据原 edge.bpmn.type 决定
// 线型（虚线/实线、箭头形状）——本表不染指 serializer，只染指 layout。

export type BpmnEdgeKind =
  | 'sequenceFlow'
  | 'messageFlow'
  | 'association'             // 含 dataInputAssociation / dataOutputAssociation
  | 'compensationAssociation' // compensation BE → 触发的 handler activity
  | 'boundaryConnector';      // 非 compensation BE → handler 子图入口

export type RouterStyle = 'orthogonal' | 'polyline' | 'direct';

export interface EdgeStyleRule {
  routerStyle: RouterStyle;
  /**
   * 当端点的 X 或 Y 已经几乎对齐（差 ≤ tolerance px）时，polyline 退化为 2-point 直线。
   * Infinity 表示永远退化为直线（'direct' 风格的常用值）。
   * 仅对 polyline / direct 风格生效；orthogonal 永远保持 4-wp 正交折线。
   */
  directTolerance: number;
}

/**
 * BPMN 规范要点：
 *  - sequenceFlow：正交。我们沿用现有 path-shaper Z/L/拱形决策。
 *  - messageFlow：BPMN 规范鼓励"直接"路径，不强制正交；多 pool 已被 pool-composer
 *    在 X 上对齐，因此大多数 message flow 实际是 2-point 垂直直线。directTolerance=30 让
 *    轻微错位时也退化为直线，避免在 pool gap 中段画个无意义的小台阶。
 *  - association / compensationAssociation：BPMN 规范是单一虚线（数据流可带箭头），
 *    视觉上**绝大多数渲染器都画直线**（含 bpmn.io）。强制 direct。
 *  - boundaryConnector：非 compensation BE 到 handler 子图的入口边。本来语义上是 sequenceFlow
 *    （interrupting / non-interrupting 都是），但 handler 在 host 下方，走正交 bottom→top
 *    L 形最稳。沿用 orthogonal。
 */
export const edgeStyleRules: Record<BpmnEdgeKind, EdgeStyleRule> = {
  sequenceFlow:            { routerStyle: 'orthogonal', directTolerance: 0 },
  messageFlow:             { routerStyle: 'polyline',   directTolerance: 30 },
  association:             { routerStyle: 'direct',     directTolerance: Infinity },
  compensationAssociation: { routerStyle: 'direct',     directTolerance: Infinity },
  boundaryConnector:       { routerStyle: 'orthogonal', directTolerance: 0 },
};

// ============================================================
// Boundary event 规则
// ============================================================
//
// eventType → handler 摆位 + BE→handler 连接边的 BPMN 类别。
// compensation BE 的特殊性：连到 handler 用的是 association（虚线+双箭头），不是 sequenceFlow。
// 其他 eventType（error/timer/escalation/cancel/signal/message/conditional/...）都走默认
// boundaryConnector，handler 在 host 下方。

export interface BoundaryEventRule {
  handlerPlacement: 'below';
  /** BE → handler 入口边的 BPMN 语义类别，决定路由风格 + 序列化时的边类型 */
  connectorKind: BpmnEdgeKind;
}

const BOUNDARY_DEFAULT: BoundaryEventRule = {
  handlerPlacement: 'below',
  connectorKind: 'boundaryConnector',
};

const boundaryEventRules: Record<string, BoundaryEventRule> = {
  compensation: {
    handlerPlacement: 'below',
    connectorKind: 'compensationAssociation',
  },
};

export function boundaryRuleFor(eventType: string): BoundaryEventRule {
  return boundaryEventRules[eventType] ?? BOUNDARY_DEFAULT;
}

// ============================================================
// Event-based gateway 规则
// ============================================================
//
// BPMN 14.3 (event-based gateway)：出边连接的应该是 intermediate catch event，且 fan-out
// 朝水平方向（east）——表达"等待若干互斥事件中的一个"。各 catch event 在垂直方向上**分布**
// （像 fixture 32 那样上/中/下 3 行），并不强制同一 Y。
//
// 这条规则**已经被** ELK Sugiyama + B3 (layerConstraint=FIRST/LAST) 满足：
//   - east fan-out：来自 ELK 默认 left-to-right layering，gateway 总是在 catch event 左侧
//   - 分支垂直分布：Sugiyama 层内 Y 由 crossing-minimization 决定，与 Camunda/Signavio 一致
//
// 所以**当前不需要 post-pass**。这条规则保留在表里是为了 (a) 文档化决策，(b) 防止未来误把
// catch events Y-snap 到 gateway.cy——那会跟 BPMN 工具的典型渲染对着干。

const eventBasedGatewayRules = {
  /**
   * Fan-out 朝东（水平方向），target 节点垂直分布。**已由 ELK 默认 layering 满足**，
   * 不需要 post-pass。声明在此防止后续误改。
   */
  fanOutDirection: 'east' as const,
  /**
   * 各分支在 Y 上由 Sugiyama crossing-minimization 决定，**不**强制同 Y（这是 BPMN 工具惯例）。
   * 若未来发现 ELK 把 catch event 放到不合理的 Y（如塞进 gateway 上方），再考虑加 layerConstraint hint。
   */
  branchYDistribution: 'sugiyama-default' as const,
};
