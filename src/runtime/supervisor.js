export function shouldRunSupervisorReview({ tasks = [], config = {} } = {}) {
  if (config.enabled === false) return false;
  const requiredForRisk = config.requiredForRisk ?? config.required_for_risk ?? ["medium", "high"];
  return tasks.some((task) => requiredForRisk.includes(task.risk));
}

export function createSupervisorReviewPrompt({ record = {}, verification = {} } = {}) {
  const tasks = record.plan?.tasks ?? [];
  const commandLines = (verification.commands ?? []).map((command) => {
    const exitCode = command.exitCode === undefined ? "unknown" : command.exitCode;
    return `- ${command.name}: ${command.status}, exitCode=${exitCode}`;
  });

  return [
    "You are the AI Coding Runtime final supervisor.",
    "Review requirement alignment, diff risk, and verification evidence.",
    "",
    "User request:",
    record.request ?? "",
    "",
    "Tasks:",
    ...tasks.map(
      (task) =>
        `- ${task.task_id ?? task.id}: ${task.title} (${task.risk ?? "unknown risk"}, ${task.model_tier ?? task.modelTier ?? "unknown tier"})`
    ),
    "",
    "Verification evidence:",
    ...(commandLines.length ? commandLines : ["- command checks: skipped"]),
    `- acceptance: ${verification.acceptance?.status ?? "unknown"}`,
    "",
    "Return JSON with status, summary, requirementAlignment, diffRisk, verificationEvidence, and blockingIssues.",
  ].join("\n");
}

export function createSkippedSupervisorReview({ reason } = {}) {
  return {
    name: "final-supervisor-review",
    status: "skipped",
    required: false,
    reason: reason ?? "Final supervisor review was not required.",
  };
}

export async function runSupervisorReview({ record = {}, verification = {}, config = {} } = {}) {
  if (!shouldRunSupervisorReview({ tasks: record.plan?.tasks ?? [], config })) {
    return createSkippedSupervisorReview({
      reason: "No task risk requires final supervisor review.",
    });
  }

  const prompt = createSupervisorReviewPrompt({ record, verification });
  if (!config.provider || !config.model) {
    return {
      name: "final-supervisor-review",
      status: "failed",
      required: true,
      errors: [
        {
          code: "supervisor.review.provider_required",
          message: "Final supervisor review requires verification.final_review.provider and model.",
        },
      ],
      prompt,
    };
  }

  if (typeof config.generate !== "function") {
    return failedSupervisorReview({
      code: "supervisor.review.provider_required",
      message: "Final supervisor review requires a configured model provider.",
      prompt,
    });
  }

  const response = await config.generate(
    createSupervisorGenerateRequest({ config, prompt })
  );

  return normalizeSupervisorResponse({ response, prompt });
}

const SUPERVISOR_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["passed", "failed"] },
    summary: { type: "string" },
    requirementAlignment: { type: "string" },
    diffRisk: { type: "string" },
    verificationEvidence: { type: "string" },
    blockingIssues: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: [
    "status",
    "summary",
    "requirementAlignment",
    "diffRisk",
    "verificationEvidence",
    "blockingIssues",
  ],
};

function normalizeSupervisorResponse({ response = {}, prompt }) {
  if (response.status === "failed" && response.error) {
    return failedSupervisorReview({
      code: response.error.code ?? "supervisor.review.provider_error",
      message: response.error.message ?? "Final supervisor review provider call failed.",
      prompt,
      provider: response.provider,
      model: response.model,
    });
  }

  const output = response.structuredOutput ?? response.structured_output ?? parseJsonObject(response.text);
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return failedSupervisorReview({
      code: "supervisor.review.invalid_response",
      message: "Final supervisor review provider returned malformed JSON.",
      prompt,
      provider: response.provider,
      model: response.model,
    });
  }

  const normalizedOutput = normalizeSupervisorOutput(output);
  const validation = validateSupervisorOutput(normalizedOutput);
  if (!validation.valid) {
    return failedSupervisorReview({
      code: "supervisor.review.invalid_response",
      message: `Final supervisor review provider response is invalid: ${validation.errors.join(", ")}.`,
      prompt,
      provider: response.provider,
      model: response.model,
    });
  }

  const blockingIssues = normalizedOutput.blockingIssues;
  const status = normalizedOutput.status === "passed" && blockingIssues.length === 0 ? "passed" : "failed";

  return {
    name: "final-supervisor-review",
    status,
    required: true,
    summary: normalizedOutput.summary,
    requirementAlignment: normalizedOutput.requirementAlignment,
    requirement_alignment: normalizedOutput.requirementAlignment,
    diffRisk: normalizedOutput.diffRisk,
    diff_risk: normalizedOutput.diffRisk,
    verificationEvidence: normalizedOutput.verificationEvidence,
    verification_evidence: normalizedOutput.verificationEvidence,
    blockingIssues,
    blocking_issues: blockingIssues,
    provider: response.provider ?? null,
    model: response.model ?? null,
    usage: response.usage ?? null,
    costEstimate: response.costEstimate ?? response.cost_estimate ?? null,
    cost_estimate: response.cost_estimate ?? response.costEstimate ?? null,
    prompt,
  };
}

