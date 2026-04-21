"""飞书 / lark-cli 凭证注入与配置引导（沙箱内）

设计约定：
1. lark-cli 原生二进制由 `scripts/install-feishu-cli.sh` 安装到项目内
   `<repo_root>/vendor/lark-cli/`（current→vX.Y.Z/bin/lark-cli 布局），
   启动沙箱时将该目录 readonly bind mount 到沙箱内固定路径
   `/opt/lark-cli`，并把 `/opt/lark-cli/current/bin` 注入沙箱 PATH。
   历史 `/opt/lark-cli/` 全局安装路径也被自动识别。
2. per-session 凭证完全隔离：沙箱内 HOME=/workspace，lark-cli 的 app 配置
   自然写到 `/workspace/.lark-cli/config.json`（= 宿主 `workspace_dir/.lark-cli/...`）。
3. `config init --new`（交互式，阻塞等浏览器）改在沙箱内 spawn，宿主进程只
   保留句柄做后台管理 —— 进程输出的任何副作用都在沙箱 /workspace 内。
4. 凭证 seed (`feishu.json`) 通过 stdin pipe 喂给沙箱内 `lark-cli config init
   --app-id X --app-secret-stdin --brand Y`，**绝不**进 argv 或 shell 拼接。
"""

import asyncio
import json
import re
import shlex
from dataclasses import dataclass

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.nsjail_config import build_nsjail_argv, write_nsjail_config
from ripple.utils.logger import get_logger

logger = get_logger("sandbox.feishu")

_lark_cli_config_locks: dict[str, asyncio.Lock] = {}


def _get_feishu_credentials(config: SandboxConfig, session_id: str) -> tuple[str, str, str] | None:
    """读取飞书 app 凭证，返回 (app_id, app_secret, brand) 或 None

    仅从 session 级 feishu.json 读取（严格 per-session 隔离）。
    """
    feishu_file = config.feishu_config_file(session_id)
    if feishu_file.exists():
        try:
            data = json.loads(feishu_file.read_text(encoding="utf-8"))
            app_id = data.get("app_id", "")
            app_secret = data.get("app_secret", "")
            if app_id and app_secret:
                return app_id, app_secret, data.get("brand", "feishu")
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("session {} feishu.json 读取失败: {}", session_id, e)
    return None


@dataclass
class _FeishuSetupState:
    """一个 session 正在进行中的 `lark-cli config init --new` 进程

    进程运行在 nsjail 沙箱内，输出（QR + URL）通过 stdout/stderr 合流抓取。
    """

    process: asyncio.subprocess.Process
    url: str


_feishu_setup_states: dict[str, _FeishuSetupState] = {}


async def _extract_url_from_process(proc: asyncio.subprocess.Process, timeout_seconds: int = 30) -> str:
    """从进程的合并输出中提取 URL（阻塞直到 URL 出现或超时）

    `config init --new` 会先输出 ASCII QR 码再输出 `https://...` 链接，
    总耗时通常 < 5s。此函数逐行读取，匹配到第一个 http(s) URL 即返回。
    """
    url_pattern = re.compile(r"https?://\S+")
    assert proc.stdout is not None
    deadline = asyncio.get_event_loop().time() + timeout_seconds
    while asyncio.get_event_loop().time() < deadline:
        try:
            line = await asyncio.wait_for(proc.stdout.readline(), timeout=5)
        except asyncio.TimeoutError:
            continue
        if not line:
            break
        text = line.decode(errors="replace")
        m = url_pattern.search(text)
        if m:
            return m.group(0)
    return ""


async def _start_feishu_setup(
    config: SandboxConfig,
    session_id: str,
) -> tuple[bool, str]:
    """在沙箱内启动 `lark-cli config init --new`，提取 URL 后立即返回。

    进程保持后台运行直到用户完成浏览器配置；完成后沙箱内会写入
    /workspace/.lark-cli/config.json，宿主侧通过 `has_lark_cli_config` 感知。

    Returns:
        (False, setup_url)  — URL 已就绪，等待用户点击
        (False, error_msg)  — 启动失败
    """
    if not config.lark_cli_bin:
        return False, "lark-cli 未预装（宿主机），无法启动配置流程"

    if not config.nsjail_cfg_file(session_id).exists():
        write_nsjail_config(config, session_id)

    argv = build_nsjail_argv(config, session_id, "lark-cli config init --new 2>&1")

    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )

    url = await _extract_url_from_process(proc)
    if not url:
        proc.kill()
        await proc.wait()
        return False, "无法从 config init --new 输出中提取配置链接"

    _feishu_setup_states[session_id] = _FeishuSetupState(process=proc, url=url)
    logger.info("session {} 飞书配置流程已在沙箱内启动，URL: {}", session_id, url)
    return False, url


