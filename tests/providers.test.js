import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  callRuntimeTool,
  checkProviderHealth,
  FileExecutionStore,
  generateModelResponse,
  loadRuntimeConfig,
} from "../src/index.js";

test("loadRuntimeConfig merges provider config and environment secrets", async () => {
  const config = await loadRuntimeConfig({
    env: {
      OPENAI_API_KEY: "openai-secret",
      OPENAI_BASE_URL: "https://openai.example/v1",
      OPENAI_MODEL: "gpt-test",
      ANTHROPIC_API_KEY: "anthropic-secret",
      GEMINI_API_KEY: "gemini-secret",
    },
  });

  assert.equal(config.providers.entries["openai-compatible"].apiKey, "openai-secret");
  assert.equal(config.providers.entries["openai-compatible"].baseUrl, "https://openai.example/v1");
  assert.equal(config.providers.entries["openai-compatible"].defaultModel, "gpt-test");
  assert.equal(config.providers.entries.anthropic.apiKey, "anthropic-secret");
  assert.equal(config.providers.entries.gemini.apiKey, "gemini-secret");
  assert.equal(config.providers.retryPolicy.maxRetries, 2);
});

test("OpenAI-compatible provider posts chat completions and normalizes response", async () => {
  const seen = [];
  const server = await startJsonServer(async ({ url, body, headers }) => {
    seen.push({ url, body, headers });
    return {
      status: 200,
      body: {
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "{\"ok\":true}",
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      },
    };
  });

  try {
    const response = await generateModelResponse(
      {
        provider: "openai-compatible",
        messages: [{ role: "user", content: "Return JSON" }],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Look up a value.",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        responseSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
        temperature: 0.2,
        maxTokens: 32,
      },
      {
        providers: {
          retryPolicy: { maxRetries: 0 },
          entries: {
            "openai-compatible": {
              type: "openai-compatible",
              baseUrl: server.url,
              apiKey: "test-key",
              defaultModel: "gpt-test",
              models: ["gpt-test"],
              cost: {
                inputUsdPerMillion: 1,
                outputUsdPerMillion: 2,
              },
            },
          },
        },
      }
    );

    assert.equal(seen.length, 1);
    assert.equal(seen[0].url.pathname, "/chat/completions");
    assert.equal(seen[0].headers.authorization, "Bearer test-key");
    assert.equal(seen[0].body.model, "gpt-test");
    assert.equal(seen[0].body.max_tokens, 32);
    assert.equal(seen[0].body.tools[0].function.name, "lookup");
    assert.equal(seen[0].body.response_format.type, "json_schema");
    assert.equal(response.provider, "openai-compatible");
    assert.equal(response.model, "gpt-test");
    assert.equal(response.text, "{\"ok\":true}");
    assert.deepEqual(response.structuredOutput, { ok: true });
    assert.deepEqual(response.usage, {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
    assert.equal(response.costEstimate.estimatedCost, 0.00002);
    assert.equal(response.finishReason, "stop");
    assert.equal(response.raw.choices[0].finish_reason, "stop");
    assert.equal(response.request.attempts, 1);
  } finally {
    await server.close();
  }
});

test("Anthropic provider posts messages, tools, response schema, and normalizes tool response", async () => {
  const seen = [];
  const responseSchema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  };
  const lookupParameters = {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  };
  const server = await startJsonServer(async ({ url, body, headers }) => {
    seen.push({ url, body, headers });
    return {
      status: 200,
      body: {
        content: [
          {
            type: "tool_use",
            name: "runtime_response",
            input: { ok: true },
          },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 7,
          output_tokens: 3,
        },
      },
    };
  });

  try {
    const response = await generateModelResponse(
      {
        provider: "anthropic",
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "Hello" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Look up a value.",
              parameters: lookupParameters,
            },
          },
        ],
        responseSchema,
        temperature: 0,
        maxTokens: 16,
        timeoutMs: 5000,
      },
      {
        providers: {
          retryPolicy: { maxRetries: 0 },
          entries: {
            anthropic: {
              type: "anthropic",
              baseUrl: server.url,
              apiKey: "anthropic-key",
              defaultModel: "claude-test",
              models: ["claude-test"],
            },
          },
        },
      }
    );

    assert.equal(seen[0].url.pathname, "/v1/messages");
    assert.equal(seen[0].headers["x-api-key"], "anthropic-key");
    assert.equal(seen[0].headers["anthropic-version"], "2023-06-01");
    assert.equal(seen[0].body.model, "claude-test");
    assert.equal(seen[0].body.system, "Be concise.");
    assert.deepEqual(seen[0].body.messages, [{ role: "user", content: "Hello" }]);
    assert.equal(seen[0].body.temperature, 0);
    assert.equal(seen[0].body.max_tokens, 16);
    assert.equal(seen[0].body.tools[0].name, "lookup");
    assert.deepEqual(seen[0].body.tools[0].input_schema, lookupParameters);
    assert.deepEqual(seen[0].body.tools[1], {
      name: "runtime_response",
      description: "Return the response using the requested JSON schema.",
      input_schema: responseSchema,
    });
    assert.deepEqual(seen[0].body.tool_choice, { type: "tool", name: "runtime_response" });
    assert.equal(response.text, "{\"ok\":true}");
    assert.deepEqual(response.structuredOutput, { ok: true });
    assert.deepEqual(response.usage, {
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
    });
    assert.equal(response.finishReason, "tool_use");
  } finally {
    await server.close();
  }
});

