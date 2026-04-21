"""沙箱运行时环境懒初始化

Python venv / Node.js + pnpm 全局环境首次使用时按需创建。
进程级 lock 按 user_id 互斥，避免并发访问时的目录竞争。
"""

import asyncio

from ripple.sandbox.config import SANDBOX_NODE_BIN, SANDBOX_PNPM_STORE, SandboxConfig
from ripple.sandbox.executor import execute_in_sandbox
from ripple.utils.logger import get_logger

logger = get_logger("sandbox.provisioning")

_venv_locks: dict[str, asyncio.Lock] = {}
_pnpm_locks: dict[str, asyncio.Lock] = {}


_PIP_WRAPPER_SCRIPT = """\
#!/bin/bash
exec uv pip "$@"
"""


def _install_pip_wrappers(config: SandboxConfig, user_id: str) -> None:
    """在 user venv 的 bin/ 下写入 pip/pip3 wrapper，让 pip 命令透明委托给 uv pip"""
    venv_bin = config.workspace_dir(user_id) / ".venv" / "bin"
    if not venv_bin.is_dir():
        return
    for name in ("pip", "pip3"):
        wrapper = venv_bin / name
        if not wrapper.exists():
            wrapper.write_text(_PIP_WRAPPER_SCRIPT, encoding="utf-8")
            wrapper.chmod(0o755)
            logger.debug("写入 {} wrapper: {}", name, wrapper)


async def ensure_python_venv(
    config: SandboxConfig,
    user_id: str,
) -> tuple[bool, str]:
    """懒创建 per-user Python venv（首次需要时调用）

    优先使用 uv venv（<200ms），不可用时回退到 python3 -m venv。
    venv 创建后在 bin/ 下写入 pip/pip3 wrapper 脚本，让 pip install
    透明委托给 uv pip install（避免包装到系统 site-packages）。

    Returns:
        (成功与否, 日志/错误信息)
    """
    if config.has_python_venv(user_id):
        return True, ""

    lock = _venv_locks.setdefault(user_id, asyncio.Lock())
    async with lock:
        if config.has_python_venv(user_id):
            return True, ""

        logger.info("为 user {} 懒创建 Python venv", user_id)

        cmd = "uv venv /workspace/.venv 2>&1 || python3 -m venv /workspace/.venv"
        stdout, stderr, exit_code = await execute_in_sandbox(cmd, config, user_id, timeout=60)

        if exit_code == 0 and config.has_python_venv(user_id):
            _install_pip_wrappers(config, user_id)
            logger.info("user {} Python venv 创建成功（含 pip wrapper）", user_id)
            return True, stdout
        else:
            msg = f"venv 创建失败 (exit={exit_code}): {stderr or stdout}"
            logger.warning("user {} {}", user_id, msg)
            return False, msg


async def ensure_pnpm_setup(
    config: SandboxConfig,
    user_id: str,
) -> tuple[bool, str]:
    """懒初始化 per-user Node.js 全局环境（首次需要时调用）

    创建 /workspace/.local/bin/ 目录，配置 pnpm global-bin-dir 和 store-dir，
    使 pnpm install -g / npm install -g 安装的 CLI 二进制可通过 PATH 直接调用。

    成功后写入 marker 文件 .node-setup-done，避免 mkdir 成功但 pnpm config 失败时的误判。

    Returns:
        (成功与否, 日志/错误信息)
    """
    if not config.node_dir:
        return False, "Node.js not available in sandbox"

    if config.has_pnpm_setup(user_id):
        return True, ""

    lock = _pnpm_locks.setdefault(user_id, asyncio.Lock())
    async with lock:
        if config.has_pnpm_setup(user_id):
            return True, ""

        logger.info("为 user {} 初始化 Node.js 全局环境", user_id)

        marker = "/workspace/.local/.node-setup-done"
        cmd = (
            f"mkdir -p {SANDBOX_NODE_BIN} && "
            f"pnpm config set global-bin-dir {SANDBOX_NODE_BIN} --global && "
            f"pnpm config set store-dir {SANDBOX_PNPM_STORE} --global && "
            # pnpm v10 默认屏蔽 postinstall 等 build scripts，沙箱自身已提供隔离，允许全部
            f"echo 'onlyBuiltDependencies[]=*' >> /workspace/.npmrc && "
            f"touch {marker}"
        )
        stdout, stderr, exit_code = await execute_in_sandbox(cmd, config, user_id, timeout=120)

        if exit_code == 0 and config.has_pnpm_setup(user_id):
            logger.info("user {} Node.js 全局环境初始化成功", user_id)
            return True, stdout
        else:
            msg = f"Node.js 全局环境初始化失败 (exit={exit_code}): {stderr or stdout}"
            logger.warning("user {} {}", user_id, msg)
            return False, msg
