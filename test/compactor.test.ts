import { describe, expect, it } from 'bun:test';
import { compact } from '../src/stages/index.ts';
import type { NodeBox } from '../src/stages/index.ts';

function box(x: number, y = 0, w = 100, h = 80): NodeBox {
  return { x, y, w, h };
}

describe('Compactor', () => {
  it('compresses ELK default layer gaps to the normal layer gap', () => {
    const out = compact({
      nodes: new Map<string, NodeBox>([
        ['a', box(0)],
        ['b', box(200)],
        ['c', box(400)],
      ]),
    });

    expect(out.trimmedPx).toBe(40);
    expect(out.nodes.get('a')!.x).toBe(0);
    expect(out.nodes.get('b')!.x).toBe(180);
    expect(out.nodes.get('c')!.x).toBe(360);
  });

  it('leaves already compact columns unchanged', () => {
    const nodes = new Map<string, NodeBox>([
      ['a', box(0)],
      ['b', box(175)],
    ]);

    const out = compact({ nodes });

    expect(out.trimmedPx).toBe(0);
    expect(out.nodes.get('b')!.x).toBe(175);
  });

  it('wraps long pure chains when requested', () => {
    const nodes = new Map<string, NodeBox>();
    const edges: Array<{ source: string; target: string }> = [];
    for (let i = 0; i < 16; i++) {
      nodes.set(`n${i}`, box(i * 200));
      if (i > 0) edges.push({ source: `n${i - 1}`, target: `n${i}` });
    }

    const out = compact({ nodes, edges, wrapLinearChain: true });

    expect(out.trimmedPx).toBeGreaterThan(0);
    expect(out.nodes.get('n0')!.y).toBe(out.nodes.get('n7')!.y);
    expect(out.nodes.get('n8')!.y).toBeGreaterThan(out.nodes.get('n7')!.y);
    expect(out.nodes.get('n8')!.x).toBe(out.nodes.get('n0')!.x);
  });

  it('does not wrap branching graphs', () => {
    const nodes = new Map<string, NodeBox>([
      ['a', box(0)],
      ['b', box(200)],
      ['c', box(200, 140)],
      ['d', box(400)],
    ]);

    const out = compact({
      nodes,
      edges: [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'c' },
        { source: 'b', target: 'd' },
        { source: 'c', target: 'd' },
      ],
      wrapLinearChain: true,
    });

    expect(out.nodes.get('d')!.y).toBe(0);
  });

  it('moves a connected terminal event next to its source within a row', () => {
    const nodes = new Map<string, NodeBox>([
      ['match', box(0)],
      ['fastEnd', box(130, 22, 36, 36)],
      ['normalEnd', box(200, 22, 36, 36)],
    ]);

    const out = compact({
      nodes,
      edges: [{ source: 'match', target: 'normalEnd' }],
      nodeMeta: new Map([
        ['match', { type: 'serviceTask' }],
        ['fastEnd', { type: 'endEvent' }],
        ['normalEnd', { type: 'endEvent' }],
      ]),
    });

    expect(out.trimmedPx).toBeGreaterThan(0);
    expect(out.nodes.get('normalEnd')!.x).toBe(130);
    expect(out.nodes.get('fastEnd')!.x).toBe(200);
  });
});
