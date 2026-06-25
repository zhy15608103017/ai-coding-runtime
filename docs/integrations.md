# AI Coding Runtime Integrations

AI Coding Runtime exposes two integration surfaces in Phase 2:

- stdio MCP: `node ./bin/ai-coding-runtime.js mcp`
- Streamable HTTP JSON-RPC: `POST http://127.0.0.1:3847/mcp`

The HTTP service also exposes REST-style endpoints for scripts and smoke tests.
Phase 5 adds provider adapters for OpenAI-compatible, Anthropic, Gemini, and local placeholder models. `runtime_model_generate` can append usage and estimated cost to a run trace when called with `runId`.
The runtime can also accept structured worker results, validate patch boundaries against task contracts, optionally apply validated text patches, and run the Phase 7 verification engine: command checks, task acceptance review, final supervisor review, and escalation metadata.
Phase 8 adds host-tool setup guides, sample MCP configs, prompt samples, and smoke-test checklists for Codex Desktop, Codex CLI, Cursor, and OpenCode. Start with `docs/integrations/README.md` for the guide index.
Phase 9 expands final reports with changed files, per-task cost attribution, unattributed model usage, routing and escalation reasons, failure categories, trace viewer data, export metadata, and historical model reliability metrics.
Phase 10 adds team policy metadata, secret redaction, file and command allowlists, and completed-run audit export. Host tools should surface `policyStatus.violations`, keep approval gates visible for high-risk work, and use `runtime_audit` through MCP `tools/call` or `GET /api/runs/:runId/audit` when a completed run needs redacted evidence for team review.
Phase 3 responses include task contract validation metadata and a deterministic planning prompt. If a plan contains medium or high risk tasks, `runtime_run` creates a run with status `approval_required`; `runtime_approve` records human approval and moves the run to `approved`.
Phase 4 responses add classifier, model registry, routing policy, budget policy, escalation policy, budget status, policy status, and routing trace metadata. If `budgetStatus.allowed` or `policyStatus.allowed` is `false`, `runtime_run` refuses persisted execution with a policy error.
Explicit read-only planning prompts such as `plan only`, `read-only`, or `不修改文件` produce low-risk task contracts and can be persisted with status `planned`.

## Runtime Tools

MCP tools:

- `runtime_plan`
- `runtime_estimate`
- `runtime_run`
- `runtime_status`
- `runtime_collect`
- `runtime_verify`
- `runtime_report`
- `runtime_cancel`
- `runtime_approve`
- `runtime_provider_health`
- `runtime_model_generate`
- `runtime_submit_worker_result`

`runtime_plan` and `runtime_estimate` include `taskGraph`, `approval`, `validation`, `planningPrompt`, `planReport`, `modelRegistry`, `routingPolicy`, `budgetPolicy`, `budgetStatus`, `policyConfig`, `policyValidation`, `policyStatus`, `escalationPolicy`, and `routingTrace`. When `planning.supervisor.enabled` is configured, they can ask a supervisor model to draft dynamic task contracts before local routing; those plans include `supervisorPlanning` / `supervisor_planning`, and malformed supervisor output falls back to deterministic planning. When `policy.shadowClassifier.enabled` is configured with a provider and model, plan and estimate responses also include `shadowClassifier` / `shadow_classifier` advisory metadata. Shadow classifier output can show potential cheaper-tier savings, safety-floor blocks, and low-confidence ignored recommendations, but it never changes `modelTier`, `routingTrace`, approval, execution, retries, verification, or provider selection. `planReport` is the Phase 3 plan review output for host tools to show before execution.
Use `runtime_provider_health` before real generation to confirm local API key and model configuration. Use `runtime_model_generate` only when the host tool intentionally wants Runtime to call a configured provider directly.
Use `runtime_submit_worker_result` after a run is approved to submit a worker's structured patch result. The worker context pack is built from task `allowed_files` plus read-only `referenced_files`. The result must include `patch`, `explanation`, `verificationNotes`, `confidence`, `filesTouched`, and acceptance evidence for every task acceptance item. Runtime rejects patches outside `allowed_files` and worker results that explicitly include task `forbidden_actions`. Set `apply: true` only when the host tool wants Runtime to apply a validated text patch to the configured workspace.
Use `runtime_verify` for runs in `planned`, `approved`, or `verification_failed`. Runs in `approval_required` should be approved first, then verified. The tool accepts `{ "runId": "...", "verification": { ... } }` when a host wants to override the configured diff/test/lint/typecheck/custom commands or final review settings for a single run.
For read-only planning, include wording such as `plan only` or `不修改文件` when you want a low-risk plan that does not require approval.

## Codex CLI

Full guide: `docs/integrations/codex-cli.md`.

For local development from this repository:

```bash
codex mcp add ai-coding-runtime -- node ./bin/ai-coding-runtime.js mcp
```

For an installed package:

```bash
codex mcp add ai-coding-runtime -- npx -y ai-coding-runtime mcp
```

Then prompt Codex:

```text
Use ai-coding-runtime to plan this task first. Show risk, routing, and estimated cost before execution.
If the Runtime returns approval_required, show me the task contracts and wait for my approval.
```

