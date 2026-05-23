import { layoutAndSerialize as serializeLayout } from './service.ts';
import { runPipeline as runLayoutPipeline } from './pipeline.ts';
import { warmup, isReady } from './layout/elk-singleton.ts';

export interface NodeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PreviousBoxesInput = Map<string, NodeBox> | Record<string, NodeBox>;

export interface LayoutOptions {
  previousBoxes?: PreviousBoxesInput;
  debug?: boolean | { stageSnapshots?: boolean };
}

export interface LayoutConstraint {
  kind: string;
  [key: string]: unknown;
}

export interface LayoutDecision {
  stage: string;
  kind: string;
  subject: {
    kind: string;
    id: string;
  };
  reason: string;
  input?: Record<string, string | number | boolean | null>;
  output?: Record<string, string | number | boolean | null>;
}

export interface LayoutTrace {
  routeCount: number;
  byEdgeType: Record<string, number>;
  constraints: LayoutConstraint[];
  constraintSummary: {
    total: number;
    byKind: Record<string, number | undefined>;
  };
  decisions: LayoutDecision[];
  decisionCount: number;
  decisionsTruncated: boolean;
  incremental: {
    previousBoxCount: number;
    appliedCount: number;
    skippedCount: number;
  };
  elkShape: unknown[];
  stageSnapshots?: unknown[];
  msPlacement: number;
  msConstrain: number;
  msCompose: number;
  msHandlers: number;
  msRoute: number;
  msMerge: number;
  msTotal: number;
}

export interface SerializedLayoutTrace extends LayoutTrace {
  msSerialize: number;
}

export interface LayoutXmlResult {
  xml: string;
  trace: SerializedLayoutTrace;
}

export interface LayoutGraphResult {
  graph: unknown;
  trace: LayoutTrace;
}

export async function layoutBpmnXml(
  rawJson: unknown,
  fixtureLabel = 'request',
  options: LayoutOptions = {},
): Promise<LayoutXmlResult> {
  return serializeLayout(rawJson, fixtureLabel, options);
}

export const layoutAndSerialize = layoutBpmnXml;

export async function layoutBpmnGraph(
  rawJson: unknown,
  fixtureLabel = 'request',
  options: LayoutOptions = {},
): Promise<LayoutGraphResult> {
  return runLayoutPipeline(rawJson, fixtureLabel, options);
}

export const runPipeline = layoutBpmnGraph;

export async function warmupLayoutEngine(): Promise<void> {
  await warmup();
}

export function isLayoutEngineReady(): boolean {
  return isReady();
}
