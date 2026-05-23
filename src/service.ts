// 顶层服务：JSON → 布局 → BPMN 2.0 XML。

import { runPipeline } from './pipeline.ts';
import { ModelBuilder, BpmnXmlGenerator, type LayoutedGraph } from './serializer/index.ts';
import type { LayoutOptions, PipelineTrace } from './pipeline.ts';
import { parseBpmnLayout } from './evaluation/layout-evaluator.ts';
import { snapshotFromParsedFixture } from './debug/ai-debug.ts';

const modelBuilder = new ModelBuilder();
const xmlGenerator = new BpmnXmlGenerator();

export interface LayoutResult {
  xml: string;
  trace: PipelineTrace & { msSerialize: number };
}

export async function layoutAndSerialize(
  rawJson: any,
  fixtureLabel = 'request',
  options: LayoutOptions = {},
): Promise<LayoutResult> {
  const { graph, trace } = await runPipeline(rawJson, fixtureLabel, options);
  const tS = performance.now();
  const model = modelBuilder.build(graph as LayoutedGraph);
  const xml = await xmlGenerator.generate(model);
  const msSerialize = performance.now() - tS;
  if (trace.stageSnapshots) {
    const parsed = parseBpmnLayout(fixtureLabel, xml);
    trace.stageSnapshots.push(snapshotFromParsedFixture(
      parsed,
      'serializer',
      trace.stageSnapshots.length,
      ['Serializer snapshot is parsed back from BPMN DI XML and is the ground truth for check:layout.'],
    ));
  }
  return { xml, trace: { ...trace, msSerialize } };
}
