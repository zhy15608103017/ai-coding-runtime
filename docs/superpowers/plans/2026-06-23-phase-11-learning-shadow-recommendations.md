# Phase 11 Learning Shadow Recommendations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Phase 11.0 learning telemetry and shadow routing recommendations derived from run history without changing live routing decisions.

**Architecture:** Add a focused `src/runtime/learning.js` module that extracts privacy-safe samples from persisted run records, aggregates outcome buckets, and emits shadow recommendations. Keep routing deterministic by integrating learning only into `createReport()` / `runtime_report`, with policy controls in the existing Phase 10 policy config path.

**Tech Stack:** Node.js ESM, `node:test`, existing runtime report/store/policy modules, JSON runtime config

---

## File Structure

- Create: `src/runtime/learning.js`
  - Owns learning sample extraction, aggregation, recommendation rules, confidence labels, and disabled/error profiles.
- Modify: `src/runtime/policy.js`
  - Adds `policy.learning` defaults, alias normalization, and validation.
- Modify: `src/runtime/report.js`
  - Imports learning, calls it from `createReport()`, exposes `learningProfile` / `learning_profile`, and renders a Markdown section.
- Modify: `src/index.js`
  - Exports learning helpers for focused unit tests and future consumers.
- Create: `tests/phase11-learning.test.js`
  - Covers policy normalization, learning extraction, aggregation, recommendations, privacy shape, report exposure, and routing non-regression.
- Modify: `tests/phase8-integrations.test.js`, `tests/phase9-reporting.test.js`, `tests/phase10-policy-safety-team.test.js`
  - Loosen old "Phase 11 is entirely unchecked" assertions after Phase 11.0 marks partial roadmap progress.
- Modify: `README.md`, `docs/integrations.md`, `total.md`
  - Document report-level learning output and mark only completed Phase 11.0 checklist items.

## Implementation Notes

- Preserve camelCase and snake_case aliases on public report fields.
- Do not add learned routing to `routeTask()`, `routePlan()`, or `createRuntimePlan()`.
- Do not include request text, source contents, patches, model output, worker prompts, or command output in learning samples.
- Treat `policy.learning.mode: "advisory"` and `"auto"` as normalized shadow mode with a warning.
- Keep import support out of scope; only stable report JSON export is included.

---

### Task 1: Add Learning Policy Defaults And Validation

**Files:**
- Modify: `src/runtime/policy.js`
- Test: `tests/phase11-learning.test.js`

- [ ] **Step 1: Write failing tests for learning policy defaults, aliases, disabled mode, and future-mode normalization**

Add this import block to the top of `tests/phase11-learning.test.js`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createLearningProfile,
  createReport,
  createRuntimePlan,
  formatReportMarkdown,
  normalizePolicyConfig,
  validatePolicyConfig,
} from "../src/index.js";
```

Create these tests:

```js
test("Phase 11 policy config exposes learning defaults", () => {
  const policy = normalizePolicyConfig();

  assert.equal(policy.learning.enabled, true);
  assert.equal(policy.learning.mode, "shadow");
  assert.equal(policy.learning.minSamples, 5);
  assert.equal(policy.learning.cheapSuccessThreshold, 0.85);
  assert.equal(policy.learning.strongerFailureThreshold, 0.3);
  assert.equal(policy.learning.maxRetryRateForDowngrade, 0.15);
  assert.equal(policy.learning.maxEscalationRateForDowngrade, 0.1);
});

test("Phase 11 policy config normalizes learning aliases and future modes to shadow", () => {
  const policy = normalizePolicyConfig({
    learning: {
      enabled: true,
      mode: "auto",
      min_samples: 7,
      cheap_success_threshold: 0.9,
      stronger_failure_threshold: 0.4,
      max_retry_rate_for_downgrade: 0.2,
      max_escalation_rate_for_downgrade: 0.12,
    },
  });

  assert.equal(policy.learning.mode, "shadow");
  assert.equal(policy.learning.requestedMode, "auto");
  assert.equal(policy.learning.requested_mode, "auto");
  assert.deepEqual(policy.learning.warnings, ["policy.learning.mode.auto.normalized_to_shadow"]);
  assert.equal(policy.learning.minSamples, 7);
  assert.equal(policy.learning.cheapSuccessThreshold, 0.9);
  assert.equal(policy.learning.strongerFailureThreshold, 0.4);
  assert.equal(policy.learning.maxRetryRateForDowngrade, 0.2);
  assert.equal(policy.learning.maxEscalationRateForDowngrade, 0.12);
});

test("Phase 11 policy validation reports invalid learning fields", () => {
  const validation = validatePolicyConfig({
    learning: {
      enabled: "yes",
      mode: "aggressive",
      minSamples: 0,
      cheapSuccessThreshold: 2,
      strongerFailureThreshold: -0.1,
      maxRetryRateForDowngrade: "low",
      maxEscalationRateForDowngrade: 1.5,
    },
  });

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.code === "policy.learning.enabled.invalid"));
  assert.ok(validation.errors.some((error) => error.code === "policy.learning.mode.invalid"));
  assert.ok(validation.errors.some((error) => error.code === "policy.learning.min_samples.invalid"));
  assert.ok(validation.errors.some((error) => error.code === "policy.learning.threshold.invalid"));
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test tests/phase11-learning.test.js`

Expected: FAIL because `tests/phase11-learning.test.js` exists but `createLearningProfile` is not exported, or because `policy.learning` fields are missing.

- [ ] **Step 3: Add learning defaults to `DEFAULT_POLICY_CONFIG`**

In `src/runtime/policy.js`, add this top-level section after `routing`:

```js
  learning: {
    enabled: true,
    mode: "shadow",
    minSamples: 5,
    cheapSuccessThreshold: 0.85,
    strongerFailureThreshold: 0.3,
    maxRetryRateForDowngrade: 0.15,
    maxEscalationRateForDowngrade: 0.1,
  },
```

- [ ] **Step 4: Add learning alias normalization**

In `normalizePolicyConfig()`, call:

```js
  normalizeLearningAliases(normalized.learning);
