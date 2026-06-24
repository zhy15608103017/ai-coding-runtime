# Phase 11.1 Routing History Export Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement privacy-safe routing history export/import so imported learning evidence can feed reports without affecting live routing or execution.

**Architecture:** Add a focused `src/runtime/history.js` module that sanitizes run records into schema-versioned learning-history snapshots and validates imports. Extend `FileExecutionStore` with explicit imported-history methods, wire CLI `history export/import`, and make report paths opt into imported learning records while keeping normal runtime paths isolated.

**Tech Stack:** Node.js ESM, built-in `node:test`, JSON file storage through `node:fs/promises`, existing runtime modules in `src/runtime`.

---

## File Structure

- Create `src/runtime/history.js`: snapshot schema constants, export snapshot creation, record sanitization, import validation, import summary helpers.
- Modify `src/runtime/store.js`: add `importedHistoryDirectory`, `listImportedLearningRecords()`, `writeImportedLearningRecords(records)`, and duplicate-safe imported record paths.
- Modify `src/runtime/report.js`: allow `importedHistoryRecords` and expose `importedRecords` / `imported_records` in the learning profile.
- Modify `src/runtime/tools.js`: include imported learning records in `runtime_report` and `runtime_audit` report generation only.
- Modify `src/server.js`: include imported records in HTTP report generation only.
- Modify `src/cli.js`: add `history export/import`, wire imported records into `report`, keep output stable.
- Modify `src/index.js`: export history helpers for tests and future integrations.
- Create `tests/phase11-history.test.js`: unit and integration tests for export/import, privacy, store isolation, report integration, CLI, and routing non-interference.
- Modify `tests/phase11-learning.test.js`: update roadmap assertion after Phase 11.1 completes.
- Modify `total.md`: mark `Add export/import for routing history.` complete.

---

### Task 1: History Snapshot Module

**Files:**
- Create: `src/runtime/history.js`
- Test: `tests/phase11-history.test.js`
- Modify: `src/index.js`

- [ ] **Step 1: Write failing tests for snapshot export and privacy**

Add `tests/phase11-history.test.js`:

```javascript
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  ROUTING_HISTORY_SCHEMA_VERSION,
  createRoutingHistorySnapshot,
  createRuntimePlan,
  FileExecutionStore,
  importRoutingHistorySnapshot,
  createReport,
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
```

Use helper functions at the bottom of the test file:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/phase11-history.test.js`

Expected: FAIL because `ROUTING_HISTORY_SCHEMA_VERSION`, `createRoutingHistorySnapshot`, and `importRoutingHistorySnapshot` are not exported.

- [ ] **Step 3: Implement minimal history module and exports**

Create `src/runtime/history.js` with:

```javascript
import { stableHash } from "./policy.js";

export const ROUTING_HISTORY_SCHEMA_VERSION = "ai-coding-runtime.routing-history.v1";

export function createRoutingHistorySnapshot(records = [], { now = new Date(), version = "0.1.0" } = {}) {
  const normalizedRecords = Array.isArray(records) ? records : [];
  const exportedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const sanitizedRecords = [];
  let skipped = 0;

  for (const record of normalizedRecords) {
    const sanitized = sanitizeRoutingHistoryRecord(record);
    if (sanitized) {
      sanitizedRecords.push(sanitized);
    } else {
      skipped += 1;
    }
  }

  return {
    schemaVersion: ROUTING_HISTORY_SCHEMA_VERSION,
    exportedAt,
    source: {
      runtime: "ai-coding-runtime",
      version,
    },
    summary: {
      recordsScanned: normalizedRecords.length,
      records_scanned: normalizedRecords.length,
      recordsExported: sanitizedRecords.length,
      records_exported: sanitizedRecords.length,
      recordsSkipped: skipped,
      records_skipped: skipped,
    },
    records: sanitizedRecords,
  };
}

