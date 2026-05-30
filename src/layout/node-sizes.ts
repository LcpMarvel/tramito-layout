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

export const IO_SPEC_DATA_WIDTH = 36;
export const IO_SPEC_DATA_HEIGHT = 50;
export const IO_SPEC_GAP_BELOW = 20;
export const IO_SPEC_LABEL_GAP = 4;
export const IO_SPEC_LABEL_LINE_HEIGHT = 14;
export const IO_SPEC_LABEL_MAX_WIDTH = 100;
export const IO_SPEC_ROW_GAP = 6;

export interface IoSpecBox { x: number; y: number; w: number; h: number }

// serializer/diagram-builder 把 ioSpec dataInput/dataOutput 摆在 task 下方：
//   y0 = taskY + taskH + 20 (gapBelow)
//   每行高度 = 50 (dataHeight) + label gap + 自动换行后的 label 高度
//   如果同一行 input/output label 横向相交，output label 会向下错开。
// 这里返回 task 下方需要预留多少额外像素（与 visualH 无关）。
export function ioSpecLabelMaxWidth(hostWidth = TASK_W): number {
  return Math.max(IO_SPEC_DATA_WIDTH, Math.min(IO_SPEC_LABEL_MAX_WIDTH, hostWidth));
}

function estimateIoSpecTextWidth(text: string, maxWidth = IO_SPEC_LABEL_MAX_WIDTH): number {
  let width = 0;
  for (const char of text) {
    width += char.charCodeAt(0) > 255 ? 14 : 7;
  }
  return Math.max(IO_SPEC_DATA_WIDTH, Math.min(width, maxWidth));
}

export function estimateIoSpecLabelHeight(text: string | undefined, maxWidth = IO_SPEC_LABEL_MAX_WIDTH): number {
  if (!text) return 0;
  const width = estimateIoSpecTextWidth(text, maxWidth);
  let currentLineWidth = 0;
  let lines = 1;
  for (const char of text) {
    const charWidth = char.charCodeAt(0) > 255 ? 14 : 7;
    if (currentLineWidth + charWidth > width) {
      lines++;
      currentLineWidth = charWidth;
    } else {
      currentLineWidth += charWidth;
    }
  }
  return lines * IO_SPEC_LABEL_LINE_HEIGHT;
}

function ioSpecLabelsOverlap(inputName: string | undefined, outputName: string | undefined, hostWidth: number): boolean {
  if (!inputName || !outputName) return false;
  const maxWidth = ioSpecLabelMaxWidth(hostWidth);
  const inputWidth = estimateIoSpecTextWidth(inputName, maxWidth);
  const outputWidth = estimateIoSpecTextWidth(outputName, maxWidth);
  const inputX = (IO_SPEC_DATA_WIDTH - inputWidth) / 2;
  const outputX = hostWidth - IO_SPEC_DATA_WIDTH + (IO_SPEC_DATA_WIDTH - outputWidth) / 2;
  return inputX < outputX + outputWidth && outputX < inputX + inputWidth;
}

function ioSpecRowLabelHeight(inputName: string | undefined, outputName: string | undefined, hostWidth: number): number {
  const maxWidth = ioSpecLabelMaxWidth(hostWidth);
  const inputHeight = estimateIoSpecLabelHeight(inputName, maxWidth);
  const outputHeight = estimateIoSpecLabelHeight(outputName, maxWidth);
  if (inputHeight <= 0) return outputHeight;
  if (outputHeight <= 0) return inputHeight;

  if (ioSpecLabelsOverlap(inputName, outputName, hostWidth)) {
    return inputHeight + IO_SPEC_ROW_GAP + IO_SPEC_DATA_HEIGHT + IO_SPEC_LABEL_GAP + outputHeight;
  }
  return Math.max(inputHeight, outputHeight);
}

export function ioSpecExtraBelow(
  ioInputCount: number,
  ioOutputCount: number,
  ioInputNames: readonly string[] = [],
  ioOutputNames: readonly string[] = [],
  hostWidth = TASK_W,
): number {
  const n = Math.max(ioInputCount, ioOutputCount);
  if (n <= 0) return 0;
  let below = IO_SPEC_GAP_BELOW;
  for (let i = 0; i < n; i++) {
    below += IO_SPEC_DATA_HEIGHT
      + IO_SPEC_LABEL_GAP
      + ioSpecRowLabelHeight(ioInputNames[i], ioOutputNames[i], hostWidth);
    if (i < n - 1) below += IO_SPEC_ROW_GAP;
  }
  return below;
}

export function layoutHeightWithIoSpec(
  visibleHeight: number,
  ioInputCount: number,
  ioOutputCount: number,
  ioInputNames?: readonly string[],
  ioOutputNames?: readonly string[],
  hostWidth?: number,
): number {
  const below = ioSpecExtraBelow(ioInputCount, ioOutputCount, ioInputNames, ioOutputNames, hostWidth);
  // ELK 按 layout box 的中心对齐；上方配同等空白，才能既保持 task 视觉中心齐平，又包住下方 ioSpec。
  return visibleHeight + below * 2;
}

/**
 * 返回 ioSpecification 数据形的避障 box。**唯一消费者是 router 的 routeObstacles**（序列化器另走
 * 一条路径画形），所以这里把每个 box 的高度撑到「数据形 + label gap + label」整段——否则贴在数据形
 * 正下方的名字（fixture 07 task_process 下的「事件表单」label，y 454-468）量不到，forward-skip 下拱
 * 走廊会从文字中间穿过（线压字）。撑高只影响避障，不改数据形的绘制坐标。
 */
export function ioSpecDataObjectBoxes(
  host: IoSpecBox,
  ioInputCount: number,
  ioOutputCount: number,
  ioInputNames: readonly string[] = [],
  ioOutputNames: readonly string[] = [],
): IoSpecBox[] {
  const boxes: IoSpecBox[] = [];
  const n = Math.max(ioInputCount, ioOutputCount);
  let y = host.y + host.h + IO_SPEC_GAP_BELOW;
  for (let i = 0; i < n; i++) {
    const inputName = ioInputNames[i];
    const outputName = ioOutputNames[i];
    const maxWidth = ioSpecLabelMaxWidth(host.w);
    const inputLabelHeight = estimateIoSpecLabelHeight(inputName, maxWidth);
    const outputLabelHeight = estimateIoSpecLabelHeight(outputName, maxWidth);
    const withLabel = (labelH: number) => IO_SPEC_DATA_HEIGHT + (labelH > 0 ? IO_SPEC_LABEL_GAP + labelH : 0);
    const stackedOutput = i < ioInputCount && i < ioOutputCount && ioSpecLabelsOverlap(inputName, outputName, host.w);
    if (i < ioInputCount) {
      boxes.push({ x: host.x, y, w: IO_SPEC_DATA_WIDTH, h: withLabel(inputLabelHeight) });
    }
    if (i < ioOutputCount) {
      const outputY = stackedOutput
        ? y + IO_SPEC_DATA_HEIGHT + IO_SPEC_LABEL_GAP + inputLabelHeight + IO_SPEC_ROW_GAP
        : y;
      boxes.push({ x: host.x + host.w - IO_SPEC_DATA_WIDTH, y: outputY, w: IO_SPEC_DATA_WIDTH, h: withLabel(outputLabelHeight) });
    }
    y += IO_SPEC_DATA_HEIGHT
      + IO_SPEC_LABEL_GAP
      + ioSpecRowLabelHeight(ioInputNames[i], ioOutputNames[i], host.w)
      + IO_SPEC_ROW_GAP;
  }
  return boxes;
}
