import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { callRuntimeTool, RUNTIME_TOOLS } from "../src/runtime/tools.js";
import { executeRun, skipReasonForTask } from "../src/runtime/execution.js";
import { createRuntimePlan } from "../src/runtime/planner.js";
import { FileExecutionStore } from "../src/runtime/store.js";

test("executeRun refuses runs waiting for approval", async () => {
  const fixture = await createFixture("refuses-approval");
  try {
    const plan = createRuntimePlan({
      request: "Change authentication, payment behavior, and database schema.",
    });
    const record = await fixture.store.createRecord(plan);

    assert.equal(record.status, "approval_required");
    await assert.rejects(
      () => executeRun({ runId: record.runId, store: fixture.store }),
      /cannot execute from approval_required status/
    );
  } finally {
    await fixture.cleanup();
  }
});

test("executeRun skips read-only, final verification, and already successful tasks", async () => {
  const fixture = await createFixture("skips-tasks");
  try {
    await writeFile(join(fixture.cwd, "src", "app.js"), "export const value = 1;\n", "utf8");
    const record = await createRunWithTasks(fixture.store, [
      taskContract("T-001", { title: "Read only", allowed_files: [], allowedFiles: [] }),
      taskContract("T-002", { title: "Final review", final_verification: true }),
      taskContract("T-003", { title: "Already done" }),
    ]);
    await fixture.store.recordWorkerAttempt(record.runId, {
      attemptId: "attempt_existing",
      attempt_id: "attempt_existing",
      runId: record.runId,
      run_id: record.runId,
      taskId: "T-003",
      task_id: "T-003",
      status: "applied",
      applied: true,
      filesTouched: ["src/app.js"],
      files_touched: ["src/app.js"],
    });

    const result = await executeRun({
      runId: record.runId,
      store: fixture.store,
      runtimeOptions: { workspace: { cwd: fixture.cwd } },
      generate: async () => {
        throw new Error("generate should not be called for skipped-only run");
      },
      verifyRun: async () => ({ runId: record.runId, status: "skipped", commands: [] }),
      createReport: () => ({ schema: "ai-coding-runtime.report" }),
    });

    assert.equal(result.status, "verification_skipped");
    assert.deepEqual(
      result.skippedTasks.map((item) => item.reason),
      [
        "read_only_or_no_allowed_files",
        "final_verification_task",
        "already_successful_worker_attempt",
      ]
    );
    assert.deepEqual(result.executedTasks, []);
  } finally {
    await fixture.cleanup();
  }
});

test("executeRun executes an eligible task once and records model and worker traces", async () => {
  const fixture = await createFixture("executes-task");
  try {
    const filePath = join(fixture.cwd, "src", "app.js");
    await writeFile(filePath, "export const value = 1;\n", "utf8");
    const record = await createRunWithTasks(fixture.store, [taskContract("T-001")]);

    const result = await executeRun({
      runId: record.runId,
      store: fixture.store,
      runtimeOptions: { workspace: { cwd: fixture.cwd } },
      generate: async (request) => modelResponse(request, {
        patch: patchFor("src/app.js", "export const value = 1;", "export const value = 2;"),
      }),
      verifyRun: async () => ({ runId: record.runId, status: "passed", commands: [] }),
      createReport: () => ({ schema: "ai-coding-runtime.report" }),
    });

    assert.equal(result.status, "verification_passed");
    assert.equal(result.executedTasks.length, 1);
    assert.equal(result.executedTasks[0].taskId, "T-001");
    assert.equal(result.executedTasks[0].workerStatus, "applied");
    assert.equal(await readFile(filePath, "utf8"), "export const value = 2;\n");

    const updated = await fixture.store.readRecord(record.runId);
    assert.equal(updated.modelCalls.length, 1);
    assert.equal(updated.modelCalls[0].taskId, "T-001");
    assert.equal(updated.workerAttempts.length, 1);
    assert.ok(updated.events.some((event) => event.type === "execution.started"));
    assert.ok(updated.events.some((event) => event.type === "task.execution.started"));
    assert.ok(updated.events.some((event) => event.type === "task.execution.finished"));
    assert.ok(updated.events.some((event) => event.type === "execution.finished"));
  } finally {
    await fixture.cleanup();
  }
});

