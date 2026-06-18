# AI Coding Runtime Integrations

AI Coding Runtime exposes two integration surfaces in Phase 2:

- stdio MCP: `node ./bin/ai-coding-runtime.js mcp`
- Streamable HTTP JSON-RPC: `POST http://127.0.0.1:3847/mcp`

The HTTP service also exposes REST-style endpoints for scripts and smoke tests.

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
- `POST /api/runs/:id/cancel`
- `POST /api/verify`
- `GET /api/runs/:id/report`
- `POST /mcp`

If `server.apiToken` or `AI_CODING_RUNTIME_API_TOKEN` is set, every endpoint except `/api/health` requires:

```text
Authorization: Bearer <token>
```

