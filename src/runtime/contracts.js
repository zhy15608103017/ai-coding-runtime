const DIFFICULTIES = new Set(["L0", "L1", "L2", "L3", "L4"]);
const RISKS = new Set(["low", "medium", "high"]);
const CONTEXT_NEEDS = new Set(["low", "medium", "high"]);
const VERIFICATION_LEVELS = new Set(["easy", "medium", "hard"]);
const MODEL_TIERS = new Set(["cheap", "standard", "premium"]);

export function normalizeTaskContract(task) {
  const id = task.id ?? task.task_id;
  const dependsOn = task.dependsOn ?? task.depends_on ?? [];
  const allowedFiles = task.allowedFiles ?? task.allowed_files ?? [];
  const forbiddenActions = task.forbiddenActions ?? task.forbidden_actions ?? [];
  const expectedOutput = task.expectedOutput ?? task.expected_output ?? [];
  const contextNeed = task.contextNeed ?? task.context_need ?? "low";
  const modelTier = task.modelTier ?? task.model_tier;
  const finalVerification = task.finalVerification ?? task.final_verification ?? false;

  return {
    ...task,
    id,
    task_id: id,
    dependsOn,
    depends_on: dependsOn,
    allowedFiles,
    allowed_files: allowedFiles,
    forbiddenActions,
    forbidden_actions: forbiddenActions,
    expectedOutput,
    expected_output: expectedOutput,
    contextNeed,
    context_need: contextNeed,
    modelTier,
    model_tier: modelTier,
    finalVerification,
    final_verification: finalVerification,
  };
}

export function createTaskGraph({
  runId = null,
  tasks,
  dependencies,
  approvalRequired,
  estimatedCost,
  riskSummary,
}) {
  return {
    run_id: runId,
    tasks: tasks.map((task) => ({
      task_id: task.task_id,
      title: task.title,
      difficulty: task.difficulty,
      risk: task.risk,
      model_tier: task.model_tier,
      final_verification: task.final_verification,
      depends_on: task.depends_on,
    })),
    dependencies,
    approval_required: approvalRequired,
    estimated_cost: estimatedCost,
    risk_summary: riskSummary,
  };
}

export function createPlanningPrompt({ request, workspaceSummary = null }) {
  const workspaceLines = workspaceSummary
    ? [
        "",
        "Workspace summary:",
        `- total_files: ${workspaceSummary.total_files ?? workspaceSummary.totalFiles}`,
        `- matched_request_files: ${(workspaceSummary.matched_request_files ?? workspaceSummary.matchedRequestFiles ?? []).join(", ") || "none"}`,
        `- project_signals: ${(workspaceSummary.project_signals ?? workspaceSummary.projectSignals ?? []).join(", ") || "none"}`,
      ]
    : [];

  return [
    "You are the AI Coding Runtime planner.",
    "Convert the user request into a dependency-aware task graph and worker-safe Task Contract entries.",
    "",
    "Each Task Contract must include: task_id, title, goal, difficulty, risk, context_need, verification, model_tier, final_verification, depends_on, allowed_files, forbidden_actions, acceptance, and expected_output.",
    "Reject or revise any task that has no acceptance criteria.",
    "Mark medium and high risk plans as requiring human approval before execution.",
    ...workspaceLines,
    "",
    "User request:",
    request,
  ].join("\n");
}

export function createApprovalGate(tasks) {
  const approvalTasks = tasks.filter((task) => task.risk === "medium" || task.risk === "high");

  return {
    required: approvalTasks.length > 0,
    status: approvalTasks.length > 0 ? "required" : "not_required",
    reasons: approvalTasks.map((task) => ({
      task_id: task.task_id,
      title: task.title,
      risk: task.risk,
      reason: `${task.risk}-risk task requires human approval before execution`,
    })),
  };
}

