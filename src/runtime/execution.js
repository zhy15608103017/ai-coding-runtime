import { createContextPack } from "./workspace.js";
import { DEFAULT_PROVIDER_RETRY_POLICY, generateModelResponse } from "./providers.js";
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

  for (const task of record.plan.tasks ?? []) {
    const taskId = task.task_id ?? task.id;
    const skipReason = skipReasonForTask(task, record.workerAttempts ?? []);
    if (skipReason) {
      skippedTasks.push({
        taskId,
        task_id: taskId,
        reason: skipReason,
      });
      continue;
    }

    const modelSelection = resolveTaskModel(task, runtimeOptions);
    await appendEvent(store, normalizedRunId, {
      type: "task.execution.started",
      taskId,
      task_id: taskId,
      provider: modelSelection.provider,
      model: modelSelection.model,
    });

    try {
      const response = await generateWorkerResponse({
        task,
        modelSelection,
        generate,
        runtimeOptions,
      });
      await recordModelCall(store, normalizedRunId, response, taskId, runtimeOptions);

      const workerOutput = parseWorkerOutput(response);
      const submitted = await submitWorkerResult({
        runId: normalizedRunId,
        taskId,
        result: workerOutput,
        apply: apply === true,
        store,
        runtimeOptions,
      });

      const executedTask = {
        taskId,
        task_id: taskId,
        modelTier: task.model_tier ?? task.modelTier,
        model_tier: task.model_tier ?? task.modelTier,
        provider: response.provider ?? modelSelection.provider,
        model: response.model ?? modelSelection.model,
        workerStatus: submitted.status,
        worker_status: submitted.status,
      };
      executedTasks.push(executedTask);

      await appendEvent(store, normalizedRunId, {
        type: "task.execution.finished",
        taskId,
        task_id: taskId,
        status: submitted.status,
      });
    } catch (error) {
      if (error.provider || error.code?.startsWith?.("provider.")) {
        await recordModelCallFailure(store, normalizedRunId, error, modelSelection, runtimeOptions);
      }

      const failure = createTaskFailure({ taskId, modelSelection, error });
      failedTasks.push(failure);
      await appendEvent(store, normalizedRunId, {
        type: "task.execution.failed",
        taskId,
        task_id: taskId,
        provider: modelSelection.provider,
        model: modelSelection.model,
        error: failure.error,
      });
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

    record = await store.readRecord(normalizedRunId);
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

export function skipReasonForTask(task, workerAttempts = []) {
  const taskId = task.task_id ?? task.id;
  if (task.final_verification === true || task.finalVerification === true) {
    return "final_verification_task";
  }

  const allowedFiles = task.allowed_files ?? task.allowedFiles ?? [];
  if (!Array.isArray(allowedFiles) || allowedFiles.length === 0) {
    return "read_only_or_no_allowed_files";
  }

  if (!Array.isArray(task.acceptance) || task.acceptance.length === 0) {
    return "missing_acceptance";
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

function resolveTaskModel(task, runtimeOptions = {}) {
  const selectedModel =
    task.routing?.selected_model ??
    task.routing?.selectedModel ??
    task.selected_model ??
    task.selectedModel;
  const provider =
    selectedModel?.provider ??
    runtimeOptions.providers?.defaultProvider ??
    "local";
  const providerConfig = runtimeOptions.providers?.entries?.[provider];
  const model =
    selectedModel?.model ??
    selectedModel?.id ??
    providerConfig?.defaultModel ??
    "local-placeholder";

  return { provider, model };
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
