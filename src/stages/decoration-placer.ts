// DecorationPlacer
//
// 职责：boundary event 节点骑在 host 边上（CLAUDE.md B1：半内半外）。
//
// P3 去分片后：handler 节点已并入主 ELK（与主图同一坐标系），这里不再做子图平移，
// 只决定 BE 骑 host 的哪条边——朝 handler 入口所在侧（下边为默认；handler 落在 host
// 上方时骑顶边，否则 BE→handler 边要从底边出发绕回上方）。
//
// boundary event 摆位：半内半外坐在 host 边上，按 idx 从左到右排
//   cx = host.left + 20 + i*40
//   cy = host.bottom（handler 在下方）或 host.top（handler 在上方）
// idx 顺序与 handler 分支的排列顺序一致，避免 BE→handler 边交叉。

import type { NodeBox } from './types.ts';
import { EVENT_W, EVENT_H } from '../layout/node-sizes.ts';
import { BE_INSET, BE_HORIZONTAL_STEP } from './bpmn-rules.ts';

export interface DecorationInputBoundaryEvent {
  id: string;
  hostId: string;
  /** 多个 BE 时，在该 host 内的索引（0,1,2...） */
  idx: number;
}

export interface DecorationInput {
  hostBoxes: Map<string, NodeBox>;  // 已绝对坐标
  boundaryEvents: DecorationInputBoundaryEvent[];
  /** BE id → handler 入口节点 box（决定骑边侧；无 handler 的 BE 不查）。 */
  handlerEntryBoxes?: Map<string, NodeBox>;
}

export interface DecorationOutput {
  boundaryEventBoxes: Map<string, NodeBox>;
}

export function placeDecorations(input: DecorationInput): DecorationOutput {
  const boundaryEventBoxes = new Map<string, NodeBox>();
  for (const be of input.boundaryEvents) {
    const host = input.hostBoxes.get(be.hostId);
    if (!host) continue;
    const entry = input.handlerEntryBoxes?.get(be.id);
    const hostCy = host.y + host.h / 2;
    // 无 handler / handler 在下方 → 默认底边（BPMN 惯例）；handler 在上方 → 顶边。
    const rideTop = entry !== undefined && entry.y + entry.h / 2 < hostCy;
    const cx = host.x + BE_INSET + be.idx * BE_HORIZONTAL_STEP;
    const cy = rideTop ? host.y : host.y + host.h;
    boundaryEventBoxes.set(be.id, {
      x: cx - EVENT_W / 2,
      y: cy - EVENT_H / 2,
      w: EVENT_W,
      h: EVENT_H,
    });
  }
  return { boundaryEventBoxes };
}
