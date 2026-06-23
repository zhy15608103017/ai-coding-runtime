# Phase 10 Policy Safety And Team Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Historical note:** this plan was drafted before the later user constraint to stop adding tests and not commit code. Any test-writing and `git commit` steps below are superseded by that later instruction.

**Goal:** Complete Phase 10 by adding a unified policy engine, safety enforcement, secret redaction, team policy examples, and redacted audit exports.

**Architecture:** Add `src/runtime/policy.js` as the single policy boundary. Existing modules keep their current responsibilities: planner builds plans, router routes models, workspace validates file scope, worker records attempts, verification runs commands, report formats evidence, and tools expose CLI/HTTP/MCP behavior. Each existing module calls the policy helpers at its boundary instead of embedding policy rules inline.

**Tech Stack:** Node.js ESM, built-in `node:test`, file-backed `FileExecutionStore`, existing CLI/HTTP/MCP runtime surfaces.

---

## File Structure

- Create `src/runtime/policy.js`: default policy config, normalization, validation, policy evaluation, file/command checks, redaction, audit export.
- Modify `src/runtime/config.js`: add top-level `policy`, normalize it after config/env merge, expose validation.
- Modify `src/runtime/planner.js`: accept normalized policy config, evaluate run policy, attach policy metadata, and merge Phase 10 budget aliases into Phase 4 budget.
- Modify `src/runtime/contracts.js`: validate new plan aliases for `policyConfig`, `policyValidation`, and existing `policyStatus` compatibility.
- Modify `src/runtime/store.js`: record policy events on run creation and keep refusing disallowed plans.
- Modify `src/runtime/workspace.js`: accept workspace policy in context and patch validation helpers.
- Modify `src/runtime/worker.js`: pass policy to workspace helpers and redact stored worker prompts/attempt text.
- Modify `src/runtime/verification.js`: expose command policy filtering/refusal helper or accept a pre-filtered command list.
- Modify `src/runtime/tools.js`: pass policy into planning, worker, verification, model generation, reports, and new audit tool.
- Modify `src/runtime/report.js`: redact returned reports and expose audit export helper.
- Modify `src/cli.js`: add `audit <run-id> --json` and pass policy through runtime options.
- Modify `src/server.js`: add `GET /api/runs/:runId/audit`.
- Inspect `src/mcp.js`: confirm tool registration reads `RUNTIME_TOOLS`; modify it only if `runtime_audit` does not appear automatically in MCP tool listing.
- Modify `src/index.js`: export `createAuditExport`, `normalizePolicyConfig`, `validatePolicyConfig`, and `redactSecrets` so tests and host code can import the public helpers from the package index.
- Create `tests/phase10-policy-safety-team.test.js`: Phase 10 behavior coverage.
- Modify `tests/runtime.test.js`, `tests/worker.test.js`, `tests/gateway.test.js`, `tests/cli.test.js`, and `tests/phase9-reporting.test.js` when a task below names a specific assertion for those files.
- Create `docs/policy.md`: policy schema and operational reference.
- Create `examples/team-policies/solo-default.json`, `examples/team-policies/team-strict.json`, and `examples/team-policies/high-security.json`.
- Modify `README.md`, `docs/integrations.md`, and `total.md`.
- Create `.ai-review/review-context/current-request.md` before final review.

---

### Task 1: Policy Schema, Validation, And Redaction Core

**Files:**
- Create: `src/runtime/policy.js`
- Create: `tests/phase10-policy-safety-team.test.js`

- [ ] **Step 1: Write failing policy schema and redaction tests**

Append these tests to the new `tests/phase10-policy-safety-team.test.js`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_POLICY_CONFIG,
  normalizePolicyConfig,
  redactSecrets,
  validatePolicyConfig,
} from "../src/runtime/policy.js";

test("Phase 10 policy config exposes safe compatible defaults", () => {
  const policy = normalizePolicyConfig();

  assert.equal(policy.schemaVersion, "runtime.policy.v1");
  assert.equal(policy.budget.maxCostPerRun, DEFAULT_POLICY_CONFIG.budget.maxCostPerRun);
  assert.equal(policy.safety.requireHumanApprovalForHighRisk, true);
  assert.equal(policy.safety.blockSecretExfiltration, true);
  assert.deepEqual(policy.workspace.allowedFiles, []);
  assert.deepEqual(policy.commands.allowlist, []);
});

test("Phase 10 policy validation reports invalid config fields", () => {
  const validation = validatePolicyConfig({
    budget: { maxCostPerRun: -1, maxWorkerRetries: "many" },
    workspace: { allowedFiles: ["src/**", 123] },
    commands: { allowlist: "npm test" },
    safety: { requireTestsForCodeChanges: "yes" },
  });

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.code === "policy.budget.max_cost.invalid"));
  assert.ok(validation.errors.some((error) => error.code === "policy.budget.max_worker_retries.invalid"));
  assert.ok(validation.errors.some((error) => error.code === "policy.workspace.allowed_files.invalid"));
  assert.ok(validation.errors.some((error) => error.code === "policy.commands.allowlist.invalid"));
  assert.ok(validation.errors.some((error) => error.code === "policy.safety.boolean.invalid"));
});

