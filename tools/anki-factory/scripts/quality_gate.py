#!/usr/bin/env python3
"""Quality and format gate for Anki Factory candidate cards and APKGs."""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from apkg_profiler import AI_SMELL_PATTERNS, extract_apkg_data, load_contract, match_contract_key, norm_name, strip_markup


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def error(code: str, message: str, **extra: Any) -> dict[str, Any]:
    item = {"code": code, "message": message}
    item.update(extra)
    return item


def warning(code: str, message: str, **extra: Any) -> dict[str, Any]:
    item = {"code": code, "message": message}
    item.update(extra)
    return item


def note_type_specs(contract: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return contract.get("canonical_note_types", {})


def validate_field_shape(
    note_type_key: str,
    fields: dict[str, str],
    contract: dict[str, Any],
    candidate_id: str | None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    errors: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    specs = note_type_specs(contract)
    spec = specs.get(note_type_key)
    if not spec:
        errors.append(error("unknown_note_type_key", f"Unknown note_type_key: {note_type_key}", candidate_id=candidate_id))
        return errors, warnings

    expected_fields = spec.get("fields", [])
    actual_fields = list(fields.keys())
    if actual_fields != expected_fields:
        errors.append(
            error(
                "field_order_or_name_drift",
                f"{note_type_key} fields must be exactly {expected_fields}, got {actual_fields}",
                candidate_id=candidate_id,
                note_type=note_type_key,
            )
        )

    for required in spec.get("required_fields_nonempty", []):
        if not strip_markup(fields.get(required, "")):
            errors.append(
                error(
                    "required_field_empty",
                    f"{note_type_key}.{required} must not be empty",
                    candidate_id=candidate_id,
                    note_type=note_type_key,
                )
            )

    if spec.get("type") == "cloze":
        text = fields.get("Text", "")
        pattern = spec.get("field_specific_rules", {}).get("Text", {}).get("must_match_regex")
        if pattern and not re.search(pattern, text):
            errors.append(
                error(
                    "missing_cloze_deletion",
                    "standard_cloze Text must contain {{cN::...}}",
                    candidate_id=candidate_id,
                    note_type=note_type_key,
                )
            )

    return errors, warnings


def scan_ai_smell(text: str, candidate_id: str | None = None) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    plain = strip_markup(text)
    for label, pattern in AI_SMELL_PATTERNS:
        if pattern.search(plain):
            issues.append(
                warning(
                    "ai_smell_pattern",
                    f"Potential AI-smell pattern detected: {label}",
                    candidate_id=candidate_id,
                    pattern=label,
                )
            )
    if re.search(r"중요하(다|며|고)", plain) and not re.search(r"왜|이유|때문|므로|따라서|그래서", plain):
        issues.append(
            warning(
                "importance_without_why",
                "The card says something is important without explaining why.",
                candidate_id=candidate_id,
            )
        )
    return issues


def visible_text(card: dict[str, Any]) -> str:
    fields = card.get("fields", {})
    if not isinstance(fields, dict):
        return ""
    return " ".join(str(value) for value in fields.values())


def scan_image_caption_quality(text: str, candidate_id: str | None = None) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    for match in re.finditer(r"<img\b[^>]*>", text or "", flags=re.I):
        tail = (text or "")[match.end() : match.end() + 500]
        caption_match = re.search(r'<div style="font-size:0\.9em[^>]*>(.*?)</div>', tail, flags=re.I | re.S)
        if not caption_match:
            issues.append(warning("image_missing_caption", "Supplemental images should include a short explanatory caption.", candidate_id=candidate_id))
            continue
        caption = strip_markup(html.unescape(caption_match.group(1)))
        if not caption:
            issues.append(warning("image_empty_caption", "Image caption is empty.", candidate_id=candidate_id))
            continue
        if re.fullmatch(r"(그림|영상|이미지|예시|참고|표)(입니다)?\.?", caption):
            issues.append(warning("image_vague_caption", "Image caption is too vague; say what the image explains.", candidate_id=candidate_id))
        if not re.search(r"(설명하는 이미지입니다|보여주는 이미지입니다|정리한 이미지입니다|확인하는 이미지입니다)\.?$", caption):
            issues.append(warning("image_caption_not_explanatory", "Supplemental image captions should say what the image explains.", candidate_id=candidate_id))
    return issues


def scan_disallowed_humor(text: str, candidate_id: str | None = None) -> list[dict[str, Any]]:
    plain = strip_markup(text or "")
    if re.search(r"암기\s*훅|드립|농담|밈|ㅋㅋ|ㅎㅎ|개웃|웃긴|재밌는", plain, flags=re.I):
        return [
            error(
                "disallowed_humor_or_mnemonic_hook",
                "Do not add joke, meme, or forced-funny mnemonic hooks to generated cards.",
                candidate_id=candidate_id,
            )
        ]
    return []


def scan_metadata_leakage(text: str, candidate_id: str | None = None) -> list[dict[str, Any]]:
    plain = strip_markup(text or "")
    leaked = re.findall(
        r"\b(learning_intent|likely_confusion|exam_relevance|source_refs|candidate_id|problem_classification|lecture_support|source_assignment|visible_caveat_required|review_status)\b",
        plain,
    )
    if not leaked:
        return []
    return [
        error(
            "metadata_leaked_to_card_field",
            "Operational metadata must not appear in learner-visible card fields.",
            candidate_id=candidate_id,
            leaked=sorted(set(leaked)),
        )
    ]


def scan_table_quality(text: str, candidate_id: str | None = None) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    for match in re.finditer(r"<table\b([^>]*)>", text or "", flags=re.I):
        attrs = match.group(1) or ""
        table_html = (text or "")[match.start() : match.start() + 2000]
        checks = [
            ("table_missing_border", r'border=["\']1["\']', "Comparison tables should use border=\"1\"."),
            ("table_missing_cellpadding", r'cellpadding=["\']5["\']', "Comparison tables should use cellpadding=\"5\"."),
            ("table_missing_border_collapse", r"border-collapse\s*:\s*collapse", "Comparison tables should use border-collapse:collapse."),
            ("table_missing_full_width", r"width\s*:\s*100%", "Comparison tables should use width:100%."),
            ("table_missing_center_align", r"text-align\s*:\s*center", "Comparison tables should use text-align:center."),
        ]
        for code, pattern, message in checks:
            if not re.search(pattern, attrs, flags=re.I):
                issues.append(warning(code, message, candidate_id=candidate_id))
        if not re.search(r"background-color\s*:\s*#f2f2f2", table_html, flags=re.I):
            issues.append(
                warning(
                    "table_missing_gray_header",
                    "Comparison tables should visually separate the header row with background-color:#f2f2f2.",
                    candidate_id=candidate_id,
                )
            )
    return issues


def scan_basic_front_quality(card: dict[str, Any], candidate_id: str | None = None) -> list[dict[str, Any]]:
    if card.get("note_type_key") != "standard_basic":
        return []
    front = str(card.get("fields", {}).get("Front", ""))
    plain = strip_markup(front)
    if len(plain) > 70 and not re.search(r"<img\b", front, flags=re.I):
        return [
            warning(
                "basic_front_title_too_long",
                "standard_basic Front should be a compact title, not a full paragraph.",
                candidate_id=candidate_id,
                length=len(plain),
            )
        ]
    return []


def scan_stiff_plain_form(text: str, candidate_id: str | None = None) -> list[dict[str, Any]]:
    plain = strip_markup(text or "")
    stiff_endings = re.findall(r"(?:한다|된다|이다|있다|없다)\.", plain)
    if len(stiff_endings) >= 5 and not re.search(r"됩니다|입니다|보면|고르면|편합니다|아닙니다", plain):
        return [
            warning(
                "stiff_plain_form_repetition",
                "Learner-visible explanation may sound like stiff report prose; rewrite in a natural tutor tone.",
                candidate_id=candidate_id,
                count=len(stiff_endings),
            )
        ]
    return []


def validate_jokbo_problem_classification(card: dict[str, Any], candidate_id: str | None) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    errors: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    if card.get("note_type_key") != "standard_new_jokbo":
        return errors, warnings

    classification = card.get("problem_classification")
    if not isinstance(classification, dict):
        errors.append(
            error(
                "missing_problem_classification",
                "standard_new_jokbo cards must classify the problem against matching previous-Anki and current lecture sources.",
                candidate_id=candidate_id,
            )
        )
        return errors, warnings

    support = classification.get("lecture_support")
    if support not in {"direct", "partial", "not_found"}:
        errors.append(
            error(
                "invalid_lecture_support",
                "problem_classification.lecture_support must be direct, partial, or not_found.",
                candidate_id=candidate_id,
            )
        )
        return errors, warnings

    if not classification.get("lecture_evidence") and support != "not_found":
        errors.append(
            error(
                "missing_lecture_evidence",
                "lecture-supported jokbo problems must include current lecture evidence locators.",
                candidate_id=candidate_id,
            )
        )

    text = visible_text(card)
    if support == "not_found" and "현재 강의록 내용으로 풀기는 어렵습니다" not in text:
        errors.append(
            error(
                "missing_current_lecture_unsupported_caveat",
                "If the current lecture cannot support the problem, the visible explanation must say: 현재 강의록 내용으로 풀기는 어렵습니다.",
                candidate_id=candidate_id,
            )
        )
    if support == "partial" and classification.get("visible_caveat_required") and "현재 강의록 내용만으로는 일부 세부 보기 판단이 어렵습니다" not in text:
        errors.append(
            error(
                "missing_current_lecture_partial_caveat",
                "Partially supported problems requiring a caveat must visibly say: 현재 강의록 내용만으로는 일부 세부 보기 판단이 어렵습니다.",
                candidate_id=candidate_id,
            )
        )

    if support == "direct" and classification.get("missing_or_external_points"):
        warnings.append(
            warning(
                "direct_support_has_missing_points",
                "lecture_support is direct but missing_or_external_points is non-empty.",
                candidate_id=candidate_id,
            )
        )
    return errors, warnings


def validate_new_jokbo_format(card: dict[str, Any], candidate_id: str | None) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    errors: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    fields = card.get("fields", {})
    deck_path = str(card.get("deck_path", ""))
    is_new_jokbo = card.get("note_type_key") == "standard_new_jokbo"
    if deck_path.startswith("03. 족보") and not is_new_jokbo:
        errors.append(
            error(
                "jokbo_subdeck_non_exam_card",
                "The jokbo subdeck must contain only standard_new_jokbo recovered exam cards.",
                candidate_id=candidate_id,
            )
        )
    if deck_path.startswith("05. 형성평가") and not is_new_jokbo:
        errors.append(
            error(
                "formative_subdeck_non_exam_card",
                "The formative-assessment subdeck must contain only standard_new_jokbo source-question cards.",
                candidate_id=candidate_id,
            )
        )
    if not is_new_jokbo:
        return errors, warnings

    is_jokbo_deck = deck_path.startswith("03. 족보")
    is_formative_deck = deck_path.startswith("05. 형성평가")
    if not (is_jokbo_deck or is_formative_deck):
        errors.append(
            error(
                "new_jokbo_wrong_subdeck",
                "standard_new_jokbo cards must be routed to the jokbo or formative-assessment source-question subdeck.",
                candidate_id=candidate_id,
            )
        )

    problem_no = str(fields.get("문제번호", ""))
    expected_problem_no = r"\(\d{2}-신장학-형성평가-\d{1,3}\)" if is_formative_deck else r"\(\d{2}-신장학-\d{1,3}\)"
    if not re.fullmatch(expected_problem_no, problem_no):
        errors.append(
            error(
                "new_jokbo_problem_number_format",
                "문제번호 must use the exact format like (25-신장학-86) or (25-신장학-형성평가-46) for formative cards.",
                candidate_id=candidate_id,
                actual=problem_no,
            )
        )

    body = str(fields.get("본문", ""))
    first_line = re.split(r"<br\s*/?>|\n", body, maxsplit=1, flags=re.I)[0].strip()
    if not re.search(r"신장내과\s+.+교수님,\s*.+", first_line):
        errors.append(
            error(
                "new_jokbo_missing_course_professor_first_line",
                "본문 first line must look like '신장내과 예시 교수님, 합성 강의'.",
                candidate_id=candidate_id,
                actual=first_line,
            )
        )

    if "복원 보기 일부" in body or "기타" in body:
        errors.append(
            error(
                "new_jokbo_fabricated_or_placeholder_options",
                "Do not fabricate options or use placeholder options in actual exam cards. Use recovered options only, or mark 보기 복원 없음.",
                candidate_id=candidate_id,
            )
        )

    has_option = bool(re.search(r"①|②|③|④|⑤|ㄱ|ㄴ|ㄷ|ㄹ", body))
    if not has_option and "보기 복원 없음" not in body:
        errors.append(
            error(
                "new_jokbo_missing_options_or_restore_note",
                "본문 should include recovered options. If options are missing in the source, write 보기 복원 없음 instead of inventing options.",
                candidate_id=candidate_id,
            )
        )
    if has_option:
        explanation = str(fields.get("정답 및 해설", ""))
        explained_markers = set(re.findall(r"①|②|③|④|⑤|ㄱ|ㄴ|ㄷ|ㄹ", explanation))
        if len(explained_markers) < 2 and "보기 복원 없음" not in body + explanation:
            warnings.append(
                warning(
                    "new_jokbo_option_level_explanation_weak",
                    "Recovered options are visible, but the explanation does not clearly discuss multiple options.",
                    candidate_id=candidate_id,
                    explained_markers=sorted(explained_markers),
                )
            )
    return errors, warnings


def load_cards(path: str | Path) -> list[dict[str, Any]]:
    with Path(path).expanduser().open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if isinstance(payload, list):
        return payload
    for key in ("cards", "card_candidates", "candidates"):
        if isinstance(payload, dict) and isinstance(payload.get(key), list):
            return payload[key]
    raise ValueError("Card JSON must be an array or contain cards/card_candidates/candidates array.")


def validate_cards(path: str | Path, contract: dict[str, Any]) -> dict[str, Any]:
    cards = load_cards(path)
    errors: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    metrics = {"candidate_count": len(cards), "by_note_type": {}}
    by_type: dict[str, int] = {}

    for index, card in enumerate(cards):
        candidate_id = card.get("candidate_id") or f"index:{index}"
        note_type_key = card.get("note_type_key")
        fields = card.get("fields", {})
        by_type[note_type_key or "missing"] = by_type.get(note_type_key or "missing", 0) + 1

        if not note_type_key:
            errors.append(error("missing_note_type_key", "candidate is missing note_type_key", candidate_id=candidate_id))
            continue
        if not isinstance(fields, dict):
            errors.append(error("fields_not_object", "candidate fields must be an object", candidate_id=candidate_id))
            continue

        shape_errors, shape_warnings = validate_field_shape(note_type_key, fields, contract, candidate_id)
        errors.extend(shape_errors)
        warnings.extend(shape_warnings)
        all_text = " ".join(str(value) for value in fields.values())
        warnings.extend(scan_ai_smell(all_text, candidate_id))
        warnings.extend(scan_image_caption_quality(all_text, candidate_id))
        errors.extend(scan_metadata_leakage(all_text, candidate_id))
        warnings.extend(scan_table_quality(all_text, candidate_id))
        warnings.extend(scan_basic_front_quality(card, candidate_id))
        warnings.extend(scan_stiff_plain_form(all_text, candidate_id))
        errors.extend(scan_disallowed_humor(all_text, candidate_id))

        if not card.get("source_refs"):
            errors.append(error("missing_source_refs", "candidate must include source_refs", candidate_id=candidate_id))
        if not card.get("likely_confusion"):
            warnings.append(
                warning(
                    "missing_likely_confusion",
                    "candidate should explain what a student is likely to confuse.",
                    candidate_id=candidate_id,
                )
            )
        if not card.get("learning_intent"):
            errors.append(error("missing_learning_intent", "candidate must include learning_intent", candidate_id=candidate_id))
        jokbo_format_errors, jokbo_format_warnings = validate_new_jokbo_format(card, candidate_id)
        errors.extend(jokbo_format_errors)
        warnings.extend(jokbo_format_warnings)
        classification_errors, classification_warnings = validate_jokbo_problem_classification(card, candidate_id)
        errors.extend(classification_errors)
        warnings.extend(classification_warnings)

    metrics["by_note_type"] = by_type
    return {
        "ok": not errors,
        "checked_at": now_iso(),
        "target": str(path),
        "errors": errors,
        "warnings": warnings,
        "metrics": metrics,
    }


def validate_apkg(path: str | Path, contract: dict[str, Any], strict_template_hash: bool = False) -> dict[str, Any]:
    data = extract_apkg_data(path)
    errors: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    specs = note_type_specs(contract)
    note_type_by_id = {note_type["id"]: note_type for note_type in data["notetypes"]}

    rejected_config_hashes: dict[str, str] = {}
    for key, spec in specs.items():
        for rejected_id in spec.get("rejected_duplicate_source_notetype_ids", []):
            rejected_config_hashes[str(rejected_id)] = key

    for note_type in data["notetypes"]:
        note_count = int(note_type.get("note_count", 0))
        if note_count == 0:
            continue
        matched_key = match_contract_key(note_type, contract)
        if not matched_key:
            errors.append(
                error(
                    "non_standard_note_type_with_notes",
                    f"Non-standard note type has notes: {note_type.get('name')} fields={note_type.get('fields')}",
                    note_type=note_type.get("name"),
                    note_count=note_count,
                )
            )
            continue

        spec = specs[matched_key]
        if note_type.get("fields") != spec.get("fields", []):
            errors.append(
                error(
                    "field_shape_drift",
                    f"{note_type.get('name')} fields must be {spec.get('fields')}, got {note_type.get('fields')}",
                    note_type=note_type.get("name"),
                )
            )

        cfg_hash = note_type.get("config_sha256")
        if cfg_hash and cfg_hash == "65794aa77b35fe137017e293250825f45a074929fc57f0f62a308a1387b66fdd":
            errors.append(
                error(
                    "rejected_cloze_template_used",
                    "This APKG uses the @표준화 Cloze sample whose source text says not to use it.",
                    note_type=note_type.get("name"),
                )
            )

        if strict_template_hash:
            expected_hash = spec.get("source_notetype_config_sha256")
            if cfg_hash:
                if cfg_hash != expected_hash:
                    errors.append(
                        error(
                            "template_fingerprint_drift",
                            f"{note_type.get('name')} config hash does not match canonical contract hash.",
                            note_type=note_type.get("name"),
                            expected=expected_hash,
                            actual=cfg_hash,
                        )
                    )
            else:
                warnings.append(
                    warning(
                        "template_hash_unavailable",
                        f"{note_type.get('name')} has no anki21b config hash; strict template equality could not be fully verified.",
                        note_type=note_type.get("name"),
                    )
                )

    for note in data["notes"]:
        note_type = note_type_by_id.get(note["mid"], {})
        matched_key = match_contract_key(note_type, contract)
        if not matched_key:
            continue
        shape_errors, shape_warnings = validate_field_shape(
            matched_key,
            note.get("fields", {}),
            contract,
            str(note["id"]),
        )
        errors.extend(shape_errors)
        warnings.extend(shape_warnings)
        all_text = " ".join(str(value) for value in note.get("fields", {}).values())
        warnings.extend(scan_ai_smell(all_text, str(note["id"])))
        warnings.extend(scan_image_caption_quality(all_text, str(note["id"])))
        errors.extend(scan_metadata_leakage(all_text, str(note["id"])))
        warnings.extend(scan_table_quality(all_text, str(note["id"])))
        warnings.extend(scan_stiff_plain_form(all_text, str(note["id"])))
        errors.extend(scan_disallowed_humor(all_text, str(note["id"])))

        if norm_name(note.get("notetype_name", "")) in {"Basic", "Cloze"}:
            errors.append(
                error(
                    "default_anki_note_type_used",
                    "Default Anki Basic/Cloze is not allowed for generated decks.",
                    note_type=note.get("notetype_name"),
                    candidate_id=str(note["id"]),
                )
            )

    return {
        "ok": not errors,
        "checked_at": now_iso(),
        "target": str(path),
        "errors": errors,
        "warnings": warnings,
        "metrics": {
            "note_count": data["note_count"],
            "card_count": data["card_count"],
            "deck_count": len(data["decks"]),
            "note_type_counts": {
                note_type["name"]: note_type.get("note_count", 0) for note_type in data["notetypes"]
            },
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate Anki Factory candidates or APKGs.")
    parser.add_argument("--contract", required=True, help="standardized-anki-contract.json")
    parser.add_argument("--cards", help="Candidate card JSON to validate")
    parser.add_argument("--apkg", help="APKG to validate")
    parser.add_argument("--strict-template-hash", action="store_true", help="Require canonical anki21b template/config hashes when available")
    parser.add_argument("--out", help="Write report JSON to this path")
    args = parser.parse_args()

    if not args.cards and not args.apkg:
        parser.error("Provide --cards or --apkg")
    if args.cards and args.apkg:
        parser.error("Validate one target at a time")

    contract = load_contract(args.contract)
    if args.cards:
        report = validate_cards(args.cards, contract)
    else:
        report = validate_apkg(args.apkg, contract, args.strict_template_hash)

    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(rendered + "\n", encoding="utf-8")
    else:
        print(rendered)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
