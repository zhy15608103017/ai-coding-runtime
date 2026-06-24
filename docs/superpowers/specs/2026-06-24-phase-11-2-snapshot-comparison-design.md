# Phase 11.2 Snapshot Comparison 设计

**目标：** 增加一个只用于报告和分析的 snapshot comparison 能力，用来比较两个 routing history snapshot，让用户理解导入或积累历史之后，学习信号、推荐置信度、成本模式和路由风险发生了什么变化，并为未来 advisory routing 做准备。

## 背景

Phase 11.0 已经增加了本地 shadow learning profile 和 shadow recommendation。Phase 11.1 又增加了隐私安全的 routing history export/import，并使用带 schema version 的 snapshot 文件承载历史学习证据。现在用户已经可以移动学习历史，但还缺一个关键能力：

```text
导入这些历史之后，到底发生了什么变化？
```

如果没有 comparison，用户只能看到最终的 `learningProfile`。他们很难判断哪些 task bucket 增加了证据、哪些 recommendation 发生了变化、cheap tier 的置信度是否变高、失败率是否上升，或者导入历史是否带来了噪声。

Phase 11.2 必须保持观察型能力。它解释历史信号变化，但不影响 routing、execution、verification、retry、provider selection 或 policy。

## 推荐方案

实现 **Learning Profile Comparison**。

Runtime 读取两个 Phase 11.1 routing history snapshot，分别基于 snapshot records 生成 `learningProfile`，然后比较两个 profile。这样输出的是面向学习和路由决策的领域差异，而不是普通 JSON diff。

推荐这个方案的原因：

- 复用现有 learning model，不引入第二套指标系统。
- 比较 routing 相关概念，例如 buckets 和 recommendations。
- 不受 snapshot 字段顺序或无关 metadata 变化影响。
- 保持 Phase 11.1 的隐私边界，因为 snapshot 已经经过 sanitization。
- 为未来 advisory routing 提供可解释证据。

## 备选方案

### 普通 Snapshot JSON Diff

逐字段比较两个 JSON 文件。

这个方案实现简单，但价值低。用户看到的是结构变化，而不是学习意义。普通 diff 可以告诉用户 records 变了，却不能说明 confidence 是否提高、失败风险是否增加、recommendation 是否反转。

### Report 文件 Diff

先生成导入前后的完整 runtime report，再比较 report。

这个方案上下文更多，但会把当前 run 的细节和历史学习变化混在一起。Snapshot comparison 应该独立于某一次具体运行。

### Import 后比较 Store 状态

把 snapshot 导入本地 store，然后比较导入前后的 learning 状态。

这个方案更接近真实工作流，但有副作用，也更难信任。Phase 11.2 应该是纯分析：输入两个文件，输出 comparison，不写 store。

## 范围

Phase 11.2 包含：

- 增加一个比较两个 routing history snapshot 的 runtime comparison module。
- 校验两个输入都使用 `ai-coding-runtime.routing-history.v1`。
- 分别基于两个 snapshot 生成 learning profile。
- 输出 bucket 级别的指标 delta。
- 检测 recommendation added / removed / changed。
- 输出 risk 和 confidence summary。
- 增加 JSON 和 Markdown 输出的 CLI 命令。
- 增加 comparison 行为、隐私、异常输入和无 runtime side effect 的测试。

Phase 11.2 不包含：

- 导入 snapshot 到本地 store。
- 修改已有 imported history。
- 改变 routing decision。
- advisory routing。
- automatic routing。
- HTTP 或 MCP comparison endpoint。
- UI chart。
- 普通 JSON diff 模式。
- raw prompt、source、patch、stdout、stderr 的比较。

## CLI 形态

增加 `history compare` 子命令：

```bash
ai-coding-runtime history compare before.json after.json --json
ai-coding-runtime history compare before.json after.json --markdown
```

默认人类可读输出应该是 Markdown，因为 comparison 是解释型输出。`--json` 输出稳定的机器可读对象。

无效用法应该列出支持形式：