```

Add this helper near the other alias normalizers:

```js
function normalizeLearningAliases(learning) {
  if (!isPlainObject(learning)) return;
  learning.enabled = learning.enabled ?? learning.learning_enabled;
  learning.mode = learning.mode ?? learning.learning_mode;
  learning.minSamples = learning.minSamples ?? learning.min_samples;
  learning.cheapSuccessThreshold =
    learning.cheapSuccessThreshold ?? learning.cheap_success_threshold;
  learning.strongerFailureThreshold =
    learning.strongerFailureThreshold ?? learning.stronger_failure_threshold;
  learning.maxRetryRateForDowngrade =
    learning.maxRetryRateForDowngrade ?? learning.max_retry_rate_for_downgrade;
  learning.maxEscalationRateForDowngrade =
    learning.maxEscalationRateForDowngrade ?? learning.max_escalation_rate_for_downgrade;

  if (learning.mode === "advisory" || learning.mode === "auto") {
    const requestedMode = learning.mode;
    learning.mode = "shadow";
    learning.requestedMode = requestedMode;
    learning.requested_mode = requestedMode;
    learning.warnings = uniqueStrings([
      ...(learning.warnings ?? []),
      `policy.learning.mode.${requestedMode}.normalized_to_shadow`,
    ]);
  }
}
```

- [ ] **Step 5: Add learning validation**

In `validatePolicyConfig()`, after safety validation, add:

```js
  if (typeof normalized.learning.enabled !== "boolean") {
    errors.push(error("policy.learning.enabled.invalid", "policy.learning.enabled"));
  }
  if (!["off", "shadow"].includes(normalized.learning.mode)) {
    errors.push(error("policy.learning.mode.invalid", "policy.learning.mode"));
  }
  if (!Number.isInteger(normalized.learning.minSamples) || normalized.learning.minSamples < 1) {
    errors.push(error("policy.learning.min_samples.invalid", "policy.learning.minSamples"));
  }
  for (const field of [
    "cheapSuccessThreshold",
    "strongerFailureThreshold",
    "maxRetryRateForDowngrade",
    "maxEscalationRateForDowngrade",
  ]) {
    if (!isRatio(normalized.learning[field])) {
      errors.push(error("policy.learning.threshold.invalid", `policy.learning.${field}`));
    }
  }
```

Add this helper near `isNonNegativeNumber()`:

```js
function isRatio(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}
```

- [ ] **Step 6: Export a placeholder learning helper so the test reaches policy assertions**

Create `src/runtime/learning.js` with:

```js
export function createLearningProfile() {
  return {
    enabled: true,
    mode: "shadow",
    recordsScanned: 0,
    records_scanned: 0,
    eligibleSamples: 0,
    eligible_samples: 0,
    ignoredRecords: 0,
    ignored_records: 0,
    samples: [],
    buckets: [],
    recommendations: [],
  };
}
```

Add this export to `src/index.js`:

```js
export { createLearningProfile } from "./runtime/learning.js";
```

- [ ] **Step 7: Run the focused test and verify policy tests pass**

Run: `node --test tests/phase11-learning.test.js`

Expected: PASS for the three policy tests. Later tests do not exist yet.

- [ ] **Step 8: Commit policy foundation**

```bash
git add src/runtime/policy.js src/runtime/learning.js src/index.js tests/phase11-learning.test.js
git commit -m "feat: add learning policy config"
```

---

### Task 2: Implement Learning Sample Extraction And Privacy Shape

**Files:**
- Modify: `src/runtime/learning.js`
- Modify: `tests/phase11-learning.test.js`

- [ ] **Step 1: Add synthetic record helpers to `tests/phase11-learning.test.js`**

Append these helpers to the bottom of the test file:

```js
function learningRecord({
  runId,
  status = "verification_passed",
  verificationStatus = "passed",
  taskId = "T-001",
  taskType = "implementation",
  difficulty = "L2",
  risk = "low",
  contextNeed = "medium",
  verification = "easy",
  tier = "standard",
  provider = "openai-compatible",
  model = "gpt-test",
  workerAttempts = [],
  modelCalls = [],
  events = [],
  request = "SECRET=leak user request must not enter learning",
} = {}) {
  return {
    runId,
    status,
    request,
    createdAt: "2026-06-23T00:00:00.000Z",
    updatedAt: "2026-06-23T00:00:00.000Z",
    plan: {
      tasks: [
        {
          id: taskId,
          task_id: taskId,
          title: "Implement sample task",
          taskType,
          task_type: taskType,
          difficulty,
          risk,
          contextNeed,
          context_need: contextNeed,
          verification,
          modelTier: tier,
          model_tier: tier,
          finalVerification: false,
          final_verification: false,
          routing: {
            model_tier: tier,
            selected_model: { provider, model, tier },
            reason: `${difficulty} default routing tier`,
            escalation_triggers: [],
          },
        },
      ],
      routingTrace: [
        {
          task_id: taskId,
          model_tier: tier,
          selected_model: { provider, model, tier },
          reason: `${difficulty} default routing tier`,
          cost_hint: { estimated_usd_per_call: 0.01 },
          escalation_triggers: [],
        },
      ],
      policyConfig: normalizePolicyConfig(),
      modelTierAliases: { cheap: "cheap", standard: "standard", premium: "premium" },
    },
    workerAttempts,
    modelCalls,
    verification: verificationStatus
      ? [
          {
            name: "verification",
            status: verificationStatus,
            message: verificationStatus === "passed" ? "passed" : "failed",
            commands: [
              {
                name: "test",
                status: verificationStatus,
                stdout: "raw command output must not enter learning",
                stderr: "raw stderr must not enter learning",
              },
            ],
            acceptance: { status: verificationStatus },
            supervisorReview: { status: "skipped" },
            escalation: { required: verificationStatus === "failed", reason: "failed_tests" },
          },
        ]
      : [],
    modelCalls,
    events,
  };
}

function workerAttempt(taskId, overrides = {}) {
  return {
    attemptId: `attempt_${taskId}_${overrides.status ?? "applied"}`,
    attempt_id: `attempt_${taskId}_${overrides.status ?? "applied"}`,
    taskId,
    task_id: taskId,
    status: "applied",
    applied: true,
    patch: "diff --git a/secret b/secret",
    workerPrompt: "worker prompt must not enter learning",
    worker_prompt: "worker prompt must not enter learning",
    explanation: "model output must not enter learning",
    ...overrides,
  };
}

function modelCall(taskId, overrides = {}) {
  return {
    provider: "openai-compatible",
    model: "gpt-test",
    status: "finished",
    usage: { totalTokens: 100 },
    costEstimate: { currency: "USD", estimatedCost: 0.0123, estimated_cost: 0.0123 },
    cost_estimate: { currency: "USD", estimatedCost: 0.0123, estimated_cost: 0.0123 },
    request: {
      taskId,
      task_id: taskId,
      prompt: "raw prompt must not enter learning",
    },
    response: "raw model response must not enter learning",
    ...overrides,
  };
}
```

- [ ] **Step 2: Write failing tests for extraction, ignored records, and privacy**

Add these tests:

```js
test("Phase 11 learning extracts privacy-safe samples from verified runs", () => {
  const record = learningRecord({
    runId: "run_passed",
    workerAttempts: [workerAttempt("T-001")],
    modelCalls: [modelCall("T-001")],
    events: [
      {
        type: "task.execution.escalated",
        taskId: "T-001",
        task_id: "T-001",
        fromTier: "standard",
        from_tier: "standard",
        toTier: "premium",
        to_tier: "premium",
      },
    ],
  });

  const profile = createLearningProfile([record], {
    policy: normalizePolicyConfig(),
    now: new Date("2026-06-23T01:00:00.000Z"),
  });
  const sample = profile.samples[0];
  const serialized = JSON.stringify(profile);

  assert.equal(profile.enabled, true);
  assert.equal(profile.mode, "shadow");
  assert.equal(profile.recordsScanned, 1);
  assert.equal(profile.eligibleSamples, 1);
  assert.equal(sample.runId, "run_passed");
  assert.equal(sample.taskId, "T-001");
  assert.equal(sample.taskType, "implementation");
  assert.equal(sample.difficulty, "L2");
  assert.equal(sample.risk, "low");
  assert.equal(sample.contextNeed, "medium");
  assert.equal(sample.verification, "easy");
  assert.equal(sample.plannedTier, "standard");
  assert.equal(sample.selectedProvider, "openai-compatible");
  assert.equal(sample.selectedModel, "gpt-test");
  assert.equal(sample.selectedTier, "standard");
  assert.equal(sample.attemptCount, 1);
  assert.deepEqual(sample.attemptedTiers, ["standard", "premium"]);
  assert.equal(sample.retryCount, 1);
  assert.equal(sample.escalated, true);
  assert.equal(sample.workerStatus, "accepted");
  assert.equal(sample.verificationStatus, "passed");
  assert.equal(sample.estimatedCost, 0.0123);
  assert.doesNotMatch(serialized, /SECRET=leak/);
  assert.doesNotMatch(serialized, /diff --git/);
  assert.doesNotMatch(serialized, /worker prompt/);
  assert.doesNotMatch(serialized, /raw prompt/);
  assert.doesNotMatch(serialized, /raw command output/);
  assert.doesNotMatch(serialized, /raw model response/);
});

