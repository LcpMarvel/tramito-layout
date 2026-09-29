// GitHub Pages demo entry —— 页面即编译器前门演示：
//   validateGraph 诊断 → layoutBpmnXml 编译 → bpmn-js 渲染。
// 错误分层照 README 的口径：校验错回显在 diagnostics 面板（用户可改）；
// InternalCompilerError 单独红卡提示去仓库上报（编译器 bug，不是输入的错）。

import pkg from '../package.json';
import { validateGraph, layoutBpmnXml, InternalCompilerError } from '../src/index.ts';
import { provideBrowserElkWorkerSource } from '../src/layout/elk-singleton.ts';
import { ELK_WORKER_SOURCE } from './generated/elk-worker-source.ts';
import { FIXTURES } from './generated/fixtures.ts';
// bpmn-js 不带 TS 类型；demo 不在 tsconfig include 里（tsc 只扫 src/scripts/test）。
import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer.js';

provideBrowserElkWorkerSource(ELK_WORKER_SOURCE);

type Issue = {
  severity?: string;
  code?: string;
  id?: string;
  message?: string;
  hint?: string;
};

type Trace = {
  routeCount?: number;
  msPlacement?: number;
  msConstrain?: number;
  msCompose?: number;
  msHandlers?: number;
  msRoute?: number;
  msSerialize?: number;
  msTotal?: number;
};

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const fixtureSelect = $<HTMLSelectElement>('#fixture');
const sourceEl = $<HTMLTextAreaElement>('#source');
const compileBtn = $<HTMLButtonElement>('#compile');
const downloadBtn = $<HTMLButtonElement>('#download');
const statusEl = $<HTMLElement>('#statusline');
const diagnosticsEl = $<HTMLElement>('#diagnostics');
const canvasEl = $<HTMLElement>('#canvas');
const canvasCard = $<HTMLElement>('#diagram-card');
const canvasEmpty = $<HTMLElement>('#canvas-empty');
const xmlView = $<HTMLElement>('#xml');
const tabButtons = [...document.querySelectorAll<HTMLButtonElement>('.tab')];

const viewer = new NavigatedViewer({ container: canvasEl });

const DEFAULT_FIXTURE = '26-collaboration-lanes';
let currentFixtureId = '';
let currentXml = '';
let compileSeq = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function setStatus(text: string, kind: 'idle' | 'busy' | 'ok' | 'error' = 'idle'): void {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
}

function issueChip(sev: string): string {
  const cls = sev === 'error' ? 'err' : sev === 'warning' ? 'warn' : 'info';
  return `<span class="chip ${cls}">${esc(sev ?? '?')}</span>`;
}

function renderIssues(issues: Issue[], title: string): void {
  if (issues.length === 0) {
    diagnosticsEl.innerHTML =
      `<div class="diag-ok">${esc(title)} — 0 issues, compilable ✓</div>`;
    return;
  }
  const rows = issues
    .map(
      (i) => `<div class="issue">
        ${issueChip(i.severity ?? 'info')}
        <code class="issue-code">${esc(i.code ?? '')}${i.id ? ` <span class="issue-id">${esc(i.id)}</span>` : ''}</code>
        <span class="issue-msg">${esc(i.message ?? '')}</span>
        ${i.hint ? `<span class="issue-hint">↳ ${esc(i.hint)}</span>` : ''}
      </div>`,
    )
    .join('');
  diagnosticsEl.innerHTML = `<div class="diag-head">${esc(title)} · ${issues.length} issue(s)</div>${rows}`;
}

function renderIce(err: Error & { stage?: string }): void {
  const title = encodeURIComponent(`[ICE] stage=${err.stage ?? '?'}: ${err.message.slice(0, 120)}`);
  const body = encodeURIComponent(`Fixture: ${currentFixtureId}\n\n${err.stack ?? err.message}`);
  diagnosticsEl.innerHTML =
    `<div class="ice">
      <div class="ice-title">InternalCompilerError — compiler bug, not your fault</div>
      <div class="ice-meta">stage=<code>${esc(err.stage ?? '?')}</code></div>
      <div class="ice-msg">${esc(err.message)}</div>
      <a class="btn" target="_blank" rel="noopener"
         href="https://github.com/LcpMarvel/tramito-layout/issues/new?title=${title}&body=${body}">Report on GitHub ↗</a>
    </div>`;
}

function renderTimings(trace: Trace, wallMs: number): void {
  const stages: Array<[string, number | undefined]> = [
    ['placement', trace.msPlacement],
    ['constrain', trace.msConstrain],
    ['compose', trace.msCompose],
    ['handlers', trace.msHandlers],
    ['route', trace.msRoute],
    ['serialize', trace.msSerialize],
    ['total', trace.msTotal],
  ];
  const cells = stages
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => `<div class="t-cell"><span>${k}</span><b>${Math.round(v!)} ms</b></div>`)
    .join('');
  diagnosticsEl.innerHTML =
    `<div class="diag-ok">validateGraph: 0 issues — compiled ✓ (wall ${Math.round(wallMs)} ms)</div>
     <div class="timings">${cells}<div class="t-cell"><span>routes</span><b>${trace.routeCount ?? 0}</b></div></div>`;
}

async function showDiagram(xml: string): Promise<void> {
  await viewer.importXML(xml);
  viewer.get('canvas').zoom('fit-viewport', 'auto');
  canvasEmpty.hidden = true;
  downloadBtn.disabled = false;
}

function clearDiagram(): void {
  try {
    viewer.clear();
  } catch {
    /* 首次编译前 canvas 为空，clear 会抛——忽略 */
  }
  canvasEmpty.hidden = false;
  downloadBtn.disabled = true;
  currentXml = '';
}

async function compile(): Promise<void> {
  const seq = ++compileSeq;
  setStatus('compiling…', 'busy');
  let graph: unknown;
  try {
    graph = JSON.parse(sourceEl.value);
  } catch (e) {
    if (seq !== compileSeq) return;
    clearDiagram();
    diagnosticsEl.innerHTML =
      `<div class="issue">${issueChip('error')}<code class="issue-code">JSON.parse</code>
       <span class="issue-msg">${esc((e as Error).message)}</span></div>`;
    setStatus('invalid JSON', 'error');
    return;
  }

  const issues = (validateGraph(graph) ?? []) as Issue[];
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    if (seq !== compileSeq) return;
    clearDiagram();
    renderIssues(issues, 'validateGraph');
    setStatus(`${errors.length} error(s) — fix the source to compile`, 'error');
    return;
  }

  try {
    const t0 = performance.now();
    const { xml, trace } = await layoutBpmnXml(graph, currentFixtureId || 'demo');
    if (seq !== compileSeq) return;
    const wall = performance.now() - t0;
    currentXml = xml;
    xmlView.textContent = xml;
    await showDiagram(xml);
    renderTimings(trace as Trace, wall);
    setStatus(`compiled in ${Math.round(wall)} ms`, 'ok');
  } catch (e) {
    if (seq !== compileSeq) return;
    clearDiagram();
    if (e instanceof InternalCompilerError) {
      renderIce(e);
      setStatus('internal compiler error', 'error');
    } else if (e instanceof AggregateError) {
      renderIssues(
        (e.errors as Error[]).map((er) => ({ severity: 'error', message: er.message })),
        'validation',
      );
      setStatus('validation error', 'error');
    } else {
      diagnosticsEl.innerHTML =
        `<div class="issue">${issueChip('error')}<span class="issue-msg">${esc(String(e))}</span></div>`;
      setStatus('unexpected error', 'error');
    }
  }
}

function scheduleCompile(delay = 600): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void compile(), delay);
}

function loadFixture(id: string): void {
  const fixture = FIXTURES.find((f) => f.id === id) ?? FIXTURES[0]!;
  currentFixtureId = fixture.id;
  fixtureSelect.value = fixture.id;
  sourceEl.value = JSON.stringify(fixture.json, null, 2);
  scheduleCompile(0);
}

function setupTabs(): void {
  for (const btn of tabButtons) {
    btn.addEventListener('click', () => {
      for (const b of tabButtons) b.classList.toggle('active', b === btn);
      const showXml = btn.dataset.tab === 'xml';
      xmlView.hidden = !showXml;
      canvasCard.hidden = showXml;
    });
  }
}

function setupEditorKeys(): void {
  sourceEl.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: t, value } = sourceEl;
      sourceEl.value = `${value.slice(0, s)}  ${value.slice(t)}`;
      sourceEl.selectionStart = sourceEl.selectionEnd = s + 2;
      scheduleCompile();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void compile();
    }
  });
  sourceEl.addEventListener('input', () => scheduleCompile());
}

function setupDownload(): void {
  downloadBtn.addEventListener('click', () => {
    if (!currentXml) return;
    const url = URL.createObjectURL(new Blob([currentXml], { type: 'application/xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentFixtureId || 'diagram'}.bpmn`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

function boot(): void {
  for (const f of FIXTURES) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.id;
    fixtureSelect.appendChild(opt);
  }
  fixtureSelect.addEventListener('change', () => loadFixture(fixtureSelect.value));
  compileBtn.addEventListener('click', () => void compile());
  $<HTMLElement>('#pkg-meta').textContent = `tramito-layout@${pkg.version}`;
  setStatus(`${FIXTURES.length} fixtures · edit the JSON, diagram recompiles live`, 'idle');
  setupTabs();
  setupEditorKeys();
  setupDownload();
  loadFixture(DEFAULT_FIXTURE);
}

boot();
