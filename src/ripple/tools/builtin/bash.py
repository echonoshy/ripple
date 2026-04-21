"""Bash 工具

执行 shell 命令。
CLI 模式：直接在宿主机执行。
Server 模式：通过 nsjail 在沙箱中执行。
"""

import asyncio
import re
from typing import Any

from pydantic import BaseModel, Field

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.permissions.levels import ToolRiskLevel
from ripple.tools.base import Tool, ToolResult
from ripple.utils.logger import get_logger

logger = get_logger("tools.bash")

# 匹配需要 Python venv 的命令（支持管道、&&、绝对路径等）
_PYTHON_CMD_PATTERN = re.compile(
    r"(?:^|&&|\|\||;|\|)\s*(?:uv\s+(?:pip|run|add)|(?:/\S+/)?python3?|(?:/\S+/)?pip3?)\b",
)

# 匹配需要 pnpm 全局环境的命令。
# 注意：lark-cli 是 Go 静态二进制（scripts/install-feishu-cli.sh 下载到
# <repo_root>/vendor/lark-cli/），沙箱启动时 readonly bind mount 到
# /opt/lark-cli 并加入 PATH，无需 Node/pnpm 环境 — 因此不在此列表中。
_NODE_CMD_PATTERN = re.compile(
    r"(?:^|&&|\|\||;|\|)\s*(?:pnpm|npx|npm|node|corepack)\b",
)

# 匹配需要 lark-cli 的命令
_LARK_CLI_CMD_PATTERN = re.compile(
    r"(?:^|&&|\|\||;|\|)\s*lark-cli\b",
)

# 匹配需要 notion-cli (ntn) 的命令。
# 注意：ntn 是 Rust 静态二进制，与 lark-cli 一样无需 Node/pnpm 环境。
_NOTION_CLI_CMD_PATTERN = re.compile(
    r"(?:^|&&|\|\||;|\|)\s*ntn\b",
)


class BashInput(BaseModel):
    """Bash 工具输入"""

    command: str = Field(description="要执行的 shell 命令")
    timeout: int = Field(default=120, description="超时时间（秒）")


class BashOutput(BaseModel):
    """Bash 工具输出"""

    stdout: str
    stderr: str
    exit_code: int


# 全局沙箱配置引用（由 server 启动时设置）
_sandbox_config = None
# 全局 SandboxManager 引用（用于获取 per-user lock）
_sandbox_manager = None


def set_sandbox_config(config):
    global _sandbox_config
    _sandbox_config = config


def set_sandbox_manager(manager):
    global _sandbox_manager
    _sandbox_manager = manager


def _needs_python_venv(command: str) -> bool:
    """判断命令是否需要 Python venv 环境"""
    return bool(_PYTHON_CMD_PATTERN.search(command))


def _needs_node_env(command: str) -> bool:
    """判断命令是否需要 Node.js/pnpm 环境"""
    return bool(_NODE_CMD_PATTERN.search(command))


def _needs_lark_cli(command: str) -> bool:
    """判断命令是否需要 lark-cli"""
    return bool(_LARK_CLI_CMD_PATTERN.search(command))


def _needs_notion_cli(command: str) -> bool:
    """判断命令是否需要 notion-cli (ntn)"""
    return bool(_NOTION_CLI_CMD_PATTERN.search(command))


