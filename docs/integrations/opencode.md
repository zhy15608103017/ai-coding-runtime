# OpenCode Setup

Use this when you want OpenCode to call AI Coding Runtime through local or remote MCP.

## Prerequisites

- Node.js 20 or newer.
- OpenCode installed.
- This repository checked out locally, or the Runtime HTTP service running locally.

## Option A: Local Stdio MCP

Add this to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ai_runtime": {
      "type": "local",
      "command": ["node", "./bin/ai-coding-runtime.js", "mcp"],
      "enabled": true
    }
  },
  "command": {
    "runtime": {
      "template": "Use ai_runtime to plan and route this task. Perform worker changes in the host according to Runtime task contracts, submit structured worker results, then verify and summarize: $ARGUMENTS",
      "description": "Run task through AI Coding Runtime"
    }
  }
}
```

Sample file: `examples/opencode/opencode.json`.

## Option B: HTTP MCP

Start the service:

```bash
node ./bin/ai-coding-runtime.js start --host 127.0.0.1 --port 3847
```

Then add this to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ai_runtime": {
      "type": "remote",
      "url": "http://127.0.0.1:3847/mcp",
      "enabled": true
    }
  },
  "command": {
    "runtime": {
      "template": "Use ai_runtime to plan and route this task. Perform worker changes in the host according to Runtime task contracts, submit structured worker results, then verify and summarize: $ARGUMENTS",
      "description": "Run task through AI Coding Runtime"
    }
  }
}
```

Sample file: `examples/opencode/opencode-http.json`.

## Recommended Prompts, Rules, And Skills

OpenCode can use the `runtime` command template above as the reusable command rule. No separate Runtime-specific skill is required; the command should keep Runtime responsible for planning, routing, verification, and reports while host-side worker changes stay bounded by task contracts.

```text
Use ai_runtime for tasks that need planning, routing, approval gates, worker-result validation, verification evidence, or final reports.
Do not mark a task complete until Runtime verification and report evidence are available.
```

## Smoke Test

Follow `examples/smoke-tests/opencode.md`.
