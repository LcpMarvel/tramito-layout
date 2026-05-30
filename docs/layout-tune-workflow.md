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

## 注意

- `out-tuned/` 是**开发期 ground truth**，可入 git（和 fixture 一样是可复现资产）；`out-xml/`、`out-bpmn-png/` 是产物。
- 手调基线会过时：算法进步后旧 `edited.bpmn` 可能比自动还差（见 41）。`tuned:diff` 的 `✓` 标记就是提醒重存。别把过时基线当上限。
