// 本地布局编辑器 dev server。
//
// 回路：选 fixtures/*.json → layoutBpmnXml() 出 BPMN XML → bpmn-js Modeler 渲染 →
// 用户拖拽/美化 → 保存到 out-tuned/<fixture>/（手调 XML + 原始 input + meta + 评分），
// 供 AI 用「自动布局 vs 手调理想布局」的坐标 diff 来改进布局算法。
//
// 为什么用 Bun.serve + inline HTML：仓库不维护独立 HTTP server 入口（README），这是开发期
// 工具，类比 render-bpmn.ts —— 不进 npm 包、不引 web 框架依赖。bpmn-js Modeler / CSS 直接
// 从 node_modules/bpmn-js/dist 静态服务，前端无构建步骤。
//
// 用法：bun run scripts/serve-editor.ts    （PORT 可覆盖，默认 3737）

import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { layoutBpmnXml, warmupLayoutEngine, InternalCompilerError } from '../src/index.ts';
import {
  evaluateBpmnXmlFixtures,
  serializeLayoutEvaluation,
  type SerializableEvaluation,
} from '../src/evaluation/layout-evaluator.ts';

const ROOT = resolve(import.meta.dir, '..');
const FIXTURES_DIR = resolve(ROOT, 'fixtures');
const TUNED_DIR = resolve(ROOT, 'out-tuned');
const BPMN_DIST = resolve(ROOT, 'node_modules/bpmn-js/dist');
const MODELER_JS = resolve(BPMN_DIST, 'bpmn-modeler.production.min.js');
const ASSETS_DIR = resolve(BPMN_DIST, 'assets');

// 早抛：缺资产直接报错，不静默兜底（项目规范）。
if (!existsSync(MODELER_JS)) throw new Error(`bpmn-js modeler not found at ${MODELER_JS} — run 'bun install'`);
if (!existsSync(ASSETS_DIR)) throw new Error(`bpmn-js assets not found at ${ASSETS_DIR}`);

