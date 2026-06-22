# Phase 8 Host Tool Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI Coding Runtime easy to connect from Codex Desktop, Codex CLI, Cursor, and OpenCode.

**Architecture:** Phase 8 is a documentation and example-config layer over the existing stdio MCP, HTTP MCP, and HTTP health endpoints. Runtime protocol code already exposes the necessary host interfaces, so this phase adds focused guides, reusable prompts, sample MCP configuration files, and smoke-test checklists.

**Tech Stack:** Markdown guides, JSON/TOML sample configuration, Node's built-in test runner for documentation shape checks.

---

### Task 1: Integration File Map

**Files:**
- Create: `docs/integrations/README.md`
- Create: `docs/integrations/codex-desktop.md`
- Create: `docs/integrations/codex-cli.md`
- Create: `docs/integrations/cursor.md`
- Create: `docs/integrations/opencode.md`
- Create: `docs/integrations/prompts.md`
- Create: `docs/integrations/smoke-tests.md`
- Modify: `docs/integrations.md`
- Modify: `README.md`

- [x] Define the Phase 8 document structure.
- [x] Keep `docs/integrations.md` as the high-level index and compatibility overview.
- [x] Put per-tool instructions in `docs/integrations/*.md`.

### Task 2: Sample MCP Configs

**Files:**
- Create: `examples/codex-desktop/mcp.json`
- Create: `examples/codex-cli/config.toml`
- Create: `examples/cursor/mcp-http.json`
- Create: `examples/cursor/mcp-stdio.json`
- Create: `examples/opencode/opencode-http.json`
- Modify: `examples/opencode/opencode.json`

- [x] Add a sample MCP config for Codex Desktop.
- [x] Add a sample MCP config for Codex CLI.
- [x] Add stdio and HTTP MCP examples for Cursor.
- [x] Add local and HTTP MCP examples for OpenCode.

### Task 3: Prompt Library

**Files:**
- Create: `examples/prompts/plan-only.md`
- Create: `examples/prompts/cost-optimized.md`
- Create: `examples/prompts/premium-final-review.md`
- Create: `examples/prompts/high-risk-require-approval.md`
- Create: `examples/prompts/README.md`
- Modify: `docs/integrations/prompts.md`

- [x] Add prompts for plan-only usage.
- [x] Add prompts for cost-optimized usage.
- [x] Add prompts for premium final review usage.
- [x] Add prompts for high-risk approval-gated usage.

### Task 4: Smoke Test Checklist

**Files:**
- Create: `examples/smoke-tests/codex-desktop.md`
- Create: `examples/smoke-tests/codex-cli.md`
- Create: `examples/smoke-tests/cursor.md`
- Create: `examples/smoke-tests/opencode.md`
- Modify: `docs/integrations/smoke-tests.md`

- [x] Add smoke checks for service health.
- [x] Add smoke checks for MCP tool discovery.
- [x] Add smoke checks for plan, run, verify, and report flow.
- [x] Add host-specific troubleshooting notes.

### Task 5: Verification

**Files:**
- Create: `tests/phase8-integrations.test.js`
- Modify: `total.md`

- [x] Add documentation shape tests for Phase 8 deliverables.
- [x] Validate JSON sample configuration files.
- [x] Check Phase 8 tasks in `total.md`.
- [x] Run project verification and AI review loop.