```text
history compare requires two snapshot file paths.
Usage:
  ai-coding-runtime history compare <before.json> <after.json> [--json|--markdown]
```

## Comparison 输入

两个输入都必须是 Phase 11.1 snapshot：

```json
{
  "schemaVersion": "ai-coding-runtime.routing-history.v1",
  "records": []
}
```

`history compare` 不要求 snapshot 已经被 import。它不应该读取或写入 `FileExecutionStore`。

如果任意 snapshot 格式错误：

- 返回清晰错误。
- 不输出部分 comparison。
- 不写入 store。

V1 应该拒绝未知未来 schema version，而不是静默比较。

## Comparison 输出

JSON 输出：

```json
{
  "schemaVersion": "ai-coding-runtime.snapshot-comparison.v1",
  "generatedAt": "2026-06-24T00:00:00.000Z",
  "before": {
    "records": 10,
    "eligibleSamples": 8,
    "recommendations": 2
  },
  "after": {
    "records": 20,
    "eligibleSamples": 17,
    "recommendations": 4
  },
  "summary": {
    "recordDelta": 10,
    "eligibleSampleDelta": 9,
    "recommendationDelta": 2,
    "newRecommendations": 2,
    "removedRecommendations": 0,
    "changedRecommendations": 1,
    "riskFlags": []
  },
  "bucketChanges": [],
  "recommendationChanges": [],
  "riskFlags": []
}
```

Markdown 输出：

```text
# Routing History Snapshot Comparison

## Summary
- records: 10 -> 20 (+10)
- eligible samples: 8 -> 17 (+9)
- recommendations: 2 -> 4 (+2)

## Recommendation Changes
- added: implementation/L2/standard -> consider_cheaper_tier
- changed: documentation/L1/standard confidence low -> medium

## Bucket Changes
- implementation/L2/standard: success 60% -> 86%, retry 20% -> 8%

## Risk Flags
- none
```

## Bucket Diff 模型

使用稳定 identity 比较 learning buckets：

```text
bucket.type + canonical(bucket.key)
```

对每个匹配 bucket 计算 delta：

- `sampleCount`
- `successRate`
- `failureRate`
- `retryRate`
- `escalationRate`
- `verificationFailureRate`
- `malformedWorkerOutputRate`
- `providerFailureRate`
- `averageEstimatedCost`

对于新增 bucket：

- 标记 `changeType: "added"`。
- 包含 after metrics。

对于移除 bucket：

- 标记 `changeType: "removed"`。
- 包含 before metrics。

对于变化 bucket：

- 标记 `changeType: "changed"`。
- 包含 before、after 和 delta values。

对于未变化 bucket：

- 默认输出中省略。
- 只有未来单独设计 `--all` 选项时才包含。

V1 不增加 `--all`。

## Recommendation Diff 模型

使用稳定 identity 比较 recommendations：

```text
bucket.type + canonical(bucket.key)
```

跟踪：

- 新增 recommendation。
- 移除 recommendation。
- action 变化，例如 `hold` 变成 `consider_cheaper_tier`。
- confidence 变化。
- reason 变化。
- sample count 变化。

Recommendation changes 比 raw bucket changes 更面向用户，Markdown 输出中应该先展示。

## Risk Flags

当 comparison 发现潜在不安全或噪声历史变化时，生成 warning 风格的 flags：

- `sample_size_low`：after snapshot 对某个 changed recommendation 仍然样本不足。
- `failure_rate_increased`：可比较 bucket 的 failure rate 至少上升 0.15。
- `retry_rate_increased`：retry rate 至少上升 0.15。
- `escalation_rate_increased`：escalation rate 至少上升 0.10。
- `recommendation_regressed`：recommendation 从 cheaper 或 hold 退化到 stronger tier。
- `cost_increased`：两侧都有 cost data 时，average estimated cost 至少上升 25%。
- `signals_mixed`：success rate 改善，但 retry 或 escalation rate 也明显上升。

Risk flags 只用于解释，不影响 runtime 行为。

