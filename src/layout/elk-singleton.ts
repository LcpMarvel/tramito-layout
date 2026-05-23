// elkjs singleton + warmup.
//
// elkjs spins up a web-worker on first .layout() call; cold start is ~3-5s.
// We construct the worker eagerly at module load and `warmup()` runs a tiny
// dummy layout so the worker is fully ready before the first real request lands.

import ElkConstructor, { type ELK } from 'elkjs';

const workerUrl = import.meta.resolve('elkjs/lib/elk-worker.min.js');

let instance: ELK | null = null;
let warmupPromise: Promise<void> | null = null;
let ready = false;

export function getElk(): ELK {
  if (!instance) {
    instance = new ElkConstructor({ workerUrl } as any);
  }
  return instance;
}

export function isReady(): boolean {
  return ready;
}

export async function warmup(): Promise<void> {
  if (warmupPromise) return warmupPromise;
  warmupPromise = (async () => {
    const elk = getElk();
    // Tiny two-node layout — forces worker to load and pre-warm.
    await elk.layout({
      id: '__warmup__',
      layoutOptions: { 'elk.algorithm': 'layered' },
      children: [
        { id: 'a', width: 40, height: 40 },
        { id: 'b', width: 40, height: 40 },
      ],
      edges: [{ id: 'e1', sources: ['a'], targets: ['b'] } as any],
    } as any);
    ready = true;
  })();
  return warmupPromise;
}
