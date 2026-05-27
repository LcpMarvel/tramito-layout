# CLAUDE.md — tramito-layout

## 项目定位

**tramito-layout 是一个编译器**：源语言 = ELK-BPMN JSON（无坐标的流程结构），目标 = 带 BPMN DI 的 BPMN 2.0 XML。`layoutBpmnXml()` 就是 `compile(source) → target`。所有设计决策都应回到这个定位上判断。

按编译器分层理解整个项目：

- **前端（诊断 / frontend）= `validateGraph()`**：对源做静态+语义检查，返回 `ValidationIssue[]`。这是"能不能编译"的判定。错误信息必须**清晰且可照着改**（带 `code` / `id` / 可执行的 `hint`），因为源往往由 LLM 生成、要靠错误回喂自纠。`formatIssuesForFeedback()` 把诊断格式化成可直接回喂模型的反馈。
- **后端（代码生成 / backend）= 布局 + 序列化管线**：elkjs 粗排 → Lane 约束 → Pool 堆叠 → Edge 路由 → 装饰摆位 → 序列化。把合法的源翻译成 XML。
- **codegen 正确性规范 = 下面的「布局验收标准（E/N/B/L）」**：后端产出必须满足它，违反即 codegen bug。
- **核心不变式：通过 `validateGraph` 的源 ⟹ 后端一定能产出 XML。** 后端在已过校验的输入上 throw = 编译器自身的 bug = `InternalCompilerError`（ICE），**不是用户/模型的错，绝不能当诊断回喂模型**。详见下面「错误分层」。

实现要点：

- 语言/运行时：TypeScript + Bun
- 节点摆位：elkjs（Stage 1 / Stage 1b）
- Lane 约束、Pool 堆叠、Edge 路由、装饰摆位、序列化：**自研**
- 当前设计与 stage 切分见 `README.md`；历史教训见 `docs/layout-lessons.md`。本文件只讲**怎么验收 / 怎么跑 / 怎么改**。

### 错误分层（HARD - 决定错误归谁、能不能回喂模型）

把"谁的错"分清楚，是这个编译器对接 LLM 自纠循环的关键。混了就会让模型对着自己没写错的东西瞎改、空烧 step。

- **校验错（用户/模型可改）**：源结构非法。`validateGraph` 收集**全部** issue（非 fail-fast）后，loader 以 `AggregateError`（只含 `error` 级）抛出。消费侧应 `formatIssuesForFeedback` + 原始 graph 一起回喂模型自纠。
- **ICE（编译器 bug）**：源已过校验，后端仍 throw。在编译边界（`service.ts` / `index.layoutBpmnGraph`）被 `withCompileErrors` 统一包成 `InternalCompilerError`（`internal: true` + `stage`）。消费侧**不要**回喂模型，应作为 bug 上报 / 降级处理。
- **新增/改规则的判据**：`validateGraph` 该覆盖的，**不是 BPMN 规范全集，而是恰好等于"后端处理不了、且用户能改"的集合**。某条 BPMN 约束若后端本就能正常编译，就不该进校验（别误杀合法输入——见 `validate-graph.ts` 里不拦 compensation association 的注释）。若后端会因它 throw 且用户能改，则提升为前端规则。规则单点定义在 `src/loader/validate-graph.ts`，loader 复用、永不漂移。

> 历史：v1.0 是 Kotlin + Java ELK + `ILayoutExecutionListener` 内化 hook；v2.0 是纯自研 SESE 模板；v2.1 是 RPST + elkjs 混合。都因不同原因放弃，**v2.2 才是当前架构**。当前仓库不应再包含 Kotlin/Java 源码；若搜索到 Kotlin / Java / hooks / processors / spike / `LayeredWithHooks`，应只出现在历史说明里，不能作为实现依据。

## 布局验收标准（HARD - 不达标即 bug，必须修）

每次改 layout 代码后，**必须**渲染 fixture PNG 并用下面这把尺子量。任何一条不达标都是 bug，不是"美观问题"。

### 1. 连线（Edge）