test("Gemini provider posts generateContent and normalizes response", async () => {
  const seen = [];
  const responseSchema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  };
  const lookupParameters = {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  };
  const server = await startJsonServer(async ({ url, body, headers }) => {
    seen.push({ url, body, headers });
    return {
      status: 200,
      body: {
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [{ text: "{\"ok\":true}" }],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 4,
          candidatesTokenCount: 6,
          totalTokenCount: 10,
        },
      },
    };
  });

  try {
    const response = await generateModelResponse(
      {
        provider: "gemini",
        messages: [
          { role: "system", content: "Be exact." },
          { role: "user", content: "Hello" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Look up a value.",
              parameters: lookupParameters,
            },
          },
        ],
        responseSchema,
        temperature: 0.1,
        maxTokens: 24,
        timeoutMs: 5000,
      },
      {
        providers: {
          retryPolicy: { maxRetries: 0 },
          entries: {
            gemini: {
              type: "gemini",
              baseUrl: server.url,
              apiKey: "gemini-key",
              defaultModel: "gemini-test",
              models: ["gemini-test"],
            },
          },
        },
      }
    );

    assert.equal(seen[0].url.pathname, "/v1beta/models/gemini-test:generateContent");
    assert.equal(seen[0].headers["x-goog-api-key"], "gemini-key");
    assert.deepEqual(seen[0].body.systemInstruction, {
      parts: [{ text: "Be exact." }],
    });
    assert.equal(seen[0].body.system_instruction, undefined);
    assert.deepEqual(seen[0].body.contents, [
      {
        role: "user",
        parts: [{ text: "Hello" }],
      },
    ]);
    assert.deepEqual(seen[0].body.generationConfig, {
      temperature: 0.1,
      maxOutputTokens: 24,
      responseMimeType: "application/json",
      responseSchema,
    });
    assert.deepEqual(seen[0].body.tools, [
      {
        functionDeclarations: [
          {
            name: "lookup",
            description: "Look up a value.",
            parameters: lookupParameters,
          },
        ],
      },
    ]);
    assert.equal(response.text, "{\"ok\":true}");
    assert.deepEqual(response.structuredOutput, { ok: true });
    assert.deepEqual(response.usage, {
      inputTokens: 4,
      outputTokens: 6,
      totalTokens: 10,
    });
    assert.equal(response.finishReason, "STOP");
  } finally {
    await server.close();
  }
});

