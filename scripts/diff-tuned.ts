// 手调 ideal ↔ 自动布局 坐标 diff（编辑器闭环的「对比」环节）。
//
// 闭环：在编辑器(`bun run editor`)里手调某个 fixture 的布局并保存 → out-tuned/<fixture>/
// （edited.bpmn = 手调理想 + input.json = 原始源）。本脚本用**当前代码**重新编译 input.json
// 得到自动布局，再和 edited.bpmn 逐节点 / 逐边对比，给 AI 一份「自动还差在哪」的结构化事实，
// 据此修 *布局算法*（而不是给单个 fixture 打坐标补丁）。详见 docs/layout-tune-workflow.md。
//
// 用法：
//   bun run tuned:diff                 # 所有 out-tuned/* 都对比
//   bun run tuned:diff 41              # 只对比 41 开头的
//   bun run tuned:diff 41-cross-lane-dense
//   bun run tuned:diff --json          # 机器可读（给 AI / debug 工具）
//
// 退出码：有任一 fixture 的自动布局与手调存在差异 → 1（方便 CI/loop 感知"还没追平"）。

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { layoutBpmnXml } from '../src/index.ts';
import { warmup } from '../src/layout/elk-singleton.ts';
import {
  parseBpmnLayout,
  evaluateBpmnXmlFixtures,
  serializeLayoutEvaluation,
  type Point,
  type EdgeRoute,
} from '../src/evaluation/layout-evaluator.ts';

const ROOT = resolve(import.meta.dir, '..');
const TUNED_DIR = resolve(ROOT, 'out-tuned');

// 坐标四舍五入到整像素再比——edited.bpmn 来自 bpmn-js，可能带 .0001 噪声。
const r = (n: number) => Math.round(n);
// 节点/路点视为"动了"的阈值（px）。小于它当作浮点噪声。
const MOVE_EPS = 1;

interface EdgeDiff {
  id: string;
  autoPts: Point[];
  tunedPts: Point[];
  autoShape: string;
  tunedShape: string;
  /** 手调点数更少 = 自动可能过度绕路（router 候选改进点）。 */
  tunedSimpler: boolean;
}
interface NodeDiff { id: string; auto: { x: number; y: number }; tuned: { x: number; y: number }; dx: number; dy: number }
interface FixtureDiff {
  fixture: string;
  nodesMoved: NodeDiff[];
  edgesRerouted: EdgeDiff[];
  /** 已扣除的整体平移（auto→tuned 的中位 Δ）。手调常顺手把整图拖一下，那是视觉无意义的。 */
  translation: { dx: number; dy: number };
  hard: { auto: number; tuned: number };
  softFail: { auto: string[]; tuned: string[] };
  identical: boolean;
  error?: string;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

/** 路点形状速记：L=3点折线，Z=4点，corridor/complex=更多段。供 AI 一眼看出"自动绕了"。 */
function shapeOf(pts: Point[]): string {
  const n = pts.length;
  if (n <= 2) return `直线(${n})`;
  if (n === 3) return `L(3)`;
  if (n === 4) return `Z(4)`;
  return `多段(${n})`;
}

function ptsEqual(a: Point[], b: Point[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(r(a[i]!.x) - r(b[i]!.x)) > MOVE_EPS || Math.abs(r(a[i]!.y) - r(b[i]!.y)) > MOVE_EPS) return false;
  }
  return true;
}

function fmtPts(pts: Point[]): string {
  return pts.map((p) => `(${r(p.x)},${r(p.y)})`).join('');
}

function evalOne(name: string, xml: string): { hard: number; softFail: string[] } {
  const ev = serializeLayoutEvaluation(evaluateBpmnXmlFixtures([{ fixture: name, xml }]), '');
  const f = ev.fixtures[0];
  return { hard: f?.hardViolationCount ?? 0, softFail: (f?.softFailures ?? []).slice() };
}

