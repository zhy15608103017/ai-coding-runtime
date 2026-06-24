import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const cliPath = path.resolve("bin", "ai-coding-runtime.js");

test("run, status, and report commands use the same file-backed run", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-cli-"));

  try {
    const runResult = runCli(["run", "实现 V0 runtime 骨架", "--json"], workspace);
    assert.equal(runResult.status, 0, runResult.stderr);

    const runOutput = JSON.parse(runResult.stdout);
    assert.match(runOutput.runId, /^run_/);
    assert.equal(runOutput.status, "approval_required");
    assert.ok(runOutput.plan.tasks.length >= 5);

    const statusResult = runCli(["status", runOutput.runId, "--json"], workspace);
    assert.equal(statusResult.status, 0, statusResult.stderr);

    const statusOutput = JSON.parse(statusResult.stdout);
    assert.equal(statusOutput.runId, runOutput.runId);
    assert.equal(statusOutput.status, "approval_required");
    assert.equal(statusOutput.taskCount, runOutput.plan.tasks.length);

    const verifyBeforeApprovalResult = runCli(["verify", runOutput.runId, "--json"], workspace);
    assert.equal(verifyBeforeApprovalResult.status, 1);
    assert.match(verifyBeforeApprovalResult.stderr, /approval_required/);

    const approveResult = runCli(["approve", runOutput.runId, "--json"], workspace);
    assert.equal(approveResult.status, 0, approveResult.stderr);
    const approveOutput = JSON.parse(approveResult.stdout);
    assert.equal(approveOutput.runId, runOutput.runId);
    assert.equal(approveOutput.status, "approved");

    const reportResult = runCli(["report", runOutput.runId, "--markdown"], workspace);
    assert.equal(reportResult.status, 0, reportResult.stderr);
    assert.match(reportResult.stdout, /AI Coding Runtime Report/);
    assert.match(reportResult.stdout, /Budget/);
    assert.match(reportResult.stdout, /Routing Trace/);
    assert.match(reportResult.stdout, /实现 V0 runtime 骨架/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("worker-result command records and applies structured worker output", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-cli-worker-"));
  const project = path.join(workspace, "project");
  const runtimeHome = path.join(workspace, "runtime-data");

  try {
    await writeProjectFile(project, "src/app.js", "export const value = 1;\n");

    const runResult = runCli(
      ["run", "implement a safe worker patch from cli", "--json"],
      runtimeHome,
      project
    );
    assert.equal(runResult.status, 0, runResult.stderr);
    const runOutput = JSON.parse(runResult.stdout);
    const task = runOutput.plan.tasks.find((candidate) => candidate.task_id === "T-003");

    const approveResult = runCli(["approve", runOutput.runId, "--json"], runtimeHome, project);
    assert.equal(approveResult.status, 0, approveResult.stderr);

    const resultPath = path.join(project, "worker-result.json");
    await writeFile(
      resultPath,
      JSON.stringify(
        workerResultForTask(task, {
          patch: patchFor("src/app.js", "export const value = 1;", "export const value = 2;"),
        }),
        null,
        2
      ),
      "utf8"
    );

    const workerResult = runCli(
      [
        "worker-result",
        runOutput.runId,
        task.task_id,
        "--from-file",
        resultPath,
        "--apply",
        "--json",
      ],
      runtimeHome,
      project
    );
    assert.equal(workerResult.status, 0, workerResult.stderr);
    const submitted = JSON.parse(workerResult.stdout);
    assert.equal(submitted.status, "applied");
    assert.deepEqual(submitted.filesTouched, ["src/app.js"]);
    assert.equal(await readFile(path.join(project, "src/app.js"), "utf8"), "export const value = 2;\n");

    const reportResult = runCli(["report", runOutput.runId, "--markdown"], runtimeHome, project);
    assert.equal(reportResult.status, 0, reportResult.stderr);
    assert.match(reportResult.stdout, /Worker Attempts/);
    assert.match(reportResult.stdout, /src\/app\.js/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("start command launches a local HTTP health endpoint", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-server-"));
  const child = spawn(
    process.execPath,
    [cliPath, "start", "--host", "127.0.0.1", "--port", "0", "--json"],
    {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        AI_CODING_RUNTIME_HOME: workspace,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  try {
    const firstLine = await readFirstStdoutLine(child);
    const started = JSON.parse(firstLine);
    assert.equal(started.status, "started");
    assert.match(started.httpUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

    const response = await fetch(`${started.httpUrl}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ok",
      service: "ai-coding-runtime",
    });
  } finally {
    child.kill("SIGTERM");
    await rm(workspace, { recursive: true, force: true });
  }
});

test("mcp command serves runtime tools over stdio JSON-RPC", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-mcp-cli-"));
  const child = spawn(process.execPath, [cliPath, "mcp"], {
    cwd: workspace,
    env: {
      ...process.env,
      AI_CODING_RUNTIME_HOME: workspace,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const childExit = new Promise((resolve) => child.once("exit", resolve));

  try {
    const initializedLine = readFirstStdoutLine(child);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "cli-test", version: "0.0.0" },
        },
      })}\n`
    );
    const initialized = JSON.parse(await initializedLine);
    assert.equal(initialized.id, 1);
    assert.equal(initialized.result.protocolVersion, "2025-06-18");

    const listedLine = readFirstStdoutLine(child);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      })}\n`
    );
    const listed = JSON.parse(await listedLine);
    assert.equal(listed.id, 2);
    assert.ok(listed.result.tools.some((tool) => tool.name === "runtime_plan"));

    const calledLine = readFirstStdoutLine(child);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "runtime_plan",
          arguments: {
            request: "stdio mcp plan",
          },
        },
      })}\n`
    );
    const called = JSON.parse(await calledLine);
    assert.equal(called.id, 3);
    assert.match(called.result.structuredContent.planId, /^plan_/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await childExit;
    }
    await rm(workspace, { recursive: true, force: true });
  }
});

test("provider-health and generate commands use provider adapters", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-provider-cli-"));

  try {
    const healthResult = runCli(["provider-health", "local", "--json"], workspace);
    assert.equal(healthResult.status, 0, healthResult.stderr);
    const health = JSON.parse(healthResult.stdout);
    assert.equal(health.providers.length, 1);
    assert.equal(health.providers[0].status, "placeholder");

    const generateResult = runCli(
      ["generate", "hello provider", "--provider", "local", "--json"],
      workspace
    );
    assert.equal(generateResult.status, 0, generateResult.stderr);
    const generated = JSON.parse(generateResult.stdout);
    assert.equal(generated.provider, "local");
    assert.match(generated.text, /hello provider/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("execute command runs explicit execution loop without verification", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-cli-execute-"));

  try {
    const runResult = runCli(
      ["run", "plan only: inspect files without modifying files", "--json"],
      workspace,
      workspace
    );
    assert.equal(runResult.status, 0, runResult.stderr);
    const runOutput = JSON.parse(runResult.stdout);
    assert.equal(runOutput.status, "planned");

    const executeResult = runCli(
      ["execute", runOutput.runId, "--no-apply", "--no-verify", "--json"],
      workspace,
      workspace
    );
    assert.equal(executeResult.status, 0, executeResult.stderr);
    const executed = JSON.parse(executeResult.stdout);
    assert.equal(executed.runId, runOutput.runId);
    assert.equal(executed.status, "verification_skipped");
    assert.equal(executed.executedTasks.length, 0);
    assert.ok(executed.skippedTasks.length > 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("verify command runs configured verification commands", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-cli-verify-"));

  try {
    await writeFile(
      path.join(workspace, "runtime.config.json"),
      JSON.stringify(
        {
          verification: {
            diff_check: { enabled: false },
            commands: [
              {
                name: "node-version",
                command: process.execPath,
                args: ["--version"],
                required: true,
                timeoutMs: 10000,
              },
            ],
          },
        },
        null,
        2
      )
    );

    const runResult = runCli(
      ["run", "plan only: verify from cli without modifying files", "--json"],
      workspace,
      workspace
    );
    assert.equal(runResult.status, 0, runResult.stderr);
    const runOutput = JSON.parse(runResult.stdout);
    assert.equal(runOutput.status, "planned");

    const verifyResult = runCli(["verify", runOutput.runId, "--json"], workspace, workspace);
    assert.equal(verifyResult.status, 0, verifyResult.stderr);
    const verification = JSON.parse(verifyResult.stdout);
    assert.equal(verification.status, "passed");
    assert.equal(verification.commands.length, 1);
    assert.equal(verification.commands[0].name, "node-version");
    assert.equal(verification.commands[0].exitCode, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("verify command exits nonzero when a required verification command fails", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ai-runtime-cli-verify-fail-"));

  try {
    await writeFile(
      path.join(workspace, "runtime.config.json"),
      JSON.stringify(
        {
          verification: {
            diff_check: { enabled: false },
            commands: [
              {
                name: "failing-required-command",
                command: process.execPath,
                args: ["-e", "process.exit(42)"],
                required: true,
                timeoutMs: 10000,
              },
            ],
          },
        },
        null,
        2
      )
    );

    const runResult = runCli(
      ["run", "plan only: verify failure exit code from cli", "--json"],
      workspace,
      workspace
    );
    assert.equal(runResult.status, 0, runResult.stderr);
    const runOutput = JSON.parse(runResult.stdout);
    assert.equal(runOutput.status, "planned");

    const verifyResult = runCli(["verify", runOutput.runId, "--json"], workspace, workspace);
    assert.equal(verifyResult.status, 1, verifyResult.stderr);
    const verification = JSON.parse(verifyResult.stdout);
    assert.equal(verification.status, "failed");
    assert.equal(verification.commands.length, 1);
    assert.equal(verification.commands[0].name, "failing-required-command");
    assert.equal(verification.commands[0].status, "failed");
    assert.equal(verification.commands[0].exitCode, 42);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function runCli(args, workspace, cwd = path.resolve(".")) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: {
      ...process.env,
      AI_CODING_RUNTIME_HOME: workspace,
    },
    encoding: "utf8",
  });
}

function readFirstStdoutLine(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for server start. stderr: ${stderr}`));
    }, 5000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      const newlineIndex = stdout.indexOf("\n");
      if (newlineIndex !== -1) {
        clearTimeout(timeout);
        resolve(stdout.slice(0, newlineIndex));
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Server exited with ${code}. stderr: ${stderr}`));
      }
    });
  });
}

function workerResultForTask(task, overrides = {}) {
  return {
    patch: overrides.patch,
    explanation: "Updated an allowed implementation file.",
    verificationNotes: ["Validated through CLI worker-result command."],
    confidence: 0.8,
    filesTouched: overrides.filesTouched ?? ["src/app.js"],
    acceptance: Object.fromEntries(
      task.acceptance.map((item) => [item, `Evidence for ${item}`])
    ),
  };
}

function patchFor(filePath, before, after) {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    "@@ -1 +1 @@",
    `-${before}`,
    `+${after}`,
    "",
  ].join("\n");
}

async function writeProjectFile(workspace, relativePath, content) {
  const filePath = path.join(workspace, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}
