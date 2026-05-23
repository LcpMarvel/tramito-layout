import { describe, expect, it, beforeAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadFixture } from '../src/loader/loader.ts';
import type { ProcessUnit } from '../src/loader/types.ts';
import { elkPlacement } from '../src/stages/elk-placement.ts';
import { laneConstrain } from '../src/stages/lane-constrainer.ts';
import { poolCompose, type ComposeInputPool } from '../src/stages/pool-composer.ts';
import { nodeSizeOf, POOL_GAP } from '../src/layout/node-sizes.ts';
import { warmup } from '../src/layout/elk-singleton.ts';

const FIX = (n: string) =>
  JSON.parse(readFileSync(resolve(import.meta.dir, '../fixtures', `${n}.json`), 'utf-8'));

async function runStages1To3(fixtureName: string) {
  const m = loadFixture(fixtureName, FIX(fixtureName));
  const inputs: ComposeInputPool[] = [];
  for (const proc of m.processes) {
    if (proc.isBlackBox || proc.flowNodes.length === 0) {
      inputs.push({
        id: proc.id,
        name: proc.name,
        isBlackBox: proc.isBlackBox,
        nodes: new Map(),
        laneBoxes: new Map(),
        leafOrder: [],
        allLanes: [],
        width: 200,
        height: 60,
      });
      continue;
    }
    const placement = await elkPlacement({
      processId: proc.id,
      nodes: proc.flowNodes.filter(n => n.type !== 'boundaryEvent').map(n => ({
        id: n.id, type: n.type, ...nodeSizeOf(n.type),
      })),
      edges: proc.sequenceFlows.map(sf => ({ id: sf.id, source: sf.source, target: sf.target })),
    });
    const constrain = laneConstrain({
      nodes: placement.nodes, width: placement.bounds.width, lanes: proc.lanes,
    });
    inputs.push({
      id: proc.id,
      name: proc.name,
      isBlackBox: false,
      nodes: constrain.nodes,
      laneBoxes: constrain.laneBoxes,
      leafOrder: constrain.leafOrder,
      allLanes: constrain.allLanes,
      width: constrain.poolWidth,
      height: constrain.poolHeight,
    });
  }
  return { processes: m.processes, output: poolCompose({ pools: inputs }) };
}

describe('Stage 3 — PoolComposer', () => {
  beforeAll(async () => { await warmup(); });

  it('stacks pools vertically with POOL_GAP between (29-message-flows)', async () => {
    const { output } = await runStages1To3('29-collaboration-message-flows');
    const pools = [...output.poolBoxes.values()].sort((a, b) => a.y - b.y);
    expect(pools.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < pools.length; i++) {
      const prev = pools[i - 1]!;
      const cur = pools[i]!;
      expect(cur.y).toBe(prev.y + prev.h + POOL_GAP);
    }
  });

  it('all pools share the same width (cross-pool alignment)', async () => {
    const { output } = await runStages1To3('29-collaboration-message-flows');
    const ws = new Set([...output.poolBoxes.values()].map(p => p.w));
    expect(ws.size).toBe(1);
  });

  it('every node falls completely within its pool box (N3 invariant)', async () => {
    const fixtures = ['29-collaboration-message-flows', '26-collaboration-lanes', '04-all-gateways'];
    for (const f of fixtures) {
      const { output } = await runStages1To3(f);
      for (const [nodeId, nb] of output.nodes) {
        const poolId = output.nodeToPool.get(nodeId)!;
        const pb = output.poolBoxes.get(poolId)!;
        expect(nb.x).toBeGreaterThanOrEqual(pb.x);
        expect(nb.y).toBeGreaterThanOrEqual(pb.y);
        expect(nb.x + nb.w).toBeLessThanOrEqual(pb.x + pb.w);
        expect(nb.y + nb.h).toBeLessThanOrEqual(pb.y + pb.h);
      }
    }
  });

  it('lane band sits inside its pool', async () => {
    const { output } = await runStages1To3('26-collaboration-lanes');
    for (const [, lb] of output.laneBoxes) {
      const pb = output.poolBoxes.get(lb.poolId)!;
      expect(lb.top).toBeGreaterThanOrEqual(pb.y);
      expect(lb.bottom).toBeLessThanOrEqual(pb.y + pb.h);
    }
  });

  it('node → lane reverse-lookup matches lane membership (26)', async () => {
    const { output } = await runStages1To3('26-collaboration-lanes');
    expect(output.nodeToLane.get('start_1')).toBe('lane_sales');
    expect(output.nodeToLane.get('task_quote')).toBe('lane_sales');
    expect(output.nodeToLane.get('task_review')).toBe('lane_finance');
    expect(output.nodeToLane.get('end_1')).toBe('lane_finance');
  });

  it('laneIdx is ascending in leaf order', async () => {
    const { output } = await runStages1To3('27-collaboration-nested-lanes');
    expect(output.laneIdx.get('lane_management')).toBe(0);
    expect(output.laneIdx.get('lane_team_a')).toBe(1);
    expect(output.laneIdx.get('lane_team_b')).toBe(2);
  });

  it('handles black-box pool as visible rect with no flow nodes', async () => {
    const { output } = await runStages1To3('25-collaboration-black-box');
    const blackBox = [...output.poolBoxes.values()].find(p => p.isBlackBox);
    expect(blackBox).toBeTruthy();
    expect(blackBox!.h).toBeGreaterThan(0);
  });
});
