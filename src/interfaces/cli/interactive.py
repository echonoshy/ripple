"""交互式 CLI 终端

支持多轮对话和命令执行。
"""

import asyncio
from pathlib import Path

import click
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.prompt import Prompt

from ripple.api.client import OpenRouterClient
from ripple.core.agent_loop import query
from ripple.core.context import ToolOptions, ToolUseContext
from ripple.skills.skill_tool import SkillTool
from ripple.tools.builtin.agent_tool import AgentTool
from ripple.tools.builtin.bash import BashTool
from ripple.tools.builtin.read import ReadTool
from ripple.tools.builtin.search import SearchTool
from ripple.tools.builtin.write import WriteTool
from ripple.utils.config import get_config

console = Console()


class RippleCLI:
    """Ripple 交互式终端"""

    def __init__(self, model: str | None = None, max_turns: int | None = None):
        """初始化 CLI

        Args:
            model: 模型名称或预设别名
            max_turns: 最大轮数
        """
        config = get_config()
        raw_model = model or config.get("model.default", "anthropic/claude-3.5-sonnet")
        self.model_alias = raw_model
        self.model = config.resolve_model(raw_model)
        self.max_turns = max_turns or config.get("agent.max_turns", 10)
        self.thinking = config.get("model.thinking.enabled", False)
        self.client: OpenRouterClient | None = None
        self.context: ToolUseContext | None = None
        self.session_count = 0

    def initialize(self):
        """初始化客户端和上下文"""
        # 消息历史（用于 AgentTool 的 fork 模式）
        messages = []

        # 初始化工具
        tools = [
            BashTool(),
            ReadTool(),
            WriteTool(),
            SearchTool(),
            AgentTool(messages=messages),  # 传入消息历史以支持 fork 模式
            SkillTool(),
        ]

        # 创建上下文
        self.context = ToolUseContext(
            options=ToolOptions(
                tools=tools,
                model=self.model,
            ),
            session_id=f"cli-session-{self.session_count}",
            cwd=str(Path.cwd()),
        )

        # 创建客户端
        try:
            self.client = OpenRouterClient()
        except ValueError as e:
            console.print(f"[red]错误: {e}[/red]")
            raise

    def print_welcome(self):
        """打印欢迎信息"""
        welcome_text = """
# 🌊 Ripple Agent CLI

让每个提问都成为涟漪的中心，每一次循环都是向解的蔓延。

**命令:**
- `/help` - 显示帮助
- `/clear` - 清空屏幕
- `/model <name>` - 切换模型（支持别名：opus / sonnet / haiku）
- `/models` - 查看可用模型列表
- `/thinking` - 开关思考模式
- `/info` - 显示当前配置
- `/exit` 或 `/quit` - 退出

**使用方法:**
直接输入你的问题或任务，Agent 会自动调用工具完成任务。
        """
        console.print(Panel(Markdown(welcome_text), border_style="cyan"))

    def print_info(self):
        """打印当前配置信息"""
        thinking_status = "开启" if self.thinking else "关闭"
        display_model = f"{self.model_alias} ({self.model})" if self.model_alias != self.model else self.model
        info = f"""
**当前配置:**
- 模型: {display_model}
- 思考模式: {thinking_status}
- 最大轮数: {self.max_turns}
- 工作目录: {Path.cwd()}
- Session: {self.session_count}
        """
        console.print(Panel(Markdown(info), title="配置信息", border_style="blue"))

    def print_models(self):
        """打印可用模型列表"""
        config = get_config()
        presets = config.get_model_presets()
        if not presets:
            console.print("[yellow]未配置模型预设，请在 config/settings.yaml 中添加 model.presets[/yellow]")
            return
        lines = ["**可用模型:**\n"]
        for alias, info in presets.items():
            marker = " ← 当前" if alias == self.model_alias or info.get("model") == self.model else ""
            lines.append(f"- `{alias}` → {info.get('model', '?')}  {info.get('description', '')}{marker}")
        console.print(Panel(Markdown("\n".join(lines)), title="模型列表", border_style="blue"))

    def _display_subagent_execution(self, result_content: str):
        """显示 SubAgent 的执行日志

        Args:
            result_content: SubAgent 的输出内容
        """
        console.print("\n[bold magenta]📦 SubAgent 执行详情[/bold magenta]")
        console.print("[dim]" + "─" * 60 + "[/dim]")

        # 调试：显示原始内容的前500字符
        console.print(f"[yellow]DEBUG 原始内容: {result_content[:500]}...[/yellow]")

        # 尝试解析 execution_log
        try:
            import re

            # 提取 execution_log - 改进正则表达式
            match = re.search(r"execution_log=\[(.*?)\]\s*(?:,\s*\)|$)", result_content, re.DOTALL)
            if match:
                log_str = "[" + match.group(1) + "]"
                # 简单解析
                import ast

                execution_log = ast.literal_eval(log_str)

                for entry in execution_log:
                    entry_type = entry.get("type", "")

                    if entry_type == "tool_call":
                        tool_name = entry.get("tool_name", "")
                        tool_input = entry.get("tool_input", {})
                        console.print(f"\n  [cyan]🔧 SubAgent 调用: {tool_name}[/cyan]")

                        # 显示输入参数
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

    async def execute_query(self, prompt: str):
        """执行查询

        Args:
            prompt: 用户输入
        """
        if not self.client or not self.context:
            console.print("[red]客户端未初始化[/red]")
            return

        try:
            with console.status("[bold cyan]正在思考...[/bold cyan]", spinner="dots") as status:
                async for item in query(
                    user_input=prompt,
                    context=self.context,
                    client=self.client,
                    model=self.model,
                    max_turns=self.max_turns,
                    thinking=self.thinking,
                ):
                    if hasattr(item, "type"):
                        if item.type == "stream_request_start":
                            status.update("[bold cyan]正在思考...[/bold cyan]")
                        elif item.type == "assistant":
                            # 助手消息
                            status.stop()
                            content = item.message.get("content", [])
                            for block in content:
                                if isinstance(block, dict):
                                    if block.get("type") == "text":
                                        text = block.get("text", "")
                                        if text.strip():
                                            console.print(
                                                Panel(Markdown(text), border_style="green", title="🤖 Ripple")
                                            )
                                    elif block.get("type") == "tool_use":
                                        tool_name = block.get("name", "")
                                        tool_input = block.get("input", {})

                                        # 显示工具输入参数
                                        import json

                                        input_str = json.dumps(tool_input, ensure_ascii=False, indent=2)
                                        if len(input_str) > 200:
                                            input_str = input_str[:200] + "\n..."

                                        console.print(
                                            Panel(
                                                f"[cyan]参数:[/cyan]\n{input_str}",
                                                title=f"🔧 调用工具: [bold yellow]{tool_name}[/bold yellow]",
                                                border_style="yellow",
                                            )
                                        )
                            status.start()

                        elif item.type == "user":
                            # 工具结果
                            status.stop()
                            content = item.message.get("content", [])
                            for block in content:
                                if isinstance(block, dict) and block.get("type") == "tool_result":
                                    result_content = block.get("content", "")
                                    is_error = block.get("is_error", False)

                                    # 检查是否是 SubAgent 的结果
                                    try:
                                        if "SubAgentOutput" in result_content or "execution_log" in result_content:
                                            if "execution_log=[" in result_content:
                                                self._display_subagent_execution(result_content)
                                                continue
                                    except Exception:
                                        pass

                                    if is_error:
                                        console.print(
                                            Panel(
                                                f"[red]{result_content}[/red]", title="❌ 工具错误", border_style="red"
                                            )
                                        )
                                    else:
                                        # 显示工具结果（截断长输出）
                                        preview = ""
                                        if result_content:
                                            if "stdout=" in result_content:
                                                try:
                                                    import re

                                                    match = re.search(r"stdout='([^']*)'", result_content)
                                                    if match:
                                                        stdout_str = match.group(1)
                                                        stdout_str = stdout_str.encode().decode("unicode_escape")
                                                        lines = stdout_str.split("\n")[:10]
                                                        preview = "\n".join(lines)
                                                        if len(stdout_str.split("\n")) > 10:
                                                            preview += "\n..."
                                                    else:
                                                        preview = result_content[:300] + (
                                                            "..." if len(result_content) > 300 else ""
                                                        )
                                                except Exception:
                                                    preview = result_content[:300] + (
                                                        "..." if len(result_content) > 300 else ""
                                                    )
                                            else:
                                                preview = result_content[:300] + (
                                                    "..." if len(result_content) > 300 else ""
                                                )

                                        if preview:
                                            console.print(
                                                Panel(
                                                    f"[dim]{preview}[/dim]",
                                                    title="✓ 工具执行成功",
                                                    border_style="green",
                                                )
                                            )
                                        else:
                                            console.print("[green]✓ 工具执行成功 (无输出)[/green]")
                            status.start()

            console.print("\n[bold green]✓ 完成[/bold green]\n")

        except KeyboardInterrupt:
            console.print("\n[yellow]已中断[/yellow]\n")
        except Exception as e:
            console.print(f"\n[red]错误: {e}[/red]\n")

    def handle_command(self, user_input: str) -> bool:
        """处理命令

        Args:
            user_input: 用户输入

        Returns:
            是否应该继续运行
        """
        cmd = user_input.strip().lower()

        if cmd in ["/exit", "/quit"]:
            console.print("[cyan]再见！[/cyan]")
            return False

        elif cmd == "/help":
            self.print_welcome()

        elif cmd == "/clear":
            console.clear()

        elif cmd == "/info":
            self.print_info()

        elif cmd.startswith("/model "):
            new_model = user_input[7:].strip()
            if new_model:
                config = get_config()
                self.model_alias = new_model
                self.model = config.resolve_model(new_model)
                console.print(f"[green]已切换到模型: {self.model_alias} ({self.model})[/green]")
                # 重新初始化上下文
                self.session_count += 1
                self.initialize()
            else:
                console.print("[red]请指定模型名称[/red]")

        elif cmd == "/models":
            self.print_models()

        elif cmd == "/thinking":
            self.thinking = not self.thinking
            status = "开启" if self.thinking else "关闭"
            console.print(f"[green]思考模式已{status}[/green]")

        else:
            console.print(f"[red]未知命令: {cmd}[/red]")
            console.print("[dim]输入 /help 查看帮助[/dim]")

        return True

    async def run(self):
        """运行 CLI"""
        self.print_welcome()

        try:
            self.initialize()
        except ValueError:
            return

        self.print_info()

        while True:
            try:
                # 获取用户输入
                user_input = Prompt.ask("\n[bold cyan]ripple>[/bold cyan]")

                if not user_input.strip():
                    continue

                # 处理命令
                if user_input.startswith("/"):
                    should_continue = self.handle_command(user_input)
                    if not should_continue:
                        break
                else:
                    # 执行查询
                    await self.execute_query(user_input)

            except KeyboardInterrupt:
                console.print("\n[yellow]使用 /exit 或 /quit 退出[/yellow]")
                continue
            except EOFError:
                console.print("\n[cyan]再见！[/cyan]")
                break


@click.command()
@click.option("--model", default=None, help="模型名称")
@click.option("--max-turns", default=None, type=int, help="最大轮数")
def cli(model: str | None, max_turns: int | None):
    """启动 Ripple 交互式终端

    让每个提问都成为涟漪的中心，每一次循环都是向解的蔓延。
    """
    cli_instance = RippleCLI(model=model, max_turns=max_turns)
    asyncio.run(cli_instance.run())


if __name__ == "__main__":
    cli()
