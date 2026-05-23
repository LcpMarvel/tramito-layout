// Bench：单进程跑全 34 fixture N 次，统计 p50/p95/p99。
// 目标：30 QPS 单实例（即平均 < 33ms / call）。
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runPipeline } from '../src/pipeline.ts';

const ITERATIONS = Number(process.env.ITER ?? 5);
const FIX_DIR = resolve(import.meta.dir, '../fixtures');
const files = readdirSync(FIX_DIR).filter(f => f.endsWith('.json')).sort();

interface Sample { fixture: string; ms: number; }
const samples: Sample[] = [];

// Warm-up：跑一遍让 JIT / elkjs worker 启动
for (const file of files) {
  const raw = JSON.parse(readFileSync(resolve(FIX_DIR, file), 'utf-8'));
  await runPipeline(raw, file).catch(() => {});
}

for (let i = 0; i < ITERATIONS; i++) {
  for (const file of files) {
    const base = file.replace(/\.json$/, '');
    const raw = JSON.parse(readFileSync(resolve(FIX_DIR, file), 'utf-8'));
    const t = performance.now();
    try {
      await runPipeline(raw, base);
      samples.push({ fixture: base, ms: performance.now() - t });
    } catch (e: any) {
      console.error(`✗ ${base}: ${e.message}`);
    }
  }
}

// 总体
const all = samples.map(s => s.ms).sort((a, b) => a - b);
const pct = (p: number) => all[Math.min(all.length - 1, Math.floor(p * all.length))];
const avg = all.reduce((s, m) => s + m, 0) / all.length;

console.log(`\n=== overall (${samples.length} samples = ${files.length} fixtures × ${ITERATIONS} iters) ===`);
console.log(`avg: ${avg.toFixed(2)}ms   p50: ${pct(0.5)!.toFixed(2)}ms   p95: ${pct(0.95)!.toFixed(2)}ms   p99: ${pct(0.99)!.toFixed(2)}ms`);
console.log(`max: ${all[all.length - 1]!.toFixed(2)}ms   min: ${all[0]!.toFixed(2)}ms`);
console.log(`equivalent QPS (single-thread, avg): ${(1000 / avg).toFixed(1)}`);

// Per-fixture（avg）
const byFix = new Map<string, number[]>();
for (const s of samples) {
  if (!byFix.has(s.fixture)) byFix.set(s.fixture, []);
  byFix.get(s.fixture)!.push(s.ms);
}
console.log(`\n=== per fixture (avg of ${ITERATIONS} iters) ===`);
console.log('fixture'.padEnd(40), 'avg ms', 'min ms', 'max ms');
const slowFixtures: { f: string; avg: number }[] = [];
for (const [f, ms] of byFix) {
  const a = ms.reduce((s, m) => s + m, 0) / ms.length;
  slowFixtures.push({ f, avg: a });
}
slowFixtures.sort((a, b) => b.avg - a.avg);
for (const { f, avg: a } of slowFixtures) {
  const ms = byFix.get(f)!;
  const sorted = [...ms].sort((x, y) => x - y);
  console.log(f.padEnd(40), a.toFixed(2).padStart(6), sorted[0]!.toFixed(2).padStart(6), sorted[sorted.length - 1]!.toFixed(2).padStart(6));
}
