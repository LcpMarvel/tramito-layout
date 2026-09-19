// 客观硬/软标准检测 CLI。
//
// 用法：
//   bun run scripts/check-layout.ts                   # 全部 fixture × 全部规则
//   bun run scripts/check-layout.ts --rules E         # 仅 E 类
//   bun run scripts/check-layout.ts --rules E1,N1     # 指定子规则
//   bun run scripts/check-layout.ts 31 32             # 指定 fixture
//   bun run scripts/check-layout.ts --save-baseline docs/layout-baseline.json
//   bun run scripts/check-layout.ts --compare docs/layout-baseline.json
//
// baseline 纪律（aesthetics-roadmap §0）：baseline 只在**人看过 PNG 确认确实更好看**
// 之后由人手动 --save-baseline 更新。它是防止"用尺子过 CI"的唯一门禁——机器不许自动写。

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildBaseline,
  compareWithBaseline,
  evaluateBpmnXmlFixtures,
  expandRuleFilter,
  formatCompareReport,
  formatEvaluationJson,
  formatEvaluationReport,
  type EvaluationOptions,
  type FixtureXml,
  type LayoutBaseline,
} from '../src/evaluation/layout-evaluator';

const OUT_DIR = join(import.meta.dir, '..', 'out-xml');

interface CliArgs extends EvaluationOptions {
  fixtureFilter: Set<string> | null;
  verbose: boolean;
  json: boolean;
  saveBaseline: string | null;
  compare: string | null;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let ruleFilter: Set<string> | null = null;
  let fixtureFilter: Set<string> | null = null;
  let verbose = true;
  let json = false;
  let hardOnly = false;
  let softOnly = false;
  let saveBaseline: string | null = null;
  let compare: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--rules' && i + 1 < args.length) {
      const tokens = args[++i]!.split(',').map(s => s.trim()).filter(Boolean);
      ruleFilter = expandRuleFilter(tokens);
    } else if (a === '--quiet') {
      verbose = false;
    } else if (a === '--json') {
      json = true;
      verbose = false;
    } else if (a === '--hard') {
      hardOnly = true;
    } else if (a === '--soft') {
      softOnly = true;
    } else if (a === '--save-baseline' && i + 1 < args.length) {
      saveBaseline = args[++i]!;
    } else if (a === '--compare' && i + 1 < args.length) {
      compare = args[++i]!;
    } else if (/^\d+/.test(a)) {
      fixtureFilter ??= new Set<string>();
      fixtureFilter.add(a.replace(/^0+/, ''));
    }
  }

  return { ruleFilter, fixtureFilter, verbose, hardOnly, softOnly, json, saveBaseline, compare };
}

function readFixtureXmls(fixtureFilter: Set<string> | null): FixtureXml[] {
  const fixtures: FixtureXml[] = [];
  const files = readdirSync(OUT_DIR).filter(f => f.endsWith('.bpmn')).sort();
  for (const f of files) {
    const stem = f.replace(/\.bpmn$/, '');
    const id = stem.split('-')[0]!.replace(/^0+/, '');
    if (fixtureFilter && !fixtureFilter.has(id)) continue;
    fixtures.push({ fixture: stem, xml: readFileSync(join(OUT_DIR, f), 'utf-8') });
  }
  return fixtures;
}

function main(): void {
  const { fixtureFilter, verbose, json, saveBaseline, compare, ...options } = parseArgs();
  const result = evaluateBpmnXmlFixtures(readFixtureXmls(fixtureFilter), options);

  if (saveBaseline) {
    writeFileSync(saveBaseline, `${JSON.stringify(buildBaseline(result), null, 2)}\n`);
    process.stdout.write(`baseline written to ${saveBaseline}\n`);
    return;
  }

  if (compare) {
    const baseline = JSON.parse(readFileSync(compare, 'utf-8')) as LayoutBaseline;
    const diff = compareWithBaseline(result, baseline);
    // 跑子集时，子集外的"缺失"是选择而非删除，不警告
    if (fixtureFilter) diff.missingFixtures = diff.missingFixtures.filter(fx => fixtureFilter.has(fx.split('-')[0]!.replace(/^0+/, '')));
    process.stdout.write(formatCompareReport(diff, compare));
    if (diff.hardRegressions.length > 0 || diff.softRegressions.length > 0) process.exit(1);
    return;
  }

  process.stdout.write(json ? formatEvaluationJson(result) : formatEvaluationReport(result, verbose));
}

main();
