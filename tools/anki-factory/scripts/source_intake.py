#!/usr/bin/env python3
"""Create a public-safe Anki Factory source bundle.

This script records explicit source paths only. It does not crawl a user's
Drive, Vault, downloads, or generated run folders, which keeps the public CI
path safe for Copilot and GitHub review.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[3]
ANKI_FACTORY_ROOT = Path(__file__).resolve().parents[1]


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


def kind_for(path: str | Path) -> str:
    suffix = Path(path).suffix.lower()
    if suffix == ".apkg":
        return "apkg"
    if suffix in {".png", ".jpg", ".jpeg", ".webp"}:
        return "image"
    if suffix in {".pdf", ".pptx", ".docx", ".xlsx", ".md", ".txt"}:
        return suffix[1:]
    return "unknown"


def sha256_if_small(path: Path, max_bytes: int = 10 * 1024 * 1024) -> str | None:
    if not path.exists() or not path.is_file() or path.stat().st_size > max_bytes:
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_file(path: str, note: str | None = None) -> dict[str, Any]:
    resolved = fs_path(path)
    item: dict[str, Any] = {
        "path": repo_path(path),
        "kind": kind_for(path),
        "hydrated": resolved.suffix.lower() in {".md", ".txt"},
    }
    digest = sha256_if_small(resolved)
    if digest:
        item["sha256"] = digest
    if note:
        item["source_note"] = note
    return item


def source_group(paths: list[str], *, required: bool, note: str | None = None) -> dict[str, Any]:
    return {
        "required": required,
        "available": bool(paths),
        "files": [source_file(path, note) for path in paths],
    }


def missing_inputs(args: argparse.Namespace) -> list[str]:
    missing: list[str] = []
    if args.mode != "reference_profile_only" and not args.lecture:
        missing.append("lecture")
    if args.mode == "exam_production" and not (args.previous_anki or args.jokbo or args.current_year_jokbo):
        missing.append("approved recovered-question source")
    if not args.tcheck:
        missing.append("tcheck")
    return missing


def build_bundle(args: argparse.Namespace) -> dict[str, Any]:
    source_priority = [
        "previous_anki_apkg",
        "current_year_jokbo",
        "jokbo",
        "lecture",
        "tcheck",
        "local_reference",
    ]
    return {
        "bundle_id": args.bundle_id or f"{args.run_id}-source-bundle",
        "mode": args.mode,
        "created_at": now_iso(),
        "course": args.course,
        "lecture_title": args.lecture_title,
        "professor": args.professor,
        "lecture": source_group(args.lecture, required=args.mode != "reference_profile_only"),
        "previous_anki": source_group(args.previous_anki, required=False, note="matching previous-Anki APKG when available"),
        "jokbo": source_group(args.jokbo, required=args.mode == "exam_production"),
        "current_year_jokbo": source_group(args.current_year_jokbo, required=args.mode == "exam_production"),
        "jokbo_style_references": source_group(args.reference_profile, required=False),
        "tcheck": source_group(args.tcheck, required=False),
        "jokbo_source_policy": {
            "previous_anki_required": args.mode == "exam_production",
            "current_year_required_for_exam_production": args.mode == "exam_production",
            "style_reference_authors": ["이원재", "한상준"],
            "explanation_policy": "style references guide explanation structure, not problem content copying",
        },
        "problem_classification_policy": {
            "assignment_source": "matching previous-Anki first, then approved current-year jokbo",
            "lecture_support_source": "current lecture source only",
            "not_found_visible_caveat": "현재 강의록 내용으로 풀기는 어렵습니다.",
            "partial_visible_caveat": "현재 강의록 내용만으로는 일부 세부 보기 판단이 어렵습니다.",
            "current_run_result": "classification_required_before_jokbo_cards",
        },
        "reference_apkg_profiles": args.reference_profile,
        "source_priority": source_priority,
        "missing_inputs": missing_inputs(args),
        "notes": "Public-safe source bundle. Real private files stay local and are not committed.",
    }


def write_report(path: Path, bundle: dict[str, Any]) -> None:
    lines = [
        "# Source Intake Report",
        "",
        f"- Bundle: `{bundle['bundle_id']}`",
        f"- Mode: `{bundle['mode']}`",
        f"- Course: {bundle.get('course') or '-'}",
        f"- Lecture: {bundle.get('lecture_title') or '-'}",
        f"- Professor: {bundle.get('professor') or '-'}",
        "",
        "## Availability",
    ]
    for role in ["lecture", "previous_anki", "jokbo", "current_year_jokbo", "tcheck", "jokbo_style_references"]:
        group = bundle.get(role, {})
        lines.append(f"- `{role}`: available={group.get('available')} files={len(group.get('files', []))}")
    if bundle.get("missing_inputs"):
        lines.extend(["", "## Missing Inputs", *[f"- {item}" for item in bundle["missing_inputs"]]])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create an Anki Factory source-bundle.json")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--bundle-id")
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
    parser.add_argument("--out-dir", default="")
    parser.add_argument("--out", default="")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    out_dir = fs_path(args.out_dir) if args.out_dir else ANKI_FACTORY_ROOT / "runs" / args.run_id
    out_path = fs_path(args.out) if args.out else out_dir / "source-bundle.json"
    bundle = build_bundle(args)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(bundle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_report(out_path.parent / "source-intake-report.md", bundle)
    print(json.dumps({"ok": True, "source_bundle": repo_path(out_path), "missing_inputs": bundle["missing_inputs"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
