#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export PYTHONDONTWRITEBYTECODE=1

python3 - <<'PY'
import py_compile
import tempfile
from pathlib import Path

out_dir = Path(tempfile.mkdtemp(prefix="anki-factory-pycompile-"))
for script in sorted(Path("tools/anki-factory/scripts").glob("*.py")):
    py_compile.compile(str(script), cfile=str(out_dir / f"{script.name}.pyc"), doraise=True)
PY

fixture_report="$(mktemp)"
integration_report="$(mktemp)"
agent_eval_report="$(mktemp)"
runtime_report="$(mktemp)"
runtime_dir="$(mktemp -d /tmp/anki-factory-runtime-smoke.XXXXXX)"
python3 tools/anki-factory/scripts/validate_public_fixtures.py >"$fixture_report"
python3 tools/anki-factory/scripts/validate_copilot_integration.py >"$integration_report"
python3 tools/anki-factory/scripts/run_agent_evals.py >"$agent_eval_report"
python3 tools/anki-factory/scripts/run_anki_factory.py \
  --run-id public-runtime-smoke \
  --mode lecture_only_preview \
  --course "신장학" \
  --lecture-title "합성 전해질 예시" \
  --professor "예시" \
  --lecture tools/anki-factory/fixtures/good/lecture.synthetic.md \
  --cards tools/anki-factory/fixtures/good/card-candidates.preview.json \
  --out-dir "$runtime_dir" >"$runtime_report"
python3 - "$fixture_report" "$integration_report" "$agent_eval_report" "$runtime_report" <<'PY'
import json
import sys
from pathlib import Path

fixture_report = json.loads(Path(sys.argv[1]).read_text())
integration_report = json.loads(Path(sys.argv[2]).read_text())
agent_eval_report = json.loads(Path(sys.argv[3]).read_text())
runtime_report = json.loads(Path(sys.argv[4]).read_text())
print(
    json.dumps(
        {
            "ok": bool(
                fixture_report.get("ok")
                and integration_report.get("ok")
                and agent_eval_report.get("ok")
                and runtime_report.get("ok")
            ),
            "fixture_gate": fixture_report,
            "copilot_integration_gate": integration_report,
            "agent_eval_gate": agent_eval_report,
            "runtime_smoke": runtime_report,
        },
        ensure_ascii=False,
        indent=2,
    )
)
PY