export function validateRuntimePlan(plan) {
  const errors = [];
  const rawTasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const tasks = rawTasks.map(normalizeTaskContract);

  if (tasks.length === 0) {
    errors.push({
      code: "task_graph.tasks.required",
      message: "Plan must include at least one task.",
    });
  }

  const taskIds = new Set();
  for (const [index, task] of tasks.entries()) {
    validateTaskContract(task, index, errors, rawTasks[index]);

    if (task.task_id) {
      if (taskIds.has(task.task_id)) {
        errors.push({
          code: "task.id.duplicate",
          task_id: task.task_id,
          message: `Duplicate task id: ${task.task_id}.`,
        });
      }
      taskIds.add(task.task_id);
    }
  }

  validateTaskGraphSchema(plan, errors);
  validateTaskGraphTaskConsistency(plan, tasks, errors);
  validateDependencyEdgeConsistency(plan, tasks, errors);
  validateTaskGraphAliasConsistency(plan, errors);
  validateRoutingMetadata(plan, tasks, errors);
  validateApprovalConsistency(plan, tasks, errors);
  validateDependencies(plan, tasks, taskIds, errors);

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function createPlanReport(plan) {
  const approval = plan.approval ?? createApprovalGate(plan.tasks ?? []);
  const validation = plan.validation ?? validateRuntimePlan(plan);

  return {
    summary: `Plan contains ${plan.tasks.length} task(s), ${plan.dependencies.length} dependency edge(s), and ${approval.required ? "requires" : "does not require"} human approval.`,
    approval: {
      required: approval.required,
      status: approval.status,
      reasons: approval.reasons,
    },
    validation: {
      valid: validation.valid,
      errorCount: validation.errors.length,
      errors: validation.errors,
    },
    taskGraph: plan.taskGraph,
    task_graph: plan.task_graph ?? plan.taskGraph,
    workspaceSummary: plan.workspaceSummary ?? null,
    workspace_summary: plan.workspace_summary ?? plan.workspaceSummary ?? null,
    riskSummary: plan.riskSummary,
    risk_summary: plan.risk_summary ?? plan.riskSummary,
    estimatedCost: plan.estimatedCost,
    estimated_cost: plan.estimated_cost ?? plan.estimatedCost,
    tasks: plan.tasks.map((task) => ({
      task_id: task.task_id,
      title: task.title,
      goal: task.goal,
      difficulty: task.difficulty,
      risk: task.risk,
      model_tier: task.model_tier,
      acceptance: task.acceptance,
    })),
    nextSteps: approval.required
      ? ["Review task contracts", "Approve or reject the plan before execution"]
      : ["Plan can proceed to execution"],
  };
}

function validateTaskContract(task, index, errors, rawTask = {}) {
  addRequiredStringError(rawTask.task_id, "task.id.required", index, "Task must include task_id.", errors);
  addRequiredStringError(task.title, "task.title.required", index, "Task must include title.", errors);
  addRequiredStringError(task.goal, "task.goal.required", index, "Task must include goal.", errors);

  if (!DIFFICULTIES.has(task.difficulty)) {
    errors.push({
      code: "task.difficulty.invalid",
      task_id: task.task_id,
      message: "Task difficulty must be one of L0, L1, L2, L3, L4.",
    });
  }

  if (!RISKS.has(task.risk)) {
    errors.push({
      code: "task.risk.invalid",
      task_id: task.task_id,
      message: "Task risk must be one of low, medium, high.",
    });
  }

  if (!CONTEXT_NEEDS.has(rawTask.context_need)) {
    errors.push({
      code: "task.context_need.invalid",
      task_id: task.task_id,
      message: "Task context_need must be one of low, medium, high.",
    });
  }

  if (!VERIFICATION_LEVELS.has(task.verification)) {
    errors.push({
      code: "task.verification.invalid",
      task_id: task.task_id,
      message: "Task verification must be one of easy, medium, hard.",
    });
  }

  if (typeof rawTask.model_tier !== "string" || rawTask.model_tier.trim().length === 0) {
    errors.push({
      code: "task.model_tier.required",
      task_id: task.task_id,
      message: "Task must include model_tier.",
    });
  } else if (!MODEL_TIERS.has(rawTask.model_tier)) {
    errors.push({
      code: "task.model_tier.invalid",
      task_id: task.task_id,
      message: "Task model_tier must be one of cheap, standard, premium.",
    });
  }

  if (typeof rawTask.final_verification !== "boolean") {
    errors.push({
      code: "task.final_verification.required",
      task_id: task.task_id,
      message: "Task must include final_verification.",
    });
  } else if (
    rawTask.finalVerification !== undefined &&
    rawTask.finalVerification !== rawTask.final_verification
  ) {
    errors.push({
      code: "task.final_verification.alias.inconsistent",
      task_id: task.task_id,
      message: "Task finalVerification must match final_verification.",
    });
  }

  addArrayError(rawTask.depends_on, "task.depends_on.required", task, "Task must include depends_on.", errors);
  addArrayError(rawTask.allowed_files, "task.allowed_files.required", task, "Task must include allowed_files.", errors);
  addArrayError(
    rawTask.forbidden_actions,
    "task.forbidden_actions.required",
    task,
    "Task must include forbidden_actions.",
    errors
  );
  addNonEmptyArrayError(
    task.acceptance,
    "task.acceptance.required",
    task,
    "Task must include at least one acceptance criterion.",
    errors
  );
  addNonEmptyArrayError(
    rawTask.expected_output,
    "task.expected_output.required",
    task,
    "Task must include at least one expected_output item.",
    errors
  );
}

function validateTaskGraphSchema(plan, errors) {
  const requiredFields = [
    ["run_id", (value) => value === null || typeof value === "string"],
    ["tasks", Array.isArray],
    ["dependencies", Array.isArray],
    ["approval_required", (value) => typeof value === "boolean"],
    ["estimated_cost", (value) => value && typeof value === "object" && !Array.isArray(value)],
    ["risk_summary", (value) => typeof value === "string" && value.trim().length > 0],
  ];

  for (const [graphField, taskGraph] of [
    ["taskGraph", plan.taskGraph],
    ["task_graph", plan.task_graph],
  ]) {
    if (!taskGraph || typeof taskGraph !== "object" || Array.isArray(taskGraph)) {
      errors.push({
        code: "task_graph.required",
        field: graphField,
        message: `Plan must include valid ${graphField} metadata.`,
      });
      continue;
    }

    for (const [field, predicate] of requiredFields) {
      if (!(field in taskGraph) || !predicate(taskGraph[field])) {
        errors.push({
          code: `task_graph.${field}.required`,
          field: `${graphField}.${field}`,
          message: `${graphField} must include valid ${field}.`,
        });
      }
    }
  }
}

function validateTaskGraphTaskConsistency(plan, tasks, errors) {
  const taskGraphs = [
    ["taskGraph", plan.taskGraph],
    ["task_graph", plan.task_graph],
  ].filter(([, taskGraph]) => taskGraph && typeof taskGraph === "object" && !Array.isArray(taskGraph));

  if (taskGraphs.length === 0) {
    return;
  }

  const tasksById = new Map(tasks.map((task) => [task.task_id, task]));

  for (const [graphField, taskGraph] of taskGraphs) {
    if (!Array.isArray(taskGraph.tasks)) {
      continue;
    }

    const graphTaskIds = new Set();

    if (taskGraph.tasks.length !== tasks.length) {
      errors.push({
        code: "task_graph.tasks.inconsistent",
        field: `${graphField}.tasks`,
        message: "Task graph tasks must match top-level plan tasks.",
      });
    }

    for (const graphTask of taskGraph.tasks) {
      const taskId = graphTask?.task_id;
      if (typeof taskId !== "string" || taskId.trim().length === 0) {
        errors.push({
          code: "task_graph.task.id.required",
          field: `${graphField}.tasks`,
          message: "Task graph task must include task_id.",
        });
        continue;
      }

      if (graphTaskIds.has(taskId)) {
        errors.push({
          code: "task_graph.task.duplicate",
          field: `${graphField}.tasks`,
          task_id: taskId,
          message: `Duplicate task graph task id: ${taskId}.`,
        });
        continue;
      }

      graphTaskIds.add(taskId);
      const task = tasksById.get(taskId);
      if (!task) {
        errors.push({
          code: "task_graph.task.unknown",
          field: `${graphField}.tasks`,
          task_id: taskId,
          message: `Task graph references unknown task ${taskId}.`,
        });
        continue;
      }

      if (!taskGraphTaskMatchesPlanTask(graphTask, task)) {
        errors.push({
          code: "task_graph.tasks.inconsistent",
          field: `${graphField}.tasks`,
          task_id: taskId,
          message: `Task graph task ${taskId} must match the top-level task contract.`,
        });
      }
    }

    for (const task of tasks) {
      if (!graphTaskIds.has(task.task_id)) {
        errors.push({
          code: "task_graph.tasks.inconsistent",
          field: `${graphField}.tasks`,
          task_id: task.task_id,
          message: `Task graph is missing task ${task.task_id}.`,
        });
      }
    }
  }
}

function validateDependencyEdgeConsistency(plan, tasks, errors) {
  const expectedEdges = tasks.flatMap((task) =>
    (task.depends_on ?? []).map((dependencyId) => ({
      from: dependencyId,
      to: task.task_id,
    }))
  );

  for (const [field, edges] of [
    ["dependencies", plan.dependencies],
    ["taskGraph.dependencies", plan.taskGraph?.dependencies],
    ["task_graph.dependencies", plan.task_graph?.dependencies],
  ]) {
    if (!dependencyEdgesEqual(edges, expectedEdges)) {
      errors.push({
        code: "task_graph.dependencies.inconsistent",
        field,
        message: `${field} must match task depends_on edges.`,
      });
    }
  }
}

function validateTaskGraphAliasConsistency(plan, errors) {
  const taskGraph = plan.taskGraph;
  const taskGraphAlias = plan.task_graph;

  if (
    !taskGraph ||
    typeof taskGraph !== "object" ||
    Array.isArray(taskGraph) ||
    !taskGraphAlias ||
    typeof taskGraphAlias !== "object" ||
    Array.isArray(taskGraphAlias)
  ) {
    return;
  }

  const comparisons = [
    ["run_id", taskGraph.run_id, taskGraphAlias.run_id, valuesEqual],
    ["tasks", taskGraph.tasks, taskGraphAlias.tasks, valuesEqual],
    ["dependencies", taskGraph.dependencies, taskGraphAlias.dependencies, dependencyEdgesEqual],
    ["approval_required", taskGraph.approval_required, taskGraphAlias.approval_required, valuesEqual],
    ["estimated_cost", taskGraph.estimated_cost, taskGraphAlias.estimated_cost, valuesEqual],
    ["risk_summary", taskGraph.risk_summary, taskGraphAlias.risk_summary, valuesEqual],
  ];

  for (const [field, left, right, predicate] of comparisons) {
    if (!predicate(left, right)) {
      errors.push({
        code: "task_graph.alias.inconsistent",
        field,
        message: `taskGraph.${field} must match task_graph.${field}.`,
      });
    }
  }

  validatePlanMetadataAliases("estimatedCost", "estimated_cost", plan, errors);
  validatePlanMetadataAliases("riskSummary", "risk_summary", plan, errors);
  validatePlanMetadataMatchesTaskGraph(
    "estimated_cost",
    plan.estimated_cost ?? plan.estimatedCost,
    taskGraph.estimated_cost,
    taskGraphAlias.estimated_cost,
    errors
  );
  validatePlanMetadataMatchesTaskGraph(
    "risk_summary",
    plan.risk_summary ?? plan.riskSummary,
    taskGraph.risk_summary,
    taskGraphAlias.risk_summary,
    errors
  );
}

function validateApprovalConsistency(plan, tasks, errors) {
  const expectedApprovalRequired = tasks.some((task) => task.risk === "medium" || task.risk === "high");
  const approval = plan.approval;
  const hasApprovalObject = approval && typeof approval === "object" && !Array.isArray(approval);

  if (!hasApprovalObject || typeof approval.required !== "boolean") {
    errors.push({
      code: "approval.required",
      field: "approval.required",
      message: "Plan must include approval.required metadata.",
    });
  }

  const approvalValues = [
    ["approval.required", approval?.required],
    ["approvalRequired", plan.approvalRequired],
    ["approval_required", plan.approval_required],
    ["taskGraph.approval_required", plan.taskGraph?.approval_required],
    ["task_graph.approval_required", plan.task_graph?.approval_required],
  ].filter(([, value]) => value !== undefined);

  if (approvalValues.length === 0) {
    return;
  }

  for (const [field, value] of approvalValues) {
    if (value !== expectedApprovalRequired) {
      errors.push({
        code: "approval.inconsistent",
        field,
        message: `${field} must match task risk approval requirement.`,
      });
    }
  }

  if (hasApprovalObject) {
    const validStatuses = expectedApprovalRequired ? ["required", "approved"] : ["not_required"];
    if (!validStatuses.includes(approval.status)) {
      errors.push({
        code: "approval.status.inconsistent",
        field: "approval.status",
        message: "approval.status must match the approval requirement.",
      });
    }
  }
}

function validateRoutingMetadata(plan, tasks, errors) {
  const modelRegistry = Array.isArray(plan.modelRegistry) ? plan.modelRegistry : [];

  validateRoutingTrace(plan, tasks, errors, modelRegistry);
  validateModelTierAliases(plan, errors);
  validateModelRegistry(plan, errors);
  validateBudgetStatus(plan, errors);
  validatePolicyConfigMetadata(plan, errors);
  validatePolicyStatus(plan, errors);
}

function validateModelTierAliases(plan, errors) {
  const aliases = [
    ["modelTierAliases", plan.modelTierAliases],
    ["model_tier_aliases", plan.model_tier_aliases],
  ];

  for (const [field, value] of aliases) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push({
        code: "model.tier_aliases.required",
        field,
        message: `Plan must include ${field} metadata.`,
      });
      continue;
    }

    if (!isValidModelTierAliases(value)) {
      errors.push({
        code: "model.tier_aliases.invalid",
        field,
        message: `${field} must map cheap, standard, and premium aliases to their matching tiers.`,
      });
    }
  }

  if (
    plan.modelTierAliases &&
    plan.model_tier_aliases &&
    typeof plan.modelTierAliases === "object" &&
    typeof plan.model_tier_aliases === "object" &&
    !Array.isArray(plan.modelTierAliases) &&
    !Array.isArray(plan.model_tier_aliases) &&
    !valuesEqual(plan.modelTierAliases, plan.model_tier_aliases)
  ) {
    errors.push({
      code: "model.tier_aliases.alias.inconsistent",
      field: "modelTierAliases/model_tier_aliases",
      message: "modelTierAliases must match model_tier_aliases.",
    });
  }
}

