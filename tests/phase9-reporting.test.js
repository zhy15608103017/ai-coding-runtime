import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  callRuntimeTool,
  createReport,
  FileExecutionStore,
  formatReportMarkdown,
} from "../src/index.js";

const cliPath = path.resolve("bin", "ai-coding-runtime.js");

test("Phase 9 report exposes final report, cost report, trace data, and export format", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-phase9-report-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "plan only: phase 9 report visibility" },
      { store }
    );
    const record = await store.readRecord(run.runId);
    const task = record.plan.tasks[0];
    const taskId = task.task_id ?? task.id;

    await store.recordWorkerAttempt(run.runId, {
      attemptId: "attempt_phase9_success",
      attempt_id: "attempt_phase9_success",
      taskId,
      task_id: taskId,
      status: "applied",
      applied: true,
      filesTouched: ["README.md"],
      files_touched: ["README.md"],
    });
    await store.recordWorkerAttempt(run.runId, {
      attemptId: "attempt_phase9_failed",
      attempt_id: "attempt_phase9_failed",
      taskId,
      task_id: taskId,
      status: "failed",
      applied: false,
      filesTouched: ["SHOULD_NOT_BE_CHANGED.md"],
      files_touched: ["SHOULD_NOT_BE_CHANGED.md"],
      error: { code: "worker.patch.apply_failed", message: "patch did not apply" },
    });
    await store.recordModelCall(run.runId, {
      provider: "openai-compatible",
      model: "gpt-test",
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      costEstimate: { currency: "USD", estimatedCost: 0.000007, estimated_cost: 0.000007 },
      cost_estimate: { currency: "USD", estimatedCost: 0.000007, estimated_cost: 0.000007 },
      request: { taskId, task_id: taskId },
    });
    await store.recordModelCall(run.runId, {
      provider: "openai-compatible",
      model: "gpt-test",
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      costEstimate: { currency: "USD", estimatedCost: 0.000003, estimated_cost: 0.000003 },
      cost_estimate: { currency: "USD", estimatedCost: 0.000003, estimated_cost: 0.000003 },
      request: { attempts: 1 },
    });
    await callRuntimeTool(
      "runtime_verify",
      { runId: run.runId },
      {
        store,
        runtimeOptions: {
          verification: {
            diff_check: { enabled: false },
          },
        },
      }
    );
    const updated = await store.readRecord(run.runId);
    const report = createReport(updated, { historyRecords: [updated] });

    assert.deepEqual(report.changedFiles, ["README.md"]);
    assert.deepEqual(report.workerSummary.filesTouched, ["README.md", "SHOULD_NOT_BE_CHANGED.md"]);
    assert.equal(report.finalReport.changedFiles[0], "README.md");
    assert.equal(report.costReport.summary.providerCost, 0.00001);
    assert.equal(report.costReport.summary.unattributedProviderCost, 0.000003);
    assert.equal(report.perTaskModelUsage[0].taskId, taskId);
    assert.equal(report.perTaskModelUsage[0].actualCost, 0.000007);
    assert.equal(report.costReport.unattributedModelUsage.callCount, 1);
    assert.equal(report.costReport.unattributedModelUsage.estimatedCost, 0.000003);
    assert.ok(report.routingDecisions[0].reason);
    assert.equal(report.traceViewerData.run.runId, run.runId);
    assert.equal(report.exportFormat.schema, "ai-coding-runtime.report");
    assert.ok(report.finalReport.followUpRecommendations.length >= 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Phase 9 report categorizes provider, malformed output, policy, and verification failures", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-phase9-failures-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "plan only: phase 9 failure analysis" },
      { store }
    );
    const record = await store.readRecord(run.runId);
    const task = record.plan.tasks[0];
    const taskId = task.task_id ?? task.id;

    await store.recordModelCallFailure(run.runId, {
      provider: "openai-compatible",
      model: "gpt-test",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costEstimate: { currency: "USD", estimatedCost: 0, estimated_cost: 0 },
      cost_estimate: { currency: "USD", estimatedCost: 0, estimated_cost: 0 },
      request: { attempts: 1 },
      error: { code: "provider.http_error", message: "provider failed" },
    });
    await store.recordWorkerAttempt(run.runId, {
      attemptId: "attempt_phase9_failed",
      attempt_id: "attempt_phase9_failed",
      taskId,
      task_id: taskId,
      status: "failed",
      applied: false,
      filesTouched: [],
      files_touched: [],
      error: { code: "worker.output.invalid", message: "missing acceptance" },
    });
    await store.recordWorkerAttempt(run.runId, {
      attemptId: "attempt_phase9_forbidden_file",
      attempt_id: "attempt_phase9_forbidden_file",
      taskId,
      task_id: taskId,
      status: "failed",
      applied: false,
      filesTouched: ["README.md"],
      files_touched: ["README.md"],
      validation: {
        errors: [
          {
            code: "worker.patch.forbidden_file",
            message: "Worker patch touches file outside allowed_files.",
          },
        ],
      },
    });
    await store.updateRecord(run.runId, (current) => {
      current.plan.policyStatus = {
        allowed: false,
        violations: [{ code: "policy.user.violation", message: "blocked by policy" }],
      };
      return current;
    });
    await callRuntimeTool(
      "runtime_verify",
      { runId: run.runId },
      {
        store,
        runtimeOptions: {
          verification: {
            diff_check: { enabled: false },
            commands: [
              {
                name: "intentional-failure",
                command: process.execPath,
                args: ["-e", "process.exit(2)"],
                required: true,
              },
            ],
          },
        },
      }
    );
    const updated = await store.readRecord(run.runId);
    const report = createReport(updated);

    assert.equal(report.failureAnalysis.categoryCounts.provider_error, 1);
    assert.equal(report.failureAnalysis.categoryCounts.malformed_output, 1);
    assert.equal(report.failureAnalysis.categoryCounts.policy_violation, 2);
    assert.equal(report.failureAnalysis.categoryCounts.verification_failure, 1);
    assert.match(report.finalReport.followUpRecommendations.join("\n"), /verification/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Phase 9 runtime_report includes historical reliability metrics", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-phase9-history-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const first = await callRuntimeTool(
      "runtime_run",
      { request: "plan only: first reliability sample" },
      { store }
    );
    const second = await callRuntimeTool(
      "runtime_run",
      { request: "plan only: second reliability sample" },
      { store }
    );
    await callRuntimeTool(
      "runtime_run",
      { request: "plan only: unverified reliability sample" },
      { store }
    );

    await callRuntimeTool(
      "runtime_verify",
      { runId: first.runId },
      { store, runtimeOptions: { verification: { diff_check: { enabled: false } } } }
    );
    await callRuntimeTool(
      "runtime_verify",
      { runId: second.runId },
      {
        store,
        runtimeOptions: {
          verification: {
            diff_check: { enabled: false },
            commands: [
              {
                name: "history-failure",
                command: process.execPath,
                args: ["-e", "process.exit(3)"],
                required: true,
              },
            ],
          },
        },
      }
    );

    const report = await callRuntimeTool(
      "runtime_report",
      { runId: first.runId, format: "json" },
      { store }
    );

    assert.ok(report.modelReliability.samples.length >= 1);
    assert.ok(report.modelReliability.samples.some((sample) => sample.attempts >= 2));
    assert.ok(report.modelReliability.samples.every((sample) => sample.attempts <= 2));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Phase 9 model reliability ignores records without explicit verification outcomes", () => {
  const passed = reliabilityRecord("run_passed", "verification_passed", "passed");
  const failed = reliabilityRecord("run_failed", "verification_failed", "failed");
  const planned = reliabilityRecord("run_planned", "planned");
  const canceled = reliabilityRecord("run_canceled", "canceled");
  const canceledAfterPass = reliabilityRecord("run_canceled_after_pass", "canceled", "passed");
  const skipped = reliabilityRecord("run_skipped", "verification_skipped", "skipped");

  const report = createReport(passed, {
    historyRecords: [failed, planned, canceled, canceledAfterPass, skipped],
  });
  const sample = report.modelReliability.byTaskType.implementation.standard;

  assert.equal(sample.attempts, 2);
  assert.equal(sample.successes, 1);
  assert.equal(sample.failures, 1);
  assert.equal(sample.successRate, 0.5);
});

