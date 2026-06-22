export function createReport(record) {
  const tasks = record.plan.tasks;
  const modelCalls = Array.isArray(record.modelCalls) ? record.modelCalls : [];
  const workerAttempts = Array.isArray(record.workerAttempts) ? record.workerAttempts : [];
  const verification = Array.isArray(record.verification) ? record.verification : [];
  const latestVerification = verification.at(-1);
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
  if (!acceptance || acceptance.tasks?.length === 0) {
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
