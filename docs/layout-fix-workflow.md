# Layout Fix Workflow

这个流程用于处理“用户给一段 ELK-BPMN JSON，并指出渲染/布局问题”的日常修复任务。目标是先把问题沉淀成可重复运行的 fixture，再修布局代码，最后用硬标准验证没有引入回归。

## 1. 接收问题

用户需要提供两类信息：

1. 原始 ELK-BPMN JSON。
2. 观察到的问题，例如“连线断开”“节点重叠”“boundary event 没贴住 task”“泳道顺序错了”。

如果问题描述不够具体，先要求补充可观察现象。不要在没有 fixture 的情况下直接改布局逻辑。

## 2. 创建 fixture

在 `fixtures/` 下新增一个编号递增的 JSON 文件：

```text
fixtures/<next-number>-<short-problem-name>.json
```

命名规则：

- `<next-number>` 使用当前最大编号加 1，例如已有 `37-crm-voice-process.json`，下一个就是 `38-...json`。
- `<short-problem-name>` 用小写 kebab-case，描述业务场景或布局问题。
- 只放用户提供的原始 JSON；除非 JSON 语法无效，否则不要顺手“整理”流程结构。

如果用户给的是代码块，去掉 Markdown 包裹后保存。保存后先确认 JSON 能被解析，解析失败时先修正复制/转义问题，并在结论里说明。

## 3. 复现问题

优先只跑新增 fixture，减少噪声：

```bash
bun run scripts/run-xml.ts <fixture-name-without-json>
bun run scripts/render-bpmn.ts <fixture-name-without-json>
bun run scripts/check-layout.ts <fixture-number>
```

示例：

```bash
bun run scripts/run-xml.ts 38-boundary-edge-break
bun run scripts/render-bpmn.ts 38-boundary-edge-break
bun run scripts/check-layout.ts 38
```

必要时生成 AI debug bundle：

```bash
bun run debug:ai 38-boundary-edge-break
```

复现阶段要记录失败属于哪类规则：E 连线、N 节点、B BPMN 视觉规范、L 标签，或 F 软指标。硬标准问题必须修；软标准问题按影响范围判断。

## 4. 定位和修复

先根据问题类型定位 stage：

| 问题类型 | 优先检查 |
| --- | --- |
| edge 端点、穿节点、孤立箭头 | `src/stages/edge-router/`、`src/stages/merger.ts`、`src/serializer/` |
| pool / lane / 多参与者位置 | `pool-composer.ts`、`lane-constrainer.ts`、`pool-overflow-rebalancer.ts` |
| subprocess 尺寸或子节点越界 | `subprocess-layout.ts`、`subprocess-translator.ts` |
| boundary event 贴边或 handler 子图 | `decoration-placer.ts`、`edge-router/` |
| artifact / association / label | `artifact-placer.ts`、`association-router.ts`、`label-placer.ts` |

修复原则：

- 优先修 invariant，不做只针对单个 fixture 的坐标补丁。
- stage 之间只传 plain data，`pipeline.ts` 只编排，不写算法。
- layout 阶段发现无法满足的约束时应早抛异常，不要静默兜底。
- 如果修复改变了既有 fixture 行为，要确认这是合理泛化，而不是新回归。

## 5. 验证

修完后先验证新增 fixture：

```bash
bun test
bunx tsc --noEmit
bun run scripts/run-xml.ts <fixture-name-without-json>
bun run scripts/render-bpmn.ts <fixture-name-without-json>
bun run scripts/check-layout.ts <fixture-number>
```

然后跑全量布局验证：

```bash
bun run fixtures:xml
bun run fixtures:png
bun run check:layout
```

布局代码或 trace/debug 类型有变化时，保留 `bunx tsc --noEmit`；包入口、导出或构建配置有变化时，再跑 `bun run build`。

## 6. 版本与发布

当本次修复需要发布 npm 包时，先根据当前代码变化决定 `package.json` 版本号，再发布。

### 6.1 判断版本号

先看本次实际改动范围：

```bash
git --no-pager status --short
git --no-pager diff --stat
git --no-pager diff -- src test fixtures package.json README.md docs
```

按 SemVer 选择版本：

- `patch`：布局 bugfix、edge/router 纠偏、fixture 回归用例、内部重构、性能优化、文档/测试补充，且不改变公共 API。例：`2.2.2` → `2.2.3`。
- `minor`：新增向后兼容的公共 API、debug/trace 输出能力、可选配置项，或调用方可见的新能力。例：`2.2.3` → `2.3.0`。
- `major`：破坏性变更，包括 `layoutBpmnXml()` 入参/返回值不兼容、导出入口变化、输出 XML 语义不兼容、运行时要求升级且旧环境不可用。例：`2.3.0` → `3.0.0`。

如果只有文档或测试变化，默认不发布；只有在用户明确要求发布时才更新版本。

### 6.2 更新 `package.json`

只改 `version` 字段，不要顺手改依赖或发布配置：

```bash
bun -e 'const p = await Bun.file("package.json").json(); p.version = "<next-version>"; await Bun.write("package.json", JSON.stringify(p, null, 2) + "\n")'
```

更新后确认：

```bash
git --no-pager diff -- package.json
```

### 6.3 发布前验证

布局代码变更发布前必须完成：

```bash
bun test
bunx tsc --noEmit
bun run build
bun run fixtures:xml
bun run fixtures:png
bun run check:layout
```

发布脚本自身也会跑 `bun test`、`bunx tsc --noEmit`、`bun run build`；如果刚刚已经跑过完整验证，仍优先保留脚本默认验证，除非明确需要加 `--skip-verify`。

### 6.4 发布

先 dry-run 看包内容：

```bash
bun run publish:cnb:dry-run
```

确认无误后发布：

```bash
bun run publish:cnb
```

不要在命令行内联 `CNB_TOKEN=...`；token 应从 shell 环境或 `.env` 读取。如果发布报版本已存在，停止并重新按 SemVer 选择下一个合适版本，不要覆盖已发布版本。

## 7. 交付结论

交付时说明：

- 新增的 fixture 文件名。
- 用户报告的问题是否已复现。
- 修复涉及的关键 stage 或模块。
- 新增 fixture 和全量 layout check 的结果。
- 如果发布了版本，说明发布的包版本号。
- 如果仍有未达标项，明确是哪条规则、哪个 fixture、还差什么。

不要只说“测试通过”。布局修复必须以 fixture、PNG 渲染和 `check:layout` 结果为准。
