# AI Coding Runtime

AI Coding Runtime is a local-first orchestration layer for AI coding tasks.

V0 focuses on the runtime skeleton:

- create a structured runtime plan from a user request
- classify tasks into `cheap`, `standard`, and `premium` model tiers
- store run records and structured events on disk
- expose a CLI for `run`, `status`, `report`, and `start`
- expose a minimal local HTTP health and run API

V0 does not call real model providers or apply patches. Those capabilities are planned after the planner, router, storage, and gateway contracts are stable.

## Usage

```bash
npm test
node ./bin/ai-coding-runtime.js run "实现登录限流并补充测试" --json
node ./bin/ai-coding-runtime.js status <run-id> --json
node ./bin/ai-coding-runtime.js report <run-id> --markdown
node ./bin/ai-coding-runtime.js start --host 127.0.0.1 --port 3847
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
    "mcpPath": "/mcp"
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

## HTTP

Start the local service:

```bash
node ./bin/ai-coding-runtime.js start --json
```

V0 endpoints:

- `GET /api/health`
- `POST /api/plan`
- `POST /api/runs`
- `GET /api/runs/:id`
- `GET /api/runs/:id/report`
- `GET /mcp` placeholder endpoint for Phase 2

