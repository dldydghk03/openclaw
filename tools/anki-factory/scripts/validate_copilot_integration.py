#!/usr/bin/env python3
"""Validate the public-safe Copilot integration for Anki Factory."""

from __future__ import annotations

import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SMOKE_COMMAND = ".github/skills/anki-factory-quality/scripts/run-smoke.sh"

REQUIRED_FILES = [
    ".github/copilot-instructions.md",
    ".github/instructions/anki-factory.instructions.md",
    ".github/agents/anki-factory-maintainer.agent.md",
    ".github/skills/anki-factory-quality/SKILL.md",
    ".github/hooks/anki-factory-quality.json",
    ".github/hooks/anki-factory-smoke.sh",
    ".github/workflows/anki-factory-ci.yml",
    "docs/anki-factory/copilot-operation.md",
    "tools/anki-factory/scripts/validate_public_fixtures.py",
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
    ".github/skills/anki-factory-quality/**",
    ".github/hooks/anki-factory-*.json",
    ".github/hooks/anki-factory-*.sh",
    ".github/workflows/anki-factory-ci.yml",
]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


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


def validate_agent_and_skill() -> None:
    agent_text = read(".github/agents/anki-factory-maintainer.agent.md")
    agent_meta = frontmatter(agent_text)
    require(agent_meta.get("name") == "anki-factory-maintainer", "Custom agent name drifted")
    require(agent_meta.get("description"), "Custom agent description is required")
    require(SMOKE_COMMAND in agent_text, "Custom agent must require the Anki Factory smoke command")
    require("private lecture" in agent_text.lower(), "Custom agent must state private data boundary")
    require("@표준화 Basic" in agent_text and "@표준화 Cloze" in agent_text, "Custom agent must preserve standardized note types")

    skill_text = read(".github/skills/anki-factory-quality/SKILL.md")
    skill_meta = frontmatter(skill_text)
    require(skill_meta.get("name") == "anki-factory-quality", "Skill name drifted")
    require(skill_meta.get("description"), "Skill description is required")
    require(SMOKE_COMMAND in skill_text, "Skill must expose the smoke command")
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
    for glob in EXPECTED_PATH_GLOBS:
        require(glob in workflow, f"CI path filter must include {glob}")


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
                leaked.append(f"{path}: {marker}")
    require(not leaked, f"Public Copilot files contain private boundary leaks: {leaked}")


def main() -> int:
    checks = [
        validate_required_files,
        validate_instruction_scope,
        validate_agent_and_skill,
        validate_hook_and_ci,
        validate_public_boundary_terms,
    ]
    for check in checks:
        check()
    print(json.dumps({"ok": True, "checks": [check.__name__ for check in checks]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
