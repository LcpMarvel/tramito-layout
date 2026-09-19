# Test Fixtures

测试用例按从简单到复杂的顺序组织，便于理解和调试。

## 📗 基础流程 (01-04)

| 序号 | 文件名 | 说明 |
|------|--------|------|
| 01 | `01-simple-process.json` | 最简单的线性流程 |
| 02 | `02-all-tasks.json` | 所有任务类型 |
| 03 | `03-all-events.json` | 所有事件类型 (含 terminate/cancel/multiple 等) |
| 04 | `04-all-gateways.json` | 所有网关类型 |

## 📘 工件与数据 (05-07)

| 序号 | 文件名 | 说明 |
|------|--------|------|
| 05 | `05-artifacts.json` | 基础工件 (数据对象、注释) |
| 06 | `06-artifacts-extended.json` | 扩展工件 (Group、关联方向) |
| 07 | `07-data-io-specification.json` | 任务IO规范 (ioSpecification 可视化) |

## 📙 循环与多实例 (08-10)

| 序号 | 文件名 | 说明 |
|------|--------|------|
| 08 | `08-loop-standard.json` | 标准循环 |
| 09 | `09-multiinstance-tasks.json` | 多实例任务 |
| 10 | `10-multiinstance-subprocess.json` | 多实例子流程 |

## 📕 边界事件与定时器 (13-15)

| 序号 | 文件名 | 说明 |
|------|--------|------|
| 13 | `13-boundary-events-all.json` | 所有边界事件类型 (timer/error/message/signal/escalation/conditional/cancel) |
| 14 | `14-timer-variants.json` | 所有定时器配置 (timeDate/timeCycle/timeDuration) |
| 15 | `15-link-events.json` | Link 捕获/抛出事件对 |

## 📓 子流程 (16-21)

| 序号 | 文件名 | 说明 |
|------|--------|------|
| 16 | `16-subprocess-embedded.json` | 基础嵌入子流程 |
| 17 | `17-subprocess-transaction.json` | 事务子流程 |
| 18 | `18-subprocess-adhoc.json` | Ad-hoc 子流程 |
| 20 | `20-event-subprocess-variants.json` | 所有触发类型的事件子流程 (Message/Timer/Signal/Escalation/Conditional/Error) |
| 21 | `21-subprocess-variants.json` | 折叠/嵌套(3层)/带边界事件的子流程 |

## 📒 调用活动 (22-23)

| 序号 | 文件名 | 说明 |
|------|--------|------|
| 22 | `22-call-activity.json` | 调用活动 (latest/version/deployment 绑定、多实例调用) |
| 23 | `23-call-activity-boundary.json` | 带边界事件的调用活动 |

## 📔 协作与泳道 (24-31)

| 序号 | 文件名 | 说明 |
|------|--------|------|
| 24 | `24-collaboration-simple.json` | 简单协作 |
| 25 | `25-collaboration-black-box.json` | 黑盒池 |
| 26 | `26-collaboration-lanes.json` | 基础泳道 |
| 27 | `27-collaboration-nested-lanes.json` | 嵌套泳道 |
| 28 | `28-collaboration-many-lanes.json` | 多泳道 |
| 29 | `29-collaboration-message-flows.json` | 消息流 |
| 30 | `30-participant-options.json` | 参与者多实例/封闭选项 |
| 31 | `31-cross-pool-patterns.json` | 复杂跨池模式 (请求-响应) |

## 📕 高级模式 (32-35)

| 序号 | 文件名 | 说明 |
|------|--------|------|
| 32 | `32-event-gateway-parallel.json` | 并行事件网关 |
| 33 | `33-compensation-flow.json` | 补偿流程 |
| 34 | `34-global-task.json` | 全局任务 (GlobalUserTask/ManualTask/ScriptTask/BusinessRuleTask) |
| 35 | `35-voc-cross-lane.json` | 跨泳道流程 (多泳道、跨泳道连线、空泳道) |
| 36 | `36-voc-vop-capture-process.json` | VOC/VOP捕获流程 (黑盒池、消息流、多泳道并行分支) |
| 37 | `37-crm-voice-process.json` | CRM客户服务流程 (3泳道、多边界事件、跨泳道连线、消息事件、独占/包容网关) |

