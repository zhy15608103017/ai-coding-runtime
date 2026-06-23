# AI Coding Runtime

AI Coding Runtime is a local-first orchestration layer for AI coding tasks.

V0 currently covers the Phase 1 runtime skeleton through Phase 10 policy, safety, and team mode:

- create a structured runtime plan from a user request
- classify tasks into `cheap`, `standard`, and `premium` model tiers
- store run records and structured events on disk
- expose a CLI for `run`, `status`, `execute`, `verify`, `report`, and `start`
- expose a local HTTP API for planning, runs, verification, cancel, and reports
- expose stdio MCP with `node ./bin/ai-coding-runtime.js mcp`
- expose Streamable HTTP JSON-RPC at `POST /mcp`
- validate task contracts before a run is persisted
- include task graph, approval gate, validation, and plan report metadata in plans
- include a deterministic planning prompt for host tools and future supervisor calls
- include classifier, routing trace, model registry, escalation policy, and budget metadata
- refuse persisted execution when budget or routing policy metadata says a run is not allowed
- expose Phase 5 provider adapters for OpenAI-compatible, Anthropic, Gemini, and local placeholder models
- record model usage and estimated provider cost into run traces when generation is linked to a run
- build workspace snapshots and context packs from task `allowed_files` plus read-only `referenced_files`
- validate structured worker results with patch, explanation, verification notes, confidence, files touched, and acceptance evidence
- detect worker results that explicitly include task `forbidden_actions`
- reject worker patches that touch files outside the task contract
- optionally apply validated text patches and record each worker attempt in the run trace
- explicitly execute eligible worker tasks with `runtime_execute`, `ai-coding-runtime execute`, or `POST /api/runs/:id/execute`
- run Phase 7 verification with diff/test/lint/typecheck/custom command checks, task acceptance review, final supervisor review, and escalation metadata
- provide setup guides, MCP configs, prompt samples, and smoke-test checklists for Codex Desktop, Codex CLI, Cursor, and OpenCode
- generate Phase 9 reports with changed files, per-task cost attribution, routing and escalation reasons, failure categories, trace viewer data, export metadata, and historical model reliability metrics
- enforce Phase 10 policy config for budget aliases, risk gates, workspace file policy, verification command allowlists, secret redaction, and completed-run audit export

V0 can call configured model providers directly through the Phase 5 provider interface, accept structured worker results through the Phase 6 worker surface, explicitly execute dependency-aware worker tasks with configured tier escalation and retry, apply validated text patches, run Phase 7 verification, connect to host tools through Phase 8 integration guides, produce Phase 9 cost-aware run reports, and enforce Phase 10 team policy controls. `runtime_run` remains plan-only; worker execution happens only through the explicit execute surfaces.
Runs that include medium or high risk tasks are stored as `approval_required`. V0 provides a minimal approval input through CLI, HTTP, and MCP; approved runs can be executed explicitly, and later phases can add richer approval UI.
Phase 4 routing is deterministic: file-editing tasks route to at least `standard`, final verification routes to `premium`, and failed low-tier attempts can be represented with escalation trace records.
Explicit read-only planning requests such as `plan only`, `read-only`, or `不修改文件` produce low-risk plans that can be stored as `planned` without an approval gate.

## Usage

```bash
npm test
node ./bin/ai-coding-runtime.js run "实现登录限流并补充测试" --json
node ./bin/ai-coding-runtime.js status <run-id> --json
node ./bin/ai-coding-runtime.js execute <run-id> --json
node ./bin/ai-coding-runtime.js verify <run-id> --json
node ./bin/ai-coding-runtime.js approve <run-id> --json
node ./bin/ai-coding-runtime.js worker-result <run-id> T-003 --from-file worker-result.json --apply --json
node ./bin/ai-coding-runtime.js report <run-id> --markdown
node ./bin/ai-coding-runtime.js audit <run-id> --json
node ./bin/ai-coding-runtime.js provider-health --json
node ./bin/ai-coding-runtime.js generate "Say hello" --provider local --json
node ./bin/ai-coding-runtime.js start --host 127.0.0.1 --port 3847
node ./bin/ai-coding-runtime.js mcp
```

By default, run data is stored in `.ai-coding-runtime/runs`.

### Execute Worker Tasks

