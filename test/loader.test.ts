import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadFixture } from '../src/loader/loader.ts';

const FIX = (n: string) =>
  JSON.parse(readFileSync(resolve(import.meta.dir, '../fixtures', `${n}.json`), 'utf-8'));

describe('loader', () => {
  it('loads a simple process', () => {
    const m = loadFixture('01', FIX('01-simple-process'));
    expect(m.processes.length).toBe(1);
    const p = m.processes[0]!;
    expect(p.isBlackBox).toBe(false);
    expect(p.flowNodes.length).toBeGreaterThan(0);
    expect(p.sequenceFlows.length).toBeGreaterThan(0);
  });

  it('handles collaboration with black-box pool', () => {
    const m = loadFixture('25', FIX('25-collaboration-black-box'));
    const blackBox = m.processes.find(p => p.isBlackBox);
    expect(blackBox).toBeTruthy();
    expect(blackBox!.flowNodes.length).toBe(0);
  });

  it('extracts boundary events into decorations and flow-nodes', () => {
    const m = loadFixture('13', FIX('13-boundary-events-all'));
    const proc = m.processes[0]!;
    const boundaryDecos = proc.decorations.filter(d => d.kind === 'boundaryEvent');
    expect(boundaryDecos.length).toBeGreaterThan(0);
    // BE must also appear in flowNodes (so edges from BE resolve).
    for (const d of boundaryDecos) {
      expect(proc.flowNodes.find(n => n.id === d.id)).toBeTruthy();
    }
  });

  it('records lane memberRefs', () => {
    const m = loadFixture('26', FIX('26-collaboration-lanes'));
    const lanes = m.processes.flatMap(p => p.lanes);
    expect(lanes.length).toBeGreaterThan(0);
    expect(lanes.some(l => l.memberRefs.length > 0)).toBe(true);
  });

  it('captures collaboration message flows', () => {
    const m = loadFixture('29', FIX('29-collaboration-message-flows'));
    expect(m.collaborationMessageFlows.length).toBeGreaterThan(0);
  });

  it('rejects invalid top-level input with a clear error', () => {
    expect(() => loadFixture('bad-input', null)).toThrow(
      /INVALID_GRAPH_ROOT/,
    );
    expect(() => loadFixture('bad-input', { id: 'defs' })).toThrow(
      /MISSING_CHILDREN/,
    );
  });

  it('rejects edges without endpoints', () => {
    expect(() => loadFixture('bad-edge', {
      id: 'defs',
      children: [{
        id: 'proc',
        bpmn: { type: 'process' },
        children: [{ id: 'task_a', bpmn: { type: 'task' } }],
        edges: [{
          id: 'flow_without_source',
          sources: [],
          targets: ['task_a'],
          bpmn: { type: 'sequenceFlow' },
        }],
      }],
    })).toThrow(/EDGE_ENDPOINT_MISSING/);
  });
});