test("Phase 11 learning ignores records without explicit verification outcomes", () => {
  const passed = learningRecord({ runId: "run_passed" });
  const planned = learningRecord({ runId: "run_planned", status: "planned", verificationStatus: null });
  const approval = learningRecord({
    runId: "run_approval",
    status: "approval_required",
    verificationStatus: null,
  });
  const canceled = learningRecord({ runId: "run_canceled", status: "canceled", verificationStatus: "passed" });
  const skipped = learningRecord({
    runId: "run_skipped",
    status: "verification_skipped",
    verificationStatus: "skipped",
  });

  const profile = createLearningProfile([passed, planned, approval, canceled, skipped], {
    policy: normalizePolicyConfig(),
  });

  assert.equal(profile.recordsScanned, 5);
  assert.equal(profile.eligibleSamples, 1);
  assert.equal(profile.ignoredRecords, 4);
  assert.equal(profile.ignored_records, 4);
  assert.deepEqual(
    profile.ignoredSummary.map((item) => item.reason).sort(),
    ["approval_required", "canceled", "planned", "verification_skipped"]
  );
});

test("Phase 11 learning returns disabled profile when policy disables learning", () => {
  const profile = createLearningProfile([learningRecord({ runId: "run_disabled" })], {
    policy: normalizePolicyConfig({ learning: { enabled: false } }),
  });

  assert.equal(profile.enabled, false);
  assert.equal(profile.mode, "off");
  assert.equal(profile.reason, "Learning disabled by policy.");
  assert.deepEqual(profile.samples, []);
  assert.deepEqual(profile.buckets, []);
  assert.deepEqual(profile.recommendations, []);
});
```

- [ ] **Step 3: Run the focused test and verify extraction tests fail**

Run: `node --test tests/phase11-learning.test.js`

Expected: FAIL because `createLearningProfile()` still returns the placeholder profile.

- [ ] **Step 4: Replace `src/runtime/learning.js` with sample extraction implementation**

Use this implementation as the starting point:

```js
import { DEFAULT_POLICY_CONFIG, normalizePolicyConfig } from "./policy.js";

const EXCLUDED_STATUSES = new Set([
  "planned",
  "approval_required",
  "approved",
  "verifying",
  "canceled",
  "verification_skipped",
  "approval_rejected",
]);

export function createLearningProfile(records = [], { policy = DEFAULT_POLICY_CONFIG, now = new Date() } = {}) {
  const normalizedPolicy = normalizePolicyConfig(policy);
  const learningPolicy = normalizedPolicy.learning;

  if (learningPolicy.enabled === false || learningPolicy.mode === "off") {
    return disabledProfile();
  }

  const uniqueRecords = uniqueRecordsById(records);
  const ignoredSummary = [];
  const samples = [];

  for (const record of uniqueRecords) {
    const outcome = getExplicitVerificationOutcome(record);
    if (!outcome) {
      ignoredSummary.push({
        runId: record?.runId ?? null,
        run_id: record?.runId ?? null,
        reason: record?.status ?? "missing_verification_outcome",
      });
      continue;
    }

    const routeByTask = new Map(
      (record.plan?.routingTrace ?? record.plan?.routing_trace ?? []).map((route) => [route.task_id, route])
    );
    const attemptsByTask = groupByTask(record.workerAttempts ?? record.worker_attempts ?? []);
    const callsByTask = groupModelCallsByTask(record.modelCalls ?? record.model_calls ?? []);
    const escalationEventsByTask = groupEscalationEventsByTask(record.events ?? []);

    for (const task of record.plan?.tasks ?? []) {
      const taskId = task.task_id ?? task.id;
      const route = routeByTask.get(taskId) ?? task.routing;
      if (!taskId || !route) continue;
      if (isPureFinalReviewTask(task, attemptsByTask.get(taskId), callsByTask.get(taskId))) continue;

      samples.push(
        createSample({
          record,
          task,
          route,
          outcome,
          attempts: attemptsByTask.get(taskId) ?? [],
          calls: callsByTask.get(taskId) ?? [],
          escalationEvents: escalationEventsByTask.get(taskId) ?? [],
        })
      );
    }
  }

  const generatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const warnings = learningPolicy.warnings ?? [];

  return {
    enabled: true,
    mode: "shadow",
    requestedMode: learningPolicy.requestedMode ?? null,
    requested_mode: learningPolicy.requested_mode ?? learningPolicy.requestedMode ?? null,
    warnings,
    generatedAt,
    generated_at: generatedAt,
    recordsScanned: uniqueRecords.length,
    records_scanned: uniqueRecords.length,
    eligibleSamples: samples.length,
    eligible_samples: samples.length,
    ignoredRecords: ignoredSummary.length,
    ignored_records: ignoredSummary.length,
    ignoredSummary,
    ignored_summary: ignoredSummary,
    samples,
    buckets: [],
    recommendations: [],
  };
}