async function diffFixture(fixture: string): Promise<FixtureDiff> {
  const dir = resolve(TUNED_DIR, fixture);
  const inputFile = resolve(dir, 'input.json');
  const tunedFile = resolve(dir, 'edited.bpmn');
  // 早抛：缺料直接报错，不静默跳过（项目规范：早抛少兜底）。
  if (!existsSync(inputFile)) throw new Error(`${fixture}: 缺 input.json`);
  if (!existsSync(tunedFile)) throw new Error(`${fixture}: 缺 edited.bpmn`);

  const source = JSON.parse(readFileSync(inputFile, 'utf-8'));
  let autoXml: string;
  try {
    autoXml = (await layoutBpmnXml(source, fixture)).xml;
  } catch (e: any) {
    // 自动布局编译失败本身就是要报告的事实（可能是 ICE / 校验错）。
    return {
      fixture, nodesMoved: [], edgesRerouted: [], translation: { dx: 0, dy: 0 }, hard: { auto: -1, tuned: -1 },
      softFail: { auto: [], tuned: [] }, identical: false, error: `自动布局编译失败: ${e?.message ?? e}`,
    };
  }
  const tunedXml = readFileSync(tunedFile, 'utf-8');

  const auto = parseBpmnLayout(fixture, autoXml);
  const tuned = parseBpmnLayout(fixture, tunedXml);

  // 容器(lane/pool/process/collaboration)位置是 content + 高度推导出来的，不独立成"手调意图"——
  // 只比 flow node（subProcess 是真节点，保留）。否则容器跟着内容平移会噪声满屏。
  const CONTAINER_KIND = new Set(['lane', 'pool', 'process', 'collaboration']);
  const isContainer = (id: string) => CONTAINER_KIND.has(tuned.kindOf.get(id) ?? auto.kindOf.get(id) ?? '');
  const flowIds = [...tuned.boxes.keys()].filter((id) => auto.boxes.has(id) && !isContainer(id));

  // 扣除整体平移：手调常把整图拖一下，绝对坐标全变但视觉无意义。取 flow node Δ 的中位数当平移量，
  // 只报残差（真正的相对位置变化）。纯平移 → 残差全 0 → 报"一致"。
  const mdx = median(flowIds.map((id) => r(tuned.boxes.get(id)!.x) - r(auto.boxes.get(id)!.x)));
  const mdy = median(flowIds.map((id) => r(tuned.boxes.get(id)!.y) - r(auto.boxes.get(id)!.y)));

  const nodesMoved: NodeDiff[] = [];
  for (const id of flowIds) {
    const ab = auto.boxes.get(id)!, tb = tuned.boxes.get(id)!;
    const dx = (r(tb.x) - r(ab.x)) - mdx;
    const dy = (r(tb.y) - r(ab.y)) - mdy;
    if (Math.abs(dx) > MOVE_EPS || Math.abs(dy) > MOVE_EPS) {
      nodesMoved.push({ id, auto: { x: r(ab.x), y: r(ab.y) }, tuned: { x: r(tb.x), y: r(tb.y) }, dx, dy });
    }
  }

  // 边也按同一平移量归一后再比形状/几何（auto 的 waypoints 加上平移再和 tuned 比）。
  const shift = (pts: Point[]): Point[] => pts.map((p) => ({ x: p.x + mdx, y: p.y + mdy }));
  const autoEdges = new Map<string, EdgeRoute>(auto.edges.map((e) => [e.id, e]));
  const edgesRerouted: EdgeDiff[] = [];
  for (const te of tuned.edges) {
    const ae = autoEdges.get(te.id);
    if (!ae) continue;
    const autoShifted = shift(ae.waypoints);
    if (ptsEqual(autoShifted, te.waypoints)) continue;
    edgesRerouted.push({
      id: te.id,
      autoPts: autoShifted, tunedPts: te.waypoints,
      autoShape: shapeOf(ae.waypoints), tunedShape: shapeOf(te.waypoints),
      tunedSimpler: te.waypoints.length < ae.waypoints.length,
    });
  }

  return {
    fixture,
    nodesMoved: nodesMoved.sort((a, b) => a.id.localeCompare(b.id)),
    edgesRerouted: edgesRerouted.sort((a, b) => a.id.localeCompare(b.id)),
    translation: { dx: mdx, dy: mdy },
    hard: { auto: evalOne(fixture, autoXml).hard, tuned: evalOne(fixture, tunedXml).hard },
    softFail: { auto: evalOne(fixture, autoXml).softFail, tuned: evalOne(fixture, tunedXml).softFail },
    identical: nodesMoved.length === 0 && edgesRerouted.length === 0,
  };
}

function listTunedFixtures(filter: string | null): string[] {
  if (!existsSync(TUNED_DIR)) return [];
  return readdirSync(TUNED_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => existsSync(resolve(TUNED_DIR, name, 'edited.bpmn')))
    .filter((name) => !filter || name.startsWith(filter) || name.replace(/^0+/, '').startsWith(filter))
    .sort();
}

