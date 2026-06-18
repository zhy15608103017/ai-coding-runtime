import { createRuntimePlan } from "./planner.js";
import { createReport, formatReportMarkdown } from "./report.js";

export const RUNTIME_TOOLS = [
  {
    name: "runtime_plan",
    description: "Create a task plan without creating a persisted run.",
    inputSchema: requestSchema(),
  },
  {
    name: "runtime_estimate",
    description: "Estimate task difficulty, risk, and model routing tiers.",
    inputSchema: requestSchema(),
  },
  {
    name: "runtime_run",
    description: "Create a persisted runtime run from a request.",
    inputSchema: requestSchema(),
  },
  {
    name: "runtime_status",
    description: "Return the current status for a runtime run.",
    inputSchema: runIdSchema(),
  },
  {
    name: "runtime_collect",
    description: "Collect intermediate artifacts, events, and task outputs for a run.",
    inputSchema: runIdSchema(),
  },
  {
    name: "runtime_verify",
    description: "Run or record verification for a runtime run.",
    inputSchema: runIdSchema(),
  },
  {
    name: "runtime_report",
    description: "Return the final run report as JSON or Markdown.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        format: { type: "string", enum: ["json", "markdown"] },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "runtime_cancel",
    description: "Cancel a runtime run and record the reason.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },
];

export async function callRuntimeTool(name, args, { store }) {
  switch (name) {
    case "runtime_plan":
      return createRuntimePlan({ request: requireRequest(args) });
    case "runtime_estimate":
      return createEstimate(requireRequest(args));
    case "runtime_run":
      return createRun(requireRequest(args), store);
    case "runtime_status":
      return readStatus(requireRunId(args), store);
    case "runtime_collect":
      return collectRun(requireRunId(args), store);
    case "runtime_verify":
      return verifyRun(requireRunId(args), store);
    case "runtime_report":
      return reportRun(requireRunId(args), args, store);
    case "runtime_cancel":
      return cancelRun(requireRunId(args), args, store);
    default:
      throw new Error(`Unknown runtime tool: ${name}`);
  }
}

export function asMcpToolResult(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);

  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    structuredContent: value,
  };
}

function createEstimate(request) {
  const plan = createRuntimePlan({ request });

  return {
    request,
    modelTiers: plan.modelTiers,
    estimatedCost: plan.estimatedCost,
    approvalRequired: plan.approvalRequired,
    riskSummary: plan.riskSummary,
    tasks: plan.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      difficulty: task.difficulty,
      risk: task.risk,
      contextNeed: task.contextNeed,
      verification: task.verification,
      modelTier: task.modelTier,
      routingReason: task.routingReason,
    })),
  };
}

async function createRun(request, store) {
  const plan = createRuntimePlan({ request });
  const record = await store.createRecord(plan);

  return {
    runId: record.runId,
    status: record.status,
    plan: record.plan,
  };
}

async function readStatus(runId, store) {
  const record = await store.readRecord(runId);
  return summarizeRecord(record);
}

async function collectRun(runId, store) {
  const record = await store.readRecord(runId);

  return {
    runId: record.runId,
    status: record.status,
    tasks: record.plan.tasks,
    events: record.events,
    verification: record.verification,
  };
}

async function verifyRun(runId, store) {
  const verification = {
    runId,
    status: "skipped",
    message: "V0 records verification intent but does not execute verification commands yet.",
  };

  await store.updateRecord(runId, (record) => {
    record.verification.push({
      name: "v0-verification",
      status: verification.status,
      message: verification.message,
    });
    record.events.push({
      type: "verification.finished",
      timestamp: new Date().toISOString(),
      status: verification.status,
      message: verification.message,
    });
    return record;
  });

  return verification;
}

async function reportRun(runId, args, store) {
  const record = await store.readRecord(runId);
  const report = createReport(record);

  if (args?.format === "markdown") {
    return {
      runId,
      format: "markdown",
      markdown: formatReportMarkdown(report),
    };
  }

  return report;
}

async function cancelRun(runId, args, store) {
  const reason = args?.reason ?? "canceled by user";
  const record = await store.updateRecord(runId, (current) => {
    current.status = "canceled";
    current.events.push({
      type: "run.canceled",
      timestamp: new Date().toISOString(),
      reason,
    });
    return current;
  });

  return summarizeRecord(record);
}

function summarizeRecord(record) {
  return {
    runId: record.runId,
    status: record.status,
    request: record.request,
    taskCount: record.plan.tasks.length,
    eventCount: record.events.length,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function requireRequest(args) {
  if (!args?.request || typeof args.request !== "string" || args.request.trim().length === 0) {
    throw new Error("request is required.");
  }

  return args.request.trim();
}

function requireRunId(args) {
  if (!args?.runId || typeof args.runId !== "string" || args.runId.trim().length === 0) {
    throw new Error("runId is required.");
  }

  return args.runId.trim();
}

function requestSchema() {
  return {
    type: "object",
    properties: {
      request: { type: "string" },
    },
    required: ["request"],
    additionalProperties: false,
  };
}

function runIdSchema() {
  return {
    type: "object",
    properties: {
      runId: { type: "string" },
    },
    required: ["runId"],
    additionalProperties: false,
  };
}
