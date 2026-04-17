"""nsjail 命令执行器

所有 server 模式的 bash 命令都通过 nsjail 在命名空间隔离环境中执行。
"""

import asyncio
import os
import shutil
import textwrap
from dataclasses import dataclass as _dc
from pathlib import Path

from ripple.sandbox.config import LARK_CLI_INSTALL_ROOT, SANDBOX_NODE_DIR, SANDBOX_PNPM_STORE, SandboxConfig
from ripple.utils.logger import get_logger

logger = get_logger("sandbox.executor")

SANDBOX_UV_CACHE_PATH = "/uv-cache"
SANDBOX_COREPACK_HOME = "/corepack-cache"

# Node.js 全局安装目录（遵循 ~/.local 约定）
# npm:  NPM_CONFIG_PREFIX=/workspace/.local → bin 在 /workspace/.local/bin/
# pnpm: PNPM_HOME=/workspace/.local/bin → bin 直接在 /workspace/.local/bin/
# 两者的全局 CLI 二进制统一落在 /workspace/.local/bin/，只需一个 PATH 条目
SANDBOX_NODE_PREFIX = "/workspace/.local"
SANDBOX_NODE_BIN = "/workspace/.local/bin"

# per-session 锁，防止并发懒创建时目录竞争
_venv_locks: dict[str, asyncio.Lock] = {}
_pnpm_locks: dict[str, asyncio.Lock] = {}
_lark_cli_config_locks: dict[str, asyncio.Lock] = {}


def check_nsjail_available(nsjail_path: str = "nsjail"):
    """启动时检查 nsjail 是否可用，不可用则直接报错"""
    path = shutil.which(nsjail_path)
    if path is None:
        raise RuntimeError(f"nsjail 未找到 (path={nsjail_path})。请先安装: sudo apt install -y nsjail")
    logger.info("nsjail 可用: {}", path)


def build_sandbox_env(config: SandboxConfig) -> dict[str, str]:
    """构建沙箱最小白名单环境变量（不继承宿主环境）"""
    path_parts = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"]

    if config.uv_bin_dir:
        path_parts.insert(0, config.uv_bin_dir)

    if config.node_dir:
        path_parts.insert(0, f"{SANDBOX_NODE_DIR}/bin")
        # npm/pnpm 全局安装的二进制统一放在 /workspace/.local/bin/
        path_parts.insert(0, SANDBOX_NODE_BIN)

    env = {
        "PATH": ":".join(path_parts),
        "HOME": "/workspace",
        "USER": "sandbox",
        "SHELL": "/bin/bash",
        "TERM": "xterm-256color",
        "LANG": "C.UTF-8",
        "UV_CACHE_DIR": SANDBOX_UV_CACHE_PATH,
        "UV_LINK_MODE": "hardlink",
    }

    if config.pypi_mirror_url:
        env["UV_INDEX_URL"] = config.pypi_mirror_url
        env["PIP_INDEX_URL"] = config.pypi_mirror_url

    # Node.js 包管理器环境变量
    if config.node_dir:
        # pnpm 全局 bin → /workspace/.local/bin/
        env["PNPM_HOME"] = SANDBOX_NODE_BIN
        env["PNPM_STORE_DIR"] = SANDBOX_PNPM_STORE
        # npm 全局 prefix → /workspace/.local/（bin 自动在 prefix/bin/ 下）
        env["NPM_CONFIG_PREFIX"] = SANDBOX_NODE_PREFIX
        if config.npm_registry_url:
            env["NPM_CONFIG_REGISTRY"] = config.npm_registry_url
            # corepack 下载包管理器自身（如 pnpm）时使用独立的注册源配置
            env["COREPACK_NPM_REGISTRY"] = config.npm_registry_url
        env["COREPACK_ENABLE_AUTO_PIN"] = "0"
        env["COREPACK_ENABLE_DOWNLOAD_PROMPT"] = "0"
        # corepack 缓存共享，避免每个 session 重复下载 pnpm 二进制
        env["COREPACK_HOME"] = SANDBOX_COREPACK_HOME

    # 自动继承宿主进程的代理设置（clone_newnet=false 共享网络栈，但 env 是隔离的）
    for var in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "http_proxy",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "NO_PROXY",
        "no_proxy",
    ):
        val = os.environ.get(var)
        if val:
            env[var] = val

    return env


