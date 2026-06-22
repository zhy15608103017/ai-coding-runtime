# OpenCode Smoke Test

- [ ] Copy `examples/opencode/opencode.json` or `examples/opencode/opencode-http.json` into the OpenCode config location.
- [ ] For HTTP MCP, start `node ./bin/ai-coding-runtime.js start --host 127.0.0.1 --port 3847`.
- [ ] Start OpenCode and confirm the `ai_runtime` MCP server is enabled.
- [ ] Run the configured `runtime` command with a plan-only request.
- [ ] Confirm OpenCode can call `runtime_plan`.
- [ ] Confirm OpenCode can create a persisted run with `runtime_run`.
- [ ] Confirm OpenCode can inspect the persisted run with `runtime_status`.
- [ ] Confirm OpenCode can request a report with `runtime_report`.
- [ ] Confirm OpenCode can run `runtime_verify` for `planned`, `approved`, or `verification_failed` runs.
- [ ] Confirm medium/high risk runs require approval before worker-result submission.

Troubleshooting:

- If `ai_runtime` is disabled, check the `enabled` flag and config file location.
- If remote MCP fails, check `http://127.0.0.1:3847/api/health`.