## 隐私与安全

Snapshot comparison 不能包含：

- raw request text
- prompt text
- source contents
- patch contents
- command output
- model responses
- environment variables
- provider credentials

因为 Phase 11.1 snapshot 已经被 sanitization，Phase 11.2 只应该处理 sanitized snapshot records。它不接受 raw run records 作为 compare 输入。

Comparison module 必须是纯函数式分析：

- 不读 store。
- 不写 store。
- 不产生 import side effect。
- 不产生 routing side effect。
- 不产生 execution side effect。

## 模块设计

新增一个聚焦的 runtime module：

```text
src/runtime/history-comparison.js
```

职责：

- 校验两个 snapshot object。
- 基于 snapshot records 生成 learning profiles。
- 规范化 bucket 和 recommendation identity。
- 计算 summary deltas。
- 计算 bucket changes。
- 计算 recommendation changes。
- 计算 risk flags。
- 格式化 Markdown comparison output。

`src/runtime/history.js` 继续负责 export/import。`src/runtime/report.js` 继续负责 report generation。Comparison 有独立职责，应该保持单独模块，并且保持纯分析。

预期公开函数：

```javascript
export function compareRoutingHistorySnapshots(beforeSnapshot, afterSnapshot, options = {}) {}
export function formatSnapshotComparisonMarkdown(comparison) {}
```

这些函数需要从 `src/index.js` 导出，供测试和未来 integrations 使用。

## CLI 集成

扩展 `src/cli.js` 里的 `historyCommand`：

```text
history export
history import
history compare
```

`history compare` 应该：

1. 读取两个 JSON 文件。
2. 解析两个 snapshot。
3. 调用 `compareRoutingHistorySnapshots`。
4. 当传入 `--json` 时输出 JSON。
5. 默认输出 Markdown，或当传入 `--markdown` 时输出 Markdown。

该命令不应该创建 `FileExecutionStore`。

## 错误处理

Comparison 应该给出可操作错误：

- 缺少 before path：`history compare requires two snapshot file paths.`
- 缺少 after path：`history compare requires two snapshot file paths.`
- JSON 无效：包含文件路径和 parse failure。
- schema 不支持：包含实际 schema value。
- records 格式错误：拒绝整个 snapshot，而不是静默比较部分数据。

和 export 不同，comparison 不应该跳过 malformed records。它是分析工具，静默比较部分数据会误导用户。

## 测试策略

增加测试覆盖：

- 比较两个 valid snapshots 会输出 summary deltas。
- added bucket 会出现在 `bucketChanges`。
- success、retry、escalation rate 的变化能被计算。
- added recommendation 会出现在 `recommendationChanges`。
- confidence change 会出现在 `recommendationChanges`。
- failure、retry、escalation、cost 上升时会产生 risk flags。
- Markdown 输出包含 summary、recommendation changes、bucket changes 和 risk flags。
- CLI `history compare before after --json` 可用。
- CLI `history compare before after --markdown` 可用。
- malformed 或 unsupported snapshots 会清晰失败。
- compare command 不写 imported history，也不写 local runs。
- comparison output 不包含 raw prompt、source、patch、stdout、stderr 内容。

## 验收标准

- 用户可以比较两个 routing history snapshot 文件，并且不需要导入任意一个。
- comparison 解释 learning-significant differences，而不是普通 JSON changes。
- recommendation changes 清晰可见。
- changed、added、removed buckets 的 metric deltas 清晰可见。
- risk flags 能突出噪声历史或回归信号。
- comparison 没有 store、routing、execution、provider 或 verification side effects。
- 输出同时支持 JSON 和 Markdown。
- comparison 保持 Phase 11 隐私边界。

## 后续路径

Phase 11.2 之后：

- Phase 11.3 可以在有需求时增加 `history compare --against-store`。
- Phase 11.4 可以基于 comparison evidence 设计 advisory routing。
- Phase 12 UI 可以直接可视化 comparison output，而不需要理解 snapshot 内部结构。
