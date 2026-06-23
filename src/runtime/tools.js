import { createRuntimePlan } from "./planner.js";
import { reviewTaskAcceptance } from "./acceptance.js";
import { executeRun } from "./execution.js";
import { checkProviderHealth, generateModelResponse } from "./providers.js";
import { createReport, formatReportMarkdown } from "./report.js";
import { RUN_STATUS, canVerifyRun } from "./status.js";
import { runSupervisorReview } from "./supervisor.js";
import { applyCommandPolicy, buildVerificationCommands, runVerificationCommands } from "./verification.js";
import { submitWorkerResult } from "./worker.js";
import { createAuditExport, redactSecrets } from "./policy.js";

export const RUNTIME_TOOLS = [
  {
    name: "runtime_plan",
    description: "Create a task plan without creating a persisted run.",
    inputSchema: requestSchema(),
  },
  {
    name: "runtime_estimate",
    description: "Estimate task difficulty, risk, and model routing tiers.",
    inputSchema: requestSchema(),
  },
  {
    name: "runtime_run",
    description: "Create a persisted runtime run from a request.",
    inputSchema: requestSchema(),
  },
  {
    name: "runtime_status",
    description: "Return the current status for a runtime run.",
    inputSchema: runIdSchema(),
  },
  {
    name: "runtime_collect",
    description: "Collect intermediate artifacts, events, and task outputs for a run.",
    inputSchema: runIdSchema(),
  },
  {
    name: "runtime_execute",
    description: "Explicitly execute eligible worker tasks for a persisted run.",
    inputSchema: executeSchema(),
  },
  {
    name: "runtime_verify",
    description: "Run or record verification for a runtime run.",
    inputSchema: verifySchema(),
  },
  {
    name: "runtime_report",
    description: "Return the final run report as JSON or Markdown.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        format: { type: "string", enum: ["json", "markdown"] },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "runtime_audit",
    description: "Return a redacted audit export for a completed runtime run.",
    inputSchema: runIdSchema(),
  },
  {
    name: "runtime_cancel",
    description: "Cancel a runtime run and record the reason.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "runtime_approve",
    description: "Approve a runtime run that is waiting at the human approval gate.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        approvedBy: { type: "string" },
        note: { type: "string" },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "runtime_provider_health",
    description: "Return local provider configuration health without making model calls.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "runtime_model_generate",
    description: "Call a configured model provider through the normalized provider interface.",
    inputSchema: modelGenerateSchema(),
  },
  {
    name: "runtime_submit_worker_result",
    description: "Validate, optionally apply, and record a structured worker result for a task.",
    inputSchema: workerResultSchema(),
  },
];

export async function callRuntimeTool(name, args, { store, runtimeOptions = {} } = {}) {
  switch (name) {
    case "runtime_plan":
      return createRuntimePlan({ request: requireRequest(args), ...runtimeOptions });
    case "runtime_estimate":
      return createEstimate(requireRequest(args), runtimeOptions);
    case "runtime_run":
      return createRun(requireRequest(args), store, runtimeOptions);
    case "runtime_status":
      return readStatus(requireRunId(args), store);
    case "runtime_collect":
      return collectRun(requireRunId(args), store);
    case "runtime_execute":
      return executeRun({
        runId: requireRunId(args),
        apply: args.apply !== false,
        verify: args.verify !== false,
        store,
        runtimeOptions,
        generate: runtimeOptions.execution?.generate,
        verifyRun,
        createReport,
      });
    case "runtime_verify":
      return verifyRun(requireRunId(args), store, withVerificationOverride(runtimeOptions, args));
    case "runtime_report":
      return reportRun(requireRunId(args), args, store, runtimeOptions);
    case "runtime_audit":
      return auditRun(requireRunId(args), store, runtimeOptions);
    case "runtime_cancel":
      return cancelRun(requireRunId(args), args, store);
    case "runtime_approve":
      return approveRun(requireRunId(args), args, store);
    case "runtime_provider_health":
      return providerHealth(args, runtimeOptions);
    case "runtime_model_generate":
      return modelGenerate(args, store, runtimeOptions);
    case "runtime_submit_worker_result":
      return submitWorkerResult({
        runId: requireRunId(args),
        taskId: requireTaskId(args),
        result: args.result,
        apply: args.apply === true,
        store,
        runtimeOptions,
      });
    default:
      throw new Error(`Unknown runtime tool: ${name}`);
  }
}

