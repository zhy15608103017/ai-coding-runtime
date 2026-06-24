import { redactSecrets } from "./policy.js";
import { createLearningProfile } from "./learning.js";
import { isOutcomeExcludedStatus } from "./status.js";

export function createReport(record, { historyRecords = [], policy = record.plan?.policyConfig } = {}) {
  const tasks = record.plan.tasks;
  const modelCalls = Array.isArray(record.modelCalls) ? record.modelCalls : [];
  const workerAttempts = Array.isArray(record.workerAttempts) ? record.workerAttempts : [];
  const verification = Array.isArray(record.verification) ? record.verification : [];
  const latestVerification = verification.at(-1);
  const routingTrace = Array.isArray(record.plan.routingTrace) ? record.plan.routingTrace : [];
  const tierCounts = tasks.reduce((counts, task) => {
    counts[task.modelTier] = (counts[task.modelTier] ?? 0) + 1;
    return counts;
  }, {});
  const changedFiles = unique(
    workerAttempts
      .filter((attempt) => attempt.applied === true)
      .flatMap((attempt) => touchedFiles(attempt))
  );
  const workerTouchedFiles = unique(workerAttempts.flatMap((attempt) => touchedFiles(attempt)));
  const modelCostTotal = sumModelCallCost(modelCalls);
  const costReport = createCostReport({ record, tasks, routingTrace, modelCalls });
  const failureAnalysis = createFailureAnalysis(record);
  const followUpRecommendations = createFollowUpRecommendations({
    record,
    latestVerification,
    failureAnalysis,
  });
  const modelReliability = createModelReliabilityMetrics([record, ...historyRecords]);
  const learningProfile = safeCreateLearningProfile([record, ...historyRecords], { policy });
  const finalReport = {
    summary: `Planned ${tasks.length} task(s) for runtime execution.`,
    changedFiles,
    taskGraph: summarizeTasks(tasks),
    modelRouting: tierCounts,
    costEstimate: costReport.summary,
    verification: summarizeVerification(latestVerification),
    risks: createRiskSummary(record),
    followUpRecommendations,
  };

  const report = {
    runId: record.runId,
    status: record.status,
    request: record.request,
    summary: finalReport.summary,
    finalReport,
    changedFiles,
    taskGraph: summarizeTasks(tasks),
    taskGraphSchema: record.plan.taskGraph,
    approval: record.plan.approval,
    validation: record.plan.validation,
    planReport: record.plan.planReport,
    planningPrompt: record.plan.planningPrompt,
    modelRouting: tierCounts,
    modelRegistry: record.plan.modelRegistry,
    modelTierAliases: record.plan.modelTierAliases,
    routingPolicy: record.plan.routingPolicy,
    budgetPolicy: record.plan.budgetPolicy,
    escalationPolicy: record.plan.escalationPolicy,
    budgetStatus: record.plan.budgetStatus,
    policyStatus: record.plan.policyStatus,
    routingTrace,
    routingDecisions: createRoutingDecisions(routingTrace),
    escalationDecisions: createEscalationDecisions(verification),
    modelCalls,
    workerAttempts,
    workerSummary: {
      attemptCount: workerAttempts.length,
      appliedCount: workerAttempts.filter((attempt) => attempt.applied === true).length,
      filesTouched: workerTouchedFiles,
    },
    modelUsage: {
      callCount: modelCalls.length,
      estimatedCost: roundCost(modelCostTotal),
      currency: modelCalls[0]?.costEstimate?.currency ?? modelCalls[0]?.cost_estimate?.currency ?? "USD",
    },
    perTaskModelUsage: costReport.perTask,
    costReport,
    estimatedCost: record.plan.estimatedCost,
    verification,
    verificationSummary: {
      latestStatus: latestVerification?.status ?? "skipped",
      commandStatus: summarizeCommandStatus(latestVerification?.commands ?? []),
      acceptanceStatus: latestVerification?.acceptance?.status ?? "skipped",
      supervisorStatus:
        latestVerification?.supervisorReview?.status ??
        latestVerification?.supervisor_review?.status ??
        "skipped",
      escalationRequired: latestVerification?.escalation?.required === true,
    },
    failureAnalysis,
    modelReliability,
    learningProfile,
    learning_profile: learningProfile,
    traceViewerData: createTraceViewerData(record),
    exportFormat: {
      schema: "ai-coding-runtime.report",
      version: 1,
      generatedAt: new Date().toISOString(),
      formats: ["json", "markdown"],
      sections: [
        "summary",
        "changed_files",
        "task_graph",
        "model_routing",
        "cost_estimate",
        "verification",
        "risks",
        "follow_up_recommendations",
        "trace_viewer_data",
        "model_reliability",
        "learning_profile",
        "failure_analysis",
      ],
    },
    events: record.events,
  };
  return redactSecrets(report, policy);
}