test("executeRun executes eligible tasks only after dependencies are satisfied", async () => {
  const fixture = await createFixture("dependency-order");
  try {
    await writeFile(join(fixture.cwd, "src", "base.js"), "export const base = 1;\n", "utf8");
    await writeFile(join(fixture.cwd, "src", "feature.js"), "export const feature = 1;\n", "utf8");
    const record = await createRunWithTasks(fixture.store, [
      taskContract("T-002", {
        title: "Update dependent feature",
        allowed_files: ["src/feature.js"],
        allowedFiles: ["src/feature.js"],
        dependsOn: ["T-001"],
        depends_on: ["T-001"],
      }),
      taskContract("T-001", {
        title: "Update base first",
        allowed_files: ["src/base.js"],
        allowedFiles: ["src/base.js"],
      }),
    ]);
    const executionOrder = [];

    const result = await executeRun({
      runId: record.runId,
      store: fixture.store,
      verify: false,
      runtimeOptions: { workspace: { cwd: fixture.cwd } },
      generate: async (request) => {
        const prompt = request.messages.map((message) => message.content).join("\n");
        const taskId = prompt.includes("T-001") ? "T-001" : "T-002";
        executionOrder.push(taskId);
        return modelResponse(request, {
          patch:
            taskId === "T-001"
              ? patchFor("src/base.js", "export const base = 1;", "export const base = 2;")
              : patchFor("src/feature.js", "export const feature = 1;", "export const feature = 2;"),
        });
      },
      createReport: () => ({ schema: "ai-coding-runtime.report" }),
    });

    assert.equal(result.status, "verification_skipped");
    assert.deepEqual(executionOrder, ["T-001", "T-002"]);
    assert.deepEqual(result.executedTasks.map((task) => task.taskId), ["T-001", "T-002"]);
    assert.equal(await readFile(join(fixture.cwd, "src", "base.js"), "utf8"), "export const base = 2;\n");
    assert.equal(await readFile(join(fixture.cwd, "src", "feature.js"), "utf8"), "export const feature = 2;\n");
  } finally {
    await fixture.cleanup();
  }
});

test("executeRun does not unlock dependent tasks when a dependency lacks acceptance criteria", async () => {
  const fixture = await createFixture("dependency-missing-acceptance");
  try {
    const record = await createRunWithTasks(fixture.store, [
      taskContract("T-001", {
        title: "Invalid dependency contract",
        acceptance: [],
      }),
      taskContract("T-002", {
        title: "Dependent implementation",
        dependsOn: ["T-001"],
        depends_on: ["T-001"],
      }),
    ]);

    const result = await executeRun({
      runId: record.runId,
      store: fixture.store,
      verify: false,
      runtimeOptions: { workspace: { cwd: fixture.cwd } },
      generate: async () => {
        throw new Error("generate should not run when dependency contract is invalid");
      },
      createReport: () => ({ schema: "ai-coding-runtime.report" }),
    });

    assert.equal(result.status, "failed");
    assert.deepEqual(result.skippedTasks, [
      {
        taskId: "T-001",
        task_id: "T-001",
        reason: "missing_acceptance",
      },
    ]);
    assert.equal(result.failedTasks[0].taskId, "T-002");
    assert.equal(result.failedTasks[0].error.code, "task.dependencies.unresolved");
  } finally {
    await fixture.cleanup();
  }
});

