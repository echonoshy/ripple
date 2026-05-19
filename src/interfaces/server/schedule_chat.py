"""Conversation helpers for schedule creation.

Schedule creation is a Ripple control-plane workflow. Codex may be used as a
structured extractor, but Ripple validates the extracted draft and owns
confirmation plus persistence.
"""

import json
import re
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from interfaces.server.schemas import CodexSummaryMode, ScheduleCreateRequest
from ripple.utils.time import current_time_context

SCHEDULE_EXTRACTION_MAX_RUNTIME_SECONDS = 120

SCHEDULE_EXTRACTION_OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["is_schedule_request", "missing_fields", "clarification_question", "schedule"],
    "properties": {
        "is_schedule_request": {"type": "boolean"},
        "missing_fields": {"type": "array", "items": {"type": "string"}},
        "clarification_question": {"type": ["string", "null"]},
        "schedule": {
            "type": ["object", "null"],
            "additionalProperties": False,
            "required": [
                "title",
                "prompt",
                "kind",
                "timezone",
                "run_at",
                "interval_seconds",
                "enabled",
                "cwd",
                "model",
                "effort",
                "summary",
                "output_schema",
                "max_runtime_seconds",
                "max_runs",
            ],
            "properties": {
                "title": {"type": ["string", "null"]},
                "prompt": {"type": ["string", "null"]},
                "kind": {"type": ["string", "null"], "enum": ["once", "interval", None]},
                "timezone": {"type": ["string", "null"]},
                "run_at": {"type": ["string", "null"]},
                "interval_seconds": {"type": ["integer", "null"], "minimum": 1},
                "enabled": {"type": "boolean"},
                "cwd": {"type": ["string", "null"]},
                "model": {"type": ["string", "null"]},
                "effort": {"type": ["string", "null"]},
                # This is Codex's turn-summary mode, not a free-form user-facing description.
                "summary": {"type": "null"},
                # Schedule creation from chat does not currently infer a custom final output schema for the
                # future Codex run. Keeping this null also makes the extractor schema valid for OpenAI strict
                # structured outputs, which disallow arbitrary nested objects.
                "output_schema": {"type": "null"},
                "max_runtime_seconds": {"type": ["integer", "null"], "minimum": 1, "maximum": 86400},
                "max_runs": {"type": ["integer", "null"], "minimum": 1},
            },
        },
    },
}

_SCHEDULE_KEYWORD_RE = re.compile(
    r"(定时|定一个|周期|重复|每[天周月年]|每天|每周|每月|每隔|提醒|闹钟|schedule|scheduled|recurring|remind)",
    re.IGNORECASE,
)
_RELATIVE_TIME_RE = re.compile(
    r"(\d+)\s*(秒|分钟|小时|天|周|个月|seconds?|minutes?|hours?|days?|weeks?)\s*(后|以后|之后|later)?",
    re.IGNORECASE,
)

_CONFIRM_WORDS = {
    "y",
    "yes",
    "ok",
    "okay",
    "confirm",
    "create",
    "确认",
    "确定",
    "创建",
    "确认创建",
    "可以",
    "好的",
    "好",
    "同意",
}

_CANCEL_WORDS = {
    "n",
    "no",
    "cancel",
    "stop",
    "取消",
    "放弃",
    "不要",
    "不用",
    "先不要",
}


class ScheduleDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = None
    prompt: str | None = None
    kind: Literal["once", "interval"] | None = None
    timezone: str | None = None
    run_at: str | None = None
    interval_seconds: int | None = Field(default=None, ge=1)
    enabled: bool = True
    cwd: str | None = None
    model: str | None = None
    effort: str | None = None
    summary: CodexSummaryMode | None = None
    output_schema: dict[str, Any] | None = None
    max_runtime_seconds: int | None = Field(default=1800, ge=1, le=86_400)
    max_runs: int | None = Field(default=None, ge=1)


class ScheduleExtractionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    is_schedule_request: bool
    missing_fields: list[str] = Field(default_factory=list)
    clarification_question: str | None = None
    schedule: ScheduleDraft | None = None


@dataclass(frozen=True)
class ScheduleProposal:
    payload: dict[str, Any]
    message: str
    question: str
    options: list[str]


