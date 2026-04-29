"""Shared sandbox command runner.

This module keeps the preparation semantics used by BashTool available to
non-chat callers such as scheduled jobs.
"""

import re

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.executor import execute_in_sandbox
from ripple.sandbox.workspace import check_workspace_quota

_PYTHON_CMD_PATTERN = re.compile(
    r"(?:^|&&|\|\||;|\|)\s*(?:uv\s+(?:pip|run|add)|(?:/\S+/)?python3?|(?:/\S+/)?pip3?)\b",
)
_NODE_CMD_PATTERN = re.compile(
    r"(?:^|&&|\|\||;|\|)\s*(?:pnpm|npx|npm|node|corepack)\b",
)
_LARK_CLI_CMD_PATTERN = re.compile(
    r"(?:^|&&|\|\||;|\|)\s*lark-cli\b",
)
_NOTION_CLI_CMD_PATTERN = re.compile(
    r"(?:^|&&|\|\||;|\|)\s*ntn\b",
)


def needs_python_venv(command: str) -> bool:
    return bool(_PYTHON_CMD_PATTERN.search(command))


def needs_node_env(command: str) -> bool:
    return bool(_NODE_CMD_PATTERN.search(command))


def needs_lark_cli(command: str) -> bool:
    return bool(_LARK_CLI_CMD_PATTERN.search(command))


def needs_notion_cli(command: str) -> bool:
    return bool(_NOTION_CLI_CMD_PATTERN.search(command))


async def ensure_venv_if_needed(config: SandboxConfig, command: str, user_id: str) -> str | None:
    """Create the user Python venv lazily when a command needs it."""
    if not needs_python_venv(command):
        return None

    if config.has_python_venv(user_id):
        return None

    from ripple.sandbox.provisioning import ensure_python_venv

    success, msg = await ensure_python_venv(config, user_id)
    if not success:
        return f"[SANDBOX] Failed to initialize Python venv: {msg}"
    return None


async def ensure_pnpm_if_needed(config: SandboxConfig, command: str, user_id: str) -> str | None:
    """Create the user Node/pnpm environment lazily when a command needs it."""
    if not needs_node_env(command):
        return None

    if not config.node_dir:
        return "[SANDBOX] Node.js is not available. Please install Node.js on the host."

    if config.has_pnpm_setup(user_id):
        return None

    from ripple.sandbox.provisioning import ensure_pnpm_setup

    success, msg = await ensure_pnpm_setup(config, user_id)
    if not success:
        return f"[SANDBOX] Failed to initialize pnpm environment: {msg}"
    return None


async def ensure_lark_cli_if_needed(config: SandboxConfig, command: str, user_id: str) -> str | None:
    """Ensure lark-cli is available/configured when the command uses it."""
    if not needs_lark_cli(command):
        return None

    if not config.lark_cli_bin:
        return "[SANDBOX] lark-cli 未预装（宿主机）。请联系管理员执行: bash scripts/install-feishu-cli.sh"

    from ripple.sandbox.feishu import ensure_lark_cli_config

    success, msg = await ensure_lark_cli_config(config, user_id)
    if success:
        return None

    if msg.startswith("http"):
        return (
            f"[FEISHU_SETUP] 飞书应用尚未配置。请让用户点击以下链接完成配置：\n\n"
            f"  {msg}\n\n"
            f"用户完成配置后，重新执行命令即可。"
        )
    return f"[SANDBOX] lark-cli 准备失败: {msg}"


async def ensure_notion_cli_if_needed(config: SandboxConfig, command: str, user_id: str) -> str | None:
    """Ensure notion-cli is available and the current user has a token."""
    if not needs_notion_cli(command):
        return None

    if not config.notion_cli_install_root:
        return "[SANDBOX] notion-cli (ntn) 未预装（宿主机）。请联系管理员执行: bash scripts/install-notion-cli.sh"

    if not config.has_notion_token(user_id):
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


def wrap_with_venv_activation(config: SandboxConfig, command: str, user_id: str) -> str:
    if config.has_python_venv(user_id):
        return f". /workspace/.venv/bin/activate && {command}"
    return command


async def run_sandbox_command(
    command: str,
    config: SandboxConfig,
    user_id: str,
    *,
    timeout: int | None = None,
) -> tuple[str, str, int]:
    """Run a command in a user sandbox with the same preparation BashTool uses."""
    if venv_err := await ensure_venv_if_needed(config, command, user_id):
        return "", venv_err, 1

    if pnpm_err := await ensure_pnpm_if_needed(config, command, user_id):
        return "", pnpm_err, 1

    if lark_err := await ensure_lark_cli_if_needed(config, command, user_id):
        return "", lark_err, 1

    if notion_err := await ensure_notion_cli_if_needed(config, command, user_id):
        return "", notion_err, 1

    command = wrap_with_venv_activation(config, command, user_id)
    stdout, stderr, exit_code = await execute_in_sandbox(command, config, user_id, timeout=timeout)

    exceeded, size_bytes = check_workspace_quota(config, user_id)
    if exceeded:
        size_mb = size_bytes / (1024 * 1024)
        stderr += f"\n[SANDBOX] Warning: workspace size ({size_mb:.1f}MB) exceeds quota ({config.max_workspace_mb}MB)"
    return stdout, stderr, exit_code