test("executeRun does not unlock dependents for skipped dependencies without acceptance", async () => {
  const cases = [
    {
      name: "read-only",
      overrides: {
        allowed_files: [],
        allowedFiles: [],
        acceptance: [],
      },
    },
    {
      name: "final-verification",
      overrides: {
        acceptance: [],
        final_verification: true,
        finalVerification: true,
      },
    },
  ];

  for (const item of cases) {
    const fixture = await createFixture(`dependency-missing-acceptance-${item.name}`);
    try {
      const record = await createRunWithTasks(fixture.store, [
        taskContract("T-001", {
          title: `Invalid ${item.name} dependency contract`,
          ...item.overrides,
        }),
        taskContract("T-002", {
          title: "Dependent implementation",
          dependsOn: ["T-001"],
          depends_on: ["T-001"],
        }),
      ]);

      const result = await executeRun({
        runId: record.runId,
        store: fixture.store,
        verify: false,
        runtimeOptions: { workspace: { cwd: fixture.cwd } },
        generate: async () => {
          throw new Error(`generate should not run after invalid ${item.name} dependency`);
        },
        createReport: () => ({ schema: "ai-coding-runtime.report" }),
      });

      assert.equal(result.status, "failed");
      assert.equal(result.skippedTasks[0].taskId, "T-001");
      assert.equal(result.skippedTasks[0].reason, "missing_acceptance");
      assert.equal(result.failedTasks[0].taskId, "T-002");
      assert.equal(result.failedTasks[0].error.code, "task.dependencies.unresolved");
    } finally {
      await fixture.cleanup();
    }
  }
});

test("executeRun escalates tier and retries after worker failure", async () => {
  const fixture = await createFixture("tier-escalation-retry");
  try {
    await writeFile(join(fixture.cwd, "src", "app.js"), "export const value = 1;\n", "utf8");
    const record = await createRunWithTasks(
      fixture.store,
      [
        taskContract("T-001", {
          modelTier: "standard",
          model_tier: "standard",
          routing: {
            selected_model: { provider: "local", model: "standard-worker", tier: "standard" },
            selectedModel: { provider: "local", model: "standard-worker", tier: "standard" },
          },
        }),
      ],
      {
        modelRegistry: [
          { provider: "local", model: "standard-worker", tier: "standard" },
          { provider: "local", model: "premium-worker", tier: "premium" },
        ],
        model_registry: [
          { provider: "local", model: "standard-worker", tier: "standard" },
          { provider: "local", model: "premium-worker", tier: "premium" },
        ],
      }
    );
    const models = [];

    const result = await executeRun({
      runId: record.runId,
      store: fixture.store,
      verify: false,
      runtimeOptions: { workspace: { cwd: fixture.cwd } },
      generate: async (request) => {
        models.push(request.model);
        const patch = patchFor("src/app.js", "export const value = 1;", "export const value = 2;");
        if (request.model === "standard-worker") {
          const response = modelResponse(request, { patch });
          response.text = JSON.stringify({
            ...workerResult({ patch }),
            acceptance: {},
          });
          return response;
        }

        return modelResponse(request, { patch });
      },
      createReport: () => ({ schema: "ai-coding-runtime.report" }),
    });

    assert.equal(result.status, "verification_skipped");
    assert.deepEqual(models, ["standard-worker", "premium-worker"]);
    assert.equal(result.executedTasks[0].taskId, "T-001");
    assert.equal(result.executedTasks[0].modelTier, "premium");
    assert.equal(result.executedTasks[0].attemptCount, 2);
    assert.deepEqual(result.executedTasks[0].attempts.map((attempt) => attempt.status), [
      "failed",
      "applied",
    ]);
    assert.equal(result.failedTasks.length, 0);
    assert.equal(await readFile(join(fixture.cwd, "src", "app.js"), "utf8"), "export const value = 2;\n");

    const updated = await fixture.store.readRecord(record.runId);
    assert.equal(updated.workerAttempts.length, 2);
    assert.equal(updated.workerAttempts[0].status, "failed");
    assert.equal(updated.workerAttempts[1].status, "applied");
    assert.ok(updated.events.some((event) => event.type === "task.execution.escalated"));
  } finally {
    await fixture.cleanup();
  }
});

