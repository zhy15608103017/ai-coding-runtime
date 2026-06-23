# Worker Auto Execution Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit, single-pass `runtime_execute` path that lets AI Coding Runtime execute eligible worker tasks through configured model providers, submit the structured worker result through existing validation, optionally verify, and return an auditable report.

**Architecture:** Add a focused `src/runtime/execution.js` orchestration module and keep gateway files thin. The executor reads the run, checks execution eligibility, builds a strict worker prompt, calls a model through injected generation, records model traces, submits results through `submitWorkerResult`, runs injected verification, and builds a report. Existing `runtime_run` remains plan-only.

**Tech Stack:** Node.js ESM, `node:test`, existing runtime store/tool/worker/provider/report modules.

---

## File Structure

- Create `src/runtime/execution.js`: core single-pass worker execution orchestration, eligibility checks, provider/model resolution, strict JSON parsing, execution events, and result shaping.
- Create `tests/execution.test.js`: focused unit tests for executor behavior using a real `FileExecutionStore` and injected deterministic callbacks.
- Modify `src/runtime/tools.js`: add `runtime_execute` schema and dispatch to `executeRun`, inject existing `generateModelResponse`, `submitWorkerResult`, private `verifyRun`, and `createReport`.
- Modify `src/cli.js`: add `execute <run-id> [--no-apply] [--no-verify] [--json]`.
- Modify `src/server.js`: add `POST /api/runs/:id/execute`.
- Modify `src/index.js`: export executor helpers if the public module already exports runtime primitives.
- Modify `README.md` and/or `docs/integrations/README.md`: document the explicit execute surface and the no-hidden-execution rule.
- Modify integration tests (`tests/cli.test.js`, `tests/gateway.test.js`) only for the new CLI/HTTP/MCP surfaces.

## Task 1: Core Executor Red Tests

**Files:**
- Create: `tests/execution.test.js`
- Later create: `src/runtime/execution.js`

- [ ] **Step 1: Write failing tests for approval refusal, task skipping, successful execution, malformed output, and optional verification**

Create `tests/execution.test.js` with these concrete tests and helpers:

