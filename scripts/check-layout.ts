// 客观硬/软标准检测 CLI。
//
// 用法：
//   bun run scripts/check-layout.ts                   # 全部 fixture × 全部规则
//   bun run scripts/check-layout.ts --rules E         # 仅 E 类
//   bun run scripts/check-layout.ts --rules E1,N1     # 指定子规则
//   bun run scripts/check-layout.ts 31 32             # 指定 fixture

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  evaluateBpmnXmlFixtures,
  expandRuleFilter,
  formatEvaluationJson,
  formatEvaluationReport,
  type EvaluationOptions,
  type FixtureXml,
} from '../src/evaluation/layout-evaluator';

const OUT_DIR = join(import.meta.dir, '..', 'out-xml');

interface CliArgs extends EvaluationOptions {
  fixtureFilter: Set<string> | null;
  verbose: boolean;
  json: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let ruleFilter: Set<string> | null = null;
  let fixtureFilter: Set<string> | null = null;
  let verbose = true;
  let json = false;
  let hardOnly = false;
  let softOnly = false;

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
    } else if (/^\d+/.test(a)) {
      fixtureFilter ??= new Set<string>();
      fixtureFilter.add(a.replace(/^0+/, ''));
    }
  }

  return { ruleFilter, fixtureFilter, verbose, hardOnly, softOnly, json };
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
  const { fixtureFilter, verbose, json, ...options } = parseArgs();
  const result = evaluateBpmnXmlFixtures(readFixtureXmls(fixtureFilter), options);
  process.stdout.write(json ? formatEvaluationJson(result) : formatEvaluationReport(result, verbose));
}

main();
