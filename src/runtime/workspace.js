import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { evaluateFilePolicy } from "./policy.js";

const DEFAULT_SKIP_DIRECTORIES = new Set([
  ".git",
  ".ai-coding-runtime",
  ".ai-review",
  ".codegraph",
  "node_modules",
]);

export async function createWorkspaceSnapshot({
  cwd = process.cwd(),
  maxFiles = 500,
  skipDirectories = DEFAULT_SKIP_DIRECTORIES,
} = {}) {
  const root = path.resolve(cwd);
  const files = [];

  await walkWorkspace(root, "", files, { maxFiles, skipDirectories });

  return {
    cwd: root,
    totalFiles: files.length,
    files,
  };
}

export async function createContextPack({
  cwd = process.cwd(),
  task = {},
  maxBytesPerFile = 64 * 1024,
  policy = null,
} = {}) {
  const snapshot = await createWorkspaceSnapshot({ cwd });
  const allowedFiles = taskStringArray(task, "allowedFiles", "allowed_files");
  const referencedFiles = taskStringArray(
    task,
    "referencedFiles",
    "referenced_files",
    "referenceFiles",
    "reference_files"
  );
  const contextPatterns = uniqueStrings([...allowedFiles, ...referencedFiles]);
  const policyViolations = [];
  const selectedFiles = snapshot.files.filter((file) => {
    if (!isAllowedPath(file.path, contextPatterns)) return false;
    if (!policy) return true;

    const evaluation = evaluateFilePolicy({ filePath: file.path, policy });
    if (!evaluation.allowed) {
      policyViolations.push(...evaluation.violations);
      return false;
    }

    return true;
  });

  if (policyViolations.length > 0) {
    const error = new Error(
      `Workspace context violates policy: ${policyViolations.map((item) => item.code).join(", ")}`
    );
    error.statusCode = 409;
    error.validation = {
      valid: false,
      errors: policyViolations,
    };
    throw error;
  }

  const files = [];

  for (const file of selectedFiles) {
    const absolutePath = path.join(snapshot.cwd, file.path);
    const content = await readFile(absolutePath, "utf8");
    const truncated = Buffer.byteLength(content, "utf8") > maxBytesPerFile;
    files.push({
      path: file.path,
      sizeBytes: file.sizeBytes,
      content: truncated ? content.slice(0, maxBytesPerFile) : content,
      truncated,
    });
  }

  return {
    cwd: snapshot.cwd,
    taskId: task.task_id ?? task.id ?? null,
    allowedFiles,
    referencedFiles,
    totalFiles: files.length,
    files,
  };
}

export function validateWorkerPatch({ patch, task = {}, policy = null } = {}) {
  const errors = [];
  const filesTouched = extractPatchFiles(patch);
  const allowedFiles = taskStringArray(task, "allowedFiles", "allowed_files");

  if (typeof patch !== "string" || patch.trim().length === 0) {
    errors.push({
      code: "worker.patch.required",
      message: "Worker result must include a non-empty patch.",
    });
  }

  if (filesTouched.length === 0) {
    errors.push({
      code: "worker.patch.files_required",
      message: "Worker patch must touch at least one file.",
    });
  }

  errors.push(...validatePatchStructure({ patch, filesTouched }));

  for (const filePath of filesTouched) {
    if (!isAllowedPath(filePath, allowedFiles)) {
      errors.push({
        code: "worker.patch.forbidden_file",
        file: filePath,
        message: `Worker patch touches file outside allowed_files: ${filePath}.`,
      });
    }
    if (policy) {
      const policyEvaluation = evaluateFilePolicy({ filePath, policy });
      errors.push(...policyEvaluation.violations);
    }
  }

  return {
    valid: errors.length === 0,
    filesTouched,
    errors,
  };
}

