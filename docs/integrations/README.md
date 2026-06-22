# Host Tool Integrations

Phase 8 makes AI Coding Runtime usable from four host tools:

- [Codex Desktop](./codex-desktop.md)
- [Codex CLI](./codex-cli.md)
- [Cursor](./cursor.md)
- [OpenCode](./opencode.md)

Use the Runtime through one of two MCP surfaces:

- **stdio MCP:** `node ./bin/ai-coding-runtime.js mcp`
- **HTTP MCP:** `http://127.0.0.1:3847/mcp`

The HTTP MCP surface requires the Runtime service to be running:

```bash
node ./bin/ai-coding-runtime.js start --host 127.0.0.1 --port 3847
```

Shared supporting material:

- [Prompt library](./prompts.md)
- [Smoke test checklist](./smoke-tests.md)
- [Top-level integration reference](../integrations.md)

Example files live under `examples/` and are grouped by host tool.
