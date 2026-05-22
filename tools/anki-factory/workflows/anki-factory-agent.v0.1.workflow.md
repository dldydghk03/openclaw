# Anki Factory Agent v0.1 Runtime Workflow

This is the public-safe runtime wrapper for the Anki Factory agent. It proves the agent shape without committing private lecture files, APKGs, recovered exam text, or local run outputs.

## Command

```bash
python3 tools/anki-factory/scripts/run_anki_factory.py \
  --run-id public-smoke \
  --mode lecture_only_preview \
  --course "신장학" \
  --lecture-title "합성 전해질 예시" \
  --professor "예시" \
  --lecture tools/anki-factory/fixtures/good/lecture.synthetic.md \
  --cards tools/anki-factory/fixtures/good/card-candidates.preview.json \
  --out-dir /tmp/anki-factory-public-smoke
```

## Runtime Phases

1. `source_intake.py` writes `source-bundle.json` and records missing inputs.
2. `build_deck_plan.py` writes `deck-plan.preview.md` and `coverage.plan.json`.
3. `quality_gate.py` validates candidate card format, visible field hygiene, table style, jokbo explanation quality, and phrasing warnings.
4. `human_review_pack.py` writes a review queue, Markdown pack, CSV sheet, and feedback JSONL template.
5. `run_anki_factory.py` writes `factory-run-manifest.json` and `factory-run-report.md`.

## Stop Rules

- If no cards are supplied, the run stops at `needs_card_candidates`.
- If quality errors or warnings exist, the run stops at `needs_rewrite`.
- This public workflow never exports or imports an APKG.
- Export remains a separate approval/read-back gated workflow.
