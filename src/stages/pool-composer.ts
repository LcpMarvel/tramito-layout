// PoolComposer
//
// 职责：多个 pool 垂直堆叠，把所有 lane/node 坐标升级为**绝对坐标**。
//      之后所有 stage（EdgeRouter / DecorationPlacer / Merger）都在绝对坐标系工作。
//
// 算法：
//   1. pool 宽度 = max(所有 pool.width) + POOL_HEADER_W + POOL_PAD_X*2
//      （让 cross-pool 容易对齐；窄的 pool 拉宽到一致）
//   2. pool x = 0；pool y 顺序累加，pool 之间留 POOL_GAP
//   3. 节点绝对坐标 = pool.y + POOL_PAD_Y + pool-local node.y
//                  = pool.x + POOL_HEADER_W + POOL_PAD_X + pool-local node.x
//   4. lane box 同样升级

import type { LaneBox, NodeBox, PoolBox } from './types.ts';
import { POOL_HEADER_W, POOL_PAD_X, POOL_PAD_Y, POOL_GAP } from '../layout/node-sizes.ts';

export interface ComposeInputPool {
  id: string;
  name: string;
  isBlackBox: boolean;
  /** Stage 2 输出，pool-local 坐标 */
  nodes: Map<string, NodeBox>;
  /** Stage 2 输出，pool-local 坐标；非 lane pool 为空 Map。含中间层 lane */
  laneBoxes: Map<string, LaneBox>;
  /** 叶子 lane id 顺序（从上到下） */
  leafOrder: string[];
  /** 全部 lane id（含中间层）DFS document 顺序，parent 在 children 之前 */
  allLanes: string[];
  width: number;
  height: number;
}

export interface ComposeInput {
  pools: ComposeInputPool[];
  /** 跨 pool messageFlow，用来调整 pool 之间的水平 offset 让 message line 趋向竖直 */
  messageFlows?: { source: string; target: string }[];
  /** node id → pool id（用来快速判断 messageFlow 端点属于哪个 pool） */
  nodeToPool?: Map<string, string>;
}

export interface ComposeOutput {
  /** 所有 flow node 的绝对坐标 */
  nodes: Map<string, NodeBox>;
  /** 每个 leaf lane 的绝对 Y band + 所属 pool id */
  laneBoxes: Map<string, LaneBox & { poolId: string }>;
  /** 每个 pool 的绝对盒子 */
  poolBoxes: Map<string, PoolBox & { name: string; isBlackBox: boolean }>;
  /** 节点 id → pool id（EdgeRouter 用） */
  nodeToPool: Map<string, string>;
  /** 节点 id → 所属 leaf lane id（null 表示该 pool 无 lane） */
  nodeToLane: Map<string, string | null>;
  /** lane 在 pool 内的顺序编号（0,1,2...，从上到下） */
  laneIdx: Map<string, number>;
  totalBounds: { width: number; height: number };
}

const BLACK_BOX_HEIGHT = 60;

