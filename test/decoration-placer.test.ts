import { describe, expect, it } from 'bun:test';
import { placeDecorations } from '../src/stages/decoration-placer.ts';
import type { NodeBox } from '../src/stages/types.ts';

const box = (x: number, y: number, w = 100, h = 80): NodeBox => ({ x, y, w, h });

describe('Stage 5 — DecorationPlacer', () => {
  it('places a single boundary event on the host bottom-left (B1)', () => {
    const hosts = new Map([['task_x', box(100, 200)]]);
    const out = placeDecorations({
      hostBoxes: hosts,
      boundaryEvents: [{ id: 'be1', hostId: 'task_x', idx: 0 }],
      handlerSubgraphs: [],
    });
    const be = out.boundaryEventBoxes.get('be1')!;
    // host = (100, 200, 100, 80) → host.left = 100, host.bottom = 280
    // cx = 100 + 20 = 120  → be.x = 120 - 18 = 102
    // cy = 280            → be.y = 280 - 18 = 262
    expect(be.x).toBe(102);
    expect(be.y).toBe(262);
    expect(be.w).toBe(36);
    expect(be.h).toBe(36);
  });

  it('spaces multiple BEs horizontally without overlap', () => {
    const hosts = new Map([['task_x', box(100, 200)]]);
    const out = placeDecorations({
      hostBoxes: hosts,
      boundaryEvents: [
        { id: 'be1', hostId: 'task_x', idx: 0 },
        { id: 'be2', hostId: 'task_x', idx: 1 },
      ],
      handlerSubgraphs: [],
    });
    const a = out.boundaryEventBoxes.get('be1')!;
    const b = out.boundaryEventBoxes.get('be2')!;
    // idx 0 在左、idx 1 在右一个 step (40px)
    expect(b.x).toBe(a.x + 40);
    expect(b.x).toBeGreaterThanOrEqual(a.x + a.w); // 不重叠
  });

  it('skips boundary events whose host is missing', () => {
    const out = placeDecorations({
      hostBoxes: new Map(),
      boundaryEvents: [{ id: 'be1', hostId: 'ghost', idx: 0 }],
      handlerSubgraphs: [],
    });
    expect(out.boundaryEventBoxes.size).toBe(0);
  });

  it('rides on the bottom edge (half inside, half outside host)', () => {
    const hosts = new Map([['t', box(0, 0)]]);
    const out = placeDecorations({
      hostBoxes: hosts,
      boundaryEvents: [{ id: 'be1', hostId: 't', idx: 0 }],
      handlerSubgraphs: [],
    });
    const be = out.boundaryEventBoxes.get('be1')!;
    // host.bottom = 80, be center cy = 80
    // be.y = 80 - 18 = 62, be.y + be.h = 98
    expect(be.y + be.h / 2).toBe(80);
  });
});
