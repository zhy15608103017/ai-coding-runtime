import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  ROUTING_HISTORY_SCHEMA_VERSION,
  createReport,
  createRoutingHistorySnapshot,
  createRuntimePlan,
  FileExecutionStore,
  importRoutingHistorySnapshot,
  normalizePolicyConfig,
  runCli,
} from "../src/index.js";

test("Phase 11.1 exports sanitized routing history snapshot", () => {
  const snapshot = createRoutingHistorySnapshot([historyRecord()]);
  const serialized = JSON.stringify(snapshot);

  assert.equal(snapshot.schemaVersion, ROUTING_HISTORY_SCHEMA_VERSION);
  assert.equal(snapshot.source.runtime, "ai-coding-runtime");
  assert.equal(snapshot.summary.recordsScanned, 1);
  assert.equal(snapshot.summary.recordsExported, 1);
  assert.equal(snapshot.summary.recordsSkipped, 0);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].imported, true);
  assert.equal(snapshot.records[0].plan.tasks[0].task_type, "implementation");
  assert.equal(snapshot.records[0].plan.tasks[0].model_tier, "standard");
  assert.equal(snapshot.records[0].plan.routingTrace[0].selected_model.model, "gpt-test");
  assert.doesNotMatch(serialized, /SECRET=leak/);
  assert.doesNotMatch(serialized, /Implement secret task/);
  assert.doesNotMatch(serialized, /planning prompt/);
  assert.doesNotMatch(serialized, /diff --git/);
  assert.doesNotMatch(serialized, /worker prompt/);
  assert.doesNotMatch(serialized, /raw command output/);
  assert.doesNotMatch(serialized, /raw stderr/);
  assert.doesNotMatch(serialized, /raw model response/);
});

