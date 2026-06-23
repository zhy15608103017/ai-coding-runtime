import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildVerificationCommands,
  callRuntimeTool,
  createSupervisorReviewPrompt,
  FileExecutionStore,
  loadRuntimeConfig,
  reviewTaskAcceptance,
  runSupervisorReview,
  shouldRunSupervisorReview,
} from "../src/index.js";

test("loadRuntimeConfig exposes Phase 7 verification config fields", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-phase7-config-"));

  try {
    await writeFile(
      path.join(workspace, "runtime.config.json"),
      JSON.stringify(
        {
          verification: {
            diff_check: { enabled: false },
            test: { command: "npm", args: ["test"], required: true, timeoutMs: 120000 },
            lint: { command: "npm", args: ["run", "lint"], required: false },
            typecheck: { command: "npm", args: ["run", "typecheck"], required: false },
            custom_commands: [
              { name: "format", command: "npm", args: ["run", "format:check"], required: true },
            ],
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const config = await loadRuntimeConfig({ cwd: workspace, env: {} });

    assert.equal(config.verification.diff_check.enabled, false);
    assert.equal(config.verification.test.command, "npm");
    assert.deepEqual(config.verification.test.args, ["test"]);
    assert.equal(config.verification.lint.required, false);
    assert.equal(config.verification.typecheck.command, "npm");
    assert.equal(config.verification.custom_commands[0].name, "format");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("buildVerificationCommands creates diff, test, lint, typecheck, and custom commands", () => {
  const commands = buildVerificationCommands({
    diff_check: { enabled: true, required: true, timeoutMs: 30000 },
    test: { command: "npm", args: ["test"], required: true, timeoutMs: 120000 },
    lint: { command: "npm", args: ["run", "lint"], required: false },
    typecheck: { command: "npm", args: ["run", "typecheck"], required: false },
    custom_commands: [
      { name: "format", command: "npm", args: ["run", "format:check"], required: true },
    ],
  });

  assert.deepEqual(
    commands.map((command) => command.name),
    ["git-diff-check", "test", "lint", "typecheck", "format"]
  );
  assert.deepEqual(commands[0], {
    name: "git-diff-check",
    command: "git",
    args: ["diff", "--check"],
    required: true,
    timeoutMs: 30000,
    source: "diff_check",
  });
});

test("buildVerificationCommands ignores malformed command arrays", () => {
  const commands = buildVerificationCommands({
    diff_check: { enabled: false },
    custom_commands: { name: "format", command: "npm" },
    commands: "npm test",
  });

  assert.deepEqual(commands, []);
});

test("reviewTaskAcceptance maps every acceptance item to worker evidence", () => {
  const review = reviewTaskAcceptance({
    tasks: [
      {
        task_id: "T-003",
        title: "Implement feature",
        acceptance: ["feature works", "tests added"],
      },
    ],
    workerAttempts: [
      {
        task_id: "T-003",
        status: "applied",
        acceptance: {
          "feature works": "Implemented src/runtime/example.js.",
          "tests added": "Added tests/example.test.js.",
        },
      },
    ],
  });

  assert.equal(review.status, "passed");
  assert.equal(review.tasks[0].items[0].status, "passed");
  assert.equal(review.tasks[0].items[1].evidence, "Added tests/example.test.js.");
});

test("reviewTaskAcceptance fails when acceptance evidence is missing", () => {
  const review = reviewTaskAcceptance({
    tasks: [{ task_id: "T-003", title: "Implement feature", acceptance: ["feature works"] }],
    workerAttempts: [{ task_id: "T-003", status: "applied", acceptance: {} }],
  });

  assert.equal(review.status, "failed");
  assert.equal(review.tasks[0].items[0].status, "failed");
});

test("reviewTaskAcceptance fails when any task lacks evidence after worker execution starts", () => {
  const review = reviewTaskAcceptance({
    tasks: [
      { task_id: "T-001", title: "First", acceptance: ["first works"], allowed_files: ["src/first.js"] },
      { task_id: "T-002", title: "Second", acceptance: ["second works"], allowed_files: ["src/second.js"] },
    ],
    workerAttempts: [
      {
        task_id: "T-001",
        status: "recorded",
        acceptance: { "first works": "Evidence for first task." },
      },
    ],
  });

  assert.equal(review.status, "failed");
  assert.equal(review.tasks[0].status, "passed");
  assert.equal(review.tasks[1].status, "failed");
  assert.equal(review.tasks[1].items[0].status, "failed");
});

test("reviewTaskAcceptance skips read-only tasks without worker evidence after execution starts", () => {
  const review = reviewTaskAcceptance({
    tasks: [
      { task_id: "T-001", title: "Context", acceptance: ["workspace summarized"], allowed_files: [] },
      { task_id: "T-002", title: "Implement", acceptance: ["feature works"], allowed_files: ["README.md"] },
      { task_id: "T-003", title: "Verify", acceptance: ["verification recorded"], allowed_files: [] },
    ],
    workerAttempts: [
      {
        task_id: "T-002",
        status: "applied",
        acceptance: { "feature works": "Updated README.md only." },
      },
    ],
  });

  assert.equal(review.status, "passed");
  assert.equal(review.tasks[0].status, "skipped");
  assert.equal(review.tasks[1].status, "passed");
  assert.equal(review.tasks[2].status, "skipped");
});

test("runtime_verify records task acceptance review evidence", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-phase7-acceptance-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "plan only: record acceptance verification evidence" },
      { store }
    );
    const record = await store.readRecord(run.runId);

    await store.updateRecord(run.runId, (current) => {
      for (const task of record.plan.tasks) {
        const acceptance = Object.fromEntries(
          task.acceptance.map((item) => [item, `Evidence for ${item}`])
        );
        current.workerAttempts.push({
          attemptId: `attempt_${task.task_id}_phase7`,
          attempt_id: `attempt_${task.task_id}_phase7`,
          taskId: task.task_id,
          task_id: task.task_id,
          status: "recorded",
          applied: false,
          acceptance,
        });
      }
      return current;
    });

    const verification = await callRuntimeTool(
      "runtime_verify",
      { runId: run.runId },
      {
        store,
        runtimeOptions: {
          verification: {
            diff_check: { enabled: false },
          },
        },
      }
    );
    const updated = await store.readRecord(run.runId);

    assert.equal(verification.status, "passed");
    assert.equal(verification.acceptance.status, "passed");
    assert.equal(verification.acceptance.tasks[0].items[0].status, "passed");
    assert.equal(updated.verification[0].acceptance.status, "passed");
    assert.equal(updated.status, "verification_passed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime_verify defaults command cwd to workspace cwd", async () => {
  const runtimeHome = await mkdtemp(path.join(tmpdir(), "ai-runtime-phase7-cwd-store-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-phase7-cwd-workspace-"));
  const store = new FileExecutionStore({ workspace: runtimeHome });

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "plan only: verify workspace cwd" },
      { store }
    );
    const verification = await callRuntimeTool(
      "runtime_verify",
      { runId: run.runId },
      {
        store,
        runtimeOptions: {
          workspace: { cwd: workspace },
          verification: {
            diff_check: { enabled: false },
            commands: [
              {
                name: "cwd-check",
                command: process.execPath,
                args: ["-e", "console.log(process.cwd())"],
                required: true,
                timeoutMs: 10000,
              },
            ],
          },
        },
      }
    );

    assert.equal(path.normalize(verification.commands[0].stdout.trim()), path.normalize(workspace));
    assert.equal(verification.commands[0].timeoutMs, 10000);
    assert.equal(verification.commands[0].timeout_ms, 10000);
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("shouldRunSupervisorReview requires final review for medium and high risk tasks", () => {
  assert.equal(
    shouldRunSupervisorReview({
      tasks: [{ risk: "low" }],
      config: { enabled: true, requiredForRisk: ["medium", "high"] },
    }),
    false
  );
  assert.equal(
    shouldRunSupervisorReview({
      tasks: [{ risk: "medium" }],
      config: { enabled: true, requiredForRisk: ["medium", "high"] },
    }),
    true
  );
});

test("createSupervisorReviewPrompt includes requirements, diff risk, and verification evidence", () => {
  const prompt = createSupervisorReviewPrompt({
    record: {
      request: "Implement Phase 7",
      plan: { tasks: [{ task_id: "T-001", title: "Verify", risk: "medium" }] },
    },
    verification: {
      commands: [{ name: "git-diff-check", status: "passed", exitCode: 0 }],
      acceptance: { status: "passed" },
    },
  });

  assert.match(prompt, /requirement alignment/i);
  assert.match(prompt, /diff risk/i);
  assert.match(prompt, /verification evidence/i);
  assert.match(prompt, /git-diff-check/);
});

test("runSupervisorReview rejects provider JSON missing required evidence fields", async () => {
  const review = await runSupervisorReview({
    record: {
      request: "Implement Phase 7",
      plan: { tasks: [{ task_id: "T-001", title: "Verify", risk: "medium" }] },
    },
    verification: {
      commands: [{ name: "git-diff-check", status: "passed", exitCode: 0 }],
      acceptance: { status: "passed" },
    },
    config: {
      provider: "test-provider",
      model: "test-model",
      requiredForRisk: ["medium"],
      generate: async () => ({
        provider: "test-provider",
        model: "test-model",
        text: JSON.stringify({ status: "passed", blockingIssues: [] }),
        structuredOutput: { status: "passed", blockingIssues: [] },
      }),
    },
  });

  assert.equal(review.status, "failed");
  assert.equal(review.errors[0].code, "supervisor.review.invalid_response");
});

test("runSupervisorReview normalizes richer provider JSON into a passing review", async () => {
  const review = await runSupervisorReview({
    record: {
      request: "Implement Phase 7",
      plan: { tasks: [{ task_id: "T-001", title: "Verify", risk: "medium" }] },
    },
    verification: {
      commands: [{ name: "git-diff-check", status: "passed", exitCode: 0 }],
      acceptance: { status: "passed" },
    },
    config: {
      provider: "test-provider",
      model: "test-model",
      requiredForRisk: ["medium"],
      generate: async () => ({
        provider: "test-provider",
        model: "test-model",
        text: JSON.stringify({
          status: "approved",
          summary: "README.md only was updated as requested.",
          requirementAlignment: {
            request: "Only modify README.md.",
            assessment: "Aligned with the request.",
          },
          diffRisk: {
            level: "low",
            rationale: "Documentation-only change.",
          },
          verificationEvidence: [
            { check: "git-diff-check", result: "passed", exitCode: 0 },
            { check: "test", result: "passed", exitCode: 0 },
          ],
          blockingIssues: [],
        }),
      }),
    },
  });

  assert.equal(review.status, "passed");
  assert.match(review.requirementAlignment, /Aligned with the request/);
  assert.match(review.diffRisk, /Documentation-only change/);
  assert.match(review.verificationEvidence, /git-diff-check/);
});

test("runSupervisorReview accepts pass as a successful supervisor status alias", async () => {
  const review = await runSupervisorReview({
    record: {
      request: "Implement Phase 7",
      plan: { tasks: [{ task_id: "T-001", title: "Verify", risk: "medium" }] },
    },
    verification: {
      commands: [{ name: "git-diff-check", status: "passed", exitCode: 0 }],
      acceptance: { status: "passed" },
    },
    config: {
      provider: "test-provider",
      model: "test-model",
      requiredForRisk: ["medium"],
      generate: async () => ({
        provider: "test-provider",
        model: "test-model",
        text: JSON.stringify({
          status: "pass",
          summary: "Review passed.",
          requirementAlignment: "Aligned.",
          diffRisk: "Low risk.",
          verificationEvidence: "Checks passed.",
          blockingIssues: [],
        }),
      }),
    },
  });

  assert.equal(review.status, "passed");
});

test("runSupervisorReview omits responseSchema for openai-compatible providers by default", async () => {
  let seenRequest = null;
  const review = await runSupervisorReview({
    record: {
      request: "Implement Phase 7",
      plan: { tasks: [{ task_id: "T-001", title: "Verify", risk: "medium" }] },
    },
    verification: {
      commands: [{ name: "git-diff-check", status: "passed", exitCode: 0 }],
      acceptance: { status: "passed" },
    },
    config: {
      provider: "openai-compatible",
      model: "gpt-test",
      requiredForRisk: ["medium"],
      generate: async (request) => {
        seenRequest = request;
        return {
          provider: "openai-compatible",
          model: "gpt-test",
          text: JSON.stringify({
            status: "passed",
            summary: "Review passed.",
            requirementAlignment: "Aligned.",
            diffRisk: "Low risk.",
            verificationEvidence: "Checks passed.",
            blockingIssues: [],
          }),
        };
      },
    },
  });

  assert.equal(review.status, "passed");
  assert.ok(seenRequest);
  assert.equal(seenRequest.responseSchema, undefined);
});

test("runSupervisorReview accepts boolean approved aliases", async () => {
  const review = await runSupervisorReview({
    record: {
      request: "Implement Phase 7",
      plan: { tasks: [{ task_id: "T-001", title: "Verify", risk: "medium" }] },
    },
    verification: {
      commands: [{ name: "git-diff-check", status: "passed", exitCode: 0 }],
      acceptance: { status: "passed" },
    },
    config: {
      provider: "test-provider",
      model: "test-model",
      requiredForRisk: ["medium"],
      generate: async () => ({
        provider: "test-provider",
        model: "test-model",
        text: JSON.stringify({
          approved: true,
          summary: "Review passed.",
          requirementAlignment: "Aligned.",
          diffRisk: "Low risk.",
          verificationEvidence: "Checks passed.",
          blockingIssues: [],
        }),
      }),
    },
  });

  assert.equal(review.status, "passed");
});

test("runSupervisorReview preserves structured blocking issues as blocking failures", async () => {
  const review = await runSupervisorReview({
    record: {
      request: "Implement Phase 7",
      plan: { tasks: [{ task_id: "T-001", title: "Verify", risk: "medium" }] },
    },
    verification: {
      commands: [{ name: "git-diff-check", status: "passed", exitCode: 0 }],
      acceptance: { status: "passed" },
    },
    config: {
      provider: "test-provider",
      model: "test-model",
      requiredForRisk: ["medium"],
      generate: async () => ({
        provider: "test-provider",
        model: "test-model",
        text: JSON.stringify({
          status: "passed",
          summary: "Review found a blocker.",
          requirementAlignment: "Aligned.",
          diffRisk: "Low risk.",
          verificationEvidence: "Checks passed.",
          blockingIssues: [
            {
              title: "Clarify wording",
              impact: "Current sentence is ambiguous.",
            },
          ],
        }),
      }),
    },
  });

  assert.equal(review.status, "failed");
  assert.equal(review.blockingIssues.length, 1);
  assert.match(review.blockingIssues[0], /Clarify wording/);
});

test("runSupervisorReview rejects passed responses that omit blockingIssues", async () => {
  const review = await runSupervisorReview({
    record: {
      request: "Implement Phase 7",
      plan: { tasks: [{ task_id: "T-001", title: "Verify", risk: "medium" }] },
    },
    verification: {
      commands: [{ name: "git-diff-check", status: "passed", exitCode: 0 }],
      acceptance: { status: "passed" },
    },
    config: {
      provider: "test-provider",
      model: "test-model",
      requiredForRisk: ["medium"],
      generate: async () => ({
        provider: "test-provider",
        model: "test-model",
        text: JSON.stringify({
          status: "passed",
          summary: "Review passed.",
          requirementAlignment: "Aligned.",
          diffRisk: "Low risk.",
          verificationEvidence: "Checks passed.",
        }),
      }),
    },
  });

  assert.equal(review.status, "failed");
  assert.equal(review.errors[0].code, "supervisor.review.invalid_response");
});

test("runSupervisorReview requires provider and model", async () => {
  const modelOnlyReview = await runSupervisorReview({
    record: {
      request: "Implement Phase 7",
      plan: { tasks: [{ task_id: "T-001", title: "Verify", risk: "medium" }] },
    },
    verification: { commands: [], acceptance: { status: "passed" } },
    config: {
      model: "test-model",
      requiredForRisk: ["medium"],
      generate: async () => {
        throw new Error("should not call provider without provider name");
      },
    },
  });
  const providerOnlyReview = await runSupervisorReview({
    record: {
      request: "Implement Phase 7",
      plan: { tasks: [{ task_id: "T-001", title: "Verify", risk: "medium" }] },
    },
    verification: { commands: [], acceptance: { status: "passed" } },
    config: {
      provider: "test-provider",
      requiredForRisk: ["medium"],
      generate: async () => {
        throw new Error("should not call provider without model name");
      },
    },
  });

  assert.equal(modelOnlyReview.status, "failed");
  assert.equal(modelOnlyReview.errors[0].code, "supervisor.review.provider_required");
  assert.equal(providerOnlyReview.status, "failed");
  assert.equal(providerOnlyReview.errors[0].code, "supervisor.review.provider_required");
});

test("runtime_verify records skipped supervisor review when final review is not required", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-phase7-supervisor-skip-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "plan only: skip low risk supervisor verification" },
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
          },
        },
      }
    );

    assert.equal(verification.status, "skipped");
    assert.equal(verification.supervisorReview.status, "skipped");
    assert.equal(verification.supervisorReview.required, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime_verify fails required supervisor review without configured provider", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-phase7-supervisor-required-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "plan only: require supervisor verification" },
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
            final_review: {
              enabled: true,
              requiredForRisk: ["low"],
            },
          },
        },
      }
    );

    assert.equal(verification.status, "failed");
    assert.equal(verification.supervisorReview.status, "failed");
    assert.equal(verification.supervisorReview.required, true);
    assert.equal(verification.supervisorReview.errors[0].code, "supervisor.review.provider_required");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime_verify records provider-backed final supervisor review", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-phase7-supervisor-provider-"));
  const store = new FileExecutionStore({ workspace });
  const server = await startJsonServer(async ({ body }) => ({
    status: 200,
    body: {
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              status: "passed",
              summary: "Requirements align with verification evidence.",
              requirementAlignment: "aligned",
              diffRisk: "low",
              verificationEvidence: "Command checks were skipped, supervisor evidence passed.",
              blockingIssues: [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: body.messages?.[0]?.content?.length ?? 1, completion_tokens: 10 },
    },
  }));

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "plan only: provider backed supervisor review" },
      { store }
    );
    const verification = await callRuntimeTool(
      "runtime_verify",
      { runId: run.runId },
      {
        store,
        runtimeOptions: {
          providers: {
            retryPolicy: { maxRetries: 0 },
            entries: {
              "openai-compatible": {
                type: "openai-compatible",
                baseUrl: server.url,
                apiKey: "test-key",
                defaultModel: "gpt-test",
                models: ["gpt-test"],
              },
            },
          },
          verification: {
            diff_check: { enabled: false },
            final_review: {
              enabled: true,
              requiredForRisk: ["low"],
              provider: "openai-compatible",
              model: "gpt-test",
            },
          },
        },
      }
    );
    const updated = await store.readRecord(run.runId);

    assert.equal(verification.status, "passed");
    assert.equal(verification.supervisorReview.status, "passed");
    assert.equal(verification.supervisorReview.summary, "Requirements align with verification evidence.");
    assert.equal(updated.modelCalls.length, 1);
    assert.equal(updated.modelCalls[0].provider, "openai-compatible");
  } finally {
    await server.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime_verify omits structured response schema for openai-compatible final supervisor review requests", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-phase7-supervisor-schema-"));
  const store = new FileExecutionStore({ workspace });
  let seenBody = null;
  const server = await startJsonServer(async ({ body }) => {
    seenBody = body;
    return {
      status: 200,
      body: {
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                status: "passed",
                summary: "OpenAI-compatible final review returned valid JSON text.",
                requirementAlignment: "aligned",
                diffRisk: "low",
                verificationEvidence: "Supervisor prompt was sufficient without response_format.",
                blockingIssues: [],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    };
  });

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "plan only: openai-compatible supervisor schema handling" },
      { store }
    );

    const verification = await callRuntimeTool(
      "runtime_verify",
      { runId: run.runId },
      {
        store,
        runtimeOptions: {
          providers: {
            retryPolicy: { maxRetries: 0 },
            entries: {
              "openai-compatible": {
                type: "openai-compatible",
                baseUrl: server.url,
                apiKey: "test-key",
                defaultModel: "gpt-test",
                models: ["gpt-test"],
              },
            },
          },
          verification: {
            diff_check: { enabled: false },
            final_review: {
              enabled: true,
              requiredForRisk: ["low"],
              provider: "openai-compatible",
              model: "gpt-test",
            },
          },
        },
      }
    );

    assert.equal(verification.status, "passed");
    assert.equal(verification.supervisorReview.status, "passed");
    assert.ok(seenBody);
    assert.equal(seenBody.response_format, undefined);
  } finally {
    await server.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime_verify includes supervisor review time in verification duration", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-phase7-supervisor-duration-"));
  const store = new FileExecutionStore({ workspace });
  const server = await startJsonServer(async () => {
    await delay(80);
    return {
      status: 200,
      body: {
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                status: "passed",
                summary: "Delayed review still passed.",
                requirementAlignment: "aligned",
                diffRisk: "low",
                verificationEvidence: "Supervisor delay was part of verification.",
                blockingIssues: [],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    };
  });

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "plan only: delayed supervisor verification" },
      { store }
    );
    const verification = await callRuntimeTool(
      "runtime_verify",
      { runId: run.runId },
      {
        store,
        runtimeOptions: {
          providers: {
            retryPolicy: { maxRetries: 0 },
            entries: {
              "openai-compatible": {
                type: "openai-compatible",
                baseUrl: server.url,
                apiKey: "test-key",
                defaultModel: "gpt-test",
                models: ["gpt-test"],
              },
            },
          },
          verification: {
            diff_check: { enabled: false },
            final_review: {
              enabled: true,
              requiredForRisk: ["low"],
              provider: "openai-compatible",
              model: "gpt-test",
            },
          },
        },
      }
    );

    assert.equal(verification.status, "passed");
    assert.ok(verification.durationMs >= 50, `durationMs was ${verification.durationMs}`);
  } finally {
    await server.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime_verify records escalation after failed verification from standard worker attempt", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-phase7-escalation-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "plan only: escalate failed verification" },
      { store }
    );
    const record = await store.readRecord(run.runId);
    const task = record.plan.tasks[0];

    await store.updateRecord(run.runId, (current) => {
      current.plan.tasks[0].modelTier = "standard";
      current.plan.tasks[0].model_tier = "standard";
      current.workerAttempts.push({
        attemptId: "attempt_T-001_escalation",
        attempt_id: "attempt_T-001_escalation",
        taskId: task.task_id,
        task_id: task.task_id,
        status: "recorded",
        applied: false,
        acceptance: {},
      });
      return current;
    });

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
                name: "failing-required-command",
                command: process.execPath,
                args: ["-e", "process.exit(9)"],
                required: true,
              },
            ],
          },
        },
      }
    );
    const updated = await store.readRecord(run.runId);

    assert.deepEqual(verification.escalation, {
      required: true,
      reason: "verification_failed_after_non_premium_worker",
      fromTiers: ["standard"],
      from_tiers: ["standard"],
      targetTier: "premium",
      target_tier: "premium",
    });
    assert.ok(updated.events.some((event) => event.type === "verification.escalation.required"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime_report markdown separates Phase 7 verification sections", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-phase7-report-"));
  const store = new FileExecutionStore({ workspace });

  try {
    const run = await callRuntimeTool(
      "runtime_run",
      { request: "plan only: report phase 7 verification sections" },
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
          },
        },
      }
    );
    const markdown = await callRuntimeTool(
      "runtime_report",
      { runId: run.runId, format: "markdown" },
      { store }
    );

    assert.match(markdown.markdown, /Command Checks/);
    assert.match(markdown.markdown, /Acceptance Review/);
    assert.match(markdown.markdown, /Final Supervisor Review/);
    assert.match(markdown.markdown, /Escalation/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function startJsonServer(handler) {
  const server = createServer(async (request, response) => {
    let rawBody = "";
    for await (const chunk of request) {
      rawBody += chunk.toString("utf8");
    }

    const result = await handler({
      url: new URL(request.url, "http://127.0.0.1"),
      headers: request.headers,
      body: rawBody.trim() ? JSON.parse(rawBody) : {},
    });

    response.writeHead(result.status, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(result.body));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((closeResolve) => server.close(closeResolve)),
      });
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
