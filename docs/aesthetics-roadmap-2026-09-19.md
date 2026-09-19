# 布局美观度提升方案（2026-09-19）

> 用途：这是一份**可拆给低成本模型逐张执行的任务规格**，不是完成记录。
> 每个 Phase 下面的"任务卡"自带：背景（WHY）、改哪些文件、具体做法、验收命令 + 数值、禁区。
> 执行者不需要读完全文，只需读「§0 执行规则」+ 自己那张卡。

## 一、诊断：方案没错，卡在三处结构性执行

现状（`bun run check:layout`，98 fixture）：

- **硬标准**：01–45 老 fixture 全 0；56 个新压力 fixture 里 8 个脏、24 处违例，全部聚在 4 个 bug 族（见 `fixture-stress-findings-2026-06-12.md`）。→ "画得对不对"基本解决。
- **软标准**：24/98 fixture 至少一项不达标；F3（回头）17 个、F4（宽高比）10 个、F1（主流方向）8 个。→ "画得好不好看"停滞。

结论：**"ELK 摆节点 + 自研 stage 做 BPMN 决策"这个大方向是对的**（v1 JVM hook、v2.0/2.1 纯模板都已证伪，不要回头）。美观度上不去，不是方案的问题，是下面三件事：

### 原因 1：分片布局后拼接（fragmentation）

主流程走一次 ELK；每个 boundary handler 子图再走一次 mini-ELK，然后由 DecorationPlacer 整体平移到 host 下方；subprocess 内部也是独立 mini-ELK。拼接本身没问题，**问题出在片与片之间有边**：

- handler 链尾部要汇回主流（fixture 80 的"履约汇聚"）：汇聚点属于主图，被 ELK 摆在主流层序上；handler 链被平移到别处，于是"正常履约"横穿整条 handler 链、汇聚网关掉到左下角。
- handler 节点属于某条 lane（96 的 `task_cs_escalate`）：平移后没有再 snap 回 lane → N2 真违例。
- handler 出边的绕行 waypoint 用了平移前坐标 → 负坐标（77/80/83 的 E4）。

这一族问题 **不能靠再加一个后处理 pass 修**，根因是"两个独立坐标系里各算一半"。

### 原因 2：ELK 的结果只用了 X；Y 和边全部丢掉重算，靠"模板 + pass 链"

- `lane-constrainer.ts`（665 行）把 ELK 的 Y 全部改写。
- `edge-router/`（index 1175 + path-shaper 562 + detour 511 行）把 ELK 的边全部丢掉，按 edgeType 套模板（forward-step / back-edge arch / cross-lane L），然后跑一串后处理 pass（`nudgeHorizontalSegmentsOffDividers` → `nudgeParallelSegmentsApart` → `keepIntraLaneBackEdgeInsideLane` …）。
- `docs/layout-lessons.md` 第 7 条已经记录了 pass 之间互相打架、"pass 顺序即优先级"的现象。

后果：没有全局目标（交叉数 / 拐点数 / 长度），每条边只看自己。表现：

- 101（8 路并行）：入 join 网关的边穿过 `接口测试`/`界面测试` 一列，`构建` 被甩到远低于 fork 网关的位置。
- 39/54（多级驳回）：驳回归一走廊骑着首行 task 的中线跑完全图。
- 56/90：同源扇出的条件 label 100% 叠在网关出口。

### 原因 3：尺子太钝，无法客观驱动"更好看"

F1–F9 里没有 **边交叉数、拐点数、边总长、空白率**；F1/F3 把语义上必须回头的边（BackEdgeResolver 已判定）也算进分母，回边 fixture 天然 fail，噪声掩盖真问题。没有可比较的 baseline 文件，任何"美观优化"都无法自证不退步——**便宜模型尤其需要这个**，否则它只能说"看起来好了"。

### 不要让执行者走的路（已证伪，见 `layout-lessons.md`）

- 用 ELK partition 把 lane 绑到 X（第 7 条）。
- fork elkjs 拿 hook。
- 把 layout 兜底写进 serializer。
- 为单个 fixture 写坐标补丁 / 特判。

