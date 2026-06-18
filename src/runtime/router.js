export const MODEL_TIER_ALIASES = {
  cheap: "cheap",
  standard: "standard",
  premium: "premium",
};

export const DEFAULT_MODEL_TIERS = [
  {
    id: MODEL_TIER_ALIASES.cheap,
    label: "Cheap",
    description: "Low-cost tier for read-only analysis and low-risk generation.",
  },
  {
    id: MODEL_TIER_ALIASES.standard,
    label: "Standard",
    description: "Balanced tier for local code changes with ordinary risk.",
  },
  {
    id: MODEL_TIER_ALIASES.premium,
    label: "Premium",
    description: "Strong tier for high-risk work, hard verification, and final review.",
  },
];

export const DEFAULT_MODEL_REGISTRY = [
  {
    provider: "runtime-default",
    model: "cheap-placeholder",
    tier: MODEL_TIER_ALIASES.cheap,
    cost_hint: {
      label: "low",
      estimated_usd_per_call: 0.01,
    },
    context_window: 32000,
    tool_support: ["read", "summarize", "extract"],
    strengths: ["read-only analysis", "summaries", "simple generation"],
    blocked_task_types: ["file_edit", "security", "migration", "final_verification"],
  },
  {
    provider: "runtime-default",
    model: "standard-placeholder",
    tier: MODEL_TIER_ALIASES.standard,
    cost_hint: {
      label: "medium",
      estimated_usd_per_call: 0.05,
    },
    context_window: 128000,
    tool_support: ["read", "patch", "test", "summarize"],
    strengths: ["local code changes", "tests", "bounded refactors"],
    blocked_task_types: ["security", "migration", "final_verification"],
  },
  {
    provider: "runtime-default",
    model: "premium-placeholder",
    tier: MODEL_TIER_ALIASES.premium,
    cost_hint: {
      label: "high",
      estimated_usd_per_call: 0.2,
    },
    context_window: 256000,
    tool_support: ["read", "patch", "test", "review", "plan"],
    strengths: ["architecture", "security review", "cross-module changes", "final verification"],
    blocked_task_types: [],
  },
];

export const DEFAULT_ROUTING_POLICY = {
  finalVerificationTier: MODEL_TIER_ALIASES.premium,
  fileEditingMinTier: MODEL_TIER_ALIASES.standard,
  lowConfidenceThreshold: 0.6,
  difficultyMinTier: {
    L0: MODEL_TIER_ALIASES.cheap,
    L1: MODEL_TIER_ALIASES.cheap,
    L2: MODEL_TIER_ALIASES.standard,
    L3: MODEL_TIER_ALIASES.premium,
    L4: MODEL_TIER_ALIASES.premium,
  },
  riskMinTier: {
    low: MODEL_TIER_ALIASES.cheap,
    medium: MODEL_TIER_ALIASES.standard,
    high: MODEL_TIER_ALIASES.premium,
  },
  contextMinTier: {
    low: MODEL_TIER_ALIASES.cheap,
    medium: MODEL_TIER_ALIASES.standard,
    high: MODEL_TIER_ALIASES.premium,
  },
  verificationMinTier: {
    easy: MODEL_TIER_ALIASES.cheap,
    medium: MODEL_TIER_ALIASES.standard,
    hard: MODEL_TIER_ALIASES.premium,
  },
};

export const DEFAULT_BUDGET_POLICY = {
  currency: "USD",
  maxCostPerRun: 1,
  maxCallsPerRun: 20,
  maxRetryCount: 8,
};

export const DEFAULT_ESCALATION_POLICY = {
  triggers: [
    "failed_tests",
    "malformed_output",
    "forbidden_file_access",
    "low_classifier_confidence",
    "user_policy_violation",
  ],
  tierOrder: [
    MODEL_TIER_ALIASES.cheap,
    MODEL_TIER_ALIASES.standard,
    MODEL_TIER_ALIASES.premium,
  ],
  humanApprovalReasons: ["user_policy_violation", "forbidden_file_access"],
};

