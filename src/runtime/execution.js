import { createContextPack } from "./workspace.js";
import { DEFAULT_PROVIDER_RETRY_POLICY, generateModelResponse } from "./providers.js";
import { DEFAULT_ESCALATION_POLICY, DEFAULT_MODEL_REGISTRY } from "./router.js";
import { createReport as defaultCreateReport } from "./report.js";
import { RUN_STATUS } from "./status.js";
import { redactSecrets } from "./policy.js";
import {
  createWorkerPrompt,
  submitWorkerResult as defaultSubmitWorkerResult,
} from "./worker.js";

const EXECUTABLE_STATUSES = new Set([
  RUN_STATUS.planned,
  RUN_STATUS.approved,
  RUN_STATUS.verificationFailed,
  RUN_STATUS.verificationSkipped,
]);

const SUCCESSFUL_WORKER_STATUSES = new Set(["applied", "recorded"]);
const DEPENDENCY_SATISFYING_SKIP_REASONS = new Set([
  "read_only_or_no_allowed_files",
  "final_verification_task",
  "already_successful_worker_attempt",
]);

export async function executeRun({
  runId,
  apply = true,
  verify = true,
  store,
  runtimeOptions = {},
  generate = generateModelResponse,
  submitWorkerResult = defaultSubmitWorkerResult,
  verifyRun,
  createReport = defaultCreateReport,
} = {}) {
  if (!store?.readRecord || !store?.updateRecord) {
    throw new Error("runtime_execute requires a store.");
  }

  if (!runId || typeof runId !== "string" || runId.trim().length === 0) {
    throw new Error("runId is required.");
  }

  const normalizedRunId = runId.trim();
  let record = await store.readRecord(normalizedRunId);
  if (!EXECUTABLE_STATUSES.has(record.status)) {
    throw conflictError(`Run ${normalizedRunId} cannot execute from ${record.status} status.`);
  }

  await appendEvent(store, normalizedRunId, {
    type: "execution.started",
    apply: apply === true,
    verify: verify === true,
  });

  const executedTasks = [];
  const skippedTasks = [];
  const failedTasks = [];
  const pendingTasks = [...(record.plan.tasks ?? [])];
  const completedTaskIds = new Set();
  const failedTaskIds = new Set();

  while (pendingTasks.length > 0) {
    let progressed = false;

    for (let index = 0; index < pendingTasks.length; index += 1) {
      const task = pendingTasks[index];
      const taskId = task.task_id ?? task.id;
      const dependencyStatus = dependencyStatusForTask(task, {
        completedTaskIds,
        failedTaskIds,
      });

      if (dependencyStatus.failed.length > 0) {
        skippedTasks.push({
          taskId,
          task_id: taskId,
          reason: "dependency_failed",
          dependencies: dependencyStatus.failed,
        });
        pendingTasks.splice(index, 1);
        index -= 1;
        progressed = true;
        continue;
      }

      if (!dependencyStatus.ready) {
        continue;
      }

      pendingTasks.splice(index, 1);
      index -= 1;
      progressed = true;

      const skipReason = skipReasonForTask(task, record.workerAttempts ?? []);
      if (skipReason) {
        skippedTasks.push({
          taskId,
          task_id: taskId,
          reason: skipReason,
        });
        if (skipReasonSatisfiesDependencies(skipReason)) {
          completedTaskIds.add(taskId);
        }
        continue;
      }

      const taskExecution = await executeTaskWithRetries({
        runId: normalizedRunId,
        task,
        record,
        apply,
        store,
        runtimeOptions,
        generate,
        submitWorkerResult,
      });

      if (taskExecution.failedTask) {
        failedTasks.push(taskExecution.failedTask);
        failedTaskIds.add(taskId);
        await appendEvent(store, normalizedRunId, {
          type: "execution.failed",
          status: "failed",
          failedTaskCount: failedTasks.length,
          failed_task_count: failedTasks.length,
        });

        return buildExecuteResult({
          runId: normalizedRunId,
          status: "failed",
          executedTasks,
          skippedTasks,
          failedTasks,
          verification: {
            runId: normalizedRunId,
            status: "skipped",
            message: "Verification skipped after execution failure.",
            commands: [],
          },
          store,
          createReport,
          runtimeOptions,
        });
      }

      executedTasks.push(taskExecution.executedTask);
      completedTaskIds.add(taskId);
      record = await store.readRecord(normalizedRunId);
    }

    if (!progressed) {
      for (const task of pendingTasks) {
        failedTasks.push(createTaskFailure({
          taskId: task.task_id ?? task.id,
          modelSelection: resolveTaskModel(task, runtimeOptions, { record }),
          error: dependencyError(task),
        }));
      }
      await appendEvent(store, normalizedRunId, {
        type: "execution.failed",
        status: "failed",
        failedTaskCount: failedTasks.length,
        failed_task_count: failedTasks.length,
      });

      return buildExecuteResult({
        runId: normalizedRunId,
        status: "failed",
        executedTasks,
        skippedTasks,
        failedTasks,
        verification: {
          runId: normalizedRunId,
          status: "skipped",
          message: "Verification skipped because task dependencies could not be resolved.",
          commands: [],
        },
        store,
        createReport,
        runtimeOptions,
      });
    }
  }

  let verification;
  if (verify === true) {
    verification = typeof verifyRun === "function"
      ? await verifyRun(normalizedRunId, store, runtimeOptions)
      : await persistSkippedVerification({
          store,
          runId: normalizedRunId,
          message: "Verification helper unavailable.",
        });
  } else {
    verification = await persistSkippedVerification({
      store,
      runId: normalizedRunId,
      message: "Verification skipped by execute request.",
    });
  }

  const status = statusForVerification(verification.status);
  await appendEvent(store, normalizedRunId, {
    type: "execution.finished",
    status,
    executedTaskCount: executedTasks.length,
    executed_task_count: executedTasks.length,
    skippedTaskCount: skippedTasks.length,
    skipped_task_count: skippedTasks.length,
  });

  return buildExecuteResult({
    runId: normalizedRunId,
    status,
    executedTasks,
    skippedTasks,
    failedTasks,
    verification,
    store,
    createReport,
    runtimeOptions,
  });
}

