import { spawn } from "node:child_process";

import { evaluateCommandPolicy } from "./policy.js";

export function buildVerificationCommands(config = {}) {
  const commands = [];

  if (config.diff_check?.enabled !== false) {
    commands.push({
      name: "git-diff-check",
      command: "git",
      args: ["diff", "--check"],
      required: config.diff_check?.required !== false,
      timeoutMs: config.diff_check?.timeoutMs,
      source: "diff_check",
    });
  }

  for (const [source, fallbackName] of [
    ["test", "test"],
    ["lint", "lint"],
    ["typecheck", "typecheck"],
  ]) {
    const command = normalizeConfiguredCommand(config[source], source, fallbackName);
    if (command) commands.push(command);
  }

  for (const command of configuredCommandList(config.custom_commands)) {
    const normalized = normalizeConfiguredCommand(command, "custom_commands", command.name);
    if (normalized) commands.push(normalized);
  }

  for (const command of configuredCommandList(config.commands)) {
    const normalized = normalizeConfiguredCommand(command, "commands", command.name);
    if (normalized) commands.push(normalized);
  }

  return commands;
}

export async function runVerificationCommands({ commands = [], cwd = process.cwd() } = {}) {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const normalizedCommands = Array.isArray(commands) ? commands : [];
  const results = [];

  for (const command of normalizedCommands) {
    results.push(await runVerificationCommand(command, { cwd }));
  }

  const finishedAtMs = Date.now();
  const failedRequired = results.some(
    (result) => result.required && result.status !== "passed"
  );
  const status =
    results.length === 0 ? "skipped" : failedRequired ? "failed" : "passed";

  return {
    status,
    message: verificationMessage(status),
    commands: results,
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
  };
}

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

function configuredCommandList(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeConfiguredCommand(config, source, fallbackName) {
  if (!config || config.enabled === false) return null;
  return {
    name: config.name ?? fallbackName,
    command: config.command,
    args: Array.isArray(config.args) ? config.args : [],
    required: config.required !== false,
    timeoutMs: config.timeoutMs,
    source,
  };
}

function runVerificationCommand(config = {}, { cwd }) {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const command = typeof config.command === "string" ? config.command : "";
  const args = Array.isArray(config.args) ? config.args.map(String) : [];
  const required = config.required !== false;
  const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : undefined;
  const baseResult = {
    name: config.name ?? command,
    command,
    args,
    required,
    timeoutMs,
    timeout_ms: timeoutMs,
    status: "failed",
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    startedAt,
    finishedAt: null,
    durationMs: 0,
  };

  if (!command) {
    return Promise.resolve(
      finishCommand(baseResult, startedAtMs, {
        error: {
          code: "verification.command.required",
          message: "Verification command is required.",
        },
      })
    );
  }

  if (config.policyBlocked) {
    return Promise.resolve(
      finishCommand(baseResult, startedAtMs, {
        error: config.policyViolations?.[0] ?? {
          code: "policy.command.not_allowed",
          message: "Command is blocked by policy.",
        },
        policyViolations: config.policyViolations ?? [],
        policy_violations: config.policy_violations ?? config.policyViolations ?? [],
      })
    );
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError = null;
    let settled = false;
    let timeout = null;
    let timeoutFallback = null;
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
    });

    const resolveOnce = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(timeoutFallback);
      resolve(result);
    };

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
        timeoutFallback = setTimeout(() => {
          resolveOnce(
            finishCommand(baseResult, startedAtMs, {
              stdout,
              stderr,
              timedOut,
              error: {
                code: "verification.command.timeout",
                message: `Verification command timed out after ${timeoutMs}ms.`,
              },
            })
          );
        }, 1000);
      }, timeoutMs);
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      spawnError = {
        code: error.code ?? "verification.command.error",
        message: error.message,
      };
    });
    child.on("close", (exitCode, signal) => {
      resolveOnce(
        finishCommand(baseResult, startedAtMs, {
          exitCode,
          signal,
          stdout,
          stderr,
          timedOut,
          error:
            spawnError ??
            (timedOut
              ? {
                  code: "verification.command.timeout",
                  message: `Verification command timed out after ${timeoutMs}ms.`,
                }
              : undefined),
        })
      );
    });
  });
}

function finishCommand(baseResult, startedAtMs, updates = {}) {
  const finishedAtMs = Date.now();
  const exitCode =
    updates.exitCode === undefined ? baseResult.exitCode : updates.exitCode;
  const timedOut = updates.timedOut === true;
  const status = !timedOut && exitCode === 0 ? "passed" : "failed";

  return {
    ...baseResult,
    ...updates,
    status,
    exitCode,
    timedOut,
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
  };
}

function verificationMessage(status) {
  if (status === "passed") {
    return "Verification commands passed.";
  }

  if (status === "failed") {
    return "Required verification command failed.";
  }

  return "No verification commands configured.";
}
