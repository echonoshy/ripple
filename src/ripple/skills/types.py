"""Skill 数据模型

定义 Skill 的数据结构。
"""

from dataclasses import dataclass
from typing import Any, Dict, List, Optional


@dataclass
class Skill:
    """Skill 定义

    从 Markdown 文件加载的 Skill。
    """

    name: str
    description: str
    content: str  # Markdown 内容（不含 frontmatter）
    file_path: str  # 源文件路径

    # Frontmatter 字段
    allowed_tools: List[str] = None  # 允许的工具列表，["__all__"] 表示所有工具
    arguments: List[str] = None  # 参数名称列表
    context: str = "inline"  # 执行上下文：inline 或 fork
    hooks: Dict[str, Any] = None  # Hook 配置
    model: Optional[str] = None  # 模型覆盖
    effort: Optional[int] = None  # Effort 级别
    when_to_use: Optional[str] = None  # 使用场景说明
    version: Optional[str] = None  # 版本号

    def __post_init__(self):
        """初始化默认值"""
        if self.allowed_tools is None:
            self.allowed_tools = []
        if self.arguments is None:
            self.arguments = []
        if self.hooks is None:
            self.hooks = {}

    @property
    def is_all_tools_allowed(self) -> bool:
        """是否允许使用所有工具"""
        return "__all__" in self.allowed_tools

    def substitute_arguments(self, args: str) -> str:
        """替换内容中的参数占位符

        Args:
            args: 参数字符串

        Returns:
            替换后的内容
        """
        from pathlib import Path

        content = self.content

        # 替换 $SKILL_BASE_DIR（skill 文件所在目录）
        if not self.file_path.startswith("<bundled:"):
            skill_dir = Path(self.file_path).parent
            content = content.replace("$SKILL_BASE_DIR", str(skill_dir))

        # 替换 $ARGUMENTS
        content = content.replace("$ARGUMENTS", args)

        # 替换具名参数 $ARG1, $ARG2 等
        if self.arguments:
            arg_values = args.split() if args else []
            for i, arg_name in enumerate(self.arguments):
                placeholder = f"${arg_name.upper()}"
                value = arg_values[i] if i < len(arg_values) else ""
                content = content.replace(placeholder, value)

        return content
