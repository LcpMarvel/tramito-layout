import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { layoutBpmnXml } from '../src/index.ts';
import { warmup } from '../src/layout/elk-singleton.ts';
import {
  evaluateBpmnXmlFixtures,
  parseBpmnLayout,
  serializeLayoutEvaluation,
  type AiLayoutViolation,
} from '../src/evaluation/layout-evaluator.ts';
import { computeMetrics } from '../src/metrics/aesthetic-metrics.ts';
import type { EdgeRoute, NodeBox } from '../src/stages/types.ts';

const ROOT = resolve(import.meta.dir, '..');
const FIXTURES_DIR = join(ROOT, 'fixtures');
const XML_DIR = join(ROOT, 'out-xml');
const PNG_DIR = join(ROOT, 'out-bpmn-png');
const OUT_DIR = join(ROOT, 'out-ai-debug');

interface FixtureSummary {
  fixture: string;
  status: 'pass' | 'hard-fail' | 'soft-regression' | 'error';
  hardViolationCount: number;
  softFailures: string[];
  bundleDir: string;
  error?: string;
}

interface Manifest {
  generatedAt: string;
  project: 'tramito-layout';
  version: string;
  git?: {
    branch?: string;
    commit?: string;
    dirty?: boolean;
  };
  commands: {
    xml: string;
    png: string;
    evaluation: string;
  };
  fixtures: FixtureSummary[];
}