```javascript
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeRun } from "../src/runtime/execution.js";
import { createRuntimePlan } from "../src/runtime/planner.js";
import { FileExecutionStore } from "../src/runtime/store.js";

test("executeRun refuses runs waiting for approval", async () => {
  const fixture = await createFixture("refuses-approval");
  try {
    const plan = createRuntimePlan({
      request: "Change payment authentication and database schema.",
      policy: {
        approvals: {
          requireApprovalForRisk: ["low", "medium", "high"],
        },
      },
      policyExplicit: true,
    });
    const record = await fixture.store.createRecord(plan);

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
    const plan = createPlanWithTasks([
      taskContract("T-001", { title: "Read only", allowed_files: [], acceptance: ["Summarize files"] }),
      taskContract("T-002", { title: "Final review", final_verification: true }),
      taskContract("T-003", { title: "Already done" }),
    ]);
    const record = await fixture.store.createRecord(plan);
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
      verify: async () => ({ runId: record.runId, status: "skipped", commands: [] }),
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
    const plan = createPlanWithTasks([taskContract("T-001")]);
    const record = await fixture.store.createRecord(plan);

    const result = await executeRun({
      runId: record.runId,
      store: fixture.store,
      runtimeOptions: { workspace: { cwd: fixture.cwd } },
      generate: async (request) => ({
        provider: request.provider,
        model: request.model,
        text: JSON.stringify(workerResult({
          patch: patchFor("src/app.js", "export const value = 1;\n", "export const value = 2;\n"),
        })),
        structuredOutput: null,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        costEstimate: { currency: "USD", estimatedCost: 0.01 },
        cost_estimate: { currency: "USD", estimated_cost: 0.01 },
        finishReason: "stop",
        finish_reason: "stop",
        request: { durationMs: 1, duration_ms: 1 },
      }),
      verify: async () => ({ runId: record.runId, status: "passed", commands: [] }),
      createReport: () => ({ schema: "ai-coding-runtime.report" }),
    });

    assert.equal(result.status, "verification_passed");
    assert.equal(result.executedTasks.length, 1);
    assert.equal(result.executedTasks[0].taskId, "T-001");
    assert.equal(result.executedTasks[0].workerStatus, "applied");
    assert.equal(await readFile(filePath, "utf8"), "export const value = 2;\n");

    const updated = await fixture.store.readRecord(record.runId);
    assert.equal(updated.modelCalls.length, 1);
    assert.equal(updated.workerAttempts.length, 1);
    assert.ok(updated.events.some((event) => event.type === "execution.started"));
    assert.ok(updated.events.some((event) => event.type === "task.execution.started"));
    assert.ok(updated.events.some((event) => event.type === "task.execution.finished"));
    assert.ok(updated.events.some((event) => event.type === "execution.finished"));
  } finally {
    await fixture.cleanup();
  }
});

test("executeRun fails safely when provider output is malformed", async () => {
  const fixture = await createFixture("malformed-output");
  try {
    await writeFile(join(fixture.cwd, "src", "app.js"), "export const value = 1;\n", "utf8");
    const plan = createPlanWithTasks([taskContract("T-001")]);
    const record = await fixture.store.createRecord(plan);

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
      verify: async () => {
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
    const plan = createPlanWithTasks([taskContract("T-001")]);
    const record = await fixture.store.createRecord(plan);

    const result = await executeRun({
      runId: record.runId,
      store: fixture.store,
      verify: false,
      runtimeOptions: { workspace: { cwd: fixture.cwd } },
      generate: async () => ({
        provider: "local",
        model: "worker",
        text: JSON.stringify(workerResult({
          patch: patchFor("src/app.js", "export const value = 1;\n", "export const value = 2;\n"),
        })),
        structuredOutput: null,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        costEstimate: { currency: "USD", estimatedCost: 0 },
        cost_estimate: { currency: "USD", estimated_cost: 0 },
        finishReason: "stop",
        finish_reason: "stop",
        request: { durationMs: 1, duration_ms: 1 },
      }),
      createReport: () => ({ schema: "ai-coding-runtime.report" }),
    });

    assert.equal(result.status, "verification_skipped");
    assert.equal(result.verification.status, "skipped");
    assert.equal(result.verification.message, "Verification skipped by execute request.");
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

function createPlanWithTasks(tasks) {
  const plan = createRuntimePlan({ request: "Update app implementation." });
  return {
    ...plan,
    approval: { required: false, status: "not_required", reasons: [] },
    approvalRequired: false,
    approval_required: false,
    tasks,
    taskGraph: { ...plan.taskGraph, tasks },
    task_graph: { ...plan.task_graph, tasks },
  };
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
    `-${before.trimEnd()}`,
    `+${after.trimEnd()}`,
    "",
  ].join("\n");
}
```

- [ ] **Step 2: Run the red test**

Run:

```bash
node --test tests/execution.test.js
```

Expected: FAIL because `../src/runtime/execution.js` does not exist or does not export `executeRun`.

## Task 2: Core Executor Implementation

**Files:**
- Create: `src/runtime/execution.js`
- Test: `tests/execution.test.js`

- [ ] **Step 1: Implement the minimal executor**

Create `src/runtime/execution.js` with this shape:

```javascript
import { createWorkerPrompt } from "./worker.js";
import { generateModelResponse } from "./providers.js";
import { submitWorkerResult as defaultSubmitWorkerResult } from "./worker.js";
import { createReport as defaultCreateReport } from "./report.js";
import { RUN_STATUS } from "./status.js";

const EXECUTABLE_STATUSES = new Set([
  RUN_STATUS.planned,
  RUN_STATUS.approved,
  RUN_STATUS.verificationFailed,
  RUN_STATUS.verificationSkipped,
]);

const SUCCESSFUL_WORKER_STATUSES = new Set(["applied", "recorded"]);

export async function executeRun({
  runId,
  apply = true,
  verify = true,
  store,
  runtimeOptions = {},
  generate = generateModelResponse,
  submitWorkerResult = defaultSubmitWorkerResult,
  verifyRun,
  createReport = defaultCreateReport,
} = {}) {
  if (!store?.readRecord || !store?.updateRecord) {
    throw new Error("runtime_execute requires a store.");
  }
  if (!runId || typeof runId !== "string") {
    throw new Error("runId is required.");
  }

  const startedAt = new Date().toISOString();
  let record = await store.readRecord(runId);
  if (!EXECUTABLE_STATUSES.has(record.status)) {
    throw conflictError(`Run ${runId} cannot execute from ${record.status} status.`);
  }

  await appendEvent(store, runId, { type: "execution.started", timestamp: startedAt, apply, verify });

  const executedTasks = [];
  const skippedTasks = [];
  const failedTasks = [];

  for (const task of record.plan.tasks ?? []) {
    const taskId = task.task_id ?? task.id;
    const skipReason = skipReasonForTask(task, record.workerAttempts ?? []);
    if (skipReason) {
      skippedTasks.push({ taskId, task_id: taskId, reason: skipReason });
      continue;
    }

    const modelSelection = resolveTaskModel(task, runtimeOptions);
    await appendEvent(store, runId, {
      type: "task.execution.started",
      taskId,
      task_id: taskId,
      provider: modelSelection.provider,
      model: modelSelection.model,
    });

    try {
      const prompt = createStrictWorkerPrompt(task);
      const response = await generate({
        provider: modelSelection.provider,
        model: modelSelection.model,
        messages: [
          { role: "system", content: "You are an AI Coding Runtime worker. Return only valid JSON." },
          { role: "user", content: prompt },
        ],
        responseSchema: workerResponseSchema(),
      }, { providers: runtimeOptions.providers });

      await recordModelCall(store, runId, response);
      const workerOutput = parseWorkerOutput(response);
      const submitted = await submitWorkerResult({
        runId,
        taskId,
        result: workerOutput,
        apply,
        store,
        runtimeOptions,
      });

      const executedTask = {
        taskId,
        task_id: taskId,
        modelTier: task.model_tier ?? task.modelTier,
        model_tier: task.model_tier ?? task.modelTier,
        provider: response.provider ?? modelSelection.provider,
        model: response.model ?? modelSelection.model,
        workerStatus: submitted.status,
        worker_status: submitted.status,
      };
      executedTasks.push(executedTask);
      await appendEvent(store, runId, {
        type: "task.execution.finished",
        taskId,
        task_id: taskId,
        status: submitted.status,
      });
    } catch (error) {
      const failure = {
        taskId,
        task_id: taskId,
        provider: modelSelection.provider,
        model: modelSelection.model,
        error: {
          message: error.message,
          code: error.code ?? error.validation?.errors?.[0]?.code ?? "task.execution.failed",
        },
      };
      failedTasks.push(failure);
      await appendEvent(store, runId, {
        type: "task.execution.failed",
        taskId,
        task_id: taskId,
        provider: modelSelection.provider,
        model: modelSelection.model,
        error: failure.error,
      });
      await appendEvent(store, runId, {
        type: "execution.failed",
        status: "failed",
        failedTaskCount: failedTasks.length,
      });
      return buildExecuteResult({
        runId,
        status: "failed",
        executedTasks,
        skippedTasks,
        failedTasks,
        verification: { runId, status: "skipped", message: "Verification skipped after execution failure.", commands: [] },
        store,
        createReport,
        runtimeOptions,
      });
    }

    record = await store.readRecord(runId);
  }

  let verification;
  if (verify) {
    if (typeof verifyRun !== "function") {
      verification = { runId, status: "skipped", message: "Verification helper unavailable.", commands: [] };
    } else {
      verification = await verifyRun(runId, store, runtimeOptions);
    }
  } else {
    verification = { runId, status: "skipped", message: "Verification skipped by execute request.", commands: [] };
  }

  const status = statusForVerification(verification.status);
  await appendEvent(store, runId, {
    type: "execution.finished",
    status,
    executedTaskCount: executedTasks.length,
    skippedTaskCount: skippedTasks.length,
  });

  return buildExecuteResult({
    runId,
    status,
    executedTasks,
    skippedTasks,
    failedTasks,
    verification,
    store,
    createReport,
    runtimeOptions,
  });
}

export function skipReasonForTask(task, workerAttempts = []) {
  const taskId = task.task_id ?? task.id;
  const allowedFiles = task.allowed_files ?? task.allowedFiles ?? [];
  if (!Array.isArray(allowedFiles) || allowedFiles.length === 0) return "read_only_or_no_allowed_files";
  if (task.final_verification === true || task.finalVerification === true) return "final_verification_task";
  if (!Array.isArray(task.acceptance) || task.acceptance.length === 0) return "missing_acceptance";
  if (workerAttempts.some((attempt) => (attempt.task_id ?? attempt.taskId) === taskId && SUCCESSFUL_WORKER_STATUSES.has(attempt.status))) {
    return "already_successful_worker_attempt";
  }
  return null;
}
```

