// SubprocessLayout — 展开 subprocess 内部布局
//
// 把每个 isExpanded=true 的 subProcess（含嵌套）跑一遍 mini ELK，得到内部节点
// 的"局部坐标"（原点 0,0）+ 外包矩形（决定 subprocess 节点放大后的尺寸）。
//
// 不处理：lane（subprocess 内不允许 lane 是 BPMN 规范，loader 也没塞 lane 进 subProcesses）；
//        pool；container offset。这些由调用方负责。
//
// 顶层 process 不出现在结果里 —— 它的 layout 由主 pipeline 处理。

import type { ProcessUnit } from '../loader/types.ts';
import { layoutHeightWithIoSpec, nodeSizeOf } from '../layout/node-sizes.ts';
import { resolveBackEdgesForElk } from './back-edge-resolver.ts';
import { elkPlacement } from './elk-placement.ts';
import type { NodeBox } from './types.ts';

export interface SubprocessLayout {
  id: string;
  /** 内部节点 → 局部坐标（原点 0,0，子流程内容区左上角） */
  innerNodes: Map<string, NodeBox>;
  /** 内部 sequenceFlow id 列表 */
  innerEdgeIds: string[];
  /** 内部 bbox：决定 subprocess 节点放大后的尺寸（外包） */
  bounds: { width: number; height: number };
}

/** subprocess 节点 padding：top 给 header 留出空间 */
export const SUBPROCESS_PADDING_TOP = 40;
export const SUBPROCESS_PADDING_BOTTOM = 20;
export const SUBPROCESS_PADDING_LEFT = 20;
export const SUBPROCESS_PADDING_RIGHT = 20;

/**
 * 深度优先递归 layout 所有展开 subprocess，结果累加到 out。
 * 顶层 proc 自己不被 layout（它由主 pipeline 跑）。嵌套层级：
 *   先 layout 最内层 → 它的尺寸作为外层的 size override 喂给外层 ELK。
 */
export async function collectSubprocessLayouts(
  proc: ProcessUnit,
  out: Map<string, SubprocessLayout>,
): Promise<void> {
  for (const sub of proc.subProcesses) {
    const parentFn = proc.flowNodes.find(f => f.subProcessId === sub.id);
    if (!parentFn?.isExpanded) continue;

    // 深度优先：先把嵌套展开 subprocess 跑完
    await collectSubprocessLayouts(sub, out);

    // 用已 layout 的嵌套展开 subprocess 尺寸作为 size override
    const sizeOverrides = new Map<string, { w: number; h: number; layoutH: number }>();
    for (const innerFn of sub.flowNodes) {
      if (!innerFn.isExpanded) continue;
      const child = out.get(innerFn.id);
      if (!child) continue;
      const h = child.bounds.height + SUBPROCESS_PADDING_TOP + SUBPROCESS_PADDING_BOTTOM;
      sizeOverrides.set(innerFn.id, {
        w: child.bounds.width + SUBPROCESS_PADDING_LEFT + SUBPROCESS_PADDING_RIGHT,
        h,
        layoutH: layoutHeightWithIoSpec(
          h,
          innerFn.ioInputCount,
          innerFn.ioOutputCount,
          innerFn.ioInputNames,
          innerFn.ioOutputNames,
          child.bounds.width + SUBPROCESS_PADDING_LEFT + SUBPROCESS_PADDING_RIGHT,
        ),
      });
    }

    const elkNodes = sub.flowNodes
      .filter(n => n.type !== 'boundaryEvent') // BE 由 DecorationPlacer 处理
      .map(n => {
        const ov = sizeOverrides.get(n.id);
        if (ov) return { id: n.id, type: n.type, ...ov };
        const size = nodeSizeOf(n.type);
        return {
          id: n.id,
          type: n.type,
          ...size,
          layoutH: layoutHeightWithIoSpec(size.h, n.ioInputCount, n.ioOutputCount, n.ioInputNames, n.ioOutputNames, size.w),
        };
      });
    const innerNodeIds = new Set(elkNodes.map(n => n.id));
    const innerFlows = sub.sequenceFlows
      .filter(sf => innerNodeIds.has(sf.source) && innerNodeIds.has(sf.target));
    // subprocess 内部同样可能有驳回环，断环策略与主流程一致
    const { edges: elkEdges } = resolveBackEdgesForElk(
      sub.flowNodes.filter(n => innerNodeIds.has(n.id)),
      innerFlows,
    );

    const placement = await elkPlacement({
      processId: `${proc.id}::sub::${sub.id}`,
      nodes: elkNodes,
      edges: elkEdges,
    });

    out.set(sub.id, {
      id: sub.id,
      innerNodes: placement.nodes,
      innerEdgeIds: sub.sequenceFlows.map(sf => sf.id),
      bounds: placement.bounds,
    });
  }
}