function disabledProfile() {
  return {
    enabled: false,
    mode: "off",
    reason: "Learning disabled by policy.",
    recordsScanned: 0,
    records_scanned: 0,
    eligibleSamples: 0,
    eligible_samples: 0,
    ignoredRecords: 0,
    ignored_records: 0,
    samples: [],
    buckets: [],
    recommendations: [],
  };
}
```

Add helper functions in the same file:

```js
function createSample({ record, task, route, outcome, attempts, calls, escalationEvents }) {
  const taskId = task.task_id ?? task.id;
  const selectedModel = normalizeSelectedModel(route?.selected_model ?? route?.selectedModel);
  const plannedTier = route?.model_tier ?? task.model_tier ?? task.modelTier ?? "unknown";
  const attemptedTiers = uniqueStrings([
    plannedTier,
    ...attempts.map((attempt) => attempt.modelTier ?? attempt.model_tier).filter(Boolean),
    ...calls.map((call) => call.tier ?? call.modelTier ?? call.model_tier).filter(Boolean),
    ...escalationEvents.flatMap((event) => [event.fromTier ?? event.from_tier, event.toTier ?? event.to_tier]),
  ]);
  const retryCount = Math.max(0, attemptedTiers.length - 1, attempts.length - 1);
  const failureCategories = failureCategoriesFor({ calls, attempts, outcome });
  const workerStatus = workerStatusFor(attempts);

  return {
    runId: record.runId,
    run_id: record.runId,
    taskId,
    task_id: taskId,
    taskType: task.taskType ?? task.task_type ?? task.difficulty ?? "unknown",
    task_type: task.task_type ?? task.taskType ?? task.difficulty ?? "unknown",
    difficulty: task.difficulty ?? "unknown",
    risk: task.risk ?? "unknown",
    contextNeed: task.contextNeed ?? task.context_need ?? "unknown",
    context_need: task.context_need ?? task.contextNeed ?? "unknown",
    verification: task.verification ?? "unknown",
    plannedTier,
    planned_tier: plannedTier,
    selectedProvider: selectedModel.provider,
    selected_provider: selectedModel.provider,
    selectedModel: selectedModel.model,
    selected_model: selectedModel.model,
    selectedTier: selectedModel.tier ?? plannedTier,
    selected_tier: selectedModel.tier ?? plannedTier,
    attemptCount: Math.max(attempts.length, calls.length, 1),
    attempt_count: Math.max(attempts.length, calls.length, 1),
    attemptedTiers,
    attempted_tiers: attemptedTiers,
    retryCount,
    retry_count: retryCount,
    escalated: escalationEvents.length > 0 || attemptedTiers.length > 1,
    workerStatus,
    worker_status: workerStatus,
    verificationStatus: outcome,
    verification_status: outcome,
    failureCategories,
    failure_categories: failureCategories,
    estimatedCost: sumEstimatedCost(calls),
    estimated_cost: sumEstimatedCost(calls),
  };
}

function getExplicitVerificationOutcome(record) {
  if (!record || EXCLUDED_STATUSES.has(record.status)) return null;
  if (record.status === "verification_passed") return "passed";
  if (record.status === "verification_failed") return "failed";

  const latest = Array.isArray(record.verification) ? record.verification.at(-1) : null;
  if (latest?.status === "passed" || latest?.status === "failed") return latest.status;
  return null;
}

function uniqueRecordsById(records) {
  const byId = new Map();
  for (const record of records.filter(Boolean)) {
    byId.set(record.runId ?? byId.size, record);
  }
  return [...byId.values()];
}

function groupByTask(items) {
  const groups = new Map();
  for (const item of items) {
    const taskId = item.taskId ?? item.task_id;
    if (!taskId) continue;
    groups.set(taskId, [...(groups.get(taskId) ?? []), item]);
  }
  return groups;
}

function groupModelCallsByTask(calls) {
  const groups = new Map();
  for (const call of calls) {
    const taskId = call.request?.taskId ?? call.request?.task_id;
    if (!taskId) continue;
    groups.set(taskId, [...(groups.get(taskId) ?? []), call]);
  }
  return groups;
}

function groupEscalationEventsByTask(events) {
  return groupByTask(events.filter((event) => event.type === "task.execution.escalated"));
}

function isPureFinalReviewTask(task, attempts = [], calls = []) {
  return (task.finalVerification === true || task.final_verification === true) && attempts.length === 0 && calls.length === 0;
}

function normalizeSelectedModel(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      provider: value.provider ?? null,
      model: value.model ?? value.name ?? null,
      tier: value.tier ?? value.modelTier ?? value.model_tier ?? null,
    };
  }
  if (typeof value === "string") {
    return { provider: null, model: value, tier: null };
  }
  return { provider: null, model: null, tier: null };
}

function workerStatusFor(attempts) {
  if (attempts.some((attempt) => attempt.status === "applied" || attempt.status === "accepted")) {
    return "accepted";
  }
  if (attempts.some((attempt) => attempt.status === "failed" || attempt.error)) return "failed";
  return "not_recorded";
}

function failureCategoriesFor({ calls, attempts, outcome }) {
  const categories = [];
  if (calls.some((call) => call.status === "failed" || call.error)) categories.push("provider_error");
  if (attempts.some((attempt) => attempt.status === "failed" || attempt.error || attempt.validation?.errors?.length)) {
    categories.push("malformed_output");
  }
  if (outcome === "failed") categories.push("verification_failure");
  return uniqueStrings(categories);
}

function sumEstimatedCost(calls) {
  if (calls.length === 0) return null;
  return roundCost(
    calls.reduce(
      (total, call) =>
        total + (call.costEstimate?.estimatedCost ?? call.cost_estimate?.estimated_cost ?? 0),
      0
    )
  );
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))].sort();
}

function roundCost(value) {
  return Math.round((Number.isFinite(value) ? value : 0) * 1000000000) / 1000000000;
}
```

- [ ] **Step 5: Run focused tests**

Run: `node --test tests/phase11-learning.test.js`

Expected: PASS for policy and extraction tests.

- [ ] **Step 6: Commit sample extraction**

```bash
git add src/runtime/learning.js tests/phase11-learning.test.js
git commit -m "feat: extract learning samples from run history"
```

---

### Task 3: Add Aggregation Buckets And Shadow Recommendations

**Files:**
- Modify: `src/runtime/learning.js`
- Modify: `tests/phase11-learning.test.js`

- [ ] **Step 1: Write failing tests for buckets, cheaper recommendation, stronger recommendation, hold recommendation, and safety-floor blocking**

Add these tests:

```js
test("Phase 11 learning aggregates task, tier, provider, retry, escalation, and failure metrics", () => {
  const records = [
    learningRecord({ runId: "pass_1", tier: "standard", modelCalls: [modelCall("T-001")] }),
    learningRecord({
      runId: "fail_1",
      status: "verification_failed",
      verificationStatus: "failed",
      tier: "standard",
      modelCalls: [
        modelCall("T-001", {
          status: "failed",
          error: { code: "provider.http_error" },
        }),
      ],
      workerAttempts: [workerAttempt("T-001", { status: "failed", applied: false })],
    }),
  ];

  const profile = createLearningProfile(records, { policy: normalizePolicyConfig() });
  const bucket = profile.buckets.find(
    (item) => item.bucketType === "task_type_tier" && item.taskType === "implementation" && item.modelTier === "standard"
  );
  const providerBucket = profile.buckets.find(
    (item) => item.bucketType === "task_type_provider_model" && item.selectedModel === "gpt-test"
  );

  assert.equal(bucket.sampleCount, 2);
  assert.equal(bucket.successes, 1);
  assert.equal(bucket.failures, 1);
  assert.equal(bucket.successRate, 0.5);
  assert.equal(bucket.failureRate, 0.5);
  assert.equal(bucket.providerFailureCount, 1);
  assert.equal(bucket.malformedOutputCount, 1);
  assert.equal(bucket.verificationFailureCount, 1);
  assert.equal(bucket.averageEstimatedCost, 0.0123);
  assert.ok(providerBucket);
});

