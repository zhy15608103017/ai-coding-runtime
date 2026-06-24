import { stableHash } from "./policy.js";

export const ROUTING_HISTORY_SCHEMA_VERSION = "ai-coding-runtime.routing-history.v1";

export function createRoutingHistorySnapshot(
  records = [],
  { now = new Date(), version = "0.1.0" } = {}
) {
  const normalizedRecords = Array.isArray(records) ? records : [];
  const exportedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const sanitizedRecords = [];
  let skipped = 0;

  for (const record of normalizedRecords) {
    const sanitized = sanitizeRoutingHistoryRecord(record);
    if (sanitized) {
      sanitizedRecords.push(sanitized);
    } else {
      skipped += 1;
    }
  }

  return {
    schemaVersion: ROUTING_HISTORY_SCHEMA_VERSION,
    exportedAt,
    exported_at: exportedAt,
    source: {
      runtime: "ai-coding-runtime",
      version,
    },
    summary: {
      recordsScanned: normalizedRecords.length,
      records_scanned: normalizedRecords.length,
      recordsExported: sanitizedRecords.length,
      records_exported: sanitizedRecords.length,
      recordsSkipped: skipped,
      records_skipped: skipped,
    },
    records: sanitizedRecords,
  };
}

export function importRoutingHistorySnapshot(snapshot = {}, { existingImportIds = new Set() } = {}) {
  if (snapshot?.schemaVersion !== ROUTING_HISTORY_SCHEMA_VERSION) {
    throw new Error(`Unsupported routing history schema: ${snapshot?.schemaVersion ?? "missing"}`);
  }

  if (!Array.isArray(snapshot.records)) {
    throw new Error("Invalid routing history snapshot: records must be an array.");
  }

  const importedRecords = [];
  const rejectedRecords = [];
  let duplicateCount = 0;

  for (const record of snapshot.records) {
    const sanitized = sanitizeRoutingHistoryRecord(record);
    if (!sanitized) {
      rejectedRecords.push({ reason: "record.invalid" });
      continue;
    }

    if (existingImportIds.has(sanitized.importId)) {
      duplicateCount += 1;
      continue;
    }

    existingImportIds.add(sanitized.importId);
    importedRecords.push(sanitized);
  }

  return {
    status: "ok",
    importedRecords,
    imported_records: importedRecords,
    imported: importedRecords.length,
    duplicates: duplicateCount,
    rejected: rejectedRecords.length,
    rejectedRecords,
    rejected_records: rejectedRecords,
  };
}

export function sanitizeRoutingHistoryRecord(record = {}) {
  if (!record || typeof record !== "object") return null;
  const tasks = Array.isArray(record.plan?.tasks) ? record.plan.tasks : [];
  const routingTraceSource = record.plan?.routingTrace ?? record.plan?.routing_trace;
  const routingTrace = Array.isArray(routingTraceSource) ? routingTraceSource : [];
  if (!record.status || tasks.length === 0 || routingTrace.length === 0) return null;

  const sourceHash =
    record.sourceRunIdHash ?? record.source_run_id_hash ?? sourceRunIdHash(record.runId);
  const planTasks = tasks.map(sanitizeTask).filter(Boolean);
  const planRoutingTrace = routingTrace.map(sanitizeRoute).filter(Boolean);
  const sanitized = {
    runId: record.importId ?? record.import_id ?? sourceHash,
    run_id: record.import_id ?? record.importId ?? sourceHash,
    importId: record.importId ?? record.import_id ?? null,
    import_id: record.import_id ?? record.importId ?? null,
    sourceRunIdHash: sourceHash,
    source_run_id_hash: sourceHash,
    createdAt: safeString(record.createdAt ?? record.created_at),
    created_at: safeString(record.created_at ?? record.createdAt),
    status: safeString(record.status),
    plan: {
      tasks: planTasks,
      routingTrace: planRoutingTrace,
      routing_trace: planRoutingTrace,
    },
    workerAttempts: sanitizeWorkerAttempts(record.workerAttempts ?? record.worker_attempts),
    worker_attempts: sanitizeWorkerAttempts(record.workerAttempts ?? record.worker_attempts),
    modelCalls: sanitizeModelCalls(record.modelCalls ?? record.model_calls),
    model_calls: sanitizeModelCalls(record.modelCalls ?? record.model_calls),
    verification: sanitizeVerification(record.verification),
    events: sanitizeEvents(record.events),
    imported: true,
  };

  if (sanitized.plan.tasks.length === 0 || sanitized.plan.routingTrace.length === 0) return null;

  const importId = record.importId ?? record.import_id ?? `sha256:${stableHash(sanitized)}`;
  sanitized.importId = importId;
  sanitized.import_id = importId;
  sanitized.runId = importId;
  sanitized.run_id = importId;
  return sanitized;
}

function sanitizeTask(task = {}) {
  const taskId = task.task_id ?? task.id ?? task.taskId;
  if (!taskId) return null;

  const taskType = safeString(task.taskType ?? task.task_type ?? task.difficulty ?? "unknown");
  const contextNeed = safeString(task.contextNeed ?? task.context_need ?? "unknown");
  const modelTier = safeString(task.modelTier ?? task.model_tier ?? "unknown");
  const finalVerification = task.finalVerification === true || task.final_verification === true;

  return {
    id: safeString(taskId),
    task_id: safeString(taskId),
    taskType,
    task_type: taskType,
    difficulty: safeString(task.difficulty ?? "unknown"),
    risk: safeString(task.risk ?? "unknown"),
    contextNeed,
    context_need: contextNeed,
    verification: safeString(task.verification ?? "unknown"),
    modelTier,
    model_tier: modelTier,
    finalVerification,
    final_verification: finalVerification,
  };
}

