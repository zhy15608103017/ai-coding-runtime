import { DEFAULT_MODEL_REGISTRY, MODEL_TIER_ALIASES } from "./router.js";

const TIER_ORDER = [MODEL_TIER_ALIASES.cheap, MODEL_TIER_ALIASES.standard, MODEL_TIER_ALIASES.premium];
const DIFFICULTIES = new Set(["L0", "L1", "L2", "L3", "L4"]);
const RISKS = new Set(["low", "medium", "high"]);
const CONTEXT_NEEDS = new Set(["low", "medium", "high"]);
const VERIFICATION_LEVELS = new Set(["easy", "medium", "hard"]);

export async function runShadowClassifier(plan, options = {}) {
  const config = resolveShadowClassifierConfig(options.policy?.shadowClassifier ?? options.policy?.shadow_classifier);
  if (config.enabled !== true || config.mode !== "shadow") {
    return createUnavailableResult({
      enabled: false,
      mode: "off",
      status: "disabled",
      warnings: config.warnings,
    });
  }

  if (!config.provider || !config.model) {
    return createUnavailableResult({
      enabled: true,
      mode: "shadow",
      provider: config.provider,
      model: config.model,
      status: "unavailable",
      warnings: [...config.warnings, "shadow_classifier.provider_required"],
    });
  }

  const generate = options.generate;
  if (typeof generate !== "function") {
    return createUnavailableResult({
      enabled: true,
      mode: "shadow",
      provider: config.provider,
      model: config.model,
      status: "unavailable",
      warnings: [...config.warnings, "shadow_classifier.generate_required"],
    });
  }

  const request = createShadowClassifierRequest({ plan, config });
  let response;
  try {
    response = await generate(request, { providers: options.providers });
  } catch {
    return createUnavailableResult({
      enabled: true,
      mode: "shadow",
      provider: config.provider,
      model: config.model,
      status: "unavailable",
      warnings: [...config.warnings, "shadow_classifier.provider_failed"],
    });
  }

  try {
    const parsed = parseClassifierResponse(response);
    const recommendations = normalizeRecommendations({
      plan,
      rawRecommendations: parsed.recommendations,
      config,
      modelRegistry: options.modelRegistry,
    });
    return completeResult({
      config,
      recommendations,
      warnings: [...config.warnings, ...parsed.warnings],
      provider: response.provider ?? config.provider,
      model: response.model ?? config.model,
    });
  } catch {
    return createUnavailableResult({
      enabled: true,
      mode: "shadow",
      provider: config.provider,
      model: config.model,
      status: "unavailable",
      warnings: [...config.warnings, "shadow_classifier.output_malformed"],
    });
  }
}

export function createShadowClassifierRequest({ plan, config }) {
  const tasks = (plan.tasks ?? []).map((task) => {
    const route = findRoute(plan, task);
    const selectedModel = safeSelectedModel(route?.selected_model ?? route?.selectedModel);
    const allowedFiles = task.allowed_files ?? task.allowedFiles ?? [];
    const referencedFiles = task.referenced_files ?? task.referencedFiles ?? [];
    const forbiddenActions = task.forbidden_actions ?? task.forbiddenActions ?? [];
    const acceptance = task.acceptance ?? [];
    const expectedOutput = task.expected_output ?? task.expectedOutput ?? [];
    return {
      task_id: task.task_id ?? task.id,
      title_length: textLength(task.title),
      goal_length: textLength(task.goal),
      acceptance_count: Array.isArray(acceptance) ? acceptance.length : 0,
      expected_output_count: Array.isArray(expectedOutput) ? expectedOutput.length : 0,
      forbidden_actions_count: Array.isArray(forbiddenActions) ? forbiddenActions.length : 0,
      allowed_files_count: Array.isArray(allowedFiles) ? allowedFiles.length : 0,
      referenced_files_count: Array.isArray(referencedFiles) ? referencedFiles.length : 0,
      edits_files: Array.isArray(allowedFiles) && allowedFiles.length > 0,
      final_verification: task.final_verification === true || task.finalVerification === true,
      deterministic_classification: route?.classification ?? task.classification ?? null,
      deterministic_tier: route?.model_tier ?? route?.modelTier ?? task.model_tier ?? task.modelTier,
      selected_model: selectedModel,
      safety_floor_tier: safetyFloorForTask({ task, route }),
    };
  });

  return {
    provider: config.provider,
    model: config.model,
    temperature: 0,
    maxTokens: 2048,
    messages: [
      {
        role: "system",
        content:
          "You are AI Coding Runtime's shadow task classifier. Return JSON only. Use only the metadata provided. Do not request or infer file contents, credentials, patches, command output, or raw prompts.",
      },
      {
        role: "user",
        content: JSON.stringify({
          objective:
            "Recommend advisory model tiers for cost visibility. These recommendations will not change live routing.",
          allowed_tiers: TIER_ORDER,
          tasks,
          output_schema: {
            recommendations: [
              {
                task_id: "string",
                difficulty: "L0|L1|L2|L3|L4",
                risk: "low|medium|high",
                context_need: "low|medium|high",
                verification: "easy|medium|hard",
                recommended_tier: "cheap|standard|premium",
                confidence: 0.8,
                reasoning: ["short reason"],
              },
            ],
          },
        }),
      },
    ],
  };
}

