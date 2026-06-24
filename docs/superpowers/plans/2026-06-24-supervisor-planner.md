# Supervisor Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in supervisor planner that lets a strong model dynamically draft task contracts before the existing router, executor, and verifier take over.

**Architecture:** Keep `createRuntimePlan` synchronous and backward compatible. Add an async supervisor-planning layer that calls a configured provider, validates/sanitizes model-produced task drafts, then delegates final routing, approval, reports, and validation to the existing runtime plan builder. If supervisor planning is disabled or fails, return the current deterministic plan and record fallback metadata.

**Tech Stack:** Node.js ESM, built-in `node:test`, existing provider adapters, existing runtime contracts/router.

---

### Task 1: Plan Builder Seam

**Files:**
- Modify: `src/runtime/planner.js`
- Test: `tests/runtime.test.js`

- [x] Write a failing test showing `createRuntimePlan` can accept explicit task drafts and still produce valid routed metadata.
- [x] Run `node --test tests/runtime.test.js --test-name-pattern "explicit task drafts"` and confirm it fails because the option is ignored.
- [x] Add a `taskDrafts` option to `createRuntimePlan`; when present, use those drafts instead of default template drafts.
- [x] Run the focused test and confirm it passes.

### Task 2: Supervisor Planner Module

**Files:**
- Create: `src/runtime/supervisor-planner.js`
- Modify: `src/index.js`
- Test: `tests/runtime.test.js`

- [x] Write a failing test for `createRuntimePlanWithSupervisor` using an injected deterministic `generate` function that returns task JSON.
- [x] Write a failing fallback test where malformed supervisor output returns a deterministic plan with supervisor metadata explaining the fallback.
- [x] Implement prompt creation, provider request construction, JSON parsing, task draft sanitization, and fallback handling.
- [x] Export the new helper from `src/index.js`.
- [x] Run the focused tests and confirm they pass.

### Task 3: Tool And Config Integration

**Files:**
- Modify: `src/runtime/tools.js`
- Modify: `src/runtime/config.js`
- Modify: `src/cli.js`
- Modify: `runtime.config.example.json`
- Test: `tests/runtime.test.js`

- [x] Write a failing test showing `callRuntimeTool("runtime_plan")` uses supervisor planning when `runtimeOptions.planning.supervisor.enabled=true`.
- [x] Add default config for `planning.supervisor`.
- [x] Pass `config.planning` through `runtimeOptionsFromConfig`.
- [x] Update `runtime_plan`, `runtime_estimate`, and `runtime_run` to await the supervisor-aware helper.
- [x] Run focused tests, then `npm test`.

### Task 4: Review And Verification

**Files:**
- Create/update: `.ai-review/review-context/current-request.md`

- [x] Create self-contained review context describing the user request, design, acceptance criteria, non-goals, and verification.
- [x] Run `git diff --check`.
- [x] Run `npm test`.
- [x] Run the AI code review loop.
- [x] Fix any blocking `P0/P1` findings and rerun verification.