const DIFFICULTIES = new Set(["L0", "L1", "L2", "L3", "L4"]);
const RISKS = new Set(["low", "medium", "high"]);
const CONTEXT_NEEDS = new Set(["low", "medium", "high"]);
const VERIFICATION_LEVELS = new Set(["easy", "medium", "hard"]);
const TIER_RANK = new Map([
  [MODEL_TIER_ALIASES.cheap, 0],
  [MODEL_TIER_ALIASES.standard, 1],
  [MODEL_TIER_ALIASES.premium, 2],
]);

export function classifyTask(task = {}) {
  const difficulty = normalizeChoice(task.difficulty, DIFFICULTIES, "L1");
  const risk = normalizeChoice(task.risk, RISKS, "low");
  const contextNeed = normalizeChoice(task.contextNeed ?? task.context_need, CONTEXT_NEEDS, "low");
  const verification = normalizeChoice(task.verification, VERIFICATION_LEVELS, "easy");
  const allowedFiles = task.allowedFiles ?? task.allowed_files ?? [];
  const editsFiles = Array.isArray(allowedFiles) && allowedFiles.length > 0;
  const explicitConfidence = task.classifierConfidence ?? task.confidence;
  const confidence =
    typeof explicitConfidence === "number"
      ? clamp(explicitConfidence, 0, 1)
      : deriveConfidence(task, { difficulty, risk, contextNeed, verification, editsFiles });

  const reasoning = [
    `difficulty=${difficulty}`,
    `risk=${risk}`,
    `context_need=${contextNeed}`,
    `verification=${verification}`,
    editsFiles ? "task edits files" : "task is read-only or review-only",
  ];

  return {
    difficulty,
    risk,
    context_need: contextNeed,
    contextNeed,
    verification,
    edits_files: editsFiles,
    editsFiles,
    confidence,
    reasoning,
  };
}

export function routeTask(task = {}, options = {}) {
  const routingPolicy = {
    ...DEFAULT_ROUTING_POLICY,
    ...(options.routingPolicy ?? {}),
  };
  const modelRegistry = options.modelRegistry ?? DEFAULT_MODEL_REGISTRY;
  const classification = classifyTask(task);
  const finalVerification = task.finalVerification === true || task.final_verification === true;
  const candidates = [];
  const routingReason = [];
  const escalationTriggers = defaultEscalationTriggers(classification.difficulty);

  addTierCandidate(
    candidates,
    routingReason,
    routingPolicy.difficultyMinTier[classification.difficulty],
    `${classification.difficulty} default routing tier`
  );
  addTierCandidate(
    candidates,
    routingReason,
    routingPolicy.riskMinTier[classification.risk],
    `${classification.risk}-risk minimum tier`
  );
  addTierCandidate(
    candidates,
    routingReason,
    routingPolicy.contextMinTier[classification.context_need],
    `${classification.context_need} context requirement`
  );
  addTierCandidate(
    candidates,
    routingReason,
    routingPolicy.verificationMinTier[classification.verification],
    `${classification.verification} verification strength`
  );

  if (classification.edits_files) {
    addTierCandidate(
      candidates,
      routingReason,
      strongestTier(routingPolicy.fileEditingMinTier, MODEL_TIER_ALIASES.standard),
      "file-editing tasks require at least the standard tier"
    );
  }

  if (finalVerification) {
    addTierCandidate(
      candidates,
      routingReason,
      strongestTier(routingPolicy.finalVerificationTier, MODEL_TIER_ALIASES.premium),
      "final verification always uses the premium tier"
    );
    escalationTriggers.push("final_review");
  }

  if (classification.confidence < routingPolicy.lowConfidenceThreshold) {
    escalationTriggers.push("low_classifier_confidence");
  }

  const modelTier = maxTier(candidates.length > 0 ? candidates : [MODEL_TIER_ALIASES.cheap]);
  const selectedModel = selectModelForTier(modelRegistry, modelTier);
  const reasoning =
    routingReason.length > 0 ? routingReason : ["low-risk, easy-to-verify task can use the cheap tier"];
  const taskId = task.task_id ?? task.id ?? null;

  return {
    taskId,
    task_id: taskId,
    modelTier,
    model_tier: modelTier,
    selectedModel,
    selected_model: selectedModel,
    classification,
    routingReason: reasoning,
    reasoning,
    escalationTriggers: unique(escalationTriggers),
    escalation_triggers: unique(escalationTriggers),
    routing: {
      task_id: taskId,
      model_tier: modelTier,
      selected_model: selectedModel,
      classification,
      reason: reasoning.join("; "),
      reasons: reasoning,
      escalation_triggers: unique(escalationTriggers),
    },
  };
}

