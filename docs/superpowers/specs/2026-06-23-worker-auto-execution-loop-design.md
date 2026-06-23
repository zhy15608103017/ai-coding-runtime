# Worker Auto Execution Loop Design

## Goal

Add the first Runtime-owned execution loop so AI Coding Runtime can execute approved worker tasks by calling configured model providers, validating structured worker outputs, applying safe patches, running verification, and returning an auditable report.

This phase closes the biggest remaining gap between the current framework and the original AI Coding Runtime V0 goal: workers should no longer be only host-submitted results. The Runtime should be able to run a constrained worker task itself when explicitly asked to execute.

## Scope

The first version is a single-pass executor. It executes each eligible worker task at most once, then runs verification once. It records escalation evidence when verification fails after cheap or standard workers, but it does not automatically retry with stronger models in this phase.

The feature is explicit opt-in. Existing `runtime_run` behavior remains plan creation and persistence. Automatic file changes happen only through a new execute surface such as `runtime_execute`, `ai-coding-runtime execute <run-id>`, or an HTTP endpoint that clearly says execute.

## Non-Goals

- No hidden execution from `runtime_run` by default.
- No autonomous multi-round retry loop.
- No learning-based routing changes.
- No UI or dashboard.
- No replacement for existing `runtime_submit_worker_result`; the executor reuses it.
- No broad task planner redesign.
- No execution of final review tasks as normal workers.

## Current Architecture Fit

The current codebase already has the key building blocks:

- `createRuntimePlan` creates task contracts and routing metadata.
- `generateModelResponse` calls configured providers and returns normalized model output.
- `createWorkerPrompt` builds task-specific worker instructions.
- `submitWorkerResult` validates structured worker output, checks file allowlists, applies patches, and records worker attempts.
- `verifyRun` runs deterministic verification, task acceptance review, final supervisor review, and escalation metadata.
- `createReport` summarizes cost, routing, workers, verification, failures, and follow-ups.

The new executor should be a small orchestration layer around these pieces, not a replacement for them.

## Proposed API

### Runtime Tool

Add `runtime_execute`.

Input:

```json
{
  "runId": "run_...",
  "apply": true,
  "verify": true
}
```

Defaults:

- `apply`: `true`
- `verify`: `true`

Output:

```json
{
  "runId": "run_...",
  "status": "verification_passed",
  "executedTasks": [
    {
      "taskId": "T-003",
      "modelTier": "standard",
      "provider": "openai-compatible",
      "model": "gpt-example",
      "workerStatus": "applied"
    }
  ],
  "skippedTasks": [
    {
      "taskId": "T-001",
      "reason": "read_only_or_no_allowed_files"
    }
  ],
  "verification": {
    "status": "passed"
  },
  "report": {
    "schema": "ai-coding-runtime.report"
  }
}
```

### CLI

Add:

```bash
ai-coding-runtime execute <run-id> [--no-apply] [--no-verify] [--json]
```

`--no-apply` records validated worker results without applying patches. `--no-verify` skips verification for smoke tests or dry-run integrations, but reports should make skipped verification clear.

### HTTP

Add:

```text
POST /api/runs/:id/execute
```

Body:

```json
{
  "apply": true,
  "verify": true
}
```

### MCP

Expose `runtime_execute` through the existing tool list and JSON-RPC handling.

## Execution Eligibility

The executor should only run tasks that satisfy all of these conditions:

- The run status is `planned`, `approved`, `verification_failed`, or `verification_skipped`.
- The task has at least one `allowed_files` entry.
- The task is not marked `final_verification`.
- The task has acceptance criteria.
- The task has not already had a successful applied or recorded worker attempt, unless a future explicit `rerun` option is added.

Skipped tasks are recorded in the execute result with a reason. They should not be treated as failures by themselves.

Approval still matters. A run in `approval_required` cannot execute until `runtime_approve` moves it to `approved`.

## Provider And Model Selection

The executor should select the provider and model from the routed task metadata where possible:

