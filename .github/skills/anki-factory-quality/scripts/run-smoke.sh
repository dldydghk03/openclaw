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
python3 tools/anki-factory/scripts/validate_public_fixtures.py
