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
      depends_on: task.depends_on,
    })),
    dependencies,
    approval_required: approvalRequired,
    estimated_cost: estimatedCost,
    risk_summary: riskSummary,
  };
}

export function createPlanningPrompt({ request }) {
  return [
    "You are the AI Coding Runtime planner.",
    "Convert the user request into a dependency-aware task graph and worker-safe Task Contract entries.",
    "",
    "Each Task Contract must include: task_id, title, goal, difficulty, risk, context_need, verification, model_tier, depends_on, allowed_files, forbidden_actions, acceptance, and expected_output.",
    "Reject or revise any task that has no acceptance criteria.",
    "Mark medium and high risk plans as requiring human approval before execution.",
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