export function formatReportMarkdown(report) {
  const lines = [
    `# AI Coding Runtime Report`,
    ``,
    `Run: ${report.runId}`,
    `Status: ${report.status}`,
    ``,
    `## Request`,
    report.request,
    ``,
    `## Summary`,
    report.summary,
    ``,
    `## Changed Files`,
    ...(report.changedFiles?.length ? report.changedFiles.map((file) => `- ${file}`) : ["- none"]),
    ``,
    `## Model Routing`,
    ...Object.entries(report.modelRouting).map(([tier, count]) => `- ${tier}: ${count}`),
    ``,
    `## Cost Estimate`,
    `- planned routing cost: ${report.costReport?.summary.currency ?? "USD"} ${report.costReport?.summary.plannedRoutingCost ?? 0}`,
    `- provider cost: ${report.costReport?.summary.currency ?? "USD"} ${report.costReport?.summary.providerCost ?? 0}`,
    `- unattributed provider cost: ${report.costReport?.summary.currency ?? "USD"} ${report.costReport?.summary.unattributedProviderCost ?? 0}`,
    `- total visible cost: ${report.costReport?.summary.currency ?? "USD"} ${report.costReport?.summary.totalVisibleCost ?? 0}`,
    ``,
    `## Budget`,
    `- allowed: ${report.budgetStatus?.allowed ?? "unknown"}`,
    `- estimated cost: ${report.budgetStatus?.currency ?? "USD"} ${report.budgetStatus?.estimatedCost ?? 0}`,
    `- estimated calls: ${report.budgetStatus?.estimatedCalls ?? 0}`,
    `- reserved retries: ${report.budgetStatus?.estimatedRetries ?? 0}`,
    ...(report.budgetStatus?.violations?.length
      ? report.budgetStatus.violations.map((violation) => `- violation: ${violation.code}`)
      : ["- violations: none"]),
    ``,
    `## Policy`,
    `- allowed: ${report.policyStatus?.allowed ?? "unknown"}`,
    ...(report.policyStatus?.violations?.length
      ? report.policyStatus.violations.map((violation) => `- violation: ${violation.code}`)
      : ["- violations: none"]),
    ``,
    `## Routing Trace`,
    ...(report.routingDecisions?.length
      ? report.routingDecisions.map(
          (route) =>
            `- ${route.taskId}: ${route.modelTier} (${route.reason}; selected: ${route.selectedModel ?? "none"})`
        )
      : ["- skipped: no routing trace recorded."]),
    ``,
    `## Per-Task Model Usage`,
    ...(report.perTaskModelUsage?.length
      ? report.perTaskModelUsage.map(
          (task) =>
            `- ${task.taskId}: ${task.modelTier}/${task.selectedModel ?? "none"} planned ${task.currency} ${task.estimatedCost}, actual ${task.currency} ${task.actualCost}`
        )
      : ["- none recorded"]),
    ``,
    `## Model Calls`,
    `- calls: ${report.modelUsage?.callCount ?? 0}`,
    `- estimated provider cost: ${report.modelUsage?.currency ?? "USD"} ${report.modelUsage?.estimatedCost ?? 0}`,
    ...(report.modelCalls?.length
      ? report.modelCalls.map(
          (call) => {
            const cost = getModelCallCostEstimate(call);
            return `- ${call.provider}/${call.model}: ${call.usage?.totalTokens ?? 0} tokens, ${cost.currency} ${cost.estimatedCost}`;
          }
        )
      : ["- none recorded"]),
    ``,
    `## Worker Attempts`,
    `- attempts: ${report.workerSummary?.attemptCount ?? 0}`,
    `- applied: ${report.workerSummary?.appliedCount ?? 0}`,
    ...(report.workerAttempts?.length
      ? report.workerAttempts.map(
          (attempt) =>
            `- ${attempt.taskId ?? attempt.task_id}: ${attempt.status} (${touchedFiles(attempt).join(", ") || "no files"})`
        )
      : ["- none recorded"]),
    ``,
    `## Approval`,
    `- status: ${report.approval?.status ?? "unknown"}`,
    `- required: ${report.approval?.required ?? false}`,
    ``,
    `## Task Graph`,
    ...report.taskGraph.map(
      (task) =>
        `- ${task.id}: ${task.title} (${task.difficulty}, ${task.risk}, ${task.modelTier})`
    ),
    ``,
    `## Verification`,
    formatVerificationMarkdown(report.verification),
    ``,
    `## Risks`,
    ...(report.finalReport?.risks?.length
      ? report.finalReport.risks.map((risk) => `- ${risk}`)
      : ["- none recorded"]),
    ``,
    `## Failure Analysis`,
    ...formatFailureAnalysis(report.failureAnalysis),
    ``,
    `## Model Reliability`,
    ...formatModelReliability(report.modelReliability),
    ``,
    `## Learning`,
    ...formatLearningProfile(report.learningProfile),
    ``,
    `## Follow-Up Recommendations`,
    ...(report.finalReport?.followUpRecommendations?.length
      ? report.finalReport.followUpRecommendations.map((item) => `- ${item}`)
      : ["- none"]),
  ];

  return `${lines.join("\n")}\n`;
}

