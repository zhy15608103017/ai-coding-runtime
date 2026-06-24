import { createHash } from "node:crypto";

export const DEFAULT_POLICY_CONFIG = {
  schemaVersion: "runtime.policy.v1",
  budget: {
    maxCostPerRun: 1,
    maxWorkerRetries: 8,
    maxCallsPerRun: 20,
  },
  routing: {
    finalReviewModelTier: "premium",
    securityTasksMinTier: "premium",
    readonlyTasksAllowLocalModels: true,
  },
  learning: {
    enabled: true,
    mode: "shadow",
    minSamples: 5,
    cheapSuccessThreshold: 0.85,
    strongerFailureThreshold: 0.3,
    maxRetryRateForDowngrade: 0.15,
    maxEscalationRateForDowngrade: 0.1,
  },
  safety: {
    requireHumanApprovalForHighRisk: true,
    requireTestsForCodeChanges: false,
    blockSecretExfiltration: true,
    blockUnapprovedNetworkAccess: false,
  },
  workspace: {
    trusted: true,
    allowedFiles: [],
    blockedFiles: [".env", ".env.*", "*.pem", "*.key", "secrets/**"],
  },
  commands: {
    allowlist: [],
    blockNetworkByDefault: false,
  },
  secrets: {
    redactionText: "[REDACTED]",
    patterns: ["api[_-]?key", "token", "secret", "password", "credential"],
  },
  audit: {
    includeTraceViewerData: true,
  },
};

const BOOLEAN_SAFETY_FIELDS = [
  "requireHumanApprovalForHighRisk",
  "requireTestsForCodeChanges",
  "blockSecretExfiltration",
  "blockUnapprovedNetworkAccess",
];

export function normalizePolicyConfig(policy = {}) {
  const input = isPlainObject(policy) ? policy : {};
  const normalized = deepMerge(DEFAULT_POLICY_CONFIG, input);
  normalized.schemaVersion = DEFAULT_POLICY_CONFIG.schemaVersion;
  normalizeBudgetAliases(normalized.budget);
  normalizeRoutingAliases(normalized.routing);
  normalizeLearningAliases(normalized.learning);
  normalizeSafetyAliases(normalized.safety);
  normalized.workspace.allowedFiles = uniqueStrings(normalized.workspace.allowedFiles);
  normalized.workspace.blockedFiles = uniqueStrings(normalized.workspace.blockedFiles);
  normalized.commands.allowlist = uniqueStrings(normalized.commands.allowlist);
  normalized.secrets.patterns = uniqueStrings(normalized.secrets.patterns);
  return normalized;
}

export function validatePolicyConfig(policy = {}) {
  const input = isPlainObject(policy) ? policy : {};
  const normalized = normalizePolicyConfig(input);
  const errors = [];

  if (hasOwn(input, "learning") && !isPlainObject(input.learning)) {
    errors.push(error("policy.learning.object.invalid", "policy.learning"));
  }

  if (!isNonNegativeNumber(normalized.budget.maxCostPerRun)) {
    errors.push(error("policy.budget.max_cost.invalid", "policy.budget.maxCostPerRun"));
  }
  if (!Number.isInteger(normalized.budget.maxWorkerRetries) || normalized.budget.maxWorkerRetries < 0) {
    errors.push(error("policy.budget.max_worker_retries.invalid", "policy.budget.maxWorkerRetries"));
  }
  if (!Number.isInteger(normalized.budget.maxCallsPerRun) || normalized.budget.maxCallsPerRun < 0) {
    errors.push(error("policy.budget.max_calls.invalid", "policy.budget.maxCallsPerRun"));
  }

  for (const field of BOOLEAN_SAFETY_FIELDS) {
    if (typeof normalized.safety[field] !== "boolean") {
      errors.push(error("policy.safety.boolean.invalid", `policy.safety.${field}`));
    }
  }

  if (typeof normalized.learning.enabled !== "boolean") {
    errors.push(error("policy.learning.enabled.invalid", "policy.learning.enabled"));
  }
  if (!["off", "shadow"].includes(normalized.learning.mode)) {
    errors.push(error("policy.learning.mode.invalid", "policy.learning.mode"));
  }
  if (!Number.isInteger(normalized.learning.minSamples) || normalized.learning.minSamples < 1) {
    errors.push(error("policy.learning.min_samples.invalid", "policy.learning.minSamples"));
  }
  for (const field of [
    "cheapSuccessThreshold",
    "strongerFailureThreshold",
    "maxRetryRateForDowngrade",
    "maxEscalationRateForDowngrade",
  ]) {
    if (!isRatio(normalized.learning[field])) {
      errors.push(error("policy.learning.threshold.invalid", `policy.learning.${field}`));
    }
  }

  if (hasOwn(input.workspace, "allowedFiles") && !isStringArray(input.workspace.allowedFiles)) {
    errors.push(error("policy.workspace.allowed_files.invalid", "policy.workspace.allowedFiles"));
  }
  if (hasOwn(input.workspace, "blockedFiles") && !isStringArray(input.workspace.blockedFiles)) {
    errors.push(error("policy.workspace.blocked_files.invalid", "policy.workspace.blockedFiles"));
  }
  if (hasOwn(input.commands, "allowlist") && !isStringArray(input.commands.allowlist)) {
    errors.push(error("policy.commands.allowlist.invalid", "policy.commands.allowlist"));
  }
  if (
    hasOwn(input.secrets, "patterns") &&
    (!isStringArray(input.secrets.patterns) || !input.secrets.patterns.every(isValidRegExpSource))
  ) {
    errors.push(error("policy.secrets.patterns.invalid", "policy.secrets.patterns"));
  }

  return {
    valid: errors.length === 0,
    errors,
    policy: normalized,
  };
}

