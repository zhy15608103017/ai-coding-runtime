import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createRuntimePlan,
  FileExecutionStore,
  loadRuntimeConfig,
  routeTask,
} from "../src/index.js";

test("createRuntimePlan returns task contracts with model routing", () => {
  const plan = createRuntimePlan({
    request: "为登录模块增加限流逻辑，并补充测试和最终验证",
  });

  assert.match(plan.planId, /^plan_/);
  assert.equal(plan.modelTiers.length, 3);
  assert.ok(plan.tasks.length >= 5);

  const ids = new Set(plan.tasks.map((task) => task.id));
  assert.equal(ids.size, plan.tasks.length);
  assert.equal(plan.tasks[0].difficulty, "L0");
  assert.equal(plan.tasks[0].modelTier, "cheap");

  const implementationTask = plan.tasks.find((task) =>
    task.title.includes("实现")
  );
  assert.ok(implementationTask);
  assert.equal(implementationTask.modelTier, "standard");
  assert.ok(implementationTask.acceptance.length > 0);

  const finalTask = plan.tasks.at(-1);
  assert.equal(finalTask.title, "最终审查与交付报告");
  assert.equal(finalTask.modelTier, "premium");
  assert.deepEqual(finalTask.dependsOn, [plan.tasks.at(-2).id]);
});

test("routeTask escalates high risk and hard-to-verify work", () => {
  assert.equal(
    routeTask({
      difficulty: "L1",
      risk: "low",
      contextNeed: "low",
      verification: "easy",
    }).modelTier,
    "cheap"
  );

  assert.equal(
    routeTask({
      difficulty: "L2",
      risk: "medium",
      contextNeed: "medium",
      verification: "medium",
    }).modelTier,
    "standard"
  );

  assert.equal(
    routeTask({
      difficulty: "L2",
      risk: "high",
      contextNeed: "low",
      verification: "easy",
    }).modelTier,
    "premium"
  );

  assert.equal(
    routeTask({
      difficulty: "L1",
      risk: "low",
      contextNeed: "low",
      verification: "hard",
    }).modelTier,
    "premium"
  );
});

test("FileExecutionStore writes and reads execution records", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const plan = createRuntimePlan({
      request: "总结项目结构，并记录执行结果",
      now: new Date("2026-06-17T10:00:00.000Z"),
    });

    const record = await store.createRecord(plan);
    assert.match(record.runId, /^run_/);
    assert.equal(record.status, "planned");
    assert.equal(record.plan.planId, plan.planId);
    assert.equal(record.events[0].type, "run.created");

    await store.appendEvent(record.runId, {
      type: "task.routed",
      taskId: plan.tasks[0].id,
      modelTier: plan.tasks[0].modelTier,
      message: "Task routed during dry-run planning.",
    });

    const loaded = await store.readRecord(record.runId);
    assert.equal(loaded.events.length, 2);
    assert.equal(loaded.events[1].type, "task.routed");
    assert.equal(loaded.events[1].taskId, plan.tasks[0].id);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("loadRuntimeConfig merges defaults, config file, and environment overrides", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-config-"));
  const dataDirectory = path.join(workspace, "data");

  try {
    await writeFile(
      path.join(workspace, "runtime.config.json"),
      JSON.stringify(
        {
          server: {
            host: "0.0.0.0",
            httpPort: 4123,
          },
          routing: {
            finalVerificationTier: "premium",
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const config = await loadRuntimeConfig({
      cwd: workspace,
      env: {
        AI_CODING_RUNTIME_HOME: dataDirectory,
      },
    });

    assert.equal(config.server.host, "0.0.0.0");
    assert.equal(config.server.httpPort, 4123);
    assert.equal(config.server.mcpPath, "/mcp");
    assert.equal(config.storage.directory, dataDirectory);
    assert.equal(config.routing.finalVerificationTier, "premium");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
