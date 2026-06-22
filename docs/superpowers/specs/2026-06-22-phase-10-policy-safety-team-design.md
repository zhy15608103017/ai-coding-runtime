# Phase 10 Policy Safety And Team Mode Design

## Goal

Phase 10 makes AI Coding Runtime safe enough for individual and team use by adding a unified policy engine. The runtime should validate policy configuration, enforce budget and risk gates, redact secrets before traces and prompts leave the runtime, constrain file and command access, provide team policy examples, and export completed runs for audit.

This phase completes the full Phase 10 checklist from `total.md` without starting Phase 11 learning features.

## Recommended Approach

Add an independent `src/runtime/policy.js` module and call it from existing runtime surfaces. The router continues to own model tier routing, contracts continue to own plan shape validation, and policy becomes the single place for team and safety rules.

This is preferred over extending `router.js` or `contracts.js` because Phase 10 concerns apply across planning, worker context, model traces, verification commands, reports, and audit export. Keeping policy separate avoids coupling routing decisions to workspace trust, secret redaction, and command allowlists.

## Policy Configuration

Runtime config gains a top-level `policy` object. Existing `routing.budgetPolicy` remains supported and is merged into the Phase 10 budget view for backward compatibility.

The policy config contains these sections:

- `budget`: `maxCostPerRun`, `maxWorkerRetries`, and compatible aliases for existing budget controls.
- `routing`: final review tier, security task minimum tier, and local model allowance for read-only tasks.
- `safety`: high-risk approval requirement, code-change test requirement, secret exfiltration blocking, and network blocking.
- `workspace`: trust state, allowed file patterns, and blocked file patterns.
- `commands`: verification command allowlist and network default.
- `secrets`: redaction marker and configurable secret-name/value patterns.
- `audit`: audit export options.

Default policy should be safe but compatible with the current repo tests. An absent file allowlist means "use the task contract allowlist." An absent command allowlist means "allow configured verification commands." Stricter behavior is activated when users or teams configure explicit limits.

## Runtime Integration

`config.js` loads and normalizes the policy config, validates it, and exposes both the normalized policy and validation result through runtime options.

`planner.js` evaluates policy while creating a plan. The plan stores `policyConfig`, `policyValidation`, and `policyStatus`. Budget rules update or mirror the existing Phase 4 `budgetStatus` so persisted execution continues to reject over-budget plans.

`store.js` keeps refusing `policyStatus.allowed=false` plans and records policy events, including policy evaluation and individual violations.

`worker.js` and `workspace.js` apply workspace policy when building context packs, validating worker patches, and applying patches. Worker prompts, context file contents, result text, and stored attempts are redacted before they are written to traces.

`tools.js` applies command policy before verification commands run and redacts model generation requests before recording model calls. If `safety.requireTestsForCodeChanges` is enabled and a file-changing plan has no test command, the runtime produces a policy violation.

`report.js` returns redacted report data by default and exposes audit export data for completed runs.

`cli.js`, `server.js`, and MCP expose audit export as a JSON-first interface. Markdown reports remain human-facing reports, while audit export is structured evidence for sharing or retention.

## Enforcement Rules

Budget enforcement uses the existing budget refusal path and adds Phase 10 config aliases. A run that exceeds configured cost, call, or retry limits can be inspected as a plan but cannot be persisted for execution.

Risk approval enforces human approval for high-risk tasks when `requireHumanApprovalForHighRisk` is enabled. Medium-risk approval remains compatible with the existing approval behavior.

Workspace file policy combines task contracts with team policy. A file is allowed only when it satisfies the task contract and does not match `workspace.blockedFiles`. If `workspace.allowedFiles` is configured, the file must also match that allowlist.

Command policy checks configured verification commands before execution. When an allowlist exists, commands must match it exactly or by supported safe prefix rules. Blocked commands are reported as policy violations instead of being executed.

Secret redaction is applied recursively to strings, arrays, and plain objects. It covers common key names such as API keys, tokens, passwords, and secrets, plus common inline assignment patterns. Redaction happens before prompts, model request traces, worker attempts, reports, and audit exports are persisted or returned.

Network policy is represented in Phase 10 command and safety metadata. The runtime blocks unapproved network-oriented commands when configured, but it does not try to sandbox arbitrary host process network access in this phase.

## Audit Export

Audit export is available for completed runs, including verification passed, verification failed, verification skipped, canceled, and rejected approval states. Active runs such as planned, approval required, approved, or verifying are not exportable as completed evidence.

The export includes:

- schema name and version
- generated timestamp
- run id, status, request summary, and timestamps
- redacted plan, policy config, policy status, and budget status
- approval, routing, worker, model, verification, and event evidence
- redacted final report summary
- integrity metadata with event count and a SHA-256 hash of the canonical redacted export payload

Audit export intentionally excludes raw secrets and unredacted file contents.

## Team Policy Examples

Add JSON examples under `examples/team-policies/`:

- `solo-default.json`: permissive local-first defaults for individual use.
- `team-strict.json`: approval, file, command, and budget controls for team repositories.
- `high-security.json`: stronger redaction, blocked secret files, stricter commands, and high-risk approval.

These examples are documentation assets and test fixtures for schema validation.

## Testing

Create `tests/phase10-policy-safety-team.test.js` covering:

- policy schema defaults, config merging, and invalid config errors
- budget enforcement through Phase 10 policy config
- high-risk human approval behavior
- secret redaction in worker prompts, model call traces, reports, and audit exports
- file allowlist and blocklist enforcement for context packs and worker patches
- command allowlist enforcement for verification
- audit export for completed runs
- roadmap checklist completion for Phase 10 while Phase 11 stays unchecked

Existing Phase 1 through Phase 9 tests must continue to pass.

## Documentation

Update `README.md` and `docs/integrations.md` to describe Phase 10 policy metadata, policy violations, approval behavior, redaction guarantees, allowlist behavior, and audit export.

Add `docs/policy.md` as the central policy reference with schema examples, defaults, and team policy guidance.

Update `total.md` only after implementation and tests prove the Phase 10 checklist is complete.

## Acceptance Criteria

- The runtime enforces budget and risk limits from Phase 10 policy config.
- Secrets are redacted from worker prompts, model traces, reports, and audit exports.
- High-risk actions can require explicit human approval.
- File and command allowlists block unapproved worker and verification actions.
- Team policy examples exist and validate against the schema.
- Completed runs can produce a redacted audit export.
- `npm test` passes.
- Phase 10 checklist is complete and Phase 11 remains incomplete.
