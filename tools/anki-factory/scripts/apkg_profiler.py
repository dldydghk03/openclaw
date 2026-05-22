#!/usr/bin/env python3
"""Read-only APKG profiler for Anki Factory reference decks.

The profiler extracts deck/style metrics so high-quality reference decks can
inform rubrics without authorizing template drift or content copying.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import shutil
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

FIELD_SEP = "\x1f"

AI_SMELL_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("axis_phrase", re.compile(r"(한\s*)?축(이다|으로|과|을|에|처럼|으로\s*묶)", re.I)),
    ("bundle_phrase", re.compile(r"(로|으로)\s*묶(는다|어|으면|기|고)", re.I)),
    ("based_phrase", re.compile(r"(에|을)\s*기반(한다|으로)", re.I)),
    ("aspect_importance", re.compile(r"측면에서\s*중요", re.I)),
    ("generic_core", re.compile(r"핵심은|정리하면|중요하다", re.I)),
    ("compressed_summary", re.compile(r"대표적|일반적으로|주로|관련된다", re.I)),
    (
        "awkward_directional_advice",
        re.compile(
            r"단서가\s*(나오|보이)면|떠올리|떠오른다|그쪽|잡아\s*두|잡아야|잡는다|잡는\s*병|단서로\s*잡|먼저\s*잡|부터\s*잡|생각하세요|쪽으로\s*(가|간|생각|기억|잡|무게)",
            re.I,
        ),
    ),
    (
        "awkward_tutor_register",
        re.compile(
            r"먼저\s*(봅|본|보는)|가장\s*먼저\s*보|이\s*조합|조합이면|더\s*잘\s*맞|잘\s*맞(다|습니다|는)|관점|충분합니다",
            re.I,
        ),
    ),
]

HUMAN_TUTOR_SIGNAL_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("why", re.compile(r"왜|이유|때문|므로|따라서|그래서")),
    ("confusion", re.compile(r"헷갈|혼동|반대로|구분|비교|감별")),
    ("exam", re.compile(r"족보|출제|선지|보기|오답|정답|함정|문제")),
    ("tcheck", re.compile(r"티첵|T-check|tcheck", re.I)),
    ("professor", re.compile(r"교수|강의에서|수업에서")),
    ("option_level", re.compile(r"①|②|③|④|⑤|ㄱ|ㄴ|ㄷ|보기|선지")),
]

DECK_KEYWORDS = [
    "JBL",
    "내용이해",
    "필수암기",
    "족보",
    "고족",
    "티첵",
    "Test",
    "참공",
]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def strip_markup(value: str) -> str:
    value = html.unescape(value or "")
    value = re.sub(r"<br\s*/?>", "\n", value, flags=re.I)
    value = re.sub(r"<[^>]+>", " ", value)
    value = re.sub(r"\{\{c\d+::(.*?)(::.*?)?\}\}", r"\1", value)
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def image_filenames(value: str) -> list[str]:
    names = []
    for match in re.finditer(r"<img[^>]+src=[\"']([^\"']+)[\"']", value or "", flags=re.I):
        src = html.unescape(match.group(1)).strip()
        if src and not re.match(r"^(https?:|data:)", src, flags=re.I):
            names.append(Path(src).name)
    return names


def norm_name(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def percentile(values: list[int], pct: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * pct)))
    return float(ordered[index])


def stats(values: list[int]) -> dict[str, Any]:
    if not values:
        return {"count": 0}
    return {
        "count": len(values),
        "min": min(values),
        "median": float(statistics.median(values)),
        "p90": percentile(values, 0.9),
        "max": max(values),
        "mean": round(float(statistics.mean(values)), 2),
    }


def guess_creator(path: Path) -> str:
    stem = path.stem
    match = re.search(r"\bby\s+([가-힣A-Za-z0-9_. -]{2,20})", stem)
    if match:
        name = re.split(r"\s+\d{3,4}|\s*\(|__", match.group(1).strip())[0].strip()
        return name
    for name in ("한상준", "이원재", "이재서"):
        if name in stem:
            return name
    return ""


def decompress_collection(apkg: Path, workdir: Path) -> Path:
    with zipfile.ZipFile(apkg) as archive:
        names = set(archive.namelist())
        if "collection.anki21b" in names and shutil.which("zstd"):
            archive.extract("collection.anki21b", workdir)
            source = workdir / "collection.anki21b"
            target = workdir / "collection.anki21"
            subprocess.run(["zstd", "-q", "-d", str(source), "-o", str(target)], check=True)
            return target
        if "collection.anki2" in names:
            archive.extract("collection.anki2", workdir)
            return workdir / "collection.anki2"
        if "collection.anki21" in names:
            archive.extract("collection.anki21", workdir)
            return workdir / "collection.anki21"
    raise ValueError(f"No supported Anki collection database found in {apkg}")


def table_exists(cur: sqlite3.Cursor, name: str) -> bool:
    row = cur.execute(
        "select 1 from sqlite_master where type='table' and name=? limit 1",
        (name,),
    ).fetchone()
    return bool(row)


def load_new_schema(cur: sqlite3.Cursor) -> dict[str, Any]:
    notetypes: dict[int, dict[str, Any]] = {}
    for ntid, name, config in cur.execute("select id, name, config from notetypes").fetchall():
        fields = [
            row[0]
            for row in cur.execute(
                "select name from fields where ntid=? order by ord",
                (ntid,),
            ).fetchall()
        ]
        templates = []
        for ord_, tname, tconfig in cur.execute(
            "select ord, name, config from templates where ntid=? order by ord",
            (ntid,),
        ).fetchall():
            templates.append(
                {
                    "ord": ord_,
                    "name": tname,
                    "config_sha256": sha256_bytes(tconfig),
                    "config_len": len(tconfig),
                }
            )
        notetypes[int(ntid)] = {
            "id": int(ntid),
            "name": name,
            "fields": fields,
            "templates": templates,
            "config_sha256": sha256_bytes(config),
            "config_len": len(config),
            "schema": "anki21b",
        }

    decks = {
        int(did): {"id": int(did), "name": name}
        for did, name in cur.execute("select id, name from decks").fetchall()
    }
    return {"notetypes": notetypes, "decks": decks}


def load_legacy_schema(cur: sqlite3.Cursor) -> dict[str, Any]:
    row = cur.execute("select models, decks from col").fetchone()
    if not row:
        raise ValueError("Legacy collection is missing col row")
    models_json, decks_json = row
    models = json.loads(models_json or "{}")
    decks_json_obj = json.loads(decks_json or "{}")
    notetypes: dict[int, dict[str, Any]] = {}
    for raw_id, model in models.items():
        ntid = int(raw_id)
        fields = [field.get("name", "") for field in model.get("flds", [])]
        templates = []
        for tmpl in model.get("tmpls", []):
            qfmt = tmpl.get("qfmt", "")
            afmt = tmpl.get("afmt", "")
            templates.append(
                {
                    "ord": tmpl.get("ord", len(templates)),
                    "name": tmpl.get("name", ""),
                    "qfmt_sha256": hashlib.sha256(qfmt.encode()).hexdigest(),
                    "afmt_sha256": hashlib.sha256(afmt.encode()).hexdigest(),
                    "qfmt_len": len(qfmt),
                    "afmt_len": len(afmt),
                }
            )
        css = model.get("css", "")
        notetypes[ntid] = {
            "id": ntid,
            "name": model.get("name", ""),
            "fields": fields,
            "templates": templates,
            "css_sha256": hashlib.sha256(css.encode()).hexdigest(),
            "css_len": len(css),
            "schema": "anki2",
        }
    decks = {
        int(raw_id): {"id": int(raw_id), "name": deck.get("name", "")}
        for raw_id, deck in decks_json_obj.items()
    }
    return {"notetypes": notetypes, "decks": decks}


def extract_apkg_data(apkg_path: str | Path) -> dict[str, Any]:
    apkg = Path(apkg_path).expanduser()
    with zipfile.ZipFile(apkg) as archive:
        archive_names = archive.namelist()
    packaged_media_files = sorted(name for name in archive_names if name.isdigit())
    with tempfile.TemporaryDirectory(prefix="apkg-profiler-") as temp:
        db_path = decompress_collection(apkg, Path(temp))
        con = sqlite3.connect(db_path)
        cur = con.cursor()
        if table_exists(cur, "notetypes") and cur.execute("select count(*) from notetypes").fetchone()[0]:
            loaded = load_new_schema(cur)
        else:
            loaded = load_legacy_schema(cur)

        notetypes = loaded["notetypes"]
        decks = loaded["decks"]
        card_counts_by_note = Counter()
        note_decks: dict[int, list[dict[str, Any]]] = defaultdict(list)
        deck_counts = Counter()
        for nid, did, ord_ in cur.execute("select nid, did, ord from cards").fetchall():
            card_counts_by_note[int(nid)] += 1
            deck_name = decks.get(int(did), {}).get("name", str(did))
            deck_counts[deck_name] += 1
            note_decks[int(nid)].append({"id": int(did), "name": deck_name, "ord": int(ord_)})

        notes = []
        for nid, mid, tags, flds in cur.execute("select id, mid, tags, flds from notes").fetchall():
            nt = notetypes.get(int(mid), {"name": str(mid), "fields": []})
            raw_values = (flds or "").split(FIELD_SEP)
            fields = {}
            for index, field_name in enumerate(nt.get("fields", [])):
                fields[field_name] = raw_values[index] if index < len(raw_values) else ""
            notes.append(
                {
                    "id": int(nid),
                    "mid": int(mid),
                    "notetype_name": nt.get("name", ""),
                    "notetype_schema": nt.get("schema", ""),
                    "tags": tags or "",
                    "fields": fields,
                    "card_count": card_counts_by_note[int(nid)],
                    "decks": note_decks.get(int(nid), []),
                }
            )
        con.close()

    for nt in notetypes.values():
        nt["note_count"] = sum(1 for note in notes if note["mid"] == nt["id"])
        nt["card_count"] = sum(note["card_count"] for note in notes if note["mid"] == nt["id"])

    return {
        "path": str(apkg),
        "sha256": sha256_file(apkg),
        "creator_guess": guess_creator(apkg),
        "notetypes": list(notetypes.values()),
        "decks": list(decks.values()),
        "deck_card_counts": dict(deck_counts),
        "media": {
            "file_count": len(packaged_media_files),
            "files": packaged_media_files,
            "has_manifest": "media" in archive_names,
        },
        "notes": notes,
        "note_count": len(notes),
        "card_count": sum(note["card_count"] for note in notes),
    }


def load_contract(path: str | Path | None) -> dict[str, Any] | None:
    if not path:
        return None
    with Path(path).expanduser().open("r", encoding="utf-8") as handle:
        return json.load(handle)


def match_contract_key(note_type: dict[str, Any], contract: dict[str, Any] | None) -> str | None:
    if not contract:
        return None
    name = note_type.get("name", "")
    fields = note_type.get("fields", [])
    cfg_hash = note_type.get("config_sha256")
    for key, spec in contract.get("canonical_note_types", {}).items():
        if cfg_hash and cfg_hash == spec.get("source_notetype_config_sha256"):
            return key
        allowed_names = [norm_name(v) for v in spec.get("allowed_name_exact", [])]
        if norm_name(name) in allowed_names and fields == spec.get("fields", []):
            return key
    return None


def build_profile(apkg_path: str | Path, contract: dict[str, Any] | None = None) -> dict[str, Any]:
    data = extract_apkg_data(apkg_path)
    note_type_counts = Counter(note["notetype_name"] for note in data["notes"])
    field_lengths: dict[str, list[int]] = defaultdict(list)
    field_html_lengths: dict[str, list[int]] = defaultdict(list)
    cloze_counts: list[int] = []
    image_note_count = 0
    image_ref_count = 0
    image_refs_by_filename = Counter()
    quality_counts = Counter()
    ai_smell_counts = Counter()
    keyword_counts = Counter()
    unauthorized_note_count = 0
    notes_with_default_type = 0

    nt_by_mid = {nt["id"]: nt for nt in data["notetypes"]}
    contract_matches = {}
    for nt in data["notetypes"]:
        key = match_contract_key(nt, contract)
        if key:
            contract_matches[str(nt["id"])] = key

    for note in data["notes"]:
        nt = nt_by_mid.get(note["mid"], {})
        if contract and not match_contract_key(nt, contract):
            unauthorized_note_count += 1
        if norm_name(note["notetype_name"]) in {"Basic", "Cloze"}:
            notes_with_default_type += 1
        combined_parts = []
        note_has_image = False
        for field_name, value in note["fields"].items():
            plain = strip_markup(value)
            names = image_filenames(value or "")
            if names:
                note_has_image = True
                image_ref_count += len(names)
                image_refs_by_filename.update(names)
            field_lengths[f"{note['notetype_name']}::{field_name}"].append(len(plain))
            field_html_lengths[f"{note['notetype_name']}::{field_name}"].append(len(value or ""))
            combined_parts.append(plain)
            cloze_counts.append(len(re.findall(r"\{\{c\d+::", value or "")))
        combined = " ".join(combined_parts)
        if note_has_image:
            image_note_count += 1
        for label, pattern in HUMAN_TUTOR_SIGNAL_PATTERNS:
            if pattern.search(combined):
                quality_counts[label] += 1
        for label, pattern in AI_SMELL_PATTERNS:
            matches = pattern.findall(combined)
            if matches:
                ai_smell_counts[label] += len(matches)
        for keyword in DECK_KEYWORDS:
            if keyword.lower() in combined.lower() or keyword.lower() in note.get("tags", "").lower():
                keyword_counts[keyword] += 1

    deck_keyword_counts = Counter()
    for deck in data["decks"]:
        name = deck.get("name", "")
        for keyword in DECK_KEYWORDS:
            if keyword.lower() in name.lower():
                deck_keyword_counts[keyword] += 1

    profile = {
        "path": data["path"],
        "sha256": data["sha256"],
        "creator_guess": data["creator_guess"],
        "note_count": data["note_count"],
        "card_count": data["card_count"],
        "deck_count": len(data["decks"]),
        "notetypes": data["notetypes"],
        "deck_names": [deck.get("name", "") for deck in data["decks"]],
        "deck_card_counts": data["deck_card_counts"],
        "media": {
            **data.get("media", {}),
            "image_note_count": image_note_count,
            "image_ref_count": image_ref_count,
            "image_refs_by_filename": dict(image_refs_by_filename),
        },
        "note_type_counts": dict(note_type_counts),
        "field_metrics": {
            "plain_length": {key: stats(values) for key, values in sorted(field_lengths.items())},
            "html_length": {key: stats(values) for key, values in sorted(field_html_lengths.items())},
            "cloze_count_per_note": stats(cloze_counts),
        },
        "quality_signals": {
            "human_tutor_signal_counts": dict(quality_counts),
            "ai_smell_counts": dict(ai_smell_counts),
            "content_keyword_counts": dict(keyword_counts),
            "deck_keyword_counts": dict(deck_keyword_counts),
        },
        "format_compliance": {
            "contract_matches_by_notetype_id": contract_matches,
            "unauthorized_notes_by_contract": unauthorized_note_count,
            "default_basic_or_cloze_notes": notes_with_default_type,
        },
    }
    return profile


def discover_apkgs(roots: list[str], authors: list[str], max_files: int) -> list[Path]:
    found: list[Path] = []
    seen: set[str] = set()
    for root in roots:
        root_path = Path(root).expanduser()
        if not root_path.exists():
            continue
        if root_path.is_file() and root_path.suffix.lower() == ".apkg":
            candidates = [root_path]
        else:
            candidates = sorted(root_path.rglob("*.apkg"))
        for path in candidates:
            text = str(path)
            if authors and not any(author in text for author in authors):
                continue
            resolved = str(path.resolve())
            if resolved in seen:
                continue
            seen.add(resolved)
            found.append(path)
            if max_files and len(found) >= max_files:
                return found
    return found


def aggregate_profiles(profiles: list[dict[str, Any]]) -> dict[str, Any]:
    creators = Counter(profile.get("creator_guess", "") or "unknown" for profile in profiles)
    note_types = Counter()
    deck_keywords = Counter()
    ai_smell = Counter()
    human_signals = Counter()
    notes = 0
    cards = 0
    for profile in profiles:
        notes += int(profile.get("note_count", 0))
        cards += int(profile.get("card_count", 0))
        note_types.update(profile.get("note_type_counts", {}))
        deck_keywords.update(profile.get("quality_signals", {}).get("deck_keyword_counts", {}))
        ai_smell.update(profile.get("quality_signals", {}).get("ai_smell_counts", {}))
        human_signals.update(profile.get("quality_signals", {}).get("human_tutor_signal_counts", {}))
    return {
        "deck_count": len(profiles),
        "note_count": notes,
        "card_count": cards,
        "creator_counts": dict(creators),
        "note_type_counts": dict(note_types),
        "deck_keyword_counts": dict(deck_keywords),
        "human_tutor_signal_counts": dict(human_signals),
        "ai_smell_counts": dict(ai_smell),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Profile APKG decks for Anki Factory.")
    parser.add_argument("apkg", nargs="*", help="APKG files to profile. If omitted, scan roots are used.")
    parser.add_argument("--contract", default=None, help="standardized-anki-contract.json")
    parser.add_argument("--scan-root", action="append", default=[], help="Directory or APKG to scan.")
    parser.add_argument("--author", action="append", default=[], help="Filter filenames by author name.")
    parser.add_argument("--include-secondary-authors", action="store_true")
    parser.add_argument("--max-files", type=int, default=80)
    parser.add_argument("--out", default=None, help="Write corpus JSON to this path.")
    args = parser.parse_args()

    contract = load_contract(args.contract)
    authors = list(args.author)
    roots = list(args.scan_root)
    if contract:
        if not authors:
            authors = list(contract.get("reference_quality_sources", {}).get("primary_authors", []))
        if args.include_secondary_authors:
            authors += list(contract.get("reference_quality_sources", {}).get("secondary_authors", []))
        if not roots:
            roots = list(contract.get("reference_quality_sources", {}).get("default_scan_roots", []))

    paths = [Path(p).expanduser() for p in args.apkg]
    if not paths:
        paths = discover_apkgs(roots, authors, args.max_files)
    if not paths:
        print("No APKG files found.", file=sys.stderr)
        return 2

    profiles = []
    errors = []
    for path in paths:
        try:
            profiles.append(build_profile(path, contract))
        except Exception as exc:  # keep corpus generation resilient
            errors.append({"path": str(path), "error": str(exc)})

    corpus = {
        "generated_at": now_iso(),
        "contract_version": contract.get("contract_version") if contract else None,
        "selection": {
            "authors": authors,
            "roots": roots,
            "requested_files": [str(path) for path in paths],
            "profiled_count": len(profiles),
            "error_count": len(errors),
        },
        "aggregate": aggregate_profiles(profiles),
        "profiles": profiles,
        "errors": errors,
    }

    rendered = json.dumps(corpus, ensure_ascii=False, indent=2)
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(rendered + "\n", encoding="utf-8")
    else:
        print(rendered)
    return 0 if profiles else 1


if __name__ == "__main__":
    raise SystemExit(main())
