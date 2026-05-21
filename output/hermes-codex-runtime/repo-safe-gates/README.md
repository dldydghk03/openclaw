# Repo-Safe Hermes/OpenClaw Gates

This directory contains public-safe templates for local Hermes/OpenClaw operations.
They intentionally contain no personal vault paths, account IDs, calendar names, or
ledger data.

## Contract

Any workflow that writes outside a temporary preview must follow:

1. preview
2. explicit approval
3. apply
4. read-back in the same job
5. repair-needed status if read-back is incomplete

## Scope

- Apple Calendar create/update/delete
- finance ledger append/reconcile apply
- OpenClaw cleanup, file move, file delete, and migration apply
- bridge, prompt, playbook, approval-gate, and cron workflow changes

## Non-Negotiable Rules

- A date-anchored schedule must not apply unless `anchor_required=true` and
  `anchor_verified=true` are both present.
- Timetable imports must not dedupe by `date + title` alone. Adjacent same-title
  periods are merged into one continuous block; non-adjacent same-title periods
  remain separate events.
- Finance apply is append-only and requires `preview_file`, `approval_id`,
  duplicate checks, and post-append read-back.
- Cleanup cannot delete, move, or rewrite state until a stable
  `keep/promote/archive/delete` manifest exists.
- Hermes shadow promotion writes only to `00-Core` or `30-Playbooks`, and only
  after at least 7 calendar days of evidence unless the operator gives an
  explicit manual override.

## How To Use

1. Fill one of the `*.template.json` files.
2. Validate it against `external-write-gate.schema.json`.
3. Apply only if `apply_allowed=true` and `apply_blockers=[]`.
4. Read the target system back in the same job and persist the result.

These templates are intended for Codex/GitHub review as workflow changes.