export function routePlan(tasks, options = {}) {
  const routes = tasks.map((task) => routeTask(task, options));
  const budgetStatus = evaluateBudgetPolicy({
    routes,
    budgetPolicy: options.budgetPolicy,
  });

  return {
    routes,
    budgetStatus,
    routingTrace: routes.map((route) => route.routing),
  };
}

export function evaluateBudgetPolicy({ routes = [], budgetPolicy = DEFAULT_BUDGET_POLICY } = {}) {
  const policy = {
    ...DEFAULT_BUDGET_POLICY,
    ...(budgetPolicy ?? {}),
  };
  const estimatedCost = roundCurrency(
    routes.reduce((total, route) => total + modelCost(route.selectedModel), 0)
  );
  const estimatedCalls = routes.length;
  const estimatedRetries = routes.filter((route) => route.modelTier !== MODEL_TIER_ALIASES.premium).length;
  const violations = [];

  if (estimatedCost > policy.maxCostPerRun) {
    violations.push({
      code: "budget.cost.exceeded",
      limit: policy.maxCostPerRun,
      actual: estimatedCost,
      message: `Estimated model cost ${estimatedCost} exceeds maxCostPerRun ${policy.maxCostPerRun}.`,
    });
  }

  if (estimatedCalls > policy.maxCallsPerRun) {
    violations.push({
      code: "budget.calls.exceeded",
      limit: policy.maxCallsPerRun,
      actual: estimatedCalls,
      message: `Estimated model calls ${estimatedCalls} exceeds maxCallsPerRun ${policy.maxCallsPerRun}.`,
    });
  }

  if (estimatedRetries > policy.maxRetryCount) {
    violations.push({
      code: "budget.retries.exceeded",
      limit: policy.maxRetryCount,
      actual: estimatedRetries,
      message: `Reserved retry count ${estimatedRetries} exceeds maxRetryCount ${policy.maxRetryCount}.`,
    });
  }

  return {
    allowed: violations.length === 0,
    currency: policy.currency,
    estimatedCost,
    estimated_cost: estimatedCost,
    estimatedCalls,
    estimated_calls: estimatedCalls,
    estimatedRetries,
    estimated_retries: estimatedRetries,
    maxCostPerRun: policy.maxCostPerRun,
    max_cost_per_run: policy.maxCostPerRun,
    maxCallsPerRun: policy.maxCallsPerRun,
    max_calls_per_run: policy.maxCallsPerRun,
    maxRetryCount: policy.maxRetryCount,
    max_retry_count: policy.maxRetryCount,
    violations,
  };
}

