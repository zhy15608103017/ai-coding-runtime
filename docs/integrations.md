# AI Coding Runtime Integrations

AI Coding Runtime exposes two integration surfaces in Phase 2:

- stdio MCP: `node ./bin/ai-coding-runtime.js mcp`
- Streamable HTTP JSON-RPC: `POST http://127.0.0.1:3847/mcp`

The HTTP service also exposes REST-style endpoints for scripts and smoke tests.
Phase 5 adds provider adapters for OpenAI-compatible, Anthropic, Gemini, and local placeholder models. `runtime_model_generate` can append usage and estimated cost to a run trace when called with `runId`.
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

`runtime_plan` and `runtime_estimate` include `taskGraph`, `approval`, `validation`, `planningPrompt`, `planReport`, `modelRegistry`, `routingPolicy`, `budgetPolicy`, `budgetStatus`, `policyStatus`, `escalationPolicy`, and `routingTrace`. `planReport` is the Phase 3 plan review output for host tools to show before execution.
Use `runtime_provider_health` before real generation to confirm local API key and model configuration. Use `runtime_model_generate` only when the host tool intentionally wants Runtime to call a configured provider directly.
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
- `POST /api/verify`
- `GET /api/providers/health`
- `POST /api/model/generate`
- `GET /api/runs/:id/report`
- `POST /mcp`

Plan and estimate responses include task graph, approval, validation, planning prompt, plan report, model registry, routing policy, budget policy, budget status, policy status, escalation policy, and routing trace metadata.

If `server.apiToken` or `AI_CODING_RUNTIME_API_TOKEN` is set, every endpoint except `/api/health` requires:

```text
Authorization: Bearer <token>
```
