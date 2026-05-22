# Copilot Operation For Anki Factory

GitHub Copilot is used as an engine-maintenance layer for Anki Factory. It must not handle private lecture notes, real APKG source decks, recovered exam files, or run outputs.

## Target Architecture

```text
Private source material
-> local Anki Factory generation
-> preview APKG and human review pack

Public-safe engine code
-> GitHub PR
-> Copilot review, Copilot agent, CI fixtures
-> improved local Anki Factory
```

## Copilot Should Handle

- Quality gate implementation and refactors.
- JSON schema changes.
- Synthetic fixture creation.
- CI and hook scripts.
- APKG profiler and read-back validation code.
- Documentation that contains only public-safe synthetic examples.
- Regression tests for previously observed failure modes.

## Copilot Must Not Handle

- Real lecture notes, transcripts, screenshots, Drive exports, or APKGs.
- Real recovered exam-question content.
- Private `output/hermes-codex-runtime/anki-agent/runs/**` artifacts.
- Obsidian vault material that contains personal study data.
- Any code path that imports private sources into GitHub.
- Any change to standardized note type names, fields, templates, or CSS.

## Review Priorities

Treat these as P1 review findings:

- Non-standard note type creation or template/field drift.
- APKG export without preview, approval, and read-back.
- Visible metadata leakage into card fields.
- Jokbo cards with visible options but answer-only explanations.
- Missing current-lecture support caveat for unsupported jokbo items.
- Source code or fixtures containing absolute local paths, private names, or real course-source text.
- CI that passes without checking both positive and negative synthetic fixtures.

## Why This Is Layered

Copilot instructions are useful but still advisory. Anki Factory therefore uses four layers instead of relying on prompt text alone:

- Repository and path-specific Copilot instructions describe the expected review behavior.
- A custom Copilot agent narrows the work to public-safe engine maintenance.
- A Copilot skill gives the agent a repeatable smoke command and scope boundary.
- CI and the `agentStop` hook run deterministic checks so metadata leaks, weak jokbo explanations, table formatting drift, and note-type drift are blocked even if a reviewer misses them.
- `validate_copilot_integration.py` checks that the instruction files, custom agent, skill, hook, and CI all point at the same smoke command and preserve the same public/private boundary.
- `run_agent_evals.py` adds synthetic good-change and bad-change scenarios so the agent is judged on whether it can preserve good edits and reject bad ones.

## PR Check Interpretation

When this workflow is first introduced on a branch, GitHub may not list the new workflow on the repository default branch until the workflow file exists there. In that phase, the local smoke command and the Copilot `agentStop` hook are the authoritative checks for this integration. Existing repository workflows can still fail for unrelated repository-secret setup issues; those failures should be separated from Anki Factory validation by checking the failing job log.

## Local-Only Data Boundary

The local `output/hermes-codex-runtime/anki-agent/runs/**` directory can be used by Codex/Hermes for private runs, but it is not a Copilot input. When a bug is found from a private run, reduce it to a synthetic fixture before opening a GitHub PR.

## Recommended Pull Request Shape

- One PR per gate, schema, or workflow change.
- Include a synthetic good fixture and a synthetic bad fixture when adding a rule.
- Include the exact command used to validate fixtures.
- Do not include generated APKGs or private decks.

## GitHub Operating Loop

Use GitHub as the public-safe maintenance queue for Anki Factory:

- File an `Anki Factory improvement` issue for engine, schema, fixture, CI, hook, or documentation work.
- File a `Deck quality regression` issue when private runs reveal a bad pattern, but reduce the finding to synthetic or redacted evidence before it enters GitHub.
- File a `Workflow gate change` issue for preview, approval, export, read-back, external-write, migration, or cleanup safeguards.
- Keep Copilot-ready work small enough for one deterministic fix plus one synthetic good/bad eval.

## Required Evidence

Every Anki Factory PR should preserve a review trail:

- The PR checklist must state whether preview, approval, and read-back are applicable.
- The smoke command must run before handoff.
- The CI artifact `anki-factory-smoke-report` is the public-safe review record.
- `fixture_gate` shows standardized-card and public fixture health.
- `copilot_integration_gate` shows GitHub instruction, hook, CI, and template wiring health.
- `agent_eval_gate` shows whether known good and bad agent changes are still distinguished.

The repository ruleset requires the `Public fixture gates` status check on the default branch so gate changes cannot merge without the public smoke path.