export function asMcpToolResult(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);

  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    structuredContent: value,
  };
}

function createEstimate(request, runtimeOptions = {}) {
  const plan = createRuntimePlan({ request, ...runtimeOptions });

  return {
    request,
    modelTiers: plan.modelTiers,
    modelTierAliases: plan.modelTierAliases,
    modelRegistry: plan.modelRegistry,
    routingPolicy: plan.routingPolicy,
    budgetPolicy: plan.budgetPolicy,
    escalationPolicy: plan.escalationPolicy,
    budgetStatus: plan.budgetStatus,
    policyConfig: plan.policyConfig,
    policy_config: plan.policy_config,
    policyValidation: plan.policyValidation,
    policy_validation: plan.policy_validation,
    policyStatus: plan.policyStatus,
    policy_status: plan.policy_status,
    routingTrace: plan.routingTrace,
    estimatedCost: plan.estimatedCost,
    approvalRequired: plan.approvalRequired,
    approval: plan.approval,
    validation: plan.validation,
    taskGraph: plan.taskGraph,
    planReport: plan.planReport,
    planningPrompt: plan.planningPrompt,
    riskSummary: plan.riskSummary,
    tasks: plan.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      difficulty: task.difficulty,
      risk: task.risk,
      contextNeed: task.contextNeed,
      verification: task.verification,
      modelTier: task.modelTier,
      routingReason: task.routingReason,
      classification: task.classification,
      routing: task.routing,
    })),
  };
}

async function createRun(request, store, runtimeOptions = {}) {
  const plan = createRuntimePlan({ request, ...runtimeOptions });
  const record = await store.createRecord(plan);

  return {
    runId: record.runId,
    status: record.status,
    plan: record.plan,
  };
}

async function readStatus(runId, store) {
  const record = await store.readRecord(runId);
  return summarizeRecord(record);
}

async function collectRun(runId, store) {
  const record = await store.readRecord(runId);

  return {
    runId: record.runId,
    status: record.status,
    tasks: record.plan.tasks,
    events: record.events,
    verification: record.verification,
  };
}

async function verifyRun(runId, store, runtimeOptions = {}) {
  const commands = applyCommandPolicy(
    buildVerificationCommands(runtimeOptions.verification ?? {}),
    runtimeOptions.policy
  );
  const cwd = runtimeOptions.verification?.cwd ?? runtimeOptions.workspace?.cwd ?? process.cwd();
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  await store.updateRecord(
    runId,
    (record) => {
      if (!canVerifyRun(record.status)) {
        throw conflictError(
          `Run ${runId} cannot be verified from ${record.status} status.`
        );
      }

      record.status = RUN_STATUS.verifying;
      record.events.push({
        type: "verification.started",
        timestamp: startedAt,
        commandCount: Array.isArray(commands) ? commands.length : 0,
      });
      return record;
    },
    { now: new Date(startedAt) }
  );

  const result = await runVerificationCommands({ commands, cwd });
  const commandVerification = {
    runId,
    name: "verification",
    ...result,
  };
  const latestRecord = await store.readRecord(runId);
  const acceptance = reviewTaskAcceptance({
    tasks: latestRecord.plan.tasks,
    workerAttempts: latestRecord.workerAttempts,
  });
  const preliminaryVerification = {
    ...commandVerification,
    status: combineVerificationStatus(commandVerification.status, acceptance.status),
    message: verificationMessageForStatus(
      combineVerificationStatus(commandVerification.status, acceptance.status),
      commandVerification.message
    ),
    acceptance,
  };
  const supervisorReview = await runSupervisorReview({
    record: latestRecord,
    verification: preliminaryVerification,
    config: {
      ...(runtimeOptions.verification?.final_review ?? {}),
      generate: async (request) =>
        generateSupervisorModelResponse({
          runId,
          request,
          store,
          runtimeOptions,
        }),
    },
  });
  let verification = {
    ...preliminaryVerification,
    status: combineVerificationStatus(preliminaryVerification.status, supervisorReview.status),
    message: verificationMessageForStatus(
      combineVerificationStatus(preliminaryVerification.status, supervisorReview.status),
      preliminaryVerification.message
    ),
    supervisorReview,
    supervisor_review: supervisorReview,
  };
  verification = {
    ...verification,
    escalation: evaluateVerificationEscalation({
      record: latestRecord,
      verification,
    }),
  };
  const finishedAtMs = Date.now();
  const finishedAt = new Date(finishedAtMs);
  verification = {
    ...verification,
    startedAt,
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAtMs - startedAtMs,
  };
  verification = redactSecrets(verification, runtimeOptions.policy);

  await store.updateRecord(
    runId,
    (record) => {
      const statusBeforeVerificationFinish = record.status;
      if (record.status === RUN_STATUS.verifying) {
        record.status = runStatusForVerification(verification.status);
      }
      record.verification.push(verification);
      if (verification.escalation.required) {
        record.events.push({
          type: "verification.escalation.required",
          timestamp: verification.finishedAt,
          reason: verification.escalation.reason,
          targetTier: verification.escalation.targetTier,
          target_tier: verification.escalation.target_tier,
        });
      }
      record.events.push({
        type: "verification.finished",
        timestamp: verification.finishedAt,
        status: verification.status,
        message: verification.message,
        commandCount: verification.commands.length,
        runStatusBeforeFinish: statusBeforeVerificationFinish,
        runStatusAfterFinish: record.status,
      });
      return record;
    },
    { now: finishedAt }
  );

  return verification;
}

