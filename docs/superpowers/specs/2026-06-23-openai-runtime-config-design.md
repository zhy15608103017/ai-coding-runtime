# OpenAI Runtime Config Design

**Objective:** Add a local runtime configuration that uses a real `openai-compatible` provider so AI Coding Runtime can start collecting real Phase 11 run history.

## Scope

This change is limited to local configuration and config hygiene. It does not change runtime code, routing logic, provider adapters, or execution behavior.

## Decisions

1. Create a local `runtime.config.json` in the repository root.
2. Use `openai-compatible` as the default provider.
3. Keep API credentials out of the file and continue to load them from `OPENAI_API_KEY`.
4. Start with routing option 1:
   - `cheap` -> `gpt-4.1-mini`
   - `standard` -> `gpt-4.1-mini`
   - `premium` -> `gpt-4.1`
5. Configure final verification to use the `premium` mapping through `openai-compatible` + `gpt-4.1`.
6. Keep the existing storage, budget, policy, and verification defaults unless they are needed for real provider execution.
7. Add `runtime.config.json` to `.gitignore` so local runtime setup is not committed accidentally.

## Expected Outcome

After this change, the repository can be configured with a real OpenAI-compatible provider and begin recording real execution history in `.ai-coding-runtime/runs` after `run`, `approve`, `execute`, and `report`.

## Non-Goals

- No secret values are committed.
- No automatic Phase 11 learning logic is added.
- No provider retry or routing strategy changes are introduced.
- No Phase 10.6 execution hardening work is included.
