// BPMN 节点默认尺寸 + 间距常量。
// 跟 Camunda Modeler 一致（task 100×80, event 36×36, gateway 50×50）。

import type { FlowNodeType } from '../loader/types.ts';

const TASK_W = 100;
const TASK_H = 80;
export const EVENT_W = 36;
export const EVENT_H = 36;
const GATEWAY_W = 50;
const GATEWAY_H = 50;

export const LANE_PAD = 16;
export const LANE_MIN_H = 100;

export const POOL_HEADER_W = 30;
export const POOL_PAD_X = 20;
export const POOL_PAD_Y = 20;
export const POOL_GAP = 30;

export interface NodeSize { w: number; h: number }

export function nodeSizeOf(type: FlowNodeType): NodeSize {
  switch (type) {
    case 'startEvent':
    case 'endEvent':
    case 'intermediateCatchEvent':
    case 'intermediateThrowEvent':
    case 'boundaryEvent':
      return { w: EVENT_W, h: EVENT_H };
    case 'exclusiveGateway':
    case 'parallelGateway':
    case 'inclusiveGateway':
    case 'eventBasedGateway':
    case 'complexGateway':
      return { w: GATEWAY_W, h: GATEWAY_H };
    case 'subProcess':
    case 'adHocSubProcess':
    case 'transaction':
    case 'callActivity':
      return { w: TASK_W, h: TASK_H }; // collapsed
    default:
      return { w: TASK_W, h: TASK_H };
  }
}

export function isGatewayType(type: FlowNodeType): boolean {
  return type === 'exclusiveGateway'
    || type === 'parallelGateway'
    || type === 'inclusiveGateway'
    || type === 'eventBasedGateway'
    || type === 'complexGateway';
}

const IO_SPEC_DATA_WIDTH = 36;
const IO_SPEC_DATA_HEIGHT = 50;
const IO_SPEC_GAP_BELOW = 20;
const IO_SPEC_VERTICAL_SPACING = 24;
const IO_SPEC_LABEL_HEIGHT = 14;
const IO_SPEC_LABEL_GAP = 4;

export interface IoSpecBox { x: number; y: number; w: number; h: number }

// serializer/diagram-builder 把 ioSpec dataInput/dataOutput 摆在 task 下方：
//   y0 = taskY + taskH + 20 (gapBelow)
//   每行高度 = 50 (dataHeight) + 24 (verticalSpacing)
//   末行还要 + 14 (label) + 4 (label gap)
// 这里返回 task 下方需要预留多少额外像素（与 visualH 无关，ELK 用 visualH+extra 摆位）。
export function ioSpecExtraBelow(ioInputCount: number, ioOutputCount: number): number {
  const n = Math.max(ioInputCount, ioOutputCount);
  if (n <= 0) return 0;
  return IO_SPEC_GAP_BELOW
    + n * IO_SPEC_DATA_HEIGHT
    + (n - 1) * IO_SPEC_VERTICAL_SPACING
    + IO_SPEC_LABEL_GAP
    + IO_SPEC_LABEL_HEIGHT;
}

export function ioSpecDataObjectBoxes(host: IoSpecBox, ioInputCount: number, ioOutputCount: number): IoSpecBox[] {
  const boxes: IoSpecBox[] = [];
  for (let i = 0; i < ioInputCount; i++) {
    boxes.push({
      x: host.x,
      y: host.y + host.h + IO_SPEC_GAP_BELOW + i * (IO_SPEC_DATA_HEIGHT + IO_SPEC_VERTICAL_SPACING),
      w: IO_SPEC_DATA_WIDTH,
      h: IO_SPEC_DATA_HEIGHT,
    });
  }
  for (let i = 0; i < ioOutputCount; i++) {
    boxes.push({
      x: host.x + host.w - IO_SPEC_DATA_WIDTH,
      y: host.y + host.h + IO_SPEC_GAP_BELOW + i * (IO_SPEC_DATA_HEIGHT + IO_SPEC_VERTICAL_SPACING),
      w: IO_SPEC_DATA_WIDTH,
      h: IO_SPEC_DATA_HEIGHT,
    });
  }
  return boxes;
}