function validatePatchStructure({ patch, filesTouched }) {
  if (typeof patch !== "string" || patch.trim().length === 0 || filesTouched.length === 0) {
    return [];
  }

  const errors = [];
  const lines = patch.split(/\r?\n/);
  const hunkHeaders = lines.filter((line) => line.startsWith("@@ "));
  const validHunkPattern = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

  if (hunkHeaders.length === 0) {
    errors.push({
      code: "worker.patch.malformed",
      message: "Worker patch must include at least one unified diff hunk.",
    });
  }

  for (const header of hunkHeaders) {
    if (!validHunkPattern.test(header)) {
      errors.push({
        code: "worker.patch.malformed",
        message: `Worker patch includes malformed hunk header: ${header}.`,
      });
    }
  }

  const sectionFiles = new Set(parsePatchSections(patch).map((section) => section.filePath));
  for (const filePath of filesTouched) {
    if (!sectionFiles.has(filePath)) {
      errors.push({
        code: "worker.patch.malformed",
        file: filePath,
        message: `Worker patch has no valid hunk for touched file: ${filePath}.`,
      });
    }
  }

  return errors;
}

export function extractPatchFiles(patch = "") {
  const files = new Set();
  const lines = String(patch).split(/\r?\n/);

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/);
      if (match) {
        files.add(normalizePatchPath(match[2]));
      }
      continue;
    }

    if (line.startsWith("+++ ") && !line.includes("/dev/null")) {
      const target = line.slice(4).trim();
      files.add(stripPatchPrefix(target));
    }
  }

  return [...files].filter(Boolean).sort();
}

export async function applyWorkerPatch({ cwd = process.cwd(), patch, task = {}, policy = null } = {}) {
  const validation = validateWorkerPatch({ patch, task, policy });
  if (!validation.valid) {
    const error = new Error(
      `Invalid worker patch: ${validation.errors.map((item) => item.code).join(", ")}`
    );
    error.statusCode = 409;
    error.validation = validation;
    throw error;
  }

  const root = path.resolve(cwd);
  const sections = parsePatchSections(patch);
  const updatesByPath = new Map();

  for (const section of sections) {
    const filePath = normalizeSafeWorkspacePath(section.filePath);
    if (!filePath) {
      throw new Error(`Patch path is not a safe workspace-relative path: ${section.filePath}`);
    }

    const absolutePath = path.resolve(root, filePath);
    assertInsideWorkspace(root, absolutePath);

    let update = updatesByPath.get(filePath);
    if (!update) {
      const content = await readFile(absolutePath, "utf8");
      update = {
        absolutePath,
        original: content,
        updated: content,
      };
      updatesByPath.set(filePath, update);
    }

    update.updated = applyHunksToContent(update.updated, section.hunks);
  }

  const written = [];
  try {
    for (const update of updatesByPath.values()) {
      await mkdir(path.dirname(update.absolutePath), { recursive: true });
      await writeFile(update.absolutePath, update.updated, "utf8");
      written.push(update);
    }
  } catch (error) {
    for (const update of written.reverse()) {
      try {
        await writeFile(update.absolutePath, update.original, "utf8");
      } catch {
        // Preserve the original write failure while making a best effort rollback.
      }
    }
    throw error;
  }

  return {
    status: "applied",
    filesTouched: validation.filesTouched,
  };
}

export function isAllowedPath(filePath, allowedFiles = []) {
  const normalized = normalizeSafeWorkspacePath(filePath);
  if (!normalized) return false;
  return allowedFiles.some((pattern) => matchesAllowedPattern(normalized, pattern));
}

async function walkWorkspace(root, relativeDirectory, files, options) {
  if (files.length >= options.maxFiles) return;

  const absoluteDirectory = path.join(root, relativeDirectory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });

  for (const entry of entries) {
    if (files.length >= options.maxFiles) return;
    if (entry.isDirectory() && options.skipDirectories.has(entry.name)) continue;

    const relativePath = normalizeWorkspacePath(path.join(relativeDirectory, entry.name));
    const absolutePath = path.join(root, relativePath);

    if (entry.isDirectory()) {
      await walkWorkspace(root, relativePath, files, options);
    } else if (entry.isFile()) {
      const info = await stat(absolutePath);
      files.push({
        path: relativePath,
        sizeBytes: info.size,
        modifiedAt: info.mtime.toISOString(),
      });
    }
  }
}

function matchesAllowedPattern(filePath, pattern) {
  const normalizedPattern = normalizeAllowedPattern(pattern);
  if (!normalizedPattern) return false;
  if (normalizedPattern === filePath) return true;
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -2);
    return filePath.startsWith(prefix);
  }
  if (!normalizedPattern.includes("*")) return false;

  const expression = `^${escapeRegExp(normalizedPattern).replaceAll("\\*", "[^/]*")}$`;
  return new RegExp(expression).test(filePath);
}

