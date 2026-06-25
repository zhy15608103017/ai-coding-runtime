export function createRunInspection(record = {}) {
  const plan = record.plan ?? {};
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const workerAttempts = Array.isArray(record.workerAttempts) ? record.workerAttempts : [];
  const modelCalls = Array.isArray(record.modelCalls) ? record.modelCalls : [];
  const events = Array.isArray(record.events) ? record.events : [];
  const latestVerification = latestItem(record.verification);
  const routingTrace = Array.isArray(plan.routingTrace ?? plan.routing_trace)
    ? plan.routingTrace ?? plan.routing_trace
    : [];
  const inspectedTasks = tasks.map((task) =>
    inspectTask({
      task,
      workerAttempts,
      modelCalls,
      routingTrace,
      events,
      latestVerification,
      runStatus: record.status,
    })
  );
  const summary = createSummary({
    tasks: inspectedTasks,
    record,
    latestVerification,
    workerAttempts,
  });
  const verification = inspectVerification(latestVerification);
  const escalation = inspectVerificationEscalation(latestVerification?.escalation);
  const nextActions = createNextActions({
    record,
    tasks: inspectedTasks,
    verification,
    escalation,
  });

  return {
    schemaVersion: "runtime.inspection.v1",
    runId: record.runId,
    run_id: record.runId,
    status: record.status,
    request: record.request,
    createdAt: record.createdAt,
    created_at: record.createdAt,
    updatedAt: record.updatedAt,
    updated_at: record.updatedAt,
    summary,
    tasks: inspectedTasks,
    approval: inspectApproval(plan.approval),
    budget: inspectBudget(plan.budgetStatus ?? plan.budget_status),
    policy: inspectPolicy(plan.policyStatus ?? plan.policy_status),
    verification,
    escalation,
    nextActions,
    next_actions: nextActions,
  };
}

export function formatInspectionMarkdown(inspection = {}) {
  const lines = [
    "# Runtime 运行观察",
    "",
    `运行：${inspection.runId ?? "unknown"}`,
    `状态：${inspection.status ?? "unknown"}`,
    `请求：${inspection.request ?? ""}`,
    "",
    "## 摘要",
    `- 任务：${inspection.summary?.taskCount ?? 0} 个`,
    `- 审批：${inspection.approval?.status ?? "unknown"}${inspection.approval?.required ? "（需要）" : "（不需要）"}`,
    `- 预算：${inspection.budget?.allowed === false ? "不允许" : "允许"}，预计 ${inspection.budget?.currency ?? "USD"} ${inspection.budget?.estimatedCost ?? 0}`,
    `- 最新验证：${inspection.verification?.latestStatus ?? "skipped"}`,
    "",
    "## 模型层级",
    ...formatCounts(inspection.summary?.tierCounts),
    "",
    "## 任务",
    ...formatTasks(inspection.tasks ?? []),
    "",
    "## 验证",
    `- 状态：${inspection.verification?.latestStatus ?? "skipped"}`,
    `- 命令检查：${inspection.verification?.commandStatus ?? "skipped"}`,
    `- 验收检查：${inspection.verification?.acceptanceStatus ?? "skipped"}`,
    `- 最终审查：${inspection.verification?.supervisorStatus ?? "skipped"}`,
    "",
    "## 升级",
    ...formatEscalation(inspection),
    "",
    "## 下一步",
    ...formatNextActions(inspection.nextActions ?? inspection.next_actions ?? []),
  ];

  return `${lines.join("\n")}\n`;
}

