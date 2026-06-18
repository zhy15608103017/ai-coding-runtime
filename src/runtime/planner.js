import {
  createApprovalGate,
  createPlanningPrompt,
  createPlanReport,
  createTaskGraph,
  normalizeTaskContract,
  validateRuntimePlan,
} from "./contracts.js";

const MODEL_TIERS = [
  {
    id: "cheap",
    label: "Cheap",
    description: "Low-cost tier for read-only analysis and low-risk generation.",
  },
  {
    id: "standard",
    label: "Standard",
    description: "Balanced tier for local code changes with ordinary risk.",
  },
  {
    id: "premium",
    label: "Premium",
    description: "Strong tier for high-risk work, hard verification, and final review.",
  },
];

const DIFFICULTY_ORDER = new Map([
  ["L0", 0],
  ["L1", 1],
  ["L2", 2],
  ["L3", 3],
  ["L4", 4],
]);

const DEFAULT_ESTIMATED_COST = {
  currency: "USD",
  minimum: 0,
  maximum: 0,
  note: "V0 skeleton records routing tiers but does not call real model providers.",
};

export function routeTask(task) {
  const difficulty = task.difficulty ?? "L1";
  const risk = task.risk ?? "low";
  const contextNeed = task.contextNeed ?? task.context_need ?? "low";
  const verification = task.verification ?? "easy";

  const reasons = [];
  let modelTier = "cheap";

  if (task.finalVerification) {
    modelTier = "premium";
    reasons.push("final verification always uses the premium tier");
  } else if (difficultyAtLeast(difficulty, "L3")) {
    modelTier = "premium";
    reasons.push(`${difficulty} tasks require stronger reasoning`);
  } else if (risk === "high") {
    modelTier = "premium";
    reasons.push("high-risk work requires premium review");
  } else if (verification === "hard") {
    modelTier = "premium";
    reasons.push("hard-to-verify work requires premium review");
  } else if (
    difficultyAtLeast(difficulty, "L2") ||
    risk === "medium" ||
    contextNeed === "medium" ||
    verification === "medium"
  ) {
    modelTier = "standard";
    reasons.push("task needs the standard tier because risk, context, or verification is non-trivial");
  } else {
    reasons.push("low-risk, easy-to-verify task can use the cheap tier");
  }

  return {
    modelTier,
    reasoning: reasons,
  };
}

export function createRuntimePlan({ request, now = new Date() }) {
  if (!request || typeof request !== "string" || request.trim().length === 0) {
    throw new TypeError("createRuntimePlan requires a non-empty request string.");
  }

  const createdAt = now.toISOString();
  const planId = createId("plan", request, createdAt);
  const taskDrafts = createDefaultTaskDrafts(request.trim());
  const tasks = taskDrafts.map((draft) => {
    const routing = routeTask(draft);

    return normalizeTaskContract({
      ...draft,
      task_id: draft.id,
      modelTier: routing.modelTier,
      model_tier: routing.modelTier,
      routingReason: routing.reasoning,
    });
  });
  const dependencies = tasks.flatMap((task) =>
    task.dependsOn.map((dependencyId) => ({
      from: dependencyId,
      to: task.id,
    }))
  );
  const approval = createApprovalGate(tasks);
  const estimatedCost = DEFAULT_ESTIMATED_COST;
  const riskSummary = summarizeRisk(tasks);
  const planningPrompt = createPlanningPrompt({ request: request.trim() });
  const basePlan = {
    schemaVersion: "runtime.plan.v1",
    planId,
    request: request.trim(),
    createdAt,
    modelTiers: MODEL_TIERS,
    tasks,
    dependencies,
    approvalRequired: approval.required,
    approval_required: approval.required,
    approval,
    planningPrompt,
    planning_prompt: planningPrompt,
    estimatedCost,
    estimated_cost: estimatedCost,
    riskSummary,
    risk_summary: riskSummary,
    status: "planned",
  };
  const taskGraph = createTaskGraph({
    runId: null,
    tasks,
    dependencies,
    approvalRequired: approval.required,
    estimatedCost,
    riskSummary,
  });
  const candidatePlan = {
    ...basePlan,
    taskGraph,
    task_graph: taskGraph,
  };
  const validation = validateRuntimePlan(candidatePlan);
  const plan = {
    ...candidatePlan,
    validation,
  };
  const planReport = createPlanReport(plan);

  return {
    ...plan,
    planReport,
    plan_report: planReport,
  };
}

