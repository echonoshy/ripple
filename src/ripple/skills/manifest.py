"""Codex-facing skill manifest helpers."""

import re
from dataclasses import dataclass
from pathlib import Path

from ripple.skills.loader import (
    WORKSPACE_SKILLS_DIRNAME,
    _get_shared_skill_dirs,
    load_shared_skills,
    load_workspace_skills,
)
from ripple.skills.types import Skill

SANDBOX_SHARED_SKILLS_ROOT = "/opt/ripple/skills/shared"


@dataclass(frozen=True)
class SharedSkillMount:
    source: Path
    sandbox_path: str


@dataclass(frozen=True)
class SkillManifestEntry:
    name: str
    description: str
    source: str
    path: str
    when_to_use: str | None = None
    version: str | None = None


def _safe_mount_segment(value: str) -> str:
    segment = re.sub(r"[^a-zA-Z0-9._-]+", "-", value.strip())
    return segment.strip("-") or "skills"


def shared_skill_mounts() -> list[SharedSkillMount]:
    mounts: list[SharedSkillMount] = []
    for index, source in enumerate(_get_shared_skill_dirs()):
        mounts.append(
            SharedSkillMount(
                source=source,
                sandbox_path=f"{SANDBOX_SHARED_SKILLS_ROOT}/{index}-{_safe_mount_segment(source.name)}",
            )
        )
    return mounts


def _shared_skill_sandbox_path(skill_path: Path) -> str | None:
    for mount in shared_skill_mounts():
        try:
            relative = skill_path.relative_to(mount.source)
        except ValueError:
            continue
        return str(Path(mount.sandbox_path) / relative).replace("\\", "/")
    return None


def _workspace_skill_sandbox_path(skill_path: Path, workspace_root: Path) -> str | None:
    skills_root = workspace_root / WORKSPACE_SKILLS_DIRNAME
    try:
        relative = skill_path.relative_to(skills_root)
    except ValueError:
        return None
    return str(Path("/workspace") / WORKSPACE_SKILLS_DIRNAME / relative).replace("\\", "/")


def _entry_for_skill(skill: Skill, *, workspace_root: Path | None) -> SkillManifestEntry | None:
    skill_path = Path(skill.file_path)
    if workspace_root is not None:
        workspace_path = _workspace_skill_sandbox_path(skill_path, workspace_root)
        if workspace_path is not None:
            return SkillManifestEntry(
                name=skill.name,
                description=skill.description,
                source="workspace",
                path=workspace_path,
                when_to_use=skill.when_to_use,
                version=skill.version,
            )

    shared_path = _shared_skill_sandbox_path(skill_path)
    if shared_path is None:
        return None
    return SkillManifestEntry(
        name=skill.name,
        description=skill.description,
        source="shared",
        path=shared_path,
        when_to_use=skill.when_to_use,
        version=skill.version,
    )


def build_skill_manifest(workspace_root: Path | None) -> list[SkillManifestEntry]:
    skills = load_workspace_skills(workspace_root) if workspace_root is not None else load_shared_skills()
    entries: list[SkillManifestEntry] = []
    for skill in sorted(skills.values(), key=lambda item: item.name.casefold()):
        entry = _entry_for_skill(skill, workspace_root=workspace_root)
        if entry is not None:
            entries.append(entry)
    return entries


def render_skill_manifest(workspace_root: Path | None) -> str:
    entries = build_skill_manifest(workspace_root)
    if not entries:
        return "- no skills available"

    lines: list[str] = []
    for entry in entries:
        line = f"- {entry.name} ({entry.source}): {entry.description or '(no description)'}"
        line += f"\n  path: {entry.path}"
        if entry.when_to_use:
            line += f"\n  when_to_use: {entry.when_to_use}"
        if entry.version:
            line += f"\n  version: {entry.version}"
        lines.append(line)
    return "\n".join(lines)
