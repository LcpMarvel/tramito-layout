import { describe, expect, it, beforeAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadFixture } from '../src/loader/loader.ts';
import { elkPlacement, type PlacementInput } from '../src/stages/elk-placement.ts';
import { layoutHeightWithIoSpec, nodeSizeOf } from '../src/layout/node-sizes.ts';
import { warmup } from '../src/layout/elk-singleton.ts';

const FIX = (n: string) =>
  JSON.parse(readFileSync(resolve(import.meta.dir, '../fixtures', `${n}.json`), 'utf-8'));

function inputFromFirstProcess(fixtureName: string): PlacementInput {
  const m = loadFixture(fixtureName, FIX(fixtureName));
  const proc = m.processes.find(p => !p.isBlackBox && p.flowNodes.length > 0)!;
  return {
    processId: proc.id,
    nodes: proc.flowNodes
      .filter(n => n.type !== 'boundaryEvent') // boundary events 由 Stage 5 处理
      .map(n => {
        const size = nodeSizeOf(n.type);
        return {
          id: n.id,
          type: n.type,
          ...size,
          layoutH: layoutHeightWithIoSpec(size.h, n.ioInputCount, n.ioOutputCount, n.ioInputNames, n.ioOutputNames, size.w),
        };
      }),
    edges: proc.sequenceFlows.map(sf => ({ id: sf.id, source: sf.source, target: sf.target })),
  };
}

describe('Stage 1 — ElkPlacement', () => {
  beforeAll(async () => { await warmup(); });

  it('places every input node exactly once', async () => {
    const input = inputFromFirstProcess('01-simple-process');
    const output = await elkPlacement(input);
    expect(output.nodes.size).toBe(input.nodes.length);
    for (const n of input.nodes) expect(output.nodes.has(n.id)).toBe(true);
  });

  it('returns positive bounds containing all nodes', async () => {
    const input = inputFromFirstProcess('04-all-gateways');
    const output = await elkPlacement(input);
    expect(output.bounds.width).toBeGreaterThan(0);
    expect(output.bounds.height).toBeGreaterThan(0);
    for (const box of output.nodes.values()) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.w).toBeLessThanOrEqual(output.bounds.width + 1);
      expect(box.y + box.h).toBeLessThanOrEqual(output.bounds.height + 1);
    }
  });

  it('produces non-overlapping node boxes', async () => {
    const input = inputFromFirstProcess('04-all-gateways');
    const output = await elkPlacement(input);
    const boxes = [...output.nodes.entries()];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const [idA, a] = boxes[i]!;
        const [idB, b] = boxes[j]!;
        const overlap =
          a.x < b.x + b.w &&
          a.x + a.w > b.x &&
          a.y < b.y + b.h &&
          a.y + a.h > b.y;
        if (overlap) {
          throw new Error(`overlap between ${idA} and ${idB}`);
        }
      }
    }
  });

  it('lays out a simple chain with monotonic X order', async () => {
    const input = inputFromFirstProcess('01-simple-process');
    const output = await elkPlacement(input);
    // 01-simple-process: start_1 → task_1 → task_2 → end_1
    const xs = ['start_1', 'task_1', 'task_2', 'end_1'].map(id => output.nodes.get(id)!.x);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]!);
  });

  it('handles a rigid (non-SP) graph without throwing', async () => {
    const input = inputFromFirstProcess('37-crm-voice-process');
    const output = await elkPlacement(input);
    expect(output.nodes.size).toBeGreaterThan(0);
  });

  it('uses layout-only height without changing the visible node box', async () => {
    const output = await elkPlacement({
      processId: 'io-spec',
      nodes: [
        { id: 'task_with_io', type: 'task', w: 100, h: 80, layoutH: 180 },
      ],
      edges: [],
    });
    const task = output.nodes.get('task_with_io')!;
    const layoutPad = (180 - 80) / 2;

    expect(task.h).toBe(80);
    expect(task.y).toBeGreaterThanOrEqual(layoutPad - 1);
    expect(task.y + task.h + layoutPad).toBeLessThanOrEqual(output.bounds.height + 1);
  });

  it('returns empty output for empty input', async () => {
    const output = await elkPlacement({ processId: 'empty', nodes: [], edges: [] });
    expect(output.nodes.size).toBe(0);
    expect(output.bounds.width).toBe(0);
  });
});
