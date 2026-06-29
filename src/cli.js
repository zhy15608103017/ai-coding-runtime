import {
  callRuntimeTool,
  createReport,
  FileExecutionStore,
  formatReportMarkdown,
  loadRuntimeConfig,
} from "./index.js";
import { readFile, writeFile } from "node:fs/promises";
import { startMcpStdioServer } from "./mcp.js";
import { createRoutingHistorySnapshot, importRoutingHistorySnapshot } from "./runtime/history.js";
import { createRuntimeHttpServer, listen, summarizeRecord } from "./server.js";

export async function runCli(argv, io = process) {
  const [command, ...rest] = argv;

  try {
    switch (command) {
      case "run":
        return await runCommand(rest, io);
      case "status":
        return await statusCommand(rest, io);
      case "inspect":
        return await inspectCommand(rest, io);
      case "verify":
        return await verifyCommand(rest, io);
      case "execute":
        return await executeCommand(rest, io);
      case "report":
        return await reportCommand(rest, io);
      case "dashboard":
        return await dashboardCommand(rest, io);
      case "audit":
        return await auditCommand(rest, io);
      case "history":
        return await historyCommand(rest, io);
      case "approve":
        return await approveCommand(rest, io);
      case "worker-result":
        return await workerResultCommand(rest, io);
      case "provider-health":
        return await providerHealthCommand(rest, io);
      case "generate":
        return await generateCommand(rest, io);
      case "start":
        return await startCommand(rest, io);
      case "mcp":
        return await mcpCommand(io);
      case "help":
      case "--help":
      case "-h":
      case undefined:
        io.stdout.write(helpText());
        return 0;
      default:
        io.stderr.write(`Unknown command: ${command}\n\n${helpText()}`);
        return 1;
    }
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    return 1;
  }
}

async function runCommand(args, io) {
  const { positional, options } = parseArgs(args);
  const request = positional.join(" ").trim();

  if (!request) {
    throw new Error("run requires a request string.");
  }

  const config = await loadRuntimeConfig();
  const store = new FileExecutionStore({ workspace: config.storage.directory });
  const output = await callRuntimeTool(
    "runtime_run",
    { request },
    { store, runtimeOptions: runtimeOptionsFromConfig(config) }
  );

  if (options.json) {
    io.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    io.stdout.write(`Created run ${output.runId} (${output.status})\n`);
  }

  return 0;
}

async function statusCommand(args, io) {
  const { positional, options } = parseArgs(args);
  const [runId] = positional;

  if (!runId) {
    throw new Error("status requires a run id.");
  }

  const config = await loadRuntimeConfig();
  const store = new FileExecutionStore({ workspace: config.storage.directory });
  const record = await store.readRecord(runId);
  const summary = summarizeRecord(record);

  if (options.json) {
    io.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    io.stdout.write(`${summary.runId}: ${summary.status} (${summary.taskCount} tasks)\n`);
  }

  return 0;
}

async function verifyCommand(args, io) {
  const { positional, options } = parseArgs(args);
  const [runId] = positional;

  if (!runId) {
    throw new Error("verify requires a run id.");
  }

  const config = await loadRuntimeConfig();
  const store = new FileExecutionStore({ workspace: config.storage.directory });
  const verification = await callRuntimeTool(
    "runtime_verify",
    { runId },
    { store, runtimeOptions: runtimeOptionsFromConfig(config) }
  );

  if (options.json) {
    io.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
  } else {
    io.stdout.write(`${verification.runId}: verification ${verification.status}\n`);
  }

  return verification.status === "failed" ? 1 : 0;
}

async function executeCommand(args, io) {
  const { positional, options } = parseArgs(args);
  const [runId] = positional;

  if (!runId) {
    throw new Error("execute requires a run id.");
  }

  const config = await loadRuntimeConfig();
  const store = new FileExecutionStore({ workspace: config.storage.directory });
  const executed = await callRuntimeTool(
    "runtime_execute",
    {
      runId,
      apply: options.noApply === true ? false : true,
      verify: options.noVerify === true ? false : true,
    },
    { store, runtimeOptions: runtimeOptionsFromConfig(config) }
  );

  if (options.json) {
    io.stdout.write(`${JSON.stringify(executed, null, 2)}\n`);
  } else {
    io.stdout.write(
      `${executed.runId}: execute ${executed.status} (${executed.executedTasks.length} executed, ${executed.skippedTasks.length} skipped)\n`
    );
  }

  return executed.status === "failed" || executed.status === "verification_failed" ? 1 : 0;
}

