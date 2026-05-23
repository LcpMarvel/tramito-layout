import { describe, expect, it, beforeAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadFixture } from '../src/loader/loader.ts';
import { elkPlacement } from '../src/stages/elk-placement.ts';
import { laneConstrain } from '../src/stages/lane-constrainer.ts';
import { ioSpecExtraBelow, nodeSizeOf, LANE_MIN_H } from '../src/layout/node-sizes.ts';
import { warmup } from '../src/layout/elk-singleton.ts';

const FIX = (n: string) =>
  JSON.parse(readFileSync(resolve(import.meta.dir, '../fixtures', `${n}.json`), 'utf-8'));

async function runStage1And2(fixtureName: string, opts?: { processFilter?: (p: any) => boolean }) {
  const m = loadFixture(fixtureName, FIX(fixtureName));
  const filter = opts?.processFilter ?? ((p: any) => !p.isBlackBox && p.flowNodes.length > 0);
  const proc = m.processes.find(filter)!;
  const placement = await elkPlacement({
    processId: proc.id,
    nodes: proc.flowNodes
      .filter(n => n.type !== 'boundaryEvent')
      .map(n => ({ id: n.id, type: n.type, ...nodeSizeOf(n.type) })),
    edges: proc.sequenceFlows.map(sf => ({ id: sf.id, source: sf.source, target: sf.target })),
  });
  const constrain = laneConstrain({
    nodes: placement.nodes,
    width: placement.bounds.width,
    lanes: proc.lanes,
    nodeMeta: new Map(proc.flowNodes.map(n => [n.id, {
      type: n.type,
      name: n.name,
      ioInputCount: n.ioInputCount,
      ioOutputCount: n.ioOutputCount,
    }])),
  });
  return { proc, placement, constrain };
}

describe('Stage 2 — LaneConstrainer', () => {
  beforeAll(async () => { await warmup(); });

  it('passes through when pool has no lanes', async () => {
    const { placement, constrain } = await runStage1And2('01-simple-process');
    expect(constrain.laneBoxes.size).toBe(0);
    expect(constrain.leafOrder.length).toBe(0);
    expect(constrain.nodes.size).toBe(placement.nodes.size);
    for (const [id, box] of placement.nodes) {
      expect(constrain.nodes.get(id)?.y).toBe(box.y); // Y not changed
    }
  });

  it('snaps each node Y into its assigned leaf lane band (26-lanes, flat)', async () => {
    const { constrain } = await runStage1And2('26-collaboration-lanes');
    expect(constrain.leafOrder).toEqual(['lane_sales', 'lane_finance']);
    expect(constrain.laneBoxes.size).toBe(2);
    // 销售部 在上、财务部 在下
    const sales = constrain.laneBoxes.get('lane_sales')!;
    const finance = constrain.laneBoxes.get('lane_finance')!;
    expect(sales.top).toBe(0);
    expect(sales.bottom).toBe(finance.top); // 紧贴
    // 节点 Y 必须落在所属 lane 内
    const memberOf: Record<string, string> = {
      start_1: 'lane_sales', task_quote: 'lane_sales',
      task_review: 'lane_finance', end_1: 'lane_finance',
    };
    for (const [nodeId, laneId] of Object.entries(memberOf)) {
      const box = constrain.nodes.get(nodeId)!;
      const band = constrain.laneBoxes.get(laneId)!;
      expect(box.y).toBeGreaterThanOrEqual(band.top);
      expect(box.y + box.h).toBeLessThanOrEqual(band.bottom);
    }
  });

  it('flattens nested lanes DFS order (27-nested-lanes)', async () => {
    const { constrain } = await runStage1And2('27-collaboration-nested-lanes');
    // 管理层 → 执行层(团队A → 团队B)
    expect(constrain.leafOrder).toEqual(['lane_management', 'lane_team_a', 'lane_team_b']);
    // laneBoxes 含中间层（执行层）→ 4 = 3 leaf + 1 parent
    expect(constrain.laneBoxes.size).toBe(4);
    // allLanes 按 DFS document 顺序，parent 在 children 之前
    expect(constrain.allLanes).toEqual([
      'lane_management', 'lane_execution', 'lane_team_a', 'lane_team_b',
    ]);
  });

  it('gives empty lane its min height (35-voc has empty 品管部)', async () => {
    const { constrain } = await runStage1And2('35-voc-cross-lane');
    expect(constrain.leafOrder).toContain('lane_qc_dept');
    const qc = constrain.laneBoxes.get('lane_qc_dept')!;
    expect(qc.height).toBe(LANE_MIN_H);
  });

  it('lane boxes do not overlap and total height matches poolHeight', async () => {
    const { constrain } = await runStage1And2('35-voc-cross-lane');
    const sorted = [...constrain.laneBoxes.values()].sort((a, b) => a.top - b.top);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.top).toBeGreaterThanOrEqual(sorted[i - 1]!.bottom);
    }
    const totalLaneH = sorted.reduce((s, l) => s + l.height, 0);
    expect(constrain.poolHeight).toBe(totalLaneH);
  });

  it('preserves X exactly (only touches Y)', async () => {
    const { placement, constrain } = await runStage1And2('26-collaboration-lanes');
    for (const [id, box] of placement.nodes) {
      expect(constrain.nodes.get(id)!.x).toBe(box.x);
      expect(constrain.nodes.get(id)!.w).toBe(box.w);
      expect(constrain.nodes.get(id)!.h).toBe(box.h);
    }
  });

  it('reserves lane-local space for ioSpecification data shapes (37-crm)', async () => {
    const { proc, constrain } = await runStage1And2('37-crm-voice-process');
    const task = proc.flowNodes.find(n => n.id === 'task_split_create_issue')!;
    const box = constrain.nodes.get(task.id)!;
    const lane = constrain.laneBoxes.get('lane_sales_support')!;
    const reservedBottom = box.y + box.h + ioSpecExtraBelow(task.ioInputCount, task.ioOutputCount);

    expect(task.ioOutputCount).toBe(3);
    expect(reservedBottom).toBeLessThanOrEqual(lane.bottom);
  });
});
