import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export class FileExecutionStore {
  constructor({ workspace = defaultRuntimeHome() } = {}) {
    this.workspace = resolve(workspace);
    this.runsDirectory = join(this.workspace, "runs");
  }

  async createRecord(plan, { now = new Date() } = {}) {
    const runId = createRunId(now);
    const record = {
      runId,
      status: "planned",
      request: plan.request,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      plan,
      events: [
        {
          type: "run.created",
          timestamp: now.toISOString(),
          message: "Runtime run record created.",
        },
      ],
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

function defaultRuntimeHome() {
  return process.env.AI_CODING_RUNTIME_HOME ?? join(process.cwd(), ".ai-coding-runtime");
}

function createRunId(now) {
  const timestamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
  const random = Math.random().toString(36).slice(2, 8);
  return `run_${timestamp}_${random}`;
}