---

## 二、总览：6 个 Phase

| Phase | 目标 | 主要文件 | 难度 | 依赖 | 可并行 |
|---|---|---|---|---|---|
| 0 尺子 | 补美观指标 + baseline 对比 | `src/evaluation/layout-evaluator.ts`, `scripts/check-layout.ts` | 低 | — | 与 P1 并行 |
| 1 硬 bug | 清掉 4 个 bug 族，98 fixture 硬标准归 0 | `lane-constrainer.ts`, `decoration-placer.ts`, `label-placer.ts`, `edge-router/` | 低–中 | — | 与 P0 并行 |
| 2 拆 pipeline | `runPipeline` 拆成 phase 函数（行为逐字节不变） | `src/pipeline.ts` | 低（有完美 oracle） | P1 | — |
| 3 去分片 | handler 子图并入主 ELK，删掉 mini-ELK + 平移 | `pipeline.ts`, `elk-placement.ts`, `decoration-placer.ts` | 中 | P2 | — |
| 4 主干对齐 | 主干同 Y、分支对称、F2 归 0 | 新 `spine-aligner.ts`, `elk-placement.ts` | 中 | P3 | 与 P5 并行 |
| 5 路由升级 | 轨道分配替代 per-edge 模板 + pass 链 | `edge-router/channel.ts` → 新 `track-allocator.ts` | 高 | P3 | 与 P4 并行 |
| 6 宽高比 | lane 内长链折行（71 30:1） | `compactor.ts`, `lane-constrainer.ts` | 中 | P4 | 最后 |

预期收益排序：**P3 > P5 > P4 > P1 > P6**；P0/P2 本身不改画面，但决定后面能不能被便宜模型安全地做。

---

## §0 执行规则（每张卡都适用）

1. **一张卡一个会话、一个 commit。** 不要顺手改卡外的东西；发现卡外问题写进 commit message 的"发现"段，不修。
2. **开工前存基线**：
   ```bash
   bun run fixtures:xml >/dev/null && bun run check:layout --json > /tmp/before.json
   ```
3. **收工必跑**，并把输出表格贴进汇报：
   ```bash
   bun test && bunx tsc --noEmit
   bun run fixtures:xml && bun run check:layout          # 硬标准违例必须 ≤ 开工前；软指标不得整体退步
   bun run scripts/render-bpmn.ts <卡上列的 fixture>     # 然后用 Read 工具打开 PNG 逐条对照 E/N/B/L
   ```
   P0 做完后改用 `bun run check:layout --compare docs/layout-baseline.json`。
4. **禁区**：不改 `serializer/` 来修布局；不加 fixture 特判（按 id / name 判断）；不写"看起来还行"的兜底值（invariant 破坏就 throw，见 CLAUDE.md）；不加 ELK partition。
5. **新增 edge-router 后处理 pass 要付"税"**：必须在函数头注释写清"哪个 fixture 推出来的、避开了什么、为什么不能在更早的 stage 解决"，并且给它加一个 fixture 或单测。
6. **注释只写 WHY**，不复述代码在做什么。
7. 汇报不写"主要修好了"。逐 fixture 写：哪条规则从几到几、哪张 PNG 还差什么。
8. **baseline 只在人看过 PNG 确认"确实更好看"之后由人手动 `--save-baseline` 更新**（单独 commit）。执行者一律用 `--compare docs/layout-baseline.json` 自证不退步，绝不许自己重写 baseline 让对比变绿——这是防止"用尺子过 CI"的唯一门禁。

---

## Phase 0：把尺子磨尖（可与 Phase 1 并行）

### 卡 0.1 — F1/F3 剔除语义必需回边

**WHY**：`45/47/48/54` 等回边 fixture F1 71–80%、F3 15–29%，其中大部分是循环结构里**必须**向后的边（BackEdgeResolver 已判定）。它们在分母里制造噪声，真正的 N 形回头（如 80 的"正常履约"）被淹没。

**改哪**：`src/evaluation/layout-evaluator.ts` 的 F1/F3。

