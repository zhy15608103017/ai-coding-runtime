import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  asMcpToolResult,
  callRuntimeTool,
  createRunInspection,
  FileExecutionStore,
  formatInspectionMarkdown,
  normalizePolicyConfig,
  RUNTIME_TOOLS,
} from "../src/index.js";
import { createRuntimeHttpServer, listen } from "../src/server.js";

const cliPath = path.resolve("bin", "ai-coding-runtime.js");

test("createRunInspection exposes task routing, acceptance, and escalation state", () => {
  const record = visibilityRecord();
  const inspection = createRunInspection(record);

  assert.equal(inspection.runId, "run_visibility");
  assert.equal(inspection.status, "verification_failed");
  assert.equal(inspection.summary.taskCount, 3);
  assert.deepEqual(inspection.summary.tierCounts, {
    cheap: 1,
    standard: 1,
    premium: 1,
  });
  assert.equal(inspection.summary.taskCountsByStatus.applied, 1);
  assert.equal(inspection.summary.taskCountsByStatus.final_review, 1);
  assert.equal(inspection.summary.workerAttemptCountsByStatus.failed, 1);

  const implementation = inspection.tasks.find((task) => task.taskId === "T-002");
  assert.equal(implementation.status, "applied");
  assert.equal(implementation.difficulty, "L2");
  assert.equal(implementation.risk, "medium");
  assert.equal(implementation.modelTier, "standard");
  assert.deepEqual(implementation.model, {
    provider: "openai-compatible",
    model: "gpt-standard",
    tier: "standard",
  });
  assert.match(implementation.routing.reason, /file-editing/i);
  assert.equal(implementation.worker.attemptCount, 2);
  assert.equal(implementation.worker.latestStatus, "applied");
  assert.deepEqual(implementation.worker.filesTouched, ["src/app.js"]);
  assert.equal(implementation.acceptance.status, "passed");
  assert.equal(implementation.acceptance.passed, 2);
  assert.equal(implementation.acceptance.total, 2);
  assert.equal(implementation.escalations.length, 1);
  assert.equal(implementation.escalations[0].fromTier, "standard");
  assert.equal(implementation.escalations[0].toTier, "premium");
  assert.equal(implementation.escalations[0].fromModel, "gpt-standard");
  assert.equal(implementation.escalations[0].toModel, "gpt-premium");
  assert.equal(implementation.escalations[0].reason, "worker.output.malformed");
  assert.equal(implementation.escalations[0].attempt, 1);

  const finalReview = inspection.tasks.find((task) => task.taskId === "T-003");
  assert.equal(finalReview.status, "final_review");
  assert.equal(finalReview.modelTier, "premium");
  assert.equal(finalReview.acceptance.status, "skipped");

  assert.equal(inspection.verification.latestStatus, "failed");
  assert.equal(inspection.verification.commandStatus, "failed");
  assert.equal(inspection.verification.acceptanceStatus, "passed");
  assert.equal(inspection.verification.supervisorStatus, "failed");
  assert.equal(inspection.escalation.required, true);
  assert.equal(inspection.escalation.targetTier, "premium");
  assert.ok(inspection.nextActions.some((action) => action.code === "fix_verification"));
});

test("createRunInspection accepts camelCase routing trace aliases", () => {
  const record = visibilityRecord();
  const implementation = record.plan.tasks.find((task) => task.task_id === "T-002");
  implementation.routing = {};
  implementation.routingReason = [];
  implementation.routing_reason = [];
  record.plan.routingTrace = [
    {
      taskId: "T-002",
      selectedModel: {
        provider: "openai-compatible",
        model: "gpt-camel",
        tier: "standard",
      },
      reason: "camelCase routing trace",
      escalationTriggers: ["camel_case_trigger"],
    },
  ];

  const inspection = createRunInspection(record);
  const task = inspection.tasks.find((candidate) => candidate.taskId === "T-002");

  assert.equal(task.model.model, "gpt-camel");
  assert.equal(task.routing.reason, "camelCase routing trace");
  assert.deepEqual(task.routing.escalationTriggers, ["camel_case_trigger"]);
});

