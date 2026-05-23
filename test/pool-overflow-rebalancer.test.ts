import { describe, expect, it } from 'bun:test';
import { rebalancePoolOverflow } from '../src/stages/index.ts';
import type { NodeBox, NodeLayoutBox, PoolBox } from '../src/stages/index.ts';

describe('PoolOverflowRebalancer', () => {
  it('uses layoutBox to reserve ioSpec space without changing the visual node box', () => {
    const taskBox: NodeBox = { x: 50, y: 40, w: 100, h: 80 };
    const nodes = new Map<string, NodeBox>([['task_1', taskBox]]);
    const nodeLayoutBoxes = new Map<string, NodeLayoutBox>([
      ['task_1', {
        visualBox: taskBox,
        layoutBox: { x: 50, y: 40, w: 100, h: 180 },
      }],
    ]);
    const poolBoxes = new Map<string, PoolBox & { name?: string; isBlackBox?: boolean }>([
      ['process_1', { id: 'process_1', x: 0, y: 0, w: 240, h: 160 }],
    ]);

    rebalancePoolOverflow({
      poolBoxes,
      totalBounds: { width: 240, height: 160 },
      nodes,
      laneBoxes: new Map(),
      expandedInnerNodes: new Map(),
      artifactBoxes: new Map(),
      boundaryEventBoxes: new Map(),
      handlerNodeBoxes: new Map(),
      nodeToPool: new Map([['task_1', 'process_1']]),
      artifactHosts: new Map(),
      boundaryEventHosts: new Map(),
      handlerNodeHosts: new Map(),
      innerNodeOwnerPool: new Map(),
      nodeLayoutBoxes,
      bottomLaneByPool: new Map(),
    });

    expect(taskBox.h).toBe(80);
    expect(poolBoxes.get('process_1')!.h).toBeGreaterThan(160);
  });
});
