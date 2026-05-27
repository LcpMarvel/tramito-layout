# 重构待办：拆分 runPipeline（F2 剩余部分）

> 状态：**待做**。这是一份可直接接手的任务规格，不是已完成记录。
> 背景来自"把项目当编译器看"的 review（2026-05-27）：前端 `validateGraph` 诊断、后端 codegen、ICE 分层都已立起来，唯独**后端的编排主函数没有真正分 pass**。

## 问题

`src/pipeline.ts` 的 `runPipeline` 是一个 ~800 行的单函数，违反两条已写进 CLAUDE.md 的架构契约：

- "pipeline.ts 只做装配胶水，不写算法逻辑"
- "stage 之间只通过 plain data 传递，每个 stage 是纯函数"

实际它在内部内联了几何运算（per-pool `finalWidth/finalHeight`、`nodeToPool` 映射等）、跨阶段共享大量可变 local（`poolInputs`、各种 `Map`、snapshot 累加器）。

后果（编译器视角）：
- 后端没有真正的"分 pass"，难读、难测、难定位责任阶段。
- 直接拖累 **F3（ICE stage 归属）**：`InternalCompilerError.stage` 目前靠解析 throw message 的 `[xxx]` 前缀（见 `src/errors.ts` 的 `extractStageTag`），runPipeline 内联逻辑抛的错没有前缀，归属不可靠。phase 拆开后才能给每个阶段包一层权威的 stage tag。

## 已完成（不要重复做）

- 已把两个纯图算法 `mainFlowReachable` / `collectHandlerSubgraph`（+ `CollectedSubgraph`）从 pipeline 抽到 `src/stages/handler-subgraph.ts`，经 `stages/index.ts` 单点 re-export，并加了 `test/handler-subgraph.test.ts`。
- 已给 ICE-prone 的后端 throw 补齐 `[stage]` 前缀（edge-router / merger / path-shaper / serializer 都有了）。

## 目标

把 `runPipeline` 拆成一串**有名字的 phase 函数**，每个对应执行顺序里的一个阶段（见 `stages/index.ts` 顶部的顺序注释）：

```
SubprocessLayout → ElkPlacement+LaneConstrainer(per pool) → PoolComposer →
SubprocessTranslator → handler mini-ELK → DecorationPlacer → ArtifactPlacer →
PoolOverflowRebalancer → IncrementalStabilizer → EdgeRouter → AssociationRouter → Merger
```

建议手法：引入一个贯穿的 **`PipelineContext`** 对象持有当前所有共享 local（nodes/poolInputs/各 Map/snapshot 累加器/trace），把每个 phase 改写成读写该 context 的函数。`runPipeline` 退化成"按序调用各 phase + 收尾"，真正只剩编排。内联几何运算应下沉到它逻辑归属的 stage（如 per-pool 宽高 → pool-composer）。

顺带做 **F3**：用一个 `runStage(name, fn)`（可放 `src/errors.ts`）包裹每个 phase，让任何逃逸的 throw 带上权威 stage 名，不再依赖 message 前缀。

## 安全网（关键——必须用）

这次重构是**纯行为保持**，有一个完美 oracle：**所有 fixture 的输出 XML 必须逐字节不变**。

```bash
# 1. 重构前存基线
bun run fixtures:xml >/dev/null && mkdir -p /tmp/rp-baseline && cp out-xml/*.bpmn /tmp/rp-baseline/
shasum out-xml/*.bpmn | shasum          # 记下这个指纹

# 2. 每拆完一个 phase 就验一次
bun run fixtures:xml >/dev/null
shasum out-xml/*.bpmn | shasum          # 必须等于基线指纹
diff -rq /tmp/rp-baseline out-xml | grep -v '\.keep'   # 必须无 .bpmn 差异

# 3. 配套
bunx tsc --noEmit
bun test                                 # 含 test/invariant.test.ts：过校验⟹能编译
bun run check:layout --hard              # 硬违例必须仍为 0
```

只要指纹变了，说明引入了行为差异——**立刻定位或回退该步**，不要继续往下拆。建议小步：一次只抽一个 phase，验证，再下一个。从后往前（EdgeRouter / AssociationRouter / Merger 更接近"单次调用"、状态纠缠少）通常比从头拆更安全。

## 验收

- `runPipeline` 主体只剩"按序调用 phase + 收尾"，无内联几何算法。
- 每个 phase 是独立命名函数，throw 经 `runStage` 带权威 stage 名（F3 完成：ICE 不再依赖 message 前缀归属）。
- 全部 fixture XML 逐字节不变；`bun test` 全绿；`check:layout --hard` 违例 0。
- CLAUDE.md 那两条契约（pipeline 只编排 / stage 纯函数）在代码层面成立。

## 非目标

- 不改任何布局算法/输出（任何输出变化都算这次重构失败）。
- 不改 stage 的对外签名（除非顺带修了某条契约漂移，且在 `stages/index.ts` 注明差异）。
