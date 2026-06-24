import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  callRuntimeTool,
  createContextPack,
  createReport,
  createWorkerPrompt,
  createWorkspaceSnapshot,
  FileExecutionStore,
  validateWorkerPatch,
} from "../src/index.js";

test("workspace snapshot and context pack respect task allowlists", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-worker-context-"));

  try {
    await writeProjectFile(workspace, "src/app.js", "export const value = 1;\n");
    await writeProjectFile(workspace, "tests/app.test.js", "import '../src/app.js';\n");
    await writeProjectFile(workspace, "docs/spec.md", "# Spec\n");
    await writeProjectFile(workspace, "secret.env", "TOKEN=secret\n");

    const snapshot = await createWorkspaceSnapshot({ cwd: workspace });
    assert.equal(snapshot.cwd, workspace);
    assert.equal(snapshot.totalFiles, 4);
    assert.ok(snapshot.files.some((file) => file.path === "src/app.js"));
    assert.ok(snapshot.files.every((file) => typeof file.sizeBytes === "number"));
    assert.ok(snapshot.files.every((file) => file.content === undefined));

    const contextPack = await createContextPack({
      cwd: workspace,
      task: {
        task_id: "T-ctx",
        allowed_files: ["src/**", "tests/app.test.js"],
        referenced_files: ["docs/spec.md", "../secret.env", "/secret.env", "C:/secret.env"],
      },
    });

    assert.deepEqual(
      contextPack.files.map((file) => file.path).sort(),
      ["docs/spec.md", "src/app.js", "tests/app.test.js"]
    );
    assert.match(contextPack.files.find((file) => file.path === "src/app.js").content, /value = 1/);
    assert.match(contextPack.files.find((file) => file.path === "docs/spec.md").content, /# Spec/);
    assert.equal(contextPack.files.some((file) => file.path === "secret.env"), false);
    assert.deepEqual(contextPack.referencedFiles, [
      "docs/spec.md",
      "../secret.env",
      "/secret.env",
      "C:/secret.env",
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("context pack can trim JSON referenced files to selected sections", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-worker-json-context-"));

  try {
    await writeProjectFile(
      workspace,
      "runtime.config.json",
      JSON.stringify(
        {
          server: { host: "127.0.0.1" },
          providers: {
            entries: {
              "openai-compatible": {
                defaultModel: "gpt-config-default",
                baseUrl: "https://example.test/v1",
              },
            },
          },
          verification: {
            final_review: {
              model: "gpt-config-final",
              provider: "openai-compatible",
            },
          },
        },
        null,
        2
      )
    );

    const contextPack = await createContextPack({
      cwd: workspace,
      task: {
        task_id: "T-json",
        referenced_files: ["runtime.config.json"],
        context_selectors: {
          "runtime.config.json": [
            "providers.entries.openai-compatible.defaultModel",
            "verification.final_review.model",
          ],
        },
      },
    });

    assert.equal(contextPack.files.length, 1);
    const [configFile] = contextPack.files;
    const parsed = JSON.parse(configFile.content);
    assert.deepEqual(parsed, {
      providers: {
        entries: {
          "openai-compatible": {
            defaultModel: "gpt-config-default",
          },
        },
      },
      verification: {
        final_review: {
          model: "gpt-config-final",
        },
      },
    });
    assert.doesNotMatch(configFile.content, /server/);
    assert.doesNotMatch(configFile.content, /baseUrl/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("worker patch validation rejects files outside the task contract", () => {
  const allowed = validateWorkerPatch({
    patch: patchFor("src/app.js", "export const value = 1;", "export const value = 2;"),
    task: {
      task_id: "T-003",
      allowed_files: ["src/**"],
    },
  });

  assert.equal(allowed.valid, true);
  assert.deepEqual(allowed.filesTouched, ["src/app.js"]);

  const rejected = validateWorkerPatch({
    patch: patchFor("README.md", "# Old", "# New"),
    task: {
      task_id: "T-003",
      allowed_files: ["src/**"],
    },
  });

  assert.equal(rejected.valid, false);
  assert.ok(rejected.errors.some((error) => error.code === "worker.patch.forbidden_file"));

  const traversal = validateWorkerPatch({
    patch: patchFor("src/../README.md", "# Old", "# New"),
    task: {
      task_id: "T-003",
      allowed_files: ["src/**"],
    },
  });

  assert.equal(traversal.valid, false);
  assert.ok(traversal.errors.some((error) => error.code === "worker.patch.forbidden_file"));

  const malformed = validateWorkerPatch({
    patch: [
      "diff --git a/src/app.js b/src/app.js",
      "--- a/src/app.js",
      "+++ b/src/app.js",
      "",
    ].join("\n"),
    task: {
      task_id: "T-003",
      allowed_files: ["src/**"],
    },
  });

  assert.equal(malformed.valid, false);
  assert.ok(malformed.errors.some((error) => error.code === "worker.patch.malformed"));
});

test("worker prompt requires valid unified diff hunk headers", () => {
  const prompt = createWorkerPrompt({
    task: {
      task_id: "T-003",
      title: "Implement focused runtime config test",
      goal: "Add a focused test without touching other files.",
      allowed_files: ["tests/runtime.test.js"],
      referenced_files: ["runtime.config.json"],
      forbidden_actions: ["edit files outside the approved allowlist"],
      acceptance: ["patch is valid unified diff"],
    },
    contextPack: {
      files: [
        {
          path: "tests/runtime.test.js",
          sizeBytes: 128,
          truncated: false,
          content: "test('example', () => {});\n",
        },
      ],
    },
  });

  assert.match(prompt, /valid unified diff/i);
  assert.match(prompt, /@@ -\d+(,\d+)? \+\d+(,\d+)? @@/);
  assert.match(prompt, /The acceptance object must include every acceptance criterion/);
  assert.match(prompt, /"patch is valid unified diff"/);
});

test("runtime_submit_worker_result records structured worker attempts", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-worker-attempt-"));
  const project = path.join(workspace, "project");
  const store = new FileExecutionStore({ workspace: path.join(workspace, "runtime-data") });

  try {
    await writeProjectFile(project, "src/app.js", "export const value = 1;\n");
    const run = await createApprovedRun(store);
    const task = run.plan.tasks.find((candidate) => candidate.task_id === "T-003");

    const submitted = await callRuntimeTool(
      "runtime_submit_worker_result",
      {
        runId: run.runId,
        taskId: task.task_id,
        result: workerResultForTask(task, {
          patch: patchFor("src/app.js", "export const value = 1;", "export const value = 2;"),
        }),
      },
      {
        store,
        runtimeOptions: {
          workspace: { cwd: project },
        },
      }
    );

    assert.equal(submitted.status, "recorded");
    assert.equal(submitted.taskId, task.task_id);
    assert.deepEqual(submitted.filesTouched, ["src/app.js"]);

    const record = await store.readRecord(run.runId);
    assert.equal(record.workerAttempts.length, 1);
    assert.equal(record.workerAttempts[0].taskId, task.task_id);
    assert.equal(record.workerAttempts[0].status, "recorded");
    assert.equal(record.workerAttempts[0].confidence, 0.82);
    assert.deepEqual(record.workerAttempts[0].filesTouched, ["src/app.js"]);
    assert.deepEqual(Object.keys(record.workerAttempts[0].acceptance), task.acceptance);
    assert.ok(record.events.some((event) => event.type === "worker.attempt.recorded"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime_submit_worker_result applies valid patches and rejects forbidden files", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-worker-apply-"));
  const project = path.join(workspace, "project");
  const store = new FileExecutionStore({ workspace: path.join(workspace, "runtime-data") });

  try {
    await writeProjectFile(project, "src/app.js", "export const value = 1;\n");
    await writeProjectFile(project, "README.md", "# Old\n");
    const run = await createApprovedRun(store);
    const task = run.plan.tasks.find((candidate) => candidate.task_id === "T-003");

    const applied = await callRuntimeTool(
      "runtime_submit_worker_result",
      {
        runId: run.runId,
        taskId: task.task_id,
        apply: true,
        result: workerResultForTask(task, {
          patch: patchFor("src/app.js", "export const value = 1;", "export const value = 2;"),
        }),
      },
      {
        store,
        runtimeOptions: {
          workspace: { cwd: project },
        },
      }
    );

    assert.equal(applied.status, "applied");
    assert.equal(await readFile(path.join(project, "src/app.js"), "utf8"), "export const value = 2;\n");

    const record = await store.readRecord(run.runId);
    assert.ok(record.events.some((event) => event.type === "worker.patch.applied"));

    await assert.rejects(
      callRuntimeTool(
        "runtime_submit_worker_result",
        {
          runId: run.runId,
          taskId: task.task_id,
          apply: true,
          result: workerResultForTask(task, {
            patch: patchFor("README.md", "# Old", "# New"),
            filesTouched: ["README.md"],
          }),
        },
        {
          store,
          runtimeOptions: {
            workspace: { cwd: project },
          },
        }
      ),
      /worker.patch.forbidden_file/
    );

    const updatedRecord = await store.readRecord(run.runId);
    assert.equal(updatedRecord.workerAttempts.length, 2);
    assert.equal(updatedRecord.workerAttempts[1].status, "failed");
    assert.equal(updatedRecord.workerAttempts[1].applied, false);
    assert.ok(
      updatedRecord.workerAttempts[1].validation.errors.some(
        (error) => error.code === "worker.patch.forbidden_file"
      )
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime_submit_worker_result records failed attempts when result validation fails", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-worker-result-fail-"));
  const project = path.join(workspace, "project");
  const store = new FileExecutionStore({ workspace: path.join(workspace, "runtime-data") });

  try {
    await writeProjectFile(project, "src/app.js", "export const value = 1;\n");
    const run = await createApprovedRun(store);
    const task = run.plan.tasks.find((candidate) => candidate.task_id === "T-003");
    const result = workerResultForTask(task, {
      patch: patchFor("src/app.js", "export const value = 1;", "export const value = 2;"),
    });
    result.acceptance = {};

    await assert.rejects(
      callRuntimeTool(
        "runtime_submit_worker_result",
        {
          runId: run.runId,
          taskId: task.task_id,
          apply: true,
          result,
        },
        {
          store,
          runtimeOptions: {
            workspace: { cwd: project },
          },
        }
      ),
      /worker.result.acceptance.missing/
    );

    assert.equal(await readFile(path.join(project, "src/app.js"), "utf8"), "export const value = 1;\n");
    const record = await store.readRecord(run.runId);
    assert.equal(record.workerAttempts.length, 1);
    assert.equal(record.workerAttempts[0].status, "failed");
    assert.equal(record.workerAttempts[0].applied, false);
    assert.ok(
      record.workerAttempts[0].validation.errors.some(
        (error) => error.code === "worker.result.acceptance.missing"
      )
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime_submit_worker_result records failed attempts when result is null", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-worker-result-null-"));
  const project = path.join(workspace, "project");
  const store = new FileExecutionStore({ workspace: path.join(workspace, "runtime-data") });

  try {
    await writeProjectFile(project, "src/app.js", "export const value = 1;\n");
    const run = await createApprovedRun(store);
    const task = run.plan.tasks.find((candidate) => candidate.task_id === "T-003");

    await assert.rejects(
      callRuntimeTool(
        "runtime_submit_worker_result",
        {
          runId: run.runId,
          taskId: task.task_id,
          apply: true,
          result: null,
        },
        {
          store,
          runtimeOptions: {
            workspace: { cwd: project },
          },
        }
      ),
      /worker.result.invalid/
    );

    assert.equal(await readFile(path.join(project, "src/app.js"), "utf8"), "export const value = 1;\n");
    const record = await store.readRecord(run.runId);
    assert.equal(record.workerAttempts.length, 1);
    assert.equal(record.workerAttempts[0].status, "failed");
    assert.equal(record.workerAttempts[0].applied, false);
    assert.ok(
      record.workerAttempts[0].validation.errors.some(
        (error) => error.code === "worker.result.invalid"
      )
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime_submit_worker_result records failed attempts when context pack generation fails", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-worker-context-fail-"));
  const project = path.join(workspace, "missing-project");
  const store = new FileExecutionStore({ workspace: path.join(workspace, "runtime-data") });

  try {
    const run = await createApprovedRun(store);
    const task = run.plan.tasks.find((candidate) => candidate.task_id === "T-003");

    await assert.rejects(
      callRuntimeTool(
        "runtime_submit_worker_result",
        {
          runId: run.runId,
          taskId: task.task_id,
          apply: true,
          result: workerResultForTask(task, {
            patch: patchFor("src/app.js", "export const value = 1;", "export const value = 2;"),
          }),
        },
        {
          store,
          runtimeOptions: {
            workspace: { cwd: project },
          },
        }
      ),
      /worker.context.failed/
    );

    const record = await store.readRecord(run.runId);
    assert.equal(record.workerAttempts.length, 1);
    assert.equal(record.workerAttempts[0].status, "failed");
    assert.equal(record.workerAttempts[0].applied, false);
    assert.ok(
      record.workerAttempts[0].validation.errors.some(
        (error) => error.code === "worker.context.failed"
      )
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime_submit_worker_result rejects forbidden actions and records failed attempts", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-worker-forbidden-action-"));
  const project = path.join(workspace, "project");
  const store = new FileExecutionStore({ workspace: path.join(workspace, "runtime-data") });

  try {
    await writeProjectFile(project, "src/app.js", "export const value = 1;\n");
    const run = await createApprovedRun(store);
    const task = run.plan.tasks.find((candidate) => candidate.task_id === "T-003");

    await assert.rejects(
      callRuntimeTool(
        "runtime_submit_worker_result",
        {
          runId: run.runId,
          taskId: task.task_id,
          apply: true,
          result: workerResultForTask(task, {
            patch: patchFor("src/app.js", "export const value = 1;", "export const value = 2;"),
            explanation: "I will perform destructive filesystem operations.",
          }),
        },
        {
          store,
          runtimeOptions: {
            workspace: { cwd: project },
          },
        }
      ),
      /worker.result.forbidden_action/
    );

    assert.equal(await readFile(path.join(project, "src/app.js"), "utf8"), "export const value = 1;\n");
    const record = await store.readRecord(run.runId);
    assert.equal(record.workerAttempts.length, 1);
    assert.equal(record.workerAttempts[0].status, "failed");
    assert.equal(record.workerAttempts[0].applied, false);
    assert.ok(
      record.workerAttempts[0].validation.errors.some(
        (error) => error.code === "worker.result.forbidden_action"
      )
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime_submit_worker_result records failed attempts when patch application fails", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-worker-apply-fail-"));
  const project = path.join(workspace, "project");
  const store = new FileExecutionStore({ workspace: path.join(workspace, "runtime-data") });

  try {
    await writeProjectFile(project, "src/app.js", "export const value = 1;\n");
    const run = await createApprovedRun(store);
    const task = run.plan.tasks.find((candidate) => candidate.task_id === "T-003");

    await assert.rejects(
      callRuntimeTool(
        "runtime_submit_worker_result",
        {
          runId: run.runId,
          taskId: task.task_id,
          apply: true,
          result: workerResultForTask(task, {
            patch: patchFor("src/app.js", "export const missing = 1;", "export const value = 2;"),
          }),
        },
        {
          store,
          runtimeOptions: {
            workspace: { cwd: project },
          },
        }
      ),
      /worker.patch.apply_failed/
    );

    assert.equal(await readFile(path.join(project, "src/app.js"), "utf8"), "export const value = 1;\n");
    const record = await store.readRecord(run.runId);
    assert.equal(record.workerAttempts.length, 1);
    assert.equal(record.workerAttempts[0].status, "failed");
    assert.equal(record.workerAttempts[0].applied, false);
    assert.ok(
      record.workerAttempts[0].validation.errors.some(
        (error) => error.code === "worker.patch.apply_failed"
      )
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime_submit_worker_result leaves all files unchanged when a later patch hunk fails", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-worker-apply-atomic-"));
  const project = path.join(workspace, "project");
  const store = new FileExecutionStore({ workspace: path.join(workspace, "runtime-data") });

  try {
    await writeProjectFile(project, "src/app.js", "export const value = 1;\n");
    await writeProjectFile(project, "src/other.js", "export const other = 1;\n");
    const run = await createApprovedRun(store);
    const task = run.plan.tasks.find((candidate) => candidate.task_id === "T-003");
    const patch = [
      patchFor("src/app.js", "export const value = 1;", "export const value = 2;"),
      patchFor("src/other.js", "export const missing = 1;", "export const other = 2;"),
    ].join("");

    await assert.rejects(
      callRuntimeTool(
        "runtime_submit_worker_result",
        {
          runId: run.runId,
          taskId: task.task_id,
          apply: true,
          result: workerResultForTask(task, {
            patch,
            filesTouched: ["src/app.js", "src/other.js"],
          }),
        },
        {
          store,
          runtimeOptions: {
            workspace: { cwd: project },
          },
        }
      ),
      /worker.patch.apply_failed/
    );

    assert.equal(await readFile(path.join(project, "src/app.js"), "utf8"), "export const value = 1;\n");
    assert.equal(await readFile(path.join(project, "src/other.js"), "utf8"), "export const other = 1;\n");
    const record = await store.readRecord(run.runId);
    assert.equal(record.workerAttempts.length, 1);
    assert.equal(record.workerAttempts[0].status, "failed");
    assert.equal(record.workerAttempts[0].applied, false);
    assert.deepEqual(record.workerAttempts[0].filesTouched, ["src/app.js", "src/other.js"]);
    assert.ok(
      record.workerAttempts[0].validation.errors.some(
        (error) => error.code === "worker.patch.apply_failed"
      )
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("forbidden action detection does not reject phrases that appear only inside patch text", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-worker-forbidden-diff-"));
  const project = path.join(workspace, "project");
  const store = new FileExecutionStore({ workspace: path.join(workspace, "runtime-data") });

  try {
    await writeProjectFile(
      project,
      "src/app.js",
      "export const note = 'perform destructive filesystem operations';\n"
    );
    const run = await createApprovedRun(store);
    const task = run.plan.tasks.find((candidate) => candidate.task_id === "T-003");

    const submitted = await callRuntimeTool(
      "runtime_submit_worker_result",
      {
        runId: run.runId,
        taskId: task.task_id,
        apply: true,
        result: workerResultForTask(task, {
          patch: patchFor(
            "src/app.js",
            "export const note = 'perform destructive filesystem operations';",
            "export const note = 'safe operation';"
          ),
        }),
      },
      {
        store,
        runtimeOptions: {
          workspace: { cwd: project },
        },
      }
    );

    assert.equal(submitted.status, "applied");
    assert.equal(await readFile(path.join(project, "src/app.js"), "utf8"), "export const note = 'safe operation';\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime reports include worker attempt summaries", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-worker-report-"));
  const project = path.join(workspace, "project");
  const store = new FileExecutionStore({ workspace: path.join(workspace, "runtime-data") });

  try {
    await writeProjectFile(project, "src/app.js", "export const value = 1;\n");
    const run = await createApprovedRun(store);
    const task = run.plan.tasks.find((candidate) => candidate.task_id === "T-003");

    await callRuntimeTool(
      "runtime_submit_worker_result",
      {
        runId: run.runId,
        taskId: task.task_id,
        result: workerResultForTask(task, {
          patch: patchFor("src/app.js", "export const value = 1;", "export const value = 2;"),
        }),
      },
      {
        store,
        runtimeOptions: {
          workspace: { cwd: project },
        },
      }
    );

    const record = await store.readRecord(run.runId);
    const report = createReport(record);
    assert.equal(report.workerAttempts.length, 1);
    assert.deepEqual(report.workerAttempts[0].filesTouched, ["src/app.js"]);

    const markdown = await callRuntimeTool(
      "runtime_report",
      { runId: run.runId, format: "markdown" },
      { store }
    );
    assert.match(markdown.markdown, /Worker Attempts/);
    assert.match(markdown.markdown, /src\/app\.js/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function createApprovedRun(store) {
  const run = await callRuntimeTool(
    "runtime_run",
    { request: "implement a safe worker patch with tests" },
    { store }
  );
  assert.equal(run.status, "approval_required");
  await callRuntimeTool(
    "runtime_approve",
    { runId: run.runId, approvedBy: "worker-test", note: "approve worker execution" },
    { store }
  );
  return {
    ...run,
    status: "approved",
  };
}

function workerResultForTask(task, overrides = {}) {
  const acceptance = Object.fromEntries(
    task.acceptance.map((item) => [item, `Evidence for ${item}`])
  );

  return {
    patch: overrides.patch,
    explanation: overrides.explanation ?? "Updated the allowed implementation file.",
    verificationNotes: ["Validated patch boundaries."],
    confidence: 0.82,
    filesTouched: overrides.filesTouched ?? ["src/app.js"],
    acceptance,
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

function newFilePatchFor(filePath, contentLines) {
  const lines = contentLines.map((line) => `+${line}`);
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${contentLines.length} @@`,
    ...lines,
    "",
  ].join("\n");
}

async function assertFileDoesNotExist(absolutePath) {
  await assert.rejects(() => stat(absolutePath), { code: "ENOENT" });
}

test("runtime_submit_worker_result creates a new file when the patch adds a previously absent file", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-worker-newfile-"));
  const project = path.join(workspace, "project");
  const store = new FileExecutionStore({ workspace: path.join(workspace, "runtime-data") });

  try {
    await writeProjectFile(project, "src/app.js", "export const value = 1;\n");
    const run = await createApprovedRun(store);
    const task = run.plan.tasks.find((candidate) => candidate.task_id === "T-003");
    const newFilePath = path.join(project, "src/new-module.js");

    await assertFileDoesNotExist(newFilePath);

    const result = await callRuntimeTool(
      "runtime_submit_worker_result",
      {
        runId: run.runId,
        taskId: task.task_id,
        apply: true,
        result: workerResultForTask(task, {
          patch: newFilePatchFor("src/new-module.js", ["// new module", "export const newVar = 42;"]),
          filesTouched: ["src/new-module.js"],
        }),
      },
      { store, runtimeOptions: { workspace: { cwd: project } } }
    );

    assert.equal(result.status, "applied");
    assert.equal(result.applied, true);
    assert.equal(
      await readFile(newFilePath, "utf8"),
      "// new module\nexport const newVar = 42;"
    );
    const record = await store.readRecord(run.runId);
    assert.equal(record.workerAttempts.length, 1);
    assert.equal(record.workerAttempts[0].status, "applied");
    assert.equal(record.workerAttempts[0].applied, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime_submit_worker_result rolls back a newly created file when a later patch hunk fails", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-worker-newfile-rollback-"));
  const project = path.join(workspace, "project");
  const store = new FileExecutionStore({ workspace: path.join(workspace, "runtime-data") });

  try {
    await writeProjectFile(project, "src/app.js", "export const value = 1;\n");
    const run = await createApprovedRun(store);
    const task = run.plan.tasks.find((candidate) => candidate.task_id === "T-003");
    const newFilePath = path.join(project, "src/brand-new.js");

    const patch = [
      newFilePatchFor("src/brand-new.js", ["// created then rolled back"]),
      patchFor("src/app.js", "export const missing = 1;", "export const value = 2;"),
    ].join("");

    await assert.rejects(
      callRuntimeTool(
        "runtime_submit_worker_result",
        {
          runId: run.runId,
          taskId: task.task_id,
          apply: true,
          result: workerResultForTask(task, {
            patch,
            filesTouched: ["src/brand-new.js", "src/app.js"],
          }),
        },
        { store, runtimeOptions: { workspace: { cwd: project } } }
      ),
      /worker.patch.apply_failed/
    );

    await assertFileDoesNotExist(newFilePath);
    assert.equal(await readFile(path.join(project, "src/app.js"), "utf8"), "export const value = 1;\n");
    const record = await store.readRecord(run.runId);
    assert.equal(record.workerAttempts.length, 1);
    assert.equal(record.workerAttempts[0].status, "failed");
    assert.equal(record.workerAttempts[0].applied, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
