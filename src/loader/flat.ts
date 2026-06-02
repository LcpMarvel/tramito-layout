// 扁平输入的对外校验接缝：两层前端。
//
// 第一层 validateFlatStructure：用扁平词汇查 parent/attachedTo/lane/pool/parentLane 的引用与归属错——
// 这些字段在 flatToNested 转换后就消失/改形了，只能在转换前查（否则只剩 EDGE_ENDPOINT_MISSING 这种
// 指错方向的二手错误）。第二层 validateGraph：在确定性产出的嵌套结构上查其余语义错（缺 eventDef /
// 并行未收束 / 排他默认分支非法 / 重复 id / 悬空边端点……），与嵌套门完全共用一套码/hint。
//
// WHY 有第一层 error 时短路、不再叠加第二层：第一层的引用错是「根因」，转换会因这些错丢节点/改形，
// 第二层在残缺产物上必然冒出一堆误导性级联错（指向已声明节点的 EDGE_ENDPOINT_MISSING 等），
// 把模型往错路上带、空烧 step。先把根因报清楚，作者改完再 validate 才暴露下一层——标准编译器做法。

import { flatToNested } from './flat-builder.ts';
import { validateGraph, type ValidationIssue, type ValidationProfile } from './validate-graph.ts';
import { validateFlatStructure } from './validate-flat.ts';
import type { FlatBpmn } from './flat-types.ts';

export function validateFlat(
  flat: FlatBpmn,
  options: { profile?: ValidationProfile } = {},
): ValidationIssue[] {
  const flatIssues = validateFlatStructure(flat);
  if (flatIssues.some((i) => i.severity === 'error')) return flatIssues;
  // 无扁平层 error：扁平层告警（如 MSGFLOW_INTRA）+ 嵌套层语义校验一起返回。
  return [...flatIssues, ...validateGraph(flatToNested(flat), options)];
}