function parsePatchSections(patch) {
  const lines = String(patch).split(/\r?\n/);
  const sections = [];
  let current = null;
  let currentHunk = null;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (currentHunk && current) current.hunks.push(currentHunk);
      if (current) sections.push(current);
      const match = line.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/);
      current = {
        filePath: match ? match[2] : null,
        hunks: [],
      };
      currentHunk = null;
      continue;
    }

    if (!current) continue;

    if (line.startsWith("+++ ") && !line.includes("/dev/null")) {
      current.filePath = stripPatchPrefix(line.slice(4).trim());
      continue;
    }

    if (line.startsWith("@@ ")) {
      if (currentHunk) current.hunks.push(currentHunk);
      const match = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      currentHunk = {
        oldStart: match ? Number(match[1]) : 1,
        newStart: match ? Number(match[2]) : 1,
        lines: [],
      };
      continue;
    }

    if (currentHunk && /^[ +\-]/.test(line)) {
      currentHunk.lines.push(line);
    }
  }

  if (currentHunk && current) current.hunks.push(currentHunk);
  if (current) sections.push(current);

  return sections.filter((section) => section.filePath && section.hunks.length > 0);
}

function applyHunksToContent(content, hunks) {
  const hadFinalNewline = content.endsWith("\n");
  const originalLines = content.length === 0
    ? []
    : (hadFinalNewline ? content.slice(0, -1) : content).split(/\r?\n/);
  const output = [];
  let cursor = 0;

  for (const hunk of hunks) {
    const hunkStart = Math.max(hunk.oldStart - 1, 0);
    if (hunkStart > originalLines.length) {
      throw new Error(`Patch hunk starts beyond end of file at line ${hunk.oldStart}.`);
    }
    while (cursor < hunkStart) {
      output.push(originalLines[cursor]);
      cursor += 1;
    }

    for (const line of hunk.lines) {
      const marker = line[0];
      const value = line.slice(1);

      if (marker === " ") {
        assertPatchLineMatches(originalLines[cursor], value);
        output.push(originalLines[cursor]);
        cursor += 1;
      } else if (marker === "-") {
        assertPatchLineMatches(originalLines[cursor], value);
        cursor += 1;
      } else if (marker === "+") {
        output.push(value);
      }
    }
  }

  while (cursor < originalLines.length) {
    output.push(originalLines[cursor]);
    cursor += 1;
  }

  return `${output.join("\n")}${hadFinalNewline ? "\n" : ""}`;
}

function assertPatchLineMatches(actual, expected) {
  if (actual !== expected) {
    throw new Error(`Patch context mismatch. Expected "${expected}", found "${actual ?? ""}".`);
  }
}

function assertInsideWorkspace(cwd, absolutePath) {
  const root = path.resolve(cwd);
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Patch path escapes workspace: ${absolutePath}`);
  }
}

function stripPatchPrefix(value) {
  return normalizePatchPath(value.replace(/^(a|b)\//, ""));
}

function normalizeWorkspacePath(value = "") {
  return String(value).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function normalizePatchPath(value = "") {
  return String(value).replace(/\\/g, "/").replace(/\/+$/, "");
}

function normalizeSafeWorkspacePath(value = "") {
  const raw = normalizePatchPath(value);
  if (!raw || raw.includes("\0")) return null;
  if (raw.startsWith("/") || raw.startsWith("//")) return null;
  if (/^[A-Za-z]:/.test(raw)) return null;

  const segments = raw.split("/");
  if (segments.some((segment) => segment === "..")) return null;

  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    return null;
  }

  return normalized;
}

function normalizeAllowedPattern(pattern = "") {
  const raw = normalizePatchPath(pattern);
  if (!raw || raw.includes("\0")) return "";
  if (raw.startsWith("/") || raw.startsWith("//")) return "";
  if (/^[A-Za-z]:/.test(raw)) return "";

  const segments = raw.split("/");
  if (segments.some((segment) => segment === "..")) return "";

  return segments.filter((segment) => segment && segment !== ".").join("/");
}

function taskStringArray(task, ...fields) {
  for (const field of fields) {
    if (Array.isArray(task?.[field])) {
      return uniqueStrings(task[field]);
    }
  }

  return [];
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function escapeRegExp(value) {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
