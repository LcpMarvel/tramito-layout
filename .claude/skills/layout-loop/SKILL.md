---
name: layout-loop
description: 布局自演化闭环——Sonnet 出题生成 ELK-BPMN JSON，编译渲染后由 Opus 视觉评审，产出排序的可复现缺陷清单（report-only，不自动改代码）。当需要主动挖掘 tramito-layout 的布局缺陷、压测新拓扑、或不想靠人肉看图发现问题时使用。
---

# layout-loop：布局自演化闭环

这个 skill 让编译器**自己挖布局缺陷**,不靠人肉枚举。一次运行 = 出题 → 渲染+客观体检 → 视觉评审 → 聚合报告。**report-only**:只产出缺陷清单 + 把暴露 bug 的题升级成 fixture,**绝不自动改 layout 代码**(修复是人/下一轮的显式决定)。

分工:**Sonnet 出题**(便宜、要多样)、确定性脚本做骨架(可复现)、**Opus 评审**(贵、眼力准)。

## 参数

`$ARGUMENTS` 可含:题量(默认每类 2 题)、压力类别筛选。无参数时跑默认全类别、每类 2 题。

## Phase 1 — 出题(Sonnet,并行)

压力类别(轮转覆盖,每类一个 Sonnet subagent):
`fan-in-common-sink`(多条边汇一个 sink/驳回回环)、`cross-lane-dense`(多 lane 频繁跨越)、`nested-lanes`、`many-pools-messageflow`、`boundary-heavy`(一个 host 挂多个 boundary)、`gateway-spine`(多 gateway 分叉/合并)、`long-loop-back`(长链回退)。

对每个类别,用 **Agent 工具、`model: "sonnet"`** spawn 一个 subagent,prompt 要点:
- 参照 `fixtures/26-collaboration-lanes.json`、`fixtures/39-approval-reject-merge.json` 的 schema(collaboration/participant/lane/children/edges、`bpmn.type`、节点 `width/height`、`labels`)。节点尺寸:task 100×80、event 36×36、gateway 50×50。
- 针对本类别生成 N 个**结构合法、能被 validateGraph 通过**的 ELK-BPMN JSON,写到 `fixtures/zzfuzz-<类别>-<i>.json`(扁平、`zzfuzz-` 前缀=临时,已 gitignore)。
- 题要**多样且能压到该类别的痛点**(例如 fan-in 类:让 3~5 条边指向同一节点;cross-lane 类:让主流频繁上下穿 lane)。
- 返回写出的文件名清单(JSON 数组)。

收集所有 Sonnet 写出的 `zzfuzz-*` 名字。

## Phase 2 — 编译 + 渲染 + 客观体检(确定性)

```bash
bun run scripts/run-xml.ts <zzfuzz 名字...>      # JSON → out-xml/<name>.bpmn（编译失败=ICE，记下，是 bug）
bun run scripts/render-bpmn.ts <zzfuzz 名字...>  # → out-bpmn-png/<name>.png
bun run scripts/check-layout.ts <数字筛选不便,用 --json 跑全量后过滤 zzfuzz>
```
注意 `check-layout` 的 fixture 数字筛选不认前缀名;直接 `bun run check:layout:json > /tmp/loop-eval.json` 后在结果里挑 `zzfuzz-*`。记录每题的硬违例数 + 软 F1-F8 值。**编译期 throw 的题**单列(可能是 ICE,即编译器 bug,价值最高)。

## Phase 3 — 视觉评审(Opus,并行)

对每个成功渲染的 `zzfuzz-*`,用 **Agent 工具、`model: "opus"`** spawn 一个 subagent:
- 让它 **Read 该 PNG**(`out-bpmn-png/<name>.png`)。
- 喂入 `docs/prompts/layout-visual-critic.md` 的 prompt 全文 + 该题的客观体检结果(硬违例/软值)。
- 要求按该 prompt 的 JSON schema 返回 findings(severity/ruleId/subject/evidence/suspectedStage/fixHint)。

用 `schema` 选项强制结构化输出。Opus 的重点是**客观尺子没报、肉眼才看得出**的「丑但合规」。

## Phase 4 — 聚合 + 报告(主 agent)

1. 汇总所有 findings + 编译失败 + 客观违例,按 severity(hard > ugly > nit)和复现确定性排序。
2. **升级**:任何**暴露了真实缺陷**(硬违例 / 编译 throw / Opus 判 hard)的 zzfuzz 题,按 `docs/layout-fix-workflow.md` 重命名为正式 fixture `NN-<描述>.json`(取下一个编号),留作回归用例。
3. **清理**:其余 zzfuzz 题及其 `out-xml`/`out-bpmn-png` 产物删除(它们是临时探针)。
4. 产出一份 markdown 报告:`out-ai-debug/layout-loop-report.md`,含:本轮题量/类别、新发现缺陷清单(每条:fixture、ruleId、subject、evidence、suspectedStage、severity)、已升级为 fixture 的清单、建议下一步修哪几个(按 severity)。

**不要改任何 `src/` 下的 layout 代码。** 报告交回,由人决定修复。

## 收尾自检

- 确认 `fixtures/zzfuzz-*` 已清理或升级(不要把一堆 zzfuzz 残留留在 fixtures/)。
- 报告里每条缺陷必须可复现(指明 fixture)+ 有 evidence。
- 若本轮 0 新缺陷,如实写「0 new defects this round」,不要凑数。
