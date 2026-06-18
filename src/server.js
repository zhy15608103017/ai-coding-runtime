import { createServer } from "node:http";

import { createReport, createRuntimePlan, FileExecutionStore, formatReportMarkdown } from "./index.js";

export function createRuntimeHttpServer({ store = new FileExecutionStore() } = {}) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/api/health") {
        return sendJson(response, 200, {
          status: "ok",
          service: "ai-coding-runtime",
        });
      }

      if (request.method === "POST" && url.pathname === "/api/plan") {
        const body = await readJsonBody(request);
        const plan = createRuntimePlan({ request: body.request });
        return sendJson(response, 200, plan);
      }

      if (request.method === "POST" && url.pathname === "/api/runs") {
        const body = await readJsonBody(request);
        const plan = createRuntimePlan({ request: body.request });
        const record = await store.createRecord(plan);
        return sendJson(response, 201, {
          runId: record.runId,
          status: record.status,
          plan: record.plan,
        });
      }

      const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (request.method === "GET" && runMatch) {
        const record = await store.readRecord(runMatch[1]);
        return sendJson(response, 200, summarizeRecord(record));
      }

      const reportMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/report$/);
      if (request.method === "GET" && reportMatch) {
        const record = await store.readRecord(reportMatch[1]);
        const report = createReport(record);

        if (url.searchParams.get("format") === "markdown") {
          return sendText(response, 200, formatReportMarkdown(report), "text/markdown; charset=utf-8");
        }

        return sendJson(response, 200, report);
      }

      if (request.method === "GET" && url.pathname === "/mcp") {
        return sendJson(response, 200, {
          service: "ai-coding-runtime",
          status: "placeholder",
          note: "V0 exposes HTTP health and run APIs. Full MCP tools are planned for Phase 2.",
        });
      }

      return sendJson(response, 404, {
        error: "not_found",
        message: `${request.method} ${url.pathname} is not implemented.`,
      });
    } catch (error) {
      return sendJson(response, 500, {
        error: "runtime_error",
        message: error.message,
      });
    }
  });
}

export function listen(server, { host = "127.0.0.1", port = 3847 } = {}) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      resolve({
        host,
        port: address.port,
        httpUrl: `http://${host}:${address.port}`,
        mcpUrl: `http://${host}:${address.port}/mcp`,
      });
    });
  });
}

export function summarizeRecord(record) {
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

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value)}\n`);
}

function sendText(response, statusCode, value, contentType) {
  response.writeHead(statusCode, { "content-type": contentType });
  response.end(value);
}

async function readJsonBody(request) {
  let rawBody = "";

  for await (const chunk of request) {
    rawBody += chunk.toString("utf8");
  }

  if (rawBody.trim().length === 0) {
    return {};
  }

  return JSON.parse(rawBody);
}