function evaluateVerificationEscalation({ record, verification }) {
  if (verification.status !== "failed") {
    return {
      required: false,
      reason: "verification_not_failed",
      fromTiers: [],
      from_tiers: [],
      targetTier: null,
      target_tier: null,
    };
  }

  const taskById = new Map(
    (record.plan?.tasks ?? []).map((task) => [task.task_id ?? task.id, task])
  );
  const fromTiers = [
    ...new Set(
      (record.workerAttempts ?? [])
        .filter((attempt) => ["failed", "applied", "recorded"].includes(attempt.status))
        .map((attempt) => {
          const taskId = attempt.task_id ?? attempt.taskId;
          const task = taskById.get(taskId);
          return task?.model_tier ?? task?.modelTier;
        })
        .filter((tier) => tier === "cheap" || tier === "standard")
    ),
  ].sort();
  const required = fromTiers.length > 0;

  return {
    required,
    reason: required
      ? "verification_failed_after_non_premium_worker"
      : "no_non_premium_worker_attempt",
    fromTiers,
    from_tiers: fromTiers,
    targetTier: required ? "premium" : null,
    target_tier: required ? "premium" : null,
  };
}

async function generateSupervisorModelResponse({ runId, request, store, runtimeOptions = {} }) {
  const startedAt = Date.now();
  let response;

  try {
    response = await generateModelResponse(request, {
      providers: runtimeOptions.providers,
    });
  } catch (error) {
    const failure = redactSecrets(
      modelGenerationFailure(request, error, startedAt, runtimeOptions),
      runtimeOptions.policy
    );
    await store.recordModelCallFailure(runId, {
      provider: failure.provider,
      model: failure.model,
      usage: failure.usage,
      costEstimate: failure.costEstimate,
      cost_estimate: failure.cost_estimate,
      finishReason: failure.finishReason,
      finish_reason: failure.finish_reason,
      request: failure.request,
      error: failure.error,
    });
    return failure;
  }

  response = redactSecrets(response, runtimeOptions.policy);
  await store.recordModelCall(runId, {
    provider: response.provider,
    model: response.model,
    usage: response.usage,
    costEstimate: response.costEstimate,
    cost_estimate: response.cost_estimate,
    finishReason: response.finishReason,
    finish_reason: response.finish_reason,
    request: response.request,
  });

  return response;
}

function combineVerificationStatus(...statuses) {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("passed")) return "passed";
  return "skipped";
}

function verificationMessageForStatus(status, fallback) {
  if (status === "failed") return "Verification failed.";
  if (status === "passed") return "Verification evidence passed.";
  return fallback ?? "No verification evidence recorded.";
}

function runStatusForVerification(status) {
  if (status === "passed") {
    return RUN_STATUS.verificationPassed;
  }

  if (status === "failed") {
    return RUN_STATUS.verificationFailed;
  }

  return RUN_STATUS.verificationSkipped;
}

async function reportRun(runId, args, store, runtimeOptions = {}) {
  const record = await store.readRecord(runId);
  const historyRecords =
    typeof store.listRecords === "function" ? await store.listRecords() : [];
  const report = createReport(record, { historyRecords, policy: runtimeOptions.policy });

  if (args?.format === "markdown") {
    return {
      runId,
      format: "markdown",
      markdown: formatReportMarkdown(report),
    };
  }

  return report;
}

