"""Skill 加载器

从目录加载 Skill 定义，并合并 bundled skills。

只有满足以下条件之一的 .md 文件才会被加载为 Skill：
1. 文件名为 SKILL.md（推荐的入口文件命名）
2. 文件包含有效的 YAML frontmatter 且含有 name 或 description 字段
"""

from pathlib import Path

import frontmatter

from ripple.skills.registry import get_bundled_skills
from ripple.skills.types import Skill
from ripple.utils.logger import get_logger

logger = get_logger("skills.loader")

SKILL_ENTRY_FILENAME = "SKILL.md"


class SkillLoader:
    """Skill 加载器

    从 Markdown 文件加载 Skill 定义。
    """

    def __init__(self, skill_dirs: list[str] | None = None):
        """初始化加载器

        Args:
            skill_dirs: Skill 目录列表，默认为 ["skills"]
        """
        if skill_dirs is None:
            skill_dirs = ["skills"]
        self.skill_dirs = [Path(d).expanduser() for d in skill_dirs]
        self._skills: dict[str, Skill] = {}

    def load_all(self) -> dict[str, Skill]:
        """加载所有 Skill

        加载顺序：
        1. Bundled skills（内置技能）
        2. 文件系统 skills（用户技能）

        后加载的覆盖先加载的（文件系统 skills 可以覆盖 bundled skills）

        Returns:
            Skill 字典（name -> Skill）
        """
        self._skills.clear()

        bundled_skills = get_bundled_skills()
        self._skills.update(bundled_skills)

        for skill_dir in self.skill_dirs:
            if not skill_dir.exists():
                continue

            for skill_file in skill_dir.rglob("*.md"):
                try:
                    skill = self._load_skill_file(skill_file)
                    if skill:
                        self._skills[skill.name] = skill
                except Exception as e:
                    logger.warning("跳过无法加载的 Skill 文件 {}: {}", skill_file, e)
                    continue

        return self._skills

    def get_skill(self, name: str) -> Skill | None:
        """获取 Skill"""
        return self._skills.get(name)

    def list_skills(self) -> list[Skill]:
        """列出所有 Skill"""
        return list(self._skills.values())

    def _load_skill_file(self, file_path: Path) -> Skill | None:
        """从文件加载 Skill

        只加载满足条件的文件：
        - 文件名为 SKILL.md
        - 或含有效 frontmatter（有 name 或 description 字段）

        非入口 .md 文件（如 README.md、references 文档）会被跳过。
        """
        with open(file_path, encoding="utf-8") as f:
            post = frontmatter.load(f)

        metadata = post.metadata
        content = post.content

        is_entry_file = file_path.name == SKILL_ENTRY_FILENAME
        has_skill_metadata = bool(metadata.get("name") or metadata.get("description"))

        if not is_entry_file and not has_skill_metadata:
            return None

        name = metadata.get("name", file_path.stem)

        return Skill(
            name=name,
            description=metadata.get("description", ""),
            content=content,
            file_path=str(file_path),
            allowed_tools=self._parse_allowed_tools(metadata.get("allowed-tools", [])),
            arguments=metadata.get("arguments", []),
            context=metadata.get("context", "inline"),
            hooks=metadata.get("hooks", {}),
            model=metadata.get("model"),
            effort=metadata.get("effort"),
            when_to_use=metadata.get("when-to-use") or metadata.get("when_to_use"),
            version=metadata.get("version"),
        )

    def _parse_allowed_tools(self, allowed_tools: list[str] | str) -> list[str]:
        """解析 allowed-tools 字段"""
        if isinstance(allowed_tools, str):
            if allowed_tools.lower() == "all":
                return ["__all__"]
            return [allowed_tools]
        elif isinstance(allowed_tools, list):
            return allowed_tools
        else:
            return []


_global_loader: SkillLoader | None = None


def get_global_loader() -> SkillLoader:
    """获取全局 Skill 加载器

    首次调用时会注册所有 bundled skills 并加载所有 skills。
    """
    global _global_loader
    if _global_loader is None:
        from ripple.skills.bundled import register_all_bundled_skills

        register_all_bundled_skills()

        _global_loader = SkillLoader()
        _global_loader.load_all()
    return _global_loader


def reload_skills():
    """重新加载所有 Skill"""
    global _global_loader
    if _global_loader:
        _global_loader.load_all()
