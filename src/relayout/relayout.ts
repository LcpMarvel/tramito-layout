import { runPipeline } from '../pipeline.ts';
import { ModelBuilder } from '../serializer/index.ts';
import type { LayoutOptions, PipelineTrace } from '../pipeline.ts';
import type { LayoutedGraph } from '../serializer/index.ts';
import { xmlToLayoutInput } from './xml-to-layout-input.ts';
import { patchBpmndi } from './bpmndi-patcher.ts';
import { withCompileErrors } from '../errors.ts';

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

  // 前端（源语言 = BPMN XML）：解析 + 转成 layout graph。这里抛的错是“源 XML 的问题”，
  // 用户可改，原样透传（不归 ICE）。XML→graph 的诊断质量仍是裸 Error，后续可比照 validateGraph 结构化。
  const { rawJson, semanticIds } = await xmlToLayoutInput(xml);

  // 后端：与 JSON 路径同一条编译管线，套同一道 ICE 边界。
  // - runPipeline 内的 loadFixture/validateGraph 若判定转换出的 graph 非法 → AggregateError 透传（可改）。
  // - 布局/序列化阶段的非预期 throw → InternalCompilerError（编译器 bug，勿回喂模型）。
  return withCompileErrors(async () => {
    const { graph, trace } = await runPipeline(rawJson, 'relayout-xml', {
      debug: options.debug,
      // relayout 的源是已存在的合法 BPMN XML，跳过生成专属规则（如 NON_ASCII_ID：XML 合法地带中文 id）。
      validationProfile: 'relayout',
    });
    const model = modelBuilder.build(graph as LayoutedGraph);
    return {
      xml: patchBpmndi(xml, model.diagram, semanticIds),
      trace,
    };
  });
}
