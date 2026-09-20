# 布局美观度诊断（2026-09-19）

> 本文是现状诊断与方案决策的**结论摘要**；逐张可执行的任务卡见
> [`aesthetics-roadmap-2026-09-19.md`](./aesthetics-roadmap-2026-09-19.md)。
> 依据：`check:layout` 全量 98 fixture + 16 张代表性 PNG + elk-placement /
> lane-constrainer / edge-router / pipeline 结构走读。

## 一、方案没错，卡在三处结构性执行

数据：老 fixture 01–45 硬标准全 0；56 个新压力 fixture 只有 8 个脏，全聚在
4 个 bug 族（详见 `fixture-stress-findings-2026-06-12.md`）；软指标 24/98
不达标。即 **"画得对"已解决，"画得好看"停滞**。

"ELK 摆节点 + 自研 stage 做 BPMN 决策"的大方向是对的——v1 JVM hook、
v2.0/2.1 纯模板都已证伪，不回头。美观上不去是三件事：

### 1. 分片布局后拼接

主图一次 ELK，每个 boundary handler 子图再跑 mini-ELK 然后整体平移。
片与片之间一旦有边（handler 链汇回主流、handler 节点属于某条 lane），
就出 N 形回头、节点出 lane、负坐标。典型是 80："正常履约"横穿整条
handler 链，"履约汇聚"掉到左下角。

![80 handler 链汇回主流被拆成两个坐标系](../out-bpmn-png/80-boundary-handler-long-chain-merge.png)

这类问题再加多少后处理 pass 都修不干净，**根因是两半各算一套坐标**。

### 2. ELK 的结果只用了 X，Y 和边全丢掉重算

lane-constrainer 665 行重写 Y；edge-router 2200+ 行按 edgeType 套模板再
跑一串 nudge pass（`layout-lessons.md` 第 7 条已记录 pass 互相打架）。
没有全局目标（交叉数 / 拐点 / 长度），每条边只看自己。典型是 101：入
join 的边穿过测试任务那一列，`构建` 被甩到远低于 fork 网关的位置；
39/54 的驳回走廊骑着首行 task 中线跑；56/90 同源扇出 label 100% 叠放。

![101 八路并行缠线、构建掉出主干](../out-bpmn-png/101-cicd-parallel-rollback.png)

### 3. 尺子太钝

F1–F9 里没有边交叉数、拐点数、空白率；F1/F3 把语义上必须回头的边也算
进分母，回边 fixture 天然 fail、掩盖真问题。没有 baseline 文件，任何
"美观优化"都无法自证不退步——**便宜模型尤其需要这个**，否则它只能说
"看起来好了"。

## 二、方案：6 个 Phase

| Phase | 目标 | 难度 | 收益 |
|---|---|---|---|
| 0 尺子 | F1/F3 剔回边；新增 F10 交叉、F11 拐点、F12 骑行段、F13 空白率、F14 主干拐点；`--save-baseline` / `--compare` | 低 | 使后面能被便宜模型安全做 |
| 1 硬 bug | 清 4 个 bug 族（lane 为 boundary 预留净空、多 boundary 撑宽 host、handler 负坐标、同源 label 错开） | 低–中 | 98 fixture 硬标准归 0 |
| 2 拆 pipeline | 按 `refactor-runpipeline-phases.md` 拆 `runPipeline`，XML 逐字节不变为 oracle | 低 | P3 的前置 |
| 3 去分片 | handler 节点并入主 ELK（BE→entry 边喂 ELK 时改成 host→entry，模型顺序让 handler 落下方），删掉 mini-ELK + 平移 | 中 | **最大**：80/96/77/83 一族消失 |
| 4 主干对齐 | 抽共享 `spine.ts`；先试 ELK `priority.straightness` 一行配置；不够再加 `spine-aligner` 小 stage | 中 | F2 归 0，修 101 的"构建掉下去" |
| 5 路由升级 | 层间隙竖直轨道分配 + 行间走廊轨道，替代 channel.ts 固定偏移；每接管一类边就删对应 pass | 高 | **第二**：交叉 / 骑行 / label 叠放从源头消失 |
| 6 宽高比 | lane 内长链 snake 折行（71 的 30:1） | 中 | F4 |

执行顺序：**P0 ∥ P1 → P2 → P3 → P4 ∥ P5 → P6**。
预期收益排序：P3 > P5 > P4 > P1 > P6。

