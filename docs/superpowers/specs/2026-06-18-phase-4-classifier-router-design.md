# Phase 4 Classifier And Router Design

## Goal

Phase 4 adds a deterministic V0 classifier and model router to the local runtime. The runtime should explain model tier choices, enforce simple budget and policy limits before persisted execution, and record escalation decisions for failed low-tier attempts.

## Architecture

The router lives in `src/runtime/router.js` and owns classification, model registry defaults, routing policy defaults, budget policy defaults, and escalation evaluation. `src/runtime/planner.js` keeps plan construction but delegates task classification and routing to the router. Existing response shapes remain compatible: tasks still expose `modelTier`, `model_tier`, and `routingReason`.

## Data Model

Each task gets:

- `classification`: `difficulty`, `risk`, `context_need`, `verification`, `confidence`, `reasoning`
- `routing`: selected `model_tier`, selected registry entry, routing inputs, reason text, and escalation triggers
- compatibility aliases: `modelTier`, `model_tier`, `routingReason`

Each plan gets:

- `modelTierAliases`: `cheap`, `standard`, `premium`
- `modelRegistry`: entries with `provider`, `model`, `tier`, `cost_hint`, `context_window`, `tool_support`, `strengths`, `blocked_task_types`
- `routingPolicy`, `budgetPolicy`, `escalationPolicy`
- `budgetStatus`: `allowed`, estimated cost/calls/retries, and violations
- `routingTrace`: one route record per task

## Routing Rules

The default table follows `total.md`:

- `L0`: cheap, escalate on missing/conflicting result
- `L1`: cheap, escalate on invalid patch or failed checks
- `L2`: standard, escalate on failed tests or uncertain diff
- `L3`: premium, always final review
- `L4`: premium, human approval required

File-editing tasks are never routed below `standard`. Final verification tasks always use `premium` unless a later policy phase adds an explicit override.

## Budget And Policy

The V0 budget policy is deterministic and local:

- `maxCostPerRun`
- `maxCallsPerRun`
- `maxRetryCount`

If routing violates any budget control, `createRuntimePlan` still returns a plan with `budgetStatus.allowed=false` for inspection. Persisted execution through `FileExecutionStore.createRecord` refuses the plan.

## Escalation

`evaluateEscalation` returns trace records for:

- failed tests
- malformed output
- forbidden file access
- low classifier confidence
- user policy violation

Escalation moves `cheap -> standard -> premium`, keeps `premium` at `premium`, and marks human approval when the reason is a user policy violation or an L4/high-risk case.

## Testing

Tests cover classifier output fields, registry shape, file-editing routing, final verification routing, budget refusal, escalation traces, plan metadata exposure, and report/estimate inclusion.