function summarizeTasks(tasks) {
  return tasks.map((task) => ({
    id: task.id,
    task_id: task.task_id,
    title: task.title,
    dependsOn: task.dependsOn,
    depends_on: task.depends_on,
    modelTier: task.modelTier,
    model_tier: task.model_tier,
    risk: task.risk,
    difficulty: task.difficulty,
    routingReason: task.routingReason,
    routing_reason: task.routing_reason,
  }));
}

function createCostReport({ record, tasks, routingTrace, modelCalls }) {
  const currency = record.plan.estimatedCost?.currency ?? "USD";
  const routeByTask = new Map(routingTrace.map((route) => [route.task_id, route]));
  const taskIds = new Set(tasks.map((task) => task.task_id ?? task.id));
  const plannedRoutingCost = numberOrZero(record.plan.estimatedCost?.estimatedCost);
  const providerCost = sumModelCallCost(modelCalls);
  const unattributedModelCalls = modelCalls.filter((call) => {
    const taskId = getModelCallTaskId(call);
    return !taskId || !taskIds.has(taskId);
  });
  const unattributedProviderCost = sumModelCallCost(unattributedModelCalls);
  const perTask = tasks.map((task) => {
    const taskId = task.task_id ?? task.id;
    const route = routeByTask.get(taskId);
    const taskCalls = modelCalls.filter((call) => getModelCallTaskId(call) === taskId);
    const actualCost = sumModelCallCost(taskCalls);

    return {
      taskId,
      task_id: taskId,
      title: task.title,
      taskType: task.difficulty,
      task_type: task.difficulty,
      modelTier: task.modelTier ?? route?.model_tier,
      model_tier: task.model_tier ?? route?.model_tier,
      selectedModel: route?.selected_model ?? null,
      selected_model: route?.selected_model ?? null,
      routingReason: task.routingReason ?? route?.reason ?? null,
      routing_reason: task.routing_reason ?? route?.reason ?? null,
      estimatedCost: numberOrZero(route?.cost_hint?.estimated_usd_per_call),
      estimated_cost: numberOrZero(route?.cost_hint?.estimated_usd_per_call),
      actualCost: roundCost(actualCost),
      actual_cost: roundCost(actualCost),
      currency,
      callCount: taskCalls.length,
      call_count: taskCalls.length,
    };
  });
  const byTier = perTask.reduce((tiers, task) => {
    const tier = task.modelTier ?? "unknown";
    const current = tiers[tier] ?? {
      tier,
      taskCount: 0,
      task_count: 0,
      estimatedCost: 0,
      estimated_cost: 0,
      actualCost: 0,
      actual_cost: 0,
      currency,
    };

    current.taskCount += 1;
    current.task_count = current.taskCount;
    current.estimatedCost = roundCost(current.estimatedCost + task.estimatedCost);
    current.estimated_cost = current.estimatedCost;
    current.actualCost = roundCost(current.actualCost + task.actualCost);
    current.actual_cost = current.actualCost;
    tiers[tier] = current;
    return tiers;
  }, {});

  return {
    summary: {
      plannedRoutingCost: roundCost(plannedRoutingCost),
      planned_routing_cost: roundCost(plannedRoutingCost),
      providerCost: roundCost(providerCost),
      provider_cost: roundCost(providerCost),
      unattributedProviderCost: roundCost(unattributedProviderCost),
      unattributed_provider_cost: roundCost(unattributedProviderCost),
      totalVisibleCost: roundCost(plannedRoutingCost + providerCost),
      total_visible_cost: roundCost(plannedRoutingCost + providerCost),
      currency,
    },
    perTask,
    per_task: perTask,
    byTier: Object.values(byTier),
    by_tier: Object.values(byTier),
    modelCalls: modelCalls.map((call) => ({
      provider: call.provider,
      model: call.model,
      status: call.status ?? "finished",
      costEstimate: call.costEstimate ?? call.cost_estimate ?? null,
      cost_estimate: call.cost_estimate ?? call.costEstimate ?? null,
      usage: call.usage ?? null,
      taskId: getModelCallTaskId(call),
      task_id: getModelCallTaskId(call),
    })),
    model_calls: modelCalls,
    unattributedModelUsage: {
      callCount: unattributedModelCalls.length,
      call_count: unattributedModelCalls.length,
      estimatedCost: roundCost(unattributedProviderCost),
      estimated_cost: roundCost(unattributedProviderCost),
      currency,
      modelCalls: unattributedModelCalls.map((call) => ({
        provider: call.provider,
        model: call.model,
        status: call.status ?? "finished",
        costEstimate: call.costEstimate ?? call.cost_estimate ?? null,
        cost_estimate: call.cost_estimate ?? call.costEstimate ?? null,
        usage: call.usage ?? null,
        taskId: getModelCallTaskId(call),
        task_id: getModelCallTaskId(call),
      })),
      model_calls: unattributedModelCalls,
    },
    unattributed_model_usage: {
      call_count: unattributedModelCalls.length,
      estimated_cost: roundCost(unattributedProviderCost),
      currency,
      model_calls: unattributedModelCalls,
    },
  };
}

