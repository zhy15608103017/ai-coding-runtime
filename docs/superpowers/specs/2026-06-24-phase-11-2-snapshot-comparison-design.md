# Phase 11.2 Snapshot Comparison Design

**Objective:** Add a report-only comparison mode for two routing history snapshots so users can understand how imported or accumulated history changes learning signals, recommendation confidence, cost patterns, and routing risk before any future advisory routing work.

## Context

Phase 11.0 added local shadow learning profiles and recommendations derived from run history. Phase 11.1 added privacy-safe routing history export/import through schema-versioned snapshots. Users can now move learning evidence between runtime stores, but they still need a way to answer a practical question:

```text
What changed after this history was added?
```

Without comparison, a user can inspect only the final `learningProfile`. They cannot easily tell which task buckets gained evidence, which recommendations changed, whether cheap-tier confidence improved, whether failures increased, or whether imported history added noise.

Phase 11.2 should remain observational. It explains historical signal changes; it does not influence routing, execution, verification, retries, provider selection, or policy.

## Recommended Approach

Implement **Learning Profile Comparison**.

The runtime should read two Phase 11.1 routing history snapshots, derive a learning profile from each snapshot, then compare the resulting profiles. This produces a domain-specific comparison instead of a generic JSON diff.

This approach is recommended because:

- it reuses the existing learning model instead of inventing a second metric system
- it compares routing-relevant concepts such as buckets and recommendations
- it is resilient to harmless snapshot field ordering or metadata differences
- it keeps privacy boundaries intact because snapshots are already sanitized
- it creates evidence needed before any future advisory routing mode

## Alternatives Considered

### Generic Snapshot JSON Diff

Compare the two JSON files field by field.

This is easy to implement, but low value. Users would see structural changes instead of learning meaning. A generic diff can say that records changed, but not whether confidence improved, failure risk increased, or a recommendation flipped.

### Report File Diff

Generate full runtime reports before and after import, then compare reports.

This gives more context, but it mixes current-run details with historical learning changes. Snapshot comparison should be independent of a particular run.

### Import Then Compare Store State

Compare current store learning before and after importing a snapshot.

This is closer to real workflow, but it has side effects and makes comparison harder to trust. Phase 11.2 should be pure: two input files in, comparison out, no store writes.

## Scope

Phase 11.2 includes:

- a runtime comparison module for two routing history snapshots
- validation that both inputs use `ai-coding-runtime.routing-history.v1`
- learning profile generation for each snapshot
- bucket-level metric deltas
- recommendation added/removed/changed detection
- risk and confidence summaries
- CLI command for JSON and Markdown output
- tests for comparison behavior, privacy, malformed input, and no runtime side effects

Phase 11.2 does not include:

- importing snapshots into the local store
- modifying existing imported history
- changing routing decisions
- advisory routing
- automatic routing
- HTTP or MCP comparison endpoints
- UI charts
- generic JSON diff mode
- raw prompt/source/patch/stdout/stderr comparison

## CLI Surface

Add a `history compare` subcommand:

```bash
ai-coding-runtime history compare before.json after.json --json
ai-coding-runtime history compare before.json after.json --markdown
```

Default human output should be Markdown because comparison is explanatory. `--json` should output a stable machine-readable object.

Invalid usage should list supported forms:

```text
history compare requires two snapshot file paths.
Usage:
  ai-coding-runtime history compare <before.json> <after.json> [--json|--markdown]
```

## Comparison Input

Both inputs must be Phase 11.1 snapshots:

```json
{
  "schemaVersion": "ai-coding-runtime.routing-history.v1",
  "records": []
}
```

The compare command should not require snapshots to have been imported. It should not read or write `FileExecutionStore`.

If either snapshot is malformed:

- return a clear error
- do not produce partial comparison output
- do not write to the store

Unknown future schema versions should be rejected in V1 rather than silently compared.

## Comparison Output

JSON output:

```json
{
  "schemaVersion": "ai-coding-runtime.snapshot-comparison.v1",
  "generatedAt": "2026-06-24T00:00:00.000Z",
  "before": {
    "records": 10,
    "eligibleSamples": 8,
    "recommendations": 2
  },
  "after": {
    "records": 20,
    "eligibleSamples": 17,
    "recommendations": 4
  },
  "summary": {
    "recordDelta": 10,
    "eligibleSampleDelta": 9,
    "recommendationDelta": 2,
    "newRecommendations": 2,
    "removedRecommendations": 0,
    "changedRecommendations": 1,
    "riskFlags": []
  },
  "bucketChanges": [],
  "recommendationChanges": [],
  "riskFlags": []
}
```

Markdown output:

```text
# Routing History Snapshot Comparison

## Summary
- records: 10 -> 20 (+10)
- eligible samples: 8 -> 17 (+9)
- recommendations: 2 -> 4 (+2)

## Recommendation Changes
- added: implementation/L2/standard -> consider_cheaper_tier
- changed: documentation/L1/standard confidence low -> medium

## Bucket Changes
- implementation/L2/standard: success 60% -> 86%, retry 20% -> 8%

## Risk Flags
- none
```

## Bucket Diff Model

Compare learning buckets by stable identity:

