"""nsjail 配置生成

负责为每个 user 生成 `nsjail.cfg` 文件，包括沙箱白名单环境变量、
mount 列表以及资源/命名空间配置。执行逻辑见 `executor.py`。
"""

import os
import textwrap
from pathlib import Path

from ripple.sandbox.config import (
    LARK_CLI_INSTALL_ROOT,
    LARK_CLI_SANDBOX_BIN_DIR,
    NOTION_CLI_INSTALL_ROOT,
    NOTION_CLI_SANDBOX_BIN_DIR,
    SANDBOX_COREPACK_HOME,
    SANDBOX_NODE_BIN,
    SANDBOX_NODE_DIR,
    SANDBOX_NODE_PREFIX,
    SANDBOX_PNPM_STORE,
    SANDBOX_UV_CACHE_PATH,
    SandboxConfig,
)
from ripple.utils.logger import get_logger

logger = get_logger("sandbox.nsjail_config")


def build_sandbox_env(config: SandboxConfig, user_id: str) -> dict[str, str]:
    """构建沙箱最小白名单环境变量（不继承宿主环境）。

    按 user_id 读取 per-user 敏感 env（如 NOTION_API_TOKEN），确保不同 user
    之间严格隔离。
    """
    path_parts = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"]

    if config.uv_bin_dir:
        path_parts.insert(0, config.uv_bin_dir)

    if config.node_dir:
        path_parts.insert(0, f"{SANDBOX_NODE_DIR}/bin")
        path_parts.insert(0, SANDBOX_NODE_BIN)

    # lark-cli 通过 bind-mount 到 /opt/lark-cli，bin 目录显式加入 PATH，
    # 解耦宿主安装位置（vendor/ 或 /opt/），不再依赖 /usr/local/bin/lark-cli 软链。
    if config.lark_cli_install_root:
        path_parts.insert(0, LARK_CLI_SANDBOX_BIN_DIR)

    # notion-cli (ntn) 同 lark-cli 的模式：bind-mount 到 /opt/notion-cli，bin 入 PATH。
    if config.notion_cli_install_root:
        path_parts.insert(0, NOTION_CLI_SANDBOX_BIN_DIR)

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

    # Notion CLI (ntn) 鉴权 token —— **per-user** 严格隔离：
    # 只从该 user 的 credentials/notion.json 读取，没配就完全不注入（bash 守卫会
    # 在命令执行前拦下并提示用户通过 NotionTokenSet 工具绑定）。
    # 这里故意**不**回落到任何全局配置，避免跨 user 泄漏。
    from ripple.sandbox.notion import read_notion_token

    notion_token = read_notion_token(config, user_id)
    if notion_token:
        env["NOTION_API_TOKEN"] = notion_token

    if config.node_dir:
        env["PNPM_HOME"] = SANDBOX_NODE_BIN
        env["PNPM_STORE_DIR"] = SANDBOX_PNPM_STORE
        env["NPM_CONFIG_PREFIX"] = SANDBOX_NODE_PREFIX
        if config.npm_registry_url:
            env["NPM_CONFIG_REGISTRY"] = config.npm_registry_url
            # corepack 下载包管理器自身（如 pnpm）时使用独立的注册源配置
            env["COREPACK_NPM_REGISTRY"] = config.npm_registry_url
        env["COREPACK_ENABLE_AUTO_PIN"] = "0"
        env["COREPACK_ENABLE_DOWNLOAD_PROMPT"] = "0"
        # 跨 user 共享 corepack 缓存，避免每次重下 pnpm 二进制
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


