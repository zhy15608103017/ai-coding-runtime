export function createReport(record) {
  const tasks = record.plan.tasks;
  const modelCalls = Array.isArray(record.modelCalls) ? record.modelCalls : [];
  const workerAttempts = Array.isArray(record.workerAttempts) ? record.workerAttempts : [];
  const tierCounts = tasks.reduce((counts, task) => {
    counts[task.modelTier] = (counts[task.modelTier] ?? 0) + 1;
    return counts;
  }, {});
  const modelCostTotal = modelCalls.reduce(
    (total, call) => total + (call.costEstimate?.estimatedCost ?? call.cost_estimate?.estimated_cost ?? 0),
    0
  );

  return {
    runId: record.runId,
    status: record.status,
    request: record.request,
    summary: `Planned ${tasks.length} task(s) for runtime execution.`,
    taskGraph: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      dependsOn: task.dependsOn,
      modelTier: task.modelTier,
      risk: task.risk,
      difficulty: task.difficulty,
    })),
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
    routingTrace: record.plan.routingTrace,
    modelCalls,
    workerAttempts,
    workerSummary: {
      attemptCount: workerAttempts.length,
      appliedCount: workerAttempts.filter((attempt) => attempt.applied === true).length,
      filesTouched: unique(workerAttempts.flatMap((attempt) => attempt.filesTouched ?? [])),
    },
    modelUsage: {
      callCount: modelCalls.length,
      estimatedCost: Math.round(modelCostTotal * 1000000000) / 1000000000,
      currency: modelCalls[0]?.costEstimate?.currency ?? modelCalls[0]?.cost_estimate?.currency ?? "USD",
    },
    estimatedCost: record.plan.estimatedCost,
    verification: record.verification,
    events: record.events,
  };
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
    `## Model Routing`,
    ...Object.entries(report.modelRouting).map(([tier, count]) => `- ${tier}: ${count}`),
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
    ...(report.routingTrace?.length
      ? report.routingTrace.map(
          (route) => `- ${route.task_id}: ${route.model_tier} (${route.reason})`
        )
      : ["- skipped: no routing trace recorded."]),
    ``,
    `## Model Calls`,
    `- calls: ${report.modelUsage?.callCount ?? 0}`,
    `- estimated provider cost: ${report.modelUsage?.currency ?? "USD"} ${report.modelUsage?.estimatedCost ?? 0}`,
    ...(report.modelCalls?.length
      ? report.modelCalls.map(
          (call) =>
            `- ${call.provider}/${call.model}: ${call.usage?.totalTokens ?? 0} tokens, ${call.costEstimate?.currency ?? "USD"} ${call.costEstimate?.estimatedCost ?? 0}`
        )
      : ["- none recorded"]),
    ``,
    `## Worker Attempts`,
    `- attempts: ${report.workerSummary?.attemptCount ?? 0}`,
    `- applied: ${report.workerSummary?.appliedCount ?? 0}`,
    ...(report.workerAttempts?.length
      ? report.workerAttempts.map(
          (attempt) =>
            `- ${attempt.taskId ?? attempt.task_id}: ${attempt.status} (${(attempt.filesTouched ?? attempt.files_touched ?? []).join(", ") || "no files"})`
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
  ];

  return `${lines.join("\n")}\n`;
}

function unique(values) {
  return [...new Set(values)].sort();
}

function formatVerificationMarkdown(verification) {
  if (verification.length === 0) {
    return "- skipped: no verification has been recorded.";
  }

  return verification
    .flatMap((item) => {
      const lines = [`- ${item.name}: ${item.status}`];

      if (item.message) {
        lines.push(`  - message: ${item.message}`);
      }

      for (const command of item.commands ?? []) {
        const exitCode =
          command.exitCode === null || command.exitCode === undefined
            ? "none"
            : command.exitCode;
        lines.push(
          `  - ${command.name}: ${command.status} (exitCode: ${exitCode}, required: ${command.required}, durationMs: ${command.durationMs})`
        );
      }

      return lines;
    })
    .join("\n");
}