async function reportCommand(args, io) {
  const { positional, options } = parseArgs(args);
  const [runId] = positional;

  if (!runId) {
    throw new Error("report requires a run id.");
  }

  const config = await loadRuntimeConfig();
  const store = new FileExecutionStore({ workspace: config.storage.directory });
  const record = await store.readRecord(runId);
  const historyRecords = await store.listRecords();
  const importedHistoryRecords =
    typeof store.listImportedLearningRecords === "function"
      ? await store.listImportedLearningRecords()
      : [];
  const report = createReport(record, {
    historyRecords,
    importedHistoryRecords,
    policy: config.policy,
  });

  if (options.json && !options.markdown) {
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    io.stdout.write(formatReportMarkdown(report));
  }

  return 0;
}

async function dashboardCommand(args, io) {
  const { positional, options } = parseArgs(args);
  const [runId] = positional;

  if (!runId) {
    throw new Error("dashboard requires a run id.");
  }

  if (!options.out) {
    throw new Error("dashboard requires --out <file>.");
  }

  const config = await loadRuntimeConfig();
  const store = new FileExecutionStore({ workspace: config.storage.directory });
  const dashboard = await callRuntimeTool(
    "runtime_dashboard",
    { runId, out: options.out },
    { store, runtimeOptions: runtimeOptionsFromConfig(config) }
  );

  if (options.json) {
    io.stdout.write(`${JSON.stringify({ status: "ok", ...dashboard }, null, 2)}\n`);
  } else {
    io.stdout.write(`${dashboard.message}\n`);
  }

  return 0;
}

async function auditCommand(args, io) {
  const { positional } = parseArgs(args);
  const [runId] = positional;

  if (!runId) {
    throw new Error("audit requires a run id.");
  }

  const config = await loadRuntimeConfig();
  const store = new FileExecutionStore({ workspace: config.storage.directory });
  const audit = await callRuntimeTool(
    "runtime_audit",
    { runId },
    { store, runtimeOptions: runtimeOptionsFromConfig(config) }
  );
  io.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
  return 0;
}

async function inspectCommand(args, io) {
  const { positional, options } = parseArgs(args);
  const [runId] = positional;

  if (!runId) {
    throw new Error("inspect requires a run id.");
  }

  const config = await loadRuntimeConfig();
  const store = new FileExecutionStore({ workspace: config.storage.directory });
  const inspected = await callRuntimeTool(
    "runtime_inspect",
    {
      runId,
      format: options.json ? "json" : "markdown",
    },
    { store, runtimeOptions: runtimeOptionsFromConfig(config) }
  );

  if (options.json) {
    io.stdout.write(`${JSON.stringify(inspected, null, 2)}\n`);
  } else {
    io.stdout.write(inspected.markdown);
  }

  return 0;
}

async function historyCommand(args, io) {
  const [subcommand, ...rest] = args;

  if (subcommand === "export") {
    return historyExportCommand(rest, io);
  }

  if (subcommand === "import") {
    return historyImportCommand(rest, io);
  }

  throw new Error(
    "history requires export or import.\n" +
      "Usage:\n" +
      "  ai-coding-runtime history export <file> [--json]\n" +
      "  ai-coding-runtime history import <file> [--json]"
  );
}

async function historyExportCommand(args, io) {
  const { positional, options } = parseArgs(args);
  const [filePath] = positional;

  if (!filePath) {
    throw new Error("history export requires a file path.");
  }

  const config = await loadRuntimeConfig();
  const store = new FileExecutionStore({ workspace: config.storage.directory });
  const snapshot = createRoutingHistorySnapshot(await store.listRecords());
  await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  const output = {
    status: "ok",
    exported: snapshot.summary.recordsExported,
    skipped: snapshot.summary.recordsSkipped,
    path: filePath,
  };

  if (options.json) {
    io.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    io.stdout.write(
      `Exported ${output.exported} routing history record(s) to ${filePath}; skipped ${output.skipped}.\n`
    );
  }

  return 0;
}