test("Phase 11 learning recommends cheaper tiers only with enough successful cheaper samples", () => {
  const records = [
    ...Array.from({ length: 5 }, (_, index) =>
      learningRecord({
        runId: `cheap_pass_${index}`,
        tier: "cheap",
        difficulty: "L1",
        risk: "low",
        verification: "easy",
        model: "cheap-model",
      })
    ),
    learningRecord({
      runId: "standard_current",
      tier: "standard",
      difficulty: "L1",
      risk: "low",
      verification: "easy",
      model: "standard-model",
    }),
  ];

  const profile = createLearningProfile(records, {
    policy: normalizePolicyConfig({ learning: { minSamples: 5 } }),
  });
  const recommendation = profile.recommendations.find(
    (item) => item.action === "consider_cheaper_tier" && item.fromTier === "standard"
  );

  assert.ok(recommendation);
  assert.equal(recommendation.toTier, "cheap");
  assert.equal(recommendation.confidence, "low");
  assert.equal(recommendation.sampleCount, 5);
  assert.match(recommendation.reason, /cheap/i);
});

test("Phase 11 learning recommends stronger tiers when failures or escalations are frequent", () => {
  const records = Array.from({ length: 5 }, (_, index) =>
    learningRecord({
      runId: `standard_fail_${index}`,
      status: "verification_failed",
      verificationStatus: "failed",
      tier: "standard",
      difficulty: "L2",
      risk: "medium",
      verification: "medium",
    })
  );

  const profile = createLearningProfile(records, {
    policy: normalizePolicyConfig({ learning: { minSamples: 5, strongerFailureThreshold: 0.3 } }),
  });
  const recommendation = profile.recommendations.find(
    (item) => item.action === "consider_stronger_tier" && item.fromTier === "standard"
  );

  assert.ok(recommendation);
  assert.equal(recommendation.toTier, "premium");
  assert.equal(recommendation.sampleCount, 5);
  assert.match(recommendation.reason, /failure|escalation/i);
});

test("Phase 11 learning holds recommendations for small samples and high-risk downgrades", () => {
  const smallProfile = createLearningProfile(
    [learningRecord({ runId: "tiny_1", tier: "cheap", difficulty: "L1", risk: "low" })],
    { policy: normalizePolicyConfig({ learning: { minSamples: 5 } }) }
  );
  const highRiskProfile = createLearningProfile(
    [
      ...Array.from({ length: 5 }, (_, index) =>
        learningRecord({
          runId: `cheap_high_${index}`,
          tier: "cheap",
          difficulty: "L3",
          risk: "high",
        })
      ),
      learningRecord({
        runId: "premium_high",
        tier: "premium",
        difficulty: "L3",
        risk: "high",
      }),
    ],
    { policy: normalizePolicyConfig({ learning: { minSamples: 5 } }) }
  );

  assert.ok(smallProfile.recommendations.some((item) => item.action === "hold"));
  assert.ok(highRiskProfile.recommendations.some((item) => item.action === "hold" && /safety/i.test(item.reason)));
  assert.equal(
    highRiskProfile.recommendations.some((item) => item.action === "consider_cheaper_tier"),
    false
  );
});
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `node --test tests/phase11-learning.test.js`

Expected: FAIL because `buckets` and `recommendations` are still empty.

- [ ] **Step 3: Add bucket aggregation to `src/runtime/learning.js`**

In `createLearningProfile()`, replace `buckets: []` with:

```js
  const buckets = createBuckets(samples);
  const recommendations = createRecommendations({ buckets, policy: learningPolicy });
```

Return those variables:

```js
    buckets,
    recommendations,
```

Add these helpers:

```js
const BUCKET_BUILDERS = [
  {
    type: "task_type_tier",
    key: (sample) => ({
      taskType: sample.taskType,
      task_type: sample.taskType,
      modelTier: sample.plannedTier,
      model_tier: sample.plannedTier,
    }),
  },
  {
    type: "task_type_difficulty_tier",
    key: (sample) => ({
      taskType: sample.taskType,
      task_type: sample.taskType,
      difficulty: sample.difficulty,
      modelTier: sample.plannedTier,
      model_tier: sample.plannedTier,
    }),
  },
  {
    type: "task_type_risk_tier",
    key: (sample) => ({
      taskType: sample.taskType,
      task_type: sample.taskType,
      risk: sample.risk,
      modelTier: sample.plannedTier,
      model_tier: sample.plannedTier,
    }),
  },
  {
    type: "task_type_verification_tier",
    key: (sample) => ({
      taskType: sample.taskType,
      task_type: sample.taskType,
      verification: sample.verification,
      modelTier: sample.plannedTier,
      model_tier: sample.plannedTier,
    }),
  },
  {
    type: "task_type_provider_model",
    key: (sample) => ({
      taskType: sample.taskType,
      task_type: sample.taskType,
      selectedProvider: sample.selectedProvider,
      selected_provider: sample.selectedProvider,
      selectedModel: sample.selectedModel,
      selected_model: sample.selectedModel,
    }),
  },
];

function createBuckets(samples) {
  const buckets = new Map();
  for (const sample of samples) {
    for (const builder of BUCKET_BUILDERS) {
      const dimensions = builder.key(sample);
      const key = `${builder.type}:${Object.values(dimensions).join(":")}`;
      const current = buckets.get(key) ?? createEmptyBucket(builder.type, dimensions);
      addSampleToBucket(current, sample);
      buckets.set(key, current);
    }
  }
  return [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function createEmptyBucket(bucketType, dimensions) {
  const key = `${bucketType}:${Object.values(dimensions).join(":")}`;
  return {
    key,
    bucketType,
    bucket_type: bucketType,
    ...dimensions,
    sampleCount: 0,
    sample_count: 0,
    successes: 0,
    failures: 0,
    successRate: 0,
    success_rate: 0,
    failureRate: 0,
    failure_rate: 0,
    retryCount: 0,
    retry_count: 0,
    retryRate: 0,
    retry_rate: 0,
    escalationCount: 0,
    escalation_count: 0,
    escalationRate: 0,
    escalation_rate: 0,
    verificationFailureCount: 0,
    verification_failure_count: 0,
    verificationFailureRate: 0,
    verification_failure_rate: 0,
    malformedOutputCount: 0,
    malformed_output_count: 0,
    providerFailureCount: 0,
    provider_failure_count: 0,
    retriedSampleCount: 0,
    retried_sample_count: 0,
    risks: [],
    averageEstimatedCost: null,
    average_estimated_cost: null,
    totalEstimatedCost: 0,
    total_estimated_cost: 0,
    costSampleCount: 0,
    cost_sample_count: 0,
  };
}

function addSampleToBucket(bucket, sample) {
  bucket.sampleCount += 1;
  bucket.sample_count = bucket.sampleCount;
  if (sample.verificationStatus === "passed") bucket.successes += 1;
  if (sample.verificationStatus === "failed") bucket.failures += 1;
  bucket.retryCount += sample.retryCount;
  bucket.retry_count = bucket.retryCount;
  if (sample.retryCount > 0) bucket.retriedSampleCount += 1;
  bucket.retried_sample_count = bucket.retriedSampleCount;
  if (sample.escalated) bucket.escalationCount += 1;
  bucket.escalation_count = bucket.escalationCount;
  if (sample.failureCategories.includes("verification_failure")) bucket.verificationFailureCount += 1;
  if (sample.failureCategories.includes("malformed_output")) bucket.malformedOutputCount += 1;
  if (sample.failureCategories.includes("provider_error")) bucket.providerFailureCount += 1;
  bucket.verification_failure_count = bucket.verificationFailureCount;
  bucket.malformed_output_count = bucket.malformedOutputCount;
  bucket.provider_failure_count = bucket.providerFailureCount;

  bucket.successRate = roundRatio(bucket.successes / bucket.sampleCount);
  bucket.success_rate = bucket.successRate;
  bucket.failureRate = roundRatio(bucket.failures / bucket.sampleCount);
  bucket.failure_rate = bucket.failureRate;
  bucket.retryRate = roundRatio(bucket.retriedSampleCount / bucket.sampleCount);
  bucket.retry_rate = bucket.retryRate;
  bucket.escalationRate = roundRatio(bucket.escalationCount / bucket.sampleCount);
  bucket.escalation_rate = bucket.escalationRate;
  bucket.verificationFailureRate = roundRatio(bucket.verificationFailureCount / bucket.sampleCount);
  bucket.verification_failure_rate = bucket.verificationFailureRate;
  bucket.risks = uniqueStrings([...bucket.risks, sample.risk]);

  if (Number.isFinite(sample.estimatedCost)) {
    bucket.totalEstimatedCost = roundCost(bucket.totalEstimatedCost + sample.estimatedCost);
    bucket.total_estimated_cost = bucket.totalEstimatedCost;
    bucket.costSampleCount += 1;
    bucket.cost_sample_count = bucket.costSampleCount;
    bucket.averageEstimatedCost = roundCost(bucket.totalEstimatedCost / bucket.costSampleCount);
    bucket.average_estimated_cost = bucket.averageEstimatedCost;
  }
}

function roundRatio(value) {
  return Math.round((Number.isFinite(value) ? value : 0) * 10000) / 10000;
}
```

