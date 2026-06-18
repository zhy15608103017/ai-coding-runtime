# Phase 4 Classifier Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic Phase 4 classifier, model router, budget guard, and escalation trace surface to the runtime.

**Architecture:** Add a focused router module and wire planner, store, tools, report, and config to that module. Keep Phase 3 plan/task contract compatibility while adding Phase 4 metadata.

**Tech Stack:** Node.js ESM, `node:test`, local JSON persistence.

---

## File Structure

- Create `src/runtime/router.js`: classifier, model registry, routing policy, budget policy, escalation policy, route and budget helpers.
- Modify `src/runtime/planner.js`: call router helpers, attach plan-level routing metadata, preserve `routeTask` export.
- Modify `src/runtime/contracts.js`: validate new routing/budget metadata at plan level without breaking approved persisted records.
- Modify `src/runtime/store.js`: reject `budgetStatus.allowed=false` plans and add routing events when records are created.
- Modify `src/runtime/tools.js`: include Phase 4 metadata in estimates.
- Modify `src/runtime/report.js`: include routing trace, budget status, and escalation policy in reports.
- Modify `src/runtime/config.js`: add default routing budget controls and registry config shape.
- Modify `src/index.js`: export router helpers needed by tests and integrations.
- Modify `tests/runtime.test.js`, `tests/gateway.test.js`, `tests/cli.test.js`: Phase 4 coverage.
- Modify `README.md` and `docs/integrations.md`: document Phase 4 response metadata and budget refusal.

### Task 1: Router API And Unit Tests

- [ ] Write failing tests in `tests/runtime.test.js` for `classifyTask`, `routeTask`, `evaluateBudgetPolicy`, and `evaluateEscalation`.
- [ ] Run `npm test -- tests/runtime.test.js` and confirm the new imports or assertions fail because router APIs do not exist.
- [ ] Create `src/runtime/router.js` with the minimal exported helpers and default policy data.
- [ ] Export helpers from `src/index.js`.
- [ ] Run `npm test -- tests/runtime.test.js` and confirm router unit tests pass.

### Task 2: Planner Integration

- [ ] Write failing tests that `createRuntimePlan` exposes `modelTierAliases`, `modelRegistry`, `routingPolicy`, `budgetPolicy`, `escalationPolicy`, `budgetStatus`, and `routingTrace`.
- [ ] Run `npm test -- tests/runtime.test.js` and confirm the metadata assertions fail.
- [ ] Update `src/runtime/planner.js` to use `routePlan` and attach Phase 4 metadata.
- [ ] Keep task aliases `modelTier`, `model_tier`, `routingReason`, and `context_need` stable.
- [ ] Run `npm test -- tests/runtime.test.js` and confirm planner tests pass.

### Task 3: Validation And Persistence Guards

- [ ] Write failing tests that `validateRuntimePlan` rejects missing routing trace and that `FileExecutionStore.createRecord` rejects budget-disallowed plans.
- [ ] Run `npm test -- tests/runtime.test.js` and confirm expected failures.
- [ ] Update `src/runtime/contracts.js` to validate new Phase 4 metadata.
- [ ] Update `src/runtime/store.js` to refuse budget/policy violations and append `task.routed` trace events.
- [ ] Run `npm test -- tests/runtime.test.js` and confirm validation and persistence tests pass.

### Task 4: Tools, Reports, Config, And Docs

- [ ] Write failing assertions in gateway/CLI/runtime tests for estimate/report exposure.
- [ ] Run relevant tests and confirm expected failures.
- [ ] Update `src/runtime/tools.js`, `src/runtime/report.js`, and `src/runtime/config.js`.
- [ ] Update `README.md` and `docs/integrations.md`.
- [ ] Run `npm test` and `git diff --check`.

### Task 5: Review Loop

- [ ] Update `.ai-review/review-context/current-request.md` with Phase 4 requirements.
- [ ] Run `node .agents/skills/code-review-loop/scripts/ai-review.mjs --profile auto --verify "git diff --check"`.
- [ ] Fix blocking `P0/P1` findings and repeat review up to three times.
- [ ] Report verification commands and review result.