function createRoutingDecisions(routingTrace) {
  return routingTrace.map((route) => ({
    taskId: route.task_id,
    task_id: route.task_id,
    modelTier: route.model_tier,
    model_tier: route.model_tier,
    selectedModel: route.selected_model ?? null,
    selected_model: route.selected_model ?? null,
    reason: route.reason ?? "No routing reason recorded.",
    escalationTriggers: route.escalation_triggers ?? [],
    escalation_triggers: route.escalation_triggers ?? [],
  }));
}

function createEscalationDecisions(verification) {
  return verification
    .map((item) => item.escalation)
    .filter(Boolean)
    .map((escalation) => ({
      required: escalation.required === true,
      reason: escalation.reason ?? "No escalation reason recorded.",
      fromTiers: escalation.fromTiers ?? escalation.from_tiers ?? [],
      from_tiers: escalation.from_tiers ?? escalation.fromTiers ?? [],
      targetTier: escalation.targetTier ?? escalation.target_tier ?? null,
      target_tier: escalation.target_tier ?? escalation.targetTier ?? null,
    }));
}

function createRiskSummary(record) {
  const risks = unique((record.plan.tasks ?? []).map((task) => task.risk).filter(Boolean));
  const approval = record.plan.approval;
  const policyViolations = record.plan.policyStatus?.violations ?? [];
  const budgetViolations = record.plan.budgetStatus?.violations ?? [];
  const summary = risks.map((risk) => `Task risk: ${risk}`);

  if (approval?.required) {
    summary.push(`Approval required: ${(approval.reasons ?? []).join(", ") || "risk gate"}`);
  }
  for (const violation of [...policyViolations, ...budgetViolations]) {
    summary.push(`Policy/budget risk: ${violation.code}`);
  }
  return summary;
}

