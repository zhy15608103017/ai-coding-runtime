import { createServer } from "node:http";

import { createReport, FileExecutionStore, formatReportMarkdown } from "./index.js";
import { handleMcpJsonRpc } from "./mcp.js";
import { callRuntimeTool } from "./runtime/tools.js";

export function createRuntimeHttpServer({
  store = new FileExecutionStore(),
  apiToken = null,
  runtimeOptions = {},
} = {}) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/api/health") {
        return sendJson(response, 200, {
          status: "ok",
          service: "ai-coding-runtime",
        });
      }

      if (!isAuthorized(request, apiToken)) {
        return sendJson(response, 401, {
          error: "unauthorized",
          message: "Authorization bearer token is required.",
        });
      }

      if (request.method === "POST" && url.pathname === "/api/plan") {
        const body = await readJsonBody(request);
        const plan = await callRuntimeTool("runtime_plan", body, { store, runtimeOptions });
        return sendJson(response, 200, plan);
      }

      if (request.method === "POST" && url.pathname === "/api/estimate") {
        const body = await readJsonBody(request);
        const estimate = await callRuntimeTool("runtime_estimate", body, { store, runtimeOptions });
        return sendJson(response, 200, estimate);
      }

      if (request.method === "POST" && url.pathname === "/api/runs") {
        const body = await readJsonBody(request);
        const record = await callRuntimeTool("runtime_run", body, { store, runtimeOptions });
        return sendJson(response, 201, record);
      }

      const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (request.method === "GET" && runMatch) {
        const record = await store.readRecord(runMatch[1]);
        return sendJson(response, 200, summarizeRecord(record));
      }

      const cancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
      if (request.method === "POST" && cancelMatch) {
        const body = await readJsonBody(request);
        const canceled = await callRuntimeTool(
          "runtime_cancel",
          { runId: cancelMatch[1], reason: body.reason },
          { store }
        );
        return sendJson(response, 200, canceled);
      }

      const approveMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/approve$/);
      if (request.method === "POST" && approveMatch) {
        const body = await readJsonBody(request);
        const approved = await callRuntimeTool(
          "runtime_approve",
          { runId: approveMatch[1], approvedBy: body.approvedBy, note: body.note },
          { store }
        );
        return sendJson(response, 200, approved);
      }

      if (request.method === "POST" && url.pathname === "/api/verify") {
        const body = await readJsonBody(request);
        const verification = await callRuntimeTool("runtime_verify", body, { store, runtimeOptions });
        return sendJson(response, 200, verification);
      }

      if (request.method === "GET" && url.pathname === "/api/providers/health") {
        const provider = url.searchParams.get("provider") ?? undefined;
        const health = await callRuntimeTool(
          "runtime_provider_health",
          { provider },
          { store, runtimeOptions }
        );
        return sendJson(response, 200, health);
      }

      if (request.method === "POST" && url.pathname === "/api/model/generate") {
        const body = await readJsonBody(request);
        const generated = await callRuntimeTool("runtime_model_generate", body, { store, runtimeOptions });
        return sendJson(response, 200, generated);
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

      if (request.method === "POST" && url.pathname === "/mcp") {
        const body = await readJsonBody(request);
        const mcpResponse = await handleMcpJsonRpc(body, { store, runtimeOptions });

        if (!mcpResponse) {
          response.writeHead(202);
          response.end();
          return undefined;
        }

        return sendJson(response, 200, mcpResponse);
      }

      if (request.method === "GET" && url.pathname === "/mcp") {
        return sendJson(response, 405, {
          error: "method_not_allowed",
          message: "Use POST /mcp for Streamable HTTP JSON-RPC requests.",
        });
      }

      return sendJson(response, 404, {
        error: "not_found",
        message: `${request.method} ${url.pathname} is not implemented.`,
      });
    } catch (error) {
      return sendJson(response, error.statusCode ?? 500, {
        error: "runtime_error",
        message: error.message,
      });
    }
  });
}

function isAuthorized(request, apiToken) {
  if (!apiToken) {
    return true;
  }

  return request.headers.authorization === `Bearer ${apiToken}`;
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
    approvalStatus: record.plan.approval?.status ?? "unknown",
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
