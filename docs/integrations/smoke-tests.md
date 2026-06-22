# Integration Smoke Tests

Use these checks after adding AI Coding Runtime to a host tool.

## Common Runtime Checks

- Start the HTTP service when using HTTP MCP:

  ```bash
  node ./bin/ai-coding-runtime.js start --host 127.0.0.1 --port 3847
  ```

- Confirm service health:

  ```bash
  curl http://127.0.0.1:3847/api/health
  ```

- Confirm stdio MCP starts when using local MCP:

  ```bash
  node ./bin/ai-coding-runtime.js mcp
  ```

  Stop it after confirming it starts; host tools manage the stdio process themselves.

## Host Checklists

- Codex Desktop: `examples/smoke-tests/codex-desktop.md`
- Codex CLI: `examples/smoke-tests/codex-cli.md`
- Cursor: `examples/smoke-tests/cursor.md`
- OpenCode: `examples/smoke-tests/opencode.md`

## Expected Runtime Flow

1. The host can list MCP tools and sees `runtime_plan`, `runtime_run`, `runtime_status`, `runtime_verify`, and `runtime_report`.
2. A plan-only prompt returns a low-risk plan without editing files.
3. A persisted run returns `planned` or `approval_required`.
4. `runtime_status` can read the persisted run status.
5. Verification returns `passed`, `failed`, or `skipped` with evidence sections.
6. The final report includes task graph, routing, verification, risk, and follow-up information available for the current runtime phase.
