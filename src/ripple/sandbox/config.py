"""沙箱配置"""

import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path

PYPI_MIRROR_TSINGHUA = "https://pypi.tuna.tsinghua.edu.cn/simple"
NPM_MIRROR_NPMMIRROR = "https://registry.npmmirror.com"

SANDBOX_NODE_DIR = "/opt/node"
SANDBOX_PNPM_STORE = "/pnpm-store"

# uv / corepack 缓存路径（所有 session 共享，通过 bind mount rw 挂入沙箱）
SANDBOX_UV_CACHE_PATH = "/uv-cache"
SANDBOX_COREPACK_HOME = "/corepack-cache"

# Node.js 全局安装目录（遵循 ~/.local 约定）
# npm:  NPM_CONFIG_PREFIX=/workspace/.local → bin 在 /workspace/.local/bin/
# pnpm: PNPM_HOME=/workspace/.local/bin → bin 直接在 /workspace/.local/bin/
# 两者的全局 CLI 二进制统一落在 /workspace/.local/bin/，只需一个 PATH 条目
SANDBOX_NODE_PREFIX = "/workspace/.local"
SANDBOX_NODE_BIN = "/workspace/.local/bin"

# lark-cli 在**沙箱内**的挂载目的地（dst）。
# 宿主侧的安装根目录由 scripts/install-feishu-cli.sh 决定（默认项目内
# `<repo_root>/vendor/lark-cli/`，或历史上的 `/opt/lark-cli/`），运行时发现后
# 以 readonly bind mount 方式挂到这个固定路径，使沙箱内路径与安装来源解耦。
# 二进制布局（不论宿主哪种安装方式，沙箱内始终一致）：
#   /opt/lark-cli/vX.Y.Z/bin/lark-cli
#   /opt/lark-cli/current -> vX.Y.Z
LARK_CLI_INSTALL_ROOT = "/opt/lark-cli"
LARK_CLI_SANDBOX_BIN_DIR = f"{LARK_CLI_INSTALL_ROOT}/current/bin"
LARK_CLI_SANDBOX_BIN = f"{LARK_CLI_SANDBOX_BIN_DIR}/lark-cli"

# notion-cli (ntn) 在**沙箱内**的挂载目的地（dst）。
# 宿主侧的安装根目录由 scripts/install-notion-cli.sh 决定（项目内
# `<repo_root>/vendor/notion-cli/`），运行时发现后以 readonly bind mount
# 方式挂到这个固定路径，与 lark-cli 同款模式。
#   /opt/notion-cli/vX.Y.Z/bin/ntn
#   /opt/notion-cli/current -> vX.Y.Z
NOTION_CLI_INSTALL_ROOT = "/opt/notion-cli"
NOTION_CLI_SANDBOX_BIN_DIR = f"{NOTION_CLI_INSTALL_ROOT}/current/bin"
NOTION_CLI_SANDBOX_BIN = f"{NOTION_CLI_SANDBOX_BIN_DIR}/ntn"

# gogcli (gog) 在**沙箱内**的挂载目的地。
# 宿主侧安装根由 scripts/install-gogcli-cli.sh 决定（`<repo_root>/vendor/gogcli-cli/`），
# 运行时 readonly bind-mount 到沙箱内固定路径。
#   /opt/gogcli-cli/vX.Y.Z/bin/gog
#   /opt/gogcli-cli/current -> vX.Y.Z
GOGCLI_CLI_INSTALL_ROOT = "/opt/gogcli-cli"
GOGCLI_CLI_SANDBOX_BIN_DIR = f"{GOGCLI_CLI_INSTALL_ROOT}/current/bin"
GOGCLI_CLI_SANDBOX_BIN = f"{GOGCLI_CLI_SANDBOX_BIN_DIR}/gog"


_USER_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


def validate_user_id(user_id: str) -> str:
    """校验 user_id 合法性（防路径穿越），返回原值。非法抛 ValueError。"""
    if not isinstance(user_id, str) or not _USER_ID_RE.match(user_id):
        raise ValueError(f"Invalid user_id: {user_id!r}")
    return user_id


