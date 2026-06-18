import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

    const runResponse = await postJson(`${started.httpUrl}/api/runs`, {
      request: "为支付模块生成计划",
    });
    assert.equal(runResponse.status, 201);
    const run = await runResponse.json();

    const verifyResponse = await postJson(`${started.httpUrl}/api/verify`, {
      runId: run.runId,
    });
    assert.equal(verifyResponse.status, 200);
    const verification = await verifyResponse.json();
    assert.equal(verification.runId, run.runId);
    assert.equal(verification.status, "skipped");
    assert.match(verification.message, /V0/);

    const approveResponse = await postJson(`${started.httpUrl}/api/runs/${run.runId}/approve`, {
      approvedBy: "gateway-test",
      note: "approved through HTTP",
    });
    assert.equal(approveResponse.status, 200);
    const approved = await approveResponse.json();
    assert.equal(approved.status, "approved");
    assert.equal(approved.approvalStatus, "approved");

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
