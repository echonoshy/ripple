"""Textual TUI 界面

类似 Claude Code 的终端图形界面。
"""

from pathlib import Path

import click
from rich.markdown import Markdown
from textual import on, work
from textual.app import App, ComposeResult
from textual.containers import Container, VerticalScroll
from textual.widgets import Footer, Header, Input, Static

from ripple.api.client import OpenRouterClient
from ripple.core.agent_loop import query
from ripple.core.context import ToolOptions, ToolUseContext
from ripple.skills.skill_tool import SkillTool
from ripple.tools.builtin.bash import BashTool
from ripple.tools.builtin.read import ReadTool
from ripple.tools.builtin.subagent import SubAgentTool
from ripple.tools.builtin.write import WriteTool
from ripple.utils.config import get_config


class MessageWidget(Static):
    """消息组件 - 统一的时间线显示"""

    def __init__(self, content: str, msg_type: str = "text", **kwargs):
        super().__init__(content, **kwargs)
        self.msg_type = msg_type
        self.add_class(f"msg-{msg_type}")


class ChatPanel(VerticalScroll):
    """聊天面板 - 单栏时间线设计"""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.can_focus = False

    def add_user_message(self, content: str):
        """添加用户消息"""
        msg = MessageWidget(f"[bold cyan]You:[/bold cyan] {content}", "user")
        self.mount(msg)
        self.scroll_end(animate=False)
        self.refresh()

    def add_thinking(self, content: str):
        """添加思考过程"""
        msg = MessageWidget(f"[dim italic]{content}[/dim italic]", "thinking")
        self.mount(msg)
        self.scroll_end(animate=False)
        self.refresh()

    def add_tool_call(self, tool_name: str, tool_input: dict):
        """添加工具调用"""
        import json

        input_str = json.dumps(tool_input, ensure_ascii=False, indent=2)
        if len(input_str) > 300:
            input_str = input_str[:300] + "..."

        content = f"[bold yellow]🔧 Tool:[/bold yellow] [cyan]{tool_name}[/cyan]\n[dim]{input_str}[/dim]"
        msg = MessageWidget(content, "tool-call")
        self.mount(msg)
        self.scroll_end(animate=False)
        self.refresh()

    def add_tool_result(self, success: bool, preview: str, is_subagent: bool = False):
        """添加工具结果

        Args:
            success: 是否成功
            preview: 预览内容
            is_subagent: 是否是 SubAgent 的结果
        """
        if is_subagent:
            # SubAgent 结果用特殊样式
            content = f"[bold magenta]📦 SubAgent 完成[/bold magenta]\n[dim]{preview}[/dim]"
            msg = MessageWidget(content, "subagent-result")
        elif success:
            content = f"[green]✓ Success[/green]\n[dim]{preview}[/dim]"
            msg = MessageWidget(content, "tool-result-success")
        else:
            content = f"[red]✗ Error[/red]\n[dim]{preview}[/dim]"
            msg = MessageWidget(content, "tool-result-error")
        self.mount(msg)
        self.scroll_end(animate=False)
        self.refresh()

    def add_subagent_execution(self, execution_log: list):
        """添加 SubAgent 执行日志

        Args:
            execution_log: 执行日志列表
        """
        for entry in execution_log:
            entry_type = entry.get("type", "")

            if entry_type == "tool_call":
                tool_name = entry.get("tool_name", "")
                tool_input = entry.get("tool_input", {})

                import json

                input_str = json.dumps(tool_input, ensure_ascii=False, indent=2)
                if len(input_str) > 200:
                    input_str = input_str[:200] + "..."

                content = f"  [cyan]🔧 SubAgent → {tool_name}[/cyan]\n  [dim]{input_str}[/dim]"
                msg = MessageWidget(content, "subagent-tool-call")
                self.mount(msg)

            elif entry_type == "tool_result":
                is_error = entry.get("is_error", False)
                result_content = entry.get("content", "")

                if is_error:
                    content = f"  [red]  ❌ Error[/red]\n  [dim]{result_content}[/dim]"
                else:
                    content = f"  [green]  ✓ Success[/green]\n  [dim]{result_content}[/dim]"
                msg = MessageWidget(content, "subagent-tool-result")
                self.mount(msg)

            elif entry_type == "assistant_text":
                text = entry.get("content", "")
                if text:
                    content = f"  [blue]💬 SubAgent: {text}[/blue]"
                    msg = MessageWidget(content, "subagent-text")
                    self.mount(msg)

        self.scroll_end(animate=False)
        self.refresh()

    def add_assistant_message(self, content: str):
        """添加助手最终回复"""
        msg = MessageWidget(Markdown(content), "assistant")
        self.mount(msg)
        self.scroll_end(animate=False)
        self.refresh()

    def add_system_message(self, content: str):
        """添加系统消息"""
        msg = MessageWidget(f"[dim]{content}[/dim]", "system")
        self.mount(msg)
        self.scroll_end(animate=False)
        self.refresh()


