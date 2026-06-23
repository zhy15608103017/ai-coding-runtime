import { applyWorkerPatch, createContextPack, validateWorkerPatch } from "./workspace.js";
import { redactSecrets } from "./policy.js";

const EXECUTABLE_RUN_STATUSES = new Set([
  "planned",
  "approved",
  "verification_failed",
  "verification_skipped",
]);

export async function submitWorkerResult({
  runId,
  taskId,
  result,
  apply = false,
  store,
  runtimeOptions = {},
} = {}) {
  if (!store?.readRecord || !store?.recordWorkerAttempt) {
    throw new Error("runtime_submit_worker_result requires a store.");
  }

  const record = await store.readRecord(runId);
  if (!EXECUTABLE_RUN_STATUSES.has(record.status)) {
    throw conflictError(`Run ${runId} cannot accept worker results from ${record.status} status.`);
  }

  const task = record.plan.tasks.find((candidate) => candidate.task_id === taskId || candidate.id === taskId);
  if (!task) {
    throw conflictError(`Task ${taskId} does not exist in run ${runId}.`);
  }

  const workspaceCwd = runtimeOptions.workspace?.cwd ?? process.cwd();
  const policy = runtimeOptions.policy;
  let contextPack;
  try {
    contextPack = await createContextPack({ cwd: workspaceCwd, task, policy });
  } catch (error) {
    contextPack = createFallbackContextPack({ cwd: workspaceCwd, task });
    const workerPrompt = redactSecrets(createWorkerPrompt({ task, contextPack }), policy);
    const contextValidation = {
      valid: false,
      errors: [
        {
          code: "worker.context.failed",
          message: error.message,
        },
      ],
    };
    await store.recordWorkerAttempt(
      runId,
      createWorkerAttempt({
        runId,
        task,
        result: redactSecrets(result, policy),
        status: "failed",
        applied: false,
        filesTouched: [],
        contextPack,
        workerPrompt,
        validation: contextValidation,
      })
    );
    throw validationError("Worker context generation failed", contextValidation);
  }
  const workerPrompt = redactSecrets(createWorkerPrompt({ task, contextPack }), policy);
  const safeResult = redactSecrets(result, policy);
  const validation = validateWorkerResult({ task, result });
  const patchValidation = validateWorkerPatch({ patch: result?.patch, task, policy });

  if (!validation.valid) {
    await store.recordWorkerAttempt(
      runId,
      createWorkerAttempt({
        runId,
        task,
        result: safeResult,
        status: "failed",
        applied: false,
        filesTouched: patchValidation.filesTouched,
        contextPack,
        workerPrompt,
        validation,
      })
    );
    throw validationError("Invalid worker result", validation);
  }

  if (!patchValidation.valid) {
    await store.recordWorkerAttempt(
      runId,
      createWorkerAttempt({
        runId,
        task,
        result: safeResult,
        status: "failed",
        applied: false,
        filesTouched: patchValidation.filesTouched,
        contextPack,
        workerPrompt,
        validation: patchValidation,
      })
    );
    throw validationError("Invalid worker patch", patchValidation);
  }

  if (apply) {
    try {
      await applyWorkerPatch({
        cwd: workspaceCwd,
        patch: result.patch,
        task,
        policy,
      });
    } catch (error) {
      const applyValidation = {
        valid: false,
        errors: [
          {
            code: "worker.patch.apply_failed",
            message: error.message,
          },
        ],
      };
      await store.recordWorkerAttempt(
        runId,
        createWorkerAttempt({
          runId,
          task,
          result: safeResult,
          status: "failed",
          applied: false,
          filesTouched: patchValidation.filesTouched,
          contextPack,
          workerPrompt,
          validation: applyValidation,
        })
      );
      throw validationError("Worker patch apply failed", applyValidation);
    }
  }

  const status = apply ? "applied" : "recorded";
  const attempt = createWorkerAttempt({
    runId,
    task,
    result: safeResult,
    status,
    applied: apply,
    filesTouched: patchValidation.filesTouched,
    contextPack,
    workerPrompt,
  });

  await store.recordWorkerAttempt(runId, attempt);

  return {
    runId,
    taskId: task.task_id,
    status,
    applied: apply,
    filesTouched: patchValidation.filesTouched,
  };
}

function createWorkerAttempt({
  runId,
  task,
  result = {},
  status,
  applied,
  filesTouched,
  contextPack,
  workerPrompt,
  validation = null,
}) {
  const attemptId = createAttemptId(task.task_id);
  const attempt = {
    attemptId,
    attempt_id: attemptId,
    runId,
    run_id: runId,
    taskId: task.task_id,
    task_id: task.task_id,
    status,
    applied,
    filesTouched,
    files_touched: filesTouched,
    explanation: result?.explanation ?? "",
    verificationNotes: result?.verificationNotes ?? [],
    verification_notes: result?.verificationNotes ?? [],
    confidence: typeof result?.confidence === "number" ? result.confidence : 0,
    acceptance: result?.acceptance ?? {},
    patch: result?.patch ?? "",
    context: {
      cwd: contextPack.cwd,
      fileCount: contextPack.totalFiles,
      files: contextPack.files.map((file) => ({
        path: file.path,
        sizeBytes: file.sizeBytes,
        truncated: file.truncated,
      })),
    },
    workerPrompt,
    worker_prompt: workerPrompt,
  };
  if (validation) {
    attempt.validation = validation;
  }

  return attempt;
}

