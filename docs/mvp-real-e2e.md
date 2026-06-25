# MVP Real End-to-End Run

## Goal

This document records the first MVP real end-to-end loop for AI Coding Runtime: plan, route, approve when needed, record real provider usage, apply a checked worker result, verify, inspect, report, and audit.

## Environment

- Runtime command: `node ./bin/ai-coding-runtime.js`
- Data directory: `.ai-coding-runtime`
- Verification commands: `git diff --check` and `npm test`

## Provider Configuration

- Provider used: `openai-compatible`
- Model used: `gpt-5.4`
- `provider-health` selected-provider result: `openai-compatible` was `configured` and `ok: true` for model `gpt-5.4`.
- Non-real provider boundary: `local` was available only as `local-placeholder` and was not used for this run.
- Provider usage for the explicit generation call: `391 tokens`
- Secret handling: credentials came from local ignored configuration or environment variables and are not recorded here.

## User Request

`Only modify docs/mvp-real-e2e.md to document one MVP real end-to-end AI Coding Runtime run. Include goal, environment, provider configuration without secrets, user request, plan, approval, model call, worker-result application, verification, inspect, report, audit, result, and lessons. Do not modify src/ code.`

## Run

- Run id: `run_20260625062843589_eckzgq`
- Task id: `T-003`
- Initial run status: `approval_required`
- Worker result status: `applied`
- Runtime verification status: `passed`

## Plan

Runtime planned six tasks for the docs-only request. The plan kept the commit boundary to `docs/mvp-real-e2e.md` and routed work across cheap, standard, and premium tiers:

- T-001 and T-002: cheap planning/context tasks.
- T-003: standard file-editing task for the MVP E2E document.
- T-004 and T-005: standard/cheap supporting review and summary tasks.
- T-006: premium final verification task.

The planned policy and budget checks were allowed with no violations.

## Approval

The run initially stopped at `approval_required`. It was explicitly approved through the Runtime approval flow before the provider-backed task execution continued.

## Real Provider Evidence

Runtime recorded a provider-backed generation call against this run and task.

Response summary:

```text
Documenting a real end-to-end runtime run increases trust because it shows the system actually works in practice under realistic conditions rather than only in theory.
```

## Worker Result Application

The documentation file was created through `ai-coding-runtime worker-result --apply` so Runtime could validate the patch against the task contract before applying it.

## Changed Files
- docs/mvp-real-e2e.md

## Verification

- `git diff --check`: passed.
- `npm test`: passed. Captured pass line: `# pass 233`.
- Runtime verification status: `passed`.

Runtime verification commands:

```text
- git-diff-check: passed, exit 0
- test: passed, exit 0
```

## Inspect Summary

The post-approval inspect view showed the run as visible to Runtime with the same run id, task routing, acceptance, verification, and escalation state used in the report. The key inspect outcome was that `T-003` had an applied worker result, verification evidence was present, and the run had progressed to `verification_passed` after `verify`.

## Report Summary

```text
# AI Coding Runtime Report

Run: run_20260625062843589_eckzgq
Status: verification_passed

## Request
Only modify docs/mvp-real-e2e.md to document one MVP real end-to-end AI Coding Runtime run. Include goal, environment, provider configuration without secrets, user request, plan, approval, model call, worker-result application, verification, inspect, report, audit, result, and lessons. Do not modify src/ code.

## Summary
Planned 6 task(s) for runtime execution.

## Changed Files
- docs/mvp-real-e2e.md

## Model Routing
- cheap: 3
- standard: 2
- premium: 1

## Cost Estimate
- planned routing cost: USD 0
- provider cost: USD 0
- unattributed provider cost: USD 0
- total visible cost: USD 0

## Budget
- allowed: true
- estimated cost: USD 0.33
- estimated calls: 6
- reserved retries: 5
- violations: none

## Policy
- allowed: true
- violations: none

## Routing Trace
- T-001: cheap (L0 default routing tier; low-risk minimum tier; low context requirement; easy verification strength; selected: openai-compatible/gpt-5.4-mini)
- T-002: cheap (L1 default routing tier; low-risk minimum tier; low context requirement; easy verification strength; selected: openai-compatible/gpt-5.4-mini)
- T-003: standard (L2 default routing tier; medium-risk minimum tier; medium context requirement; medium verification strength; file-editing tasks require at least the standard tier; selected: openai-compatible/gpt-5.4)
- T-004: standard (L1 default routing tier; low-risk minimum tier; medium context requirement; easy verification strength; selected: openai-compatible/gpt-5.4)
- T-005: cheap (L1 default routing tier; low-risk minimum tier; low context requirement; easy verification strength; selected: openai-compatible/gpt-5.4-mini)
- T-006: premium (L4 default routing tier; high-risk minimum tier; high context requirement; hard verification strength; final verification always uses the premium tier; selected: openai-compatible/gpt-5.5)

## Per-Task Model Usage
- T-001: cheap/openai-compatible/gpt-5.4-mini planned USD 0, actual USD 0
- T-002: cheap/openai-compatible/gpt-5.4-mini planned USD 0, actual USD 0
- T-003: standard/openai-compatible/gpt-5.4 planned USD 0, actual USD 0
- T-004: standard/openai-compatible/gpt-5.4 planned USD 0, actual USD 0
- T-005: cheap/openai-compatible/gpt-5.4-mini planned USD 0, actual USD 0
- T-006: premium/openai-compatible/gpt-5.5 planned USD 0, actual USD 0

## Model Calls
- calls: 2
- estimated provider cost: USD 0
- openai-compatible/gpt-5.4: 391 tokens, USD 0
- openai-compatible/gpt-5.4: 2046 tokens, USD 0

```

## Audit Summary

The completed-run audit export was generated with redacted evidence. Integrity metadata:

```json
{
  "eventCount": 15,
  "event_count": 15,
  "sha256": "2c4f57b045bcaf59a4b422ab1a79df3c716d7e674b16e4375de9f791c3875fcb"
}
```

## Safety Check

A separate docs-only safety run intentionally submitted a `package.json` patch outside `allowed_files`. Runtime rejected the worker result with status `failed` and left `package.json` unchanged.

Safety rejection evidence:

```text
Invalid worker patch: worker.patch.forbidden_file
```

## Result

The MVP loop is successful: verification passed, the report includes routing and model-call evidence, the audit export includes integrity metadata, and the boundary rejection check proved that out-of-contract file edits are blocked.

## Lessons

- Keep the first MVP run narrow.
- Use real provider evidence without committing credentials.
- Keep raw runtime artifacts local and commit only this human-readable summary.
- Treat generated run records as local evidence, not repository content.
