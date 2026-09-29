# tramito-layout

[English](README.md) | [简体中文](README.zh-CN.md)

**tramito-layout 是一个编译器**：源语言是无坐标的 ELK-BPMN JSON（流程结构），目标是带 BPMN DI 的 BPMN 2.0 XML。`layoutBpmnXml()` 就是 `compile(json) → xml`。

像任何编译器一样，它分两层：

- **前端（诊断）** `validateGraph()`：判定源能不能编译，返回一组**清晰可改**的结构错（`ValidationIssue[]`）。源常由 LLM 生成、靠把错误回喂模型自纠——错误质量直接决定自纠效率。
- **后端（代码生成）** 布局 + 序列化管线：把合法的源翻译成带视觉布局的 XML。

**不变式：通过 `validateGraph` 的源一定能编译出 XML。** 后端若在已过校验的输入上失败，那是编译器自身的 bug（`InternalCompilerError`），不是输入的错。

它适合接入流程建模、审批流、编排平台等场景：业务侧只需要提供流程结构，布局计算由本库完成。

## 使用

```ts
import { layoutBpmnXml, warmupLayoutEngine } from 'tramito-layout';

await warmupLayoutEngine();

const { xml, trace } = await layoutBpmnXml(elkBpmnJson, 'request', {
  debug: { stageSnapshots: true },
});
```

公开入口：

| API | 作用 |
| --- | --- |
| `validateGraph(rawJson)` | **前端诊断**：纯函数、不跑布局，返回 `ValidationIssue[]`（空数组=可编译）。同步、无副作用、不依赖 ELK |
| `formatIssuesForFeedback(issues)` | 把诊断格式化成可直接回喂 LLM 的中文反馈（无 issue 返回 `''`） |
| `layoutBpmnXml(rawJson, fixtureLabel?, options?)` | **编译**：返回 `{ xml, trace }`。内部先校验，有 `error` 则抛 `AggregateError` |
| `relayoutBpmnXml(xml, options?)` / `layoutBpmnXmlFromXml(xml, options?)` | 从已有 BPMN XML 全量重算 BPMNDI，保留原语义 XML |
| `layoutBpmnGraph(rawJson, fixtureLabel?, options?)` | 返回 `{ graph, trace }`，用于调试布局中间结果 |
| `warmupLayoutEngine()` | 预热 elkjs 单例 |
| `isLayoutEngineReady()` | 查询 elkjs 是否已预热 |
| `InternalCompilerError` | ICE 类型：源已过校验但后端失败=编译器 bug，`internal: true` + `stage` |

`options.previousBoxes` 用于增量稳定；`options.debug.stageSnapshots` 用于生成 AI debug bundle，不会默认开启。

### 校验 + 编译 + 错误分层

源常由 LLM 生成，推荐"先校验、按错误类型分流"的接法：

```ts
import {
  validateGraph, formatIssuesForFeedback, layoutBpmnXml, InternalCompilerError,
} from 'tramito-layout';

const issues = validateGraph(graph);
if (issues.some((i) => i.severity === 'error')) {
  const feedback = formatIssuesForFeedback(issues); // 连同原 graph 回喂模型自纠
  // ...让模型重新生成...
} else {
  try {
    const { xml } = await layoutBpmnXml(graph);
  } catch (e) {
    if (e instanceof InternalCompilerError) {
      // 编译器 bug（e.stage 指明阶段）：上报 / 降级，【不要】回喂模型
    } else {
      throw e; // 理论上不会到这（已先校验）
    }
  }
}
```

- **校验错**（`AggregateError` / `validateGraph` 的 `error`）= 源的问题，用户/模型可改 → 回喂自纠。
- **`InternalCompilerError`** = 源已合法但后端崩，编译器自身的 bug → 上报，别让模型背锅。
- 新增校验规则的判据：只覆盖"后端处理不了、且用户能改"的情况，不追求 BPMN 规范全集。

### 从已有 BPMN XML 重排版

当你拿到的是带（或不带）BPMN DI 的 BPMN 2.0 XML，可以直接 `relayoutBpmnXml` 让布局重算。`layoutBpmnXmlFromXml` 是同一函数的别名，方便按命名习惯引用。

```ts
import { relayoutBpmnXml, warmupLayoutEngine } from 'tramito-layout';

await warmupLayoutEngine();

const { xml, trace } = await relayoutBpmnXml(originalBpmnXml);
```