export function evaluateEscalation({
  task = {},
  route = routeTask(task),
  outcome = {},
  escalationPolicy = DEFAULT_ESCALATION_POLICY,
} = {}) {
  const fromTier = route.modelTier ?? route.model_tier ?? MODEL_TIER_ALIASES.cheap;
  const reasons = collectEscalationReasons(route, outcome, escalationPolicy);
  const shouldEscalate = reasons.length > 0;
  const toTier = shouldEscalate ? nextTier(fromTier, escalationPolicy.tierOrder) : fromTier;
  const taskId = task.task_id ?? task.id ?? route.task_id ?? route.taskId ?? null;
  const requiresHumanApproval =
    reasons.some((reason) => escalationPolicy.humanApprovalReasons.includes(reason)) ||
    task.risk === "high" ||
    task.difficulty === "L4";

  return {
    shouldEscalate,
    should_escalate: shouldEscalate,
    fromTier,
    from_tier: fromTier,
    toTier,
    to_tier: toTier,
    reasons,
    requiresHumanApproval,
    requires_human_approval: requiresHumanApproval,
    trace: {
      task_id: taskId,
      from_tier: fromTier,
      to_tier: toTier,
      reasons,
      requires_human_approval: requiresHumanApproval,
    },
  };
}

function defaultEscalationTriggers(difficulty) {
  switch (difficulty) {
    case "L0":
      return ["missing_result", "conflicting_result"];
    case "L1":
      return ["invalid_patch", "failed_checks"];
    case "L2":
      return ["failed_tests", "uncertain_diff"];
    case "L3":
      return ["final_review"];
    case "L4":
      return ["human_approval"];
    default:
      return [];
  }
}

function collectEscalationReasons(route, outcome, policy) {
  const reasons = [];

  if (outcome.failedTests) {
    reasons.push("failed_tests");
  }
  if (outcome.malformedOutput) {
    reasons.push("malformed_output");
  }
  if (outcome.forbiddenFileAccess) {
    reasons.push("forbidden_file_access");
  }
  if (outcome.userPolicyViolation) {
    reasons.push("user_policy_violation");
  }
  if (
    outcome.lowClassifierConfidence ||
    route.classification?.confidence < DEFAULT_ROUTING_POLICY.lowConfidenceThreshold
  ) {
    reasons.push("low_classifier_confidence");
  }

  return unique(reasons).filter((reason) => policy.triggers.includes(reason));
}

function normalizeChoice(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function addTierCandidate(candidates, routingReason, tier, reason) {
  if (!tier) {
    return;
  }

  candidates.push(tier);
  routingReason.push(reason);
}

function maxTier(tiers) {
  return tiers.reduce((best, tier) => {
    const bestRank = TIER_RANK.get(best) ?? 0;
    const tierRank = TIER_RANK.get(tier) ?? 0;
    return tierRank > bestRank ? tier : best;
  }, MODEL_TIER_ALIASES.cheap);
}

function strongestTier(left, right) {
  return maxTier([left, right]);
}

function nextTier(currentTier, tierOrder) {
  const index = tierOrder.indexOf(currentTier);
  if (index === -1 || index === tierOrder.length - 1) {
    return MODEL_TIER_ALIASES.premium;
  }

  return tierOrder[index + 1];
}

function selectModelForTier(modelRegistry, tier) {
  return modelRegistry.find((entry) => entry.tier === tier) ?? DEFAULT_MODEL_REGISTRY.at(-1);
}

function modelCost(model) {
  const value = model?.cost_hint?.estimated_usd_per_call;
  return typeof value === "number" ? value : 0;
}

function roundCurrency(value) {
  return Math.round(value * 10000) / 10000;
}

function deriveConfidence(task, classification) {
  const explicitFieldCount = [
    task.difficulty,
    task.risk,
    task.contextNeed ?? task.context_need,
    task.verification,
  ].filter(Boolean).length;
  const base = explicitFieldCount === 4 ? 0.9 : 0.72;
  const complexityPenalty =
    classification.difficulty === "L4" ||
    classification.risk === "high" ||
    classification.verification === "hard"
      ? 0.08
      : 0;

  return clamp(base - complexityPenalty, 0.3, 0.95);
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function unique(items) {
  return Array.from(new Set(items));
}
