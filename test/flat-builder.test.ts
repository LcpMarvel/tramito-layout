import { describe, expect, it } from 'bun:test';
import { flatToNested } from '../src/loader/flat-builder.ts';
import { validateFlat } from '../src/loader/flat.ts';
import { loadFixture } from '../src/loader/loader.ts';
import { layoutBpmnFlat } from '../src/index.ts';
import type { FlatBpmn } from '../src/loader/flat-types.ts';

const errs = (f: FlatBpmn) => validateFlat(f).filter((i) => i.severity === 'error');
const codes = (f: FlatBpmn) => validateFlat(f).map((i) => i.code);
// flatToNested 是编译用代码确定性产物，喂 loadFixture 得到与嵌套门同构的 BpmnModel。
const model = (f: FlatBpmn) => loadFixture('flat-test', flatToNested(f) as any);

const SIMPLE: FlatBpmn = {
  nodes: [
    { id: 'start_3', type: 'startEvent', name: '提交' },
    { id: 'task_4', type: 'userTask', name: '审核' },
    { id: 'gw_5', type: 'exclusiveGateway', name: '结果', default: 'flow_12' },
    { id: 'task_6', type: 'serviceTask', name: '处理' },
    { id: 'end_7', type: 'endEvent', name: '通过' },
    { id: 'end_8', type: 'endEvent', name: '拒绝' },
  ],
  edges: [
    { id: 'flow_9', source: 'start_3', target: 'task_4' },
    { id: 'flow_10', source: 'task_4', target: 'gw_5' },
    { id: 'flow_11', source: 'gw_5', target: 'task_6', name: '通过', condition: '${ok}' },
    { id: 'flow_12', source: 'gw_5', target: 'end_8', name: '拒绝', isDefault: true },
    { id: 'flow_13', source: 'task_6', target: 'end_7' },
  ],
};

const LANES: FlatBpmn = {
  pools: [{ id: 'pool_3', name: '公司' }],
  lanes: [
    { id: 'lane_5', name: '申请人', pool: 'pool_3' },
    { id: 'lane_8', name: '经理', pool: 'pool_3' },
    { id: 'lane_11', name: '人事', pool: 'pool_3' },
  ],
  nodes: [
    { id: 'start_6', type: 'startEvent', name: '开始', lane: 'lane_5' },
    { id: 'task_7', type: 'userTask', name: '提交', lane: 'lane_5' },
    { id: 'task_9', type: 'userTask', name: '审核', lane: 'lane_8' },
    { id: 'task_12', type: 'serviceTask', name: '归档', lane: 'lane_11' },
    { id: 'end_13', type: 'endEvent', name: '完成', lane: 'lane_11' },
  ],
  edges: [
    { id: 'flow_14', source: 'start_6', target: 'task_7' },
    { id: 'flow_15', source: 'task_7', target: 'task_9' },
    { id: 'flow_16', source: 'task_9', target: 'task_12' },
    { id: 'flow_17', source: 'task_12', target: 'end_13' },
  ],
};

const BOUNDARY: FlatBpmn = {
  nodes: [
    { id: 'start_3', type: 'startEvent' },
    { id: 'task_4', type: 'userTask', name: '设计' },
    { id: 'be_5', type: 'boundaryEvent', name: '超时', attachedTo: 'task_4', eventDefinitionType: 'timer', isInterrupting: false },
    { id: 'task_6', type: 'userTask', name: '评审' },
    { id: 'end_7', type: 'endEvent' },
  ],
  edges: [
    { id: 'flow_8', source: 'start_3', target: 'task_4' },
    { id: 'flow_9', source: 'task_4', target: 'end_7' },
    { id: 'flow_10', source: 'be_5', target: 'task_6' },
    { id: 'flow_11', source: 'task_6', target: 'end_7' },
  ],
};

const CROSS_POOL: FlatBpmn = {
  pools: [{ id: 'cust', name: '客户' }, { id: 'shop', name: '商家' }],
  nodes: [
    { id: 'c1', type: 'startEvent', pool: 'cust' },
    { id: 'c2', type: 'sendTask', name: '下单', pool: 'cust' },
    { id: 'c3', type: 'endEvent', pool: 'cust' },
    { id: 's1', type: 'receiveTask', name: '接单', pool: 'shop' },
    { id: 's2', type: 'endEvent', pool: 'shop' },
  ],
  edges: [
    { id: 'f1', source: 'c1', target: 'c2' },
    { id: 'f2', source: 'c2', target: 'c3' },
    { id: 'f3', source: 's1', target: 's2' },
    { id: 'mf', source: 'c2', target: 's1' }, // 跨池、未标 type → 自动 messageFlow
  ],
};