async function executeTaskWithRetries({
  runId,
  task,
  record,
  apply,
  store,
  runtimeOptions,
  generate,
  submitWorkerResult,
}) {
  const taskId = task.task_id ?? task.id;
  const maxWorkerRetries = resolveMaxWorkerRetries(record, runtimeOptions);
  const attempts = [];
  let retriesUsed = 0;
  let modelSelection = resolveTaskModel(task, runtimeOptions, { record });

  while (true) {
    const attemptNumber = attempts.length + 1;
    await appendEvent(store, runId, {
      type: "task.execution.started",
      taskId,
      task_id: taskId,
      provider: modelSelection.provider,
      model: modelSelection.model,
      modelTier: modelSelection.tier,
      model_tier: modelSelection.tier,
      attempt: attemptNumber,
    });

    try {
      const response = await generateWorkerResponse({
        task,
        modelSelection,
        generate,
        runtimeOptions,
      });
      await recordModelCall(store, runId, response, taskId, runtimeOptions);

      const workerOutput = parseWorkerOutput(response);
      const submitted = await submitWorkerResult({
        runId,
        taskId,
        result: workerOutput,
        apply: apply === true,
        store,
        runtimeOptions,
      });
      const successAttempt = {
        attempt: attemptNumber,
        status: submitted.status,
        modelTier: modelSelection.tier,
        model_tier: modelSelection.tier,
        provider: response.provider ?? modelSelection.provider,
        model: response.model ?? modelSelection.model,
      };
      attempts.push(successAttempt);

      const executedTask = {
        taskId,
        task_id: taskId,
        modelTier: modelSelection.tier,
        model_tier: modelSelection.tier,
        provider: response.provider ?? modelSelection.provider,
        model: response.model ?? modelSelection.model,
        workerStatus: submitted.status,
        worker_status: submitted.status,
        attemptCount: attemptNumber,
        attempt_count: attemptNumber,
        attempts: [...attempts],
      };

      await appendEvent(store, runId, {
        type: "task.execution.finished",
        taskId,
        task_id: taskId,
        status: submitted.status,
        attempt: attemptNumber,
        attemptCount: attemptNumber,
        attempt_count: attemptNumber,
      });

      return { executedTask };
    } catch (error) {
      if (error.provider || error.code?.startsWith?.("provider.")) {
        await recordModelCallFailure(store, runId, error, modelSelection, runtimeOptions);
      }

      const failure = createTaskFailure({ taskId, modelSelection, error });
      attempts.push({
        attempt: attemptNumber,
        status: "failed",
        modelTier: modelSelection.tier,
        model_tier: modelSelection.tier,
        provider: modelSelection.provider,
        model: modelSelection.model,
        error: failure.error,
      });
      await appendEvent(store, runId, {
        type: "task.execution.failed",
        taskId,
        task_id: taskId,
        provider: modelSelection.provider,
        model: modelSelection.model,
        modelTier: modelSelection.tier,
        model_tier: modelSelection.tier,
        attempt: attemptNumber,
        error: failure.error,
      });

      const nextModelSelection =
        retriesUsed < maxWorkerRetries
          ? resolveEscalatedModelSelection({ task, record, runtimeOptions, modelSelection })
          : null;
      if (!nextModelSelection) {
        return { failedTask: failure };
      }

      retriesUsed += 1;
      await appendEvent(store, runId, {
        type: "task.execution.escalated",
        taskId,
        task_id: taskId,
        fromTier: modelSelection.tier,
        from_tier: modelSelection.tier,
        toTier: nextModelSelection.tier,
        to_tier: nextModelSelection.tier,
        fromModel: modelSelection.model,
        from_model: modelSelection.model,
        toModel: nextModelSelection.model,
        to_model: nextModelSelection.model,
        attempt: attemptNumber,
        reason: failure.error.code,
      });

      modelSelection = nextModelSelection;
    }
  }
}

