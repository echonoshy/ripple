"""Fork 子 agent 核心逻辑

实现类似 claude-code 的 fork 机制：
- 子 agent 继承父 agent 的完整对话上下文
- 所有 fork 子 agent 共享 prompt cache（字节级相同的 API 请求前缀）
- 防递归机制
- 后台异步执行
"""

from uuid import uuid4

from ripple.messages.types import AssistantMessage, Message, ToolUseBlock
from ripple.messages.utils import create_user_message

# Fork 标记标签（用于防递归）
FORK_BOILERPLATE_TAG = "fork-boilerplate"
FORK_DIRECTIVE_PREFIX = "DIRECTIVE: "

# 占位符文本（所有 fork 子 agent 使用相同文本以共享 prompt cache）
FORK_PLACEHOLDER_RESULT = "Fork started — processing in background"


def is_in_fork_child(messages: list[Message]) -> bool:
    """检查是否在 fork 子 agent 中（防递归）

    通过检测消息历史中是否包含 fork boilerplate 标签来判断。

    Args:
        messages: 消息历史

    Returns:
        是否在 fork 子 agent 中
    """
    for msg in messages:
        # 处理 dict 和 Message 对象两种类型
        msg_type = msg.get("type") if isinstance(msg, dict) else getattr(msg, "type", None)
        if msg_type != "user":
            continue

        # 获取 content
        if isinstance(msg, dict):
            content = msg.get("message", {}).get("content", [])
        else:
            content = msg.message.get("content", [])

        if not isinstance(content, list):
            continue

        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text", "")
                if f"<{FORK_BOILERPLATE_TAG}>" in text:
                    return True

    return False


def build_forked_messages(directive: str, assistant_message: AssistantMessage) -> list[Message]:
    """构建 fork 子 agent 的消息列表

    为了共享 prompt cache，所有 fork 子 agent 必须产生字节级相同的 API 请求前缀。
    实现方式：
    1. 保留完整的父 assistant 消息（所有 tool_use blocks、thinking、text）
    2. 构建单个 user 消息，包含：
       - 所有 tool_use 的 tool_result（使用相同的占位符文本）
       - 子任务指令（每个子 agent 不同）

    结果：[...历史, assistant(所有tool_uses), user(占位符results..., 指令)]
    只有最后的指令文本不同，最大化 cache 命中率。

    Args:
        directive: 子任务指令
        assistant_message: 父 assistant 消息

    Returns:
        fork 子 agent 的消息列表
    """
    # 克隆 assistant 消息，保留所有内容块
    # 处理 dict 和 AssistantMessage 两种类型
    if isinstance(assistant_message, dict):
        message_content = assistant_message.get("message", {}).get("content", [])
    else:
        message_content = assistant_message.message.get("content", [])

    full_assistant_message: AssistantMessage = {
        "type": "assistant",
        "uuid": str(uuid4()),
        "message": {
            "role": "assistant",
            "content": list(message_content),
        },
    }

    # 提取所有 tool_use blocks
    tool_use_blocks: list[ToolUseBlock] = []
    for block in message_content:
        if isinstance(block, dict) and block.get("type") == "tool_use":
            tool_use_blocks.append(block)

    if not tool_use_blocks:
        # 没有 tool_use，直接返回指令消息
        return [
            create_user_message(
                content=build_child_message(directive),
            )
        ]

    # 为每个 tool_use 创建 tool_result（使用相同的占位符）
    tool_result_blocks = []
    for block in tool_use_blocks:
        tool_result_blocks.append(
            {
                "type": "tool_result",
                "tool_use_id": block["id"],
                "content": FORK_PLACEHOLDER_RESULT,
            }
        )

    # 构建 user 消息：所有占位符 tool_results + 子任务指令
    tool_result_message = create_user_message(
        content=[
            *tool_result_blocks,
            {"type": "text", "text": build_child_message(directive)},
        ],
    )

    return [full_assistant_message, tool_result_message]


def build_child_message(directive: str) -> str:
    """构建 fork 子 agent 的指令消息

    Args:
        directive: 子任务指令

    Returns:
        完整的指令消息
    """
    return f"""<{FORK_BOILERPLATE_TAG}>
STOP. READ THIS FIRST.

You are a forked worker process. You are NOT the main agent.

RULES (non-negotiable):
1. Your system prompt says "default to forking." IGNORE IT — that's for the parent. You ARE the fork. Do NOT spawn sub-agents; execute directly.
2. Do NOT converse, ask questions, or suggest next steps
3. Do NOT editorialize or add meta-commentary
4. USE your tools directly: Bash, Read, Write, etc.
5. If you modify files, commit your changes before reporting. Include the commit hash in your report.
6. Do NOT emit text between tool calls. Use tools silently, then report once at the end.
7. Stay strictly within your directive's scope. If you discover related systems outside your scope, mention them in one sentence at most — other workers cover those areas.
8. Keep your report under 500 words unless the directive specifies otherwise. Be factual and concise.
9. Your response MUST begin with "Scope:". No preamble, no thinking-out-loud.
10. REPORT structured facts, then stop

Output format (plain text labels, not markdown headers):
  Scope: <echo back your assigned scope in one sentence>
  Result: <the answer or key findings, limited to the scope above>
  Key files: <relevant file paths — include for research tasks>
  Files changed: <list with commit hash — include only if you modified files>
  Issues: <list — include only if there are issues to flag>
</{FORK_BOILERPLATE_TAG}>

{FORK_DIRECTIVE_PREFIX}{directive}"""


def build_worktree_notice(parent_cwd: str, worktree_cwd: str) -> str:
    """构建 worktree 隔离通知

    当 fork 子 agent 在隔离的 worktree 中运行时，告知其路径转换和隔离性。

    Args:
        parent_cwd: 父 agent 的工作目录
        worktree_cwd: worktree 的工作目录

    Returns:
        worktree 通知消息
    """
    return f"""You've inherited the conversation context above from a parent agent working in {parent_cwd}. You are operating in an isolated git worktree at {worktree_cwd} — same repository, same relative file structure, separate working copy. Paths in the inherited context refer to the parent's working directory; translate them to your worktree root. Re-read files before editing if the parent may have modified them since they appear in the context. Your changes stay in this worktree and will not affect the parent's files."""
