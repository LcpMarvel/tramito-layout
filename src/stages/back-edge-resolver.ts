// BackEdgeResolver — 自主断环：在喂 ELK 之前识别"回头边"并预反转。
//
// 为什么不交给 ELK：GREEDY cycle breaking 对"审批-驳回"双环结构会断错边（把
// gateway 推到 layer 0，主流程蛇形乱序——见 fixtures/45-approval-double-loop 与
// docs/feedback-2026-06-11.md 问题一）。MODEL_ORDER / DEPTH_FIRST 等策略实验同样
// 不可靠。喂进 ELK 的图若已无环，GREEDY 无从出错。
//
// 哪条边算回头线不能只靠图论，要用 BPMN 语义加权（语义优先于图论）：
//   - default flow（驳回循环常被建模为 gateway 的 default 出边）
//   - label 写着"不通过/驳回/拒绝"等否定词的 gateway 出边
//   - 指向声明顺序更早节点的边（作者书写顺序即叙事顺序）
// DFS 从 start event 出发，每个节点的出边按"像回头线的程度"升序遍历——越像
// happy path 越先走。命中 DFS 栈上节点的边即 back edge。
//
// 正确性：DFS back edge 反转后必无环（按 DFS finish time 倒序即拓扑序：tree/forward/
// cross 边都从 finish 晚的指向 finish 早的，反转后的 back edge 亦然）。
//
// 输出只决定 ELK 看到的方向；EdgeRouter 仍按 loader 模型的真实方向路由。

import type { FlowNodeType } from '../loader/types.ts';

export interface BackEdgeInputNode {
  id: string;
  type: FlowNodeType;
}

export interface BackEdgeInputEdge {
  id: string;
  source: string;
  target: string;
  isDefault?: boolean;
  /** edge label 文本（"不通过"等），用于语义加权。 */
  label?: string;
}

export interface BackEdgeInput {
  /** 按声明顺序排列的节点（声明顺序参与语义加权）。 */
  nodes: BackEdgeInputNode[];
  edges: BackEdgeInputEdge[];
}

/** label 含否定/重做语义 → 该出边大概率是驳回回头线。 */
const REJECT_LABEL_RE = /不通过|不合格|不同意|不批准|驳回|拒绝|退回|打回|重新|重做|返工|\b(no|reject(ed)?|den(y|ied)|fail(ed|ure)?|rework|redo|retry)\b/i;

/**
 * 返回应预反转（喂 ELK 时 source/target 对调）的 edge id 集合。
 * 输入无环时返回空集，零影响。
 */
export function resolveBackEdges(input: BackEdgeInput): Set<string> {
  const declIndex = new Map<string, number>();
  input.nodes.forEach((n, i) => declIndex.set(n.id, i));

  // 出边邻接表，保留声明顺序作稳定 tie-break
  const outEdges = new Map<string, BackEdgeInputEdge[]>();
  for (const e of input.edges) {
    if (!declIndex.has(e.source) || !declIndex.has(e.target)) continue;
    if (!outEdges.has(e.source)) outEdges.set(e.source, []);
    outEdges.get(e.source)!.push(e);
  }

  const backScore = (e: BackEdgeInputEdge): number => {
    let score = 0;
    if (e.isDefault) score += 4;
    if (e.label && REJECT_LABEL_RE.test(e.label)) score += 3;
    const si = declIndex.get(e.source)!;
    const ti = declIndex.get(e.target)!;
    if (ti < si) score += 1;
    return score;
  };

  // 每个节点的出边按 backScore 升序：最不像回头线的先走（成为 DFS tree 边 = 主干）
  for (const edges of outEdges.values()) {
    edges.sort((a, b) => backScore(a) - backScore(b));
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const n of input.nodes) color.set(n.id, WHITE);
  const reversed = new Set<string>();

  // 迭代 DFS（显式栈，避免深链爆递归栈）
  const dfs = (rootId: string): void => {
    type Frame = { nodeId: string; edgeIdx: number };
    const stack: Frame[] = [{ nodeId: rootId, edgeIdx: 0 }];
    color.set(rootId, GRAY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const edges = outEdges.get(frame.nodeId) ?? [];
      if (frame.edgeIdx >= edges.length) {
        color.set(frame.nodeId, BLACK);
        stack.pop();
        continue;
      }
      const edge = edges[frame.edgeIdx]!;
      frame.edgeIdx++;
      const c = color.get(edge.target);
      if (c === GRAY) {
        reversed.add(edge.id); // 命中栈上祖先 → back edge
      } else if (c === WHITE) {
        color.set(edge.target, GRAY);
        stack.push({ nodeId: edge.target, edgeIdx: 0 });
      }
      // BLACK：forward/cross 边，不构成环
    }
  };

  // start event 优先作 DFS 根（主干从 start 长出来）；剩余不可达节点按声明顺序兜底
  for (const n of input.nodes) {
    if (n.type === 'startEvent' && color.get(n.id) === WHITE) dfs(n.id);
  }
  for (const n of input.nodes) {
    if (color.get(n.id) === WHITE) dfs(n.id);
  }

  return reversed;
}

/** SequenceFlow 形态的边（loader 模型 / handler 子图共有的字段子集）。 */
export interface BackEdgeFlow {
  id: string;
  source: string;
  target: string;
  isDefault?: boolean;
  name?: string;
}

/**
 * 三个 ELK 喂图点（主流程 / handler 子图 / subprocess mini-ELK）共用的断环装配：
 * SequenceFlow 形态 → resolveBackEdges 输入 → 带 reversed 标记的 PlacementInputEdge。
 */
export function resolveBackEdgesForElk(
  nodes: BackEdgeInputNode[],
  flows: BackEdgeFlow[],
): { edges: Array<{ id: string; source: string; target: string; reversed: boolean }>; reversedIds: Set<string> } {
  const reversedIds = resolveBackEdges({
    nodes,
    edges: flows.map(f => ({
      id: f.id, source: f.source, target: f.target,
      isDefault: f.isDefault, label: f.name,
    })),
  });
  return {
    edges: flows.map(f => ({
      id: f.id, source: f.source, target: f.target,
      reversed: reversedIds.has(f.id),
    })),
    reversedIds,
  };
}
