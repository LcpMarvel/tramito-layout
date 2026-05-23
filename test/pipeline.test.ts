import { describe, expect, it, beforeAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { layoutBpmnXml } from '../src/index.ts';
import { runPipeline } from '../src/pipeline.ts';
import { warmup } from '../src/layout/elk-singleton.ts';
import type { NodeBox } from '../src/stages/types.ts';

const FIX = (n: string) =>
  JSON.parse(readFileSync(resolve(import.meta.dir, '../fixtures', `${n}.json`), 'utf-8'));

describe('layoutAndSerialize — end-to-end', () => {
  beforeAll(async () => { await warmup(); });

  it('produces well-formed BPMN XML for a simple process', async () => {
    const { xml, trace } = await layoutBpmnXml(FIX('01-simple-process'), '01');
    expect(xml).toContain('<bpmn:definitions');
    expect(xml).toContain('<bpmndi:BPMNDiagram');
    expect(xml).toContain('<dc:Bounds');
    expect(trace.routeCount).toBeGreaterThan(0);
    expect(trace.constraintSummary.total).toBeGreaterThan(0);
    expect(trace.constraintSummary.byKind['port-side']).toBeGreaterThan(0);
    expect(trace.decisionCount).toBeGreaterThan(0);
    expect(trace.decisionsTruncated).toBe(false);
    expect(trace.decisions.some(d => d.kind === 'edge-route')).toBe(true);
  });

  it('handles a multi-pool collaboration (29)', async () => {
    const { xml, trace } = await layoutBpmnXml(FIX('29-collaboration-message-flows'), '29');
    expect(xml).toContain('messageFlow');
    expect(xml).toContain('BPMNEdge');
    // 至少有 cross-pool 的边
    const crossPool = (trace.byEdgeType['cross-pool-down'] ?? 0)
      + (trace.byEdgeType['cross-pool-up'] ?? 0);
    expect(crossPool).toBeGreaterThan(0);
  });

  it('handles lane fixture (26)', async () => {
    const { xml, trace } = await layoutBpmnXml(FIX('26-collaboration-lanes'), '26');
    expect(xml).toContain('<bpmn:lane');
    // 跨 lane 边存在
    const crossLane = (trace.byEdgeType['cross-lane-down'] ?? 0)
      + (trace.byEdgeType['cross-lane-up'] ?? 0);
    expect(crossLane).toBeGreaterThan(0);
    expect(trace.constraintSummary.byKind.contains).toBeGreaterThan(0);
    expect(trace.decisions.some(d => d.kind === 'elk-lane-partition')).toBe(true);
  });

  it('handles boundary events (13)', async () => {
    const { xml, trace } = await layoutBpmnXml(FIX('13-boundary-events-all'), '13');
    expect(xml).toContain('boundaryEvent');
    expect(trace.constraintSummary.byKind['rides-boundary']).toBeGreaterThan(0);
    expect(trace.decisions.some(d => d.kind === 'boundary-placement')).toBe(true);
  });

  it('handles a rigid fixture (37)', async () => {
    const { xml, trace } = await layoutBpmnXml(FIX('37-crm-voice-process'), '37');
    expect(xml).toContain('<bpmn:definitions');
    // 应该有 back-edge
    const back = (trace.byEdgeType['back-edge-up-left'] ?? 0)
      + (trace.byEdgeType['back-edge-down-left'] ?? 0);
    expect(back).toBeGreaterThan(0);
  });

  it('uses previousBoxes as incremental preserve hints without changing default behavior', async () => {
    const fixture = FIX('01-simple-process');
    const baseline = await runPipeline(fixture, '01-baseline');
    const previousBoxes = collectFlowNodeBoxes(baseline.graph);
    const next = await runPipeline(fixture, '01-incremental', { previousBoxes });
    expect(next.trace.incremental.previousBoxCount).toBeGreaterThan(0);
    expect(next.trace.incremental.appliedCount).toBeGreaterThan(0);
    expect(next.trace.constraintSummary.byKind['preserve-position']).toBeGreaterThan(0);
    expect(next.trace.decisions.some(d => d.kind === 'incremental-preserve')).toBe(true);
  });
});

function collectFlowNodeBoxes(root: any): Record<string, NodeBox> {
  const boxes: Record<string, NodeBox> = {};
  function walk(node: any, baseX = 0, baseY = 0): void {
    if (!node || typeof node !== 'object') return;
    const type = node.bpmn?.type;
    const x = typeof node.x === 'number' ? node.x : 0;
    const y = typeof node.y === 'number' ? node.y : 0;
    const absX = baseX + x;
    const absY = baseY + y;
    if (type && !['definitions', 'collaboration', 'participant', 'process', 'lane'].includes(type)) {
      if (typeof node.x === 'number'
        && typeof node.y === 'number'
        && typeof node.width === 'number'
        && typeof node.height === 'number') {
        boxes[node.id] = { x: absX, y: absY, w: node.width, h: node.height };
      }
    }
    const childBaseX = type === 'definitions' ? baseX : absX;
    const childBaseY = type === 'definitions' ? baseY : absY;
    for (const child of node.children ?? []) walk(child, childBaseX, childBaseY);
    for (const boundary of node.boundaryEvents ?? []) walk(boundary, baseX, baseY);
    for (const artifact of node.artifacts ?? []) walk(artifact, childBaseX, childBaseY);
  }
  walk(root);
  return boxes;
}
