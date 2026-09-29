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
//
// 浏览器（GitHub Pages demo）：bun 的 browser target 会把 node:fs / node:module 编译成
// 空对象，readFileSync / createRequire 在浏览器 bundle 里是 undefined。宿主须在首次布局前
// 调 provideBrowserElkWorkerSource() 注入同一份 elk-worker.min.js 源码；UMD 求值走与
// Node 完全相同的 self/document 遮蔽路径，行为两侧一致。

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ElkConstructor, { type ELK } from 'elkjs';

type FakeWorkerClass = new (url?: string) => Worker;
let fakeWorkerClass: FakeWorkerClass | null = null;
let browserWorkerSource: string | null = null;

// tsconfig 无 DOM lib，用 globalThis 探测避免引入 DOM 类型（bun-types 也没有 window/document）。
const gt = globalThis as { document?: unknown; window?: unknown };
const isBrowserRuntime = typeof gt.document !== 'undefined' && typeof gt.window !== 'undefined';

export function provideBrowserElkWorkerSource(source: string): void {
  browserWorkerSource = source;
}

// UMD 以形参遮蔽 self/document → 走 Node 分支把 Worker 类挂到 module.exports。
// 两环境共用同一段求值逻辑，差异只在源码从哪来（fs 读 vs 宿主注入）。
function evaluateFakeWorkerClass(src: string, requireImpl: (id: string) => unknown): FakeWorkerClass {
  const moduleShim: { exports: Record<string, unknown> } = { exports: {} };
  const load = new Function('module', 'exports', 'require', 'self', 'document', src);
  load(moduleShim, moduleShim.exports, requireImpl, undefined, undefined);
  const W = (moduleShim.exports as { Worker?: FakeWorkerClass }).Worker;
  if (!W) throw new Error('[elk-singleton] failed to load elkjs fake worker (UMD did not export Worker)');
  return W;
}

function throwingRequire(id: string): unknown {
  throw new Error(`[elk-singleton] elk worker tried to require "${id}" in browser — unsupported`);
}

function loadFakeWorkerClass(): FakeWorkerClass {
  if (fakeWorkerClass) return fakeWorkerClass;
  if (isBrowserRuntime) {
    if (!browserWorkerSource) {
      throw new Error(
        '[elk-singleton] browser runtime needs provideBrowserElkWorkerSource(elkWorkerMinJs) before the first layout',
      );
    }
    fakeWorkerClass = evaluateFakeWorkerClass(browserWorkerSource, throwingRequire);
    return fakeWorkerClass;
  }
  // createRequire 惰性化：浏览器 bundle 里它是 undefined，不能在模块顶层调用。
  const nodeRequire = createRequire(import.meta.url);
  const workerPath = nodeRequire.resolve('elkjs/lib/elk-worker.min.js');
  fakeWorkerClass = evaluateFakeWorkerClass(readFileSync(workerPath, 'utf8'), nodeRequire);
  return fakeWorkerClass;
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
