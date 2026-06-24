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
      (record.plan?.routingTrace ?? record.plan?.routing_trace ?? []).map((route) => [
        route.task_id,
        route,
      ])
    );
    const attemptsByTask = groupByTask(record.workerAttempts ?? record.worker_attempts ?? []);
    const callsByTask = groupModelCallsByTask(record.modelCalls ?? record.model_calls ?? []);
    const escalationEventsByTask = groupEscalationEventsByTask(record.events ?? []);

    for (const task of record.plan?.tasks ?? []) {
      const taskId = task.task_id ?? task.id;
      const route = routeByTask.get(taskId) ?? task.routing;
      if (!taskId || !route) continue;

      const attempts = attemptsByTask.get(taskId) ?? [];
      const calls = callsByTask.get(taskId) ?? [];
      if (isPureFinalReviewTask(task, attempts, calls)) continue;

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

function createSample({ record, task, route, outcome, attempts, calls, escalationEvents }) {
  const taskId = task.task_id ?? task.id;
  const selectedModel = normalizeSelectedModel(route?.selected_model ?? route?.selectedModel);
  const plannedTier = route?.model_tier ?? task.model_tier ?? task.modelTier ?? "unknown";
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

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))].sort();
}

function uniqueStringsInOrder(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function roundCost(value) {
  return Math.round((Number.isFinite(value) ? value : 0) * 1000000000) / 1000000000;
}