async function main(): Promise<void> {
  const targets = parseTargets(process.argv.slice(2));
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(XML_DIR, { recursive: true });
  await warmup();

  const generatedAt = new Date().toISOString();
  const summaries: FixtureSummary[] = [];
  const evaluationInputs: { fixture: string; xml: string }[] = [];

  for (const fixture of targets) {
    const bundleDir = join(OUT_DIR, fixture);
    mkdirSync(bundleDir, { recursive: true });
    try {
      const inputPath = join(FIXTURES_DIR, `${fixture}.json`);
      if (!existsSync(inputPath)) throw new Error(`fixture not found: ${fixture}`);
      const rawText = readFileSync(inputPath, 'utf-8');
      const rawJson = JSON.parse(rawText);
      const { xml, trace } = await layoutBpmnXml(rawJson, fixture, { debug: { stageSnapshots: true } });
      const evaluation = evaluateBpmnXmlFixtures([{ fixture, xml }]);
      const serializableEvaluation = serializeLayoutEvaluation(evaluation, generatedAt);
      const fixtureEval = serializableEvaluation.fixtures[0];
      if (!fixtureEval) throw new Error(`missing evaluation row for ${fixture}`);
      const violations = serializableEvaluation.hard?.violations ?? [];
      const parsed = parseBpmnLayout(fixture, xml);
      const metrics = computeFixtureMetrics(parsed);

      writeFileSync(join(bundleDir, 'input.json'), `${JSON.stringify(rawJson, null, 2)}\n`);
      writeFileSync(join(bundleDir, 'output.bpmn'), xml);
      writeFileSync(join(bundleDir, 'trace.json'), `${JSON.stringify(stripSnapshotsFromTrace(trace), null, 2)}\n`);
      writeFileSync(join(bundleDir, 'stage-snapshots.json'), `${JSON.stringify(trace.stageSnapshots ?? [], null, 2)}\n`);
      writeFileSync(join(bundleDir, 'decisions.json'), `${JSON.stringify(trace.decisions, null, 2)}\n`);
      writeFileSync(join(bundleDir, 'constraints.json'), `${JSON.stringify(trace.constraints, null, 2)}\n`);
      writeFileSync(join(bundleDir, 'violations.json'), `${JSON.stringify(violations, null, 2)}\n`);
      writeFileSync(join(bundleDir, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
      writeFileSync(join(bundleDir, 'ai-brief.md'), buildAiBrief(fixture, fixtureEval, violations));

      const pngPath = join(PNG_DIR, `${fixture}.png`);
      if (!existsSync(pngPath)) {
        throw new Error(`PNG missing for ${fixture}; run 'bun run fixtures:png' first`);
      }
      copyFileSync(pngPath, join(bundleDir, 'output.png'));

      evaluationInputs.push({ fixture, xml });
      summaries.push({
        fixture,
        status: fixtureEval.status,
        hardViolationCount: fixtureEval.hardViolationCount,
        softFailures: fixtureEval.softFailures,
        bundleDir,
      });
      writeFileSync(join(XML_DIR, `${fixture}.bpmn`), xml);
      console.log(`✓ ${fixture} → ${bundleDir}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeFileSync(join(bundleDir, 'error.json'), `${JSON.stringify({ fixture, error: message }, null, 2)}\n`);
      summaries.push({
        fixture,
        status: 'error',
        hardViolationCount: 0,
        softFailures: [],
        bundleDir,
        error: message,
      });
      console.error(`✗ ${fixture}: ${message}`);
    }
  }

  if (evaluationInputs.length > 0) {
    const evaluation = evaluateBpmnXmlFixtures(evaluationInputs);
    writeFileSync(join(OUT_DIR, 'evaluation.json'), `${JSON.stringify(serializeLayoutEvaluation(evaluation, generatedAt), null, 2)}\n`);
  }

  const git = gitInfo();
  const manifest: Manifest = {
    generatedAt,
    project: 'tramito-layout',
    version: readPackageVersion(),
    ...(git ? { git } : {}),
    commands: {
      xml: 'bun run fixtures:xml',
      png: 'bun run fixtures:png',
      evaluation: 'bun run check:layout --json',
    },
    fixtures: summaries,
  };
  writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  if (summaries.some(s => s.status === 'error')) process.exit(1);
}

function parseTargets(args: string[]): string[] {
  const positional = args.filter(arg => !arg.startsWith('-'));
  if (positional.length === 0) {
    throw new Error('usage: bun run debug:ai <fixture> [fixture...]');
  }
  const fixtures = readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''))
    .sort();
  return positional.map(target => {
    if (fixtures.includes(target)) return target;
    const normalizedId = target.replace(/^0+/, '');
    const found = fixtures.find(f => f.split('-')[0]!.replace(/^0+/, '') === normalizedId);
    if (!found) throw new Error(`unknown fixture: ${target}`);
    return found;
  });
}

function computeFixtureMetrics(parsed: ReturnType<typeof parseBpmnLayout>): ReturnType<typeof computeMetrics> {
  const nodes = new Map<string, NodeBox>();
  for (const [id, box] of parsed.boxes) {
    const kind = parsed.kindOf.get(id);
    if (!kind || ['lane', 'pool', 'process', 'collaboration'].includes(kind)) continue;
    nodes.set(id, { x: box.x, y: box.y, w: box.w, h: box.h });
  }
  const routes = new Map<string, EdgeRoute>();
  for (const edge of parsed.edges) {
    routes.set(edge.id, {
      edgeId: edge.id,
      edgeType: 'forward-straight',
      sourcePort: {
        nodeId: edge.source,
        side: 'right',
        point: edge.waypoints[0]!,
        boundary: 'box',
      },
      targetPort: {
        nodeId: edge.target,
        side: 'left',
        point: edge.waypoints[edge.waypoints.length - 1]!,
        boundary: 'box',
      },
      waypoints: edge.waypoints,
      channel: 0,
    });
  }
  return computeMetrics({
    fixture: parsed.fixture,
    nodes,
    routes,
    totalBounds: { width: parsed.totalW, height: parsed.totalH },
  });
}

function stripSnapshotsFromTrace(trace: any): Record<string, unknown> {
  const { stageSnapshots: _stageSnapshots, ...rest } = trace;
  return rest;
}

function buildAiBrief(
  fixture: string,
  fixtureEval: { hardViolationCount: number; softFailures: string[]; status: string },
  violations: AiLayoutViolation[],
): string {
  const suspicious = topSuspiciousStages(violations);
  return `# Fixture ${fixture} AI Debug Brief

## Result
- Status: ${fixtureEval.status}
- Hard violations: ${fixtureEval.hardViolationCount}
- Soft failures: ${fixtureEval.softFailures.length ? fixtureEval.softFailures.join(', ') : 'none'}

## Most suspicious stage
${suspicious.length ? suspicious.map(s => `- ${s.stage}: ${s.count} hard violation(s)`).join('\n') : '- none'}

## Evidence files
- violations.json
- stage-snapshots.json
- decisions.json
- constraints.json
- metrics.json
- output.bpmn
- output.png

## Suggested investigation order
1. Compare edge-router, merger, and serializer snapshots for the same subject id.
2. Inspect sourcePort/targetPort and final waypoint segment for edge violations.
3. Check sourceHints in violations.json before opening broader code.
`;
}

function topSuspiciousStages(violations: AiLayoutViolation[]): Array<{ stage: string; count: number }> {
  const counts = new Map<string, number>();
  for (const violation of violations) {
    const stage = violation.suspectedStages[0] ?? 'unknown';
    counts.set(stage, (counts.get(stage) ?? 0) + 1);
  }
  return Array.from(counts, ([stage, count]) => ({ stage, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { version?: string };
  return pkg.version ?? '0.0.0';
}

function gitInfo(): Manifest['git'] | undefined {
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  const commit = runGit(['rev-parse', 'HEAD']);
  if (!branch && !commit) return undefined;
  const status = runGit(['status', '--porcelain']);
  return {
    ...(branch ? { branch } : {}),
    ...(commit ? { commit } : {}),
    dirty: status !== '',
  };
}

function runGit(args: string[]): string | undefined {
  const proc = Bun.spawnSync(['git', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) return undefined;
  return new TextDecoder().decode(proc.stdout).trim();
}

await main();
process.exit(0);
