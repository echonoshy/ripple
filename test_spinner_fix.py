"""测试 spinner 暂停/恢复功能"""

import asyncio
from pathlib import Path

from rich.console import Console

from ripple.core.context import ToolOptions, ToolUseContext
from ripple.permissions.levels import PermissionMode
from ripple.permissions.manager import PermissionManager
from ripple.tools.builtin.bash import BashTool

console = Console()


async def test_spinner_pause():
    """测试权限询问时 spinner 是否正确暂停"""
    # 创建工具
    bash = BashTool()

    # 创建权限管理器
    permission_manager = PermissionManager(mode=PermissionMode.SMART)

    # 创建上下文（带 spinner 控制回调）
    spinner_paused = False
    spinner_resumed = False

    def pause_spinner():
        nonlocal spinner_paused
        spinner_paused = True
        console.print("[yellow]✓ Spinner 已暂停[/yellow]")

    def resume_spinner():
        nonlocal spinner_resumed
        spinner_resumed = True
        console.print("[yellow]✓ Spinner 已恢复[/yellow]")

    context = ToolUseContext(
        options=ToolOptions(tools=[bash]),
        session_id="test",
        cwd=str(Path.cwd()),
        permission_manager=permission_manager,
        on_pause_spinner=pause_spinner,
        on_resume_spinner=resume_spinner,
    )

    # 测试危险命令（会触发权限询问）
    console.print("\n[bold cyan]测试场景：执行危险命令 'rm -rf /tmp/test'[/bold cyan]")
    console.print("[dim]这会触发权限询问，spinner 应该暂停[/dim]\n")

    # 模拟权限检查
    allowed, reason = await permission_manager.check_permission(
        bash, {"command": "rm -rf /tmp/test"}, context
    )

    # 验证结果
    console.print(f"\n[bold]测试结果:[/bold]")
    console.print(f"  Spinner 暂停: {spinner_paused}")
    console.print(f"  Spinner 恢复: {spinner_resumed}")
    console.print(f"  权限结果: {'允许' if allowed else '拒绝'}")

    if spinner_paused and spinner_resumed:
        console.print("\n[bold green]✓ 测试通过！Spinner 控制正常工作[/bold green]")
    else:
        console.print("\n[bold red]✗ 测试失败！Spinner 控制未正常工作[/bold red]")


if __name__ == "__main__":
    asyncio.run(test_spinner_pause())
