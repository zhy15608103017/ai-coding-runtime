import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { validateRuntimePlan } from "./contracts.js";

export class FileExecutionStore {
  constructor({ workspace = defaultRuntimeHome() } = {}) {
    this.workspace = resolve(workspace);
    this.runsDirectory = join(this.workspace, "runs");
  }

  async createRecord(plan, { now = new Date() } = {}) {
    const validation = validateRuntimePlan(plan);
    if (!validation.valid) {
      const error = new Error(
        `Invalid runtime plan: ${validation.errors.map((item) => item.code).join(", ")}`
      );
      error.validation = validation;
      throw error;
    }

    if (plan.budgetStatus?.allowed === false) {
      const error = new Error("Invalid runtime plan: budget.policy.violation");
      error.statusCode = 409;
      error.validation = {
        valid: false,
        errors: [
          {
            code: "budget.policy.violation",
            field: "budgetStatus",
            message: "Runtime execution is refused because the plan violates budget policy.",
            violations: plan.budgetStatus.violations,
          },
        ],
      };
      throw error;
    }

    if (plan.policyStatus?.allowed === false) {
      const error = new Error("Invalid runtime plan: policy.status.violation");
      error.statusCode = 409;
      error.validation = {
        valid: false,
        errors: [
          {
            code: "policy.status.violation",
            field: "policyStatus",
            message: "Runtime execution is refused because the plan violates user policy.",
            violations: plan.policyStatus.violations,
          },
        ],
      };
      throw error;
    }

    const expectedApprovalStatus = plan.approval.required ? "required" : "not_required";
    if (plan.approval.status !== expectedApprovalStatus) {
      const error = new Error("Invalid runtime plan: approval.status.inconsistent");
      error.validation = {
        valid: false,
        errors: [
          {
            code: "approval.status.inconsistent",
            field: "approval.status",
            message: "New runtime plans must start in their initial approval status.",
          },
        ],
      };
      throw error;
    }

    const runId = createRunId(now);
    const status = plan.approval.required ? "approval_required" : "planned";
    const storedPlan = applyRunIdToPlan({ ...plan, validation }, runId);
    const approvalEvents =
      status === "approval_required"
        ? [
            {
              type: "approval.required",
              timestamp: now.toISOString(),
              message: "Human approval is required before execution.",
              reasons: plan.approval.reasons,
            },
          ]
        : [];
    const routingEvents = (plan.routingTrace ?? []).map((route) => ({
      type: "task.routed",
      timestamp: now.toISOString(),
      taskId: route.task_id,
      task_id: route.task_id,
      modelTier: route.model_tier,
      model_tier: route.model_tier,
      reason: route.reason,
      selectedModel: route.selected_model,
      selected_model: route.selected_model,
      escalationTriggers: route.escalation_triggers,
      escalation_triggers: route.escalation_triggers,
    }));
    const record = {
      runId,
      status,
      request: plan.request,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      plan: storedPlan,
      events: [
        {
          type: "run.created",
          timestamp: now.toISOString(),
          message: "Runtime run record created.",
        },
        ...approvalEvents,
        ...routingEvents,
      ],
      modelCalls: [],
      verification: [],
      report: null,
    };

    await this.writeRecord(record);
    return record;
  }

  async readRecord(runId) {
    const content = await readFile(this.recordPath(runId), "utf8");
    return JSON.parse(content);
  }

  async appendEvent(runId, event, { now = new Date() } = {}) {
    const record = await this.readRecord(runId);
    record.events.push({
      timestamp: now.toISOString(),
      ...event,
    });
    record.updatedAt = now.toISOString();

    await this.writeRecord(record);
    return record;
  }

  async recordModelCall(runId, modelCall, { now = new Date() } = {}) {
    return this.updateRecord(
      runId,
      (record) => {
        record.modelCalls = Array.isArray(record.modelCalls) ? record.modelCalls : [];
        record.modelCalls.push({
          timestamp: now.toISOString(),
          ...modelCall,
        });
        record.events.push({
          type: "model.call.finished",
          timestamp: now.toISOString(),
          provider: modelCall.provider,
          model: modelCall.model,
          usage: modelCall.usage,
          costEstimate: modelCall.costEstimate,
          cost_estimate: modelCall.cost_estimate ?? modelCall.costEstimate,
        });
        return record;
      },
      { now }
    );
  }

  async recordModelCallFailure(runId, modelCall, { now = new Date() } = {}) {
    return this.updateRecord(
      runId,
      (record) => {
        record.modelCalls = Array.isArray(record.modelCalls) ? record.modelCalls : [];
        record.modelCalls.push({
          timestamp: now.toISOString(),
          status: "failed",
          ...modelCall,
        });
        record.events.push({
          type: "model.call.failed",
          timestamp: now.toISOString(),
          provider: modelCall.provider,
          model: modelCall.model,
          error: modelCall.error,
        });
        return record;
      },
      { now }
    );
  }

  async updateRecord(runId, updater, { now = new Date() } = {}) {
    const record = await this.readRecord(runId);
    const updated = await updater(record);
    updated.updatedAt = now.toISOString();
    await this.writeRecord(updated);
    return updated;
  }

  async listRecords() {
    await mkdir(this.runsDirectory, { recursive: true });
    const entries = await readdir(this.runsDirectory, { withFileTypes: true });
    const runIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const records = await Promise.all(runIds.map((runId) => this.readRecord(runId)));

    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  recordPath(runId) {
    return join(this.runsDirectory, runId, "run.json");
  }

  async writeRecord(record) {
    await mkdir(join(this.runsDirectory, record.runId), { recursive: true });
    await writeFile(this.recordPath(record.runId), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }
}

function applyRunIdToPlan(plan, runId) {
  if (!plan.taskGraph) {
    return plan;
  }

  const taskGraph = {
    ...plan.taskGraph,
    run_id: runId,
  };
  const planReport = plan.planReport
    ? {
        ...plan.planReport,
        taskGraph,
        task_graph: taskGraph,
      }
    : undefined;

  return {
    ...plan,
    taskGraph,
    task_graph: taskGraph,
    ...(planReport
      ? {
          planReport,
          plan_report: planReport,
        }
      : {}),
  };
}

function defaultRuntimeHome() {
  return process.env.AI_CODING_RUNTIME_HOME ?? join(process.cwd(), ".ai-coding-runtime");
}

function createRunId(now) {
  const timestamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
  const random = Math.random().toString(36).slice(2, 8);
  return `run_${timestamp}_${random}`;
}
