import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import * as runtimeIndex from "../src/index.js";
import {
  callRuntimeTool,
  classifyTask,
  createRuntimePlan,
  DEFAULT_MODEL_REGISTRY,
  evaluateBudgetPolicy,
  evaluateEscalation,
  FileExecutionStore,
  loadRuntimeConfig,
  routeTask,
  validateRuntimePlan,
} from "../src/index.js";

function supervisorPlannerTaskDrafts() {
  return [
    {
      task_id: "SP-001",
      title: "Map provider health scope",
      goal: "Identify the files and behavior needed for the requested provider health change.",
      difficulty: "L0",
      risk: "low",
      context_need: "low",
      verification: "easy",
      final_verification: false,
      depends_on: [],
      allowed_files: [],
      forbidden_actions: ["modify files"],
      acceptance: ["provider health scope is identified"],
      expected_output: ["scope notes"],
    },
    {
      task_id: "SP-002",
      title: "Implement provider health change",
      goal: "Apply the provider health behavior change inside the approved files.",
      difficulty: "L2",
      risk: "medium",
      context_need: "medium",
      verification: "medium",
      final_verification: false,
      depends_on: ["SP-001"],
      allowed_files: ["src/runtime/providers.js", "tests/providers.test.js"],
      forbidden_actions: ["edit files outside the provider health allowlist"],
      acceptance: ["provider health change is implemented inside the allowlist"],
      expected_output: ["patch", "test notes"],
    },
    {
      task_id: "SP-003",
      title: "Final supervisor review",
      goal: "Review the final provider health change and verification evidence.",
      difficulty: "L4",
      risk: "high",
      context_need: "high",
      verification: "hard",
      final_verification: true,
      depends_on: ["SP-002"],
      allowed_files: [],
      forbidden_actions: ["skip final review"],
      acceptance: ["final review records routing and verification evidence"],
      expected_output: ["final report"],
    },
  ];
}

test("classifyTask returns Phase 4 classifier fields", () => {
  const classification = classifyTask({
    difficulty: "L2",
    risk: "medium",
    contextNeed: "medium",
    verification: "medium",
    allowedFiles: ["src/runtime/planner.js"],
  });

  assert.equal(classification.difficulty, "L2");
  assert.equal(classification.risk, "medium");
  assert.equal(classification.context_need, "medium");
  assert.equal(classification.verification, "medium");
  assert.equal(classification.edits_files, true);
  assert.equal(typeof classification.confidence, "number");
  assert.ok(classification.confidence > 0);
  assert.ok(classification.confidence <= 1);
  assert.ok(Array.isArray(classification.reasoning));
  assert.ok(classification.reasoning.length > 0);
});

test("default model registry exposes Phase 4 capability fields", () => {
  assert.deepEqual(
    DEFAULT_MODEL_REGISTRY.map((entry) => entry.tier),
    ["cheap", "standard", "premium"]
  );

  for (const entry of DEFAULT_MODEL_REGISTRY) {
    assert.equal(typeof entry.provider, "string");
    assert.equal(typeof entry.model, "string");
    assert.equal(typeof entry.cost_hint, "object");
    assert.equal(typeof entry.context_window, "number");
    assert.ok(Array.isArray(entry.tool_support));
    assert.ok(Array.isArray(entry.strengths));
    assert.ok(Array.isArray(entry.blocked_task_types));
  }
});

test("routeTask explains file-editing and final verification routing", () => {
  const fileEditingRoute = routeTask({
    difficulty: "L1",
    risk: "low",
    contextNeed: "low",
    verification: "easy",
    allowedFiles: ["src/runtime/router.js"],
  });

  assert.equal(fileEditingRoute.modelTier, "standard");
  assert.equal(fileEditingRoute.model_tier, "standard");
  assert.equal(fileEditingRoute.classification.edits_files, true);
  assert.match(fileEditingRoute.routingReason.join(" "), /file-editing/i);
  assert.equal(fileEditingRoute.selectedModel.tier, "standard");

  const finalVerificationRoute = routeTask({
    difficulty: "L1",
    risk: "low",
    contextNeed: "low",
    verification: "easy",
    finalVerification: true,
  });

  assert.equal(finalVerificationRoute.modelTier, "premium");
  assert.match(finalVerificationRoute.routingReason.join(" "), /final verification/i);
  assert.ok(finalVerificationRoute.escalationTriggers.includes("final_review"));
});

test("routeTask does not allow policy overrides to lower safety tiers", () => {
  const fileEditingRoute = routeTask(
    {
      difficulty: "L1",
      risk: "low",
      verification: "easy",
      allowedFiles: ["src/runtime/router.js"],
    },
    {
      routingPolicy: {
        fileEditingMinTier: "cheap",
      },
    }
  );

  assert.equal(fileEditingRoute.modelTier, "standard");

  const finalVerificationRoute = routeTask(
    {
      difficulty: "L1",
      risk: "low",
      verification: "easy",
      finalVerification: true,
    },
    {
      routingPolicy: {
        finalVerificationTier: "cheap",
      },
    }
  );

  assert.equal(finalVerificationRoute.modelTier, "premium");
});

test("evaluateBudgetPolicy refuses routes that exceed cost, call, or retry limits", () => {
  const routes = [
    routeTask({ difficulty: "L2", risk: "medium", verification: "medium" }),
    routeTask({ difficulty: "L4", risk: "high", verification: "hard", finalVerification: true }),
  ];

  const budgetStatus = evaluateBudgetPolicy({
    routes,
    budgetPolicy: {
      maxCostPerRun: 0.01,
      maxCallsPerRun: 1,
      maxRetryCount: 0,
    },
  });

  assert.equal(budgetStatus.allowed, false);
  assert.ok(budgetStatus.estimatedCost > 0.01);
  assert.equal(budgetStatus.estimatedCalls, 2);
  assert.ok(budgetStatus.violations.some((violation) => violation.code === "budget.cost.exceeded"));
  assert.ok(budgetStatus.violations.some((violation) => violation.code === "budget.calls.exceeded"));
  assert.ok(budgetStatus.violations.some((violation) => violation.code === "budget.retries.exceeded"));
});

test("evaluateEscalation records stronger-tier trace decisions", () => {
  const route = routeTask({
    id: "T-001",
    difficulty: "L1",
    risk: "low",
    verification: "easy",
  });

  const failedAttempt = evaluateEscalation({
    task: { id: "T-001", difficulty: "L1", risk: "low" },
    route,
    outcome: {
      failedTests: true,
      malformedOutput: true,
    },
  });

  assert.equal(failedAttempt.shouldEscalate, true);
  assert.equal(failedAttempt.fromTier, "cheap");
  assert.equal(failedAttempt.toTier, "standard");
  assert.ok(failedAttempt.reasons.includes("failed_tests"));
  assert.ok(failedAttempt.reasons.includes("malformed_output"));
  assert.equal(failedAttempt.trace.task_id, "T-001");
  assert.equal(failedAttempt.trace.from_tier, "cheap");
  assert.equal(failedAttempt.trace.to_tier, "standard");

  const policyViolation = evaluateEscalation({
    task: { id: "T-004", difficulty: "L4", risk: "high" },
    route: routeTask({ difficulty: "L4", risk: "high", verification: "hard" }),
    outcome: {
      userPolicyViolation: true,
    },
  });

  assert.equal(policyViolation.toTier, "premium");
  assert.equal(policyViolation.requiresHumanApproval, true);
  assert.ok(policyViolation.reasons.includes("user_policy_violation"));

  const accessViolation = evaluateEscalation({
    task: { id: "T-005", difficulty: "L1", risk: "low" },
    route,
    outcome: {
      forbiddenFileAccess: true,
      lowClassifierConfidence: true,
    },
  });

  assert.ok(accessViolation.reasons.includes("forbidden_file_access"));
  assert.ok(accessViolation.reasons.includes("low_classifier_confidence"));
  assert.equal(accessViolation.requiresHumanApproval, true);
});