def generate_nsjail_config(config: SandboxConfig, session_id: str) -> str:
    """为指定 session 生成 nsjail 配置文件内容"""
    workspace = config.workspace_dir(session_id)
    limits = config.resource_limits

    mounts = []

    for path_str in config.shared_readonly_paths:
        p = Path(path_str)
        if p.exists():
            mounts.append(f"""mount {{
    src: "{path_str}"
    dst: "{path_str}"
    is_bind: true
    rw: false
}}""")

    # uv 二进制目录（只读），保持原路径以兼容 PATH
    if config.uv_bin_dir:
        uv_dir = Path(config.uv_bin_dir)
        if uv_dir.exists():
            mounts.append(f"""mount {{
    src: "{config.uv_bin_dir}"
    dst: "{config.uv_bin_dir}"
    is_bind: true
    rw: false
}}""")

    # uv 全局 cache（读写，所有 session 共享；安装时通过 hardlink 共享 inode 去重）
    uv_cache = config.uv_cache_dir
    uv_cache.mkdir(parents=True, exist_ok=True)
    mounts.append(f"""mount {{
    src: "{uv_cache}"
    dst: "{SANDBOX_UV_CACHE_PATH}"
    is_bind: true
    rw: true
}}""")

    # Node.js 安装目录（只读，含 bin/ 和 lib/node_modules/）
    if config.node_dir:
        node_dir = Path(config.node_dir)
        if node_dir.exists():
            mounts.append(f"""mount {{
    src: "{config.node_dir}"
    dst: "{SANDBOX_NODE_DIR}"
    is_bind: true
    rw: false
}}""")

    # pnpm content-addressable store（读写，所有 session 共享，通过硬链接去重）
    if config.node_dir:
        pnpm_cache = config.pnpm_cache_dir
        pnpm_cache.mkdir(parents=True, exist_ok=True)
        mounts.append(f"""mount {{
    src: "{pnpm_cache}"
    dst: "{SANDBOX_PNPM_STORE}"
    is_bind: true
    rw: true
}}""")

    # corepack 缓存（读写，所有 session 共享，避免每个 session 重新下载 pnpm）
    if config.node_dir:
        corepack_cache = config.corepack_cache_dir
        corepack_cache.mkdir(parents=True, exist_ok=True)
        mounts.append(f"""mount {{
    src: "{corepack_cache}"
    dst: "{SANDBOX_COREPACK_HOME}"
    is_bind: true
    rw: true
}}""")

    # lark-cli 原生二进制安装根（只读，所有 session 共享）。
    # /usr/local/bin/lark-cli -> /opt/lark-cli/current/bin/lark-cli，必须挂
    # /opt/lark-cli 整个目录 symlink 才能在沙箱内被解析。
    if config.lark_cli_bin and Path(LARK_CLI_INSTALL_ROOT).exists():
        mounts.append(f"""mount {{
    src: "{LARK_CLI_INSTALL_ROOT}"
    dst: "{LARK_CLI_INSTALL_ROOT}"
    is_bind: true
    rw: false
}}""")

    mounts.append(f"""mount {{
    src: "{workspace}"
    dst: "/workspace"
    is_bind: true
    rw: true
}}""")

    mounts.append("""mount {
    dst: "/proc"
    fstype: "proc"
    rw: false
}""")

    mounts.append(f"""mount {{
    dst: "/tmp"
    fstype: "tmpfs"
    rw: true
    options: "size={config.tmpfs_size_mb}M"
}}""")

    for dev in ["/dev/null", "/dev/zero", "/dev/urandom", "/dev/random"]:
        if Path(dev).exists():
            mounts.append(f"""mount {{
    src: "{dev}"
    dst: "{dev}"
    is_bind: true
    rw: false
}}""")

    mounts_str = "\n\n".join(mounts)

    sandbox_env = build_sandbox_env(config)
    envars = [f'envar: "{k}={v}"' for k, v in sandbox_env.items()]
    envars_str = "\n".join(envars)

    return textwrap.dedent(f"""\
        name: "ripple-sandbox-{session_id}"

        mode: ONCE

        clone_newuser: true
        clone_newns: true
        clone_newpid: true
        clone_newipc: true
        clone_newuts: true
        clone_newnet: {"true" if config.clone_newnet else "false"}

        hostname: "sandbox"

        cwd: "/workspace"

        time_limit: {limits.command_timeout}

        rlimit_as_type: INF
        rlimit_cpu_type: SOFT
        rlimit_fsize: {limits.max_file_size_mb}
        rlimit_nofile: 8192
        rlimit_nproc_type: SOFT

        skip_setsid: true
        disable_no_new_privs: false

        keep_env: false

        {envars_str}

        {mounts_str}
    """)


