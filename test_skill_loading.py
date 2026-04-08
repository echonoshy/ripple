#!/usr/bin/env python3
"""测试 Skill 加载"""

from ripple.skills.loader import get_global_loader

# 获取全局加载器
loader = get_global_loader()

# 列出所有 skills
skills = loader.list_skills()

print(f"总共加载了 {len(skills)} 个 skills:\n")

for skill in skills:
    print(f"- {skill.name}")
    print(f"  描述: {skill.description[:80]}...")
    print(f"  文件: {skill.file_path}")
    print(f"  上下文: {skill.context}")
    print()

# 检查 etf-assistant 是否存在
etf_skill = loader.get_skill("etf-assistant")
if etf_skill:
    print("✓ etf-assistant skill 已加载")
    print(f"  完整描述: {etf_skill.description}")
else:
    print("✗ etf-assistant skill 未找到")