## 📐 布局压力 — 回边/循环 (46-55)

| 序号 | 文件名 | 说明 |
|------|--------|------|
| 46 | `46-self-loop.json` | task 自环 |
| 47 | `47-interleaved-loops.json` | 交错（非嵌套）双回边 |
| 48 | `48-triple-nested-loops.json` | 三重嵌套驳回环 |
| 49 | `49-long-backedge.json` | 8 层长 spine 末端回首 |
| 50 | `50-backedge-into-gateway.json` | 回边 target 是上游 gateway |
| 51 | `51-boundary-retry-loop.json` | error boundary 重试环 |
| 52 | `52-cross-lane-updown-backedges.json` | 同图双向跨 lane 回边 |
| 53 | `53-loop-around-subprocess.json` | 回边绕开 expanded subprocess |
| 54 | `54-mega-reject-fanin.json` | 7 级审批 8 边汇入同一 task（fan-in bundling 压测） |
| 55 | `55-loop-body-subprocess.json` | 循环体是 subprocess 本身 |

## 📐 布局压力 — 分支密度 (56-62)

| 序号 | 文件名 | 说明 |
|------|--------|------|
| 56 | `56-superfanout-8way.json` | 单 gateway 8 路扇出全带条件 label |
| 57 | `57-diamond-nested-3.json` | 三层嵌套菱形 |
| 58 | `58-unbalanced-branches.json` | 1 vs 7 节点不平衡分支 |
| 59 | `59-gateway-chain.json` | gateway 直连 gateway 链 |
| 60 | `60-all-edge-labels.json` | 全图每条边带中文 label |
| 61 | `61-inclusive-partial-merge.json` | inclusive 部分汇合再总汇合 |
| 62 | `62-default-flows-dense.json` | 3 个相邻 gateway 的 default flow 密集区 |

## 📐 布局压力 — Lane/Pool (63-72)

| 序号 | 文件名 | 说明 |
|------|--------|------|
| 63 | `63-three-level-nested-lanes.json` | 3 层嵌套 lane |
| 64 | `64-ten-lane-waterfall.json` | 10 lane 垂直瀑布 |
| 65 | `65-max-lane-span.json` | lane1 直连 lane8 跨 6 lane |
| 66 | `66-multiple-empty-lanes.json` | 多个空 lane 夹层 |
| 67 | `67-five-pool-collab.json` | 5 pool + 7 messageFlow |
| 68 | `68-blackbox-middle.json` | 黑盒 pool 夹中间、msgflow 跨越 |
| 69 | `69-message-pingpong.json` | 双 pool 6 轮请求-响应 |
| 70 | `70-messageflow-endpoint-mix.json` | msgflow 端点：节点/黑盒边界混合 |
| 71 | `71-single-lane-long-process.json` | 单 lane 26 节点纯串行（折行/宽高比压测） |
| 72 | `72-lane-height-fanout.json` | 中间 lane 内 6 路扇出撑高 |

## 📐 布局压力 — Subprocess (73-79)

| 序号 | 文件名 | 说明 |
|------|--------|------|
| 73 | `73-subprocess-5-level.json` | 5 层全展开嵌套 |
| 74 | `74-three-subprocess-siblings.json` | 3 个 expanded subprocess 并排 |
| 75 | `75-subprocess-internal-loop.json` | subprocess 内部回边环 |
| 76 | `76-collapsed-expanded-mix.json` | 折叠/展开交替 4 个 |
| 77 | `77-boundary-handler-with-subprocess.json` | boundary handler 链含 subprocess |
| 78 | `78-event-subprocess-backedge-mix.json` | event subprocess + 主流回边同框 |
| 79 | `79-subprocess-tall-in-lane.json` | lane 内高大 subprocess 撑 lane 连锁 |

## 📐 布局压力 — Boundary/Artifact (80-87)