- **E1 端点必须落在节点边上**：edge 的 startPoint / endPoint 必须精确落在 source / target 节点的外边框上。**不能**浮在节点外（视觉上断开）、**不能**伸进节点内部、**不能**只画到节点附近就停下。
- **E2 线不能穿过节点**：edge 在任何位置都不能切过非 source/target 的其他节点。该绕行的绕行（增加 bend point）。edge 之间可以相交，但 edge 不能穿过 node。
- **E3 最后一段垂直进入**：edge 最后一段必须垂直于所连节点的边。进入左/右侧 → 水平段；进入上/下边 → 竖直段。不能斜着扎进节点角落。
- **E4 没有孤立 edge**：渲染出来的图里不能有"飘在外面"的箭头碎片（waypoint 跑到画布外面、看不到源头或目标）。常见原因：edge 用了错误的坐标系（pool-relative vs absolute 混了）。当前架构里**所有 edge 必须在绝对坐标系里算**。

### 2. 节点（Node）

- **N1 节点之间不能重叠**：任何两个节点的 bounding box 不能相交。包括 task / event / gateway / subprocess / data object 等。
- **N2 节点不能穿出父容器**：lane 内的 task 不能伸出 lane 边界；subprocess 子节点不能伸出 subprocess 框；pool 内的元素不能伸出 pool。
- **N3 容器必须包住所有 children**：pool 必须比所有 lane + flow node 加起来还大；subprocess 必须够大装下所有子节点 + padding；lane 必须够高装下其 member。
- **N4 节点尺寸必须对**：task / userTask / serviceTask 默认 100×80（长 label 会撑宽）；event 36×36；gateway 50×50。**不能**因为给 task 挂了 boundary event 就把 task 缩到 60×60。

### 3. BPMN 视觉规范

- **B1 Boundary event 骑在 host 边上**：boundary event 必须半内半外地坐在 host 节点的底边（或侧边）上。不能浮在 host 旁边，不能完全在 host 外面。
- **B2 多 Pool 垂直堆叠**：collaboration 里多个 pool 必须上下排开，pool 之间留间距（≥20px），**绝对不能**横向并排或重叠。
- **B3 Lane 按声明顺序垂直排列**：pool 内的 lane 按 BPMN XML 声明顺序自上而下排，**不能**乱序、不能水平排列。
- **B4 Nested lane 正确缩进**：sub-lane 在父 lane 的内部、缩进一个 lane header 的宽度（30px）。sub-lane 的 width = 父 lane.width - 30，右边界对齐父 lane 右边。

### 4. Label

- **L1 节点 label 不要跨出节点远**：task 的 label 在节点内部居中；event / gateway 的 label 默认在节点下方 4px 处。不能跑到完全没关系的位置。
- **L2 Edge label 不能压住节点**：edge label 沿 edge 路径放置，必须不压在任何 node 上（容忍轻微擦边）。
- **L3 多个 label 不堆叠**：多个 boundary event 或多条 edge 在同一区域时，label 必须错开，不能完全压在一起。

## 软标准（SOFT - 影响美观，能改尽量改但不阻塞）

- **F1 主流方向一致**：默认左→右；明确的子流程（如 boundary event handler）可以向下/向上分叉。
- **F2 Spine 居中，分支上下分布**：start → end 的主干（spine）应位于其层的垂直中心，分支均匀分布在 spine 上下，**不应**所有分支都堆在 spine 一侧（这是当前 04-all-gateways 的硬伤）。
- **F3 避免 backtracking**：主流不能 N 形回头。可以接受 convergence gateway 把分支收回主线，但主线不能往回走。
- **F4 宽高比合理**：总体长宽比不要极端（避免超过 4:1）。可以通过让独立分支共享 Y / 紧凑布局来改善。
- **F5 节点对齐**：同一逻辑层级的节点应对齐 Y（或 X，取决于方向）。

## 验证流程（每次改 layout 必跑）

