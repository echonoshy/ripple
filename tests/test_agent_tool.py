"""测试 Agent Tool 的 Fork 模式

验证核心功能：
1. Fork 消息构建
2. 防递归检测
3. 后台任务管理
"""

import asyncio

import pytest

from ripple.core.background import BackgroundTask, TaskManager, create_task_notification
from ripple.core.fork import FORK_BOILERPLATE_TAG, build_child_message, build_forked_messages, is_in_fork_child
from ripple.messages.utils import create_user_message


def test_build_child_message():
    """测试子任务指令构建"""
    directive = "分析 src/ripple/core/ 目录"
    message = build_child_message(directive)

    # 检查包含必要的标签和指令
    assert f"<{FORK_BOILERPLATE_TAG}>" in message
    assert f"</{FORK_BOILERPLATE_TAG}>" in message
    assert directive in message
    assert "You are a forked worker process" in message
    assert "Scope:" in message


def test_build_forked_messages():
    """测试 fork 消息构建"""
    # 创建模拟的 assistant 消息
    assistant_message = {
        "type": "assistant",
        "uuid": "test-uuid",
        "message": {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "Let me help you with that."},
                {
                    "type": "tool_use",
                    "id": "tool-1",
                    "name": "Read",
                    "input": {"file_path": "/test.py"},
                },
                {
                    "type": "tool_use",
                    "id": "tool-2",
                    "name": "Bash",
                    "input": {"command": "ls"},
                },
            ],
        },
    }

    directive = "分析代码"
    messages = build_forked_messages(directive, assistant_message)

    # 应该返回 2 条消息：assistant + user
    assert len(messages) == 2

    # 第一条是 assistant 消息
    assert messages[0]["type"] == "assistant"
    assert len(messages[0]["message"]["content"]) == 3  # text + 2 tool_use

    # 第二条是 user 消息（tool_results + 指令）
    # create_user_message 返回的是 TypedDict，需要用字典访问
    msg = messages[1]
    if hasattr(msg, "message"):
        content = msg.message.get("content", [])
    else:
        content = msg["message"]["content"]

    # 应该有 2 个 tool_result + 1 个 text
    tool_results = [b for b in content if isinstance(b, dict) and b.get("type") == "tool_result"]
    text_blocks = [b for b in content if isinstance(b, dict) and b.get("type") == "text"]

    assert len(tool_results) == 2
    assert len(text_blocks) == 1

    # 检查 tool_result 的 ID 匹配
    assert tool_results[0]["tool_use_id"] == "tool-1"
    assert tool_results[1]["tool_use_id"] == "tool-2"

    # 检查指令文本
    assert directive in text_blocks[0]["text"]
    assert FORK_BOILERPLATE_TAG in text_blocks[0]["text"]


def test_build_forked_messages_no_tool_use():
    """测试没有 tool_use 的情况"""
    assistant_message = {
        "type": "assistant",
        "uuid": "test-uuid",
        "message": {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "I understand."},
            ],
        },
    }

    directive = "继续任务"
    messages = build_forked_messages(directive, assistant_message)

    # 没有 tool_use，应该只返回指令消息
    assert len(messages) == 1
    # UserMessage 是 TypedDict，使用属性访问
    msg = messages[0]
    assert msg.type == "user"


def test_is_in_fork_child():
    """测试防递归检测"""
    # 正常消息（不在 fork 中）
    normal_messages = [
        create_user_message(content="Hello"),
        {
            "type": "assistant",
            "uuid": "test",
            "message": {"role": "assistant", "content": [{"type": "text", "text": "Hi"}]},
        },
    ]
    assert not is_in_fork_child(normal_messages)

    # Fork 子 agent 的消息（包含 boilerplate）
    fork_message = create_user_message(content=f"<{FORK_BOILERPLATE_TAG}>You are a fork</{FORK_BOILERPLATE_TAG}>")
    fork_messages = [*normal_messages, fork_message]
    assert is_in_fork_child(fork_messages)


