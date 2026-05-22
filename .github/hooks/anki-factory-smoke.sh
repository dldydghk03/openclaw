#!/usr/bin/env bash
set -euo pipefail

cd "${GITHUB_WORKSPACE:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

changed_files="$(
  {
    git diff --name-only HEAD -- \
      tools/anki-factory \
      docs/anki-factory \
      .github/copilot-instructions.md \
      .github/instructions/anki-factory.instructions.md \
      .github/agents/anki-factory-maintainer.agent.md \
      .github/ISSUE_TEMPLATE/anki_factory_improvement.yml \
      .github/ISSUE_TEMPLATE/deck_quality_regression.yml \
      .github/ISSUE_TEMPLATE/workflow_gate_change.yml \
      .github/labeler.yml \
      .github/pull_request_template.md \
      .github/skills/anki-factory-quality \
      .github/hooks/anki-factory-quality.json \
      .github/hooks/anki-factory-smoke.sh \
      .github/workflows/anki-factory-ci.yml
    git ls-files --others --exclude-standard -- \
      tools/anki-factory \
      docs/anki-factory \
      .github/copilot-instructions.md \
      .github/instructions/anki-factory.instructions.md \
      .github/agents/anki-factory-maintainer.agent.md \
      .github/ISSUE_TEMPLATE/anki_factory_improvement.yml \
      .github/ISSUE_TEMPLATE/deck_quality_regression.yml \
      .github/ISSUE_TEMPLATE/workflow_gate_change.yml \
      .github/labeler.yml \
      .github/pull_request_template.md \
      .github/skills/anki-factory-quality \
      .github/hooks/anki-factory-quality.json \
      .github/hooks/anki-factory-smoke.sh \
      .github/workflows/anki-factory-ci.yml
  } | sort -u
)"

if [ -z "$changed_files" ]; then
  printf '{}\n'
  exit 0
fi

log_file="$(mktemp)"
if .github/skills/anki-factory-quality/scripts/run-smoke.sh >"$log_file" 2>&1; then
  printf '{}\n'
  exit 0
fi

python3 - "$log_file" <<'PY'
import json
import pathlib
import sys

log_path = pathlib.Path(sys.argv[1])
log = log_path.read_text(errors="replace")[-4000:]
print(
    json.dumps(
        {
            "decision": "block",
            "reason": "Anki Factory public smoke failed. Fix the gate or fixtures before finishing.\n\n" + log,
        }
    )
)
PY