test("executeRun honors tierOrder inside snake-case escalation_policy", async () => {
  const fixture = await createFixture("snake-escalation-policy-tier-order");
  try {
    await writeFile(join(fixture.cwd, "src", "app.js"), "export const value = 1;\n", "utf8");
    const record = await createRunWithTasks(
      fixture.store,
      [
        taskContract("T-001", {
          modelTier: "cheap",
          model_tier: "cheap",
          routing: {
            selected_model: { provider: "local", model: "cheap-worker", tier: "cheap" },
            selectedModel: { provider: "local", model: "cheap-worker", tier: "cheap" },
          },
        }),
      ],
      {
        escalationPolicy: undefined,
        escalation_policy: {
          tierOrder: ["cheap", "premium"],
        },
        modelRegistry: [
          { provider: "local", model: "cheap-worker", tier: "cheap" },
          { provider: "local", model: "standard-worker", tier: "standard" },
          { provider: "local", model: "premium-worker", tier: "premium" },
        ],
      }
    );
    const models = [];

    const result = await executeRun({
      runId: record.runId,
      store: fixture.store,
      verify: false,
      runtimeOptions: { workspace: { cwd: fixture.cwd } },
      generate: async (request) => {
        models.push(request.model);
        const patch = patchFor("src/app.js", "export const value = 1;", "export const value = 2;");
        if (request.model === "cheap-worker") {
          return {
            provider: request.provider,
            model: request.model,
            text: "not json",
            structuredOutput: null,
            structured_output: null,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            costEstimate: { currency: "USD", estimatedCost: 0 },
            cost_estimate: { currency: "USD", estimated_cost: 0 },
            finishReason: "stop",
            finish_reason: "stop",
            request: { durationMs: 1, duration_ms: 1 },
          };
        }

        return modelResponse(request, { patch });
      },
      createReport: () => ({ schema: "ai-coding-runtime.report" }),
    });

    assert.equal(result.status, "verification_skipped");
    assert.deepEqual(models, ["cheap-worker", "premium-worker"]);
    assert.equal(result.executedTasks[0].modelTier, "premium");
  } finally {
    await fixture.cleanup();
  }
});

test("executeRun uses routing runtimeOptions for escalation models and tier order", async () => {
  const fixture = await createFixture("runtime-options-routing-escalation");
  try {
    await writeFile(join(fixture.cwd, "src", "app.js"), "export const value = 1;\n", "utf8");
    const record = await createRunWithTasks(fixture.store, [
      taskContract("T-001", {
        modelTier: "cheap",
        model_tier: "cheap",
        routing: {
          selected_model: { provider: "local", model: "cheap-worker", tier: "cheap" },
          selectedModel: { provider: "local", model: "cheap-worker", tier: "cheap" },
        },
      }),
    ]);
    const models = [];

    const result = await executeRun({
      runId: record.runId,
      store: fixture.store,
      verify: false,
      runtimeOptions: {
        workspace: { cwd: fixture.cwd },
        routing: {
          escalationPolicy: {
            tierOrder: ["cheap", "premium"],
          },
          modelRegistry: [
            { provider: "local", model: "cheap-worker", tier: "cheap" },
            { provider: "local", model: "premium-runtime-worker", tier: "premium" },
          ],
        },
      },
      generate: async (request) => {
        models.push(request.model);
        const patch = patchFor("src/app.js", "export const value = 1;", "export const value = 2;");
        if (request.model === "cheap-worker") {
          const response = modelResponse(request, { patch });
          response.text = "not json";
          return response;
        }
        if (request.model !== "premium-runtime-worker") {
          throw new Error(`unexpected model ${request.model}`);
        }

        return modelResponse(request, { patch });
      },
      createReport: () => ({ schema: "ai-coding-runtime.report" }),
    });

    assert.equal(result.status, "verification_skipped");
    assert.deepEqual(models, ["cheap-worker", "premium-runtime-worker"]);
    assert.equal(result.executedTasks[0].model, "premium-runtime-worker");
  } finally {
    await fixture.cleanup();
  }
});


