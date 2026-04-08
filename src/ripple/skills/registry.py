"""Bundled Skills Registry

内置技能注册表，用于注册和管理编译到 Ripple 中的技能。
"""

from typing import Dict

from ripple.skills.types import Skill

# 全局注册表：存储所有 bundled skills
_bundled_skills: Dict[str, Skill] = {}


def register_bundled_skill(
    name: str,
    description: str,
    content: str,
    allowed_tools: list[str] | None = None,
    arguments: list[str] | None = None,
    context: str = "inline",
    hooks: dict | None = None,
    model: str | None = None,
    effort: int | None = None,
    when_to_use: str | None = None,
    version: str | None = None,
) -> None:
    """注册一个 bundled skill

    Args:
        name: 技能名称
        description: 技能描述
        content: 技能内容（Markdown 格式）
        allowed_tools: 允许的工具列表，["__all__"] 表示所有工具
        arguments: 参数名称列表
        context: 执行上下文（inline 或 fork）
        hooks: Hook 配置
        model: 模型覆盖
        effort: Effort 级别
        when_to_use: 使用场景说明
        version: 版本号
    """
    skill = Skill(
        name=name,
        description=description,
        content=content,
        file_path=f"<bundled:{name}>",  # 标记为 bundled skill
        allowed_tools=allowed_tools or [],
        arguments=arguments or [],
        context=context,
        hooks=hooks or {},
        model=model,
        effort=effort,
        when_to_use=when_to_use,
        version=version,
    )

    _bundled_skills[name] = skill


def get_bundled_skills() -> Dict[str, Skill]:
    """获取所有 bundled skills

    Returns:
        Skill 字典（name -> Skill）
    """
    return _bundled_skills.copy()


def clear_bundled_skills() -> None:
    """清空 bundled skills 注册表（用于测试）"""
    _bundled_skills.clear()
