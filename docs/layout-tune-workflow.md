# Layout Tune Workflow（编辑器手调 → AI 对比 → 修算法）

这是和 [`layout-fix-workflow.md`](./layout-fix-workflow.md) 并列的另一条修复闭环。区别：

- **layout-fix-workflow**：用户给一段 JSON + **文字描述**问题 → 沉淀 fixture → 修。
- **layout-tune-workflow（本文）**：用户在**编辑器里把布局手调成理想样子**并保存 → AI 用「自动 vs 手调」的**坐标 diff** 反推该改哪个 stage → 修 *算法*。

适用于"说不清但一看就别扭"的布局问题（多是 F 类软指标 / metrics 抓不到的"丑但合规"），靠手调出 ground truth 比文字描述高效。

## 闭环四步

### 1. 手调（用户）

```bash
bun run editor          # http://localhost:3737，watch 模式
```

选 fixture → 自动布局渲染 → 拖拽节点 / 改连线到理想样子 → **保存到 out-tuned**。保存产物：

```
out-tuned/<fixture>/
  input.json     # 原始 ELK-BPMN 源（= fixtures/<fixture>.json）
  edited.bpmn    # 手调后的 BPMN（含 DI 坐标）= 理想基线
  meta.json      # 保存时间 + 当时的 check 摘要
```

> dev server 不热重载浏览器：改了 `src/` 后要手动刷新页面、重选 fixture 才会用新代码重新布局。

### 2. 对比（AI）

```bash
bun run tuned:diff                 # 所有 out-tuned/* 
bun run tuned:diff 41              # 只看 41 开头
bun run tuned:diff --json          # 机器可读
```

`tuned:diff` 用**当前代码**重新编译 `input.json` 得到自动布局，和 `edited.bpmn` 逐节点 / 逐边对比。每条差异分三类：

- **节点位置差异**：手调把节点挪到哪（`auto(x,y) → tuned(x,y) Δ(dx,dy)`）。
- **边路由差异**，带标记：
  - `★` 手调更简洁（自动**过度绕路**）→ **router 待修**。
  - `✓` 自动更简洁（自动**已反超**手调）→ 不用改，去第 4 步重存基线。
  - `·` 同段数但几何不同（手调挪了路点）→ 看是不是更优。

退出码：有「待修」差异 → 1；全部一致或自动已反超 → 0。

### 3. 读 diff → 定位 stage → 改算法（AI）

按差异**形态**反推责任 stage（不要给单个 fixture 打坐标补丁）：

| diff 形态 | 多半是什么问题 | 优先看 |
| --- | --- | --- |
| 节点 Δ **同号批量平移**（一组节点整体上移/下移/左移） | 容器尺寸 / lane 高 / 空带 / pool 堆叠偏移 | `lane-constrainer.ts`、`pool-composer.ts`、`pool-overflow-rebalancer.ts` |
| 节点 Δ 改变**相对顺序 / 列对齐** | 摆位（X=flow rank）/ spine 居中 | `elk-placement.ts`、`lane-constrainer.ts` |
| 边 `★` **手调更少点**（绕路/倒退/贴线） | router 过度走廊 / 端点选择 / 净空 | `edge-router/path-shaper.ts`、`channel.ts`、`anchor.ts`、`index.ts` |
| 边末段没垂直进入 / 端点浮空 | 端口 / tail-stub | `edge-router/index.ts`（finalize）、`anchor.ts` |

修复原则（与项目根 CLAUDE.md 一致）：

- **改算法不改单点**：手调揭示的是*一类*几何应该怎么走，把它写成 stage 里的判据（带触发条件 + 回退），不是硬编码这一条边的 waypoints。
- **早抛少兜底**：判据不成立时回退到原有路径，不要静默写一个凑合值。
- **stage 只传 plain data**，`pipeline.ts` 只编排。

### 4. 验证 + 收敛 + 重存基线（AI）

```bash
bun test
bunx tsc --noEmit
bun run fixtures:xml
bun run check:layout            # 硬标准必须 0；软标准不整体退步
bun run tuned:diff <fixture>    # 确认该 fixture 收敛（待修差异清零）
```

- **全量不退步**是硬门槛：router/摆位改动影响所有 fixture，必须跑全量 `check:layout` 并和改前对比（`--json` 存一份 diff）。宁可放过一个手调细节，也不能为追一个 fixture 让别的退步。
- **自动反超后重存基线**：当 `tuned:diff` 显示自动已不弱于手调（全 `✓`），旧的 `edited.bpmn` 就不再代表上限了——在编辑器重新保存一次（或删掉该 `out-tuned/<fixture>/`），免得下次 diff 拿过时基线误导。
- 看 PNG：`bun run fixtures:png` 后用硬标准 E/N/B/L 逐条对照代表性图。