`runtime_run` creates and stores a plan only. It does not call worker models or apply patches.

Use the explicit execution surface after reviewing or approving a run:

```bash
node ./bin/ai-coding-runtime.js execute <run-id> --json
```

For smoke tests or host integrations that should not write files or run verification:

```bash
node ./bin/ai-coding-runtime.js execute <run-id> --no-apply --no-verify --json
```

HTTP and MCP expose the same behavior through `POST /api/runs/:id/execute` and `runtime_execute`.

### Workspace Scope

Implementation work stays inside the task contract boundary:

- `allowed_files` are the only files that may be edited or patched.
- `referenced_files` are read-only inputs for planning and verification.
- worker results that target files outside the allowlist are rejected before patch application.

Override the data directory:

```bash
$env:AI_CODING_RUNTIME_HOME="D:\runtime-data"
node ./bin/ai-coding-runtime.js run "规划一个任务" --json
```

## Config

Copy `runtime.config.example.json` to `runtime.config.json` and adjust it:

```json
{
  "server": {
    "host": "127.0.0.1",
    "httpPort": 3847,
    "mcpPath": "/mcp",
    "apiToken": null
  },
  "storage": {
    "directory": ".ai-coding-runtime"
  },
  "routing": {
    "modelTiers": ["cheap", "standard", "premium"],
    "finalVerificationTier": "premium",
    "budgetPolicy": {
      "maxCostPerRun": 1,
      "maxCallsPerRun": 20,
      "maxRetryCount": 8
    }
  },
  "providers": {
    "defaultProvider": "local",
    "retryPolicy": {
      "maxRetries": 2,
      "initialDelayMs": 250,
      "maxDelayMs": 2000,
      "timeoutMs": 60000
    },
    "entries": {
      "openai-compatible": {
        "type": "openai-compatible",
        "baseUrl": "https://api.openai.com/v1",
        "apiKeyEnv": "OPENAI_API_KEY",
        "defaultModel": null,
        "models": []
      },
      "anthropic": {
        "type": "anthropic",
        "baseUrl": "https://api.anthropic.com",
        "apiKeyEnv": "ANTHROPIC_API_KEY",
        "apiVersion": "2023-06-01",
        "defaultModel": null,
        "models": []
      },
      "gemini": {
        "type": "gemini",
        "baseUrl": "https://generativelanguage.googleapis.com",
        "apiKeyEnv": "GEMINI_API_KEY",
        "defaultModel": null,
        "models": []
      },
      "local": {
        "type": "local",
        "defaultModel": "local-placeholder",
        "models": ["local-placeholder"]
      }
    }
  },
  "verification": {
    "diff_check": {
      "enabled": true,
      "required": true,
      "timeoutMs": 30000
    },
    "test": {
      "command": "node",
      "args": ["--test"],
      "required": true,
      "timeoutMs": 120000
    },
    "lint": null,
    "typecheck": null,
    "custom_commands": [],
    "commands": [],
    "final_review": {
      "enabled": true,
      "provider": null,
      "model": null,
      "requiredForRisk": ["medium", "high"]
    }
  }
}
```

`verification.diff_check` runs `git diff --check` by default. `verification.test`, `verification.lint`, `verification.typecheck`, and `verification.custom_commands` add named command checks; `verification.commands` remains supported as a legacy command list. `runtime_verify`, `POST /api/verify`, and `ai-coding-runtime verify <run-id>` run checks in order, record stdout, stderr, exit code, duration, acceptance review, final supervisor review, and escalation metadata, then mark the run as `verification_passed`, `verification_failed`, or `verification_skipped`.

`verification.final_review` controls provider-backed final review for medium/high-risk tasks. Set both `provider` and `model` to use a configured provider; when final review is required but either value is missing, verification fails instead of reporting success without review evidence.

Environment variables can override local config:

- `AI_CODING_RUNTIME_HOME`
- `AI_CODING_RUNTIME_HOST`
- `AI_CODING_RUNTIME_PORT`
- `AI_CODING_RUNTIME_API_TOKEN`
- `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`
- `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`
- `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_BASE_URL`, `GEMINI_MODEL`

With a real provider configured, a manual smoke check can run a generation without enabling worker execution:

```bash
$env:OPENAI_API_KEY="<key>"
$env:OPENAI_MODEL="<model>"
node ./bin/ai-coding-runtime.js generate "Reply with one short sentence." --provider openai-compatible --json
```

## HTTP

Start the local service:

```bash
node ./bin/ai-coding-runtime.js start --json
```

V0 HTTP endpoints:

- `GET /api/health`
- `POST /api/plan`
- `POST /api/estimate`
- `POST /api/runs`
- `GET /api/runs/:id`
- `POST /api/runs/:id/approve`
- `POST /api/runs/:id/cancel`
- `POST /api/runs/:id/execute`
- `POST /api/runs/:id/worker-results`
- `POST /api/verify`
- `GET /api/providers/health`
- `POST /api/model/generate`
- `GET /api/runs/:id/report`
- `GET /api/runs/:id/audit`
- `POST /mcp`

See `docs/integrations.md` and `docs/integrations/README.md` for Codex Desktop, Codex CLI, Cursor, and OpenCode setup examples.

## MCP Tools

The MCP gateway exposes:

- `runtime_plan`
- `runtime_estimate`
- `runtime_run`
- `runtime_status`
- `runtime_collect`
- `runtime_execute`
- `runtime_verify`
- `runtime_report`
- `runtime_cancel`
- `runtime_approve`
- `runtime_provider_health`
- `runtime_model_generate`
- `runtime_submit_worker_result`

`runtime_plan` and `runtime_estimate` include `taskGraph`, `approval`, `validation`, `planningPrompt`, `planReport`, `modelRegistry`, `routingPolicy`, `budgetPolicy`, `budgetStatus`, `policyConfig`, `policyValidation`, `policyStatus`, `escalationPolicy`, and `routingTrace`. `planReport` is the Phase 3 plan review output for host tools to show before execution. `runtime_run` persists the same plan metadata, returns `approval_required` when human approval is required before execution, returns `planned` for explicit low-risk read-only plans, and refuses execution when `budgetStatus.allowed` or `policyStatus.allowed` is `false`. `runtime_approve` records human approval and moves the run to `approved`. `runtime_execute` runs eligible worker tasks only after dependencies are satisfied, skips read-only/final-review/already-completed tasks, upgrades to the next configured tier and retries after worker failure when retry budget allows, optionally applies validated patches, optionally runs verification, and returns executed/skipped/failed task summaries plus a report. `runtime_verify` can run from `planned`, `approved`, or `verification_failed`; it accepts an optional `verification` override object and records command checks, task acceptance review, final supervisor review, and escalation evidence.
`runtime_model_generate` calls a configured provider through the normalized Phase 5 interface. When given `runId`, it appends model usage, estimated cost, finish reason, and request metadata to the run trace; optional `taskId` metadata is recorded for Phase 9 cost attribution without being sent to the provider.
`runtime_submit_worker_result` validates a structured worker result against the task contract, builds worker context from `allowed_files` plus read-only `referenced_files`, rejects patches outside `allowed_files`, optionally applies the patch when `apply: true`, and records the worker attempt for reporting.
For compatibility with existing exact-list integrations, MCP `tools/list` omits `runtime_audit`; hosts that know the tool name can still call it through `tools/call`. `runtime_audit` returns a redacted completed-run audit export with policy, routing, worker, model, verification, event, report, and integrity metadata.

## Policy

Phase 10 adds a top-level `policy` config for team safety controls: budget limits, risk-based approval, secret redaction, workspace file policy, verification command allowlists, and completed-run audit export. Reports and audit exports are redacted by default. See `docs/policy.md` and `examples/team-policies/`.

## Reports

`ai-coding-runtime report <run-id> --json` returns the Phase 9 report export. `--markdown` renders the same evidence for people. Reports include:

- final report sections for summary, changed files, task graph, model routing, cost estimate, verification, risks, and follow-up recommendations
- per-task model usage, cost estimates, and unattributed model usage for provider calls that cannot be mapped to a task
- routing and escalation decisions with reason fields
- failure categories for provider errors, malformed worker output, policy violations, verification failures, and rejected approvals
- trace viewer data and export metadata
- historical model reliability metrics grouped by task type and model tier

`ai-coding-runtime audit <run-id> --json` returns the Phase 10 redacted audit export for completed runs.