| 序号 | 文件名 | 说明 |
|------|--------|------|
| 80 | `80-boundary-handler-long-chain-merge.json` | 6 节点 handler 链汇回主流 |
| 81 | `81-boundary-handler-upward.json` | handler 汇入上方分支 |
| 82 | `82-boundary-near-lane-bottom.json` | boundary 骑 lane 底边（B1 vs N2 冲突） |
| 83 | `83-five-boundaries-one-host.json` | 1 task 挂 5 个 boundary（溢出压测） |
| 84 | `84-dataobject-star.json` | dataObject 被 4 task 星形读写 |
| 85 | `85-annotation-on-edge.json` | annotation 关联 gateway（关联 edge 不被校验支持，已降级） |
| 86 | `86-group-cross-lane.json` | group 框跨 lane 节点 |
| 87 | `87-datastore-cross-pool.json` | dataStore 跨 pool 共享读写 |

## 📐 布局压力 — Label/退化形态 (88-95)

| 序号 | 文件名 | 说明 |
|------|--------|------|
| 88 | `88-long-chinese-labels.json` | 全图 25+ 字长中文 label |
| 89 | `89-mixed-cjk-latin-labels.json` | 中英混排 label |
| 90 | `90-event-gateway-six-catch-labels.json` | event gateway 6 catch 分支长 label |
| 91 | `91-minimal-start-end.json` | 最小图 start→end |
| 92 | `92-isolated-node.json` | 孤立节点（校验接受，静默编译） |
| 93 | `93-disconnected-subgraphs.json` | 两条不连通链（校验接受） |
| 94 | `94-multi-start-mesh.json` | 4 start 网状汇合 2 end |
| 95 | `95-terminate-mid-branch.json` | terminate end 在分支中间 + 回环 |

## 📐 布局压力 — 综合业务场景 (96-101)

| 序号 | 文件名 | 说明 |
|------|--------|------|
| 96 | `96-ecommerce-return.json` | 电商退货：4 lane 双驳回环 + timer boundary 升级 |
| 97 | `97-loan-tiered-approval.json` | 贷款三档不平衡分支 + 驳回回边 |
| 98 | `98-recruitment-interview-rounds.json` | 招聘：双 pool + 加面循环 + 4 messageFlow |
| 99 | `99-ticket-sla-escalation.json` | 工单 SLA：逐级非中断 timer boundary 跨 lane 升级 |
| 100 | `100-manufacturing-rework-nested.json` | 制造返工：subprocess 内外嵌套双环 |
| 101 | `101-cicd-parallel-rollback.json` | CI/CD：8 路并行测试 + 失败长距离回滚回边 |

---

## 覆盖率

| 类别 | 状态 | 说明 |
|------|------|------|
| 事件 | ✅ 100% | 含 terminate/cancel/multiple/parallelMultiple |
| 任务 | ✅ 100% | 所有 8 种任务类型 |
| 网关 | ✅ 100% | 含 complex gateway |
| 子流程 | ✅ 100% | embedded/transaction/adhoc/event-triggered |
| 边界事件 | ✅ 100% | 所有 7 种类型 (中断/非中断) |
| 工件 | ✅ 100% | DataObject/TextAnnotation/Group/Association |
| 补偿 | ✅ 100% | compensation handler + boundary + throw |
| 协作/泳道 | ✅ 100% | 含嵌套泳道、消息流、跨泳道连线 |
| 定时器 | ✅ 100% | timeDate/timeCycle/timeDuration |
| 调用活动 | ✅ 100% | 含边界事件、多实例 |
| 全局任务 | ✅ 100% | 4种全局任务类型 |

## 不支持

| 类别 | 说明 |
|------|------|
| Choreography | bpmn-js 不支持编排图渲染 |
| Conversation | bpmn-js 不支持会话图渲染 |

## 运行测试

```bash
cd packages/bpmn-elk-layout
bun run test                              # 运行所有测试
bun run test -- -t "01-simple"            # 运行特定测试
bun run test -- -u                        # 更新快照
```

测试运行后会在 `test/__screenshots__/` 目录生成 PNG 截图，可用于视觉验证。
