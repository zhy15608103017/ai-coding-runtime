# Policy

AI Coding Runtime Phase 10 policy controls budget, risk approval, workspace access, command execution, secret redaction, and audit export.

## Policy Schema

Policy lives at the top level of `runtime.config.json` under `policy`. Existing `routing.budgetPolicy` remains supported, but `policy.budget` is the Phase 10 source of truth when present.

```json
{
  "policy": {
    "budget": {
      "maxCostPerRun": 2,
      "maxWorkerRetries": 2,
      "maxCallsPerRun": 12
    },
    "safety": {
      "requireHumanApprovalForHighRisk": true,
      "requireTestsForCodeChanges": true,
      "blockSecretExfiltration": true,
      "blockUnapprovedNetworkAccess": true
    },
    "workspace": {
      "allowedFiles": ["src/**", "tests/**"],
      "blockedFiles": [".env", "*.pem", "secrets/**"]
    },
    "commands": {
      "allowlist": ["git diff --check", "node --test"],
      "blockNetworkByDefault": true
    }
  }
}
```

Snake-case aliases from the roadmap example, such as `max_cost_per_run` and `require_human_approval_for_high_risk`, are normalized into the runtime's camel-case shape.

## Budget And Risk

`policy.budget.maxCostPerRun`, `maxCallsPerRun`, and `maxWorkerRetries` are enforced before persisted execution. A disallowed plan can still be inspected, but `runtime_run` refuses it.

High-risk tasks remain behind explicit approval when `policy.safety.requireHumanApprovalForHighRisk` is enabled. Existing medium-risk approval behavior remains compatible with earlier phases.

## Workspace Files

Task contracts still define task-local file scope. Team policy can further restrict that scope with `workspace.allowedFiles` and `workspace.blockedFiles`. A worker patch must satisfy both the task contract and the team policy.

## Commands

Verification commands are allowed by default for compatibility. When `commands.allowlist` is configured, every verification command must match an allowlist entry. Network-oriented commands such as `curl`, `wget`, `ssh`, and `scp` are blocked when `blockNetworkByDefault` or `blockUnapprovedNetworkAccess` is enabled.

## Secret Redaction

Prompts, model traces, worker attempts, reports, and audit exports are recursively redacted with the configured secret patterns. Matching key names replace the whole value, and inline assignments such as `TOKEN=value` or `password: value` are redacted before storage or export.

## Audit Export

Use `ai-coding-runtime audit <run-id> --json`, `runtime_audit`, or `GET /api/runs/:runId/audit` to export completed run evidence. Audit exports include policy, routing, worker, model, verification, event, and report evidence with a SHA-256 integrity hash over the redacted payload.

Audit export is available only after a run reaches a completed status such as `verification_passed`, `verification_failed`, `verification_skipped`, `canceled`, or `approval_rejected`.

## Team Examples

See:

- `examples/team-policies/solo-default.json`
- `examples/team-policies/team-strict.json`
- `examples/team-policies/high-security.json`
