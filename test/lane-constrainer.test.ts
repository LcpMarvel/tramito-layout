import { describe, expect, it, beforeAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadFixture } from '../src/loader/loader.ts';
import { elkPlacement } from '../src/stages/elk-placement.ts';
import { laneConstrain } from '../src/stages/lane-constrainer.ts';
import { ioSpecExtraBelow, layoutHeightWithIoSpec, nodeSizeOf, LANE_MIN_H } from '../src/layout/node-sizes.ts';
import { warmup } from '../src/layout/elk-singleton.ts';
import { leafLaneOrder, nodeToLeafLane } from '../src/layout/lane-resolver.ts';

const FIX = (n: string) =>
  JSON.parse(readFileSync(resolve(import.meta.dir, '../fixtures', `${n}.json`), 'utf-8'));

async function runStage1And2(fixtureName: string, opts?: { processFilter?: (p: any) => boolean }) {
  const m = loadFixture(fixtureName, FIX(fixtureName));
  const filter = opts?.processFilter ?? ((p: any) => !p.isBlackBox && p.flowNodes.length > 0);
  const proc = m.processes.find(filter)!;
  const leafOrder = leafLaneOrder(proc.lanes);
  const leafIndex = new Map(leafOrder.map((id, index) => [id, index]));
  const nodeLeaf = nodeToLeafLane(proc.lanes, leafOrder);
  const placement = await elkPlacement({
    processId: proc.id,
    hasLanes: proc.lanes.length > 0,
    hasBoundaryHandlers: proc.decorations.some((d: any) => d.kind === 'boundaryEvent'),
    nodes: proc.flowNodes
      .filter(n => n.type !== 'boundaryEvent')
      .map(n => {
        const size = nodeSizeOf(n.type);
        return {
          id: n.id,
          type: n.type,
          ...size,
          layoutH: layoutHeightWithIoSpec(size.h, n.ioInputCount, n.ioOutputCount, n.ioInputNames, n.ioOutputNames, size.w),
          laneIndex: leafIndex.get(nodeLeaf.get(n.id) ?? ''),
        };
      }),
    edges: proc.sequenceFlows.map(sf => ({ id: sf.id, source: sf.source, target: sf.target })),
  });
  const constrain = laneConstrain({
    nodes: placement.nodes,
    width: placement.bounds.width,
    height: placement.bounds.height,
    lanes: proc.lanes,
    nodeMeta: new Map(proc.flowNodes.map(n => [n.id, {
      type: n.type,
      name: n.name,
      ioInputCount: n.ioInputCount,
      ioOutputCount: n.ioOutputCount,
      ioInputNames: n.ioInputNames,
      ioOutputNames: n.ioOutputNames,
    }])),
    edges: proc.sequenceFlows.map(sf => ({ source: sf.source, target: sf.target })),
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

  it('uses Stage 1 bounds for no-lane pool height', () => {
    const nodes = new Map([['task_with_io', { x: 50, y: 40, w: 100, h: 80 }]]);
    const constrain = laneConstrain({
      nodes,
      width: 200,
      height: 260,
      lanes: [],
      nodeMeta: new Map([['task_with_io', {
        type: 'task',
        ioInputCount: 0,
        ioOutputCount: 2,
      }]]),
    });

    expect(constrain.nodes.get('task_with_io')!.h).toBe(80);
    expect(constrain.poolHeight).toBe(260);
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

  it('spreads off-spine branch onto a separate row, spine aligned (36-voc marketing lane)', async () => {
    const { constrain } = await runStage1And2('36-voc-vop-capture-process');
    // 主干（最长前向链）的节点应共用一条对齐行
    const spineIds = [
      'gateway_parallel_fork', 'task_receive_voc', 'gateway_customer_type',
      'gateway_related', 'gateway_department', 'task_marketing_receive', 'gateway_parallel_join',
    ];
    const cy = (id: string) => { const b = constrain.nodes.get(id)!; return b.y + b.h / 2; };
    const spineCy = cy(spineIds[0]!);
    for (const id of spineIds) expect(Math.abs(cy(id) - spineCy)).toBeLessThan(1);
    // 内销分支任务离开主干行，落到上 / 下方（填满泳道）
    expect(Math.abs(cy('task_marketing_after_sales') - spineCy)).toBeGreaterThan(60);
  });

  it('reserves lane-local space for ioSpecification data shapes (37-crm)', async () => {
    const { proc, constrain } = await runStage1And2('37-crm-voice-process');
    const task = proc.flowNodes.find(n => n.id === 'task_split_create_issue')!;
    const box = constrain.nodes.get(task.id)!;
    const lane = constrain.laneBoxes.get('lane_sales_support')!;
    const reservedBottom = box.y + box.h + ioSpecExtraBelow(
      task.ioInputCount,
      task.ioOutputCount,
      task.ioInputNames,
      task.ioOutputNames,
      box.w,
    );

    expect(task.ioOutputCount).toBe(3);
    expect(reservedBottom).toBeLessThanOrEqual(lane.bottom);
  });

  // fixture 44：经理审批(task_mgr)是 cross-lane-up 驳回边的源、在 lane 最左、网关(gw_amount)在其右挡道。
  // edge-router 只剩 gap 走廊一条路，走廊默认贴 divider+24、会切穿源 task；lane 必须在顶行上方留
  // 净空把节点压下去，让回边横段跑在节点上方干净带里（用户手调诉求：把泳道弄高点）。
  it('reserves top headroom for a blocked cross-lane-up reject source (44-reimburse)', async () => {
    const { constrain } = await runStage1And2('44-reimburse-amount-reject');
    const lane = constrain.laneBoxes.get('lane_dept')!;
    const mgr = constrain.nodes.get('task_mgr')!;
    // 顶行节点与 lane 顶之间须留出 > 走廊偏移(24)+label，否则 y≈divider+24 的横段会切进 task。
    expect(mgr.y - lane.top).toBeGreaterThan(40);
    // 顶行下移后整条 lane 仍须装得下节点（N3：容器包住 children）。
    expect(mgr.y + mgr.h).toBeLessThanOrEqual(lane.bottom);
  });
});