export function importRoutingHistorySnapshot(snapshot = {}, { existingImportIds = new Set() } = {}) {
  if (snapshot?.schemaVersion !== ROUTING_HISTORY_SCHEMA_VERSION) {
    throw new Error(`Unsupported routing history schema: ${snapshot?.schemaVersion ?? "missing"}`);
  }

  if (!Array.isArray(snapshot.records)) {
    throw new Error("Invalid routing history snapshot: records must be an array.");
  }

  const importedRecords = [];
  const rejectedRecords = [];
  let duplicateCount = 0;

  for (const record of snapshot.records) {
    const sanitized = sanitizeRoutingHistoryRecord(record);
    if (!sanitized) {
      rejectedRecords.push({ reason: "record.invalid" });
      continue;
    }

    if (existingImportIds.has(sanitized.importId)) {
      duplicateCount += 1;
      continue;
    }

    existingImportIds.add(sanitized.importId);
    importedRecords.push(sanitized);
  }

  return {
    status: "ok",
    importedRecords,
    imported_records: importedRecords,
    imported: importedRecords.length,
    duplicates: duplicateCount,
    rejected: rejectedRecords.length,
    rejectedRecords,
    rejected_records: rejectedRecords,
  };
}

export function sanitizeRoutingHistoryRecord(record = {}) {
  if (!record || typeof record !== "object") return null;
  const tasks = Array.isArray(record.plan?.tasks) ? record.plan.tasks : [];
  const routingTrace = Array.isArray(record.plan?.routingTrace ?? record.plan?.routing_trace)
    ? record.plan.routingTrace ?? record.plan.routing_trace
    : [];
  if (!record.status || tasks.length === 0 || routingTrace.length === 0) return null;

  const sanitized = {
    runId: record.importId ?? sourceRunIdHash(record.runId),
    run_id: record.importId ?? sourceRunIdHash(record.runId),
    importId: record.importId ?? null,
    import_id: record.import_id ?? record.importId ?? null,
    sourceRunIdHash: record.sourceRunIdHash ?? record.source_run_id_hash ?? sourceRunIdHash(record.runId),
    source_run_id_hash: record.source_run_id_hash ?? record.sourceRunIdHash ?? sourceRunIdHash(record.runId),
    createdAt: safeString(record.createdAt ?? record.created_at),
    created_at: safeString(record.created_at ?? record.createdAt),
    status: safeString(record.status),
    plan: {
      tasks: tasks.map(sanitizeTask).filter(Boolean),
      routingTrace: routingTrace.map(sanitizeRoute).filter(Boolean),
      routing_trace: routingTrace.map(sanitizeRoute).filter(Boolean),
    },
    workerAttempts: sanitizeWorkerAttempts(record.workerAttempts ?? record.worker_attempts),
    worker_attempts: sanitizeWorkerAttempts(record.workerAttempts ?? record.worker_attempts),
    modelCalls: sanitizeModelCalls(record.modelCalls ?? record.model_calls),
    model_calls: sanitizeModelCalls(record.modelCalls ?? record.model_calls),
    verification: sanitizeVerification(record.verification),
    events: sanitizeEvents(record.events),
    imported: true,
  };

  if (sanitized.plan.tasks.length === 0 || sanitized.plan.routingTrace.length === 0) return null;
  const importId = record.importId ?? record.import_id ?? `sha256:${stableHash(sanitized)}`;
  sanitized.importId = importId;
  sanitized.import_id = importId;
  sanitized.runId = importId;
  sanitized.run_id = importId;
  return sanitized;
}

function sanitizeTask(task = {}) {
  const taskId = task.task_id ?? task.id ?? task.taskId;
  if (!taskId) return null;
  return {
    id: safeString(taskId),
    task_id: safeString(taskId),
    taskType: safeString(task.taskType ?? task.task_type ?? task.difficulty ?? "unknown"),
    task_type: safeString(task.task_type ?? task.taskType ?? task.difficulty ?? "unknown"),
    difficulty: safeString(task.difficulty ?? "unknown"),
    risk: safeString(task.risk ?? "unknown"),
    contextNeed: safeString(task.contextNeed ?? task.context_need ?? "unknown"),
    context_need: safeString(task.context_need ?? task.contextNeed ?? "unknown"),
    verification: safeString(task.verification ?? "unknown"),
    modelTier: safeString(task.modelTier ?? task.model_tier ?? "unknown"),
    model_tier: safeString(task.model_tier ?? task.modelTier ?? "unknown"),
    finalVerification: task.finalVerification === true || task.final_verification === true,
    final_verification: task.final_verification === true || task.finalVerification === true,
  };
}

