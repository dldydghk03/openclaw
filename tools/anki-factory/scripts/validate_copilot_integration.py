#!/usr/bin/env python3
"""Validate the public-safe Copilot integration for Anki Factory."""

from __future__ import annotations

import json
import re
import argparse
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SMOKE_COMMAND = ".github/skills/anki-factory-quality/scripts/run-smoke.sh"
AGENT_EVAL_COMMAND = "tools/anki-factory/scripts/run_agent_evals.py"
AGENT_EVAL_GATE = "agent_eval_gate"
INSTRUCTION_BUDGET_CHARS = 4000
CORE_RULE_WINDOW_CHARS = 3500

REQUIRED_FILES = [
    ".github/copilot-instructions.md",
    ".github/instructions/anki-factory.instructions.md",
    ".github/agents/anki-factory-maintainer.agent.md",
    ".github/ISSUE_TEMPLATE/anki_factory_improvement.yml",
    ".github/ISSUE_TEMPLATE/deck_quality_regression.yml",
    ".github/ISSUE_TEMPLATE/workflow_gate_change.yml",
    ".github/labeler.yml",
    ".github/pull_request_template.md",
    ".github/skills/anki-factory-quality/SKILL.md",
    ".github/hooks/anki-factory-quality.json",
    ".github/hooks/anki-factory-smoke.sh",
    ".github/workflows/anki-factory-ci.yml",
    "docs/anki-factory/copilot-operation.md",
    "tools/anki-factory/scripts/validate_public_fixtures.py",
    "tools/anki-factory/scripts/run_agent_evals.py",
    "tools/anki-factory/evals/README.md",
    "tools/anki-factory/evals/manifest.json",
]

PRIVATE_BOUNDARY_PATHS = [
    ".github/copilot-instructions.md",
    ".github/instructions/anki-factory.instructions.md",
    ".github/agents/anki-factory-maintainer.agent.md",
    ".github/skills/anki-factory-quality/SKILL.md",
    "docs/anki-factory/copilot-operation.md",
    "tools/anki-factory/README.md",
]

EXPECTED_PATH_GLOBS = [
    "tools/anki-factory/**",
    "docs/anki-factory/**",
    ".github/copilot-instructions.md",
    ".github/instructions/anki-factory.instructions.md",
    ".github/agents/anki-factory-maintainer.agent.md",
    ".github/ISSUE_TEMPLATE/anki_factory_improvement.yml",
    ".github/ISSUE_TEMPLATE/deck_quality_regression.yml",
    ".github/ISSUE_TEMPLATE/workflow_gate_change.yml",
    ".github/labeler.yml",
    ".github/pull_request_template.md",
    ".github/skills/anki-factory-quality/**",
    ".github/hooks/anki-factory-*.json",
    ".github/hooks/anki-factory-*.sh",
    ".github/workflows/anki-factory-ci.yml",
]

INSTRUCTION_BUDGET_FILES = {
    ".github/copilot-instructions.md": [
        "Privacy Boundary",
        "Anki Factory Hard Rules",
        "Public CI must use synthetic fixtures only",
    ],
    ".github/instructions/anki-factory.instructions.md": [
        "Blockers",
        "Any change that allows non-standard note types",
        "Any public fixture or documentation",
        "Expected Positive Pattern",
    ],
    ".github/agents/anki-factory-maintainer.agent.md": [
        "Data Boundary",
        "Required Validation",
        AGENT_EVAL_COMMAND,
        "Eval Policy",
        "Do not remove or bypass",
    ],
    ".github/skills/anki-factory-quality/SKILL.md": [
        "Not allowed:",
        "Quality Rules",
        AGENT_EVAL_COMMAND,
        AGENT_EVAL_GATE,
    ],
}


