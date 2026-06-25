# Shadow LLM Classifier Design

## Objective

Add a shadow LLM classifier that makes model-tier savings visible without changing live routing decisions.

The current router uses deterministic task fields to choose `cheap`, `standard`, or `premium`. That is safe, but it cannot show when a cheaper model might have been enough. The shadow classifier should run beside the deterministic classifier, compare recommendations, and expose potential savings with enough reasoning for a human to trust or reject the signal.

## Product Principle

This phase is advisory only. It must not change planning, routing, execution, retries, verification, provider selection, approval gates, or policy enforcement.

The goal is to make the cost story observable:

- Which tasks did the LLM think could use a cheaper tier?
- How much cheaper might the run have been?
- Which safety floors prevented an automatic downgrade?
- How confident was the classifier?

## Scope

This phase includes:

- A provider-backed classifier prompt for task-level shadow classification.
- A strict output schema for LLM classification results.
- Validation and normalization of classifier output.
- A deterministic fallback when the classifier is disabled, unavailable, malformed, or fails.
- Plan/report metadata that records shadow recommendations and potential savings.
- Tests proving shadow recommendations do not affect actual routing.

This phase does not include:

- Automatic learned routing.
- Advisory routing that asks the user to accept a cheaper tier.
- Changing `routeTask`, `routePlan`, or `createRuntimePlan` selected tiers based on LLM output.
- Using raw prompts, patches, source code, model responses, or command output as persistent learning data.
- A Phase 12 UI.

## Architecture

Add a focused runtime module for shadow classification, separate from the deterministic router:

- `src/runtime/shadow-classifier.js` owns prompt construction, output normalization, safety comparison, and savings estimates.
- `src/runtime/planner.js` optionally invokes the shadow classifier after deterministic routing has produced task routes.
- `src/runtime/report.js` exposes the final shadow classification summary in JSON and Markdown.
- `src/runtime/policy.js` or existing config normalization owns a small policy section that can enable or disable the feature.

The deterministic router remains the source of truth for `modelTier`, `model_tier`, `selectedModel`, routing traces, budget policy, and approval gates.

## Configuration

Add an optional policy/config section:

```json
{
  "policy": {
    "shadowClassifier": {
      "enabled": false,
      "mode": "shadow",
      "provider": "openai-compatible",
      "model": "gpt-5.4-mini",
      "minConfidence": 0.7
    }
  }
}
```

Defaults:

- `enabled: false`
- `mode: "off"` when disabled, `mode: "shadow"` when enabled
- `provider` and `model` may be omitted; if omitted, Runtime should use the configured cheap or standard provider only when available
- `minConfidence: 0.7`

Invalid or unsupported future modes normalize to `shadow` only when enabled, with a warning. Missing provider configuration disables the classifier for that run and records a warning instead of failing planning.

## Classifier Input

The classifier receives only task metadata and deterministic routing context:

- task id
- task title/description
- acceptance criteria
- allowed file patterns
- deterministic classification
- deterministic selected tier/model
- final verification flag
- known safety floors such as file-editing minimum tier and final verification minimum tier

It must not receive:

- file contents
- raw prompts
- patch bodies
- command output
- credentials
- environment variables
- raw provider responses from prior calls

## Classifier Output

The model should return one normalized object per task:

```json
{
  "task_id": "T-001",
  "difficulty": "L1",
  "risk": "low",
  "context_need": "low",
  "verification": "easy",
  "recommended_tier": "cheap",
  "confidence": 0.82,
  "reasoning": [
    "Read-only documentation task",
    "Low context need",
    "Easy verification"
  ]
}
```

Runtime validates every field. Unknown enum values are replaced with the deterministic value. Missing confidence becomes `0`. Reasoning is truncated to short strings.

## Shadow Decision Model

For each task, Runtime compares:

- deterministic tier
- LLM recommended tier
- safety floor tier
- confidence
- estimated model cost delta

Output categories:

- `agree`: LLM recommendation matches deterministic routing.
- `potential_savings`: LLM recommends a cheaper tier, confidence is high enough, and the recommendation does not go below the safety floor.
- `blocked_by_safety_floor`: LLM recommends a cheaper tier but file-editing, final verification, risk, or policy floors prevent it.
- `stronger_recommended`: LLM recommends a more capable tier.
- `ignored_low_confidence`: recommendation confidence is below `minConfidence`.
- `unavailable`: classifier did not run or output was unusable.

None of these categories change the selected tier.

## Savings Estimate

Savings are advisory and use the existing model registry `cost_hint.estimated_usd_per_call`.

For each `potential_savings` task:

```text
deterministic_model_cost - recommended_model_cost
```

The report should include:

- total potential savings
- count of tasks with potential savings
- count blocked by safety floors
- count ignored due to low confidence
- per-task recommendation summaries

If model costs are unknown, savings should be `0` with a warning such as `shadow_classifier.cost_hint_missing`.

## Report Shape

Plan/report JSON should expose both camelCase and snake_case aliases:

```json
{
  "shadowClassifier": {
    "enabled": true,
    "mode": "shadow",
    "provider": "openai-compatible",
    "model": "gpt-5.4-mini",
    "status": "completed",
    "summary": {
      "potentialSavingsUsd": 0.12,
      "potential_savings_usd": 0.12,
      "potentialSavingsTasks": 2,
      "blockedBySafetyFloorTasks": 1,
      "ignoredLowConfidenceTasks": 1
    },
    "recommendations": []
  },
  "shadow_classifier": {}
}
```

Markdown reports should add a concise section:

```text
## Shadow LLM Classifier
- status: completed
- potential savings: USD 0.12 across 2 task(s)
- blocked by safety floor: 1
- ignored for low confidence: 1
```

## Error Handling

The classifier must fail soft:

- provider missing: record `unavailable`, continue deterministic planning
- provider error: record `unavailable`, continue deterministic planning
- malformed JSON: record `unavailable`, continue deterministic planning
- invalid task ids: ignore invalid recommendations and record a warning
- partial output: keep valid recommendations and warn about missing tasks

Planning should not throw because the shadow classifier failed.

## Privacy And Safety

The classifier prompt and persisted output must remain metadata-only. It should not include secrets, raw file contents, command output, patch text, worker prompts, or previous model responses.

The feature must preserve existing policy boundaries:

- no route may be downgraded automatically
- file-editing tasks cannot bypass the standard minimum tier
- final verification cannot bypass the premium tier
- high-risk/L4 approval behavior is unchanged
- budget and policy refusal behavior is unchanged

## Testing

Tests should prove:

- policy/config defaults keep the classifier disabled
- enabling the classifier records shadow metadata without changing deterministic routing
- low-risk read-only tasks can produce `potential_savings`
- file-editing tasks below the standard floor produce `blocked_by_safety_floor`
- low-confidence recommendations produce `ignored_low_confidence`
- malformed provider output fails soft and does not break planning
- report JSON and Markdown expose the shadow classifier summary
- no raw task file contents or credentials enter classifier prompts or report output

## Acceptance Criteria

- `createRuntimePlan` output remains deterministic when the classifier is disabled.
- When enabled with a configured provider, plans/reports include shadow classifier metadata.
- LLM recommendations never alter `modelTier`, `model_tier`, `routingTrace`, task execution order, approval gates, or verification behavior.
- Savings estimates are visible when cost hints exist.
- Safety-floor blocks are visible and explain why cheaper suggestions were not adopted.
- Tests cover success, blocked, low-confidence, malformed-output, privacy, and non-regression cases.

## Follow-Up

After this phase ships and accumulates real runs:

1. Add a small Phase 12 visualization that shows deterministic route vs shadow recommendation per task.
2. Collect enough real samples to compare shadow recommendations with verification outcomes.
3. Design an explicit advisory routing mode where the user can accept a downgrade before execution.
