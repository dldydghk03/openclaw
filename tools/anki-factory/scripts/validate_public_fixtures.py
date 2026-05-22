#!/usr/bin/env python3
"""Run public synthetic Anki Factory fixture checks.

This script is intentionally limited to synthetic data so GitHub Copilot and CI
can improve the Anki Factory engine without seeing private lecture/APKG content.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ANKI_FACTORY_ROOT = SCRIPT_DIR.parent

sys.path.insert(0, str(SCRIPT_DIR))

from quality_gate import load_contract, validate_cards  # noqa: E402


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def codes(items: list[dict[str, object]]) -> set[str]:
    return {str(item.get("code")) for item in items}


def main() -> int:
    contract_path = ANKI_FACTORY_ROOT / "standardized-anki-contract.json"
    good_cards = ANKI_FACTORY_ROOT / "fixtures/good/card-candidates.preview.json"
    bad_cards = ANKI_FACTORY_ROOT / "fixtures/bad/card-candidates.preview.json"
    contract = load_contract(contract_path)

    good_report = validate_cards(good_cards, contract)
    require(good_report["ok"], f"good fixture should pass, got errors={good_report['errors']}")
    require(not good_report["warnings"], f"good fixture should have no warnings, got {good_report['warnings']}")

    bad_report = validate_cards(bad_cards, contract)
    bad_error_codes = codes(bad_report["errors"])
    bad_warning_codes = codes(bad_report["warnings"])
    require(not bad_report["ok"], "bad fixture should fail because visible fields leak metadata")
    require("metadata_leaked_to_card_field" in bad_error_codes, "bad fixture should catch metadata leakage")
    require("basic_front_title_too_long" in bad_warning_codes, "bad fixture should catch long Basic Front")
    require("table_missing_border" in bad_warning_codes, "bad fixture should catch missing table border")
    require("table_missing_cellpadding" in bad_warning_codes, "bad fixture should catch missing table padding")
    require("table_missing_gray_header" in bad_warning_codes, "bad fixture should catch missing table header styling")
    require(
        "new_jokbo_option_level_explanation_weak" in bad_warning_codes,
        "bad fixture should catch weak option-level jokbo explanation",
    )

    print(
        json.dumps(
            {
                "ok": True,
                "good": {
                    "errors": len(good_report["errors"]),
                    "warnings": len(good_report["warnings"]),
                    "metrics": good_report["metrics"],
                },
                "bad": {
                    "errors": sorted(bad_error_codes),
                    "warnings": sorted(bad_warning_codes),
                    "metrics": bad_report["metrics"],
                },
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
