"""工具和 Skills 统计

列出所有可用的内置工具和用户定义的 Skills。
"""

from pathlib import Path

from rich.console import Console
from rich.table import Table

from ripple.skills.loader import SkillLoader

console = Console()


def list_builtin_tools():
    """列出内置工具"""
    tools = [
        {
            "name": "Bash",
            "description": "执行 shell 命令",
            "file": "ripple/tools/builtin/bash.py",
        },
        {
            "name": "Read",
            "description": "读取文件内容（支持分页）",
            "file": "ripple/tools/builtin/read.py",
        },
        {
            "name": "Write",
            "description": "写入文件内容",
            "file": "ripple/tools/builtin/write.py",
        },
        {
            "name": "Search",
            "description": "使用 DuckDuckGo 搜索网络",
            "file": "ripple/tools/builtin/search.py",
        },
        {
            "name": "Skill",
            "description": "执行用户定义的 Skill",
            "file": "ripple/skills/skill_tool.py",
        },
    ]

    table = Table(title="内置工具", show_header=True, header_style="bold cyan")
    table.add_column("工具名称", style="green")
    table.add_column("描述", style="white")
    table.add_column("文件路径", style="dim")

    for tool in tools:
        table.add_row(tool["name"], tool["description"], tool["file"])

    console.print(table)
    console.print(f"\n[bold]总计: {len(tools)} 个内置工具[/bold]\n")


def list_skills():
    """列出用户定义的 Skills"""
    # 查找 skills 目录
    skills_dir = Path.cwd() / "skills"

    if not skills_dir.exists():
        console.print("[yellow]未找到 skills 目录[/yellow]\n")
        return

    # 加载 skills
    loader = SkillLoader([str(skills_dir)])
    loader.load_all()
    skills = loader.list_skills()

    if not skills:
        console.print("[yellow]未找到任何 Skill[/yellow]\n")
        return

    table = Table(title="用户定义的 Skills", show_header=True, header_style="bold magenta")
    table.add_column("Skill 名称", style="green")
    table.add_column("描述", style="white")
    table.add_column("参数", style="cyan")

    for skill in skills:
        args = ", ".join(skill.arguments) if skill.arguments else "无"
        table.add_row(skill.name, skill.description, args)

    console.print(table)
    console.print(f"\n[bold]总计: {len(skills)} 个 Skills[/bold]\n")


def main():
    """主函数"""
    console.print("\n[bold cyan]🌊 Ripple 工具统计[/bold cyan]\n")

    # 列出内置工具
    list_builtin_tools()

    # 列出 Skills
    list_skills()

    console.print("[dim]提示: 可以在 skills/ 目录下创建更多 Skill[/dim]\n")


if __name__ == "__main__":
    main()
