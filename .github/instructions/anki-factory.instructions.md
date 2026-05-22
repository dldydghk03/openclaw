---
applyTo: "tools/anki-factory/**,docs/anki-factory/**,.github/copilot-instructions.md,.github/instructions/anki-factory.instructions.md,.github/agents/anki-factory-maintainer.agent.md,.github/skills/anki-factory-quality/**,.github/hooks/anki-factory-*.json,.github/hooks/anki-factory-*.sh,.github/workflows/anki-factory-ci.yml"
---

# Anki Factory Copilot Review Rules

Review Anki Factory changes as production workflow changes, not simple docs or script edits.

## Blockers

- P1: Any change that allows non-standard note types, field drift, template drift, or CSS drift.
- P1: Any APKG export path that can run without preview, approval, and read-back.
- P1: Any public fixture or documentation that contains private lecture/APKG/jokbo content, absolute user paths, or local Drive/Vault material.
- P1: Any jokbo card validator that allows visible options with answer-only explanations.
- P1: Any card field that can leak metadata labels such as `learning_intent`, `source_refs`, `candidate_id`, `problem_classification`, `lecture_support`, or review status.
- P1: Any current-lecture unsupported jokbo path that omits the visible caveat.

## Expected Positive Pattern

- Put public-safe engine code under `tools/anki-factory/**`.
- Keep private generation runs under local `output/**` only.
- Add synthetic good and bad fixtures for every new quality rule.
- Run `python3 tools/anki-factory/scripts/validate_public_fixtures.py`.
- Keep examples short and synthetic.

## Tone And Content

Do not rewrite real card content. For documentation examples, use synthetic medical-study-like examples that cannot identify a real lecture or recovered exam source.
