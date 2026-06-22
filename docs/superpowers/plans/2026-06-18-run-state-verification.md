# Run State And Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit runtime run status lifecycle and a minimal deterministic verification engine before worker execution begins.

**Architecture:** Keep run status transitions in `src/runtime/status.js`, command execution in `src/runtime/verification.js`, and orchestration in `src/runtime/tools.js`. Verification records structured stdout, stderr, exit code, duration, required/pass/fail status, and updates the persisted run state without applying patches or running workers.

**Tech Stack:** Node.js ESM, `node:test`, local `child_process.spawn`, existing `FileExecutionStore`, CLI/HTTP/MCP runtime tools.

---

### Task 1: Run Status Lifecycle

**Files:**
- Create: `src/runtime/status.js`
- Modify: `src/runtime/store.js`
- Modify: `src/runtime/tools.js`
- Test: `tests/runtime.test.js`

- [ ] **Step 1: Write the failing test**

Add a test that creates a low-risk read-only run, starts verification, and asserts the stored run moves through explicit lifecycle events:

```javascript
test("runtime_verify records explicit lifecycle status transitions", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-status-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "plan only: verify status transitions without modifying files" },
      { store }
    );
    assert.equal(run.status, "planned");

    const verification = await callRuntimeTool(
      "runtime_verify",
      { runId: run.runId },
      {
        store,
        runtimeOptions: {
          verification: {
            commands: [],
          },
        },
      }
    );

    assert.equal(verification.status, "skipped");
    const record = await store.readRecord(run.runId);
    assert.equal(record.status, "verification_skipped");
    assert.ok(record.events.some((event) => event.type === "verification.started"));
    assert.ok(record.events.some((event) => event.type === "verification.finished"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/runtime.test.js`

Expected: FAIL because `runtime_verify` currently returns a V0 skipped placeholder and does not write `verification.started` or update run status.

- [ ] **Step 3: Implement minimal status helper**

Create `src/runtime/status.js` with:

```javascript
export const RUN_STATUS = {
  planned: "planned",
  approvalRequired: "approval_required",
  approved: "approved",
  verifying: "verifying",
  verificationPassed: "verification_passed",
  verificationFailed: "verification_failed",
  verificationSkipped: "verification_skipped",
  canceled: "canceled",
};

export function canVerifyRun(status) {
  return [RUN_STATUS.planned, RUN_STATUS.approved, RUN_STATUS.verificationFailed].includes(status);
}
```

Update `runtime_verify` to append `verification.started`, then write `verification.finished` and set `verification_skipped` when no commands are configured.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/runtime.test.js`

Expected: PASS.

### Task 2: Deterministic Verification Command Runner

**Files:**
- Create: `src/runtime/verification.js`
- Modify: `src/runtime/tools.js`
- Modify: `src/server.js`
- Modify: `src/runtime/config.js`
- Modify: `runtime.config.example.json`
- Test: `tests/runtime.test.js`
- Test: `tests/gateway.test.js`

- [ ] **Step 1: Write the failing test**

Add a test that configures one passing command and checks structured command output:

```javascript
test("runtime_verify runs configured commands and records structured evidence", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-verify-pass-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "plan only: run deterministic verification" },
      { store }
    );
    const verification = await callRuntimeTool(
      "runtime_verify",
      { runId: run.runId },
      {
        store,
        runtimeOptions: {
          verification: {
            commands: [
              {
                name: "node-version",
                command: "node",
                args: ["--version"],
                required: true,
                timeoutMs: 10000,
              },
            ],
          },
        },
      }
    );

    assert.equal(verification.status, "passed");
    assert.equal(verification.commands.length, 1);
    assert.equal(verification.commands[0].status, "passed");
    assert.equal(verification.commands[0].exitCode, 0);
    assert.match(verification.commands[0].stdout, /^v/);

    const record = await store.readRecord(run.runId);
    assert.equal(record.status, "verification_passed");
    assert.equal(record.verification[0].commands[0].name, "node-version");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/runtime.test.js`

Expected: FAIL because verification commands are not executed yet.

- [ ] **Step 3: Implement command runner**

Create `src/runtime/verification.js` with `runVerificationCommands({ commands, cwd })`, using `spawn` and capturing stdout, stderr, exit code, durationMs, timeout, and required status.

Use this command shape:

```javascript
{
  name: "node-version",
  command: "node",
  args: ["--version"],
  required: true,
  timeoutMs: 10000
}
```

Overall status rules:
- no commands: `skipped`
- every required command exits 0: `passed`
- any required command exits nonzero or times out: `failed`
- optional command failure records `failed` for the command but does not fail the overall verification.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/runtime.test.js`

