"""非交互式执行模式

提供 `ripple execute` 和 `ripple continue` 命令，
让其他 Agent 通过 CLI 调用 Ripple 的核心能力。

输出分两路：
- stdout: 最终 JSON 结果（机器解析）+ 可选 --stream JSONL
- stderr: 实时进度日志（人可读，调用方 BashTool 可见）
"""

import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from ripple.api.client import OpenRouterClient
from ripple.core.agent_loop import query
from ripple.core.context import ToolOptions, ToolUseContext
from ripple.messages.types import AssistantMessage, RequestStartEvent, StreamEvent
from ripple.messages.utils import _convert_assistant_message
from ripple.permissions.levels import PermissionMode
from ripple.permissions.manager import PermissionManager
from ripple.skills.loader import get_global_loader
from ripple.skills.skill_tool import SkillTool
from ripple.tools.builtin.agent_tool import AgentTool
from ripple.tools.builtin.ask_user import AskUserTool
from ripple.tools.builtin.bash import BashTool
from ripple.tools.builtin.read import ReadTool
from ripple.tools.builtin.search import SearchTool
from ripple.tools.builtin.write import WriteTool
from ripple.utils.config import get_config
from ripple.utils.logger import get_logger

logger = get_logger("cli.execute")


def _generate_execute_session_id() -> str:
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    import uuid

    short = uuid.uuid4().hex[:6]
    return f"rpl-{ts}-{short}"


def _build_system_prompt(cwd: Path) -> str:
    loader = get_global_loader()
    skills = loader.list_skills()

    skills_info = []
    for skill in skills:
        desc = skill.description[:150] + "..." if len(skill.description) > 150 else skill.description
        skills_info.append(f"- {skill.name}: {desc}")
    skills_text = "\n".join(skills_info)

    workspace_dir = cwd / ".ripple" / "workspace"

    return f"""Today's date is {datetime.now().strftime("%Y/%m/%d")}.

You are running in non-interactive execute mode, called programmatically by another agent.

## Important Rules for Execute Mode
- Be concise and action-oriented. Focus on completing the task.
- When using AskUser tool, the session will be suspended and the question will be returned to the caller.
- The caller may continue the session with an answer later.
- Make reasonable default decisions when possible to minimize interruptions.
- Output structured, clear results.

## File Writing Rules
When the user asks to write or save content to a file without specifying an explicit path:
- Default output directory: `{workspace_dir}`
- Do NOT write to the user's home directory, root directory, or any system directory

# Available Skills
{skills_text}"""


def _create_context(session_id: str, cwd: Path) -> ToolUseContext:
    tools = [
        BashTool(),
        ReadTool(),
        WriteTool(),
        SearchTool(),
        AgentTool(messages=[]),
        SkillTool(),
        AskUserTool(),
    ]

    permission_manager = PermissionManager(mode=PermissionMode.ALLOW_ALL)

    return ToolUseContext(
        options=ToolOptions(tools=tools),
        session_id=session_id,
        cwd=cwd,
        permission_manager=permission_manager,
        is_execute_mode=True,
    )


def _progress(msg: str):
    """写进度到 stderr（始终输出，BashTool 返回时可见）"""
    print(f"[ripple] {msg}", file=sys.stderr, flush=True)


def _emit_jsonl(event: dict[str, Any]):
    """写一行 JSONL 到 stdout"""
    print(json.dumps(event, ensure_ascii=False), flush=True)


def _output_json(data: dict[str, Any]):
    """写最终 JSON 到 stdout"""
    print(json.dumps(data, ensure_ascii=False, indent=2), flush=True)