**做法**：evaluator 从 XML 只能拿到 sequenceFlow 拓扑 + 坐标，拿不到 router 的分类。用 `src/stages/back-edge-resolver.ts` 同一套断环算法（直接 import，不要复制）对 sequenceFlow 拓扑算出"语义回边集"，F1/F3 只统计**不在该集合里**却向后（target.centerX < source.centerX）的边。展示值旁边附上被剔除数，例如 `100% (剔 3 回边)`。

**验收**：45/47/48/54 的 F1/F3 fail 消失；80、23、39、40 若仍 fail，逐条列出剩余边 id（那些是真问题，留给 P3/P5）。`bun test` 里补一个 evaluator 用例：一个 3 节点环，F3 = 0。

### 卡 0.2 — 新增 F10–F14 美观指标

**WHY**：现在没有任何指标能区分 101 的缠线和 04 的整齐；便宜模型优化路由时没有客观目标。

**改哪**：`layout-evaluator.ts`（照 F6–F9 的写法加 `checkF10..F14`，注册进规则表），`scripts/check-layout.ts` 表头。

| 指标 | 定义 | 阈值（首版） |
|---|---|---|
| F10 边交叉数 | 所有 sequenceFlow 两两线段相交数（共享端点不算；messageFlow 单独算不入分） | 绝对值，只比 baseline 不涨 |
| F11 平均拐点数 | Σ(waypoints−2)/edges | ≤ 2.0 |
| F12 骑行段 | 某条边的水平段 y 落在**非端点**节点的 `[y, y+h]` 内且 x 区间与该节点重叠 ≥ 50%（没穿过节点，但视觉上像穿过那一行） | 0 |
| F13 空白率 | 1 − Σ节点面积 / 内容 bbox 面积（pool/lane 不算节点） | ≤ 0.85 |
| F14 主干拐点 | start→end 最短路径上所有边的拐点总数 | ≤ 2 × 路径上 gateway 数 |

**验收**：98 fixture 表格跑通；101 的 F10/F12 明显高于 04（作为 sanity check 写进单测：用 `out-xml/101-*.bpmn` 与 `04-*.bpmn` 对比）。

### 卡 0.3 — baseline 文件与 `--compare`

**WHY**：没有存档就没有"退步"的定义。

**改哪**：`scripts/check-layout.ts`；新增 `docs/layout-baseline.json`。

**做法**：`check:layout --save-baseline docs/layout-baseline.json` 写入每 fixture × 每规则的值；`--compare <file>` 输出三列：硬标准新增违例（任何 > 0 直接 exit 1）、软指标变差的 fixture×规则（超出容差：百分比类 ±2 个点、计数类 +1、比值类 +5%），以及变好的。**baseline 只在人看过 PNG 之后由人手动更新**，写进 §0 规则。

**验收**：`--compare` 对自身 baseline 输出全 0；人为改一个 fixture 的 XML 坐标能被抓到。

---

## Phase 1：清掉 4 个硬 bug 族（可与 Phase 0 并行）

这些卡已在 `fixture-stress-findings-2026-06-12.md` 定位过嫌疑点，这里只给执行规格。

### 卡 1.1 — lane 为底边 boundary 预留净空（N2/N3 ×12：82/96/99）

**WHY**：B1 要 boundary 半内半外骑 host 底边；host 贴 lane 底边时 boundary 下半身必出 lane。修引擎不修尺子：lane 留白本来也更好看。

**改哪**：`src/stages/lane-constrainer.ts`（参照 `estimateFanInCorridorReserve` 的做法加 `estimateBoundaryReserve`）。

**做法**：lane 的 member 里若有挂 boundary 的 host，该 lane 底部 pad 至少 `BOUNDARY_H/2 + LABEL_LINE_H + LABEL_NODE_GAP`（boundary 半身 + 它的 label）。经正常 sizing 路径流到 pool 高度。

**验收**：82/96/99 的 N2/N3 归 0（96 的 `task_cs_escalate` 除外，见卡 3.x）；13/23/51 无变化；渲染 82/99 看 boundary label 不压分隔线。

### 卡 1.2 — 多 boundary 溢出 host 边长（B1 ×2：83）

