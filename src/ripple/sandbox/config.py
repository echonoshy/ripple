"""沙箱配置"""

import shutil
from dataclasses import dataclass, field
from pathlib import Path

PYPI_MIRROR_TSINGHUA = "https://pypi.tuna.tsinghua.edu.cn/simple"


@dataclass
class ResourceLimits:
    """沙箱资源限制"""

    max_memory_mb: int = 4096
    max_cpu_ms_per_sec: int = 500
    max_file_size_mb: int = 1024
    max_pids: int = 512
    command_timeout: int = 300


def _default_sandboxes_root() -> Path:
    from ripple.utils.paths import SERVER_SANDBOXES_DIR

    return SERVER_SANDBOXES_DIR


def _discover_uv_bin_dir() -> str | None:
    """自动发现 uv 二进制所在目录"""
    uv_path = shutil.which("uv")
    if uv_path:
        return str(Path(uv_path).resolve().parent)
    return None


@dataclass
class SandboxConfig:
    """沙箱配置（nsjail 隔离）"""

    sandboxes_root: Path = field(default_factory=lambda: _default_sandboxes_root())

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

    uv_bin_dir: str | None = field(default=None)

    pypi_mirror_url: str = field(default=PYPI_MIRROR_TSINGHUA)

    def __post_init__(self):
        if self.uv_bin_dir is None:
            self.uv_bin_dir = _discover_uv_bin_dir()

    @property
    def sessions_dir(self) -> Path:
        return self.sandboxes_root / "sessions"

    @property
    def uv_cache_dir(self) -> Path:
        """全局共享的 uv cache 目录（所有 session 共用，通过硬链接去重）"""
        return self.sandboxes_root / "uv-cache"

    def session_dir(self, session_id: str) -> Path:
        return self.sessions_dir / session_id

    def workspace_dir(self, session_id: str) -> Path:
        return self.session_dir(session_id) / "workspace"

    def state_file(self, session_id: str) -> Path:
        return self.session_dir(session_id) / "state.json"

    def nsjail_cfg_file(self, session_id: str) -> Path:
        return self.session_dir(session_id) / "nsjail.cfg"

    def has_python_venv(self, session_id: str) -> bool:
        """检查 session 的 workspace 内是否已创建 Python venv"""
        return (self.workspace_dir(session_id) / ".venv" / "pyvenv.cfg").exists()

    @classmethod
    def from_dict(cls, data: dict) -> "SandboxConfig":
        root = Path(data["sandboxes_root"]) if "sandboxes_root" in data else _default_sandboxes_root()

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
            sandboxes_root=root,
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
        )
