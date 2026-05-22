# Anki Factory Agent Evals

This directory contains public-safe deterministic evals for Anki Factory agent changes.

The evals are intentionally synthetic. They do not contain private lecture notes, real APKG content, recovered exam text, local Drive exports, or run outputs.

## What The Evals Check

- Good card-quality changes still pass without warnings.
- Bad learner-visible card changes are rejected or warned with the expected gate codes.
- Copilot integration drift is rejected when instructions, the custom agent, the skill, hooks, or CI stop pointing to the same smoke command.
- Private local paths or source markers are rejected in public Copilot-facing files.
- Eval coverage cannot be silently reduced by deleting required good-change or bad-change cases.
- The smoke command cannot skip `run_agent_evals.py` or omit `agent_eval_gate`.

## Command

```bash
python3 tools/anki-factory/scripts/run_agent_evals.py
```

The public smoke command runs these evals automatically.
