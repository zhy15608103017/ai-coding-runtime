import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_BUDGET_POLICY,
  DEFAULT_MODEL_REGISTRY,
  DEFAULT_ROUTING_POLICY,
  MODEL_TIER_ALIASES,
} from "./router.js";
import { DEFAULT_PROVIDER_CONFIG } from "./providers.js";
import { normalizePolicyConfig, validatePolicyConfig } from "./policy.js";

export const DEFAULT_RUNTIME_CONFIG = {
  server: {
    host: "127.0.0.1",
    httpPort: 3847,
    mcpPath: "/mcp",
    apiToken: null,
  },
  storage: {
    directory: ".ai-coding-runtime",
  },
  routing: {
    modelTiers: ["cheap", "standard", "premium"],
    finalVerificationTier: "premium",
    modelTierAliases: MODEL_TIER_ALIASES,
    modelRegistry: DEFAULT_MODEL_REGISTRY,
    budgetPolicy: DEFAULT_BUDGET_POLICY,
    policy: DEFAULT_ROUTING_POLICY,
  },
  providers: DEFAULT_PROVIDER_CONFIG,
  policy: normalizePolicyConfig(),
  verification: {
    diff_check: {
      enabled: true,
      required: true,
      timeoutMs: 30000,
    },
    test: null,
    lint: null,
    typecheck: null,
    custom_commands: [],
    commands: [],
    final_review: {
      enabled: true,
      provider: null,
      model: null,
      requiredForRisk: ["medium", "high"],
    },
  },
};

export async function loadRuntimeConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const fileConfig = await readConfigFile(cwd);
  const hasExplicitPolicy = isPlainObject(fileConfig) && Object.hasOwn(fileConfig, "policy");
  const merged = deepMerge(DEFAULT_RUNTIME_CONFIG, fileConfig);

  if (env.AI_CODING_RUNTIME_HOME) {
    merged.storage.directory = env.AI_CODING_RUNTIME_HOME;
  }

  if (env.AI_CODING_RUNTIME_HOST) {
    merged.server.host = env.AI_CODING_RUNTIME_HOST;
  }

  if (env.AI_CODING_RUNTIME_PORT) {
    merged.server.httpPort = Number(env.AI_CODING_RUNTIME_PORT);
  }

  if (env.AI_CODING_RUNTIME_API_TOKEN) {
    merged.server.apiToken = env.AI_CODING_RUNTIME_API_TOKEN;
  }

  applyProviderEnvOverrides(merged, env);

  const policyValidation = validatePolicyConfig(merged.policy);
  merged.policy = normalizePolicyConfig(merged.policy);
  merged.policyValidation = policyValidation;
  merged.policyExplicit = hasExplicitPolicy;
  merged.policy_explicit = hasExplicitPolicy;
  if (hasExplicitPolicy) {
    merged.routing.budgetPolicy = {
      ...merged.routing.budgetPolicy,
      maxCostPerRun: merged.policy.budget.maxCostPerRun,
      maxCallsPerRun: merged.policy.budget.maxCallsPerRun,
      maxRetryCount: merged.policy.budget.maxWorkerRetries,
    };
  }

  return merged;
}

function applyProviderEnvOverrides(config, env) {
  const providers = config.providers?.entries ?? {};
  const openai = providers["openai-compatible"];
  const anthropic = providers.anthropic;
  const gemini = providers.gemini;

  if (openai) {
    if (env.OPENAI_API_KEY) openai.apiKey = env.OPENAI_API_KEY;
    if (env.OPENAI_BASE_URL) openai.baseUrl = env.OPENAI_BASE_URL;
    if (env.OPENAI_MODEL) openai.defaultModel = env.OPENAI_MODEL;
  }

  if (anthropic) {
    if (env.ANTHROPIC_API_KEY) anthropic.apiKey = env.ANTHROPIC_API_KEY;
    if (env.ANTHROPIC_BASE_URL) anthropic.baseUrl = env.ANTHROPIC_BASE_URL;
    if (env.ANTHROPIC_MODEL) anthropic.defaultModel = env.ANTHROPIC_MODEL;
  }

  if (gemini) {
    if (env.GEMINI_API_KEY) gemini.apiKey = env.GEMINI_API_KEY;
    if (env.GOOGLE_API_KEY && !gemini.apiKey) gemini.apiKey = env.GOOGLE_API_KEY;
    if (env.GEMINI_BASE_URL) gemini.baseUrl = env.GEMINI_BASE_URL;
    if (env.GEMINI_MODEL) gemini.defaultModel = env.GEMINI_MODEL;
  }
}

async function readConfigFile(cwd) {
  try {
    const content = await readFile(join(cwd, "runtime.config.json"), "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

function deepMerge(base, override) {
  const result = structuredClone(base);

  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