## 三、执行提醒

- 卡 1.3 / 1.5 是 P3 之前的临时修，P3 做完就删；P3 排得近可直接跳过。
- 已证伪、不要走的路：ELK partition、fork elkjs、serializer 兜底、
  按 fixture id 特判。
- **baseline 只在人看过 PNG 之后手动更新**——这是防止便宜模型"用尺子
  过 CI"的唯一门禁。
- 什么时候该回头怀疑方案：P3 做完 80/96 仍要靠 pass 修，或 P5 首版让
  F10 反而上涨且找不到原因。在那之前不必下结论。

## 四、执行进度记录

> 每张卡完成后在此追加一行：日期 / 卡号 / 结果（规则从几到几）/ commit。

- [x] P0 卡 0.1 F1/F3 剔语义回边（F1 8→1、F3 17→5；e833ab0）
- [x] P0 卡 0.2 F10–F14 新指标（F14 换行边免 2 弯；e833ab0）
- [x] P0 卡 0.3 baseline + `--compare`（bootstrap baseline 已存 docs/layout-baseline.json；e833ab0）
- [x] P1 卡 1.1 lane boundary 净空（82/99 N2/N3→0；96 BE 修好；7cdf22b）
- [x] P1 卡 1.2 多 boundary 撑宽 host（83 B1 2→0、E4 3→2；b758886）
- [x] P1 卡 1.4 同源扇出 label 错开（56/90 L3→0；8ae19aa）
- [x] ~~P1 卡 1.3 handler 负坐标~~ **跳过**（P3 同 session 完成，临时修不需要）
- [x] ~~P1 卡 1.5 handler re-snap lane~~ **跳过**（P3 后自然归位）
- [x] P2 拆 runPipeline（12 phase + runStage 权威 ICE 归属；XML 指纹逐字节不变；a9c448a）
- [x] P3 去分片（spike+合并一次完成：handler 并入主 ELK + yHint 压下方 + BE 骑边侧/label 侧跟随；**硬标准 98 fixture 归 0**；8aa6676）
- [x] 用户目检修复：boundary→handler「先潜后横」（80 的 flow_bd_h1 沿 host 底边跑 100px → 潜行道 3 点 L；F12 80 归 0；91f0e2d）
- [x] 用户目检修复②：BE 出边三形态细化（浅窗直行/深窗近侧/深窗底边）——77 的 handler 与 BE 同排改零 stub 两点直行进左边；80/13 同化为两点直行；全量 98 PNG 重渲染（697de56）
- [x] 用户目检修复③（33/62/72/88，c594d09 / 697de56 / 188fee3）：
  - 33：补偿 association 端点按主导方向选互对边（不再底→顶向上钩回）
  - 62：分支 L 中段撞节点时侧边出逃 Z（紧急通道处理 改右边出）
  - 72：并行 join ≥5 路走竖直总线（busifyParallelJoinToGateway，与 fork 侧镜像）；
    fan-in 归一走廊补同款总线中间档
  - 88：长 label 三件套（task 撑宽 ≤220、event label 封顶 200 换行、边 label 诚实盒 ≤160 换行）
- [ ] 遗留待人审：89 的 3 处 L3（假盒时代的既有拥挤被诚实盒首次量到；视觉比 baseline
  时代更整齐，两版 PNG 存档对比过；真修归 P5 的全局 label 排布——多段重试与 X 滑动
  两个局部实验都实测无效已回滚，别再走这条路）
- [ ] P4 主干对齐——卡 4.2（ELK straightness 一行配置）**实测后放弃**：101 全好但 04/13/14/17/21/65 明显变差，不符「04 不能变差」验收，已完整回滚。待做：卡 4.3 spine-aligner 独立 stage、4.4 扇出对称
- [x] P5 卡 5.0 pass 盘点（→ docs/edge-router-pass-inventory.md：8 后处理 pass +
     4 前置决策的位置/证据/冲突/P5 去留映射）
- [x] P5 前置小卡：BE 潜行道 F12 骑行守卫（dive-first 加 rides 检查 + 逐级再潜；
     F12 14/23/83 归 0；代价 83 F10 +2、F11 微涨全在阈值内；83 PNG 目检通过）
