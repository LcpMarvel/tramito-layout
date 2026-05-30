# layout-loop 后续工作交接（下一轮直接读这份）

> 用途:上一轮(fan-in 归一特性 + layout-loop 闭环 + F7/F8 指标)做了一大批,这里记**还没做完的 3 项**的完整上下文,下轮开工直接照着干。done 的部分见文末「已完成基线」。
>
> **2026-05-30 更新:原待办 1/2/3 全部处理完,另加做了「fan-in 走廊自动增高泳道」(见文末「2026-05-30 收口」+「2026-05-30 追加」)。当前全 39 fixture 硬标准 0 违例,177 测试通过,tsc 干净,F7=0,F8 仅剩 1 对(41 密集图,推不开,既有代价)。下一轮若无新缺陷,本文件可只保留「已完成基线」。**

## 背景一句话

`layout-loop` skill(`.claude/skills/layout-loop/SKILL.md`)= 让编译器自己挖布局缺陷的闭环:**Sonnet 出题** → 编译渲染 → 客观体检(`check:layout` E/N/B/L + F1-F8)→ **Opus 读 PNG 评审**(`docs/prompts/layout-visual-critic.md`)→ 报告。上一轮 smoke test 跑通,报告在 `out-ai-debug/layout-loop-report.md`,逮出的 3 道题已升级为 fixture 40/41/42。下面 3 项就是报告里还没修完的。

跑验证的命令:`bun run fixtures:sync`(xml+png 一起重生成)、`bun run check:layout`(看 F 列)、`bun test`、`bunx tsc --noEmit`。改完 layout **必须** render 看 PNG。

---

## 待办 1 —— #12 残留:diverge gateway 的 name 撞 diverging 边的 label  ✅ 已修(2026-05-30)

> **结论**:采用建议 A 的变体。`placeGatewayLabelsOffEdges` 现在两类碰撞都处理:① 顶部被入边占(合并)② 默认上方 name 撞某条出边 label(diverge)。diverge 情形不往两侧挪(往左会撞相邻合并 gateway 的 name、往右会撞分支 task),而是**保持上方居中、把 name 抬高到那条 edge label 之上**——但抬高量受 L1 容差限制(到节点上沿 gap ≤ 26),抬上去会甩离节点的就放弃、退回默认轻微擦边(基线本就容忍)。42 三个网关名现在都和边 label 分开;04/32 不受影响(它们默认上方不撞 edge label,早退)。

**现象**(fixture `42-gateway-merge-labels`):包容分叉 gateway 的 name 标签「包容分叉」和它一条分叉出边的 label「VIP客户」挤在一起,渲染成「包容分叉VIP客户」一坨,分不清哪个是网关名、哪个是分支条件。

**上一轮已修的相邻问题**:`src/serializer/transform/diagram-builder.ts` 新增了 `placeGatewayLabelsOffEdges(shapes, edges)`(在 `createDiagram` build loop 后调用)。它只处理**「gateway 顶部被竖直入边占用」**这一类(合并 gateway 的 name 压在从上方进入的箭头上),占用就把 name 挪到空闲侧(下>右>左,四面皆占则上移并水平错开 shaft)。排他合并 / 并行合并已修好。

**为什么这条没覆盖**:包容分叉是 **diverge**,顶部没有竖直**入**边(它的边是**出**边、且斜着出去),所以 `occupied.has('top')` 为 false,函数直接 `continue`,name 维持默认上方摆放——正好和那条出边的 label 撞。这是 **node-name 撞 edge-label** 的 proximity 问题,不是 node-name 撞箭头。

**建议改法**(二选一或结合):
- A. 扩 `placeGatewayLabelsOffEdges`:除了"顶部被竖直边占用",再判断**默认上方 label bounds 是否和任一 edge-label bounds 相交**(edge label bounds 在 `edges[].label.bounds`,绝对坐标);相交则同样挪到空闲侧。
- B. 更通用:diverge gateway(出度≥2)的 name 默认放**下方**(L1 规范本就是"gateway label 在节点下方"),因为分叉出边的 label 通常在上方/侧方;只有下方被占才上移。
- 注意别回归 04-all-gateways / 32-event-gateway-parallel(它们现在 hard 全 0)。验收:42 渲染里三个网关名都和边 label 分开。

代码锚点:`diagram-builder.ts` 的 `placeGatewayLabelsOffEdges`(就在 `getNodePositions` 之后)、`buildShape` 里 gateway 分支(~659 行)设默认上方 bounds。

---

## 待办 2 —— #13:补 L2/L3 硬检测器盲区  ✅ 已补(2026-05-30)

