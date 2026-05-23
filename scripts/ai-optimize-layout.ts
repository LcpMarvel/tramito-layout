import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AiLayoutViolation } from '../src/evaluation/layout-evaluator.ts';

const ROOT = resolve(import.meta.dir, '..');
const FIXTURES_DIR = join(ROOT, 'fixtures');
const OUT_DIR = join(ROOT, 'out-ai-debug');
const PROMPT_PATH = join(ROOT, 'docs/prompts/layout-critic.md');

interface Args {
  fixture: string;
  dryRun: boolean;
  localRun: boolean;
}

interface Analysis {
  rootCauseHypotheses: Array<{
    confidence: number;
    stage: string;
    subjects: string[];
    reason: string;
    evidenceFiles: string[];
    suggestedFiles: string[];
  }>;
  recommendedNextChecks: string[];
  patchPlan: Array<{
    scope: 'single stage';
    files: string[];
    expectedImprovement: string[];
    regressionRisks: string[];
    validationCommands: string[];
  }>;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.localRun) {
    throw new Error('local-run is intentionally not enabled yet; use --dry-run to generate a patch plan first');
  }
  if (!args.dryRun) throw new Error('only --dry-run is supported');

  const fixture = resolveFixture(args.fixture);
  const bundleDir = join(OUT_DIR, fixture);
  const violationsPath = join(bundleDir, 'violations.json');
  const snapshotsPath = join(bundleDir, 'stage-snapshots.json');
  if (!existsSync(violationsPath) || !existsSync(snapshotsPath)) {
    throw new Error(`missing debug bundle for ${fixture}; run 'bun run debug:ai ${fixture}' first`);
  }

  const violations = JSON.parse(readFileSync(violationsPath, 'utf-8')) as AiLayoutViolation[];
  const prompt = buildPrompt(fixture, bundleDir);
  const analysis = buildLocalAnalysis(violations);
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(join(bundleDir, 'ai-critic-prompt.txt'), prompt);
  writeFileSync(join(bundleDir, 'ai-analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`);
  console.log(`✓ dry-run analysis → ${join(bundleDir, 'ai-analysis.json')}`);
}

function parseArgs(argv: string[]): Args {
  let fixture = '';
  let dryRun = false;
  let localRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--fixture' && argv[i + 1]) {
      fixture = argv[++i]!;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--local-run') {
      localRun = true;
    }
  }
  if (!fixture) throw new Error('usage: bun run ai:optimize --fixture <fixture> --dry-run');
  return { fixture, dryRun, localRun };
}

function resolveFixture(target: string): string {
  const fixtures = readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''))
    .sort();
  if (fixtures.includes(target)) return target;
  const normalizedId = target.replace(/^0+/, '');
  const found = fixtures.find(f => f.split('-')[0]!.replace(/^0+/, '') === normalizedId);
  if (!found) throw new Error(`unknown fixture: ${target}`);
  return found;
}

function buildPrompt(fixture: string, bundleDir: string): string {
  const prompt = readFileSync(PROMPT_PATH, 'utf-8');
  const briefPath = join(bundleDir, 'ai-brief.md');
  const brief = existsSync(briefPath) ? readFileSync(briefPath, 'utf-8') : '';
  return `${prompt}

## Bundle

Fixture: ${fixture}
Bundle directory: ${bundleDir}

## Brief

${brief}
`;
}

function buildLocalAnalysis(violations: AiLayoutViolation[]): Analysis {
  const groups = new Map<string, AiLayoutViolation[]>();
  for (const violation of violations) {
    const stage = violation.suspectedStages[0] ?? 'unknown';
    const key = `${stage}::${violation.subject.kind}:${violation.subject.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(violation);
  }

  const hypotheses = Array.from(groups.values())
    .map(group => {
      const first = group[0]!;
      return {
        confidence: Math.min(0.85, 0.45 + group.length * 0.1),
        stage: first.suspectedStages[0] ?? 'unknown',
        subjects: Array.from(new Set(group.map(v => v.subject.id))),
        reason: group.map(v => `${v.ruleId}: ${v.evidence.message}`).join('; '),
        evidenceFiles: ['violations.json', 'stage-snapshots.json'],
        suggestedFiles: Array.from(new Set(group.flatMap(v => v.sourceHints.map(h => h.path)))),
      };
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10);

  const firstFiles = hypotheses[0]?.suggestedFiles.slice(0, 1) ?? [];
  return {
    rootCauseHypotheses: hypotheses,
    recommendedNextChecks: [
      'Compare the first failing subject across stage-snapshots.json from suspected stage to serializer.',
      'Check whether the suspected stage output already violates the rule before changing later stages.',
    ],
    patchPlan: firstFiles.length > 0
      ? [{
        scope: 'single stage',
        files: firstFiles,
        expectedImprovement: hypotheses[0]!.reason.split('; ').map(s => s.split(':')[0]!),
        regressionRisks: ['E/N/B/L hard rule regressions in representative fixtures'],
        validationCommands: [
          'bun test',
          'bunx tsc --noEmit',
          'bun run fixtures:xml',
          'bun run check:layout',
        ],
      }]
      : [],
  };
}

main();
