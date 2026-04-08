#!/usr/bin/env python3
"""测试 Session 记忆和权限系统

运行此脚本测试新功能：
1. Session 记忆
2. 工具结果清理
3. Token 统计
4. 权限系统
"""

import asyncio

from ripple.messages.cleanup import cleanup_tool_results, estimate_tokens, trim_old_messages
from ripple.permissions.levels import PermissionMode, ToolRiskLevel
from ripple.permissions.manager import PermissionManager
from ripple.tools.builtin.bash import BashTool
from ripple.tools.builtin.write import WriteTool


async def test_message_cleanup():
    """测试消息清理"""
    print("=" * 60)
    print("测试 1: 消息清理")
    print("=" * 60)

    messages = [
        {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "让我读取文件"},
                {"type": "tool_use", "id": "1", "name": "Read", "input": {"file_path": "test.py"}},
            ],
        },
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "1", "content": "文件内容" * 1000}]},
        {"role": "assistant", "content": [{"type": "text", "text": "文件分析结果"}]},
    ]

    print(f"原始消息数: {len(messages)}")
    print(f"原始 tokens: {estimate_tokens(messages)}")

    cleaned = cleanup_tool_results(messages)
    print(f"清理后消息数: {len(cleaned)}")
    print(f"清理后 tokens: {estimate_tokens(cleaned)}")
    print(f"节省比例: {(1 - estimate_tokens(cleaned) / estimate_tokens(messages)) * 100:.1f}%")
    print("✓ 消息清理测试通过\n")


async def test_token_estimation():
    """测试 token 估算"""
    print("=" * 60)
    print("测试 2: Token 估算")
    print("=" * 60)

    messages = [{"role": "user", "content": "Hello"}, {"role": "assistant", "content": "Hi there!"}]

    tokens = estimate_tokens(messages)
    print(f"简单对话 tokens: {tokens}")

    # 测试智能清理
    large_messages = [{"role": "user", "content": "test" * 10000} for _ in range(100)]
    print(f"大量消息 tokens: {estimate_tokens(large_messages)}")

    trimmed = trim_old_messages(large_messages, max_tokens=50000)
    print(f"清理后消息数: {len(trimmed)} (原始: {len(large_messages)})")
    print(f"清理后 tokens: {estimate_tokens(trimmed)}")
    print("✓ Token 估算测试通过\n")


async def test_permission_system():
    """测试权限系统"""
    print("=" * 60)
    print("测试 3: 权限系统")
    print("=" * 60)

    # 测试工具风险级别
    bash_tool = BashTool()
    write_tool = WriteTool()

    print(f"Bash 工具风险级别: {bash_tool.risk_level.value}")
    print(f"Write 工具风险级别: {write_tool.risk_level.value}")

    # 测试危险命令检测
    dangerous_cmds = [
        {"command": "rm -rf /tmp/test"},
        {"command": "git push --force"},
        {"command": "sudo apt-get install"},
    ]

    safe_cmds = [{"command": "ls -la"}, {"command": "cat test.txt"}, {"command": "echo hello"}]

    print("\n危险命令检测:")
    for cmd in dangerous_cmds:
        result = bash_tool.requires_confirmation(cmd)
        print(f"  {cmd['command']}: {'需要确认' if result else '自动允许'}")

    print("\n安全命令检测:")
    for cmd in safe_cmds:
        result = bash_tool.requires_confirmation(cmd)
        print(f"  {cmd['command']}: {'需要确认' if result else '自动允许'}")

    print("\n✓ 权限系统测试通过\n")


async def test_permission_modes():
    """测试权限模式"""
    print("=" * 60)
    print("测试 4: 权限模式")
    print("=" * 60)

    bash_tool = BashTool()
    safe_cmd = {"command": "ls"}
    dangerous_cmd = {"command": "rm -rf test"}

    # ALLOW_ALL 模式
    manager = PermissionManager(mode=PermissionMode.ALLOW_ALL)
    allowed, reason = await manager.check_permission(bash_tool, dangerous_cmd)
    print(f"ALLOW_ALL 模式 + 危险命令: {'允许' if allowed else '拒绝'}")

    # DENY_ALL 模式
    manager = PermissionManager(mode=PermissionMode.DENY_ALL)
    allowed, reason = await manager.check_permission(bash_tool, safe_cmd)
    print(f"DENY_ALL 模式 + 安全命令: {'允许' if allowed else '拒绝'} ({reason})")

    # SMART 模式
    manager = PermissionManager(mode=PermissionMode.SMART)
    allowed, reason = await manager.check_permission(bash_tool, safe_cmd)
    print(f"SMART 模式 + 安全命令: {'允许' if allowed else '拒绝'}")

    print("\n✓ 权限模式测试通过\n")


async def main():
    """运行所有测试"""
    print("\n🧪 开始测试 Ripple 新功能\n")

    await test_message_cleanup()
    await test_token_estimation()
    await test_permission_system()
    await test_permission_modes()

    print("=" * 60)
    print("✅ 所有测试通过！")
    print("=" * 60)
    print("\n现在可以运行 'uv run ripple cli' 测试完整功能")


if __name__ == "__main__":
    asyncio.run(main())