> **结论**:parser 早已把 node-shape 内嵌 `BPMNLabel` bounds 收进 `p.labels`(按 node id keyed),只是 L2/L3 没用。现在:**L2** 新增"node name label 几何中心落进非 owner 节点 box"判据(容器 pool/lane/subProcess 的 name 不算);**L3** 把 node name label 也纳入两两叠放检测(>50% min-area),容器 name 仍排除。补完跑全量:39 fixture L2/L3 全 0(因待办 1 已把 42 修干净)。已用"把 42 还原成修复前 buggy 位置"验证过检测器**确实**逮得到那条碰撞(`gw_inc_div_label ∥ flow_inc_vip_label` overlap=74% → L3),即客观尺子现在守得住待办 1。

**现象**:layout-loop 在 42 上,客观 `check:layout` 报 **L2/L3 全 0**(干净),但 Opus 肉眼逮到 3 处 label 碰撞(网关名压菱形顶点/压箭头/和边 label 挤)。说明 `src/evaluation/layout-evaluator.ts` 的 L2/L3 检测**漏检了 gateway/node 的 name 标签碰撞**。

**根因**:上一轮**之前**,gateway 不发显式 `BPMNLabel` bounds(bpmn-js 自动摆),所以检测器在 XML 里**看不到** gateway label 的 bounds,无从检测。**上一轮做完 #12 后,合并 gateway 现在会发显式 label bounds**(`diagram-builder` 的 `shape.label.bounds`)——所以现在检测器**能**解析到了,可以补检测。