function createDefaultTaskDrafts(request) {
  if (isReadOnlyPlanningRequest(request)) {
    return createReadOnlyTaskDrafts(request);
  }

  return createImplementationTaskDrafts(request);
}

function createReadOnlyTaskDrafts(request) {
  return [
    {
      id: "T-001",
      title: "读取项目结构与需求上下文",
      goal: `Understand the workspace and clarify the requested outcome: ${request}`,
      difficulty: "L0",
      risk: "low",
      contextNeed: "low",
      verification: "easy",
      dependsOn: [],
      allowedFiles: [],
      forbiddenActions: ["modify files", "call external model providers"],
      acceptance: [
        "workspace structure is summarized",
        "request is preserved in the run trace",
      ],
      expectedOutput: ["workspace summary", "planning notes"],
    },
    {
      id: "T-002",
      title: "生成只读任务合同与约束",
      goal: "Turn the request into read-only task contracts that do not authorize file changes.",
      difficulty: "L1",
      risk: "low",
      contextNeed: "low",
      verification: "easy",
      dependsOn: ["T-001"],
      allowedFiles: [],
      forbiddenActions: [
        "modify files",
        "execute worker changes",
        "call external model providers",
      ],
      acceptance: [
        "task contracts describe read-only work",
        "no task grants file modification scope",
      ],
      expectedOutput: ["read-only task contracts", "dependency list"],
    },
    {
      id: "T-003",
      title: "输出只读计划审查报告",
      goal: "Prepare a plan review output that can be inspected without requiring execution approval.",
      difficulty: "L1",
      risk: "low",
      contextNeed: "low",
      verification: "easy",
      dependsOn: ["T-002"],
      allowedFiles: [],
      forbiddenActions: [
        "modify files",
        "claim execution has happened",
        "hide failed validation",
      ],
      acceptance: [
        "plan report includes task graph and routing",
        "approval metadata records that no human approval is required",
      ],
      expectedOutput: ["plan report", "routing notes", "verification notes"],
    },
  ];
}