test("Phase 10 redaction removes secret values recursively", () => {
  const value = {
    prompt: "OPENAI_API_KEY=sk-secret-value\nnormal text",
    nested: {
      token: "abc123",
      url: "https://example.test/path?token=leak",
    },
    list: ["password: hunter2", "safe"],
  };

  const redacted = redactSecrets(value, normalizePolicyConfig());
  const serialized = JSON.stringify(redacted);

  assert.match(serialized, /\[REDACTED\]/);
  assert.doesNotMatch(serialized, /sk-secret-value/);
  assert.doesNotMatch(serialized, /abc123/);
  assert.doesNotMatch(serialized, /hunter2/);
  assert.match(serialized, /normal text/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/phase10-policy-safety-team.test.js`

Expected: fail with `Cannot find module '../src/runtime/policy.js'`.

- [ ] **Step 3: Create the policy module with defaults, validation, and redaction**

Create `src/runtime/policy.js` with these exports and helpers:

```js
import { createHash } from "node:crypto";

export const DEFAULT_POLICY_CONFIG = {
  schemaVersion: "runtime.policy.v1",
  budget: {
    maxCostPerRun: 1,
    maxWorkerRetries: 8,
    maxCallsPerRun: 20,
  },
  routing: {
    finalReviewModelTier: "premium",
    securityTasksMinTier: "premium",
    readonlyTasksAllowLocalModels: true,
  },
  safety: {
    requireHumanApprovalForHighRisk: true,
    requireTestsForCodeChanges: false,
    blockSecretExfiltration: true,
    blockUnapprovedNetworkAccess: false,
  },
  workspace: {
    trusted: true,
    allowedFiles: [],
    blockedFiles: [".env", ".env.*", "*.pem", "*.key", "secrets/**"],
  },
  commands: {
    allowlist: [],
    blockNetworkByDefault: false,
  },
  secrets: {
    redactionText: "[REDACTED]",
    patterns: ["api[_-]?key", "token", "secret", "password", "credential"],
  },
  audit: {
    includeTraceViewerData: true,
  },
};

const BOOLEAN_SAFETY_FIELDS = [
  "requireHumanApprovalForHighRisk",
  "requireTestsForCodeChanges",
  "blockSecretExfiltration",
  "blockUnapprovedNetworkAccess",
];

export function normalizePolicyConfig(policy = {}) {
  const input = isPlainObject(policy) ? policy : {};
  const normalized = deepMerge(DEFAULT_POLICY_CONFIG, input);
  normalized.schemaVersion = DEFAULT_POLICY_CONFIG.schemaVersion;
  normalized.workspace.allowedFiles = uniqueStrings(normalized.workspace.allowedFiles);
  normalized.workspace.blockedFiles = uniqueStrings(normalized.workspace.blockedFiles);
  normalized.commands.allowlist = uniqueStrings(normalized.commands.allowlist);
  normalized.secrets.patterns = uniqueStrings(normalized.secrets.patterns);
  return normalized;
}

export function validatePolicyConfig(policy = {}) {
  const normalized = normalizePolicyConfig(policy);
  const errors = [];

  if (!isNonNegativeNumber(normalized.budget.maxCostPerRun)) {
    errors.push(error("policy.budget.max_cost.invalid", "policy.budget.maxCostPerRun"));
  }
  if (!Number.isInteger(normalized.budget.maxWorkerRetries) || normalized.budget.maxWorkerRetries < 0) {
    errors.push(error("policy.budget.max_worker_retries.invalid", "policy.budget.maxWorkerRetries"));
  }
  if (!Number.isInteger(normalized.budget.maxCallsPerRun) || normalized.budget.maxCallsPerRun < 0) {
    errors.push(error("policy.budget.max_calls.invalid", "policy.budget.maxCallsPerRun"));
  }
  for (const field of BOOLEAN_SAFETY_FIELDS) {
    if (typeof normalized.safety[field] !== "boolean") {
      errors.push(error("policy.safety.boolean.invalid", `policy.safety.${field}`));
    }
  }
  if (!isStringArray(policy?.workspace?.allowedFiles ?? [])) {
    errors.push(error("policy.workspace.allowed_files.invalid", "policy.workspace.allowedFiles"));
  }
  if (!isStringArray(policy?.workspace?.blockedFiles ?? [])) {
    errors.push(error("policy.workspace.blocked_files.invalid", "policy.workspace.blockedFiles"));
  }
  if (!isStringArray(policy?.commands?.allowlist ?? [])) {
    errors.push(error("policy.commands.allowlist.invalid", "policy.commands.allowlist"));
  }

  return {
    valid: errors.length === 0,
    errors,
    policy: normalized,
  };
}

export function redactSecrets(value, policy = DEFAULT_POLICY_CONFIG) {
  const normalized = normalizePolicyConfig(policy);
  if (normalized.safety.blockSecretExfiltration === false) return value;
  return redactValue(value, normalized, null);
}

export function stableHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function redactValue(value, policy, key) {
  if (typeof value === "string") return redactString(value, policy, key);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, policy, key));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactValue(entryValue, policy, entryKey),
      ])
    );
  }
  return value;
}

function redactString(value, policy, key) {
  const marker = policy.secrets.redactionText;
  const keyPattern = new RegExp(policy.secrets.patterns.join("|"), "i");
  if (key && keyPattern.test(key)) return marker;

  let redacted = value;
  for (const pattern of policy.secrets.patterns) {
    const assignment = new RegExp(`(${pattern}\\s*[:=]\\s*)([^\\s&]+)`, "gi");
    redacted = redacted.replace(assignment, `$1${marker}`);
  }
  return redacted;
}

function error(code, field) {
  return { code, field, message: `${field} is not valid.` };
}

function deepMerge(base, override) {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override ?? {})) {
    result[key] =
      isPlainObject(value) && isPlainObject(result[key])
        ? deepMerge(result[key], value)
        : value;
  }
  return result;
}

function uniqueStrings(values) {
  return Array.isArray(values)
    ? [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))]
    : [];
}

