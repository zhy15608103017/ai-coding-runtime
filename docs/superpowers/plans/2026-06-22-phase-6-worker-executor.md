# Phase 6 Worker Executor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first safe worker execution loop and workspace adapter so approved runtime tasks can produce validated patches, apply them only inside task contracts, and record each attempt.

**Architecture:** Keep workspace file reading and patch helpers in `src/runtime/workspace.js`, worker execution orchestration in `src/runtime/worker.js`, and public tool wiring in `src/runtime/tools.js`. The first worker executor accepts a structured worker result payload instead of autonomously calling a model, because Phase 6 is about constrained execution, patch validation, and traceability; real autonomous worker prompting can build on this surface later.

**Tech Stack:** Node.js ESM, `node:test`, file-system workspace adapter, unified diff parsing and allowlist checks implemented locally.

---

### Task 1: Workspace Snapshot And Context Pack

**Files:**
- Create: `src/runtime/workspace.js`
- Modify: `src/index.js`
- Test: `tests/worker.test.js`

- [x] **Step 1: Write the failing test**

Add tests that call `createWorkspaceSnapshot()` and `createContextPack()` for a temporary workspace containing `src/app.js`, `tests/app.test.js`, `docs/spec.md`, and `secret.env`. Assert the snapshot includes relative paths, sizes, and total file count without file contents, and the context pack includes contents for files allowed by the task contract plus safe read-only `referenced_files`.

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/worker.test.js`

Expected: FAIL because `src/runtime/workspace.js` does not exist.

- [x] **Step 3: Implement minimal workspace helpers**

Implement:
- `createWorkspaceSnapshot({ cwd, maxFiles })`
- `createContextPack({ cwd, task, maxBytesPerFile })`
- glob matching for exact files, `dir/**`, and `*.ext` style allowlist entries.

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/worker.test.js`

Expected: PASS.

### Task 2: Patch Parsing And Allowlist Enforcement

**Files:**
- Modify: `src/runtime/workspace.js`
- Test: `tests/worker.test.js`

- [x] **Step 1: Write the failing test**

Add tests for `validateWorkerPatch()` that pass a unified diff touching `src/app.js` and assert it is allowed for `allowed_files: ["src/**"]`. Add a second assertion that a diff touching `README.md` is rejected with `worker.patch.forbidden_file`.

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/worker.test.js`

Expected: FAIL because `validateWorkerPatch()` does not exist.

- [x] **Step 3: Implement minimal patch validation**

Implement:
- `extractPatchFiles(patch)`
- `validateWorkerPatch({ patch, task })`
- patch path normalization for `a/file` and `b/file`
- empty patch rejection for executable worker outputs.

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/worker.test.js`

Expected: PASS.

### Task 3: Structured Worker Result Validation And Attempt Records

**Files:**
- Create: `src/runtime/worker.js`
- Modify: `src/runtime/store.js`
- Modify: `src/index.js`
- Test: `tests/worker.test.js`

- [x] **Step 1: Write the failing test**

Add a test that creates an approved run, calls `runtime_submit_worker_result` for task `T-003`, and asserts the stored record has one `workerAttempts` entry with task id, status, files touched, explanation, verification notes, confidence, and acceptance mapping.

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/worker.test.js`

Expected: FAIL because the worker tool and store method do not exist.

- [x] **Step 3: Implement worker validation and store persistence**

Implement:
- `validateWorkerResult({ task, result })`
- `createWorkerPrompt({ task, contextPack })`
- `submitWorkerResult({ runId, taskId, result, store, runtimeOptions })`
- `FileExecutionStore.recordWorkerAttempt()`

Validation requires `patch`, `explanation`, `verificationNotes`, `confidence`, `filesTouched`, and an `acceptance` object that maps every task acceptance item to evidence.

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/worker.test.js`

Expected: PASS.

### Task 4: Safe Patch Application

**Files:**
- Modify: `src/runtime/workspace.js`
- Modify: `src/runtime/worker.js`
- Test: `tests/worker.test.js`

- [x] **Step 1: Write the failing test**

Add a test that submits a valid worker result with `apply: true`, verifies the target file changes on disk, and asserts the run event log includes `worker.patch.applied`. Add a rejection test for a patch outside `allowed_files`.

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/worker.test.js`

Expected: FAIL because patches are validated but not applied.

- [x] **Step 3: Implement safe unified diff application**

Implement a minimal applier for text patches produced by the tests:
- supports one or more `diff --git` file sections
- supports hunks with `@@ -old,count +new,count @@`
- applies context, deletions, and additions
- writes only files already approved by `validateWorkerPatch()`

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/worker.test.js`

Expected: PASS.

### Task 5: CLI, HTTP, MCP, Reports, Docs, And Roadmap Checklist

**Files:**
- Modify: `src/runtime/tools.js`
- Modify: `src/server.js`
- Modify: `src/cli.js`
- Modify: `src/runtime/report.js`
- Modify: `README.md`
- Modify: `docs/integrations.md`
- Modify: `total.md`
- Test: `tests/cli.test.js`
- Test: `tests/gateway.test.js`
- Test: `tests/worker.test.js`

- [x] **Step 1: Write failing integration tests**

Add tests that:
- `tools/list` includes `runtime_submit_worker_result`
- `POST /api/runs/:id/worker-results` records worker attempts
- `ai-coding-runtime worker-result <run-id> <task-id> --from-file result.json --json` records attempts
- reports include worker attempt and files touched summaries.

- [x] **Step 2: Run tests to verify failures**

Run: `node --test tests/gateway.test.js tests/cli.test.js tests/worker.test.js`

Expected: FAIL until gateway, CLI, and report surfaces are wired.

- [x] **Step 3: Wire public surfaces and docs**

Expose the new worker result tool through MCP, HTTP, and CLI. Document the current Phase 6 limitation: the runtime validates and applies structured worker results, but does not yet autonomously generate worker patches.

- [x] **Step 4: Mark Phase 6 checklist complete**

Update `total.md` Phase 6 task checkboxes from `[ ]` to `[x]`.

- [x] **Step 5: Run final local verification**

Run:
- `npm test`
- `git diff --check`
- `node -e "JSON.parse(require('node:fs').readFileSync('runtime.config.example.json','utf8')); console.log('runtime.config.example.json ok')"`

Expected: all commands pass.