test("createRuntimePlan returns task contracts with model routing", () => {
  const plan = createRuntimePlan({
    request: "为登录模块增加限流逻辑，并补充测试和最终验证",
  });

  assert.match(plan.planId, /^plan_/);
  assert.equal(plan.schemaVersion, "runtime.plan.v1");
  assert.equal(plan.modelTiers.length, 3);
  assert.ok(plan.tasks.length >= 5);
  assert.equal(plan.taskGraph.run_id, null);
  assert.equal(plan.taskGraph.tasks.length, plan.tasks.length);
  assert.equal(plan.taskGraph.approval_required, true);
  assert.equal(plan.approval.status, "required");
  assert.equal(plan.validation.valid, true);
  assert.match(plan.planReport.summary, /task/);
  assert.equal(plan.planReport.risk_summary, plan.risk_summary);
  assert.deepEqual(plan.planReport.task_graph, plan.task_graph);
  assert.deepEqual(plan.planReport.estimated_cost, plan.estimated_cost);
  assert.match(plan.planningPrompt, /Task Contract/);
  assert.match(plan.planningPrompt, /depends_on/);
  assert.equal(plan.planning_prompt, plan.planningPrompt);
  assert.deepEqual(plan.modelTierAliases, {
    cheap: "cheap",
    standard: "standard",
    premium: "premium",
  });
  assert.equal(plan.modelRegistry.length, 3);
  assert.equal(plan.routingPolicy.finalVerificationTier, "premium");
  assert.equal(plan.budgetPolicy.maxCallsPerRun, 20);
  assert.equal(plan.escalationPolicy.triggers.includes("failed_tests"), true);
  assert.equal(plan.budgetStatus.allowed, true);
  assert.equal(plan.routingTrace.length, plan.tasks.length);

  const ids = new Set(plan.tasks.map((task) => task.id));
  assert.equal(ids.size, plan.tasks.length);
  assert.equal(plan.tasks[0].difficulty, "L0");
  assert.equal(plan.tasks[0].modelTier, "cheap");
  assert.deepEqual(plan.tasks[0].allowed_files, plan.tasks[0].allowedFiles);
  assert.deepEqual(plan.tasks[0].forbidden_actions, plan.tasks[0].forbiddenActions);
  assert.deepEqual(plan.tasks[0].expected_output, plan.tasks[0].expectedOutput);
  assert.equal(plan.tasks[0].model_tier, plan.tasks[0].modelTier);
  assert.deepEqual(plan.tasks[0].depends_on, plan.tasks[0].dependsOn);
  assert.equal(plan.tasks[0].title, "读取项目结构与需求上下文");
  assert.equal(plan.tasks[0].context_need, plan.tasks[0].contextNeed);
  assert.equal(plan.tasks[0].verification, "easy");
  assert.equal(plan.tasks[0].classification.difficulty, "L0");
  assert.equal(plan.tasks[0].routing.model_tier, "cheap");
  assert.match(plan.tasks[0].routing.reason, /L0/);

  const implementationTask = plan.tasks.find((task) =>
    task.title.includes("实现")
  );
  assert.ok(implementationTask);
  assert.equal(implementationTask.modelTier, "standard");
  assert.equal(implementationTask.classification.edits_files, true);
  assert.equal(implementationTask.routing.selected_model.tier, "standard");
  assert.ok(implementationTask.acceptance.length > 0);

  const finalTask = plan.tasks.at(-1);
  assert.equal(finalTask.title, "最终审查与交付报告");
  assert.equal(finalTask.modelTier, "premium");
  assert.equal(finalTask.finalVerification, true);
  assert.equal(finalTask.final_verification, true);
  assert.equal(plan.taskGraph.tasks.at(-1).final_verification, true);
  assert.equal(plan.tasks[0].final_verification, false);
  assert.equal(finalTask.routing.selected_model.tier, "premium");
  assert.ok(finalTask.routing.escalation_triggers.includes("final_review"));
  assert.deepEqual(finalTask.dependsOn, [plan.tasks.at(-2).id]);
});

test("createRuntimePlan routes explicit task drafts through the existing plan contract", () => {
  const plan = createRuntimePlan({
    request: "Implement a focused provider health check improvement.",
    taskDrafts: [
      {
        id: "T-101",
        title: "Inspect provider health behavior",
        goal: "Read provider health code before changing behavior.",
        difficulty: "L0",
        risk: "low",
        contextNeed: "low",
        verification: "easy",
        dependsOn: [],
        allowedFiles: [],
        forbiddenActions: ["modify files"],
        acceptance: ["provider health behavior is summarized"],
        expectedOutput: ["summary"],
      },
      {
        id: "T-102",
        title: "Implement provider health improvement",
        goal: "Apply the requested provider health change.",
        difficulty: "L2",
        risk: "medium",
        contextNeed: "medium",
        verification: "medium",
        dependsOn: ["T-101"],
        allowedFiles: ["src/runtime/providers.js", "tests/providers.test.js"],
        forbiddenActions: ["edit files outside the provider health scope"],
        acceptance: ["provider health change is implemented inside the allowlist"],
        expectedOutput: ["patch", "test evidence"],
      },
      {
        id: "T-103",
        title: "Final supervisor review",
        goal: "Review the focused provider health change and verification evidence.",
        difficulty: "L4",
        risk: "high",
        contextNeed: "high",
        verification: "hard",
        finalVerification: true,
        dependsOn: ["T-102"],
        allowedFiles: [],
        forbiddenActions: ["skip final verification"],
        acceptance: ["final review records routing and verification evidence"],
        expectedOutput: ["final report"],
      },
    ],
  });

  assert.equal(plan.validation.valid, true);
  assert.deepEqual(
    plan.tasks.map((task) => task.task_id),
    ["T-101", "T-102", "T-103"]
  );
  assert.equal(plan.tasks[1].model_tier, "standard");
  assert.equal(plan.tasks[2].model_tier, "premium");
  assert.equal(plan.tasks[2].final_verification, true);
  assert.deepEqual(plan.dependencies, [
    { from: "T-101", to: "T-102" },
    { from: "T-102", to: "T-103" },
  ]);
});

test("createRuntimePlanWithSupervisor uses model-generated task drafts when enabled", async () => {
  let providerRequest;
  const plan = await runtimeIndex.createRuntimePlanWithSupervisor({
    request: "Implement a focused provider health check improvement.",
    planning: {
      supervisor: {
        enabled: true,
        provider: "openai-compatible",
        model: "premium-planner",
      },
    },
    generate: async (request) => {
      providerRequest = request;
      return {
        provider: request.provider,
        model: request.model,
        structuredOutput: {
          tasks: supervisorPlannerTaskDrafts(),
        },
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        costEstimate: { currency: "USD", estimatedCost: 0.01, estimated_cost: 0.01 },
        finishReason: "stop",
        request: { attempts: 1, durationMs: 5, duration_ms: 5 },
      };
    },
  });

  assert.equal(providerRequest.provider, "openai-compatible");
  assert.equal(providerRequest.model, "premium-planner");
  assert.match(providerRequest.messages.at(-1).content, /Task Contract/);
  assert.equal(plan.validation.valid, true);
  assert.equal(plan.supervisorPlanning.status, "used");
  assert.equal(plan.supervisor_planning.status, "used");
  assert.equal(plan.supervisorPlanning.taskCount, 3);
  assert.deepEqual(
    plan.tasks.map((task) => task.task_id),
    ["SP-001", "SP-002", "SP-003"]
  );
  assert.equal(plan.tasks[1].model_tier, "standard");
  assert.equal(plan.tasks[2].model_tier, "premium");
});

test("createRuntimePlanWithSupervisor falls back to deterministic planning after malformed output", async () => {
  const plan = await runtimeIndex.createRuntimePlanWithSupervisor({
    request: "Implement a focused provider health check improvement.",
    planning: {
      supervisor: {
        enabled: true,
        provider: "openai-compatible",
        model: "premium-planner",
      },
    },
    generate: async () => ({
      provider: "openai-compatible",
      model: "premium-planner",
      text: "not-json",
      structuredOutput: null,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costEstimate: { currency: "USD", estimatedCost: 0, estimated_cost: 0 },
      finishReason: "stop",
      request: { attempts: 1, durationMs: 1, duration_ms: 1 },
    }),
  });

  assert.equal(plan.validation.valid, true);
  assert.equal(plan.supervisorPlanning.status, "fallback");
  assert.match(plan.supervisorPlanning.reason, /tasks/i);
  assert.deepEqual(
    plan.tasks.map((task) => task.task_id).slice(0, 2),
    ["T-001", "T-002"]
  );
});

