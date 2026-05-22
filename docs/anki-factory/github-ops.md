# Anki Factory GitHub Operations

This repository uses GitHub as the public-safe control plane for Anki Factory.
Private lecture notes, Drive exports, APKG source decks, recovered exam text,
and local run outputs must stay outside GitHub.

## Copilot Agent Policy

- Keep `copilot-ready` issues small enough for one isolated change.
- Assign only one active issue to Copilot at a time unless the write scopes are
  disjoint.
- Prefer documentation, validator, fixture, CI, and synthetic regression work.
- Do not ask Copilot to generate real medical cards from private source data.
- Require `.github/skills/anki-factory-quality/scripts/run-smoke.sh` before a
  Copilot PR is considered reviewable.

## Ruleset Policy

The `Require Anki Factory CI` ruleset should require the `Public fixture gates`
status check. It is safe to enforce once the workflow exists on the default
branch and the status check has appeared at least once.

## Project Backlog Policy

Use a GitHub Project named `Anki Factory Quality Backlog` with these fields:

- `Status`: Backlog, Ready, In progress, Review, Done.
- `Area`: Deck quality, Workflow gate, CI, Docs, Agent instruction.
- `Risk`: Low, Medium, High.

The first queue should contain the `copilot-ready` Anki Factory issues. Keep
issue bodies synthetic and link private evidence only as a redacted summary.

## Pages Dashboard Policy

GitHub Pages should publish only the generated public-safe quality dashboard.
The dashboard is built from the synthetic smoke report and must not contain
private deck output or source content.

## Codespaces Policy

Codespaces is for clean reproduction of public gates only:

```bash
.github/skills/anki-factory-quality/scripts/run-smoke.sh
```

If a private local deck failure needs reproduction, reduce it to a synthetic
fixture first, then validate it in Codespaces.
