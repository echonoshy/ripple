"""沙箱配置"""

from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class ResourceLimits:
    """沙箱资源限制"""

    max_memory_mb: int = 256
    max_cpu_ms_per_sec: int = 500
    max_file_size_mb: int = 64
    max_pids: int = 64
    command_timeout: int = 120


@dataclass
class SandboxConfig:
    """沙箱配置（nsjail 隔离）"""

    sandboxes_root: Path = field(default_factory=lambda: Path.cwd() / ".ripple" / "sandboxes")

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

    tmpfs_size_mb: int = 64

    max_workspace_mb: int = 512

    @property
    def sessions_dir(self) -> Path:
        return self.sandboxes_root / "sessions"

    def session_dir(self, session_id: str) -> Path:
        return self.sessions_dir / session_id

    def workspace_dir(self, session_id: str) -> Path:
        return self.session_dir(session_id) / "workspace"

    def state_file(self, session_id: str) -> Path:
        return self.session_dir(session_id) / "state.json"

    def nsjail_cfg_file(self, session_id: str) -> Path:
        return self.session_dir(session_id) / "nsjail.cfg"

    @classmethod
    def from_dict(cls, data: dict) -> "SandboxConfig":
        root = Path(data["sandboxes_root"]) if "sandboxes_root" in data else Path.cwd() / ".ripple" / "sandboxes"

        limits_data = data.get("resource_limits", {})
        limits = ResourceLimits(
            max_memory_mb=limits_data.get("max_memory_mb", 256),
            max_cpu_ms_per_sec=limits_data.get("max_cpu_ms_per_sec", 500),
            max_file_size_mb=limits_data.get("max_file_size_mb", 64),
            max_pids=limits_data.get("max_pids", 64),
            command_timeout=limits_data.get("command_timeout", 120),
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
            tmpfs_size_mb=data.get("tmpfs_size_mb", 64),
            max_workspace_mb=data.get("max_workspace_mb", 512),
        )
