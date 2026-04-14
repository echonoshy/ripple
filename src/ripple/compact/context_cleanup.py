"""跨 Agent Loop 上下文清理

⚠️ 已弃用：本模块的功能已合并到 ContextManager + AutoCompactor.lightweight_cleanup() 中。
Server 模式不再调用本模块。保留仅供 CLI 或其他可能的调用方使用。

在多轮对话中，前一个 agent loop 的工具调用细节对后续 loop 无价值，
只有对话文本和操作摘要是有意义的上下文。

本模块负责将完整的会话消息列表清理为适合发送给模型的精简版本：
- 保留所有 user 文本和 assistant 文本
- 将旧的 tool_result 内容替换为简短描述
- 保留 tool_use 的名称但清理详细参数

完整的消息历史由 conversation_log 独立保存，供 Web 展示使用。
"""

import copy

from ripple.messages.types import Message
from ripple.utils.logger import get_logger

logger = get_logger("compact.context_cleanup")

TOOL_RESULT_PLACEHOLDER = "[Previous tool result omitted for context efficiency]"
TOOL_INPUT_PLACEHOLDER = {"_note": "Arguments omitted from prior conversation turn"}


def clean_messages_for_model_context(messages: list[Message]) -> list[Message]:
    """清理消息列表用于模型上下文

    保留消息结构和对话文本，但去除旧工具调用的详细内容。
    这适用于跨 agent loop 传递的 history_messages。
    """
    if not messages:
        return messages

    result: list[Message] = []
    modified_indices: dict[int, Message] = {}

    for idx, msg in enumerate(messages):
        if isinstance(msg, dict) or getattr(msg, "type", None) not in ("user", "assistant"):
            result.append(msg)
            continue

        if msg.type == "user":
            content = msg.message.get("content", "")
            if not isinstance(content, list):
                result.append(msg)
                continue

            needs_clean = False
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    c = block.get("content", "")
                    if isinstance(c, str) and len(c) > 200:
                        needs_clean = True
                        break

            if not needs_clean:
                result.append(msg)
                continue

            if idx not in modified_indices:
                new_msg = copy.copy(msg)
                new_msg.message = copy.deepcopy(msg.message)
                modified_indices[idx] = new_msg

            cleaned_msg = modified_indices[idx]
            for block in cleaned_msg.message["content"]:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    old_content = block.get("content", "")
                    if isinstance(old_content, str) and len(old_content) > 200:
                        tool_name = block.get("tool_name", "unknown")
                        block["content"] = f"[{tool_name} result: {len(old_content)} chars omitted]"

            result.append(cleaned_msg)

        elif msg.type == "assistant":
            content = msg.message.get("content", [])
            if not isinstance(content, list):
                result.append(msg)
                continue

            needs_clean = False
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    inp = block.get("input", {})
                    if isinstance(inp, dict) and len(str(inp)) > 500:
                        needs_clean = True
                        break

            if not needs_clean:
                result.append(msg)
                continue

            if idx not in modified_indices:
                new_msg = copy.copy(msg)
                new_msg.message = copy.deepcopy(msg.message)
                modified_indices[idx] = new_msg

            cleaned_msg = modified_indices[idx]
            for block in cleaned_msg.message["content"]:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    inp = block.get("input", {})
                    if isinstance(inp, dict) and len(str(inp)) > 500:
                        block["input"] = TOOL_INPUT_PLACEHOLDER

            result.append(cleaned_msg)

    if modified_indices:
        logger.info("跨 loop 上下文清理: 清理了 {} 条消息中的工具细节", len(modified_indices))

    return result