const PORT = Number(process.env.PORT ?? 3737);

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** fixtures 列表（排除 layout-loop 临时探针 zzfuzz-*）。 */
function listFixtures(): { name: string; sizeKB: number }[] {
  return readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('zzfuzz-'))
    .map(f => ({
      name: f.replace(/\.json$/, ''),
      sizeKB: +(Bun.file(resolve(FIXTURES_DIR, f)).size / 1024).toFixed(1),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 校验 fixture 名只能是已存在文件名，杜绝路径穿越。 */
function resolveFixtureFile(name: string): string {
  const safe = name.replace(/\.json$/, '');
  const file = resolve(FIXTURES_DIR, `${safe}.json`);
  if (!file.startsWith(FIXTURES_DIR) || !existsSync(file)) {
    throw new Error(`fixture not found: ${name}`);
  }
  return file;
}

/** 把 layoutBpmnXml 抛的错分层透传给前端：校验错(AggregateError) vs ICE(编译器 bug) vs 其它。 */
function errorPayload(e: unknown): { kind: string; message: string; detail?: unknown } {
  if (e instanceof InternalCompilerError) {
    return { kind: 'ice', message: e.message, detail: { stage: (e as { stage?: string }).stage, internal: true } };
  }
  if (e instanceof AggregateError) {
    return {
      kind: 'validation',
      message: e.message || 'graph validation failed',
      detail: e.errors.map(err => (err instanceof Error ? err.message : String(err))),
    };
  }
  return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
}

function evaluate(fixture: string, xml: string): SerializableEvaluation {
  return serializeLayoutEvaluation(evaluateBpmnXmlFixtures([{ fixture, xml }]));
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === '/' || path === '/index.html') {
    return new Response(EDITOR_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  if (path === '/favicon.ico') return new Response(null, { status: 204 });

  if (path === '/vendor/bpmn-modeler.js') {
    return new Response(Bun.file(MODELER_JS), { headers: { 'content-type': MIME['.js']! } });
  }

  if (path.startsWith('/vendor/assets/')) {
    const rel = path.slice('/vendor/assets/'.length);
    const file = resolve(ASSETS_DIR, rel);
    if (!file.startsWith(ASSETS_DIR) || !existsSync(file)) return new Response('not found', { status: 404 });
    return new Response(Bun.file(file), {
      headers: { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' },
    });
  }

  if (path === '/api/fixtures') {
    return json(listFixtures());
  }

  if (path === '/api/layout') {
    const name = url.searchParams.get('fixture');
    if (!name) return json({ kind: 'error', message: 'missing ?fixture=' }, 400);
    try {
      const raw = JSON.parse(readFileSync(resolveFixtureFile(name), 'utf-8'));
      const { xml, trace } = await layoutBpmnXml(raw, name);
      return json({
        xml,
        trace: { routeCount: trace.routeCount, byEdgeType: trace.byEdgeType, msTotal: trace.msTotal },
        evaluation: evaluate(name, xml),
      });
    } catch (e) {
      // 校验错给 422（用户/模型可改），ICE/其它给 500。
      const payload = errorPayload(e);
      return json(payload, payload.kind === 'validation' ? 422 : 500);
    }
  }

  if (path === '/api/evaluate' && req.method === 'POST') {
    const { fixture, xml } = (await req.json()) as { fixture: string; xml: string };
    if (!fixture || !xml) return json({ kind: 'error', message: 'need {fixture, xml}' }, 400);
    return json(evaluate(fixture, xml));
  }

  if (path === '/api/save' && req.method === 'POST') {
    const { fixture, xml } = (await req.json()) as { fixture: string; xml: string };
    if (!fixture || !xml) return json({ kind: 'error', message: 'need {fixture, xml}' }, 400);
    const inputFile = resolveFixtureFile(fixture); // 同时校验 fixture 合法
    const dir = resolve(TUNED_DIR, fixture);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'edited.bpmn'), xml);
    copyFileSync(inputFile, resolve(dir, 'input.json'));
    const evaluation = evaluate(fixture, xml);
    const meta = {
      fixture,
      savedAt: new Date().toISOString(),
      source: 'editor',
      hasBaseline: existsSync(resolve(ROOT, 'out-xml', `${fixture}.bpmn`)),
      summary: evaluation.summary,
    };
    writeFileSync(resolve(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
    return json({ savedTo: `out-tuned/${fixture}/`, evaluation });
  }

  return new Response('not found', { status: 404 });
}

await warmupLayoutEngine();

Bun.serve({
  port: PORT,
  idleTimeout: 120,
  fetch: handle,
});

console.log(`\n  layout editor  →  http://localhost:${PORT}\n  saves to       →  out-tuned/<fixture>/\n`);

// ============================================================
// 编辑器单页（inline，无构建步骤）。bpmn-js Modeler 全局名 = BpmnJS。
// ============================================================

const EDITOR_HTML = /* html */ `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tramito-layout 编辑器</title>
<link rel="stylesheet" href="/vendor/assets/diagram-js.css">
<link rel="stylesheet" href="/vendor/assets/bpmn-js.css">
<!-- 调色板/context-pad 图标字体——@font-face 不在 bpmn-js.css 里，缺它 palette 显示为空白方框 -->
<link rel="stylesheet" href="/vendor/assets/bpmn-font/css/bpmn-embedded.css">
<style>
  :root { --bg:#0f1115; --panel:#171a21; --line:#272c36; --fg:#e6e9ef; --muted:#8b93a3;
          --ok:#3fb950; --bad:#f85149; --accent:#3b82f6; }
  * { box-sizing: border-box; }
  html, body { margin:0; height:100%; font:13px/1.45 ui-sans-serif,system-ui,"PingFang SC",sans-serif;
               background:var(--bg); color:var(--fg); }
  #app { display:grid; grid-template-rows:auto 1fr; height:100vh; }
  header { display:flex; align-items:center; gap:10px; padding:8px 14px; background:var(--panel);
           border-bottom:1px solid var(--line); }
  header h1 { font-size:13px; font-weight:600; margin:0 8px 0 0; color:var(--muted); letter-spacing:.5px; }
  select, button { font:inherit; background:#11141b; color:var(--fg); border:1px solid var(--line);
                   border-radius:6px; padding:5px 10px; cursor:pointer; }
  select { min-width:230px; }
  button:hover { border-color:var(--accent); }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
  button:disabled { opacity:.45; cursor:default; }
  #status { color:var(--muted); margin-left:auto; font-variant-numeric:tabular-nums; }
  #status.err { color:var(--bad); }
  #status.ok { color:var(--ok); }
  main { display:grid; grid-template-columns:1fr 320px; min-height:0; }
  #canvas { background:#fff; min-width:0; }
  #side { background:var(--panel); border-left:1px solid var(--line); overflow:auto; padding:12px 14px; }
  #side h2 { font-size:11px; text-transform:uppercase; letter-spacing:1px; color:var(--muted);
             margin:16px 0 8px; }
  #side h2:first-child { margin-top:0; }
  .grid { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; }
  .cell { background:#11141b; border:1px solid var(--line); border-radius:6px; padding:6px 4px;
          text-align:center; }
  .cell .id { font-size:10px; color:var(--muted); }
  .cell .v { font-size:15px; font-weight:700; font-variant-numeric:tabular-nums; }
  .cell.ok .v { color:var(--ok); }
  .cell.bad { border-color:var(--bad); }
  .cell.bad .v { color:var(--bad); }
  .cell.na .v { color:var(--muted); font-size:12px; font-weight:400; }
  #violations { margin-top:10px; }
  .vrow { border-left:2px solid var(--bad); padding:4px 8px; margin:4px 0; background:#1a1316;
          border-radius:0 4px 4px 0; }
  .vrow .r { color:var(--bad); font-weight:700; margin-right:6px; }
  .vrow .m { color:var(--muted); font-size:11.5px; word-break:break-all; }
  #summary { font-size:12px; color:var(--muted); }
  #summary b.bad { color:var(--bad); } #summary b.ok { color:var(--ok); }
</style>
</head>
<body>
<div id="app">
  <header>
    <h1>TRAMITO-LAYOUT</h1>
    <select id="fixtureSel"><option>加载中…</option></select>
    <button id="saveBtn" class="primary" disabled>保存到 out-tuned</button>
    <span id="status">选一个 fixture 开始</span>
  </header>
  <main>
    <div id="canvas"></div>
    <aside id="side">
      <h2>概览</h2>
      <div id="summary">—</div>
      <h2>硬标准 E / N / B / L（违例数）</h2>
      <div class="grid" id="hardGrid"></div>
      <h2>软指标 F（值 / 阈值）</h2>
      <div class="grid" id="softGrid"></div>
      <h2>违例明细</h2>
      <div id="violations"><span class="m" style="color:var(--muted)">无</span></div>
    </aside>
  </main>
</div>
<script src="/vendor/bpmn-modeler.js"></script>
<script>
const HARD_RULES = ['E1','E2','E3','E4','N1','N2','N3','N4','B1','B2','B3','B4','L1','L2','L3'];
const $ = (id) => document.getElementById(id);
let current = null;        // 当前 fixture 名
let evalTimer = null;

const modeler = new BpmnJS({ container: '#canvas' });

// 与 render-bpmn.ts 一致的 CJK label 补丁：保证编辑器渲染与 PNG 一致（diagram-js 的 wrap
// 测试是严格 <，CJK label 量出的宽与 maxWidth 相等会逐字换行，撑宽返回 bounds 规避）。
(function patchTextRenderer() {
  const tr = modeler.get('textRenderer');
  const original = tr.getExternalLabelBounds.bind(tr);
  tr.getExternalLabelBounds = function(bounds, text) {
    const r = original(bounds, text);
    return { x: r.x - 2, y: r.y, width: r.width + 4, height: r.height + 2 };
  };
})();

function setStatus(msg, cls) { const s = $('status'); s.textContent = msg; s.className = cls || ''; }

async function loadFixtureList() {
  const list = await (await fetch('/api/fixtures')).json();
  const sel = $('fixtureSel');
  sel.innerHTML = '';
  for (const f of list) {
    const o = document.createElement('option');
    o.value = f.name; o.textContent = f.name + '  (' + f.sizeKB + ' KB)';
    sel.appendChild(o);
  }
  // 选中即布局：列表就绪后直接布局第一个，省一次点击。
  if (list.length) await loadLayout();
}

async function loadLayout() {
  const name = $('fixtureSel').value;
  setStatus('编译 ' + name + ' …', '');
  $('saveBtn').disabled = true;
  let res;
  try { res = await fetch('/api/layout?fixture=' + encodeURIComponent(name)); }
  catch (e) { setStatus('网络错误: ' + e.message, 'err'); return; }
  const data = await res.json();
  if (!res.ok) {
    const extra = Array.isArray(data.detail) ? ' — ' + data.detail.join('; ') : '';
    setStatus('[' + data.kind + '] ' + data.message + extra, 'err');
    return;
  }
  try {
    await modeler.importXML(data.xml);
    modeler.get('canvas').zoom('fit-viewport', 'auto');
  } catch (e) {
    setStatus('bpmn-js import 失败: ' + e.message, 'err');
    return;
  }
  current = name;
  $('saveBtn').disabled = false;
  setStatus('已布局 ' + name + '（' + (data.trace.msTotal|0) + 'ms）— 可拖拽美化', 'ok');
  renderEval(data.evaluation);
}

// 拖拽/改动后防抖重评（让违例数随手调实时增减）。
modeler.on('commandStack.changed', () => {
  if (!current) return;
  clearTimeout(evalTimer);
  evalTimer = setTimeout(reevaluate, 400);
});

async function reevaluate() {
  if (!current) return;
  const { xml } = await modeler.saveXML({ format: true });
  const evaluation = await (await fetch('/api/evaluate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fixture: current, xml }),
  })).json();
  renderEval(evaluation);
}

async function save() {
  if (!current) return;
  const { xml } = await modeler.saveXML({ format: true });
  setStatus('保存中…', '');
  const out = await (await fetch('/api/save', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fixture: current, xml }),
  })).json();
  if (out.savedTo) {
    setStatus('已保存 → ' + out.savedTo, 'ok');
    renderEval(out.evaluation);
  } else {
    setStatus('保存失败: ' + (out.message || '未知'), 'err');
  }
}

function renderEval(ev) {
  const hardTotals = (ev.hard && ev.hard.totals) || {};
  const violations = (ev.hard && ev.hard.violations) || [];
  const metrics = (ev.soft && ev.soft.metrics) || [];
  const s = ev.summary || {};

  $('summary').innerHTML =
    '硬违例 <b class="' + (s.hardViolationCount ? 'bad' : 'ok') + '">' + (s.hardViolationCount||0) + '</b>　·　' +
    '软指标失分 <b class="' + (s.softDirtyFixtures ? 'bad' : 'ok') + '">' + (metrics.filter(m=>!m.pass).length) + '</b>';

  $('hardGrid').innerHTML = HARD_RULES.map(r => {
    const n = hardTotals[r] || 0;
    return '<div class="cell ' + (n ? 'bad' : 'ok') + '"><div class="id">' + r +
           '</div><div class="v">' + (n || '·') + '</div></div>';
  }).join('');

  $('softGrid').innerHTML = metrics.map(m => {
    const cls = m.display === 'n/a' ? 'na' : (m.pass ? 'ok' : 'bad');
    return '<div class="cell ' + cls + '" title="' + (m.detail || '') + '"><div class="id">' + m.rule +
           '</div><div class="v">' + m.display + '</div></div>';
  }).join('');

  $('violations').innerHTML = violations.length
    ? violations.map(v => '<div class="vrow"><span class="r">' + v.ruleId + '</span><span class="m">' +
        v.evidence.message + '</span></div>').join('')
    : '<span class="m" style="color:var(--muted)">无硬违例 ✓</span>';
}

$('saveBtn').onclick = save;
$('fixtureSel').onchange = loadLayout;  // 选中即自动布局
loadFixtureList();
</script>
</body>
</html>`;
