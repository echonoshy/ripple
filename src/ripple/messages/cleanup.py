"""消息清理工具

用于清理工具调用和结果，减少 token 消耗。
"""

import json
from typing import Any

from ripple.utils.token_counter import _get_encoding


def cleanup_tool_results(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """清理工具调用和结果，只保留对话摘要

    同时兼容两种消息格式，通过特征自动检测：

    OpenAI 格式特征:
    - assistant: content 为 str/None，工具调用在 tool_calls 字段
    - 工具结果: 独立的 role="tool" 消息

    Anthropic 格式特征:
    - assistant: content 为 list，包含 {"type":"tool_use"} block
    - 工具结果: 在 user 消息的 content 中，{"type":"tool_result"} block

    清理策略（两种格式统一）:
    - 只保留 assistant 的纯文本内容
    - 丢弃所有工具调用和工具结果
    """
    cleaned = []

    for msg in messages:
        role = msg.get("role")

        if role == "tool":
            continue

        if role == "assistant":
            text = _extract_assistant_text(msg)
            if text:
                cleaned.append({"role": "assistant", "content": text})

        elif role == "user":
            content = msg.get("content", [])
            if isinstance(content, str):
                cleaned.append(msg)
            elif isinstance(content, list):
                text_blocks = [
                    block for block in content if isinstance(block, dict) and block.get("type") != "tool_result"
                ]
                if text_blocks:
                    cleaned.append({"role": "user", "content": text_blocks})

        else:
            cleaned.append(msg)

    return cleaned


def _extract_assistant_text(msg: dict) -> str:
    """从 assistant 消息中提取纯文本，兼容 OpenAI / Anthropic 两种格式"""
    content = msg.get("content")

    if isinstance(content, str):
        return content.strip()

    if isinstance(content, list):
        parts = [
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text" and block.get("text", "").strip()
        ]
        return "\n".join(parts)

    return ""


def estimate_tokens(messages: list[dict[str, Any]]) -> int:
    """基于 tiktoken 估算消息列表的 token 数"""
    enc = _get_encoding()
    total = 0

    for msg in messages:
        total += 4  # 每条消息的格式开销

        role = msg.get("role", "")
        total += len(enc.encode(role))

        content = msg.get("content")
        if isinstance(content, str):
            total += len(enc.encode(content))
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict):
                    text = block.get("text") or block.get("content") or ""
                    if text:
                        total += len(enc.encode(text))
                    name = block.get("name") or ""
                    if name:
                        total += len(enc.encode(name))
                    inp = block.get("input")
                    if inp:
                        total += len(enc.encode(json.dumps(inp, ensure_ascii=False)))

        for tc in msg.get("tool_calls", []):
            func = tc.get("function", {})
            total += len(enc.encode(func.get("name", "")))
            total += len(enc.encode(func.get("arguments", "")))

    total += 2
    return total


def _find_safe_trim_boundary(messages: list[dict[str, Any]], start_index: int) -> int:
    """从 start_index 开始向后找到安全的裁剪边界

    安全边界要求：
    1. 不在 assistant(tool_calls) + tool(result) 的配对中间切割
    2. 不在 assistant(tool_use) + user(tool_result) 的配对中间切割
    3. 优先在 user 消息（非 tool 结果）之前切割
    """
    n = len(messages)
    idx = start_index

    while idx < n:
        msg = messages[idx]
        role = msg.get("role")

        # 如果是 user 消息且不是工具结果的容器，可以安全切割
        if role == "user":
            content = msg.get("content", "")
            if isinstance(content, str):
                return idx
            if isinstance(content, list):
                has_tool_result = any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content)
                if not has_tool_result:
                    return idx

        # 如果是 system 消息，可以在它后面的消息处切
        if role == "system":
            idx += 1
            continue

        idx += 1

    return start_index


def trim_old_messages(messages: list[dict[str, Any]], max_tokens: int = 150_000) -> list[dict[str, Any]]:
    """超过阈值时裁剪旧消息

    策略：
    1. 循环裁剪，直到 token 数低于阈值
    2. 每次裁剪约 20% 的消息
    3. 在安全边界处切割（尊重 tool_use/tool_result 配对）
    4. 至少保留 2 条消息
    """
    current_tokens = estimate_tokens(messages)

    if current_tokens <= max_tokens:
        return messages

    result = list(messages)

    while estimate_tokens(result) > max_tokens and len(result) > 2:
        trim_count = max(1, int(len(result) * 0.2))
        raw_boundary = trim_count

        # 找到安全的切割边界
        safe_boundary = _find_safe_trim_boundary(result, raw_boundary)

        if safe_boundary >= len(result) - 1:
            safe_boundary = raw_boundary

        if safe_boundary <= 0:
            break

        result = result[safe_boundary:]

        if len(result) <= 2:
            break

    return result