## 已验证案例

- **41-cross-lane-dense**：手调把 4 条 cross-lane 边从"倒退进 lane gap 走廊"的 6 点折线改成干净 L。反推出 `path-shaper.ts` 的 `(top/bottom)→left` 分支应**优先简单 L（两段不撞节点时），撞了才回退走廊**。落地后自动对全部 10 条同类边统一成 L，反超手调。详见 [`layout-lessons.md`](./layout-lessons.md) "不要再走的路"。
- 同一轮还顺带验证了删除 ELK lane partitioning（X 改由 flow 拓扑序决定）——那条是"文字描述 + 坐标 diff"混合推出的。
- **40-fanin-sink-near-lane**：手调揭示两处。①归一束里 `gw_dept`（与 sink 几乎同高）的驳回边起点压在网关身上——反推出 `buildFanInPathVertical` 的 straddle 分支（走廊落在 source Y 跨度内时改水平出）。②同 lane back-edge `f_dept_gw` 的拱冲进上邻 lane——反推出 `keepIntraLaneBackEdgeInsideLane`（把拱夹回 source lane，放在所有 nudge 之后）。两处都是 0 硬 0 软下的 router 形态修正，落地后 39/40/41 的软失败一并清零。残留的"申请人 lane 顶 36px 留白"是 lane-sizing 项（爆炸半径大、纯 cosmetic），未追。
- **36-voc-vop-capture-process**：手调把两条汇入并行汇合网关的 cross-lane 边（`fork_to_join`/`quality_to_join`）从"钻进目标 lane 走廊、骑分隔线横穿全宽 / 7 点乱折"改成"沿源行横穿到 sink.cx、单段竖直入网关"的干净 L。反推出 `path-shaper.ts` 的 `(top/bottom)→left` 分支在**竖直优先 L 被目标 lane 节点挡住**时，应再试**水平优先 L**（`tryHorizontalFirstL`：source.right 横穿到 sink.cx，竖直入 sink 顶/底顶点）——两段都不撞节点才走，否则回退走廊。关键约束：riser 必须落在 sink.cx（gateway 的顶/底顶点），**不能**按 channel 错开 X——E1 只认 bbox 边，偏离顶点的入点落在菱形斜面（bbox 内部）会判 E1 违例；多条边共用这条末段 riser 视觉上自然读成"归一汇入"。auto 原本就 0 硬 0 软（属"丑但合规"），改完两条 cross-lane 边收敛到手调形态，全量零退步，**仅 36 一个 fixture 的 XML 变化**（其余 cross-lane 边要么竖直优先 L 已成、要么水平 L 被挡而回退，门槛收得很紧）。残留 ★（forward-step 的 `*_to_internal`/`related_to_*`、`internal_to_join`）的手调优势主要来自**节点移行**（elk-placement），不属 cross-lane 走廊范畴，未追。

- **36（第二轮，泳道纵向利用 / F2）**：手调揭示营销部 lane 高 219px 但节点全挤在低部一行、上方 ~113px 空着。根因：`lane-constrainer` 的 `buildFlatMetric` 把整条 lane snap 成一行，且 `estimateForwardArchReserveAbove` 为 forward-skip 拱预留了大量上方净空，但 router 实际把那些边走到了节点下方 → 预留落空、节点被压到低行。ELK 其实给了纵向 spread（cy 60→256），但被 lane-constrainer 贪心并行合成一行抹平了，且 ELK 的 Y 受跨 lane crossing-min 干扰（gateway_department 被甩到最顶）不能直接用。反推出 `assignSpineAwareRows`：取同 lane 内**最长前向链**为主干、snap 成一条对齐中心行（保 F5），主干外的分支节点按 ELK cy 落到上/下方、各侧按 X 不重叠贪心打包成行，再交给 `buildMultiRowMetric` 居中堆叠。落地后 36 营销部 lane 主干上移、内销分支 `after_sales` 离行填满泳道；**顺带把 37 的 F2 失败（lane start/end 偏心 43%）清零、41 长宽比 3.5→2.5**，全量 0 硬、软失败 5→4。纯链 lane（无 in-lane 分支）返回 null 回退原逻辑，blast radius 仅 36/37/41。手调把 `after_sales` 放在主干**上方**、算法按 ELK cy 放到了**下方**——同样填满、镜像侧，差异属可接受的次要美观项。