- [ ] **Step 4: Add shadow recommendation rules**

Add these helpers:

```js
const TIER_ORDER = ["cheap", "standard", "premium"];

function createRecommendations({ buckets, policy }) {
  const taskTierBuckets = buckets.filter((bucket) => bucket.bucketType === "task_type_tier");
  const recommendations = [];

  for (const bucket of taskTierBuckets) {
    if (bucket.sampleCount < policy.minSamples) {
      recommendations.push(holdRecommendation(bucket, "sample size too small"));
      continue;
    }

    const stronger = strongerRecommendation(bucket, policy);
    if (stronger) {
      recommendations.push(stronger);
      continue;
    }

    const cheaper = cheaperRecommendation(bucket, taskTierBuckets, policy);
    if (cheaper) {
      recommendations.push(cheaper);
      continue;
    }

    recommendations.push(holdRecommendation(bucket, "signals are mixed or already optimal"));
  }

  return recommendations.sort((a, b) => a.key.localeCompare(b.key));
}

function cheaperRecommendation(bucket, buckets, policy) {
  const fromTier = bucket.modelTier;
  const toTier = previousTier(fromTier);
  if (!toTier) return null;

  const cheaper = buckets.find(
    (candidate) => candidate.taskType === bucket.taskType && candidate.modelTier === toTier
  );
  if (!cheaper || cheaper.sampleCount < policy.minSamples) return null;
  if (bucket.risks.includes("high") || cheaper.risks.includes("high")) return null;
  if (cheaper.successRate < policy.cheapSuccessThreshold) return null;
  if (cheaper.retryRate > policy.maxRetryRateForDowngrade) return null;
  if (cheaper.escalationRate > policy.maxEscalationRateForDowngrade) return null;

  return recommendation({
    action: "consider_cheaper_tier",
    bucket: cheaper,
    fromTier,
    toTier,
    reason: `${cheaper.taskType} has ${cheaper.successes}/${cheaper.sampleCount} successful ${toTier} samples with low retry and escalation rates.`,
  });
}

function strongerRecommendation(bucket, policy) {
  const toTier = nextTier(bucket.modelTier);
  if (!toTier) return null;
  if (bucket.failureRate < policy.strongerFailureThreshold && bucket.escalationRate < policy.strongerFailureThreshold) {
    return null;
  }

  return recommendation({
    action: "consider_stronger_tier",
    bucket,
    fromTier: bucket.modelTier,
    toTier,
    reason: `${bucket.taskType}/${bucket.modelTier} failure or escalation rate is high enough to consider ${toTier}.`,
  });
}

function holdRecommendation(bucket, reason) {
  return recommendation({
    action: "hold",
    bucket,
    fromTier: bucket.modelTier,
    toTier: bucket.modelTier,
    reason,
  });
}

function recommendation({ action, bucket, fromTier, toTier, reason }) {
  const confidence = confidenceFor(bucket);
  return {
    key: `${action}:${bucket.key}:${toTier}`,
    action,
    taskType: bucket.taskType,
    task_type: bucket.taskType,
    fromTier,
    from_tier: fromTier,
    toTier,
    to_tier: toTier,
    confidence,
    sampleCount: bucket.sampleCount,
    sample_count: bucket.sampleCount,
    successRate: bucket.successRate,
    success_rate: bucket.successRate,
    failureRate: bucket.failureRate,
    failure_rate: bucket.failureRate,
    retryRate: bucket.retryRate,
    retry_rate: bucket.retryRate,
    escalationRate: bucket.escalationRate,
    escalation_rate: bucket.escalationRate,
    reason,
    evidence: {
      bucketKey: bucket.key,
      bucket_key: bucket.key,
      successes: bucket.successes,
      failures: bucket.failures,
      verificationFailureCount: bucket.verificationFailureCount,
      verification_failure_count: bucket.verificationFailureCount,
      malformedOutputCount: bucket.malformedOutputCount,
      malformed_output_count: bucket.malformedOutputCount,
      providerFailureCount: bucket.providerFailureCount,
      provider_failure_count: bucket.providerFailureCount,
    },
  };
}

function confidenceFor(bucket) {
  if (bucket.sampleCount >= 20) return "high";
  if (bucket.sampleCount >= 10) return "medium";
  return "low";
}

function previousTier(tier) {
  const index = TIER_ORDER.indexOf(tier);
  return index > 0 ? TIER_ORDER[index - 1] : null;
}

function nextTier(tier) {
  const index = TIER_ORDER.indexOf(tier);
  return index >= 0 && index < TIER_ORDER.length - 1 ? TIER_ORDER[index + 1] : null;
}
```

- [ ] **Step 5: Run focused tests**

Run: `node --test tests/phase11-learning.test.js`

Expected: PASS for extraction, aggregation, and recommendation tests.

- [ ] **Step 6: Commit aggregation and recommendations**

