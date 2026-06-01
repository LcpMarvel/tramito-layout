// 扁平输入的对外接缝：校验复用 validateGraph（先 flatToNested 再校验），零新校验器。
//
// 结构类规则（lane 错放 / boundary 进 children / 边放错层 / partition 缺失……）因 flatToNested
// 永远拼对而不可能触发；validateGraph 在扁平路径上只会冒出语义类 issue（悬空引用 / 重复 id /
// 非 ASCII id / 缺 eventDef / 排他默认分支非法 / 跨池 sequenceFlow 残留 / 并行未收束 / io 空条目）。
// 错误码、hint、formatIssuesForFeedback 全与嵌套路径共用一套，消费侧 feedback 永不漂移。

import { flatToNested } from './flat-builder.ts';
import { validateGraph, type ValidationIssue, type ValidationProfile } from './validate-graph.ts';
import type { FlatBpmn } from './flat-types.ts';

export function validateFlat(
  flat: FlatBpmn,
  options: { profile?: ValidationProfile } = {},
): ValidationIssue[] {
  return validateGraph(flatToNested(flat), options);
}