function resolveShadowClassifierConfig(input = {}) {
  return {
    enabled: input.enabled === true,
    mode: input.enabled === true ? input.mode ?? "shadow" : "off",
    provider: input.provider ?? null,
    model: input.model ?? null,
    minConfidence: typeof input.minConfidence === "number" ? input.minConfidence : input.min_confidence ?? 0.7,
    warnings: Array.isArray(input.warnings) ? input.warnings.filter((item) => typeof item === "string") : [],
  };
}

function parseClassifierResponse(response = {}) {
  const structured = response.structuredOutput ?? response.structured_output;
  if (structured !== undefined) {
    return {
      recommendations: Array.isArray(structured?.recommendations)
        ? structured.recommendations
        : Array.isArray(structured)
          ? structured
          : [],
      warnings: [],
    };
  }

  const text = response.text ?? response.content ?? response.message ?? "";
  const parsed = typeof text === "string" ? JSON.parse(text) : text;
  const recommendations = Array.isArray(parsed?.recommendations)
    ? parsed.recommendations
    : Array.isArray(parsed)
      ? parsed
      : [];
  return {
    recommendations,
    warnings: [],
  };
}

function normalizeRecommendations({ plan, rawRecommendations, config, modelRegistry = DEFAULT_MODEL_REGISTRY }) {
  const byTask = new Map(rawRecommendations.map((item) => [String(item.task_id ?? item.taskId ?? ""), item]));
  const validTaskIds = new Set((plan.tasks ?? []).map((task) => String(task.task_id ?? task.id)));
  const ignoredTaskIds = rawRecommendations
    .map((item) => String(item.task_id ?? item.taskId ?? ""))
    .filter((taskId) => taskId && !validTaskIds.has(taskId));
  return (plan.tasks ?? []).map((task) => {
    const taskId = task.task_id ?? task.id;
    const route = findRoute(plan, task);
    const raw = byTask.get(String(taskId)) ?? {};
    const deterministicClassification = route?.classification ?? task.classification ?? {};
    const deterministicTier = route?.model_tier ?? route?.modelTier ?? task.model_tier ?? task.modelTier;
    const safetyFloorTier = safetyFloorForTask({ task, route });
    const recommendedTier = normalizeChoice(raw.recommended_tier ?? raw.recommendedTier, TIER_ORDER, deterministicTier);
    const confidence = clamp(typeof raw.confidence === "number" ? raw.confidence : 0, 0, 1);
    const category = categorizeRecommendation({
      deterministicTier,
      recommendedTier,
      safetyFloorTier,
      confidence,
      minConfidence: config.minConfidence,
    });
    const savingsUsd = category === "potential_savings"
      ? roundCurrency(modelCost(modelRegistry, deterministicTier) - modelCost(modelRegistry, recommendedTier))
      : 0;

    return {
      taskId,
      task_id: taskId,
      deterministicTier,
      deterministic_tier: deterministicTier,
      recommendedTier,
      recommended_tier: recommendedTier,
      safetyFloorTier,
      safety_floor_tier: safetyFloorTier,
      category,
      confidence,
      savingsUsd,
      savings_usd: savingsUsd,
      classification: {
        difficulty: normalizeEnum(raw.difficulty, DIFFICULTIES, deterministicClassification.difficulty),
        risk: normalizeEnum(raw.risk, RISKS, deterministicClassification.risk),
        context_need: normalizeEnum(raw.context_need ?? raw.contextNeed, CONTEXT_NEEDS, deterministicClassification.context_need),
        verification: normalizeEnum(raw.verification, VERIFICATION_LEVELS, deterministicClassification.verification),
      },
      reasoning: normalizeReasoning(raw.reasoning),
      warnings: ignoredTaskIds.length > 0 ? ["shadow_classifier.ignored_unknown_task_ids"] : [],
    };
  });
}

