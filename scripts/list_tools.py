"""列出所有可用的工具和技能

用于调试和验证系统配置。
"""

from ripple.skills.loader import get_global_loader
from ripple.tools.builtin.bash import BashTool
from ripple.tools.builtin.read import ReadTool
from ripple.tools.builtin.write import WriteTool


def list_skills():
    """列出所有可用的 skills"""
    print("=" * 60)
    print("Available Skills")
    print("=" * 60)

    loader = get_global_loader()
    skills = loader.list_skills()

    # 分类统计
    bundled = [s for s in skills if s.file_path.startswith("<bundled:")]
    file_based = [s for s in skills if not s.file_path.startswith("<bundled:")]

    print(f"\nTotal: {len(skills)} skills")
    print(f"  - Bundled: {len(bundled)}")
    print(f"  - File-based: {len(file_based)}")

    # 列出 bundled skills
    if bundled:
        print("\n" + "-" * 60)
        print("Bundled Skills:")
        print("-" * 60)
        for skill in bundled:
            print(f"\n/{skill.name}")
            print(f"  Description: {skill.description}")
            print(f"  Context: {skill.context}")
            print(f"  Allowed Tools: {skill.allowed_tools if skill.allowed_tools else 'all'}")

    # 列出前 5 个文件 skills
    if file_based:
        print("\n" + "-" * 60)
        print(f"File-based Skills (showing first 5 of {len(file_based)}):")
        print("-" * 60)
        for skill in file_based[:5]:
            print(f"\n/{skill.name}")
            print(f"  Description: {skill.description[:80]}...")
            print(f"  File: {skill.file_path}")
            print(f"  Context: {skill.context}")


def list_tools():
    """列出所有可用的工具"""
    print("\n" + "=" * 60)
    print("Available Tools")
    print("=" * 60)

    tools = [
        ("Bash", "Execute shell commands"),
        ("Read", "Read files from filesystem"),
        ("Write", "Write files to filesystem"),
        ("Skill", "Execute user-defined skills"),
        ("Agent", "Launch sub-agents for complex tasks"),
    ]

    for name, desc in tools:
        print(f"\n{name}")
        print(f"  {desc}")


if __name__ == "__main__":
    list_skills()
    list_tools()
    print("\n" + "=" * 60)