async def execute_task(
    task: str,
    cwd: str | None = None,
    model: str | None = None,
    max_turns: int | None = None,
    stream: bool = False,
):
    """执行一个任务（非交互模式）"""
    config = get_config()
    resolved_cwd = Path(cwd) if cwd else Path.cwd()
    resolved_model = config.resolve_model(model or config.get("model.default", "sonnet"))
    resolved_max_turns = max_turns or config.get("agent.max_turns", 10)

    session_id = _generate_execute_session_id()
    context = _create_context(session_id, resolved_cwd)
    system_prompt = _build_system_prompt(resolved_cwd)

    client = OpenRouterClient()
    _progress(f"Session {session_id} | model={resolved_model} | max_turns={resolved_max_turns}")
    _progress(f"Task: {_truncate_str(task, 120)}")

    # 收集数据
    tool_calls_log: list[dict[str, Any]] = []
    history_messages: list[dict[str, Any]] = []
    accumulated_text = ""
    turns_used = 0
    tool_id_to_name: dict[str, str] = {}

    try:
        async for item in query(
            user_input=task,
            context=context,
            client=client,
            model=resolved_model,
            max_turns=resolved_max_turns,
            thinking=False,
            history_messages=history_messages,
            system_prompt=system_prompt,
        ):
            if not hasattr(item, "type"):
                continue

            if isinstance(item, RequestStartEvent):
                _progress(f"⏳ Turn {turns_used + 1}: 等待模型回复...")
                continue

            if isinstance(item, StreamEvent):
                if item.type == "stream_chunk" and item.data:
                    text = item.data.get("text", "")
                    if text and stream:
                        _emit_jsonl({"type": "text", "content": text})
                continue

            if isinstance(item, AssistantMessage):
                turns_used += 1
                content = item.message.get("content", [])
                msg_dict = _convert_assistant_message(content)
                history_messages.append(msg_dict)

                for block in content:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "text":
                        text = block.get("text", "")
                        if text.strip():
                            accumulated_text = text
                    elif block.get("type") == "tool_use":
                        tool_name = block.get("name", "")
                        tool_id = block.get("id", "")
                        tool_input = block.get("input", {})
                        tool_id_to_name[tool_id] = tool_name

                        input_preview = _truncate_str(json.dumps(tool_input, ensure_ascii=False), 120)
                        _progress(f"🔧 调用: {tool_name} {input_preview}")

                        if stream:
                            _emit_jsonl(
                                {
                                    "type": "tool_call",
                                    "tool": tool_name,
                                    "input": _truncate_dict(tool_input),
                                }
                            )

            elif hasattr(item, "type") and item.type == "user":
                content = item.message.get("content", [])

                if getattr(item, "is_meta", False):
                    continue

                for blk in content:
                    if isinstance(blk, dict) and blk.get("type") == "tool_result":
                        tool_use_id = blk.get("tool_use_id", "")
                        result_content = blk.get("content", "")
                        is_error = blk.get("is_error", False)
                        tool_name = blk.get("tool_name") or tool_id_to_name.get(tool_use_id, "")

                        if is_error:
                            _progress(f"❌ {tool_name}: {_truncate_str(result_content, 100)}")
                        else:
                            _progress(f"✅ {tool_name}: {_truncate_str(result_content, 100)}")

                        tool_calls_log.append(
                            {
                                "tool": tool_name,
                                "tool_use_id": tool_use_id,
                                "success": not is_error,
                                "output_preview": _truncate_str(result_content, 200),
                            }
                        )

                        history_messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": tool_use_id,
                                "content": result_content,
                            }
                        )

                        if stream:
                            _emit_jsonl(
                                {
                                    "type": "tool_result",
                                    "tool": tool_name,
                                    "success": not is_error,
                                    "output_preview": _truncate_str(result_content, 200),
                                }
                            )

    except Exception as e:
        logger.error("Execute 异常: {}", e)
        _progress(f"❌ 错误: {e}")
        result = {
            "status": "error",
            "session_id": session_id,
            "error": str(e),
            "turns_used": turns_used,
            "tool_calls": tool_calls_log,
        }
        if stream:
            _emit_jsonl({"type": "error", "error": str(e)})
        _output_json(result)
        sys.exit(1)

    # 检查是否因 AskUser 而挂起
    if context.suspend_requested:
        suspend = context.suspend_data
        _progress(f"⏸️  需要输入: {suspend.get('question', '')}")

        from interfaces.cli.session_store import save_session

        save_session(
            session_id=session_id,
            messages=history_messages,
            system_prompt=system_prompt,
            model=resolved_model,
            cwd=str(resolved_cwd),
            status="needs_input",
            suspend_data=suspend,
        )

        result = {
            "status": "needs_input",
            "session_id": session_id,
            "question": suspend.get("question", ""),
            "options": suspend.get("options"),
            "progress": _truncate_str(accumulated_text, 500),
            "turns_used": turns_used,
            "tool_calls": tool_calls_log,
        }
        if stream:
            _emit_jsonl({"type": "needs_input", **{k: v for k, v in result.items() if k != "tool_calls"}})
        _output_json(result)
        sys.exit(10)

    # 正常完成
    _progress(f"✅ 完成 ({turns_used} turns, {len(tool_calls_log)} tool calls)")

    from interfaces.cli.session_store import save_session

    save_session(
        session_id=session_id,
        messages=history_messages,
        system_prompt=system_prompt,
        model=resolved_model,
        cwd=str(resolved_cwd),
        status="completed",
    )

    result = {
        "status": "completed",
        "session_id": session_id,
        "result": accumulated_text,
        "turns_used": turns_used,
        "tool_calls": tool_calls_log,
    }
    if stream:
        _emit_jsonl({"type": "complete", "status": "completed", "session_id": session_id})
    _output_json(result)


