export const DEFAULT_PROVIDER_RETRY_POLICY = {
  maxRetries: 2,
  initialDelayMs: 250,
  maxDelayMs: 2000,
  timeoutMs: 60000,
};

export const DEFAULT_PROVIDER_CONFIG = {
  defaultProvider: "local",
  retryPolicy: DEFAULT_PROVIDER_RETRY_POLICY,
  entries: {
    "openai-compatible": {
      type: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      defaultModel: null,
      models: [],
    },
    anthropic: {
      type: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      apiVersion: "2023-06-01",
      defaultModel: null,
      models: [],
    },
    gemini: {
      type: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKeyEnv: "GEMINI_API_KEY",
      defaultModel: null,
      models: [],
    },
    local: {
      type: "local",
      defaultModel: "local-placeholder",
      models: ["local-placeholder"],
    },
  },
};

const TRANSIENT_HTTP_STATUSES = new Set([408, 409, 425, 429]);
const RESPONSE_SCHEMA_TOOL_NAME = "runtime_response";

export class ProviderError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = options.code ?? "provider.error";
    this.provider = options.provider ?? null;
    this.statusCode = options.statusCode ?? null;
    this.retryable = options.retryable === true;
    this.attempts = options.attempts ?? null;
    this.cause = options.cause;
  }
}

export async function generateModelResponse(request = {}, options = {}) {
  const providers = resolveProvidersConfig(options.providers ?? options);
  const providerName = request.provider ?? providers.defaultProvider;
  const providerConfig = providers.entries[providerName];

  if (!providerConfig) {
    throw new ProviderError(`Unsupported provider: ${providerName}.`, {
      code: "provider.unsupported",
      provider: providerName,
    });
  }

  const type = providerConfig.type ?? providerName;
  const model = resolveModel(request, providerName, providerConfig);
  const messages = normalizeMessages(request);
  const retryPolicy = {
    ...DEFAULT_PROVIDER_RETRY_POLICY,
    ...(providers.retryPolicy ?? {}),
    ...(request.retryPolicy ?? {}),
  };
  const providerContext = {
    providerName,
    providerConfig,
    model,
    messages,
    request,
    retryPolicy,
  };

  switch (type) {
    case "openai-compatible":
      return generateOpenAiCompatible(providerContext);
    case "anthropic":
      return generateAnthropic(providerContext);
    case "gemini":
      return generateGemini(providerContext);
    case "local":
      return generateLocalPlaceholder(providerContext);
    default:
      throw new ProviderError(`Unsupported provider type: ${type}.`, {
        code: "provider.unsupported_type",
        provider: providerName,
      });
  }
}

export function checkProviderHealth(options = {}) {
  const providers = resolveProvidersConfig(options.providers ?? options);
  const requestedProvider = options.provider;
  const results = Object.entries(providers.entries).map(([name, providerConfig]) => {
    const type = providerConfig.type ?? name;
    const model = providerConfig.defaultModel ?? null;

    if (type === "local") {
      return {
        name,
        type,
        status: "placeholder",
        ok: true,
        model,
        message: "Local provider placeholder is available but does not call a real model.",
      };
    }

    const envName = providerConfig.apiKeyEnv ?? defaultApiKeyEnv(type);
    const apiKey = resolveApiKey(providerConfig, envName);
    if (!apiKey) {
      return {
        name,
        type,
        status: "missing_api_key",
        ok: false,
        model,
        message: `Missing API key. Set ${envName} or configure providers.entries.${name}.apiKey.`,
      };
    }

    if (!model) {
      return {
        name,
        type,
        status: "missing_model",
        ok: false,
        model,
        message: `Missing default model for provider ${name}.`,
      };
    }

    return {
      name,
      type,
      status: "configured",
      ok: true,
      model,
      message: "Provider has the required local configuration.",
    };
  });
  const filteredResults = requestedProvider
    ? results.filter((result) => result.name === requestedProvider)
    : results;

  if (requestedProvider && filteredResults.length === 0) {
    return {
      ok: false,
      providers: [
        {
          name: requestedProvider,
          type: null,
          status: "unsupported_provider",
          ok: false,
          model: null,
          message: `Unsupported provider: ${requestedProvider}.`,
        },
      ],
    };
  }

  return {
    ok: filteredResults.every((result) => result.ok),
    providers: filteredResults,
  };
}

export function resolveProvidersConfig(input = {}) {
  const source = input.entries ? input : input.providers ?? {};
  return {
    ...DEFAULT_PROVIDER_CONFIG,
    ...source,
    retryPolicy: {
      ...DEFAULT_PROVIDER_RETRY_POLICY,
      ...(source.retryPolicy ?? {}),
    },
    entries: mergeProviderEntries(DEFAULT_PROVIDER_CONFIG.entries, source.entries ?? {}),
  };
}