test("local provider placeholder accepts common generation options", async () => {
  const response = await generateModelResponse(
    {
      provider: "local",
      messages: [{ role: "user", content: "Hello local" }],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Look up a value.",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      responseSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
      temperature: 0,
      maxTokens: 8,
      timeoutMs: 5000,
    },
    {
      providers: {
        entries: {
          local: {
            type: "local",
            defaultModel: "local-placeholder",
            models: ["local-placeholder"],
          },
        },
      },
    }
  );

  assert.equal(response.provider, "local");
  assert.equal(response.model, "local-placeholder");
  assert.equal(response.text, "Local provider placeholder for local-placeholder: Hello local");
  assert.equal(response.structuredOutput, null);
  assert.deepEqual(response.usage, {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
  assert.equal(response.costEstimate.estimatedCost, 0);
  assert.equal(response.finishReason, "placeholder");
  assert.deepEqual(response.raw, { placeholder: true });
  assert.equal(response.request.attempts, 0);
});

test("provider retries transient failures and reports configuration errors clearly", async () => {
  let calls = 0;
  const server = await startJsonServer(async () => {
    calls += 1;
    if (calls === 1) {
      return {
        status: 500,
        body: { error: { message: "temporary failure" } },
      };
    }

    return {
      status: 200,
      body: {
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    };
  });

  try {
    const response = await generateModelResponse(
      {
        provider: "openai-compatible",
        messages: [{ role: "user", content: "retry" }],
      },
      {
        providers: {
          retryPolicy: { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 },
          entries: {
            "openai-compatible": {
              type: "openai-compatible",
              baseUrl: server.url,
              apiKey: "test-key",
              defaultModel: "gpt-test",
              models: ["gpt-test"],
            },
          },
        },
      }
    );

    assert.equal(response.text, "ok");
    assert.equal(response.request.attempts, 2);
    assert.equal(calls, 2);

    await withUnsetEnv("OPENAI_API_KEY", async () => {
      await assert.rejects(
        generateModelResponse(
          {
            provider: "openai-compatible",
            messages: [{ role: "user", content: "missing key" }],
          },
          {
            providers: {
              entries: {
                "openai-compatible": {
                  type: "openai-compatible",
                  baseUrl: server.url,
                  defaultModel: "gpt-test",
                },
              },
            },
          }
        ),
        /OPENAI_API_KEY/
      );
    });

    await assert.rejects(
      generateModelResponse(
        {
          provider: "openai-compatible",
          model: "not-allowed",
          messages: [{ role: "user", content: "unsupported" }],
        },
        {
          providers: {
            entries: {
              "openai-compatible": {
                type: "openai-compatible",
                baseUrl: server.url,
                apiKey: "test-key",
                defaultModel: "gpt-test",
                models: ["gpt-test"],
              },
            },
          },
        }
      ),
      /unsupported model/i
    );
  } finally {
    await server.close();
  }
});

test("provider requests honor timeoutMs", async () => {
  const server = await startJsonServer(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      status: 200,
      body: {
        choices: [{ finish_reason: "stop", message: { content: "too late" } }],
      },
    };
  });

  try {
    await assert.rejects(
      generateModelResponse(
        {
          provider: "openai-compatible",
          messages: [{ role: "user", content: "timeout" }],
          timeoutMs: 1,
        },
        {
          providers: {
            retryPolicy: { maxRetries: 0 },
            entries: {
              "openai-compatible": {
                type: "openai-compatible",
                baseUrl: server.url,
                apiKey: "test-key",
                defaultModel: "gpt-test",
                models: ["gpt-test"],
              },
            },
          },
        }
      ),
      /request failed/i
    );
  } finally {
    await server.close();
  }
});

test("provider health reports configured, missing key, and local placeholder status", () => {
  const health = checkProviderHealth({
    providers: {
      entries: {
        "openai-compatible": {
          type: "openai-compatible",
          apiKey: "test-key",
          defaultModel: "gpt-test",
        },
        anthropic: {
          type: "anthropic",
          defaultModel: "claude-test",
        },
        local: {
          type: "local",
          defaultModel: "local-placeholder",
        },
      },
    },
  });

  assert.deepEqual(
    health.providers.map((provider) => [provider.name, provider.status]),
    [
      ["openai-compatible", "configured"],
      ["anthropic", "missing_api_key"],
      ["gemini", "missing_api_key"],
      ["local", "placeholder"],
    ]
  );
  assert.equal(health.ok, false);
  assert.match(health.providers[1].message, /ANTHROPIC_API_KEY/);

  const unknown = checkProviderHealth({
    provider: "missing-provider",
    providers: {
      entries: {
        local: {
          type: "local",
          defaultModel: "local-placeholder",
        },
      },
    },
  });

  assert.equal(unknown.ok, false);
  assert.deepEqual(unknown.providers, [
    {
      name: "missing-provider",
      type: null,
      status: "unsupported_provider",
      ok: false,
      model: null,
      message: "Unsupported provider: missing-provider.",
    },
  ]);
});

test("custom real providers can use standard API key environment fallback", async () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "fallback-key";
  const seen = [];
  const server = await startJsonServer(async ({ headers }) => {
    seen.push({ headers });
    return {
      status: 200,
      body: {
        choices: [{ finish_reason: "stop", message: { content: "fallback ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    };
  });

  try {
    const response = await generateModelResponse(
      {
        provider: "custom-openai",
        prompt: "hello",
      },
      {
        providers: {
          retryPolicy: { maxRetries: 0 },
          entries: {
            "custom-openai": {
              type: "openai-compatible",
              baseUrl: server.url,
              defaultModel: "custom-model",
              models: ["custom-model"],
            },
          },
        },
      }
    );

    assert.equal(response.text, "fallback ok");
    assert.equal(seen[0].headers.authorization, "Bearer fallback-key");
  } finally {
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
    await server.close();
  }
});

test("runtime_model_generate records model usage and cost in the run trace", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-provider-trace-"));
  const store = new FileExecutionStore({ workspace });
  const seen = [];
  const server = await startJsonServer(async ({ body }) => {
    seen.push(body);
    return {
      status: 200,
      body: {
        choices: [{ finish_reason: "stop", message: { content: "trace ok" } }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      },
    };
  });

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "plan only: provider trace" },
      { store }
    );
    const taskId = run.plan.tasks[0].task_id;
    const generated = await callRuntimeTool(
      "runtime_model_generate",
      {
        runId: run.runId,
        taskId,
        provider: "openai-compatible",
        messages: [{ role: "user", content: "trace" }],
      },
      {
        store,
        runtimeOptions: {
          providers: {
            retryPolicy: { maxRetries: 0 },
            entries: {
              "openai-compatible": {
                type: "openai-compatible",
                baseUrl: server.url,
                apiKey: "test-key",
                defaultModel: "gpt-test",
                models: ["gpt-test"],
                cost: {
                  inputUsdPerMillion: 1,
                  outputUsdPerMillion: 1,
                },
              },
            },
          },
        },
      }
    );

    assert.equal(generated.text, "trace ok");
    assert.equal(generated.request.taskId, taskId);
    assert.equal(generated.request.task_id, taskId);
    assert.equal(seen[0].taskId, undefined);
    assert.equal(seen[0].task_id, undefined);
    const record = await store.readRecord(run.runId);
    assert.equal(record.modelCalls.length, 1);
    assert.equal(record.modelCalls[0].provider, "openai-compatible");
    assert.deepEqual(record.modelCalls[0].usage, {
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
    });
    assert.equal(record.modelCalls[0].costEstimate.estimatedCost, 0.000005);
    assert.equal(record.modelCalls[0].request.taskId, taskId);
    assert.equal(record.modelCalls[0].request.task_id, taskId);
    assert.ok(record.events.some((event) => event.type === "model.call.finished"));
  } finally {
    await server.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime_model_generate records provider failures without crashing the run", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-provider-failure-"));
  const store = new FileExecutionStore({ workspace });
  let calls = 0;
  const server = await startJsonServer(async () => {
    calls += 1;
    return {
      status: 500,
      body: { error: { message: "provider down" } },
    };
  });

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "plan only: provider failure trace" },
      { store }
    );
    const failed = await callRuntimeTool(
      "runtime_model_generate",
      {
        runId: run.runId,
        provider: "openai-compatible",
        messages: [{ role: "user", content: "trace failure" }],
      },
      {
        store,
        runtimeOptions: {
          providers: {
            retryPolicy: { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 },
            entries: {
              "openai-compatible": {
                type: "openai-compatible",
                baseUrl: server.url,
                apiKey: "test-key",
                defaultModel: "gpt-test",
                models: ["gpt-test"],
              },
            },
          },
        },
      }
    );

    assert.equal(failed.ok, false);
    assert.equal(failed.provider, "openai-compatible");
    assert.equal(failed.model, "gpt-test");
    assert.equal(failed.error.code, "provider.http_error");
    assert.equal(failed.error.statusCode, 500);
    assert.match(failed.error.message, /provider down/);
    assert.equal(failed.request.attempts, 2);
    assert.equal(calls, 2);

    const record = await store.readRecord(run.runId);
    assert.equal(record.status, run.status);
    assert.equal(record.modelCalls.length, 1);
    assert.equal(record.modelCalls[0].status, "failed");
    assert.equal(record.modelCalls[0].provider, "openai-compatible");
    assert.equal(record.modelCalls[0].model, "gpt-test");
    assert.equal(record.modelCalls[0].error.code, "provider.http_error");
    assert.equal(record.modelCalls[0].request.attempts, 2);
    assert.ok(record.events.some((event) => event.type === "model.call.failed"));
  } finally {
    await server.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

function startJsonServer(handler) {
  const server = createServer(async (request, response) => {
    let rawBody = "";
    for await (const chunk of request) {
      rawBody += chunk.toString("utf8");
    }

    const result = await handler({
      url: new URL(request.url, "http://127.0.0.1"),
      headers: request.headers,
      body: rawBody.trim() ? JSON.parse(rawBody) : {},
    });

    response.writeHead(result.status, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(result.body));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((closeResolve) => server.close(closeResolve)),
      });
    });
  });
}

async function withUnsetEnv(name, action) {
  const original = process.env[name];
  delete process.env[name];

  try {
    return await action();
  } finally {
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  }
}
