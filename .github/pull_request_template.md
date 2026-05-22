## Summary

Describe the problem and fix in 2–5 bullets:

- Problem:
- Why it matters:
- What changed:
- What did NOT change (scope boundary):

## Change Type (select all)

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor
- [ ] Docs
- [ ] Security hardening
- [ ] Chore/infra

## Scope (select all touched areas)

- [ ] Gateway / orchestration
- [ ] Skills / tool execution
- [ ] Auth / tokens
- [ ] Memory / storage
- [ ] Integrations
- [ ] API / contracts
- [ ] UI / DX
- [ ] CI/CD / infra

## Linked Issue/PR

- Closes #
- Related #

## User-visible / Behavior Changes

List user-visible changes (including defaults/config).  
If none, write `None`.

## Security Impact (required)

- New permissions/capabilities? (`Yes/No`)
- Secrets/tokens handling changed? (`Yes/No`)
- New/changed network calls? (`Yes/No`)
- Command/tool execution surface changed? (`Yes/No`)
- Data access scope changed? (`Yes/No`)
- If any `Yes`, explain risk + mitigation:

## Repro + Verification

### Environment

- OS:
- Runtime/container:
- Model/provider:
- Integration/channel (if any):
- Relevant config (redacted):

### Steps

1.
2.
3.

### Expected

-

### Actual

-

## Evidence

Attach at least one:

- [ ] Failing test/log before + passing after
- [ ] Trace/log snippets
- [ ] Screenshot/recording
- [ ] Perf numbers (if relevant)

## Anki Factory / Workflow Gate Evidence

Complete this section when the PR touches `tools/anki-factory/**`, `docs/anki-factory/**`, Copilot instructions, hooks, CI, approval gates, exports, migrations, external writes, or workflow prompts. Otherwise check `Not applicable`.

- [ ] Not applicable
- [ ] Preview artifact or synthetic preview fixture is identified.
- [ ] Approval path is preserved, including `preview_file` and `approval_id` when apply/export is possible.
- [ ] Post-apply or post-export read-back is preserved when apply/export is possible.
- [ ] `.github/skills/anki-factory-quality/scripts/run-smoke.sh` was run, and the unified JSON report is attached or summarized.
- [ ] New or changed quality rule includes a synthetic good/bad eval or a clear reason why no eval changed.
- [ ] No private lecture notes, APKG source decks, recovered exam text, screenshots, Drive exports, local paths, or run outputs are included.

## Human Verification (required)

What you personally verified (not just CI), and how:

- Verified scenarios:
- Edge cases checked:
- What you did **not** verify:

## Compatibility / Migration

- Backward compatible? (`Yes/No`)
- Config/env changes? (`Yes/No`)
- Migration needed? (`Yes/No`)
- If yes, exact upgrade steps:

## Failure Recovery (if this breaks)

- How to disable/revert this change quickly:
- Files/config to restore:
- Known bad symptoms reviewers should watch for:

## Risks and Mitigations

List only real risks for this PR. Add/remove entries as needed. If none, write `None`.

- Risk:
  - Mitigation:
