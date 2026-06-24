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
