import { describe, expect, it } from 'bun:test';
import {
  collectContainmentConstraints,
  collectPoolStackConstraints,
  collectRouteConstraints,
  summarizeConstraints,
} from '../src/stages/constraint-model.ts';
import type { EdgeRoute, NodeBox, PoolBox } from '../src/stages/types.ts';

const box = (x: number, y: number, w = 100, h = 80): NodeBox => ({ x, y, w, h });

describe('ConstraintModel', () => {
  it('summarizes containment and pool stack constraints', () => {
    const poolBoxes = new Map<string, PoolBox>([
      ['p1', { id: 'p1', x: 0, y: 0, w: 300, h: 160 }],
      ['p2', { id: 'p2', x: 0, y: 190, w: 300, h: 160 }],
    ]);
    const constraints = [
      ...collectPoolStackConstraints(poolBoxes),
      ...collectContainmentConstraints({
        nodes: [{ id: 'task1', poolId: 'p1', laneId: 'lane1' }],
        lanes: [{ id: 'lane1', poolId: 'p1' }],
      }),
    ];
    expect(summarizeConstraints(constraints)).toEqual({
      total: 4,
      byKind: { 'stack-vertical': 1, contains: 3 },
    });
  });

  it('collects port-side constraints from finalized routes', () => {
    const route: EdgeRoute = {
      edgeId: 'flow1',
      edgeType: 'forward-straight',
      sourcePort: { nodeId: 'a', side: 'right', point: { x: 100, y: 40 }, boundary: 'box' },
      targetPort: { nodeId: 'b', side: 'left', point: { x: 200, y: 40 }, boundary: 'box' },
      waypoints: [{ x: 100, y: 40 }, { x: 200, y: 40 }],
      channel: 0,
    };
    const constraints = collectRouteConstraints(new Map([['flow1', route]]));
    expect(constraints).toHaveLength(2);
    expect(constraints.map(c => c.kind)).toEqual(['port-side', 'port-side']);
    expect(constraints[0]).toMatchObject({
      port: { kind: 'port', id: 'flow1:source' },
      node: { kind: 'node', id: 'a' },
      side: 'right',
    });
  });

  it('does not invent stack constraints for a single pool', () => {
    const constraints = collectPoolStackConstraints(new Map([
      ['p1', { id: 'p1', ...box(0, 0) }],
    ]));
    expect(constraints).toHaveLength(0);
  });
});