// 一条边差异是否"待修"：手调比自动更简洁(过度绕路)，或同段数但几何不同(手调挪了路点)。
// 自动严格更简洁 = 自动已反超手调，不算待修。
function edgeActionable(e: EdgeDiff): boolean {
  return !(e.autoPts.length < e.tunedPts.length);
}
// 整个 fixture 是否还有"待修"差异：有节点被挪 或 有待修边。
function fixtureActionable(d: FixtureDiff): boolean {
  return !d.error && (d.nodesMoved.length > 0 || d.edgesRerouted.some(edgeActionable));
}

function printHuman(diffs: FixtureDiff[]): void {
  for (const d of diffs) {
    console.log(`\n=== ${d.fixture} ===`);
    if (d.error) { console.log(`  ⚠ ${d.error}`); continue; }
    const todo = d.edgesRerouted.filter(edgeActionable);
    const surpassed = d.edgesRerouted.filter((e) => !edgeActionable(e));
    if (d.identical) console.log('  ✓ 自动 = 手调（扣除整体平移后逐点一致）');
    else if (!fixtureActionable(d)) console.log(`  ✓ 自动已不弱于手调（${surpassed.length} 边自动更简洁）——建议在编辑器重存基线`);
    else console.log(`  待修：${d.nodesMoved.length} 节点相对位移, ${todo.length} 边手调更优`);
    if (d.translation.dx !== 0 || d.translation.dy !== 0) {
      console.log(`  （已扣除整体平移 Δ(${d.translation.dx},${d.translation.dy})——视觉无意义，不计）`);
    }
    console.log(`  硬违例 auto=${d.hard.auto} tuned=${d.hard.tuned}   软失败 auto=[${d.softFail.auto.join(',')}] tuned=[${d.softFail.tuned.join(',')}]`);
    if (d.nodesMoved.length) {
      console.log(`  --- 节点相对位移（已扣平移；Δ=手调相对自动还差多少 = 摆位算法方向）---`);
      for (const n of d.nodesMoved) {
        console.log(`    ${n.id.padEnd(24)} auto(${n.auto.x},${n.auto.y}) → tuned(${n.tuned.x},${n.tuned.y})  Δ(${n.dx >= 0 ? '+' : ''}${n.dx},${n.dy >= 0 ? '+' : ''}${n.dy})`);
      }
    }
    if (d.edgesRerouted.length) {
      console.log(`  --- 边路由差异（★=手调更优待修 router / ✓=自动已反超）---`);
      for (const e of d.edgesRerouted) {
        const mark = e.tunedSimpler ? '★' : (e.autoPts.length < e.tunedPts.length ? '✓' : '·');
        console.log(`   ${mark} ${e.id.padEnd(22)} auto ${e.autoShape}  →  tuned ${e.tunedShape}`);
        console.log(`      auto : ${fmtPts(e.autoPts)}`);
        console.log(`      tuned: ${fmtPts(e.tunedPts)}`);
      }
    }
  }
  const todo = diffs.filter(fixtureActionable);
  console.log(`\n${diffs.length} fixture 对比，${todo.length} 个有「待修」差异（手调更优）` + (todo.length ? `：${todo.map((d) => d.fixture).join(', ')}` : '（其余要么一致、要么自动已反超）'));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const filter = args.find((a) => !a.startsWith('--')) ?? null;

  const fixtures = listTunedFixtures(filter);
  if (fixtures.length === 0) {
    console.error(filter ? `out-tuned/ 下没有匹配 "${filter}" 的手调 fixture` : 'out-tuned/ 下没有手调 fixture（先用 `bun run editor` 调一个并保存）');
    process.exit(asJson ? 0 : 1);
  }

  await warmup();
  const diffs: FixtureDiff[] = [];
  for (const f of fixtures) {
    try { diffs.push(await diffFixture(f)); }
    catch (e: any) { diffs.push({ fixture: f, nodesMoved: [], edgesRerouted: [], translation: { dx: 0, dy: 0 }, hard: { auto: -1, tuned: -1 }, softFail: { auto: [], tuned: [] }, identical: false, error: e?.message ?? String(e) }); }
  }

  if (asJson) {
    console.log(JSON.stringify({ generatedAt: null, fixtures: diffs }, null, 2));
  } else {
    printHuman(diffs);
  }

  // 退出码只看"待修"（手调更优）；自动已反超 / 一致都算 0，方便 loop 判断"是否还有要改的"。
  const anyActionable = diffs.some(fixtureActionable);
  process.exit(anyActionable && !asJson ? 1 : 0);
}

await main();