Then add the helper functions used above in the same file: `createStrictWorkerPrompt`, `resolveTaskModel`, `parseWorkerOutput`, `recordModelCall`, `appendEvent`, `buildExecuteResult`, `statusForVerification`, `workerResponseSchema`, and `conflictError`. Keep them private except `skipReasonForTask` for direct tests if needed.

- [ ] **Step 2: Run the green test**

Run:

```bash
node --test tests/execution.test.js
```

Expected: PASS.

- [ ] **Step 3: Refactor only after green**

Tighten helper names and remove duplication. Do not add retry, concurrency, or tier mapping.

- [ ] **Step 4: Run focused tests again**

Run:

```bash
node --test tests/execution.test.js
```

Expected: PASS.

## Task 3: Runtime Tool Surface

**Files:**
- Modify: `src/runtime/tools.js`
- Test: `tests/execution.test.js` or a focused new test in `tests/gateway.test.js`

- [ ] **Step 1: Write failing tool dispatch test**

Append to `tests/execution.test.js`:

```javascript
import { callRuntimeTool, RUNTIME_TOOLS } from "../src/runtime/tools.js";

test("runtime_execute is listed and dispatches execution", async () => {
  const fixture = await createFixture("tool-dispatch");
  try {
    await writeFile(join(fixture.cwd, "src", "app.js"), "export const value = 1;\n", "utf8");
    const plan = createPlanWithTasks([taskContract("T-001")]);
    const record = await fixture.store.createRecord(plan);

    assert.ok(RUNTIME_TOOLS.some((tool) => tool.name === "runtime_execute"));
    const result = await callRuntimeTool(
      "runtime_execute",
      { runId: record.runId, apply: false, verify: false },
      {
        store: fixture.store,
        runtimeOptions: {
          workspace: { cwd: fixture.cwd },
          execution: {
            generate: async () => ({
              provider: "local",
              model: "worker",
              text: JSON.stringify(workerResult({
                patch: patchFor("src/app.js", "export const value = 1;\n", "export const value = 2;\n"),
              })),
              structuredOutput: null,
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              costEstimate: { currency: "USD", estimatedCost: 0 },
              cost_estimate: { currency: "USD", estimated_cost: 0 },
              finishReason: "stop",
              finish_reason: "stop",
              request: { durationMs: 1, duration_ms: 1 },
            }),
          },
        },
      }
    );

    assert.equal(result.status, "verification_skipped");
    assert.equal(result.executedTasks[0].workerStatus, "recorded");
  } finally {
    await fixture.cleanup();
  }
});
```

- [ ] **Step 2: Run red test**

Run:

```bash
node --test tests/execution.test.js
```

Expected: FAIL because `runtime_execute` is not listed or dispatched.

- [ ] **Step 3: Add schema and dispatch**

In `src/runtime/tools.js`:

```javascript
import { executeRun } from "./execution.js";
```

Add a `RUNTIME_TOOLS` entry:

```javascript
{
  name: "runtime_execute",
  description: "Explicitly execute eligible worker tasks for a persisted run.",
  inputSchema: executeSchema(),
},
```

Add a switch case:

```javascript
case "runtime_execute":
  return executeRun({
    runId: requireRunId(args),
    apply: args.apply !== false,
    verify: args.verify !== false,
    store,
    runtimeOptions,
    generate: runtimeOptions.execution?.generate,
    verifyRun,
    createReport,
  });
```

Add schema:

```javascript
function executeSchema() {
  return {
    type: "object",
    properties: {
      runId: { type: "string" },
      apply: { type: "boolean" },
      verify: { type: "boolean" },
    },
    required: ["runId"],
    additionalProperties: false,
  };
}
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
node --test tests/execution.test.js
```

Expected: PASS.

## Task 4: CLI Execute Command

**Files:**
- Modify: `src/cli.js`
- Modify: `tests/cli.test.js`

- [ ] **Step 1: Write failing CLI test**

Add a test following existing `runCli` patterns:

