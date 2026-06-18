import {
  callRuntimeTool,
  createReport,
  createRuntimePlan,
  FileExecutionStore,
  formatReportMarkdown,
  loadRuntimeConfig,
} from "./index.js";
import { startMcpStdioServer } from "./mcp.js";
import { createRuntimeHttpServer, listen, summarizeRecord } from "./server.js";

export async function runCli(argv, io = process) {
  const [command, ...rest] = argv;

  try {
    switch (command) {
      case "run":
        return await runCommand(rest, io);
      case "status":
        return await statusCommand(rest, io);
      case "report":
        return await reportCommand(rest, io);
      case "approve":
        return await approveCommand(rest, io);
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
  const plan = createRuntimePlan({ request, ...runtimeOptionsFromConfig(config) });
  const record = await store.createRecord(plan);
  const output = {
    runId: record.runId,
    status: record.status,
    plan: record.plan,
  };

  if (options.json) {
    io.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    io.stdout.write(`Created run ${record.runId} (${record.status})\n`);
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

async function reportCommand(args, io) {
  const { positional, options } = parseArgs(args);
  const [runId] = positional;

  if (!runId) {
    throw new Error("report requires a run id.");
  }

  const config = await loadRuntimeConfig();
  const store = new FileExecutionStore({ workspace: config.storage.directory });
  const record = await store.readRecord(runId);
  const report = createReport(record);

  if (options.json && !options.markdown) {
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    io.stdout.write(formatReportMarkdown(report));
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
    modelRegistry: config.routing.modelRegistry,
    routingPolicy: {
      ...(config.routing.policy ?? {}),
      finalVerificationTier: config.routing.finalVerificationTier,
    },
    budgetPolicy: config.routing.budgetPolicy,
    escalationPolicy: config.routing.escalationPolicy,
    policyViolations: config.routing.policyViolations,
    providers: config.providers,
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
  ai-coding-runtime approve <run-id> [--json]
  ai-coding-runtime report <run-id> [--json|--markdown]
  ai-coding-runtime provider-health [provider] [--json]
  ai-coding-runtime generate "<prompt>" [--provider name] [--model model] [--run-id run-id] [--json]
`;
}