class RippleTUI(App):
    """Ripple TUI 应用"""

    CSS = """
    Screen {
        layout: vertical;
    }

    Header {
        dock: top;
    }

    #chat-panel {
        height: 1fr;
        border: solid $primary;
        padding: 1 2;
        background: $surface;
    }

    #input-container {
        dock: bottom;
        height: auto;
        padding: 1 2;
        background: $panel;
        border-top: solid $accent;
    }

    Input {
        width: 100%;
    }

    Footer {
        dock: bottom;
    }

    /* 消息样式 */
    .msg-user {
        margin: 1 0;
        padding: 1 2;
        background: $boost;
        border-left: thick $primary;
    }

    .msg-thinking {
        margin: 0 0 0 4;
        padding: 0 1;
    }

    .msg-tool-call {
        margin: 0 0 0 4;
        padding: 1 2;
        background: $panel;
        border-left: thick $warning;
    }

    .msg-tool-result-success {
        margin: 0 0 1 4;
        padding: 1 2;
        background: $panel;
        border-left: thick $success;
    }

    .msg-tool-result-error {
        margin: 0 0 1 4;
        padding: 1 2;
        background: $panel;
        border-left: thick $error;
    }

    .msg-assistant {
        margin: 1 0;
        padding: 1 2;
        background: $surface;
        border-left: thick $accent;
    }

    .msg-system {
        margin: 1 0;
        padding: 0 2;
        text-align: center;
    }

    /* SubAgent 样式 */
    .subagent-tool-call {
        margin: 0 0 0 6;
        padding: 1 2;
        background: $panel;
        border-left: thick $accent;
    }

    .subagent-tool-result {
        margin: 0 0 0 6;
        padding: 0 2;
    }

    .subagent-text {
        margin: 0 0 0 6;
        padding: 0 2;
    }

    .subagent-result {
        margin: 0 0 1 4;
        padding: 1 2;
        background: $panel;
        border-left: thick $accent;
    }
    """

    BINDINGS = [
        ("ctrl+c", "quit", "Quit"),
        ("ctrl+l", "clear", "Clear"),
    ]

    def __init__(self, model: str | None = None, max_turns: int | None = None):
        super().__init__()
        config = get_config()
        self.model = model or config.get("model.default", "anthropic/claude-3.5-sonnet")
        self.max_turns = max_turns or config.get("agent.max_turns", 10)
        self.client: OpenRouterClient | None = None
        self.context: ToolUseContext | None = None
        self.session_count = 0

    def compose(self) -> ComposeResult:
        """创建界面"""
        yield Header(show_clock=True)
        yield ChatPanel(id="chat-panel")
        yield Container(
            Input(placeholder="输入你的问题... (Ctrl+C 退出, Ctrl+L 清空)", id="user-input"),
            id="input-container",
        )
        yield Footer()

    def on_mount(self) -> None:
        """挂载时初始化"""
        self.title = "🌊 Ripple Agent"
        self.sub_title = f"Model: {self.model}"

        # 初始化客户端和上下文
        self.initialize()

        # 显示欢迎消息
        chat_panel = self.query_one("#chat-panel", ChatPanel)
        chat_panel.add_system_message(
            "🌊 Ripple Agent - 让每个提问都成为涟漪的中心\n\n"
            "输入你的问题，Agent 会自动调用工具完成任务。\n"
            "快捷键: Ctrl+C 退出 | Ctrl+L 清空"
        )

        # 聚焦输入框
        self.query_one("#user-input", Input).focus()

    def initialize(self):
        """初始化客户端和上下文"""
        tools = [
            BashTool(),
            ReadTool(),
            WriteTool(),
            SubAgentTool(),
            SkillTool(),
        ]

        self.context = ToolUseContext(
            options=ToolOptions(
                tools=tools,
                model=self.model,
            ),
            session_id=f"tui-session-{self.session_count}",
            cwd=str(Path.cwd()),
        )

        try:
            self.client = OpenRouterClient()
        except ValueError as e:
            chat_panel = self.query_one("#chat-panel", ChatPanel)
            chat_panel.add_system_message(f"[red]错误: {e}[/red]")

    @on(Input.Submitted)
    async def on_input_submitted(self, event: Input.Submitted) -> None:
        """处理输入提交"""
        user_input = event.value.strip()
        if not user_input:
            return

        # 清空输入框
        event.input.value = ""

        # 显示用户消息
        chat_panel = self.query_one("#chat-panel", ChatPanel)
        chat_panel.add_user_message(user_input)

        # 执行查询
        self.execute_query(user_input)

    @work(exclusive=True)
    async def execute_query(self, user_input: str):
        """执行查询"""
        if not self.client or not self.context:
            return

        chat_panel = self.query_one("#chat-panel", ChatPanel)

        # 显示处理状态
        status_msg = MessageWidget("[dim]正在思考...[/dim]", "system")
        chat_panel.mount(status_msg)
        chat_panel.scroll_end(animate=False)

        try:
            # 用于跟踪是否已经显示过最终回复
            final_response_shown = False

            async for item in query(
                user_input=user_input,
                context=self.context,
                client=self.client,
                model=self.model,
                max_turns=self.max_turns,
            ):
                if hasattr(item, "type"):
                    if item.type == "assistant":
                        content = item.message.get("content", [])

                        # 检查是否包含工具调用
                        has_tool_use = any(
                            isinstance(block, dict) and block.get("type") == "tool_use" for block in content
                        )

                        # 处理内容块
                        for block in content:
                            if isinstance(block, dict):
                                if block.get("type") == "text":
                                    text = block.get("text", "").strip()
                                    if text and has_tool_use:
                                        # 如果有工具调用，这是思考过程
                                        chat_panel.add_thinking(f"💭 {text}")

                                elif block.get("type") == "tool_use":
                                    # 显示工具调用
                                    tool_name = block.get("name", "")
                                    tool_input = block.get("input", {})
                                    chat_panel.add_tool_call(tool_name, tool_input)

                        # 如果没有工具调用，这是最终回复
                        if not has_tool_use and not final_response_shown:
                            text_parts = []
                            for block in content:
                                if isinstance(block, dict) and block.get("type") == "text":
                                    text = block.get("text", "").strip()
                                    if text:
                                        text_parts.append(text)

                            if text_parts:
                                full_text = "\n".join(text_parts)
                                chat_panel.add_assistant_message(full_text)
                                final_response_shown = True

                    elif item.type == "user":
                        # 工具结果
                        content = item.message.get("content", [])
                        for block in content:
                            if isinstance(block, dict) and block.get("type") == "tool_result":
                                result_content = block.get("content", "")
                                is_error = block.get("is_error", False)

                                # 检查是否是 SubAgent 的结果
                                is_subagent_result = False
                                try:
                                    if "SubAgentOutput" in result_content or "execution_log" in result_content:
                                        is_subagent_result = True
                                        # 解析 SubAgent 执行日志
                                        if "execution_log=[" in result_content:
                                            import ast
                                            import re

                                            match = re.search(
                                                r"execution_log=\[(.*?)\](?=,?\s*\))", result_content, re.DOTALL
                                            )
                                            if match:
                                                log_str = "[" + match.group(1) + "]"
                                                execution_log = ast.literal_eval(log_str)
                                                chat_panel.add_subagent_execution(execution_log)

                                            # 提取最终结果
                                            result_match = re.search(
                                                r"result='(.*?)'(?=,\s*turns_used)", result_content, re.DOTALL
                                            )
                                            if result_match:
                                                final_result = result_match.group(1)
                                                preview = final_result[:200]
                                                if len(final_result) > 200:
                                                    preview += "..."
                                                chat_panel.add_tool_result(True, preview, is_subagent=True)
                                            continue
                                except Exception:
                                    pass

                                if not is_subagent_result:
                                    # 提取预览
                                    preview = result_content[:200]
                                    if len(result_content) > 200:
                                        preview += "..."

                                    # 尝试提取 stdout
                                    if "stdout=" in result_content:
                                        import re

                                        match = re.search(r"stdout='([^']*)'", result_content)
                                        if match:
                                            stdout_str = match.group(1)
                                            try:
                                                stdout_str = stdout_str.encode().decode("unicode_escape")
                                                lines = stdout_str.split("\n")[:5]
                                                preview = "\n".join(lines)
                                                if len(stdout_str.split("\n")) > 5:
                                                    preview += "\n..."
                                            except Exception:
                                                pass

                                    chat_panel.add_tool_result(not is_error, preview)

            # 移除状态消息
            status_msg.remove()
            chat_panel.add_system_message("[green]✓ 完成[/green]")

        except Exception as e:
            # 移除状态消息
            status_msg.remove()
            chat_panel.add_system_message(f"[red]错误: {e}[/red]")
            # 打印详细错误到日志
            import traceback

            self.log(traceback.format_exc())

    def action_clear(self) -> None:
        """清空聊天"""
        chat_panel = self.query_one("#chat-panel", ChatPanel)
        chat_panel.remove_children()
        chat_panel.add_system_message("聊天已清空")


@click.command()
@click.option("--model", default=None, help="模型名称")
@click.option("--max-turns", default=None, type=int, help="最大轮数")
def main(model: str | None, max_turns: int | None):
    """启动 Ripple TUI 界面

    类似 Claude Code 的终端图形界面。
    """
    app = RippleTUI(model=model, max_turns=max_turns)
    app.run()


if __name__ == "__main__":
    main()