function summarizeVerification(verification) {
  return {
    status: verification?.status ?? "skipped",
    commandStatus: summarizeCommandStatus(verification?.commands ?? []),
    command_status: summarizeCommandStatus(verification?.commands ?? []),
    acceptanceStatus: verification?.acceptance?.status ?? "skipped",
    acceptance_status: verification?.acceptance?.status ?? "skipped",
    supervisorStatus:
      verification?.supervisorReview?.status ??
      verification?.supervisor_review?.status ??
      "skipped",
    supervisor_status:
      verification?.supervisorReview?.status ??
      verification?.supervisor_review?.status ??
      "skipped",
    escalationRequired: verification?.escalation?.required === true,
    escalation_required: verification?.escalation?.required === true,
  };
}

function createFailureAnalysis(record) {
  const categories = {
    provider_error: [],
    malformed_output: [],
    policy_violation: [],
    verification_failure: [],
    human_approval_rejected: [],
  };

  for (const call of record.modelCalls ?? []) {
    if (call.status === "failed" || call.error) {
      categories.provider_error.push({
        provider: call.provider,
        model: call.model,
        code: call.error?.code ?? "provider.error",
        message: call.error?.message ?? "Provider call failed.",
      });
    }
  }

  for (const attempt of record.workerAttempts ?? []) {
    if (attempt.status === "failed" || attempt.error) {
      const failure = {
        taskId: attempt.taskId ?? attempt.task_id,
        task_id: attempt.task_id ?? attempt.taskId,
        status: attempt.status,
        code: getWorkerAttemptErrorCode(attempt),
        message: attempt.error?.message ?? "Worker output was not accepted.",
      };

      if (isWorkerPolicyViolation(failure.code)) {
        categories.policy_violation.push(failure);
      } else {
        categories.malformed_output.push(failure);
      }
    }
  }

  for (const violation of record.plan.policyStatus?.violations ?? []) {
    categories.policy_violation.push(violation);
  }
  for (const violation of record.plan.budgetStatus?.violations ?? []) {
    categories.policy_violation.push(violation);
  }

  for (const verification of record.verification ?? []) {
    if (verification.status === "failed") {
      categories.verification_failure.push({
        status: verification.status,
        message: verification.message ?? "Verification failed.",
        commandStatus: summarizeCommandStatus(verification.commands ?? []),
        command_status: summarizeCommandStatus(verification.commands ?? []),
      });
    }
  }

  if (record.plan.approval?.status === "rejected" || record.status === "approval_rejected") {
    categories.human_approval_rejected.push({
      status: record.plan.approval?.status ?? record.status,
      reasons: record.plan.approval?.reasons ?? [],
    });
  }

  return {
    categories,
    categoryCounts: Object.fromEntries(
      Object.entries(categories).map(([category, items]) => [category, items.length])
    ),
    category_counts: Object.fromEntries(
      Object.entries(categories).map(([category, items]) => [category, items.length])
    ),
  };
}

function createFollowUpRecommendations({ record, latestVerification, failureAnalysis }) {
  const recommendations = [];
  const failures = failureAnalysis.categoryCounts;

  if (latestVerification?.status === "failed") {
    recommendations.push("Fix failed verification evidence before treating the run as complete.");
  }
  if (failures.provider_error > 0) {
    recommendations.push("Review provider configuration, retry policy, and model availability.");
  }
  if (failures.malformed_output > 0) {
    recommendations.push("Ask the worker to resubmit structured output with acceptance evidence.");
  }
  if (failures.policy_violation > 0) {
    recommendations.push("Adjust task scope or policy limits before creating another run.");
  }
  if (record.plan.approval?.required && record.plan.approval?.status !== "approved") {
    recommendations.push("Collect human approval before file-changing worker steps.");
  }
  if (recommendations.length === 0) {
    recommendations.push("No immediate follow-up required from recorded runtime evidence.");
  }
  return recommendations;
}

