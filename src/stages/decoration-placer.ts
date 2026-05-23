// DecorationPlacer
//
// 职责：boundary event 节点骑在 host 边上；boundary handler 子树由 pipeline
// 提前用 mini ELK 算好局部坐标，这里平移到 host 下方。
//
// boundary event 摆位（CLAUDE.md B1）：半内半外坐在 host 底边，按 idx 从左到右排
//   cx = host.left + 20 + i*40
//   cy = host.bottom
// idx 顺序与 handler 子图在下方的排列顺序一致，避免 BE→handler 边交叉。
//
// Boundary handler 子树（B 系列硬标准的延伸）：
//   handler 在 host 下方，水平居中对齐到 host
//   每个 handler 节点的局部坐标 + 平移量 = 绝对坐标

import type { NodeBox } from './types.ts';
import { EVENT_W, EVENT_H } from '../layout/node-sizes.ts';
import {
  BE_INSET, BE_HORIZONTAL_STEP,
  HANDLER_VERTICAL_GAP, HANDLER_HORIZONTAL_GAP, INTER_HOST_HANDLER_GAP,
} from './bpmn-rules.ts';

export interface DecorationInputBoundaryEvent {
  id: string;
  hostId: string;
  /** 多个 BE 时，在该 host 内的索引（0,1,2...） */
  idx: number;
}

/** 已经被 mini ELK 算好的 handler 子图：节点局部坐标 + 子图整体 bounds */
export interface HandlerSubgraph {
  beId: string;          // 这个 handler 是哪个 BE 触发的
  hostId: string;
  /** 子图局部坐标，原点 (0,0) */
  nodes: Map<string, NodeBox>;
  /** 子图整体宽高 */
  width: number;
  height: number;
}

export interface DecorationInput {
  hostBoxes: Map<string, NodeBox>;  // 已绝对坐标
  boundaryEvents: DecorationInputBoundaryEvent[];
  handlerSubgraphs: HandlerSubgraph[];
}

export interface DecorationOutput {
  boundaryEventBoxes: Map<string, NodeBox>;
  handlerNodeBoxes: Map<string, NodeBox>;
}

// 常量统一从 bpmn-rules.ts 引入，避免散落

export function placeDecorations(input: DecorationInput): DecorationOutput {
  const boundaryEventBoxes = new Map<string, NodeBox>();
  for (const be of input.boundaryEvents) {
    const host = input.hostBoxes.get(be.hostId);
    if (!host) continue;
    const cx = host.x + BE_INSET + be.idx * BE_HORIZONTAL_STEP;
    const cy = host.y + host.h;
    boundaryEventBoxes.set(be.id, {
      x: cx - EVENT_W / 2,
      y: cy - EVENT_H / 2,
      w: EVENT_W,
      h: EVENT_H,
    });
  }

  // 按 hostId 聚合 handler subgraph，多个时水平并排（按 input 顺序，对应 BE idx 顺序）。
  // 单个 handler 时居中对齐 host，多个时整组居中对齐 host。
  const byHost = new Map<string, HandlerSubgraph[]>();
  for (const sg of input.handlerSubgraphs) {
    if (!byHost.has(sg.hostId)) byHost.set(sg.hostId, []);
    byHost.get(sg.hostId)!.push(sg);
  }

  // 按 host X 从左到右扫描；每个 group 默认居中到 host，但若与左邻 group 重叠则右移让出。
  // 避免相邻 host 的 handler 群在下排互相穿插（N1）。
  const orderedHosts = Array.from(byHost.entries())
    .map(([hostId, group]) => {
      const host = input.hostBoxes.get(hostId);
      return host ? { hostId, group, host } : null;
    })
    .filter((x): x is { hostId: string; group: HandlerSubgraph[]; host: NodeBox } => x !== null)
    .sort((a, b) => a.host.x - b.host.x);

  const handlerNodeBoxes = new Map<string, NodeBox>();
  let prevGroupRight = -Infinity;
  for (const { group, host } of orderedHosts) {
    const totalW = group.reduce((s, g) => s + g.width, 0)
      + HANDLER_HORIZONTAL_GAP * Math.max(0, group.length - 1);
    const desiredLeft = host.x + host.w / 2 - totalW / 2;
    const minLeft = prevGroupRight + INTER_HOST_HANDLER_GAP;
    let cursorX = Math.max(desiredLeft, minLeft);
    const groupLeft = cursorX;
    const offsetY = host.y + host.h + HANDLER_VERTICAL_GAP;
    for (const sg of group) {
      const offsetX = cursorX;
      for (const [id, localBox] of sg.nodes) {
        handlerNodeBoxes.set(id, {
          x: offsetX + localBox.x,
          y: offsetY + localBox.y,
          w: localBox.w,
          h: localBox.h,
        });
      }
      cursorX += sg.width + HANDLER_HORIZONTAL_GAP;
    }
    prevGroupRight = groupLeft + totalW;
  }

  return { boundaryEventBoxes, handlerNodeBoxes };
}