返回的 XML 完整保留原语义元素（process / lane / task / 自定义命名空间 / extensionElements / documentation 等），只重新生成 `<bpmndi:BPMNDiagram>`。

`RelayoutBpmnXmlOptions` 字段：

| 字段 | 说明 |
| --- | --- |
| `mode` | 目前仅支持 `'full'`（默认）—— 全量重算 BPMNDI。`'preserve'` / `'local'` 暂未实现，传入会抛错。 |
| `debug` | 同 `layoutBpmnXml` 的 `options.debug`，用于采集 stage snapshot。 |

适用场景：编辑器端拿到的是 BPMN XML 而非 ELK-BPMN JSON；或者业务上游改了流程结构，想用最新布局算法重排但保留原 XML 中的自定义扩展。

## 当前设计

核心思路：**ELK 只负责通用节点粗排，BPMN-specific 视觉规则由自研 stage 处理。**

为什么这样拆：

1. 节点分层、层内排序、基础对齐交给 elkjs，比自研稳定。
2. BPMN 规则（lane、pool、boundary event、message flow、association、label、artifact）不是通用图优化问题，必须显式建模。
3. edge route 全部基于最终节点位置计算，统一使用绝对坐标，避免 pool-local / absolute 混用。
4. serializer 只负责把 `LayoutedGraph` 翻译成 BPMN DI XML，不应该再承担布局决策。

实际运行路径：

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

`pipeline.ts` 只做装配；stage 入口与类型统一从 `src/stages/index.ts` re-export。新增 stage 时先把契约放进 `src/stages/index.ts`，再接入 pipeline。

## 关键目录

```text
src/
  index.ts                 # npm 包公共入口
  service.ts               # runPipeline → bpmn-moddle XML
  pipeline.ts              # stage 编排
  loader/                  # 原始 JSON → BpmnModel
  layout/                  # elk singleton、节点尺寸、lane resolver
  stages/                  # 布局 stage
    edge-router/           # classifier / port / anchor / path / channel / detour
    bpmn-rules.ts          # BPMN 语义规则表
    compactor.ts           # 水平压缩与长链折行
    constraint-model.ts    # 约束/决策 trace
    incremental-stabilizer.ts
    label-placer.ts
    merger.ts
  serializer/              # LayoutedGraph → BPMN 2.0 XML
  evaluation/              # check:layout 的规则实现
scripts/
  run-xml.ts               # fixture → out-xml/*.bpmn
  render-bpmn.ts           # BPMN XML → out-bpmn-png/*.png
  check-layout.ts          # E/N/B/L 硬标准 + F 软指标
  export-ai-debug-bundle.ts
fixtures/                  # 34 个覆盖用例
docs/layout-lessons.md     # 布局历史经验与长期工程原则
docs/layout-fix-workflow.md # 用户 JSON 问题 → fixture → 复现 → 修复流程
```

`out-xml/*.bpmn` 与 `out-bpmn-png/*.png`（编译产物及其渲染图）随仓库一起提交，布局改动可以在 git 里对照评审——改完布局跑 `bun run fixtures:sync` 重新生成。`out-ai-debug/` 只保留 `.keep` 占位，内容是本地诊断产物，不提交。

## 开发命令

```bash
bun test
bunx tsc --noEmit
bun run build

bun run fixtures:xml
bun run fixtures:png
bun run check:layout
```

布局相关改动必须至少跑：

```bash
bun test
bunx tsc --noEmit
bun run fixtures:xml
bun run fixtures:png
bun run check:layout
```

如果只看机器指标不够，按 `CLAUDE.md` 里的 E/N/B/L 硬标准检查代表性 PNG。

## 发布到 npm

公开发布（`prepack` 会自动 build）：

```bash
npm publish --registry=https://registry.npmjs.org
```

发布前先 dry-run 检查包内容：

```bash
npm publish --dry-run --registry=https://registry.npmjs.org
```

License: Apache-2.0。

## AI Debug Bundle

默认包入口不调用 AI，也不采集 stage snapshot。需要诊断时显式运行：

```bash
bun run debug:ai 13-boundary-events-all
bun run ai:optimize --fixture 13-boundary-events-all --dry-run
```

产物落在 `out-ai-debug/`，只作本地分析。`docs/prompts/layout-critic.md` 是 AI 读取 bundle 时使用的 prompt。