export function redactSecrets(value, policy = DEFAULT_POLICY_CONFIG) {
  const normalized = normalizePolicyConfig(policy);
  return redactValue(value, normalized, null);
}

export function stableHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function budgetPolicyFromPolicy(policy = DEFAULT_POLICY_CONFIG, existingBudgetPolicy = {}) {
  const normalized = normalizePolicyConfig(policy);
  return {
    ...existingBudgetPolicy,
    maxCostPerRun: normalized.budget.maxCostPerRun,
    maxCallsPerRun: normalized.budget.maxCallsPerRun,
    maxRetryCount: normalized.budget.maxWorkerRetries,
  };
}

export function evaluateRunPolicy({
  policy = DEFAULT_POLICY_CONFIG,
  policyValidation = validatePolicyConfig(policy),
  tasks = [],
  budgetStatus = {},
  verification = {},
} = {}) {
  const normalized = normalizePolicyConfig(policy);
  const violations = [];

  if (policyValidation?.valid === false) {
    violations.push(
      ...(policyValidation.errors ?? []).map((item) => ({
        ...item,
        code: item.code.startsWith("policy.config.") ? item.code : `policy.config.${item.code}`,
      }))
    );
  }

  for (const violation of budgetStatus.violations ?? []) {
    violations.push({
      ...violation,
      code: String(violation.code ?? "budget.violation").replace(/^budget\./, "policy.budget."),
    });
  }

  if (normalized.safety.requireTestsForCodeChanges && planEditsFiles(tasks) && !hasTestCommand(verification)) {
    violations.push({
      code: "policy.safety.tests_required",
      field: "policy.safety.requireTestsForCodeChanges",
      message: "Policy requires a test command for file-changing plans.",
    });
  }

  return {
    allowed: violations.length === 0,
    violations,
  };
}

export function evaluateFilePolicy({ filePath, policy = DEFAULT_POLICY_CONFIG } = {}) {
  const normalized = normalizePolicyConfig(policy);
  const blocked = normalized.workspace.blockedFiles.some((pattern) => matchesPattern(filePath, pattern));
  const allowlist = normalized.workspace.allowedFiles;
  const allowedByTeam =
    allowlist.length === 0 || allowlist.some((pattern) => matchesPattern(filePath, pattern));
  const violations = [];

  if (blocked) {
    violations.push({
      code: "policy.workspace.file_blocked",
      file: normalizePath(filePath),
      message: `File is blocked by workspace policy: ${filePath}.`,
    });
  }

  if (!allowedByTeam) {
    violations.push({
      code: "policy.workspace.file_not_allowed",
      file: normalizePath(filePath),
      message: `File is outside workspace policy allowlist: ${filePath}.`,
    });
  }

  return {
    allowed: violations.length === 0,
    violations,
  };
}

export function evaluateCommandPolicy({ command, policy = DEFAULT_POLICY_CONFIG } = {}) {
  const normalized = normalizePolicyConfig(policy);
  const commandText = commandToText(command);
  const allowlist = normalized.commands.allowlist;
  const violations = [];

  if (allowlist.length > 0 && !allowlist.includes(commandText)) {
    violations.push({
      code: "policy.command.not_allowed",
      command: commandText,
      message: `Command is outside policy allowlist: ${commandText}.`,
    });
  }

  if (
    (normalized.commands.blockNetworkByDefault || normalized.safety.blockUnapprovedNetworkAccess) &&
    /\b(curl|wget|ssh|scp|ftp|Invoke-WebRequest|iwr)\b/i.test(commandText)
  ) {
    violations.push({
      code: "policy.command.network_blocked",
      command: commandText,
      message: `Network-oriented command is blocked by policy: ${commandText}.`,
    });
  }

  return {
    allowed: violations.length === 0,
    violations,
  };
}

