// PoolOverflowRebalancer
//
// PoolComposer 按 host Y 安排 pool 上下堆叠；之后 DecorationPlacer + ArtifactPlacer 又
// 把 BE / handler / dataObject / textAnnotation 摆到 host 上下方。这些后摆位的 box
// 可能溢出 pool 的上下边界（典型：dataInputAssoc 把 artifact 推到 host 上方 → 越过 pool 顶；
// dataOutputAssoc 把 artifact 推到 host 下方 → 越过 pool 底）。单 pool 时只是框小了；
// 多 pool（collaboration）时还会让相邻 pool 互相重叠。
//
// 本 stage 做两件事：
//   1. **垂直再排版**：算每个 pool 的 topOverflow / bottomGrow，自上而下累加位移；
//      pool.y 整体下移、pool.h 撑大、pool 内 content（含 lane / inner subprocess 节点 /
//      artifact / BE / handler）跟着 shift；bottomGrow 单独把底部 leaf lane 拉高（不全层 shift）。
//   2. **水平扩展**：handler 子图横向超出 pool 右边时，扩 pool.w 与 totalBounds.width。
//
// 重要约定：本 stage **mutates in place**。所有传入的 NodeBox / LaneBox / PoolBox 对象的
// 字段会被原地修改（.y / .h / .top / .bottom / .centerY / .w）。totalBounds 是值类型，
// 返回新的。这是因为 pipeline 已经依赖 Map<id, Box> 的引用语义（box 在多个 Map 里共享身份），
// 强行 immutable 反而要全图克隆。

import type { LaneBox, NodeBox, NodeLayoutBox, PoolBox } from './types.ts';
import { POOL_PAD_X, POOL_PAD_Y } from '../layout/node-sizes.ts';

const PAD = 20;

export interface PoolOverflowRebalanceInput {
  /** 顶层 pool 集合（会原地修改 .y / .h / .w） */
  poolBoxes: Map<string, PoolBox & { name?: string; isBlackBox?: boolean }>;
  /** 主图 totalBounds（不原地改；返回新值） */
  totalBounds: { width: number; height: number };

  // ── 内容 box（按 pool shift 时原地改 .y）──
  nodes: Map<string, NodeBox>;
  laneBoxes: Map<string, LaneBox & { poolId: string }>;
  expandedInnerNodes: Map<string, NodeBox>;
  artifactBoxes: Map<string, NodeBox>;
  boundaryEventBoxes: Map<string, NodeBox>;
  handlerNodeBoxes: Map<string, NodeBox>;

  // ── 归属映射（只读）──
  /** flow node id → pool id */
  nodeToPool: Map<string, string>;
  /** artifact id → 该 artifact 关联的 host id（host 又能查 pool） */
  artifactHosts: Map<string, string>;
  /** boundary event id → host id */
  boundaryEventHosts: Map<string, string>;
  /** handler node id → host id */
  handlerNodeHosts: Map<string, string>;
  /** 展开 subprocess 内部节点 → owner top-level pool id */
  innerNodeOwnerPool: Map<string, string>;

  // ── 计算 overflow 用的元数据 ──
  /** node id → visual/layout box pair; layoutBox may reserve ioSpec/data shape space below the node */
  nodeLayoutBoxes: Map<string, NodeLayoutBox>;
  /** pool id → 底部 leaf lane id（bottomGrow 时只拉这条 lane） */
  bottomLaneByPool: Map<string, string>;
}

export interface PoolOverflowRebalanceOutput {
  /** 扩张后的 totalBounds（width 因 handler 右溢，height 因 pool 上下溢） */
  totalBounds: { width: number; height: number };
}

