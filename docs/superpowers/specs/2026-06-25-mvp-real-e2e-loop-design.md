# MVP Real End-to-End Loop Design

## Objective

Define the smallest trustworthy MVP loop for AI Coding Runtime: a real local coding request moves from planning to execution, verification, inspection, reporting, and audit evidence without relying on a placeholder-only demonstration.

The MVP should prove that the runtime is not only a planning skeleton. It can safely route work, control edits, run verification, explain what happened, and leave evidence another user can inspect.

## Primary Scenario

Use one small, real repository change as the demonstration case. The preferred case is a low-to-medium risk improvement to runtime observability, such as tightening `runtime_inspect` output or documenting a real run. The task should be small enough to finish in one run, but concrete enough to modify at least one tracked file and run tests.

The scenario must use a configured real provider for at least one model-backed step. `local-placeholder` may remain available for fallback checks, but the MVP evidence cannot be based only on placeholder output.

## Loop

The MVP loop is:

1. User gives a concrete coding request.
2. Runtime creates a plan with task contracts, task graph, risk, model tier, routing reasons, file scope, and acceptance criteria.
3. Runtime estimates budget and identifies whether approval is required.
4. User approves the run when the approval gate requires it.
5. Runtime executes eligible worker tasks with structured worker output.
6. Runtime validates patches against `allowed_files` and policy before applying them.
7. Runtime verifies the run with configured checks, including `git diff --check` and `npm test`.
8. User inspects the run through `runtime_inspect` or `ai-coding-runtime inspect`.
9. Runtime generates a report with task, routing, cost, verification, risk, and follow-up evidence.
10. Runtime generates a redacted audit export for the completed run.

## Required Evidence

The final MVP documentation must include:

- the original user request used for the run
- the run id
- the provider and model used, without secrets
- the task breakdown and routing summary
- the approval status and approval command when applicable
- the files changed by the worker task
- verification command summaries
- inspection output summary
- report summary
- audit export summary and redaction note
- lessons learned from the run

The documentation should summarize important outputs rather than paste entire JSON blobs. Full raw run records can stay under `.ai-coding-runtime/runs/<run-id>/`.

## Acceptance Criteria

- A real provider is configured and used for at least one model-backed step.
- At least one tracked file is modified through the runtime worker-result or execution path.
- Runtime rejects edits outside the task contract if attempted during the run or in a documented safety check.
- `git diff --check` passes after the run.
- `npm test` passes after the run.
- `runtime_inspect` or `ai-coding-runtime inspect` explains task state, routing, verification, and next actions.
- `runtime_report` or `ai-coding-runtime report` includes routing, cost, verification, and risk evidence.
- `runtime_audit` or `ai-coding-runtime audit` exports redacted completed-run evidence without secrets.
- A human-readable document at `docs/mvp-real-e2e.md` allows another user to reproduce the loop with their own provider credentials.

## Non-Goals

- No automatic learned routing.
- No LLM classifier taking over production routing.
- No hosted sync or team account system.
- No broad UI project.
- No attempt to support every provider perfectly in the MVP.
- No large architecture refactor.
- No requirement to commit generated run artifacts under `.ai-coding-runtime/`.

## Suggested Documentation Shape

Create `docs/mvp-real-e2e.md` after the run is completed.

Recommended sections:

- Goal
- Environment
- Provider Configuration
- User Request
- Step 1: Plan
- Step 2: Approve
- Step 3: Execute
- Step 4: Verify
- Step 5: Inspect
- Step 6: Report
- Step 7: Audit
- Result
- Lessons

## Risks And Mitigations

The main risk is turning the MVP into a feature sprint. Keep the first loop focused on proving trust, not adding scope. If the run exposes missing ergonomics, record them in Lessons and defer them unless they block the loop.

The second risk is demonstrating only with placeholder providers. That would validate plumbing but not the cost-aware model-routing story. Use a real provider for the run, and document provider setup without storing credentials.

The third risk is leaking sensitive data into reports or review artifacts. Use the existing policy redaction and audit export behavior, and summarize outputs in docs instead of committing raw traces.

## Follow-Up Sequence

After the MVP loop is documented:

1. Add a shadow LLM classifier that runs beside deterministic routing and records differences without changing routing decisions.
2. Add a minimal Phase 12 visualization focused on run status, task graph, model tier, budget, approval, and verification state.
3. Revisit learned or advisory routing only after enough real run samples exist.