**改哪**：`src/stages/decoration-placer.ts`，可能要动 `layout/node-sizes.ts` 的 host 尺寸输入。

**做法**：host 底边可容纳 `floor((w − 2×margin)/ (36 + gap))` 个；超出部分**优先撑宽 host**（N4 允许长 label 撑宽，这里同理，撑宽发生在 ELK 之前——在 pipeline 组装 `PlacementInputNode.w` 时按 boundary 数算），仍放不下才溢到顶边。同时 label 交错：偶数个 label 在下、奇数个在上（L3）。

**验收**：83 B1/L3 归 0；13 不变；PNG 上 5 个 boundary 全骑在底边上。

### 卡 1.3 — handler 出边负坐标（E4 ×6：77/80/83）

**WHY**：这一族的根因是分片（原因 1），P3 会彻底消掉。但 P3 之前 E4 是硬违例，先做最小修。

**改哪**：`src/stages/edge-router/index.ts` 或 `path-shaper.ts` 里 boundary → handler entry 的路径。

**做法**：找到绕行方向固定向左的分支，改为"向 handler 子图所在侧绕"；任何 waypoint `x < 0` 直接 throw（早抛），不 clamp。

**验收**：77/80/83 E4 归 0；13/23/51/81 不变。**注**：如果 P3 已经排期，这张卡可以跳过，直接让 P3 验收 E4。

### 卡 1.4 — 同源扇出 label 错开（L3 ×4：56/90）

**改哪**：`src/stages/label-placer.ts`（不是 channel.ts）。

**做法**：同一 source 出发的 ≥3 条边，label 不放在出口共享段，放在各自**第一段独占段**（分叉之后的那一段）的中点；仍重叠则沿该段滑动。gateway 自身 name 与出边 label 相撞时沿用 `placeGatewayLabelsOffEdges` 的抬高逻辑。

**验收**：56/90 L3 归 0；04/42/60 不变；渲染 56 看 8 个金额档位各自可读。

### 卡 1.5 — handler 节点平移后 re-snap 回 lane（N2：96 `task_cs_escalate`）

**做法**：DecorationPlacer 平移 handler 子图后，对有 lane 归属的 handler 节点重新按 lane band 校正 Y（复用 lane-constrainer 的 snap 函数，不要重写）。若 lane 装不下则 lane 增高，不是把节点硬塞。**注**：P3 做完后这段代码会删掉；如 P3 排在近期可跳过。

---

## Phase 2：拆 `runPipeline`（P3 的前置）

完整规格在 `docs/refactor-runpipeline-phases.md`，已经写好，直接照做。要点：

- 纯行为保持，**所有 fixture XML 逐字节不变**是完美 oracle（文档里有 shasum 指纹脚本）。
- 从后往前拆（Merger → AssociationRouter → EdgeRouter …），一次一个 phase，验一次。
- 顺带用 `runStage(name, fn)` 给每个 phase 包权威 stage 名（ICE 归属）。

这是**最适合便宜模型**的一张：机械、有 oracle、失败可即时回退。P3 要大动 pipeline 的 handler 段，不先拆开会改出一身 bug。

---

## Phase 3：去分片——handler 子图并入主 ELK（收益最大）

### 卡 3.1 — 设计与验证 spike（先做，不合并）

**WHY**：原因 1。把 handler 节点放进主图一起 ELK，"汇回主流"就变成普通分层，80 的 N 形、96 的出 lane、77/80/83 的负坐标全部不再有生成路径。

**做法**（在 `elk-placement.ts` 的输入组装处，即 P2 拆出的 placement phase）：