- [ ] P5 卡 5.1 竖直轨道 → 5.2 行间走廊 → 5.3 删 pass
- [x] P6 第一批（2026-09-20，aa14fa0）：lane 内纯链 snake 折行——71 F4 30→2.1（验收锚点
     远超达成）；行方向透出（nodeRowDir）+ RTL 锚点翻转 + evaluator F1/F3/F9 行感知。
     守卫：带 BE / 有外联边 / 非纯链的 lane 不折（35 实测全线抖）。
- [x] P6 第二批（2026-09-20，2baf12a）：无 lane pool 的**环链**折行——compactor 的
     linearOrder 跳过语义回边取链序（backEdgeIds 由 pipeline 从 BackEdgeResolver 透传），
     45/47/48/49/100 折成两行：F4 5.6/6.2/7.7/10.7/6.7 → 1.5/1.6/1.9/2.5/3.3，
     F14 全部 → 0，F10 48 6→3。固有代价：F13 空白率升至 0.61–0.83（末行不满，阈值内）。
     55 未触发（下轮单独看）；5 张 PNG 已目检（carriage-return 读感顺畅、回边走廊干净）。
- [x] 尺子修正（2026-09-20，3d34688）：F1/F3 只数同排边（|Δcy|≤60，对齐 F9 的换排豁免）。
     依据：F3 全库回头分子实测 0 条同排、30 条全跨排——跨排 X 跨度是行宽决定的
     carriage-return，不是 N 形回头。F3 全库归 0（含 45 折行后的 16.7% fail）；
     F1 折行 fixture 回 1。新单测钉住两侧（跨排豁免 / 同排仍被抓）。
- [x] 用户目检修复④（47 的 重新清洗 起终点选错，07e9020）：BackEdgeResolver 回边集透传
     classifier（几何 dx≤0 代理漏判折行后同列情形 → forward-step 退化成 9 点绕行）；
     配套 back-row-up/down 共享 channel bucket 错开行间走廊中段（47 三条曾全叠 y=220）。
     8 个 fixture 路由变化全目检：回边统一顶出底进、走廊横线错开。
- [x] P6 第三批（2026-09-20，c4ad89e）：胖成员链折行——节点数门槛量不到 74 的 5 节点
     2100px subprocess 并排链；加绝对行宽通道（len≥4 且 W>1600 且 aspect>7，比长链严一档
     吸收 pool padding 口径差，73 的 6.5 假阳性实测回退）。74 F4 10.4→3.1、76 8.9→2.0。
- [x] P6 第四批（2026-09-20，b9da371）：互不相连子图网格重排——93 双链 F4 8.0→1.9。
     触发用含 pool 框估计（(W+124)/(H+64)，与 evaluator F4 实测吻合）>6 才动；
     列数取宽高比最接近 2:1。20 的 5+1 事件子流程网格本来及格，确认不误伤。
- [ ] P6 剩余族的明确决策（2026-09-20）：
  - **55 接受现状**（6.32 刚超线；单链含 subprocess 折行会断开容器，读感反而差）
  - **77/80/81 暂缓**（主链+handler 双链配对折行 = 高风险手术：BE 净空、dive-first
    走廊、骑边侧都会受影响；6.2/7.0 刚超线且双带形态读感清晰，收益不抵风险）
  - **88 暂缓**（链中带网关分叉，折行需分叉感知断行——单 fixture、复杂度高、
    现渲染可读；留给将来真有需求时做 branch-aware wrap）
  - **F13×40 空白率**（下一个大块；折行 fixture 的末行不满已把 5 个推到 0.8 附近，
    行均衡/末行补齐应与此一并考虑）

### 下一轮工作块的任务规格（人审通过当前状态后启动）

> 启动前置：`docs/layout-baseline.json` 已按 P0–P3 后的 PNG 状态由人手动更新
> （`--save-baseline` + 单独 commit）。之后每张卡以 `--compare` 自证不退步。