async function generateOpenAiCompatible(context) {
  const { providerName, providerConfig, model, messages, request, retryPolicy } = context;
  const apiKey = requireApiKey(providerName, providerConfig, "OPENAI_API_KEY");
  const body = {
    model,
    messages: toOpenAiMessages(messages),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
    ...(Array.isArray(request.tools) && request.tools.length > 0 ? { tools: request.tools } : {}),
    ...(request.responseSchema ? { response_format: toOpenAiResponseFormat(request.responseSchema) } : {}),
  };
  const startedAt = Date.now();
  const { json, attempts } = await postJsonWithRetry({
    url: `${trimSlash(providerConfig.baseUrl)}/chat/completions`,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body,
    providerName,
    retryPolicy,
    timeoutMs: request.timeoutMs,
  });
  const choice = json.choices?.[0] ?? {};
  const text = normalizeText(choice.message?.content ?? "");
  const usage = normalizeUsage({
    inputTokens: json.usage?.prompt_tokens,
    outputTokens: json.usage?.completion_tokens,
    totalTokens: json.usage?.total_tokens,
  });

  return normalizeProviderResponse({
    provider: providerName,
    model,
    text,
    usage,
    cost: estimateCost(usage, providerConfig.cost),
    finishReason: choice.finish_reason ?? null,
    raw: json,
    attempts,
    durationMs: Date.now() - startedAt,
    responseSchema: request.responseSchema,
  });
}

async function generateAnthropic(context) {
  const { providerName, providerConfig, model, messages, request, retryPolicy } = context;
  const apiKey = requireApiKey(providerName, providerConfig, "ANTHROPIC_API_KEY");
  const { system, conversation } = splitSystemMessages(messages);
  const tools = [
    ...(Array.isArray(request.tools) && request.tools.length > 0
      ? request.tools.map(toAnthropicTool)
      : []),
    ...(request.responseSchema ? [toAnthropicResponseSchemaTool(request.responseSchema)] : []),
  ];
  const body = {
    model,
    max_tokens: request.maxTokens ?? providerConfig.defaultMaxTokens ?? 1024,
    messages: conversation.map(toAnthropicMessage),
    ...(system ? { system } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(request.responseSchema ? { tool_choice: { type: "tool", name: RESPONSE_SCHEMA_TOOL_NAME } } : {}),
  };
  const startedAt = Date.now();
  const { json, attempts } = await postJsonWithRetry({
    url: `${trimSlash(providerConfig.baseUrl)}/v1/messages`,
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": providerConfig.apiVersion ?? "2023-06-01",
      "content-type": "application/json",
    },
    body,
    providerName,
    retryPolicy,
    timeoutMs: request.timeoutMs,
  });
  const text = normalizeText(anthropicContentText(json.content ?? [], request.responseSchema));
  const usage = normalizeUsage({
    inputTokens: json.usage?.input_tokens,
    outputTokens: json.usage?.output_tokens,
  });

  return normalizeProviderResponse({
    provider: providerName,
    model,
    text,
    usage,
    cost: estimateCost(usage, providerConfig.cost),
    finishReason: json.stop_reason ?? null,
    raw: json,
    attempts,
    durationMs: Date.now() - startedAt,
    responseSchema: request.responseSchema,
  });
}