export function validateWorkerResult({ task = {}, result = {} } = {}) {
  const errors = [];
  const workerResult = result && typeof result === "object" && !Array.isArray(result) ? result : {};

  if (workerResult !== result) {
    errors.push({
      code: "worker.result.invalid",
      message: "Worker result must be an object.",
    });
  }

  if (typeof workerResult.patch !== "string" || workerResult.patch.trim().length === 0) {
    errors.push({
      code: "worker.result.patch.required",
      message: "Worker result must include a non-empty patch string.",
    });
  }

  if (typeof workerResult.explanation !== "string" || workerResult.explanation.trim().length === 0) {
    errors.push({
      code: "worker.result.explanation.required",
      message: "Worker result must include explanation.",
    });
  }

  if (!Array.isArray(workerResult.verificationNotes) || workerResult.verificationNotes.length === 0) {
    errors.push({
      code: "worker.result.verification_notes.required",
      message: "Worker result must include verificationNotes.",
    });
  }

  if (typeof workerResult.confidence !== "number" || workerResult.confidence < 0 || workerResult.confidence > 1) {
    errors.push({
      code: "worker.result.confidence.invalid",
      message: "Worker result confidence must be a number between 0 and 1.",
    });
  }

  if (!Array.isArray(workerResult.filesTouched) || workerResult.filesTouched.length === 0) {
    errors.push({
      code: "worker.result.files_touched.required",
      message: "Worker result must include filesTouched.",
    });
  }

  for (const forbiddenAction of detectForbiddenActions({ task, result: workerResult })) {
    errors.push({
      code: "worker.result.forbidden_action",
      forbiddenAction,
      forbidden_action: forbiddenAction,
      message: `Worker result appears to include forbidden action: ${forbiddenAction}.`,
    });
  }

  const acceptance = workerResult.acceptance;
  if (!acceptance || typeof acceptance !== "object" || Array.isArray(acceptance)) {
    errors.push({
      code: "worker.result.acceptance.required",
      message: "Worker result must include acceptance evidence.",
    });
  } else {
    for (const item of task.acceptance ?? []) {
      if (typeof acceptance[item] !== "string" || acceptance[item].trim().length === 0) {
        errors.push({
          code: "worker.result.acceptance.missing",
          acceptance: item,
          message: `Worker result is missing evidence for acceptance criterion: ${item}.`,
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function detectForbiddenActions({ task = {}, result = {} } = {}) {
  const forbiddenActions = task.forbiddenActions ?? task.forbidden_actions ?? [];
  const resultText = [
    result.explanation,
    ...(Array.isArray(result.verificationNotes) ? result.verificationNotes : []),
    ...Object.values(result.acceptance ?? {}),
  ]
    .filter((value) => typeof value === "string")
    .join("\n")
    .toLowerCase();

  return forbiddenActions.filter((action) => {
    const normalized = String(action).trim().toLowerCase();
    return normalized.length > 0 && resultText.includes(normalized);
  });
}

export function createWorkerPrompt({ task = {}, contextPack = {} } = {}) {
  return [
    "You are an AI Coding Runtime worker.",
    "Execute only the provided task contract.",
    "",
    `Task: ${task.task_id ?? task.id} - ${task.title}`,
    `Goal: ${task.goal}`,
    `Allowed files: ${(task.allowed_files ?? task.allowedFiles ?? []).join(", ") || "none"}`,
    `Referenced files: ${(task.referenced_files ?? task.referencedFiles ?? []).join(", ") || "none"}`,
    `Forbidden actions: ${(task.forbidden_actions ?? task.forbiddenActions ?? []).join("; ") || "none"}`,
    "",
    "Acceptance criteria:",
    ...(task.acceptance ?? []).map((item) => `- ${item}`),
    "",
    "Context files:",
    ...formatContextFiles(contextPack.files ?? []),
    "",
    "Patch requirements:",
    "- Return a valid unified diff patch.",
    "- Include diff --git, ---, +++, and at least one hunk header with line numbers like @@ -12,3 +12,4 @@.",
    "- Do not return placeholder hunk markers such as @@ without line numbers.",
    "",
    "Acceptance evidence requirements:",
    "- The acceptance object must include every acceptance criterion above as an exact key.",
    "- Do not rename, summarize, omit, or translate acceptance keys.",
    "- Use this exact acceptance object shape:",
    JSON.stringify(createAcceptanceEvidenceTemplate(task.acceptance ?? []), null, 2),
    "",
    "Return structured output with patch, explanation, verificationNotes, confidence, filesTouched, and acceptance evidence.",
  ].join("\n");
}

function createAcceptanceEvidenceTemplate(acceptance = []) {
  return Object.fromEntries(
    acceptance
      .filter((item) => typeof item === "string" && item.length > 0)
      .map((item) => [item, "evidence for this exact criterion"])
  );
}

function formatContextFiles(files = []) {
  if (!Array.isArray(files) || files.length === 0) {
    return ["- none"];
  }

  return files.flatMap((file) => [
    `- ${file.path} (${file.sizeBytes} bytes${file.truncated ? ", truncated" : ""})`,
    "```",
    file.content ?? "",
    "```",
  ]);
}

function createFallbackContextPack({ cwd, task = {} }) {
  return {
    cwd,
    taskId: task.task_id ?? task.id ?? null,
    allowedFiles: task.allowedFiles ?? task.allowed_files ?? [],
    referencedFiles: task.referencedFiles ?? task.referenced_files ?? [],
    totalFiles: 0,
    files: [],
  };
}

function validationError(message, validation) {
  const error = new Error(`${message}: ${validation.errors.map((item) => item.code).join(", ")}`);
  error.statusCode = 409;
  error.validation = validation;
  return error;
}

function conflictError(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

function createAttemptId(taskId) {
  return `attempt_${taskId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
