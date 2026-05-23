import { describe, expect, it } from 'bun:test';
import { stabilizeWithPreviousBoxes } from '../src/stages/incremental-stabilizer.ts';
import type { LaneBox, NodeBox, PoolBox } from '../src/stages/types.ts';

const box = (x: number, y: number, w = 100, h = 80): NodeBox => ({ x, y, w, h });

const pool: PoolBox = { id: 'p1', x: 0, y: 0, w: 600, h: 240 };
const lane: LaneBox & { poolId: string } = {
  poolId: 'p1',
  top: 20,
  bottom: 180,
  centerY: 100,
  height: 160,
};

function baseInput(previousBoxes: Map<string, NodeBox>) {
  return {
    nodes: new Map<string, NodeBox>([
      ['a', box(160, 60)],
      ['b', box(320, 60)],
    ]),
    previousBoxes,
    nodeMeta: new Map([
      ['a', { poolId: 'p1', laneId: 'l1' }],
      ['b', { poolId: 'p1', laneId: 'l1' }],
    ]),
    poolBoxes: new Map([['p1', pool]]),
    laneBoxes: new Map([['l1', lane]]),
  };
}

describe('IncrementalStabilizer', () => {
  it('applies previous x when the candidate is safe', () => {
    const out = stabilizeWithPreviousBoxes(baseInput(new Map([
      ['a', box(220, 60)],
    ])));
    expect(out.nodes.get('a')?.x).toBe(220);
    expect(out.appliedCount).toBe(1);
    expect(out.skippedCount).toBe(0);
    expect(out.constraints[0]).toMatchObject({ kind: 'preserve-position' });
    expect(out.decisions[0]).toMatchObject({
      kind: 'incremental-preserve',
      output: { applied: true, x: 220, deltaX: 60 },
    });
  });

  it('skips previous x when it would overlap a peer', () => {
    const out = stabilizeWithPreviousBoxes(baseInput(new Map([
      ['a', box(300, 60)],
    ])));
    expect(out.nodes.get('a')?.x).toBe(160);
    expect(out.appliedCount).toBe(0);
    expect(out.skippedCount).toBe(1);
    expect(out.decisions[0]?.output?.applied).toBe(false);
  });

  it('skips previous boxes with different size', () => {
    const out = stabilizeWithPreviousBoxes(baseInput(new Map([
      ['a', box(220, 60, 120, 80)],
    ])));
    expect(out.nodes.get('a')?.x).toBe(160);
    expect(out.appliedCount).toBe(0);
    expect(out.skippedCount).toBe(1);
  });

  it('is a no-op when no previous boxes are provided', () => {
    const out = stabilizeWithPreviousBoxes(baseInput(new Map()));
    expect(out.nodes).toEqual(baseInput(new Map()).nodes);
    expect(out.constraints).toEqual([]);
    expect(out.decisions).toEqual([]);
  });
});
