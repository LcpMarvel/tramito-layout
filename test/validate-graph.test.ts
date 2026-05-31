import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateGraph, formatIssuesForFeedback } from '../src/loader/validate-graph.ts';

const FIX_DIR = resolve(import.meta.dir, '../fixtures');
const FIX = (n: string) => JSON.parse(readFileSync(resolve(FIX_DIR, `${n}.json`), 'utf-8'));

const codes = (g: unknown) => validateGraph(g).map((i) => i.code);
const errs = (g: unknown) => validateGraph(g).filter((i) => i.severity === 'error');

// 最小合法单 process 模板，便于逐条注入错误。
const baseProcess = (children: any[], edges: any[] = []) => ({
  id: 'defs',
  children: [{ id: 'p1', bpmn: { type: 'process' }, children, edges }],
});

describe('validateGraph — 合法输入', () => {
  it('all shipped fixtures pass without errors', () => {
    const files = readdirSync(FIX_DIR).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const issues = validateGraph(FIX(f.replace('.json', '')));
      const errors = issues.filter((i) => i.severity === 'error');
      expect({ f, errors }).toEqual({ f, errors: [] });
    }
  });

  it('plain none start/end events are valid (no EVENT_MISSING_EVENT_DEF)', () => {
    const g = baseProcess(
      [
        { id: 's', bpmn: { type: 'startEvent' } },
        { id: 'e', bpmn: { type: 'endEvent' } },
      ],
      [{ id: 'f1', sources: ['s'], targets: ['e'], bpmn: { type: 'sequenceFlow' } }],
    );
    expect(errs(g)).toEqual([]);
  });
});

