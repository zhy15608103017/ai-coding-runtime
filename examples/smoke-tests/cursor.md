# Cursor Smoke Test

- [ ] Copy `examples/cursor/mcp-stdio.json` or `examples/cursor/mcp-http.json` to `.cursor/mcp.json`.
- [ ] For HTTP MCP, start `node ./bin/ai-coding-runtime.js start --host 127.0.0.1 --port 3847`.
- [ ] Reload Cursor so the MCP configuration is detected.
- [ ] Ask: `Use AI Coding Runtime in plan-only mode for a small refactor. Do not modify files.`
- [ ] Confirm Cursor can list or call Runtime MCP tools.
- [ ] Confirm Cursor can call `runtime_plan`.
- [ ] Confirm Cursor can create a persisted run with `runtime_run`.
- [ ] Confirm Cursor can inspect the persisted run with `runtime_status`.
- [ ] Confirm Cursor can request a report with `runtime_report`.
- [ ] Confirm the plan includes task contracts and approval metadata.
- [ ] Confirm final verification evidence is shown before Cursor reports completion.

Troubleshooting:

- If HTTP MCP fails, open `http://127.0.0.1:3847/api/health`.
- If stdio MCP fails, run `node ./bin/ai-coding-runtime.js mcp` manually from the same directory.