function categorizeRecommendation({ deterministicTier, recommendedTier, safetyFloorTier, confidence, minConfidence }) {
  if (confidence < minConfidence) return "ignored_low_confidence";
  if (tierRank(recommendedTier) > tierRank(deterministicTier)) return "stronger_recommended";
  if (tierRank(recommendedTier) < tierRank(deterministicTier)) {
    if (tierRank(recommendedTier) < tierRank(safetyFloorTier)) return "blocked_by_safety_floor";
    return "potential_savings";
  }
  return "agree";
}

function completeResult({ config, recommendations, warnings, provider, model }) {
  const summary = {
    potentialSavingsUsd: roundCurrency(sum(recommendations.map((item) => item.savingsUsd))),
    potential_savings_usd: roundCurrency(sum(recommendations.map((item) => item.savingsUsd))),
    potentialSavingsTasks: countCategory(recommendations, "potential_savings"),
    potential_savings_tasks: countCategory(recommendations, "potential_savings"),
    blockedBySafetyFloorTasks: countCategory(recommendations, "blocked_by_safety_floor"),
    blocked_by_safety_floor_tasks: countCategory(recommendations, "blocked_by_safety_floor"),
    ignoredLowConfidenceTasks: countCategory(recommendations, "ignored_low_confidence"),
    ignored_low_confidence_tasks: countCategory(recommendations, "ignored_low_confidence"),
  };
  return withAliases({
    enabled: true,
    mode: "shadow",
    provider,
    model,
    status: "completed",
    minConfidence: config.minConfidence,
    min_confidence: config.minConfidence,
    summary,
    recommendations,
    warnings: unique(warnings),
  });
}

function createUnavailableResult({ enabled, mode, provider = null, model = null, status, warnings = [] }) {
  return withAliases({
    enabled,
    mode,
    provider,
    model,
    status,
    summary: {
      potentialSavingsUsd: 0,
      potential_savings_usd: 0,
      potentialSavingsTasks: 0,
      potential_savings_tasks: 0,
      blockedBySafetyFloorTasks: 0,
      blocked_by_safety_floor_tasks: 0,
      ignoredLowConfidenceTasks: 0,
      ignored_low_confidence_tasks: 0,
    },
    recommendations: [],
    warnings: unique(warnings),
  });
}

function withAliases(result) {
  return {
    ...result,
    summary: {
      ...result.summary,
    },
  };
}

function findRoute(plan, task) {
  const taskId = task.task_id ?? task.id;
  return (plan.routingTrace ?? plan.routing_trace ?? []).find(
    (route) => (route.task_id ?? route.taskId) === taskId
  );
}

function safetyFloorForTask({ task, route }) {
  if (task.final_verification === true || task.finalVerification === true) return MODEL_TIER_ALIASES.premium;
  const classification = route?.classification ?? task.classification ?? {};
  const allowedFiles = task.allowed_files ?? task.allowedFiles ?? [];
  if (classification.edits_files === true || (Array.isArray(allowedFiles) && allowedFiles.length > 0)) {
    return MODEL_TIER_ALIASES.standard;
  }
  if ((task.risk ?? classification.risk) === "high") return MODEL_TIER_ALIASES.premium;
  return MODEL_TIER_ALIASES.cheap;
}

function modelCost(modelRegistry, tier) {
  const model = (Array.isArray(modelRegistry) ? modelRegistry : DEFAULT_MODEL_REGISTRY).find((entry) => entry.tier === tier);
  const value = model?.cost_hint?.estimated_usd_per_call;
  return typeof value === "number" ? value : 0;
}

function normalizeChoice(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizeEnum(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback ?? null;
}

function normalizeReasoning(value) {
  return (Array.isArray(value) ? value : [])
    .filter((item) => typeof item === "string")
    .map((item) => item.slice(0, 160))
    .slice(0, 5);
}

function safeSelectedModel(selectedModel) {
  if (!selectedModel || typeof selectedModel !== "object" || Array.isArray(selectedModel)) return null;
  return {
    provider: stringOrNull(selectedModel.provider),
    model: stringOrNull(selectedModel.model),
    tier: normalizeChoice(selectedModel.tier, TIER_ORDER, null),
  };
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

function textLength(value) {
  return typeof value === "string" ? value.length : 0;
}

function tierRank(tier) {
  return Math.max(0, TIER_ORDER.indexOf(tier));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function countCategory(recommendations, category) {
  return recommendations.filter((item) => item.category === category).length;
}

function roundCurrency(value) {
  return Math.round(Math.max(0, value) * 10000) / 10000;
}

function unique(values) {
  return Array.from(new Set(values));
}
