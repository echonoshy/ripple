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
from ripple.tools.builtin.write import WriteTool
from ripple.utils.config import get_config


class MessageWidget(Static):
    """单条消息组件"""

    def __init__(self, role: str, content: str, **kwargs):
        super().__init__(**kwargs)
        self.role = role
        self.content = content

    def compose(self) -> ComposeResult:
        if self.role == "user":
            yield Static(f"[bold cyan]You:[/bold cyan] {self.content}", classes="message user-message")
        elif self.role == "assistant":
            yield Static(Markdown(self.content), classes="message assistant-message")
        elif self.role == "tool":
            yield Static(f"[yellow]🔧 {self.content}[/yellow]", classes="message tool-message")
        elif self.role == "system":
            yield Static(f"[dim]{self.content}[/dim]", classes="message system-message")


class ChatPanel(VerticalScroll):
    """聊天面板"""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.can_focus = False

    def add_message(self, role: str, content: str):
        """添加消息"""
        message = MessageWidget(role, content)
        self.mount(message)
        self.scroll_end(animate=False)


class ToolPanel(VerticalScroll):
    """工具调用面板"""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.can_focus = False

    def add_tool_call(self, tool_name: str, tool_input: dict):
        """添加工具调用"""
        import json

        input_str = json.dumps(tool_input, ensure_ascii=False, indent=2)
        if len(input_str) > 300:
            input_str = input_str[:300] + "..."
        content = f"[bold yellow]{tool_name}[/bold yellow]\n[dim]{input_str}[/dim]"
        self.mount(Static(content, classes="tool-call"))
        self.scroll_end(animate=False)

    def add_tool_result(self, success: bool, preview: str):
        """添加工具结果"""
        if success:
            content = f"[green]✓ Success[/green]\n[dim]{preview}[/dim]"
        else:
            content = f"[red]✗ Error[/red]\n[dim]{preview}[/dim]"
        self.mount(Static(content, classes="tool-result"))
        self.scroll_end(animate=False)


class StatusBar(Static):
    """状态栏"""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.model = "claude-sonnet-4.6"
        self.status = "Ready"

    def compose(self) -> ComposeResult:
        yield Static(f"[bold]Model:[/bold] {self.model} | [bold]Status:[/bold] {self.status}")

    def update_status(self, status: str):
        """更新状态"""
        self.status = status
        self.update(f"[bold]Model:[/bold] {self.model} | [bold]Status:[/bold] {self.status}")


