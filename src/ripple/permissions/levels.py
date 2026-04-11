"""权限级别定义"""

from enum import Enum


class ToolRiskLevel(Enum):
    """工具风险级别"""

    SAFE = "safe"  # 安全操作：Read, Search, Grep
    MODERATE = "moderate"  # 中等风险：Write, Edit
    DANGEROUS = "dangerous"  # 危险操作：Bash (rm/git push), Agent


class PermissionMode(Enum):
    """权限模式"""

    ALLOW_ALL = "allow"  # 自动允许所有
    ASK = "ask"  # 每次询问
    DENY_ALL = "deny"  # 拒绝所有
    SMART = "smart"  # 智能模式：安全的自动允许，危险的询问
