// 共享的 stage-to-stage 数据类型。
// 每个 stage 的 input/output schema 在自己的文件里 import 这些原子类型组装。
//
// 设计约束：这里只放**数据**类型，不放函数。stage 之间通过这些 plain
// data 传递；任何"读写共享 mutable state"都是 bug。

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RectWithId extends Rect {
  id: string;
}

export interface NodeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LabelBox extends Rect {}

export interface LabelObstacle extends RectWithId {}

export interface NodeLayoutBox {
  /** BPMN shape's real visible bounds; edge endpoints and DI shapes must use this box. */
  visualBox: NodeBox;
  /** Layout/containment bounds; may reserve extra space around the visual shape. */
  layoutBox: NodeBox;
}

export interface LaneBox {
  top: number;
  bottom: number;
  centerY: number;
  height: number;
}

export interface PoolBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Waypoint {
  x: number;
  y: number;
}

export type Anchor = 'top' | 'right' | 'bottom' | 'left';

export interface NodePort {
  nodeId: string;
  side: Anchor;
  point: Waypoint;
  boundary: 'box' | 'diamond';
}

export type LayoutSubjectKind = 'node' | 'edge' | 'pool' | 'lane' | 'port' | 'label';

export interface LayoutSubject {
  kind: LayoutSubjectKind;
  id: string;
}

export type ConstraintStrength = 'required' | 'strong' | 'medium' | 'weak';

export type LayoutConstraint =
  | {
    kind: 'contains';
    parent: LayoutSubject;
    child: LayoutSubject;
    strength: ConstraintStrength;
    reason: string;
  }
  | {
    kind: 'stack-vertical';
    subjects: LayoutSubject[];
    gap: number;
    strength: ConstraintStrength;
    reason: string;
  }
  | {
    kind: 'rides-boundary';
    node: LayoutSubject;
    host: LayoutSubject;
    side: Anchor;
    strength: ConstraintStrength;
    reason: string;
  }
  | {
    kind: 'same-x';
    subjects: LayoutSubject[];
    strength: ConstraintStrength;
    reason: string;
  }
  | {
    kind: 'port-side';
    port: LayoutSubject;
    node: LayoutSubject;
    side: Anchor;
    strength: ConstraintStrength;
    reason: string;
  }
  | {
    kind: 'avoid-overlap';
    a: LayoutSubject;
    b: LayoutSubject;
    strength: ConstraintStrength;
    reason: string;
  }
  | {
    kind: 'preserve-position';
    node: LayoutSubject;
    previousBox: NodeBox;
    strength: ConstraintStrength;
    reason: string;
  };

export type LayoutConstraintKind = LayoutConstraint['kind'];

export interface LayoutConstraintSummary {
  total: number;
  byKind: Partial<Record<LayoutConstraintKind, number>>;
}

export type LayoutTraceValue = string | number | boolean | null;

export type LayoutDecisionKind =
  | 'elk-layer'
  | 'pool-stack'
  | 'boundary-placement'
  | 'incremental-preserve'
  | 'edge-route'
  | 'label-placement';

export interface LayoutDecision {
  stage: string;
  kind: LayoutDecisionKind;
  subject: LayoutSubject;
  reason: string;
  input?: Record<string, LayoutTraceValue>;
  output?: Record<string, LayoutTraceValue>;
}

/**
 * ELK 布局形状诊断快照（M8 诊断 milestone 引入）。
 *
 * 用于事后分析 F4（aspect ratio）失分根因——把宽度拆成"节点本身宽度"和"层间间距"两块。
 * 仅 trace 字段，不影响坐标输出。
 */
export interface ElkShape {
  processId: string;
  /** Layer 数（按 ELK 输出节点的左边 X 分组）。 */
  layerCount: number;
  /** 每个 layer 的节点数（按 layer X 从左到右排序）。 */
  perLayerNodeCount: number[];
  /** 每个 layer 内最宽节点的宽度，用于宽度构成分析。 */
  perLayerMaxNodeWidth: number[];
  /** 节点最大 fan-out（出度），来自输入 edges。 */
  maxFanOut: number;
  /** ELK 输出 bounds.width。 */
  totalWidth: number;
  /** ELK 输出 bounds.height。 */
  totalHeight: number;
  /** sum(perLayerMaxNodeWidth)。 */
  nodeWidthSum: number;
  /** totalWidth - nodeWidthSum，可视作层间 spacing 总和。 */
  spacingWidth: number;
  /** 节点数。 */
  nodeCount: number;
}

export type EdgeType =
  | 'cross-pool-down'
  | 'cross-pool-up'
  | 'boundary-to-handler'
  | 'cross-lane-down'
  | 'cross-lane-up'
  | 'back-edge-up-left'
  | 'back-edge-down-left'
  | 'back-row-down'
  | 'back-row-up'
  | 'forward-straight'
  | 'branch-down'
  | 'branch-up'
  | 'forward-step';

export interface EdgeRoute {
  edgeId: string;
  edgeType: EdgeType;
  sourcePort: NodePort;
  targetPort: NodePort;
  waypoints: Waypoint[];
  channel: number;
}