function validateRoutingTrace(plan, tasks, errors, modelRegistry) {
  const traces = [
    ["routingTrace", plan.routingTrace],
    ["routing_trace", plan.routing_trace],
  ];

  for (const [field, trace] of traces) {
    if (!Array.isArray(trace)) {
      errors.push({
        code: "routing.trace.required",
        field,
        message: `Plan must include ${field} routing trace metadata.`,
      });
      continue;
    }

    if (trace.length !== tasks.length) {
      errors.push({
        code: "routing.trace.inconsistent",
        field,
        message: `${field} must include one route record per task.`,
      });
    }
  }

  if (Array.isArray(plan.routingTrace) && Array.isArray(plan.routing_trace)) {
    if (!valuesEqual(plan.routingTrace, plan.routing_trace)) {
      errors.push({
        code: "routing.trace.alias.inconsistent",
        field: "routingTrace/routing_trace",
        message: "routingTrace must match routing_trace.",
      });
    }
  }

  const trace = Array.isArray(plan.routingTrace) ? plan.routingTrace : [];
  const tasksById = new Map(tasks.map((task) => [task.task_id, task]));
  const traceTaskIds = new Set();

  for (const route of trace) {
    const taskId = route?.task_id;
    if (typeof taskId !== "string" || taskId.trim().length === 0) {
      errors.push({
        code: "routing.trace.task_id.required",
        field: "routingTrace.task_id",
        message: "Routing trace entries must include task_id.",
      });
      continue;
    }

    if (traceTaskIds.has(taskId)) {
      errors.push({
        code: "routing.trace.task.duplicate",
        task_id: taskId,
        message: `Routing trace contains duplicate task ${taskId}.`,
      });
    }
    traceTaskIds.add(taskId);

    const task = tasksById.get(taskId);
    if (!task) {
      errors.push({
        code: "routing.trace.task.unknown",
        task_id: taskId,
        message: `Routing trace references unknown task ${taskId}.`,
      });
      continue;
    }

    if (route.model_tier !== task.model_tier) {
      errors.push({
        code: "routing.trace.model_tier.inconsistent",
        task_id: taskId,
        message: `Routing trace for ${taskId} must match task model_tier.`,
      });
    }

    validateSelectedModelConsistency({
      selectedModel: route.selected_model,
      expectedTier: task.model_tier,
      modelRegistry,
      codePrefix: "routing.trace",
      taskId,
      errors,
    });
  }

  for (const task of tasks) {
    if (!traceTaskIds.has(task.task_id)) {
      errors.push({
        code: "routing.trace.task.missing",
        task_id: task.task_id,
        message: `Routing trace is missing task ${task.task_id}.`,
      });
    }
  }

  for (const task of tasks) {
    if (!isValidClassificationMetadata(task.classification)) {
      errors.push({
        code: task.classification && typeof task.classification === "object" && !Array.isArray(task.classification)
          ? "task.classification.invalid"
          : "task.classification.required",
        task_id: task.task_id,
        message:
          "Task must include Phase 4 classification metadata with difficulty, risk, context_need, verification, confidence, and reasoning.",
      });
    }

    if (!isValidTaskRoutingMetadata(task.routing)) {
      errors.push({
        code: task.routing && typeof task.routing === "object" && !Array.isArray(task.routing)
          ? "task.routing.invalid"
          : "task.routing.required",
        task_id: task.task_id,
        message:
          "Task must include Phase 4 routing metadata with model_tier, selected_model, reason, and escalation_triggers.",
      });
    }

    const contractEditsFiles = Array.isArray(task.allowed_files) && task.allowed_files.length > 0;
    const contractFinalVerification = task.final_verification === true;
    if (
      task.classification &&
      typeof task.classification === "object" &&
      !Array.isArray(task.classification) &&
      task.classification.edits_files !== contractEditsFiles
    ) {
      errors.push({
        code: "task.classification.edits_files.inconsistent",
        task_id: task.task_id,
        message: "Task classification edits_files must match the task contract allowed_files.",
      });
    }

    if (
      task.routing &&
      typeof task.routing === "object" &&
      !Array.isArray(task.routing) &&
      task.routing.model_tier !== task.model_tier
    ) {
      errors.push({
        code: "task.routing.model_tier.inconsistent",
        task_id: task.task_id,
        message: "Task routing metadata model_tier must match the task contract model_tier.",
      });
    }

    validateSelectedModelConsistency({
      selectedModel: task.routing?.selected_model,
      expectedTier: task.model_tier,
      modelRegistry,
      codePrefix: "task.routing",
      taskId: task.task_id,
      errors,
    });

    if (contractEditsFiles && task.model_tier === "cheap") {
      errors.push({
        code: "routing.safety.file_edit_tier",
        task_id: task.task_id,
        message: "File-editing tasks must route to at least the standard tier.",
      });
    }

    if (
      contractFinalVerification &&
      task.routing &&
      typeof task.routing === "object" &&
      !Array.isArray(task.routing) &&
      Array.isArray(task.routing.escalation_triggers) &&
      !task.routing.escalation_triggers.includes("final_review")
    ) {
      errors.push({
        code: "task.routing.final_review.required",
        task_id: task.task_id,
        message: "Final verification tasks must include final_review in routing escalation triggers.",
      });
    }

    if (contractFinalVerification && task.model_tier !== "premium") {
      errors.push({
        code: "routing.safety.final_verification_tier",
        task_id: task.task_id,
        message: "Final verification tasks must route to the premium tier.",
      });
    }
  }
}