def _build_common_mounts(config: SandboxConfig) -> list[str]:
    """生成与具体 user 无关的公共 mount 列表（bind-mount 共享二进制/缓存/skill 目录）"""
    mounts: list[str] = []

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

    # uv 全局 cache（读写，所有 user 共享；安装时通过 hardlink 共享 inode 去重）
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

    # pnpm content-addressable store（读写，所有 user 共享，通过硬链接去重）
    if config.node_dir:
        pnpm_cache = config.pnpm_cache_dir
        pnpm_cache.mkdir(parents=True, exist_ok=True)
        mounts.append(f"""mount {{
    src: "{pnpm_cache}"
    dst: "{SANDBOX_PNPM_STORE}"
    is_bind: true
    rw: true
}}""")

    # corepack 缓存（读写，所有 user 共享，避免每个 user 重新下载 pnpm）
    if config.node_dir:
        corepack_cache = config.corepack_cache_dir
        corepack_cache.mkdir(parents=True, exist_ok=True)
        mounts.append(f"""mount {{
    src: "{corepack_cache}"
    dst: "{SANDBOX_COREPACK_HOME}"
    is_bind: true
    rw: true
}}""")

    # lark-cli 原生二进制安装根（只读，所有 user 共享）。
    # 宿主侧 install_root（vendor/lark-cli/ 或 /opt/lark-cli/，含 current→vX.Y.Z
    # 软链和 current/bin/lark-cli 二进制）整体挂到沙箱内固定的
    # LARK_CLI_INSTALL_ROOT（/opt/lark-cli），使 current 软链在沙箱内可解析。
    if config.lark_cli_install_root and Path(config.lark_cli_install_root).exists():
        mounts.append(f"""mount {{
    src: "{config.lark_cli_install_root}"
    dst: "{LARK_CLI_INSTALL_ROOT}"
    is_bind: true
    rw: false
}}""")

    # notion-cli (ntn) 原生二进制安装根（只读，所有 user 共享），与 lark-cli 同款。
    if config.notion_cli_install_root and Path(config.notion_cli_install_root).exists():
        mounts.append(f"""mount {{
    src: "{config.notion_cli_install_root}"
    dst: "{NOTION_CLI_INSTALL_ROOT}"
    is_bind: true
    rw: false
}}""")

    # 共享 skill 目录（只读，所有 user 共享）。
    # 以"原路径 → 原路径"挂载，使 Skill 系统提示中替换后的 `$SKILL_BASE_DIR`
    # 宿主绝对路径（见 `skills/types.py`）在沙箱内依然可直接访问，从而允许
    # 在 skill 里用 Bash/Python 调用 skill 目录下的辅助脚本、模板等资源。
    try:
        from ripple.skills.loader import _get_shared_skill_dirs
    except Exception:
        _get_shared_skill_dirs = None  # type: ignore[assignment]
    if _get_shared_skill_dirs is not None:
        try:
            skill_dirs = _get_shared_skill_dirs()
        except Exception as exc:
            logger.warning("枚举共享 skill 目录失败，沙箱将无法访问 $SKILL_BASE_DIR: {}", exc)
            skill_dirs = []
        for skill_root in skill_dirs:
            if not skill_root.exists():
                continue
            src = str(skill_root)
            mounts.append(f"""mount {{
    src: "{src}"
    dst: "{src}"
    is_bind: true
    rw: false
}}""")

    return mounts


def generate_nsjail_config(config: SandboxConfig, user_id: str) -> str:
    """为指定 user 生成 nsjail 配置文件内容"""
    workspace = config.workspace_dir(user_id)
    limits = config.resource_limits

    mounts = _build_common_mounts(config)

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

    sandbox_env = build_sandbox_env(config, user_id)
    envars = [f'envar: "{k}={v}"' for k, v in sandbox_env.items()]
    envars_str = "\n".join(envars)

    return textwrap.dedent(f"""\
        name: "ripple-sandbox-{user_id}"

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


def write_nsjail_config(config: SandboxConfig, user_id: str) -> Path:
    """生成并写入 user 级 nsjail 配置文件"""
    cfg_content = generate_nsjail_config(config, user_id)
    cfg_path = config.nsjail_cfg_file(user_id)
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text(cfg_content, encoding="utf-8")
    logger.debug("写入 user nsjail 配置: {}", cfg_path)
    return cfg_path


def build_nsjail_argv(config: SandboxConfig, user_id: str, command: str) -> list[str]:
    """构造 `nsjail --config X.cfg -- /bin/bash -c CMD` argv。

    若 user 的 cfg 尚未生成则自动写入。调用方负责捕获 stdin/stdout/stderr
    并管理进程生命周期。
    """
    cfg_path = config.nsjail_cfg_file(user_id)
    if not cfg_path.exists():
        write_nsjail_config(config, user_id)
    return [
        config.nsjail_path,
        "--config",
        str(cfg_path),
        "--",
        "/bin/bash",
        "-c",
        command,
    ]