def test_task_manager_create_task():
    """测试任务创建"""
    manager = TaskManager()

    task = manager.create_task(
        description="测试任务",
        prompt="执行测试",
    )

    assert task.task_id.startswith("task-")
    assert task.description == "测试任务"
    assert task.prompt == "执行测试"
    assert task.status == "running"
    assert task.result is None

    # 任务应该被注册
    assert task.task_id in manager.tasks


def test_task_manager_get_task():
    """测试任务获取"""
    manager = TaskManager()

    task = manager.create_task(description="测试", prompt="测试")
    retrieved = manager.get_task(task.task_id)

    assert retrieved is not None
    assert retrieved.task_id == task.task_id
    assert retrieved.description == task.description


def test_task_manager_list_tasks():
    """测试任务列表"""
    manager = TaskManager()

    task1 = manager.create_task(description="任务1", prompt="测试1")
    task2 = manager.create_task(description="任务2", prompt="测试2")

    tasks = manager.list_tasks()
    assert len(tasks) == 2
    assert task1 in tasks
    assert task2 in tasks


@pytest.mark.asyncio
async def test_task_manager_run_task():
    """测试任务运行"""
    manager = TaskManager()

    # 创建模拟的 agent loop
    async def mock_agent_loop():
        # 模拟 assistant 消息（需要有 type 属性）
        class MockMessage:
            def __init__(self):
                self.type = "assistant"
                self.message = {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "Task completed successfully"}],
                }

        yield MockMessage()

    task = manager.create_task(description="测试任务", prompt="执行测试")
    manager.start_task(task, mock_agent_loop())

    # 等待任务完成
    await asyncio.sleep(0.2)
    completed_task = await manager.wait_for_task(task.task_id)

    assert completed_task is not None
    assert completed_task.status == "completed"
    assert completed_task.result is not None
    assert "Task completed successfully" in completed_task.result
    assert completed_task.turns_used == 1


def test_create_task_notification():
    """测试任务通知创建"""
    # 完成的任务
    completed_task = BackgroundTask(
        task_id="task-123",
        description="测试任务",
        prompt="执行测试",
        status="completed",
        result="任务完成",
        turns_used=3,
    )

    notification = create_task_notification(completed_task)
    assert notification.type == "user"
    # content 是列表，需要提取文本
    content_blocks = notification.message.get("content", [])
    if isinstance(content_blocks, list):
        content = content_blocks[0].get("text", "") if content_blocks else ""
    else:
        content = content_blocks
    assert "<task-notification>" in content
    assert "task-123" in content
    assert "任务完成" in content

    # 失败的任务
    failed_task = BackgroundTask(
        task_id="task-456",
        description="失败任务",
        prompt="执行测试",
        status="failed",
        error="测试错误",
    )

    notification = create_task_notification(failed_task)
    content_blocks = notification.message.get("content", [])
    if isinstance(content_blocks, list):
        content = content_blocks[0].get("text", "") if content_blocks else ""
    else:
        content = content_blocks
    assert "failed" in content
    assert "测试错误" in content


if __name__ == "__main__":
    # 运行基本测试
    print("测试 1: build_child_message")
    test_build_child_message()
    print("✓ 通过")

    print("\n测试 2: build_forked_messages")
    test_build_forked_messages()
    print("✓ 通过")

    print("\n测试 3: build_forked_messages_no_tool_use")
    test_build_forked_messages_no_tool_use()
    print("✓ 通过")

    print("\n测试 4: is_in_fork_child")
    test_is_in_fork_child()
    print("✓ 通过")

    print("\n测试 5: task_manager_create_task")
    test_task_manager_create_task()
    print("✓ 通过")

    print("\n测试 6: task_manager_get_task")
    test_task_manager_get_task()
    print("✓ 通过")

    print("\n测试 7: task_manager_list_tasks")
    test_task_manager_list_tasks()
    print("✓ 通过")

    print("\n测试 8: create_task_notification")
    test_create_task_notification()
    print("✓ 通过")

    print("\n测试 9: task_manager_run_task (异步)")
    asyncio.run(test_task_manager_run_task())
    print("✓ 通过")

    print("\n✅ 所有测试通过！")
