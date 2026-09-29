# tramito-layout

[English](README.md) | [简体中文](README.zh-CN.md)

**tramito-layout is a compiler**: the source language is coordinate-free ELK-BPMN JSON (pure process structure), the target is BPMN 2.0 XML with BPMN DI. `layoutBpmnXml()` is exactly `compile(json) → xml`.

Like any compiler, it splits into two layers:

- **Frontend (diagnostics)** — `validateGraph()`: decides whether a source is compilable, returning **clear, actionable** structural issues (`ValidationIssue[]`). Sources are frequently LLM-generated and self-correct by feeding errors back to the model — diagnostic quality directly determines how fast that loop converges.
- **Backend (code generation)** — the layout + serialization pipeline: translates a valid source into XML carrying a visual layout.

**Invariant: a source that passes `validateGraph` always compiles to XML.** If the backend fails on validated input, that is a bug in the compiler itself (`InternalCompilerError`), never the input's fault.

It fits process modeling, approval flows, orchestration platforms and similar settings: the business side only supplies the process structure; this library computes the drawing.

## Usage

```ts
import { layoutBpmnXml, warmupLayoutEngine } from 'tramito-layout';

await warmupLayoutEngine();

const { xml, trace } = await layoutBpmnXml(elkBpmnJson, 'request', {
  debug: { stageSnapshots: true },
});
```

Public entry points:

| API | Purpose |
| --- | --- |
| `validateGraph(rawJson)` | **Frontend diagnostics**: pure function, runs no layout, returns `ValidationIssue[]` (empty = compilable). Synchronous, side-effect free, no ELK dependency |
| `formatIssuesForFeedback(issues)` | Formats diagnostics into feedback that can be fed straight back to an LLM (returns `''` when there are no issues) |
| `layoutBpmnXml(rawJson, fixtureLabel?, options?)` | **Compile**: returns `{ xml, trace }`. Validates first; `error`-level issues throw an `AggregateError` |
| `relayoutBpmnXml(xml, options?)` / `layoutBpmnXmlFromXml(xml, options?)` | Recomputes all BPMN DI from existing BPMN XML, preserving the semantic XML |
| `layoutBpmnGraph(rawJson, fixtureLabel?, options?)` | Returns `{ graph, trace }` for debugging intermediate layout results |
| `warmupLayoutEngine()` | Warms up the elkjs singleton |
| `isLayoutEngineReady()` | Queries whether elkjs is warmed up |
| `InternalCompilerError` | The ICE type: source passed validation but the backend failed = compiler bug, `internal: true` + `stage` |

`options.previousBoxes` enables incremental stability; `options.debug.stageSnapshots` produces the AI debug bundle and is off by default.

### Validate + compile + error layering

Sources are often LLM-generated. The recommended integration validates first and branches on error type:

```ts
import {
  validateGraph, formatIssuesForFeedback, layoutBpmnXml, InternalCompilerError,
} from 'tramito-layout';

const issues = validateGraph(graph);
if (issues.some((i) => i.severity === 'error')) {
  const feedback = formatIssuesForFeedback(issues); // feed back together with the original graph
  // ...ask the model to regenerate...
} else {
  try {
    const { xml } = await layoutBpmnXml(graph);
  } catch (e) {
    if (e instanceof InternalCompilerError) {
      // Compiler bug (e.stage names the stage): report / degrade — do NOT feed back to the model
    } else {
      throw e; // theoretically unreachable (validated up front)
    }
  }
}
```

- **Validation errors** (`AggregateError` / `error` from `validateGraph`) = problems in the source that the user/model can fix → feed back for self-correction.
- **`InternalCompilerError`** = the source was valid but the backend crashed; a compiler bug → report it, don't make the model take the blame.
- Criterion for new validation rules: cover exactly "what the backend cannot handle AND the user can fix" — not the full BPMN specification.

### Relayouting existing BPMN XML

When what you have is BPMN 2.0 XML (with or without BPMN DI), call `relayoutBpmnXml` to recompute the layout. `layoutBpmnXmlFromXml` is an alias of the same function, kept for naming preference.

```ts
import { relayoutBpmnXml, warmupLayoutEngine } from 'tramito-layout';

await warmupLayoutEngine();

const { xml, trace } = await relayoutBpmnXml(originalBpmnXml);
```

The returned XML fully preserves the original semantic elements (process / lane / task / custom namespaces / extensionElements / documentation, …); only `<bpmndi:BPMNDiagram>` is regenerated.