test("Phase 11.1 stores imported routing history outside native runs", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "acr-history-store-"));
  try {
    const store = new FileExecutionStore({ workspace });
    const snapshot = createRoutingHistorySnapshot([historyRecord()]);
    const summary = await store.writeImportedLearningRecords(snapshot.records);

    assert.equal(summary.imported, 1);
    assert.equal(summary.duplicates, 0);
    assert.equal((await store.listImportedLearningRecords()).length, 1);
    assert.equal((await store.listRecords()).length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Phase 11.1 skips duplicate imported routing history records", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "acr-history-dupes-"));
  try {
    const store = new FileExecutionStore({ workspace });
    const snapshot = createRoutingHistorySnapshot([historyRecord()]);

    await store.writeImportedLearningRecords(snapshot.records);
    const second = await store.writeImportedLearningRecords(snapshot.records);

    assert.equal(second.imported, 0);
    assert.equal(second.duplicates, 1);
    assert.equal((await store.listImportedLearningRecords()).length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Phase 11.1 stores colliding import ids without overwriting records", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "acr-history-collision-"));
  try {
    const store = new FileExecutionStore({ workspace });
    const first = createRoutingHistorySnapshot([historyRecord({ runId: "run_colon" })]).records[0];
    const second = createRoutingHistorySnapshot([historyRecord({ runId: "run_underscore" })]).records[0];
    first.importId = "external:a:b";
    first.import_id = "external:a:b";
    second.importId = "external:a_b";
    second.import_id = "external:a_b";

    const summary = await store.writeImportedLearningRecords([first, second]);
    const records = await store.listImportedLearningRecords();

    assert.equal(summary.imported, 2);
    assert.equal(summary.duplicates, 0);
    assert.equal(records.length, 2);
    assert.deepEqual(
      records.map((record) => record.importId).sort(),
      ["external:a:b", "external:a_b"]
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Phase 11.1 rejects unsupported routing history schema", () => {
  assert.throws(
    () => importRoutingHistorySnapshot({ schemaVersion: "future.v9", records: [] }),
    /Unsupported routing history schema/
  );
});

test("Phase 11.1 CLI exports and imports routing history as JSON", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "acr-history-cli-"));
  const importedWorkspace = await mkdtemp(join(tmpdir(), "acr-history-cli-import-"));
  const cwd = process.cwd();

  try {
    const store = new FileExecutionStore({ workspace: join(workspace, ".runtime") });
    await store.writeRecord(historyRecord({ runId: "run_cli" }));
    await writeConfig(workspace, join(workspace, ".runtime"));
    process.chdir(workspace);

    const exportIo = memoryIo();
    const exportPath = join(workspace, "history.json");
    assert.equal(await runCli(["history", "export", exportPath, "--json"], exportIo), 0);
    const exportOutput = JSON.parse(exportIo.stdoutText);
    assert.equal(exportOutput.status, "ok");
    assert.equal(exportOutput.exported, 1);

    await writeConfig(importedWorkspace, join(importedWorkspace, ".runtime"));
    process.chdir(importedWorkspace);
    const importIo = memoryIo();
    assert.equal(await runCli(["history", "import", exportPath, "--json"], importIo), 0);
    const importOutput = JSON.parse(importIo.stdoutText);
    assert.equal(importOutput.status, "ok");
    assert.equal(importOutput.imported, 1);
  } finally {
    process.chdir(cwd);
    await rm(workspace, { recursive: true, force: true });
    await rm(importedWorkspace, { recursive: true, force: true });
  }
});

test("Phase 11.1 CLI history command explains supported subcommands", async () => {
  const io = memoryIo();

  assert.equal(await runCli(["history"], io), 1);
  assert.match(io.stderrText, /history requires export or import/);
  assert.match(io.stderrText, /history export <file>/);
  assert.match(io.stderrText, /history import <file>/);
});

test("Phase 11.1 report includes imported learning records and counts them", () => {
  const current = historyRecord({ runId: "current_standard", tier: "standard" });
  const imported = createRoutingHistorySnapshot([
    historyRecord({ runId: "imported_cheap_1", tier: "cheap" }),
    historyRecord({ runId: "imported_cheap_2", tier: "cheap" }),
  ]).records;

  const report = createReport(current, {
    historyRecords: [],
    importedHistoryRecords: imported,
    policy: normalizePolicyConfig({ learning: { minSamples: 2 } }),
  });

  assert.equal(report.learningProfile.importedRecords, 2);
  assert.equal(report.learningProfile.imported_records, 2);
  assert.equal(report.learningProfile.recordsScanned, 3);
  assert.ok(report.learningProfile.eligibleSamples >= 3);
});

test("Phase 11.1 imported downgrade evidence does not affect deterministic routing", () => {
  const baseline = createRuntimePlan({
    request: "Implement a medium-risk local code change",
  });
  createRoutingHistorySnapshot(
    Array.from({ length: 10 }, (_, index) =>
      historyRecord({ runId: `cheap_success_${index}`, tier: "cheap", risk: "low" })
    )
  );
  const afterImportedEvidence = createRuntimePlan({
    request: "Implement a medium-risk local code change",
  });

  assert.deepEqual(
    afterImportedEvidence.tasks.map((task) => task.modelTier),
    baseline.tasks.map((task) => task.modelTier)
  );
  assert.deepEqual(afterImportedEvidence.routingTrace, baseline.routingTrace);
});

function historyRecord({
  runId = "run_history",
  status = "verification_passed",
  taskId = "T-001",
  tier = "standard",
  risk = "low",
  verificationStatus = "passed",
} = {}) {
  return {
    runId,
    status,
    request: "SECRET=leak user request must not export",
    createdAt: "2026-06-24T00:00:00.000Z",
    updatedAt: "2026-06-24T00:00:00.000Z",
    plan: {
      request: "SECRET=leak plan request must not export",
      planningPrompt: "planning prompt must not export",
      tasks: [
        {
          id: taskId,
          task_id: taskId,
          title: "Implement secret task",
          description: "source contents must not export",
          taskType: "implementation",
          task_type: "implementation",
          difficulty: "L2",
          risk,
          contextNeed: "medium",
          context_need: "medium",
          verification: "easy",
          modelTier: tier,
          model_tier: tier,
          allowed_files: ["src/secret.js"],
          routing: route(taskId, tier),
        },
      ],
      routingTrace: [route(taskId, tier)],
      policyConfig: normalizePolicyConfig(),
    },
    workerAttempts: [
      {
        taskId,
        task_id: taskId,
        status: "applied",
        applied: true,
        patch: "diff --git a/src/secret.js b/src/secret.js",
        workerPrompt: "worker prompt must not export",
        explanation: "raw model response must not export",
        filesTouched: ["src/secret.js"],
      },
    ],
    modelCalls: [
      {
        taskId,
        task_id: taskId,
        provider: "openai-compatible",
        model: "gpt-test",
        status: "finished",
        prompt: "raw prompt must not export",
        text: "raw model response must not export",
        usage: { totalTokens: 123 },
        costEstimate: { currency: "USD", estimatedCost: 0.0123 },
      },
    ],
    verification: [
      {
        status: verificationStatus,
        commands: [
          {
            name: "test",
            status: verificationStatus,
            stdout: "raw command output must not export",
            stderr: "raw stderr must not export",
          },
        ],
        acceptance: {
          status: verificationStatus,
          tasks: [{ taskId, task_id: taskId, status: verificationStatus }],
        },
        escalation: { required: verificationStatus === "failed" },
      },
    ],
    events: [
      {
        type: "task.execution.escalated",
        taskId,
        task_id: taskId,
        fromTier: "standard",
        from_tier: "standard",
        toTier: "premium",
        to_tier: "premium",
        message: "raw error detail must not export",
      },
    ],
  };
}

function route(taskId, tier) {
  return {
    task_id: taskId,
    model_tier: tier,
    selected_model: { provider: "openai-compatible", model: "gpt-test", tier },
    selected_provider: "openai-compatible",
    reason: "L2 default routing tier",
    cost_hint: { estimated_usd_per_call: 0.0123 },
  };
}

async function writeConfig(cwd, storageDirectory) {
  await writeFile(
    join(cwd, "runtime.config.json"),
    `${JSON.stringify({ storage: { directory: storageDirectory } }, null, 2)}\n`,
    "utf8"
  );
}

function memoryIo() {
  let stdoutText = "";
  let stderrText = "";
  return {
    get stdoutText() {
      return stdoutText;
    },
    get stderrText() {
      return stderrText;
    },
    stdout: { write: (value) => (stdoutText += value) },
    stderr: { write: (value) => (stderrText += value) },
    stdin: { on() {}, resume() {} },
  };
}
