# Phase 9 Reporting Observability And Cost Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every run understandable, auditable, and cost-aware.

**Architecture:** Extend the existing report generator instead of adding a second report surface. `createReport(record, { historyRecords })` remains the shared JSON source for CLI, MCP, and HTTP, while Markdown formatting renders the same Phase 9 sections for humans.

**Tech Stack:** Node.js ESM, built-in `node:test`, file-backed run records through `FileExecutionStore`.

---

### Task 1: Report Data Model

**Files:**
- Modify: `src/runtime/report.js`

- [x] Add `finalReport` sections for summary, changed files, task graph, model routing, cost estimate, verification, risks, and follow-up recommendations.
- [x] Add `costReport` with planned routing cost, provider cost, per-task model usage, and tier totals.
- [x] Add `traceViewerData` with run, task, event, routing, model call, worker attempt, and verification data.
- [x] Add `exportFormat` metadata for JSON and Markdown exports.

### Task 2: Decisions And Failures

**Files:**
- Modify: `src/runtime/report.js`

- [x] Add routing decision records with reason fields.
- [x] Add escalation decision records with reason fields.
- [x] Add failure categories for provider error, malformed output, policy violation, verification failure, and human approval rejected.

### Task 3: Historical Reliability

**Files:**
- Modify: `src/runtime/report.js`
- Modify: `src/runtime/tools.js`
- Modify: `src/cli.js`
- Modify: `src/server.js`

- [x] Compute model reliability metrics grouped by task type and model tier.
- [x] Pass `store.listRecords()` into report creation from MCP, CLI, and HTTP report surfaces.

### Task 4: Verification And Docs

**Files:**
- Create: `tests/phase9-reporting.test.js`
- Modify: `README.md`
- Modify: `docs/integrations.md`
- Modify: `total.md`

- [x] Cover Phase 9 report fields, failure categories, and historical reliability.
- [x] Document Phase 9 reporting fields.
- [x] Check Phase 9 tasks in `total.md` without marking Phase 10.
