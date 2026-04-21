"""nsjail 命令执行器

所有 server 模式的 bash 命令都通过 nsjail 在命名空间隔离环境中执行。
仅负责"执行" —— 配置生成见 `nsjail_config.py`，环境懒初始化见
`provisioning.py`，飞书凭证注入见 `feishu.py`。
"""

import asyncio
import shutil

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.nsjail_config import build_nsjail_argv, write_nsjail_config
from ripple.utils.logger import get_logger

logger = get_logger("sandbox.executor")


def check_nsjail_available(nsjail_path: str = "nsjail"):
    """启动时检查 nsjail 是否可用，不可用则直接报错"""
    path = shutil.which(nsjail_path)
    if path is None:
        raise RuntimeError(f"nsjail 未找到 (path={nsjail_path})。请先安装: sudo apt install -y nsjail")
    logger.info("nsjail 可用: {}", path)


async def execute_in_sandbox(
    command: str,
    config: SandboxConfig,
    user_id: str,
    timeout: int | None = None,
) -> tuple[str, str, int]:
    """在 user 的 nsjail 沙箱中执行命令。

    Returns:
        (stdout, stderr, exit_code)
    """
    cfg_path = config.nsjail_cfg_file(user_id)
    if not cfg_path.exists():
        write_nsjail_config(config, user_id)

    effective_timeout = timeout or config.resource_limits.command_timeout
    nsjail_cmd = build_nsjail_argv(config, user_id, command)

    logger.debug("nsjail 执行 (user={}): {}", user_id, command[:200])

    proc = await asyncio.create_subprocess_exec(
        *nsjail_cmd,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    try:
        stdout_bytes, stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=effective_timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return "", f"Command timed out after {effective_timeout} seconds", -1

    stdout = stdout_bytes.decode(errors="replace") if stdout_bytes else ""
    stderr = stderr_bytes.decode(errors="replace") if stderr_bytes else ""

    nsjail_log_prefixes = ("[I]", "[D]", "[W]", "[E]", "[F]")
    filtered_stderr_lines = []
    for line in stderr.splitlines():
        if any(line.startswith(p) for p in nsjail_log_prefixes):
            continue
        filtered_stderr_lines.append(line)
    filtered_stderr = "\n".join(filtered_stderr_lines)

    return stdout, filtered_stderr, proc.returncode or 0
