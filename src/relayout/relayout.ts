import { runPipeline } from '../pipeline.ts';
import { ModelBuilder } from '../serializer/index.ts';
import type { LayoutOptions, PipelineTrace } from '../pipeline.ts';
import type { LayoutedGraph } from '../serializer/index.ts';
import { xmlToLayoutInput } from './xml-to-layout-input.ts';
import { patchBpmndi } from './bpmndi-patcher.ts';

export interface RelayoutBpmnXmlOptions extends Omit<LayoutOptions, 'previousBoxes'> {
  mode?: 'full' | 'preserve' | 'local';
  preserveElementIds?: boolean;
  preserveSemanticIds?: boolean;
  preserveViewport?: boolean;
  targetElementIds?: string[];
}

export interface RelayoutBpmnXmlResult {
  xml: string;
  trace: PipelineTrace;
}

const modelBuilder = new ModelBuilder();

export async function relayoutBpmnXml(
  xml: string,
  options: RelayoutBpmnXmlOptions = {},
): Promise<RelayoutBpmnXmlResult> {
  const mode = options.mode ?? 'full';
  if (mode !== 'full') {
    throw new Error(`[relayout] mode "${mode}" is not supported yet; use mode "full"`);
  }

  const { rawJson, semanticIds } = await xmlToLayoutInput(xml);
  const { graph, trace } = await runPipeline(rawJson, 'relayout-xml', {
    debug: options.debug,
  });
  const model = modelBuilder.build(graph as LayoutedGraph);
  return {
    xml: patchBpmndi(xml, model.diagram, semanticIds),
    trace,
  };
}
