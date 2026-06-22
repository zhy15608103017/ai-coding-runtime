# Codex CLI Smoke Test

- [ ] Register MCP with `codex mcp add ai-coding-runtime -- node ./bin/ai-coding-runtime.js mcp`.
- [ ] Start `codex` from the repository root.
- [ ] Ask: `Use ai-coding-runtime to plan only: add a README section. Show risk and cost.`
- [ ] Confirm Codex can call `runtime_plan`.
- [ ] Confirm Codex can create a persisted run with `runtime_run`.
- [ ] Confirm Codex can inspect the persisted run with `runtime_status`.
- [ ] Confirm Codex can request a report with `runtime_report`.
- [ ] If a run is `approval_required`, confirm Codex asks before approval.
- [ ] Run `runtime_verify` only for `planned`, `approved`, or `verification_failed` runs.

Troubleshooting:

- If MCP registration points at a different directory, use `npx -y ai-coding-runtime mcp` or an absolute path.
- If provider health is needed, call `runtime_provider_health` before generation.
