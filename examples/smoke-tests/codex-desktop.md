# Codex Desktop Smoke Test

- [ ] Add `examples/codex-desktop/mcp.json` to Codex Desktop MCP settings or create an equivalent server entry.
- [ ] Restart Codex Desktop so the MCP server is loaded.
- [ ] Ask: `Use AI Coding Runtime in plan-only mode for adding a README section. Show the plan and do not edit files.`
- [ ] Confirm Codex can call `runtime_plan`.
- [ ] Confirm Codex can create a persisted run with `runtime_run`.
- [ ] Confirm Codex can inspect the persisted run with `runtime_status`.
- [ ] Confirm Codex can request a report with `runtime_report`.
- [ ] Confirm the response includes task risk, routing, approval status, and verification plan.
- [ ] Use `runtime_verify` only for `planned`, `approved`, or `verification_failed` runs.

Troubleshooting:

- If the server is not visible, check that the working directory points at the repository root.
- If `node` is not found, use an absolute path to Node.js in the MCP command.