class BashTool(Tool[BashInput, BashOutput]):
    """Bash 工具"""

    def __init__(self):
        self.name = "Bash"
        self.description = "Execute a bash command and return the output"
        self.max_result_size_chars = 100_000
        self.risk_level = ToolRiskLevel.DANGEROUS

    async def call(
        self,
        args: BashInput | dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage,
    ) -> ToolResult[BashOutput]:
        if isinstance(args, dict):
            args = BashInput(**args)

        if error := self._check_blocked_commands(args.command):
            return ToolResult(data=BashOutput(stdout="", stderr=error, exit_code=1))

        try:
            if context.is_sandboxed and _sandbox_config:
                stdout, stderr, exit_code = await self._execute_in_sandbox(args, context)
            else:
                stdout, stderr, exit_code = await self._execute_direct(args, context)

            return ToolResult(data=BashOutput(stdout=stdout, stderr=stderr, exit_code=exit_code))

        except Exception as e:
            from ripple.utils.errors import error_message

            return ToolResult(
                data=BashOutput(stdout="", stderr=f"Command execution failed: {error_message(e)}", exit_code=-1)
            )

    def _check_blocked_commands(self, command: str) -> str | None:
        """检查命令是否包含被禁止的模式，返回错误信息或 None。"""
        import shlex

        try:
            tokens = shlex.split(command)
        except ValueError:
            tokens = command.split()

        if any(tok == "sudo" for tok in tokens) or command.lstrip().startswith("sudo "):
            return (
                "Error: sudo is not supported in this environment. "
                "The subprocess has no interactive stdin, so sudo will hang waiting for a password. "
                "Please run the command without sudo."
            )
        return None

    async def _ensure_venv_if_needed(self, command: str, user_id: str) -> str | None:
        """如果命令需要 Python 且 venv 不存在，懒创建之。返回错误信息或 None。"""
        if not _needs_python_venv(command):
            return None

        if _sandbox_config.has_python_venv(user_id):
            return None

        from ripple.sandbox.provisioning import ensure_python_venv

        success, msg = await ensure_python_venv(_sandbox_config, user_id)
        if not success:
            return f"[SANDBOX] Failed to initialize Python venv: {msg}"
        return None

    async def _ensure_pnpm_if_needed(self, command: str, user_id: str) -> str | None:
        """如果命令需要 Node.js/pnpm 且全局环境未初始化，懒创建之。返回错误信息或 None。"""
        if not _needs_node_env(command):
            return None

        if not _sandbox_config.node_dir:
            return "[SANDBOX] Node.js is not available. Please install Node.js on the host."

        if _sandbox_config.has_pnpm_setup(user_id):
            return None

        from ripple.sandbox.provisioning import ensure_pnpm_setup

        success, msg = await ensure_pnpm_setup(_sandbox_config, user_id)
        if not success:
            return f"[SANDBOX] Failed to initialize pnpm environment: {msg}"
        return None

    async def _ensure_lark_cli_if_needed(self, command: str, user_id: str) -> str | None:
        """确保 lark-cli 已配置 app 凭证。返回错误/提示信息或 None。

        lark-cli 二进制由宿主侧 scripts/install-feishu-cli.sh 安装到
        <repo_root>/vendor/lark-cli/，沙箱启动时 readonly bind mount 到
        /opt/lark-cli 并加入 PATH，无需 per-user 安装。仅在凭证缺失时
        启动沙箱内 `config init --new` 并把 setup URL 返回给模型。
        """
        if not _needs_lark_cli(command):
            return None

        if not _sandbox_config.lark_cli_bin:
            return "[SANDBOX] lark-cli 未预装（宿主机）。请联系管理员执行: bash scripts/install-feishu-cli.sh"

        from ripple.sandbox.feishu import ensure_lark_cli_config

        success, msg = await ensure_lark_cli_config(_sandbox_config, user_id)
        if success:
            return None

        if msg.startswith("http"):
            return (
                f"[FEISHU_SETUP] 飞书应用尚未配置。请让用户点击以下链接完成配置：\n\n"
                f"  {msg}\n\n"
                f"用户完成配置后，重新执行命令即可。"
            )
        return f"[SANDBOX] lark-cli 准备失败: {msg}"

    async def _ensure_notion_cli_if_needed(self, command: str, user_id: str) -> str | None:
        """确保 notion-cli (ntn) 二进制已挂入沙箱、且当前 user 已绑定 token。

        Token 采用 **per-user 隔离** 模式：每个 user 在 sandboxes/<uid>/credentials/notion.json
        里持有独立的 Integration Token（对该 user 下所有 session 共享）。没配置时返回明确
        的"问用户拿 token + 调 NotionTokenSet 工具"指令，让模型走对话流程完成绑定
        （不依赖任何特定前端 UI）。

        返回 None 表示前置条件满足；非 None 表示错误/提示文本，调用方会 short-circuit。
        """
        if not _needs_notion_cli(command):
            return None

        if not _sandbox_config.notion_cli_install_root:
            return "[SANDBOX] notion-cli (ntn) 未预装（宿主机）。请联系管理员执行: bash scripts/install-notion-cli.sh"

        if not _sandbox_config.has_notion_token(user_id):
            return (
                "[NOTION_AUTH_REQUIRED] 当前用户尚未绑定 Notion Integration Token。\n\n"
                "请按以下步骤处理（不要再次直接调 ntn）：\n"
                "  1. 用一段简短自然语言告知用户：需要他从 "
                "https://www.notion.so/profile/integrations 复制 Internal "
                "Integration Token（格式 `ntn_...` 或 `secret_...`）并直接粘贴到对话里。\n"
                "  2. 提醒用户：把目标 page/database 在 Notion 里 Share 给该 Integration，"
                "否则即使 token 正确也会 404/403。\n"
                "  3. 收到用户贴出的 token 后，**立刻调 `NotionTokenSet` 工具** 完成绑定 "
                "（参数 `api_token=<用户贴的原文>`），然后重跑刚才被拦下的命令。\n"
                "  4. 在你后续的回复里**不要回显完整 token**，最多展示前 6 字符 + `...`。"
            )
        return None

    def _wrap_with_venv_activation(self, command: str, user_id: str) -> str:
        """如果 workspace 内存在 venv，自动在命令前激活它"""
        if _sandbox_config.has_python_venv(user_id):
            return f". /workspace/.venv/bin/activate && {command}"
        return command

    async def _execute_in_sandbox(self, args: BashInput, context: ToolUseContext) -> tuple[str, str, int]:
        """通过 nsjail 在沙箱中执行（user-scoped）"""
        from ripple.sandbox.executor import execute_in_sandbox
        from ripple.sandbox.workspace import check_workspace_quota

        user_id = context.user_id
        if not user_id:
            return "", "[SANDBOX] 当前上下文没有 user_id，无法定位 sandbox", 1

        async def _run() -> tuple[str, str, int]:
            if venv_err := await self._ensure_venv_if_needed(args.command, user_id):
                return "", venv_err, 1

            if pnpm_err := await self._ensure_pnpm_if_needed(args.command, user_id):
                return "", pnpm_err, 1

            if lark_err := await self._ensure_lark_cli_if_needed(args.command, user_id):
                return "", lark_err, 1

            if notion_err := await self._ensure_notion_cli_if_needed(args.command, user_id):
                return "", notion_err, 1

            command = self._wrap_with_venv_activation(args.command, user_id)

            stdout, stderr, exit_code = await execute_in_sandbox(
                command,
                _sandbox_config,
                user_id,
                timeout=args.timeout,
            )

            exceeded, size_bytes = check_workspace_quota(_sandbox_config, user_id)
            if exceeded:
                size_mb = size_bytes / (1024 * 1024)
                stderr += (
                    f"\n[SANDBOX] Warning: workspace size ({size_mb:.1f}MB) "
                    f"exceeds quota ({_sandbox_config.max_workspace_mb}MB)"
                )
            return stdout, stderr, exit_code

        # 同一 user 的多 session 共享 workspace，以 per-user lock 串行化
        # 保护 workspace 级 provisioning（venv/pnpm/lark-cli setup）和文件写入。
        if _sandbox_manager is not None:
            async with _sandbox_manager.user_lock(user_id):
                return await _run()
        return await _run()

    async def _execute_direct(self, args: BashInput, context: ToolUseContext) -> tuple[str, str, int]:
        """直接在宿主机执行（CLI 模式）"""
        proc = await asyncio.create_subprocess_shell(
            args.command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=context.cwd,
        )

        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=args.timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return "", f"Command timed out after {args.timeout} seconds", -1

        stdout = stdout_bytes.decode(errors="replace") if stdout_bytes else ""
        stderr = stderr_bytes.decode(errors="replace") if stderr_bytes else ""
        return stdout, stderr, proc.returncode or 0

    def is_concurrency_safe(self, input: BashInput | dict[str, Any]) -> bool:
        return False

    def _get_parameters_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The bash command to execute",
                },
                "timeout": {
                    "type": "integer",
                    "description": "Timeout in seconds (default: 120)",
                    "default": 120,
                },
            },
            "required": ["command"],
        }

    def requires_confirmation(self, input_params: dict) -> bool:
        command = input_params.get("command", "").lower()

        destructive_patterns = [
            "rm -rf",
            "rm -fr",
            "rm -r",
            "rm ",
            "rmdir",
            "unlink",
            "> /dev/null",
        ]
        git_dangerous = [
            "git push --force",
            "git push -f",
            "git reset --hard",
            "git clean -fd",
            "git branch -d",
            "git branch -D",
            "git rebase",
            "git push",
        ]
        database_dangerous = ["drop table", "drop database", "delete from", "truncate"]
        system_dangerous = [
            "sudo",
            "chmod 777",
            "chmod -r",
            "chown",
            "kill -9",
            "pkill",
            "shutdown",
            "reboot",
            "mkfs",
            "dd if=",
        ]
        package_dangerous = [
            "apt-get remove",
            "apt remove",
            "yum remove",
            "brew uninstall",
            "pip uninstall",
            "npm uninstall -g",
        ]

        all_patterns = destructive_patterns + git_dangerous + database_dangerous + system_dangerous + package_dangerous
        return any(pattern in command for pattern in all_patterns)