describe('flatToNested — 结构装配', () => {
  it('单 process：节点平铺、边进 process、validate 全清', () => {
    expect(errs(SIMPLE)).toEqual([]);
    const m = model(SIMPLE);
    expect(m.processes.length).toBe(1);
    expect(m.processes[0]!.flowNodes.map((n) => n.id).sort()).toEqual(
      ['end_7', 'end_8', 'gw_5', 'start_3', 'task_4', 'task_6'],
    );
    expect(m.processes[0]!.sequenceFlows.length).toBe(5);
  });

  it('泳道：节点按 lane 分组进 lane.children、memberRefs 正确、partition 已配（无 LANE_* 报错/告警）', () => {
    const c = codes(LANES);
    expect(c.filter((x) => x.startsWith('LANE_'))).toEqual([]);
    expect(errs(LANES)).toEqual([]);
    const m = model(LANES);
    const proc = m.processes[0]!;
    expect(proc.lanes.map((l) => l.id).sort()).toEqual(['lane_11', 'lane_5', 'lane_8']);
    const byLane = Object.fromEntries(proc.lanes.map((l) => [l.id, l.memberRefs.sort()]));
    expect(byLane['lane_5']).toEqual(['start_6', 'task_7']);
    expect(byLane['lane_8']).toEqual(['task_9']);
    expect(byLane['lane_11']).toEqual(['end_13', 'task_12']);
  });

  it('边界事件：从 nodes 提出来挂宿主 boundaryEvents、不进 children', () => {
    expect(errs(BOUNDARY)).toEqual([]);
    const nested = flatToNested(BOUNDARY) as any;
    const proc = nested.children[0];
    const task4 = proc.children.find((c: any) => c.id === 'task_4');
    expect(task4.boundaryEvents.map((b: any) => b.id)).toEqual(['be_5']);
    // be_5 不应作为普通 child 出现
    expect(proc.children.some((c: any) => c.id === 'be_5')).toBe(false);
    const m = model(BOUNDARY);
    const deco = m.processes[0]!.decorations.find((d) => d.kind === 'boundaryEvent');
    expect(deco && (deco as any).host).toBe('task_4');
  });

  it('跨池连线：未标 type 的跨池边自动归 collaboration.edges 为 messageFlow', () => {
    expect(errs(CROSS_POOL)).toEqual([]);
    const m = model(CROSS_POOL);
    expect(m.collaborationMessageFlows.map((mf) => mf.id)).toEqual(['mf']);
    expect(m.processes.length).toBe(2);
    // 两个池内各自的 sequenceFlow 不串
    const flows = m.processes.flatMap((p) => p.sequenceFlows.map((f) => f.id)).sort();
    expect(flows).toEqual(['f1', 'f2', 'f3']);
  });
});

describe('validateFlat — 只剩语义错（结构错已被构造消灭）', () => {
  it('悬空边端点 → EDGE_ENDPOINT_MISSING', () => {
    const bad: FlatBpmn = {
      nodes: [{ id: 'a', type: 'startEvent' }, { id: 'b', type: 'endEvent' }],
      edges: [{ id: 'e', source: 'a', target: 'ghost' }],
    };
    expect(codes(bad)).toContain('EDGE_ENDPOINT_MISSING');
  });

  it('重复 id → DUPLICATE_ID', () => {
    const bad: FlatBpmn = {
      nodes: [{ id: 'dup', type: 'startEvent' }, { id: 'dup', type: 'endEvent' }],
      edges: [],
    };
    expect(codes(bad)).toContain('DUPLICATE_ID');
  });

  it('合法图 0 error', () => {
    expect(errs(SIMPLE)).toEqual([]);
    expect(errs(LANES)).toEqual([]);
    expect(errs(BOUNDARY)).toEqual([]);
    expect(errs(CROSS_POOL)).toEqual([]);
  });
});

describe('layoutBpmnFlat — 端到端出 XML', () => {
  it('四类图都能编译出非空 BPMN XML', async () => {
    for (const f of [SIMPLE, LANES, BOUNDARY, CROSS_POOL]) {
      const { xml } = await layoutBpmnFlat(f);
      expect(xml.length).toBeGreaterThan(500);
      expect(xml).toContain('BPMNDiagram');
    }
  });
});