**P4 卡 4.3 —— 已尝试并关闭（2026-09-20，负结果）**。三个变体全部实测：
① median 拉直：49 项软指标变差 + 3 硬违例，101 因密集列 fits 全回退反而完全不生效；
② mode 行拉直：30 项变差（F2/F11/F14 全面抖动）；③ 最短路径 spine + ≥40px 离群 +
start/end 不可动 + 众数占比 ≥70% + 最多拉 2 个 + 弯数自验收：安全但归零（唯一两个
触发点 07 改善/89 变差都被自验收正确裁决，最终 no-op）。根因数理：单词离群
（101 的「构建」）已被 P3+目检修复清零；剩余 F14 债全是**整段离行**（环体/handler
段整体在第二行）——拉单点两头造台阶，拉整段就是 median 版的全库损伤。
**F14 的 14 个 fail 归 P5 路由层**（多行流程的边走法），不是摆位问题。
spike 代码在 git 历史（本次会话未提交）。以下原规格留档：

**P4 卡 4.3 spine-aligner（原规格，已按上述结论关闭）**
- 位置：ELK 之后、Compactor 之前，新 `src/stages/spine-aligner.ts`（经 stages/index.ts re-export）。
- 主干判定：图级 start→end 最重路径（卡 4.1 的定义；回边不算——evaluator 已有同款
  BFS 可参照）。lane-constrainer 的 lane-local 主干判定语义不同（lane 成员内 X 序最长链），
  不要强行合并（P3 commit message 有记录）。
- 只对**无 lane 的 pool** 生效（有 lane 的归 lane-constrainer）：spine 节点 Y 统一到加权
  中位数；每层非 spine 节点保持原侧别向外推；每步做 N1 检查，撞就回退该节点。
- 验收：F14 fail 归 0 或接近 0；101 PNG 主干一条直线、构建回到 fork 网关同 Y；
  F10 不涨；04 不能变差。
- 卡 4.4 扇出对称随后：fork 奇数分支中间支与网关同 Y，偶数上下各半；验收 04/56/57/101。

**P5 路由升级（最大剩余收益：101 缠线、F8/F12 残余、pass 减半）**
- 卡 5.0 先只读盘点 `edge-router/index.ts` 全部 pass → `docs/edge-router-pass-inventory.md`。
- 卡 5.1 层间隙竖直轨道分配（接管同 pool forward 边）：从节点 X 反推层，间隙内按
  (y_from, y_to) 冲突图分配轨道 x；edge label 放独占轨旁（L3 同源叠放从源头消失）。
  验收：F10 ≤ baseline 且 101/56/57/59 明显下降；F12 101/56 归 0；硬标准 0。
- 卡 5.2 回边/跳边的行间走廊轨道（内环内轨，间距 ≥12px）；48/47/49/54 验收。
- 卡 5.3 每接管一类删一个对应 pass；目标 index.ts ≤ 600 行。
- 已知交互点：dive-first 的 BE 潜行道（697de56）与 fan-in 归一走廊（busifyFanInToSink）
  是两条"自带走廊语义"的边类，轨道分配接管 forward 边时不要抢它们。

**P6 宽高比（F4 的 12 个 fail）**
- lane 内纯串行长链 snake 折行（lane-constrainer 的 MULTI_ROW_* 已有基础）；
  71 ≤ 8:1 为验收锚点。
- P3 新增的三张（77/80/81）是 handler 链单层展开拉宽：先评估是否该让 handler 链
  在无 lane pool 里参与折行（wrapLinearChain 目前因无边节点介入而 return null）。
- F9 要顺带改成按行判定（snake 第二行 X 是反的，roadmap 卡 6 已注明）。

### 当前状态（P3 完成时）

- **硬标准：98 fixture 全 0**（起点：24 处违例 / 8 fixture 脏）。
- 软指标：F3 剩 3 fail（06/09 线性链回退、69 pingpong——真问题）；F4 12 fail
  （含 P3 新增 77/80/81，卡 3.2 已预告归 P6）；F14 14、F13 40（新尺子照出的全库
  稀疏/主干抖动，归 P4/P6）；F12 3、F8 2（归 P5）。
- **待人审 PNG 后更新 baseline**：`bun run check:layout --save-baseline docs/layout-baseline.json`
  + 单独 commit（roadmap §0 规则 8）。重点看：80/96/23/13/83/99/56。
- compare 门显示的 31 项软指标「变差」逐项归属：F4 77/80/81/13（P6）、F14 17/21/23/81
  （P4）、F10 14/83（P5）、F8 13/23（P5）、F12 101/56（P5）、F2 99（P1 BE 净空的
  固有代价，0.109 远低于 0.30 阈值）、F11/F13/F4 小幅波动（P3 架构变化的正常重排）。