function createTraceViewerData(record) {
  return {
    run: {
      runId: record.runId,
      run_id: record.runId,
      status: record.status,
      createdAt: record.createdAt,
      created_at: record.createdAt,
      updatedAt: record.updatedAt,
      updated_at: record.updatedAt,
    },
    tasks: summarizeTasks(record.plan.tasks ?? []),
    events: record.events ?? [],
    routing: record.plan.routingTrace ?? [],
    modelCalls: record.modelCalls ?? [],
    model_calls: record.modelCalls ?? [],
    workerAttempts: record.workerAttempts ?? [],
    worker_attempts: record.workerAttempts ?? [],
    verification: record.verification ?? [],
  };
}

function createModelReliabilityMetrics(records) {
  const groups = new Map();
  const recordsById = new Map();

  for (const record of records.filter(Boolean)) {
    recordsById.set(record.runId ?? recordsById.size, record);
  }

  for (const record of recordsById.values()) {
    const outcome = getExplicitVerificationOutcome(record);
    if (!outcome) continue;

    for (const task of record.plan?.tasks ?? []) {
      const taskType = task.taskType ?? task.task_type ?? task.difficulty ?? "unknown";
      const modelTier = task.modelTier ?? task.model_tier ?? "unknown";
      const key = `${taskType}:${modelTier}`;
      const current = groups.get(key) ?? {
        taskType,
        task_type: taskType,
        modelTier,
        model_tier: modelTier,
        attempts: 0,
        successes: 0,
        failures: 0,
        successRate: 0,
        success_rate: 0,
      };

      current.attempts += 1;
      if (outcome === "passed") {
        current.successes += 1;
      } else {
        current.failures += 1;
      }
      current.successRate = roundRatio(current.successes / current.attempts);
      current.success_rate = current.successRate;
      groups.set(key, current);
    }
  }

  const byTaskType = {};
  for (const item of groups.values()) {
    byTaskType[item.taskType] = byTaskType[item.taskType] ?? {};
    byTaskType[item.taskType][item.modelTier] = item;
  }

  return {
    byTaskType,
    by_task_type: byTaskType,
    samples: [...groups.values()].sort((a, b) =>
      `${a.taskType}:${a.modelTier}`.localeCompare(`${b.taskType}:${b.modelTier}`)
    ),
  };
}

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

function getExplicitVerificationOutcome(record) {
  if (isOutcomeExcludedStatus(record.status)) {
    return null;
  }
  if (record.status === "verification_passed") {
    return "passed";
  }
  if (record.status === "verification_failed") {
    return "failed";
  }

  const latestVerification = Array.isArray(record.verification) ? record.verification.at(-1) : null;
  if (latestVerification?.status === "passed" || latestVerification?.status === "failed") {
    return latestVerification.status;
  }
  return null;
}

function unique(values) {
  return [...new Set(values)].sort();
}

function touchedFiles(attempt = {}) {
  return attempt.filesTouched ?? attempt.files_touched ?? [];
}

function sumModelCallCost(modelCalls) {
  return roundCost(
    modelCalls.reduce(
      (total, call) =>
        total + (call.costEstimate?.estimatedCost ?? call.cost_estimate?.estimated_cost ?? 0),
      0
    )
  );
}

function getModelCallTaskId(call) {
  return call.request?.taskId ?? call.request?.task_id ?? null;
}

function getModelCallCostEstimate(call) {
  return {
    currency: call.costEstimate?.currency ?? call.cost_estimate?.currency ?? "USD",
    estimatedCost: call.costEstimate?.estimatedCost ?? call.cost_estimate?.estimated_cost ?? 0,
  };
}

function getWorkerAttemptErrorCode(attempt) {
  return (
    attempt.error?.code ??
    attempt.validation?.errors?.find((error) => typeof error?.code === "string")?.code ??
    "worker.output.invalid"
  );
}

function isWorkerPolicyViolation(code) {
  return typeof code === "string" && /(?:forbidden|policy|budget)/.test(code);
}

function numberOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function roundCost(value) {
  return Math.round(numberOrZero(value) * 1000000000) / 1000000000;
}