test("Phase 9 failure analysis includes rejected human approvals", () => {
  const record = reliabilityRecord("run_rejected", "approval_rejected");
  record.plan.approval = {
    required: true,
    status: "rejected",
    reasons: ["human rejected high-risk work"],
  };

  const report = createReport(record);

  assert.equal(report.failureAnalysis.categoryCounts.human_approval_rejected, 1);
  assert.equal(report.failureAnalysis.categories.human_approval_rejected[0].status, "rejected");
});

test("Phase 9 markdown model call details support snake_case cost fields", () => {
  const record = reliabilityRecord("run_snake_case_cost", "verification_passed", "passed");
  record.modelCalls = [
    {
      provider: "openai-compatible",
      model: "gpt-snake",
      usage: { totalTokens: 11 },
      cost_estimate: { currency: "USD", estimated_cost: 0.000011 },
      request: { task_id: "T-001" },
    },
  ];

  const report = createReport(record);
  const markdown = formatReportMarkdown(report);

  assert.match(markdown, /gpt-snake: 11 tokens, USD 0\.000011/);
});

test("Phase 9 CLI report supports JSON and Markdown exports", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-phase9-cli-"));

  try {
    const runResult = runCli(["run", "plan only: phase 9 cli report export", "--json"], workspace);
    assert.equal(runResult.status, 0, runResult.stderr);
    const run = JSON.parse(runResult.stdout);

    const jsonResult = runCli(["report", run.runId, "--json"], workspace);
    assert.equal(jsonResult.status, 0, jsonResult.stderr);
    const report = JSON.parse(jsonResult.stdout);
    assert.equal(report.exportFormat.schema, "ai-coding-runtime.report");
    assert.ok(report.finalReport);

    const markdownResult = runCli(["report", run.runId, "--markdown"], workspace);
    assert.equal(markdownResult.status, 0, markdownResult.stderr);
    assert.match(markdownResult.stdout, /Cost Estimate/);
    assert.match(markdownResult.stdout, /unattributed provider cost/);
    assert.match(markdownResult.stdout, /Model Reliability/);
    assert.match(markdownResult.stdout, /Follow-Up Recommendations/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Phase 9 roadmap checklist is complete without marking Phase 10 complete", async () => {
  const roadmap = await readFile(path.resolve("total.md"), "utf8");
  const phase9 = sectionBetween(roadmap, "## Phase 9:", "## Phase 10:");
  const phase10 = sectionBetween(roadmap, "## Phase 10:", "## Phase 11:");

  for (const task of phase9.matchAll(/- \[(x| )\] /g)) {
    assert.equal(task[1], "x");
  }
  assert.match(phase10, /- \[ \] /);
  assert.doesNotMatch(phase10, /- \[x\] /);
});

function runCli(args, runtimeHome) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      AI_CODING_RUNTIME_HOME: runtimeHome,
    },
    encoding: "utf8",
  });
}