function inspectTask({
  task,
  workerAttempts,
  modelCalls,
  routingTrace,
  events,
  latestVerification,
  runStatus,
}) {
  const taskId = task.task_id ?? task.taskId ?? task.id;
  const attempts = workerAttempts.filter((attempt) => attemptTaskId(attempt) === taskId);
  const latestAttempt = latestItem(attempts);
  const route =
    routingTrace.find((candidate) => (candidate.task_id ?? candidate.taskId) === taskId) ??
    task.routing ??
    {};
  const model = normalizeSelectedModel(
    task.routing?.selected_model ??
      task.routing?.selectedModel ??
      route.selected_model ??
      route.selectedModel ??
      task.selected_model ??
      task.selectedModel,
    task.modelTier ?? task.model_tier
  );
  const filesTouched = uniqueStrings(attempts.flatMap((attempt) => touchedFiles(attempt)));
  const acceptance = inspectAcceptance({ task, latestAttempt, latestVerification });
  const escalations = inspectTaskEscalations(events, taskId);
  const calls = modelCalls.filter((call) => modelCallTaskId(call) === taskId);

  return {
    taskId,
    task_id: taskId,
    title: task.title,
    goal: task.goal,
    status: taskStatus({ task, latestAttempt, runStatus }),
    difficulty: task.difficulty,
    risk: task.risk,
    contextNeed: task.contextNeed ?? task.context_need,
    context_need: task.context_need ?? task.contextNeed,
    verification: task.verification,
    modelTier: task.modelTier ?? task.model_tier,
    model_tier: task.model_tier ?? task.modelTier,
    model,
    finalVerification: task.finalVerification === true || task.final_verification === true,
    final_verification: task.final_verification === true || task.finalVerification === true,
    files: {
      allowed: stringArray(task.allowedFiles ?? task.allowed_files),
      referenced: stringArray(task.referencedFiles ?? task.referenced_files),
      touched: filesTouched,
    },
    routing: {
      reason:
        route.reason ??
        route.routingReason ??
        firstString(task.routingReason ?? task.routing_reason) ??
        "",
      reasons: stringArray(
        route.reasons ??
          route.routingReasons ??
          route.routing_reason ??
          task.routingReason ??
          task.routing_reason
      ),
      escalationTriggers: stringArray(
        route.escalation_triggers ??
          route.escalationTriggers ??
          task.routing?.escalation_triggers ??
          task.routing?.escalationTriggers
      ),
      escalation_triggers: stringArray(
        route.escalation_triggers ??
          route.escalationTriggers ??
          task.routing?.escalation_triggers ??
          task.routing?.escalationTriggers
      ),
    },
    worker: {
      attemptCount: attempts.length,
      attempt_count: attempts.length,
      latestStatus: latestAttempt?.status ?? "none",
      latest_status: latestAttempt?.status ?? "none",
      latestAttemptId: latestAttempt?.attemptId ?? latestAttempt?.attempt_id ?? null,
      latest_attempt_id: latestAttempt?.attempt_id ?? latestAttempt?.attemptId ?? null,
      filesTouched,
      files_touched: filesTouched,
      attempts: attempts.map(inspectAttempt),
    },
    acceptance,
    escalations,
    modelUsage: {
      callCount: calls.length,
      call_count: calls.length,
      totalTokens: calls.reduce((total, call) => total + numberOrZero(call.usage?.totalTokens), 0),
      total_tokens: calls.reduce((total, call) => total + numberOrZero(call.usage?.totalTokens), 0),
    },
  };
}

function createSummary({ tasks, record, latestVerification, workerAttempts }) {
  return {
    taskCount: tasks.length,
    task_count: tasks.length,
    taskCountsByStatus: countBy(tasks, "status"),
    task_counts_by_status: countBy(tasks, "status"),
    workerAttemptCountsByStatus: countBy(workerAttempts, "status"),
    worker_attempt_counts_by_status: countBy(workerAttempts, "status"),
    tierCounts: countBy(tasks, "modelTier"),
    tier_counts: countBy(tasks, "modelTier"),
    approvalRequired: record.plan?.approval?.required === true,
    approval_required: record.plan?.approval?.required === true,
    latestVerificationStatus: latestVerification?.status ?? "skipped",
    latest_verification_status: latestVerification?.status ?? "skipped",
  };
}

function inspectAcceptance({ task, latestAttempt, latestVerification }) {
  const taskId = task.task_id ?? task.id;
  const verificationTask = (latestVerification?.acceptance?.tasks ?? []).find(
    (candidate) => (candidate.task_id ?? candidate.taskId) === taskId
  );

  if (verificationTask) {
    const items = (verificationTask.items ?? []).map((item) => ({
      criterion: item.criterion,
      status: item.status ?? "skipped",
      evidence: item.evidence ?? "",
    }));
    return summarizeAcceptanceItems(verificationTask.status ?? summarizeItems(items), items);
  }

  const criteria = stringArray(task.acceptance);
  if (latestAttempt?.acceptance && criteria.length > 0) {
    const items = criteria.map((criterion) => {
      const evidence = latestAttempt.acceptance?.[criterion];
      return {
        criterion,
        status: typeof evidence === "string" && evidence.trim() ? "passed" : "failed",
        evidence: typeof evidence === "string" ? evidence : "",
      };
    });
    return summarizeAcceptanceItems(summarizeItems(items), items);
  }

  const items = criteria.map((criterion) => ({
    criterion,
    status: "skipped",
    evidence: "",
  }));
  return summarizeAcceptanceItems("skipped", items);
}

