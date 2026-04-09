"""Token 计数工具"""

from typing import Any

import tiktoken


def count_tokens(text: str, model: str = "gpt-4") -> int:
    """计算文本的 token 数量

    Args:
        text: 要计算的文本
        model: 模型名称，用于选择正确的 tokenizer

    Returns:
        Token 数量
    """
    try:
        encoding = tiktoken.encoding_for_model(model)
    except KeyError:
        # 如果模型不存在，使用 cl100k_base（GPT-4 的编码）
        encoding = tiktoken.get_encoding("cl100k_base")

    return len(encoding.encode(text))


def count_message_tokens(messages: list[dict[str, Any]], model: str = "gpt-4") -> int:
    """计算消息列表的 token 数量

    Args:
        messages: 消息列表
        model: 模型名称

    Returns:
        总 token 数量
    """
    total = 0

    for message in messages:
        # 每条消息的基础开销
        total += 4  # <|start|>role<|end|>content<|end|>

        # 角色
        if "role" in message:
            total += count_tokens(message["role"], model)

        # 内容
        if "content" in message:
            if isinstance(message["content"], str):
                total += count_tokens(message["content"], model)
            elif isinstance(message["content"], list):
                for block in message["content"]:
                    if isinstance(block, dict):
                        if block.get("type") == "text":
                            total += count_tokens(block.get("text", ""), model)
                        elif block.get("type") == "tool_use":
                            # 工具调用的 token 估算
                            total += count_tokens(block.get("name", ""), model)
                            total += count_tokens(str(block.get("input", {})), model)
                        elif block.get("type") == "tool_result":
                            total += count_tokens(block.get("content", ""), model)

    # 每次对话的结束标记
    total += 2

    return total


def estimate_tokens_with_buffer(messages: list[dict[str, Any]], model: str = "gpt-4", buffer: float = 1.1) -> int:
    """估算消息的 token 数量，带安全边界

    Args:
        messages: 消息列表
        model: 模型名称
        buffer: 安全边界倍数（默认 1.1，即 10% 的缓冲）

    Returns:
        估算的 token 数量（带缓冲）
    """
    base_count = count_message_tokens(messages, model)
    return int(base_count * buffer)
