"""交互式 CLI 终端

支持多轮对话和命令执行。
"""

import asyncio
import traceback
from pathlib import Path

import click
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.prompt import Prompt

from ripple.api.client import OpenRouterClient
from ripple.core.agent_loop import query
from ripple.core.context import ToolOptions, ToolUseContext
from ripple.permissions.levels import PermissionMode
from ripple.permissions.manager import PermissionManager
from ripple.skills.skill_tool import SkillTool
from ripple.tools.builtin.agent_tool import AgentTool
from ripple.tools.builtin.ask_user import AskUserTool
from ripple.tools.builtin.bash import BashTool
from ripple.tools.builtin.read import ReadTool
from ripple.tools.builtin.search import SearchTool
from ripple.tools.builtin.write import WriteTool
from ripple.utils.config import get_config
from ripple.utils.conversation_log import ConversationLogger, generate_session_id, list_conversations
from ripple.utils.logger import LOG_FILE, get_logger

logger = get_logger("cli.interactive")
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
        self.session_id = generate_session_id()

        # 会话消息历史
        self.session_messages: list = []

        # API 返回的真实 token 统计（累计）
        self.api_input_tokens: int = 0
        self.api_output_tokens: int = 0
        # 最后一次 API 调用的 input tokens（= 当前上下文大小）
        self.last_context_tokens: int = 0

        # 系统提示（包含可用 skills）
        self.system_prompt: str = ""

        # 初始化会话记录器
        self.conversation_log = ConversationLogger(session_id=self.session_id)

    def initialize(self):
        """初始化客户端和上下文"""
        # 清空会话历史（切换模型时）
        self.session_messages = []
        self.api_input_tokens = 0
        self.api_output_tokens = 0
        self.last_context_tokens = 0

        # 加载所有可用的 skills 并构建系统提示
        from datetime import datetime

        from ripple.skills.loader import get_global_loader

        loader = get_global_loader()
        skills = loader.list_skills()

        # 构建 skills 列表（所有 skills）
        skills_info = []
        for skill in skills:
            # 截断描述到 150 字符，避免过长
            desc = skill.description[:150] + "..." if len(skill.description) > 150 else skill.description
            skills_info.append(f"- {skill.name}: {desc}")

        skills_text = "\n".join(skills_info)

        workspace_dir = Path.cwd() / ".ripple" / "workspace"

        self.system_prompt = f"""Today's date is {datetime.now().strftime("%Y/%m/%d")}.

# Using Your Tools

## Agent Tool (Fork SubAgent)
Use the Agent tool to delegate complex, multi-step tasks:
- When a task requires 3+ distinct operations
- For parallel research (multiple file searches, web lookups)
- When exploring unfamiliar code areas
- For tasks that might take many turns

Example: "Use Agent tool to search for all authentication-related files and summarize the auth flow"

## AskUser Tool
Proactively ask the user when:
- Multiple valid approaches exist (e.g., "Should I use Redis or in-memory cache?")
- Requirements are ambiguous (e.g., "Which files should I modify?")
- You need user preferences (e.g., "Do you want verbose logging?")
- Before risky operations (e.g., "This will delete 10 files. Confirm?")
- When you're unsure about the user's intent

DO NOT guess or assume - ask first when uncertain.

## File Writing Rules
When the user asks to write or save content to a file without specifying an explicit path:
- Default output directory: `{workspace_dir}`
- Always use this directory for generated files (reports, summaries, notes, etc.)
- Do NOT write to the user's home directory, root directory, or any system directory
- If the user provides an explicit absolute path, respect it but warn if it's outside the workspace

# Available Skills
{skills_text}

IMPORTANT: Before declining a user request because it's outside your domain, check if there's a relevant skill available."""

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
            AskUserTool(),  # 新增 AskUser 工具
        ]

        # 创建权限管理器
        permission_manager = PermissionManager(mode=PermissionMode.SMART)

        # 创建上下文
        self.context = ToolUseContext(
            options=ToolOptions(
                tools=tools,
                model=self.model,
            ),
            session_id=self.session_id,
            cwd=Path.cwd(),
            thinking=self.thinking,
            permission_manager=permission_manager,
            on_pause_spinner=None,
            on_resume_spinner=None,
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
- `/clear` - 清空会话历史
- `/tokens` - 显示 Token 使用情况
- `/model <name>` - 切换模型（支持别名：opus / sonnet / haiku）
- `/models` - 查看可用模型列表
- `/thinking` - 开关思考模式
- `/info` - 显示当前配置
- `/log` - 显示日志文件位置
- `/history` - 查看历史会话记录
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
- Session: {self.session_id}
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
            lines.append(f"- `{alias}` → {info.get('model', '?')}{marker}")
        console.print(Panel(Markdown("\n".join(lines)), title="模型列表", border_style="blue"))

    def _get_context_tokens(self) -> int:
        """获取当前上下文 token 数：API 真实值优先，tiktoken 估算兜底"""
        if self.last_context_tokens > 0:
            return self.last_context_tokens
        from ripple.messages.cleanup import estimate_tokens

        return estimate_tokens(self.session_messages)

    def _display_token_usage(self):
        """显示 token 使用情况"""
        max_context = 200_000
        ctx = self._get_context_tokens()
        usage_percent = (ctx / max_context) * 100 if ctx else 0
        api_total = self.api_input_tokens + self.api_output_tokens

        parts = []
        if api_total > 0:
            parts.append(f"API 累计: ↑{self.api_input_tokens:,} ↓{self.api_output_tokens:,}")
        if ctx > 0:
            parts.append(f"上下文: {usage_percent:.1f}% ({ctx:,}/{max_context:,})")

        if not parts:
            return

        summary = " | ".join(parts)
        if usage_percent > 80:
            console.print(f"[yellow]⚠️  {summary}[/yellow]")
        else:
            console.print(f"[dim]{summary}[/dim]")

    def _display_subagent_execution(self, result_content: str):
        """显示 SubAgent 的执行日志

        Args:
            result_content: SubAgent 的输出内容
        """
        console.print("\n[bold magenta]📦 SubAgent 执行详情[/bold magenta]")
        console.print("[dim]" + "─" * 60 + "[/dim]")

        logger.debug("SubAgent 原始内容: {}...", result_content[:500])
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
            from rich.live import Live

            new_messages = [{"role": "user", "content": [{"type": "text", "text": prompt}]}]

            has_output = False
            tool_id_to_name: dict[str, str] = {}

            # 流式渲染状态
            streaming_text = ""
            live_display: Live | None = None
            text_streamed_this_turn = False

            self.conversation_log.log_user_message(prompt)
            logger.info("用户输入: {}", prompt[:200])

            with console.status("[bold cyan]正在思考...[/bold cyan]", spinner="dots") as status:
                self.context.on_pause_spinner = status.stop
                self.context.on_resume_spinner = status.start

                async for item in query(
                    user_input=prompt,
                    context=self.context,
                    client=self.client,
                    model=self.model,
                    max_turns=self.max_turns,
                    thinking=self.thinking,
                    history_messages=self.session_messages,
                    system_prompt=self.system_prompt,
                ):
                    if not hasattr(item, "type"):
                        continue

                    if item.type == "stream_request_start":
                        status.update("[bold cyan]正在思考...[/bold cyan]")

                    elif item.type == "stream_start":
                        status.stop()
                        streaming_text = ""
                        text_streamed_this_turn = True
                        live_display = Live(
                            Panel(Markdown("▌"), border_style="green", title="🤖 Ripple"),
                            console=console,
                            refresh_per_second=8,
                            vertical_overflow="visible",
                        )
                        live_display.start()

                    elif item.type == "stream_chunk":
                        if item.data:
                            streaming_text += item.data.get("text", "")
                        if live_display:
                            live_display.update(
                                Panel(Markdown(streaming_text + "▌"), border_style="green", title="🤖 Ripple")
                            )

                    elif item.type == "stream_end":
                        if live_display:
                            live_display.update(
                                Panel(Markdown(streaming_text), border_style="green", title="🤖 Ripple")
                            )
                            live_display.stop()
                            live_display = None

                    elif item.type == "assistant":
                        # 安全清理：如果 Live 还在运行（异常情况）
                        if live_display:
                            live_display.update(
                                Panel(Markdown(streaming_text), border_style="green", title="🤖 Ripple")
                            )
                            live_display.stop()
                            live_display = None

                        status.stop()
                        from ripple.messages.utils import _convert_assistant_message

                        new_messages.append(_convert_assistant_message(item.message.get("content", [])))

                        usage = item.message.get("usage", {})
                        if usage:
                            inp = usage.get("input_tokens", 0)
                            out = usage.get("output_tokens", 0)
                            self.api_input_tokens += inp
                            self.api_output_tokens += out
                            if inp > 0:
                                self.last_context_tokens = inp

                        content = item.message.get("content", [])
                        for block in content:
                            if isinstance(block, dict):
                                if block.get("type") == "text":
                                    text = block.get("text", "")
                                    if text.strip():
                                        has_output = True
                                        self.conversation_log.log_assistant_message(text)
                                        if not text_streamed_this_turn:
                                            console.print(
                                                Panel(Markdown(text), border_style="green", title="🤖 Ripple")
                                            )
                                elif block.get("type") == "tool_use":
                                    tool_name = block.get("name", "")
                                    tool_id = block.get("id", "")
                                    tool_input = block.get("input", {})

                                    if tool_id:
                                        tool_id_to_name[tool_id] = tool_name

                                    self.conversation_log.log_tool_call(tool_name, tool_input)

                                    import json

                                    input_str = json.dumps(tool_input, ensure_ascii=False)
                                    if len(input_str) > 100:
                                        input_str = input_str[:100] + "..."

                                    from rich.markup import escape

                                    input_str = escape(input_str)
                                    console.print(
                                        f"🔧 [bold yellow]调用工具:[/bold yellow] [cyan]{tool_name}[/cyan] [dim]{input_str}[/dim]"
                                    )

                        text_streamed_this_turn = False
                        status.start()

                    elif item.type == "user":
                        status.stop()
                        content = item.message.get("content", [])

                        if getattr(item, "is_meta", False):
                            for block in content:
                                if isinstance(block, dict) and block.get("type") == "text":
                                    error_text = block.get("text", "")
                                    if error_text:
                                        has_output = True
                                        console.print(f"\n[bold red]⚠️  {error_text}[/bold red]")
                            status.start()
                            continue

                        for blk in content:
                            if isinstance(blk, dict) and blk.get("type") == "tool_result":
                                new_messages.append(
                                    {
                                        "role": "tool",
                                        "tool_call_id": blk.get("tool_use_id", ""),
                                        "content": blk.get("content", ""),
                                    }
                                )
                        for block in content:
                            if isinstance(block, dict) and block.get("type") == "tool_result":
                                result_content = block.get("content", "")
                                is_error = block.get("is_error", False)

                                try:
                                    if "SubAgentOutput" in result_content or "execution_log" in result_content:
                                        if "execution_log=[" in result_content:
                                            self._display_subagent_execution(result_content)
                                            continue
                                except Exception:
                                    pass

                                from rich.markup import escape

                                tool_use_id = block.get("tool_use_id", "")
                                logged_tool_name = (
                                    block.get("tool_name") or tool_id_to_name.get(tool_use_id) or tool_use_id
                                )

                                if is_error:
                                    self.conversation_log.log_tool_result(
                                        logged_tool_name, result_content, is_error=True
                                    )
                                    logger.warning("工具执行出错: {}: {}", logged_tool_name, result_content[:300])
                                    err_preview = escape(result_content[:100])
                                    console.print(f"❌ [red]工具错误:[/red] [dim]{err_preview}...[/dim]")
                                else:
                                    self.conversation_log.log_tool_result(logged_tool_name, result_content)
                                    if result_content:
                                        preview = result_content[:100].replace("\n", " ") + (
                                            "..." if len(result_content) > 100 else ""
                                        )
                                        preview = escape(preview)
                                        console.print(f"✓ [green]执行成功:[/green] [dim]{preview}[/dim]")
                                    else:
                                        console.print("✓ [green]执行成功 (无输出)[/green]")
                        status.start()

            # 安全清理：确保 Live 已停止
            if live_display:
                live_display.stop()

            if not has_output:
                console.print(
                    "\n[bold yellow]⚠️  模型未返回任何内容，可能原因：[/bold yellow]\n"
                    "[yellow]  • 上下文过长，超出模型限制（尝试 /clear 清空历史）\n"
                    "  • API 调用异常\n"
                    "  • 模型返回了空响应[/yellow]"
                )

            from ripple.messages.cleanup import cleanup_tool_results, estimate_tokens, trim_old_messages

            cleaned_messages = cleanup_tool_results(new_messages)
            self.session_messages.extend(cleaned_messages)

            ctx = self.last_context_tokens or estimate_tokens(self.session_messages)
            if ctx > 150_000:
                old_count = len(self.session_messages)
                self.session_messages = trim_old_messages(self.session_messages)
                trimmed = old_count - len(self.session_messages)

                console.print(f"[yellow]⚠️  上下文接近上限 ({ctx:,} tokens)，已清理 {trimmed} 条旧消息[/yellow]")

            self._display_token_usage()

            console.print("\n[bold green]✓ 完成[/bold green]\n")

        except KeyboardInterrupt:
            if live_display:
                live_display.stop()
            console.print("\n[yellow]已中断[/yellow]\n")
        except Exception as e:
            if live_display:
                live_display.stop()
            tb = traceback.format_exc()
            logger.error("查询执行失败: {}\n{}", e, tb)
            self.conversation_log.log_error(str(e), tb)
            console.print(f"\n[red]错误: {e}[/red]")
            console.print(f"[dim]详细日志: {LOG_FILE}[/dim]\n")

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
            self.session_messages = []
            self.api_input_tokens = 0
            self.api_output_tokens = 0
            self.last_context_tokens = 0
            console.clear()
            console.print("[green]会话历史已清空[/green]")

        elif cmd == "/tokens":
            max_context = 200_000
            ctx = self._get_context_tokens()
            usage_percent = (ctx / max_context) * 100 if ctx else 0
            api_total = self.api_input_tokens + self.api_output_tokens
            info = f"""
**Token 使用情况:**
- 当前上下文: {ctx:,} / {max_context:,} tokens ({usage_percent:.1f}%)
- API 累计: ↑ input {self.api_input_tokens:,} + ↓ output {self.api_output_tokens:,} = {api_total:,} tokens
- 消息数: {len(self.session_messages)}
            """
            console.print(Panel(Markdown(info), title="Token 统计", border_style="blue"))

        elif cmd == "/info":
            self.print_info()

        elif cmd.startswith("/model "):
            new_model = user_input[7:].strip()
            if new_model:
                config = get_config()
                self.model_alias = new_model
                self.model = config.resolve_model(new_model)
                console.print(f"[green]已切换到模型: {self.model_alias} ({self.model})[/green]")
                # 重新初始化上下文（生成新 session ID）
                self.session_id = generate_session_id()
                self.initialize()
            else:
                console.print("[red]请指定模型名称[/red]")

        elif cmd == "/models":
            self.print_models()

        elif cmd == "/thinking":
            self.thinking = not self.thinking
            if self.context:
                self.context.thinking = self.thinking
            status = "开启" if self.thinking else "关闭"
            console.print(f"[green]思考模式已{status}[/green]")

        elif cmd == "/log":
            from ripple.utils.conversation_log import CONVERSATION_DIR

            log_info = f"""
**日志文件:**
- 运行日志: `{LOG_FILE}`
- 会话记录目录: `{CONVERSATION_DIR}`
- 当前会话: `{self.conversation_log.filepath}`
            """
            console.print(Panel(Markdown(log_info), title="日志信息", border_style="blue"))

        elif cmd == "/history":
            from ripple.utils.conversation_log import CONVERSATION_DIR

            conversations = list_conversations(limit=10)
            if not conversations:
                console.print("[yellow]暂无历史会话记录[/yellow]")
            else:
                lines = ["**最近会话记录:**\n"]
                for conv in conversations:
                    lines.append(f"- `{conv['file']}` ({conv['start_time'][:19]}, {conv['messages']} 条消息)")
                lines.append(f"\n会话目录: `{CONVERSATION_DIR}`")
                console.print(Panel(Markdown("\n".join(lines)), title="历史记录", border_style="blue"))

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

        try:
            from prompt_toolkit import PromptSession
            from prompt_toolkit.formatted_text import HTML
            from prompt_toolkit.history import InMemoryHistory

            session = PromptSession(history=InMemoryHistory())
        except ImportError:
            session = None

        while True:
            try:
                # 获取用户输入
                if session:
                    user_input = await session.prompt_async(HTML("<b><ansicyan>ripple></ansicyan></b> "))
                else:
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

        self.conversation_log.log_session_end()
        logger.info("CLI 会话结束")


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
