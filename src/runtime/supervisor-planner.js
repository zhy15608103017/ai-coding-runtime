import { createRuntimePlan } from "./planner.js";
import { redactSecrets } from "./policy.js";
import { generateModelResponse } from "./providers.js";

export async function createRuntimePlanWithSupervisor(options = {}) {
  const supervisorConfig = resolveSupervisorConfig(options);
  if (supervisorConfig.enabled !== true) {
    return createRuntimePlan(options);
  }

  let providerRequest = { provider: null, model: null };

  try {
    providerRequest = createSupervisorPlannerRequest(options, supervisorConfig);
    const generate =
      options.generate ??
      options.execution?.generate ??
      supervisorConfig.generate ??
      generateModelResponse;
    const response = await generate(providerRequest, { providers: options.providers });
    const taskDrafts = extractSupervisorTaskDrafts(response);
    const plan = createRuntimePlan({
      ...options,
      taskDrafts,
    });
    if (plan.validation?.valid !== true) {
      throw new Error(`Supervisor planner produced invalid task contracts: ${validationCodes(plan).join(", ")}`);
    }

    return attachSupervisorPlanning(plan, {
      enabled: true,
      status: "used",
      provider: response.provider ?? providerRequest.provider,
      model: response.model ?? providerRequest.model,
      taskCount: taskDrafts.length,
      task_count: taskDrafts.length,
      finishReason: response.finishReason ?? response.finish_reason ?? null,
      finish_reason: response.finishReason ?? response.finish_reason ?? null,
      fallback: false,
    });
  } catch (error) {
    const plan = createRuntimePlan(options);
    return attachSupervisorPlanning(plan, {
      enabled: true,
      status: "fallback",
      provider: providerRequest.provider ?? null,
      model: providerRequest.model ?? null,
      taskCount: plan.tasks.length,
      task_count: plan.tasks.length,
      reason: error.message,
      fallback: true,
    });
  }
}

function resolveSupervisorConfig(options = {}) {
  return (
    options.planning?.supervisor ??
    options.planning?.supervisorPlanner ??
    options.planning?.supervisor_planner ??
    options.supervisorPlanner ??
    options.supervisor_planner ??
    {}
  );
}

function createSupervisorPlannerRequest(options, supervisorConfig) {
  const provider = supervisorConfig.provider;
  const model = supervisorConfig.model;
  if (!provider || !model) {
    throw new Error("supervisor planner requires provider and model.");
  }

  return {
    provider,
    model,
    messages: [
      {
        role: "system",
        content: "You are the AI Coding Runtime supervisor planner. Return only valid JSON.",
      },
      {
        role: "user",
        content: createSupervisorPlannerPrompt(options),
      },
    ],
    temperature: supervisorConfig.temperature ?? 0,
    maxTokens: supervisorConfig.maxTokens ?? supervisorConfig.max_tokens ?? 4096,
    timeoutMs: supervisorConfig.timeoutMs ?? supervisorConfig.timeout_ms,
    responseSchema: supervisorPlannerResponseSchema(),
  };
}

function createSupervisorPlannerPrompt({ request, workspace = {} }) {
  const workspaceLines = workspace.cwd
    ? [
        "",
        "Workspace:",
        `- cwd: ${workspace.cwd}`,
      ]
    : [];

  return [
    "Create dynamic Task Contract drafts for AI Coding Runtime.",
    "",
    "Return JSON with one top-level `tasks` array.",
    "Each task must include: task_id, title, goal, difficulty, risk, context_need, verification, final_verification, depends_on, allowed_files, forbidden_actions, acceptance, and expected_output.",
    "Use difficulty values L0, L1, L2, L3, or L4.",
    "Use risk/context_need values low, medium, or high.",
    "Use verification values easy, medium, or hard.",
    "Keep file edits narrowly scoped with allowed_files.",
    "Include a final review task with final_verification=true for implementation work.",
    ...workspaceLines,
    "",
    "User request:",
    request,
  ].join("\n");
}

function extractSupervisorTaskDrafts(response = {}) {
  const structured = response.structuredOutput ?? response.structured_output;
  const parsed =
    isPlainObject(structured)
      ? structured
      : typeof response.text === "string" && response.text.trim()
        ? parseSupervisorJson(response.text)
        : null;

  const tasks = parsed?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("Supervisor planner output must include a non-empty tasks array.");
  }

  return tasks.map((task, index) => sanitizeSupervisorTaskDraft(task, index));
}

function parseSupervisorJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Supervisor planner output must include a non-empty tasks array.");
  }
}

