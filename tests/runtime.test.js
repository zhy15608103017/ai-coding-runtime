import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  callRuntimeTool,
  createRuntimePlan,
  FileExecutionStore,
  loadRuntimeConfig,
  routeTask,
  validateRuntimePlan,
} from "../src/index.js";

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

  const implementationTask = plan.tasks.find((task) =>
    task.title.includes("实现")
  );
  assert.ok(implementationTask);
  assert.equal(implementationTask.modelTier, "standard");
  assert.ok(implementationTask.acceptance.length > 0);

  const finalTask = plan.tasks.at(-1);
  assert.equal(finalTask.title, "最终审查与交付报告");
  assert.equal(finalTask.modelTier, "premium");
  assert.deepEqual(finalTask.dependsOn, [plan.tasks.at(-2).id]);
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

    await store.appendEvent(record.runId, {
      type: "task.routed",
      taskId: plan.tasks[0].id,
      modelTier: plan.tasks[0].modelTier,
      message: "Task routed during dry-run planning.",
    });

    const loaded = await store.readRecord(record.runId);
    assert.equal(loaded.events.length, 3);
    assert.equal(loaded.events[2].type, "task.routed");
    assert.equal(loaded.events[2].taskId, plan.tasks[0].id);
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
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
