# Cursor Setup

Use this when you want Cursor to call AI Coding Runtime from a project MCP configuration.

## Prerequisites

- Node.js 20 or newer.
- Cursor with MCP support enabled.
- This repository checked out locally, or the Runtime HTTP service running locally.

## Option A: Stdio MCP

Create `.cursor/mcp.json` in the target project:

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

Sample file: `examples/cursor/mcp-stdio.json`.

## Option B: HTTP MCP

Start the service:

```bash
node ./bin/ai-coding-runtime.js start --host 127.0.0.1 --port 3847
```

Then create `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ai-coding-runtime": {
      "url": "http://127.0.0.1:3847/mcp"
    }
  }
}
```

Sample file: `examples/cursor/mcp-http.json`.

## Recommended Prompts, Rules, And Skills

Use this as a Cursor project rule. Cursor does not need a separate Runtime-specific skill; the rule should steer the agent to call Runtime MCP tools for planning, approval gates, worker-result submission, verification, and reporting.

```md
Use AI Coding Runtime for multi-step, high-cost, risky, or verification-heavy tasks.
Plan first, ask for approval on medium/high risk, perform worker changes in the host according to Runtime task contracts, submit structured worker results, then verify and summarize the final report.
```

## Smoke Test

Follow `examples/smoke-tests/cursor.md`.
