# Phase 11.1 Routing History Export And Import Design

**Objective:** Add privacy-safe export/import for routing history so users can move learning evidence between local runtime stores, seed reports from prior runs, and inspect learning changes without allowing imported data to affect live routing.

## Context

Phase 11.0 added shadow learning recommendations derived from persisted run records. The runtime can now aggregate task-level outcomes, retry signals, escalation signals, provider/model usage, verification outcomes, and policy-controlled recommendations through `runtime_report`.

The remaining Phase 11 roadmap item is routing history export/import. This must preserve the Phase 11.0 safety boundary: learning is advisory and report-only. Imported history must not change `runtime_run`, `createRuntimePlan`, `routeTask`, execution retries, verification, or provider selection.

Current code shape:

- `FileExecutionStore` persists local run records under `runs/<runId>/run.json`.
- `createReport(record, { historyRecords, policy })` consumes current plus historical records.
- `createLearningProfile(records, { policy })` derives privacy-safe learning output from records.
- CLI report already loads `store.listRecords()` and passes history into report generation.

## Approaches Considered

### Recommended: Sanitized Snapshot Export/Import

Export a versioned JSON snapshot containing sanitized learning records. Import validates the snapshot, deduplicates records, and stores them in a separate imported-history area. Reports combine local run records with imported learning records.

This is the best V1 because it gives users portable history while preserving privacy and runtime safety. It also creates a stable file format for future hosted or team workflows.

### Alternative: Aggregated Profile Export Only

Export only the computed `learningProfile` buckets and recommendations, then import those aggregates for comparison.

This is very safe, but it is too lossy. Recommendations can change as rules evolve, and aggregate-only imports make it hard to recompute profiles under new policy thresholds.

### Alternative: Redacted Full Run Export

Export full run records after redaction and import them as history.

This keeps maximum fidelity, but it is too risky for V1. Existing run records can contain request text, planning prompts, model calls, worker attempts, command output, and audit details. Even with redaction, this creates a larger privacy and compatibility surface than Phase 11.1 needs.

## Decision

Implement sanitized snapshot export/import.

The snapshot should contain recomputable learning evidence, not raw runtime records and not only final aggregates. Imported records become report inputs only; they never masquerade as local runs and never participate in planning, routing, execution, or verification.

## Scope

Phase 11.1 includes:

- `history export` CLI command that writes a versioned JSON snapshot.
- `history import` CLI command that reads, validates, deduplicates, and stores a snapshot.
- A runtime module for exporting/importing sanitized learning history.
- A store extension for imported learning history.
- Report integration that includes imported history when building `learningProfile`.
- Strict privacy filtering and schema validation.
- Tests for export shape, import validation, duplicate handling, report integration, and routing non-interference.

Phase 11.1 does not include:

- automatic learned routing
- advisory prompts that change routing
- HTTP or MCP history import/export endpoints
- hosted sync
- team trust management
- raw prompt, patch, source, stdout, stderr, or model response export
- cross-project identity resolution beyond snapshot metadata

## Snapshot Format

Use a single JSON document:

```json
{
  "schemaVersion": "ai-coding-runtime.routing-history.v1",
  "exportedAt": "2026-06-24T00:00:00.000Z",
  "source": {
    "runtime": "ai-coding-runtime",
    "version": "0.1.0"
  },
  "summary": {
    "recordsScanned": 12,
    "recordsExported": 8,
    "recordsSkipped": 4
  },
  "records": []
}
```

Each `records[]` item is a sanitized learning record shaped for `createLearningProfile` compatibility:

```json
{
  "importId": "sha256:...",
  "sourceRunIdHash": "sha256:...",
  "createdAt": "2026-06-24T00:00:00.000Z",
  "status": "verification_passed",
  "plan": {
    "tasks": [
      {
        "id": "T-001",
        "task_type": "implementation",
        "difficulty": "L2",
        "risk": "medium",
        "context_need": "medium",
        "verification": "easy",
        "model_tier": "standard"
      }
    ],
    "routingTrace": [
      {
        "task_id": "T-001",
        "model_tier": "standard",
        "selected_provider": "openai-compatible",
        "selected_model": "model-name",
        "cost_hint": {
          "estimated_usd_per_call": 0.0123
        }
      }
    ]
  },
  "workerAttempts": [
    {
      "taskId": "T-001",
      "status": "accepted",
      "applied": true,
      "filesTouchedCount": 2
    }
  ],
  "modelCalls": [
    {
      "taskId": "T-001",
      "provider": "openai-compatible",
      "model": "model-name",
      "status": "finished",
      "costEstimate": {
        "currency": "USD",
        "estimatedCost": 0.0123
      }
    }
  ],
  "verification": [
    {
      "status": "passed",
      "acceptance": {
        "status": "passed",
        "tasks": [
          {
            "taskId": "T-001",
            "status": "passed"
          }
        ]
      },
      "escalation": {
        "required": false
      }
    }
  ],
  "events": [
    {
      "type": "worker.retry",
      "taskId": "T-001"
    }
  ],
  "imported": true
}
```

