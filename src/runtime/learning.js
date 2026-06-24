import { DEFAULT_POLICY_CONFIG, normalizePolicyConfig } from "./policy.js";
import { isOutcomeExcludedStatus } from "./status.js";

const TIER_ORDER = ["cheap", "standard", "premium"];
const RECOMMENDATION_BUCKET_TYPE = "task_type_difficulty_risk_verification_tier";

const BUCKET_BUILDERS = [
  {
    type: RECOMMENDATION_BUCKET_TYPE,
    key: (sample) => ({
      taskType: sample.taskType,
      task_type: sample.taskType,
      difficulty: sample.difficulty,
      risk: sample.risk,
      verification: sample.verification,
      modelTier: sample.plannedTier,
      model_tier: sample.plannedTier,
    }),
  },
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

export function createLearningProfile(
  records = [],
  { policy = DEFAULT_POLICY_CONFIG, now = new Date() } = {}
) {
  const normalizedPolicy = normalizePolicyConfig(policy);
  const learningPolicy = normalizedPolicy.learning;

  if (learningPolicy.enabled === false || learningPolicy.mode === "off") {
    return disabledProfile();
  }

  const uniqueRecords = uniqueRecordsById(records);
  const ignoredSummary = [];
  const samples = [];

  for (const record of uniqueRecords) {
    const runOutcome = getExplicitVerificationOutcome(record);
    if (!runOutcome) {
      ignoredSummary.push({
        runId: record?.runId ?? null,
        run_id: record?.runId ?? null,
        reason: record?.status ?? "missing_verification_outcome",
      });
      continue;
    }

    const routeByTask = new Map(
      (record.plan?.routingTrace ?? record.plan?.routing_trace ?? [])
        .map((route) => [route.task_id ?? route.taskId, route])
        .filter(([taskId]) => taskId)
    );
    const attemptsByTask = groupByTask(record.workerAttempts ?? record.worker_attempts ?? []);
    const callsByTask = groupModelCallsByTask(record.modelCalls ?? record.model_calls ?? []);
    const escalationEventsByTask = groupEscalationEventsByTask(record.events ?? []);
    const taskOutcomes = getTaskVerificationOutcomes(record);
    const taskCount = Array.isArray(record.plan?.tasks) ? record.plan.tasks.length : 0;

    for (const task of record.plan?.tasks ?? []) {
      const taskId = task.task_id ?? task.id;
      const route = routeByTask.get(taskId) ?? task.routing;
      if (!taskId || !route) continue;

      const attempts = attemptsByTask.get(taskId) ?? [];
      const calls = callsByTask.get(taskId) ?? [];
      if (isPureFinalReviewTask(task, attempts, calls)) continue;
      const outcome = getTaskOutcome({ taskId, taskOutcomes, runOutcome, taskCount });
      if (!outcome) continue;

      samples.push(
        createSample({
          record,
          task,
          route,
          outcome,
          attempts,
          calls,
          escalationEvents: escalationEventsByTask.get(taskId) ?? [],
        })
      );
    }
  }

  const generatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const warnings = learningPolicy.warnings ?? [];
  const buckets = createBuckets(samples);
  const recommendations = createRecommendations({ buckets, policy: learningPolicy });

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
    buckets,
    recommendations,
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

function createSample({ record, task, route, outcome, attempts, calls, escalationEvents }) {
  const taskId = task.task_id ?? task.id;
  const selectedModel = normalizeSelectedModel(route?.selected_model ?? route?.selectedModel);
  const plannedTier = route?.model_tier ?? route?.modelTier ?? task.model_tier ?? task.modelTier ?? "unknown";
  const attemptedTiers = uniqueStringsInOrder([
    plannedTier,
    ...attempts.map((attempt) => attempt.modelTier ?? attempt.model_tier).filter(Boolean),
    ...calls.map((call) => call.tier ?? call.modelTier ?? call.model_tier).filter(Boolean),
    ...escalationEvents.flatMap((event) => [
      event.fromTier ?? event.from_tier,
      event.toTier ?? event.to_tier,
    ]),
  ]);
  const retryCount = Math.max(0, attemptedTiers.length - 1, attempts.length - 1);
  const failureCategories = failureCategoriesFor({ calls, attempts, outcome });
  const workerStatus = workerStatusFor(attempts);
  const taskType = task.taskType ?? task.task_type ?? task.difficulty ?? "unknown";
  const contextNeed = task.contextNeed ?? task.context_need ?? "unknown";
  const selectedTier = selectedModel.tier ?? plannedTier;
  const estimatedCost = sumEstimatedCost(calls);

  return {
    runId: record.runId,
    run_id: record.runId,
    taskId,
    task_id: taskId,
    taskType,
    task_type: taskType,
    difficulty: task.difficulty ?? "unknown",
    risk: task.risk ?? "unknown",
    contextNeed,
    context_need: contextNeed,
    verification: task.verification ?? "unknown",
    plannedTier,
    planned_tier: plannedTier,
    selectedProvider: selectedModel.provider,
    selected_provider: selectedModel.provider,
    selectedModel: selectedModel.model,
    selected_model: selectedModel.model,
    selectedTier,
    selected_tier: selectedTier,
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
    estimatedCost,
    estimated_cost: estimatedCost,
  };
}

function getExplicitVerificationOutcome(record) {
  if (!record || isOutcomeExcludedStatus(record.status)) return null;
  if (record.status === "verification_passed") return "passed";
  if (record.status === "verification_failed") return "failed";

  const latest = Array.isArray(record.verification) ? record.verification.at(-1) : null;
  if (latest?.status === "passed" || latest?.status === "failed") return latest.status;
  return null;
}

function getTaskVerificationOutcomes(record) {
  const outcomes = new Map();
  const latest = Array.isArray(record?.verification) ? record.verification.at(-1) : null;
  const acceptance = latest?.acceptance ?? latest?.taskAcceptance ?? latest?.task_acceptance;
  const taskReviews = Array.isArray(acceptance?.tasks)
    ? acceptance.tasks
    : Array.isArray(acceptance?.taskResults)
      ? acceptance.taskResults
      : [];

  for (const review of taskReviews) {
    const taskId = review.taskId ?? review.task_id ?? review.id;
    if (!taskId) continue;
    if (review.status === "passed" || review.status === "failed") {
      outcomes.set(taskId, review.status);
    }
  }

  return outcomes;
}

function getTaskOutcome({ taskId, taskOutcomes, runOutcome, taskCount }) {
  if (taskOutcomes.has(taskId)) return taskOutcomes.get(taskId);
  return taskCount === 1 ? runOutcome : null;
}

function uniqueRecordsById(records) {
  const byId = new Map();
  for (const record of (Array.isArray(records) ? records : []).filter(Boolean)) {
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
  return (
    (task.finalVerification === true || task.final_verification === true) &&
    attempts.length === 0 &&
    calls.length === 0
  );
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
  if (attempts.some((attempt) => attempt.status === "failed" || attempt.error)) {
    return "failed";
  }
  return "not_recorded";
}

function failureCategoriesFor({ calls, attempts, outcome }) {
  const categories = [];
  if (calls.some((call) => call.status === "failed" || call.error)) {
    categories.push("provider_error");
  }
  if (
    attempts.some(
      (attempt) => attempt.status === "failed" || attempt.error || attempt.validation?.errors?.length
    )
  ) {
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
    retriedSampleCount: 0,
    retried_sample_count: 0,
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
  if (sample.failureCategories.includes("verification_failure")) {
    bucket.verificationFailureCount += 1;
  }
  if (sample.failureCategories.includes("malformed_output")) {
    bucket.malformedOutputCount += 1;
  }
  if (sample.failureCategories.includes("provider_error")) {
    bucket.providerFailureCount += 1;
  }
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

function createRecommendations({ buckets, policy }) {
  const taskTierBuckets = buckets.filter((bucket) => bucket.bucketType === RECOMMENDATION_BUCKET_TYPE);
  const recommendations = [];

  for (const bucket of taskTierBuckets) {
    const stronger = bucket.sampleCount >= policy.minSamples ? strongerRecommendation(bucket, policy) : null;
    if (stronger) {
      recommendations.push(stronger);
      continue;
    }

    const cheaper = cheaperRecommendation(bucket, taskTierBuckets, policy);
    if (cheaper) {
      recommendations.push(cheaper);
      continue;
    }

    const safetyHold = cheaperSafetyHold(bucket, taskTierBuckets);
    if (safetyHold) {
      recommendations.push(safetyHold);
      continue;
    }

    if (bucket.sampleCount < policy.minSamples) {
      recommendations.push(holdRecommendation(bucket, "sample size too small"));
      continue;
    }

    recommendations.push(holdRecommendation(bucket, "signals are mixed or already optimal"));
  }

  return recommendations.sort((a, b) => a.key.localeCompare(b.key));
}

function cheaperRecommendation(bucket, buckets, policy) {
  const fromTier = bucket.modelTier;
  const cheaper = bestCheaperBucket(bucket, buckets);
  if (!cheaper) return null;
  if (bucket.risks.includes("high") || cheaper.risks.includes("high")) return null;
  if (cheaper.sampleCount < policy.minSamples) return null;
  if (cheaper.successRate < policy.cheapSuccessThreshold) return null;
  if (cheaper.retryRate > policy.maxRetryRateForDowngrade) return null;
  if (cheaper.escalationRate > policy.maxEscalationRateForDowngrade) return null;

  return recommendation({
    action: "consider_cheaper_tier",
    bucket: cheaper,
    fromTier,
    toTier: cheaper.modelTier,
    reason: `${describeBucketScope(cheaper)} has ${cheaper.successes}/${cheaper.sampleCount} successful ${cheaper.modelTier} samples with low retry and escalation rates.`,
  });
}

function strongerRecommendation(bucket, policy) {
  const toTier = nextTier(bucket.modelTier);
  if (!toTier) return null;
  if (
    bucket.failureRate < policy.strongerFailureThreshold &&
    bucket.escalationRate < policy.strongerFailureThreshold
  ) {
    return null;
  }

  return recommendation({
    action: "consider_stronger_tier",
    bucket,
    fromTier: bucket.modelTier,
    toTier,
    reason: `${describeBucketScope(bucket)}/${bucket.modelTier} failure or escalation rate is high enough to consider ${toTier}.`,
  });
}

function cheaperSafetyHold(bucket, buckets) {
  const cheaper = bestCheaperBucket(bucket, buckets);
  if (!cheaper) return null;
  if (!bucket.risks.includes("high") && !cheaper.risks.includes("high")) return null;
  return holdRecommendation(bucket, "safety policy blocks cheaper routing for high-risk history");
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
    difficulty: bucket.difficulty ?? null,
    risk: bucket.risk ?? null,
    verification: bucket.verification ?? null,
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
      bucketType: bucket.bucketType,
      bucket_type: bucket.bucketType,
      bucketKey: bucket.key,
      bucket_key: bucket.key,
      scope: describeBucketScope(bucket),
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

function bestCheaperBucket(bucket, buckets) {
  const fromIndex = TIER_ORDER.indexOf(bucket.modelTier);
  if (fromIndex <= 0) return null;
  const cheaperTiers = TIER_ORDER.slice(0, fromIndex).reverse();
  return (
    cheaperTiers
      .map((tier) =>
        buckets.find((candidate) => isComparableBucket(candidate, bucket) && candidate.modelTier === tier)
      )
      .find(Boolean) ?? null
  );
}

function isComparableBucket(candidate, bucket) {
  return (
    candidate.bucketType === bucket.bucketType &&
    candidate.taskType === bucket.taskType &&
    candidate.difficulty === bucket.difficulty &&
    candidate.risk === bucket.risk &&
    candidate.verification === bucket.verification
  );
}

function describeBucketScope(bucket) {
  return [bucket.taskType, bucket.difficulty, bucket.risk, bucket.verification]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join("/");
}

function nextTier(tier) {
  const index = TIER_ORDER.indexOf(tier);
  return index >= 0 && index < TIER_ORDER.length - 1 ? TIER_ORDER[index + 1] : null;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))].sort();
}

function uniqueStringsInOrder(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function roundCost(value) {
  return Math.round((Number.isFinite(value) ? value : 0) * 1000000000) / 1000000000;
}

function roundRatio(value) {
  return Math.round((Number.isFinite(value) ? value : 0) * 10000) / 10000;
}