def is_schedule_intent(text: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return False
    return bool(_SCHEDULE_KEYWORD_RE.search(stripped) or _RELATIVE_TIME_RE.search(stripped))


def build_schedule_extraction_prompt(user_input: str) -> str:
    return (
        "You are a strict schedule-request extractor for Ripple.\n"
        f"{current_time_context()}\n\n"
        "Extract whether the user wants Ripple to create a future or recurring Codex task.\n"
        "Return only data that matches the provided output schema.\n\n"
        "Rules:\n"
        "- Set is_schedule_request=true only when the user is asking to create a future/recurring task.\n"
        "- For relative time such as '2 minutes later' or '2分钟以后', convert it to an absolute ISO 8601 run_at "
        "with timezone offset.\n"
        "- Use kind='once' for one-time future tasks and kind='interval' for recurring tasks.\n"
        "- For interval schedules, interval_seconds is required. For once schedules, run_at is required.\n"
        "- If the user says to run a recurring task a fixed number of times, set schedule.max_runs to that count.\n"
        "- If the user asks to run more than once but does not provide a recurrence interval, set schedule=null, "
        "include interval_seconds in missing_fields, and ask how often it should repeat.\n"
        "- Always set schedule.summary=null. It is an internal Codex configuration field, not a free-form task "
        "description.\n"
        "- schedule.prompt is the exact instruction Codex should receive when the schedule fires.\n"
        "- Preserve execution-time intent in schedule.prompt. For example, if the user asks for a filename based on "
        "the execution date/time, say to compute it at execution time rather than hard-coding the extraction time.\n"
        "- Do not execute the task now. Do not create timers, cron jobs, sleep loops, or background daemons.\n"
        "- If required information is missing, set schedule=null, list missing_fields, and provide one concise "
        "clarification_question.\n\n"
        f"User request:\n{user_input.strip()}\n"
    )


def parse_schedule_extraction_output(text: str) -> ScheduleExtractionResult:
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError("schedule extraction did not return valid JSON") from exc
    try:
        return ScheduleExtractionResult.model_validate(raw)
    except ValidationError as exc:
        raise ValueError(f"schedule extraction did not match schema: {exc}") from exc


def schedule_extraction_clarification(result: ScheduleExtractionResult) -> str | None:
    if not result.is_schedule_request:
        return None
    if result.clarification_question and result.clarification_question.strip():
        return result.clarification_question.strip()
    if result.missing_fields:
        return "还需要补充：" + "、".join(result.missing_fields)
    if result.schedule is None:
        return "还需要补充定时任务的时间和执行内容。"
    return None


def schedule_proposal_from_extraction(result: ScheduleExtractionResult) -> ScheduleProposal | None:
    if not result.is_schedule_request or result.schedule is None:
        return None
    payload = normalize_schedule_payload(result.schedule)
    return ScheduleProposal(
        payload=payload,
        message=build_schedule_confirmation_message(payload),
        question="要创建这个定时任务吗？",
        options=["确认创建", "取消"],
    )


def normalize_schedule_payload(draft: ScheduleDraft) -> dict[str, Any]:
    payload = draft.model_dump()
    if not payload.get("timezone"):
        payload["timezone"] = "UTC"
    if not payload.get("kind"):
        payload["kind"] = "once"
    if payload.get("enabled") is None:
        payload["enabled"] = True
    if payload.get("max_runtime_seconds") is None:
        payload["max_runtime_seconds"] = 1800

    try:
        request = ScheduleCreateRequest(**payload)
    except Exception as exc:
        raise ValueError(f"invalid extracted schedule: {exc}") from exc

    normalized = request.model_dump(by_alias=False)
    kind = normalized.get("kind")
    if kind == "once" and not normalized.get("run_at"):
        raise ValueError("run_at is required for once schedules")
    if kind == "interval" and not normalized.get("interval_seconds"):
        raise ValueError("interval_seconds is required for interval schedules")
    if kind != "interval" and normalized.get("max_runs") is not None:
        raise ValueError("max_runs is only supported for interval schedules")
    return normalized


def build_schedule_confirmation_message(payload: dict[str, Any]) -> str:
    title = str(payload.get("title") or "").strip()
    prompt = str(payload.get("prompt") or "").strip()
    timezone_name = str(payload.get("timezone") or "UTC")
    kind = str(payload.get("kind") or "once")
    if kind == "interval":
        timing = f"每 {_human_interval(int(payload.get('interval_seconds') or 0))}"
        run_at = payload.get("run_at")
        if run_at:
            timing += f"，从 {run_at} 开始"
    else:
        timing = f"在 {payload.get('run_at')}"

    return (
        "我可以创建这个定时任务：\n"
        f"- 标题：{title}\n"
        f"- 类型：{'周期任务' if kind == 'interval' else '一次性任务'}\n"
        f"- 时间：{timing}（时区：{timezone_name}）\n"
        f"- 次数：{_run_limit_label(payload)}\n"
        f"- 执行内容：{prompt}\n\n"
        "回复“确认创建”来创建，或回复“取消”放弃。"
    )


def build_schedule_created_message(record: dict[str, Any]) -> str:
    next_run_at = record.get("next_run_at")
    next_line = f"下一次运行时间：{next_run_at}" if next_run_at else "当前没有下一次运行时间。"
    return f"已创建定时任务「{record.get('title')}」。{next_line}"


def build_schedule_cancelled_message(payload: dict[str, Any] | None) -> str:
    title = str((payload or {}).get("title") or "这个定时任务")
    return f"已取消创建「{title}」。"


def build_schedule_pending_message(payload: dict[str, Any]) -> str:
    title = str(payload.get("title") or "这个定时任务")
    return f"「{title}」还在等待确认。请回复“确认创建”或“取消”。"


def is_schedule_confirmation(text: str) -> bool:
    normalized = _normalize_reply(text)
    return normalized in _CONFIRM_WORDS


def is_schedule_cancellation(text: str) -> bool:
    normalized = _normalize_reply(text)
    return normalized in _CANCEL_WORDS


def schedule_proposal_event(proposal: ScheduleProposal) -> dict[str, Any]:
    return {
        "type": "schedule_proposed",
        "message": proposal.message,
        "question": proposal.question,
        "options": proposal.options,
        "schedule": proposal.payload,
    }


def schedule_clarification_event(message: str) -> dict[str, Any]:
    return {
        "type": "schedule_clarification_required",
        "message": message,
        "question": message,
        "options": [],
    }


def schedule_extraction_failed_event(message: str) -> dict[str, Any]:
    return {"type": "schedule_extraction_failed", "message": message}


def schedule_created_event(record: dict[str, Any], message: str) -> dict[str, Any]:
    return {"type": "schedule_created", "message": message, "schedule": record}


def schedule_cancelled_event(message: str) -> dict[str, Any]:
    return {"type": "schedule_cancelled", "message": message}


def schedule_pending_event(message: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "schedule_pending_confirmation",
        "message": message,
        "question": "要创建这个定时任务吗？",
        "options": ["确认创建", "取消"],
        "schedule": payload,
    }


def agent_stop_ask_user_event(
    message: str, question: str, options: list[str], schedule: dict[str, Any] | None = None
) -> dict[str, Any]:
    return {
        "type": "agent_stop",
        "stop_reason": "ask_user",
        "metadata": {
            "message": message,
            "question": question,
            "options": options,
            "schedule": schedule or {},
        },
    }


def _normalize_reply(text: str) -> str:
    normalized = text.strip().casefold()
    normalized = re.sub(r"[\s。.!！?？,，;；:：\"'“”‘’]+", "", normalized)
    return normalized


def _human_interval(seconds: int) -> str:
    if seconds <= 0:
        return "指定间隔"
    units = [
        (7 * 24 * 3600, "周"),
        (24 * 3600, "天"),
        (3600, "小时"),
        (60, "分钟"),
    ]
    for unit_seconds, label in units:
        if seconds % unit_seconds == 0:
            value = seconds // unit_seconds
            return f"{value} {label}"
    return f"{seconds} 秒"


def _run_limit_label(payload: dict[str, Any]) -> str:
    if payload.get("kind") != "interval":
        return "1 次"
    max_runs = payload.get("max_runs")
    if isinstance(max_runs, int) and max_runs > 0:
        return f"最多 {max_runs} 次"
    return "不限次数"
