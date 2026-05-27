import { describe, expect, it } from 'bun:test';
import { mainFlowReachable, collectHandlerSubgraph } from '../src/stages/handler-subgraph.ts';
import type { SequenceFlow } from '../src/loader/types.ts';

const sf = (id: string, source: string, target: string): SequenceFlow => ({ id, source, target, isDefault: false });

describe('mainFlowReachable', () => {
  it('收集 startEvent 沿 sequenceFlow 可达的主流，遇 boundaryEvent 截断', () => {
    const nodes = [
      { id: 'start', type: 'startEvent' },
      { id: 'task', type: 'task' },
      { id: 'end', type: 'endEvent' },
      { id: 'be', type: 'boundaryEvent' },
      { id: 'handler', type: 'task' },
    ];
    const flows = [
      sf('f1', 'start', 'task'),
      sf('f2', 'task', 'end'),
      sf('f3', 'be', 'handler'), // BE 出向不进主流
    ];
    const reachable = mainFlowReachable(nodes, flows);
    expect(reachable).toEqual(new Set(['start', 'task', 'end']));
    expect(reachable.has('handler')).toBe(false);
  });
});

describe('collectHandlerSubgraph', () => {
  it('从 BE 出发 BFS，止于 rejoin 主流和已认领节点', () => {
    const flows = [
      sf('f1', 'start', 'task'),
      sf('f2', 'task', 'end'),
      sf('be_out', 'be', 'h1'),
      sf('h1_h2', 'h1', 'h2'),
      sf('h2_rejoin', 'h2', 'end'), // rejoin 主流，end 不被收
    ];
    const mainReachable = new Set(['start', 'task', 'end']);
    const sg = collectHandlerSubgraph('be', 'task', flows, mainReachable, new Set());
    expect(sg.nodes).toEqual(new Set(['h1', 'h2']));
    expect(sg.beId).toBe('be');
    expect(sg.hostId).toBe('task');
  });

  it('不跨入 alreadyClaimed 的其他 handler', () => {
    const flows = [sf('be_out', 'be', 'shared'), sf('shared_x', 'shared', 'x')];
    const sg = collectHandlerSubgraph('be', 'host', flows, new Set(), new Set(['shared']));
    expect(sg.nodes.size).toBe(0);
  });
});
