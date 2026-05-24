import { beforeAll, describe, expect, it } from 'bun:test';
import { collectSubprocessLayouts, type SubprocessLayout } from '../src/stages/subprocess-layout.ts';
import { ioSpecExtraBelow } from '../src/layout/node-sizes.ts';
import { warmup } from '../src/layout/elk-singleton.ts';
import type { FlowNode, ProcessUnit } from '../src/loader/types.ts';

const node = (id: string, type: FlowNode['type'], extra: Partial<FlowNode> = {}): FlowNode => ({
  id,
  type,
  name: id,
  subProcessId: null,
  boundaryEventIds: [],
  isExpanded: false,
  ioInputCount: 0,
  ioOutputCount: 0,
  ...extra,
});

describe('SubprocessLayout', () => {
  beforeAll(async () => { await warmup(); });

  it('reserves ioSpecification layout height for nodes inside expanded subprocesses', async () => {
    const sub: ProcessUnit = {
      id: 'sub',
      name: 'Sub',
      isBlackBox: false,
      lanes: [],
      flowNodes: [
        node('task_with_io', 'task', { ioOutputCount: 2 }),
      ],
      sequenceFlows: [],
      subProcesses: [],
      decorations: [],
    };
    const proc: ProcessUnit = {
      id: 'proc',
      name: 'Proc',
      isBlackBox: false,
      lanes: [],
      flowNodes: [
        node('sub_node', 'subProcess', { subProcessId: 'sub', isExpanded: true }),
      ],
      sequenceFlows: [],
      subProcesses: [sub],
      decorations: [],
    };
    const layouts = new Map<string, SubprocessLayout>();

    await collectSubprocessLayouts(proc, layouts);

    const layout = layouts.get('sub')!;
    const task = layout.innerNodes.get('task_with_io')!;
    expect(task.h).toBe(80);
    expect(task.y + task.h + ioSpecExtraBelow(0, 2)).toBeLessThanOrEqual(layout.bounds.height + 1);
  });
});