export function commandToText(command = {}) {
  return [command.command, ...(command.args ?? [])].filter(Boolean).map(String).join(" ").trim();
}

export function matchesPattern(filePath = "", pattern = "") {
  const normalizedPath = normalizePath(filePath);
  const normalizedPattern = normalizePath(pattern);
  if (!normalizedPath || !normalizedPattern) return false;
  if (normalizedPattern === normalizedPath) return true;
  if (normalizedPattern.endsWith("/**")) return normalizedPath.startsWith(normalizedPattern.slice(0, -2));
  if (!normalizedPattern.includes("*")) return false;
  const expression = `^${escapeRegExp(normalizedPattern).replaceAll("\\*", "[^/]*")}$`;
  return new RegExp(expression).test(normalizedPath);
}

const COMPLETED_AUDIT_STATUSES = new Set([
  "verification_passed",
  "verification_failed",
  "verification_skipped",
  "canceled",
  "approval_rejected",
]);

export function createAuditExport(record, { report = null, policy = record?.plan?.policyConfig } = {}) {
  if (!COMPLETED_AUDIT_STATUSES.has(record.status)) {
    const error = new Error(`Run ${record.runId} is not completed and cannot be exported for audit.`);
    error.statusCode = 409;
    throw error;
  }

  const generatedAt = new Date().toISOString();
  const redacted = redactSecrets(
    {
      schema: "ai-coding-runtime.audit",
      version: 1,
      generatedAt,
      generated_at: generatedAt,
      run: {
        runId: record.runId,
        run_id: record.runId,
        status: record.status,
        request: record.request,
        createdAt: record.createdAt,
        created_at: record.createdAt,
        updatedAt: record.updatedAt,
        updated_at: record.updatedAt,
      },
      plan: record.plan,
      policy: {
        config: record.plan?.policyConfig ?? record.plan?.policy_config ?? null,
        validation: record.plan?.policyValidation ?? record.plan?.policy_validation ?? null,
        status: record.plan?.policyStatus ?? record.plan?.policy_status ?? null,
        budgetStatus: record.plan?.budgetStatus ?? record.plan?.budget_status ?? null,
        budget_status: record.plan?.budget_status ?? record.plan?.budgetStatus ?? null,
      },
      evidence: {
        approval: record.plan?.approval ?? null,
        routing: record.plan?.routingTrace ?? record.plan?.routing_trace ?? [],
        events: record.events ?? [],
        modelCalls: record.modelCalls ?? [],
        model_calls: record.modelCalls ?? [],
        workerAttempts: record.workerAttempts ?? [],
        worker_attempts: record.workerAttempts ?? [],
        verification: record.verification ?? [],
      },
      report,
    },
    policy
  );
  const integrity = {
    eventCount: record.events?.length ?? 0,
    event_count: record.events?.length ?? 0,
    sha256: stableHash(redacted),
  };

  return {
    ...redacted,
    integrity,
  };
}

function redactValue(value, policy, key) {
  if (keyMatchesSecretPattern(key, policy)) return policy.secrets.redactionText;
  if (typeof value === "string") return redactString(value, policy, key);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, policy, key));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactValue(entryValue, policy, entryKey),
      ])
    );
  }
  return value;
}

function redactString(value, policy, key) {
  const marker = policy.secrets.redactionText;

  let redacted = value;
  for (const pattern of validSecretPatterns(policy)) {
    const assignment = new RegExp(`(${pattern}\\s*[:=]\\s*)([^\\s&]+)`, "gi");
    redacted = redacted.replace(assignment, `$1${marker}`);
  }
  return redacted;
}

function keyMatchesSecretPattern(key, policy) {
  return Boolean(
    key &&
      validSecretPatterns(policy).some((pattern) => {
        const expression = new RegExp(`(^|[^A-Za-z0-9])(?:${pattern})([^A-Za-z0-9]|$)`, "i");
        return expression.test(key);
      })
  );
}

function validSecretPatterns(policy) {
  return policy.secrets.patterns.filter(isValidRegExpSource);
}

