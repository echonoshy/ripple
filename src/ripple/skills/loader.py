"""Skill 加载器

从目录加载 Skill 定义，并合并 bundled skills。
"""

from pathlib import Path
from typing import Dict, List

import frontmatter

from ripple.skills.registry import get_bundled_skills
from ripple.skills.types import Skill


class SkillLoader:
    """Skill 加载器

    从 Markdown 文件加载 Skill 定义。
    """

    def __init__(self, skill_dirs: List[str] | None = None):
        """初始化加载器

        Args:
            skill_dirs: Skill 目录列表，默认为 ["skills"]
        """
        if skill_dirs is None:
            skill_dirs = [
                "skills",
            ]
        self.skill_dirs = [Path(d).expanduser() for d in skill_dirs]
        self._skills: Dict[str, Skill] = {}

    def load_all(self) -> Dict[str, Skill]:
        """加载所有 Skill

        加载顺序：
        1. Bundled skills（内置技能）
        2. 文件系统 skills（用户技能）

        后加载的覆盖先加载的（文件系统 skills 可以覆盖 bundled skills）

        Returns:
            Skill 字典（name -> Skill）
        """
        self._skills.clear()

        # 1. 加载 bundled skills
        bundled_skills = get_bundled_skills()
        self._skills.update(bundled_skills)

        # 2. 加载文件系统 skills
        for skill_dir in self.skill_dirs:
            if not skill_dir.exists():
                continue

            # 递归查找所有 .md 文件
            for skill_file in skill_dir.rglob("*.md"):
                try:
                    skill = self._load_skill_file(skill_file)
                    if skill:
                        # 去重：后加载的覆盖先加载的
                        self._skills[skill.name] = skill
                except Exception as e:
                    # 加载失败，跳过
                    print(f"Warning: Failed to load skill from {skill_file}: {e}")
                    continue

        return self._skills

    def get_skill(self, name: str) -> Skill | None:
        """获取 Skill

        Args:
            name: Skill 名称

        Returns:
            Skill 对象或 None
        """
        return self._skills.get(name)

    def list_skills(self) -> List[Skill]:
        """列出所有 Skill

        Returns:
            Skill 列表
        """
        return list(self._skills.values())

    def _load_skill_file(self, file_path: Path) -> Skill | None:
        """从文件加载 Skill

        Args:
            file_path: Skill 文件路径

        Returns:
            Skill 对象或 None
        """
        with open(file_path, "r", encoding="utf-8") as f:
            post = frontmatter.load(f)

        # 解析 frontmatter
        metadata = post.metadata
        content = post.content

        # 获取 Skill 名称（优先使用 frontmatter 中的 name，否则使用文件名）
        name = metadata.get("name", file_path.stem)

        # 创建 Skill 对象
        skill = Skill(
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

        return skill

    def _parse_allowed_tools(self, allowed_tools: list[str] | str) -> list[str]:
        """解析 allowed-tools 字段

        支持两种模式：
        - all: 允许使用所有工具，返回 ["__all__"]
        - allow_list: 指定工具列表，如 ["Bash", "Read"]

        Args:
            allowed_tools: allowed-tools 配置

        Returns:
            工具名称列表，["__all__"] 表示所有工具
        """
        if isinstance(allowed_tools, str):
            if allowed_tools.lower() == "all":
                return ["__all__"]
            return [allowed_tools]
        elif isinstance(allowed_tools, list):
            return allowed_tools
        else:
            return []


# 全局 Skill 加载器实例
_global_loader: SkillLoader | None = None


def get_global_loader() -> SkillLoader:
    """获取全局 Skill 加载器

    首次调用时会注册所有 bundled skills 并加载所有 skills。

    Returns:
        全局加载器实例
    """
    global _global_loader
    if _global_loader is None:
        # 注册所有 bundled skills
        from ripple.skills.bundled import register_all_bundled_skills

        register_all_bundled_skills()

        # 创建加载器并加载所有 skills
        _global_loader = SkillLoader()
        _global_loader.load_all()
    return _global_loader


def reload_skills():
    """重新加载所有 Skill"""
    global _global_loader
    if _global_loader:
        _global_loader.load_all()
