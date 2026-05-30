# 布局实现经验

这份文档只沉淀长期有效的坑和原则，不写路线图、不记录已完成任务。某条经验不再能防止真实绕路时，就删掉。

## 不要再走的路

1. **不要复活 Kotlin/Java ELK 引擎。** v1 依赖 JVM ELK 的内部 phase hook（`ILayoutExecutionListener`），局部节点调整确实好用，但 multi-pool collaboration 没做完，而且 elkjs 没暴露等价 hook。
2. **不要为了拿回 ELK hook 去 fork elkjs。** 维护 GWT 编译产物成本太高。ELK 只当节点摆位 backend，BPMN 规则放在 TypeScript stage 里表达。
3. **不要回到纯 SESE/RPST 模板布局。** v2.0/v2.1 证明，手写模板会在长链、rigid region、lane 重排、subprocess 展开、edge waypoint 复用时失真。
4. **不要混用坐标系。** v2.1 merger 曾经把 pool-local sequence flow 和 absolute message flow 混在一起。当前架构里 edge route 和 serializer waypoint 必须统一用绝对坐标。
5. **不要把 layout fallback 留在 serializer。** serializer 只做 `LayoutedGraph` → BPMN DI 翻译。端点修正、绕障、label 摆位、连接边推断都应在 stage 完成；gateway 菱形相交这类纯渲染几何细节例外。
6. **不要维护长期并行 engine。** 避免 `layout-v3/`、`LAYOUT_ENGINE=v2|v3|compare` 这类运行时分叉。小步替换唯一 runtime 路径，回滚交给 git。
7. **不要用 ELK lane partitioning 控制布局。** 曾给每个节点传 `partition=laneIndex` 想减少跨 lane 穿插，但 ELK partitioning 的语义是"partition i 的所有 layer 排在 i+1 之前"——于是节点的 X(layer) 被绑死成 **lane 的上下顺序**，与流程拓扑序脱钩。流程顺着 lane 往下走时碰巧没事；一旦 zig-zag(流程在 lane 间来回跳，如 41-cross-lane-dense)，主流方向被打乱、回头线满图(F1/F3 崩)。全量验收(39 fixture)证明：**去掉 partition 零硬标准退步，反而修好 4 个 zig-zag fixture**。X 永远交给 ELK layered 的拓扑分层；方向一致性用 start/end 的 `layerConstraint=FIRST/LAST` 保证(它和 partition 互斥，去掉 partition 后才能对 lane pool 生效)；lane 的 Y 由 LaneConstrainer 显式 snap，从来不靠 partition。曾经试过的"按 flow-rank 与 lane-index 相关性 auto 开关 partition"是死路——相关性不预测 partition 是否有害(36 低相关却需要留、37 高相关却需要关)。

## 当前架构原则

1. **ELK 摆节点，自研 stage 做 BPMN 决策。** ELK 负责通用 layered graph placement；lane、pool、boundary event、message flow、port、label、artifact 这些 BPMN 规则由本项目 stage 负责。
2. **stage 之间只传 plain data。** stage 是纯函数，`pipeline.ts` 只负责编排，不写布局算法。
3. **早抛异常，不隐藏 invariant 破坏。** 节点越界、edge endpoint 浮空、lane owner 缺失、容器包不住 children 等问题要暴露出来，不要编一个“看起来还行”的兜底值。
4. **渲染验收是布局开发的一部分。** `bun test` 和 XML 生成不够。布局改动要跑 `fixtures:xml`、`fixtures:png`、`check:layout`，并看代表性 PNG。
5. **硬标准是产品要求。** E/N/B/L 违例是 bug；F 类软指标用于指导优化，但不能单独作为大重构理由。

## 已验证有效的做法

1. **swimlane 的 X 由 flow 拓扑序定，Y 由 LaneConstrainer 显式 snap。** lane 只约束 Y，绝不参与 X(layer) 决策——见"不要再走的路"第 7 条(为什么不能用 partition 把 X 绑到 lane 顺序)。容器尺寸也要显式算，不靠 ELK。
2. **Port-first 能减少端点 bug。** 先决定边进入哪一侧/哪个 anchor，再 shape path；不要先画路径再指望 serializer 修端点。
3. **message flow / association 不能按 sequence flow 处理。** BPMN 语义分类要和几何 EdgeType 分开。compensation association、已对齐 message flow 经常需要 direct/polyline，而不是默认 orthogonal。
4. **label 避障要跳过容器。** pool/lane/process 不应作为 label 障碍物；否则 collaboration 图里的 label 永远找不到合法位置。
5. **boundary event 是 host 几何的一部分。** event 必须骑在 host 边上，handler route 应从这个确定位置出发，而不是从 host 附近的抽象点出发。
6. **诊断产物是可丢弃的。** `out-xml/`、`out-bpmn-png/`、`out-ai-debug/` 只保留 `.keep` 占位，其余本地生成。
7. **后处理 pass 要懂自己的语义目标，别只懂局部约束。** `nudgeHorizontalSegmentsOffDividers` 只懂"离分隔线远"，会把同 lane back-edge 的拱越推越出 lane（fixture 40：拱 127 → 122，更深入上邻 lane）。修法是补一个懂"留在本 lane"的 pass（`keepIntraLaneBackEdgeInsideLane`）并放在**最后**，让它对单纯避线的 pass 有最终否决权。pass 顺序本身就是约束优先级。
8. **fan-in 归一的 riser 在 source 与走廊同高时会退化。** 共 sink 的归一束默认 source 顶/底出竖直 riser 到走廊；当走廊 Y 落在 source 自己的 Y 跨度内（source 与 sink 几乎同高，fixture 40 的 gw_dept），riser 会从节点边折回穿过自己身体。判据：走廊在 `[src.y, src.y+h]` 内 → 改从朝 sink 那侧水平出，省掉 riser（`buildFanInPathVertical` 的 straddle 分支）。

## 未来可能反复出现的压力点

1. **ELK 对 BPMN-specific 二次节点调整仍是黑盒。** 如果 spine 对称、cross-pool X 对齐、boundary handler 定位反复出问题，应新增小的 post-placement stage，不要把补丁散进无关 stage。
2. **长链容易过宽。** F4 aspect ratio 问题通常来自 layered layout 把流程排成一整行。先用 `scripts/diagnose-aspect.ts` 诊断，再决定是否做折行或 spacing 调整。
3. **invariant 检查应逐步靠近 stage。** `check:layout` 能抓最终失败；stage-level self-check 能更快定位责任阶段。
4. **`runPipeline` 仍是 ~800 行单函数，需拆成 phase 函数（F2 剩余）。** 这是后端"没有真正分 pass"的根因，也拖累 ICE stage 归属。完整任务规格与逐字节安全网见 [`refactor-runpipeline-phases.md`](./refactor-runpipeline-phases.md)。