def write_nsjail_config(config: SandboxConfig, session_id: str) -> Path:
    """生成并写入 nsjail 配置文件"""
    cfg_content = generate_nsjail_config(config, session_id)
    cfg_path = config.nsjail_cfg_file(session_id)
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text(cfg_content, encoding="utf-8")
    logger.debug("写入 nsjail 配置: {}", cfg_path)
    return cfg_path


async def execute_in_sandbox(
    command: str,
    config: SandboxConfig,
    session_id: str,
    timeout: int | None = None,
) -> tuple[str, str, int]:
    """在 nsjail 沙箱中执行命令

    Returns:
        (stdout, stderr, exit_code)
    """
    cfg_path = config.nsjail_cfg_file(session_id)
    if not cfg_path.exists():
        cfg_path = write_nsjail_config(config, session_id)

    effective_timeout = timeout or config.resource_limits.command_timeout

    nsjail_cmd = [
        config.nsjail_path,
        "--config",
        str(cfg_path),
        "--",
        "/bin/bash",
        "-c",
        command,
    ]

    logger.debug("nsjail 执行: {}", command[:200])

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


_PIP_WRAPPER_SCRIPT = """\
#!/bin/bash
exec uv pip "$@"
"""


def _install_pip_wrappers(config: SandboxConfig, session_id: str) -> None:
    """在 venv 的 bin/ 目录下写入 pip/pip3 wrapper，让 pip 命令透明委托给 uv pip"""
    venv_bin = config.workspace_dir(session_id) / ".venv" / "bin"
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
    session_id: str,
) -> tuple[bool, str]:
    """懒创建 per-session Python venv（首次需要时调用）

    优先使用 uv venv（<200ms），不可用时回退到 python3 -m venv。
    venv 创建后在 bin/ 下写入 pip/pip3 wrapper 脚本，让 pip install
    透明委托给 uv pip install（避免包装到系统 site-packages）。

    Returns:
        (成功与否, 日志/错误信息)
    """
    if config.has_python_venv(session_id):
        return True, ""

    lock = _venv_locks.setdefault(session_id, asyncio.Lock())
    async with lock:
        if config.has_python_venv(session_id):
            return True, ""

        logger.info("为 session {} 懒创建 Python venv", session_id)

        cmd = "uv venv /workspace/.venv 2>&1 || python3 -m venv /workspace/.venv"
        stdout, stderr, exit_code = await execute_in_sandbox(cmd, config, session_id, timeout=60)

        if exit_code == 0 and config.has_python_venv(session_id):
            _install_pip_wrappers(config, session_id)
            logger.info("session {} Python venv 创建成功（含 pip wrapper）", session_id)
            return True, stdout
        else:
            msg = f"venv 创建失败 (exit={exit_code}): {stderr or stdout}"
            logger.warning("session {} {}", session_id, msg)
            return False, msg


# ---------------------------------------------------------------------------
# Node.js / pnpm 环境初始化
# ---------------------------------------------------------------------------


