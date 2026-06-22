# Prompt Library

These prompts are host-neutral. Use them in Codex Desktop, Codex CLI, Cursor, or OpenCode after the Runtime MCP server is connected.

## Plan Only

```text
Use AI Coding Runtime in plan-only mode for this task.
Call runtime_plan or runtime_estimate first, show the task graph, risk, routing, estimated cost, approval status, and verification plan.
Do not modify files and do not submit worker results.
```

Sample file: `examples/prompts/plan-only.md`.

## Cost Optimized

```text
Use AI Coding Runtime for this task and optimize for cost.
Prefer cheap or standard model tiers when the Runtime routing policy allows it.
Show any escalation reason before using a stronger tier, and keep required verification evidence in the final report.
```

Sample file: `examples/prompts/cost-optimized.md`.

## Premium Final Review

```text
Use AI Coding Runtime for this task.
Plan and route according to the Runtime task contracts. Perform any worker changes in the host, submit structured worker results to Runtime, then run verification with premium final review enabled.
Do not report completion until command checks, acceptance review, supervisor review, and escalation status are visible in the Runtime report.
```

Sample file: `examples/prompts/premium-final-review.md`.

## High Risk Require Approval

```text
Use AI Coding Runtime for this high-risk task.
Create the run, show the task contracts and approval summary, and wait for explicit approval before any file-changing worker step.
After approval, submit worker results through Runtime, run verification, and show the final report.
```

Sample file: `examples/prompts/high-risk-require-approval.md`.
