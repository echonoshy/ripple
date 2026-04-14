"""统一上下文管理器

为 Server 模式的 Session 提供统一的消息上下文管理：
- prepare_model_messages(): 合并 L1(context_cleanup) + L2(micro_compact) 的清理
- 持有持久化的 AutoCompactor 实例（L3），生命周期与 Session 一致
- 替代原来分散在 sse.py / agent_loop.py / routes.py 中的四层独立压缩
"""

from ripple.compact.auto_compact import AutoCompactor
from ripple.messages.types import Message
from ripple.utils.logger import get_logger

logger = get_logger("compact.context_manager")


class ContextManager:
    """统一的上下文管理器，生命周期与 Session 一致

    职责：
    1. 维护 AutoCompactor 实例（不再每次 query 新建）
    2. 在 query 前对 display_messages 做轻量级清理，生成 model_messages
    3. 通过 get_compactor_state / from_persisted_state 支持 Session 挂起/恢复
    """

    def __init__(self, compactor: AutoCompactor | None = None):
        self._compactor = compactor or AutoCompactor()

    @property
    def compactor(self) -> AutoCompactor:
        """暴露 compactor 实例供 agent_loop 使用"""
        return self._compactor

    def prepare_model_messages(self, display_messages: list[Message]) -> list[Message]:
        """准备传给模型的消息（合并 L1 + L2 的单次清理入口）

        在每次 query 开始前调用。对完整的 session.messages 做清理，
        返回适合发给模型的精简版本。不修改原始 display_messages。
        """
        return self._compactor.lightweight_cleanup(display_messages)

    def get_compactor_state(self) -> dict:
        """序列化 compactor 状态，用于 Session 持久化"""
        return self._compactor.get_state()

    @classmethod
    def from_persisted_state(cls, state: dict) -> "ContextManager":
        """从持久化状态恢复 ContextManager"""
        compactor = AutoCompactor.from_state(state) if state else AutoCompactor()
        return cls(compactor=compactor)
