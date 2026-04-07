"""简单的 CLI 入口

用于测试 Ripple Agent 系统。
"""

import asyncio
from pathlib import Path

import click
from rich.console import Console
from rich.markdown import Markdown

from ripple.api.client import OpenRouterClient
from ripple.core.agent_loop import query
from ripple.core.context import ToolOptions, ToolUseContext
from ripple.skills.skill_tool import SkillTool
from ripple.tools.builtin.bash import BashTool
from ripple.tools.builtin.read import ReadTool
from ripple.tools.builtin.search import SearchTool
from ripple.tools.builtin.subagent import SubAgentTool
from ripple.tools.builtin.write import WriteTool

console = Console()


def display_subagent_execution(result_content: str):
    """显示 SubAgent 的执行日志

    Args:
        result_content: SubAgent 的输出内容
    """
    console.print("\n[bold magenta]📦 SubAgent 执行详情[/bold magenta]")
    console.print("[dim]" + "─" * 60 + "[/dim]")

    try:
        import re

        # 提取 execution_log
        match = re.search(r"execution_log=\[(.*?)\](?=,?\s*\))", result_content, re.DOTALL)
        if match:
            log_str = "[" + match.group(1) + "]"
            import ast

            execution_log = ast.literal_eval(log_str)

            for entry in execution_log:
                entry_type = entry.get("type", "")

                if entry_type == "tool_call":
                    tool_name = entry.get("tool_name", "")
                    tool_input = entry.get("tool_input", {})
                    console.print(f"\n  [cyan]🔧 SubAgent 调用: {tool_name}[/cyan]")

                    import json

                    input_str = json.dumps(tool_input, ensure_ascii=False, indent=2)
                    if len(input_str) > 150:
                        input_str = input_str[:150] + "..."
                    console.print(f"  [dim]  参数: {input_str}[/dim]")

                elif entry_type == "tool_result":
                    is_error = entry.get("is_error", False)
                    content = entry.get("content", "")

                    if is_error:
                        console.print(f"  [red]  ❌ 错误: {content}[/red]")
                    else:
                        console.print("  [green]  ✓ 成功[/green]")
                        if content:
                            console.print(f"  [dim]  结果: {content}[/dim]")

                elif entry_type == "assistant_text":
                    content = entry.get("content", "")
                    if content:
                        console.print(f"  [blue]💬 SubAgent: {content}[/blue]")

        # 提取最终结果
        result_match = re.search(r"result='(.*?)'(?=,\s*turns_used)", result_content, re.DOTALL)
        if result_match:
            final_result = result_match.group(1)
            console.print("\n[bold green]✓ SubAgent 最终结果:[/bold green]")
            console.print(f"[dim]{final_result[:300]}{'...' if len(final_result) > 300 else ''}[/dim]")

        # 提取轮数
        turns_match = re.search(r"turns_used=(\d+)", result_content)
        if turns_match:
            turns = turns_match.group(1)
            console.print(f"\n[dim]使用轮数: {turns}[/dim]")

    except Exception as e:
        console.print(f"[yellow]无法解析 SubAgent 日志: {e}[/yellow]")
        console.print(f"[dim]{result_content[:200]}...[/dim]")

    console.print("[dim]" + "─" * 60 + "[/dim]\n")


@click.group()
def main():
    """Ripple - Agent Loop CLI

    让每个提问都成为涟漪的中心，每一次循环都是向解的蔓延。
    """
    pass


@main.command()
@click.argument("prompt", required=False)
@click.option("--model", default="anthropic/claude-3.5-sonnet", help="Model to use")
@click.option("--max-turns", default=10, type=int, help="Maximum number of turns")
def run(prompt: str | None, model: str, max_turns: int):
    """运行单次查询"""
    if not prompt:
        console.print("[yellow]请输入提示词：[/yellow]")
        prompt = input("> ")

    if not prompt.strip():
        console.print("[red]提示词不能为空[/red]")
        return

    # 运行 agent loop
    asyncio.run(run_agent_once(prompt, model, max_turns))


async def run_agent_once(prompt: str, model: str, max_turns: int):
    """运行 agent loop

    Args:
        prompt: 用户提示
        model: 模型名称
        max_turns: 最大轮数
    """
    console.print("\n[bold cyan]🌊 Ripple Agent 启动[/bold cyan]")
    console.print(f"[dim]模型: {model}[/dim]")
    console.print(f"[dim]最大轮数: {max_turns}[/dim]\n")

    # 初始化工具
    tools = [
        BashTool(),
        ReadTool(),
        WriteTool(),
        SearchTool(),
        SubAgentTool(),
        SkillTool(),  # 添加 Skill Tool
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

                            # 检查是否是 SubAgent 的结果
                            try:
                                if "SubAgentOutput" in result_content or "execution_log" in result_content:
                                    if "execution_log=[" in result_content:
                                        display_subagent_execution(result_content)
                                        continue
                            except Exception:
                                pass

                            if is_error:
                                console.print(f"[red]❌ 工具错误: {result_content}[/red]")
                            else:
                                console.print("[green]✓ 工具结果[/green]")
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


@main.command()
@click.option("--model", default=None, help="模型名称")
@click.option("--max-turns", default=None, type=int, help="最大轮数")
def cli(model: str | None, max_turns: int | None):
    """启动交互式 CLI"""
    from interfaces.cli.interactive import RippleCLI

    cli_instance = RippleCLI(model=model, max_turns=max_turns)
    asyncio.run(cli_instance.run())


if __name__ == "__main__":
    main()