describe('validateGraph — 结构错误', () => {
  it('INVALID_GRAPH_ROOT / MISSING_CHILDREN', () => {
    expect(codes(null)).toEqual(['INVALID_GRAPH_ROOT']);
    expect(codes({ id: 'x' })).toEqual(['MISSING_CHILDREN']);
  });

  it('CHILD_WITHOUT_TYPE', () => {
    const g = baseProcess([{ id: 'mystery' }]);
    expect(codes(g)).toContain('CHILD_WITHOUT_TYPE');
  });

  it('UNKNOWN_NODE_TYPE', () => {
    const g = baseProcess([{ id: 'x', bpmn: { type: 'wormhole' } }]);
    expect(codes(g)).toContain('UNKNOWN_NODE_TYPE');
  });

  it('BOUNDARY_EVENT_IN_CHILDREN', () => {
    const g = baseProcess([{ id: 'be', bpmn: { type: 'boundaryEvent' } }]);
    expect(codes(g)).toContain('BOUNDARY_EVENT_IN_CHILDREN');
  });

  it('DUPLICATE_ID', () => {
    const g = baseProcess([
      { id: 'dup', bpmn: { type: 'task' } },
      { id: 'dup', bpmn: { type: 'task' } },
    ]);
    const dups = validateGraph(g).filter((i) => i.code === 'DUPLICATE_ID');
    expect(dups.length).toBe(1);
    expect(dups[0]!.id).toBe('dup');
  });

  it('NON_ASCII_ID', () => {
    const g = baseProcess([{ id: '任务', bpmn: { type: 'task' } }]);
    expect(codes(g)).toContain('NON_ASCII_ID');
  });

  it('NON_ASCII_ID 是生成路径专属：relayout profile 下不报（已存在 XML 合法带中文 id）', () => {
    const g = baseProcess(
      [
        { id: '开始', bpmn: { type: 'startEvent' } },
        { id: '任务', bpmn: { type: 'task' } },
      ],
      [{ id: '流转', sources: ['开始'], targets: ['任务'], bpmn: { type: 'sequenceFlow' } }],
    );
    // 生成路径：中文 id 报错
    expect(validateGraph(g).map((i) => i.code)).toContain('NON_ASCII_ID');
    // relayout 路径：跳过该规则，且整体无 error（其余规则都满足）
    expect(validateGraph(g, { profile: 'relayout' })).toEqual([]);
  });

  it('EDGE_ENDPOINT_MISSING — empty source and unknown target', () => {
    const g = baseProcess(
      [{ id: 'a', bpmn: { type: 'task' } }],
      [
        { id: 'f1', sources: [], targets: ['a'], bpmn: { type: 'sequenceFlow' } },
        { id: 'f2', sources: ['a'], targets: ['ghost'], bpmn: { type: 'sequenceFlow' } },
      ],
    );
    const missing = validateGraph(g).filter((i) => i.code === 'EDGE_ENDPOINT_MISSING');
    expect(missing.length).toBe(2);
  });

  it('EDGE_ENDPOINT_MISSING — 漏声明网关：hint 指向"补节点"而非"删边"', () => {
    // 模型常写了经过网关的所有连线、却忘了把网关 emit 进 children（生产实测的失败模式）。
    const g = baseProcess(
      [
        { id: 'start_1', bpmn: { type: 'startEvent' } },
        { id: 'task_2', bpmn: { type: 'userTask', name: 'A' } },
        { id: 'task_3', bpmn: { type: 'userTask', name: 'B' } },
        { id: 'end_4', bpmn: { type: 'endEvent' } },
      ],
      [
        { id: 'f1', sources: ['start_1'], targets: ['task_2'], bpmn: { type: 'sequenceFlow' } },
        // gateway_9 从未声明，却被三条边引用（1 入 2 出）。
        { id: 'f2', sources: ['task_2'], targets: ['gateway_9'], bpmn: { type: 'sequenceFlow' } },
        { id: 'f3', sources: ['gateway_9'], targets: ['task_3'], bpmn: { type: 'sequenceFlow' } },
        { id: 'f4', sources: ['gateway_9'], targets: ['end_4'], bpmn: { type: 'sequenceFlow' } },
      ],
    );
    const missing = validateGraph(g).filter((i) => i.code === 'EDGE_ENDPOINT_MISSING');
    expect(missing.length).toBe(3); // f2.target + f3.source + f4.source
    for (const i of missing) {
      expect(i.hint).toContain('漏写了这个节点');
      expect(i.hint).toContain('网关');
      expect(i.hint).toContain('不要删掉这些连线');
    }
  });

  it('EDGE_ENDPOINT_MISSING — 单次引用的非网关 id 仍按打错处理', () => {
    const g = baseProcess(
      [{ id: 'a', bpmn: { type: 'task' } }],
      [{ id: 'f1', sources: ['a'], targets: ['typo_node'], bpmn: { type: 'sequenceFlow' } }],
    );
    const missing = validateGraph(g).filter((i) => i.code === 'EDGE_ENDPOINT_MISSING');
    expect(missing.length).toBe(1);
    expect(missing[0]!.hint).toContain('若该 id 是打错的');
  });

  it('EVENT_MISSING_EVENT_DEF — only catch/boundary', () => {
    const g = baseProcess([
      { id: 'c', bpmn: { type: 'intermediateCatchEvent' } },
      { id: 't', bpmn: { type: 'intermediateThrowEvent' } }, // throw without def is fine
    ]);
    const evDef = validateGraph(g).filter((i) => i.code === 'EVENT_MISSING_EVENT_DEF');
    expect(evDef.map((i) => i.id)).toEqual(['c']);
  });

  it('MSGFLOW_NOT_IN_COLLABORATION', () => {
    const g = baseProcess(
      [{ id: 'a', bpmn: { type: 'task' } }],
      [{ id: 'm', sources: ['a'], targets: ['a'], bpmn: { type: 'messageFlow' } }],
    );
    expect(codes(g)).toContain('MSGFLOW_NOT_IN_COLLABORATION');
  });

  it('SEQFLOW_CROSS_POOL', () => {
    const g = {
      id: 'defs',
      children: [
        {
          id: 'collab',
          bpmn: { type: 'collaboration' },
          children: [
            {
              id: 'poolA',
              bpmn: { type: 'participant' },
              children: [{ id: 'a', bpmn: { type: 'task' } }],
              edges: [{ id: 'x', sources: ['a'], targets: ['b'], bpmn: { type: 'sequenceFlow' } }],
            },
            {
              id: 'poolB',
              bpmn: { type: 'participant' },
              children: [{ id: 'b', bpmn: { type: 'task' } }],
            },
          ],
        },
      ],
    };
    expect(codes(g)).toContain('SEQFLOW_CROSS_POOL');
  });

  it('EXCLUSIVE_DEFAULT_INVALID', () => {
    const g = baseProcess(
      [
        { id: 'gw', bpmn: { type: 'exclusiveGateway', default: 'no_such_flow' } },
        { id: 'a', bpmn: { type: 'task' } },
      ],
      [{ id: 'f1', sources: ['gw'], targets: ['a'], bpmn: { type: 'sequenceFlow' } }],
    );
    expect(codes(g)).toContain('EXCLUSIVE_DEFAULT_INVALID');
  });

  it('EXCLUSIVE_DEFAULT_INVALID — valid default does not fire', () => {
    const g = baseProcess(
      [
        { id: 'gw', bpmn: { type: 'exclusiveGateway', default: 'f1' } },
        { id: 'a', bpmn: { type: 'task' } },
      ],
      [{ id: 'f1', sources: ['gw'], targets: ['a'], bpmn: { type: 'sequenceFlow' } }],
    );
    expect(codes(g)).not.toContain('EXCLUSIVE_DEFAULT_INVALID');
  });

  it('BLACKBOX_POOL_HAS_BODY', () => {
    const g = {
      id: 'defs',
      children: [
        {
          id: 'collab',
          bpmn: { type: 'collaboration' },
          children: [
            {
              id: 'pool',
              bpmn: { type: 'participant', isBlackBox: true, processRef: 'proc_x' },
              children: [{ id: 'a', bpmn: { type: 'task' } }],
            },
          ],
        },
      ],
    };
    expect(codes(g)).toContain('BLACKBOX_POOL_HAS_BODY');
  });

  it('EMPTY_GRAPH — no process or collaboration', () => {
    expect(codes({ id: 'defs', children: [] })).toEqual(['EMPTY_GRAPH']);
  });

  it('IO_SPEC_EMPTY_ENTRY — null entry in dataInputs', () => {
    const g = baseProcess([
      { id: 't', bpmn: { type: 'task', ioSpecification: { dataInputs: [null], dataOutputs: [{ id: 'o', name: 'out' }] } } },
    ]);
    const io = validateGraph(g).filter((i) => i.code === 'IO_SPEC_EMPTY_ENTRY');
    expect(io.length).toBe(1);
    expect(io[0]!.id).toBe('t');
  });

  it('compensation association (boundary → task, no artifact) is NOT flagged', () => {
    const g = baseProcess(
      [
        { id: 'task_main', bpmn: { type: 'task' }, boundaryEvents: [{ id: 'be', bpmn: { type: 'boundaryEvent', eventDefinitionType: 'compensate' } }] },
        { id: 'task_handler', bpmn: { type: 'task' } },
      ],
      [{ id: 'assoc', sources: ['be'], targets: ['task_handler'], bpmn: { type: 'association' } }],
    );
    expect(errs(g)).toEqual([]);
  });

  it('UNKNOWN_EDGE_TYPE — unknown type and missing type', () => {
    const g = baseProcess(
      [{ id: 'a', bpmn: { type: 'task' } }, { id: 'b', bpmn: { type: 'task' } }],
      [
        { id: 'f1', sources: ['a'], targets: ['b'], bpmn: { type: 'fooFlow' } },
        { id: 'f2', sources: ['a'], targets: ['b'] }, // no bpmn.type
      ],
    );
    const u = validateGraph(g).filter((i) => i.code === 'UNKNOWN_EDGE_TYPE');
    expect(u.map((i) => i.id).sort()).toEqual(['f1', 'f2']);
  });

  it('UNKNOWN_EDGE_TYPE — sequenceFlow not allowed at collaboration level', () => {
    const g = {
      id: 'defs',
      children: [
        {
          id: 'collab',
          bpmn: { type: 'collaboration' },
          children: [
            { id: 'poolA', bpmn: { type: 'participant' }, children: [{ id: 'a', bpmn: { type: 'task' } }] },
          ],
          edges: [{ id: 'bad', sources: ['a'], targets: ['a'], bpmn: { type: 'sequenceFlow' } }],
        },
      ],
    };
    expect(codes(g)).toContain('UNKNOWN_EDGE_TYPE');
  });

  it('artifact directly under lane-using body is NOT flagged misplaced', () => {
    const g = {
      id: 'defs',
      children: [
        {
          id: 'p1',
          bpmn: { type: 'process' },
          children: [
            { id: 'lane1', bpmn: { type: 'lane' }, children: [{ id: 'a', bpmn: { type: 'task' } }] },
            { id: 'doc', bpmn: { type: 'dataObject' } }, // artifact 停在 body 级，合法
          ],
        },
      ],
    };
    expect(codes(g)).not.toContain('LANE_NODE_MISPLACED');
  });

  it('LANE_NODE_MISPLACED', () => {
    const g = {
      id: 'defs',
      children: [
        {
          id: 'p1',
          bpmn: { type: 'process' },
          children: [
            { id: 'lane1', bpmn: { type: 'lane' }, children: [{ id: 'a', bpmn: { type: 'task' } }] },
            { id: 'loose', bpmn: { type: 'task' } }, // 直接挂在 body 下，应进 lane
          ],
        },
      ],
    };
    expect(codes(g)).toContain('LANE_NODE_MISPLACED');
  });
});

