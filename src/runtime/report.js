export function createReport(record) {
  const tasks = record.plan.tasks;
  const tierCounts = tasks.reduce((counts, task) => {
    counts[task.modelTier] = (counts[task.modelTier] ?? 0) + 1;
    return counts;
  }, {});

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
    report.verification.length === 0
      ? "- skipped: V0 skeleton has not run verification commands yet."
      : report.verification.map((item) => `- ${item.name}: ${item.status}`).join("\n"),
  ];

  return `${lines.join("\n")}\n`;
}
