#!/usr/bin/env python3
"""Build a static public-safe Anki Factory quality dashboard."""

from __future__ import annotations

import argparse
import html
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def read_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"Expected JSON object in {path}")
    return data


def status_label(ok: bool) -> str:
    return "PASS" if ok else "FAIL"


def render_list(items: list[Any]) -> str:
    if not items:
        return "<li>None</li>"
    return "\n".join(f"<li>{html.escape(str(item))}</li>" for item in items)


def build_html(report: dict[str, Any], repo: str, ref: str, sha: str) -> str:
    agent_gate = report.get("agent_eval_gate", {})
    fixture_gate = report.get("fixture_gate", {})
    integration_gate = report.get("copilot_integration_gate", {})
    coverage = agent_gate.get("coverage", {}) if isinstance(agent_gate, dict) else {}
    observed = coverage.get("observed", {}) if isinstance(coverage, dict) else {}
    bad_fixture = fixture_gate.get("bad", {}) if isinstance(fixture_gate, dict) else {}
    good_fixture = fixture_gate.get("good", {}) if isinstance(fixture_gate, dict) else {}

    ok = bool(report.get("ok"))
    case_count = agent_gate.get("case_count", 0) if isinstance(agent_gate, dict) else 0
    failed_count = agent_gate.get("failed_count", 0) if isinstance(agent_gate, dict) else 0
    checks = integration_gate.get("checks", []) if isinstance(integration_gate, dict) else []
    checked_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()

    css = """
      :root {
        color-scheme: light;
        --ink: #1c1b19;
        --muted: #6b6258;
        --paper: #fff9ef;
        --panel: #fffdf8;
        --line: #ded4c7;
        --pass: #1f7a4d;
        --fail: #b42318;
        --accent: #8a5a20;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(189, 142, 75, 0.18), transparent 34rem),
          linear-gradient(135deg, #f8f1e7, #efe8db 58%, #f9f5ee);
      }
      main {
        max-width: 1120px;
        margin: 0 auto;
        padding: 44px 22px 64px;
      }
      header {
        display: grid;
        gap: 10px;
        margin-bottom: 24px;
      }
      h1 {
        margin: 0;
        font-size: clamp(2rem, 6vw, 4.5rem);
        letter-spacing: -0.06em;
      }
      h2 { margin: 0 0 12px; }
      p { color: var(--muted); line-height: 1.55; }
      code {
        border-radius: 7px;
        padding: 2px 7px;
        background: #eee1cf;
      }
      .status {
        display: inline-flex;
        width: fit-content;
        border-radius: 999px;
        padding: 6px 12px;
        color: #fff;
        background: var(--fail);
        font-weight: 700;
        letter-spacing: 0.04em;
      }
      .status.pass { background: var(--pass); }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 16px;
      }
      .panel {
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 22px;
        background: rgba(255, 253, 248, 0.9);
        box-shadow: 0 16px 36px rgba(59, 43, 24, 0.08);
      }
      .metric {
        font-size: 2.2rem;
        font-weight: 800;
        letter-spacing: -0.04em;
      }
      ul {
        margin: 0;
        padding-left: 20px;
        color: var(--muted);
      }
      .meta {
        display: grid;
        gap: 4px;
        color: var(--muted);
        font-size: 0.95rem;
      }
      .meta strong { color: var(--ink); }
    """

    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Anki Factory Quality Dashboard</title>
    <style>{css}</style>
  </head>
  <body>
    <main>
      <header>
        <span class="status {'pass' if ok else ''}">{status_label(ok)}</span>
        <h1>Anki Factory Quality Dashboard</h1>
        <p>
          Public-safe dashboard for synthetic Anki Factory quality gates. It
          does not publish lecture notes, private APKGs, recovered exam text,
          Drive exports, or local run outputs.
        </p>
        <div class="meta">
          <span><strong>Repository:</strong> {html.escape(repo)}</span>
          <span><strong>Ref:</strong> {html.escape(ref)}</span>
          <span><strong>SHA:</strong> {html.escape(sha)}</span>
          <span><strong>Generated:</strong> {checked_at}</span>
        </div>
      </header>

      <section class="grid" aria-label="Gate summary">
        <article class="panel">
          <h2>Agent Evals</h2>
          <div class="metric">{html.escape(str(case_count))}</div>
          <p>{html.escape(str(failed_count))} failed cases.</p>
        </article>
        <article class="panel">
          <h2>Fixture Gate</h2>
          <div class="metric">{status_label(bool(fixture_gate.get('ok')))}</div>
          <p>Good fixture warnings: {html.escape(str(len(as_list(good_fixture.get('warnings')))))}</p>
        </article>
        <article class="panel">
          <h2>Integration Gate</h2>
          <div class="metric">{status_label(bool(integration_gate.get('ok')))}</div>
          <p>{html.escape(str(len(as_list(checks))))} wiring checks completed.</p>
        </article>
      </section>

      <section class="grid" aria-label="Details" style="margin-top: 16px;">
        <article class="panel">
          <h2>Eval Coverage</h2>
          <ul>
            <li>Total cases: {html.escape(str(observed.get('total_cases', 0)))}</li>
            <li>Card quality cases: {html.escape(str(observed.get('card_quality_cases', 0)))}</li>
            <li>Phrasing regression cases: {html.escape(str(observed.get('phrasing_regression_cases', 0)))}</li>
            <li>Copilot integration cases: {html.escape(str(observed.get('copilot_integration_cases', 0)))}</li>
          </ul>
        </article>
        <article class="panel">
          <h2>Expected Bad Fixture Signals</h2>
          <ul>{render_list(as_list(bad_fixture.get('errors')) + as_list(bad_fixture.get('warnings')))}</ul>
        </article>
        <article class="panel">
          <h2>Public Boundaries</h2>
          <ul>
            <li>No private lecture notes.</li>
            <li>No source APKG deck content.</li>
            <li>No recovered exam text.</li>
            <li>No local user paths or Drive exports.</li>
          </ul>
        </article>
      </section>
    </main>
  </body>
</html>
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the public-safe Anki Factory quality dashboard.")
    parser.add_argument("--smoke-report", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--repo", default="local")
    parser.add_argument("--ref", default="local")
    parser.add_argument("--sha", default="unknown")
    args = parser.parse_args()

    report = read_json(args.smoke_report)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    (args.out_dir / "index.html").write_text(
        build_html(report, repo=args.repo, ref=args.ref, sha=args.sha),
        encoding="utf-8",
    )
    (args.out_dir / "smoke-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