function validateModelRegistry(plan, errors) {
  const registries = [
    ["modelRegistry", plan.modelRegistry],
    ["model_registry", plan.model_registry],
  ];

  for (const [field, registry] of registries) {
    if (!Array.isArray(registry)) {
      errors.push({
        code: "model.registry.required",
        field,
        message: `Plan must include ${field} metadata.`,
      });
      continue;
    }

    for (const [index, entry] of registry.entries()) {
      if (!isValidModelRegistryEntry(entry)) {
        errors.push({
          code: "model.registry.entry.invalid",
          field: `${field}[${index}]`,
          message:
            "Model registry entries must include provider, model, tier, cost_hint, context_window, tool_support, strengths, and blocked_task_types.",
        });
      }
    }
  }

  if (Array.isArray(plan.modelRegistry) && Array.isArray(plan.model_registry)) {
    if (!valuesEqual(plan.modelRegistry, plan.model_registry)) {
      errors.push({
        code: "model.registry.alias.inconsistent",
        field: "modelRegistry/model_registry",
        message: "modelRegistry must match model_registry.",
      });
    }
  }
}

function validateBudgetStatus(plan, errors) {
  const budgetStatus = plan.budgetStatus;
  const budgetStatusAlias = plan.budget_status;

  for (const [field, value] of [
    ["budgetStatus", budgetStatus],
    ["budget_status", budgetStatusAlias],
  ]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push({
        code: "budget.status.required",
        field,
        message: `Plan must include ${field} metadata.`,
      });
      continue;
    }

    if (typeof value.allowed !== "boolean" || !Array.isArray(value.violations)) {
      errors.push({
        code: "budget.status.invalid",
        field,
        message: `${field} must include allowed and violations fields.`,
      });
    }
  }

  if (
    budgetStatus &&
    budgetStatusAlias &&
    typeof budgetStatus === "object" &&
    typeof budgetStatusAlias === "object" &&
    !Array.isArray(budgetStatus) &&
    !Array.isArray(budgetStatusAlias) &&
    !valuesEqual(budgetStatus, budgetStatusAlias)
  ) {
    errors.push({
      code: "budget.status.alias.inconsistent",
      field: "budgetStatus/budget_status",
      message: "budgetStatus must match budget_status.",
    });
  }
}

