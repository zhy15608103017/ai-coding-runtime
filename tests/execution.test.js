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

async function createRunWithTasks(store, tasks) {
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
