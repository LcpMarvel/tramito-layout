// Stage 4a: EdgeClassifier
//
// 纯函数 (edge, nodeInfo) → EdgeType。判定按以下顺序：
//   1. 跨 pool
//   2. boundary source
//   3. 跨 lane
//   4. 同 lane：back-edge / forward-straight / branch / forward-step
//
// 几何分类只决定 EdgeType；BPMN 语义分类在 bpmn-rules.ts。

import type { FlowNodeType } from '../../loader/types.ts';
import type { EdgeType, NodeBox } from '../types.ts';
import { isGatewayType } from '../../layout/node-sizes.ts';
import { EDGE_CY_EPS, BACK_ROW_MIN_GAP, BRANCH_MIN_GAP } from '../bpmn-rules.ts';

const EPS = EDGE_CY_EPS; // 局部短名引用，方便阅读

export interface ClassifierNode {
  box: NodeBox;
  type: FlowNodeType;
  poolId: string;
  laneId: string | null;
  laneIdx: number | null;
}

export interface ClassifierEdge {
  id: string;
  source: string;
  target: string;
}

export function classify(edge: ClassifierEdge, nodes: Map<string, ClassifierNode>): EdgeType {
  const src = nodes.get(edge.source);
  const tgt = nodes.get(edge.target);
  if (!src || !tgt) {
    throw new Error(`[classify] edge ${edge.id}: missing endpoint (src=${edge.source} tgt=${edge.target})`);
  }

  // 1. 跨 pool
  if (src.poolId !== tgt.poolId) {
    const srcCy = src.box.y + src.box.h / 2;
    const tgtCy = tgt.box.y + tgt.box.h / 2;
    return tgtCy >= srcCy ? 'cross-pool-down' : 'cross-pool-up';
  }

  // 2. boundary
  if (src.type === 'boundaryEvent') return 'boundary-to-handler';

  // 3. 跨 lane
  if (
    src.laneId !== null
    && tgt.laneId !== null
    && src.laneId !== tgt.laneId
    && src.laneIdx !== null
    && tgt.laneIdx !== null
  ) {
    return tgt.laneIdx > src.laneIdx ? 'cross-lane-down' : 'cross-lane-up';
  }

  // 4. 同 lane（或 pool 无 lane）
  const srcCx = src.box.x + src.box.w / 2;
  const tgtCx = tgt.box.x + tgt.box.w / 2;
  const srcCy = src.box.y + src.box.h / 2;
  const tgtCy = tgt.box.y + tgt.box.h / 2;
  const dx = tgtCx - srcCx;
  const dy = tgtCy - srcCy;

  // back-edge：target.x ≤ source.x（含等号；loop 自指也走这条）
  if (dx <= 0) {
    // 当 target 完全位于另一"行"上（dy 大于两节点半高之和 + 一段真空），不是真正的
    // 同行 loop，而是分支回主线之类的跨行回连。此时按 L 形从行间间隙绕回，避免拱形
    // 飞到 lane 外（fixture 28 throw_damage_report→throw_transfer_request 即此例）。
    // 真正的同行 loop（dy≈0）或贴得很近的 back（无足够 gap 走 L）仍走原 back-edge 拱形。
    const rowThreshold = src.box.h / 2 + tgt.box.h / 2 + BACK_ROW_MIN_GAP;
    if (dy >= rowThreshold) return 'back-row-down';
    if (dy <= -rowThreshold) return 'back-row-up';
    return dy >= 0 ? 'back-edge-down-left' : 'back-edge-up-left';
  }

  // forward-straight：dx > 0 且同 cy
  if (Math.abs(dy) < EPS) return 'forward-straight';

  // gateway 收敛（tgt=gateway）：多路汇合时落到 gateway top/bottom 顶点而不是 left vertex；
  // 否则 3 条入边全挤在左顶点，箭头互相覆盖。
  // 发散（src=gateway）一律走 forward-step Z 形（先水平再竖直再水平）。
  // 之前发散也走 branch-up/down 时，靠近水平的 dy 会画出几乎纯水平加两个针眼竖向小段的"水平线"，
  // 标签飘在很远处，用户实测难看。
  //
  // 收敛也有同样的"针眼"问题：source.bottom 和 target.top 之间只差几像素时（fixture 32
  // task→并行汇合：dy=70、间隙仅 5px），bottom→top 几乎是横线、视觉像穿过 task 底部。
  // 要求中间真空段 ≥ BRANCH_MIN_GAP，否则走 forward-step Z。
  const branchThreshold = src.box.h / 2 + tgt.box.h / 2 + BRANCH_MIN_GAP;
  if (isGatewayType(tgt.type) && !isGatewayType(src.type) && Math.abs(dy) >= branchThreshold) {
    return dy > 0 ? 'branch-down' : 'branch-up';
  }

  return 'forward-step';
}