test("formatInspectionMarkdown renders a Chinese run visibility summary", () => {
  const markdown = formatInspectionMarkdown(createRunInspection(visibilityRecord()));

  assert.match(markdown, /# Runtime 运行观察/);
  assert.match(markdown, /运行：run_visibility/);
  assert.match(markdown, /任务：3 个/);
  assert.match(markdown, /模型层级：standard/);
  assert.match(markdown, /验收：passed/);
  assert.match(markdown, /允许文件：src\/app\.js/);
  assert.match(markdown, /引用文件：docs\/requirements\.md/);
  assert.match(markdown, /触达文件：src\/app\.js/);
  assert.match(markdown, /失败原因：worker\.output\.malformed/);
  assert.match(markdown, /验收证据：实现逻辑=passed：代码已更新/);
  assert.match(markdown, /升级：standard -> premium/);
  assert.match(markdown, /模型 gpt-standard -> gpt-premium/);
  assert.match(markdown, /下一步/);
});

test("runtime_inspect exposes the shared inspection model through MCP tools", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-inspect-tool-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "plan only: inspect runtime visibility" },
      { store }
    );

    assert.ok(RUNTIME_TOOLS.some((tool) => tool.name === "runtime_inspect"));

    const inspection = await callRuntimeTool(
      "runtime_inspect",
      { runId: run.runId },
      { store }
    );
    assert.equal(inspection.runId, run.runId);
    assert.equal(inspection.summary.taskCount, run.plan.tasks.length);
    assert.ok(inspection.tasks.every((task) => task.modelTier));

    const markdown = await callRuntimeTool(
      "runtime_inspect",
      { runId: run.runId, format: "markdown" },
      { store }
    );
    assert.equal(markdown.runId, run.runId);
    assert.match(markdown.markdown, /Runtime 运行观察/);
    const mcpMarkdown = asMcpToolResult(markdown);
    assert.equal(mcpMarkdown.content[0].text, markdown.markdown);
    assert.equal(mcpMarkdown.structuredContent.inspection.runId, run.runId);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("HTTP gateway exposes run inspection", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-inspect-http-"));
  const store = new FileExecutionStore({ workspace });
  const server = createRuntimeHttpServer({ store });
  const started = await listen(server, { host: "127.0.0.1", port: 0 });

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "plan only: inspect through HTTP" },
      { store }
    );
    const response = await fetch(`${started.httpUrl}/api/runs/${run.runId}/inspect`);
    assert.equal(response.status, 200);
    const inspection = await response.json();

    assert.equal(inspection.runId, run.runId);
    assert.equal(inspection.summary.taskCount, run.plan.tasks.length);
    assert.ok(inspection.nextActions.some((action) => action.code === "execute_ready"));
  } finally {
    await closeServer(server);
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime inspection surfaces redact secrets with runtime policy", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-inspect-redaction-"));
  const cliWorkspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-inspect-cli-redaction-"));
  const store = new FileExecutionStore({ workspace });
  const runtimeOptions = { policy: normalizePolicyConfig() };
  const server = createRuntimeHttpServer({ store, runtimeOptions });
  const started = await listen(server, { host: "127.0.0.1", port: 0 });

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "plan only: inspect token=runtime-secret" },
      { store, runtimeOptions }
    );
    await store.updateRecord(run.runId, (record) => {
      const taskId = record.plan.tasks[0].task_id;
      record.workerAttempts.push({
        attemptId: "secret_attempt",
        taskId,
        status: "failed",
        applied: false,
        validation: {
          errors: [{ code: "worker.secret", message: "password=hunter2" }],
        },
      });
      record.verification.push({
        name: "verification",
        status: "failed",
        acceptance: {
          status: "failed",
          tasks: [
            {
              task_id: taskId,
              status: "failed",
              items: [
                {
                  criterion: "protect secret",
                  status: "failed",
                  evidence: "api_key=acceptance-secret",
                },
              ],
            },
          ],
        },
        supervisorReview: {
          status: "failed",
          blockingIssues: ["token=supervisor-secret"],
        },
      });
      return record;
    });

    const toolInspection = await callRuntimeTool(
      "runtime_inspect",
      { runId: run.runId },
      { store, runtimeOptions }
    );
    const toolMarkdown = await callRuntimeTool(
      "runtime_inspect",
      { runId: run.runId, format: "markdown" },
      { store, runtimeOptions }
    );
    const httpResponse = await fetch(`${started.httpUrl}/api/runs/${run.runId}/inspect`);
    const httpInspection = await httpResponse.json();

    for (const output of [toolInspection, toolMarkdown, httpInspection]) {
      const serialized = JSON.stringify(output);
      assert.match(serialized, /\[REDACTED\]/);
      assert.doesNotMatch(serialized, /runtime-secret/);
      assert.doesNotMatch(serialized, /hunter2/);
      assert.doesNotMatch(serialized, /acceptance-secret/);
      assert.doesNotMatch(serialized, /supervisor-secret/);
    }

    const cliRun = runCli(["run", "plan only: inspect token=cli-secret", "--json"], cliWorkspace);
    assert.equal(cliRun.status, 0, cliRun.stderr);
    const cliRunRecord = JSON.parse(cliRun.stdout);
    const cliInspect = runCli(["inspect", cliRunRecord.runId, "--json"], cliWorkspace);
    assert.equal(cliInspect.status, 0, cliInspect.stderr);
    assert.match(cliInspect.stdout, /\[REDACTED\]/);
    assert.doesNotMatch(cliInspect.stdout, /cli-secret/);
  } finally {
    await closeServer(server);
    await rm(workspace, { recursive: true, force: true });
    await rm(cliWorkspace, { recursive: true, force: true });
  }
});

