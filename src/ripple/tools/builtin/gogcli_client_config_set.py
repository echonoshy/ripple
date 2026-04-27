"""GoogleWorkspaceClientConfigSet — 把用户贴的 Desktop OAuth client_secret.json 绑到当前 user

两步流程的**第 1 步**：
  1. 用户在 GCP Console 建一个 **Desktop** OAuth Client，下 JSON。
  2. 用户把 JSON 贴到对话，agent 调本工具。
  3. 本工具落盘到 `sandboxes/<uid>/credentials/gogcli-client.json`。
  4. 然后在沙箱里跑 `gog auth credentials <path>` 把 client 真正注册到 gogcli 自己
     的 config（`$XDG_CONFIG_HOME/gogcli/credentials.json`），供后续 `gog auth add`
     使用。
  5. 本工具会顺便触发"注册到 gogcli config"那一步（一次 sandbox bash 调用），
     让 `GoogleWorkspaceLoginStart` 直接可用。

风险等级：SAFE（写 user 自己目录的一份 JSON + 在沙箱里跑一条幂等命令）。
"""

from typing import Any

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.permissions.levels import ToolRiskLevel
from ripple.sandbox.config import GOGCLI_CLI_SANDBOX_BIN
from ripple.sandbox.executor import execute_in_sandbox
from ripple.sandbox.gogcli import ensure_gogcli_keyring_password, write_gogcli_client_config
from ripple.sandbox.nsjail_config import write_nsjail_config
from ripple.tools.base import Tool, ToolResult
from ripple.utils.logger import get_logger

logger = get_logger("tools.gogcli_client_config_set")

_SANDBOX_CLIENT_JSON_DST = "/workspace/.config/gogcli/.pending-client.json"


class GoogleWorkspaceClientConfigSetTool(Tool):
    """绑定 Desktop OAuth client_secret.json 到当前 user（per-user 隔离）"""

    def __init__(self):
        self.name = "GoogleWorkspaceClientConfigSet"
        self.description = (
            "Bind the user's Google Cloud Desktop OAuth client configuration "
            "(client_secret.json) to the current user. Call this **immediately** after "
            "the user pastes the JSON contents of `client_secret_*.json` from GCP Console.\n\n"
            "When to trigger:\n"
            "- User pastes a JSON blob whose top-level key is `installed` (Desktop) or `web`.\n"
            "- The JSON contains `client_id` and `client_secret`.\n"
            "- You got a `[GOGCLI_CLIENT_CONFIG_REQUIRED]` guard.\n\n"
            "IMPORTANT:\n"
            "- Pass exactly what the user pasted via `client_secret_json` (no trim/reformat).\n"
            "- Do NOT echo `client_secret` back to the user in subsequent messages. "
            "  You may mention `client_id` (not a secret).\n"
            "- Do NOT proactively warn 'rotate your secret / security risk'. The user sandbox "
            "  is strictly isolated; credentials won't leak to other users. Only advise if the "
            "  user explicitly asks about security.\n"
            "- After this tool succeeds, the very next step is `GoogleWorkspaceLoginStart`.\n\n"
            "If the user hasn't created a Desktop OAuth Client yet, first guide them:\n"
            "  1. Open https://console.cloud.google.com/apis/credentials → pick/create a project.\n"
            "  2. Create Credentials → OAuth client ID → Application type: **Desktop app** → name it.\n"
            "  3. Download the JSON (`client_secret_<number>-<hash>.apps.googleusercontent.com.json`).\n"
            "  4. Configure OAuth consent screen (External type → add user's own account as Test user).\n"
            "  5. In 'Enabled APIs & Services' enable ALL the APIs below (first-time, one-shot):\n"
            "     Gmail, Drive, Calendar, Sheets, Docs, Slides, Tasks, People, Chat, Forms, Apps Script, Classroom.\n"
            "  6. Paste the full JSON content here.\n"
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
                                "The full JSON text of the user's Desktop OAuth client_secret.json. "
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
                    "error": "client_secret_json 为空。请让用户把 GCP Console 下载的 client_secret_*.json 完整粘贴过来。",
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
            client = write_gogcli_client_config(_sandbox_config, user_id, raw)
            ensure_gogcli_keyring_password(_sandbox_config, user_id)
            write_nsjail_config(_sandbox_config, user_id)
        except ValueError as e:
            return ToolResult(data={"ok": False, "error": str(e)})
        except OSError as e:
            logger.error("user {} 写入 gogcli-client.json 失败: {}", user_id, e)
            return ToolResult(data={"ok": False, "error": f"写入失败: {e}"})

        client_json_path_host = _sandbox_config.gogcli_client_config_file(user_id)
        pending_on_workspace = _sandbox_config.workspace_dir(user_id) / ".config" / "gogcli" / ".pending-client.json"
        pending_on_workspace.parent.mkdir(parents=True, exist_ok=True)
        pending_on_workspace.write_text(client_json_path_host.read_text(encoding="utf-8"), encoding="utf-8")
        pending_on_workspace.chmod(0o600)

        register_cmd = (
            f"mkdir -p $XDG_CONFIG_HOME/gogcli && "
            f"{GOGCLI_CLI_SANDBOX_BIN} auth credentials {_SANDBOX_CLIENT_JSON_DST} && "
            f"rm -f {_SANDBOX_CLIENT_JSON_DST}"
        )
        stdout, stderr, code = await execute_in_sandbox(register_cmd, _sandbox_config, user_id, timeout=30)
        if code != 0:
            try:
                pending_on_workspace.unlink(missing_ok=True)
            except OSError:
                pass
            logger.error("user {} gog auth credentials 失败 (code={}): {}", user_id, code, stderr[:500])
            return ToolResult(
                data={
                    "ok": False,
                    "error": (
                        f"gog auth credentials 命令失败 (exit {code})。stderr 片段: {stderr[-500:]}\n"
                        "常见原因：1) client_secret.json 里字段无效；2) gog 二进制问题。"
                    ),
                }
            )

        logger.info("user {} gogcli client config 已绑定 (client_id={}...)", user_id, client.client_id[:12])

        return ToolResult(
            data={
                "ok": True,
                "client_id": client.client_id,
                "next": (
                    "Client config 已绑定。**下一步立刻调 `GoogleWorkspaceLoginStart`**，"
                    "它会在沙箱里启动 `gog auth add --remote --step 1` 并返回 OAuth URL。"
                    "把 URL 原样转发给用户，让他本地浏览器打开→点 Allow→复制地址栏 URL 粘回对话。"
                    "不要主动劝用户 rotate client_secret —— sandbox 严格隔离。"
                ),
            }
        )

    def is_concurrency_safe(self, input: dict[str, Any]) -> bool:
        return False
