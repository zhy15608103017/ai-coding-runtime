# First Real Run Sampling Design

**Objective:** Define the first three real runtime runs used to seed Phase 11 learning history in the `ai-coding-runtime` repository.

## Sampling Strategy

Use a coverage-first trio so the first dataset includes:
- one low-risk success-biased run
- one standard execution run with focused test behavior
- one medium-risk run that is likely to require approval

## Selected Runs

### Run 1: Low-risk documentation consistency check
Request:
`请检查 README.md 和 docs/integrations.md 中关于 runtime_execute 的说明是否一致。如果不一致，只做最小文字修正，并补一个简短说明到 report 可读。不要修改 src/ 下代码。`

Purpose:
- get an early successful run
- exercise doc-only planning and execution behavior
- produce a low-risk comparison sample

### Run 2: Standard focused test task
Request:
`为 runtime config 加一条 focused test，验证 openai-compatible provider 的 defaultModel 和 final_review model 会从 runtime.config.json 正常读取。只修改 tests/ 下相关测试文件，保持现有行为不变。`

Purpose:
- create a real code-change execution sample
- exercise test-oriented worker output
- produce a standard-tier verification sample

### Run 3: Medium-risk approval-flow documentation task
Request:
`改进 runtime execute/report 相关文档，使 execute -> verify -> report 的人工操作步骤更完整，并补一条针对 approval_required 流程的 CLI 示例。允许修改 README.md、docs/integrations.md、docs/policy.md。不要修改 src/ 下代码。`

Purpose:
- intentionally include a likely approval-required run
- seed approval, execution, and reporting history together
- create a medium-risk routing sample without touching runtime code

## Success Criteria

1. At least one run stays in the low-risk path and completes execution.
2. At least one run produces a code-change plus verification sample.
3. At least one run enters the approval flow before execution.
4. All three runs generate persistent records under `.ai-coding-runtime/runs`.
5. The trio is cheap enough to repeat after Phase 10.6 hardening.

## Non-Goals

- Maximize model diversity in the first batch.
- Intentionally force provider errors.
- Start Phase 11 learning logic implementation.