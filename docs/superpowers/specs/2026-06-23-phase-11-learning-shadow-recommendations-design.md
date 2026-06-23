# Phase 11.0 Learning Telemetry And Shadow Recommendations Design

**Objective:** Add the first safe learning loop for AI Coding Runtime by deriving model-tier outcome metrics from run history and surfacing shadow routing recommendations without changing live routing decisions.

## Context

The runtime already records plans, routing traces, worker attempts, model calls, verification results, reports, retry evidence, and escalation evidence. Phase 9 added report-level model reliability metrics, and Phase 10 added policy and safety controls. Phase 11 should build on those foundations, but real run history is still early.

This phase intentionally avoids automatic learned routing. The runtime should first learn in the background, explain what it would recommend, and let users inspect sample size and confidence before any future routing behavior changes.

## Scope

Phase 11.0 includes:

- a learning profile derived from persisted run records
- task/model outcome aggregation by stable bucket keys
- retry, escalation, and verification failure metrics
- shadow recommendations to use cheaper or stronger tiers
- a policy switch to disable learning output
- report, CLI, HTTP, and MCP exposure through the existing `runtime_report` surface

Phase 11.0 does not include:

- automatic changes to `routeTask` or `createRuntimePlan`
- model fine-tuning, embeddings, or probabilistic ML
- a separate hosted dashboard
- content-based learning from prompts, source code, model outputs, or patch bodies
- changing execution retry behavior beyond what already exists

## Recommended Approach

Create a new `src/runtime/learning.js` module and call it from `src/runtime/report.js`.

This keeps learning logic separate from routing and avoids turning `report.js` into the place where policy, aggregation, and recommendation rules all accumulate. The router remains deterministic in Phase 11.0. Reports become the single place where users can inspect what the runtime has learned.

Alternative approaches considered:

- Extend `createModelReliabilityMetrics` in `report.js`. This is smaller, but it would make report generation own too much learning behavior.
- Write learning data into a separate database immediately. This is closer to the final Phase 11 wording, but it adds storage complexity before the event shape is proven.
- Feed recommendations directly into routing. This is the final direction, but it is too early without enough real history and guardrails.

## Data Flow

1. A run is planned and executed normally.
2. The existing store persists plan, routing trace, worker attempts, model calls, verification, and events.
3. `runtime_report` loads the current record plus available history records.
4. `createLearningProfile(records, policy)` extracts privacy-safe learning samples.
5. Samples are aggregated into outcome buckets.
6. Recommendation rules produce shadow suggestions with confidence and evidence.
7. The report exposes `learningProfile` / `learning_profile` and a short markdown summary.

No learning output is fed back into planning or execution in this phase.

## Learning Sample Shape

Each eligible task contributes one learning sample. A sample should contain only metadata already needed for runtime auditability:

```json
{
  "runId": "run_123",
  "taskId": "T-002",
  "taskType": "implementation",
  "difficulty": "L2",
  "risk": "medium",
  "contextNeed": "medium",
  "verification": "easy",
  "plannedTier": "standard",
  "selectedProvider": "openai-compatible",
  "selectedModel": "gpt-4.1-mini",
  "selectedTier": "standard",
  "attemptCount": 2,
  "attemptedTiers": ["standard", "premium"],
  "retryCount": 1,
  "escalated": true,
  "workerStatus": "accepted",
  "verificationStatus": "passed",
  "failureCategories": [],
  "estimatedCost": 0.0123
}
```

Samples must not include:

- user request text
- source file contents
- patch contents
- model response text
- secret values
- raw command output

## Eligibility Rules

A task is eligible when:

- the run has an explicit final verification outcome of `passed` or `failed`
- the task has routing metadata
- the task is not purely a final supervisor review unless it has a model call or worker attempt
- the task can be associated with a planned tier

Skipped, planned-only, approval-pending, approval-rejected, canceled, and verification-skipped runs do not affect success-rate metrics. They may still be counted in a separate ignored summary so users understand why history did not contribute.

## Aggregation Buckets

The first implementation should aggregate by these bucket keys:

- `taskType + plannedTier`
- `taskType + difficulty + plannedTier`
- `taskType + risk + plannedTier`
- `taskType + verification + plannedTier`
- `taskType + selectedProvider + selectedModel`

Each bucket records:

- sample count
- success count and success rate
- failure count and failure rate
- retry count and retry rate
- escalation count and escalation rate
- verification failure count and rate
- malformed worker output count and rate
- provider failure count and rate
- average estimated cost when model call cost exists

The implementation may expose both camelCase and snake_case aliases to match the existing runtime contract style.

## Recommendation Rules

Recommendations are shadow-only. They explain what the runtime would consider, not what it will do.

Default policy:

```json
{
  "policy": {
    "learning": {
      "enabled": true,
      "mode": "shadow",
      "minSamples": 5,
      "cheapSuccessThreshold": 0.85,
      "strongerFailureThreshold": 0.3,
      "maxRetryRateForDowngrade": 0.15,
      "maxEscalationRateForDowngrade": 0.1
    }
  }
}
```

Cheaper-tier recommendation:

- bucket has at least `minSamples`
- current tier is above `cheap`
- comparable cheaper-tier bucket exists
- cheaper-tier success rate is at or above `cheapSuccessThreshold`
- cheaper-tier retry and escalation rates stay below downgrade limits
- task risk is not `high`
- recommendation would not violate existing safety floors

Stronger-tier recommendation:

- bucket has at least `minSamples`
- current tier has failure rate at or above `strongerFailureThreshold`, or escalation rate at or above the same threshold
- at least one stronger tier exists in configured tier order
- recommendation explains whether failures are verification, provider, malformed output, policy, or acceptance related

Hold recommendation:

- sample size is too small
- signals are mixed
- safety policy blocks cheaper routing
- failures are not model-quality related

## Confidence

Each recommendation includes:

- `confidence`: `low`, `medium`, or `high`
- `sampleCount`
- `successRate`
- `retryRate`
- `escalationRate`
- `reason`
- `evidence`

Confidence mapping:

- `low`: fewer than `minSamples * 2` samples, or mixed signals
- `medium`: at least `minSamples * 2` samples with consistent outcome direction
- `high`: at least `minSamples * 4` samples with stable success/failure and low contradiction

Low-confidence recommendations are still useful during early history collection, but they must be clearly labeled as exploratory.

## Policy And Privacy

Add `policy.learning` support through the existing runtime config normalization path.

Supported Phase 11.0 modes:

- `off`: do not generate learning profile or recommendations
- `shadow`: generate learning profile and recommendations, but do not affect routing

Future modes such as `advisory` and `auto` are intentionally out of scope. If configured in Phase 11.0, they should be normalized to `shadow`, and the learning profile should include a warning that the requested mode is not active yet. This is safer than rejecting an otherwise valid local config and safer than silently enabling behavior that does not exist.

Privacy stance:

- learning is local-only
- no raw prompts, code, patches, command output, or model output are copied into learning samples
- export data contains aggregated metadata unless a future explicit raw-history export mode is added
- `policy.learning.enabled=false` fully suppresses learning output in reports

## Report Surface

`runtime_report` should include:

```json
{
  "learningProfile": {
    "enabled": true,
    "mode": "shadow",
    "generatedAt": "2026-06-23T00:00:00.000Z",
    "recordsScanned": 12,
    "eligibleSamples": 8,
    "ignoredRecords": 4,
    "buckets": [],
    "recommendations": []
  }
}
```

The markdown report should include a short section:

```text
## Learning
- mode: shadow
- eligible samples: 8 from 12 records
- recommendations:
  - implementation/L2 standard: hold, sample size too small
  - documentation/L1 standard: consider cheap, 6/6 passed with no escalation
```

When learning is disabled:

```json
{
  "learningProfile": {
    "enabled": false,
    "mode": "off",
    "reason": "Learning disabled by policy."
  }
}
```

## Export And Import Boundary

Phase 11.0 should support export by making the aggregated `learningProfile` JSON stable and documented. This is enough for users to save or compare learning snapshots.

Full import is deferred to Phase 11.1. Importing external routing history safely requires versioning, source trust, duplicate detection, and privacy review. The Phase 11.0 implementation should not accept imported history for routing recommendations yet.

## Error Handling

Learning should fail soft.

- malformed historical records are ignored and counted
- unknown tiers are grouped under `unknown` but never recommended
- missing verification outcomes exclude samples from success metrics
- missing cost estimates produce `averageEstimatedCost=null`
- disabled learning returns a minimal disabled profile
- report generation must not fail because learning aggregation fails

If aggregation throws unexpectedly, the report should include a learning error summary and continue producing the rest of the report.

## Testing Strategy

Add tests for:

- sample extraction from passed and failed verified runs
- exclusion of planned, approval-pending, canceled, and verification-skipped runs
- aggregation by task type, difficulty, risk, verification, tier, provider, and model
- retry and escalation rate calculation
- verification failure pattern counting
- cheaper-tier shadow recommendation thresholds
- stronger-tier shadow recommendation thresholds
- safety-floor downgrade blocking
- disabled policy output
- privacy shape: no request text, patch body, model output, or command output in samples
- report JSON and markdown exposure
- route creation remains unchanged by learning output

## Acceptance Criteria

- `runtime_report` exposes a learning profile derived from real run history.
- Users can inspect why a shadow recommendation was made.
- Learning can be disabled by policy.
- Recommendations do not affect planning, routing, execution, retries, or verification.
- The profile contains only privacy-safe metadata.
- Existing Phase 9 reliability reporting remains compatible or is cleanly mapped to the new learning profile.
- Phase 11 remains incomplete until import support and any future routing integration are intentionally designed.

## Follow-Up Path

After Phase 11.0 ships, collect real run samples before moving forward:

- 10 to 30 local runs for early signal checks
- at least 5 samples in one comparable bucket before trusting a recommendation
- at least one repeated cheap/standard/premium comparison before considering advisory mode

Phase 11.1 should design importable routing history and snapshot comparison. Phase 11.2 can consider advisory routing, where the runtime asks the user before applying a learned recommendation. Automatic routing should stay out of scope until there is enough history to prove the recommendations are stable.
