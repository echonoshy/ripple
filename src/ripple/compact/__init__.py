"""自动压缩系统

提供消息历史的自动压缩功能。
"""

from ripple.compact.auto_compact import AutoCompactor, get_global_compactor

__all__ = ["AutoCompactor", "get_global_compactor"]