test("executeRun includes allowed file contents in the worker prompt", async () => {
  const fixture = await createFixture("prompt-context");
  try {
    await writeFile(join(fixture.cwd, "src", "app.js"), "export const value = 1;\nexport const label = \"ready\";\n", "utf8");
    const record = await createRunWithTasks(fixture.store, [taskContract("T-001")]);
    let receivedPrompt = "";

    const result = await executeRun({
      runId: record.runId,
      store: fixture.store,
      verify: false,
      runtimeOptions: { workspace: { cwd: fixture.cwd } },
      generate: async (request) => {
        receivedPrompt = request.messages.map((message) => message.content).join("\n");
        return modelResponse(request, {
          patch: patchFor("src/app.js", "export const value = 1;", "export const value = 2;"),
        });
      },
      createReport: () => ({ schema: "ai-coding-runtime.report" }),
    });

    assert.equal(result.status, "verification_skipped");
    assert.match(receivedPrompt, /src\/app\.js/);
    assert.match(receivedPrompt, /export const label = "ready";/);
  } finally {
    await fixture.cleanup();
  }
});

test("executeRun truncates large worker context files before prompting the model", async () => {
  const fixture = await createFixture("prompt-context-truncate");
  try {
    const largeContent = `export const value = 1;\n${"A".repeat(20000)}\nTAIL_MARKER_SHOULD_NOT_APPEAR\n`;
    await writeFile(join(fixture.cwd, "src", "app.js"), largeContent, "utf8");
    const record = await createRunWithTasks(fixture.store, [taskContract("T-001")]);
    let receivedPrompt = "";

    const result = await executeRun({
      runId: record.runId,
      store: fixture.store,
      verify: false,
      runtimeOptions: {
        workspace: { cwd: fixture.cwd },
        execution: { maxContextBytesPerFile: 4096 },
      },
      generate: async (request) => {
        receivedPrompt = request.messages.map((message) => message.content).join("\n");
        return modelResponse(request, {
          patch: patchFor("src/app.js", "export const value = 1;", "export const value = 2;"),
        });
      },
      createReport: () => ({ schema: "ai-coding-runtime.report" }),
    });

    assert.equal(result.status, "verification_skipped");
    assert.doesNotMatch(receivedPrompt, /TAIL_MARKER_SHOULD_NOT_APPEAR/);
  } finally {
    await fixture.cleanup();
  }
});

test("executeRun applies task context selectors to referenced JSON files", async () => {
  const fixture = await createFixture("prompt-context-selectors");
  try {
    await writeFile(join(fixture.cwd, "src", "app.js"), "export const value = 1;\n", "utf8");
    await writeFile(
      join(fixture.cwd, "runtime.config.json"),
      JSON.stringify(
        {
          server: { host: "127.0.0.1" },
          providers: {
            entries: {
              "openai-compatible": {
                defaultModel: "gpt-config-default",
                baseUrl: "https://example.test/v1",
              },
            },
          },
          verification: {
            final_review: {
              model: "gpt-config-final",
              provider: "openai-compatible",
            },
          },
        },
        null,
        2
      ),
      "utf8"
    );
    const record = await createRunWithTasks(fixture.store, [
      taskContract("T-001", {
        referenced_files: ["runtime.config.json"],
        referencedFiles: ["runtime.config.json"],
        context_selectors: {
          "runtime.config.json": [
            "providers.entries.openai-compatible.defaultModel",
            "verification.final_review.model",
          ],
        },
        contextSelectors: {
          "runtime.config.json": [
            "providers.entries.openai-compatible.defaultModel",
            "verification.final_review.model",
          ],
        },
      }),
    ]);
    let receivedPrompt = "";

    const result = await executeRun({
      runId: record.runId,
      store: fixture.store,
      verify: false,
      runtimeOptions: { workspace: { cwd: fixture.cwd } },
      generate: async (request) => {
        receivedPrompt = request.messages.map((message) => message.content).join("\n");
        return modelResponse(request, {
          patch: patchFor("src/app.js", "export const value = 1;", "export const value = 2;"),
        });
      },
      createReport: () => ({ schema: "ai-coding-runtime.report" }),
    });

    assert.equal(result.status, "verification_skipped");
    assert.match(receivedPrompt, /runtime\.config\.json/);
    assert.match(receivedPrompt, /gpt-config-default/);
    assert.match(receivedPrompt, /gpt-config-final/);
    assert.doesNotMatch(receivedPrompt, /127\.0\.0\.1/);
    assert.doesNotMatch(receivedPrompt, /example\.test/);
  } finally {
    await fixture.cleanup();
  }
});