@dataclass
class ResourceLimits:
    """沙箱资源限制"""

    max_memory_mb: int = 4096
    max_cpu_ms_per_sec: int = 500
    max_file_size_mb: int = 1024
    max_pids: int = 512
    command_timeout: int = 300


def _default_caches_root() -> Path:
    from ripple.utils.paths import SANDBOXES_CACHE_DIR

    return SANDBOXES_CACHE_DIR


def _default_sandboxes_root() -> Path:
    from ripple.utils.paths import SANDBOXES_DIR

    return SANDBOXES_DIR


def _discover_uv_bin_dir() -> str | None:
    """自动发现 uv 二进制所在目录"""
    uv_path = shutil.which("uv")
    if uv_path:
        return str(Path(uv_path).resolve().parent)
    return None


def _discover_node_dir() -> str | None:
    """自动发现 Node.js 安装根目录（含 bin/ 和 lib/）

    node、npm、pnpm、npx 等二进制位于 bin/ 下且通过符号链接指向 ../lib/node_modules/，
    因此需要挂载整个安装目录而非仅 bin/。
    """
    node_path = shutil.which("node")
    if node_path:
        real_path = Path(node_path).resolve()
        # node 二进制通常位于 <install_root>/bin/node
        if real_path.parent.name == "bin":
            return str(real_path.parent.parent)
    return None


def _repo_root() -> Path:
    """从本文件位置推出仓库根（src/ripple/sandbox/config.py → 3 层上）"""
    return Path(__file__).resolve().parents[3]


def _discover_lark_cli_install_root() -> str | None:
    """自动发现 lark-cli 的**宿主侧安装根目录**（用于 bind-mount 到沙箱）。

    要求目录结构为 `<root>/current/bin/lark-cli`。探测顺序：
      1. 项目内（scripts/install-feishu-cli.sh 默认位置）：
         `<repo_root>/vendor/lark-cli/`
      2. 宿主全局（历史位置）：`/opt/lark-cli/`

    返回任一命中的路径，否则 None。
    """
    candidates = [
        _repo_root() / "vendor" / "lark-cli",
        Path("/opt/lark-cli"),
    ]
    for root in candidates:
        if (root / "current" / "bin" / "lark-cli").exists():
            return str(root)
    return None


def _discover_notion_cli_install_root() -> str | None:
    """自动发现 notion-cli (ntn) 的**宿主侧安装根目录**（用于 bind-mount 到沙箱）。

    要求目录结构为 `<root>/current/bin/ntn`。探测顺序：
      1. 项目内（scripts/install-notion-cli.sh 默认位置）：
         `<repo_root>/vendor/notion-cli/`
      2. 宿主全局（备用）：`/opt/notion-cli/`

    返回任一命中的路径，否则 None。
    """
    candidates = [
        _repo_root() / "vendor" / "notion-cli",
        Path("/opt/notion-cli"),
    ]
    for root in candidates:
        if (root / "current" / "bin" / "ntn").exists():
            return str(root)
    return None


def _discover_gogcli_cli_install_root() -> str | None:
    """自动发现 gogcli (gog) 的**宿主侧安装根目录**（用于 bind-mount 到沙箱）。

    优先级：
      1. 项目内（scripts/install-gogcli-cli.sh 默认位置）：
         `<repo_root>/vendor/gogcli-cli/`
      2. 宿主全局（备用）：`/opt/gogcli-cli/`
    要求该目录下含 `current/bin/gog`。
    """
    candidates = [
        _repo_root() / "vendor" / "gogcli-cli",
        Path("/opt/gogcli-cli"),
    ]
    for root in candidates:
        gog = root / "current" / "bin" / "gog"
        if gog.exists() and gog.is_file():
            return str(root)
    return None