async function generateGemini(context) {
  const { providerName, providerConfig, model, messages, request, retryPolicy } = context;
  const apiKey = requireApiKey(providerName, providerConfig, "GEMINI_API_KEY");
  const { system, conversation } = splitSystemMessages(messages);
  const generationConfig = {
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
    ...(request.responseSchema
      ? {
          responseMimeType: "application/json",
          responseSchema: request.responseSchema,
        }
      : {}),
  };
  const body = {
    contents: conversation.map(toGeminiContent),
    ...(system
      ? {
          systemInstruction: {
            parts: [{ text: system }],
          },
        }
      : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
    ...(Array.isArray(request.tools) && request.tools.length > 0 ? { tools: toGeminiTools(request.tools) } : {}),
  };
  const startedAt = Date.now();
  const { json, attempts } = await postJsonWithRetry({
    url: `${trimSlash(providerConfig.baseUrl)}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    headers: {
      "x-goog-api-key": apiKey,
      "content-type": "application/json",
    },
    body,
    providerName,
    retryPolicy,
    timeoutMs: request.timeoutMs,
  });
  const candidate = json.candidates?.[0] ?? {};
  const text = normalizeText((candidate.content?.parts ?? []).map((part) => part.text ?? "").join(""));
  const usage = normalizeUsage({
    inputTokens: json.usageMetadata?.promptTokenCount,
    outputTokens: json.usageMetadata?.candidatesTokenCount,
    totalTokens: json.usageMetadata?.totalTokenCount,
  });

  return normalizeProviderResponse({
    provider: providerName,
    model,
    text,
    usage,
    cost: estimateCost(usage, providerConfig.cost),
    finishReason: candidate.finishReason ?? null,
    raw: json,
    attempts,
    durationMs: Date.now() - startedAt,
    responseSchema: request.responseSchema,
  });
}

function generateLocalPlaceholder(context) {
  const { providerName, model, messages, request } = context;
  const lastMessage = [...messages].reverse().find((message) => message.role !== "system");
  const text = `Local provider placeholder for ${model}: ${normalizeText(lastMessage?.content ?? request.prompt ?? "")}`;

  return normalizeProviderResponse({
    provider: providerName,
    model,
    text,
    usage: normalizeUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    cost: {
      currency: "USD",
      estimatedCost: 0,
      estimated_cost: 0,
      source: "local-placeholder",
    },
    finishReason: "placeholder",
    raw: {
      placeholder: true,
    },
    attempts: 0,
    durationMs: 0,
    responseSchema: request.responseSchema,
  });
}

async function postJsonWithRetry({ url, headers, body, providerName, retryPolicy, timeoutMs }) {
  const maxRetries = Number.isFinite(retryPolicy.maxRetries) ? retryPolicy.maxRetries : 0;
  let lastError;
  let attempts = 0;

  for (let attemptIndex = 0; attemptIndex <= maxRetries; attemptIndex += 1) {
    attempts = attemptIndex + 1;
    try {
      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }, timeoutMs ?? retryPolicy.timeoutMs);
      const json = await readJsonResponse(response);

      if (!response.ok) {
        const retryable = isRetryableStatus(response.status);
        const message = providerErrorMessage(providerName, response.status, json);
        if (retryable && attemptIndex < maxRetries) {
          await delay(retryDelay(attemptIndex, retryPolicy));
          continue;
        }

        throw new ProviderError(message, {
          code: "provider.http_error",
          provider: providerName,
          statusCode: response.status,
          retryable,
          attempts,
        });
      }

      return {
        json,
        attempts: attemptIndex + 1,
      };
    } catch (error) {
      lastError = error;
      const retryable = error instanceof ProviderError ? error.retryable : true;
      if (!retryable || attemptIndex >= maxRetries) {
        break;
      }

      await delay(retryDelay(attemptIndex, retryPolicy));
    }
  }

  if (lastError instanceof ProviderError) {
    throw lastError;
  }

  throw new ProviderError(`Provider ${providerName} request failed: ${lastError?.message ?? lastError}`, {
    code: "provider.network_error",
    provider: providerName,
    retryable: true,
    attempts,
    cause: lastError,
  });
}

async function fetchWithTimeout(url, options, timeoutMs) {
  if (!timeoutMs || !Number.isFinite(timeoutMs)) {
    return fetch(url, options);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text.trim()) return {};

  try {
    return JSON.parse(text);
  } catch {
    return {
      error: {
        message: text,
      },
    };
  }
}

function normalizeProviderResponse({
  provider,
  model,
  text,
  usage,
  cost,
  finishReason,
  raw,
  attempts,
  durationMs,
  responseSchema,
}) {
  return {
    provider,
    model,
    text,
    structuredOutput: parseStructuredOutput(text, responseSchema),
    structured_output: parseStructuredOutput(text, responseSchema),
    usage,
    costEstimate: cost,
    cost_estimate: cost,
    finishReason,
    finish_reason: finishReason,
    raw,
    request: {
      attempts,
      durationMs,
      duration_ms: durationMs,
    },
  };
}

function normalizeMessages(request) {
  if (Array.isArray(request.messages) && request.messages.length > 0) {
    return request.messages.map((message) => ({
      role: normalizeRole(message.role),
      content: message.content ?? "",
    }));
  }

  if (request.prompt) {
    return [{ role: "user", content: request.prompt }];
  }

  throw new ProviderError("Model generation requires messages or prompt.", {
    code: "provider.request.messages_required",
    provider: request.provider,
  });
}

function normalizeRole(role) {
  if (role === "assistant" || role === "model") return "assistant";
  if (role === "system" || role === "developer") return "system";
  return "user";
}

function toOpenAiMessages(messages) {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "assistant" : message.role,
    content: message.content,
  }));
}

function toAnthropicMessage(message) {
  return {
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content,
  };
}

function toGeminiContent(message) {
  return {
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: normalizeText(message.content) }],
  };
}

function splitSystemMessages(messages) {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => normalizeText(message.content))
    .filter(Boolean)
    .join("\n\n");
  const conversation = messages.filter((message) => message.role !== "system");

  return { system, conversation };
}

function toAnthropicTool(tool) {
  if (tool.input_schema) return tool;
  const fn = tool.function ?? tool;
  return {
    name: fn.name,
    description: fn.description,
    input_schema: fn.parameters ?? { type: "object", properties: {} },
  };
}

function toAnthropicResponseSchemaTool(schema) {
  return {
    name: RESPONSE_SCHEMA_TOOL_NAME,
    description: "Return the response using the requested JSON schema.",
    input_schema: schema,
  };
}

function anthropicContentText(content, responseSchema) {
  return content.map((part) => {
    if (part.type === "text") return part.text ?? "";
    if (responseSchema && part.type === "tool_use" && part.name === RESPONSE_SCHEMA_TOOL_NAME) {
      return normalizeText(part.input);
    }
    return "";
  }).join("");
}

function toGeminiTools(tools) {
  return [
    {
      functionDeclarations: tools.map((tool) => {
        const fn = tool.function ?? tool;
        return {
          name: fn.name,
          description: fn.description,
          parameters: fn.parameters ?? { type: "object", properties: {} },
        };
      }),
    },
  ];
}

function toOpenAiResponseFormat(schema) {
  return {
    type: "json_schema",
    json_schema: {
      name: RESPONSE_SCHEMA_TOOL_NAME,
      schema,
      strict: true,
    },
  };
}

function parseStructuredOutput(text, responseSchema) {
  if (!responseSchema) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeUsage({ inputTokens = 0, outputTokens = 0, totalTokens } = {}) {
  const input = numberOrZero(inputTokens);
  const output = numberOrZero(outputTokens);
  const total = numberOrZero(totalTokens) || input + output;

  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
  };
}

function estimateCost(usage, cost = {}) {
  const inputRate = numberOrZero(cost.inputUsdPerMillion);
  const outputRate = numberOrZero(cost.outputUsdPerMillion);
  const estimatedCost = roundCost(
    (usage.inputTokens / 1000000) * inputRate + (usage.outputTokens / 1000000) * outputRate
  );

  return {
    currency: cost.currency ?? "USD",
    estimatedCost,
    estimated_cost: estimatedCost,
    source: inputRate || outputRate ? "token_usage" : "unpriced",
  };
}

function resolveModel(request, providerName, providerConfig) {
  const model = request.model ?? providerConfig.defaultModel;

  if (!model) {
    throw new ProviderError(`Provider ${providerName} has no model configured.`, {
      code: "provider.missing_model",
      provider: providerName,
    });
  }

  const supportedModels = Array.isArray(providerConfig.models) ? providerConfig.models : [];
  if (supportedModels.length > 0 && !supportedModels.includes(model)) {
    throw new ProviderError(`Provider ${providerName} has unsupported model ${model}.`, {
      code: "provider.unsupported_model",
      provider: providerName,
    });
  }

  return model;
}

function requireApiKey(providerName, providerConfig, fallbackEnv) {
  const apiKey = resolveApiKey(providerConfig, fallbackEnv);
  if (apiKey) return apiKey;

  const envName = providerConfig.apiKeyEnv ?? fallbackEnv;
  throw new ProviderError(`Missing API key for provider ${providerName}. Set ${envName}.`, {
    code: "provider.missing_api_key",
    provider: providerName,
  });
}

function resolveApiKey(providerConfig, fallbackEnv) {
  return (
    providerConfig.apiKey ??
    (providerConfig.apiKeyEnv ? process.env[providerConfig.apiKeyEnv] : undefined) ??
    (fallbackEnv ? process.env[fallbackEnv] : undefined)
  );
}

function defaultApiKeyEnv(type) {
  switch (type) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "gemini":
      return "GEMINI_API_KEY";
    default:
      return "OPENAI_API_KEY";
  }
}

function mergeProviderEntries(base, override) {
  const entries = {};
  for (const [name, value] of Object.entries(base)) {
    entries[name] = { ...value };
  }
  for (const [name, value] of Object.entries(override)) {
    entries[name] = {
      ...(entries[name] ?? {}),
      ...value,
    };
  }
  return entries;
}

function isRetryableStatus(status) {
  return TRANSIENT_HTTP_STATUSES.has(status) || status >= 500;
}

function providerErrorMessage(providerName, status, json) {
  const detail =
    json?.error?.message ??
    json?.error ??
    json?.message ??
    `HTTP ${status}`;
  return `Provider ${providerName} request failed with HTTP ${status}: ${detail}`;
}

function retryDelay(attemptIndex, policy) {
  const initial = Number.isFinite(policy.initialDelayMs) ? policy.initialDelayMs : 0;
  const max = Number.isFinite(policy.maxDelayMs) ? policy.maxDelayMs : initial;
  return Math.min(initial * 2 ** attemptIndex, max);
}

function delay(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

function normalizeText(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function roundCost(value) {
  return Math.round(value * 1000000000) / 1000000000;
}