class ValidationError(AssertionError):
    """Expected validation failure with a user-safe message."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def frontmatter(text: str) -> dict[str, str]:
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---\n", 4)
    if end == -1:
        return {}
    parsed: dict[str, str] = {}
    for line in text[4:end].splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        parsed[key.strip()] = value.strip().strip('"')
    return parsed


def validate_required_files() -> None:
    missing = [path for path in REQUIRED_FILES if not (REPO_ROOT / path).is_file()]
    require(not missing, f"Missing required Copilot integration files: {missing}")


def validate_instruction_scope() -> None:
    text = read(".github/instructions/anki-factory.instructions.md")
    metadata = frontmatter(text)
    apply_to = metadata.get("applyTo", "")
    require(apply_to, "Path-specific Copilot instructions must define applyTo frontmatter")
    missing = [glob for glob in EXPECTED_PATH_GLOBS if glob not in apply_to]
    require(not missing, f"Copilot applyTo is missing required paths: {missing}")

    repo_instructions = read(".github/copilot-instructions.md")
    for phrase in [
        "AGENTS.md",
        "Privacy Boundary",
        "Anki Factory Hard Rules",
        "@표준화 Basic",
        "@표준화 Cloze",
        "@표준화 뉴족보",
    ]:
        require(phrase in repo_instructions, f"Repository Copilot instructions must mention {phrase!r}")


def validate_instruction_budget() -> None:
    for path, markers in INSTRUCTION_BUDGET_FILES.items():
        text = read(path)
        require(
            len(text) <= INSTRUCTION_BUDGET_CHARS,
            f"Instruction file exceeds budget: {path} has {len(text)} chars > {INSTRUCTION_BUDGET_CHARS}",
        )
        for marker in markers:
            index = text.find(marker)
            require(index != -1, f"Instruction core marker missing from {path}: {marker}")
            require(
                index < CORE_RULE_WINDOW_CHARS,
                f"Instruction core marker appears too late in {path}: {marker}",
            )


def validate_agent_and_skill() -> None:
    agent_text = read(".github/agents/anki-factory-maintainer.agent.md")
    agent_meta = frontmatter(agent_text)
    require(agent_meta.get("name") == "anki-factory-maintainer", "Custom agent name drifted")
    require(agent_meta.get("description"), "Custom agent description is required")
    require(SMOKE_COMMAND in agent_text, "Custom agent must require the Anki Factory smoke command")
    require(agent_text.count(AGENT_EVAL_COMMAND) >= 2, "Custom agent must require agent evals in validation and eval policy")
    require(AGENT_EVAL_GATE in agent_text, "Custom agent must treat missing agent_eval_gate as a failure")
    require("Do not remove or bypass" in agent_text, "Custom agent must forbid bypassing agent evals")
    require("private lecture" in agent_text.lower(), "Custom agent must state private data boundary")
    require("@표준화 Basic" in agent_text and "@표준화 Cloze" in agent_text, "Custom agent must preserve standardized note types")

    skill_text = read(".github/skills/anki-factory-quality/SKILL.md")
    skill_meta = frontmatter(skill_text)
    require(skill_meta.get("name") == "anki-factory-quality", "Skill name drifted")
    require(skill_meta.get("description"), "Skill description is required")
    require(SMOKE_COMMAND in skill_text, "Skill must expose the smoke command")
    require(AGENT_EVAL_COMMAND in skill_text, "Skill must expose the agent eval command")
    require(AGENT_EVAL_GATE in skill_text, "Skill must describe agent_eval_gate output")
    require("Not allowed" in skill_text and "Private run outputs" in skill_text, "Skill must keep private data out of scope")


def validate_hook_and_ci() -> None:
    hook_path = REPO_ROOT / ".github/hooks/anki-factory-quality.json"
    hook = json.loads(hook_path.read_text(encoding="utf-8"))
    agent_stop = hook.get("hooks", {}).get("agentStop", [])
    require(isinstance(agent_stop, list) and agent_stop, "Hook config must define hooks.agentStop")
    smoke_hook = next((item for item in agent_stop if item.get("bash") == ".github/hooks/anki-factory-smoke.sh"), None)
    require(smoke_hook is not None, "Hook config must run .github/hooks/anki-factory-smoke.sh")
    require(smoke_hook.get("type") == "command", "Hook must use command type")
    require(int(smoke_hook.get("timeoutSec", 0)) >= 30, "Hook timeout must allow the smoke check to finish")

    hook_script = read(".github/hooks/anki-factory-smoke.sh")
    require(SMOKE_COMMAND in hook_script, "Hook script must delegate to the same smoke command")
    for glob in EXPECTED_PATH_GLOBS:
        if glob.endswith("**") or "*" in glob:
            continue
        require(glob in hook_script, f"Hook changed-file detector must include {glob}")

    workflow = read(".github/workflows/anki-factory-ci.yml")
    require(SMOKE_COMMAND in workflow, "CI workflow must run the same smoke command")
    require("pull_request:" in workflow and "workflow_dispatch:" in workflow, "CI workflow must support PR and manual runs")
    require("set -o pipefail" in workflow, "CI workflow must fail when smoke fails through tee")
    require("actions/upload-artifact@v4" in workflow, "CI workflow must upload the smoke report artifact")
    require("anki-factory-smoke-report" in workflow, "CI workflow must name the smoke report artifact")
    require("$GITHUB_STEP_SUMMARY" in workflow, "CI workflow must publish the smoke report summary")
    require("anki-factory-ci-artifacts/smoke-report.json" in workflow, "CI workflow must persist the smoke report JSON")
    for glob in EXPECTED_PATH_GLOBS:
        require(workflow.count(glob) >= 2, f"CI path filter must include {glob} for pull_request and push")

    smoke_script = read(SMOKE_COMMAND)
    require(AGENT_EVAL_COMMAND in smoke_script, "Smoke command must run agent evals")
    require(AGENT_EVAL_GATE in smoke_script, "Smoke command must emit agent_eval_gate")


def validate_issue_templates_and_pr_checklist() -> None:
    issue_templates = {
        ".github/ISSUE_TEMPLATE/anki_factory_improvement.yml": [
            "Anki Factory improvement",
            "Public-safe boundary",
            "synthetic examples",
            SMOKE_COMMAND,
            "copilot-ready",
        ],
        ".github/ISSUE_TEMPLATE/deck_quality_regression.yml": [
            "Deck quality regression",
            "Synthetic or redacted example",
            "Gate or eval expectation",
            "No private source deck",
            "deck-quality",
        ],
        ".github/ISSUE_TEMPLATE/workflow_gate_change.yml": [
            "Workflow gate change",
            "preview",
            "approval",
            "read-back",
            "fails closed",
        ],
    }
    for path, required_terms in issue_templates.items():
        text = read(path)
        for term in required_terms:
            require(term in text, f"Issue template {path} must include {term!r}")

    pr_template = read(".github/pull_request_template.md")
    for term in [
        "Anki Factory / Workflow Gate Evidence",
        "preview_file",
        "approval_id",
        "read-back",
        SMOKE_COMMAND,
        "No private lecture notes",
    ]:
        require(term in pr_template, f"PR template must include Anki Factory checklist term {term!r}")

    labeler = read(".github/labeler.yml")
    for term in [
        '"anki-factory"',
        "tools/anki-factory/**",
        "docs/anki-factory/**",
        ".github/ISSUE_TEMPLATE/anki_factory_improvement.yml",
        ".github/pull_request_template.md",
    ]:
        require(term in labeler, f"Labeler must include Anki Factory path term {term!r}")


def validate_public_boundary_terms() -> None:
    private_markers = [
        "/" + "Users" + "/",
        "Down" + "loads",
        "Drive" + "Corpus",
        "lecture" + "-source",
        "jokbo" + "-source",
    ]
    leaked: list[str] = []
    for path in PRIVATE_BOUNDARY_PATHS:
        text = read(path)
        for marker in private_markers:
            if marker in text:
                leaked.append(f"{path}: private-boundary-marker")
    require(not leaked, f"Public Copilot files contain private boundary leaks: {leaked}")


def main() -> int:
    global REPO_ROOT

    parser = argparse.ArgumentParser(description="Validate Anki Factory Copilot integration wiring.")
    parser.add_argument("--repo-root", default=str(REPO_ROOT), help="Repository root to validate.")
    args = parser.parse_args()

    REPO_ROOT = Path(args.repo_root).resolve()

    checks = [
        validate_required_files,
        validate_instruction_scope,
        validate_instruction_budget,
        validate_agent_and_skill,
        validate_hook_and_ci,
        validate_issue_templates_and_pr_checklist,
        validate_public_boundary_terms,
    ]
    completed: list[str] = []
    for check in checks:
        try:
            check()
        except ValidationError as exc:
            print(
                json.dumps(
                    {
                        "ok": False,
                        "failed_check": check.__name__,
                        "completed_checks": completed,
                        "error": str(exc),
                    },
                    indent=2,
                )
            )
            return 1
        completed.append(check.__name__)
    print(json.dumps({"ok": True, "checks": completed}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
