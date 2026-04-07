"""简单测试 TUI 界面更新"""

from interfaces.tui.tui import RippleTUI

if __name__ == "__main__":
    app = RippleTUI(model="anthropic/claude-3.5-sonnet", max_turns=3)
    app.run()
