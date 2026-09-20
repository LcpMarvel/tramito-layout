// elkjs singleton + warmup.
//
// worker 方案在 bun 下三面受阻（2026-09-20 部署实测）：
//   ① { workerUrl } + bun 原生 Worker：Linux 容器里 spawn 即挂死（0% CPU 等不到消息）；
//   ② elkjs 默认 fake worker：elk-worker.min.js 的 UMD 见到 bun 全局 self 走浏览器分支，
//     module.exports 不赋值 → .Worker = undefined（本地也挂）；
//   ③ bundled + 无参：同 ②。
// 解法：把 elk-worker.min.js 读进来，以形参遮蔽 self/document 强制走它的 Node 分支，
// 拿到进程内 fake worker 类喂给 workerFactory——全环境确定性的同步模式。
// 冷启动（GWT 首次 parse）仍在，warmup() 跑一条 dummy layout 提前付掉。

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ElkConstructor, { type ELK } from 'elkjs';

const nodeRequire = createRequire(import.meta.url);

type FakeWorkerClass = new (url?: string) => Worker;
let fakeWorkerClass: FakeWorkerClass | null = null;

function loadFakeWorkerClass(): FakeWorkerClass {
  if (fakeWorkerClass) return fakeWorkerClass;
  const src = readFileSync(nodeRequire.resolve('elkjs/lib/elk-worker.min.js'), 'utf8');
  const moduleShim: { exports: Record<string, unknown> } = { exports: {} };
  const load = new Function('module', 'exports', 'require', 'self', 'document', src);
  load(moduleShim, moduleShim.exports, nodeRequire, undefined, undefined);
  const W = (moduleShim.exports as { Worker?: FakeWorkerClass }).Worker;
  if (!W) throw new Error('[elk-singleton] failed to load elkjs fake worker (UMD did not export Worker)');
  fakeWorkerClass = W;
  return W;
}

let instance: ELK | null = null;
let warmupPromise: Promise<void> | null = null;
let ready = false;

export function getElk(): ELK {
  if (!instance) {
    const W = loadFakeWorkerClass();
    instance = new ElkConstructor({ workerFactory: () => new W() } as unknown as Record<string, unknown>);
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