function isValidRegExpSource(pattern) {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function error(code, field) {
  return { code, field, message: `${field} is not valid.` };
}

function deepMerge(base, override) {
  if (isPlainObject(base) && !isPlainObject(override)) {
    return structuredClone(base);
  }
  if (!isPlainObject(base)) {
    return override;
  }

  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override ?? {})) {
    result[key] =
      isPlainObject(result[key])
        ? deepMerge(result[key], value)
        : value;
  }
  return result;
}

function uniqueStrings(values) {
  return Array.isArray(values)
    ? [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))]
    : [];
}

function isNonNegativeNumber(value) {
  return Number.isFinite(value) && value >= 0;
}

function isRatio(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return isPlainObject(value) && Object.hasOwn(value, key);
}

function normalizeBudgetAliases(budget) {
  if (!isPlainObject(budget)) return;
  budget.maxCostPerRun = budget.maxCostPerRun ?? budget.max_cost_per_run;
  budget.maxWorkerRetries = budget.maxWorkerRetries ?? budget.max_worker_retries;
  budget.maxCallsPerRun = budget.maxCallsPerRun ?? budget.max_calls_per_run;
}

function normalizeRoutingAliases(routing) {
  if (!isPlainObject(routing)) return;
  routing.finalReviewModelTier = routing.finalReviewModelTier ?? routing.final_review_model_tier;
  routing.securityTasksMinTier = routing.securityTasksMinTier ?? routing.security_tasks_min_tier;
  routing.readonlyTasksAllowLocalModels =
    routing.readonlyTasksAllowLocalModels ?? routing.readonly_tasks_allow_local_models;
}

function normalizeLearningAliases(learning) {
  if (!isPlainObject(learning)) return;
  learning.enabled =
    hasOwn(learning, "learning_enabled") ? learning.learning_enabled : learning.enabled;
  learning.mode =
    hasOwn(learning, "learning_mode") ? learning.learning_mode : learning.mode;
  learning.minSamples =
    hasOwn(learning, "min_samples") ? learning.min_samples : learning.minSamples;
  learning.cheapSuccessThreshold =
    hasOwn(learning, "cheap_success_threshold")
      ? learning.cheap_success_threshold
      : learning.cheapSuccessThreshold;
  learning.strongerFailureThreshold =
    hasOwn(learning, "stronger_failure_threshold")
      ? learning.stronger_failure_threshold
      : learning.strongerFailureThreshold;
  learning.maxRetryRateForDowngrade =
    hasOwn(learning, "max_retry_rate_for_downgrade")
      ? learning.max_retry_rate_for_downgrade
      : learning.maxRetryRateForDowngrade;
  learning.maxEscalationRateForDowngrade =
    hasOwn(learning, "max_escalation_rate_for_downgrade")
      ? learning.max_escalation_rate_for_downgrade
      : learning.maxEscalationRateForDowngrade;

  if (learning.mode === "advisory" || learning.mode === "auto") {
    const requestedMode = learning.mode;
    learning.mode = "shadow";
    learning.requestedMode = requestedMode;
    learning.requested_mode = requestedMode;
    learning.warnings = uniqueStrings([
      ...(learning.warnings ?? []),
      `policy.learning.mode.${requestedMode}.normalized_to_shadow`,
    ]);
  }
}

function normalizeSafetyAliases(safety) {
  if (!isPlainObject(safety)) return;
  safety.requireHumanApprovalForHighRisk =
    safety.requireHumanApprovalForHighRisk ?? safety.require_human_approval_for_high_risk;
  safety.requireTestsForCodeChanges =
    safety.requireTestsForCodeChanges ?? safety.require_tests_for_code_changes;
  safety.blockSecretExfiltration =
    safety.blockSecretExfiltration ?? safety.block_secret_exfiltration;
  safety.blockUnapprovedNetworkAccess =
    safety.blockUnapprovedNetworkAccess ?? safety.block_unapproved_network_access;
}

function planEditsFiles(tasks) {
  return tasks.some((task) => (task.allowed_files ?? task.allowedFiles ?? []).length > 0);
}

function hasTestCommand(verification) {
  return Boolean(verification?.test?.command);
}

function normalizePath(value = "") {
  const raw = String(value).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!raw || raw.includes("\0")) return "";
  if (raw.startsWith("/") || raw.startsWith("//")) return "";
  if (/^[A-Za-z]:/.test(raw)) return "";
  if (raw.split("/").some((segment) => segment === "..")) return "";
  return raw
    .split("/")
    .filter((segment) => segment && segment !== ".")
    .join("/");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
