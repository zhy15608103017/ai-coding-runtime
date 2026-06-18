import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_BUDGET_POLICY,
  DEFAULT_MODEL_REGISTRY,
  DEFAULT_ROUTING_POLICY,
  MODEL_TIER_ALIASES,
} from "./router.js";

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
  verification: {
    commands: [],
  },
};

export async function loadRuntimeConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const fileConfig = await readConfigFile(cwd);
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

  return merged;
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