1. 主图 children 追加所有 handler 节点；edges 追加 handler 内部边和汇回边。
2. `BE → handlerEntry` 这条边在喂 ELK 时改成 `host → handlerEntry`（BE 不是 ELK 节点，它骑在 host 上）。
3. 让 handler 分支落在 host **下方**而不是上方：children 数组里 handler 节点排在全部主流节点之后（`considerModelOrder=NODES_AND_EDGES` 已开，模型顺序会影响层内排序）。不够稳时再加 `elk.layered.crossingMinimization.semiInteractive=true` + 给 handler 节点 `elk.position.y` 一个大值作 hint。**不要**用 partition。
4. DecorationPlacer 只保留"BE 骑 host 边 + 决定骑哪条边（朝 handler 方向那条）"，删掉子图平移。
5. handler 节点有 lane 归属时，走正常 lane-constrainer 路径（自然修掉 96）。
6. 删除 pipeline 里的 mini-ELK handler 段、`HandlerSubgraph` 类型、`beToHandlerEntry` 等只服务平移的中间态。`handler-subgraph.ts` 的 `collectHandlerSubgraph` 仍要保留：DecorationPlacer 决定 BE 骑哪条边、edge-router 决定 BE 出边锚点都要知道"哪些节点是这个 BE 的 handler"。

**spike 验收**：只对 `13, 23, 51, 77, 80, 81, 82, 83, 96, 99` 跑，硬标准不比现在差，80 的 PNG 里 handler 链在 host 下方一行、"履约汇聚"在两条分支右侧。贴 PNG 汇报，由人决定是否合并。

### 卡 3.2 — 合并 + 全量验收

全 98 fixture `check:layout --compare`；F1/F3（已剔回边）在 80/23 应改善；F12 骑行段在 80 归 0。卡 1.3 / 1.5 的临时代码在此删除。

**已知风险与对策**：

- ELK 可能把 handler 放在 host 上方 → 可接受（F1 允许子流程向上分叉），但 BE 要骑顶边。DecorationPlacer 按 handler entry 相对 host 的 Y 决定骑顶/底。
- handler 链很长时会拉宽主图 → 用 `elk.layered.priority.shortness` 压 handler 边；仍不理想交给 P6。
- subprocess 内部的 mini-ELK **保留**：那是真正的层级容器，不属于分片问题。

---

## Phase 4：主干对齐与分支平衡（F2 归 0；修 101 的"构建掉下去"）

### 卡 4.1 — 抽出共享的 spine 探测

**WHY**：`lane-constrainer.ts` 的 `assignSpineAwareRows` 已有一套主干判定；P4/P5/F14 都要用，不能三处各写一份。

**做法**：新建 `src/layout/spine.ts`：`findSpine(nodes, edges): string[]`，定义为 start → end 之间**边权最大**的路径（forward 边权 1、gateway 直通路径优先、回边不算），多 start/end 取最长。lane-constrainer 改为调用它。逐字节不变验收（同 P2 的 oracle）。

### 卡 4.2 — 先试 ELK 自带的拉直优先级

**做法**：spine 上的边在喂 ELK 时加 `'elk.layered.priority.straightness': '10'`（BRANDES_KOEPF 会尽量让这些边水平）。这是一行配置的实验，先量再决定要不要卡 4.3。

**验收**：F2、F14 与 baseline 对比；101 的 `构建` 是否回到 fork 网关同 Y；04 不能变差。

### 卡 4.3 — `spine-aligner` post-placement stage（无 lane pool）

**WHY**：`layout-lessons.md` "未来压力点" 第 1 条的建议——BPMN 特定的二次调整做成**独立小 stage**，别散进别的 stage。

**做法**：ELK 之后、Compactor 之前插入。对无 lane pool：spine 节点 Y 统一到加权中位数；每层非 spine 节点按"原 Y 在 spine 上/下"保持侧别，向外推到不与 spine 行重叠；每一步做 N1 检查，撞就回退该节点。有 lane 的 pool 不动（Y 归 lane-constrainer）。

**验收**：F2 fail 归 0；101/97/100 PNG 主干一条直线；F10 交叉数不涨。

### 卡 4.4 — 扇出对称

fork 网关 k 个分支：k 奇数时中间分支与网关同 Y，其余上下对称；k 偶数时上下各半、网关落在中缝。ELK 通常已做到（04），这张卡只处理 `spine-aligner` 移动 spine 后分支侧别失衡的情况。验收：04/56/57/101。

---

## Phase 5：路由升级——轨道分配替代 per-edge 模板（难度最高，收益第二）

### 卡 5.0 — 现状盘点（只读，产出文档）

