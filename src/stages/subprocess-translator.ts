// SubprocessTranslator
//
// 把 SubprocessLayout（内部节点局部坐标，原点 0,0）平移到绝对坐标系。
//
// SubprocessLayout 是 SubprocessLayout stage 跑 mini-ELK 的产物——每个展开 subprocess
// 都有"内部节点局部坐标 + bbox"。但 mini-ELK 不知道这个 subprocess 在主图里的位置，所以
// 必须在 PoolComposer 算出绝对坐标后，再把内部节点的"局部坐标 + subprocess 绝对左上角 +
// padding" = "内部节点绝对坐标"。
//
// 嵌套：subprocess 内嵌 subprocess 时，外层先平移（外层的绝对位置由 compose 提供），
// 平移后外层"内部 subprocess 节点"得到自己的绝对 box，作为内层平移的基准；深度优先递归。
//
// 不变量：
//   - 所有 input.subprocessLayouts 里的 SubprocessLayout 都被翻译（除非它的 owner
//     subprocess 不在 input.topLevelExpansions 的可达图中——通常意味着调用方漏给）
//   - 翻译只读 input，不改 input；产出全部是 fresh Map / Array

import type { NodeBox } from './types.ts';
import type { SubprocessLayout } from './subprocess-layout.ts';
import {
  SUBPROCESS_PADDING_LEFT,
  SUBPROCESS_PADDING_TOP,
} from './subprocess-layout.ts';

export interface SubprocessTranslateInput {
  /** SubprocessLayout stage 的产物：subId → 内部局部坐标 + bbox + 内部 edge id */
  subprocessLayouts: Map<string, SubprocessLayout>;
  /**
   * 顶层展开 subprocess 列表 + 它们在主图（compose）里的绝对 box。
   * "顶层"= 直接 placed by ElkPlacement 的 subprocess 节点；嵌套的不在这里。
   */
  topLevelExpansions: Array<{ subId: string; absBox: NodeBox }>;
}

export interface SubprocessTranslateOutput {
  /** 所有展开 subprocess 内部节点（含嵌套深层）→ 绝对坐标 */
  innerNodeBoxes: Map<string, NodeBox>;
  /** 所有展开 subprocess（含嵌套）→ 自己的绝对 box（外层来自输入，内层是翻译产物） */
  subprocessBoxes: Map<string, NodeBox>;
  /** 所有展开 subprocess 内部 sequenceFlow id（EdgeRouter 用来过滤主流 edge 与内部 edge） */
  innerEdgeIds: string[];
}

export function translateSubprocesses(
  input: SubprocessTranslateInput,
): SubprocessTranslateOutput {
  const innerNodeBoxes = new Map<string, NodeBox>();
  const subprocessBoxes = new Map<string, NodeBox>();
  const innerEdgeIds: string[] = [];

  const recurse = (subId: string): void => {
    const layout = input.subprocessLayouts.get(subId);
    if (!layout) return;
    const ownBox = subprocessBoxes.get(subId)!;
    const contentBaseX = ownBox.x + SUBPROCESS_PADDING_LEFT;
    const contentBaseY = ownBox.y + SUBPROCESS_PADDING_TOP;
    for (const [innerId, local] of layout.innerNodes) {
      const absBox: NodeBox = {
        x: contentBaseX + local.x,
        y: contentBaseY + local.y,
        w: local.w,
        h: local.h,
      };
      innerNodeBoxes.set(innerId, absBox);
      // 嵌套：如果这个 inner 节点也是展开 subprocess，递归
      if (input.subprocessLayouts.has(innerId)) {
        subprocessBoxes.set(innerId, absBox);
        recurse(innerId);
      }
    }
    for (const eid of layout.innerEdgeIds) innerEdgeIds.push(eid);
  };

  for (const { subId, absBox } of input.topLevelExpansions) {
    subprocessBoxes.set(subId, absBox);
    recurse(subId);
  }

  return { innerNodeBoxes, subprocessBoxes, innerEdgeIds };
}
