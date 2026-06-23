# OpenAI Runtime Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local OpenAI-compatible runtime configuration and keep it out of version control so real run history can be collected safely.

**Architecture:** Keep the change entirely at the repository edge. Add one ignore rule for the local config file and create one root `runtime.config.json` that points routing tiers and final review at real OpenAI-compatible models while leaving secrets in environment variables.

**Tech Stack:** JSON config, Git ignore rules, existing AI Coding Runtime config loader

---

### Task 1: Protect Local Runtime Config

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add the local config filename to Git ignore rules**

```gitignore
runtime.config.json
```

- [ ] **Step 2: Verify Git now treats the config as local-only**

Run: `git check-ignore runtime.config.json`
Expected: prints `runtime.config.json`

### Task 2: Create the Initial OpenAI-Compatible Runtime Config

**Files:**
- Create: `runtime.config.json`
- Reference: `runtime.config.example.json`

- [ ] **Step 1: Create the root config with real provider routing**

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
    "modelRegistry": [
      {
        "provider": "openai-compatible",
        "model": "gpt-4.1-mini",
        "tier": "cheap"
      },
      {
        "provider": "openai-compatible",
        "model": "gpt-4.1-mini",
        "tier": "standard"
      },
      {
        "provider": "openai-compatible",
        "model": "gpt-4.1",
        "tier": "premium"
      }
    ],
    "budgetPolicy": {
      "maxCostPerRun": 1,
      "maxCallsPerRun": 20,
      "maxRetryCount": 8
    }
  },
  "providers": {
    "defaultProvider": "openai-compatible",
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
        "defaultModel": "gpt-4.1-mini",
        "models": ["gpt-4.1-mini", "gpt-4.1"]
      }
    }
  },
  "policy": {
    "budget": {
      "maxCostPerRun": 1,
      "maxWorkerRetries": 8,
      "maxCallsPerRun": 20
    },
    "routing": {
      "finalReviewModelTier": "premium",
      "securityTasksMinTier": "premium",
      "readonlyTasksAllowLocalModels": false
    },
    "safety": {
      "requireHumanApprovalForHighRisk": true,
      "requireTestsForCodeChanges": false,
      "blockSecretExfiltration": true,
      "blockUnapprovedNetworkAccess": false
    },
    "workspace": {
      "trusted": true,
      "allowedFiles": [],
      "blockedFiles": [".env", ".env.*", "*.pem", "*.key", "secrets/**"]
    },
    "commands": {
      "allowlist": [],
      "blockNetworkByDefault": false
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
      "provider": "openai-compatible",
      "model": "gpt-4.1",
      "requiredForRisk": ["medium", "high"]
    }
  }
}
```

- [ ] **Step 2: Verify the file is valid JSON and loadable by the runtime**

Run: `node --input-type=module -e "import('./src/runtime/config.js').then(async ({ loadRuntimeConfig }) => { const config = await loadRuntimeConfig({ cwd: process.cwd(), env: process.env }); console.log(JSON.stringify({ provider: config.providers.defaultProvider, cheap: config.routing.modelRegistry[0].model, premium: config.routing.modelRegistry[2].model, finalReviewProvider: config.verification.final_review.provider, finalReviewModel: config.verification.final_review.model }, null, 2)); })"`
Expected: JSON output showing `openai-compatible`, `gpt-4.1-mini`, and `gpt-4.1`
