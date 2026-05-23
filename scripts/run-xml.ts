// 把所有 fixture 跑 JSON → 布局 → BPMN XML，dump 到 out-xml/。
// 报告每个 fixture 的耗时和路由类型分布。

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { layoutBpmnXml } from '../src/index.ts';
import { warmup } from '../src/layout/elk-singleton.ts';

const FIXTURES_DIR = resolve(import.meta.dir, '../fixtures');
const OUT_DIR = resolve(import.meta.dir, '../out-xml');

async function main() {
  const args = process.argv.slice(2);
  const targets = (args.length > 0
    ? args
    : readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''))
  ).sort();

  mkdirSync(OUT_DIR, { recursive: true });
  console.log('[warmup] elkjs…');
  const t0 = performance.now();
  await warmup();
  console.log(`[warmup] ready in ${(performance.now() - t0).toFixed(0)}ms\n`);

  const fails: { fixture: string; error: string }[] = [];
  const tally: Record<string, number> = {};

  for (const base of targets) {
    try {
      const json = JSON.parse(readFileSync(resolve(FIXTURES_DIR, `${base}.json`), 'utf-8'));
      const { xml, trace } = await layoutBpmnXml(json, base);
      writeFileSync(resolve(OUT_DIR, `${base}.bpmn`), xml);
      for (const [t, n] of Object.entries(trace.byEdgeType)) tally[t] = (tally[t] ?? 0) + n;
      console.log(`✓ ${base.padEnd(40)} routes=${String(trace.routeCount).padStart(3)}  total=${trace.msTotal.toFixed(0).padStart(3)}ms  (place=${trace.msPlacement.toFixed(0)}ms route=${trace.msRoute.toFixed(0)}ms ser=${trace.msSerialize.toFixed(0)}ms)`);
    } catch (e: any) {
      console.error(`✗ ${base}: ${e.message}`);
      fails.push({ fixture: base, error: e.message });
    }
  }

  console.log('\n=== Edge type tally ===');
  for (const [t, n] of Object.entries(tally).sort()) console.log(`  ${t.padEnd(20)} ${n}`);

  if (fails.length) {
    console.log('\n[!] Failures:');
    for (const f of fails) console.log(`  ${f.fixture}: ${f.error}`);
    process.exit(1);
  }
}

await main();
process.exit(0);