The shape intentionally mirrors only the fields learning already reads. This keeps Phase 11.1 small and avoids adding a second learning data model too early.

## Privacy Rules

Export must omit:

- `request`
- `planningPrompt`
- task titles and task descriptions
- source contents
- patch contents
- worker prompts
- model prompts and model responses
- command stdout and stderr
- raw error messages that may include secrets or code
- exact file paths unless reduced to counts
- environment variables and provider credentials

Export may include:

- task ids
- task type/classification metadata
- model tier
- provider/model names
- status values
- retry/escalation event types
- cost estimates
- token usage totals only if already present and non-sensitive
- timestamp metadata
- hashed source run id

Hashing should use the existing stable hashing utility where practical. Hashes are for deduplication and traceability, not security guarantees.

## Storage

Keep imported history separate from native run records:

```text
<runtime-storage>/
  runs/
  imported-history/
    routing-history/
      <importId>.json
```

`FileExecutionStore.listRecords()` should continue returning only native local runs. Add explicit methods such as:

- `listImportedLearningRecords()`
- `writeImportedLearningRecords(records)`

Report paths that want learning history can opt into imported records. Runtime paths that create, execute, verify, approve, or cancel runs should not see imported history.

## CLI Surface

Add a top-level `history` command with subcommands:

```bash
ai-coding-runtime history export <file> --json
ai-coding-runtime history import <file> --json
```

Human output:

```text
Exported 8 routing history record(s) to history.json; skipped 4.
Imported 7 routing history record(s); skipped 1 duplicate; rejected 0.
```

JSON output:

```json
{
  "status": "ok",
  "exported": 8,
  "skipped": 4,
  "path": "history.json"
}
```

For V1, keep options minimal. Do not add filters such as `--run-id`, `--since`, or `--include-raw`. They can be designed later once the format is proven.

## Report Integration

CLI `report` should load:

- native local runs through `store.listRecords()`
- imported learning records through `store.listImportedLearningRecords()`

Then it should pass both into `createReport` as history records.

Report output should include import summary metadata in the learning section, for example:

```json
{
  "learningProfile": {
    "recordsScanned": 20,
    "eligibleSamples": 14,
    "importedRecords": 7,
    "imported_records": 7
  }
}
```

This count is required for V1. The implementation may compute it in report assembly rather than inside `createLearningProfile`, but users must be able to tell how many scanned records came from imported history.

## Validation And Errors

Export should fail soft per local record:

- malformed records are skipped and counted
- privacy-sensitive fields are never copied
- unsupported statuses are excluded according to existing learning eligibility

Import should validate before writing:

- `schemaVersion` must equal `ai-coding-runtime.routing-history.v1`
- `records` must be an array
- each record must contain only allowed top-level fields
- each record must be independently sanitizable
- malformed records are rejected individually
- duplicates are skipped by `importId`
- unknown future schema versions are rejected

Import should be atomic per record, not all-or-nothing. One bad record should not block valid records in the same snapshot.

## Runtime Safety

Imported history must not affect:

- `createRuntimePlan`
- `routeTask`
- `routePlan`
- `executeRun`
- provider selection
- retry/escalation behavior
- verification commands
- approval policy

The only allowed consumer in Phase 11.1 is report/learning generation.

This should be protected by tests that create imported history with strong downgrade signals, run a new plan, and assert the planned tier remains controlled by the normal deterministic router.

## Testing Strategy

Add tests for:

- exporting a valid local run produces schema v1 and sanitized records
- exported snapshots do not contain request text, task titles, prompts, patches, stdout, stderr, or raw model output
- malformed local records are skipped during export
- importing valid snapshots writes imported records separately from `runs`
- importing the same snapshot twice skips duplicates
- importing unknown schema versions fails with a clear error
- importing malformed records rejects only those records
- `report` includes imported records in learning profile generation
- imported downgrade evidence does not affect planning or routing
- CLI `history export/import --json` output is stable

## Acceptance Criteria

- Users can export routing history to a local JSON snapshot.
- Users can import a snapshot into another runtime store.
- Imported history contributes to report-time learning profiles.
- Imported history does not affect live routing or execution.
- Snapshots contain only privacy-safe routing/learning metadata.
- Duplicate imports are skipped safely.
- Unsupported or malformed snapshots produce clear errors.
- Phase 11 roadmap can mark routing history export/import complete after tests pass.

## Follow-Up Path

After Phase 11.1:

- Phase 11.2 can add snapshot comparison reports.
- Phase 11.3 can consider advisory routing behind explicit user approval.
- HTTP/MCP import/export can be added only after the local CLI format is stable.
- Team-shared history should require a separate trust and privacy design.
