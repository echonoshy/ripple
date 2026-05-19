"""Connector metadata and status models."""

from dataclasses import dataclass, field
from typing import Any, Protocol

from ripple.sandbox.config import SandboxConfig


@dataclass(frozen=True)
class ConnectorInfo:
    name: str
    display_name: str
    description: str
    auth_type: str
    kind: str = "user_connector"
    auth_flow: str = "none"
    auth_surfaces: dict[str, bool] = field(default_factory=lambda: {"web": False, "chat": False})
    auth_start_path: str | None = None
    auth_complete_path: str | None = None
    disconnect_path: str | None = None
    accounts_path: str | None = None


@dataclass(frozen=True)
class ConnectorStatus:
    name: str
    connected: bool
    required: bool
    detail: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ConnectorActionResult:
    name: str
    ok: bool
    stage: str = ""
    detail: str = ""
    data: dict[str, Any] = field(default_factory=dict)


class ConnectorUnsupportedError(RuntimeError):
    """Raised when a connector does not support the requested action."""


class Connector(Protocol):
    info: ConnectorInfo

    def status(self, config: SandboxConfig, user_id: str) -> ConnectorStatus: ...

    async def auth_start(
        self,
        config: SandboxConfig,
        user_id: str,
        payload: dict[str, Any],
        *,
        request_base_url: str | None = None,
    ) -> ConnectorActionResult: ...

    async def auth_complete(
        self,
        config: SandboxConfig,
        user_id: str,
        payload: dict[str, Any],
    ) -> ConnectorActionResult: ...

    async def disconnect(
        self,
        config: SandboxConfig,
        user_id: str,
        payload: dict[str, Any],
    ) -> ConnectorActionResult: ...
