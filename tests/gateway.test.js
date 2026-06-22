import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createRuntimeHttpServer, listen } from "../src/server.js";
import { FileExecutionStore } from "../src/index.js";

test("HTTP gateway exposes estimate, verify, cancel, and report endpoints", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-http-"));
  const store = new FileExecutionStore({ workspace });
  const server = createRuntimeHttpServer({ store });
  const started = await listen(server, { host: "127.0.0.1", port: 0 });

  try {
    const estimateResponse = await postJson(`${started.httpUrl}/api/estimate`, {
      request: "为支付模块生成计划",
    });
    assert.equal(estimateResponse.status, 200);
    const estimate = await estimateResponse.json();
    assert.equal(estimate.request, "为支付模块生成计划");
    assert.equal(estimate.modelTiers.length, 3);
    assert.ok(estimate.tasks.length >= 5);
    assert.equal(estimate.approval.status, "required");
    assert.equal(estimate.validation.valid, true);
    assert.equal(estimate.planReport.approval.status, "required");
    assert.match(estimate.planningPrompt, /Task Contract/);
    assert.equal(estimate.modelRegistry.length, 3);
    assert.equal(estimate.budgetStatus.allowed, true);
    assert.equal(estimate.routingTrace.length, estimate.tasks.length);
    assert.equal(typeof estimate.tasks[0].classification.confidence, "number");

    const runResponse = await postJson(`${started.httpUrl}/api/runs`, {
      request: "为支付模块生成计划",
    });
    assert.equal(runResponse.status, 201);
    const run = await runResponse.json();

    const verifyBeforeApprovalResponse = await postJson(`${started.httpUrl}/api/verify`, {
      runId: run.runId,
    });
    assert.equal(verifyBeforeApprovalResponse.status, 409);
    const verifyBeforeApproval = await verifyBeforeApprovalResponse.json();
    assert.match(verifyBeforeApproval.message, /approval_required/);

    const approveResponse = await postJson(`${started.httpUrl}/api/runs/${run.runId}/approve`, {
      approvedBy: "gateway-test",
      note: "approved through HTTP",
    });
    assert.equal(approveResponse.status, 200);
    const approved = await approveResponse.json();
    assert.equal(approved.status, "approved");
    assert.equal(approved.approvalStatus, "approved");

    const verifyResponse = await postJson(`${started.httpUrl}/api/verify`, {
      runId: run.runId,
    });
    assert.equal(verifyResponse.status, 200);
    const verification = await verifyResponse.json();
    assert.equal(verification.runId, run.runId);
    assert.equal(verification.status, "skipped");
    assert.match(verification.message, /No verification commands configured/);

    const cancelResponse = await postJson(`${started.httpUrl}/api/runs/${run.runId}/cancel`, {
      reason: "test cleanup",
    });
    assert.equal(cancelResponse.status, 200);
    const canceled = await cancelResponse.json();
    assert.equal(canceled.status, "canceled");

    const approveCanceledResponse = await postJson(`${started.httpUrl}/api/runs/${run.runId}/approve`, {
      approvedBy: "gateway-test",
      note: "should fail after cancel",
    });
    assert.equal(approveCanceledResponse.status, 409);
    const approveCanceled = await approveCanceledResponse.json();
    assert.match(approveCanceled.message, /approval_required/);

    const reportResponse = await fetch(`${started.httpUrl}/api/runs/${run.runId}/report`);
    assert.equal(reportResponse.status, 200);
    const report = await reportResponse.json();
    assert.equal(report.runId, run.runId);
    assert.equal(report.status, "canceled");
    assert.equal(report.approval.status, "approved");
    assert.equal(report.validation.valid, true);
    assert.match(report.planningPrompt, /Task Contract/);
    assert.equal(report.budgetStatus.allowed, true);
    assert.equal(report.routingTrace.length, report.taskGraph.length);
    assert.equal(report.modelRegistry.length, 3);
  } finally {
    server.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("HTTP gateway passes verification runtime options to runtime_verify", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-http-verify-"));
  const store = new FileExecutionStore({ workspace });
  const server = createRuntimeHttpServer({
    store,
    runtimeOptions: {
      verification: {
        commands: [
          {
            name: "node-version",
            command: process.execPath,
            args: ["--version"],
            required: true,
            timeoutMs: 10000,
          },
        ],
      },
    },
  });
  const started = await listen(server, { host: "127.0.0.1", port: 0 });

  try {
    const runResponse = await postJson(`${started.httpUrl}/api/runs`, {
      request: "plan only: verify through HTTP without modifying files",
    });
    assert.equal(runResponse.status, 201);
    const run = await runResponse.json();
    assert.equal(run.status, "planned");

    const verifyResponse = await postJson(`${started.httpUrl}/api/verify`, {
      runId: run.runId,
    });
    assert.equal(verifyResponse.status, 200);
    const verification = await verifyResponse.json();
    assert.equal(verification.status, "passed");
    assert.equal(verification.commands.length, 1);
    assert.equal(verification.commands[0].name, "node-version");
    assert.equal(verification.commands[0].exitCode, 0);

    const record = await store.readRecord(run.runId);
    assert.equal(record.status, "verification_passed");
  } finally {
    server.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("HTTP MCP endpoint lists and calls runtime tools with structured content", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-mcp-http-"));
  const store = new FileExecutionStore({ workspace });
  const server = createRuntimeHttpServer({ store });
  const started = await listen(server, { host: "127.0.0.1", port: 0 });

  try {
    const initialize = await postJson(`${started.httpUrl}/mcp`, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.0" },
      },
    });
    assert.equal(initialize.status, 200);
    const initialized = await initialize.json();
    assert.equal(initialized.result.protocolVersion, "2025-06-18");
    assert.deepEqual(initialized.result.capabilities, { tools: {} });

    const list = await postJson(`${started.httpUrl}/mcp`, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    assert.equal(list.status, 200);
    const listed = await list.json();
    const toolNames = listed.result.tools.map((tool) => tool.name);
    assert.deepEqual(toolNames, [
      "runtime_plan",
      "runtime_estimate",
      "runtime_run",
      "runtime_status",
      "runtime_collect",
      "runtime_verify",
      "runtime_report",
      "runtime_cancel",
      "runtime_approve",
      "runtime_provider_health",
      "runtime_model_generate",
      "runtime_submit_worker_result",
    ]);

    const call = await postJson(`${started.httpUrl}/mcp`, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "runtime_run",
        arguments: {
          request: "通过 MCP 创建运行",
        },
      },
    });
    assert.equal(call.status, 200);
    const called = await call.json();
    assert.match(called.result.structuredContent.runId, /^run_/);
    assert.equal(called.result.structuredContent.status, "approval_required");
    assert.equal(called.result.content[0].type, "text");
  } finally {
    server.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("HTTP gateway exposes provider health and model generation endpoints", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-provider-http-"));
  const store = new FileExecutionStore({ workspace });
  const server = createRuntimeHttpServer({ store });
  const started = await listen(server, { host: "127.0.0.1", port: 0 });

  try {
    const healthResponse = await fetch(`${started.httpUrl}/api/providers/health?provider=local`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.providers.length, 1);
    assert.equal(health.providers[0].name, "local");
    assert.equal(health.providers[0].status, "placeholder");

    const generateResponse = await postJson(`${started.httpUrl}/api/model/generate`, {
      provider: "local",
      prompt: "hello",
    });
    assert.equal(generateResponse.status, 200);
    const generated = await generateResponse.json();
    assert.equal(generated.provider, "local");
    assert.match(generated.text, /hello/);
    assert.equal(generated.costEstimate.estimatedCost, 0);
  } finally {
    server.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("HTTP gateway records and applies worker results", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-worker-http-"));
  const project = path.join(workspace, "project");
  const store = new FileExecutionStore({ workspace: path.join(workspace, "runtime-data") });
  const server = createRuntimeHttpServer({
    store,
    runtimeOptions: {
      workspace: { cwd: project },
    },
  });
  const started = await listen(server, { host: "127.0.0.1", port: 0 });

  try {
    await writeProjectFile(project, "src/app.js", "export const value = 1;\n");

    const runResponse = await postJson(`${started.httpUrl}/api/runs`, {
      request: "implement a safe worker patch through HTTP",
    });
    assert.equal(runResponse.status, 201);
    const run = await runResponse.json();
    const task = run.plan.tasks.find((candidate) => candidate.task_id === "T-003");

    const approveResponse = await postJson(`${started.httpUrl}/api/runs/${run.runId}/approve`, {
      approvedBy: "gateway-worker-test",
    });
    assert.equal(approveResponse.status, 200);

    const workerResponse = await postJson(`${started.httpUrl}/api/runs/${run.runId}/worker-results`, {
      taskId: task.task_id,
      apply: true,
      result: workerResultForTask(task, {
        patch: patchFor("src/app.js", "export const value = 1;", "export const value = 2;"),
      }),
    });
    assert.equal(workerResponse.status, 200);
    const submitted = await workerResponse.json();
    assert.equal(submitted.status, "applied");
    assert.deepEqual(submitted.filesTouched, ["src/app.js"]);
    assert.equal(await readFile(path.join(project, "src/app.js"), "utf8"), "export const value = 2;\n");

    const reportResponse = await fetch(`${started.httpUrl}/api/runs/${run.runId}/report`);
    assert.equal(reportResponse.status, 200);
    const report = await reportResponse.json();
    assert.equal(report.workerAttempts.length, 1);
    assert.equal(report.workerSummary.appliedCount, 1);
  } finally {
    server.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("HTTP gateway applies runtime budget policy to estimates and runs", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-http-budget-"));
  const store = new FileExecutionStore({ workspace });
  const server = createRuntimeHttpServer({
    store,
    runtimeOptions: {
      budgetPolicy: {
        maxCostPerRun: 0.01,
        maxCallsPerRun: 1,
        maxRetryCount: 0,
      },
    },
  });
  const started = await listen(server, { host: "127.0.0.1", port: 0 });

  try {
    const estimateResponse = await postJson(`${started.httpUrl}/api/estimate`, {
      request: "implement an over-budget HTTP task",
    });
    assert.equal(estimateResponse.status, 200);
    const estimate = await estimateResponse.json();
    assert.equal(estimate.budgetStatus.allowed, false);
    assert.ok(estimate.budgetStatus.violations.some((violation) => violation.code === "budget.cost.exceeded"));

    const runResponse = await postJson(`${started.httpUrl}/api/runs`, {
      request: "implement an over-budget HTTP task",
    });
    assert.equal(runResponse.status, 409);
    const refused = await runResponse.json();
    assert.match(refused.message, /budget.policy.violation/);

    const mcpRunResponse = await postJson(`${started.httpUrl}/mcp`, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "runtime_run",
        arguments: {
          request: "implement an over-budget HTTP MCP task",
        },
      },
    });
    assert.equal(mcpRunResponse.status, 200);
    const mcpRun = await mcpRunResponse.json();
    assert.equal(mcpRun.id, 7);
    assert.match(mcpRun.error.message, /budget.policy.violation/);
  } finally {
    server.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("HTTP gateway requires bearer token when configured", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-auth-"));
  const store = new FileExecutionStore({ workspace });
  const server = createRuntimeHttpServer({ store, apiToken: "secret-token" });
  const started = await listen(server, { host: "127.0.0.1", port: 0 });

  try {
    const health = await fetch(`${started.httpUrl}/api/health`);
    assert.equal(health.status, 200);

    const denied = await postJson(`${started.httpUrl}/api/plan`, {
      request: "需要鉴权",
    });
    assert.equal(denied.status, 401);

    const allowed = await fetch(`${started.httpUrl}/api/plan`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ request: "需要鉴权" }),
    });
    assert.equal(allowed.status, 200);
    const plan = await allowed.json();
    assert.equal(plan.request, "需要鉴权");
  } finally {
    server.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function workerResultForTask(task, overrides = {}) {
  return {
    patch: overrides.patch,
    explanation: "Updated an allowed implementation file.",
    verificationNotes: ["Validated through HTTP gateway test."],
    confidence: 0.8,
    filesTouched: overrides.filesTouched ?? ["src/app.js"],
    acceptance: Object.fromEntries(
      task.acceptance.map((item) => [item, `Evidence for ${item}`])
    ),
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

async function writeProjectFile(workspace, relativePath, content) {
  const filePath = path.join(workspace, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}
