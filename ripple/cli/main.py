"""简单的 CLI 入口

用于测试 Ripple Agent 系统。
"""

import asyncio
import os
from pathlib import Path

import click
from rich.console import Console
from rich.markdown import Markdown

from ripple.api.client import OpenRouterClient
from ripple.core.agent_loop import query
from ripple.core.context import ToolOptions, ToolUseContext
from ripple.messages.types import Message
from ripple.tools.builtin.bash import BashTool
from ripple.tools.builtin.read import ReadTool
from ripple.tools.builtin.write import WriteTool

console = Console()


@click.command()
@click.argument("prompt", required=False)
@click.option("--model", default="anthropic/claude-3.5-sonnet", help="Model to use")
@click.option("--max-turns", default=10, type=int, help="Maximum number of turns")
def cli(prompt: str | None, model: str, max_turns: int):
    """Ripple - Agent Loop CLI

    让每个提问都成为涟漪的中心，每一次循环都是向解的蔓延。
    """
    if not prompt:
        console.print("[yellow]请输入提示词：[/yellow]")
        prompt = input("> ")

    if not prompt.strip():
        console.print("[red]提示词不能为空[/red]")
        return

    # 运行 agent loop
    asyncio.run(run_agent(prompt, model, max_turns))


async def run_agent(prompt: str, model: str, max_turns: int):
    """运行 agent loop

    Args:
        prompt: 用户提示
        model: 模型名称
        max_turns: 最大轮数
    """
    console.print(f"\n[bold cyan]🌊 Ripple Agent 启动[/bold cyan]")
    console.print(f"[dim]模型: {model}[/dim]")
    console.print(f"[dim]最大轮数: {max_turns}[/dim]\n")

    # 初始化工具
    tools = [
        BashTool(),
        ReadTool(),
        WriteTool(),
    ]

    # 创建上下文
    context = ToolUseContext(
        options=ToolOptions(
            tools=tools,
            model=model,
        ),
        session_id="cli-session",
        cwd=str(Path.cwd()),
    )

    # 创建客户端
    try:
        client = OpenRouterClient()
    except ValueError as e:
        console.print(f"[red]错误: {e}[/red]")
        console.print("[yellow]请设置 OPENROUTER_API_KEY 环境变量[/yellow]")
        return

    # 执行查询
    try:
        async for item in query(
            user_input=prompt,
            context=context,
            client=client,
            model=model,
            max_turns=max_turns,
        ):
            # 处理不同类型的消息
            if hasattr(item, "type"):
                if item.type == "assistant":
                    # 助手消息
                    content = item.message.get("content", [])
                    for block in content:
                        if isinstance(block, dict):
                            if block.get("type") == "text":
                                text = block.get("text", "")
                                if text.strip():
                                    console.print(Markdown(text))
                            elif block.get("type") == "tool_use":
                                tool_name = block.get("name", "")
                                console.print(f"\n[yellow]🔧 调用工具: {tool_name}[/yellow]")

                elif item.type == "user":
                    # 工具结果
                    content = item.message.get("content", [])
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "tool_result":
                            result_content = block.get("content", "")
                            is_error = block.get("is_error", False)
                            if is_error:
                                console.print(f"[red]❌ 工具错误: {result_content}[/red]")
                            else:
                                console.print(f"[green]✓ 工具结果[/green]")
                                # 只显示前 500 字符
                                if len(result_content) > 500:
                                    console.print(f"[dim]{result_content[:500]}...[/dim]")
                                else:
                                    console.print(f"[dim]{result_content}[/dim]")

                elif item.type == "stream_request_start":
                    console.print("\n[dim]正在思考...[/dim]")

        console.print("\n[bold green]✓ 任务完成[/bold green]")

    except KeyboardInterrupt:
        console.print("\n[yellow]用户中断[/yellow]")
    except Exception as e:
        console.print(f"\n[red]错误: {e}[/red]")
        import traceback

        console.print(f"[dim]{traceback.format_exc()}[/dim]")


if __name__ == "__main__":
    cli()
