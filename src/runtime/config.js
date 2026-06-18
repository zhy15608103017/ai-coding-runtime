import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_RUNTIME_CONFIG = {
  server: {
    host: "127.0.0.1",
    httpPort: 3847,
    mcpPath: "/mcp",
  },
  storage: {
    directory: ".ai-coding-runtime",
  },
  routing: {
    modelTiers: ["cheap", "standard", "premium"],
    finalVerificationTier: "premium",
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

