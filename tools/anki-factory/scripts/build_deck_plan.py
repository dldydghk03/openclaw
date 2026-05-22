#!/usr/bin/env python3
"""Build a deck-plan.preview.md from a public-safe source bundle."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[3]
ANKI_FACTORY_ROOT = Path(__file__).resolve().parents[1]


DENSITY_BUDGETS = {
    "minimal": {"max_cards": 35, "basic": "10-14", "cloze": "6-9", "jokbo": "0-4"},
    "balanced": {"max_cards": 45, "basic": "14-18", "cloze": "8-12", "jokbo": "5-9"},
    "exam_dense": {"max_cards": 55, "basic": "18-22", "cloze": "10-14", "jokbo": "8-12"},
}


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


def read_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise SystemExit(f"Expected JSON object: {path}")
    return payload


def role_available(bundle: dict[str, Any], role: str) -> bool:
    block = bundle.get(role)
    return isinstance(block, dict) and bool(block.get("available"))


def role_count(bundle: dict[str, Any], role: str) -> int:
    block = bundle.get(role)
    files = block.get("files", []) if isinstance(block, dict) else []
    return len(files) if isinstance(files, list) else 0


def coverage_mode(bundle: dict[str, Any]) -> str:
    if not role_available(bundle, "lecture") and bundle.get("mode") != "reference_profile_only":
        return "blocked_missing_lecture"
    if role_available(bundle, "previous_anki") and (role_available(bundle, "jokbo") or role_available(bundle, "current_year_jokbo")):
        return "jokbo_guided_exam_preview"
    if role_available(bundle, "lecture"):
        return "lecture_only_preview"
    return "reference_profile_only"


def density_for(bundle: dict[str, Any], requested: str | None) -> str:
    if requested:
        return requested
    if bundle.get("mode") == "exam_production":
        return "exam_dense"
    return "balanced"


def build_plan(bundle: dict[str, Any], *, density: str | None, max_cards: int | None) -> tuple[str, dict[str, Any]]:
    selected_density = density_for(bundle, density)
    budget = dict(DENSITY_BUDGETS.get(selected_density, DENSITY_BUDGETS["balanced"]))
    if max_cards is not None:
        budget["max_cards"] = max_cards
    mode = coverage_mode(bundle)
    missing = bundle.get("missing_inputs") if isinstance(bundle.get("missing_inputs"), list) else []
    include_jokbo = role_available(bundle, "previous_anki") or role_available(bundle, "jokbo") or role_available(bundle, "current_year_jokbo")

    coverage = {
        "run_id": bundle.get("bundle_id", "anki-factory-run"),
        "checked_at": now_iso(),
        "coverage_mode": mode,
        "density": selected_density,
        "budget": budget,
        "include_jokbo_subdeck": include_jokbo,
        "missing_inputs": missing,
        "role_counts": {role: role_count(bundle, role) for role in ["lecture", "previous_anki", "jokbo", "current_year_jokbo", "tcheck"]},
    }

    lines = [
        "# Deck Plan Preview",
        "",
        f"- Bundle: `{bundle.get('bundle_id')}`",
        f"- Mode: `{bundle.get('mode')}`",
        f"- Coverage mode: `{mode}`",
        f"- Density: `{selected_density}`",
        f"- Max cards: `{budget['max_cards']}`",
        "",
        "## Source Status",
    ]
    for role in ["lecture", "previous_anki", "jokbo", "current_year_jokbo", "tcheck", "jokbo_style_references"]:
        lines.append(f"- `{role}`: available={role_available(bundle, role)} files={role_count(bundle, role)}")
    lines.extend(
        [
            "",
            "## Subdeck Plan",
            "- `01. JBL 개념 흐름`: no-base explanations and card titles that say what the learner is doing.",
            "- `02. 비교표 Cloze`: tables only when comparison improves recall; targeted cloze only.",
            "- `03. 족보 원문형`: actual recovered-question cards only; omit if no approved recovered source exists.",
            "- `04. 강조점·티첵후보`: class emphasis candidates only; keep as preview if t-check is missing.",
            "",
            "## Quality Rules",
            "- Use only standardized note types from `standardized-anki-contract.json`.",
            "- Do not put metadata in visible card fields.",
            "- Use conversational tutor-style Korean, not stiff report phrasing.",
            "- Require quality gate and human review pack before APKG export.",
        ]
    )
    if missing:
        lines.extend(["", "## Missing Inputs", *[f"- {item}" for item in missing]])
    return "\n".join(lines).rstrip() + "\n", coverage


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build Anki Factory deck plan preview")
    parser.add_argument("--source-bundle", required=True)
    parser.add_argument("--out", default="")
    parser.add_argument("--coverage-out", default="")
    parser.add_argument("--density", choices=sorted(DENSITY_BUDGETS), default="")
    parser.add_argument("--max-cards", type=int)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source_bundle = fs_path(args.source_bundle)
    bundle = read_json(source_bundle)
    plan_text, coverage = build_plan(bundle, density=args.density or None, max_cards=args.max_cards)
    out_path = fs_path(args.out) if args.out else source_bundle.parent / "deck-plan.preview.md"
    coverage_path = fs_path(args.coverage_out) if args.coverage_out else source_bundle.parent / "coverage.plan.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(plan_text, encoding="utf-8")
    coverage_path.write_text(json.dumps(coverage, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "deck_plan": repo_path(out_path), "coverage": repo_path(coverage_path)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