export function poolCompose(input: ComposeInput): ComposeOutput {
  // 共享 pool 宽度：选所有 pool 的最大宽度（用于 cross-pool 对齐）
  const maxInnerW = Math.max(0, ...input.pools.map(p => p.width));
  const poolFullW = POOL_HEADER_W + POOL_PAD_X * 2 + Math.max(maxInnerW, 200);

  const nodes = new Map<string, NodeBox>();
  const laneBoxes = new Map<string, LaneBox & { poolId: string }>();
  const poolBoxes = new Map<string, PoolBox & { name: string; isBlackBox: boolean }>();
  const nodeToPool = new Map<string, string>();
  const nodeToLane = new Map<string, string | null>();
  const laneIdx = new Map<string, number>();

  // 计算每个 pool 的 xShift：让第一个连到已放置 pool 的 messageFlow 走竖直线。
  const xShiftByPool = computePoolXShifts(input);
  // pool 偏移导致整图宽度可能超过 poolFullW，记录最大右边界
  let maxRight = poolFullW;

  let cursorY = 0;
  for (const pool of input.pools) {
    const xShift = xShiftByPool.get(pool.id) ?? 0;
    const innerH = pool.isBlackBox ? BLACK_BOX_HEIGHT : Math.max(pool.height, BLACK_BOX_HEIGHT);
    const poolFullH = POOL_PAD_Y * 2 + innerH;
    const poolX = xShift;
    const poolY = cursorY;
    if (poolX + poolFullW > maxRight) maxRight = poolX + poolFullW;

    poolBoxes.set(pool.id, {
      id: pool.id,
      name: pool.name,
      isBlackBox: pool.isBlackBox,
      x: poolX,
      y: poolY,
      w: poolFullW,
      h: poolFullH,
    });

    // 平移所有 lane box（含中间层）。laneIdx 仅记叶子 lane 的索引（EdgeRouter 用来判跨 lane）
    const baseY = poolY + POOL_PAD_Y;
    const allLaneIds = pool.allLanes.length > 0 ? pool.allLanes : pool.leafOrder;
    for (const laneId of allLaneIds) {
      const box = pool.laneBoxes.get(laneId);
      if (!box) continue;
      laneBoxes.set(laneId, {
        poolId: pool.id,
        top: baseY + box.top,
        bottom: baseY + box.bottom,
        centerY: baseY + box.centerY,
        height: box.height,
      });
    }
    pool.leafOrder.forEach((laneId, idx) => {
      if (pool.laneBoxes.has(laneId)) laneIdx.set(laneId, idx);
    });

    // node-to-lane 反查（再算一次：从 pool.laneBoxes/leafOrder 信息其实需要从外面传入）
    // 这里用 pool.nodes 推：哪个 lane band 包含 node center
    const baseX = poolX + POOL_HEADER_W + POOL_PAD_X;
    for (const [nodeId, box] of pool.nodes) {
      nodes.set(nodeId, {
        x: baseX + box.x,
        y: baseY + box.y,
        w: box.w,
        h: box.h,
      });
      nodeToPool.set(nodeId, pool.id);
      // 找包住 node center 的 lane
      const cy = baseY + box.y + box.h / 2;
      let laneId: string | null = null;
      for (const id of pool.leafOrder) {
        const lb = laneBoxes.get(id);
        if (lb && cy >= lb.top && cy <= lb.bottom) {
          laneId = id;
          break;
        }
      }
      nodeToLane.set(nodeId, laneId);
    }

    cursorY = poolY + poolFullH + POOL_GAP;
  }

  const totalHeight = Math.max(0, cursorY - POOL_GAP);
  return {
    nodes,
    laneBoxes,
    poolBoxes,
    nodeToPool,
    nodeToLane,
    laneIdx,
    totalBounds: { width: maxRight, height: totalHeight },
  };
}

/**
 * 计算每个 pool 的 xShift：贪心地按 pool 出现顺序，让每个 pool 的第一条与已放置 pool 的
 * messageFlow 端点 X 对齐。第一个 pool xShift=0。
 */
function computePoolXShifts(input: ComposeInput): Map<string, number> {
  const shifts = new Map<string, number>();
  if (!input.messageFlows || !input.nodeToPool || input.pools.length < 2) {
    for (const p of input.pools) shifts.set(p.id, 0);
    return shifts;
  }
  // 节点局部 box（在自己 pool 的 inner 坐标里）
  const localBox = new Map<string, NodeBox>();
  for (const p of input.pools) {
    for (const [id, box] of p.nodes) localBox.set(id, box);
  }
  const baseOffset = POOL_HEADER_W + POOL_PAD_X;
  // 已放置 pool 的 node id → 中心 X（绝对）
  const placedCenterAbsX = new Map<string, number>();

  for (const p of input.pools) {
    if (p.isBlackBox) {
      shifts.set(p.id, 0);
      continue;
    }
    let chosenShift = 0;
    for (const mf of input.messageFlows) {
      const srcPool = input.nodeToPool.get(mf.source);
      const tgtPool = input.nodeToPool.get(mf.target);
      let localId: string | null = null;
      let remoteCenterAbsX: number | null = null;
      if (srcPool === p.id && tgtPool && placedCenterAbsX.has(mf.target)) {
        localId = mf.source;
        remoteCenterAbsX = placedCenterAbsX.get(mf.target)!;
      } else if (tgtPool === p.id && srcPool && placedCenterAbsX.has(mf.source)) {
        localId = mf.target;
        remoteCenterAbsX = placedCenterAbsX.get(mf.source)!;
      }
      if (localId === null || remoteCenterAbsX === null) continue;
      const lb = localBox.get(localId);
      if (!lb) continue;
      // 让本端 center == remoteCenter：poolShift + baseOffset + lb.x + lb.w/2 = remoteCenterAbsX
      chosenShift = remoteCenterAbsX - baseOffset - lb.x - lb.w / 2;
      break;
    }
    if (chosenShift < 0) chosenShift = 0;
    shifts.set(p.id, chosenShift);
    for (const [id, box] of p.nodes) {
      placedCenterAbsX.set(id, chosenShift + baseOffset + box.x + box.w / 2);
    }
  }
  return shifts;
}