function sanitizeRoute(route = {}) {
  const taskId = route.task_id ?? route.taskId;
  if (!taskId) return null;

  const selected = route.selected_model ?? route.selectedModel ?? {};
  const modelTier = safeString(route.model_tier ?? route.modelTier ?? selected.tier ?? "unknown");
  const selectedModel =
    selected && typeof selected === "object" && !Array.isArray(selected)
      ? {
          provider: safeString(selected.provider ?? route.selected_provider ?? "unknown"),
          model: safeString(selected.model ?? selected.name ?? "unknown"),
          tier: safeString(selected.tier ?? selected.modelTier ?? selected.model_tier ?? modelTier),
        }
      : {
          provider: safeString(route.selected_provider ?? "unknown"),
          model: safeString(selected),
          tier: modelTier,
        };

  return {
    task_id: safeString(taskId),
    taskId: safeString(taskId),
    model_tier: modelTier,
    modelTier,
    selected_model: selectedModel,
    selectedModel,
    selected_provider: selectedModel.provider,
    selectedProvider: selectedModel.provider,
    cost_hint: sanitizeCostHint(route.cost_hint ?? route.costHint),
    costHint: sanitizeCostHint(route.costHint ?? route.cost_hint),
  };
}

function sanitizeWorkerAttempts(attempts = []) {
  if (!Array.isArray(attempts)) return [];

  return attempts
    .map((attempt) => {
      const taskId = attempt.taskId ?? attempt.task_id;
      if (!taskId) return null;
      const touchedFiles = attempt.filesTouched ?? attempt.files_touched;
      const filesTouchedCount = Array.isArray(touchedFiles)
        ? touchedFiles.length
        : numberOrNull(attempt.filesTouchedCount ?? attempt.files_touched_count) ?? 0;
      const modelTier = safeString(attempt.modelTier ?? attempt.model_tier);

      return {
        taskId: safeString(taskId),
        task_id: safeString(taskId),
        status: safeString(attempt.status ?? "unknown"),
        applied: attempt.applied === true,
        modelTier,
        model_tier: modelTier,
        filesTouchedCount,
        files_touched_count: filesTouchedCount,
      };
    })
    .filter(Boolean);
}

function sanitizeModelCalls(calls = []) {
  if (!Array.isArray(calls)) return [];

  return calls
    .map((call) => {
      const taskId = call.request?.taskId ?? call.request?.task_id ?? call.taskId ?? call.task_id;
      if (!taskId) return null;
      const costEstimate = sanitizeCostEstimate(call.costEstimate ?? call.cost_estimate);
      const usage = sanitizeUsage(call.usage);
      const tier = safeString(call.tier ?? call.modelTier ?? call.model_tier);

      return {
        taskId: safeString(taskId),
        task_id: safeString(taskId),
        request: {
          taskId: safeString(taskId),
          task_id: safeString(taskId),
        },
        provider: safeString(call.provider ?? "unknown"),
        model: safeString(call.model ?? "unknown"),
        tier,
        modelTier: tier,
        model_tier: tier,
        status: safeString(call.status ?? "finished"),
        usage,
        costEstimate,
        cost_estimate: costEstimate,
      };
    })
    .filter(Boolean);
}

function sanitizeVerification(verification = []) {
  if (!Array.isArray(verification)) return [];

  return verification.map((item) => ({
    status: safeString(item.status ?? "unknown"),
    acceptance: sanitizeAcceptance(item.acceptance ?? item.taskAcceptance ?? item.task_acceptance),
    escalation: {
      required: item.escalation?.required === true,
    },
  }));
}

function sanitizeAcceptance(acceptance = {}) {
  const tasks = Array.isArray(acceptance.tasks)
    ? acceptance.tasks
    : Array.isArray(acceptance.taskResults)
      ? acceptance.taskResults
      : [];

  return {
    status: safeString(acceptance.status ?? "unknown"),
    tasks: tasks.map((task) => ({
      taskId: safeString(task.taskId ?? task.task_id ?? task.id),
      task_id: safeString(task.task_id ?? task.taskId ?? task.id),
      status: safeString(task.status ?? "unknown"),
    })),
  };
}

function sanitizeEvents(events = []) {
  if (!Array.isArray(events)) return [];

  return events
    .filter((event) => typeof event?.type === "string")
    .map((event) => ({
      type: safeString(event.type),
      taskId: safeString(event.taskId ?? event.task_id),
      task_id: safeString(event.task_id ?? event.taskId),
      fromTier: safeString(event.fromTier ?? event.from_tier),
      from_tier: safeString(event.from_tier ?? event.fromTier),
      toTier: safeString(event.toTier ?? event.to_tier),
      to_tier: safeString(event.to_tier ?? event.toTier),
    }));
}

function sanitizeCostHint(costHint = {}) {
  return {
    estimated_usd_per_call: numberOrNull(costHint.estimated_usd_per_call ?? costHint.estimatedUsdPerCall),
  };
}

function sanitizeCostEstimate(costEstimate = {}) {
  const estimatedCost = numberOrNull(costEstimate.estimatedCost ?? costEstimate.estimated_cost);
  return {
    currency: safeString(costEstimate.currency ?? "USD"),
    estimatedCost,
    estimated_cost: estimatedCost,
  };
}

function sanitizeUsage(usage = {}) {
  const totalTokens = numberOrNull(usage.totalTokens ?? usage.total_tokens);
  return {
    totalTokens,
    total_tokens: totalTokens,
  };
}

function sourceRunIdHash(runId) {
  return `sha256:${stableHash({ runId: runId ?? "unknown" })}`;
}

function safeString(value) {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
