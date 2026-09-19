# 压力 fixture 扩充与现状盘点（2026-06-12）

> 来源：按拓扑/布局压力维度系统性穷举缺口后，新增 56 个 fixture（46–101，分 7 类），
> 全部通过 `validateGraph` 并编译成功（零 ICE），随后全量 `check:layout` 盘点现状。
> 本文是问题清单与嫌疑定位，**尚未修复**。
>
> 复现：`bun run fixtures:xml && bun run check:layout --hard`
> 渲染单图：`bun run scripts/render-bpmn.ts <fixture-name>`

## 结论速览

老 fixture（01–45）硬标准保持 0，无回归。新 fixture 暴露 **8 个脏 fixture、24 处硬违例**，
聚成 4 个 bug 族；另有 2 个软标准问题和 2 个前端（validator）观察。

| # | 问题 | 规则 | 触发 fixture | 嫌疑点 |
|---|------|------|--------------|--------|
| 1 | boundary handler 出边 waypoint 跑到画布外（负坐标） | E4 ×6 | 77, 80, 83 | decoration-placer / edge-router 的 boundary-to-handler 路由 |
| 2 | boundary 骑 lane 底边被判出 lane（B1 与 N2 结构性冲突） | N2/N3 ×12 | 82, 96, 99 | lane 高度计算未为 boundary 预留 margin；或 checker 该豁免 |
| 3 | 多 boundary 超出 host 边长，第 4/5 个完全脱离 host | B1 ×2 | 83 | decoration-placer 未处理 host 边长溢出 |
| 4 | 高扇出条件 label 100% 堆叠 | L3 ×4 | 56, 90 | edge-router/channel 的 label 错开只处理平行边 |
| 5 | 单 lane 长串行链宽高比 30:1，折行未生效 | F4（软） | 71（及 49/74/76） | elk-placement 的 wrapping 配置对 lane 内长链不触发 |
| 6 | 回边 fixture 普遍 F1/F3 偏低（71–80%） | F1/F3（软） | 45/47/48/52/54/80 等 | 部分是指标对回边的固有反应，部分确属 N 形回头 |
| 7 | 孤立节点 / 不连通子图被静默接受 | （前端） | 92, 93 | validateGraph 无连通性规则——是否该提诊断待定 |
| 8 | association 不能关联到 edge | （前端） | 85（已降级） | `EDGE_ENDPOINT_MISSING`：端点必须是节点 id |

---

## 问题一：boundary handler 出边 waypoint 负坐标（E4，6 处）

handler 链较长、或同一 host 挂多个 boundary 时，boundary 出边的首段 waypoint
被推到 `x < 0`，跑出声明的画布范围：

```
[E4] 77-boundary-handler-with-subprocess: edge=handler_flow_1 waypoint (-40,282) outside canvas 1130x512
[E4] 80-boundary-handler-long-chain-merge: edge=flow_bd_h1 waypoint (-92,177) outside canvas 998x412
[E4] 80-boundary-handler-long-chain-merge: edge=flow_h1_h2 waypoint (-42,264) outside canvas 998x412
[E4] 83-five-boundaries-one-host: edge=flow_bd_timer_remind waypoint (-236,153) outside canvas 782x344
[E4] 83-five-boundaries-one-host: edge=flow_bd_error_fix waypoint (-72,165) outside canvas 782x344
[E4] 83-five-boundaries-one-host: edge=flow_fix_abort waypoint (-22,264) outside canvas 782x344
```

规律：负偏移量随 handler 子图宽度/boundary 数量增大（83 最多 boundary → 偏到 -236）。
怀疑 handler 子图平移（decoration-placer）后，boundary 出边的绕行 waypoint
仍按平移前的局部坐标参与计算，或绕行方向固定向左、未检查画布左界。

bpmn-js 渲染时会自动 fit 视口，所以 PNG 上不易直接看出，但 DI 坐标已经为负——
下游消费方（编辑器、嵌入渲染）按声明画布裁剪就会截断这些边。

## 问题二：boundary 骑 lane 底边 vs lane 包含（N2/N3，12 处）

B1 要求 boundary 半内半外骑在 host 边上；host 紧贴 lane 底边时，boundary
下半身必然探出 lane，N2/N3 即报违例：

```
[N2] 82-boundary-near-lane-bottom: node=boundary_handle_timeout not inside lane=lane_handling
[N2] 96-ecommerce-return: node=boundary_cs_timeout not inside lane=lane_service
[N2] 96-ecommerce-return: node=task_cs_escalate not inside lane=lane_service   ← 这条是真·节点出 lane
[N2] 99-ticket-sla-escalation: node=boundary_l1_sla not inside lane=lane_level1
[N2] 99-ticket-sla-escalation: node=boundary_l2_sla not inside lane=lane_level2
[N2] 99-ticket-sla-escalation: node=boundary_l3_sla not inside lane=lane_level3
（N3 与上面逐条对偶，共 12 处）
```

两个子问题要分开：