```javascript
test("execute command calls runtime_execute and prints JSON", async () => {
  const fixture = await createCliFixture("execute-json");
  try {
    const io = createIo();
    const exitCode = await runCli(["execute", "run_123", "--no-apply", "--no-verify", "--json"], {
      ...io,
      env: { AI_CODING_RUNTIME_HOME: fixture.runtimeHome },
    });

    assert.equal(exitCode, 0);
    const output = JSON.parse(io.stdout.output);
    assert.equal(output.runId, "run_123");
    assert.equal(output.status, "verification_skipped");
  } finally {
    await fixture.cleanup();
  }
});
```

If existing CLI tests do not support provider injection, write this as a lower-level parse/command behavior test against a fixture run and local provider, matching local helper style.

- [ ] **Step 2: Run red CLI test**

Run:

```bash
node --test tests/cli.test.js
```

Expected: FAIL with unknown command `execute`.

- [ ] **Step 3: Implement CLI command**

In `src/cli.js` switch:

```javascript
case "execute":
  return await executeCommand(rest, io);
```

Add command:

```javascript
async function executeCommand(args, io) {
  const { positional, options } = parseArgs(args);
  const [runId] = positional;
  if (!runId) {
    throw new Error("execute requires a run id.");
  }

  const config = await loadRuntimeConfig();
  const store = new FileExecutionStore({ workspace: config.storage.directory });
  const result = await callRuntimeTool(
    "runtime_execute",
    {
      runId,
      apply: options.noApply === true ? false : true,
      verify: options.noVerify === true ? false : true,
    },
    { store, runtimeOptions: runtimeOptionsFromConfig(config) }
  );

  if (options.json) {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    io.stdout.write(`${result.runId}: execute ${result.status} (${result.executedTasks.length} executed, ${result.skippedTasks.length} skipped)\n`);
  }
  return result.status === "failed" || result.status === "verification_failed" ? 1 : 0;
}
```

Extend `parseArgs`:

```javascript
} else if (arg === "--no-apply") {
  options.noApply = true;
} else if (arg === "--no-verify") {
  options.noVerify = true;
}
```

Extend `helpText`:

```text
  ai-coding-runtime execute <run-id> [--no-apply] [--no-verify] [--json]
```

- [ ] **Step 4: Run CLI tests**

Run:

```bash
node --test tests/cli.test.js
```

Expected: PASS.

## Task 5: HTTP And MCP Gateway

**Files:**
- Modify: `src/server.js`
- Modify: `tests/gateway.test.js`
- MCP uses `RUNTIME_TOOLS`, so no production change is expected in `src/mcp.js` unless tests reveal a mismatch.

- [ ] **Step 1: Write failing HTTP and MCP tests**

Add tests:

```javascript
test("HTTP POST /api/runs/:id/execute calls runtime_execute", async () => {
  const fixture = await createGatewayFixture("http-execute");
  try {
    const record = await fixture.store.createRecord(createPlanWithTasks([taskContract("T-001")]));
    const server = createRuntimeHttpServer({
      store: fixture.store,
      runtimeOptions: {
        workspace: { cwd: fixture.cwd },
        execution: { generate: fixture.generateWorkerResult },
      },
    });
    const started = await listen(server, { port: 0 });
    try {
      const response = await fetch(`${started.httpUrl}/api/runs/${record.runId}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apply: false, verify: false }),
      });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.runId, record.runId);
      assert.equal(body.status, "verification_skipped");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await fixture.cleanup();
  }
});