async function auditRun(runId, store, runtimeOptions = {}) {
  const record = await store.readRecord(runId);
  const historyRecords =
    typeof store.listRecords === "function" ? await store.listRecords() : [];
  const report = createReport(record, { historyRecords, policy: runtimeOptions.policy });
  return createAuditExport(record, { report, policy: runtimeOptions.policy });
}

async function cancelRun(runId, args, store) {
  const reason = args?.reason ?? "canceled by user";
  const record = await store.updateRecord(runId, (current) => {
    current.status = "canceled";
    current.events.push({
      type: "run.canceled",
      timestamp: new Date().toISOString(),
      reason,
    });
    return current;
  });

  return summarizeRecord(record);
}

async function approveRun(runId, args, store) {
  const approvedAt = new Date().toISOString();
  const approvedBy = args?.approvedBy ?? "unknown";
  const note = args?.note ?? "approved";
  const record = await store.updateRecord(runId, (current) => {
    if (current.status !== "approval_required") {
      throw conflictError(`Run ${runId} must be in approval_required status before approval.`);
    }

    if (current.plan.approval?.required !== true) {
      throw conflictError(`Run ${runId} does not require human approval.`);
    }

    current.status = "approved";
    current.plan.approval = {
      ...current.plan.approval,
      status: "approved",
      approvedBy,
      approvedAt,
      note,
    };
    current.plan.planReport = current.plan.planReport
      ? {
          ...current.plan.planReport,
          approval: current.plan.approval,
        }
      : current.plan.planReport;
    current.plan.plan_report = current.plan.plan_report
      ? {
          ...current.plan.plan_report,
          approval: current.plan.approval,
        }
      : current.plan.plan_report;
    current.events.push({
      type: "approval.approved",
      timestamp: approvedAt,
      approvedBy,
      note,
    });
    return current;
  });

  return summarizeRecord(record);
}

function providerHealth(args = {}, runtimeOptions = {}) {
  return checkProviderHealth({
    provider: args.provider,
    providers: runtimeOptions.providers,
  });
}

async function modelGenerate(args = {}, store, runtimeOptions = {}) {
  if (args.runId) {
    if (!store?.recordModelCall || !store?.recordModelCallFailure) {
      throw new Error("runtime_model_generate requires a store when runId is provided.");
    }
  }

  const startedAt = Date.now();
  const providerArgs = modelProviderArgs(args);
  let response;

  try {
    response = await generateModelResponse(providerArgs, {
      providers: runtimeOptions.providers,
    });
  } catch (error) {
    if (!args.runId) {
      throw error;
    }

    const failure = redactSecrets(
      withModelTraceMetadata(modelGenerationFailure(providerArgs, error, startedAt, runtimeOptions), args),
      runtimeOptions.policy
    );
    await store.recordModelCallFailure(args.runId, {
      provider: failure.provider,
      model: failure.model,
      usage: failure.usage,
      costEstimate: failure.costEstimate,
      cost_estimate: failure.cost_estimate,
      finishReason: failure.finishReason,
      finish_reason: failure.finish_reason,
      request: failure.request,
      error: failure.error,
    });
    return failure;
  }

  response = redactSecrets(withModelTraceMetadata(response, args), runtimeOptions.policy);

  if (args.runId) {
    await store.recordModelCall(args.runId, {
      provider: response.provider,
      model: response.model,
      usage: response.usage,
      costEstimate: response.costEstimate,
      cost_estimate: response.cost_estimate,
      finishReason: response.finishReason,
      finish_reason: response.finish_reason,
      request: response.request,
    });
  }

  return response;
}

function modelGenerationFailure(args, error, startedAt, runtimeOptions = {}) {
  const provider = error.provider ?? args.provider ?? runtimeOptions.providers?.defaultProvider ?? null;
  const model = args.model ?? (provider ? runtimeOptions.providers?.entries?.[provider]?.defaultModel : null) ?? null;
  const durationMs = Date.now() - startedAt;
  const attempts = Number.isFinite(error.attempts) ? error.attempts : 0;
  const costEstimate = {
    currency: "USD",
    estimatedCost: 0,
    estimated_cost: 0,
    source: "provider-error",
  };

  return {
    ok: false,
    status: "failed",
    provider,
    model,
    text: "",
    structuredOutput: null,
    structured_output: null,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    costEstimate,
    cost_estimate: costEstimate,
    finishReason: "error",
    finish_reason: "error",
    raw: null,
    request: {
      attempts,
      durationMs,
      duration_ms: durationMs,
    },
    error: serializeModelGenerationError(error),
  };
}

