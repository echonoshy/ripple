"""NotionTokenSet — 把用户在对话里贴出的 Notion Integration Token 绑定到当前 user

设计理念：
  * **不依赖前端 UI**：用户直接在对话框里贴 token，模型识别后调本工具
    完成绑定。这样后端能给任意前端（CLI、Web、SDK）共用，无需各自实现
    一个 "token 输入卡片"。
  * **per-user 严格隔离**：token 写到 `sandboxes/<user_id>/credentials/notion.json`，
    对同一 user 下的所有 session 共享；user sandbox 本身是严格隔离且保密的，
    不会泄露给其他 user。
  * **不回显 token**：工具的 result.data 里**绝不**包含 token 原文，
    只返回前 6 字符 + 长度，避免后续 turn 把 token 反复带进 LLM 上下文。
  * **不主动劝用户 Regenerate**：既然 sandbox 是隔离保密的，绑定成功就
    直接继续业务，不要在每次回复里挂"建议 Regenerate / token 有风险"
    的尾巴。仅在用户主动问起安全问题时再给建议。
  * **生效即时**：写文件后立刻重生成 nsjail.cfg，下一次 bash 命令就能
    读到 `NOTION_API_TOKEN` env。

风险等级：BENIGN（不破坏环境，但确实写文件 + 涉及凭证）。
"""

from typing import Any

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.permissions.levels import ToolRiskLevel
from ripple.sandbox.notion import write_notion_token_uid
from ripple.sandbox.nsjail_config import write_nsjail_config_uid
from ripple.tools.base import Tool, ToolResult
from ripple.utils.logger import get_logger

logger = get_logger("tools.notion_token_set")


class NotionTokenSetTool(Tool):
    """把 Notion Integration Token 绑定到当前 user（per-user 隔离）"""

    def __init__(self):
        self.name = "NotionTokenSet"
        self.description = (
            "Bind a Notion Internal Integration Token to the current user "
            "(per-user, strictly isolated; shared across sessions of the same user). "
            "Use this **immediately** after the user pastes their Notion token "
            "(typically `ntn_...` or `secret_...`) in the chat. After binding, "
            "retry the original `ntn` command — the sandbox will pick up the "
            "token via `NOTION_API_TOKEN` env.\n\n"
            "IMPORTANT:\n"
            "- Do NOT echo the full token in your subsequent messages. If you "
            "  must refer to it (e.g. to confirm which one is bound), show only "
            "  first 6 chars + ellipsis like `ntn_xxx...`.\n"
            "- Do NOT call this tool with a fake / example token.\n"
            "- Do NOT proactively warn the user to 'regenerate / rotate the token' "
            "  or claim 'the token is exposed in conversation history'. The user "
            "  sandbox is strictly isolated; tokens pasted here are not leaked to "
            "  others. Only mention rotation if the user explicitly asks about "
            "  security.\n\n"
            "Input:\n"
            "- api_token (required): The full token string the user pasted.\n"
        )
        self.risk_level = ToolRiskLevel.SAFE

    def to_openai_tool(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "api_token": {
                            "type": "string",
                            "description": (
                                "Notion Internal Integration Token. Typically starts with "
                                "`ntn_` or `secret_`, length 50+. Pass exactly what the user pasted."
                            ),
                        },
                    },
                    "required": ["api_token"],
                },
            },
        }

    async def call(
        self,
        args: dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage | None,
    ) -> ToolResult[dict]:
        api_token = (args.get("api_token") or "").strip()

        if not api_token:
            return ToolResult(data={"ok": False, "error": "api_token 为空，请向用户索取 token"})

        if not (api_token.startswith("ntn_") or api_token.startswith("secret_")):
            return ToolResult(
                data={
                    "ok": False,
                    "error": (
                        "Token 前缀不合法：Notion Integration Token 通常以 `ntn_` 或 `secret_` 开头。"
                        "请提醒用户检查是否复制完整。"
                    ),
                }
            )

        if len(api_token) < 20 or len(api_token) > 200:
            return ToolResult(
                data={
                    "ok": False,
                    "error": f"Token 长度异常 (got {len(api_token)})；正常 Notion token 约 50 字符。",
                }
            )

        # 从 BashTool 共享的全局 SandboxConfig 拿引用，与其他 sandbox-aware 工具
        # （write.py 等）的拿法一致；server 启动时由 app.py 调
        # `bash.set_sandbox_config(...)` 一次性灌入。
        from ripple.tools.builtin.bash import _sandbox_config

        if _sandbox_config is None:
            return ToolResult(
                data={
                    "ok": False,
                    "error": "Sandbox 未启用（_sandbox_config is None），无法绑定 token",
                }
            )

        user_id = context.user_id
        if not user_id:
            return ToolResult(
                data={
                    "ok": False,
                    "error": "当前上下文没有 user_id，无法定位写入位置",
                }
            )

        try:
            write_notion_token_uid(_sandbox_config, user_id, api_token)
            write_nsjail_config_uid(_sandbox_config, user_id)
        except OSError as e:
            logger.error("user {} 写入 notion.json 失败: {}", user_id, e)
            return ToolResult(data={"ok": False, "error": f"写入失败: {e}"})

        masked = f"{api_token[:6]}...({len(api_token)} chars)"
        logger.info("user {} Notion token 已绑定 ({})", user_id, masked)

        return ToolResult(
            data={
                "ok": True,
                "token_preview": masked,
                "next": (
                    "Token 已绑定到当前 user 的沙箱环境（对该 user 下所有 session 共享）。"
                    "请立刻重跑刚才被拦下的 `ntn` 命令，直接继续业务即可。"
                    "不要主动劝用户 Regenerate / rotate token —— "
                    "user sandbox 是严格隔离保密的，token 不会泄露给其他 user，"
                    "只有用户明确问起安全问题时才给建议。"
                ),
            }
        )

    def is_concurrency_safe(self, input: dict[str, Any]) -> bool:
        return False
