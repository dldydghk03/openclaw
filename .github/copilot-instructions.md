# Repository Copilot Instructions

Follow `AGENTS.md` first. These additional rules exist so Copilot can review Anki Factory work safely.

## Privacy Boundary

- Do not add private lecture notes, transcripts, screenshots, Drive exports, APKGs, recovered exam files, or run outputs to the repository.
- Treat `output/hermes-codex-runtime/anki-agent/runs/**`, `Vault/**`, and local user paths as private local data.
- If a bug comes from private data, reduce it to a synthetic fixture under `tools/anki-factory/fixtures/**`.

## Anki Factory Hard Rules

- Generated decks may use only `@표준화 Basic`, `@표준화 Cloze`, and `@표준화 뉴족보`.
- Never create, rename, reorder, or restyle note types or fields.
- Visible card fields must not contain metadata labels such as `learning_intent`, `source_refs`, `candidate_id`, `problem_classification`, or `lecture_support`.
- Jokbo cards with visible options must include option-level explanation, not just the answer.
- APKG export workflows must require preview, approval, export, and read-back in the same job.
- Public CI must use synthetic fixtures only.

## Copilot Role

Use Copilot for code maintenance, schemas, tests, fixtures, CI, and documentation. Do not use Copilot to write real medical cards from private sources.