```bash
cd /Volumes/lcp/hovel/mouqitech/tramito-layout

# 1. 单测（每个 stage 一份）
bun test

# 类型检查（布局/trace/debug 类型改动时必须跑）
bunx tsc --noEmit

# 2. 全量 fixture → BPMN XML（产物落 out-xml/*.bpmn）
bun run fixtures:xml
# 也可只跑指定 fixture：bun run scripts/run-xml.ts 04-all-gateways 13-boundary-events-all

# 3. 渲染 PNG（用 bpmn-js + puppeteer-core 调系统 Chrome，产物落 out-bpmn-png/*.png）
bun run fixtures:png
# 如果 Chrome 不在默认路径，给 CHROME_PATH 环境变量

# 4. 客观标准检测（硬 E/N/B/L 15 条 + 软 F1-F5）
bun run check:layout
# 输出两张表：硬标准违例数 + 软标准指标值/阈值通过
# 任何 layout 改动**硬标准**违例数必须 ≤ baseline (0)；软标准指标允许略微波动但不能整体退步
# 仅硬：--hard ；仅软：--soft ；筛选规则：--rules E / --rules E1,N1
# 仅一个 fixture：bun run check:layout 22
# 机器可读 JSON（给 AI/debug 工具用）：bun run check:layout:json
# 或：bun run check:layout --json > out-ai-debug/evaluation.json

# 5. 看几张代表性 PNG，用上面的 E/N/B/L 硬标准逐条对照
```

**改完后必须用 Read 工具看几个有代表性的 PNG，用硬标准逐条对照。不能只看 `bun test` 绿了或 `run-xml` 没报错就报告完工。** 典型代表性 fixture：

- `01-simple-process` —— 最基础的单流程
- `04-all-gateways` —— gateway 分支 / 合并、spine 居中
- `13-boundary-events-all` —— task 尺寸、boundary 附着、edge 端点
- `16-subprocess-embedded` —— 子流程容器嵌套
- `21-subprocess-variants` —— 多层嵌套子流程
- `24-collaboration-simple` —— 多 pool 垂直堆叠
- `26-collaboration-lanes` —— 单 pool 多 lane
- `27-collaboration-nested-lanes` —— nested lane
- `28-collaboration-many-lanes` —— 多 pool 多 lane
- `29-collaboration-message-flows` —— pool 之间 message flow

### AI Debug Bundle（开发期诊断）

默认包入口 `layoutBpmnXml()` **不调用 AI、不采集 stage snapshot**。只有显式跑 debug 命令或传入 debug 选项时，pipeline 才会把关键 stage 的 plain data snapshot 写入 trace。

```bash
# 生成单个 / 多个 fixture 的 AI 诊断包
bun run debug:ai 13-boundary-events-all
bun run debug:ai 13-boundary-events-all 24-collaboration-simple

# 产物落 out-ai-debug/
#   manifest.json
#   evaluation.json
#   <fixture>/input.json
#   <fixture>/output.bpmn
#   <fixture>/output.png
#   <fixture>/trace.json
#   <fixture>/stage-snapshots.json
#   <fixture>/decisions.json
#   <fixture>/constraints.json
#   <fixture>/violations.json
#   <fixture>/metrics.json
#   <fixture>/ai-brief.md

# dry-run：不改源码，只基于 bundle 生成本地分析骨架
bun run ai:optimize --fixture 13-boundary-events-all --dry-run
```

`stage-snapshots.json` 至少应包含 `elk-placement`、`lane-constrainer`、`pool-composer`、`subprocess-translator`、`decoration-placer`、`artifact-placer`、`pool-overflow-rebalancer`、`edge-router`、`merger`、`serializer`。如果要定位 E 类问题，优先比较 `edge-router → merger → serializer` 同一 edge 的 waypoints/ports；如果要定位 B/N 类问题，优先比较 `lane-constrainer → pool-composer → pool-overflow-rebalancer → merger`。

`violations.json` 是 AI 分析硬违例的事实源，每条记录必须有 `ruleId`、`subject`、`evidence`、`suspectedStages`、`sourceHints`。`ai-brief.md` 只作摘要，不作为事实源。

### 作为 npm 包引入

```ts
import { layoutBpmnXml, warmupLayoutEngine } from 'tramito-layout';

await warmupLayoutEngine();
const { xml, trace } = await layoutBpmnXml(elkBpmnJson);
```

本仓库不再维护独立 HTTP server / docker compose 入口；联调方应直接依赖包 API。

## 实施约定

