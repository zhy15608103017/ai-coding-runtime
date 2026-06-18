import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
    cwd: path.resolve("."),
    env: {
      ...process.env,
      AI_CODING_RUNTIME_HOME: workspace,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
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
    const initialized = JSON.parse(await readFirstStdoutLine(child));
    assert.equal(initialized.id, 1);
    assert.equal(initialized.result.protocolVersion, "2025-06-18");

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      })}\n`
    );
    const listed = JSON.parse(await readFirstStdoutLine(child));
    assert.equal(listed.id, 2);
    assert.ok(listed.result.tools.some((tool) => tool.name === "runtime_plan"));

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
    const called = JSON.parse(await readFirstStdoutLine(child));
    assert.equal(called.id, 3);
    assert.match(called.result.structuredContent.planId, /^plan_/);
  } finally {
    child.kill("SIGTERM");
    await rm(workspace, { recursive: true, force: true });
  }
});

function runCli(args, workspace) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: path.resolve("."),
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
