# Codex CLI Setup

Use this when you want Codex CLI to call AI Coding Runtime through a local stdio MCP server.

## Prerequisites

- Node.js 20 or newer.
- Codex CLI installed.
- This repository checked out locally, or the `ai-coding-runtime` package available through `npx`.

## Register MCP

For this repository:

```bash
codex mcp add ai-coding-runtime -- node ./bin/ai-coding-runtime.js mcp
```

For an installed package:

```bash
codex mcp add ai-coding-runtime -- npx -y ai-coding-runtime mcp
```

Sample file: `examples/codex-cli/config.toml`.

## Recommended Prompts, Rules, And Skills

Codex CLI can use this as a standing instruction in the project or as the first task prompt. No separate Runtime-specific skill is required; the host should use the MCP tools and keep worker edits bounded by Runtime task contracts.

```text
Use ai-coding-runtime to plan and route tasks when the task is multi-step, risky, expensive, or verification-heavy.
Perform any worker changes in the host according to Runtime task contracts, submit structured worker results back to Runtime, then verify and report through Runtime.
Prefer low-cost model tiers for simple tasks, but keep final verification on premium unless I explicitly disable it.
```

## First Prompt

```text
Use ai-coding-runtime to plan this task first. Show task contracts, risk, routing, and estimated cost before execution.
If the Runtime returns approval_required, show me the approval summary and wait.
```

## Smoke Test

Follow `examples/smoke-tests/codex-cli.md`.
