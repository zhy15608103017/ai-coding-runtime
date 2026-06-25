# MVP 真实端到端运行

## 目标

本文档记录了 AI Coding Runtime 的第一次 MVP 真实端到端闭环：规划、路由、在需要时请求批准、记录真实的提供商使用情况、应用经过检查的 worker 结果、验证、检查、报告与审计。

## 环境

- 运行时命令：`node ./bin/ai-coding-runtime.js`
- 数据目录：`.ai-coding-runtime`
- 验证命令：`git diff --check` 和 `npm test`

## 提供商配置

- 使用的提供商：`openai-compatible`
- 使用的模型：`gpt-5.4`
- `provider-health` 的 selected-provider 结果：`openai-compatible` 状态为 `configured`，且对模型 `gpt-5.4` 的 `ok: true`。
- 非真实提供商边界：`local` 仅以 `local-placeholder` 形式可用，且未用于本次运行。
- 显式生成调用的提供商使用量：`391 tokens`
- 密钥处理：凭证来自本地已忽略的配置或环境变量，本文档中不记录。

## 用户请求

`Only modify docs/mvp-real-e2e.md to document one MVP real end-to-end AI Coding Runtime run. Include goal, environment, provider configuration without secrets, user request, plan, approval, model call, worker-result application, verification, inspect, report, audit, result, and lessons. Do not modify src/ code.`

## 运行

- 运行 ID：`run_20260625062843589_eckzgq`
- 任务 ID：`T-003`
- 初始运行状态：`approval_required`
- Worker 结果状态：`applied`
- Runtime 验证状态：`passed`

## 计划

对于这个仅修改文档的请求，Runtime 规划了六个任务。该计划将提交边界限制在 `docs/mvp-real-e2e.md`，并在廉价、标准和高级层之间进行任务路由：

- T-001 和 T-002：廉价的规划/上下文任务。
- T-003：用于编辑 MVP 端到端文档的标准文件编辑任务。
- T-004 和 T-005：标准/廉价的辅助审查与总结任务。
- T-006：高级最终验证任务。

计划中的策略与预算检查均被允许，没有任何违规项。

## 批准

本次运行最初停在 `approval_required`。在继续执行由提供商支持的任务之前，已通过 Runtime 的批准流程进行了显式批准。

## 真实提供商证据

Runtime 针对此次运行和该任务记录了一次由提供商支持的生成调用。

响应摘要：

```text
记录一次真实的端到端运行会提升信任，因为它表明系统不仅在理论上可行，而且确实能在现实条件下正常工作。
```

## Worker 结果应用

该文档文件通过 `ai-coding-runtime worker-result --apply` 创建，以便 Runtime 能在应用补丁前，根据任务契约验证该补丁。

## 已修改文件
- docs/mvp-real-e2e.md

## 验证

- `git diff --check`：通过。
- `npm test`：通过。记录到的通过行：`# pass 233`。
- Runtime 验证状态：`passed`。

Runtime 验证命令：

```text
- git-diff-check: passed, exit 0
- test: passed, exit 0
```

## Inspect 摘要

批准后的 inspect 视图显示，该运行已被 Runtime 正确识别，且其运行 ID、任务路由、验收、验证与升级状态与报告中使用的信息一致。inspect 的关键结果是：`T-003` 的 worker 结果已被应用，验证证据已存在，并且该运行在执行 `verify` 后已推进到 `verification_passed`。

## Report 摘要

```text
# AI Coding Runtime Report

Run: run_20260625062843589_eckzgq
Status: verification_passed

## Request
Only modify docs/mvp-real-e2e.md to document one MVP real end-to-end AI Coding Runtime run. Include goal, environment, provider configuration without secrets, user request, plan, approval, model call, worker-result application, verification, inspect, report, audit, result, and lessons. Do not modify src/ code.

## Summary
Planned 6 task(s) for runtime execution.

## Changed Files
- docs/mvp-real-e2e.md

## Model Routing
- cheap: 3
- standard: 2
- premium: 1

## Cost Estimate
- planned routing cost: USD 0
- provider cost: USD 0
- unattributed provider cost: USD 0
- total visible cost: USD 0

## Budget
- allowed: true
- estimated cost: USD 0.33
- estimated calls: 6
- reserved retries: 5
- violations: none

## Policy
- allowed: true
- violations: none

## Routing Trace
- T-001: cheap (L0 default routing tier; low-risk minimum tier; low context requirement; easy verification strength; selected: openai-compatible/gpt-5.4-mini)
- T-002: cheap (L1 default routing tier; low-risk minimum tier; low context requirement; easy verification strength; selected: openai-compatible/gpt-5.4-mini)
- T-003: standard (L2 default routing tier; medium-risk minimum tier; medium context requirement; medium verification strength; file-editing tasks require at least the standard tier; selected: openai-compatible/gpt-5.4)
- T-004: standard (L1 default routing tier; low-risk minimum tier; medium context requirement; easy verification strength; selected: openai-compatible/gpt-5.4)
- T-005: cheap (L1 default routing tier; low-risk minimum tier; low context requirement; easy verification strength; selected: openai-compatible/gpt-5.4-mini)
- T-006: premium (L4 default routing tier; high-risk minimum tier; high context requirement; hard verification strength; final verification always uses the premium tier; selected: openai-compatible/gpt-5.5)

## Per-Task Model Usage
- T-001: cheap/openai-compatible/gpt-5.4-mini planned USD 0, actual USD 0
- T-002: cheap/openai-compatible/gpt-5.4-mini planned USD 0, actual USD 0
- T-003: standard/openai-compatible/gpt-5.4 planned USD 0, actual USD 0
- T-004: standard/openai-compatible/gpt-5.4 planned USD 0, actual USD 0
- T-005: cheap/openai-compatible/gpt-5.4-mini planned USD 0, actual USD 0
- T-006: premium/openai-compatible/gpt-5.5 planned USD 0, actual USD 0

## Model Calls
- calls: 2
- estimated provider cost: USD 0
- openai-compatible/gpt-5.4: 391 tokens, USD 0
- openai-compatible/gpt-5.4: 2046 tokens, USD 0

```

## Audit 摘要

已生成完成运行的审计导出，并对证据做了脱敏处理。完整性元数据如下：

```json
{
  "eventCount": 15,
  "event_count": 15,
  "sha256": "2c4f57b045bcaf59a4b422ab1a79df3c716d7e674b16e4375de9f791c3875fcb"
}
```

## 安全检查

一次单独的、仅文档范围的安全运行故意提交了一个超出 `allowed_files` 范围的 `package.json` 补丁。Runtime 以 `failed` 状态拒绝了该 worker 结果，并保持 `package.json` 未被修改。

安全拒绝证据：

```text
Invalid worker patch: worker.patch.forbidden_file
```

## 结果

这个 MVP 闭环是成功的：验证通过，报告包含路由和模型调用证据，审计导出包含完整性元数据，而边界拒绝检查证明了超出契约范围的文件编辑会被阻止。

## 经验总结

- 保持第一次 MVP 运行范围尽可能小。
- 使用真实的提供商证据，但不要提交凭证。
- 保持原始 Runtime 工件在本地，仅提交这份人类可读的摘要。
- 将生成的运行记录视为本地证据，而不是仓库内容。
