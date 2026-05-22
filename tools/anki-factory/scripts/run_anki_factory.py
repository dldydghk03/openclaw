#!/usr/bin/env python3
"""Public-safe one-command Anki Factory preview runner.

The runner prepares source intake, deck planning, deterministic quality checks,
and a human review pack. It intentionally stops before APKG export/import.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[3]
ANKI_FACTORY_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_DIR = Path(__file__).resolve().parent


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def fs_path(path: str | Path) -> Path:
    expanded = Path(path).expanduser()
    return expanded if expanded.is_absolute() else REPO_ROOT / expanded


def repo_path(path: str | Path) -> str:
    expanded = fs_path(path)
    try:
        return str(expanded.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(expanded)


def run_json(label: str, cmd: list[str]) -> dict[str, Any]:
    result = subprocess.run(cmd, cwd=REPO_ROOT, text=True, capture_output=True)
    if result.returncode != 0:
        if result.stdout:
            print(result.stdout, file=sys.stderr)
        if result.stderr:
            print(result.stderr, file=sys.stderr)
        raise SystemExit(f"{label} failed with exit code {result.returncode}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{label} did not emit JSON") from exc
    if not isinstance(payload, dict):
        raise SystemExit(f"{label} did not emit a JSON object")
    return payload


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def append_many(cmd: list[str], flag: str, values: list[str]) -> None:
    for value in values:
        cmd.extend([flag, value])


def source_intake(args: argparse.Namespace, out_dir: Path) -> dict[str, Any]:
    if args.source_bundle:
        return {"ok": True, "source_bundle": repo_path(args.source_bundle), "missing_inputs": []}
    cmd = [
        sys.executable,
        str(SCRIPT_DIR / "source_intake.py"),
        "--run-id",
        args.run_id,
        "--mode",
        args.mode,
        "--course",
        args.course,
        "--lecture-title",
        args.lecture_title,
        "--professor",
        args.professor,
        "--out-dir",
        str(out_dir),
    ]
    append_many(cmd, "--lecture", args.lecture)
    append_many(cmd, "--previous-anki", args.previous_anki)
    append_many(cmd, "--jokbo", args.jokbo)
    append_many(cmd, "--current-year-jokbo", args.current_year_jokbo)
    append_many(cmd, "--tcheck", args.tcheck)
    append_many(cmd, "--reference-profile", args.reference_profile)
    return run_json("source intake", cmd)


def build_plan(source_bundle: str, out_dir: Path, args: argparse.Namespace) -> dict[str, Any]:
    cmd = [
        sys.executable,
        str(SCRIPT_DIR / "build_deck_plan.py"),
        "--source-bundle",
        source_bundle,
        "--out",
        str(out_dir / "deck-plan.preview.md"),
        "--coverage-out",
        str(out_dir / "coverage.plan.json"),
    ]
    if args.density:
        cmd.extend(["--density", args.density])
    if args.max_cards is not None:
        cmd.extend(["--max-cards", str(args.max_cards)])
    return run_json("deck plan", cmd)


def quality_gate(cards: str, out_dir: Path) -> dict[str, Any]:
    cmd = [
        sys.executable,
        str(SCRIPT_DIR / "quality_gate.py"),
        "--cards",
        cards,
        "--contract",
        str(ANKI_FACTORY_ROOT / "standardized-anki-contract.json"),
    ]
    report = run_json("quality gate", cmd)
    write_json(out_dir / "quality-report.json", report)
    return report


def human_review(cards: str, out_dir: Path) -> dict[str, Any]:
    return run_json(
        "human review pack",
        [
            sys.executable,
            str(SCRIPT_DIR / "human_review_pack.py"),
            "--cards",
            cards,
            "--quality-report",
            str(out_dir / "quality-report.json"),
            "--out-dir",
            str(out_dir / "human-review-pack"),
        ],
    )


def write_run_report(out_dir: Path, manifest: dict[str, Any]) -> None:
    lines = [
        "# Anki Factory Run Report",
        "",
        f"- Run ID: `{manifest['run_id']}`",
        f"- Status: `{manifest['status']}`",
        f"- Source bundle: `{manifest.get('source_bundle')}`",
        f"- Deck plan: `{manifest.get('deck_plan')}`",
        f"- Cards: `{manifest.get('card_candidates') or '-'}`",
        f"- Quality ok: `{manifest.get('quality_gate_ok')}`",
        f"- Human review pack: `{manifest.get('human_review_pack') or '-'}`",
    ]
    out_dir.joinpath("factory-run-report.md").write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run public-safe Anki Factory preview pipeline")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--mode", choices=["exam_production", "lecture_only_preview", "reference_profile_only"], default="lecture_only_preview")
    parser.add_argument("--course", default="")
    parser.add_argument("--lecture-title", default="")
    parser.add_argument("--professor", default="")
    parser.add_argument("--lecture", action="append", default=[])
    parser.add_argument("--previous-anki", action="append", default=[])
    parser.add_argument("--jokbo", action="append", default=[])
    parser.add_argument("--current-year-jokbo", action="append", default=[])
    parser.add_argument("--tcheck", action="append", default=[])
    parser.add_argument("--reference-profile", action="append", default=[])
    parser.add_argument("--source-bundle", default="")
    parser.add_argument("--cards", default="")
    parser.add_argument("--out-dir", default="")
    parser.add_argument("--density", choices=["minimal", "balanced", "exam_dense"], default="")
    parser.add_argument("--max-cards", type=int)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    out_dir = fs_path(args.out_dir) if args.out_dir else ANKI_FACTORY_ROOT / "runs" / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    source_result = source_intake(args, out_dir)
    source_bundle = args.source_bundle or source_result["source_bundle"]
    plan_result = build_plan(source_bundle, out_dir, args)

    quality_report: dict[str, Any] | None = None
    review_result: dict[str, Any] | None = None
    if args.cards:
        quality_report = quality_gate(args.cards, out_dir)
        review_result = human_review(args.cards, out_dir)

    status = "preview_ready" if quality_report and quality_report.get("ok") else "needs_card_candidates"
    if quality_report and (quality_report.get("errors") or quality_report.get("warnings")):
        status = "needs_rewrite"
    manifest = {
        "ok": status in {"preview_ready", "needs_card_candidates"},
        "run_id": args.run_id,
        "status": status,
        "created_at": now_iso(),
        "source_bundle": source_bundle,
        "deck_plan": plan_result["deck_plan"],
        "coverage": plan_result["coverage"],
        "card_candidates": args.cards or None,
        "quality_gate_ok": bool(quality_report and quality_report.get("ok")),
        "human_review_pack": (review_result or {}).get("files", {}).get("pack") if review_result else None,
        "external_write_allowed": False,
        "next_required_step": "draft card-candidates.preview.json" if not args.cards else "human review then approval gate",
    }
    write_json(out_dir / "factory-run-manifest.json", manifest)
    write_run_report(out_dir, manifest)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
