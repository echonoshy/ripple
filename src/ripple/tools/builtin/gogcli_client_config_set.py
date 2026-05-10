"""GoogleWorkspaceClientConfigSet — 管理员/开发调试时绑定 Google OAuth 凭据到当前 user

正常终端用户授权流程不应该调用本工具。部署方应在 `config/settings.yaml` 里配置
`server.gogcli_oauth.client`，随后由 `GoogleWorkspaceLoginStart` 自动注册。

本工具只保留给管理员/开发者做迁移、排障或一次性调试：
  1. 管理员已经在对话中明确提供凭据 JSON。
  2. 本工具落盘到 `sandboxes/<uid>/credentials/gogcli-client.json`。
  3. 然后在沙箱里跑 `gog auth credentials <path>` 把 client 真正注册到 gogcli 自己
     的 config（`$XDG_CONFIG_HOME/gogcli/credentials.json`），供后续 `gog auth add`
     使用。
  4. 本工具会顺便触发"注册到 gogcli config"那一步（一次 sandbox bash 调用），
     让 `GoogleWorkspaceLoginStart` 直接可用。

风险等级：SAFE（写 user 自己目录的一份 JSON + 在沙箱里跑一条幂等命令）。
"""

from typing import Any

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.permissions.levels import ToolRiskLevel
from ripple.sandbox.gogcli_registration import GogcliClientRegistrationError, register_gogcli_client_config
from ripple.tools.base import Tool, ToolResult
from ripple.utils.logger import get_logger

logger = get_logger("tools.gogcli_client_config_set")


class GoogleWorkspaceClientConfigSetTool(Tool):
    """管理员/开发调试时绑定 Google OAuth 凭据到当前 user（per-user 隔离）"""

    def __init__(self):
        self.name = "GoogleWorkspaceClientConfigSet"
        self.description = (
            "Admin/debug-only escape hatch: bind a Google OAuth credential JSON to the current "
            "user. Normal end-user login should use `GoogleWorkspaceLoginStart`, which "
            "auto-registers `server.gogcli_oauth.client` when the deployment is configured. "
            "Call this tool only when an operator has already supplied the JSON explicitly for "
            "migration, debugging, or one-off local setup.\n\n"
            "When to trigger:\n"
            "- Operator/admin supplies a JSON blob whose top-level key is `installed` (Desktop) or `web`.\n"
            "- The JSON contains `client_id` and `client_secret`.\n"
            "- The operator explicitly confirms this is an admin/debug setup, not a normal "
            "  end-user authorization flow.\n\n"
            "IMPORTANT:\n"
            "- Do not route normal users to this tool. If login reports missing server config, "
            "  tell the user the service is not configured yet and ask an administrator to fix "
            "  `server.gogcli_oauth.client`.\n"
            "- Pass exactly the supplied JSON via `client_secret_json` (no reformat).\n"
            "- Do NOT echo `client_secret` back in subsequent messages. "
            "  You may mention `client_id` (not a secret).\n"
            "- Do NOT proactively warn 'rotate your secret / security risk'. The user sandbox "
            "  is strictly isolated; credentials won't leak to other users. Only advise if the "
            "  user explicitly asks about security.\n"
            "- After this tool succeeds, the very next step is `GoogleWorkspaceLoginStart`.\n"
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
                        "client_secret_json": {
                            "type": "string",
                            "description": (
                                "The full Google OAuth credential JSON supplied by the operator. "
                                "Must contain `installed` or `web` with `client_id` and `client_secret`."
                            ),
                        },
                    },
                    "required": ["client_secret_json"],
                },
            },
        }

    async def call(
        self,
        args: dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage | None,
    ) -> ToolResult[dict]:
        raw = (args.get("client_secret_json") or "").strip()
        if not raw:
            return ToolResult(
                data={
                    "ok": False,
                    "error": (
                        "client_secret_json 为空。此工具仅供管理员/开发调试；"
                        "正常授权请先配置 server.gogcli_oauth.client 后调用 GoogleWorkspaceLoginStart。"
                    ),
                }
            )

        from ripple.tools.builtin.bash import _sandbox_config

        if _sandbox_config is None:
            return ToolResult(data={"ok": False, "error": "Sandbox 未启用，无法绑定 OAuth client"})

        user_id = context.user_id
        if not user_id:
            return ToolResult(data={"ok": False, "error": "当前上下文没有 user_id"})

        if not _sandbox_config.gogcli_cli_install_root:
            return ToolResult(
                data={
                    "ok": False,
                    "error": "gogcli 未预装（宿主机）。请联系管理员执行: bash scripts/install-gogcli-cli.sh",
                }
            )

        try:
            client = await register_gogcli_client_config(_sandbox_config, user_id, raw)
        except ValueError as e:
            return ToolResult(data={"ok": False, "error": str(e)})
        except GogcliClientRegistrationError as e:
            logger.error("user {} gog auth credentials 失败: {}", user_id, e)
            return ToolResult(
                data={
                    "ok": False,
                    "error": (
                        f"{e}\n"
                        "常见原因：1) 凭据 JSON 里字段无效；2) gog 二进制问题；"
                        "3) Web OAuth client 的 redirect URI 未登记。"
                    ),
                }
            )
        except OSError as e:
            logger.error("user {} 写入 gogcli-client.json 失败: {}", user_id, e)
            return ToolResult(data={"ok": False, "error": f"写入失败: {e}"})

        logger.info("user {} gogcli client config 已绑定 (client_id={}...)", user_id, client.client_id[:12])

        return ToolResult(
            data={
                "ok": True,
                "client_id": client.client_id,
                "next": (
                    "Client config 已绑定。**下一步立刻调 `GoogleWorkspaceLoginStart`**，"
                    "它会在沙箱里启动 `gog auth add --remote --step 1` 并返回 OAuth URL。"
                    "如果 Ripple 能从配置或当前 API 请求推断 callback URL，"
                    "用户只需在浏览器授权；否则按 remote 流程完成 callback。"
                    "不要主动劝用户 rotate client_secret —— sandbox 严格隔离。"
                ),
            }
        )

    def is_concurrency_safe(self, input: dict[str, Any]) -> bool:
        return False