function isValidClassificationMetadata(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    DIFFICULTIES.has(value.difficulty) &&
    RISKS.has(value.risk) &&
    CONTEXT_NEEDS.has(value.context_need) &&
    VERIFICATION_LEVELS.has(value.verification) &&
    typeof value.confidence === "number" &&
    value.confidence >= 0 &&
    value.confidence <= 1 &&
    Array.isArray(value.reasoning)
  );
}

function isValidTaskRoutingMetadata(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    MODEL_TIERS.has(value.model_tier) &&
    isValidSelectedModel(value.selected_model) &&
    typeof value.reason === "string" &&
    value.reason.trim().length > 0 &&
    Array.isArray(value.escalation_triggers)
  );
}

function validateSelectedModelConsistency({
  selectedModel,
  expectedTier,
  modelRegistry,
  codePrefix,
  taskId,
  errors,
}) {
  if (!isValidSelectedModel(selectedModel)) {
    errors.push({
      code: `${codePrefix}.selected_model.invalid`,
      task_id: taskId,
      message: "Selected model must include provider, model, and tier.",
    });
    return;
  }

  if (selectedModel.tier !== expectedTier) {
    errors.push({
      code: `${codePrefix}.selected_model.tier.inconsistent`,
      task_id: taskId,
      message: "Selected model tier must match the routed task tier.",
    });
  }

  if (!modelRegistryHasSelectedModel(modelRegistry, selectedModel)) {
    errors.push({
      code: `${codePrefix}.selected_model.unknown`,
      task_id: taskId,
      message: "Selected model must exist in the model registry.",
    });
  }
}