async def _check_feishu_setup(
    config: SandboxConfig,
    session_id: str,
) -> tuple[bool, str]:
    """检查沙箱内 config init --new 进程状态。

    Returns:
        (True, "")          — 配置完成，/workspace/.lark-cli/config.json 已生成
        (False, url)        — 仍在等待用户点击
        (False, error_msg)  — 进程异常退出
    """
    state = _feishu_setup_states.get(session_id)
    if not state:
        return False, ""

    if state.process.returncode is None:
        try:
            await asyncio.wait_for(state.process.wait(), timeout=0.1)
        except asyncio.TimeoutError:
            return False, state.url

    exit_code = state.process.returncode
    del _feishu_setup_states[session_id]

    if exit_code != 0:
        return False, f"config init --new 失败 (exit={exit_code})"

    if not config.has_lark_cli_config(session_id):
        return False, "config init --new 退出但未生成 config.json"

    logger.info("session {} 飞书 app 配置完成", session_id)
    return True, ""


async def _inject_feishu_credentials(
    config: SandboxConfig,
    session_id: str,
    app_id: str,
    app_secret: str,
    brand: str,
) -> tuple[bool, str]:
    """将已有的 app 凭证（feishu.json）通过 stdin 注入沙箱内 lark-cli。

    命令参数里只带非敏感的 app_id / brand；app_secret 通过 stdin 传入
    `--app-secret-stdin`，避免 argv / shell 历史 / ps aux 泄漏。
    """
    quoted_app_id = shlex.quote(app_id)
    quoted_brand = shlex.quote(brand)
    inner_cmd = f"lark-cli config init --app-id {quoted_app_id} --app-secret-stdin --brand {quoted_brand} 2>&1"
    argv = build_nsjail_argv(config, session_id, inner_cmd)

    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )

    try:
        stdout_bytes, _ = await asyncio.wait_for(
            proc.communicate(input=f"{app_secret}\n".encode()),
            timeout=30,
        )
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return False, "lark-cli 凭证注入超时"

    output = stdout_bytes.decode(errors="replace") if stdout_bytes else ""
    exit_code = proc.returncode or 0
    if exit_code == 0:
        logger.info("session {} lark-cli app 凭证注入成功", session_id)
        return True, ""
    return False, f"lark-cli 凭证注入失败 (exit={exit_code}): {output.strip()}"


async def ensure_lark_cli_config(
    config: SandboxConfig,
    session_id: str,
) -> tuple[bool, str]:
    """确保沙箱内 lark-cli 已配置 app 凭证。

    三阶段逻辑（lark-cli 二进制由宿主预装，不再有"懒安装"步骤）：
      1. 沙箱内已有 `/workspace/.lark-cli/config.json` → 直接返回
      2. 宿主 feishu.json 有种子凭证 → 通过 stdin 注入沙箱
      3. 无凭证 → 检查或启动沙箱内 `config init --new`，返回 setup URL

    Returns:
        (True, "")          — 配置就绪
        (False, setup_url)  — 需要用户点击链接完成配置
        (False, error_msg)  — 错误
    """
    if not config.lark_cli_bin:
        return False, ("lark-cli 未预装（宿主机）。请管理员执行: bash scripts/install-feishu-cli.sh")

    if config.has_lark_cli_config(session_id):
        return True, ""

    lock = _lark_cli_config_locks.setdefault(session_id, asyncio.Lock())
    async with lock:
        if config.has_lark_cli_config(session_id):
            return True, ""

        # 阶段 2：有 seed 凭证 → stdin 注入
        creds = _get_feishu_credentials(config, session_id)
        if creds:
            app_id, app_secret, brand = creds
            return await _inject_feishu_credentials(config, session_id, app_id, app_secret, brand)

        # 阶段 3：检查/启动沙箱内 config init --new
        if session_id in _feishu_setup_states:
            ok, msg = await _check_feishu_setup(config, session_id)
            if ok:
                return True, ""
            return False, msg

        return await _start_feishu_setup(config, session_id)


# --- user 维度 API (Phase 2-5 过渡期) ---

_lark_cli_config_locks_uid: dict[str, asyncio.Lock] = {}
_feishu_setup_states_uid: dict[str, _FeishuSetupState] = {}


