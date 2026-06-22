# AI Coding Runtime Integrations

AI Coding Runtime exposes two integration surfaces in Phase 2:

- stdio MCP: `node ./bin/ai-coding-runtime.js mcp`
- Streamable HTTP JSON-RPC: `POST http://127.0.0.1:3847/mcp`

The HTTP service also exposes REST-style endpoints for scripts and smoke tests.
Phase 5 adds provider adapters for OpenAI-compatible, Anthropic, Gemini, and local placeholder models. `runtime_model_generate` can append usage and estimated cost to a run trace when called with `runId`.
The runtime can also accept structured worker results, validate patch boundaries against task contracts, optionally apply validated text patches, and execute configured deterministic verification commands.
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

`runtime_plan` and `runtime_estimate` include `taskGraph`, `approval`, `validation`, `planningPrompt`, `planReport`, `modelRegistry`, `routingPolicy`, `budgetPolicy`, `budgetStatus`, `policyStatus`, `escalationPolicy`, and `routingTrace`. `planReport` is the Phase 3 plan review output for host tools to show before execution.
Use `runtime_provider_health` before real generation to confirm local API key and model configuration. Use `runtime_model_generate` only when the host tool intentionally wants Runtime to call a configured provider directly.
Use `runtime_submit_worker_result` after a run is approved to submit a worker's structured patch result. The worker context pack is built from task `allowed_files` plus read-only `referenced_files`. The result must include `patch`, `explanation`, `verificationNotes`, `confidence`, `filesTouched`, and acceptance evidence for every task acceptance item. Runtime rejects patches outside `allowed_files` and worker results that explicitly include task `forbidden_actions`. Set `apply: true` only when the host tool wants Runtime to apply a validated text patch to the configured workspace.
Use `runtime_verify` for runs in `planned`, `approved`, or `verification_failed`. Runs in `approval_required` should be approved first, then verified.
For read-only planning, include wording such as `plan only` or `不修改文件` when you want a low-risk plan that does not require approval.

## Codex CLI

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
- `POST /mcp`

Plan and estimate responses include task graph, approval, validation, planning prompt, plan report, model registry, routing policy, budget policy, budget status, policy status, escalation policy, and routing trace metadata.
`POST /api/verify` accepts `{ "runId": "..." }` and returns `skipped`, `passed`, or `failed` with structured command evidence. Persisted run status becomes `verification_skipped`, `verification_passed`, or `verification_failed`.
`POST /api/runs/:id/worker-results` accepts `{ "taskId": "T-003", "apply": true, "result": { ... } }`, validates the worker output, builds context from `allowed_files` plus read-only `referenced_files`, records a worker attempt, and applies the patch only when it remains inside the task `allowed_files`.

If `server.apiToken` or `AI_CODING_RUNTIME_API_TOKEN` is set, every endpoint except `/api/health` requires:

```text
Authorization: Bearer <token>
```