function isValidSelectedModel(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.provider === "string" &&
    value.provider.trim().length > 0 &&
    typeof value.model === "string" &&
    value.model.trim().length > 0 &&
    MODEL_TIERS.has(value.tier)
  );
}

function modelRegistryHasSelectedModel(modelRegistry, selectedModel) {
  return modelRegistry.some(
    (entry) =>
      entry?.provider === selectedModel.provider &&
      entry?.model === selectedModel.model &&
      entry?.tier === selectedModel.tier
  );
}

function isValidModelTierAliases(value) {
  return value.cheap === "cheap" && value.standard === "standard" && value.premium === "premium";
}

function isValidModelRegistryEntry(entry) {
  return (
    entry &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    typeof entry.provider === "string" &&
    entry.provider.trim().length > 0 &&
    typeof entry.model === "string" &&
    entry.model.trim().length > 0 &&
    MODEL_TIERS.has(entry.tier) &&
    entry.cost_hint &&
    typeof entry.cost_hint === "object" &&
    !Array.isArray(entry.cost_hint) &&
    typeof entry.context_window === "number" &&
    Array.isArray(entry.tool_support) &&
    Array.isArray(entry.strengths) &&
    Array.isArray(entry.blocked_task_types)
  );
}

function validatePolicyStatus(plan, errors) {
  const policyStatus = plan.policyStatus;
  const policyStatusAlias = plan.policy_status;

  for (const [field, value] of [
    ["policyStatus", policyStatus],
    ["policy_status", policyStatusAlias],
  ]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push({
        code: "policy.status.required",
        field,
        message: `Plan must include ${field} metadata.`,
      });
      continue;
    }

    if (typeof value.allowed !== "boolean" || !Array.isArray(value.violations)) {
      errors.push({
        code: "policy.status.invalid",
        field,
        message: `${field} must include allowed and violations fields.`,
      });
    }
  }

  if (
    policyStatus &&
    policyStatusAlias &&
    typeof policyStatus === "object" &&
    typeof policyStatusAlias === "object" &&
    !Array.isArray(policyStatus) &&
    !Array.isArray(policyStatusAlias) &&
    !valuesEqual(policyStatus, policyStatusAlias)
  ) {
    errors.push({
      code: "policy.status.alias.inconsistent",
      field: "policyStatus/policy_status",
      message: "policyStatus must match policy_status.",
    });
  }
}