async def ensure_pnpm_setup(
    config: SandboxConfig,
    session_id: str,
) -> tuple[bool, str]:
    """懒初始化 per-session Node.js 全局环境（首次需要时调用）

    创建 /workspace/.local/bin/ 目录，配置 pnpm global-bin-dir 和 store-dir，
    使 pnpm install -g / npm install -g 安装的 CLI 二进制可通过 PATH 直接调用。

    成功后写入 marker 文件 .node-setup-done，避免 mkdir 成功但 pnpm config 失败时的误判。

    Returns:
        (成功与否, 日志/错误信息)
    """
    if not config.node_dir:
        return False, "Node.js not available in sandbox"

    if config.has_pnpm_setup(session_id):
        return True, ""

    lock = _pnpm_locks.setdefault(session_id, asyncio.Lock())
    async with lock:
        if config.has_pnpm_setup(session_id):
            return True, ""

        logger.info("为 session {} 初始化 Node.js 全局环境", session_id)

        marker = "/workspace/.local/.node-setup-done"
        cmd = (
            f"mkdir -p {SANDBOX_NODE_BIN} && "
            f"pnpm config set global-bin-dir {SANDBOX_NODE_BIN} --global && "
            f"pnpm config set store-dir {SANDBOX_PNPM_STORE} --global && "
            # pnpm v10 默认屏蔽 postinstall 等 build scripts，沙箱自身已提供隔离，允许全部
            f"echo 'onlyBuiltDependencies[]=*' >> /workspace/.npmrc && "
            f"touch {marker}"
        )
        stdout, stderr, exit_code = await execute_in_sandbox(cmd, config, session_id, timeout=120)

        if exit_code == 0 and config.has_pnpm_setup(session_id):
            logger.info("session {} Node.js 全局环境初始化成功", session_id)
            return True, stdout
        else:
            msg = f"Node.js 全局环境初始化失败 (exit={exit_code}): {stderr or stdout}"
            logger.warning("session {} {}", session_id, msg)
            return False, msg


# ---------------------------------------------------------------------------
# lark-cli 配置流程（二进制由宿主机预装 + bind mount 提供）
# ---------------------------------------------------------------------------
#
# 设计约定：
# 1. lark-cli 原生二进制由宿主机 scripts/install-feishu-cli.sh 预装，路径
#    /usr/local/bin/lark-cli -> /opt/lark-cli/current/bin/lark-cli，
#    /opt/lark-cli 以只读方式 bind mount 进所有沙箱。
# 2. per-session 凭证完全隔离：沙箱内 HOME=/workspace，lark-cli 的 app 配置
#    自然写到 /workspace/.lark-cli/config.json（= 宿主 workspace_dir/.lark-cli/...）。
# 3. `config init --new`（交互式，阻塞等浏览器）改在沙箱内 spawn，宿主进程只
#    保留句柄做后台管理 — 进程输出的任何副作用都在沙箱 /workspace 内。
# 4. 凭证 seed (feishu.json) 通过 stdin pipe 喂给沙箱内 `lark-cli config init
#    --app-id X --app-secret-stdin --brand Y`，**绝不**进 argv 或 shell 拼接。


def _get_feishu_credentials(config: SandboxConfig, session_id: str) -> tuple[str, str, str] | None:
    """读取飞书 app 凭证，返回 (app_id, app_secret, brand) 或 None

    仅从 session 级 feishu.json 读取（严格 per-session 隔离）。
    """
    import json

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


@_dc
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
    import re

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


def _build_nsjail_argv(config: SandboxConfig, session_id: str, command: str) -> list[str]:
    """构造 nsjail + bash -c 的命令行，复用已有的 per-session nsjail.cfg。

    cfg 文件必须已存在（调用方应先经过 execute_in_sandbox 或 write_nsjail_config）。
    """
    cfg_path = config.nsjail_cfg_file(session_id)
    if not cfg_path.exists():
        write_nsjail_config(config, session_id)
    return [
        config.nsjail_path,
        "--config",
        str(cfg_path),
        "--",
        "/bin/bash",
        "-c",
        command,
    ]


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

    # 确保 nsjail cfg 已生成
    if not config.nsjail_cfg_file(session_id).exists():
        write_nsjail_config(config, session_id)

    argv = _build_nsjail_argv(config, session_id, "lark-cli config init --new 2>&1")

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

    # config init --new 正常退出会把凭证写到 /workspace/.lark-cli/config.json
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
    import shlex

    # app_id / brand 通过 shlex.quote 严格转义；app_secret 不入命令行
    quoted_app_id = shlex.quote(app_id)
    quoted_brand = shlex.quote(brand)
    inner_cmd = f"lark-cli config init --app-id {quoted_app_id} --app-secret-stdin --brand {quoted_brand} 2>&1"
    argv = _build_nsjail_argv(config, session_id, inner_cmd)

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