function createImplementationTaskDrafts(request) {
  return [
    {
      id: "T-001",
      title: "读取项目结构与需求上下文",
      goal: `Understand the workspace and clarify the requested outcome: ${request}`,
      difficulty: "L0",
      risk: "low",
      contextNeed: "low",
      verification: "easy",
      dependsOn: [],
      allowedFiles: [],
      forbiddenActions: ["modify files", "call external model providers"],
      acceptance: [
        "workspace structure is summarized",
        "request is preserved in the run trace",
      ],
      expectedOutput: ["workspace summary", "planning notes"],
    },
    {
      id: "T-002",
      title: "生成任务合同与执行约束",
      goal: "Turn the request into explicit worker-safe task contracts.",
      difficulty: "L1",
      risk: "low",
      contextNeed: "low",
      verification: "easy",
      dependsOn: ["T-001"],
      allowedFiles: [],
      forbiddenActions: ["modify files outside an approved task contract"],
      acceptance: [
        "each executable task has acceptance criteria",
        "each executable task has forbidden actions",
      ],
      expectedOutput: ["task contracts", "dependency list"],
    },
    {
      id: "T-003",
      title: "实现核心代码变更",
      goal: "Apply the requested implementation inside the approved workspace scope.",
      difficulty: "L2",
      risk: "medium",
      contextNeed: "medium",
      verification: "medium",
      dependsOn: ["T-002"],
      allowedFiles: ["src/**", "tests/**"],
      forbiddenActions: [
        "edit files outside the approved allowlist",
        "perform destructive filesystem operations",
      ],
      acceptance: [
        "implementation matches the approved task contract",
        "changed files remain inside the allowlist",
      ],
      expectedOutput: ["patch", "implementation notes", "files touched"],
    },
    {
      id: "T-004",
      title: "补充测试与验证命令",
      goal: "Add or identify verification that proves the requested behavior.",
      difficulty: "L1",
      risk: "low",
      contextNeed: "medium",
      verification: "easy",
      dependsOn: ["T-003"],
      allowedFiles: ["tests/**", "package.json"],
      forbiddenActions: ["weaken existing assertions", "remove existing tests"],
      acceptance: [
        "verification command is recorded",
        "new behavior has test coverage when code changes are made",
      ],
      expectedOutput: ["test patch", "verification command"],
    },
    {
      id: "T-005",
      title: "运行验证并收集证据",
      goal: "Run configured checks and capture the evidence needed for final review.",
      difficulty: "L1",
      risk: "low",
      contextNeed: "low",
      verification: "easy",
      dependsOn: ["T-004"],
      allowedFiles: [],
      forbiddenActions: ["claim success without command output"],
      acceptance: [
        "verification results include command, exit code, and output summary",
        "failed verification blocks final success",
      ],
      expectedOutput: ["verification evidence", "failure summary if any"],
    },
    {
      id: "T-006",
      title: "最终审查与交付报告",
      goal: "Review the full run, explain routing decisions, and prepare the final report.",
      difficulty: "L4",
      risk: "high",
      contextNeed: "high",
      verification: "hard",
      finalVerification: true,
      dependsOn: ["T-005"],
      allowedFiles: [],
      forbiddenActions: ["skip final verification", "hide failed checks"],
      acceptance: [
        "final report includes task graph, routing, and verification evidence",
        "premium-tier final review is recorded",
      ],
      expectedOutput: ["final report", "risk notes", "follow-up recommendations"],
    },
  ];
}

function isReadOnlyPlanningRequest(request) {
  const normalized = request.toLowerCase();
  const readOnlyMarkers = [
    "plan only",
    "planning only",
    "estimate only",
    "dry run",
    "read-only",
    "readonly",
    "without modifying files",
    "without file changes",
    "do not modify files",
    "no file changes",
    "只读",
    "只规划",
    "仅规划",
    "只计划",
    "仅计划",
    "不修改文件",
    "不改动文件",
    "不写入文件",
    "不要修改文件",
  ];

  return readOnlyMarkers.some((marker) => normalized.includes(marker));
}

function difficultyAtLeast(actual, expected) {
  return (DIFFICULTY_ORDER.get(actual) ?? 1) >= (DIFFICULTY_ORDER.get(expected) ?? 1);
}

function summarizeRisk(tasks) {
  const counts = tasks.reduce(
    (accumulator, task) => {
      accumulator[task.risk] += 1;
      return accumulator;
    },
    { low: 0, medium: 0, high: 0 }
  );

  if (counts.high > 0) {
    return `high: ${counts.high} high-risk task(s), ${counts.medium} medium-risk task(s), ${counts.low} low-risk task(s)`;
  }

  if (counts.medium > 0) {
    return `medium: ${counts.medium} medium-risk task(s), ${counts.low} low-risk task(s)`;
  }

  return `low: ${counts.low} low-risk task(s)`;
}

function createId(prefix, request, createdAt) {
  const input = `${prefix}:${createdAt}:${request}`;
  let hash = 0;

  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }

  return `${prefix}_${createdAt.replace(/[-:.TZ]/g, "").slice(0, 14)}_${hash.toString(36)}`;
}