test("supervisor fallback metadata redacts provider error secrets", async () => {
  const secret = "sk-test-secret-123";
  const policy = {
    secrets: {
      patterns: ["apiKey"],
    },
  };
  const runtimeOptions = {
    policy,
    planning: {
      supervisor: {
        enabled: true,
        provider: "openai-compatible",
        model: "premium-planner",
      },
    },
    execution: {
      generate: async () => {
        throw new Error(`Provider failed with apiKey=${secret}`);
      },
    },
  };

  const planned = await callRuntimeTool(
    "runtime_plan",
    { request: "Implement a focused provider health check improvement." },
    { runtimeOptions }
  );

  assert.equal(planned.validation.valid, true);
  assert.equal(planned.supervisorPlanning.status, "fallback");
  assert.equal(planned.supervisorPlanning.reason.includes(secret), false);
  assert.equal(planned.planReport.supervisor_planning.reason.includes(secret), false);

  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-supervisor-redact-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "Implement a focused provider health check improvement." },
      { store, runtimeOptions }
    );

    assert.equal(run.plan.supervisorPlanning.reason.includes(secret), false);
    assert.equal(run.plan.planReport.supervisor_planning.reason.includes(secret), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("createRuntimePlanWithSupervisor falls back when provider or model is missing", async () => {
  const plan = await runtimeIndex.createRuntimePlanWithSupervisor({
    request: "Implement a focused provider health check improvement.",
    planning: {
      supervisor: {
        enabled: true,
      },
    },
  });

  assert.equal(plan.validation.valid, true);
  assert.equal(plan.supervisorPlanning.status, "fallback");
  assert.match(plan.supervisorPlanning.reason, /provider and model/i);
  assert.deepEqual(
    plan.tasks.map((task) => task.task_id).slice(0, 2),
    ["T-001", "T-002"]
  );
});

test("createRuntimePlanWithSupervisor does not use default providers for missing supervisor model", async () => {
  const plan = await runtimeIndex.createRuntimePlanWithSupervisor({
    request: "Implement a focused provider health check improvement.",
    planning: {
      supervisor: {
        enabled: true,
      },
    },
    providers: {
      defaultProvider: "openai-compatible",
      entries: {
        "openai-compatible": {
          type: "openai-compatible",
          defaultModel: "default-model-that-must-not-run",
        },
      },
    },
    generate: async () => {
      throw new Error("generate should not be called without explicit supervisor provider/model");
    },
  });

  assert.equal(plan.validation.valid, true);
  assert.equal(plan.supervisorPlanning.status, "fallback");
  assert.match(plan.supervisorPlanning.reason, /provider and model/i);
});

test("createRuntimePlanWithSupervisor falls back when supervisor drafts fail local validation", async () => {
  const plan = await runtimeIndex.createRuntimePlanWithSupervisor({
    request: "Implement a focused provider health check improvement.",
    planning: {
      supervisor: {
        enabled: true,
        provider: "openai-compatible",
        model: "premium-planner",
      },
    },
    generate: async () => ({
      provider: "openai-compatible",
      model: "premium-planner",
      structuredOutput: {
        tasks: [
          {
            ...supervisorPlannerTaskDrafts()[0],
            task_id: "SP-DUP",
          },
          {
            ...supervisorPlannerTaskDrafts()[1],
            task_id: "SP-DUP",
            depends_on: ["SP-DUP"],
          },
        ],
      },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costEstimate: { currency: "USD", estimatedCost: 0.001, estimated_cost: 0.001 },
      finishReason: "stop",
      request: { attempts: 1, durationMs: 1, duration_ms: 1 },
    }),
  });

  assert.equal(plan.validation.valid, true);
  assert.equal(plan.supervisorPlanning.status, "fallback");
  assert.match(plan.supervisorPlanning.reason, /invalid task contracts/i);
  assert.deepEqual(
    plan.tasks.map((task) => task.task_id).slice(0, 2),
    ["T-001", "T-002"]
  );
});

test("createRuntimePlanWithSupervisor falls back when supervisor drafts miss required fields", async () => {
  const plan = await runtimeIndex.createRuntimePlanWithSupervisor({
    request: "Implement a focused provider health check improvement.",
    planning: {
      supervisor: {
        enabled: true,
        provider: "openai-compatible",
        model: "premium-planner",
      },
    },
    generate: async () => ({
      provider: "openai-compatible",
      model: "premium-planner",
      structuredOutput: {
        tasks: [
          {
            title: "Incomplete supervisor task",
          },
        ],
      },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costEstimate: { currency: "USD", estimatedCost: 0.001, estimated_cost: 0.001 },
      finishReason: "stop",
      request: { attempts: 1, durationMs: 1, duration_ms: 1 },
    }),
  });

  assert.equal(plan.validation.valid, true);
  assert.equal(plan.supervisorPlanning.status, "fallback");
  assert.match(plan.supervisorPlanning.reason, /task_id/i);
  assert.deepEqual(
    plan.tasks.map((task) => task.task_id).slice(0, 2),
    ["T-001", "T-002"]
  );
});

test("createRuntimePlanWithSupervisor falls back when supervisor drafts use invalid enums", async () => {
  const plan = await runtimeIndex.createRuntimePlanWithSupervisor({
    request: "Implement a focused provider health check improvement.",
    planning: {
      supervisor: {
        enabled: true,
        provider: "openai-compatible",
        model: "premium-planner",
      },
    },
    generate: async () => ({
      provider: "openai-compatible",
      model: "premium-planner",
      structuredOutput: {
        tasks: [
          {
            ...supervisorPlannerTaskDrafts()[0],
            difficulty: "tiny",
          },
        ],
      },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costEstimate: { currency: "USD", estimatedCost: 0.001, estimated_cost: 0.001 },
      finishReason: "stop",
      request: { attempts: 1, durationMs: 1, duration_ms: 1 },
    }),
  });

  assert.equal(plan.validation.valid, true);
  assert.equal(plan.supervisorPlanning.status, "fallback");
  assert.match(plan.supervisorPlanning.reason, /difficulty/i);
  assert.deepEqual(
    plan.tasks.map((task) => task.task_id).slice(0, 2),
    ["T-001", "T-002"]
  );
});

test("runtime_plan uses supervisor planning when explicitly enabled", async () => {
  const planned = await callRuntimeTool(
    "runtime_plan",
    { request: "Implement a focused provider health check improvement." },
    {
      runtimeOptions: {
        planning: {
          supervisor: {
            enabled: true,
            provider: "openai-compatible",
            model: "premium-planner",
          },
        },
        execution: {
          generate: async () => ({
            provider: "openai-compatible",
            model: "premium-planner",
            structuredOutput: {
              tasks: supervisorPlannerTaskDrafts(),
            },
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            costEstimate: { currency: "USD", estimatedCost: 0.001, estimated_cost: 0.001 },
            finishReason: "stop",
            request: { attempts: 1, durationMs: 1, duration_ms: 1 },
          }),
        },
      },
    }
  );

  assert.equal(planned.supervisorPlanning.status, "used");
  assert.deepEqual(
    planned.tasks.map((task) => task.task_id),
    ["SP-001", "SP-002", "SP-003"]
  );
});

test("runtime_estimate preserves supervisor planning metadata", async () => {
  const estimate = await callRuntimeTool(
    "runtime_estimate",
    { request: "Implement a focused provider health check improvement." },
    {
      runtimeOptions: {
        planning: {
          supervisor: {
            enabled: true,
            provider: "openai-compatible",
            model: "premium-planner",
          },
        },
        execution: {
          generate: async () => ({
            provider: "openai-compatible",
            model: "premium-planner",
            structuredOutput: {
              tasks: supervisorPlannerTaskDrafts(),
            },
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            costEstimate: { currency: "USD", estimatedCost: 0.001, estimated_cost: 0.001 },
            finishReason: "stop",
            request: { attempts: 1, durationMs: 1, duration_ms: 1 },
          }),
        },
      },
    }
  );

  assert.equal(estimate.supervisorPlanning.status, "used");
  assert.equal(estimate.supervisor_planning.status, "used");
});

test("createRuntimePlan supports low-risk read-only planning without approval", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-low-risk-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const plan = createRuntimePlan({
      request: "plan only: summarize the repository without modifying files",
    });

    assert.equal(plan.approval.required, false);
    assert.equal(plan.approval.status, "not_required");
    assert.equal(plan.approvalRequired, false);
    assert.equal(plan.taskGraph.approval_required, false);
    assert.equal(plan.validation.valid, true);
    assert.ok(plan.tasks.length >= 3);
    assert.ok(plan.tasks.every((task) => task.risk === "low"));
    assert.ok(plan.tasks.every((task) => task.allowed_files.length === 0));

    const record = await store.createRecord(plan);
    assert.equal(record.status, "planned");
    assert.ok(!record.events.some((event) => event.type === "approval.required"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("createRuntimePlan keeps implementation requests with behavior constraints approval-gated", () => {
  const plan = createRuntimePlan({
    request: "Implement login rate limiting with no changes to the public API",
  });

  assert.equal(plan.approval.required, true);
  assert.equal(plan.approval.status, "required");
  assert.equal(plan.taskGraph.approval_required, true);
  assert.ok(plan.tasks.some((task) => task.risk === "medium" || task.risk === "high"));
});


test("createRuntimePlan narrows doc-only task scopes to requested documentation files", () => {
  const plan = createRuntimePlan({
    request:
      "Check README.md and docs/integrations.md for runtime_execute consistency. If they differ, make the smallest wording fix. Do not modify src/ code.",
  });

  const implementationTask = plan.tasks.find((task) => task.id === "T-003");
  const verificationTask = plan.tasks.find((task) => task.id === "T-004");

  assert.ok(implementationTask);
  assert.ok(verificationTask);
  assert.deepEqual(implementationTask.allowed_files, ["README.md", "docs/integrations.md"]);
  assert.deepEqual(verificationTask.allowed_files, []);
  assert.ok(!implementationTask.allowed_files.includes("src/**"));
  assert.ok(!verificationTask.allowed_files.includes("tests/**"));
});

test("createRuntimePlan treats README-only requests as documentation-only when the workspace matches", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-planner-v2-doc-readme-"));

  try {
    await mkdir(path.join(workspace, "docs"), { recursive: true });
    await writeFile(path.join(workspace, "README.md"), "# Runtime\n", "utf8");
    await writeFile(path.join(workspace, "docs", "integrations.md"), "Local stdio MCP:\n", "utf8");

    const plan = createRuntimePlan({
      request:
        "Only modify README.md to add one short sentence clarifying that runtime_execute applies patches and runs verification by default unless --no-apply or --no-verify is used.",
      workspace: { cwd: workspace },
    });

    const implementationTask = plan.tasks.find((task) => task.id === "T-003");
    const verificationTask = plan.tasks.find((task) => task.id === "T-004");

    assert.ok(implementationTask);
    assert.ok(verificationTask);
    assert.deepEqual(plan.workspaceSummary.matchedRequestFiles, ["README.md"]);
    assert.deepEqual(implementationTask.allowed_files, ["README.md"]);
    assert.deepEqual(verificationTask.allowed_files, []);
    assert.ok(!implementationTask.allowed_files.includes("src/**"));
    assert.ok(!verificationTask.allowed_files.includes("tests/**"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("createRuntimePlan keeps implementation scope when implementation also mentions docs", () => {
  const plan = createRuntimePlan({
    request: "Implement login rate limiting and update README.md usage notes.",
  });

  const implementationTask = plan.tasks.find((task) => task.id === "T-003");
  const verificationTask = plan.tasks.find((task) => task.id === "T-004");

  assert.ok(implementationTask);
  assert.ok(verificationTask);
  assert.deepEqual(implementationTask.allowed_files, ["src/**", "tests/**"]);
  assert.deepEqual(verificationTask.allowed_files, ["tests/**", "package.json"]);
});

test("createRuntimePlan narrows tests-only task scopes and keeps config files read-only", () => {
  const plan = createRuntimePlan({
    request:
      "Add one focused test for runtime config so openai-compatible defaultModel and final_review model are read from runtime.config.json. Only modify tests/ files and keep current behavior unchanged.",
  });

  const implementationTask = plan.tasks.find((task) => task.id === "T-003");
  const verificationTask = plan.tasks.find((task) => task.id === "T-004");

  assert.ok(implementationTask);
  assert.ok(verificationTask);
  assert.deepEqual(implementationTask.allowed_files, ["tests/providers.test.js"]);
  assert.deepEqual(verificationTask.allowed_files, ["tests/providers.test.js"]);
  assert.deepEqual(implementationTask.referencedFiles, ["runtime.config.json"]);
  assert.deepEqual(verificationTask.referencedFiles, ["runtime.config.json"]);
  assert.deepEqual(implementationTask.contextSelectors, {
    "runtime.config.json": [
      "providers.entries.openai-compatible.defaultModel",
      "verification.final_review.model",
    ],
  });
  assert.deepEqual(verificationTask.contextSelectors, {
    "runtime.config.json": [
      "providers.entries.openai-compatible.defaultModel",
      "verification.final_review.model",
    ],
  });
  assert.ok(
    implementationTask.acceptance.includes(
      'focused test verifies config.providers.entries["openai-compatible"].defaultModel is read from runtime.config.json'
    )
  );
  assert.ok(
    implementationTask.acceptance.includes(
      "focused test verifies config.verification.final_review.model is read from runtime.config.json"
    )
  );
  assert.ok(
    verificationTask.acceptance.includes(
      'focused test verifies config.providers.entries["openai-compatible"].defaultModel is read from runtime.config.json'
    )
  );
  assert.ok(
    verificationTask.acceptance.includes(
      "focused test verifies config.verification.final_review.model is read from runtime.config.json"
    )
  );
  assert.ok(!implementationTask.allowed_files.includes("src/**"));
  assert.ok(!verificationTask.allowed_files.includes("tests/**"));
});

test("createRuntimePlan keeps implementation scope when a request only mentions adding tests", () => {
  const plan = createRuntimePlan({
    request:
      "Implement login rate limiting and add unit tests for the new behavior.",
  });

  const implementationTask = plan.tasks.find((task) => task.id === "T-003");
  const verificationTask = plan.tasks.find((task) => task.id === "T-004");

  assert.ok(implementationTask);
  assert.ok(verificationTask);
  assert.deepEqual(implementationTask.allowed_files, ["src/**", "tests/**"]);
  assert.deepEqual(verificationTask.allowed_files, ["tests/**", "package.json"]);
});

test("createRuntimePlan keeps implementation scope when a request asks to add a focused test", () => {
  const plan = createRuntimePlan({
    request:
      "Implement login rate limiting and add a focused test for the new behavior.",
  });

  const implementationTask = plan.tasks.find((task) => task.id === "T-003");
  const verificationTask = plan.tasks.find((task) => task.id === "T-004");

  assert.ok(implementationTask);
  assert.ok(verificationTask);
  assert.deepEqual(implementationTask.allowed_files, ["src/**", "tests/**"]);
  assert.deepEqual(verificationTask.allowed_files, ["tests/**", "package.json"]);
});

test("createRuntimePlan keeps implementation scope for Chinese requests that ask to add tests", () => {
  const plan = createRuntimePlan({
    request:
      "\u4e3a login \u6a21\u5757\u589e\u52a0 rate limit \u903b\u8f91\uff0c\u5e76\u8865\u5145\u6d4b\u8bd5\u548c\u6700\u7ec8\u9a8c\u8bc1\u3002",
  });

  const implementationTask = plan.tasks.find((task) => task.id === "T-003");
  const verificationTask = plan.tasks.find((task) => task.id === "T-004");

  assert.ok(implementationTask);
  assert.ok(verificationTask);
  assert.deepEqual(implementationTask.allowed_files, ["src/**", "tests/**"]);
  assert.deepEqual(verificationTask.allowed_files, ["tests/**", "package.json"]);
});

test("createRuntimePlan keeps tests-only scope for a new explicit test file in a workspace", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-planner-v2-new-test-"));

  try {
    await mkdir(path.join(workspace, "tests"), { recursive: true });
    await writeFile(path.join(workspace, "package.json"), "{\"scripts\":{\"test\":\"node --test\"}}\n", "utf8");

    const plan = createRuntimePlan({
      request:
        "Only modify tests/new-feature.test.js to cover the new rate limiting behavior.",
      workspace: { cwd: workspace },
    });

    const implementationTask = plan.tasks.find((task) => task.id === "T-003");
    const verificationTask = plan.tasks.find((task) => task.id === "T-004");

    assert.ok(implementationTask);
    assert.ok(verificationTask);
    assert.deepEqual(implementationTask.allowed_files, ["tests/new-feature.test.js"]);
    assert.deepEqual(verificationTask.allowed_files, ["tests/new-feature.test.js"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("createRuntimePlan keeps default implementation scope without workspace even when files are mentioned", () => {
  const plan = createRuntimePlan({
    request:
      "Improve planner behavior in src/runtime/planner.js and tests/runtime.test.js. Keep the change focused.",
  });

  const implementationTask = plan.tasks.find((task) => task.id === "T-003");
  const verificationTask = plan.tasks.find((task) => task.id === "T-004");

  assert.ok(implementationTask);
  assert.ok(verificationTask);
  assert.deepEqual(implementationTask.allowed_files, ["src/**", "tests/**"]);
  assert.deepEqual(verificationTask.allowed_files, ["tests/**", "package.json"]);
});

test("createRuntimePlan uses workspace context to narrow explicit implementation files", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-planner-v2-"));

  try {
    await mkdir(path.join(workspace, "src", "runtime"), { recursive: true });
    await mkdir(path.join(workspace, "tests"), { recursive: true });
    await writeFile(path.join(workspace, "src", "runtime", "planner.js"), "export {}\n", "utf8");
    await writeFile(path.join(workspace, "tests", "runtime.test.js"), "import test from 'node:test';\n", "utf8");
    await writeFile(path.join(workspace, "package.json"), "{\"scripts\":{\"test\":\"node --test\"}}\n", "utf8");

    const plan = createRuntimePlan({
      request:
        "Improve planner behavior in src/runtime/planner.js and tests/runtime.test.js. Keep the change focused.",
      workspace: { cwd: workspace },
    });

    const implementationTask = plan.tasks.find((task) => task.id === "T-003");
    const verificationTask = plan.tasks.find((task) => task.id === "T-004");

    assert.ok(implementationTask);
    assert.ok(verificationTask);
    assert.equal(plan.workspaceSummary.totalFiles, 3);
    assert.deepEqual(plan.workspaceSummary.matchedRequestFiles, [
      "src/runtime/planner.js",
      "tests/runtime.test.js",
    ]);
    assert.deepEqual(plan.workspace_summary, plan.workspaceSummary);
    assert.deepEqual(plan.planReport.workspace_summary, plan.workspaceSummary);
    assert.ok(plan.planningPrompt.includes("src/runtime/planner.js"));
    assert.ok(plan.planningPrompt.includes("tests/runtime.test.js"));
    assert.ok(
      plan.dependencies.some((edge) => edge.from === "T-002" && edge.to === "T-003")
    );
    assert.ok(
      plan.dependencies.some((edge) => edge.from === "T-003" && edge.to === "T-004")
    );
    assert.deepEqual(implementationTask.allowed_files, [
      "src/runtime/planner.js",
      "tests/runtime.test.js",
    ]);
    assert.deepEqual(verificationTask.allowed_files, ["tests/runtime.test.js"]);
    assert.deepEqual(implementationTask.depends_on, ["T-002"]);
    assert.deepEqual(verificationTask.depends_on, ["T-003"]);
    assert.equal(implementationTask.goal, "Apply the requested implementation inside the approved workspace scope.");
    assert.equal(implementationTask.context_need, "medium");
    assert.equal(implementationTask.verification, "medium");
    assert.ok(implementationTask.forbidden_actions.includes("edit files outside the approved allowlist"));
    assert.ok(
      implementationTask.acceptance.includes(
        "planner narrows execution scope to explicitly mentioned workspace files"
      )
    );
    assert.deepEqual(implementationTask.expected_output, [
      "patch",
      "implementation notes",
      "files touched",
    ]);
    assert.deepEqual(verificationTask.expected_output, [
      "test patch",
      "verification command",
    ]);
    assert.equal(verificationTask.goal, "Add or identify verification that proves the requested behavior.");
    assert.equal(verificationTask.context_need, "medium");
    assert.equal(verificationTask.verification, "easy");
    assert.ok(verificationTask.forbidden_actions.includes("weaken existing assertions"));
    assert.ok(verificationTask.forbidden_actions.includes("remove existing tests"));
    assert.ok(verificationTask.acceptance.includes("verification command is recorded"));
    assert.ok(
      verificationTask.acceptance.includes(
        "new behavior has test coverage when code changes are made"
      )
    );
    assert.ok(
      verificationTask.acceptance.includes(
        "planner narrows execution scope to explicitly mentioned workspace files"
      )
    );
    assert.ok(!implementationTask.allowed_files.includes("src/**"));
    assert.ok(!verificationTask.allowed_files.includes("tests/**"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("createRuntimePlan keeps default verification scope when workspace has no explicit file match", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-planner-v2-default-"));

  try {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "src", "app.js"), "export const value = 1;\n", "utf8");

    const plan = createRuntimePlan({
      request: "Implement login rate limiting with tests.",
      workspace: { cwd: workspace },
    });

    const implementationTask = plan.tasks.find((task) => task.id === "T-003");
    const verificationTask = plan.tasks.find((task) => task.id === "T-004");

    assert.ok(implementationTask);
    assert.ok(verificationTask);
    assert.deepEqual(implementationTask.allowed_files, ["src/**", "tests/**"]);
    assert.deepEqual(verificationTask.allowed_files, ["tests/**", "package.json"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("createRuntimePlan enforces workspace maxFiles inside a single large directory", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-planner-v2-maxfiles-"));

  try {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        writeFile(path.join(workspace, "src", `file-${index}.js`), `export const value${index} = ${index};\n`, "utf8")
      )
    );

    const plan = createRuntimePlan({
      request: "Inspect the workspace before planning.",
      workspace: { cwd: workspace, maxFiles: 2 },
    });

    assert.equal(plan.workspaceSummary.totalFiles, 2);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
test("routeTask escalates high risk and hard-to-verify work", () => {
  assert.equal(
    routeTask({
      difficulty: "L1",
      risk: "low",
      contextNeed: "low",
      verification: "easy",
    }).modelTier,
    "cheap"
  );

  assert.equal(
    routeTask({
      difficulty: "L2",
      risk: "medium",
      contextNeed: "medium",
      verification: "medium",
    }).modelTier,
    "standard"
  );

  assert.equal(
    routeTask({
      difficulty: "L2",
      risk: "high",
      contextNeed: "low",
      verification: "easy",
    }).modelTier,
    "premium"
  );

  assert.equal(
    routeTask({
      difficulty: "L1",
      risk: "low",
      contextNeed: "low",
      verification: "hard",
    }).modelTier,
    "premium"
  );
});

test("FileExecutionStore writes and reads execution records", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const plan = createRuntimePlan({
      request: "总结项目结构，并记录执行结果",
      now: new Date("2026-06-17T10:00:00.000Z"),
    });

    const record = await store.createRecord(plan);
    assert.match(record.runId, /^run_/);
    assert.equal(record.status, "approval_required");
    assert.equal(record.plan.planId, plan.planId);
    assert.equal(record.plan.taskGraph.run_id, record.runId);
    assert.equal(record.plan.planReport.task_graph.run_id, record.runId);
    assert.equal(record.events[0].type, "run.created");
    assert.equal(record.events[1].type, "approval.required");
    assert.equal(
      record.events.filter((event) => event.type === "task.routed").length,
      plan.tasks.length
    );

    await store.appendEvent(record.runId, {
      type: "task.routed",
      taskId: plan.tasks[0].id,
      modelTier: plan.tasks[0].modelTier,
      message: "Task routed during dry-run planning.",
    });

    const loaded = await store.readRecord(record.runId);
    assert.equal(loaded.events.length, 2 + plan.tasks.length + 1);
    assert.equal(loaded.events.at(-1).type, "task.routed");
    assert.equal(loaded.events.at(-1).taskId, plan.tasks[0].id);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("FileExecutionStore rejects invalid plans before persistence", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-invalid-plan-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const plan = createRuntimePlan({
      request: "生成一个无效持久化计划",
    });
    const invalidPlan = {
      ...plan,
      tasks: plan.tasks.map((task, index) =>
        index === 0
          ? {
              ...task,
              acceptance: [],
            }
          : task
      ),
    };

    await assert.rejects(store.createRecord(invalidPlan), /invalid runtime plan/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("validateRuntimePlan rejects task contracts without acceptance criteria", () => {
  const plan = createRuntimePlan({
    request: "生成一个无效任务合同用于验证",
  });
  const invalidPlan = {
    ...plan,
    tasks: plan.tasks.map((task, index) =>
      index === 0
        ? {
            ...task,
            acceptance: [],
          }
        : task
    ),
  };

  const validation = validateRuntimePlan(invalidPlan);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.code === "task.acceptance.required"));
});

test("validateRuntimePlan rejects circular task dependencies", () => {
  const plan = createRuntimePlan({
    request: "生成一个循环任务图用于验证",
  });
  const invalidPlan = {
    ...plan,
    tasks: plan.tasks.map((task) => {
      if (task.id === "T-001") {
        return { ...task, dependsOn: ["T-002"], depends_on: ["T-002"] };
      }

      if (task.id === "T-002") {
        return { ...task, dependsOn: ["T-001"], depends_on: ["T-001"] };
      }

      return task;
    }),
  };

  const validation = validateRuntimePlan(invalidPlan);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.code === "task_graph.cycle"));
});

test("validateRuntimePlan rejects circular top-level dependency edges", () => {
  const plan = createRuntimePlan({
    request: "生成一个只有 dependencies 字段成环的任务图",
  });
  const invalidPlan = {
    ...plan,
    tasks: plan.tasks.map((task) => ({
      ...task,
      dependsOn: [],
      depends_on: [],
    })),
    dependencies: [
      { from: "T-001", to: "T-002" },
      { from: "T-002", to: "T-001" },
    ],
    taskGraph: {
      ...plan.taskGraph,
      dependencies: [
        { from: "T-001", to: "T-002" },
        { from: "T-002", to: "T-001" },
      ],
    },
  };

  const validation = validateRuntimePlan(invalidPlan);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.code === "task_graph.cycle"));
});

test("validateRuntimePlan rejects task graph tasks that drift from plan tasks", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-task-graph-drift-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const plan = createRuntimePlan({
      request: "生成一个 taskGraph 与顶层任务不一致的计划",
    });
    const tamperedPlan = {
      ...plan,
      taskGraph: {
        ...plan.taskGraph,
        tasks: plan.taskGraph.tasks.slice(1),
      },
      task_graph: {
        ...plan.task_graph,
        tasks: plan.task_graph.tasks.slice(1),
      },
    };

    const validation = validateRuntimePlan(tamperedPlan);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.code === "task_graph.tasks.inconsistent"));

    await assert.rejects(store.createRecord(tamperedPlan), /task_graph.tasks.inconsistent/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("validateRuntimePlan rejects task graph alias metadata drift", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-task-graph-alias-drift-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const plan = createRuntimePlan({
      request: "生成一个 task_graph 元数据被篡改的计划",
    });
    const tamperedPlan = {
      ...plan,
      task_graph: {
        ...plan.task_graph,
        risk_summary: "low: forged summary",
      },
    };

    const validation = validateRuntimePlan(tamperedPlan);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.code === "task_graph.alias.inconsistent"));

    await assert.rejects(store.createRecord(tamperedPlan), /task_graph.alias.inconsistent/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("validateRuntimePlan rejects top-level plan metadata alias drift", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-plan-metadata-alias-drift-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const plan = createRuntimePlan({
      request: "生成一个顶层成本和风险摘要别名被篡改的计划",
    });
    const tamperedPlan = {
      ...plan,
      estimatedCost: {
        ...plan.estimatedCost,
        total: "$999.00",
      },
      riskSummary: "low: forged top-level summary",
    };

    const validation = validateRuntimePlan(tamperedPlan);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.code === "task_graph.alias.inconsistent"));

    await assert.rejects(store.createRecord(tamperedPlan), /task_graph.alias.inconsistent/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("validateRuntimePlan accepts metadata aliases with equivalent object values", () => {
  const plan = createRuntimePlan({
    request: "生成一个成本对象字段顺序不同但语义相同的计划",
  });
  const reorderedEstimatedCost = {
    note: plan.estimatedCost.note,
    maximum: plan.estimatedCost.maximum,
    minimum: plan.estimatedCost.minimum,
    currency: plan.estimatedCost.currency,
  };
  const equivalentPlan = {
    ...plan,
    estimatedCost: reorderedEstimatedCost,
  };

  const validation = validateRuntimePlan(equivalentPlan);

  assert.equal(validation.valid, true);
});

test("validateRuntimePlan requires both task graph aliases to be valid", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-task-graph-alias-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const plan = createRuntimePlan({
      request: "生成一个缺少 task_graph 别名的计划",
    });
    const missingSnakeCase = {
      ...plan,
      task_graph: undefined,
    };
    const missingCamelCase = {
      ...plan,
      taskGraph: undefined,
    };

    const missingSnakeCaseValidation = validateRuntimePlan(missingSnakeCase);
    assert.equal(missingSnakeCaseValidation.valid, false);
    assert.ok(missingSnakeCaseValidation.errors.some((error) => error.code === "task_graph.required"));

    const missingCamelCaseValidation = validateRuntimePlan(missingCamelCase);
    assert.equal(missingCamelCaseValidation.valid, false);
    assert.ok(missingCamelCaseValidation.errors.some((error) => error.code === "task_graph.required"));

    await assert.rejects(store.createRecord(missingSnakeCase), /task_graph.required/);
    await assert.rejects(store.createRecord(missingCamelCase), /task_graph.required/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("validateRuntimePlan rejects task contracts missing model_tier or depends_on", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-task-contract-required-fields-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const plan = createRuntimePlan({
      request: "生成一个缺少必填任务合同字段的计划",
    });
    const tamperedTasks = plan.tasks.map((task, index) => {
      if (index !== 0) {
        return task;
      }

      const {
        modelTier,
        model_tier: _modelTier,
        dependsOn,
        depends_on: _dependsOn,
        ...rest
      } = task;
      return rest;
    });
    const tamperedGraphTasks = plan.taskGraph.tasks.map((task, index) => {
      if (index !== 0) {
        return task;
      }

      const { model_tier: _modelTier, ...rest } = task;
      return rest;
    });
    const tamperedPlan = {
      ...plan,
      tasks: tamperedTasks,
      taskGraph: {
        ...plan.taskGraph,
        tasks: tamperedGraphTasks,
      },
      task_graph: {
        ...plan.task_graph,
        tasks: tamperedGraphTasks,
      },
    };

    const validation = validateRuntimePlan(tamperedPlan);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.code === "task.model_tier.required"));
    assert.ok(validation.errors.some((error) => error.code === "task.depends_on.required"));

    await assert.rejects(store.createRecord(tamperedPlan), /task.model_tier.required/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("validateRuntimePlan rejects task contracts missing snake_case output constraint fields", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-task-contract-snake-fields-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const plan = createRuntimePlan({
      request: "生成一个缺少 snake_case 任务合同字段的计划",
    });
    const tamperedPlan = {
      ...plan,
      tasks: plan.tasks.map((task, index) => {
        if (index !== 0) {
          return task;
        }

        const {
          allowed_files: _allowedFiles,
          forbidden_actions: _forbiddenActions,
          expected_output: _expectedOutput,
          final_verification: _finalVerification,
          ...rest
        } = task;
        return rest;
      }),
    };

    const validation = validateRuntimePlan(tamperedPlan);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.code === "task.allowed_files.required"));
    assert.ok(validation.errors.some((error) => error.code === "task.forbidden_actions.required"));
    assert.ok(validation.errors.some((error) => error.code === "task.expected_output.required"));
    assert.ok(validation.errors.some((error) => error.code === "task.final_verification.required"));

    await assert.rejects(store.createRecord(tamperedPlan), /task.allowed_files.required/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("validateRuntimePlan rejects task contracts missing task_id or context_need", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-task-contract-id-context-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const plan = createRuntimePlan({
      request: "生成一个缺少 task_id 和 context_need 的任务合同",
    });
    const tamperedPlan = {
      ...plan,
      tasks: plan.tasks.map((task, index) => {
        if (index !== 0) {
          return task;
        }

        const { task_id: _taskId, context_need: _contextNeed, ...rest } = task;
        return rest;
      }),
    };

    const validation = validateRuntimePlan(tamperedPlan);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.code === "task.id.required"));
    assert.ok(validation.errors.some((error) => error.code === "task.context_need.invalid"));

    await assert.rejects(store.createRecord(tamperedPlan), /task.id.required/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("validateRuntimePlan rejects dependency edges that drift from task contracts", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-dependency-drift-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const plan = createRuntimePlan({
      request: "生成一个 dependencies 与 depends_on 不一致的计划",
    });
    const tamperedPlan = {
      ...plan,
      dependencies: [],
      taskGraph: {
        ...plan.taskGraph,
        dependencies: [],
      },
      task_graph: {
        ...plan.task_graph,
        dependencies: [],
      },
    };

    const validation = validateRuntimePlan(tamperedPlan);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.code === "task_graph.dependencies.inconsistent"));

    await assert.rejects(store.createRecord(tamperedPlan), /task_graph.dependencies.inconsistent/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("validateRuntimePlan rejects approval status that disagrees with approval requirement", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-approval-status-drift-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const plan = createRuntimePlan({
      request: "生成一个审批状态被篡改的计划",
    });
    const tamperedPlan = {
      ...plan,
      approval: {
        ...plan.approval,
        status: "not_required",
      },
    };

    const validation = validateRuntimePlan(tamperedPlan);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.code === "approval.status.inconsistent"));

    await assert.rejects(store.createRecord(tamperedPlan), /approval.status.inconsistent/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("FileExecutionStore rejects new plans already marked approved", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-pre-approved-plan-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const plan = createRuntimePlan({
      request: "生成一个被预先标记为 approved 的计划",
    });
    const preApprovedPlan = {
      ...plan,
      approval: {
        ...plan.approval,
        status: "approved",
      },
    };

    assert.equal(validateRuntimePlan(preApprovedPlan).valid, true);
    await assert.rejects(store.createRecord(preApprovedPlan), /approval.status.inconsistent/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("validateRuntimePlan rejects plans missing task graph schema", () => {
  const plan = createRuntimePlan({
    request: "生成一个缺少 taskGraph 的计划",
  });
  const invalidPlan = {
    ...plan,
    taskGraph: undefined,
    task_graph: undefined,
  };

  const validation = validateRuntimePlan(invalidPlan);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.code === "task_graph.required"));
});

test("validateRuntimePlan rejects missing Phase 4 routing metadata", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-routing-missing-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const plan = createRuntimePlan({
      request: "create a plan with routing trace removed",
    });
    const tamperedPlan = {
      ...plan,
      routingTrace: undefined,
      routing_trace: undefined,
    };

    const validation = validateRuntimePlan(tamperedPlan);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.code === "routing.trace.required"));

    await assert.rejects(store.createRecord(tamperedPlan), /routing.trace.required/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("validateRuntimePlan rejects incomplete Phase 4 task routing metadata", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-routing-incomplete-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const plan = createRuntimePlan({
      request: "create a plan with incomplete routing metadata",
    });
    const tamperedPlan = {
      ...plan,
      tasks: plan.tasks.map((task, index) =>
        index === 0
          ? {
              ...task,
              classification: {},
              routing: {},
            }
          : task
      ),
    };

    const validation = validateRuntimePlan(tamperedPlan);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.code === "task.classification.invalid"));
    assert.ok(validation.errors.some((error) => error.code === "task.routing.invalid"));

    await assert.rejects(store.createRecord(tamperedPlan), /task.classification.invalid/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("validateRuntimePlan rejects incomplete model registry entries", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-model-registry-invalid-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const plan = createRuntimePlan({
      request: "create a plan with incomplete model registry metadata",
    });
    const tamperedPlan = {
      ...plan,
      modelRegistry: [{}],
      model_registry: [{}],
    };

    const validation = validateRuntimePlan(tamperedPlan);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.code === "model.registry.entry.invalid"));

    await assert.rejects(store.createRecord(tamperedPlan), /model.registry.entry.invalid/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("validateRuntimePlan rejects missing or drifted model tier aliases", () => {
  const plan = createRuntimePlan({
    request: "create a plan with tampered model tier aliases",
  });
  const missingAliasesPlan = {
    ...plan,
    modelTierAliases: undefined,
    model_tier_aliases: undefined,
  };
  const driftedAliasesPlan = {
    ...plan,
    model_tier_aliases: {
      ...plan.model_tier_aliases,
      premium: "standard",
    },
  };

  const missingValidation = validateRuntimePlan(missingAliasesPlan);
  const driftedValidation = validateRuntimePlan(driftedAliasesPlan);

  assert.equal(missingValidation.valid, false);
  assert.ok(missingValidation.errors.some((error) => error.code === "model.tier_aliases.required"));
  assert.equal(driftedValidation.valid, false);
  assert.ok(driftedValidation.errors.some((error) => error.code === "model.tier_aliases.invalid"));
  assert.ok(driftedValidation.errors.some((error) => error.code === "model.tier_aliases.alias.inconsistent"));
});

test("validateRuntimePlan rejects routing trace duplicates and missing tasks", () => {
  const plan = createRuntimePlan({
    request: "create a plan with duplicate routing trace entries",
  });
  const duplicateTrace = plan.routingTrace.map((route, index) =>
    index === 1
      ? {
          ...route,
          task_id: plan.routingTrace[0].task_id,
        }
      : route
  );
  const tamperedPlan = {
    ...plan,
    routingTrace: duplicateTrace,
    routing_trace: duplicateTrace,
  };

  const validation = validateRuntimePlan(tamperedPlan);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.code === "routing.trace.task.duplicate"));
  assert.ok(validation.errors.some((error) => error.code === "routing.trace.task.missing"));
});

test("validateRuntimePlan rejects task routing metadata that drifts from task contracts", () => {
  const plan = createRuntimePlan({
    request: "create a plan with mismatched task routing metadata",
  });
  const tamperedTasks = plan.tasks.map((task, index) =>
    index === 0
      ? {
          ...task,
          routing: {
            ...task.routing,
            model_tier: task.model_tier === "cheap" ? "standard" : "cheap",
          },
        }
      : task
  );
  const tamperedPlan = {
    ...plan,
    tasks: tamperedTasks,
  };

  const validation = validateRuntimePlan(tamperedPlan);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.code === "task.routing.model_tier.inconsistent"));
});

test("validateRuntimePlan rejects selected models that drift from routed tiers", () => {
  const plan = createRuntimePlan({
    request: "create a plan with mismatched selected model metadata",
  });
  const cheapModel = plan.modelRegistry.find((entry) => entry.tier === "cheap");
  const finalTaskId = plan.tasks.at(-1).task_id;
  const tamperedTasks = plan.tasks.map((task) =>
    task.task_id === finalTaskId
      ? {
          ...task,
          routing: {
            ...task.routing,
            selected_model: cheapModel,
          },
        }
      : task
  );
  const tamperedTrace = plan.routingTrace.map((route) =>
    route.task_id === finalTaskId
      ? {
          ...route,
          selected_model: cheapModel,
        }
      : route
  );
  const tamperedPlan = {
    ...plan,
    tasks: tamperedTasks,
    routingTrace: tamperedTrace,
    routing_trace: tamperedTrace,
  };

  const validation = validateRuntimePlan(tamperedPlan);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.code === "task.routing.selected_model.tier.inconsistent"));
  assert.ok(validation.errors.some((error) => error.code === "routing.trace.selected_model.tier.inconsistent"));
});

test("validateRuntimePlan rejects selected models outside the model registry", () => {
  const plan = createRuntimePlan({
    request: "create a plan with an unknown selected model",
  });
  const unknownModel = {
    provider: "unknown-provider",
    model: "unknown-model",
    tier: plan.tasks[0].model_tier,
  };
  const tamperedTasks = plan.tasks.map((task, index) =>
    index === 0
      ? {
          ...task,
          routing: {
            ...task.routing,
            selected_model: unknownModel,
          },
        }
      : task
  );
  const tamperedTrace = plan.routingTrace.map((route, index) =>
    index === 0
      ? {
          ...route,
          selected_model: unknownModel,
        }
      : route
  );
  const tamperedPlan = {
    ...plan,
    tasks: tamperedTasks,
    routingTrace: tamperedTrace,
    routing_trace: tamperedTrace,
  };

  const validation = validateRuntimePlan(tamperedPlan);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.code === "task.routing.selected_model.unknown"));
  assert.ok(validation.errors.some((error) => error.code === "routing.trace.selected_model.unknown"));
});

test("validateRuntimePlan rejects routing below safety floors", () => {
  const plan = createRuntimePlan({
    request: "create a plan with downgraded safe routing",
  });
  const downgradedTasks = plan.tasks.map((task) => {
    if (task.classification.edits_files || task.finalVerification) {
      return {
        ...task,
        modelTier: "cheap",
        model_tier: "cheap",
        classification: {
          ...task.classification,
          ...(task.classification.edits_files
            ? {
                edits_files: false,
                editsFiles: false,
              }
            : {}),
        },
        routing: {
          ...task.routing,
          model_tier: "cheap",
        },
      };
    }

    return task;
  });
  const downgradedGraphTasks = plan.taskGraph.tasks.map((task) => {
    const source = downgradedTasks.find((candidate) => candidate.task_id === task.task_id);
    return {
      ...task,
      model_tier: source.model_tier,
    };
  });
  const downgradedTrace = plan.routingTrace.map((route) => {
    const source = downgradedTasks.find((task) => task.task_id === route.task_id);
    return {
      ...route,
      model_tier: source.model_tier,
    };
  });
  const tamperedPlan = {
    ...plan,
    tasks: downgradedTasks,
    taskGraph: {
      ...plan.taskGraph,
      tasks: downgradedGraphTasks,
    },
    task_graph: {
      ...plan.task_graph,
      tasks: downgradedGraphTasks,
    },
    routingTrace: downgradedTrace,
    routing_trace: downgradedTrace,
  };

  const validation = validateRuntimePlan(tamperedPlan);

  assert.equal(validation.valid, false);
  assert.ok(
    validation.errors.some((error) => error.code === "task.classification.edits_files.inconsistent")
  );
  assert.ok(validation.errors.some((error) => error.code === "routing.safety.file_edit_tier"));
  assert.ok(validation.errors.some((error) => error.code === "routing.safety.final_verification_tier"));
});

test("validateRuntimePlan rejects final verification downgrades when optional markers are removed", () => {
  const plan = createRuntimePlan({
    request: "create a plan with a downgraded final verification contract",
  });
  const finalTaskId = plan.tasks.at(-1).task_id;
  const downgradedTasks = plan.tasks.map((task) => {
    if (task.task_id !== finalTaskId) {
      return task;
    }

    const { finalVerification: _finalVerification, ...taskWithoutCamelFinal } = task;
    return {
      ...taskWithoutCamelFinal,
      final_verification: true,
      modelTier: "cheap",
      model_tier: "cheap",
      routing: {
        ...task.routing,
        model_tier: "cheap",
        escalation_triggers: task.routing.escalation_triggers.filter((trigger) => trigger !== "final_review"),
      },
    };
  });
  const downgradedGraphTasks = plan.taskGraph.tasks.map((task) =>
    task.task_id === finalTaskId
      ? {
          ...task,
          model_tier: "cheap",
          final_verification: true,
        }
      : task
  );
  const downgradedTrace = plan.routingTrace.map((route) =>
    route.task_id === finalTaskId
      ? {
          ...route,
          model_tier: "cheap",
          escalation_triggers: route.escalation_triggers.filter((trigger) => trigger !== "final_review"),
        }
      : route
  );
  const tamperedPlan = {
    ...plan,
    tasks: downgradedTasks,
    taskGraph: {
      ...plan.taskGraph,
      tasks: downgradedGraphTasks,
    },
    task_graph: {
      ...plan.task_graph,
      tasks: downgradedGraphTasks,
    },
    routingTrace: downgradedTrace,
    routing_trace: downgradedTrace,
  };

  const validation = validateRuntimePlan(tamperedPlan);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.code === "routing.safety.final_verification_tier"));
});

test("FileExecutionStore refuses budget-disallowed plans before persistence", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-budget-refusal-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const plan = createRuntimePlan({
      request: "implement a feature that is intentionally over budget",
    });
    const budgetStatus = {
      ...plan.budgetStatus,
      allowed: false,
      violations: [
        {
          code: "budget.cost.exceeded",
          limit: 0.01,
          actual: plan.budgetStatus.estimatedCost,
          message: "test budget limit exceeded",
        },
      ],
    };
    const overBudgetPlan = {
      ...plan,
      budgetStatus,
      budget_status: budgetStatus,
    };

    assert.equal(validateRuntimePlan(overBudgetPlan).valid, true);
    await assert.rejects(store.createRecord(overBudgetPlan), /budget.policy.violation/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("createRuntimePlan applies caller budget policy before persistence", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-budget-policy-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const plan = createRuntimePlan({
      request: "implement a feature that exceeds a tiny budget",
      budgetPolicy: {
        maxCostPerRun: 0.01,
        maxCallsPerRun: 1,
        maxRetryCount: 0,
      },
    });

    assert.equal(plan.budgetStatus.allowed, false);
    assert.ok(plan.budgetStatus.violations.some((violation) => violation.code === "budget.cost.exceeded"));
    assert.ok(plan.budgetStatus.violations.some((violation) => violation.code === "budget.calls.exceeded"));
    assert.ok(plan.budgetStatus.violations.some((violation) => violation.code === "budget.retries.exceeded"));
    await assert.rejects(store.createRecord(plan), /budget.policy.violation/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("FileExecutionStore refuses user policy violation plans before persistence", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-policy-refusal-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const plan = createRuntimePlan({
      request: "implement a feature that violates a user policy",
      policyViolations: [
        {
          code: "policy.user.violation",
          message: "test user policy violation",
        },
      ],
    });

    assert.equal(plan.policyStatus.allowed, false);
    assert.equal(plan.policy_status.allowed, false);
    assert.ok(plan.policyStatus.violations.some((violation) => violation.code === "policy.user.violation"));
    assert.equal(validateRuntimePlan(plan).valid, true);
    await assert.rejects(store.createRecord(plan), /policy.status.violation/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("validateRuntimePlan rejects approval metadata that disagrees with task risk", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-approval-mismatch-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const plan = createRuntimePlan({
      request: "生成一个审批元数据被篡改的计划",
    });
    const tamperedPlan = {
      ...plan,
      approvalRequired: false,
      approval_required: false,
      approval: {
        ...plan.approval,
        required: false,
        status: "not_required",
      },
      taskGraph: {
        ...plan.taskGraph,
        approval_required: false,
      },
      task_graph: {
        ...plan.task_graph,
        approval_required: false,
      },
    };

    const validation = validateRuntimePlan(tamperedPlan);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.code === "approval.inconsistent"));

    await assert.rejects(store.createRecord(tamperedPlan), /approval.inconsistent/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("validateRuntimePlan rejects approval-required plans without an approval object", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-approval-missing-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const plan = createRuntimePlan({
      request: "create a plan with approval metadata removed",
    });
    const tamperedPlan = {
      ...plan,
      approval: undefined,
    };

    const validation = validateRuntimePlan(tamperedPlan);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.code === "approval.required"));

    await assert.rejects(store.createRecord(tamperedPlan), /approval.required/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime_run persists approval gate metadata for medium and high risk plans", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-approval-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "实现跨模块支付重构并最终审查" },
      { store }
    );
    assert.equal(run.status, "approval_required");
    assert.equal(run.plan.approval.status, "required");
    assert.equal(run.plan.approvalRequired, true);

    const loaded = await store.readRecord(run.runId);
    assert.equal(loaded.status, "approval_required");
    assert.equal(loaded.plan.taskGraph.approval_required, true);
    assert.ok(loaded.events.some((event) => event.type === "approval.required"));

    const approved = await callRuntimeTool(
      "runtime_approve",
      { runId: run.runId, approvedBy: "test-user", note: "approved in test" },
      { store }
    );
    assert.equal(approved.status, "approved");
    assert.equal(approved.approvalStatus, "approved");

    const approvedRecord = await store.readRecord(run.runId);
    assert.equal(approvedRecord.status, "approved");
    assert.equal(approvedRecord.plan.approval.status, "approved");
    assert.equal(approvedRecord.plan.planReport.approval.status, "approved");
    assert.ok(approvedRecord.events.some((event) => event.type === "approval.approved"));

    await assert.rejects(
      callRuntimeTool("runtime_approve", { runId: run.runId, approvedBy: "test-user" }, { store }),
      /approval_required/
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

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
            diff_check: { enabled: false },
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

test("runtime_verify refuses approval_required runs", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-approval-verify-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "implement a payment module with tests" },
      { store }
    );
    assert.equal(run.status, "approval_required");

    await assert.rejects(
      callRuntimeTool("runtime_verify", { runId: run.runId }, { store }),
      /approval_required/
    );

    const record = await store.readRecord(run.runId);
    assert.equal(record.status, "approval_required");
    assert.equal(
      record.events.some((event) => event.type === "verification.started"),
      false
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

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
            diff_check: { enabled: false },
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
            diff_check: { enabled: false },
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

test("runtime_verify does not overwrite a run canceled during verification", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-verify-cancel-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "plan only: cancel while deterministic verification runs" },
      { store }
    );
    const verificationPromise = callRuntimeTool(
      "runtime_verify",
      { runId: run.runId },
      {
        store,
        runtimeOptions: {
          verification: {
            diff_check: { enabled: false },
            commands: [
              {
                name: "delayed-success",
                command: process.execPath,
                args: ["-e", "setTimeout(() => process.exit(0), 250);"],
                required: true,
              },
            ],
          },
        },
      }
    );

    await waitForRecordStatus(store, run.runId, "verifying");
    const canceled = await callRuntimeTool(
      "runtime_cancel",
      { runId: run.runId, reason: "cancel during verification" },
      { store }
    );
    assert.equal(canceled.status, "canceled");

    await verificationPromise;

    const record = await store.readRecord(run.runId);
    assert.equal(record.status, "canceled");
    assert.ok(record.events.some((event) => event.type === "run.canceled"));
    assert.ok(record.events.some((event) => event.type === "verification.finished"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime_verify records command spawn errors as verification_failed", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-verify-spawn-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "plan only: record verification spawn errors" },
      { store }
    );
    const verification = await callRuntimeTool(
      "runtime_verify",
      { runId: run.runId },
      {
        store,
        runtimeOptions: {
          verification: {
            cwd: path.join(workspace, "missing-directory"),
            diff_check: { enabled: false },
            commands: [
              {
                name: "bad-cwd",
                command: process.execPath,
                args: ["--version"],
                required: true,
              },
            ],
          },
        },
      }
    );

    assert.equal(verification.status, "failed");
    assert.equal(verification.commands[0].status, "failed");
    assert.ok(verification.commands[0].error);

    const record = await store.readRecord(run.runId);
    assert.equal(record.status, "verification_failed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime_report markdown includes verification command evidence", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-report-verify-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "plan only: report deterministic verification evidence" },
      { store }
    );
    await callRuntimeTool(
      "runtime_verify",
      { runId: run.runId },
      {
        store,
        runtimeOptions: {
          verification: {
            diff_check: { enabled: false },
            commands: [
              {
                name: "node-version",
                command: process.execPath,
                args: ["--version"],
                required: true,
              },
            ],
          },
        },
      }
    );

    const report = await callRuntimeTool(
      "runtime_report",
      { runId: run.runId, format: "markdown" },
      { store }
    );

    assert.match(report.markdown, /node-version: passed/);
    assert.match(report.markdown, /exitCode: 0/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("loadRuntimeConfig merges defaults, config file, and environment overrides", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-config-"));
  const dataDirectory = path.join(workspace, "data");

  try {
    await writeFile(
      path.join(workspace, "runtime.config.json"),
      JSON.stringify(
        {
          server: {
            host: "0.0.0.0",
            httpPort: 4123,
          },
          routing: {
            finalVerificationTier: "premium",
          },
          execution: {
            maxContextBytesPerFile: 8192,
            workerTimeoutMs: 150000,
          },
          planning: {
            supervisor: {
              enabled: true,
              provider: "openai-compatible",
              model: "premium-planner",
              maxTokens: 2048,
            },
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const config = await loadRuntimeConfig({
      cwd: workspace,
      env: {
        AI_CODING_RUNTIME_HOME: dataDirectory,
      },
    });

    assert.equal(config.server.host, "0.0.0.0");
    assert.equal(config.server.httpPort, 4123);
    assert.equal(config.server.mcpPath, "/mcp");
    assert.equal(config.storage.directory, dataDirectory);
    assert.equal(config.routing.finalVerificationTier, "premium");
    assert.equal(config.routing.budgetPolicy.maxCallsPerRun, 20);
    assert.equal(config.routing.budgetPolicy.maxRetryCount, 8);
    assert.equal(config.routing.modelRegistry.length, 3);
    assert.equal(config.execution.maxContextBytesPerFile, 8192);
    assert.equal(config.execution.workerTimeoutMs, 150000);
    assert.equal(config.planning.supervisor.enabled, true);
    assert.equal(config.planning.supervisor.provider, "openai-compatible");
    assert.equal(config.planning.supervisor.model, "premium-planner");
    assert.equal(config.planning.supervisor.maxTokens, 2048);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function waitForRecordStatus(store, runId, status) {
  const deadline = Date.now() + 1000;

  while (Date.now() < deadline) {
    const record = await store.readRecord(runId);
    if (record.status === status) {
      return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const record = await store.readRecord(runId);
  assert.equal(record.status, status);
  return record;
}
