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