def _discover_lark_cli_bin() -> str | None:
    """自动发现 lark-cli 二进制的宿主路径（仅作可用性判据）。

    探测顺序：
      1. 已发现的 install_root 下的 current/bin/lark-cli（vendor/ 或 /opt/）
      2. /usr/local/bin/lark-cli（遗留 symlink，实际目标需自行可挂入沙箱）
      3. `shutil.which("lark-cli")`

    注意：这里返回的是**宿主路径**，沙箱内不一定可以按同名访问 —— 沙箱内
    的实际可调用路径取决于 nsjail 的 bind-mount 结果，由 install_root
    决定。
    """
    root = _discover_lark_cli_install_root()
    if root:
        return str(Path(root) / "current" / "bin" / "lark-cli")

    default = Path("/usr/local/bin/lark-cli")
    if default.exists() or default.is_symlink():
        return str(default)
    found = shutil.which("lark-cli")
    if found:
        return found
    return None


def _discover_pnpm_store_dir() -> str | None:
    """自动发现 pnpm content-addressable store 目录"""
    pnpm_path = shutil.which("pnpm")
    if not pnpm_path:
        return None
    import subprocess

    try:
        result = subprocess.run(
            [pnpm_path, "store", "path"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            store_path = Path(result.stdout.strip())
            # pnpm store path 返回的是 v10 子目录，取其父目录作为 store 根
            if store_path.name.startswith("v") and store_path.parent.name == "store":
                return str(store_path.parent)
            return str(store_path)
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return None


@dataclass
class SandboxConfig:
    """沙箱配置（nsjail 隔离）

    目录布局（user 维度）：
    - sandboxes_root/<user_id>/
        ├── workspace/                    ← user 持久工作区
        ├── nsjail.cfg                    ← user 级沙箱配置
        ├── credentials/{feishu.json, notion.json}
        └── sessions/<sid>/               ← 每个 session 的运行时状态
            ├── meta.json, messages.jsonl, tasks.json
            └── task-outputs/
    - caches_root/
        ├── uv-cache/
        ├── corepack-cache/
        └── pnpm-store/                   (可选)
    """

    sandboxes_root: Path = field(default_factory=lambda: _default_sandboxes_root())
    caches_root: Path = field(default_factory=lambda: _default_caches_root())

    resource_limits: ResourceLimits = field(default_factory=ResourceLimits)

    idle_suspend_seconds: int = 1800
    retention_seconds: int = 86400 * 7

    nsjail_path: str = "nsjail"

    shared_readonly_paths: list[str] = field(
        default_factory=lambda: [
            "/usr",
            "/lib",
            "/lib64",
            "/bin",
            "/sbin",
            "/etc/resolv.conf",
            "/etc/ssl",
            "/etc/ca-certificates",
        ]
    )

    clone_newnet: bool = False

    tmpfs_size_mb: int = 512

    max_workspace_mb: int = 2048

    # --- Python / uv ---
    uv_bin_dir: str | None = field(default=None)
    pypi_mirror_url: str = field(default=PYPI_MIRROR_TSINGHUA)

    # --- Node.js / pnpm ---
    node_dir: str | None = field(default=None)
    pnpm_store_dir: str | None = field(default=None)
    npm_registry_url: str = field(default=NPM_MIRROR_NPMMIRROR)

    # --- lark-cli ---
    # lark_cli_install_root: 宿主侧安装根目录，要求含 `current/bin/lark-cli`。
    #   运行时 readonly bind-mount 到沙箱内 LARK_CLI_INSTALL_ROOT（/opt/lark-cli）。
    #   由 scripts/install-feishu-cli.sh 默认写入 <repo_root>/vendor/lark-cli/。
    # lark_cli_bin: 宿主二进制路径（仅用于可用性检测 + 日志），可与 install_root 无关。
    lark_cli_install_root: str | None = field(default=None)
    lark_cli_bin: str | None = field(default=None)

    # --- notion-cli (ntn) ---
    # notion_cli_install_root: 宿主侧安装根目录，要求含 `current/bin/ntn`。
    #   运行时 readonly bind-mount 到沙箱内 NOTION_CLI_INSTALL_ROOT（/opt/notion-cli）。
    #   由 scripts/install-notion-cli.sh 默认写入 <repo_root>/vendor/notion-cli/。
    # 注意：Notion Integration Token 采用 **per-user** 存储模式（见
    # `notion_config_file(user_id)` → sandbox_dir/credentials/notion.json），
    # 沙箱启动时动态读取并注入 env NOTION_API_TOKEN。此处不持有全局 token，保证严格隔离。
    notion_cli_install_root: str | None = field(default=None)
    gogcli_cli_install_root: str | None = field(default=None)

    def __post_init__(self):
        self.sandboxes_root = Path(self.sandboxes_root)
        self.caches_root = Path(self.caches_root)
        if self.uv_bin_dir is None:
            self.uv_bin_dir = _discover_uv_bin_dir()
        if self.node_dir is None:
            self.node_dir = _discover_node_dir()
        if self.pnpm_store_dir is None:
            self.pnpm_store_dir = _discover_pnpm_store_dir()
        if self.lark_cli_install_root is None:
            self.lark_cli_install_root = _discover_lark_cli_install_root()
        if self.lark_cli_bin is None:
            self.lark_cli_bin = _discover_lark_cli_bin()
        if self.notion_cli_install_root is None:
            self.notion_cli_install_root = _discover_notion_cli_install_root()
        if self.gogcli_cli_install_root is None:
            self.gogcli_cli_install_root = _discover_gogcli_cli_install_root()

    @property
    def uv_cache_dir(self) -> Path:
        """全局共享的 uv cache 目录（所有 session 共用，通过硬链接去重）"""
        return self.caches_root / "uv-cache"

    @property
    def pnpm_cache_dir(self) -> Path:
        """全局共享的 pnpm store 目录（所有 session 共用，通过硬链接去重）

        如果宿主机已有 pnpm store 且与 caches_root 在同一文件系统上，
        则直接使用宿主机 store（最大化硬链接共享）；否则在 caches_root 下新建。
        """
        if self.pnpm_store_dir:
            return Path(self.pnpm_store_dir)
        return self.caches_root / "pnpm-store"

    @property
    def corepack_cache_dir(self) -> Path:
        """全局共享的 corepack 缓存目录（所有 session 共用）

        corepack 负责下载 pnpm 等包管理器自身的二进制。共享此缓存后，
        只有第一个 session 需要下载，后续 session 直接复用。
        """
        return self.caches_root / "corepack-cache"

    # --- user 维度路径方法 ---

    def sandbox_dir(self, user_id: str) -> Path:
        validate_user_id(user_id)
        return self.sandboxes_root / user_id

    def workspace_dir(self, user_id: str) -> Path:
        return self.sandbox_dir(user_id) / "workspace"

    def nsjail_cfg_file(self, user_id: str) -> Path:
        return self.sandbox_dir(user_id) / "nsjail.cfg"

    def feishu_config_file(self, user_id: str) -> Path:
        """user 级飞书凭证配置文件路径（宿主机侧）"""
        return self.sandbox_dir(user_id) / "credentials" / "feishu.json"

    def bilibili_config_file(self, user_id: str) -> Path:
        """user 级 Bilibili 凭证 JSON 路径（宿主侧，per-user）。

        文件内容格式（由 `sandbox/bilibili.py` 维护）:
            {"sessdata": "...", "bili_jct": "...", "dede_user_id": "...",
             "uname": "...", "mid": 123, "bound_at": 123, "expires_at": 123}

        与 Notion/gogcli 的差异：SESSDATA **不**作为 env 注入，而是把整个 JSON
        以 readonly bind-mount 挂进沙箱的 `/workspace/.bilibili/sessdata.json`，
        这样 bilibili 相关的 pipeline 脚本能直接读到 sessdata + bili_jct 等多字段。
        """
        validate_user_id(user_id)
        return self.sandbox_dir(user_id) / "credentials" / "bilibili.json"

    def notion_config_file(self, user_id: str) -> Path:
        """user 级 Notion Integration Token 文件路径（宿主机侧，per-user）

        文件内容格式: {"api_token": "ntn_xxx..."}

        **绝不**挂进沙箱 /workspace（免得用户脚本意外读到）；仅由
        `ripple.sandbox.notion.read_notion_token` 在构造沙箱 env 时读取。
        """
        return self.sandbox_dir(user_id) / "credentials" / "notion.json"

    def gogcli_client_config_file(self, user_id: str) -> Path:
        """Desktop OAuth client_secret.json 的宿主侧落盘路径（不入沙箱）。

        `GoogleWorkspaceClientConfigSet` 工具把用户贴的 JSON 原文写这里；
        `ripple.sandbox.gogcli.read_gogcli_client_config` 在构造沙箱 env 时读取。
        """
        validate_user_id(user_id)
        return self.sandbox_dir(user_id) / "credentials" / "gogcli-client.json"

    def gogcli_keyring_pass_file(self, user_id: str) -> Path:
        """gogcli keyring (backend=file) 的加密密码宿主侧存放路径。

        首次 gog 鉴权动作前由 ripple 随机生成 32B 密码写入 (mode 0600)，
        沙箱启动时作为 env `GOG_KEYRING_PASSWORD` 注入；agent/user 都不可见。
        """
        validate_user_id(user_id)
        return self.sandbox_dir(user_id) / "credentials" / "gogcli-keyring.pass"

    def session_dir(self, user_id: str, session_id: str) -> Path:
        return self.sandbox_dir(user_id) / "sessions" / session_id

    def meta_file(self, user_id: str, session_id: str) -> Path:
        return self.session_dir(user_id, session_id) / "meta.json"

    def messages_file(self, user_id: str, session_id: str) -> Path:
        return self.session_dir(user_id, session_id) / "messages.jsonl"

    def model_messages_file(self, user_id: str, session_id: str) -> Path:
        return self.session_dir(user_id, session_id) / "model_messages.jsonl"

    def tasks_file(self, user_id: str, session_id: str) -> Path:
        """TaskCreate/Update/Get/List 工具的 todo 持久化文件"""
        return self.session_dir(user_id, session_id) / "tasks.json"

    def task_outputs_dir(self, user_id: str, session_id: str) -> Path:
        """AgentTool 后台任务的输出目录"""
        return self.session_dir(user_id, session_id) / "task-outputs"

    def has_python_venv(self, user_id: str) -> bool:
        """检查 user workspace 内是否已创建 Python venv"""
        return (self.workspace_dir(user_id) / ".venv" / "pyvenv.cfg").exists()

    def has_pnpm_setup(self, user_id: str) -> bool:
        """检查 user workspace 内是否已成功初始化 Node.js 全局环境

        使用 marker 文件而非目录存在判断，避免 mkdir 成功但后续配置失败时的误判。
        """
        return (self.workspace_dir(user_id) / ".local" / ".node-setup-done").exists()

    def has_lark_cli_config(self, user_id: str) -> bool:
        """检查 user 是否已配置 lark-cli app 凭证

        判定依据：沙箱内 `$HOME=/workspace`，lark-cli 把 app 配置写到
        `/workspace/.lark-cli/config.json`，对应宿主 workspace 目录下的同路径。
        """
        return (self.workspace_dir(user_id) / ".lark-cli" / "config.json").exists()

    def has_notion_token(self, user_id: str) -> bool:
        """检查 user 是否已配置 Notion Integration Token

        判定依据：credentials/notion.json 存在且有非空 api_token 字段。
        不读取文件内容的合法性校验（留给 write 端），只看"是否可用"。
        """
        f = self.notion_config_file(user_id)
        if not f.exists():
            return False
        try:
            import json

            data = json.loads(f.read_text(encoding="utf-8"))
            token = data.get("api_token", "")
            return isinstance(token, str) and bool(token.strip())
        except (json.JSONDecodeError, OSError):
            return False

    def has_bilibili_credential(self, user_id: str) -> bool:
        """判定依据：credentials/bilibili.json 存在且含非空 sessdata 字段。

        只做结构性判定（是否能拿到一串 token），不校验 SESSDATA 在 B 站侧
        是否仍然有效 —— 有效性是 `sandbox/bilibili.py::verify_credential_live`
        的职责，它会实际打 /x/web-interface/nav 接口。
        """
        f = self.bilibili_config_file(user_id)
        if not f.exists():
            return False
        try:
            import json

            data = json.loads(f.read_text(encoding="utf-8"))
            sessdata = data.get("sessdata", "") if isinstance(data, dict) else ""
            return isinstance(sessdata, str) and bool(sessdata.strip())
        except (json.JSONDecodeError, OSError):
            return False

    def has_gogcli_client_config(self, user_id: str) -> bool:
        """判定依据：credentials/gogcli-client.json 存在且非空。

        不校验 JSON 合法性（那是 `write_gogcli_client_config` 负责的）。
        """
        f = self.gogcli_client_config_file(user_id)
        try:
            return f.exists() and f.stat().st_size > 0
        except OSError:
            return False

    def has_gogcli_login(self, user_id: str) -> bool:
        """判定依据：`workspace/.config/gogcli/keyring/` 目录下有非空文件。

        gogcli backend=file 会把加密 credentials 写进 keyring 目录；只要里面有
        任何非空文件，就说明至少跑成功过一次 `gog auth add`。
        这个检测对 agent 引导很重要（`has_gogcli_login=False` → 引导 OAuth login）。
        """
        d = self.workspace_dir(user_id) / ".config" / "gogcli" / "keyring"
        if not d.exists() or not d.is_dir():
            return False
        try:
            for entry in d.iterdir():
                if entry.is_file() and entry.stat().st_size > 0:
                    return True
        except OSError:
            return False
        return False

    @classmethod
    def from_dict(cls, data: dict) -> "SandboxConfig":
        sandboxes_root = Path(data["sandboxes_root"]) if "sandboxes_root" in data else _default_sandboxes_root()
        caches_root = Path(data["caches_root"]) if "caches_root" in data else _default_caches_root()

        limits_data = data.get("resource_limits", {})
        limits = ResourceLimits(
            max_memory_mb=limits_data.get("max_memory_mb", 4096),
            max_cpu_ms_per_sec=limits_data.get("max_cpu_ms_per_sec", 500),
            max_file_size_mb=limits_data.get("max_file_size_mb", 1024),
            max_pids=limits_data.get("max_pids", 512),
            command_timeout=limits_data.get("command_timeout", 300),
        )

        default_shared = [
            "/usr",
            "/lib",
            "/lib64",
            "/bin",
            "/sbin",
            "/etc/resolv.conf",
            "/etc/ssl",
            "/etc/ca-certificates",
        ]
        shared = data.get("shared_readonly_paths", default_shared)

        return cls(
            sandboxes_root=sandboxes_root,
            caches_root=caches_root,
            resource_limits=limits,
            idle_suspend_seconds=data.get("idle_suspend_seconds", 1800),
            retention_seconds=data.get("retention_seconds", 86400 * 7),
            nsjail_path=data.get("nsjail_path", "nsjail"),
            shared_readonly_paths=shared,
            clone_newnet=data.get("clone_newnet", False),
            tmpfs_size_mb=data.get("tmpfs_size_mb", 512),
            max_workspace_mb=data.get("max_workspace_mb", 2048),
            uv_bin_dir=data.get("uv_bin_dir"),
            pypi_mirror_url=data.get("pypi_mirror_url", PYPI_MIRROR_TSINGHUA),
            node_dir=data.get("node_dir"),
            pnpm_store_dir=data.get("pnpm_store_dir"),
            npm_registry_url=data.get("npm_registry_url", NPM_MIRROR_NPMMIRROR),
            lark_cli_install_root=data.get("lark_cli_install_root"),
            lark_cli_bin=data.get("lark_cli_bin"),
            notion_cli_install_root=data.get("notion_cli_install_root"),
            gogcli_cli_install_root=data.get("gogcli_cli_install_root"),
        )