function validatePolicyConfigMetadata(plan, errors) {
  validateOptionalAliasObject("policyConfig", "policy_config", plan, errors, "policy.config");
  validateOptionalAliasObject("policyValidation", "policy_validation", plan, errors, "policy.validation");

  const validation = plan.policyValidation ?? plan.policy_validation;
  if (validation !== undefined) {
    if (!validation || typeof validation !== "object" || Array.isArray(validation)) {
      errors.push({
        code: "policy.validation.invalid",
        field: "policyValidation",
        message: "policyValidation must be an object when present.",
      });
    } else if (typeof validation.valid !== "boolean" || !Array.isArray(validation.errors)) {
      errors.push({
        code: "policy.validation.invalid",
        field: "policyValidation",
        message: "policyValidation must include valid and errors fields.",
      });
    }
  }
}

function validateOptionalAliasObject(camelField, snakeField, plan, errors, codePrefix) {
  const left = plan[camelField];
  const right = plan[snakeField];

  for (const [field, value] of [
    [camelField, left],
    [snakeField, right],
  ]) {
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
      errors.push({
        code: `${codePrefix}.invalid`,
        field,
        message: `${field} must be an object when present.`,
      });
    }
  }

  if (
    left !== undefined &&
    right !== undefined &&
    left &&
    right &&
    typeof left === "object" &&
    typeof right === "object" &&
    !Array.isArray(left) &&
    !Array.isArray(right) &&
    !valuesEqual(left, right)
  ) {
    errors.push({
      code: `${codePrefix}.alias.inconsistent`,
      field: `${camelField}/${snakeField}`,
      message: `${camelField} must match ${snakeField}.`,
    });
  }
}

