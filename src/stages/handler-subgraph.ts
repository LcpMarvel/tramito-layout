// Handler 子图识别（boundary-event handler subgraph）。
//
// 这两个纯图算法原先内联在 pipeline.ts 里，违反“pipeline 只编排、不写算法”的架构契约。
// 抽到此处：pipeline 只负责按序调用，图遍历逻辑可独立测试、可独立定位 ICE。
//
// 用途：decoration-placer 之前的 handler mini-ELK 阶段需要知道——从某个 boundary event 出发，
// 哪些节点/边属于它的 handler 分支（而不属于主流程、也不属于别的 handler）。

import type { SequenceFlow } from '../loader/types.ts';

/**
 * 从所有 startEvent 出发、沿 sequenceFlow 可达的节点集合 = 主流程。
 * boundary event 不参与主流可达（遇到 BE 即截断），因此 BE 的 handler 分支不会被算进主流。
 */
export function mainFlowReachable(
  flowNodes: Array<{ id: string; type: string }>,
  sequenceFlows: Array<{ source: string; target: string }>,
): Set<string> {
  const beIds = new Set(flowNodes.filter((n) => n.type === 'boundaryEvent').map((n) => n.id));
  const adj = new Map<string, string[]>();
  for (const sf of sequenceFlows) {
    if (!adj.has(sf.source)) adj.set(sf.source, []);
    adj.get(sf.source)!.push(sf.target);
  }
  const starts = flowNodes.filter((n) => n.type === 'startEvent').map((n) => n.id);
  const seen = new Set<string>(starts);
  const q = [...starts];
  while (q.length) {
    const cur = q.shift()!;
    if (beIds.has(cur)) continue;
    for (const nxt of adj.get(cur) ?? []) {
      if (beIds.has(nxt)) continue;
      if (!seen.has(nxt)) {
        seen.add(nxt);
        q.push(nxt);
      }
    }
  }
  return seen;
}

export interface CollectedSubgraph {
  beId: string;
  hostId: string;
  nodes: Set<string>;
  edges: SequenceFlow[];
}

/**
 * 从 BE 出发收集 handler 子图：沿 outgoing edges BFS，不越界进入主流程 / 其他已认领的 handler。
 * 起点是 BE 的直接 target（不是 BE 自己）；遇到 rejoin 回主流的 target 即跳过。
 */
export function collectHandlerSubgraph(
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
