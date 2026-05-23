// LaneResolver — Stage 2 内部用的 lane 结构帮手。
// 职责：
//   1. 把可能嵌套的 lane 列表 DFS 展平成 leaf lane 顺序（节点 Y snap 用）
//   2. DFS 展平所有 lane（含中间层，parent 在前）— merger 渲染嵌套用
//   3. 反查每个 node id 属于哪个 leaf lane
//   4. 计算每个 lane 的嵌套深度（depth=0 表示顶层 lane），merger 算 width 减去祖先 header strip 用

import type { Lane } from '../loader/types.ts';

function buildChildrenIndex(lanes: Lane[]): Map<string | null, Lane[]> {
  const childrenOf = new Map<string | null, Lane[]>();
  for (const l of lanes) {
    const k = l.parentLaneId;
    if (!childrenOf.has(k)) childrenOf.set(k, []);
    childrenOf.get(k)!.push(l);
  }
  return childrenOf;
}

// DFS top-level lanes（按 document 顺序），lane 无 child 时计入 leaf。
export function leafLaneOrder(lanes: Lane[]): string[] {
  const childrenOf = buildChildrenIndex(lanes);
  const result: string[] = [];
  function walk(parent: string | null) {
    for (const l of childrenOf.get(parent) ?? []) {
      const kids = childrenOf.get(l.id) ?? [];
      if (kids.length === 0) result.push(l.id);
      else walk(l.id);
    }
  }
  walk(null);
  return result;
}

// DFS 所有 lane（含中间层），parent 排在 children 之前。merger 按这顺序写嵌套容器。
export function allLaneOrder(lanes: Lane[]): string[] {
  const childrenOf = buildChildrenIndex(lanes);
  const result: string[] = [];
  function walk(parent: string | null) {
    for (const l of childrenOf.get(parent) ?? []) {
      result.push(l.id);
      walk(l.id);
    }
  }
  walk(null);
  return result;
}

// 通过 lane.memberRefs 反查；只考虑 leaf lane（嵌套 lane 的 outer 会被 inner 覆盖）。
export function nodeToLeafLane(lanes: Lane[], leafLaneIds: string[]): Map<string, string> {
  const leafSet = new Set(leafLaneIds);
  const m = new Map<string, string>();
  for (const l of lanes) {
    if (!leafSet.has(l.id)) continue;
    for (const ref of l.memberRefs) m.set(ref, l.id);
  }
  return m;
}
