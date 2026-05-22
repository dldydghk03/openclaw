#!/usr/bin/env python3
"""Run deterministic public-safe evals for Anki Factory agent changes."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True

SCRIPT_DIR = Path(__file__).resolve().parent
ANKI_FACTORY_ROOT = SCRIPT_DIR.parent
REPO_ROOT = ANKI_FACTORY_ROOT.parent.parent
EVAL_ROOT = ANKI_FACTORY_ROOT / "evals"
MANIFEST_PATH = EVAL_ROOT / "manifest.json"
CONTRACT_PATH = ANKI_FACTORY_ROOT / "standardized-anki-contract.json"

sys.path.insert(0, str(SCRIPT_DIR))

import validate_copilot_integration as copilot_integration  # noqa: E402
from quality_gate import load_contract, validate_cards  # noqa: E402


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def code_set(items: list[dict[str, Any]]) -> set[str]:
    return {str(item.get("code")) for item in items}


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def case_result(case: dict[str, Any], passed: bool, observed: dict[str, Any], failures: list[str]) -> dict[str, Any]:
    return {
        "id": case.get("id"),
        "kind": case.get("kind"),
        "passed": passed,
        "failures": failures,
        "observed": observed,
    }


def eval_card_quality_case(case: dict[str, Any], contract: dict[str, Any]) -> dict[str, Any]:
    fixture_path = EVAL_ROOT / str(case["fixture"])
    report = validate_cards(fixture_path, contract)
    errors = code_set(report["errors"])
    warnings = code_set(report["warnings"])
    failures: list[str] = []

    expected_ok = bool(case.get("expect_ok"))
    if bool(report["ok"]) != expected_ok:
        failures.append(f"expected ok={expected_ok}, got ok={report['ok']}")

    for code in case.get("required_error_codes", []):
        if code not in errors:
            failures.append(f"missing required error code: {code}")
    for code in case.get("required_warning_codes", []):
        if code not in warnings:
            failures.append(f"missing required warning code: {code}")
    if case.get("expect_no_warnings") and warnings:
        failures.append(f"expected no warnings, got {sorted(warnings)}")

    observed = {
        "ok": report["ok"],
        "errors": sorted(errors),
        "warnings": sorted(warnings),
        "candidate_count": report["metrics"]["candidate_count"],
    }
    return case_result({**case, "kind": "card_quality"}, not failures, observed, failures)


def copy_file(src_root: Path, dst_root: Path, relative_path: str) -> None:
    src = src_root / relative_path
    dst = dst_root / relative_path
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def make_temp_repo() -> Path:
    temp_root = Path(tempfile.mkdtemp(prefix="anki-factory-agent-eval-"))
    copy_paths = set(copilot_integration.REQUIRED_FILES)
    copy_paths.update(copilot_integration.PRIVATE_BOUNDARY_PATHS)
    copy_paths.update(
        {
            ".github/hooks/anki-factory-smoke.sh",
            ".github/workflows/anki-factory-ci.yml",
            ".github/skills/anki-factory-quality/scripts/run-smoke.sh",
            "tools/anki-factory/scripts/validate_copilot_integration.py",
        }
    )
    for relative_path in sorted(copy_paths):
        copy_file(REPO_ROOT, temp_root, relative_path)
    return temp_root


def apply_mutation(temp_root: Path, mutation: dict[str, Any]) -> None:
    target = temp_root / str(mutation["path"])
    text = target.read_text(encoding="utf-8")
    op = mutation.get("op")
    if op == "replace":
        old = str(mutation["old"])
        new = str(mutation["new"])
        if old not in text:
            raise AssertionError(f"mutation target text not found in {mutation['path']}: {old!r}")
        target.write_text(text.replace(old, new, 1), encoding="utf-8")
        return
    if op == "append":
        append_text = str(mutation.get("text", ""))
        if "text_parts" in mutation:
            append_text = "".join(str(part) for part in mutation["text_parts"])
        target.write_text(text + append_text, encoding="utf-8")
        return
    raise AssertionError(f"unknown mutation op: {op}")


def run_integration_validator(temp_root: Path) -> tuple[bool, str]:
    command = [
        sys.executable,
        str(SCRIPT_DIR / "validate_copilot_integration.py"),
        "--repo-root",
        str(temp_root),
    ]
    proc = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    return proc.returncode == 0, (proc.stdout + proc.stderr)


def eval_copilot_integration_case(case: dict[str, Any]) -> dict[str, Any]:
    temp_root = make_temp_repo()
    failures: list[str] = []
    try:
        for mutation in case.get("mutations", []):
            apply_mutation(temp_root, mutation)
        ok, output = run_integration_validator(temp_root)
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)

    expected_ok = bool(case.get("expect_ok"))
    if ok != expected_ok:
        failures.append(f"expected ok={expected_ok}, got ok={ok}")

    for fragment in case.get("required_message_fragments", []):
        if fragment not in output:
            failures.append(f"missing required message fragment: {fragment}")

    observed = {
        "ok": ok,
        "output_excerpt": output[-1200:],
    }
    return case_result({**case, "kind": "copilot_integration"}, not failures, observed, failures)


def main() -> int:
    manifest = read_json(MANIFEST_PATH)
    contract = load_contract(CONTRACT_PATH)
    results: list[dict[str, Any]] = []

    for case in manifest.get("card_quality_cases", []):
        results.append(eval_card_quality_case(case, contract))
    for case in manifest.get("copilot_integration_cases", []):
        results.append(eval_copilot_integration_case(case))

    failed = [result for result in results if not result["passed"]]
    report = {
        "ok": not failed,
        "checked_at": now_iso(),
        "manifest_version": manifest.get("version"),
        "case_count": len(results),
        "failed_count": len(failed),
        "cases": results,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
