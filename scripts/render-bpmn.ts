// Real BPMN rendering: out-xml/*.bpmn → out-bpmn-png/*.png via bpmn-js + puppeteer.
//
// Uses the locally-installed bpmn-js dist + system Chrome via puppeteer-core (we skip the
// Chromium auto-download). Each fixture is rendered in a hidden page, then page.screenshot()
// captures the SVG canvas.

import { readdirSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const XML_DIR = resolve(import.meta.dir, '../out-xml');
const PNG_DIR = resolve(import.meta.dir, '../out-bpmn-png');
const BPMN_VIEWER = resolve(import.meta.dir, '../node_modules/bpmn-js/dist/bpmn-viewer.production.min.js');

const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!existsSync(XML_DIR)) {
  throw new Error(`run 'bun run scripts/run-xml.ts' first — no ${XML_DIR}`);
}
if (!existsSync(BPMN_VIEWER)) {
  throw new Error(`bpmn-js viewer not found at ${BPMN_VIEWER}`);
}
if (!existsSync(CHROME)) {
  throw new Error(`Chrome not found at ${CHROME} (set CHROME_PATH to override)`);
}

const viewerJs = readFileSync(BPMN_VIEWER, 'utf-8');

function htmlFor(xml: string): string {
  // Inline the viewer + the XML into one self-contained page. We then call fitViewport and
  // expose a hook so the puppeteer side can wait for `window.__rendered` before screenshotting.
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: #fff; }
  #c { width: 100vw; height: 100vh; }
  .djs-overlays { display: none !important; }
</style></head>
<body>
<div id="c"></div>
<script>${viewerJs}</script>
<script>
  window.__rendered = false;
  const viewer = new BpmnJS({ container: '#c' });
  // bpmn-js bug: textRenderer.getExternalLabelBounds tight-fits the label box to the
  // exact measured text width, then renderExternalLabel re-runs the layout with the same
  // box. The wrap test in diagram-js is "textBBox.width < maxWidth" (strict <), so when
  // they're equal — which always happens for CJK labels — it falls through to
  // shortenLine and wraps one char at a time. Pad the returned bounds so the second
  // pass sees a slightly larger box than the text needs.
  (function patchTextRenderer() {
    const tr = viewer.get('textRenderer');
    const original = tr.getExternalLabelBounds.bind(tr);
    tr.getExternalLabelBounds = function(bounds, text) {
      const r = original(bounds, text);
      return { x: r.x - 2, y: r.y, width: r.width + 4, height: r.height + 2 };
    };
  })();
  const xml = ${JSON.stringify(xml)};
  viewer.importXML(xml).then(({ warnings }) => {
    if (warnings && warnings.length) console.warn('bpmn-js warnings:', warnings);
    viewer.get('canvas').zoom('fit-viewport', 'auto');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      window.__rendered = true;
    }));
  }).catch(err => {
    document.body.innerHTML = '<pre style="color:red;padding:1em;">' + err.message + '</pre>';
    window.__rendered = 'error';
  });
</script>
</body></html>`;
}

async function main() {
  mkdirSync(PNG_DIR, { recursive: true });

  const targets = process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : readdirSync(XML_DIR).filter(f => f.endsWith('.bpmn')).map(f => f.replace(/\.bpmn$/, '')).sort();

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
  });

  let ok = 0;
  for (const base of targets) {
    try {
      const xml = readFileSync(resolve(XML_DIR, `${base}.bpmn`), 'utf-8');
      const page = await browser.newPage();
      await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
      await page.setContent(htmlFor(xml), { waitUntil: 'load' });
      await page.waitForFunction('window.__rendered !== false', { timeout: 10_000 });
      const status = await page.evaluate(() => (globalThis as { __rendered?: string | false }).__rendered);
      if (status === 'error') throw new Error('bpmn-js failed to import XML');
      // Trim to the diagram canvas so output PNG isn't padded.
      await page.screenshot({ path: resolve(PNG_DIR, `${base}.png`) as `${string}.png`, fullPage: false });
      await page.close();
      console.log(`✓ ${base}`);
      ok++;
    } catch (e: any) {
      console.error(`✗ ${base}: ${e.message}`);
    }
  }

  await browser.close();
  console.log(`\n${ok}/${targets.length} rendered → ${PNG_DIR}`);
  if (ok !== targets.length) process.exit(1);
}

await main();
