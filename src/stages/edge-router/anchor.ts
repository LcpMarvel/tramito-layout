// Stage 4b: AnchorSelector
//
// 纯函数 EdgeType → (sourceAnchor, targetAnchor)。
// 根据 EdgeType 选择 source/target 的边界锚点。

import type { Anchor, EdgeType } from '../types.ts';

const TABLE: Record<EdgeType, [Anchor, Anchor]> = {
  'forward-straight':    ['right',  'left'],
  'forward-step':        ['right',  'left'],
  'branch-down':         ['bottom', 'top'],
  'branch-up':           ['top',    'bottom'],
  'back-edge-up-left':   ['bottom', 'bottom'],
  'back-edge-down-left': ['top',    'top'],
  'back-row-down':       ['bottom', 'top'],
  'back-row-up':         ['top',    'bottom'],
  'cross-lane-down':     ['bottom', 'top'],
  'cross-lane-up':       ['top',    'bottom'],
  'cross-pool-down':     ['bottom', 'top'],
  'cross-pool-up':       ['top',    'bottom'],
  'boundary-to-handler': ['bottom', 'top'],
};

export function selectAnchors(edgeType: EdgeType): { source: Anchor; target: Anchor } {
  const entry = TABLE[edgeType];
  if (!entry) throw new Error(`[anchor] unknown EdgeType: ${edgeType}`);
  return { source: entry[0], target: entry[1] };
}

// 给定节点 box 和锚点名，算锚点在节点边上的精确像素位置。
export function anchorPoint(box: { x: number; y: number; w: number; h: number }, anchor: Anchor): { x: number; y: number } {
  switch (anchor) {
    case 'top':    return { x: box.x + box.w / 2, y: box.y };
    case 'right':  return { x: box.x + box.w,     y: box.y + box.h / 2 };
    case 'bottom': return { x: box.x + box.w / 2, y: box.y + box.h };
    case 'left':   return { x: box.x,             y: box.y + box.h / 2 };
  }
}