function sanitizeSupervisorTaskDraft(task = {}, index) {
  validateRawSupervisorTaskDraft(task, index);

  const taskId = stringOrFallback(task.task_id ?? task.taskId ?? task.id, `SP-${String(index + 1).padStart(3, "0")}`);
  const finalVerification = task.final_verification === true || task.finalVerification === true;

  return {
    id: taskId,
    task_id: taskId,
    title: stringOrFallback(task.title, `Supervisor task ${index + 1}`),
    goal: stringOrFallback(task.goal, "Execute the supervisor-planned task contract."),
    difficulty: allowedChoice(task.difficulty, ["L0", "L1", "L2", "L3", "L4"], finalVerification ? "L4" : "L1"),
    risk: allowedChoice(task.risk, ["low", "medium", "high"], finalVerification ? "high" : "low"),
    contextNeed: allowedChoice(task.contextNeed ?? task.context_need, ["low", "medium", "high"], "medium"),
    context_need: allowedChoice(task.contextNeed ?? task.context_need, ["low", "medium", "high"], "medium"),
    verification: allowedChoice(task.verification, ["easy", "medium", "hard"], finalVerification ? "hard" : "medium"),
    finalVerification,
    final_verification: finalVerification,
    dependsOn: stringArray(task.dependsOn ?? task.depends_on),
    depends_on: stringArray(task.dependsOn ?? task.depends_on),
    allowedFiles: stringArray(task.allowedFiles ?? task.allowed_files),
    allowed_files: stringArray(task.allowedFiles ?? task.allowed_files),
    forbiddenActions: stringArray(task.forbiddenActions ?? task.forbidden_actions),
    forbidden_actions: stringArray(task.forbiddenActions ?? task.forbidden_actions),
    acceptance: nonEmptyStringArray(task.acceptance, "supervisor task has acceptance evidence"),
    expectedOutput: nonEmptyStringArray(task.expectedOutput ?? task.expected_output, "task result"),
    expected_output: nonEmptyStringArray(task.expectedOutput ?? task.expected_output, "task result"),
  };
}

function validateRawSupervisorTaskDraft(task, index) {
  if (!isPlainObject(task)) {
    throw new Error(`Invalid supervisor task draft ${index + 1}: task must be an object.`);
  }

  requireStringField(task, index, "task_id", ["task_id", "taskId", "id"]);
  requireStringField(task, index, "title", ["title"]);
  requireStringField(task, index, "goal", ["goal"]);
  requireChoiceField(task, index, "difficulty", ["difficulty"], ["L0", "L1", "L2", "L3", "L4"]);
  requireChoiceField(task, index, "risk", ["risk"], ["low", "medium", "high"]);
  requireChoiceField(task, index, "context_need", ["context_need", "contextNeed"], ["low", "medium", "high"]);
  requireChoiceField(task, index, "verification", ["verification"], ["easy", "medium", "hard"]);
  requireBooleanField(task, index, "final_verification", ["final_verification", "finalVerification"]);
  requireStringArrayField(task, index, "depends_on", ["depends_on", "dependsOn"], { allowEmpty: true });
  requireStringArrayField(task, index, "allowed_files", ["allowed_files", "allowedFiles"], { allowEmpty: true });
  requireStringArrayField(task, index, "forbidden_actions", ["forbidden_actions", "forbiddenActions"], { allowEmpty: true });
  requireStringArrayField(task, index, "acceptance", ["acceptance"], { allowEmpty: false });
  requireStringArrayField(task, index, "expected_output", ["expected_output", "expectedOutput"], { allowEmpty: false });
}

function requireStringField(task, index, fieldName, aliases) {
  const value = pickAlias(task, aliases);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid supervisor task draft ${index + 1}: ${fieldName} must be a non-empty string.`);
  }
}

function requireChoiceField(task, index, fieldName, aliases, choices) {
  const value = pickAlias(task, aliases);
  if (!choices.includes(value)) {
    throw new Error(`Invalid supervisor task draft ${index + 1}: ${fieldName} must be one of ${choices.join(", ")}.`);
  }
}

function requireBooleanField(task, index, fieldName, aliases) {
  const value = pickAlias(task, aliases);
  if (typeof value !== "boolean") {
    throw new Error(`Invalid supervisor task draft ${index + 1}: ${fieldName} must be a boolean.`);
  }
}

function requireStringArrayField(task, index, fieldName, aliases, { allowEmpty }) {
  const value = pickAlias(task, aliases);
  if (!Array.isArray(value)) {
    throw new Error(`Invalid supervisor task draft ${index + 1}: ${fieldName} must be an array.`);
  }
  if (!allowEmpty && value.length === 0) {
    throw new Error(`Invalid supervisor task draft ${index + 1}: ${fieldName} must not be empty.`);
  }
  if (value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`Invalid supervisor task draft ${index + 1}: ${fieldName} must contain only non-empty strings.`);
  }
}

function pickAlias(value, aliases) {
  for (const alias of aliases) {
    if (Object.hasOwn(value, alias)) {
      return value[alias];
    }
  }
  return undefined;
}

function attachSupervisorPlanning(plan, metadata) {
  const safeMetadata = redactSecrets(metadata, plan.policyConfig ?? plan.policy_config);
  const planReport = plan.planReport
    ? {
        ...plan.planReport,
        supervisorPlanning: safeMetadata,
        supervisor_planning: safeMetadata,
      }
    : plan.planReport;
  const planReportAlias = plan.plan_report
    ? {
        ...plan.plan_report,
        supervisorPlanning: safeMetadata,
        supervisor_planning: safeMetadata,
      }
    : plan.plan_report;

  return {
    ...plan,
    planReport,
    plan_report: planReportAlias,
    supervisorPlanning: safeMetadata,
    supervisor_planning: safeMetadata,
  };
}

function validationCodes(plan) {
  return Array.isArray(plan.validation?.errors) && plan.validation.errors.length > 0
    ? plan.validation.errors.map((error) => error.code ?? "validation.error")
    : ["validation.invalid"];
}

function supervisorPlannerResponseSchema() {
  return {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
        },
      },
    },
    required: ["tasks"],
    additionalProperties: true,
  };
}

function stringOrFallback(value, fallback) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function allowedChoice(value, choices, fallback) {
  return choices.includes(value) ? value : fallback;
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function nonEmptyStringArray(value, fallback) {
  const items = stringArray(value);
  return items.length > 0 ? items : [fallback];
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