test("inspect CLI prints Chinese markdown by default and JSON with --json", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-inspect-cli-"));

  try {
    const runResult = runCli(["run", "plan only: inspect from cli", "--json"], workspace);
    assert.equal(runResult.status, 0, runResult.stderr);
    const run = JSON.parse(runResult.stdout);

    const markdownResult = runCli(["inspect", run.runId], workspace);
    assert.equal(markdownResult.status, 0, markdownResult.stderr);
    assert.match(markdownResult.stdout, /Runtime 运行观察/);
    assert.match(markdownResult.stdout, /任务/);
    assert.match(markdownResult.stdout, /模型层级/);

    const jsonResult = runCli(["inspect", run.runId, "--json"], workspace);
    assert.equal(jsonResult.status, 0, jsonResult.stderr);
    const inspection = JSON.parse(jsonResult.stdout);
    assert.equal(inspection.runId, run.runId);
    assert.equal(inspection.summary.taskCount, run.plan.tasks.length);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function visibilityRecord() {
  return {
    runId: "run_visibility",
    status: "verification_failed",
    request: "实现可观测运行面板",
    createdAt: "2026-06-24T00:00:00.000Z",
    updatedAt: "2026-06-24T00:01:00.000Z",
    plan: {
      approval: { required: true, status: "approved", reasons: [] },
      budgetStatus: {
        allowed: true,
        currency: "USD",
        estimatedCost: 0.26,
        estimatedCalls: 3,
        estimatedRetries: 2,
        violations: [],
      },
      policyStatus: { allowed: true, violations: [] },
      validation: { valid: true, errors: [] },
      estimatedCost: { currency: "USD", maximum: 0.26 },
      tasks: [
        task("T-001", {
          title: "读取上下文",
          difficulty: "L1",
          risk: "low",
          modelTier: "cheap",
          allowedFiles: [],
          selectedModel: {
            provider: "openai-compatible",
            model: "gpt-cheap",
            tier: "cheap",
          },
          reason: "read-only task can use cheap tier",
        }),
        task("T-002", {
          title: "实现代码变更",
          difficulty: "L2",
          risk: "medium",
          modelTier: "standard",
          allowedFiles: ["src/app.js"],
          referencedFiles: ["docs/requirements.md"],
          acceptance: ["实现逻辑", "保留边界"],
          selectedModel: {
            provider: "openai-compatible",
            model: "gpt-standard",
            tier: "standard",
          },
          reason: "file-editing tasks require at least the standard tier",
        }),
        task("T-003", {
          title: "最终审查",
          difficulty: "L4",
          risk: "high",
          modelTier: "premium",
          finalVerification: true,
          selectedModel: {
            provider: "openai-compatible",
            model: "gpt-premium",
            tier: "premium",
          },
          reason: "final verification always uses the premium tier",
        }),
      ],
      routingTrace: [
        route("T-001", "cheap", "gpt-cheap", "read-only task can use cheap tier"),
        route("T-002", "standard", "gpt-standard", "file-editing tasks require at least the standard tier"),
        route("T-003", "premium", "gpt-premium", "final verification always uses the premium tier"),
      ],
    },
    modelCalls: [
      {
        taskId: "T-002",
        provider: "openai-compatible",
        model: "gpt-standard",
        usage: { totalTokens: 100 },
        costEstimate: { currency: "USD", estimatedCost: 0.01 },
        request: { taskId: "T-002" },
      },
      {
        taskId: "T-002",
        provider: "openai-compatible",
        model: "gpt-premium",
        usage: { totalTokens: 150 },
        costEstimate: { currency: "USD", estimatedCost: 0.03 },
        request: { taskId: "T-002" },
      },
    ],
    workerAttempts: [
      {
        attemptId: "attempt_failed",
        attempt_id: "attempt_failed",
        taskId: "T-002",
        task_id: "T-002",
        status: "failed",
        applied: false,
        filesTouched: ["src/app.js"],
        files_touched: ["src/app.js"],
        validation: {
          errors: [{ code: "worker.output.malformed", message: "malformed output" }],
        },
      },
      {
        attemptId: "attempt_applied",
        attempt_id: "attempt_applied",
        taskId: "T-002",
        task_id: "T-002",
        status: "applied",
        applied: true,
        confidence: 0.88,
        filesTouched: ["src/app.js"],
        files_touched: ["src/app.js"],
        acceptance: {
          "实现逻辑": "代码已更新",
          "保留边界": "只改动 src/app.js",
        },
      },
    ],
    verification: [
      {
        name: "verification",
        status: "failed",
        message: "Verification failed.",
        commands: [
          {
            name: "node-test",
            status: "failed",
            required: true,
            exitCode: 1,
            durationMs: 20,
          },
        ],
        acceptance: {
          status: "passed",
          tasks: [
            {
              task_id: "T-002",
              status: "passed",
              items: [
                { criterion: "实现逻辑", status: "passed", evidence: "代码已更新" },
                { criterion: "保留边界", status: "passed", evidence: "只改动 src/app.js" },
              ],
            },
          ],
        },
        supervisorReview: {
          status: "failed",
          blockingIssues: ["验证命令失败"],
        },
        escalation: {
          required: true,
          reason: "verification_failed_after_non_premium_worker",
          fromTiers: ["standard"],
          targetTier: "premium",
        },
      },
    ],
    events: [
      {
        type: "task.execution.escalated",
        timestamp: "2026-06-24T00:00:30.000Z",
        taskId: "T-002",
        task_id: "T-002",
        fromTier: "standard",
        from_tier: "standard",
        toTier: "premium",
        to_tier: "premium",
        fromModel: "gpt-standard",
        from_model: "gpt-standard",
        toModel: "gpt-premium",
        to_model: "gpt-premium",
        attempt: 1,
        reason: "worker.output.malformed",
      },
    ],
  };
}

function task(taskId, overrides = {}) {
  const selectedModel = overrides.selectedModel ?? {
    provider: "openai-compatible",
    model: "gpt-test",
    tier: overrides.modelTier ?? "cheap",
  };
  const acceptance = overrides.acceptance ?? [`${taskId} 完成`];
  return {
    id: taskId,
    task_id: taskId,
    title: overrides.title ?? taskId,
    goal: overrides.goal ?? `${taskId} goal`,
    difficulty: overrides.difficulty ?? "L1",
    risk: overrides.risk ?? "low",
    contextNeed: "low",
    context_need: "low",
    verification: "easy",
    modelTier: overrides.modelTier ?? "cheap",
    model_tier: overrides.modelTier ?? "cheap",
    routingReason: [overrides.reason ?? "test routing"],
    routing_reason: [overrides.reason ?? "test routing"],
    routing: {
      task_id: taskId,
      model_tier: overrides.modelTier ?? "cheap",
      selected_model: selectedModel,
      reason: overrides.reason ?? "test routing",
      escalation_triggers: ["failed_checks"],
    },
    finalVerification: overrides.finalVerification === true,
    final_verification: overrides.finalVerification === true,
    allowedFiles: overrides.allowedFiles ?? [],
    allowed_files: overrides.allowedFiles ?? [],
    referencedFiles: overrides.referencedFiles ?? [],
    referenced_files: overrides.referencedFiles ?? [],
    forbiddenActions: [],
    forbidden_actions: [],
    acceptance,
    expectedOutput: ["result"],
    expected_output: ["result"],
    dependsOn: [],
    depends_on: [],
  };
}

function route(taskId, tier, model, reason) {
  return {
    task_id: taskId,
    model_tier: tier,
    selected_model: {
      provider: "openai-compatible",
      model,
      tier,
    },
    reason,
    escalation_triggers: ["failed_checks"],
  };
}

function runCli(args, workspace, cwd = path.resolve(".")) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: {
      ...process.env,
      AI_CODING_RUNTIME_HOME: workspace,
    },
    encoding: "utf8",
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