列出 `edge-router/index.ts` 里所有后处理 pass 的顺序、各自解决的 fixture、互相冲突的记录（lessons 第 7 条那类）。产出 `docs/edge-router-pass-inventory.md`。这张卡是让执行者（和人）知道 P5 要替代什么。

### 卡 5.1 — 竖直轨道分配（inter-layer gap）

**WHY**：101 的缠线、56 的 label 叠放、39/54 的走廊骑行，共同根因是**多条边在同一个层间隙里争同一个 x**，`channel.ts`（63 行）只是按 bucket 给固定偏移，不知道别的边在哪。

**做法**：新建 `edge-router/track-allocator.ts`：

1. 从节点 X 反推层（`elk-placement.ts` 的 `computeShape` 已有分桶逻辑，抽出来共用）；层间隙 = `[layer_i.right, layer_{i+1}.left]`。
2. 每条需要在该间隙里走竖直段的边（forward-step 换行、fan-out、fan-in）登记 `(y_from, y_to)`。
3. 轨道排序：经典 ELK orthogonal 的做法——按 `(y_from, y_to)` 关系建冲突图，同向不重叠的共用一条轨，其余按 y 顺序分配，使交叉最少；轨道 x 等分间隙，最小间距 10px，不够就把整层右推（Compactor 允许）。
4. 边 label 放在**自己独占的竖直轨旁**或独占的水平段上——轨道唯一，L3 同源叠放从源头消失。

**范围控制**：首版只接管**同 pool 的 forward 边**（含 fan-out / fan-in 归一），back-edge、cross-lane、message flow 仍走现有路径。`channel.ts` 对这些边停用。

**验收**：F10 全量 ≤ baseline，101/56/57/59 明显下降；F12 骑行段 101 归 0；L3 56/90 归 0；硬标准 0。

### 卡 5.2 — 水平走廊轨道（back-edge / skip-edge 的拱）

回边和跨层跳边在**行间走廊**里分配轨道：按嵌套深度分层（内环内轨），同一走廊内不同边间距 ≥ 12px（这正是 F8 在量的）。48/47/49/54 为验收 fixture。完成后 `nudgeParallelSegmentsApart` 应可删除或退化为断言。

### 卡 5.3 — 删 pass

每接管一类边，就删掉只为它存在的后处理 pass（按卡 5.0 的清单）。删一个验一次。目标：`edge-router/index.ts` 从 1175 行降到 ≤ 600 行，pass 数减半。

---

## Phase 6：宽高比（F4）——lane 内长链折行

**WHY**：71 单 lane 26 节点 30:1；49/74/76/88/93 也超 6:1。lane 是"行"，不能像无 lane pool 那样整体 wrap，只能在 lane 内折。

**做法**：lane-constrainer 已支持多行（`MULTI_ROW_*`）；对 leaf lane 内**纯串行且长度 > N** 的 member 链，Compactor 的 `wrapLinearChain` 允许在 lane 内 snake（第二行反向），lane 增高。74/76 的 subprocess 兄弟并排是另一回事（容器折行），单独评估要不要做。

**验收**：71 ≤ 8:1，其它 F4 fail 不增；硬标准 0；F9（X 序与拓扑序一致）不能因 snake 变差——snake 第二行 X 是反的，F9 需要按行判定，这是 F9 要顺带改的地方。

---

## 三、给人的操作建议

- **顺序**：P0 和 P1 同时开两个会话；然后 P2；然后 P3（这一张我建议用中等模型做 spike、便宜模型做合并收尾）；P4 和 P5 可以并行开两个会话；P6 最后。
- **合并门禁**：每张卡 PR 只看三样——`--compare` 表格、卡上列的 PNG、commit message 的"发现"段。
- **何时更新 baseline**：只在人看过 PNG 确认"确实更好看"之后，`--save-baseline`，单独 commit。
- **什么时候该怀疑方案**：如果 P3 做完 80/96 仍然要靠 pass 修，或者 P5 首版轨道分配让 F10 反而上涨且找不到原因——那时再回来讨论，不要在 P1 阶段就下结论。
