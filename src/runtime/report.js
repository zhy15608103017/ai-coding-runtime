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