test("executeRun redacts worker prompts before calling providers", async () => {
  const fixture = await createFixture("redacts-prompt");
  try {
    await writeFile(join(fixture.cwd, "src", "app.js"), "export const value = 1;\n", "utf8");
    const record = await createRunWithTasks(fixture.store, [
      taskContract("T-001", {
        goal: "Update app file with apiKey=super-secret-token hidden from providers.",
      }),
    ]);
    let receivedPrompt = "";

    await executeRun({
      runId: record.runId,
      store: fixture.store,
      verify: false,
      runtimeOptions: {
        workspace: { cwd: fixture.cwd },
        policy: {
          secrets: {
            patterns: ["apiKey"],
          },
        },
      },
      generate: async (request) => {
        receivedPrompt = request.messages.map((message) => message.content).join("\n");
        return modelResponse(request, {
          patch: patchFor("src/app.js", "export const value = 1;", "export const value = 2;"),
        });
      },
      createReport: () => ({ schema: "ai-coding-runtime.report" }),
    });

    assert.doesNotMatch(receivedPrompt, /super-secret-token/);
    assert.match(receivedPrompt, /apiKey=\[REDACTED\]/);
  } finally {
    await fixture.cleanup();
  }
});


test("executeRun omits structured response schema for openai-compatible worker requests", async () => {
  const fixture = await createFixture("openai-compatible-schema");
  try {
    await writeFile(join(fixture.cwd, "src", "app.js"), "export const value = 1;\n", "utf8");
    const record = await createRunWithTasks(fixture.store, [
      taskContract("T-001", {
        routing: {
          selected_model: { provider: "openai-compatible", model: "gpt-5.4-mini" },
          selectedModel: { provider: "openai-compatible", model: "gpt-5.4-mini" },
        },
      }),
    ]);
    let receivedRequest = null;

    const result = await executeRun({
      runId: record.runId,
      store: fixture.store,
      verify: false,
      runtimeOptions: {
        workspace: { cwd: fixture.cwd },
        providers: {
          defaultProvider: "openai-compatible",
          entries: {
            "openai-compatible": {
              type: "openai-compatible",
              defaultModel: "gpt-5.4-mini",
            },
          },
        },
      },
      generate: async (request) => {
        receivedRequest = request;
        return modelResponse(request, {
          patch: patchFor("src/app.js", "export const value = 1;", "export const value = 2;"),
        });
      },
      createReport: () => ({ schema: "ai-coding-runtime.report" }),
    });

    assert.equal(result.status, "verification_skipped");
    assert.ok(receivedRequest);
    assert.equal(receivedRequest.provider, "openai-compatible");
    assert.equal(receivedRequest.responseSchema, undefined);
  } finally {
    await fixture.cleanup();
  }
});

test("executeRun allows openai-compatible worker response schema opt-in", async () => {
  const fixture = await createFixture("openai-compatible-schema-opt-in");
  try {
    await writeFile(join(fixture.cwd, "src", "app.js"), "export const value = 1;\n", "utf8");
    const record = await createRunWithTasks(fixture.store, [
      taskContract("T-001", {
        routing: {
          selected_model: { provider: "openai-compatible", model: "gpt-5.4-mini" },
          selectedModel: { provider: "openai-compatible", model: "gpt-5.4-mini" },
        },
      }),
    ]);
    let receivedRequest = null;

    const result = await executeRun({
      runId: record.runId,
      store: fixture.store,
      verify: false,
      runtimeOptions: {
        workspace: { cwd: fixture.cwd },
        providers: {
          defaultProvider: "openai-compatible",
          entries: {
            "openai-compatible": {
              type: "openai-compatible",
              defaultModel: "gpt-5.4-mini",
              workerResponseSchema: true,
            },
          },
        },
      },
      generate: async (request) => {
        receivedRequest = request;
        return modelResponse(request, {
          patch: patchFor("src/app.js", "export const value = 1;", "export const value = 2;"),
        });
      },
      createReport: () => ({ schema: "ai-coding-runtime.report" }),
    });

    assert.equal(result.status, "verification_skipped");
    assert.ok(receivedRequest);
    assert.equal(receivedRequest.provider, "openai-compatible");
    assert.equal(receivedRequest.responseSchema.type, "object");
  } finally {
    await fixture.cleanup();
  }
});