function sanitizeRoute(route = {}) {
  const taskId = route.task_id ?? route.taskId;
  if (!taskId) return null;
  const selected = route.selected_model ?? route.selectedModel ?? {};
  const selectedModel =
    typeof selected === "object"
      ? {
          provider: safeString(selected.provider ?? route.selected_provider ?? "unknown"),
          model: safeString(selected.model ?? route.selected_model_name ?? "unknown"),
          tier: safeString(selected.tier ?? route.model_tier ?? route.modelTier ?? "unknown"),
        }
      : {
          provider: safeString(route.selected_provider ?? "unknown"),
          model: safeString(selected),
          tier: safeString(route.model_tier ?? route.modelTier ?? "unknown"),
        };
  return {
    task_id: safeString(taskId),
    taskId: safeString(taskId),
    model_tier: safeString(route.model_tier ?? route.modelTier ?? selectedModel.tier),
    modelTier: safeString(route.modelTier ?? route.model_tier ?? selectedModel.tier),
    selected_model: selectedModel,
    selectedModel,
    selected_provider: selectedModel.provider,
    selectedProvider: selectedModel.provider,
    cost_hint: sanitizeCostHint(route.cost_hint ?? route.costHint),
    costHint: sanitizeCostHint(route.costHint ?? route.cost_hint),
  };
}

function sanitizeWorkerAttempts(attempts = []) {
  return Array.isArray(attempts)
    ? attempts
        .map((attempt) => {
          const taskId = attempt.taskId ?? attempt.task_id;
          if (!taskId) return null;
          const filesTouched = Array.isArray(attempt.filesTouched ?? attempt.files_touched)
            ? attempt.filesTouched ?? attempt.files_touched
            : [];
          return {
            taskId: safeString(taskId),
            task_id: safeString(taskId),
            status: safeString(attempt.status ?? "unknown"),
            applied: attempt.applied === true,
            modelTier: safeString(attempt.modelTier ?? attempt.model_tier ?? ""),
            model_tier: safeString(attempt.model_tier ?? attempt.modelTier ?? ""),
            filesTouchedCount: filesTouched.length,
            files_touched_count: filesTouched.length,
          };
        })
        .filter(Boolean)
    : [];
}

function sanitizeModelCalls(calls = []) {
  return Array.isArray(calls)
    ? calls
        .map((call) => {
          const taskId = call.taskId ?? call.task_id;
          if (!taskId) return null;
          return {
            taskId: safeString(taskId),
            task_id: safeString(taskId),
            provider: safeString(call.provider ?? "unknown"),
            model: safeString(call.model ?? "unknown"),
            tier: safeString(call.tier ?? call.modelTier ?? call.model_tier ?? ""),
            status: safeString(call.status ?? "finished"),
            usage: sanitizeUsage(call.usage),
            costEstimate: sanitizeCostEstimate(call.costEstimate ?? call.cost_estimate),
            cost_estimate: sanitizeCostEstimate(call.cost_estimate ?? call.costEstimate),
          };
        })
        .filter(Boolean)
    : [];
}

function sanitizeVerification(verification = []) {
  return Array.isArray(verification)
    ? verification.map((item) => ({
        status: safeString(item.status ?? "unknown"),
        acceptance: sanitizeAcceptance(item.acceptance),
        escalation: { required: item.escalation?.required === true },
      }))
    : [];
}

function sanitizeAcceptance(acceptance = {}) {
  return {
    status: safeString(acceptance.status ?? "unknown"),
    tasks: Array.isArray(acceptance.tasks)
      ? acceptance.tasks.map((task) => ({
          taskId: safeString(task.taskId ?? task.task_id),
          task_id: safeString(task.task_id ?? task.taskId),
          status: safeString(task.status ?? "unknown"),
        }))
      : [],
  };
}

function sanitizeEvents(events = []) {
  return Array.isArray(events)
    ? events
        .filter((event) => typeof event?.type === "string")
        .map((event) => ({
          type: safeString(event.type),
          taskId: safeString(event.taskId ?? event.task_id ?? ""),
          task_id: safeString(event.task_id ?? event.taskId ?? ""),
          fromTier: safeString(event.fromTier ?? event.from_tier ?? ""),
          from_tier: safeString(event.from_tier ?? event.fromTier ?? ""),
          toTier: safeString(event.toTier ?? event.to_tier ?? ""),
          to_tier: safeString(event.to_tier ?? event.toTier ?? ""),
        }))
    : [];
}

