import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  callRuntimeTool,
  createDashboardHtml,
  createReport,
  FileExecutionStore,
  RUNTIME_TOOLS,
} from "../src/index.js";

const cliPath = path.resolve("bin", "ai-coding-runtime.js");

test("Phase 12 dashboard renders run, task, routing, shadow, cost, and verification visibility", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-phase12-dashboard-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "plan only: phase 12 dashboard visibility" },
      { store }
    );
    await store.updateRecord(run.runId, (record) => {
      const shadowClassifier = {
        enabled: true,
        mode: "shadow",
        status: "completed",
        provider: "review-provider",
        model: "review-classifier",
        summary: {
          potentialSavingsTasks: 1,
          potential_savings_tasks: 1,
          blockedBySafetyFloorTasks: 0,
          blocked_by_safety_floor_tasks: 0,
          ignoredLowConfidenceTasks: 0,
          ignored_low_confidence_tasks: 0,
          potentialSavingsUsd: 0.04,
          potential_savings_usd: 0.04,
        },
        recommendations: [
          {
            taskId: "T-001",
            task_id: "T-001",
            category: "potential_savings",
            recommendedTier: "cheap",
            recommended_tier: "cheap",
            confidence: 0.92,
            estimatedSavingsUsd: 0.04,
            estimated_savings_usd: 0.04,
          },
        ],
        warnings: [],
      };
      record.plan.shadowClassifier = shadowClassifier;
      record.plan.shadow_classifier = shadowClassifier;
      return record;
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

    const record = await store.readRecord(run.runId);
    const report = createReport(record);
    const html = createDashboardHtml(report);

    assert.match(html, /<!doctype html>/i);
    assert.match(html, /AI Coding Runtime Dashboard/);
    assert.match(html, new RegExp(run.runId));
    assert.match(html, /Task Graph/);
    assert.match(html, /Verification Timeline/);
    assert.match(html, /Cost Breakdown/);
    assert.match(html, /Model Performance/);
    assert.match(html, /Shadow Classifier/);
    assert.match(html, /potential savings/i);
    assert.match(html, /review-classifier/);
    assert.doesNotMatch(html, /<script/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("dashboard CLI writes a static HTML file for an existing run", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-phase12-dashboard-cli-"));

  try {
    const runResult = spawnSync(
      process.execPath,
      [cliPath, "run", "plan only: write phase 12 dashboard", "--json"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AI_CODING_RUNTIME_HOME: workspace,
        },
        encoding: "utf8",
      }
    );
    assert.equal(runResult.status, 0, runResult.stderr);
    const run = JSON.parse(runResult.stdout);
    const outFile = path.join(workspace, "reports", "dashboard.html");

    const dashboardResult = spawnSync(process.execPath, [cliPath, "dashboard", run.runId, "--out", outFile], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AI_CODING_RUNTIME_HOME: workspace,
      },
      encoding: "utf8",
    });

    assert.equal(dashboardResult.status, 0, dashboardResult.stderr);
    assert.match(dashboardResult.stdout, /Dashboard written/);
    const html = await readFile(outFile, "utf8");
    assert.match(html, /AI Coding Runtime Dashboard/);
    assert.match(html, new RegExp(run.runId));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime_dashboard tool writes dashboard HTML for MCP callers", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-phase12-dashboard-tool-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "plan only: dashboard through mcp tool" },
      { store }
    );
    const outFile = path.join(workspace, "mcp-dashboard.html");

    assert.ok(RUNTIME_TOOLS.some((tool) => tool.name === "runtime_dashboard"));
    const dashboard = await callRuntimeTool(
      "runtime_dashboard",
      { runId: run.runId, out: outFile },
      { store }
    );

    assert.equal(dashboard.runId, run.runId);
    assert.equal(dashboard.format, "html");
    assert.equal(dashboard.path, outFile);
    assert.equal(dashboard.bytes > 1000, true);
    assert.match(dashboard.message, /Dashboard written/);

    const html = await readFile(outFile, "utf8");
    assert.match(html, /AI Coding Runtime Dashboard/);
    assert.match(html, new RegExp(run.runId));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