function validateDependencies(plan, tasks, taskIds, errors) {
  const graph = new Map(tasks.map((task) => [task.task_id, new Set(task.depends_on ?? [])]));

  for (const task of tasks) {
    for (const dependencyId of task.depends_on ?? []) {
      if (!taskIds.has(dependencyId)) {
        errors.push({
          code: "task_graph.dependency.unknown",
          task_id: task.task_id,
          dependency_id: dependencyId,
          message: `Task ${task.task_id} depends on unknown task ${dependencyId}.`,
        });
      }
    }
  }

  for (const edge of collectDependencyEdges(plan)) {
    if (!isValidDependencyEdge(edge)) {
      errors.push({
        code: "task_graph.dependency.invalid",
        message: "Dependency edge must include string from and to fields.",
      });
      continue;
    }

    if (!taskIds.has(edge.from)) {
      errors.push({
        code: "task_graph.dependency.unknown",
        task_id: edge.to,
        dependency_id: edge.from,
        message: `Task ${edge.to} depends on unknown task ${edge.from}.`,
      });
      continue;
    }

    if (!taskIds.has(edge.to)) {
      errors.push({
        code: "task_graph.dependency.unknown",
        task_id: edge.to,
        dependency_id: edge.from,
        message: `Unknown task ${edge.to} depends on ${edge.from}.`,
      });
      continue;
    }

    graph.get(edge.to).add(edge.from);
  }

  const visited = new Set();
  const visiting = new Set();

  for (const task of tasks) {
    if (hasCycle(task.task_id, graph, visited, visiting)) {
      errors.push({
        code: "task_graph.cycle",
        task_id: task.task_id,
        message: "Task graph contains a circular dependency.",
      });
      return;
    }
  }
}

function hasCycle(taskId, graph, visited, visiting) {
  if (visiting.has(taskId)) {
    return true;
  }

  if (visited.has(taskId)) {
    return false;
  }

  visiting.add(taskId);

  for (const dependencyId of graph.get(taskId) ?? []) {
    if (hasCycle(dependencyId, graph, visited, visiting)) {
      return true;
    }
  }

  visiting.delete(taskId);
  visited.add(taskId);
  return false;
}

function collectDependencyEdges(plan) {
  const edges = [
    ...(Array.isArray(plan.dependencies) ? plan.dependencies : []),
    ...(Array.isArray(plan.taskGraph?.dependencies) ? plan.taskGraph.dependencies : []),
    ...(Array.isArray(plan.task_graph?.dependencies) ? plan.task_graph.dependencies : []),
  ];
  const seen = new Set();

  return edges.filter((edge) => {
    const key = `${edge?.from ?? ""}->${edge?.to ?? ""}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function isValidDependencyEdge(edge) {
  return (
    edge &&
    typeof edge.from === "string" &&
    edge.from.trim().length > 0 &&
    typeof edge.to === "string" &&
    edge.to.trim().length > 0
  );
}

function taskGraphTaskMatchesPlanTask(graphTask, task) {
  return (
    graphTask.title === task.title &&
    graphTask.difficulty === task.difficulty &&
    graphTask.risk === task.risk &&
    graphTask.model_tier === task.model_tier &&
    graphTask.final_verification === task.final_verification &&
    arraysEqual(graphTask.depends_on, task.depends_on)
  );
}

function arraysEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }

  return left.every((item, index) => item === right[index]);
}

function dependencyEdgesEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return false;
  }

  const normalizedLeft = normalizeDependencyEdges(left);
  const normalizedRight = normalizeDependencyEdges(right);
  return arraysEqual(normalizedLeft, normalizedRight);
}

function normalizeDependencyEdges(edges) {
  return edges.map((edge) => `${edge?.from ?? ""}->${edge?.to ?? ""}`).sort();
}

function validatePlanMetadataAliases(camelField, snakeField, plan, errors) {
  if (plan[camelField] === undefined || plan[snakeField] === undefined) {
    return;
  }

  if (!valuesEqual(plan[camelField], plan[snakeField])) {
    errors.push({
      code: "task_graph.alias.inconsistent",
      field: `${camelField}/${snakeField}`,
      message: `${camelField} must match ${snakeField}.`,
    });
  }
}

function validatePlanMetadataMatchesTaskGraph(field, planValue, taskGraphValue, taskGraphAliasValue, errors) {
  if (planValue === undefined) {
    return;
  }

  if (!valuesEqual(planValue, taskGraphValue) || !valuesEqual(planValue, taskGraphAliasValue)) {
    errors.push({
      code: "task_graph.alias.inconsistent",
      field,
      message: `Plan ${field} must match task graph metadata.`,
    });
  }
}

function valuesEqual(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }

  return value;
}

function addRequiredStringError(value, code, index, message, errors) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push({
      code,
      task_index: index,
      message,
    });
  }
}

function addArrayError(value, code, task, message, errors) {
  if (!Array.isArray(value)) {
    errors.push({
      code,
      task_id: task.task_id,
      message,
    });
  }
}

function addNonEmptyArrayError(value, code, task, message, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({
      code,
      task_id: task.task_id,
      message,
    });
  }
}