test("executeRun forwards worker timeout overrides to provider requests", async () => {
  const fixture = await createFixture("worker-timeout");
  try {
    await writeFile(join(fixture.cwd, "src", "app.js"), "export const value = 1;\n", "utf8");
    const record = await createRunWithTasks(fixture.store, [taskContract("T-001")]);
    let receivedRequest = null;

    const result = await executeRun({
      runId: record.runId,
      store: fixture.store,
      verify: false,
      runtimeOptions: {
        workspace: { cwd: fixture.cwd },
        execution: { workerTimeoutMs: 123456 },
      },
      generate: async (request) => {
        receivedRequest = request;
        return modelResponse(request, {
          patch: patchFor("src/app.js", "export const value = 1;", "export const value = 2;"),
        });
      },
      createReport: () => ({ schema: "ai-coding-runtime.report" }),
    });

    assert.equal(result.status, "verification_skipped");
    assert.ok(receivedRequest);
    assert.equal(receivedRequest.timeoutMs, 123456);
  } finally {
    await fixture.cleanup();
  }
});

test("executeRun fails safely when provider output is malformed", async () => {
  const fixture = await createFixture("malformed-output");
  try {
    await writeFile(join(fixture.cwd, "src", "app.js"), "export const value = 1;\n", "utf8");
    const record = await createRunWithTasks(fixture.store, [taskContract("T-001")]);

    const result = await executeRun({
      runId: record.runId,
      store: fixture.store,
      runtimeOptions: { workspace: { cwd: fixture.cwd } },
      generate: async () => ({
        provider: "local",
        model: "bad-worker",
        text: "not json",
        structuredOutput: null,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        costEstimate: { currency: "USD", estimatedCost: 0 },
        cost_estimate: { currency: "USD", estimated_cost: 0 },
        finishReason: "stop",
        finish_reason: "stop",
        request: { durationMs: 1, duration_ms: 1 },
      }),
      verifyRun: async () => {
        throw new Error("verify should not run after task execution failure");
      },
      createReport: () => ({ schema: "ai-coding-runtime.report" }),
    });

    assert.equal(result.status, "failed");
    assert.equal(result.failedTasks[0].taskId, "T-001");
    assert.match(result.failedTasks[0].error.message, /worker.output.malformed/);

    const updated = await fixture.store.readRecord(record.runId);
    assert.ok(updated.events.some((event) => event.type === "task.execution.failed"));
    assert.ok(updated.events.some((event) => event.type === "execution.failed"));
  } finally {
    await fixture.cleanup();
  }
});

test("executeRun can skip verification explicitly", async () => {
  const fixture = await createFixture("no-verify");
  try {
    await writeFile(join(fixture.cwd, "src", "app.js"), "export const value = 1;\n", "utf8");
    const record = await createRunWithTasks(fixture.store, [taskContract("T-001")]);

    const result = await executeRun({
      runId: record.runId,
      store: fixture.store,
      verify: false,
      runtimeOptions: { workspace: { cwd: fixture.cwd } },
      generate: async (request) => modelResponse(request, {
        patch: patchFor("src/app.js", "export const value = 1;", "export const value = 2;"),
      }),
      createReport: () => ({ schema: "ai-coding-runtime.report" }),
    });

    assert.equal(result.status, "verification_skipped");
    assert.equal(result.verification.status, "skipped");
    assert.equal(result.verification.message, "Verification skipped by execute request.");

    const updated = await fixture.store.readRecord(record.runId);
    assert.equal(updated.status, "verification_skipped");
    assert.equal(updated.verification.length, 1);
    assert.equal(updated.verification[0].status, "skipped");
    assert.equal(updated.verification[0].message, "Verification skipped by execute request.");
  } finally {
    await fixture.cleanup();
  }
});

