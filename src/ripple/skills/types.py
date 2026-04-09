"""Skill 数据模型

定义 Skill 的数据结构。
"""

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Skill:
    """Skill 定义

    从 Markdown 文件加载的 Skill。
    """

    name: str
    description: str
    content: str
    file_path: str

    allowed_tools: list[str] = field(default_factory=list)
    arguments: list[str] = field(default_factory=list)
    context: str = "inline"
    hooks: dict[str, Any] = field(default_factory=dict)
    model: str | None = None
    effort: int | None = None
    when_to_use: str | None = None
    version: str | None = None

    @property
    def is_all_tools_allowed(self) -> bool:
        """是否允许使用所有工具"""
        return "__all__" in self.allowed_tools

    def substitute_arguments(self, args: str) -> str:
        """替换内容中的参数占位符"""
        from pathlib import Path

        content = self.content

        if not self.file_path.startswith("<bundled:"):
            skill_dir = Path(self.file_path).parent
            content = content.replace("$SKILL_BASE_DIR", str(skill_dir))

        content = content.replace("$ARGUMENTS", args)

        if self.arguments:
            arg_values = args.split() if args else []
            for i, arg_name in enumerate(self.arguments):
                placeholder = f"${arg_name.upper()}"
                value = arg_values[i] if i < len(arg_values) else ""
                content = content.replace(placeholder, value)

        return content