export function skipReasonForTask(task, workerAttempts = []) {
  const taskId = task.task_id ?? task.id;
  if (!Array.isArray(task.acceptance) || task.acceptance.length === 0) {
    return "missing_acceptance";
  }

  if (task.final_verification === true || task.finalVerification === true) {
    return "final_verification_task";
  }

  const allowedFiles = task.allowed_files ?? task.allowedFiles ?? [];
  if (!Array.isArray(allowedFiles) || allowedFiles.length === 0) {
    return "read_only_or_no_allowed_files";
  }

  const alreadySucceeded = workerAttempts.some(
    (attempt) =>
      (attempt.task_id ?? attempt.taskId) === taskId &&
      SUCCESSFUL_WORKER_STATUSES.has(attempt.status)
  );
  if (alreadySucceeded) {
    return "already_successful_worker_attempt";
  }

  return null;
}

function skipReasonSatisfiesDependencies(reason) {
  return DEPENDENCY_SATISFYING_SKIP_REASONS.has(reason);
}

function dependencyStatusForTask(task, { completedTaskIds, failedTaskIds }) {
  const dependencies = dependenciesForTask(task);
  const failed = dependencies.filter((dependencyId) => failedTaskIds.has(dependencyId));
  const pending = dependencies.filter(
    (dependencyId) => !completedTaskIds.has(dependencyId) && !failedTaskIds.has(dependencyId)
  );

  return {
    ready: failed.length === 0 && pending.length === 0,
    failed,
    pending,
  };
}

function dependenciesForTask(task = {}) {
  return uniqueStrings(task.depends_on ?? task.dependsOn ?? []);
}

function dependencyError(task) {
  const dependencies = dependenciesForTask(task);
  const error = new Error(
    `task.dependencies.unresolved: ${task.task_id ?? task.id} is waiting for ${dependencies.join(", ") || "unknown dependencies"}.`
  );
  error.code = "task.dependencies.unresolved";
  return error;
}