test("skipReasonForTask prefers final verification reason over empty allowed files", async () => {
  assert.equal(
    skipReasonForTask(taskContract("T-final", {
      allowed_files: [],
      allowedFiles: [],
      final_verification: true,
    })),
    "final_verification_task"
  );
});

test("runtime_execute is listed and dispatches execution", async () => {
  const fixture = await createFixture("tool-dispatch");
  try {
    await writeFile(join(fixture.cwd, "src", "app.js"), "export const value = 1;\n", "utf8");
    const record = await createRunWithTasks(fixture.store, [taskContract("T-001")]);

    assert.ok(RUNTIME_TOOLS.some((tool) => tool.name === "runtime_execute"));
    const result = await callRuntimeTool(
      "runtime_execute",
      { runId: record.runId, apply: false, verify: false },
      {
        store: fixture.store,
        runtimeOptions: {
          workspace: { cwd: fixture.cwd },
          execution: {
            generate: async (request) => modelResponse(request, {
              patch: patchFor("src/app.js", "export const value = 1;", "export const value = 2;"),
            }),
          },
        },
      }
    );

    assert.equal(result.status, "verification_skipped");
    assert.equal(result.executedTasks[0].workerStatus, "recorded");
    assert.equal(await readFile(join(fixture.cwd, "src", "app.js"), "utf8"), "export const value = 1;\n");
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture(name) {
  const root = await mkdtemp(join(tmpdir(), `acr-${name}-`));
  const cwd = join(root, "workspace");
  await mkdir(join(cwd, "src"), { recursive: true });
  return {
    root,
    cwd,
    store: new FileExecutionStore({ workspace: join(root, "runtime") }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function createRunWithTasks(store, tasks, planOverrides = {}) {
  const plan = createRuntimePlan({ request: "Plan only: inspect project structure without modifying files." });
  const record = await store.createRecord(plan);
  return store.updateRecord(record.runId, (current) => ({
    ...current,
    status: "planned",
    plan: {
      ...current.plan,
      approval: { required: false, status: "not_required", reasons: [] },
      approvalRequired: false,
      approval_required: false,
      tasks,
      taskGraph: { ...current.plan.taskGraph, tasks },
      task_graph: { ...current.plan.task_graph, tasks },
      ...planOverrides,
    },
  }));
}

function taskContract(taskId, overrides = {}) {
  return {
    id: taskId,
    task_id: taskId,
    title: "Update app file",
    goal: "Update the allowed implementation file.",
    difficulty: "L2",
    risk: "low",
    contextNeed: "low",
    context_need: "low",
    verification: "easy",
    modelTier: "standard",
    model_tier: "standard",
    routing: {
      selected_model: { provider: "local", model: "worker" },
      selectedModel: { provider: "local", model: "worker" },
    },
    allowed_files: ["src/app.js"],
    allowedFiles: ["src/app.js"],
    referenced_files: [],
    referencedFiles: [],
    forbidden_actions: ["Do not edit files outside allowed_files"],
    forbiddenActions: ["Do not edit files outside allowed_files"],
    acceptance: ["Allowed file is updated"],
    dependsOn: [],
    depends_on: [],
    ...overrides,
  };
}

function modelResponse(request, { patch }) {
  return {
    provider: request.provider,
    model: request.model,
    text: JSON.stringify(workerResult({ patch })),
    structuredOutput: null,
    structured_output: null,
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    costEstimate: { currency: "USD", estimatedCost: 0.01 },
    cost_estimate: { currency: "USD", estimated_cost: 0.01 },
    finishReason: "stop",
    finish_reason: "stop",
    request: { durationMs: 1, duration_ms: 1 },
  };
}

function workerResult({ patch }) {
  return {
    patch,
    explanation: "Updated the allowed implementation file.",
    verificationNotes: ["Checked the patch touches only the allowed file."],
    confidence: 0.9,
    filesTouched: ["src/app.js"],
    acceptance: {
      "Allowed file is updated": "The patch changes src/app.js.",
    },
  };
}

function patchFor(filePath, before, after) {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    "@@ -1 +1 @@",
    `-${before}`,
    `+${after}`,
    "",
  ].join("\n");
}
