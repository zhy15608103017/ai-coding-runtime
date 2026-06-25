import { createRuntimePlan } from "./planner.js";
import { generateModelResponse } from "./providers.js";

export async function createRuntimePlanWithSupervisor(options = {}) {
  const supervisorConfig = resolveSupervisorConfig(options); 
  if (supervisorConfig.enabled !== true) {
    return createRuntimePlan(options);
  }

  const providerRequest = createSupervisorPlannerRequest(options, supervisorConfig);
  const generate =
    options.generate ??
    options.execution?.generate ??
    supervisorConfig.generate ??
    generateModelResponse;

  try {
    const response = await generate(providerRequest, { providers: options.providers });
    const taskDrafts = extractSupervisorTaskDrafts(response);
    const plan = createRuntimePlan({
      ...options,
      taskDrafts,
    });

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
  const provider = supervisorConfig.provider ?? options.providers?.defaultProvider;
  const model = supervisorConfig.model ?? (provider ? options.providers?.entries?.[provider]?.defaultModel : null);
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

function attachSupervisorPlanning(plan, metadata) {
  return {
    ...plan,
    supervisorPlanning: metadata,
    supervisor_planning: metadata,
  };
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