**建议改法**(`layout-evaluator.ts`):
- 解析每个 `<bpmndi:BPMNShape>` 内嵌的 `<bpmndi:BPMNLabel><dc:Bounds>`(node label bounds),归入 parsed 数据(目前 parser 主要解析 edge label `labelBounds`,见 `EdgeRoute.labelBounds`;node label 可能没解析)。
- **L2**(label 不压节点):node label bounds 不应和**其它**节点的 box 相交。
- **L3**(label 不堆叠):node label bounds 不应和 edge label bounds、或别的 node label bounds 显著相交。
- 也可加一条:node label 不应和**边的 waypoint 段**相交(网关名压箭头)。
- 阈值参考现有 L 类容差。补完后,42(若 #12 没完全修好)应能 hard 报 L2/L3,形成"客观尺子也守得住"。

注意:这是**硬规则**,补强后可能让若干现存 fixture 变红(本来就有的真问题)。按 CLAUDE.md,硬标准违例必须修;所以补检测器要和修 fixture 配套——建议先补检测、看报出哪些,再逐个修(或调容差到合理)。

---

## 待办 3 —— F8 近平行叠线(优先级「次」)  ✅ 部分修(2026-05-30,4 对→2 对)

> **结论**:采用建议 A。`src/stages/edge-router/index.ts` 新增 `nudgeParallelSegmentsApart`(在 `nudgeHorizontalSegmentsOffDividers` 之后调用)。只动**内部水平段**(两端都非首尾 wp,故 E1/E3 不受影响),把近平行的一段推到 ≥12px;推到的新 Y 若**贴泳道线 / 撞节点 / 又和另一条重叠段挤成新近平行**则放弃(防 23 那种"越推越糟"的 whack-a-mole——第一版没这道闸,23 反而从 2 对涨到 3 对)。效果:31 全清,23 从 2 对→1 对,41 不变(密集 cross-lane 推不开)。剩下 23/41 各 1 对在极密集区,任何方向都会撞节点或制造新叠线,按软指标"不为它制造硬违例"原则保留。硬标准 / F7 仍全 0。

**现象**:`check:layout` 软指标 F8 仍 fail 3 个:
- `23-call-activity-boundary`(2 对):`flow_order_timeout_to_merge`@y161 ∥ `flow_payment_error`@y165,dy=5
- `31-cross-pool-patterns`(1 对):两条 messageFlow dy=9
- `41-cross-lane-dense`(1 对):dy=6

都是两条不同 edge 的同向水平段挨太近(dy 5-9px,F8 阈值 10px),叠成糊线。

**根因方向**:`src/stages/edge-router/channel.ts` 的 channel 错开步长 / 分桶——这些边要么不在同一 bucket(没被一起错开),要么 `CHANNEL_GAP` 不够。messageFlow(31)和 call-activity(23)是不同路由路径。

**建议改法**(二选一):
- A. 加一个通用后处理(类似上一轮加的 `nudgeHorizontalSegmentsOffDividers`):检测两条不同 edge 的近平行水平段 dy<10 且重叠,把其中一条的内部水平段推开到 ≥10px(撞节点回滚)。最省、对所有路由通用。
- B. 调 `channel.ts` 让这些边进同一 bucket 并增大错开步长——更"正确"但要分别理解 23/31/41 的边类型。

建议先试 A(和 F7 的 nudge 是同一类后处理,可复用 `routeCrossesObstacles` 回滚机制)。

代码锚点:`src/stages/edge-router/index.ts` 的 `nudgeHorizontalSegmentsOffDividers`(可仿写一个 `nudgeParallelSegmentsApart`)、`channel.ts`。

---

## 已完成基线(上一轮,勿重复做)

- **fan-in 归一特性**:`src/stages/edge-router/bundle.ts`(`detectFanInBundles`,共 sink + gateway 出发的拓扑判据)+ `index.ts` `busifyFanInToSink`(共享单走廊 + 单点进入;**智能入口侧**:优先朝 source 侧水平进入、走廊放 sink 中线开阔行,占用则偏移走廊;**走廊选址避开分隔线 + forward 边段**=③主流优先驳回让路)+ `channel.ts` excludeIds。fixture 39 / 40。
- **F7 通用净空 pass**:`index.ts` `nudgeHorizontalSegmentsOffDividers`——把贴分隔线<8px 的水平边中段推到≥10px,撞节点回滚。修好 35/36/41。
- **指标**:`layout-evaluator.ts` 新增 **F6**(fan-in 归一率,量化收紧到 2px)、**F7**(边-分隔线净空)、**F8**(近平行间距)。接进 `check:layout`。
- **gateway 合并 label**:`diagram-builder.ts` `placeGatewayLabelsOffEdges`(只处理顶部竖直入边那类,见待办 1)。
- **layout-loop skill** + `docs/prompts/layout-visual-critic.md` + 报告 `out-ai-debug/layout-loop-report.md`。
- **产物入库**:`.gitignore` 改为追踪 `out-xml/*.bpmn` + `out-bpmn-png/*.png`;`fixtures:sync` 脚本;`zzfuzz-*` 临时探针 gitignore。

**当前状态**:全 39 fixture 硬标准 0 违例,177 测试通过,tsc 干净。软指标 F6/F7=0 fail;F8=3、F1/F2/F3 为既有语义代价(回退边等)。

---

## 2026-05-30 收口(本轮三项 done)

- **待办 1**(gateway diverge name 撞 edge label):`diagram-builder.ts` `placeGatewayLabelsOffEdges` 扩成两类碰撞;diverge 情形"抬高居中、L1 容差封顶"。42 干净,04/32 无回归。
- **待办 2**(L2/L3 盲区):`layout-evaluator.ts` L2 加 node-label-压别节点、L3 纳入 node name label 两两叠放。已验证能逮回 42 修复前的 74% 叠放。
- **待办 3**(F8):`edge-router/index.ts` `nudgeParallelSegmentsApart`(带防 whack-a-mole 闸)。F8 从 4 对降到 2 对(31 全清 / 23 减半 / 41 不变),硬标准 + F7 仍全 0。

**收口后状态**:39 fixture 硬标准 0 违例,177 测试通过,tsc 干净,F6/F7=0;F8=2 对(23/41 各 1,密集图既有代价);F1/F2/F3 同前。

---

## 2026-05-30 追加:fan-in 驳回走廊自动增高泳道

**现象**(用户指出,fixture 40/39):多级驳回归一的「驳回」走廊+label 贴在泳道分隔线上,文字几乎压线难读。根因:sink(如 task_revise)所在 lane 只按节点尺寸算高,sink 底边到分隔线只有 LANE_PAD(16px),容不下 edge-router 在 sink 下方铺的归一走廊,走廊+label 被挤到分隔线/下一条 lane 上。

**改法**:
- **lane-constrainer 预留走廊净空**:`estimateFanInCorridorReserve`——检测本 lane 含 fan-in sink(被 ≥2 条 backward 边即 source 中心在 sink 右侧汇入的成员),按 source 群所在 lane 相对本 lane 的**顺序**(不是节点 Y——此刻 Y 还是 ELK 原值未 snap,会判反)决定走廊在上/下,在那侧加 `FANIN_CORRIDOR_RESERVE=36` 净空。lane 增高经正常 sizing 路径流到 pool 高度,N2/N3 自洽。新增 `laneIndexOf`(node→leaf lane 序号)plumb 进 `buildLaneMetric`。
- **edge-router F8 后处理顺序修正 + fixed 锚**:lane 增高后走廊上移,正好和主流 forward 步降段并行(40 出现 dy=8 新叠线)。两处修:① `nudgeParallelSegmentsApart` 现在把 fan-in 走廊段当 `fixed` 锚(自身不动,只推可动的主流边让开);② 该 pass **移到 `finalizeRoutePortsForRoutes` 之后**——finalize 的 target arrow tail-stub 会把贴 sink 的水平段再挪几 px 凑 20px 直入,在那之前测 dy 不作数。

**效果**:40/39 驳回文字现在落在 sink 所在 lane 内、离分隔线有净空;F8 从 2 对进一步降到 **1 对**(只剩 41 密集图);硬标准/F7 仍全 0,177 测试通过。代码锚点:`lane-constrainer.ts` `estimateFanInCorridorReserve` / `buildFlatMetric` / `buildMultiRowMetric`;`edge-router/index.ts` `nudgeParallelSegmentsApart`(HSeg.fixed)+ `routeEdges` 调用顺序。
