---
name: anki-factory-quality
description: Public-safe Anki Factory quality gate, fixture, schema, CI, and documentation maintenance. Use for tools/anki-factory and docs/anki-factory changes; never use with private lecture/APKG/run data.
---

# Anki Factory Quality

Use this skill when working on Anki Factory code, schemas, fixtures, quality gates, CI, or documentation.

## Scope

Allowed:

- `tools/anki-factory/**`
- `docs/anki-factory/**`
- `.github/copilot-instructions.md`
- `.github/instructions/anki-factory.instructions.md`
- `.github/agents/anki-factory-maintainer.agent.md`
- `.github/hooks/anki-factory-quality.json`
- `.github/hooks/anki-factory-smoke.sh`
- `.github/workflows/anki-factory-ci.yml`

Not allowed:

- Real lecture notes, recovered exam files, APKGs, or Google Drive exports.
- Private run outputs under `output/**/runs/**`.
- Private Obsidian vault material.
- Any new custom Anki note type.

## Quality Rules

1. Only `standard_basic`, `standard_cloze`, and `standard_new_jokbo` candidates are valid.
2. Public fixtures must be synthetic.
3. Visible fields must not leak metadata labels.
4. Jokbo cards with options must explain multiple options.
5. Tables should use border, collapsed borders, full width, centered text, padding, and gray header.
6. Basic card fronts should be compact titles.
7. APKG workflows must preserve preview, approval, export, and read-back.
8. Copilot instructions, agent, skill, hook, and CI must all delegate to the same smoke command.
9. Agent evals must distinguish good changes from bad changes before a PR is considered ready.
10. Instruction files must stay under the budget and keep core rules near the top.
11. Phrasing regressions from user feedback must remain covered by evals.

## Commands

Run the public smoke check:

```bash
.github/skills/anki-factory-quality/scripts/run-smoke.sh
```

The command emits one JSON object with `fixture_gate`, `copilot_integration_gate`, and `agent_eval_gate` sections so CI, hooks, and agents can parse the same report.

The `agent_eval_gate` comes from:

```bash
python3 tools/anki-factory/scripts/run_agent_evals.py
```

## Review Checklist

- Did the change add synthetic positive and negative coverage?
- Did it avoid private examples?
- Does it preserve standardized note type contracts?
- Does it fail closed when metadata leaks or jokbo explanations are weak?
- Does documentation match the gate behavior?
- Does the unified smoke report still include `agent_eval_gate`?
- Did the change avoid weakening or deleting bad-change eval cases?
- Did the change keep user-specific phrasing regressions covered?
- Did the change keep core Copilot instructions within the budget guard?