async function historyImportCommand(args, io) {
  const { positional, options } = parseArgs(args);
  const [filePath] = positional;

  if (!filePath) {
    throw new Error("history import requires a file path.");
  }

  const config = await loadRuntimeConfig();
  const store = new FileExecutionStore({ workspace: config.storage.directory });
  const snapshot = JSON.parse(await readFile(filePath, "utf8"));
  const existingImportIds = new Set(
    (await store.listImportedLearningRecords()).map((record) => record.importId).filter(Boolean)
  );
  const prepared = importRoutingHistorySnapshot(snapshot, { existingImportIds });
  const written = await store.writeImportedLearningRecords(prepared.importedRecords);
  const output = {
    status: "ok",
    imported: written.imported,
    duplicates: prepared.duplicates + written.duplicates,
    rejected: prepared.rejected,
    path: filePath,
  };

  if (options.json) {
    io.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    io.stdout.write(
      `Imported ${output.imported} routing history record(s); skipped ${output.duplicates} duplicate; rejected ${output.rejected}.\n`
    );
  }

  return 0;
}

async function approveCommand(args, io) {
  const { positional, options } = parseArgs(args);
  const [runId] = positional;

  if (!runId) {
    throw new Error("approve requires a run id.");
  }

  const config = await loadRuntimeConfig();
  const store = new FileExecutionStore({ workspace: config.storage.directory });
  const approved = await callRuntimeTool(
    "runtime_approve",
    { runId, approvedBy: "cli", note: "approved through CLI" },
    { store }
  );

  if (options.json) {
    io.stdout.write(`${JSON.stringify(approved, null, 2)}\n`);
  } else {
    io.stdout.write(`${approved.runId}: ${approved.status}\n`);
  }

  return 0;
}

async function workerResultCommand(args, io) {
  const { positional, options } = parseArgs(args);
  const [runId, taskId] = positional;

  if (!runId) {
    throw new Error("worker-result requires a run id.");
  }

  if (!taskId) {
    throw new Error("worker-result requires a task id.");
  }

  if (!options.fromFile) {
    throw new Error("worker-result requires --from-file <path>.");
  }

  const config = await loadRuntimeConfig();
  const store = new FileExecutionStore({ workspace: config.storage.directory });
  const result = JSON.parse(await readFile(options.fromFile, "utf8"));
  const submitted = await callRuntimeTool(
    "runtime_submit_worker_result",
    {
      runId,
      taskId,
      apply: options.apply === true,
      result,
    },
    { store, runtimeOptions: runtimeOptionsFromConfig(config) }
  );

  if (options.json) {
    io.stdout.write(`${JSON.stringify(submitted, null, 2)}\n`);
  } else {
    io.stdout.write(`${submitted.runId}: worker result ${submitted.status} for ${submitted.taskId}\n`);
  }

  return 0;
}

async function providerHealthCommand(args, io) {
  const { positional, options } = parseArgs(args);
  const [provider] = positional;
  const config = await loadRuntimeConfig();
  const health = await callRuntimeTool(
    "runtime_provider_health",
    { provider },
    { runtimeOptions: runtimeOptionsFromConfig(config) }
  );

  if (options.json) {
    io.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
  } else {
    for (const item of health.providers) {
      io.stdout.write(`${item.name}: ${item.status} (${item.message})\n`);
    }
  }

  return 0;
}

async function generateCommand(args, io) {
  const { positional, options } = parseArgs(args);
  const prompt = positional.join(" ").trim();

  if (!prompt) {
    throw new Error("generate requires a prompt string.");
  }

  const config = await loadRuntimeConfig();
  const store = new FileExecutionStore({ workspace: config.storage.directory });
  const generated = await callRuntimeTool(
    "runtime_model_generate",
    {
      runId: options.runId,
      taskId: options.taskId,
      provider: options.provider,
      model: options.model,
      prompt,
      temperature: options.temperature === undefined ? undefined : Number(options.temperature),
      maxTokens: options.maxTokens === undefined ? undefined : Number(options.maxTokens),
      timeoutMs: options.timeoutMs === undefined ? undefined : Number(options.timeoutMs),
    },
    { store, runtimeOptions: runtimeOptionsFromConfig(config) }
  );

  if (options.json) {
    io.stdout.write(`${JSON.stringify(generated, null, 2)}\n`);
  } else {
    io.stdout.write(`${generated.text}\n`);
  }

  return 0;
}