```text
bucket.type + canonical(bucket.key)
```

For each matched bucket, calculate deltas for:

- `sampleCount`
- `successRate`
- `failureRate`
- `retryRate`
- `escalationRate`
- `verificationFailureRate`
- `malformedWorkerOutputRate`
- `providerFailureRate`
- `averageEstimatedCost`

For added buckets:

- mark `changeType: "added"`
- include after metrics

For removed buckets:

- mark `changeType: "removed"`
- include before metrics

For changed buckets:

- mark `changeType: "changed"`
- include before, after, and delta values

For unchanged buckets:

- omit them from default output
- include them only if a future `--all` option is covered by a separate design

V1 should not add `--all`.

## Recommendation Diff Model

Compare recommendations by stable identity:

```text
bucket.type + canonical(bucket.key)
```

Track:

- added recommendations
- removed recommendations
- action changes, such as `hold` to `consider_cheaper_tier`
- confidence changes
- reason changes
- sample count changes

Recommendation changes are more user-facing than raw bucket changes and should appear first in Markdown.

## Risk Flags

Generate warning-style flags when comparison reveals potentially unsafe or noisy history changes:

- `sample_size_low`: after snapshot still has too few samples for a changed recommendation
- `failure_rate_increased`: failure rate increased by at least 0.15 for a comparable bucket
- `retry_rate_increased`: retry rate increased by at least 0.15
- `escalation_rate_increased`: escalation rate increased by at least 0.10
- `recommendation_regressed`: recommendation moved from cheaper/hold to stronger tier
- `cost_increased`: average estimated cost increased by at least 25% where both sides have cost data
- `signals_mixed`: success rate improved but retry or escalation rate also increased materially

Risk flags should be explanatory only. They must not affect runtime behavior.

## Privacy And Safety

Snapshot comparison must not include:

- raw request text
- prompt text
- source contents
- patch contents
- command output
- model responses
- environment variables
- provider credentials

Because Phase 11.1 snapshots are already sanitized, Phase 11.2 should operate only on sanitized snapshot records. It should not accept raw run records as compare input.

The comparison module must be pure:

- no store reads
- no store writes
- no import side effects
- no routing side effects
- no execution side effects

## Module Design

Create or extend a focused runtime module:

```text
src/runtime/history-comparison.js
```

Responsibilities:

- validate two snapshot objects
- derive learning profiles from snapshot records
- normalize bucket and recommendation identities
- compute summary deltas
- compute bucket changes
- compute recommendation changes
- compute risk flags
- format Markdown comparison output

Keep export/import concerns in `src/runtime/history.js`. Keep report generation in `src/runtime/report.js`. Comparison deserves a separate module because it has different responsibilities and should stay pure.

Expected public functions:

```javascript
export function compareRoutingHistorySnapshots(beforeSnapshot, afterSnapshot, options = {}) {}
export function formatSnapshotComparisonMarkdown(comparison) {}
```

Export these functions from `src/index.js` for tests and future integrations.

## CLI Integration

Extend existing `historyCommand` in `src/cli.js`:

```text
history export
history import
history compare
```

`history compare` should:

1. read two JSON files
2. parse both snapshots
3. call `compareRoutingHistorySnapshots`
4. print JSON when `--json` is provided
5. print Markdown otherwise or when `--markdown` is provided

The command should not create a `FileExecutionStore`.

## Error Handling

Comparison should fail with actionable messages:

- missing before path: `history compare requires two snapshot file paths.`
- missing after path: `history compare requires two snapshot file paths.`
- invalid JSON: include file path and parse failure
- unsupported schema: include actual schema value
- malformed records: reject the snapshot rather than silently comparing partial data

Unlike export, comparison should not skip malformed records. It is an analysis tool, and silently comparing partial data can mislead users.

## Testing Strategy

Add tests for:

- comparing two valid snapshots produces summary deltas
- added bucket appears in `bucketChanges`
- changed success/retry/escalation rates are calculated
- added recommendation appears in `recommendationChanges`
- confidence change appears in `recommendationChanges`
- risk flags appear for increased failure/retry/escalation/cost
- Markdown output includes summary, recommendation changes, bucket changes, and risk flags
- CLI `history compare before after --json` works
- CLI `history compare before after --markdown` works
- malformed or unsupported snapshots fail clearly
- compare command does not write imported history or local runs
- comparison output does not contain raw prompt/source/patch/stdout/stderr content

## Acceptance Criteria

- Users can compare two routing history snapshot files without importing either one.
- The comparison explains learning-significant differences, not generic JSON changes.
- Recommendation changes are visible and easy to inspect.
- Bucket metric deltas are visible for changed/added/removed buckets.
- Risk flags highlight noisy or regressive history changes.
- Comparison has no store, routing, execution, provider, or verification side effects.
- Output is available in both JSON and Markdown.
- The comparison preserves Phase 11 privacy boundaries.

## Follow-Up Path

After Phase 11.2:

- Phase 11.3 can add `history compare --against-store` if there is demand.
- Phase 11.4 can add advisory routing design using comparison evidence as a prerequisite.
- Phase 12 UI can visualize comparison output without needing to know snapshot internals.
