// M8 诊断脚本：把 F4（aspect ratio）失分的 fixture 拆开看
//
// 用法：
//   bun run scripts/diagnose-aspect.ts          # 全 fixture，重点 hightlight 04/10/13/22
//   bun run scripts/diagnose-aspect.ts 04 13    # 仅指定 fixture
//
// 报告 4 件事：
//   1. 每个 process 的 layer 数 / 单 layer 最多节点数 / 最大 fan-out
//   2. 每个 process ELK 宽度 = sum(perLayerMaxNodeW) + spacingWidth 的拆分
//   3. 04 / 10 / 13 / 22 是否都属于"单链长（fan-out ≤ 1）"型
//   4. 最终 totalBounds aspect（与 check:layout F4 同口径）
//
// 不影响坐标，纯 trace 字段读取。

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { runPipeline } from '../src/pipeline.ts';
import { warmup } from '../src/layout/elk-singleton.ts';
import type { ElkShape } from '../src/stages/index.ts';

const FIXTURES_DIR = resolve(import.meta.dir, '../fixtures');
const F4_THRESHOLD = 6; // 与 check:layout 的 F4 软标准一致

// 历史 F4 失分集（已 strip leading zeros），用于优先诊断最容易变宽的 fixture。
const FOCUS = new Set(['4', '10', '13', '22']);

interface FixtureReport {
  fixture: string;
  totalWidth: number;
  totalHeight: number;
  aspect: number;
  shapes: ElkShape[];
}

function fixtureNumericId(stem: string): string {
  return (stem.split('-')[0] ?? '').replace(/^0+/, '') || stem;
}

function fmt(n: number, w = 6, decimals = 0): string {
  return n.toFixed(decimals).padStart(w);
}

async function run(fixture: string): Promise<FixtureReport> {
  const json = JSON.parse(readFileSync(resolve(FIXTURES_DIR, `${fixture}.json`), 'utf-8'));
  const { graph, trace } = await runPipeline(json, fixture);
  const totalWidth = (graph as any).width ?? 0;
  const totalHeight = (graph as any).height ?? 0;
  return {
    fixture,
    totalWidth,
    totalHeight,
    aspect: totalHeight > 0 ? totalWidth / totalHeight : 0,
    shapes: trace.elkShape,
  };
}

function printShape(prefix: string, s: ElkShape): void {
  const maxLayer = s.perLayerNodeCount.length > 0 ? Math.max(...s.perLayerNodeCount) : 0;
  const widthPctNodes = s.totalWidth > 0
    ? ((s.nodeWidthSum / s.totalWidth) * 100).toFixed(0)
    : '--';
  const widthPctSpacing = s.totalWidth > 0
    ? ((s.spacingWidth / s.totalWidth) * 100).toFixed(0)
    : '--';
  console.log(
    `${prefix}  proc=${s.processId.padEnd(20)} ` +
    `layers=${fmt(s.layerCount, 2)} maxLayerN=${fmt(maxLayer, 2)} ` +
    `maxFanOut=${fmt(s.maxFanOut, 2)} nodes=${fmt(s.nodeCount, 3)} ` +
    `W=${fmt(s.totalWidth, 5)} H=${fmt(s.totalHeight, 5)} ` +
    `nodes=${widthPctNodes}% spacing=${widthPctSpacing}%`
  );
  if (s.perLayerNodeCount.length > 0) {
    console.log(`${prefix}    per-layer N: [${s.perLayerNodeCount.join(',')}]`);
    console.log(`${prefix}    per-layer maxW: [${s.perLayerMaxNodeWidth.map(w => Math.round(w)).join(',')}]`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const onlyIds = new Set(args.map(a => a.replace(/^0+/, '')));

  console.log('[warmup] elkjs…');
  const t0 = performance.now();
  await warmup();
  console.log(`[warmup] ready in ${(performance.now() - t0).toFixed(0)}ms\n`);

  const fixtures = readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''))
    .filter(stem => onlyIds.size === 0 || onlyIds.has(fixtureNumericId(stem)))
    .sort();

  const reports: FixtureReport[] = [];
  for (const fx of fixtures) {
    try {
      reports.push(await run(fx));
    } catch (e: any) {
      console.error(`✗ ${fx}: ${e.message}`);
    }
  }

  // 报告 1: 全 fixture aspect 排序，标记 F4 fail
  console.log('━━━ Aspect ratio 全 fixture 排序（W/H）━━━');
  console.log('fixture                                    W      H   aspect  F4');
  for (const r of [...reports].sort((a, b) => b.aspect - a.aspect)) {
    const fail = r.aspect > F4_THRESHOLD ? '  FAIL' : '';
    const focus = FOCUS.has(fixtureNumericId(r.fixture)) ? ' ★' : '  ';
    console.log(
      `${focus}${r.fixture.padEnd(40)}${fmt(r.totalWidth, 6)} ${fmt(r.totalHeight, 6)}   ${r.aspect.toFixed(2).padStart(5)}${fail}`
    );
  }

  // 报告 2: 重点 fixture 的逐 process 形状
  console.log('\n━━━ 重点 fixture ELK 形状（★ = §3.1 baseline F4 fail）━━━');
  for (const r of reports) {
    const id = fixtureNumericId(r.fixture);
    const isFocus = FOCUS.has(id);
    const isFail = r.aspect > F4_THRESHOLD;
    if (!isFocus && !isFail) continue;
    const mark = isFocus ? '★' : '·';
    console.log(`\n${mark} ${r.fixture}   total ${r.totalWidth.toFixed(0)} × ${r.totalHeight.toFixed(0)}  aspect=${r.aspect.toFixed(2)}`);
    for (const s of r.shapes) {
      printShape('  ', s);
    }
  }

  // 报告 3: 单链度（main process layerCount vs nodeCount，fan-out）
  console.log('\n━━━ 单链 vs 树形分类（★ fixture）━━━');
  console.log('fixture                              proc                     nodes  layers  maxLayerN  maxFanOut  形态');
  for (const r of reports) {
    if (!FOCUS.has(fixtureNumericId(r.fixture))) continue;
    for (const s of r.shapes) {
      const maxLayer = s.perLayerNodeCount.length > 0 ? Math.max(...s.perLayerNodeCount) : 0;
      let shape = '?';
      if (s.nodeCount === 0) shape = '空';
      else if (maxLayer === 1 && s.maxFanOut <= 1) shape = '纯单链';
      else if (maxLayer <= 1 && s.maxFanOut > 1) shape = '单链 + gateway 分支但分支被压扁';
      else if (s.maxFanOut <= 1) shape = '多列但无分叉（异常）';
      else shape = '分支树';
      console.log(
        `${r.fixture.padEnd(38)}${s.processId.padEnd(24)}${fmt(s.nodeCount, 5)}${fmt(s.layerCount, 8)}${fmt(maxLayer, 11)}${fmt(s.maxFanOut, 11)}  ${shape}`
      );
    }
  }
}

main()
  .then(() => process.exit(0))  // elkjs worker 不会自动退出
  .catch(e => { console.error(e); process.exit(1); });