async function startCommand(args, io) {
  const { options } = parseArgs(args);
  const config = await loadRuntimeConfig();
  const host = options.host ?? config.server.host;
  const port = options.port === undefined ? config.server.httpPort : Number(options.port);
  const store = new FileExecutionStore({ workspace: config.storage.directory });
  const server = createRuntimeHttpServer({
    store,
    apiToken: config.server.apiToken,
    runtimeOptions: runtimeOptionsFromConfig(config),
  });
  const started = await listen(server, { host, port });
  const output = {
    status: "started",
    ...started,
  };

  if (options.json) {
    io.stdout.write(`${JSON.stringify(output)}\n`);
  } else {
    io.stdout.write(`AI Coding Runtime started at ${started.httpUrl}\n`);
  }

  await waitForShutdown(server, io);
  return 0;
}

async function mcpCommand(io) {
  const config = await loadRuntimeConfig();
  const store = new FileExecutionStore({ workspace: config.storage.directory });
  await startMcpStdioServer({
    input: io.stdin,
    output: io.stdout,
    store,
    runtimeOptions: runtimeOptionsFromConfig(config),
  });
  return 0;
}

function runtimeOptionsFromConfig(config) {
  return {
    workspace: {
      cwd: process.cwd(),
    },
    modelRegistry: config.routing.modelRegistry,
    routingPolicy: {
      ...(config.routing.policy ?? {}),
      finalVerificationTier: config.routing.finalVerificationTier,
    },
    budgetPolicy: config.routing.budgetPolicy,
    escalationPolicy: config.routing.escalationPolicy,
    policyViolations: config.routing.policyViolations,
    policy: config.policy,
    policyExplicit: config.policyExplicit,
    policyValidation: config.policyValidation,
    planning: config.planning,
    providers: config.providers,
    execution: config.execution,
    verification: config.verification,
  };
}

function waitForShutdown(server, io) {
  return new Promise((resolve) => {
    const shutdown = () => {
      server.close(() => resolve());
    };

    io.once?.("SIGTERM", shutdown);
    io.once?.("SIGINT", shutdown);
  });
}

function parseArgs(args) {
  const positional = [];
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--markdown") {
      options.markdown = true;
    } else if (arg === "--host") {
      options.host = args[index + 1];
      index += 1;
    } else if (arg === "--port") {
      options.port = args[index + 1];
      index += 1;
    } else if (arg === "--provider") {
      options.provider = args[index + 1];
      index += 1;
    } else if (arg === "--model") {
      options.model = args[index + 1];
      index += 1;
    } else if (arg === "--run-id") {
      options.runId = args[index + 1];
      index += 1;
    } else if (arg === "--task-id") {
      options.taskId = args[index + 1];
      index += 1;
    } else if (arg === "--from-file") {
      options.fromFile = args[index + 1];
      index += 1;
    } else if (arg === "--out") {
      options.out = args[index + 1];
      index += 1;
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--no-apply") {
      options.noApply = true;
    } else if (arg === "--no-verify") {
      options.noVerify = true;
    } else if (arg === "--temperature") {
      options.temperature = args[index + 1];
      index += 1;
    } else if (arg === "--max-tokens") {
      options.maxTokens = args[index + 1];
      index += 1;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = args[index + 1];
      index += 1;
    } else {
      positional.push(arg);
    }
  }

  return { positional, options };
}

function helpText() {
  return `AI Coding Runtime V0

Usage:
  ai-coding-runtime start [--host 127.0.0.1] [--port 3847] [--json]
  ai-coding-runtime mcp
  ai-coding-runtime run "<request>" [--json]
  ai-coding-runtime status <run-id> [--json]
  ai-coding-runtime inspect <run-id> [--json]
  ai-coding-runtime execute <run-id> [--no-apply] [--no-verify] [--json]
  ai-coding-runtime verify <run-id> [--json]
  ai-coding-runtime approve <run-id> [--json]
  ai-coding-runtime worker-result <run-id> <task-id> --from-file result.json [--apply] [--json]
  ai-coding-runtime report <run-id> [--json|--markdown]
  ai-coding-runtime dashboard <run-id> --out dashboard.html [--json]
  ai-coding-runtime audit <run-id> --json
  ai-coding-runtime history export <file> [--json]
  ai-coding-runtime history import <file> [--json]
  ai-coding-runtime provider-health [provider] [--json]
  ai-coding-runtime generate "<prompt>" [--provider name] [--model model] [--run-id run-id] [--task-id task-id] [--json]
`;
}
