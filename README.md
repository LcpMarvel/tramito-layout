# tramito-layout

tramito-layout 用于把无坐标的 ELK-BPMN JSON 自动排版成带 BPMN DI 的 BPMN 2.0 XML。

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
| `layoutBpmnXml(rawJson, fixtureLabel?, options?)` | 返回 `{ xml, trace }`，用于业务集成 |
| `layoutBpmnGraph(rawJson, fixtureLabel?, options?)` | 返回 `{ graph, trace }`，用于调试布局中间结果 |
| `warmupLayoutEngine()` | 预热 elkjs 单例 |
| `isLayoutEngineReady()` | 查询 elkjs 是否已预热 |

`options.previousBoxes` 用于增量稳定；`options.debug.stageSnapshots` 用于生成 AI debug bundle，不会默认开启。

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
```

生成目录只保留 `.keep` 占位：`out-xml/`、`out-bpmn-png/`、`out-ai-debug/`。内容都是本地生成产物，不提交。

## 开发命令

```bash
bun test
bunx tsc --noEmit
bun run build

bun run fixtures:xml
bun run fixtures:png
bun run check:layout
```

## 发布到 CNB npm 制品库

`.npmrc` 已配置 CNB npm 制品库地址，并通过 `CNB_TOKEN` 读取令牌。先做 dry-run 检查包内容：

```bash
bun run publish:cnb:dry-run
```

确认无误后发布：

```bash
bun run publish:cnb
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

## AI Debug Bundle

默认包入口不调用 AI，也不采集 stage snapshot。需要诊断时显式运行：

```bash
bun run debug:ai 13-boundary-events-all
bun run ai:optimize --fixture 13-boundary-events-all --dry-run
```

产物落在 `out-ai-debug/`，只作本地分析。`docs/prompts/layout-critic.md` 是 AI 读取 bundle 时使用的 prompt。