- **38-egg-fried-rice-loop-height（发散网关分叉可见性）**：手调揭示决策网关「尝味是否合格」的两条出边（向上「味道不够」/ 向下「味道OK」）默认都从 right 顶点出、共享同一段水平干线后才在 trunkX 处分叉，视觉上像「一条线晚分叉」，看不清是网关在分支。反推出 `planGatewayForkAnchors`（`edge-router/index.ts`）：gateway 源、≥2 条 forward-step 出边时，把*唯一*一条明显向上的支移到 **top 顶点**、*唯一*一条明显向下的支移到 **bottom 顶点**，各走干净竖直优先 L，让分叉落在网关本体上。窄触发护栏：①某侧恰好一条才移（多条同侧仍走 right bus，否则在同顶点二次重叠）；②目标顶点未被该网关其它边占用——**loop-back 入边常占 top**（fixture 38 `flow_47` / 16 `flow_41`），故 38 的上支保留 right、下支走 bottom；③移动后 L 两段不撞节点，否则保留原 forward-step。关键约束同 36：分叉只能落在 top/bottom **顶点**（bbox 边中点），不能沿菱形斜面错开——偏离顶点会判 E1。落地后 38 两叉清晰分开，且 `flow_48`/`flow_28`/`flow_42` 从 4 点 Z 收成 3 点 L（反超手调）；**顺带让 04/32/42 等所有 3 路网关对称扇出**（上→top、中→right、下→bottom，spine 居中），全量 0 硬零退步、F2 不变。残留手调 `flow_46` 想把上支也偏到 right 上斜面（1289,640）——E1-invalid（tuned 基线 27 违例之源），不可追，已用 bottom 支分开达成同等可读性。

- **37-crm-voice-process（双向网关对的回边侧进）**：手调揭示「审核问题工单」⇄「审批问题工单」两网关间的一对反向边——正向「批准」（review→approve，cross-lane-down）和回边「拒绝」（approve→review，cross-lane-up）——被 router 叠在同一条 `target.cx` 竖直走廊上（x=267），两条线重合、两个标签压在一起，看不出是两条边。反推出 `planReversePairAnchors`（`edge-router/index.ts`）：检测 2-cycle（A↔B 反向对），把其中 cross-lane-up 的回边改从**侧面**进 target——沿 source 自己的 cx 竖直、横入 target 朝向 source 的那侧（source 在右→`target.right`），正向边保留原走廊，两条各占独立 X 自然分开。配套把 `path-shaper.ts` 的 `(top/bottom)→left` 竖直优先 L 分支推广到 `→right`（镜像，approachX 反向）。窄触发护栏：①回边须 cross-lane-up 且有反向兄弟边；②两节点 cx 错位 ≥ SHAPER_MARGIN（对齐时侧进无益、竖直仍叠）；③侧面 L 两段不撞节点，否则保留原走廊。落地后 37 两边收敛到手调形态（`tuned:diff` 全等），**blast radius 仅 37 一个 fixture**，全量 0 硬零退步。残留 37 的 F3（backtracking）是审批/驳回回路固有的 back-edge，非本项范畴。

- **41-cross-lane-dense（网关分支 label 贴网关）**：手调把网关分支边的条件 label（充足/不足/已发货/派送失败）从「最长段中点」挪到「紧贴网关、谁分出来一眼可见」——这是 BPMN 惯例（决策条件标在决策点旁）。auto 的 `label-placer.pickLabelPosition` 默认取最长非端点段的中点，gateway 出边的最长段常在远处，label 飘到线中段。反推出 `pickLabelPosition` 加 `anchorNearSource` 选项 + `pickNearSource`：取靠 source 的第一段、沿线从 source 端外移 ~22px 取锚点，再按 L2>L3 优先级（先贴线 perp 小、再贴网关 alongShift 小、两侧都试）选最干净落点。`merger.placeEdgeLabel` 在 source 为 gateway 时开启该选项。落地后 41 四个 gateway label 收敛到手调位置（个别选了镜像侧，同样贴网关且无重叠，属可接受）；blast radius = 所有带 gateway 分支 label 的 fixture（04/07/22/28/32/33/34/37/38/39/40/41/42），全量 0 硬零退步、软不变。注意此项只改 **edge label** 摆位，gateway **name** label 仍由 `diagram-builder.placeGatewayLabelsOffEdges` 管，互不影响。

## 注意

- `out-tuned/` 是**开发期 ground truth**，可入 git（和 fixture 一样是可复现资产）；`out-xml/`、`out-bpmn-png/` 是产物。
- 手调基线会过时：算法进步后旧 `edited.bpmn` 可能比自动还差（见 41）。`tuned:diff` 的 `✓` 标记就是提醒重存。别把过时基线当上限。