function summarizeAcceptanceItems(status, items) {
  return {
    status,
    total: items.length,
    passed: items.filter((item) => item.status === "passed").length,
    failed: items.filter((item) => item.status === "failed").length,
    skipped: items.filter((item) => item.status === "skipped").length,
    items,
  };
}

function inspectVerification(verification) {
  const supervisor = verification?.supervisorReview ?? verification?.supervisor_review;
  return {
    latestStatus: verification?.status ?? "skipped",
    latest_status: verification?.status ?? "skipped",
    message: verification?.message ?? "",
    commandStatus: summarizeCommandStatus(verification?.commands ?? []),
    command_status: summarizeCommandStatus(verification?.commands ?? []),
    acceptanceStatus: verification?.acceptance?.status ?? "skipped",
    acceptance_status: verification?.acceptance?.status ?? "skipped",
    supervisorStatus: supervisor?.status ?? "skipped",
    supervisor_status: supervisor?.status ?? "skipped",
    commands: (verification?.commands ?? []).map((command) => ({
      name: command.name,
      status: command.status,
      required: command.required === true,
      exitCode: command.exitCode,
      exit_code: command.exitCode,
      durationMs: command.durationMs,
      duration_ms: command.durationMs,
    })),
    supervisorReview: supervisor ?? null,
    supervisor_review: supervisor ?? null,
  };
}

function inspectVerificationEscalation(escalation) {
  return {
    required: escalation?.required === true,
    reason: escalation?.reason ?? "none",
    fromTiers: stringArray(escalation?.fromTiers ?? escalation?.from_tiers),
    from_tiers: stringArray(escalation?.from_tiers ?? escalation?.fromTiers),
    targetTier: escalation?.targetTier ?? escalation?.target_tier ?? null,
    target_tier: escalation?.target_tier ?? escalation?.targetTier ?? null,
  };
}

function inspectTaskEscalations(events, taskId) {
  return events
    .filter(
      (event) =>
        event.type === "task.execution.escalated" &&
        (event.taskId ?? event.task_id) === taskId
    )
    .map((event) => ({
      fromTier: event.fromTier ?? event.from_tier ?? null,
      from_tier: event.from_tier ?? event.fromTier ?? null,
      toTier: event.toTier ?? event.to_tier ?? null,
      to_tier: event.to_tier ?? event.toTier ?? null,
      fromModel: event.fromModel ?? event.from_model ?? null,
      from_model: event.from_model ?? event.fromModel ?? null,
      toModel: event.toModel ?? event.to_model ?? null,
      to_model: event.to_model ?? event.toModel ?? null,
      reason: event.reason ?? "unknown",
      attempt: event.attempt ?? null,
    }));
}

function inspectApproval(approval = {}) {
  return {
    required: approval.required === true,
    status: approval.status ?? "unknown",
    reasons: approval.reasons ?? [],
    approvedBy: approval.approvedBy ?? approval.approved_by ?? null,
    approved_by: approval.approved_by ?? approval.approvedBy ?? null,
    approvedAt: approval.approvedAt ?? approval.approved_at ?? null,
    approved_at: approval.approved_at ?? approval.approvedAt ?? null,
  };
}

function inspectBudget(budget = {}) {
  return {
    allowed: budget.allowed !== false,
    currency: budget.currency ?? "USD",
    estimatedCost: budget.estimatedCost ?? budget.estimated_cost ?? 0,
    estimated_cost: budget.estimated_cost ?? budget.estimatedCost ?? 0,
    estimatedCalls: budget.estimatedCalls ?? budget.estimated_calls ?? 0,
    estimated_calls: budget.estimated_calls ?? budget.estimatedCalls ?? 0,
    estimatedRetries: budget.estimatedRetries ?? budget.estimated_retries ?? 0,
    estimated_retries: budget.estimated_retries ?? budget.estimatedRetries ?? 0,
    violations: budget.violations ?? [],
  };
}

