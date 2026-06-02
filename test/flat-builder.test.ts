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

const SUBPROC: FlatBpmn = {
  nodes: [
    { id: 'start_1', type: 'startEvent', name: '开始' },
    { id: 'sub_2', type: 'subProcess', name: '审批子流程' },
    { id: 's_start', type: 'startEvent', name: '子开始', parent: 'sub_2' },
    { id: 's_task', type: 'userTask', name: '内部审核', parent: 'sub_2' },
    { id: 's_end', type: 'endEvent', name: '子结束', parent: 'sub_2' },
    { id: 'end_3', type: 'endEvent', name: '结束' },
  ],
  edges: [
    { id: 'f1', source: 'start_1', target: 'sub_2' },
    { id: 'f2', source: 'sub_2', target: 'end_3' },
    { id: 'sf1', source: 's_start', target: 's_task' },
    { id: 'sf2', source: 's_task', target: 's_end' },
  ],
};

describe('flatToNested — 子流程（parent 指向，内部流收进 children/edges）', () => {
  it('内部节点收进 subProcess.children、内部边收进 subProcess.edges、isExpanded=true', () => {
    expect(errs(SUBPROC)).toEqual([]);
    const nested = flatToNested(SUBPROC) as any;
    const proc = nested.children[0];
    const sub = proc.children.find((c: any) => c.id === 'sub_2');
    expect(sub.bpmn.isExpanded).toBe(true);
    expect(sub.children.map((c: any) => c.id)).toEqual(['s_start', 's_task', 's_end']);
    expect(sub.edges.map((e: any) => e.id)).toEqual(['sf1', 'sf2']);
    // 内部节点不出现在顶层；顶层只剩 start/sub/end 和外层两条边
    expect(proc.children.map((c: any) => c.id)).toEqual(['start_1', 'sub_2', 'end_3']);
    expect(proc.edges.map((e: any) => e.id)).toEqual(['f1', 'f2']);
  });

  it('loadFixture 产模：subProcesses 正确，外层 flowNodes 含子流程节点本身', () => {
    const m = model(SUBPROC);
    expect(m.processes[0]!.flowNodes.map((n) => n.id)).toEqual(['start_1', 'sub_2', 'end_3']);
    expect(m.processes[0]!.subProcesses.length).toBe(1);
    const inner = m.processes[0]!.subProcesses[0]!;
    expect(inner.flowNodes.map((n) => n.id)).toEqual(['s_start', 's_task', 's_end']);
    expect(inner.sequenceFlows.map((f) => f.id)).toEqual(['sf1', 'sf2']);
  });

  it('任意层嵌套（子流程套子流程）', () => {
    const nested: FlatBpmn = {
      nodes: [
        { id: 'start_1', type: 'startEvent' },
        { id: 'sub_2', type: 'subProcess', name: '外层' },
        { id: 'sub_3', type: 'subProcess', name: '内层', parent: 'sub_2' },
        { id: 'leaf_4', type: 'userTask', name: '最内', parent: 'sub_3' },
        { id: 'end_5', type: 'endEvent' },
      ],
      edges: [
        { id: 'f1', source: 'start_1', target: 'sub_2' },
        { id: 'f2', source: 'sub_2', target: 'end_5' },
      ],
    };
    expect(errs(nested)).toEqual([]);
    const out = flatToNested(nested) as any;
    const outer = out.children[0].children.find((c: any) => c.id === 'sub_2');
    expect(outer.children.map((c: any) => c.id)).toEqual(['sub_3']);
    const innerSub = outer.children.find((c: any) => c.id === 'sub_3');
    expect(innerSub.children.map((c: any) => c.id)).toEqual(['leaf_4']);
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
    for (const f of [SIMPLE, LANES, BOUNDARY, CROSS_POOL, SUBPROC]) {
      const { xml } = await layoutBpmnFlat(f);
      expect(xml.length).toBeGreaterThan(500);
      expect(xml).toContain('BPMNDiagram');
    }
  });
});