Expected: PASS.

### Task 3: Failing Verification Blocks Completion

**Files:**
- Modify: `tests/runtime.test.js`
- Modify: `src/runtime/tools.js`
- Modify: `src/runtime/report.js`

- [ ] **Step 1: Write the failing test**

Add a test that uses a failing required command:

```javascript
test("runtime_verify marks required command failures as verification_failed", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-verify-fail-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "plan only: fail deterministic verification" },
      { store }
    );
    const verification = await callRuntimeTool(
      "runtime_verify",
      { runId: run.runId },
      {
        store,
        runtimeOptions: {
          verification: {
            commands: [
              {
                name: "failing-command",
                command: "node",
                args: ["-e", "console.error('intentional failure'); process.exit(3);"],
                required: true,
              },
            ],
          },
        },
      }
    );

    assert.equal(verification.status, "failed");
    assert.equal(verification.commands[0].exitCode, 3);
    assert.match(verification.commands[0].stderr, /intentional failure/);

    const record = await store.readRecord(run.runId);
    assert.equal(record.status, "verification_failed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/runtime.test.js`

Expected: FAIL until required command failures set the persisted run status.

- [ ] **Step 3: Persist failed status and report evidence**

Update `runtime_verify` to set `verification_failed` when required commands fail. Update `createReport()` and markdown formatting to include the new command evidence already stored under `record.verification`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/runtime.test.js`

Expected: PASS.

### Task 4: Gateway And Config Wiring

**Files:**
- Modify: `src/server.js`
- Modify: `src/cli.js`
- Modify: `src/runtime/config.js`
- Modify: `runtime.config.example.json`
- Modify: `README.md`
- Test: `tests/gateway.test.js`
- Test: `tests/cli.test.js`

- [ ] **Step 1: Write failing endpoint/CLI tests**

Update gateway test so `POST /api/verify` receives `runtimeOptions.verification` from the HTTP server and returns command evidence. Update CLI tests to assert `verify <run-id> --json` returns the structured verification response if the command exists, or add that command if missing.

- [ ] **Step 2: Run tests to verify failures**

Run: `node --test tests/gateway.test.js tests/cli.test.js`

Expected: FAIL until HTTP and CLI pass verification config through.

- [ ] **Step 3: Wire verification config**

Ensure `createRuntimeHttpServer` passes `runtimeOptions` to `runtime_verify`. Add CLI support only if the command is not currently exposed.

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test tests/gateway.test.js tests/cli.test.js`

Expected: PASS.

### Final Verification

- [ ] Run `npm test`.
- [ ] Run `git diff --check`.
- [ ] Run `node -e "JSON.parse(require('node:fs').readFileSync('runtime.config.example.json','utf8')); console.log('runtime.config.example.json ok')"`.
- [ ] Update `.ai-review/review-context/current-request.md`.
- [ ] Run `node .agents/skills/code-review-loop/scripts/ai-review.mjs --profile auto --verify "npm test" --verify "git diff --check"`.

### Self-Review

- Spec coverage: Covers the immediate next slice from `init.md` alignment: explicit run lifecycle and deterministic verification before worker/patch execution.
- Placeholder scan: No placeholder task is included; worker execution, context packs, and patch application are intentionally out of scope for this slice.
- Type consistency: Status names are snake_case strings in persisted records; verification commands use `{ name, command, args, required, timeoutMs }`.