class RippleTUI(App):
    """Ripple TUI 应用"""

    CSS = """
    Screen {
        layout: grid;
        grid-size: 2 3;
        grid-columns: 3fr 1fr;
        grid-rows: auto 1fr auto;
    }

    Header {
        column-span: 2;
    }

    #chat-panel {
        border: solid $primary;
        height: 100%;
        padding: 1;
    }

    #tool-panel {
        border: solid $secondary;
        height: 100%;
        padding: 1;
    }

    #input-container {
        column-span: 2;
        height: auto;
        padding: 1;
        border: solid $accent;
    }

    Input {
        width: 100%;
    }

    .message {
        margin: 1 0;
    }

    .user-message {
        color: $text;
    }

    .assistant-message {
        color: $text;
    }

    .tool-message {
        color: $warning;
    }

    .system-message {
        color: $text-muted;
    }

    .tool-call {
        margin: 1 0;
        padding: 1;
        background: $panel;
        border-left: thick $warning;
    }

    .tool-result {
        margin: 1 0;
        padding: 1;
        background: $panel;
        border-left: thick $success;
    }

    Footer {
        column-span: 2;
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
        yield ToolPanel(id="tool-panel")
        yield Container(
            Input(placeholder="输入你的问题... (Ctrl+C 退出)", id="user-input"),
            id="input-container",
        )
        yield Footer()

    def on_mount(self) -> None:
        """挂载时初始化"""
        self.title = "🌊 Ripple Agent TUI"
        self.sub_title = f"Model: {self.model}"

        # 初始化客户端和上下文
        self.initialize()

        # 显示欢迎消息
        chat_panel = self.query_one("#chat-panel", ChatPanel)
        chat_panel.add_message(
            "system",
            "🌊 Ripple Agent TUI - 让每个提问都成为涟漪的中心\n\n"
            "输入你的问题，Agent 会自动调用工具完成任务。\n"
            "快捷键: Ctrl+C 退出 | Ctrl+L 清空",
        )

        # 聚焦输入框
        self.query_one("#user-input", Input).focus()

    def initialize(self):
        """初始化客户端和上下文"""
        tools = [
            BashTool(),
            ReadTool(),
            WriteTool(),
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
            chat_panel.add_message("system", f"[red]错误: {e}[/red]")

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
        chat_panel.add_message("user", user_input)

        # 执行查询（@work 装饰器会自动处理异步执行）
        self.execute_query(user_input)

    @work(exclusive=True)
    async def execute_query(self, user_input: str):
        """执行查询"""
        if not self.client or not self.context:
            return

        chat_panel = self.query_one("#chat-panel", ChatPanel)
        tool_panel = self.query_one("#tool-panel", ToolPanel)

        status_msg = Static("[dim]正在处理...[/dim]", classes="message system-message")
        chat_panel.mount(status_msg)
        chat_panel.scroll_end(animate=False)

        try:
            async for item in query(
                user_input=user_input,
                context=self.context,
                client=self.client,
                model=self.model,
                max_turns=self.max_turns,
            ):
                if hasattr(item, "type"):
                    if item.type == "assistant":
                        # 助手消息
                        content = item.message.get("content", [])

                        # 检查是否包含工具调用
                        has_tool_use = any(
                            isinstance(block, dict) and block.get("type") == "tool_use" for block in content
                        )

                        # 提取文本和工具调用
                        text_parts = []
                        for block in content:
                            if isinstance(block, dict):
                                if block.get("type") == "text":
                                    text = block.get("text", "")
                                    if text.strip():
                                        text_parts.append(text)

                                elif block.get("type") == "tool_use":
                                    # 显示工具调用
                                    tool_name = block.get("name", "")
                                    tool_input = block.get("input", {})
                                    tool_panel.add_tool_call(tool_name, tool_input)

                        # 只显示没有工具调用的消息文本（最终回复）
                        if not has_tool_use and text_parts:
                            full_text = "".join(text_parts)
                            chat_panel.add_message("assistant", full_text)

                    elif item.type == "user":
                        # 工具结果
                        content = item.message.get("content", [])
                        for block in content:
                            if isinstance(block, dict) and block.get("type") == "tool_result":
                                result_content = block.get("content", "")
                                is_error = block.get("is_error", False)

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

                                tool_panel.add_tool_result(not is_error, preview)

            # 移除状态消息
            status_msg.remove()
            chat_panel.add_message("system", "[green]✓ 完成[/green]")

        except Exception as e:
            # 移除状态消息
            status_msg.remove()
            chat_panel.add_message("system", f"[red]错误: {e}[/red]")
            # 打印详细错误到日志
            import traceback

            self.log(traceback.format_exc())

    def action_clear(self) -> None:
        """清空聊天"""
        chat_panel = self.query_one("#chat-panel", ChatPanel)
        tool_panel = self.query_one("#tool-panel", ToolPanel)
        chat_panel.remove_children()
        tool_panel.remove_children()
        chat_panel.add_message("system", "聊天已清空")


@click.command()
@click.option("--model", default=None, help="模型名称")
@click.option("--max-turns", default=None, type=int, help="最大轮数")
def tui(model: str | None, max_turns: int | None):
    """启动 Ripple TUI 界面

    类似 Claude Code 的终端图形界面。
    """
    app = RippleTUI(model=model, max_turns=max_turns)
    app.run()


if __name__ == "__main__":
    tui()