## Codex Desktop

Full guide: `docs/integrations/codex-desktop.md`.

Use the same MCP command shape as Codex CLI. In Desktop settings, add an MCP server named `ai-coding-runtime` that runs:

```bash
node ./bin/ai-coding-runtime.js mcp
```

When this package is published, use:

```bash
npx -y ai-coding-runtime mcp
```

Recommended prompt:

```text
Use AI Coding Runtime for this task. Plan first, estimate cost and risk, then wait for approval.
If approval is required, do not execute worker tasks yet.
```

## Cursor

Full guide: `docs/integrations/cursor.md`.

Project-level `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ai-coding-runtime": {
      "command": "node",
      "args": ["./bin/ai-coding-runtime.js", "mcp"]
    }
  }
}
```

For the HTTP service:

```json
{
  "mcpServers": {
    "ai-coding-runtime": {
      "url": "http://127.0.0.1:3847/mcp"
    }
  }
}
```

## OpenCode

Full guide: `docs/integrations/opencode.md`.

Local stdio MCP:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ai_runtime": {
      "type": "local",
      "command": ["node", "./bin/ai-coding-runtime.js", "mcp"],
      "enabled": true
    }
  }
}
```

HTTP MCP:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ai_runtime": {
      "type": "remote",
      "url": "http://127.0.0.1:3847/mcp",
      "enabled": true
    }
  }
}
```

## HTTP API

Start the service:

```bash
node ./bin/ai-coding-runtime.js start --host 127.0.0.1 --port 3847
```

Endpoints:

- `GET /api/health`
- `POST /api/plan`
- `POST /api/estimate`
- `POST /api/runs`
- `GET /api/runs/:id`
- `POST /api/runs/:id/approve`
- `POST /api/runs/:id/cancel`
- `POST /api/runs/:id/worker-results`
- `POST /api/verify`
- `GET /api/providers/health`
- `POST /api/model/generate`
- `GET /api/runs/:id/report`
- `GET /api/runs/:id/audit`
- `POST /mcp`

Plan and estimate responses include task graph, approval, validation, planning prompt, plan report, model registry, routing policy, budget policy, budget status, policy config, policy validation, policy status, escalation policy, and routing trace metadata. Supervisor-planned responses also include `supervisorPlanning` / `supervisor_planning` metadata describing whether dynamic task drafts were used or deterministic fallback was selected. Shadow-classified responses include `shadowClassifier` / `shadow_classifier` metadata when enabled.
`POST /api/verify` accepts `{ "runId": "..." }` or `{ "runId": "...", "verification": { ... } }` and returns `skipped`, `passed`, or `failed` with command checks, task acceptance review, final supervisor review, and escalation evidence. Persisted run status becomes `verification_skipped`, `verification_passed`, or `verification_failed`. Final reports split verification into Command Checks, Acceptance Review, Final Supervisor Review, and Escalation sections so hosts can show which checks passed, failed, or were skipped. Phase 9 report JSON also includes `finalReport`, `costReport`, `perTaskModelUsage`, `routingDecisions`, `escalationDecisions`, `failureAnalysis`, `traceViewerData`, `exportFormat`, and `modelReliability`; `costReport.unattributedModelUsage` captures provider calls that cannot be mapped to a task. Phase 11.0 report JSON also includes `learningProfile` / `learning_profile`. Learning is local-only and shadow-mode only in this phase: it explains cheaper-tier, stronger-tier, or hold recommendations from historical run metadata, but does not change planning, routing, execution, retries, or verification. Shadow LLM classifier reports add `shadowClassifier` / `shadow_classifier` summaries for provider-backed advisory savings and safety-floor decisions; these are also report-only.
`POST /api/model/generate` and `runtime_model_generate` accept optional `taskId` metadata with `runId`; the runtime stores it only in the run trace for report cost attribution and does not forward it to the provider request body.
`POST /api/runs/:id/worker-results` accepts `{ "taskId": "T-003", "apply": true, "result": { ... } }`, validates the worker output, builds context from `allowed_files` plus read-only `referenced_files`, records a worker attempt, rejects results that explicitly include task `forbidden_actions`, and applies the patch only when it remains inside the task `allowed_files`.
`GET /api/runs/:id/audit` returns a redacted Phase 10 audit export for completed runs, including policy, routing, worker, model, verification, event, report, and integrity metadata.

If `server.apiToken` or `AI_CODING_RUNTIME_API_TOKEN` is set, every endpoint except `/api/health` requires:

```text
Authorization: Bearer <token>
```

## Prompt Samples and Smoke Tests

Reusable prompts:

- `examples/prompts/plan-only.md`
- `examples/prompts/cost-optimized.md`
- `examples/prompts/premium-final-review.md`
- `examples/prompts/high-risk-require-approval.md`

Smoke-test checklists:

- `examples/smoke-tests/codex-desktop.md`
- `examples/smoke-tests/codex-cli.md`
- `examples/smoke-tests/cursor.md`
- `examples/smoke-tests/opencode.md`
