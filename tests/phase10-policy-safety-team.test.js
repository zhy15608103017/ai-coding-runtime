import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyCommandPolicy,
  callRuntimeTool,
  createReport,
  createRuntimePlan,
  DEFAULT_POLICY_CONFIG,
  evaluateCommandPolicy,
  evaluateFilePolicy,
  FileExecutionStore,
  loadRuntimeConfig,
  normalizePolicyConfig,
  redactSecrets,
  validatePolicyConfig,
} from "../src/index.js";

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

test("loadRuntimeConfig normalizes top-level Phase 10 policy", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-policy-config-"));

  try {
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
    assert.equal(config.routing.budgetPolicy.maxCostPerRun, 0.25);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("loadRuntimeConfig reports invalid Phase 10 policy config", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-policy-invalid-"));

  try {
    await writeFile(
      path.join(workspace, "runtime.config.json"),
      JSON.stringify({ policy: { commands: { allowlist: "npm test" } } }),
      "utf8"
    );

    const config = await loadRuntimeConfig({ cwd: workspace, env: {} });

    assert.equal(config.policyValidation.valid, false);
    assert.ok(
      config.policyValidation.errors.some((error) => error.code === "policy.commands.allowlist.invalid")
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("createRuntimePlan applies Phase 10 budget policy before persistence", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-policy-budget-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const plan = createRuntimePlan({
      request: "implement a feature with policy budget",
      policy: normalizePolicyConfig({
        budget: { maxCostPerRun: 0.01, maxCallsPerRun: 1, maxWorkerRetries: 0 },
      }),
    });

    assert.equal(plan.budgetStatus.allowed, false);
    assert.equal(plan.policyStatus.allowed, false);
    assert.ok(
      plan.policyStatus.violations.some((violation) => violation.code === "policy.budget.cost.exceeded")
    );
    await assert.rejects(store.createRecord(plan), /budget.policy.violation|policy.status.violation/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Phase 10 file and command policies enforce allowlists and blocklists", () => {
  const policy = normalizePolicyConfig({
    workspace: {
      allowedFiles: ["src/**", "tests/**"],
      blockedFiles: [".env", "secrets/**"],
    },
    commands: {
      allowlist: ["node --test"],
      blockNetworkByDefault: true,
    },
  });

  assert.equal(evaluateFilePolicy({ filePath: "src/runtime/policy.js", policy }).allowed, true);
  assert.equal(evaluateFilePolicy({ filePath: ".env", policy }).allowed, false);
  assert.equal(evaluateFilePolicy({ filePath: "README.md", policy }).allowed, false);

  assert.equal(evaluateCommandPolicy({ command: { command: "node", args: ["--test"] }, policy }).allowed, true);
  assert.equal(evaluateCommandPolicy({ command: { command: "npm", args: ["test"] }, policy }).allowed, false);
  assert.equal(evaluateCommandPolicy({ command: { command: "curl", args: ["https://example.test"] }, policy }).allowed, false);

  const commands = applyCommandPolicy(
    [
      { name: "tests", command: "node", args: ["--test"] },
      { name: "blocked", command: "npm", args: ["test"] },
    ],
    policy
  );
  assert.equal(commands[0].policyBlocked, undefined);
  assert.equal(commands[1].policyBlocked, true);
});

test("Phase 10 redaction removes secret values recursively", () => {
  const redacted = redactSecrets(
    {
      prompt: "OPENAI_API_KEY=sk-secret-value\nnormal text",
      nested: {
        token: "token-secret-abc123",
        url: "https://example.test/path?token=leak",
      },
      list: ["password: hunter2", "safe"],
    },
    normalizePolicyConfig()
  );
  const serialized = JSON.stringify(redacted);

  assert.equal(redacted.nested.token, "[REDACTED]");
  assert.match(serialized, /\[REDACTED\]/);
  assert.doesNotMatch(serialized, /sk-secret-value/);
  assert.doesNotMatch(serialized, /token=leak/);
  assert.doesNotMatch(serialized, /hunter2/);
  assert.match(serialized, /normal text/);
});

test("completed runs produce redacted Phase 10 audit exports", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-policy-audit-"));
  const store = new FileExecutionStore({ workspace });
  const runtimeOptions = {
    policy: normalizePolicyConfig(),
    verification: { diff_check: { enabled: false } },
  };

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "plan only audit SECRET=leak" },
      { store, runtimeOptions }
    );
    await callRuntimeTool("runtime_verify", { runId: run.runId }, { store, runtimeOptions });

    const audit = await callRuntimeTool("runtime_audit", { runId: run.runId }, { store, runtimeOptions });

    assert.equal(audit.schema, "ai-coding-runtime.audit");
    assert.equal(audit.version, 1);
    assert.equal(audit.run.runId, run.runId);
    assert.equal(typeof audit.integrity.sha256, "string");
    assert.equal(audit.integrity.eventCount > 0, true);
    assert.doesNotMatch(JSON.stringify(audit), /SECRET=leak/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Phase 10 reports are redacted by default", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-policy-report-"));
  const store = new FileExecutionStore({ workspace });
  const runtimeOptions = {
    policy: normalizePolicyConfig(),
    verification: { diff_check: { enabled: false } },
  };

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "plan only report TOKEN=leak" },
      { store, runtimeOptions }
    );
    await store.recordModelCall(run.runId, {
      provider: "local",
      model: "local-placeholder",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costEstimate: { currency: "USD", estimatedCost: 0, estimated_cost: 0 },
      request: { prompt: "TOKEN=leak" },
    });
    const record = await store.readRecord(run.runId);
    const report = createReport(record, { policy: runtimeOptions.policy });

    assert.doesNotMatch(JSON.stringify(report), /TOKEN=leak/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

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

test("Phase 10 roadmap checklist is complete without marking Phase 11 complete", async () => {
  const roadmap = await readFile("total.md", "utf8");
  const phase10 = sectionBetween(roadmap, "## Phase 10:", "## Phase 11:");
  const phase11 = sectionBetween(roadmap, "## Phase 11:", "## Phase 12:");

  assert.doesNotMatch(phase10, /- \[ \] /);
  assert.match(phase10, /- \[x\] Add policy schema\./);
  assert.match(phase10, /- \[x\] Add audit export for completed runs\./);
  assertSectionUnchecked(phase11, "Phase 11");
});

function sectionBetween(content, startMarker, endMarker) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start + startMarker.length);

  assert.notEqual(start, -1, `${startMarker} not found`);
  assert.notEqual(end, -1, `${endMarker} not found`);
  return content.slice(start, end);
}

function assertSectionUnchecked(section, label) {
  const tasks = [...section.matchAll(/- \[(x| )\] /g)];
  assert.ok(tasks.length > 0, `${label} should contain checklist tasks`);

  for (const task of tasks) {
    assert.equal(task[1], " ", `${label} should not be marked complete yet`);
  }
}