def _get_feishu_credentials_uid(config: SandboxConfig, user_id: str) -> tuple[str, str, str] | None:
    """读取 user 级飞书 app 凭证"""
    feishu_file = config.feishu_config_file_by_uid(user_id)
    if feishu_file.exists():
        try:
            data = json.loads(feishu_file.read_text(encoding="utf-8"))
            app_id = data.get("app_id", "")
            app_secret = data.get("app_secret", "")
            if app_id and app_secret:
                return app_id, app_secret, data.get("brand", "feishu")
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("user {} feishu.json 读取失败: {}", user_id, e)
    return None


async def _start_feishu_setup_uid(
    config: SandboxConfig,
    user_id: str,
) -> tuple[bool, str]:
    """在 user 沙箱内启动 `lark-cli config init --new`（user 版）"""
    from ripple.sandbox.nsjail_config import build_nsjail_argv_uid, write_nsjail_config_uid

    if not config.lark_cli_bin:
        return False, "lark-cli 未预装（宿主机），无法启动配置流程"

    if not config.nsjail_cfg_file_by_uid(user_id).exists():
        write_nsjail_config_uid(config, user_id)

    argv = build_nsjail_argv_uid(config, user_id, "lark-cli config init --new 2>&1")

    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )

    url = await _extract_url_from_process(proc)
    if not url:
        proc.kill()
        await proc.wait()
        return False, "无法从 config init --new 输出中提取配置链接"

    _feishu_setup_states_uid[user_id] = _FeishuSetupState(process=proc, url=url)
    logger.info("user {} 飞书配置流程已在沙箱内启动，URL: {}", user_id, url)
    return False, url


async def _check_feishu_setup_uid(
    config: SandboxConfig,
    user_id: str,
) -> tuple[bool, str]:
    """检查 user 沙箱内 config init --new 进程状态"""
    state = _feishu_setup_states_uid.get(user_id)
    if not state:
        return False, ""

    if state.process.returncode is None:
        try:
            await asyncio.wait_for(state.process.wait(), timeout=0.1)
        except asyncio.TimeoutError:
            return False, state.url

    exit_code = state.process.returncode
    del _feishu_setup_states_uid[user_id]

    if exit_code != 0:
        return False, f"config init --new 失败 (exit={exit_code})"

    if not config.has_lark_cli_config_by_uid(user_id):
        return False, "config init --new 退出但未生成 config.json"

    logger.info("user {} 飞书 app 配置完成", user_id)
    return True, ""


async def _inject_feishu_credentials_uid(
    config: SandboxConfig,
    user_id: str,
    app_id: str,
    app_secret: str,
    brand: str,
) -> tuple[bool, str]:
    """通过 stdin 将 app 凭证注入 user 沙箱内 lark-cli"""
    from ripple.sandbox.nsjail_config import build_nsjail_argv_uid

    quoted_app_id = shlex.quote(app_id)
    quoted_brand = shlex.quote(brand)
    inner_cmd = f"lark-cli config init --app-id {quoted_app_id} --app-secret-stdin --brand {quoted_brand} 2>&1"
    argv = build_nsjail_argv_uid(config, user_id, inner_cmd)

    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )

    try:
        stdout_bytes, _ = await asyncio.wait_for(
            proc.communicate(input=f"{app_secret}\n".encode()),
            timeout=30,
        )
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return False, "lark-cli 凭证注入超时"

    output = stdout_bytes.decode(errors="replace") if stdout_bytes else ""
    exit_code = proc.returncode or 0
    if exit_code == 0:
        logger.info("user {} lark-cli app 凭证注入成功", user_id)
        return True, ""
    return False, f"lark-cli 凭证注入失败 (exit={exit_code}): {output.strip()}"


async def ensure_lark_cli_config_uid(
    config: SandboxConfig,
    user_id: str,
) -> tuple[bool, str]:
    """确保 user 沙箱内 lark-cli 已配置 app 凭证（user 版）"""
    if not config.lark_cli_bin:
        return False, ("lark-cli 未预装（宿主机）。请管理员执行: bash scripts/install-feishu-cli.sh")

    if config.has_lark_cli_config_by_uid(user_id):
        return True, ""

    lock = _lark_cli_config_locks_uid.setdefault(user_id, asyncio.Lock())
    async with lock:
        if config.has_lark_cli_config_by_uid(user_id):
            return True, ""

        creds = _get_feishu_credentials_uid(config, user_id)
        if creds:
            app_id, app_secret, brand = creds
            return await _inject_feishu_credentials_uid(config, user_id, app_id, app_secret, brand)

        if user_id in _feishu_setup_states_uid:
            ok, msg = await _check_feishu_setup_uid(config, user_id)
            if ok:
                return True, ""
            return False, msg

        return await _start_feishu_setup_uid(config, user_id)
