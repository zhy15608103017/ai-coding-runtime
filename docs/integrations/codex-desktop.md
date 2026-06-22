# Codex Desktop Setup

Use this when you want Codex Desktop to call AI Coding Runtime through MCP.

## Prerequisites

- Node.js 20 or newer.
- This repository checked out locally, or the `ai-coding-runtime` package installed.
- Optional: `runtime.config.json` copied from `runtime.config.example.json`.

## Stdio MCP

Add an MCP server named `ai-coding-runtime` in Codex Desktop settings.

For this repository:

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

For an installed package:

```json
{
  "mcpServers": {
    "ai-coding-runtime": {
      "command": "npx",
      "args": ["-y", "ai-coding-runtime", "mcp"]
    }
  }
}
```

Sample file: `examples/codex-desktop/mcp.json`.

## Recommended Prompts, Rules, And Skills

Codex Desktop can use this as a persistent project instruction or as the first message in a task thread. No separate Runtime-specific skill is required; the key rule is to call the MCP tools for planning, approval, verification, and reporting evidence.

```text
Use AI Coding Runtime for multi-step, high-cost, risky, or verification-heavy coding tasks.
Plan first, show risk and estimated cost, request approval for medium/high risk, then verify and report through Runtime.
```

## First Prompt

```text
Use AI Coding Runtime for this task. Plan first, estimate cost and risk, then wait for approval before any file-changing worker step.
```

## Smoke Test

Follow `examples/smoke-tests/codex-desktop.md`.
