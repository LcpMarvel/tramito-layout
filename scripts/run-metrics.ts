// 跑全 34 fixture，输出 aesthetic metrics 报告。
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runPipeline } from '../src/pipeline.ts';
import { computeMetrics, type FixtureMetrics } from '../src/metrics/aesthetic-metrics.ts';

const FIX_DIR = resolve(import.meta.dir, '../fixtures');
const files = readdirSync(FIX_DIR).filter(f => f.endsWith('.json')).sort();

const results: FixtureMetrics[] = [];

for (const file of files) {
  const base = file.replace(/\.json$/, '');
  const raw = JSON.parse(readFileSync(resolve(FIX_DIR, file), 'utf-8'));
  try {
    const { graph } = await runPipeline(raw, base);
    // 从 graph 提取 nodes + routes：runPipeline 没暴露 routes 本身，简单起见这里重新跑取
    // 但 trace 中已有 routeCount/byEdgeType；要 routes 必须改 pipeline 返回值。
    // 简化：直接从 graph 重建 boxes，从 trace 仅取 count，少几个 metric。
    // 这里改成 runPipeline 直接暴露 nodes + routes：暂时跑 metrics 用 trace + bounds。
    const nodes = new Map<string, { x: number; y: number; w: number; h: number }>();
    walk(graph as any, 0, 0, nodes);
    const routes = new Map<string, any>();
    collectEdges(graph as any, routes);
    const m = computeMetrics({
      fixture: base,
      nodes,
      routes,
      totalBounds: { width: graph.width ?? 0, height: graph.height ?? 0 },
    });
    results.push(m);
  } catch (e: any) {
    console.error(`✗ ${base}: ${e.message}`);
  }
}

// 输出表格
console.log('\n' + 'fixture'.padEnd(40), 'nodes', 'edges', 'overlap', 'aspect', 'avgBend', 'maxBend');
for (const m of results) {
  console.log(
    m.fixture.padEnd(40),
    String(m.nodeCount).padStart(5),
    String(m.edgeCount).padStart(5),
    String(m.overlapCount).padStart(7),
    m.aspectRatio.toFixed(2).padStart(6),
    m.avgEdgeBendCount.toFixed(2).padStart(7),
    String(m.maxEdgeBendCount).padStart(7),
  );
}

// 汇总
const totalOverlap = results.reduce((s, m) => s + m.overlapCount, 0);
const avgAspect = results.reduce((s, m) => s + m.aspectRatio, 0) / results.length;
console.log(`\n=== summary ===`);
console.log(`fixtures: ${results.length}`);
console.log(`total node overlaps: ${totalOverlap}`);
console.log(`avg aspect ratio: ${avgAspect.toFixed(2)}`);

function collectEdges(node: any, out: Map<string, any>) {
  if (!node) return;
  for (const e of node.edges ?? []) {
    const s = e.sections?.[0];
    if (!s) continue;
    const wp = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
    out.set(e.id, {
      edgeId: e.id,
      edgeType: 'forward-straight', // 占位；metric 只用 waypoints
      waypoints: wp,
    });
  }
  for (const c of node.children ?? []) collectEdges(c, out);
}

function walk(node: any, baseX: number, baseY: number, out: Map<string, any>) {
  if (!node) return;
  // 节点本身
  if (typeof node.id === 'string' && typeof node.width === 'number') {
    const absX = baseX + (node.x ?? 0);
    const absY = baseY + (node.y ?? 0);
    if (node.bpmn?.type && !['collaboration', 'process', 'participant', 'lane'].includes(node.bpmn.type)) {
      out.set(node.id, { x: absX, y: absY, w: node.width, h: node.height });
    }
    // 容器：递归 children
    for (const c of node.children ?? []) walk(c, absX, absY, out);
  } else {
    for (const c of node.children ?? []) walk(c, baseX, baseY, out);
  }
}