async function generateWorkerResponse({ task, modelSelection, generate, runtimeOptions }) {
  const cwd = runtimeOptions.workspace?.cwd ?? process.cwd();
  const maxContextBytesPerFile =
    runtimeOptions.execution?.maxContextBytesPerFile ??
    runtimeOptions.execution?.max_context_bytes_per_file ??
    16 * 1024;
  const workerTimeoutMs =
    runtimeOptions.execution?.workerTimeoutMs ??
    runtimeOptions.execution?.worker_timeout_ms ??
    runtimeOptions.providers?.retryPolicy?.timeoutMs ??
    DEFAULT_PROVIDER_RETRY_POLICY.timeoutMs;
  const contextPack = await createContextPack({
    cwd,
    task,
    policy: runtimeOptions.policy,
    maxBytesPerFile: maxContextBytesPerFile,
  });
  const prompt = redactSecrets(createStrictWorkerPrompt(task, contextPack), runtimeOptions.policy);
  const messages = redactSecrets(
    [
      {
        role: "system",
        content: "You are an AI Coding Runtime worker. Return only valid JSON.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    runtimeOptions.policy
  );

  const request = {
    provider: modelSelection.provider,
    model: modelSelection.model,
    messages,
    timeoutMs: workerTimeoutMs,
  };

  if (shouldUseWorkerResponseSchema(modelSelection, runtimeOptions)) {
    request.responseSchema = workerResponseSchema();
  }

  return generate(request, { providers: runtimeOptions.providers });
}

function createStrictWorkerPrompt(task, contextPack) {
  return [
    createWorkerPrompt({ task, contextPack }),
    "",
    "Return only a JSON object matching this shape:",
    JSON.stringify(
      {
        patch: "diff --git ...",
        explanation: "What changed and why.",
        verificationNotes: ["How you reasoned about verification."],
        confidence: 0.8,
        filesTouched: ["src/file.js"],
        acceptance: {
          "criterion text": "evidence",
        },
      },
      null,
      2
    ),
  ].join("\n");
}

function resolveTaskModel(task, runtimeOptions = {}, { record = null, tierOverride = null } = {}) {
  const modelRegistry = resolveModelRegistry(record, runtimeOptions);
  if (tierOverride) {
    const registryModel = selectModelForTier(modelRegistry, tierOverride);
    if (registryModel) {
      return {
        provider: registryModel.provider,
        model: registryModel.model ?? registryModel.id,
        tier: registryModel.tier ?? tierOverride,
      };
    }
  }

  const selectedModel =
    task.routing?.selected_model ??
    task.routing?.selectedModel ??
    task.selected_model ??
    task.selectedModel;
  const selectedModelName =
    typeof selectedModel === "string" ? selectedModel : selectedModel?.model ?? selectedModel?.id;
  const provider =
    (typeof selectedModel === "object" ? selectedModel?.provider : null) ??
    runtimeOptions.providers?.defaultProvider ??
    "local";
  const providerConfig = runtimeOptions.providers?.entries?.[provider];
  const model =
    selectedModelName ??
    providerConfig?.defaultModel ??
    "local-placeholder";
  const tier = tierOverride ?? resolveTaskTier(task, selectedModel);

  return { provider, model, tier };
}

function resolveEscalatedModelSelection({ task, record, runtimeOptions, modelSelection }) {
  const tierOrder = resolveTierOrder(record, runtimeOptions);
  const nextTier = nextTierInOrder(modelSelection.tier, tierOrder);
  if (!nextTier || nextTier === modelSelection.tier) {
    return null;
  }

  const nextModelSelection = resolveTaskModel(task, runtimeOptions, {
    record,
    tierOverride: nextTier,
  });

  if (
    nextModelSelection.provider === modelSelection.provider &&
    nextModelSelection.model === modelSelection.model
  ) {
    return null;
  }

  return nextModelSelection;
}

function resolveTaskTier(task = {}, selectedModel = null) {
  return (
    (typeof selectedModel === "object" ? selectedModel?.tier : null) ??
    task.routing?.model_tier ??
    task.routing?.modelTier ??
    task.model_tier ??
    task.modelTier ??
    DEFAULT_ESCALATION_POLICY.tierOrder[0]
  );
}

function resolveModelRegistry(record, runtimeOptions = {}) {
  const registry =
    runtimeOptions.execution?.modelRegistry ??
    runtimeOptions.execution?.model_registry ??
    runtimeOptions.modelRegistry ??
    runtimeOptions.model_registry ??
    runtimeOptions.routing?.modelRegistry ??
    runtimeOptions.routing?.model_registry ??
    record?.plan?.modelRegistry ??
    record?.plan?.model_registry ??
    DEFAULT_MODEL_REGISTRY;

  return Array.isArray(registry) ? registry : DEFAULT_MODEL_REGISTRY;
}

function selectModelForTier(modelRegistry, tier) {
  return modelRegistry.find((entry) => entry?.tier === tier) ?? null;
}

function resolveTierOrder(record, runtimeOptions = {}) {
  const order =
    runtimeOptions.execution?.tierOrder ??
    runtimeOptions.execution?.tier_order ??
    runtimeOptions.escalationPolicy?.tierOrder ??
    runtimeOptions.escalationPolicy?.tier_order ??
    runtimeOptions.escalation_policy?.tierOrder ??
    runtimeOptions.escalation_policy?.tier_order ??
    runtimeOptions.routing?.tierOrder ??
    runtimeOptions.routing?.tier_order ??
    runtimeOptions.routing?.escalationPolicy?.tierOrder ??
    runtimeOptions.routing?.escalationPolicy?.tier_order ??
    runtimeOptions.routing?.escalation_policy?.tierOrder ??
    runtimeOptions.routing?.escalation_policy?.tier_order ??
    record?.plan?.escalationPolicy?.tierOrder ??
    record?.plan?.escalation_policy?.tierOrder ??
    record?.plan?.escalation_policy?.tier_order ??
    DEFAULT_ESCALATION_POLICY.tierOrder;

  return Array.isArray(order) && order.length > 0 ? order : DEFAULT_ESCALATION_POLICY.tierOrder;
}

function nextTierInOrder(currentTier, tierOrder) {
  const index = tierOrder.indexOf(currentTier);
  if (index === -1 || index >= tierOrder.length - 1) {
    return null;
  }

  return tierOrder[index + 1];
}

function resolveMaxWorkerRetries(record, runtimeOptions = {}) {
  const value =
    runtimeOptions.execution?.maxWorkerRetries ??
    runtimeOptions.execution?.max_worker_retries ??
    runtimeOptions.policy?.budget?.maxWorkerRetries ??
    runtimeOptions.policy?.budget?.max_worker_retries ??
    runtimeOptions.budgetPolicy?.maxRetryCount ??
    runtimeOptions.budgetPolicy?.max_retry_count ??
    runtimeOptions.budget_policy?.maxRetryCount ??
    runtimeOptions.budget_policy?.max_retry_count ??
    runtimeOptions.routing?.budgetPolicy?.maxRetryCount ??
    runtimeOptions.routing?.budgetPolicy?.max_retry_count ??
    runtimeOptions.routing?.budget_policy?.maxRetryCount ??
    runtimeOptions.routing?.budget_policy?.max_retry_count ??
    record?.plan?.policyConfig?.budget?.maxWorkerRetries ??
    record?.plan?.policy_config?.budget?.maxWorkerRetries ??
    record?.plan?.policy_config?.budget?.max_worker_retries ??
    record?.plan?.budgetPolicy?.maxRetryCount ??
    record?.plan?.budget_policy?.maxRetryCount ??
    record?.plan?.budget_policy?.max_retry_count ??
    record?.plan?.budgetStatus?.maxRetryCount ??
    record?.plan?.budget_status?.max_retry_count ??
    DEFAULT_ESCALATION_POLICY.tierOrder.length - 1;

  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_ESCALATION_POLICY.tierOrder.length - 1;
}

function shouldUseWorkerResponseSchema(modelSelection, runtimeOptions = {}) {
  const provider = modelSelection?.provider;
  const providerConfig = runtimeOptions.providers?.entries?.[provider];
  const providerType = providerConfig?.type ?? provider;
  const executionSchemaSetting =
    runtimeOptions.execution?.workerResponseSchema ??
    runtimeOptions.execution?.worker_response_schema;
  const providerSchemaSetting =
    providerConfig?.workerResponseSchema ??
    providerConfig?.worker_response_schema;

  if (typeof executionSchemaSetting === "boolean") {
    return executionSchemaSetting;
  }

  if (typeof providerSchemaSetting === "boolean") {
    return providerSchemaSetting;
  }

  return providerType !== "openai-compatible";
}
function parseWorkerOutput(response) {
  const structured = response?.structuredOutput ?? response?.structured_output;
  if (isPlainObject(structured)) {
    return structured;
  }

  if (typeof response?.text === "string" && response.text.trim().length > 0) {
    try {
      const parsed = JSON.parse(response.text);
      if (isPlainObject(parsed)) {
        return parsed;
      }
    } catch {
      // Fall through to the structured error below.
    }
  }

  const error = new Error("worker.output.malformed: provider response did not contain a JSON object.");
  error.code = "worker.output.malformed";
  throw error;
}

async function recordModelCall(store, runId, response, taskId, runtimeOptions) {
  if (typeof store.recordModelCall !== "function") return;
  const safeResponse = redactSecrets(response, runtimeOptions.policy);
  await store.recordModelCall(runId, {
    taskId,
    task_id: taskId,
    provider: safeResponse.provider,
    model: safeResponse.model,
    usage: safeResponse.usage,
    costEstimate: safeResponse.costEstimate,
    cost_estimate: safeResponse.cost_estimate,
    finishReason: safeResponse.finishReason,
    finish_reason: safeResponse.finish_reason,
    request: safeResponse.request,
  });
}

async function recordModelCallFailure(store, runId, error, modelSelection, runtimeOptions) {
  if (typeof store.recordModelCallFailure !== "function") return;
  const failure = redactSecrets(
    {
      provider: error.provider ?? modelSelection.provider,
      model: modelSelection.model,
      usage: null,
      costEstimate: null,
      cost_estimate: null,
      finishReason: "error",
      finish_reason: "error",
      request: {
        durationMs: 0,
        duration_ms: 0,
      },
      error: {
        message: error.message,
        code: error.code ?? "provider.error",
      },
    },
    runtimeOptions.policy
  );
  await store.recordModelCallFailure(runId, failure);
}

async function appendEvent(store, runId, event) {
  const timestamp = event.timestamp ?? new Date().toISOString();
  await store.updateRecord(
    runId,
    (record) => {
      record.events.push({
        timestamp,
        ...event,
      });
      return record;
    },
    { now: new Date(timestamp) }
  );
}

async function buildExecuteResult({
  runId,
  status,
  executedTasks,
  skippedTasks,
  failedTasks,
  verification,
  store,
  createReport,
  runtimeOptions,
}) {
  const latestRecord = await store.readRecord(runId);
  const historyRecords =
    typeof store.listRecords === "function" ? await store.listRecords() : [];
  const report = createReport(latestRecord, {
    historyRecords,
    policy: runtimeOptions.policy,
  });

  return {
    runId,
    status,
    executedTasks,
    executed_tasks: executedTasks,
    skippedTasks,
    skipped_tasks: skippedTasks,
    failedTasks,
    failed_tasks: failedTasks,
    verification,
    report,
  };
}

async function persistSkippedVerification({ store, runId, message }) {
  const startedAt = new Date().toISOString();
  const verification = {
    runId,
    name: "verification",
    status: "skipped",
    message,
    commands: [],
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
  };

  await store.updateRecord(
    runId,
    (record) => {
      const runStatusBeforeFinish = record.status;
      record.status = RUN_STATUS.verificationSkipped;
      record.verification.push(verification);
      record.events.push({
        type: "verification.finished",
        timestamp: startedAt,
        status: verification.status,
        message: verification.message,
        commandCount: 0,
        runStatusBeforeFinish,
        runStatusAfterFinish: RUN_STATUS.verificationSkipped,
      });
      return record;
    },
    { now: new Date(startedAt) }
  );

  return verification;
}

function statusForVerification(status) {
  if (status === "passed") return RUN_STATUS.verificationPassed;
  if (status === "failed") return RUN_STATUS.verificationFailed;
  return RUN_STATUS.verificationSkipped;
}

function createTaskFailure({ taskId, modelSelection, error }) {
  return {
    taskId,
    task_id: taskId,
    provider: modelSelection.provider,
    model: modelSelection.model,
    error: {
      message: error.message,
      code: error.code ?? error.validation?.errors?.[0]?.code ?? "task.execution.failed",
    },
  };
}

function workerResponseSchema() {
  return {
    type: "object",
    properties: {
      patch: { type: "string" },
      explanation: { type: "string" },
      verificationNotes: {
        type: "array",
        items: { type: "string" },
      },
      confidence: { type: "number" },
      filesTouched: {
        type: "array",
        items: { type: "string" },
      },
      acceptance: { type: "object" },
    },
    required: ["patch", "explanation", "verificationNotes", "confidence", "filesTouched", "acceptance"],
    additionalProperties: true,
  };
}

function conflictError(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(values) {
  return Array.isArray(values)
    ? [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))]
    : [];
}