function sectionBetween(content, startMarker, endMarker) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start + startMarker.length);

  assert.notEqual(start, -1, `${startMarker} not found`);
  assert.notEqual(end, -1, `${endMarker} not found`);
  return content.slice(start, end);
}

function reliabilityRecord(runId, status, verificationStatus) {
  return {
    runId,
    status,
    request: `reliability sample ${runId}`,
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
    plan: {
      tasks: [
        {
          id: "T-001",
          task_id: "T-001",
          title: "Implement sample task",
          taskType: "implementation",
          task_type: "implementation",
          dependsOn: [],
          depends_on: [],
          modelTier: "standard",
          model_tier: "standard",
          risk: "low",
          difficulty: "L2",
          routingReason: "file edit requires standard model",
          routing_reason: "file edit requires standard model",
        },
      ],
      taskGraph: {
        run_id: runId,
        tasks: ["T-001"],
        dependencies: [],
        approval_required: false,
        estimated_cost: 0,
        risk_summary: "low",
      },
      approval: { required: false, status: "not_required", reasons: [] },
      validation: { valid: true, errors: [] },
      planReport: {},
      planningPrompt: "Task Contract",
      modelRegistry: [],
      modelTierAliases: { cheap: "cheap", standard: "standard", premium: "premium" },
      routingPolicy: {},
      budgetPolicy: {},
      escalationPolicy: {},
      budgetStatus: { allowed: true, estimatedCost: 0, estimatedCalls: 0, estimatedRetries: 0, violations: [] },
      policyStatus: { allowed: true, violations: [] },
      routingTrace: [
        {
          task_id: "T-001",
          model_tier: "standard",
          selected_model: "gpt-test",
          reason: "file edit requires standard model",
          cost_hint: { estimated_usd_per_call: 0.01 },
          escalation_triggers: [],
        },
      ],
      estimatedCost: { currency: "USD", estimatedCost: 0.01 },
    },
    modelCalls: [],
    workerAttempts: [],
    verification: verificationStatus
      ? [
          {
            name: "verification",
            status: verificationStatus,
            commands: [],
            acceptance: { status: verificationStatus },
            supervisorReview: { status: "skipped" },
            escalation: { required: false, reason: "none" },
          },
        ]
      : [],
    events: [],
  };
}
