import {
  createApprovalGate,
  createPlanningPrompt,
  createPlanReport,
  createTaskGraph,
  normalizeTaskContract,
  validateRuntimePlan,
} from "./contracts.js";
import {
  DEFAULT_BUDGET_POLICY,
  DEFAULT_ESCALATION_POLICY,
  DEFAULT_MODEL_REGISTRY,
  DEFAULT_MODEL_TIERS as MODEL_TIERS,
  DEFAULT_ROUTING_POLICY,
  MODEL_TIER_ALIASES,
  routePlan,
  routeTask as routeTaskWithPolicy,
} from "./router.js";
import {
  budgetPolicyFromPolicy,
  evaluateRunPolicy,
  normalizePolicyConfig,
  redactSecrets,
  validatePolicyConfig,
} from "./policy.js";

const DEFAULT_ESTIMATED_COST = {
  currency: "USD",
  minimum: 0,
  maximum: 0,
  note: "V0 skeleton records routing tiers but does not call real model providers.",
};

export function routeTask(task) {
  return routeTaskWithPolicy(task);
}

export function createRuntimePlan({
  request,
  now = new Date(),
  modelRegistry = DEFAULT_MODEL_REGISTRY,
  routingPolicy = DEFAULT_ROUTING_POLICY,
  budgetPolicy = DEFAULT_BUDGET_POLICY,
  escalationPolicy = DEFAULT_ESCALATION_POLICY,
  policyViolations = [],
  policy = undefined,
  policyExplicit = undefined,
  policyValidation = undefined,
  verification = {},
} = {}) {
  if (!request || typeof request !== "string" || request.trim().length === 0) {
    throw new TypeError("createRuntimePlan requires a non-empty request string.");
  }

  const effectiveRoutingPolicy = mergeRoutingPolicy(routingPolicy);
  const hasPolicyConfig = policyExplicit === undefined ? policy !== undefined : policyExplicit === true;
  const policyConfig = normalizePolicyConfig(policy);
  const effectivePolicyValidation = policyValidation ?? validatePolicyConfig(policyConfig);
  const legacyBudgetPolicy = {
    ...DEFAULT_BUDGET_POLICY,
    ...(budgetPolicy ?? {}),
  };
  const effectiveBudgetPolicy = hasPolicyConfig
    ? budgetPolicyFromPolicy(policyConfig, legacyBudgetPolicy)
    : legacyBudgetPolicy;
  const effectiveEscalationPolicy = {
    ...DEFAULT_ESCALATION_POLICY,
    ...(escalationPolicy ?? {}),
  };
  const effectiveModelRegistry = Array.isArray(modelRegistry) ? modelRegistry : DEFAULT_MODEL_REGISTRY;
  const createdAt = now.toISOString();
  const planId = createId("plan", request, createdAt);
  const taskDrafts = createDefaultTaskDrafts(request.trim());
  const routedPlan = routePlan(taskDrafts, {
    modelRegistry: effectiveModelRegistry,
    routingPolicy: effectiveRoutingPolicy,
    budgetPolicy: effectiveBudgetPolicy,
  });
  const tasks = taskDrafts.map((draft, index) => {
    const routing = routedPlan.routes[index];

    return normalizeTaskContract({
      ...draft,
      task_id: draft.id,
      modelTier: routing.modelTier,
      model_tier: routing.modelTier,
      routingReason: routing.routingReason,
      classification: routing.classification,
      routing: routing.routing,
    });
  });
  const policyStatus = evaluateRunPolicy({
    policy: policyConfig,
    policyValidation: effectivePolicyValidation,
    tasks,
    budgetStatus: routedPlan.budgetStatus,
    verification,
  });
  if (Array.isArray(policyViolations) && policyViolations.length > 0) {
    policyStatus.violations.push(...policyViolations);
    policyStatus.allowed = false;
  }
  const dependencies = tasks.flatMap((task) =>
    task.dependsOn.map((dependencyId) => ({
      from: dependencyId,
      to: task.id,
    }))
  );
  const approval = createApprovalGate(tasks);
  const estimatedCost = createEstimatedCost(routedPlan.budgetStatus);
  const riskSummary = summarizeRisk(tasks);
  const planningPrompt = createPlanningPrompt({ request: request.trim() });
  const basePlan = {
    schemaVersion: "runtime.plan.v1",
    planId,
    request: request.trim(),
    createdAt,
    modelTiers: MODEL_TIERS,
    modelTierAliases: MODEL_TIER_ALIASES,
    model_tier_aliases: MODEL_TIER_ALIASES,
    modelRegistry: effectiveModelRegistry,
    model_registry: effectiveModelRegistry,
    routingPolicy: effectiveRoutingPolicy,
    routing_policy: effectiveRoutingPolicy,
    budgetPolicy: effectiveBudgetPolicy,
    budget_policy: effectiveBudgetPolicy,
    escalationPolicy: effectiveEscalationPolicy,
    escalation_policy: effectiveEscalationPolicy,
    policyConfig,
    policy_config: policyConfig,
    policyValidation: effectivePolicyValidation,
    policy_validation: effectivePolicyValidation,
    budgetStatus: routedPlan.budgetStatus,
    budget_status: routedPlan.budgetStatus,
    policyStatus,
    policy_status: policyStatus,
    routingTrace: routedPlan.routingTrace,
    routing_trace: routedPlan.routingTrace,
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

  return redactSecrets({
    ...plan,
    planReport,
    plan_report: planReport,
  }, policyConfig);
}

function mergeRoutingPolicy(routingPolicy) {
  const override = routingPolicy ?? {};

  return {
    ...DEFAULT_ROUTING_POLICY,
    ...override,
    difficultyMinTier: {
      ...DEFAULT_ROUTING_POLICY.difficultyMinTier,
      ...(override.difficultyMinTier ?? {}),
    },
    riskMinTier: {
      ...DEFAULT_ROUTING_POLICY.riskMinTier,
      ...(override.riskMinTier ?? {}),
    },
    contextMinTier: {
      ...DEFAULT_ROUTING_POLICY.contextMinTier,
      ...(override.contextMinTier ?? {}),
    },
    verificationMinTier: {
      ...DEFAULT_ROUTING_POLICY.verificationMinTier,
      ...(override.verificationMinTier ?? {}),
    },
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
  const taskScope = deriveImplementationTaskScope(request);

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
      allowedFiles: taskScope.implementationAllowedFiles,
      referencedFiles: taskScope.referencedFiles,
      contextSelectors: taskScope.contextSelectors,
      forbiddenActions: [
        "edit files outside the approved allowlist",
        "perform destructive filesystem operations",
      ],
      acceptance: [
        "implementation matches the approved task contract",
        "changed files remain inside the allowlist",
        ...taskScope.acceptance,
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
      allowedFiles: taskScope.verificationAllowedFiles,
      referencedFiles: taskScope.referencedFiles,
      contextSelectors: taskScope.contextSelectors,
      forbiddenActions: ["weaken existing assertions", "remove existing tests"],
      acceptance: [
        "verification command is recorded",
        "new behavior has test coverage when code changes are made",
        ...taskScope.acceptance,
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

function deriveImplementationTaskScope(request) {
  const normalized = request.toLowerCase();
  const mentionedPaths = extractMentionedPaths(request);
  const mentionedFiles = mentionedPaths.filter((entry) => !entry.endsWith("/"));
  const documentationFiles = mentionedFiles.filter(isDocumentationPath);

  if (isTestsOnlyRequest(normalized)) {
    const focusedTestFiles = deriveFocusedTestFiles(normalized, mentionedFiles);
    const referencedFiles = uniqueStrings([
      ...mentionedFiles.filter((entry) => !isTestPath(entry)),
      ...(normalized.includes("runtime config") ? ["runtime.config.json"] : []),
    ]);

    return {
      implementationAllowedFiles: focusedTestFiles,
      verificationAllowedFiles: focusedTestFiles,
      referencedFiles,
      contextSelectors: createReferencedContextSelectors(normalized, referencedFiles),
      acceptance: createFocusedTestAcceptance(normalized, referencedFiles),
    };
  }

  if (documentationFiles.length > 0 && isDocumentationOnlyRequest(normalized)) {
    return {
      implementationAllowedFiles: documentationFiles,
      verificationAllowedFiles: documentationFiles,
      referencedFiles: [],
      contextSelectors: {},
      acceptance: [],
    };
  }

  return {
    implementationAllowedFiles: ["src/**", "tests/**"],
    verificationAllowedFiles: ["tests/**", "package.json"],
    referencedFiles: [],
    contextSelectors: {},
    acceptance: [],
  };
}

function deriveFocusedTestFiles(normalized, mentionedFiles) {
  const explicitTestFiles = mentionedFiles.filter(
    (entry) => isTestPath(entry) && entry !== "tests/"
  );
  if (explicitTestFiles.length > 0) {
    return explicitTestFiles;
  }

  if (
    includesAny(normalized, [
      "runtime config",
      "runtime.config.json",
      "defaultmodel",
      "final_review model",
      "final review model",
      "openai-compatible provider",
      "\u8fd0\u884c\u65f6\u914d\u7f6e",
      "\u914d\u7f6e\u8bfb\u53d6",
    ])
  ) {
    return ["tests/providers.test.js"];
  }

  return ["tests/**"];
}

function createReferencedContextSelectors(normalized, referencedFiles) {
  const selectors = {};

  if (
    referencedFiles.includes("runtime.config.json") &&
    includesAny(normalized, [
      "runtime config",
      "runtime.config.json",
      "defaultmodel",
      "final_review model",
      "final review model",
      "openai-compatible provider",
      "\u8fd0\u884c\u65f6\u914d\u7f6e",
      "\u914d\u7f6e\u8bfb\u53d6",
    ])
  ) {
    selectors["runtime.config.json"] = [
      "providers.entries.openai-compatible.defaultModel",
      "verification.final_review.model",
    ];
  }

  return selectors;
}

function createFocusedTestAcceptance(normalized, referencedFiles) {
  if (
    referencedFiles.includes("runtime.config.json") &&
    includesAny(normalized, [
      "runtime config",
      "runtime.config.json",
      "defaultmodel",
      "final_review model",
      "final review model",
      "openai-compatible provider",
      "\u8fd0\u884c\u65f6\u914d\u7f6e",
      "\u914d\u7f6e\u8bfb\u53d6",
    ])
  ) {
    return [
      "focused test verifies config.providers.entries[\"openai-compatible\"].defaultModel is read from runtime.config.json",
      "focused test verifies config.verification.final_review.model is read from runtime.config.json",
    ];
  }

  return [];
}

function isDocumentationOnlyRequest(normalized) {
  return includesAny(normalized, [
    "documentation only",
    "docs only",
    "only documentation",
    "only modify docs",
    "only edit docs",
    "do not modify src/",
    "do not modify src",
    "do not change src/",
    "without modifying src",
    "wording fix",
    "smallest wording",
    "\u4e0d\u8981\u4fee\u6539 src/",
    "\u4e0d\u8981\u4fee\u6539 src",
    "\u4e0d\u4fee\u6539 src/",
    "\u4ec5\u4fee\u6539\u6587\u6863",
    "\u4ec5\u6539\u6587\u6863",
    "\u53ea\u4fee\u6539\u6587\u6863",
    "\u53ea\u6539\u6587\u6863",
  ]);
}

function isTestsOnlyRequest(normalized) {
  return includesAny(normalized, [
    "only modify tests/",
    "only modify test",
    "tests only",
    "test-only",
    "only edit tests/",
    "\u53ea\u4fee\u6539 tests/",
    "\u53ea\u6539 tests/",
    "\u53ea\u4fee\u6539\u6d4b\u8bd5",
    "\u53ea\u6539\u6d4b\u8bd5",
    "\u4ec5\u4fee\u6539\u6d4b\u8bd5",
    "\u4ec5\u6539\u6d4b\u8bd5",
  ]);
}

function extractMentionedPaths(request) {
  const matches = request.match(
    /(?:README\.md|package\.json|runtime\.config\.json|docs\/[A-Za-z0-9._/-]+|src\/[A-Za-z0-9._/-]*|tests\/[A-Za-z0-9._/-]*)/gi
  );

  if (!matches) {
    return [];
  }

  return uniqueStrings(matches.map(normalizeMentionedPath).filter(Boolean));
}

function normalizeMentionedPath(entry) {
  const normalized = String(entry).replace(/[),.;:!?]+$/g, "");

  if (normalized === "src/" || normalized === "tests/" || normalized === "docs/") {
    return normalized;
  }

  return normalized;
}

function isDocumentationPath(entry) {
  return entry === "README.md" || entry.startsWith("docs/") || entry.endsWith(".md");
}

function isTestPath(entry) {
  return entry === "tests/" || entry.startsWith("tests/");
}

function includesAny(value, markers) {
  return markers.some((marker) => value.includes(marker));
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
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

function createEstimatedCost(budgetStatus) {
  return {
    ...DEFAULT_ESTIMATED_COST,
    currency: budgetStatus.currency,
    maximum: budgetStatus.estimatedCost,
    note: "V0 estimates routing cost from model tier hints but does not call real model providers.",
  };
}

function createId(prefix, request, createdAt) {
  const input = `${prefix}:${createdAt}:${request}`;
  let hash = 0;

  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }

  return `${prefix}_${createdAt.replace(/[-:.TZ]/g, "").slice(0, 14)}_${hash.toString(36)}`;
}