1. Prefer `task.routing.selected_model` or `task.routing.selectedModel`.
2. Use the selected model's `provider` and `model` fields.
3. Fall back to configured `providers.defaultProvider` and that provider's `defaultModel`.

If no provider or model can be resolved, the worker attempt fails safely and the run records a provider configuration failure.

This phase should not require a new tier mapping config, but the implementation should keep provider resolution isolated so a future `execution.modelTierProviders` mapping can be added cleanly.

## Worker Prompt And Response

The executor should use the existing worker prompt contract and add a strict JSON instruction.

The model response must parse to:

```json
{
  "patch": "diff --git ...",
  "explanation": "What changed and why.",
  "verificationNotes": ["How the worker reasoned about verification."],
  "confidence": 0.8,
  "filesTouched": ["src/file.js"],
  "acceptance": {
    "criterion text": "evidence"
  }
}
```

The executor should first try `response.structuredOutput`, then parse `response.text` as JSON. If neither yields a valid object, it should call `submitWorkerResult` with the malformed value only if doing so records a clear failed worker attempt. If direct submission cannot represent the error cleanly, the executor should record a failed execution event and provider/model trace.

## State And Events

Add explicit events for execution:

- `execution.started`
- `task.execution.started`
- `task.execution.finished`
- `task.execution.failed`
- `execution.finished`
- `execution.failed`

The first version can avoid adding a new persistent status if doing so would ripple through existing verification guards. It may keep the run in its current executable status while task execution is in progress, then verification updates the final status.

If a task fails before verification, the overall execute result should return `status: "failed"` and include the failed task. The run should remain inspectable through `runtime_collect` and `runtime_report`.

## Verification

When `verify` is true, the executor calls the same verification path as `runtime_verify` after all eligible tasks have either succeeded or been skipped.

Verification remains the final gate:

- Passed verification can produce a successful execute result.
- Failed verification blocks success and records existing escalation metadata.
- Skipped verification must be explicit in the execute result and report.

## Error Handling

Provider errors should not crash the process. They should be recorded as failed model calls when a run id is available, and the execute result should identify the failing task.

Malformed worker output should fail the task safely. Existing worker validation errors should be preserved because they already categorize missing patch, missing evidence, forbidden actions, forbidden files, and patch application failures.

Patch application failures must not leave partially applied changes. Existing `applyWorkerPatch` behavior already protects this; the executor should reuse it through `submitWorkerResult`.

Policy violations should keep using existing policy and workspace checks. The executor should not bypass policy for convenience.

## Testing Strategy

Add a new focused test file, such as `tests/execution.test.js`.

Key tests:

- `runtime_execute` refuses `approval_required` runs.
- `runtime_execute` skips read-only and final verification tasks.
- `runtime_execute` calls a deterministic local test provider and applies a valid worker patch through `submitWorkerResult`.
- `runtime_execute` records model usage and worker attempts for executed tasks.
- `runtime_execute` runs verification when `verify` is true.
- `runtime_execute` returns a structured failure when provider output is malformed.
- CLI `execute` calls the runtime tool and prints JSON.
- HTTP `POST /api/runs/:id/execute` exposes the same behavior.
- MCP lists and calls `runtime_execute`.

The tests should avoid real external providers. Use the existing local provider where possible, or inject a deterministic provider/generate function through runtime options if needed.

## Acceptance Criteria

- A user can create a run, approve it when needed, execute eligible worker tasks, verify the result, and get a report without manually submitting a worker result.
- Existing `runtime_run` behavior remains compatible.
- Workers still cannot modify files outside task contracts and policy allowlists.
- Every model call, worker attempt, patch application, verification result, and failure is traceable in the run record.
- `npm test` passes.

## Follow-Up Work

After single-pass execution works, future phases can add:

- model tier to provider/model config mapping
- automatic retry and escalation execution
- planner improvements that produce narrower task contracts
- execution concurrency for independent tasks
- host approval for applying patches after model generation but before file writes