function inspectPolicy(policy = {}) {
  return {
    allowed: policy.allowed !== false,
    violations: policy.violations ?? [],
  };
}

function createNextActions({ record, tasks, verification, escalation }) {
  const actions = [];

  if (record.plan?.approval?.required === true && record.plan?.approval?.status !== "approved") {
    actions.push({
      code: "approval_required",
      message: "需要先审批这个 run，然后才能执行会修改文件的任务。",
    });
  }

  if (verification.latestStatus === "failed") {
    actions.push({
      code: "fix_verification",
      message: "验证失败，需要先查看失败命令、验收或最终审查信息。",
    });
  }

  if (escalation.required) {
    actions.push({
      code: "escalation_required",
      message: `验证失败后建议升级到 ${escalation.targetTier ?? "更高"} 层级处理。`,
    });
  }

  if (tasks.some((task) => task.status === "failed")) {
    actions.push({
      code: "inspect_failed_task",
      message: "存在失败的 worker 尝试，需要查看对应任务的失败原因和验收证据。",
    });
  }

  if (
    actions.length === 0 &&
    ["planned", "approved", "verification_failed", "verification_skipped"].includes(record.status)
  ) {
    actions.push({
      code: "execute_ready",
      message: "当前 run 可以继续执行或重新执行可用任务。",
    });
  }

  if (actions.length === 0) {
    actions.push({
      code: "no_action",
      message: "当前没有需要立即处理的下一步。",
    });
  }

  return actions;
}

function taskStatus({ task, latestAttempt, runStatus }) {
  if (latestAttempt?.status) return latestAttempt.status;
  if (task.finalVerification === true || task.final_verification === true) return "final_review";
  const allowedFiles = task.allowedFiles ?? task.allowed_files ?? [];
  if (!Array.isArray(allowedFiles) || allowedFiles.length === 0) return "read_only";
  if (runStatus === "approval_required") return "blocked";
  return "pending";
}

function inspectAttempt(attempt) {
  return {
    attemptId: attempt.attemptId ?? attempt.attempt_id,
    attempt_id: attempt.attempt_id ?? attempt.attemptId,
    status: attempt.status,
    applied: attempt.applied === true,
    confidence: attempt.confidence ?? null,
    filesTouched: touchedFiles(attempt),
    files_touched: touchedFiles(attempt),
    error: attempt.error ?? attempt.validation?.errors?.[0] ?? null,
  };
}

function normalizeSelectedModel(value, fallbackTier = null) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      provider: value.provider ?? null,
      model: value.model ?? value.id ?? null,
      tier: value.tier ?? fallbackTier ?? null,
    };
  }

  if (typeof value === "string") {
    return {
      provider: null,
      model: value,
      tier: fallbackTier ?? null,
    };
  }

  return {
    provider: null,
    model: null,
    tier: fallbackTier ?? null,
  };
}

function formatTasks(tasks) {
  if (tasks.length === 0) return ["- 无任务"];

  return tasks.flatMap((task) => {
    const lines = [
      `### ${task.taskId} ${task.title}`,
      `- 状态：${task.status}`,
      `- 难度/风险：${task.difficulty} / ${task.risk}`,
      `- 模型层级：${task.modelTier}`,
      `- 模型：${formatModel(task.model)}`,
      `- 路由原因：${task.routing?.reason || "未记录"}`,
      `- Worker：${task.worker?.attemptCount ?? 0} 次，最新状态 ${task.worker?.latestStatus ?? "none"}`,
      `- 验收：${task.acceptance?.status ?? "skipped"}（通过 ${task.acceptance?.passed ?? 0}/${task.acceptance?.total ?? 0}）`,
      `- 允许文件：${formatFileList(task.files?.allowed)}`,
      `- 引用文件：${formatFileList(task.files?.referenced)}`,
      `- 触达文件：${formatFileList(task.files?.touched)}`,
    ];
    const failureReason = latestFailureReason(task.worker?.attempts ?? []);
    if (failureReason) {
      lines.push(`- 失败原因：${failureReason}`);
    }
    const acceptanceEvidence = formatAcceptanceEvidence(task.acceptance?.items ?? []);
    if (acceptanceEvidence) {
      lines.push(`- 验收证据：${acceptanceEvidence}`);
    }
    for (const escalation of task.escalations ?? []) {
      lines.push(
        `- 升级：${escalation.fromTier ?? "unknown"} -> ${escalation.toTier ?? "unknown"}，模型 ${formatEscalationModelChange(escalation)}，原因 ${escalation.reason}`
      );
    }
    return [...lines, ""];
  });
}

