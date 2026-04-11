"""Bundled Skills

内置技能注册模块。
"""

from ripple.skills.bundled.hello import register_hello_skill
from ripple.skills.bundled.simplify import register_simplify_skill


def register_all_bundled_skills():
    """注册所有内置技能"""
    register_hello_skill()
    register_simplify_skill()
