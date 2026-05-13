"""Deterministic first-pass routing for Ripple task delegation."""

from enum import Enum

from pydantic import BaseModel, Field


class ExecutionRoute(str, Enum):
    DIRECT = "direct"
    RIPPLE_TOOLS = "ripple_tools"
    AGENT_RUNNER = "agent_runner"


class RoutingDecision(BaseModel):
    route: ExecutionRoute
    reason: str
    provider: str | None = None
    signals: list[str] = Field(default_factory=list)


_BASIC_TOOL_TERMS = {
    "alarm",
    "remind",
    "reminder",
    "schedule",
    "timer",
    "定时",
    "提醒",
}

_COMPLEX_ACTION_TERMS = {
    "analyze",
    "build",
    "debug",
    "generate",
    "fix",
    "implement",
    "inspect",
    "investigate",
    "refactor",
    "summarize",
    "test",
    "分析",
    "读取",
    "修复",
    "实现",
    "总结",
    "整理",
    "生成",
    "改代码",
    "排查",
    "调试",
    "重构",
}

_COMPLEX_OBJECT_TERMS = {
    "api",
    "bug",
    "compile",
    "document",
    "drive",
    "frontend",
    "gmail",
    "google",
    "notion",
    "package.json",
    "project",
    "pytest",
    "repo",
    "repository",
    "skill",
    "test failure",
    "typescript",
    "workspace",
    "代码",
    "仓库",
    "文件",
    "功能",
    "多文件",
    "失败",
    "文档",
    "项目",
    "测试",
}


def _contains_any(text: str, terms: set[str]) -> bool:
    return any(term in text for term in terms)


def choose_route(
    prompt: str,
    *,
    explicit_provider: str | None = None,
    default_provider: str = "codex",
    skill_names: list[str] | None = None,
) -> RoutingDecision:
    """Choose whether Ripple should answer, use tools/skills, or delegate coding work."""
    normalized = prompt.casefold()
    signals: list[str] = []

    if explicit_provider and explicit_provider != "auto":
        signals.append("explicit_provider")
        return RoutingDecision(
            route=ExecutionRoute.AGENT_RUNNER,
            provider=explicit_provider,
            signals=signals,
            reason=f"User or caller explicitly requested external provider '{explicit_provider}'.",
        )

    if _contains_any(normalized, _BASIC_TOOL_TERMS):
        signals.append("basic_tool")
        return RoutingDecision(
            route=ExecutionRoute.RIPPLE_TOOLS,
            signals=signals,
            reason="Request appears to need a basic Ripple tool such as scheduling.",
        )

    skill_terms = {name.casefold() for name in skill_names or []}
    if skill_terms and _contains_any(normalized, skill_terms):
        signals.append("skill_match")

    has_complex_action = _contains_any(normalized, _COMPLEX_ACTION_TERMS)
    has_complex_object = _contains_any(normalized, _COMPLEX_OBJECT_TERMS)
    if has_complex_action and (has_complex_object or "skill_match" in signals):
        signals.append("complex_task")
        return RoutingDecision(
            route=ExecutionRoute.AGENT_RUNNER,
            provider=default_provider,
            signals=signals,
            reason="Request looks like complex sandbox work suitable for the trusted external agent runner.",
        )

    return RoutingDecision(
        route=ExecutionRoute.DIRECT,
        signals=signals,
        reason="Request can be handled directly by the primary Ripple agent.",
    )
