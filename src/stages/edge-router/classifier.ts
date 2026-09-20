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
  /** snake 折行 lane 的行方向（奇数行 RTL = -1）；普通节点无此字段 */
  rowDir?: 1 | -1;
}

export interface ClassifierEdge {
  id: string;
  source: string;
  target: string;
}

export function classify(
  edge: ClassifierEdge,
  nodes: Map<string, ClassifierNode>,
  backEdgeIds?: ReadonlySet<string>,
): EdgeType {
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

  // snake 折行的两种边（P6 boustrophedon；rowDir 由 lane-constrainer 只对无环纯链 lane 发出）：
  //  ① 同行 RTL 相邻链边：X 反向是刻意折行，不是回边——forward-straight 直线。
  if (dx <= 0 && src.rowDir === -1 && tgt.rowDir === -1 && Math.abs(dy) < EPS) {
    return 'forward-straight';
  }
  //  ② 换行边：rowDir 翻转（行尾 → 下行行首），按 branch 的 bottom→top L 走成
  //    垂直短接（carriage return），不是回边拱形。
  if (src.rowDir !== undefined && tgt.rowDir !== undefined && src.rowDir !== tgt.rowDir) {
    return dy >= 0 ? 'branch-down' : 'branch-up';
  }

  // back-edge：target.x ≤ source.x（含等号；loop 自指也走这条）。
  // 语义回边（BackEdgeResolver 判出、随 backEdgeIds 传入）无条件算回边——几何代理 dx≤0
  // 会漏掉「折行后 target 正上方同列」的情形（47 的 重新清洗：dx=+11 落到 forward-step，
  // Z 形退化后被后处理搓成绕行的 9 点怪物）。
  if (dx <= 0 || backEdgeIds?.has(edge.id)) {
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