1. **B1/N2 的规则冲突**：boundary 骑边是 BPMN 视觉规范（B1），骑在 lane 底边的
   host 上时与"节点不出 lane"（N2）天然互斥。要么 lane 高度计算给挂了 boundary 的
   host 预留底部 margin（修引擎），要么 checker 对 B1 合规的 boundary 豁免 N2/N3
   （修尺子）。**倾向前者**——lane 留白本来也更好看。
2. **96 的 `task_cs_escalate` 是真问题**：普通 task 被摆出了 lane，与 boundary 无关，
   单独定位（嫌疑：boundary handler 目标节点参与 handler 子图平移后未 re-snap 回 lane）。

## 问题三：5 个 boundary 挂 100px host 放不下（B1，2 处）

```
[B1] 83-five-boundaries-one-host: BE=boundary_approve_signal center=(318,112) not on host=task_approve_contract edge
[B1] 83-five-boundaries-one-host: BE=boundary_approve_escalation center=(358,112) not on host=task_approve_contract edge
```

host 宽 100，5 个 36px boundary 横排需要 ~180px。decoration-placer 把前 3 个挤上
底边后，第 4、5 个直接摆到 host 右侧外面悬空（PNG 上肉眼可见完全脱离）。
可选修法：boundary 多时撑宽 host（N4 允许撑宽）、或溢出到 host 顶边/侧边。
同时 5 个 boundary 的 label（审批催办/合同错误/条款变更/政策更新/严重逾期）
互相压叠，修摆位时一并处理 L3。

## 问题四：高扇出条件 label 堆叠（L3，4 处）

```
[L3] 56-superfanout-8way: labels flow_tier_1_label and flow_tier_7_label stacked (overlap=100%)
[L3] 56-superfanout-8way: labels flow_tier_1_label and flow_tier_8_label stacked (overlap=100%)
[L3] 56-superfanout-8way: labels flow_tier_7_label and flow_tier_8_label stacked (overlap=100%)
[L3] 90-event-gateway-six-catch-labels: labels gateway_event_label and flow_g_pause_label stacked (overlap=100%)
```

8 路扇出的条件 label 全放在 gateway 出口处，多条边在出口共享同一段走廊时
label 完全重合（PNG 上"5千-1万 / 金额<1千 / 50万以上"叠成一团）。
channel.ts 的错开逻辑只对平行边生效，对"同源扇出"的 label 没有避让。
90 还暴露了 node label（gateway 名）与 edge label 的跨类堆叠。

## 问题五（软）：折行对 lane 内长链不生效（F4）

`71-single-lane-long-process`（单 pool 单 lane、26 节点纯串行）宽高比 **30.0**，
阈值 6.0。说明 wrapping 配置在 lane 模式下没有触发——feedback-2026-06-11 修的是
no-lane pool 的误折行，lane 内"该折不折"是它的对偶问题。
同超标：49-long-backedge（10.7）、74-three-subprocess-siblings（10.4）、
76-collapsed-expanded-mix（8.9）、100（6.7）、47/48/55（6.2–7.7）。
注意 74/76 是 subprocess 串排撑宽，折行策略要不要对容器生效需单独权衡。

## 问题六（软）：回边类 fixture 的 F1/F3 偏低

新增回边 fixture（45/47/48/52/54/80 等）F1 主流方向 71–80%、F3 backtracking
15–29%。两类成分混在一起：

- 指标的固有反应：回边本身就是"向后"的边，F1/F3 把它们计入分母会天然压分。
  评估器或许该把已分类为 `back-edge-*` 的边从 F1/F3 统计中剔除。
- 真问题：如 80 的"履约汇聚" gateway 被摆在 handler 链中段下方，
  "正常履约"长边绕全图回头，确属 N 形主线。

先修评估器口径，再看剩余真问题。

## 前端（validator）观察

1. **连通性不校验**（92/93）：孤立节点、不连通子图静默通过并正常编译出 XML。
   按"校验集 = 后端处理不了 ∧ 用户能改"的判据，后端既然能编译，就不该作 error 拦截；
   但对 LLM 自纠场景，孤立节点多半是生成遗漏，值得考虑加 **warning 级**诊断回喂。
2. **association 端点必须是节点**（85）：annotation 关联到 sequenceFlow 报
   `EDGE_ENDPOINT_MISSING`。BPMN 规范允许 association 指向 edge；当前属后端不支持
   且校验正确拦截（分层正确）。若以后要支持，需 edge-router + serializer 同时动。

## 与既有工作的衔接

- **fan-in bundling**（待用户发话开工）：`54-mega-reject-fanin`（7 级审批、8 边汇入
  同一 task）硬标准全过，可与 39 一起作 bundling 前后的对照 baseline。
- **BackEdgeResolver**（feedback-2026-06-11 已修）：46–55 全部硬标准干净，
  回边分类统计正常（back-edge-down-left ×19 等），本次扩充等于给它补了回归网。

## 新 fixture 清单

见 `fixtures/README.md` 的「布局压力」各节（46–101，共 7 类 56 个）。