`RelayoutBpmnXmlOptions` fields:

| Field | Description |
| --- | --- |
| `mode` | Currently only `'full'` (default) — full BPMNDI recomputation. `'preserve'` / `'local'` are not implemented yet and throw if passed. |
| `debug` | Same as `options.debug` of `layoutBpmnXml`, for collecting stage snapshots. |

Use cases: your editor holds BPMN XML rather than ELK-BPMN JSON; or the upstream structure changed and you want the latest layout algorithm while keeping the custom extensions from the original XML.

## Design

Core idea: **ELK only handles generic node placement; BPMN-specific visual rules live in hand-rolled stages.**

Why this split:

1. Layer assignment, in-layer ordering and basic alignment go to elkjs — more robust than reinventing them.
2. BPMN rules (lanes, pools, boundary events, message flows, associations, labels, artifacts) are not generic graph-optimization problems; they must be modeled explicitly.
3. Edge routing is computed from final node positions in absolute coordinates only — pool-local and absolute frames are never mixed.
4. The serializer only translates `LayoutedGraph` into BPMN DI XML; it makes no layout decisions.

Actual pipeline:

```text
Loader
  → SubprocessLayout
  → ElkPlacement
  → LaneConstrainer
  → Compactor
  → PoolComposer
  → SubprocessTranslator
  → mini ElkPlacement for boundary handler subgraphs
  → DecorationPlacer
  → ArtifactPlacer
  → PoolOverflowRebalancer
  → ConstraintModel / IncrementalStabilizer
  → EdgeRouter
  → AssociationRouter
  → LabelPlacer
  → Merger
  → Serializer
```

`pipeline.ts` is pure assembly; stage entry points and types are re-exported from `src/stages/index.ts`. When adding a stage, register its contract in `src/stages/index.ts` first, then wire it into the pipeline.

## Key directories

```text
src/
  index.ts                 # npm package public entry
  service.ts               # runPipeline → bpmn-moddle XML
  pipeline.ts              # stage orchestration
  loader/                  # raw JSON → BpmnModel
  layout/                  # elk singleton, node sizes, lane resolver
  stages/                  # layout stages
    edge-router/           # classifier / port / anchor / path / channel / detour
    bpmn-rules.ts          # BPMN semantic rule table
    compactor.ts           # horizontal compaction & long-chain folding
    constraint-model.ts    # constraint/decision trace
    incremental-stabilizer.ts
    label-placer.ts
    merger.ts
  serializer/              # LayoutedGraph → BPMN 2.0 XML
  evaluation/              # rule implementations behind check:layout
scripts/
  run-xml.ts               # fixture → out-xml/*.bpmn
  render-bpmn.ts           # BPMN XML → out-bpmn-png/*.png
  check-layout.ts          # E/N/B/L hard criteria + F soft metrics
  export-ai-debug-bundle.ts
fixtures/                  # 34 coverage cases
docs/layout-lessons.md     # layout history & long-term engineering principles
docs/layout-fix-workflow.md # user JSON issue → fixture → reproduce → fix loop
```

`out-xml/*.bpmn` and `out-bpmn-png/*.png` (compiler output and its rendering) are committed side-by-side so layout changes are reviewable in git — run `bun run fixtures:sync` after any layout change to regenerate both. `out-ai-debug/` keeps only a `.keep` placeholder; its contents are local diagnostics and are never committed.

## Development

```bash
bun test
bunx tsc --noEmit
bun run build

bun run fixtures:xml
bun run fixtures:png
bun run check:layout
```

Layout-related changes must run at least:

```bash
bun test
bunx tsc --noEmit
bun run fixtures:xml
bun run fixtures:png
bun run check:layout
```

If machine metrics alone are not enough, review representative PNGs against the E/N/B/L hard criteria documented in `CLAUDE.md`.

## Publishing to npm

Public publish (`prepack` builds automatically):

```bash
npm publish --registry=https://registry.npmjs.org
```

Dry-run first to inspect the tarball:

```bash
npm publish --dry-run --registry=https://registry.npmjs.org
```

License: Apache-2.0.

## AI Debug Bundle

The default package entry invokes no AI and collects no stage snapshots. For diagnostics, run explicitly:

```bash
bun run debug:ai 13-boundary-events-all
bun run ai:optimize --fixture 13-boundary-events-all --dry-run
```

Artifacts land in `out-ai-debug/` for local analysis only. `docs/prompts/layout-critic.md` is the prompt used when an AI reads the bundle.