- **早抛异常，少兜底**（与项目根 CLAUDE.md 一致）：layout 阶段发现 invariant 被破坏（节点尺寸异常、edge endpoint 浮空、lane 没找到 owner pool 等），优先 throw，**不要**悄悄写一个看起来还行的值。健壮性来自及早暴露。
- **stage 之间只通过 plain data 传递**：每个 stage 是纯函数，输入是上一 stage 的输出，输出 schema 在各 stage 文件里定义、**统一在 `src/stages/index.ts` 单点 re-export**。`pipeline.ts` 只从 index 拿，不直接 import 单个 stage 文件。任何"读写共享 mutable state"都是 bug。pipeline.ts 只做装配胶水，不写算法逻辑。
- **用户 JSON 布局问题先入 fixture**：当用户复制 ELK-BPMN JSON 并描述布局问题时，按 `docs/layout-fix-workflow.md` 新增 fixture、复现、再修复，不要跳过可重复用例。
- **不写虚假"完成"报告**：如果某个 fixture 渲染出问题，老实说"X 还差 Y"，不要说"主要修好了"就过。
- **注释只解释 WHY**（与项目根 CLAUDE.md 一致）：不要写 "这一步做 XX" 的复述注释；解释为什么这么选（哪个 fixture 推出来的约束、避开了什么坑）。

## 项目结构速查

```
tramito-layout/
  README.md                       # 当前包使用方式与架构说明
  CLAUDE.md                       # 本文件
  package.json                    # bun + elkjs + bpmn-moddle，无其他重依赖
  fixtures/                       # 34 个测试输入 JSON（01-37，编号不连续）
  out-xml/                        # `bun run fixtures:xml` 产物
  out-bpmn-png/                   # `bun run fixtures:png` 产物
  out-ai-debug/                   # `bun run debug:ai ...` 诊断包（gitignore）
  dist/                           # `bun run build` npm 包产物（gitignore/发布文件）
  docs/
    layout-lessons.md             # 历史教训与长期工程原则
    prompts/layout-critic.md      # AI 只读 bundle 时使用的 critic prompt
  test/                           # 每个 stage 一个 *.test.ts
  scripts/
    run-xml.ts                    # 全量 fixture → BPMN XML
    render-bpmn.ts                # XML → PNG（bpmn-js + puppeteer-core + 系统 Chrome）
    check-layout.ts               # E/N/B/L 硬标准 + F 软指标；支持 --json
    export-ai-debug-bundle.ts     # 生成 out-ai-debug/<fixture>/ 诊断包
    ai-optimize-layout.ts         # dry-run 生成 AI critic prompt / analysis skeleton
    run-metrics.ts                # aesthetic metrics 报告
    bench.ts                      # 性能 bench
  src/
    index.ts                      # npm 包公共入口
    service.ts                    # runPipeline → ModelBuilder → BpmnXmlGenerator
    pipeline.ts                   # 装配 stages（**只编排，不写算法**）
    debug/                        # AI debug bundle / stage snapshot 数据转换
    loader/                       # 原始 JSON → BpmnModel
    layout/                       # 跨 stage 共享的工具
      elk-singleton.ts            # elkjs 单例 + warmup
      node-sizes.ts               # 节点尺寸 / padding 常数
      lane-resolver.ts            # leaf lane 顺序、节点→lane 映射
    stages/                       # 文件名按职责命名（不再带 s1/s4b/s5b 前缀）
      index.ts                    # ★ 契约注册表：所有 stage 的 fn + Input/Output 类型 re-export
      types.ts                    # 共享原子：NodeBox / LaneBox / PoolBox / EdgeRoute 等
      subprocess-layout.ts        # 展开 subprocess 内部 mini-ELK（递归嵌套；执行序最早）
      elk-placement.ts            # 调 elkjs 摆位（局部坐标）
      lane-constrainer.ts         # 节点 Y snap 到所属 lane 中线
      pool-composer.ts            # 多 pool 垂直堆叠 → 绝对坐标
      edge-router/                # 自研 edge 路由
        classifier.ts             # edge → EdgeType
        anchor.ts                 # 端点贴哪条边
        path-shaper.ts            # waypoints
        channel.ts                # 平行 edge 错开
        index.ts                  #   装配
      association-router.ts       # artifact ↔ host 的 association 边
      decoration-placer.ts        # boundary event 骑边 + handler 子图平移
      artifact-placer.ts          # dataObject / textAnnotation 上下方摆位
      merger.ts                   # 所有 stage 输出 → LayoutedGraph JSON
    serializer/                   # LayoutedGraph → BPMN 2.0 XML（含 DI）
    metrics/aesthetic-metrics.ts  # 给 run-metrics.ts 用
```

### 长期经验

历史失败路线、当前架构原则和未来压力点统一沉淀在 `docs/layout-lessons.md`。不要在本文件继续追加开发期路线图或完成记录。
