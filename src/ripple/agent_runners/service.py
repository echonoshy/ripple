"""Shared service helpers for starting external agent runs.

This module is the control-plane boundary between Ripple and Codex. Callers can
use it from chat tools or HTTP routes without duplicating workspace validation,
routing, and sandbox metadata construction.
"""

from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from ripple.agent_runners.manager import ExternalAgentJob, ExternalAgentManager
from ripple.agent_runners.models import AgentRunnerRequest
from ripple.agent_runners.router import ExecutionRoute, RoutingDecision, choose_route


@dataclass
class AgentRunNotRoutedError(ValueError):
    """Raised when auto routing decides a request should not launch Codex."""

    decision: RoutingDecision

    def __str__(self) -> str:
        return self.decision.reason


def resolve_workspace_cwd(raw_cwd: str | None, workspace_root: Path) -> Path:
    """Resolve a caller-provided cwd while keeping it inside the workspace."""

    root = workspace_root.resolve()
    if raw_cwd:
        candidate = Path(raw_cwd)
        sandbox_path = PurePosixPath(str(candidate))
        sandbox_root = PurePosixPath("/workspace")
        if candidate.is_absolute() and (sandbox_path == sandbox_root or sandbox_root in sandbox_path.parents):
            relative = sandbox_path.relative_to(sandbox_root)
            candidate = root.joinpath(*relative.parts)
        elif not candidate.is_absolute():
            candidate = root / candidate
        candidate = candidate.resolve()
    else:
        candidate = root
    if not candidate.is_relative_to(root):
        raise ValueError("cwd must stay inside the user workspace")
    return candidate


def sandbox_cwd_for_host_path(cwd: Path, workspace_root: Path) -> str:
    """Convert a host workspace path to the sandbox-visible /workspace path."""

    relative_cwd = cwd.resolve().relative_to(workspace_root.resolve())
    return PurePosixPath("/workspace", *relative_cwd.parts).as_posix()


def start_agent_run(
    *,
    prompt: str,
    input_items: list[dict[str, Any]] | None = None,
    model: str | None = None,
    effort: str | None = None,
    summary: str | None = None,
    output_schema: dict[str, Any] | None = None,
    provider_name: str,
    raw_cwd: str | None,
    max_runtime_seconds: int,
    user_id: str | None,
    session_id: str | None,
    workspace_root: Path,
    runtime_dir: Path,
    manager: ExternalAgentManager,
    sandbox_config: Any | None,
    require_agent_route: bool = True,
) -> ExternalAgentJob:
    """Start a Codex-backed agent run in the current user's workspace."""

    clean_prompt = prompt.strip()
    if not clean_prompt:
        raise ValueError("prompt is required")

    explicit_provider = None if provider_name == "auto" else provider_name
    if explicit_provider is not None and explicit_provider != "codex":
        raise ValueError("Only the codex provider is supported in this version")

    decision = choose_route(clean_prompt, explicit_provider=explicit_provider)
    if require_agent_route and explicit_provider is None and decision.route != ExecutionRoute.AGENT_RUNNER:
        raise AgentRunNotRoutedError(decision)

    provider = decision.provider or explicit_provider or "codex"
    if not manager.has_provider(provider):
        raise ValueError(f"external agent provider '{provider}' is not configured")

    cwd = resolve_workspace_cwd(raw_cwd, workspace_root)
    metadata: dict[str, Any] = {"route": decision.route.value, "signals": decision.signals}
    metadata["sandbox_cwd"] = sandbox_cwd_for_host_path(cwd, workspace_root)
    if sandbox_config is not None:
        metadata["sandbox_config"] = sandbox_config

    runtime_dir.mkdir(parents=True, exist_ok=True)
    return manager.start(
        AgentRunnerRequest(
            provider=provider,
            prompt=clean_prompt,
            cwd=cwd,
            input_items=input_items or [],
            model=model,
            effort=effort,
            summary=summary,
            output_schema=output_schema,
            max_runtime_seconds=max_runtime_seconds,
            user_id=user_id,
            session_id=session_id,
            metadata=metadata,
        ),
        runtime_dir=runtime_dir,
    )