async def continue_session(
    session_id: str,
    answer: str,
    stream: bool = False,
):
    """继续一个被挂起的 session"""
    from interfaces.cli.session_store import load_session, save_session

    session_data = load_session(session_id)
    if session_data is None:
        _output_json({"status": "error", "error": f"Session '{session_id}' not found"})
        sys.exit(1)

    if session_data.get("status") != "needs_input":
        _output_json(
            {
                "status": "error",
                "error": f"Session '{session_id}' status is '{session_data.get('status')}', expected 'needs_input'",
            }
        )
        sys.exit(1)

    config = get_config()
    resolved_model = session_data["model"]
    system_prompt = session_data["system_prompt"]
    saved_messages = session_data["messages"]
    resolved_cwd = Path(session_data["cwd"])
    max_turns = config.get("agent.max_turns", 10)

    context = _create_context(session_id, resolved_cwd)
    client = OpenRouterClient()
    _progress(f"Continue session {session_id} | answer: {_truncate_str(answer, 80)}")

    tool_calls_log: list[dict[str, Any]] = []
    history_messages: list[dict[str, Any]] = list(saved_messages)
    accumulated_text = ""
    turns_used = 0
    tool_id_to_name: dict[str, str] = {}

    try:
        async for item in query(
            user_input=answer,
            context=context,
            client=client,
            model=resolved_model,
            max_turns=max_turns,
            thinking=False,
            history_messages=history_messages,
            system_prompt=system_prompt,
        ):
            if not hasattr(item, "type"):
                continue

            if isinstance(item, RequestStartEvent):
                _progress(f"⏳ Turn {turns_used + 1}: 等待模型回复...")
                continue

            if isinstance(item, StreamEvent):
                if item.type == "stream_chunk" and item.data:
                    text = item.data.get("text", "")
                    if text and stream:
                        _emit_jsonl({"type": "text", "content": text})
                continue

            if isinstance(item, AssistantMessage):
                turns_used += 1
                content = item.message.get("content", [])
                msg_dict = _convert_assistant_message(content)
                history_messages.append(msg_dict)

                for block in content:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "text":
                        text = block.get("text", "")
                        if text.strip():
                            accumulated_text = text
                    elif block.get("type") == "tool_use":
                        tool_name = block.get("name", "")
                        tool_id = block.get("id", "")
                        tool_input = block.get("input", {})
                        tool_id_to_name[tool_id] = tool_name

                        input_preview = _truncate_str(json.dumps(tool_input, ensure_ascii=False), 120)
                        _progress(f"🔧 调用: {tool_name} {input_preview}")

                        if stream:
                            _emit_jsonl(
                                {
                                    "type": "tool_call",
                                    "tool": tool_name,
                                    "input": _truncate_dict(tool_input),
                                }
                            )

            elif hasattr(item, "type") and item.type == "user":
                content = item.message.get("content", [])
                if getattr(item, "is_meta", False):
                    continue

                for blk in content:
                    if isinstance(blk, dict) and blk.get("type") == "tool_result":
                        tool_use_id = blk.get("tool_use_id", "")
                        result_content = blk.get("content", "")
                        is_error = blk.get("is_error", False)
                        tool_name = blk.get("tool_name") or tool_id_to_name.get(tool_use_id, "")

                        if is_error:
                            _progress(f"❌ {tool_name}: {_truncate_str(result_content, 100)}")
                        else:
                            _progress(f"✅ {tool_name}: {_truncate_str(result_content, 100)}")

                        tool_calls_log.append(
                            {
                                "tool": tool_name,
                                "tool_use_id": tool_use_id,
                                "success": not is_error,
                                "output_preview": _truncate_str(result_content, 200),
                            }
                        )

                        history_messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": tool_use_id,
                                "content": result_content,
                            }
                        )

                        if stream:
                            _emit_jsonl(
                                {
                                    "type": "tool_result",
                                    "tool": tool_name,
                                    "success": not is_error,
                                    "output_preview": _truncate_str(result_content, 200),
                                }
                            )

    except Exception as e:
        logger.error("Continue 异常: {}", e)
        _progress(f"❌ 错误: {e}")
        result = {
            "status": "error",
            "session_id": session_id,
            "error": str(e),
            "turns_used": turns_used,
            "tool_calls": tool_calls_log,
        }
        if stream:
            _emit_jsonl({"type": "error", "error": str(e)})
        _output_json(result)
        sys.exit(1)

    # 再次检查挂起
    if context.suspend_requested:
        suspend = context.suspend_data
        _progress(f"⏸️  需要输入: {suspend.get('question', '')}")
        save_session(
            session_id=session_id,
            messages=history_messages,
            system_prompt=system_prompt,
            model=resolved_model,
            cwd=str(resolved_cwd),
            status="needs_input",
            suspend_data=suspend,
        )

        result = {
            "status": "needs_input",
            "session_id": session_id,
            "question": suspend.get("question", ""),
            "options": suspend.get("options"),
            "progress": _truncate_str(accumulated_text, 500),
            "turns_used": turns_used,
            "tool_calls": tool_calls_log,
        }
        if stream:
            _emit_jsonl({"type": "needs_input", **{k: v for k, v in result.items() if k != "tool_calls"}})
        _output_json(result)
        sys.exit(10)

    # 正常完成
    _progress(f"✅ 完成 ({turns_used} turns, {len(tool_calls_log)} tool calls)")

    save_session(
        session_id=session_id,
        messages=history_messages,
        system_prompt=system_prompt,
        model=resolved_model,
        cwd=str(resolved_cwd),
        status="completed",
    )

    result = {
        "status": "completed",
        "session_id": session_id,
        "result": accumulated_text,
        "turns_used": turns_used,
        "tool_calls": tool_calls_log,
    }
    if stream:
        _emit_jsonl({"type": "complete", "status": "completed", "session_id": session_id})
    _output_json(result)


def _truncate_str(s: str, max_len: int = 200) -> str:
    if len(s) <= max_len:
        return s
    return s[:max_len] + "..."


def _truncate_dict(d: dict[str, Any], max_str_len: int = 100) -> dict[str, Any]:
    """截断 dict 中过长的字符串值，用于日志/输出"""
    result = {}
    for k, v in d.items():
        if isinstance(v, str) and len(v) > max_str_len:
            result[k] = v[:max_str_len] + "..."
        else:
            result[k] = v
    return result