```bash
git add src/runtime/learning.js tests/phase11-learning.test.js
git commit -m "feat: add learning shadow recommendations"
```

---

### Task 4: Integrate Learning Into Reports Without Routing Changes

**Files:**
- Modify: `src/runtime/report.js`
- Modify: `src/index.js`
- Modify: `tests/phase11-learning.test.js`
- Modify: `tests/phase9-reporting.test.js`

- [ ] **Step 1: Write failing report exposure and routing non-regression tests**

Add these tests to `tests/phase11-learning.test.js`:

```js
test("Phase 11 report exposes learning profile in JSON and Markdown", () => {
  const current = learningRecord({ runId: "current", tier: "standard" });
  const history = Array.from({ length: 5 }, (_, index) =>
    learningRecord({
      runId: `cheap_history_${index}`,
      tier: "cheap",
      difficulty: "L1",
      risk: "low",
      verification: "easy",
      model: "cheap-model",
    })
  );

  const report = createReport(current, {
    historyRecords: history,
    policy: normalizePolicyConfig({ learning: { minSamples: 5 } }),
  });
  const markdown = formatReportMarkdown(report);

  assert.equal(report.learningProfile.enabled, true);
  assert.equal(report.learning_profile.enabled, true);
  assert.equal(report.learningProfile.mode, "shadow");
  assert.ok(report.learningProfile.eligibleSamples >= 6);
  assert.ok(report.exportFormat.sections.includes("learning_profile"));
  assert.match(markdown, /## Learning/);
  assert.match(markdown, /mode: shadow/);
  assert.match(markdown, /eligible samples:/);
});

test("Phase 11 report shows disabled learning profile when policy disables learning", () => {
  const report = createReport(learningRecord({ runId: "disabled_report" }), {
    policy: normalizePolicyConfig({ learning: { enabled: false } }),
  });
  const markdown = formatReportMarkdown(report);

  assert.equal(report.learningProfile.enabled, false);
  assert.equal(report.learningProfile.mode, "off");
  assert.match(markdown, /Learning disabled by policy/);
});

test("Phase 11 learning does not affect deterministic route creation", () => {
  const baseline = createRuntimePlan({
    request: "plan only: summarize the repository without modifying files",
  });
  const withLearningPolicy = createRuntimePlan({
    request: "plan only: summarize the repository without modifying files",
    policy: normalizePolicyConfig({
      learning: {
        enabled: true,
        mode: "auto",
        minSamples: 1,
        cheapSuccessThreshold: 0.1,
      },
    }),
  });

  assert.deepEqual(
    withLearningPolicy.tasks.map((task) => task.modelTier),
    baseline.tasks.map((task) => task.modelTier)
  );
  assert.deepEqual(withLearningPolicy.routingTrace, baseline.routingTrace);
});
```

Update the existing Phase 9 report test in `tests/phase9-reporting.test.js` by adding:

```js
    assert.ok(report.learningProfile);
    assert.equal(report.learningProfile.mode, "shadow");
    assert.ok(report.exportFormat.sections.includes("learning_profile"));
```

- [ ] **Step 2: Run tests and verify report exposure fails**

Run: `node --test tests/phase11-learning.test.js tests/phase9-reporting.test.js`

Expected: FAIL because `createReport()` does not include learning output yet.

- [ ] **Step 3: Import learning in `src/runtime/report.js` and build a fail-soft profile**

Add import:

```js
import { createLearningProfile } from "./learning.js";
```

Inside `createReport()`, after `modelReliability`:

```js
  const learningProfile = safeCreateLearningProfile([record, ...historyRecords], { policy });
```

Add this helper near `createModelReliabilityMetrics()`:

```js
function safeCreateLearningProfile(records, options) {
  try {
    return createLearningProfile(records, options);
  } catch (error) {
    return {
      enabled: true,
      mode: "shadow",
      error: {
        code: "learning.profile.failed",
        message: error.message,
      },
      recordsScanned: Array.isArray(records) ? records.length : 0,
      records_scanned: Array.isArray(records) ? records.length : 0,
      eligibleSamples: 0,
      eligible_samples: 0,
      ignoredRecords: 0,
      ignored_records: 0,
      samples: [],
      buckets: [],
      recommendations: [],
    };
  }
}
```

- [ ] **Step 4: Add learning profile fields to the report object and export format**

In the report object, add:

```js
    learningProfile,
    learning_profile: learningProfile,
```

In `exportFormat.sections`, add:

```js
        "learning_profile",
```

- [ ] **Step 5: Add Markdown rendering**

In `formatReportMarkdown()`, after `## Model Reliability`, add:

```js
    ``,
    `## Learning`,
    ...formatLearningProfile(report.learningProfile),
```

Add this helper near `formatModelReliability()`:

```js
function formatLearningProfile(profile) {
  if (!profile) {
    return ["- no learning profile recorded"];
  }
  if (profile.enabled === false) {
    return [`- ${profile.reason ?? "Learning disabled by policy."}`];
  }
  if (profile.error) {
    return [`- error: ${profile.error.code}`, `- message: ${profile.error.message}`];
  }

  const lines = [
    `- mode: ${profile.mode ?? "shadow"}`,
    `- eligible samples: ${profile.eligibleSamples ?? 0} from ${profile.recordsScanned ?? 0} records`,
  ];
  for (const warning of profile.warnings ?? []) {
    lines.push(`- warning: ${warning}`);
  }
  if ((profile.recommendations ?? []).length === 0) {
    lines.push("- recommendations: none");
  } else {
    lines.push("- recommendations:");
    for (const item of profile.recommendations.slice(0, 5)) {
      lines.push(
        `  - ${item.taskType}/${item.fromTier}: ${item.action} -> ${item.toTier} (${item.confidence}; ${item.reason})`
      );
    }
  }
  return lines;
}
```

- [ ] **Step 6: Run report tests**

Run: `node --test tests/phase11-learning.test.js tests/phase9-reporting.test.js`

Expected: PASS.

- [ ] **Step 7: Commit report integration**

```bash
git add src/runtime/report.js tests/phase11-learning.test.js tests/phase9-reporting.test.js
git commit -m "feat: expose learning profile in reports"
```

---

### Task 5: Document Phase 11.0 And Update Roadmap Tests

**Files:**
- Modify: `README.md`
- Modify: `docs/integrations.md`
- Modify: `total.md`
- Modify: `tests/phase8-integrations.test.js`
- Modify: `tests/phase9-reporting.test.js`
- Modify: `tests/phase10-policy-safety-team.test.js`
- Modify: `tests/phase11-learning.test.js`

- [ ] **Step 1: Write failing documentation and roadmap tests**

Add this test to `tests/phase11-learning.test.js`:

```js
test("Phase 11 documentation and roadmap describe shadow learning without completing import", async () => {
  const readme = await readFile("README.md", "utf8");
  const integrations = await readFile("docs/integrations.md", "utf8");
  const roadmap = await readFile("total.md", "utf8");
  const phase11 = sectionBetween(roadmap, "## Phase 11:", "## Phase 12:");

  assert.match(readme, /Phase 11\.0|learning profile|shadow recommendation/i);
  assert.match(integrations, /learningProfile|learning_profile|shadow recommendation/i);
  assert.match(phase11, /- \[x\] Record outcome quality by task type and model tier\./);
  assert.match(phase11, /- \[x\] Record retry and escalation frequency\./);
  assert.match(phase11, /- \[x\] Record verification failure patterns\./);
  assert.match(phase11, /- \[x\] Recommend cheaper tiers for task types with high cheap-model success rates\./);
  assert.match(phase11, /- \[x\] Recommend stronger tiers for task types with frequent cheap-model failures\./);
  assert.match(phase11, /- \[x\] Add policy option to disable learning\./);
  assert.match(phase11, /- \[ \] Add export\/import for routing history\./);
});

