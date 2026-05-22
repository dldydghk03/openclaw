#!/usr/bin/env python3
"""Create a human review pack from public-safe card candidates."""

from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[3]


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


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def visible_excerpt(card: dict[str, Any], limit: int = 220) -> str:
    fields = card.get("fields", {})
    if not isinstance(fields, dict):
        return ""
    text = " / ".join(str(value) for value in fields.values())
    return text[:limit].replace("\n", " ")


def candidate_findings(card: dict[str, Any], report: dict[str, Any]) -> tuple[list[str], bool]:
    candidate_id = card.get("candidate_id")
    findings: list[str] = []
    has_error = False
    for bucket in ("errors", "warnings"):
        for item in report.get(bucket, []) if isinstance(report.get(bucket), list) else []:
            if item.get("candidate_id") in {candidate_id, None}:
                findings.append(str(item.get("code")))
                has_error = has_error or bucket == "errors"
    if card.get("manual_review_required"):
        findings.append("manual_review_required")
    return sorted(set(findings)), has_error


def build_queue(cards: list[dict[str, Any]], report: dict[str, Any]) -> list[dict[str, Any]]:
    queue = []
    for card in cards:
        findings, has_error = candidate_findings(card, report)
        if findings or card.get("note_type_key") == "standard_new_jokbo":
            queue.append(
                {
                    "candidate_id": card.get("candidate_id"),
                    "note_type_key": card.get("note_type_key"),
                    "deck_path": card.get("deck_path", ""),
                    "priority": "P1" if has_error else "P2" if findings else "P3",
                    "findings": findings,
                    "review_focus": [
                        "AI 티가 나는 말투가 있는지 확인",
                        "노베이스 학습자가 이해 가능한지 확인",
                        "표준화 note type과 visible field가 유지되는지 확인",
                    ],
                    "visible_excerpt": visible_excerpt(card),
                }
            )
    return queue


def write_markdown(path: Path, *, cards: list[dict[str, Any]], queue: list[dict[str, Any]], report: dict[str, Any]) -> None:
    lines = [
        "# Human Review Pack",
        "",
        f"- Generated: `{now_iso()}`",
        f"- Candidate count: `{len(cards)}`",
        f"- Quality ok: `{report.get('ok')}`",
        f"- Errors: `{len(report.get('errors', []))}`",
        f"- Warnings: `{len(report.get('warnings', []))}`",
        "",
        "## Review Queue",
    ]
    if not queue:
        lines.append("- No required human review items from deterministic gates.")
    for item in queue:
        lines.extend(
            [
                f"- `{item['candidate_id']}` `{item['note_type_key']}` `{item['priority']}`",
                f"  - Focus: {', '.join(item['review_focus'])}",
                f"  - Findings: {', '.join(item['findings']) if item['findings'] else '-'}",
                f"  - Excerpt: {item['visible_excerpt']}",
            ]
        )
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def write_csv(path: Path, queue: list[dict[str, Any]]) -> None:
    fieldnames = ["candidate_id", "note_type_key", "deck_path", "priority", "findings", "visible_excerpt"]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for item in queue:
            writer.writerow({key: ";".join(item[key]) if key == "findings" else item.get(key, "") for key in fieldnames})


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build Anki Factory human review pack")
    parser.add_argument("--cards", required=True)
    parser.add_argument("--quality-report", required=True)
    parser.add_argument("--out-dir", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    cards = read_json(fs_path(args.cards))
    report = read_json(fs_path(args.quality_report))
    if not isinstance(cards, list):
        raise SystemExit("--cards must be a JSON array")
    out_dir = fs_path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    queue = build_queue(cards, report if isinstance(report, dict) else {})
    (out_dir / "human-review-queue.json").write_text(json.dumps(queue, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_markdown(out_dir / "human-review-pack.md", cards=cards, queue=queue, report=report)
    write_csv(out_dir / "human-review-sheet.csv", queue)
    feedback_lines = [
        json.dumps({"candidate_id": item["candidate_id"], "decision": "approve|rewrite|reject", "comment": ""}, ensure_ascii=False)
        for item in queue
    ]
    (out_dir / "card-feedback.template.jsonl").write_text("\n".join(feedback_lines) + ("\n" if feedback_lines else ""), encoding="utf-8")
    index = {
        "ok": True,
        "generated_at": now_iso(),
        "queue_count": len(queue),
        "files": {
            "pack": repo_path(out_dir / "human-review-pack.md"),
            "queue": repo_path(out_dir / "human-review-queue.json"),
            "sheet": repo_path(out_dir / "human-review-sheet.csv"),
            "feedback_template": repo_path(out_dir / "card-feedback.template.jsonl"),
        },
    }
    (out_dir / "human-review-index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(index, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
