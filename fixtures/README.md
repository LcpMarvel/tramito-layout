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