function sectionBetween(content, startMarker, endMarker) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start + startMarker.length);

  assert.notEqual(start, -1, `${startMarker} not found`);
  assert.notEqual(end, -1, `${endMarker} not found`);
  return content.slice(start, end);
}
```

Update Phase 8, 9, and 10 roadmap tests so they no longer require every Phase 11 checkbox to be blank. Replace calls to `assertSectionUnchecked(phase11, "Phase 11")` with:

```js
assertSectionIncomplete(phase11, "Phase 11");
```

Replace the helper body with:

```js
function assertSectionIncomplete(section, label) {
  const tasks = [...section.matchAll(/- \[(x| )\] /g)];
  assert.ok(tasks.length > 0, `${label} should contain checklist tasks`);
  assert.ok(tasks.some((task) => task[1] === " "), `${label} should still have unchecked work`);
}
```

- [ ] **Step 2: Run documentation tests and verify they fail**

Run: `node --test tests/phase8-integrations.test.js tests/phase9-reporting.test.js tests/phase10-policy-safety-team.test.js tests/phase11-learning.test.js`

Expected: FAIL because docs and `total.md` are not updated yet.

- [ ] **Step 3: Update README report section**

In `README.md`, update the Phase 9/11 reporting bullet near the final report sections to mention:

```md
- Phase 11.0 learning profile data in reports, including local-only shadow recommendations, sample counts, retry/escalation rates, and policy-disabled output
```

- [ ] **Step 4: Update integrations report documentation**

In `docs/integrations.md`, extend the `runtime_report` JSON description with:

```md
Phase 11.0 report JSON also includes `learningProfile` / `learning_profile`. Learning is local-only and shadow-mode only in this phase: it explains cheaper-tier, stronger-tier, or hold recommendations from historical run metadata, but does not change planning, routing, execution, retries, or verification.
```

- [ ] **Step 5: Update Phase 11 checklist in `total.md`**

Change these Phase 11 tasks to checked:

```md
- [x] Record outcome quality by task type and model tier.
- [x] Record retry and escalation frequency.
- [x] Record verification failure patterns.
- [x] Recommend cheaper tiers for task types with high cheap-model success rates.
- [x] Recommend stronger tiers for task types with frequent cheap-model failures.
- [x] Add policy option to disable learning.
- [ ] Add export/import for routing history.
```

Keep Phase 11 acceptance criteria unchanged.

- [ ] **Step 6: Run documentation and roadmap tests**

Run: `node --test tests/phase8-integrations.test.js tests/phase9-reporting.test.js tests/phase10-policy-safety-team.test.js tests/phase11-learning.test.js`

Expected: PASS.

- [ ] **Step 7: Commit docs and roadmap**

```bash
git add README.md docs/integrations.md total.md tests/phase8-integrations.test.js tests/phase9-reporting.test.js tests/phase10-policy-safety-team.test.js tests/phase11-learning.test.js
git commit -m "docs: document phase 11 learning profile"
```

---

### Task 6: Full Verification And Code Review Loop

**Files:**
- Modify: `.ai-review/review-context/current-request.md`

- [ ] **Step 1: Run focused Phase 11 tests**

Run: `node --test tests/phase11-learning.test.js`

Expected: all Phase 11 learning tests pass.

- [ ] **Step 2: Run related reporting and policy tests**

Run: `node --test tests/phase8-integrations.test.js tests/phase9-reporting.test.js tests/phase10-policy-safety-team.test.js`

Expected: all related tests pass.

- [ ] **Step 3: Run the full suite**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 4: Run whitespace check**

Run: `git diff --check`

Expected: no whitespace errors. CRLF warnings are acceptable only if they match existing repository behavior and do not report trailing whitespace.

- [ ] **Step 5: Create review context**

Create or replace `.ai-review/review-context/current-request.md` with:

```md
# Current Request

Implement Phase 11.0 Learning Telemetry And Shadow Recommendations.

## Scope

- Add `policy.learning` defaults, validation, and alias normalization.
- Add `src/runtime/learning.js` for privacy-safe learning sample extraction, aggregation buckets, and shadow recommendations.
- Expose `learningProfile` / `learning_profile` through `runtime_report` JSON and Markdown.
- Keep learned recommendations report-only; do not change planning, routing, execution, retries, or verification behavior.
- Update README, integrations docs, and Phase 11 roadmap checklist for partial Phase 11.0 progress.

## Verification

- `node --test tests/phase11-learning.test.js`
- `node --test tests/phase8-integrations.test.js tests/phase9-reporting.test.js tests/phase10-policy-safety-team.test.js`
- `npm test`
- `git diff --check`
```

- [ ] **Step 6: Run `code-review-loop`**

Use the `code-review-loop` skill.

Expected: fix all P0/P1 findings before reporting completion. Report any P2/P3 findings clearly if they are intentionally deferred.

- [ ] **Step 7: Final commit after review fixes**

If review fixes are needed:

```bash
git add <changed-files>
git commit -m "fix: address phase 11 learning review findings"
```

If no fixes are needed, do not create an empty commit.

---

## Self-Review Checklist

- Spec coverage:
  - Learning profile from persisted history: Task 2 and Task 4.
  - Outcome aggregation: Task 3.
  - Retry, escalation, and verification failure metrics: Task 2 and Task 3.
  - Cheaper/stronger/hold recommendations: Task 3.
  - Disable learning by policy: Task 1, Task 2, and Task 4.
  - Report/CLI/HTTP/MCP exposure: Task 4 through existing `runtime_report`.
  - Privacy-safe metadata only: Task 2 tests and implementation.
  - No live routing changes: Task 4 non-regression test.
  - Export/import boundary: Task 5 keeps import unchecked and documents report JSON export only.
- Placeholder scan:
  - No placeholder markers or undefined future steps are required for implementation.
- Type consistency:
  - Public aliases use `learningProfile` / `learning_profile`, `recordsScanned` / `records_scanned`, `eligibleSamples` / `eligible_samples`, and `sampleCount` / `sample_count`.
  - Policy aliases use `minSamples` / `min_samples`, `cheapSuccessThreshold` / `cheap_success_threshold`, `strongerFailureThreshold` / `stronger_failure_threshold`, `maxRetryRateForDowngrade` / `max_retry_rate_for_downgrade`, and `maxEscalationRateForDowngrade` / `max_escalation_rate_for_downgrade`.