function isNonNegativeNumber(value) {
  return Number.isFinite(value) && value >= 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/phase10-policy-safety-team.test.js`

Expected: pass for the first three tests.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/policy.js tests/phase10-policy-safety-team.test.js
git commit -m "feat: add phase 10 policy core"
```

---

### Task 2: Config Loading And Runtime Options

**Files:**
- Modify: `src/runtime/config.js`
- Modify: `src/cli.js`
- Test: `tests/phase10-policy-safety-team.test.js`

- [ ] **Step 1: Write failing config tests**

Append:

```js
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

import { loadRuntimeConfig } from "../src/runtime/config.js";

test("loadRuntimeConfig normalizes top-level Phase 10 policy", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-policy-config-"));
  await writeFile(
    path.join(workspace, "runtime.config.json"),
    JSON.stringify({
      policy: {
        budget: { maxCostPerRun: 0.25, maxWorkerRetries: 2 },
        workspace: { allowedFiles: ["src/**"] },
      },
    }),
    "utf8"
  );

  const config = await loadRuntimeConfig({ cwd: workspace, env: {} });

  assert.equal(config.policy.budget.maxCostPerRun, 0.25);
  assert.equal(config.policy.budget.maxWorkerRetries, 2);
  assert.deepEqual(config.policy.workspace.allowedFiles, ["src/**"]);
  assert.equal(config.policyValidation.valid, true);
});

test("loadRuntimeConfig reports invalid Phase 10 policy config", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-policy-invalid-"));
  await writeFile(
    path.join(workspace, "runtime.config.json"),
    JSON.stringify({ policy: { commands: { allowlist: "npm test" } } }),
    "utf8"
  );

  const config = await loadRuntimeConfig({ cwd: workspace, env: {} });

  assert.equal(config.policyValidation.valid, false);
  assert.ok(config.policyValidation.errors.some((error) => error.code === "policy.commands.allowlist.invalid"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/phase10-policy-safety-team.test.js`

Expected: fail because `config.policy` and `config.policyValidation` are missing.

- [ ] **Step 3: Wire policy into config and CLI runtime options**

In `src/runtime/config.js`, import policy helpers:

```js
import { normalizePolicyConfig, validatePolicyConfig } from "./policy.js";
```

Add the default top-level config:

```js
  policy: normalizePolicyConfig(),
```

After env overrides in `loadRuntimeConfig`, normalize and validate:

```js
  merged.policy = normalizePolicyConfig(merged.policy);
  merged.policyValidation = validatePolicyConfig(merged.policy);
  merged.routing.budgetPolicy = {
    ...merged.routing.budgetPolicy,
    maxCostPerRun: merged.policy.budget.maxCostPerRun,
    maxCallsPerRun: merged.policy.budget.maxCallsPerRun,
    maxRetryCount: merged.policy.budget.maxWorkerRetries,
  };
```

In `src/cli.js`, add policy to `runtimeOptionsFromConfig`:

```js
    policy: config.policy,
    policyValidation: config.policyValidation,
```

- [ ] **Step 4: Run targeted tests**

Run: `node --test tests/phase10-policy-safety-team.test.js`

Expected: pass current Phase 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/config.js src/cli.js tests/phase10-policy-safety-team.test.js
git commit -m "feat: load phase 10 policy config"
```

---

### Task 3: Plan-Time Policy Evaluation, Budget, And Risk Approval

**Files:**
- Modify: `src/runtime/policy.js`
- Modify: `src/runtime/planner.js`
- Modify: `src/runtime/contracts.js`
- Test: `tests/phase10-policy-safety-team.test.js`
- Test: `tests/runtime.test.js`

- [ ] **Step 1: Write failing plan policy tests**

Append:

```js
import { createRuntimePlan } from "../src/runtime/planner.js";
import { FileExecutionStore } from "../src/runtime/store.js";

test("createRuntimePlan applies Phase 10 budget policy before persistence", async () => {
  const plan = createRuntimePlan({
    request: "implement a feature with policy budget",
    policy: normalizePolicyConfig({ budget: { maxCostPerRun: 0.01, maxCallsPerRun: 1, maxWorkerRetries: 0 } }),
  });

  assert.equal(plan.policyStatus.allowed, false);
  assert.ok(plan.policyStatus.violations.some((violation) => violation.code === "policy.budget.cost.exceeded"));
  assert.equal(plan.budgetStatus.allowed, false);

  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-policy-budget-"));
  const store = new FileExecutionStore({ workspace });
  await assert.rejects(store.createRecord(plan), /policy.status.violation|budget.policy.violation/);
});

test("createRuntimePlan records Phase 10 policy metadata and high-risk approval gate", () => {
  const plan = createRuntimePlan({
    request: "implement security-sensitive migration",
    policy: normalizePolicyConfig({
      safety: { requireHumanApprovalForHighRisk: true },
    }),
  });

  assert.equal(plan.policyConfig.schemaVersion, "runtime.policy.v1");
  assert.equal(plan.policyValidation.valid, true);
  assert.equal(plan.approval.required, true);
  assert.ok(plan.approval.reasons.some((reason) => reason.task_id === "T-006" || reason.taskId === "T-006"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/phase10-policy-safety-team.test.js`

Expected: fail because `createRuntimePlan` does not accept `policy` or attach `policyConfig`.

- [ ] **Step 3: Implement plan-time policy evaluation**

In `src/runtime/policy.js`, add:

```js
export function budgetPolicyFromPolicy(policy = DEFAULT_POLICY_CONFIG, existingBudgetPolicy = {}) {
  const normalized = normalizePolicyConfig(policy);
  return {
    ...existingBudgetPolicy,
    maxCostPerRun: normalized.budget.maxCostPerRun,
    maxCallsPerRun: normalized.budget.maxCallsPerRun,
    maxRetryCount: normalized.budget.maxWorkerRetries,
  };
}

export function evaluateRunPolicy({
  policy = DEFAULT_POLICY_CONFIG,
  policyValidation = validatePolicyConfig(policy),
  tasks = [],
  budgetStatus = {},
  verification = {},
} = {}) {
  const normalized = normalizePolicyConfig(policy);
  const violations = [];

  if (!policyValidation.valid) {
    violations.push(...policyValidation.errors.map((item) => ({
      ...item,
      code: `policy.config.${item.code}`,
    })));
  }
  for (const violation of budgetStatus.violations ?? []) {
    violations.push({
      ...violation,
      code: violation.code.replace(/^budget\./, "policy.budget."),
    });
  }
  if (normalized.safety.requireTestsForCodeChanges && planEditsFiles(tasks) && !hasTestCommand(verification)) {
    violations.push({
      code: "policy.safety.tests_required",
      field: "policy.safety.requireTestsForCodeChanges",
      message: "Policy requires a test command for file-changing plans.",
    });
  }

  return {
    allowed: violations.length === 0,
    violations,
  };
}

function planEditsFiles(tasks) {
  return tasks.some((task) => (task.allowed_files ?? task.allowedFiles ?? []).length > 0);
}

function hasTestCommand(verification) {
  return Boolean(verification?.test?.command);
}
```

In `src/runtime/planner.js`, import helpers and extend `createRuntimePlan` parameters:

```js
import {
  budgetPolicyFromPolicy,
  evaluateRunPolicy,
  normalizePolicyConfig,
  validatePolicyConfig,
} from "./policy.js";
```

Add parameters:

```js
  policy = undefined,
  policyValidation = undefined,
  verification = {},
```

Before routing, compute:

```js
  const policyConfig = normalizePolicyConfig(policy);
  const effectivePolicyValidation = policyValidation ?? validatePolicyConfig(policyConfig);
  const effectiveBudgetPolicy = budgetPolicyFromPolicy(policyConfig, {
    ...DEFAULT_BUDGET_POLICY,
    ...(budgetPolicy ?? {}),
  });
```

Replace the old `effectiveBudgetPolicy` declaration with that value. After `tasks` are built, replace `createPolicyStatus(policyViolations)` with:

```js
  const policyStatus = evaluateRunPolicy({
    policy: policyConfig,
    policyValidation: effectivePolicyValidation,
    tasks,
    budgetStatus: routedPlan.budgetStatus,
    verification,
  });
  if (Array.isArray(policyViolations) && policyViolations.length > 0) {
    policyStatus.violations.push(...policyViolations);
    policyStatus.allowed = false;
  }
```

Attach aliases to `basePlan`:

```js
    policyConfig,
    policy_config: policyConfig,
    policyValidation: effectivePolicyValidation,
    policy_validation: effectivePolicyValidation,
```

If `contracts.js` rejects the new fields, update validation to allow them as plan metadata and require `policyValidation.valid` boolean when present.

- [ ] **Step 4: Run targeted tests**

Run: `node --test tests/phase10-policy-safety-team.test.js tests/runtime.test.js`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/policy.js src/runtime/planner.js src/runtime/contracts.js tests/phase10-policy-safety-team.test.js tests/runtime.test.js
git commit -m "feat: enforce phase 10 plan policy"
```

---

### Task 4: File Policy In Workspace And Worker Attempts

**Files:**
- Modify: `src/runtime/policy.js`
- Modify: `src/runtime/workspace.js`
- Modify: `src/runtime/worker.js`
- Test: `tests/phase10-policy-safety-team.test.js`
- Test: `tests/worker.test.js`

- [ ] **Step 1: Write failing file policy and worker redaction tests**

Append:

```js
import { createContextPack, validateWorkerPatch } from "../src/runtime/workspace.js";
import { callRuntimeTool } from "../src/runtime/tools.js";

test("workspace context respects Phase 10 blocked files", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-policy-files-"));
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "src", "app.js"), "export const ok = true;\n", "utf8");
  await writeFile(path.join(workspace, ".env"), "OPENAI_API_KEY=sk-secret\n", "utf8");

  const context = await createContextPack({
    cwd: workspace,
    task: {
      task_id: "T-001",
      allowed_files: ["src/**", ".env"],
      referenced_files: [".env"],
    },
    policy: normalizePolicyConfig({ workspace: { blockedFiles: [".env"] } }),
  });

  assert.deepEqual(context.files.map((file) => file.path), ["src/app.js"]);
});

test("worker patch validation applies Phase 10 file allowlist and blocklist", () => {
  const patch = [
    "diff --git a/secrets/key.pem b/secrets/key.pem",
    "--- a/secrets/key.pem",
    "+++ b/secrets/key.pem",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");

  const validation = validateWorkerPatch({
    patch,
    task: { allowed_files: ["secrets/**"] },
    policy: normalizePolicyConfig({
      workspace: { allowedFiles: ["src/**"], blockedFiles: ["secrets/**"] },
    }),
  });

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.code === "policy.workspace.file_blocked"));
});

test("worker attempts store redacted prompts and text", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-policy-worker-redact-"));
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "src", "app.js"), "const value = 1;\n", "utf8");

  const store = new FileExecutionStore({ workspace: path.join(workspace, ".runtime") });
  const run = await callRuntimeTool(
    "runtime_run",
    { request: "implement redacted worker test" },
    { store, runtimeOptions: { workspace: { cwd: workspace }, policy: normalizePolicyConfig() } }
  );
  await callRuntimeTool("runtime_approve", { runId: run.runId, approvedBy: "test" }, { store });

  await callRuntimeTool(
    "runtime_submit_worker_result",
    {
      runId: run.runId,
      taskId: "T-003",
      result: {
        patch: [
          "diff --git a/src/app.js b/src/app.js",
          "--- a/src/app.js",
          "+++ b/src/app.js",
          "@@ -1 +1 @@",
          "-const value = 1;",
          "+const value = 2;",
        ].join("\n"),
        explanation: "TOKEN=super-secret",
        verificationNotes: ["password: hunter2"],
        confidence: 0.9,
        filesTouched: ["src/app.js"],
        acceptance: {
          "implementation matches the approved task contract": "OPENAI_API_KEY=sk-secret",
          "changed files remain inside the allowlist": "src/app.js",
        },
      },
    },
    { store, runtimeOptions: { workspace: { cwd: workspace }, policy: normalizePolicyConfig() } }
  );

  const record = await store.readRecord(run.runId);
  const serialized = JSON.stringify(record.workerAttempts);

  assert.match(serialized, /\[REDACTED\]/);
  assert.doesNotMatch(serialized, /super-secret|hunter2|sk-secret/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/phase10-policy-safety-team.test.js tests/worker.test.js`

Expected: fail because workspace helpers ignore `policy` and worker attempts are unredacted.

- [ ] **Step 3: Add file policy helpers**

In `src/runtime/policy.js`, add:

```js
export function evaluateFilePolicy({ filePath, policy = DEFAULT_POLICY_CONFIG } = {}) {
  const normalized = normalizePolicyConfig(policy);
  const blocked = normalized.workspace.blockedFiles.some((pattern) => matchesPattern(filePath, pattern));
  const allowlist = normalized.workspace.allowedFiles;
  const allowedByTeam = allowlist.length === 0 || allowlist.some((pattern) => matchesPattern(filePath, pattern));
  const violations = [];

  if (blocked) {
    violations.push({
      code: "policy.workspace.file_blocked",
      file: filePath,
      message: `File is blocked by workspace policy: ${filePath}.`,
    });
  }
  if (!allowedByTeam) {
    violations.push({
      code: "policy.workspace.file_not_allowed",
      file: filePath,
      message: `File is outside workspace policy allowlist: ${filePath}.`,
    });
  }

  return {
    allowed: violations.length === 0,
    violations,
  };
}

export function matchesPattern(filePath = "", pattern = "") {
  const normalizedPath = normalizePath(filePath);
  const normalizedPattern = normalizePath(pattern);
  if (!normalizedPath || !normalizedPattern) return false;
  if (normalizedPattern === normalizedPath) return true;
  if (normalizedPattern.endsWith("/**")) return normalizedPath.startsWith(normalizedPattern.slice(0, -2));
  if (!normalizedPattern.includes("*")) return false;
  const expression = `^${escapeRegExp(normalizedPattern).replaceAll("\\*", "[^/]*")}$`;
  return new RegExp(expression).test(normalizedPath);
}
```

Add these helpers in the same file:

```js
function normalizePath(value = "") {
  const raw = String(value).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!raw || raw.includes("\0")) return "";
  if (raw.startsWith("/") || raw.startsWith("//")) return "";
  if (/^[A-Za-z]:/.test(raw)) return "";
  if (raw.split("/").some((segment) => segment === "..")) return "";
  return raw
    .split("/")
    .filter((segment) => segment && segment !== ".")
    .join("/");
}

function escapeRegExp(value) {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
```

- [ ] **Step 4: Wire workspace and worker redaction**

In `src/runtime/workspace.js`, import `evaluateFilePolicy` and update function signatures:

```js
export async function createContextPack({ cwd = process.cwd(), task = {}, maxBytesPerFile = 64 * 1024, policy = null } = {}) {
```

Filter selected files with both task contract and policy:

```js
  const selectedFiles = snapshot.files.filter((file) => {
    if (!isAllowedPath(file.path, contextPatterns)) return false;
    return policy ? evaluateFilePolicy({ filePath: file.path, policy }).allowed : true;
  });
```

Update `validateWorkerPatch({ patch, task, policy })` to push file policy violations for each touched file after task allowlist checks.

In `src/runtime/worker.js`, pass `runtimeOptions.policy` into `createContextPack`, `validateWorkerPatch`, and `applyWorkerPatch`. Import `redactSecrets` and redact `result`, `contextPack`, and `workerPrompt` inside `createWorkerAttempt`:

```js
  const policy = runtimeOptions.policy;
  contextPack = await createContextPack({ cwd: workspaceCwd, task, policy });
  const workerPrompt = redactSecrets(createWorkerPrompt({ task, contextPack }), policy);
  const safeResult = redactSecrets(result, policy);
```

Use `safeResult` for persisted attempt fields.

- [ ] **Step 5: Run targeted tests**

Run: `node --test tests/phase10-policy-safety-team.test.js tests/worker.test.js`

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/policy.js src/runtime/workspace.js src/runtime/worker.js tests/phase10-policy-safety-team.test.js tests/worker.test.js
git commit -m "feat: enforce phase 10 workspace policy"
```

---

### Task 5: Command Policy And Required Tests For Code Changes

**Files:**
- Modify: `src/runtime/policy.js`
- Modify: `src/runtime/verification.js`
- Modify: `src/runtime/tools.js`
- Test: `tests/phase10-policy-safety-team.test.js`
- Test: `tests/phase7-verification.test.js`

- [ ] **Step 1: Write failing command policy tests**

Append:

```js
test("verification command policy blocks commands outside allowlist", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-policy-command-"));
  const store = new FileExecutionStore({ workspace: path.join(workspace, ".runtime") });
  const run = await callRuntimeTool(
    "runtime_run",
    { request: "plan only command policy" },
    {
      store,
      runtimeOptions: {
        workspace: { cwd: workspace },
        policy: normalizePolicyConfig({ commands: { allowlist: ["node --test"] } }),
        verification: {
          diff_check: { enabled: false },
          test: { command: "npm", args: ["test"], required: true },
        },
      },
    }
  );

  const verification = await callRuntimeTool(
    "runtime_verify",
    { runId: run.runId },
    {
      store,
      runtimeOptions: {
        workspace: { cwd: workspace },
        policy: normalizePolicyConfig({ commands: { allowlist: ["node --test"] } }),
        verification: {
          diff_check: { enabled: false },
          test: { command: "npm", args: ["test"], required: true },
        },
      },
    }
  );

  assert.equal(verification.status, "failed");
  assert.ok(verification.commands.some((command) => command.error?.code === "policy.command.not_allowed"));
});

test("policy requiring tests blocks file-changing plans without a test command", () => {
  const plan = createRuntimePlan({
    request: "implement code without configured tests",
    policy: normalizePolicyConfig({ safety: { requireTestsForCodeChanges: true } }),
    verification: { diff_check: { enabled: true } },
  });

  assert.equal(plan.policyStatus.allowed, false);
  assert.ok(plan.policyStatus.violations.some((violation) => violation.code === "policy.safety.tests_required"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/phase10-policy-safety-team.test.js tests/phase7-verification.test.js`

Expected: fail because commands outside allowlist still execute and required test policy may not inspect verification.

- [ ] **Step 3: Add command policy helpers**

In `src/runtime/policy.js`, add:

```js
export function evaluateCommandPolicy({ command, policy = DEFAULT_POLICY_CONFIG } = {}) {
  const normalized = normalizePolicyConfig(policy);
  const commandText = commandToText(command);
  const allowlist = normalized.commands.allowlist;
  const violations = [];

  if (allowlist.length > 0 && !allowlist.includes(commandText)) {
    violations.push({
      code: "policy.command.not_allowed",
      command: commandText,
      message: `Command is outside policy allowlist: ${commandText}.`,
    });
  }
  if (normalized.commands.blockNetworkByDefault || normalized.safety.blockUnapprovedNetworkAccess) {
    if (/\b(curl|wget|ssh|scp|ftp|Invoke-WebRequest|iwr)\b/i.test(commandText)) {
      violations.push({
        code: "policy.command.network_blocked",
        command: commandText,
        message: `Network-oriented command is blocked by policy: ${commandText}.`,
      });
    }
  }

  return {
    allowed: violations.length === 0,
    violations,
  };
}

export function commandToText(command = {}) {
  return [command.command, ...(command.args ?? [])].filter(Boolean).map(String).join(" ").trim();
}
```

- [ ] **Step 4: Wire command policy into verification**

In `src/runtime/verification.js`, export a policy application helper:

```js
export function applyCommandPolicy(commands = [], policy = null) {
  if (!policy) return commands;
  return commands.map((command) => {
    const evaluation = evaluateCommandPolicy({ command, policy });
    if (evaluation.allowed) return command;
    return {
      ...command,
      policyBlocked: true,
      policy_blocked: true,
      policyViolations: evaluation.violations,
      policy_violations: evaluation.violations,
    };
  });
}
```

Import `evaluateCommandPolicy`. In `runVerificationCommand`, before spawning, return a failed command result for `config.policyBlocked`:

```js
  if (config.policyBlocked) {
    return Promise.resolve(
      finishCommand(baseResult, startedAtMs, {
        error: config.policyViolations[0],
        policyViolations: config.policyViolations,
        policy_violations: config.policyViolations,
      })
    );
  }
```

In `src/runtime/tools.js`, import `applyCommandPolicy` and change:

```js
  const commands = applyCommandPolicy(
    buildVerificationCommands(runtimeOptions.verification ?? {}),
    runtimeOptions.policy
  );
```

- [ ] **Step 5: Run targeted tests**

Run: `node --test tests/phase10-policy-safety-team.test.js tests/phase7-verification.test.js`

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/policy.js src/runtime/verification.js src/runtime/tools.js tests/phase10-policy-safety-team.test.js tests/phase7-verification.test.js
git commit -m "feat: enforce phase 10 command policy"
```

---

### Task 6: Model Trace And Report Redaction

**Files:**
- Modify: `src/runtime/tools.js`
- Modify: `src/runtime/report.js`
- Test: `tests/phase10-policy-safety-team.test.js`
- Test: `tests/phase9-reporting.test.js`

- [ ] **Step 1: Write failing model/report redaction tests**

Append:

```js
test("model generation traces are redacted before storage", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-policy-model-redact-"));
  const store = new FileExecutionStore({ workspace });
  const run = await callRuntimeTool(
    "runtime_run",
    { request: "plan only model redaction" },
    { store, runtimeOptions: { policy: normalizePolicyConfig() } }
  );

  await callRuntimeTool(
    "runtime_model_generate",
    {
      runId: run.runId,
      provider: "local",
      prompt: "TOKEN=super-secret",
    },
    {
      store,
      runtimeOptions: {
        policy: normalizePolicyConfig(),
        providers: {
          defaultProvider: "local",
          entries: {
            local: {
              type: "local-placeholder",
              defaultModel: "local-placeholder",
            },
          },
        },
      },
    }
  );

  const record = await store.readRecord(run.runId);
  const serialized = JSON.stringify(record.modelCalls);
  assert.match(serialized, /\[REDACTED\]/);
  assert.doesNotMatch(serialized, /super-secret/);
});

test("runtime reports are redacted by default", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-policy-report-redact-"));
  const store = new FileExecutionStore({ workspace });
  const run = await callRuntimeTool(
    "runtime_run",
    { request: "plan only report redaction SECRET=leak" },
    { store, runtimeOptions: { policy: normalizePolicyConfig() } }
  );

  const report = await callRuntimeTool("runtime_report", { runId: run.runId }, { store });
  const serialized = JSON.stringify(report);

  assert.match(serialized, /\[REDACTED\]/);
  assert.doesNotMatch(serialized, /SECRET=leak/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/phase10-policy-safety-team.test.js tests/phase9-reporting.test.js`

Expected: fail because model call requests and reports are returned unredacted.

- [ ] **Step 3: Redact model traces and reports**

In `src/runtime/tools.js`, import `redactSecrets`. Before `store.recordModelCall` and `store.recordModelCallFailure`, redact the payload:

```js
const safeResponse = redactSecrets(response, runtimeOptions.policy);
await store.recordModelCall(args.runId, {
  provider: safeResponse.provider,
  model: safeResponse.model,
  usage: safeResponse.usage,
  costEstimate: safeResponse.costEstimate,
  cost_estimate: safeResponse.cost_estimate,
  finishReason: safeResponse.finishReason,
  finish_reason: safeResponse.finish_reason,
  request: safeResponse.request,
});
```

Apply the same pattern in `generateSupervisorModelResponse` for supervisor calls and in failure branches.

In `src/runtime/report.js`, import `redactSecrets` and add an optional `policy` argument:

```js
export function createReport(record, { historyRecords = [], policy = record.plan?.policyConfig } = {}) {
```

Build the existing report as `report`, then return:

```js
  return redactSecrets(report, policy);
```

Pass `runtimeOptions.policy` from `tools.js` report creation. Leave direct `createReport(record)` callers safe by using `record.plan.policyConfig`.

- [ ] **Step 4: Run targeted tests**

Run: `node --test tests/phase10-policy-safety-team.test.js tests/phase9-reporting.test.js`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/tools.js src/runtime/report.js tests/phase10-policy-safety-team.test.js tests/phase9-reporting.test.js
git commit -m "feat: redact phase 10 traces and reports"
```

---

### Task 7: Audit Export Through Tools, CLI, HTTP, And MCP

**Files:**
- Modify: `src/runtime/policy.js`
- Modify: `src/runtime/tools.js`
- Modify: `src/cli.js`
- Modify: `src/server.js`
- Modify: `src/index.js`
- Test: `tests/phase10-policy-safety-team.test.js`
- Test: `tests/cli.test.js`
- Test: `tests/gateway.test.js`

- [ ] **Step 1: Write failing audit export tests**

Append:

```js
test("completed runs produce redacted Phase 10 audit exports", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-policy-audit-"));
  const store = new FileExecutionStore({ workspace });
  const run = await callRuntimeTool(
    "runtime_run",
    { request: "plan only audit SECRET=leak" },
    { store, runtimeOptions: { policy: normalizePolicyConfig(), verification: { diff_check: { enabled: false } } } }
  );
  await callRuntimeTool(
    "runtime_verify",
    { runId: run.runId },
    { store, runtimeOptions: { policy: normalizePolicyConfig(), verification: { diff_check: { enabled: false } } } }
  );

  const audit = await callRuntimeTool("runtime_audit", { runId: run.runId }, { store });

  assert.equal(audit.schema, "ai-coding-runtime.audit");
  assert.equal(audit.version, 1);
  assert.equal(audit.run.runId, run.runId);
  assert.equal(typeof audit.integrity.sha256, "string");
  assert.equal(audit.integrity.eventCount > 0, true);
  assert.doesNotMatch(JSON.stringify(audit), /SECRET=leak/);
});

test("active runs cannot be exported as completed audit evidence", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-policy-audit-active-"));
  const store = new FileExecutionStore({ workspace });
  const run = await callRuntimeTool(
    "runtime_run",
    { request: "plan only active audit" },
    { store, runtimeOptions: { policy: normalizePolicyConfig() } }
  );

  await assert.rejects(
    callRuntimeTool("runtime_audit", { runId: run.runId }, { store }),
    /not completed/
  );
});
```

Add a CLI test to `tests/cli.test.js`:

```js
test("Phase 10 CLI audit exports completed runs", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-cli-audit-"));

  try {
    await writeFile(
      path.join(workspace, "runtime.config.json"),
      JSON.stringify({ verification: { diff_check: { enabled: false } } }),
      "utf8"
    );

    const runResult = runCli(["run", "plan only cli audit", "--json"], workspace, workspace);
    assert.equal(runResult.status, 0, runResult.stderr);
    const run = JSON.parse(runResult.stdout);

    const verifyResult = runCli(["verify", run.runId, "--json"], workspace, workspace);
    assert.equal(verifyResult.status, 0, verifyResult.stderr);

    const auditResult = runCli(["audit", run.runId, "--json"], workspace, workspace);
    assert.equal(auditResult.status, 0, auditResult.stderr);
    const audit = JSON.parse(auditResult.stdout);
    assert.equal(audit.schema, "ai-coding-runtime.audit");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

Add an HTTP test to `tests/gateway.test.js`:

```js
test("HTTP gateway exports Phase 10 audit evidence", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-http-audit-"));
  const store = new FileExecutionStore({ workspace });
  const server = createRuntimeHttpServer({
    store,
    runtimeOptions: {
      workspace: { cwd: workspace },
      verification: { diff_check: { enabled: false } },
    },
  });
  const started = await listen(server, { host: "127.0.0.1", port: 0 });
  try {
    const runResponse = await fetch(`${started.httpUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: "plan only http audit" }),
    });
    const run = await runResponse.json();
    await fetch(`${started.httpUrl}/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: run.runId }),
    });
    const auditResponse = await fetch(`${started.httpUrl}/api/runs/${run.runId}/audit`);
    const audit = await auditResponse.json();
    assert.equal(audit.schema, "ai-coding-runtime.audit");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/phase10-policy-safety-team.test.js`

Expected: fail with `Unknown runtime tool: runtime_audit`.

- [ ] **Step 3: Implement audit export helper**

In `src/runtime/policy.js`, add:

```js
const COMPLETED_AUDIT_STATUSES = new Set([
  "verification_passed",
  "verification_failed",
  "verification_skipped",
  "canceled",
  "approval_rejected",
]);

export function createAuditExport(record, { report = null, policy = record?.plan?.policyConfig } = {}) {
  if (!COMPLETED_AUDIT_STATUSES.has(record.status)) {
    const error = new Error(`Run ${record.runId} is not completed and cannot be exported for audit.`);
    error.statusCode = 409;
    throw error;
  }

  const redacted = redactSecrets(
    {
      schema: "ai-coding-runtime.audit",
      version: 1,
      generatedAt: new Date().toISOString(),
      run: {
        runId: record.runId,
        run_id: record.runId,
        status: record.status,
        request: record.request,
        createdAt: record.createdAt,
        created_at: record.createdAt,
        updatedAt: record.updatedAt,
        updated_at: record.updatedAt,
      },
      plan: record.plan,
      policy: {
        config: record.plan?.policyConfig ?? null,
        validation: record.plan?.policyValidation ?? null,
        status: record.plan?.policyStatus ?? null,
        budgetStatus: record.plan?.budgetStatus ?? null,
      },
      evidence: {
        approval: record.plan?.approval ?? null,
        routing: record.plan?.routingTrace ?? [],
        events: record.events ?? [],
        modelCalls: record.modelCalls ?? [],
        workerAttempts: record.workerAttempts ?? [],
        verification: record.verification ?? [],
      },
      report,
    },
    policy
  );

  const hashPayload = { ...redacted, integrity: undefined };
  return {
    ...redacted,
    integrity: {
      eventCount: record.events?.length ?? 0,
      event_count: record.events?.length ?? 0,
      sha256: stableHash(hashPayload),
    },
  };
}
```

- [ ] **Step 4: Expose audit through runtime tools, CLI, and HTTP**

In `src/runtime/tools.js`, add an entry to `RUNTIME_TOOLS`:

```js
  {
    name: "runtime_audit",
    description: "Return a redacted audit export for a completed runtime run.",
    inputSchema: runIdSchema(),
  },
```

Import `createAuditExport`; add switch case:

```js
    case "runtime_audit":
      return auditRun(requireRunId(args), store, runtimeOptions);
```

Add helper:

```js
async function auditRun(runId, store, runtimeOptions = {}) {
  const record = await store.readRecord(runId);
  const historyRecords = typeof store.listRecords === "function" ? await store.listRecords() : [];
  const report = createReport(record, { historyRecords, policy: runtimeOptions.policy });
  return createAuditExport(record, { report, policy: runtimeOptions.policy });
}
```

In `src/cli.js`, add command `audit`, parser branch, help text line, and:

```js
async function auditCommand(args, io) {
  const { positional } = parseArgs(args);
  const [runId] = positional;
  if (!runId) throw new Error("audit requires a run id.");
  const config = await loadRuntimeConfig();
  const store = new FileExecutionStore({ workspace: config.storage.directory });
  const audit = await callRuntimeTool("runtime_audit", { runId }, { store, runtimeOptions: runtimeOptionsFromConfig(config) });
  io.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
  return 0;
}
```

In `src/server.js`, add:

```js
      const auditMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/audit$/);
      if (request.method === "GET" && auditMatch) {
        const audit = await callRuntimeTool("runtime_audit", { runId: auditMatch[1] }, { store, runtimeOptions });
        return sendJson(response, 200, audit);
      }
```

In `src/index.js`, export `createAuditExport` if the index currently re-exports runtime helpers.

- [ ] **Step 5: Add CLI and HTTP tests**

Extend `tests/cli.test.js` to create a completed run, invoke `runCli(["audit", runId, "--json"], io)`, parse stdout, and assert `schema === "ai-coding-runtime.audit"`.

Extend `tests/gateway.test.js` to call `GET /api/runs/:runId/audit` after verification and assert the same schema.

- [ ] **Step 6: Run targeted tests**

Run: `node --test tests/phase10-policy-safety-team.test.js tests/cli.test.js tests/gateway.test.js`

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/policy.js src/runtime/tools.js src/cli.js src/server.js src/index.js tests/phase10-policy-safety-team.test.js tests/cli.test.js tests/gateway.test.js
git commit -m "feat: add phase 10 audit export"
```

---

### Task 8: Team Policy Examples And Documentation

**Files:**
- Create: `examples/team-policies/solo-default.json`
- Create: `examples/team-policies/team-strict.json`
- Create: `examples/team-policies/high-security.json`
- Create: `docs/policy.md`
- Modify: `README.md`
- Modify: `docs/integrations.md`
- Test: `tests/phase10-policy-safety-team.test.js`

- [ ] **Step 1: Write failing docs/example tests**

Append:

```js
import { readFile } from "node:fs/promises";

test("Phase 10 team policy examples validate against schema", async () => {
  for (const file of [
    "examples/team-policies/solo-default.json",
    "examples/team-policies/team-strict.json",
    "examples/team-policies/high-security.json",
  ]) {
    const policy = JSON.parse(await readFile(file, "utf8"));
    const validation = validatePolicyConfig(policy);
    assert.equal(validation.valid, true, `${file}: ${JSON.stringify(validation.errors)}`);
  }
});

test("Phase 10 policy documentation covers safety surfaces", async () => {
  const policyDoc = await readFile("docs/policy.md", "utf8");
  const readme = await readFile("README.md", "utf8");
  const integrations = await readFile("docs/integrations.md", "utf8");

  assert.match(policyDoc, /Policy schema/i);
  assert.match(policyDoc, /Secret redaction/i);
  assert.match(policyDoc, /Audit export/i);
  assert.match(readme, /Phase 10/i);
  assert.match(integrations, /runtime_audit|audit export/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/phase10-policy-safety-team.test.js`

Expected: fail because files are missing.

- [ ] **Step 3: Add policy examples**

Create `examples/team-policies/solo-default.json`:

```json
{
  "budget": {
    "maxCostPerRun": 1,
    "maxWorkerRetries": 8,
    "maxCallsPerRun": 20
  },
  "safety": {
    "requireHumanApprovalForHighRisk": true,
    "requireTestsForCodeChanges": false,
    "blockSecretExfiltration": true,
    "blockUnapprovedNetworkAccess": false
  },
  "workspace": {
    "trusted": true,
    "allowedFiles": [],
    "blockedFiles": [".env", ".env.*", "*.pem", "*.key", "secrets/**"]
  },
  "commands": {
    "allowlist": [],
    "blockNetworkByDefault": false
  }
}
```

Create `examples/team-policies/team-strict.json`:

```json
{
  "budget": {
    "maxCostPerRun": 2,
    "maxWorkerRetries": 2,
    "maxCallsPerRun": 12
  },
  "safety": {
    "requireHumanApprovalForHighRisk": true,
    "requireTestsForCodeChanges": true,
    "blockSecretExfiltration": true,
    "blockUnapprovedNetworkAccess": true
  },
  "workspace": {
    "trusted": true,
    "allowedFiles": ["src/**", "tests/**", "docs/**", "package.json"],
    "blockedFiles": [".env", ".env.*", "*.pem", "*.key", "secrets/**"]
  },
  "commands": {
    "allowlist": ["git diff --check", "node --test", "npm test"],
    "blockNetworkByDefault": true
  }
}
```

Create `examples/team-policies/high-security.json`:

```json
{
  "budget": {
    "maxCostPerRun": 0.75,
    "maxWorkerRetries": 1,
    "maxCallsPerRun": 8
  },
  "routing": {
    "finalReviewModelTier": "premium",
    "securityTasksMinTier": "premium",
    "readonlyTasksAllowLocalModels": false
  },
  "safety": {
    "requireHumanApprovalForHighRisk": true,
    "requireTestsForCodeChanges": true,
    "blockSecretExfiltration": true,
    "blockUnapprovedNetworkAccess": true
  },
  "workspace": {
    "trusted": false,
    "allowedFiles": ["src/**", "tests/**"],
    "blockedFiles": [".env", ".env.*", "*.pem", "*.key", "secrets/**", "config/production/**"]
  },
  "commands": {
    "allowlist": ["git diff --check", "node --test"],
    "blockNetworkByDefault": true
  },
  "secrets": {
    "redactionText": "[REDACTED]",
    "patterns": ["api[_-]?key", "token", "secret", "password", "credential", "private[_-]?key"]
  }
}
```

- [ ] **Step 4: Add docs**

Create `docs/policy.md` with sections:

```md
# Policy

AI Coding Runtime Phase 10 policy controls budget, risk approval, workspace access, command execution, secret redaction, and audit export.

## Policy schema

Policy lives at the top level of `runtime.config.json` under `policy`. Existing `routing.budgetPolicy` remains supported, but `policy.budget` is the Phase 10 source of truth when present.

## Budget and risk

`policy.budget.maxCostPerRun`, `maxCallsPerRun`, and `maxWorkerRetries` are enforced before persisted execution. `policy.safety.requireHumanApprovalForHighRisk` keeps high-risk tasks behind explicit approval.

## Workspace files

Task contracts still define task-local file scope. Team policy can further restrict that scope with `workspace.allowedFiles` and `workspace.blockedFiles`.

## Commands

Verification commands are allowed by default for compatibility. When `commands.allowlist` is configured, every verification command must match an allowlist entry.

## Secret redaction

Prompts, model traces, worker attempts, reports, and audit exports are recursively redacted with the configured secret patterns.

## Audit export

Use `ai-coding-runtime audit <run-id> --json`, `runtime_audit`, or `GET /api/runs/:runId/audit` to export completed run evidence.

## Team examples

See `examples/team-policies/solo-default.json`, `team-strict.json`, and `high-security.json`.
```

Update `README.md` with this Phase 10 paragraph near the V0 capability list:

```md
Phase 10 adds a top-level `policy` config for team safety controls: budget limits, risk-based approval, secret redaction, workspace file policy, verification command allowlists, and completed-run audit export. Reports and audit exports are redacted by default.
```

Update `docs/integrations.md` with this integration note:

```md
Phase 10 policy metadata appears in plan, run, report, and audit responses. Host tools should surface `policyStatus.violations`, keep approval gates visible for high-risk work, and use `runtime_audit` or `GET /api/runs/:runId/audit` when a completed run needs redacted evidence for team review.
```

- [ ] **Step 5: Run targeted tests**

Run: `node --test tests/phase10-policy-safety-team.test.js tests/phase8-integrations.test.js`

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add examples/team-policies docs/policy.md README.md docs/integrations.md tests/phase10-policy-safety-team.test.js
git commit -m "docs: add phase 10 policy guidance"
```

---

### Task 9: Roadmap Checklist And Full Regression

**Files:**
- Modify: `total.md`
- Modify: `tests/phase10-policy-safety-team.test.js`

- [ ] **Step 1: Write failing roadmap checklist test**

Append:

```js
function sectionBetween(content, start, end) {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end, startIndex + start.length);
  return content.slice(startIndex, endIndex === -1 ? content.length : endIndex);
}

test("Phase 10 roadmap checklist is complete without marking Phase 11 complete", async () => {
  const roadmap = await readFile("total.md", "utf8");
  const phase10 = sectionBetween(roadmap, "## Phase 10:", "## Phase 11:");
  const phase11 = sectionBetween(roadmap, "## Phase 11:", "## Phase 12:");

  assert.doesNotMatch(phase10, /- \[ \] /);
  assert.match(phase10, /- \[x\] Add policy schema\./);
  assert.match(phase10, /- \[x\] Add audit export for completed runs\./);
  assert.match(phase11, /- \[ \] /);
  assert.doesNotMatch(phase11, /- \[x\] /);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/phase10-policy-safety-team.test.js`

Expected: fail because Phase 10 checkboxes are still unchecked.

- [ ] **Step 3: Check only Phase 10 boxes in total.md**

Change these lines in `total.md` and no Phase 11 lines:

```md
- [x] Add policy schema.
- [x] Add policy validation.
- [x] Add budget enforcement.
- [x] Add risk-based human approval.
- [x] Add secret redaction in traces and prompts.
- [x] Add file and command allowlists.
- [x] Add team policy examples.
- [x] Add audit export for completed runs.
```

- [ ] **Step 4: Run full regression**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add total.md tests/phase10-policy-safety-team.test.js
git commit -m "test: mark phase 10 roadmap complete"
```

---

### Task 10: AI Review Loop And Final Verification

**Files:**
- Create or modify: `.ai-review/review-context/current-request.md`
- Modify code only if review finds blocking issues.

- [ ] **Step 1: Create review context**

Write `.ai-review/review-context/current-request.md`:

```md
# Current Request

Implement the full Phase 10 checklist from total.md: policy schema, policy validation, budget enforcement, risk-based human approval, secret redaction in traces and prompts, file and command allowlists, team policy examples, and audit export for completed runs.

## Scope

- New policy engine in src/runtime/policy.js.
- Integration with config, planner, store, workspace, worker, verification, tools, report, CLI, HTTP, and MCP tool surfaces.
- Documentation and examples for team policy.
- Tests proving Phase 10 completion while Phase 11 remains incomplete.

## Verification

- npm test

## Non-goals

- Do not implement Phase 11 learning and optimization.
- Do not add arbitrary process sandboxing beyond configured command/file policy checks.
```

- [ ] **Step 2: Run required verification**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 3: Run the AI code review loop**

Use the `code-review-loop` skill as required by `AGENTS.md`. The review must include the current request file and the verification output.

Expected: no blocking `P0` or `P1` findings remain. If the review setup fails, report the setup failure clearly.

- [ ] **Step 4: Fix blocking review findings**

For each valid `P0` or `P1`, write or update a focused failing test, implement the fix, and rerun:

```bash
npm test
```

Expected: all tests pass after fixes.

- [ ] **Step 5: Final status check**

Run:

```bash
git status --short
git log --oneline -n 8
```

Expected: only intentional Phase 10 files are changed or committed; recent commits show the Phase 10 progression.
