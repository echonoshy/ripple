import re
from pathlib import Path

LARK_SKILLS_ROOT = Path("skills/lark")
LARK_SHARED_SKILL = LARK_SKILLS_ROOT / "lark-shared" / "SKILL.md"

DIRECT_AUTH_RE = re.compile(r"\bauth login\s+--(?:domain|scope)\b")
IDENTITY_COMMAND_RE = re.compile(
    r"^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\$\()?lark-cli\s+"
    r"(?P<command>im \+(?:chat-search|chat-list|chat-create|chat-messages-list|messages-search|messages-send)"
    r"|contact \+search-user)\b"
)


def test_lark_skills_do_not_reintroduce_direct_cli_auth_guidance():
    offenders: list[str] = []
    for path in sorted(LARK_SKILLS_ROOT.rglob("*.md")):
        if path == LARK_SHARED_SKILL:
            continue
        text = path.read_text(encoding="utf-8")
        for line_number, line in enumerate(text.splitlines(), start=1):
            if DIRECT_AUTH_RE.search(line) or "lark-cli auth login" in line:
                offenders.append(f"{path}:{line_number}: {line.strip()}")

    assert offenders == []


def test_lark_key_identity_examples_are_explicit():
    offenders: list[str] = []
    for path in sorted(LARK_SKILLS_ROOT.rglob("*.md")):
        text = path.read_text(encoding="utf-8")
        for line_number, line in enumerate(text.splitlines(), start=1):
            match = IDENTITY_COMMAND_RE.search(line)
            if match is None:
                continue
            command = match.group("command")
            if command == "contact +search-user":
                if "--as user" not in line:
                    offenders.append(f"{path}:{line_number}: {line.strip()}")
                continue
            if "--as user" not in line and "--as bot" not in line:
                offenders.append(f"{path}:{line_number}: {line.strip()}")

    assert offenders == []
