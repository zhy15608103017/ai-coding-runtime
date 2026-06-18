import readline from "node:readline";

import { FileExecutionStore } from "./runtime/store.js";
import { asMcpToolResult, callRuntimeTool, RUNTIME_TOOLS } from "./runtime/tools.js";

const PROTOCOL_VERSION = "2025-06-18";

export async function handleMcpJsonRpc(message, { store = new FileExecutionStore() } = {}) {
  const request = typeof message === "string" ? JSON.parse(message) : message;
  const isNotification = request.id === undefined || request.id === null;

  try {
    const result = await handleMcpMethod(request.method, request.params ?? {}, { store });

    if (isNotification) {
      return undefined;
    }

    return {
      jsonrpc: "2.0",
      id: request.id,
      result,
    };
  } catch (error) {
    if (isNotification) {
      return undefined;
    }

    return {
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: error.code ?? -32603,
        message: error.message,
      },
    };
  }
}

export async function startMcpStdioServer({ input = process.stdin, output = process.stdout, store } = {}) {
  const lineReader = readline.createInterface({
    input,
    crlfDelay: Number.POSITIVE_INFINITY,
    terminal: false,
  });

  for await (const line of lineReader) {
    if (line.trim().length === 0) {
      continue;
    }

    const response = await handleMcpJsonRpc(line, { store });

    if (response) {
      output.write(`${JSON.stringify(response)}\n`);
    }
  }
}

async function handleMcpMethod(method, params, { store }) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "ai-coding-runtime",
          version: "0.1.0",
        },
      };
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: RUNTIME_TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };
    case "tools/call": {
      const toolName = params.name;
      const args = params.arguments ?? {};
      const value = await callRuntimeTool(toolName, args, { store });
      return asMcpToolResult(value);
    }
    default: {
      const error = new Error(`Method not found: ${method}`);
      error.code = -32601;
      throw error;
    }
  }
}