function sanitizeCostHint(costHint = {}) {
  return {
    estimated_usd_per_call: numberOrNull(costHint.estimated_usd_per_call ?? costHint.estimatedUsdPerCall),
  };
}

function sanitizeCostEstimate(costEstimate = {}) {
  return {
    currency: safeString(costEstimate.currency ?? "USD"),
    estimatedCost: numberOrNull(costEstimate.estimatedCost ?? costEstimate.estimated_cost),
    estimated_cost: numberOrNull(costEstimate.estimated_cost ?? costEstimate.estimatedCost),
  };
}

function sanitizeUsage(usage = {}) {
  return {
    totalTokens: numberOrNull(usage.totalTokens ?? usage.total_tokens),
    total_tokens: numberOrNull(usage.total_tokens ?? usage.totalTokens),
  };
}

function sourceRunIdHash(runId) {
  return `sha256:${stableHash({ runId: runId ?? "unknown" })}`;
}

function safeString(value) {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
```

Modify `src/index.js`:

```javascript
export {
  ROUTING_HISTORY_SCHEMA_VERSION,
  createRoutingHistorySnapshot,
  importRoutingHistorySnapshot,
  sanitizeRoutingHistoryRecord,
} from "./runtime/history.js";
export { runCli } from "./cli.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/phase11-history.test.js`

Expected: PASS for the first export/privacy test.

---

### Task 2: Store Imported History Separately

**Files:**
- Modify: `src/runtime/store.js`
- Test: `tests/phase11-history.test.js`

- [ ] **Step 1: Write failing store isolation and duplicate tests**

Append tests:

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/phase11-history.test.js`

Expected: FAIL because `writeImportedLearningRecords` and `listImportedLearningRecords` do not exist.

- [ ] **Step 3: Implement store methods**

Modify `src/runtime/store.js` imports and constructor:

```javascript
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
```

Constructor:

```javascript
this.importedHistoryDirectory = join(this.workspace, "imported-history", "routing-history");
```

Add methods inside `FileExecutionStore`:

```javascript
async listImportedLearningRecords() {
  await mkdir(this.importedHistoryDirectory, { recursive: true });
  const entries = await readdir(this.importedHistoryDirectory, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  const records = await Promise.all(
    files.map(async (entry) => JSON.parse(await readFile(join(this.importedHistoryDirectory, entry.name), "utf8")))
  );

  return records.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

async writeImportedLearningRecords(records = []) {
  await mkdir(this.importedHistoryDirectory, { recursive: true });
  const existing = new Set((await this.listImportedLearningRecords()).map((record) => record.importId));
  let imported = 0;
  let duplicates = 0;

  for (const record of Array.isArray(records) ? records : []) {
    if (!record?.importId) continue;
    if (existing.has(record.importId)) {
      duplicates += 1;
      continue;
    }
    existing.add(record.importId);
    await writeFile(
      join(this.importedHistoryDirectory, `${safeFileName(record.importId)}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8"
    );
    imported += 1;
  }

  return { status: "ok", imported, duplicates };
}
```

Add helper after the class:

```javascript
function safeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/phase11-history.test.js`

Expected: PASS for snapshot and store tests.

---

### Task 3: Import Validation And CLI History Commands

**Files:**
- Modify: `src/cli.js`
- Test: `tests/phase11-history.test.js`

- [ ] **Step 1: Write failing import validation and CLI tests**

Append tests:

```javascript
test("Phase 11.1 rejects unsupported routing history schema", () => {
  assert.throws(
    () => importRoutingHistorySnapshot({ schemaVersion: "future.v9", records: [] }),
    /Unsupported routing history schema/
  );
});

test("Phase 11.1 CLI exports and imports routing history as JSON", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "acr-history-cli-"));
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

    const importedWorkspace = await mkdtemp(join(tmpdir(), "acr-history-cli-import-"));
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
  }
});

async function writeConfig(cwd, storageDirectory) {
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(
      join(cwd, "runtime.config.json"),
      `${JSON.stringify({ storage: { directory: storageDirectory } }, null, 2)}\n`,
      "utf8"
    )
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/phase11-history.test.js`

Expected: FAIL because CLI has no `history` command.

- [ ] **Step 3: Implement CLI history commands**

Modify `src/cli.js` imports:

```javascript
import { readFile, writeFile } from "node:fs/promises";
import { createRoutingHistorySnapshot, importRoutingHistorySnapshot } from "./runtime/history.js";
```

Add switch branch:

```javascript
case "history":
  return await historyCommand(rest, io);
```

Add command:

```javascript
async function historyCommand(args, io) {
  const [subcommand, ...rest] = args;
  if (subcommand === "export") return historyExportCommand(rest, io);
  if (subcommand === "import") return historyImportCommand(rest, io);
  throw new Error("history requires export or import.");
}

async function historyExportCommand(args, io) {
  const { positional, options } = parseArgs(args);
  const [filePath] = positional;
  if (!filePath) throw new Error("history export requires a file path.");
  const config = await loadRuntimeConfig();
  const store = new FileExecutionStore({ workspace: config.storage.directory });
  const snapshot = createRoutingHistorySnapshot(await store.listRecords());
  await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  const output = {
    status: "ok",
    exported: snapshot.summary.recordsExported,
    skipped: snapshot.summary.recordsSkipped,
    path: filePath,
  };
  if (options.json) {
    io.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    io.stdout.write(`Exported ${output.exported} routing history record(s) to ${filePath}; skipped ${output.skipped}.\n`);
  }
  return 0;
}

async function historyImportCommand(args, io) {
  const { positional, options } = parseArgs(args);
  const [filePath] = positional;
  if (!filePath) throw new Error("history import requires a file path.");
  const config = await loadRuntimeConfig();
  const store = new FileExecutionStore({ workspace: config.storage.directory });
  const snapshot = JSON.parse(await readFile(filePath, "utf8"));
  const existing = new Set((await store.listImportedLearningRecords()).map((record) => record.importId));
  const prepared = importRoutingHistorySnapshot(snapshot, { existingImportIds: existing });
  const written = await store.writeImportedLearningRecords(prepared.importedRecords);
  const output = {
    status: "ok",
    imported: written.imported,
    duplicates: prepared.duplicates + written.duplicates,
    rejected: prepared.rejected,
    path: filePath,
  };
  if (options.json) {
    io.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    io.stdout.write(
      `Imported ${output.imported} routing history record(s); skipped ${output.duplicates} duplicate; rejected ${output.rejected}.\n`
    );
  }
  return 0;
}
```

Update help text with:

```text
history export <file> [--json]   Export privacy-safe routing history
history import <file> [--json]   Import privacy-safe routing history
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/phase11-history.test.js`

Expected: PASS through CLI tests.

---

### Task 4: Report Integration And Routing Non-Interference

**Files:**
- Modify: `src/runtime/report.js`
- Modify: `src/runtime/tools.js`
- Modify: `src/server.js`
- Modify: `src/cli.js`
- Test: `tests/phase11-history.test.js`

- [ ] **Step 1: Write failing report and routing safety tests**

Append tests:

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/phase11-history.test.js`

Expected: FAIL because `createReport` ignores `importedHistoryRecords` and does not expose imported record counts.

- [ ] **Step 3: Implement report imported-history support**

Modify `src/runtime/report.js` signature and learning assembly:

```javascript
export function createReport(
  record,
  { historyRecords = [], importedHistoryRecords = [], policy = record.plan?.policyConfig } = {}
) {
  const combinedHistoryRecords = [record, ...historyRecords, ...importedHistoryRecords];
  const modelReliability = createModelReliabilityMetrics([record, ...historyRecords]);
  const learningProfile = safeCreateLearningProfile(combinedHistoryRecords, {
    policy,
    importedRecordCount: Array.isArray(importedHistoryRecords) ? importedHistoryRecords.length : 0,
  });
```

Modify `safeCreateLearningProfile` to pass metadata and annotate output:

```javascript
function safeCreateLearningProfile(records, { policy, importedRecordCount = 0 } = {}) {
  try {
    const profile = createLearningProfile(records, { policy });
    return {
      ...profile,
      importedRecords: importedRecordCount,
      imported_records: importedRecordCount,
    };
  } catch (error) {
    return {
      enabled: false,
      mode: "error",
      reason: "Learning profile generation failed.",
      error: error.message,
      importedRecords: importedRecordCount,
      imported_records: importedRecordCount,
      recordsScanned: 0,
      records_scanned: 0,
      eligibleSamples: 0,
      eligible_samples: 0,
      ignoredRecords: 0,
      ignored_records: 0,
      samples: [],
      buckets: [],
      recommendations: [],
    };
  }
}
```

Modify CLI `reportCommand`:

```javascript
const importedHistoryRecords =
  typeof store.listImportedLearningRecords === "function" ? await store.listImportedLearningRecords() : [];
const report = createReport(record, { historyRecords, importedHistoryRecords, policy: config.policy });
```

Modify `src/runtime/tools.js` `reportRun` and `auditRun`:

```javascript
const importedHistoryRecords =
  typeof store.listImportedLearningRecords === "function" ? await store.listImportedLearningRecords() : [];
const report = createReport(record, { historyRecords, importedHistoryRecords, policy: runtimeOptions.policy });
```

Modify `src/server.js` report path similarly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/phase11-history.test.js`

Expected: PASS.

---

### Task 5: Roadmap And Regression Suite

**Files:**
- Modify: `tests/phase11-learning.test.js`
- Modify: `total.md`
- Test: `tests/phase11-learning.test.js`

- [ ] **Step 1: Write failing roadmap assertion update**

Change the final Phase 11 documentation test in `tests/phase11-learning.test.js`:

```javascript
assert.match(phase11, /- \[x\] Add export\/import for routing history\./);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/phase11-learning.test.js`

Expected: FAIL because `total.md` still has unchecked export/import.

- [ ] **Step 3: Mark roadmap item complete**

Modify `total.md` Phase 11 checklist:

```markdown
- [x] Add export/import for routing history.
```

- [ ] **Step 4: Run focused tests**

Run: `node --test tests/phase11-history.test.js tests/phase11-learning.test.js`

Expected: PASS.

- [ ] **Step 5: Run integration-adjacent tests**

Run: `node --test tests/cli.test.js tests/phase8-integrations.test.js tests/phase9-reporting.test.js tests/phase10-policy-safety-team.test.js`

Expected: PASS.

- [ ] **Step 6: Run full suite and whitespace check**

Run: `npm test`

Expected: all tests pass.

Run: `git diff --check`

Expected: no whitespace errors.

---

### Task 6: Code Review Loop

**Files:**
- Create/Modify: `.ai-review/review-context/current-request.md`

- [ ] **Step 1: Write review context**

Run:

```bash
node .agents/skills/code-review-loop/scripts/write-review-context.mjs --from-stdin
```

Use a concise Chinese context covering:

- User approved Phase 11.1.
- Implement privacy-safe routing history export/import.
- Imported history must feed reports/learning only.
- Imported history must not affect routing, execution, retries, verification, or provider selection.
- Verification commands: focused tests, integration-adjacent tests, `npm test`, `git diff --check`.

- [ ] **Step 2: Run AI review**

Run:

```bash
node .agents/skills/code-review-loop/scripts/ai-review.mjs --profile auto --verify "git diff --check"
```

Expected: verdict `pass` or no blocking `P0/P1`.

- [ ] **Step 3: Fix blocking findings with TDD**

If review returns `P0` or `P1`, write a failing regression test, verify RED, implement minimal fix, verify GREEN, then rerun review. Repeat at most three times.

- [ ] **Step 4: Final verification**

Run:

```bash
npm test
git diff --check
```

Expected: all tests pass and no whitespace errors.

---

## Self-Review

- Spec coverage: the plan covers snapshot format, privacy filtering, separate imported storage, CLI export/import, report-only integration, validation, duplicate handling, routing non-interference, roadmap update, and code review loop.
- Placeholder scan: no placeholder markers or open-ended test instructions remain.
- Type consistency: the plan uses `ROUTING_HISTORY_SCHEMA_VERSION`, `createRoutingHistorySnapshot`, `importRoutingHistorySnapshot`, `sanitizeRoutingHistoryRecord`, `listImportedLearningRecords`, and `writeImportedLearningRecords` consistently across module, store, CLI, and tests.
