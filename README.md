# AI Coding Runtime

AI Coding Runtime is a local-first orchestration layer for AI coding tasks.

V0 currently covers the Phase 1 runtime skeleton and the Phase 2 gateway skeleton:

- create a structured runtime plan from a user request
- classify tasks into `cheap`, `standard`, and `premium` model tiers
- store run records and structured events on disk
- expose a CLI for `run`, `status`, `report`, and `start`
- expose a local HTTP API for planning, runs, verification, cancel, and reports
- expose stdio MCP with `node ./bin/ai-coding-runtime.js mcp`
- expose Streamable HTTP JSON-RPC at `POST /mcp`
- validate task contracts before a run is persisted
- include task graph, approval gate, validation, and plan report metadata in plans
- include a deterministic planning prompt for host tools and future supervisor calls

V0 does not call real model providers or apply patches. Those capabilities are planned after the planner, router, storage, and gateway contracts are stable.
Runs that include medium or high risk tasks are stored as `approval_required`. V0 provides a minimal approval input through CLI, HTTP, and MCP; later phases will add execution after approval and richer approval UI.
Explicit read-only planning requests such as `plan only`, `read-only`, or `不修改文件` produce low-risk plans that can be stored as `planned` without an approval gate.

## Usage

```bash
npm test
node ./bin/ai-coding-runtime.js run "实现登录限流并补充测试" --json
node ./bin/ai-coding-runtime.js status <run-id> --json
node ./bin/ai-coding-runtime.js approve <run-id> --json
node ./bin/ai-coding-runtime.js report <run-id> --markdown
node ./bin/ai-coding-runtime.js start --host 127.0.0.1 --port 3847
node ./bin/ai-coding-runtime.js mcp
```

By default, run data is stored in `.ai-coding-runtime/runs`.

Override the data directory:

```bash
$env:AI_CODING_RUNTIME_HOME="D:\runtime-data"
node ./bin/ai-coding-runtime.js run "规划一个任务" --json
```

## Config

Copy `runtime.config.example.json` to `runtime.config.json` and adjust it:

```json
{
  "server": {
    "host": "127.0.0.1",
    "httpPort": 3847,
    "mcpPath": "/mcp",
    "apiToken": null
  },
  "storage": {
    "directory": ".ai-coding-runtime"
  },
  "routing": {
    "modelTiers": ["cheap", "standard", "premium"],
    "finalVerificationTier": "premium"
  },
  "verification": {
    "commands": []
  }
}
```

Environment variables can override local config:

- `AI_CODING_RUNTIME_HOME`
- `AI_CODING_RUNTIME_HOST`
- `AI_CODING_RUNTIME_PORT`
- `AI_CODING_RUNTIME_API_TOKEN`

## HTTP

Start the local service:

```bash
node ./bin/ai-coding-runtime.js start --json
```

V0 HTTP endpoints:

- `GET /api/health`
- `POST /api/plan`
- `POST /api/estimate`
- `POST /api/runs`
- `GET /api/runs/:id`
- `POST /api/runs/:id/approve`
- `POST /api/runs/:id/cancel`
- `POST /api/verify`
- `GET /api/runs/:id/report`
- `POST /mcp`

See `docs/integrations.md` for Codex, Cursor, and OpenCode setup examples.

## MCP Tools

The MCP gateway exposes:

- `runtime_plan`
- `runtime_estimate`
- `runtime_run`
- `runtime_status`
- `runtime_collect`
- `runtime_verify`
- `runtime_report`
- `runtime_cancel`
- `runtime_approve`

`runtime_plan` and `runtime_estimate` include `taskGraph`, `approval`, `validation`, `planningPrompt`, and `planReport`. `planReport` is the Phase 3 plan review output for host tools to show before execution. `runtime_run` persists the same plan metadata, returns `approval_required` when human approval is required before execution, and returns `planned` for explicit low-risk read-only plans. `runtime_approve` records human approval and moves the run to `approved`.