// 回归：扁平专属引用错必须在「扁平词汇」层报清楚，而不是静默吞节点 / 崩进程 / 冒误导性 EDGE_ENDPOINT_MISSING。
// 对应 code-review 发现的 #1~#10：见 src/loader/validate-flat.ts。
describe('validateFlat — 扁平层引用诊断（不静默丢、不崩）', () => {
  const code = (f: FlatBpmn) => errs(f).map((i) => i.code);

  it('attachedTo/parent 成环不死循环，且报 *_SELF_* / REFERENCE_CYCLE', () => {
    // 自指 attachedTo + 边引用它：旧实现会爆栈 / 挂死，这里必须秒回且带错。
    const t0 = Date.now();
    const selfBe = code({
      nodes: [{ id: 'be', type: 'boundaryEvent', attachedTo: 'be' }, { id: 't', type: 'task' }],
      edges: [{ id: 'e', source: 'be', target: 't' }],
    });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(selfBe).toContain('BOUNDARY_SELF_ATTACHED');

    const cycle = code({
      nodes: [{ id: 'a', type: 'subProcess', parent: 'b' }, { id: 'b', type: 'subProcess', parent: 'a' }, { id: 's', type: 'startEvent' }],
      edges: [{ id: 'e', source: 's', target: 'a' }],
    });
    expect(cycle).toContain('REFERENCE_CYCLE');
  });

  it('attachedTo 悬空 → BOUNDARY_HOST_MISSING；boundaryEvent 缺 attachedTo → BOUNDARY_NOT_ATTACHED', () => {
    expect(code({
      nodes: [{ id: 's', type: 'startEvent' }, { id: 'be', type: 'boundaryEvent', attachedTo: 'ghost' }, { id: 'e', type: 'endEvent' }],
      edges: [{ id: 'f1', source: 's', target: 'e' }],
    })).toContain('BOUNDARY_HOST_MISSING');
    expect(code({
      nodes: [{ id: 's', type: 'startEvent' }, { id: 'be', type: 'boundaryEvent' }, { id: 'e', type: 'endEvent' }],
      edges: [{ id: 'f', source: 's', target: 'e' }],
    })).toContain('BOUNDARY_NOT_ATTACHED');
  });

  it('parent 悬空/非子流程 → SUBPROCESS_PARENT_MISSING / _NOT_SUBPROCESS', () => {
    expect(code({
      nodes: [{ id: 't', type: 'task' }, { id: 'a', type: 'task', parent: 't' }, { id: 'e', type: 'endEvent' }],
      edges: [{ id: 'f', source: 'a', target: 'e' }],
    })).toContain('SUBPROCESS_PARENT_NOT_SUBPROCESS');
    expect(code({
      nodes: [{ id: 'a', type: 'task', parent: 'ghost' }, { id: 'e', type: 'endEvent' }],
      edges: [],
    })).toContain('SUBPROCESS_PARENT_MISSING');
  });

  it('泳道引用：非叶子泳道放节点 → LANE_NOT_LEAF；parentLane 悬空 → LANE_PARENT_MISSING', () => {
    expect(code({
      pools: [{ id: 'P' }],
      lanes: [{ id: 'L', pool: 'P' }, { id: 'L1', pool: 'P', parentLane: 'L' }],
      nodes: [{ id: 'n', type: 'task', lane: 'L' }, { id: 'm', type: 'task', lane: 'L1' }],
    })).toContain('LANE_NOT_LEAF');
    expect(code({
      pools: [{ id: 'P' }],
      lanes: [{ id: 'L1', pool: 'P', parentLane: 'ghost' }],
      nodes: [{ id: 'n', type: 'task', lane: 'L1' }],
    })).toContain('LANE_PARENT_MISSING');
  });

  it('多池节点无可解析归属 → NODE_POOL_UNRESOLVED（不再冒误导性 EDGE_ENDPOINT_MISSING）', () => {
    const c = code({
      pools: [{ id: 'A' }, { id: 'B' }],
      nodes: [{ id: 'n1', type: 'task' }, { id: 'n2', type: 'task', pool: 'B' }],
      edges: [{ id: 'e', source: 'n1', target: 'n2' }],
    });
    expect(c).toContain('NODE_POOL_UNRESOLVED');
    // 短路：根因报清楚后，不叠加在残缺嵌套产物上跑出来的 EDGE_ENDPOINT_MISSING。
    expect(c).not.toContain('EDGE_ENDPOINT_MISSING');
  });

  it('sequenceFlow 跨子流程边界 → SEQFLOW_CROSS_SUBPROCESS', () => {
    expect(code({
      nodes: [
        { id: 'sub', type: 'subProcess' }, { id: 'a', type: 'task', parent: 'sub' },
        { id: 'top', type: 'task' }, { id: 's', type: 'startEvent' }, { id: 'en', type: 'endEvent' },
      ],
      edges: [
        { id: 'f0', source: 's', target: 'sub' },
        { id: 'f1', source: 'a', target: 'top' },
        { id: 'f2', source: 'sub', target: 'en' },
      ],
    })).toContain('SEQFLOW_CROSS_SUBPROCESS');
  });

  it('子流程显式 isExpanded:false 被尊重，children 仍保留', () => {
    const nested = flatToNested({
      nodes: [{ id: 's', type: 'startEvent' }, { id: 'sub', type: 'subProcess', isExpanded: false }, { id: 'inner', type: 'task', parent: 'sub' }, { id: 'e', type: 'endEvent' }],
      edges: [{ id: 'f1', source: 's', target: 'sub' }, { id: 'f2', source: 'sub', target: 'e' }],
    }) as any;
    const sub = nested.children[0].children.find((c: any) => c.id === 'sub');
    expect(sub.bpmn.isExpanded).toBe(false);
    expect(sub.children.map((c: any) => c.id)).toEqual(['inner']);
  });

  it('layoutBpmnFlat 对扁平层错抛 AggregateError（不当 ICE）', async () => {
    await expect(
      layoutBpmnFlat({ pools: [{ id: 'A' }, { id: 'B' }], nodes: [{ id: 'x', type: 'task' }], edges: [] }),
    ).rejects.toBeInstanceOf(AggregateError);
  });
});