describe('formatIssuesForFeedback', () => {
  it('returns empty string when no issues', () => {
    expect(formatIssuesForFeedback([])).toBe('');
  });

  it('groups errors and warnings with an actionable header', () => {
    const g = baseProcess(
      [
        { id: 'be', bpmn: { type: 'boundaryEvent' } },
        { id: 'gw', bpmn: { type: 'parallelGateway' } },
        { id: 'a', bpmn: { type: 'task' } },
        { id: 'b', bpmn: { type: 'task' } },
      ],
      [
        { id: 'f1', sources: ['gw'], targets: ['a'], bpmn: { type: 'sequenceFlow' } },
        { id: 'f2', sources: ['gw'], targets: ['b'], bpmn: { type: 'sequenceFlow' } },
      ],
    );
    const text = formatIssuesForFeedback(validateGraph(g));
    expect(text).toContain('结构错误');
    expect(text).toContain('[BOUNDARY_EVENT_IN_CHILDREN]');
    expect(text).toContain('id=be');
    expect(text).toContain('修复:');
    expect(text).toContain('警告');
    expect(text).toContain('[PARALLEL_JOIN_MISSING]');
  });
});

describe('validateGraph — warning（不阻断）', () => {
  it('PARALLEL_JOIN_MISSING — fork without any join', () => {
    const g = baseProcess(
      [
        { id: 'gw', bpmn: { type: 'parallelGateway' } },
        { id: 'a', bpmn: { type: 'task' } },
        { id: 'b', bpmn: { type: 'task' } },
      ],
      [
        { id: 'f1', sources: ['gw'], targets: ['a'], bpmn: { type: 'sequenceFlow' } },
        { id: 'f2', sources: ['gw'], targets: ['b'], bpmn: { type: 'sequenceFlow' } },
      ],
    );
    const issues = validateGraph(g);
    expect(issues.some((i) => i.code === 'PARALLEL_JOIN_MISSING' && i.severity === 'warning')).toBe(true);
    expect(issues.every((i) => i.severity !== 'error')).toBe(true); // 不阻断
  });

  it('LANE_PARTITION_INCOMPLETE — lanes without partition config', () => {
    const g = {
      id: 'defs',
      children: [
        {
          id: 'p1',
          bpmn: { type: 'process' },
          children: [
            { id: 'lane1', bpmn: { type: 'lane' }, children: [{ id: 'a', bpmn: { type: 'task' } }] },
          ],
        },
      ],
    };
    const issues = validateGraph(g);
    expect(issues.some((i) => i.code === 'LANE_PARTITION_INCOMPLETE')).toBe(true);
  });
});