function normalizeSupervisorOutput(output = {}) {
  const blockingIssuesPresent =
    Object.prototype.hasOwnProperty.call(output, "blockingIssues") ||
    Object.prototype.hasOwnProperty.call(output, "blocking_issues");

  return {
    status: normalizeSupervisorStatus(output),
    summary: normalizeSupervisorText(output.summary),
    requirementAlignment: normalizeSupervisorText(
      output.requirementAlignment ?? output.requirement_alignment
    ),
    diffRisk: normalizeSupervisorText(output.diffRisk ?? output.diff_risk),
    verificationEvidence: normalizeSupervisorText(
      output.verificationEvidence ?? output.verification_evidence
    ),
    blockingIssuesPresent,
    blockingIssues: normalizeBlockingIssues(output.blockingIssues ?? output.blocking_issues, {
      present: blockingIssuesPresent,
    }),
  };
}

function createSupervisorGenerateRequest({ config = {}, prompt }) {
  const request = {
    provider: config.provider,
    model: config.model,
    prompt,
    temperature: 0,
    maxTokens: config.maxTokens ?? config.max_tokens ?? 1024,
    timeoutMs: config.timeoutMs ?? config.timeout_ms,
  };

  if (shouldIncludeSupervisorResponseSchema(config)) {
    request.responseSchema = SUPERVISOR_REVIEW_SCHEMA;
  }

  return request;
}

function validateSupervisorOutput(output) {
  const errors = [];
  const stringFields = [
    ["summary", output.summary],
    ["requirementAlignment", output.requirementAlignment],
    ["diffRisk", output.diffRisk],
    ["verificationEvidence", output.verificationEvidence],
  ];
  const blockingIssues = output.blockingIssues;

  if (output.status !== "passed" && output.status !== "failed") {
    errors.push("status");
  }

  for (const [field, value] of stringFields) {
    if (typeof value !== "string" || value.trim().length === 0) {
      errors.push(field);
    }
  }

  if (
    output.blockingIssuesPresent !== true ||
    !Array.isArray(blockingIssues) ||
    blockingIssues.some((issue) => typeof issue !== "string")
  ) {
    errors.push("blockingIssues");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function normalizeSupervisorStatus(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (value.approved === true || value.pass === true || value.passed === true || value.ok === true || value.success === true) {
      return "passed";
    }
    if (value.approved === false || value.pass === false || value.passed === false || value.failed === true || value.blocked === true) {
      return "failed";
    }
    return normalizeSupervisorStatus(value.status);
  }

  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim().toLowerCase();
  if (["pass", "passed", "approved", "ok", "success"].includes(normalized)) {
    return "passed";
  }
  if (["failed", "rejected", "blocked", "changes_requested", "needs_changes"].includes(normalized)) {
    return "failed";
  }
  return value;
}

function shouldIncludeSupervisorResponseSchema(config = {}) {
  const explicit =
    config.responseSchema ??
    config.response_schema;

  if (typeof explicit === "boolean") {
    return explicit;
  }

  return config.provider !== "openai-compatible";
}

function normalizeSupervisorText(value) {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value) || (value && typeof value === "object")) {
    return JSON.stringify(value);
  }

  return "";
}

function normalizeBlockingIssues(value, { present = false } = {}) {
  if (!present) {
    return null;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          return item.trim();
        }
        if (item && typeof item === "object") {
          return JSON.stringify(item);
        }
        if (item === null || item === undefined) {
          return "";
        }
        return String(item).trim();
      })
      .filter((item) => item.length > 0);
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized.length > 0 ? [normalized] : [];
  }

  if (value && typeof value === "object") {
    return [JSON.stringify(value)];
  }

  return null;
}

function failedSupervisorReview({ code, message, prompt, provider = null, model = null }) {
  return {
    name: "final-supervisor-review",
    status: "failed",
    required: true,
    provider,
    model,
    errors: [{ code, message }],
    prompt,
  };
}

function parseJsonObject(text) {
  if (typeof text !== "string" || text.trim().length === 0) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
