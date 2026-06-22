import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

const requiredDocs = [
  "docs/integrations/README.md",
  "docs/integrations/codex-desktop.md",
  "docs/integrations/codex-cli.md",
  "docs/integrations/cursor.md",
  "docs/integrations/opencode.md",
  "docs/integrations/prompts.md",
  "docs/integrations/smoke-tests.md",
];

const jsonExamples = [
  "examples/codex-desktop/mcp.json",
  "examples/cursor/mcp.json",
  "examples/cursor/mcp-http.json",
  "examples/cursor/mcp-stdio.json",
  "examples/opencode/opencode.json",
  "examples/opencode/opencode-http.json",
];

test("Phase 8 integration guides exist for every supported host tool", async () => {
  for (const doc of requiredDocs) {
    const content = await readText(doc);
    assert.match(content, /AI Coding Runtime|Host Tool Integrations|Setup|Prompt|Smoke/);
  }
});

test("Phase 8 host guides include per-tool prompt, rule, and skill guidance", async () => {
  for (const doc of [
    "docs/integrations/codex-desktop.md",
    "docs/integrations/codex-cli.md",
    "docs/integrations/cursor.md",
    "docs/integrations/opencode.md",
  ]) {
    const content = await readText(doc);

    assert.match(content, /Recommended Prompts, Rules, And Skills/);
    assert.match(content, /skill/i);
    assert.match(content, /rule/i);
  }
});

test("Phase 8 sample MCP JSON configs are valid and name the runtime", async () => {
  for (const file of jsonExamples) {
    const parsed = JSON.parse(await readText(file));
    const serialized = JSON.stringify(parsed);

    assert.match(serialized, /ai-coding-runtime|ai_runtime/);
  }
});

test("Phase 8 Codex CLI TOML config names the runtime MCP command", async () => {
  const content = await readText("examples/codex-cli/config.toml");

  assert.match(content, /\[mcp_servers\.ai_coding_runtime\]/);
  assert.match(content, /command = "node"/);
  assert.match(content, /\.\/bin\/ai-coding-runtime\.js/);
  assert.match(content, /"mcp"/);
});

test("Phase 8 prompt samples cover required operating modes", async () => {
  const prompts = {
    "examples/prompts/plan-only.md": /plan-only|plan only/i,
    "examples/prompts/cost-optimized.md": /cost/i,
    "examples/prompts/premium-final-review.md": /premium final review|supervisor review/i,
    "examples/prompts/high-risk-require-approval.md": /approval|approve/i,
  };

  for (const [file, pattern] of Object.entries(prompts)) {
    const content = await readText(file);
    assert.match(content, pattern);
    assert.doesNotMatch(content, /plan, route, execute|Plan and execute/i);
  }
});

test("Phase 8 smoke checklists cover every supported host tool", async () => {
  const checklist = await readText("docs/integrations/smoke-tests.md");

  for (const tool of ["Codex Desktop", "Codex CLI", "Cursor", "OpenCode"]) {
    assert.match(checklist, new RegExp(tool));
    const toolChecklist = await readText(`examples/smoke-tests/${slug(tool)}.md`);
    assert.match(toolChecklist, /- \[ \]/);
    for (const runtimeTool of [
      "runtime_plan",
      "runtime_run",
      "runtime_status",
      "runtime_report",
    ]) {
      assert.match(toolChecklist, new RegExp(runtimeTool));
    }
  }
});

test("Phase 8 roadmap checklist remains complete without marking Phase 10 complete", async () => {
  const roadmap = await readText("total.md");
  const phase8 = sectionBetween(roadmap, "## Phase 8:", "## Phase 9:");
  const phase10 = sectionBetween(roadmap, "## Phase 10:", "## Phase 11:");

  assert.doesNotMatch(phase8, /plan, route, execute|execute through Runtime|Plan and execute/i);
  for (const task of phase8.matchAll(/- \[(x| )\] /g)) {
    assert.equal(task[1], "x");
  }
  assert.match(phase10, /- \[ \] /);
  assert.doesNotMatch(phase10, /- \[x\] /);
});

async function readText(file) {
  return readFile(path.join(root, file), "utf8");
}

function slug(tool) {
  return tool.toLowerCase().replace(/\s+/g, "-");
}

function sectionBetween(content, startMarker, endMarker) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start + startMarker.length);

  assert.notEqual(start, -1, `${startMarker} not found`);
  assert.notEqual(end, -1, `${endMarker} not found`);
  return content.slice(start, end);
}
