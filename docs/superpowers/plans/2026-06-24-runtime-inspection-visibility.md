# Runtime Inspection Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a shared runtime inspection surface that makes task splitting, routing tiers, acceptance, verification, and escalation visible through CLI, MCP, and HTTP.

**Architecture:** Add a focused `inspection.js` module that derives a compact inspection model from existing run records without changing execution behavior. Reuse that module from runtime tools, CLI, HTTP, and markdown formatting so all surfaces agree.

**Tech Stack:** Node.js ESM, `node:test`, existing file-backed runtime store, existing MCP/HTTP/CLI patterns.

---

## File Structure

- Create `src/runtime/inspection.js`: derive inspection JSON and Chinese markdown.
- Modify `src/index.js`: export inspection helpers.
- Modify `src/runtime/tools.js`: add `runtime_inspect`.
- Modify `src/server.js`: add `GET /api/runs/:id/inspect`.
- Modify `src/cli.js`: add `inspect <run-id> [--json]`.
- Modify `src/runtime/report.js`: format selected model objects correctly.
- Add `tests/inspection.test.js`: shared model, CLI, MCP tool, HTTP endpoint, escalation and acceptance visibility.

## Tasks

### Task 1: Shared Inspection Model

**Files:**
- Create: `src/runtime/inspection.js`
- Test: `tests/inspection.test.js`

- [x] **Step 1: Write failing tests**

Add tests that create synthetic records with tasks, routing, worker attempts, verification, and escalation events. Assert `createRunInspection(record)` returns task count, tier/model, status, acceptance, and escalation summaries.

- [x] **Step 2: Run failing tests**

Run: `node --test tests/inspection.test.js`
Expected: fails because `src/runtime/inspection.js` does not exist.

- [x] **Step 3: Implement minimal inspection model**

Create `createRunInspection(record)` that maps existing record fields into:

```js
{
  runId,
  status,
  request,
  summary,
  tasks,
  approval,
  budget,
  verification,
  escalation,
  nextActions,
}
```

- [x] **Step 4: Run tests**

Run: `node --test tests/inspection.test.js`
Expected: pass.

### Task 2: Chinese Markdown Formatter

**Files:**
- Modify: `src/runtime/inspection.js`
- Test: `tests/inspection.test.js`

- [x] **Step 1: Write failing formatter tests**

Assert `formatInspectionMarkdown(inspection)` contains Chinese labels such as `运行`, `任务`, `模型层级`, `验收`, `升级`, `下一步`.

- [x] **Step 2: Run failing tests**

Run: `node --test tests/inspection.test.js`
Expected: fails because formatter is missing.

- [x] **Step 3: Implement formatter**

Add concise Chinese markdown output with a run summary, task sections, verification section, escalation section, and next action list.

- [x] **Step 4: Run tests**

Run: `node --test tests/inspection.test.js`
Expected: pass.

### Task 3: Runtime Tool And Exports

**Files:**
- Modify: `src/index.js`
- Modify: `src/runtime/tools.js`
- Test: `tests/inspection.test.js`

- [x] **Step 1: Write failing MCP/tool tests**

Assert `RUNTIME_TOOLS` includes `runtime_inspect` and `callRuntimeTool("runtime_inspect", { runId })` returns inspection JSON.

- [x] **Step 2: Run failing tests**

Run: `node --test tests/inspection.test.js`
Expected: fails because `runtime_inspect` is not registered.

- [x] **Step 3: Register tool**

Add `runtime_inspect` with `{ runId, format }`, default JSON, optional markdown response.

- [x] **Step 4: Run tests**

Run: `node --test tests/inspection.test.js`
Expected: pass.

### Task 4: CLI And HTTP Surfaces

**Files:**
- Modify: `src/cli.js`
- Modify: `src/server.js`
- Test: `tests/inspection.test.js`

- [x] **Step 1: Write failing CLI/HTTP tests**

Assert `ai-coding-runtime inspect <run-id>` prints Chinese markdown, `--json` prints JSON, and `GET /api/runs/:id/inspect` returns the inspection JSON.

- [x] **Step 2: Run failing tests**

Run: `node --test tests/inspection.test.js`
Expected: fails because CLI and HTTP routes are missing.

- [x] **Step 3: Implement CLI and HTTP**

Add CLI command parsing, help text, and HTTP route using existing store/runtime options.

- [x] **Step 4: Run tests**

Run: `node --test tests/inspection.test.js`
Expected: pass.

### Task 5: Report Model Formatting

**Files:**
- Modify: `src/runtime/report.js`
- Test: `tests/phase9-reporting.test.js`

- [x] **Step 1: Write failing report test**

Assert markdown renders `provider/model` instead of `[object Object]` when `selected_model` is an object.

- [x] **Step 2: Run failing test**

Run: `node --test tests/phase9-reporting.test.js`
Expected: fails before formatting fix.

- [x] **Step 3: Implement selected model formatter**

Add a helper that formats string model names and object model selections consistently.

- [x] **Step 4: Run tests**

Run: `node --test tests/phase9-reporting.test.js tests/inspection.test.js`
Expected: pass.

### Task 6: Full Verification And Review

**Files:**
- Modify: `.ai-review/review-context/current-request.md`

- [x] **Step 1: Run full local verification**

Run: `npm test`
Expected: all tests pass.

- [x] **Step 2: Write review context**

Create `.ai-review/review-context/current-request.md` in Chinese with request, corrections, design, acceptance criteria, and verification commands.

- [x] **Step 3: Run AI review loop**

Run: `node .agents/skills/code-review-loop/scripts/ai-review.mjs --profile auto --verify "npm test"`
Expected: reviewer passes or returns only non-blocking findings.

- [x] **Step 4: Fix blocking review findings**

If P0/P1 findings appear, fix them, rerun `npm test`, and rerun review.