function formatFileList(files) {
  return Array.isArray(files) && files.length > 0 ? files.join(", ") : "未记录";
}

function latestFailureReason(attempts) {
  const failed = [...attempts]
    .reverse()
    .find((attempt) => attempt?.error?.code || attempt?.error?.message || attempt?.status === "failed");
  if (!failed) return "";
  const code = failed.error?.code;
  const message = failed.error?.message;
  if (code && message) return `${code}：${message}`;
  return code ?? message ?? failed.status;
}

function formatAcceptanceEvidence(items) {
  const evidenceItems = items.filter((item) => item?.evidence);
  if (evidenceItems.length === 0) return "";
  return evidenceItems
    .map((item) => {
      const criterion = item.criterion ?? "未命名验收项";
      const status = item.status ?? "unknown";
      return `${criterion}=${status}：${item.evidence}`;
    })
    .join("；");
}

function formatEscalationModelChange(escalation) {
  const fromModel = escalation.fromModel ?? escalation.from_model ?? "unknown";
  const toModel = escalation.toModel ?? escalation.to_model ?? "unknown";
  return `${fromModel} -> ${toModel}`;
}

function formatCounts(counts = {}) {
  const entries = Object.entries(counts);
  if (entries.length === 0) return ["- 无记录"];
  return entries.map(([key, count]) => `- ${key}: ${count}`);
}

function formatEscalation(inspection) {
  const taskEscalations = (inspection.tasks ?? []).flatMap((task) =>
    (task.escalations ?? []).map(
      (escalation) =>
        `- ${task.taskId}: ${escalation.fromTier ?? "unknown"} -> ${escalation.toTier ?? "unknown"}，模型 ${formatEscalationModelChange(escalation)}，原因 ${escalation.reason}`
    )
  );
  const verificationEscalation =
    inspection.escalation?.required === true
      ? [
          `- 验证升级：需要，目标层级 ${inspection.escalation.targetTier ?? "unknown"}，原因 ${inspection.escalation.reason}`,
        ]
      : [];
  const lines = [...taskEscalations, ...verificationEscalation];
  return lines.length ? lines : ["- 未记录升级"];
}

function formatNextActions(actions) {
  if (actions.length === 0) return ["- 无"];
  return actions.map((action) => `- ${action.message}`);
}

function formatModel(model) {
  if (!model) return "未记录";
  const provider = model.provider ? `${model.provider}/` : "";
  return `${provider}${model.model ?? "unknown"}${model.tier ? ` (${model.tier})` : ""}`;
}

function summarizeCommandStatus(commands) {
  if (!Array.isArray(commands) || commands.length === 0) return "skipped";
  if (commands.some((command) => command.required && command.status !== "passed")) return "failed";
  return "passed";
}

function summarizeItems(items) {
  if (items.length === 0) return "skipped";
  return items.every((item) => item.status === "passed") ? "passed" : "failed";
}

function latestItem(items) {
  return Array.isArray(items) && items.length > 0 ? items.at(-1) : null;
}

function attemptTaskId(attempt) {
  return attempt.taskId ?? attempt.task_id;
}

function modelCallTaskId(call) {
  return call.taskId ?? call.task_id ?? call.request?.taskId ?? call.request?.task_id;
}

function touchedFiles(attempt) {
  return stringArray(attempt.filesTouched ?? attempt.files_touched);
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.length > 0)
    : [];
}

function firstString(value) {
  return stringArray(value)[0] ?? (typeof value === "string" ? value : null);
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function countBy(items, field) {
  return items.reduce((counts, item) => {
    const value = item[field] ?? "unknown";
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function numberOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}