function serializeModelGenerationError(error) {
  return {
    code: error.code ?? "provider.error",
    message: error.message ?? String(error),
    provider: error.provider ?? null,
    statusCode: error.statusCode ?? null,
    status_code: error.statusCode ?? null,
    retryable: error.retryable === true,
  };
}

function conflictError(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

function summarizeRecord(record) {
  return {
    runId: record.runId,
    status: record.status,
    request: record.request,
    taskCount: record.plan.tasks.length,
    eventCount: record.events.length,
    approvalStatus: record.plan.approval?.status ?? "unknown",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function requireRequest(args) {
  if (!args?.request || typeof args.request !== "string" || args.request.trim().length === 0) {
    throw new Error("request is required.");
  }

  return args.request.trim();
}

function requireRunId(args) {
  if (!args?.runId || typeof args.runId !== "string" || args.runId.trim().length === 0) {
    throw new Error("runId is required.");
  }

  return args.runId.trim();
}

function requireTaskId(args) {
  if (!args?.taskId || typeof args.taskId !== "string" || args.taskId.trim().length === 0) {
    throw new Error("taskId is required.");
  }

  return args.taskId.trim();
}

function requestSchema() {
  return {
    type: "object",
    properties: {
      request: { type: "string" },
    },
    required: ["request"],
    additionalProperties: false,
  };
}

function runIdSchema() {
  return {
    type: "object",
    properties: {
      runId: { type: "string" },
    },
    required: ["runId"],
    additionalProperties: false,
  };
}

function verifySchema() {
  return {
    type: "object",
    properties: {
      runId: { type: "string" },
      verification: { type: "object" },
    },
    required: ["runId"],
    additionalProperties: false,
  };
}

function executeSchema() {
  return {
    type: "object",
    properties: {
      runId: { type: "string" },
      apply: { type: "boolean" },
      verify: { type: "boolean" },
    },
    required: ["runId"],
    additionalProperties: false,
  };
}

function withVerificationOverride(runtimeOptions = {}, args = {}) {
  if (!args?.verification || typeof args.verification !== "object" || Array.isArray(args.verification)) {
    return runtimeOptions;
  }

  return {
    ...runtimeOptions,
    verification: mergePlainObjects(runtimeOptions.verification ?? {}, args.verification),
  };
}

function mergePlainObjects(base, override) {
  const result = { ...base };

  for (const [key, value] of Object.entries(override)) {
    result[key] =
      isPlainObject(value) && isPlainObject(result[key])
        ? mergePlainObjects(result[key], value)
        : value;
  }

  return result;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function modelGenerateSchema() {
  return {
    type: "object",
    properties: {
      runId: { type: "string" },
      taskId: { type: "string" },
      task_id: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      prompt: { type: "string" },
      messages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            role: { type: "string" },
            content: {},
          },
          required: ["content"],
          additionalProperties: true,
        },
      },
      tools: { type: "array" },
      responseSchema: { type: "object" },
      temperature: { type: "number" },
      maxTokens: { type: "number" },
      timeoutMs: { type: "number" },
    },
    additionalProperties: false,
  };
}

function modelProviderArgs(args = {}) {
  const { runId: _runId, taskId: _taskId, task_id: _task_id, ...providerArgs } = args;
  return providerArgs;
}

function withModelTraceMetadata(response, args = {}) {
  const taskId = args.taskId ?? args.task_id;
  if (!taskId) return response;

  return {
    ...response,
    request: {
      ...(response.request ?? {}),
      taskId,
      task_id: taskId,
    },
  };
}

function workerResultSchema() {
  return {
    type: "object",
    properties: {
      runId: { type: "string" },
      taskId: { type: "string" },
      apply: { type: "boolean" },
      result: {
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
          acceptance: {
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
        required: [
          "patch",
          "explanation",
          "verificationNotes",
          "confidence",
          "filesTouched",
          "acceptance",
        ],
        additionalProperties: false,
      },
    },
    required: ["runId", "taskId", "result"],
    additionalProperties: false,
  };
}