export function rebalancePoolOverflow(
  input: PoolOverflowRebalanceInput,
): PoolOverflowRebalanceOutput {
  // ── 收集每个 pool 的 content top/bottom（已含 PAD 余量）──
  const contentTopByPool = new Map<string, number>();
  const contentBottomByPool = new Map<string, number>();
  const widen = (poolId: string, top: number, bottom: number): void => {
    const prevTop = contentTopByPool.get(poolId);
    if (prevTop === undefined || top < prevTop) contentTopByPool.set(poolId, top);
    const prevBot = contentBottomByPool.get(poolId);
    if (prevBot === undefined || bottom > prevBot) contentBottomByPool.set(poolId, bottom);
  };

  // (1) artifact（上下两侧都要兜）
  for (const [aid, abox] of input.artifactBoxes) {
    const hostId = input.artifactHosts.get(aid);
    if (!hostId) continue;
    const poolId = input.nodeToPool.get(hostId);
    if (!poolId) continue;
    widen(poolId, abox.y - PAD, abox.y + abox.h + PAD);
  }
  // (2) ioSpec dataInput/Output（serializer 摆在 task 下方，layoutBox 预扣空间）
  for (const [nodeId, boxes] of input.nodeLayoutBoxes) {
    const box = boxes.layoutBox;
    const poolId = input.nodeToPool.get(nodeId);
    if (!poolId) continue;
    widen(poolId, box.y, box.y + box.h + PAD);
  }
  // (3) BE & handler 节点
  for (const [beId, beBox] of input.boundaryEventBoxes) {
    const hostId = input.boundaryEventHosts.get(beId);
    if (!hostId) continue;
    const poolId = input.nodeToPool.get(hostId);
    if (!poolId) continue;
    widen(poolId, beBox.y - PAD, beBox.y + beBox.h + PAD);
  }
  for (const [nodeId, box] of input.handlerNodeBoxes) {
    const hostId = input.handlerNodeHosts.get(nodeId);
    if (!hostId) continue;
    const poolId = input.nodeToPool.get(hostId);
    if (!poolId) continue;
    widen(poolId, box.y - PAD, box.y + box.h + PAD);
  }

  // ── Pass A: 每 pool 算 topOverflow / bottomGrow ──
  const orderedPools = [...input.poolBoxes.values()].sort((a, b) => a.y - b.y);
  const topOverflowByPool = new Map<string, number>();
  const bottomGrowByPool = new Map<string, number>();
  for (const pool of orderedPools) {
    const innerTop = pool.y + POOL_PAD_Y;
    const innerBottom = pool.y + pool.h - POOL_PAD_Y;
    const cTop = contentTopByPool.get(pool.id);
    const cBot = contentBottomByPool.get(pool.id);
    const topOverflow = cTop !== undefined && cTop < innerTop ? innerTop - cTop : 0;
    const bottomGrow = cBot !== undefined && cBot > innerBottom ? cBot - innerBottom : 0;
    topOverflowByPool.set(pool.id, topOverflow);
    bottomGrowByPool.set(pool.id, bottomGrow);
  }

  // ── Pass B: 累加位移，原地改 pool.y / pool.h ──
  // 对 pool[i]：pool.y += cumulativeDown（前面 pool 增长累积）；
  //            pool.h += (topOverflow_i + bottomGrow_i)；
  //            pool 内 content 下移 (cumulativeDown + topOverflow_i)；
  //            cumulativeDown += topOverflow_i + bottomGrow_i。
  const poolContentShift = new Map<string, number>();
  let cumulativeDown = 0;
  let totalExtraHeight = 0;
  for (const pool of orderedPools) {
    const topOverflow = topOverflowByPool.get(pool.id) ?? 0;
    const bottomGrow = bottomGrowByPool.get(pool.id) ?? 0;
    pool.y += cumulativeDown;
    pool.h += topOverflow + bottomGrow;
    poolContentShift.set(pool.id, cumulativeDown + topOverflow);
    cumulativeDown += topOverflow + bottomGrow;
    totalExtraHeight = cumulativeDown;
  }

  // ── 应用 content shift（原地改各 box.y）──
  const needContentShift =
    cumulativeDown > 0 || [...topOverflowByPool.values()].some(v => v > 0);
  if (needContentShift) {
    const shiftBoxByHost = (
      boxes: Map<string, NodeBox>,
      hostLookup: Map<string, string>,
    ): void => {
      for (const [id, box] of boxes) {
        const hostId = hostLookup.get(id);
        if (!hostId) continue;
        const poolId = input.nodeToPool.get(hostId);
        if (!poolId) continue;
        const dy = poolContentShift.get(poolId) ?? 0;
        if (dy) box.y += dy;
      }
    };
    for (const [nodeId, box] of input.nodes) {
      const poolId = input.nodeToPool.get(nodeId);
      if (!poolId) continue;
      const dy = poolContentShift.get(poolId) ?? 0;
      if (dy) box.y += dy;
    }
    for (const [, lb] of input.laneBoxes) {
      const dy = poolContentShift.get(lb.poolId) ?? 0;
      if (dy) {
        lb.top += dy;
        lb.bottom += dy;
        lb.centerY += dy;
      }
    }
    // 展开 subprocess 内部节点：跟 owner pool 一起 shift
    for (const [innerId, box] of input.expandedInnerNodes) {
      const ownerPoolId = input.innerNodeOwnerPool.get(innerId);
      if (!ownerPoolId) continue;
      const dy = poolContentShift.get(ownerPoolId) ?? 0;
      if (dy) box.y += dy;
    }
    shiftBoxByHost(input.artifactBoxes, input.artifactHosts);
    shiftBoxByHost(input.boundaryEventBoxes, input.boundaryEventHosts);
    shiftBoxByHost(input.handlerNodeBoxes, input.handlerNodeHosts);
  }

  // bottomGrow 单独把底部 leaf lane 拉高（不是整层 shift）
  for (const pool of orderedPools) {
    const bottomGrow = bottomGrowByPool.get(pool.id) ?? 0;
    if (bottomGrow === 0) continue;
    const bottomLaneId = input.bottomLaneByPool.get(pool.id);
    if (!bottomLaneId) continue;
    const lane = input.laneBoxes.get(bottomLaneId);
    if (!lane) continue;
    lane.bottom += bottomGrow;
    lane.height += bottomGrow;
    lane.centerY = (lane.top + lane.bottom) / 2;
  }

  // ── 水平扩展（handler 右溢出 pool 右边界）──
  // inter-host collision shift 可能把后面的 handler 群推得很远；按 pool 收集 needRight，
  // 扩 pool.w 与 totalBounds.width。
  const needRightByPool = new Map<string, number>();
  for (const [nodeId, box] of input.handlerNodeBoxes) {
    const hostId = input.handlerNodeHosts.get(nodeId);
    if (!hostId) continue;
    const poolId = input.nodeToPool.get(hostId);
    if (!poolId) continue;
    const prev = needRightByPool.get(poolId) ?? -Infinity;
    const candidate = box.x + box.w + PAD;
    if (candidate > prev) needRightByPool.set(poolId, candidate);
  }
  let extraTotalWidth = 0;
  for (const [poolId, needRight] of needRightByPool) {
    const pool = input.poolBoxes.get(poolId);
    if (!pool) continue;
    const poolInnerRight = pool.x + pool.w - POOL_PAD_X;
    if (needRight <= poolInnerRight) continue;
    const delta = needRight - poolInnerRight;
    pool.w += delta;
    if (delta > extraTotalWidth) extraTotalWidth = delta;
  }

  return {
    totalBounds: {
      width: input.totalBounds.width + extraTotalWidth,
      height: input.totalBounds.height + totalExtraHeight,
    },
  };
}