test("MCP lists and calls runtime_execute", async () => {
  const list = await handleMcpJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.ok(list.result.tools.some((tool) => tool.name === "runtime_execute"));
});
```

- [ ] **Step 2: Run red gateway tests**

Run:

```bash
node --test tests/gateway.test.js
```

Expected: HTTP execute test fails with 404; MCP list may pass after Task 3.

- [ ] **Step 3: Add HTTP route**

In `src/server.js`, after worker result or approve route:

```javascript
const executeMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/execute$/);
if (request.method === "POST" && executeMatch) {
  const body = await readJsonBody(request);
  const executed = await callRuntimeTool(
    "runtime_execute",
    {
      runId: executeMatch[1],
      apply: body.apply,
      verify: body.verify,
    },
    { store, runtimeOptions }
  );
  return sendJson(response, 200, executed);
}
```

- [ ] **Step 4: Run gateway tests**

Run:

```bash
node --test tests/gateway.test.js
```

Expected: PASS.

## Task 6: Public Export And Docs

**Files:**
- Modify: `src/index.js`
- Modify: `README.md`
- Optionally modify: `docs/integrations/README.md`

- [ ] **Step 1: Check current exports**

Run:

```bash
node -e "import('./src/index.js').then((m)=>console.log(Object.keys(m).sort().join('\n')))"
```

Expected: current export list printed.

- [ ] **Step 2: Export executor if index exports runtime primitives**

If `src/index.js` exports existing runtime modules, add:

```javascript
export { executeRun, skipReasonForTask } from "./runtime/execution.js";
```

- [ ] **Step 3: Document explicit execution**

Add a short section to `README.md`:

```markdown
### Execute Worker Tasks

`runtime_run` creates and stores a plan only. It does not call worker models or apply patches.

Use the explicit execution surface after reviewing or approving a run:

```bash
ai-coding-runtime execute <run-id> --json
```

For smoke tests or integrations:

```bash
ai-coding-runtime execute <run-id> --no-apply --no-verify --json
```

HTTP and MCP expose the same behavior through `POST /api/runs/:id/execute` and `runtime_execute`.
```

- [ ] **Step 4: Run docs/export smoke check**

Run:

```bash
node -e "import('./src/index.js').then((m)=>console.log(Boolean(m.executeRun)))"
```

Expected: prints `true` if exported, or skip this check if `src/index.js` is intentionally not public.

## Task 7: Full Verification And Review Loop

**Files:**
- Create or update: `.ai-review/review-context/current-request.md`

- [ ] **Step 1: Run all tests**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Write review context**

Run the code-review-loop context writer with a self-contained Chinese request summary:

```bash
node .agents/skills/code-review-loop/scripts/write-review-context.mjs --from-file .ai-review/review-context/draft-request.md
```

The draft must include:

```markdown
# 当前请求

实现 Phase 10.5 Worker Auto Execution Loop。新增显式 opt-in 的 `runtime_execute`，让 Runtime 在用户明确执行时，单次执行符合条件的 worker tasks，调用配置的模型 provider，解析结构化 worker JSON，通过现有 `submitWorkerResult` 校验/记录/可选应用 patch，可选调用现有 verification，并返回 report。

# 约束

- 不改变 `runtime_run` 默认行为。
- 不做自动多轮重试、并发执行或学习型路由。
- `approval_required` run 必须拒绝执行。
- 跳过只读/无 `allowed_files`、`final_verification`、无 acceptance、已有成功 worker attempt 的任务。
- provider/model 优先来自 task routing selected model，再回退到 provider config 默认值。
- 所有 model call、worker attempt、execution events、verification 和 report 必须可追踪。

# 验收

- `runtime_execute` tool 可用。
- CLI `execute` 可用。
- HTTP `POST /api/runs/:id/execute` 可用。
- MCP tools/list 包含并可调用 `runtime_execute`。
- malformed worker output 安全失败。
- `npm test` 通过。
```

- [ ] **Step 3: Run AI review**

Run:

```bash
node .agents/skills/code-review-loop/scripts/ai-review.mjs --profile auto --verify "npm test"
```

Expected: requirement audit and code review pass, or only non-blocking warnings remain.

- [ ] **Step 4: Fix blocking P0/P1 findings**

If the review returns blocking findings, fix them with TDD where behavior changes are needed, rerun:

```bash
npm test
node .agents/skills/code-review-loop/scripts/ai-review.mjs --profile auto --verify "npm test"
```

Repeat at most three review rounds.

## Self-Review

- Spec coverage: The plan covers explicit `runtime_execute`, single-pass execution, approval refusal, task eligibility, provider/model selection, worker prompt/output parsing, trace events, optional verification, CLI, HTTP, MCP, docs, full tests, and review loop.
- Placeholder scan: No `TBD`, open-ended "add appropriate" steps, or unscoped "write tests" steps remain.
- Type consistency: The plan consistently uses `runId`, `taskId`, `executedTasks`, `skippedTasks`, `failedTasks`, `workerStatus`, `verification`, `report`, and the snake_case aliases already common in the repo.