function roundRatio(value) {
  return Math.round(numberOrZero(value) * 10000) / 10000;
}

function formatVerificationMarkdown(verification) {
  if (verification.length === 0) {
    return "- skipped: no verification has been recorded.";
  }

  return verification
    .flatMap((item) => {
      const supervisor = item.supervisorReview ?? item.supervisor_review;
      const lines = [
        `- ${item.name}: ${item.status}`,
        `  - message: ${item.message ?? "none"}`,
        `  - Command Checks`,
      ];

      lines.push(...formatCommandChecks(item.commands ?? []));
      lines.push(`  - Acceptance Review: ${item.acceptance?.status ?? "skipped"}`);
      lines.push(...formatAcceptanceReview(item.acceptance));
      lines.push(`  - Final Supervisor Review: ${supervisor?.status ?? "skipped"}`);
      lines.push(...formatSupervisorReview(supervisor));
      lines.push(`  - Escalation: ${item.escalation?.required === true ? "required" : "not required"}`);
      lines.push(...formatEscalation(item.escalation));

      return lines;
    })
    .join("\n");
}

function summarizeCommandStatus(commands) {
  if (commands.length === 0) return "skipped";
  if (commands.some((command) => command.required && command.status !== "passed")) {
    return "failed";
  }
  return "passed";
}

function formatCommandChecks(commands) {
  if (commands.length === 0) {
    return ["    - skipped: no command checks configured."];
  }

  return commands.map((command) => {
    const exitCode =
      command.exitCode === null || command.exitCode === undefined ? "none" : command.exitCode;
    return `    - ${command.name}: ${command.status} (exitCode: ${exitCode}, required: ${command.required}, durationMs: ${command.durationMs})`;
  });
}

function formatAcceptanceReview(acceptance) {
  if (!acceptance || !Array.isArray(acceptance.tasks) || acceptance.tasks.length === 0) {
    return ["    - skipped: no task acceptance review recorded."];
  }

  return acceptance.tasks.flatMap((task) => [
    `    - ${task.task_id ?? task.taskId}: ${task.status}`,
    ...(task.items ?? []).map(
      (item) =>
        `      - ${item.criterion}: ${item.status}${item.evidence ? ` (${item.evidence})` : ""}`
    ),
  ]);
}

function formatSupervisorReview(supervisor) {
  if (!supervisor) {
    return ["    - skipped: no final supervisor review recorded."];
  }

  const lines = [];
  if (supervisor.reason) lines.push(`    - reason: ${supervisor.reason}`);
  if (supervisor.summary) lines.push(`    - summary: ${supervisor.summary}`);
  if (supervisor.diffRisk ?? supervisor.diff_risk) {
    lines.push(`    - diff risk: ${supervisor.diffRisk ?? supervisor.diff_risk}`);
  }
  for (const issue of supervisor.blockingIssues ?? supervisor.blocking_issues ?? []) {
    lines.push(`    - blocking issue: ${issue}`);
  }
  for (const error of supervisor.errors ?? []) {
    lines.push(`    - error: ${error.code}`);
  }
  return lines.length ? lines : ["    - no additional supervisor details."];
}

function formatEscalation(escalation) {
  if (!escalation) {
    return ["    - reason: no escalation metadata recorded."];
  }

  return [
    `    - reason: ${escalation.reason}`,
    `    - from tiers: ${(escalation.fromTiers ?? escalation.from_tiers ?? []).join(", ") || "none"}`,
    `    - target tier: ${escalation.targetTier ?? escalation.target_tier ?? "none"}`,
  ];
}

function formatFailureAnalysis(failureAnalysis) {
  return Object.entries(failureAnalysis?.categoryCounts ?? {}).map(
    ([category, count]) => `- ${category}: ${count}`
  );
}

function formatModelReliability(modelReliability) {
  const samples = modelReliability?.samples ?? [];
  if (samples.length === 0) {
    return ["- no historical samples recorded"];
  }

  return samples.map(
    (sample) =>
      `- ${sample.taskType}/${sample.modelTier}: ${sample.successes}/${sample.attempts} success (${sample.successRate})`
  );
}

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
