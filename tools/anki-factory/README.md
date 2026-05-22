# Anki Factory Public Core

This directory contains the public-safe Anki Factory quality engine used by GitHub Copilot review and CI.

It intentionally excludes private lecture notes, real APKG source decks, recovered exam files, Google Drive exports, and run outputs.

## What Lives Here

- `scripts/apkg_profiler.py`: read-only APKG structure profiler.
- `scripts/source_intake.py`: records explicit source inputs and missing materials.
- `scripts/build_deck_plan.py`: creates `deck-plan.preview.md` and source coverage JSON.
- `scripts/quality_gate.py`: deterministic candidate/APKG quality gate.
- `scripts/human_review_pack.py`: builds a review queue, Markdown pack, CSV sheet, and feedback template.
- `scripts/run_anki_factory.py`: one-command public-safe preview runner.
- `scripts/validate_public_fixtures.py`: synthetic fixture smoke test for CI and Copilot hooks.
- `scripts/validate_copilot_integration.py`: checks Copilot instructions, agent, skill, hooks, and CI wiring.
- `scripts/run_agent_evals.py`: runs public-safe good-change and bad-change evals.
- `profiles/**`: public-safe agent profile contracts.
- `workflows/**`: public-safe runtime workflow and state-machine specs.
- `schemas/*.schema.json`: public-safe JSON schemas.
- `fixtures/good/**`: synthetic candidates that must pass.
- `fixtures/bad/**`: synthetic candidates that must fail or warn in expected ways.
- `evals/**`: deterministic agent-change eval cases.
- `standardized-anki-contract.json`: sanitized note-type contract without local paths.
- `anki-factory-spec.md`: public-safe architecture and quality rules.

## Local Smoke

```bash
.github/skills/anki-factory-quality/scripts/run-smoke.sh
```

## Privacy Rule

If a private deck run reveals a bug, convert it into a synthetic fixture here. Do not copy private card text, APKG content, lecture notes, or local paths into this directory.
