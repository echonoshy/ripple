"""Codex app-server based external agent provider.

Ripple installs Codex once on the server, then starts a trusted app-server
process lazily per user sandbox. Each job creates a fresh thread/turn while
Ripple owns lifecycle, events, cancellation, and output files.
"""

import asyncio
import json
import os
import shlex
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ripple.agent_runners.approvals import codex_approval_response_for_action, parse_codex_approval_request
from ripple.agent_runners.models import (
    AgentRunnerEvent,
    AgentRunnerRequest,
    AgentRunnerResult,
    AgentRunnerStatus,
)

_TAIL_CHARS = 64_000
_VALID_SANDBOX_TYPES = ("read-only", "workspace-write", "danger-full-access")
_SANDBOX_TYPE_ALIASES = {
    "readOnly": "read-only",
    "read_only": "read-only",
    "workspaceWrite": "workspace-write",
    "workspace_write": "workspace-write",
    "dangerFullAccess": "danger-full-access",
    "danger_full_access": "danger-full-access",
}
_SANDBOX_POLICY_TYPES = {
    "read-only": "readOnly",
    "workspace-write": "workspaceWrite",
    "danger-full-access": "dangerFullAccess",
}
_RIPPLE_CODEX_PERMISSION_PROFILE = "ripple_workspace"
_CODEX_NATIVE_INPUT_TYPES = {"text", "image", "localImage", "skill", "mention"}


def _prepend_path_entries(existing_path: str, entries: list[str]) -> str:
    clean_entries = [entry for entry in entries if entry]
    return ":".join([*clean_entries, existing_path]) if existing_path else ":".join(clean_entries)


def _codex_input_items(request: AgentRunnerRequest) -> list[dict[str, Any]]:
    items = request.input_items or [{"type": "text", "text": request.prompt}]
    native_items = [
        dict(item) for item in items if isinstance(item, dict) and item.get("type") in _CODEX_NATIVE_INPUT_TYPES
    ]
    if not native_items or not any(item.get("type") == "text" for item in native_items):
        native_items.append({"type": "text", "text": request.prompt})
    return native_items


def _codex_turn_config_params(request: AgentRunnerRequest) -> dict[str, Any]:
    params: dict[str, Any] = {}
    if request.model:
        params["model"] = request.model
    if request.effort:
        params["effort"] = request.effort
    if request.summary:
        params["summary"] = request.summary
    if request.output_schema:
        params["outputSchema"] = request.output_schema
    return params


def _host_app_server_env_from_sandbox(config: Any, user_id: str, workspace: Path, current_path: str) -> dict[str, str]:
    """Translate per-user sandbox env semantics to host-visible app-server env."""

    workspace = workspace.resolve()
    path_entries = [str(workspace / ".local" / "bin")]

    if getattr(config, "uv_bin_dir", None):
        path_entries.append(str(config.uv_bin_dir))
    if getattr(config, "node_dir", None):
        path_entries.append(str(Path(str(config.node_dir)) / "bin"))
    for attr in ("lark_cli_install_root", "notion_cli_install_root", "gogcli_cli_install_root"):
        root = getattr(config, attr, None)
        if root:
            path_entries.append(str(Path(str(root)) / "current" / "bin"))

    env = {
        "PATH": _prepend_path_entries(current_path, path_entries),
        "HOME": str(workspace),
        "USER": "sandbox",
        "SHELL": os.environ.get("SHELL", "/bin/bash"),
        "TERM": os.environ.get("TERM", "xterm-256color"),
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "XDG_CONFIG_HOME": str(workspace / ".config"),
    }

    if getattr(config, "uv_cache_dir", None):
        config.uv_cache_dir.mkdir(parents=True, exist_ok=True)
        env["UV_CACHE_DIR"] = str(config.uv_cache_dir)
        env["UV_LINK_MODE"] = "hardlink"
    if getattr(config, "pypi_mirror_url", None):
        env["UV_INDEX_URL"] = str(config.pypi_mirror_url)
        env["PIP_INDEX_URL"] = str(config.pypi_mirror_url)
    if getattr(config, "node_dir", None):
        env["PNPM_HOME"] = str(workspace / ".local" / "bin")
        env["NPM_CONFIG_PREFIX"] = str(workspace / ".local")
        if getattr(config, "pnpm_cache_dir", None):
            config.pnpm_cache_dir.mkdir(parents=True, exist_ok=True)
            env["PNPM_STORE_DIR"] = str(config.pnpm_cache_dir)
        if getattr(config, "corepack_cache_dir", None):
            config.corepack_cache_dir.mkdir(parents=True, exist_ok=True)
            env["COREPACK_HOME"] = str(config.corepack_cache_dir)
        if getattr(config, "npm_registry_url", None):
            env["NPM_CONFIG_REGISTRY"] = str(config.npm_registry_url)
            env["COREPACK_NPM_REGISTRY"] = str(config.npm_registry_url)
        env["COREPACK_ENABLE_AUTO_PIN"] = "0"
        env["COREPACK_ENABLE_DOWNLOAD_PROMPT"] = "0"

    from ripple.sandbox.notion import read_notion_token

    notion_token = read_notion_token(config, user_id)
    if notion_token:
        env["NOTION_API_TOKEN"] = notion_token

    if getattr(config, "gogcli_cli_install_root", None):
        env["GOG_KEYRING_BACKEND"] = "file"
        pass_file = config.gogcli_keyring_pass_file(user_id)
        if pass_file.exists():
            password = pass_file.read_text(encoding="utf-8").strip()
            if password:
                env["GOG_KEYRING_PASSWORD"] = password

    return env


def _tail(text: str) -> str:
    return text[-_TAIL_CHARS:]


def _decode_line(data: bytes) -> str:
    return data.decode("utf-8", errors="replace").rstrip("\n")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _normalize_sandbox_type(value: str) -> str:
    normalized = _SANDBOX_TYPE_ALIASES.get(value.strip(), value.strip())
    if normalized not in _VALID_SANDBOX_TYPES:
        expected = ", ".join(_VALID_SANDBOX_TYPES)
        raise ValueError(f"unknown Codex sandbox type {value!r}; expected one of: {expected}")
    return normalized


def _sandbox_policy_type(sandbox_type: str) -> str:
    return _SANDBOX_POLICY_TYPES[sandbox_type]


def _dedupe_paths(paths: list[Path]) -> list[Path]:
    seen: set[str] = set()
    result: list[Path] = []
    for path in paths:
        try:
            normalized = path.expanduser().resolve()
        except OSError:
            normalized = path.expanduser().absolute()
        key = str(normalized)
        if key not in seen:
            seen.add(key)
            result.append(normalized)
    return result


def _codex_auth_deny_read_paths(codex_home: Path | None) -> list[Path]:
    paths: list[Path] = []
    if codex_home is not None:
        paths.append(codex_home)
    paths.append(Path.home() / ".codex")
    if os.environ.get("CODEX_HOME"):
        paths.append(Path(os.environ["CODEX_HOME"]))
    return _dedupe_paths(paths)


class JsonRpcError(RuntimeError):
    """Raised when app-server returns a JSON-RPC error."""


class JsonRpcTimeoutError(TimeoutError):
    """Raised when app-server does not answer one JSON-RPC request in time."""


@dataclass
class ActiveTurn:
    session: "CodexAppServerSession"
    thread_id: str
    turn_id: str


class CodexAppServerSession:
    """One running Codex app-server process for one user."""

    def __init__(
        self,
        *,
        user_key: str,
        codex_executable: str,
        app_server_args: list[str],
        cwd: Path,
        codex_home: Path | None = None,
        sandbox_config: Any | None = None,
        env: dict[str, str] | None = None,
        run_in_user_sandbox: bool = False,
        request_timeout_seconds: float = 30.0,
    ):
        self.user_key = user_key
        self.codex_executable = codex_executable
        self.app_server_args = app_server_args
        self.cwd = cwd
        self.codex_home = codex_home
        self.sandbox_config = sandbox_config
        self.env = env or {}
        self.run_in_user_sandbox = run_in_user_sandbox
        self.request_timeout_seconds = request_timeout_seconds
        self.process: asyncio.subprocess.Process | None = None
        self.notifications: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.run_lock = asyncio.Lock()
        self.last_active_at = _now()
        self.stderr_tail = ""
        self._next_id = 0
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._reader_task: asyncio.Task | None = None
        self._stderr_task: asyncio.Task | None = None
        self._initialized = False

    @property
    def is_running(self) -> bool:
        return self.process is not None and self.process.returncode is None

    async def ensure_started(self) -> None:
        if self.is_running:
            return
        self.cwd.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ)
        env.update(self.env)
        codex_home = self.codex_home or Path(env.get("CODEX_HOME", Path.home() / ".codex")).expanduser()
        codex_home.mkdir(parents=True, exist_ok=True)
        self.codex_home = codex_home
        if self.sandbox_config is not None and not self.run_in_user_sandbox:
            env.update(
                _host_app_server_env_from_sandbox(self.sandbox_config, self.user_key, self.cwd, env.get("PATH", ""))
            )
        env["CODEX_HOME"] = str(codex_home)
        argv = [self.codex_executable, *self.app_server_args]
        process_cwd = str(self.cwd)
        if self.sandbox_config is not None and self.run_in_user_sandbox:
            from ripple.sandbox.nsjail_config import build_nsjail_argv

            argv = build_nsjail_argv(self.sandbox_config, self.user_key, shlex.join(argv))
            process_cwd = None
        self.process = await asyncio.create_subprocess_exec(
            *argv,
            cwd=process_cwd,
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        self._reader_task = asyncio.create_task(self._read_stdout())
        self._stderr_task = asyncio.create_task(self._read_stderr())
        self._initialized = False

    async def ensure_initialized(self) -> None:
        await self.ensure_started()
        if self._initialized:
            return
        await self.request(
            "initialize",
            {
                "clientInfo": {"name": "ripple", "version": "0.1.0"},
                "capabilities": {"experimentalApi": True},
            },
        )
        await self.notify("initialized")
        self._initialized = True

    async def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        await self.ensure_started()
        if self.process is None or self.process.stdin is None:
            raise RuntimeError("codex app-server process is not writable")
        self._next_id += 1
        request_id = self._next_id
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[request_id] = future
        payload = {
            "id": request_id,
            "method": method,
            "params": params or {},
        }
        try:
            await self._write(payload)
            self.last_active_at = _now()
            response = await asyncio.wait_for(future, timeout=self.request_timeout_seconds)
        except TimeoutError as exc:
            self._pending.pop(request_id, None)
            raise JsonRpcTimeoutError(f"timed out waiting for Codex app-server response to {method}") from exc
        except Exception:
            self._pending.pop(request_id, None)
            raise
        if "error" in response:
            raise JsonRpcError(json.dumps(response["error"], ensure_ascii=False))
        result = response.get("result")
        return result if isinstance(result, dict) else {}

    async def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        await self.ensure_started()
        payload = {
            "method": method,
            "params": params or {},
        }
        await self._write(payload)
        self.last_active_at = _now()

    async def respond(self, request_id: Any, result: dict[str, Any]) -> None:
        await self.ensure_started()
        payload = {
            "id": request_id,
            "result": result,
        }
        await self._write(payload)
        self.last_active_at = _now()

    async def respond_error(self, request_id: Any, *, code: int, message: str, data: Any | None = None) -> None:
        await self.ensure_started()
        error: dict[str, Any] = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        payload = {
            "id": request_id,
            "error": error,
        }
        await self._write(payload)
        self.last_active_at = _now()

    async def _write(self, payload: dict[str, Any]) -> None:
        if self.process is None or self.process.stdin is None:
            raise RuntimeError("codex app-server process is not writable")
        self.process.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        await self.process.stdin.drain()

    async def stop(self) -> None:
        if self.process is None:
            return
        if self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), timeout=2)
            except TimeoutError:
                self.process.kill()
                await self.process.wait()
        for task in (self._reader_task, self._stderr_task):
            if task is not None and not task.done():
                task.cancel()

    async def _read_stdout(self) -> None:
        if self.process is None or self.process.stdout is None:
            return
        while line_bytes := await self.process.stdout.readline():
            line = _decode_line(line_bytes)
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                await self.notifications.put({"method": "codex/stdout", "params": {"text": line}})
                continue
            message_id = message.get("id")
            if message_id in self._pending and ("result" in message or "error" in message):
                future = self._pending.pop(message_id)
                if not future.done():
                    future.set_result(message)
            elif "method" in message:
                await self.notifications.put(message)
        error = RuntimeError(f"codex app-server process exited before responding; stderr={self.stderr_tail[-1000:]}")
        for future in list(self._pending.values()):
            if not future.done():
                future.set_exception(error)
        self._pending.clear()

    async def _read_stderr(self) -> None:
        if self.process is None or self.process.stderr is None:
            return
        while line_bytes := await self.process.stderr.readline():
            line = _decode_line(line_bytes)
            self.stderr_tail = _tail(self.stderr_tail + line + "\n")


@dataclass
class CodexAppServerPool:
    codex_executable: str = "codex"
    app_server_args: list[str] = field(default_factory=lambda: ["app-server", "--listen", "stdio://"])
    codex_home: Path | None = None
    env: dict[str, str] | None = None
    idle_timeout_seconds: int = 1800
    run_in_user_sandbox: bool = False
    request_timeout_seconds: float = 30.0
    sessions: dict[str, CodexAppServerSession] = field(default_factory=dict)

    async def get(
        self,
        *,
        user_id: str | None,
        cwd: Path,
        sandbox_config: Any | None = None,
    ) -> CodexAppServerSession:
        user_key = user_id or "default"
        session = self.sessions.get(user_key)
        if session is None or not session.is_running:
            session = CodexAppServerSession(
                user_key=user_key,
                codex_executable=self.codex_executable,
                app_server_args=self.app_server_args,
                cwd=cwd,
                codex_home=self.codex_home,
                sandbox_config=sandbox_config,
                env=self.env,
                run_in_user_sandbox=self.run_in_user_sandbox,
                request_timeout_seconds=self.request_timeout_seconds,
            )
            self.sessions[user_key] = session
        await session.ensure_started()
        return session

    async def shutdown_idle(self) -> None:
        now = _now()
        for user_key, session in list(self.sessions.items()):
            idle_for = (now - session.last_active_at).total_seconds()
            if idle_for >= self.idle_timeout_seconds and not session.run_lock.locked():
                await session.stop()
                del self.sessions[user_key]

    async def stop_user(self, user_id: str) -> None:
        session = self.sessions.pop(user_id, None)
        if session is not None:
            await session.stop()

    async def stop_all(self) -> None:
        for session in list(self.sessions.values()):
            await session.stop()
        self.sessions.clear()


class CodexAppServerAgentProvider:
    """Runs Codex through a per-user trusted app-server process."""

    def __init__(
        self,
        *,
        codex_executable: str = "codex",
        app_server_args: list[str] | None = None,
        approval_policy: str = "never",
        sandbox_type: str = "workspace-write",
        network_access: bool = True,
        codex_home: str | Path | None = None,
        env: dict[str, str] | None = None,
        idle_timeout_seconds: int = 1800,
        run_app_server_in_user_sandbox: bool = False,
        ephemeral_threads: bool = True,
        request_timeout_seconds: float = 30.0,
    ):
        self.name = "codex"
        self.approval_policy = approval_policy
        self.sandbox_type = _normalize_sandbox_type(sandbox_type)
        self.sandbox_policy_type = _sandbox_policy_type(self.sandbox_type)
        self.network_access = network_access
        self.run_app_server_in_user_sandbox = run_app_server_in_user_sandbox
        self.ephemeral_threads = ephemeral_threads
        self.pool = CodexAppServerPool(
            codex_executable=codex_executable,
            app_server_args=app_server_args or ["app-server", "--listen", "stdio://"],
            codex_home=Path(codex_home) if codex_home else None,
            env=env,
            idle_timeout_seconds=idle_timeout_seconds,
            run_in_user_sandbox=run_app_server_in_user_sandbox,
            request_timeout_seconds=request_timeout_seconds,
        )
        self.active_turns: dict[str, ActiveTurn] = {}
        self.pending_approvals: dict[str, dict[str, Any]] = {}

    def _uses_managed_permission_profile(self) -> bool:
        return self.sandbox_type in {"workspace-write", "read-only"}

    def _thread_permission_config(self, codex_home: Path | None) -> dict[str, Any]:
        filesystem: dict[str, Any] = {":root": "read"}
        if self.sandbox_type == "workspace-write":
            filesystem[":project_roots"] = {
                ".": "write",
                ".git": "write",
                ".agents": "read",
                ".codex": "read",
            }
        for path in _codex_auth_deny_read_paths(codex_home):
            filesystem[str(path)] = "none"

        return {
            "default_permissions": _RIPPLE_CODEX_PERMISSION_PROFILE,
            "permissions": {
                _RIPPLE_CODEX_PERMISSION_PROFILE: {
                    "filesystem": filesystem,
                    "network": {"enabled": self.network_access},
                }
            },
            "shell_environment_policy": {"exclude": ["CODEX_HOME"]},
        }

    def _thread_start_permission_params(self, session: CodexAppServerSession) -> dict[str, Any]:
        if not self._uses_managed_permission_profile():
            return {"sandbox": self.sandbox_type}
        return {
            "config": self._thread_permission_config(session.codex_home),
            "permissions": {"type": "profile", "id": _RIPPLE_CODEX_PERMISSION_PROFILE},
        }

    def _turn_start_permission_params(self, runner_cwd: str) -> dict[str, Any]:
        if self._uses_managed_permission_profile():
            return {}
        return {
            "sandboxPolicy": {
                "type": self.sandbox_policy_type,
                "writableRoots": [runner_cwd],
                "networkAccess": self.network_access,
            },
        }

    async def run(self, request: AgentRunnerRequest, *, job_dir: Path) -> AgentRunnerResult:
        job_id = request.job_id or "agent-job"
        job_dir.mkdir(parents=True, exist_ok=True)
        events_file = job_dir / "events.jsonl"
        output_file = job_dir / "output.txt"
        output_text = ""
        exit_code: int | None = None
        status = AgentRunnerStatus.FAILED
        error: str | None = None
        runner_cwd = str(request.cwd)
        if self.run_app_server_in_user_sandbox:
            runner_cwd = str(request.metadata.get("sandbox_cwd") or request.cwd)

        await self._append_event(
            events_file,
            AgentRunnerEvent(
                type="runner.started",
                job_id=job_id,
                provider=request.provider,
                data={
                    "cwd": runner_cwd,
                    "host_cwd": str(request.cwd),
                    "runner": "codex-app-server",
                    "user_id": request.user_id,
                    "trusted_app_server": not self.run_app_server_in_user_sandbox,
                },
            ),
        )

        session = await self.pool.get(
            user_id=request.user_id,
            cwd=request.cwd,
            sandbox_config=request.metadata.get("sandbox_config"),
        )
        try:
            async with session.run_lock:
                await session.ensure_initialized()
                thread_result = await session.request(
                    "thread/start",
                    {
                        "cwd": runner_cwd,
                        "approvalPolicy": self.approval_policy,
                        "ephemeral": self.ephemeral_threads,
                        "serviceName": "ripple",
                        **self._thread_start_permission_params(session),
                    },
                )
                thread_id = thread_result.get("thread", {}).get("id")
                if not isinstance(thread_id, str) or not thread_id:
                    raise RuntimeError("codex app-server did not return a thread id")

                turn_result = await session.request(
                    "turn/start",
                    {
                        "threadId": thread_id,
                        "input": _codex_input_items(request),
                        "cwd": runner_cwd,
                        "approvalPolicy": self.approval_policy,
                        **_codex_turn_config_params(request),
                        **self._turn_start_permission_params(runner_cwd),
                    },
                )
                turn_id = turn_result.get("turn", {}).get("id")
                if not isinstance(turn_id, str) or not turn_id:
                    raise RuntimeError("codex app-server did not return a turn id")

                self.active_turns[job_id] = ActiveTurn(session=session, thread_id=thread_id, turn_id=turn_id)
                status, output_text = await self._collect_turn(
                    session=session,
                    events_file=events_file,
                    request=request,
                    job_id=job_id,
                    thread_id=thread_id,
                    turn_id=turn_id,
                )
        except asyncio.CancelledError:
            active_turn = self.active_turns.get(job_id)
            if active_turn is not None:
                await self._interrupt_turn(active_turn)
            status = AgentRunnerStatus.CANCELLED
            error = "runner cancelled"
        except JsonRpcTimeoutError as exc:
            status = AgentRunnerStatus.FAILED
            error = str(exc)
        except TimeoutError:
            status = AgentRunnerStatus.FAILED
            error = f"runner timed out after {request.max_runtime_seconds}s"
        except Exception as exc:  # noqa: BLE001
            status = AgentRunnerStatus.FAILED
            error = str(exc)
        finally:
            self.active_turns.pop(job_id, None)

        if status == AgentRunnerStatus.COMPLETED:
            final_event = "runner.completed"
        elif status == AgentRunnerStatus.CANCELLED:
            final_event = "runner.cancelled"
        else:
            final_event = "runner.failed"
        await self._append_event(
            events_file,
            AgentRunnerEvent(
                type=final_event,
                job_id=job_id,
                provider=request.provider,
                message=error,
                data={"exit_code": exit_code},
            ),
        )

        output_file.write_text(output_text, encoding="utf-8")
        return AgentRunnerResult(
            job_id=job_id,
            provider=request.provider,
            status=status,
            events_file=events_file,
            output_file=output_file,
            exit_code=exit_code,
            stdout_tail=_tail(output_text),
            stderr_tail=session.stderr_tail,
            error=error,
        )

    async def wait_for_active_turn(self, job_id: str, *, timeout: float) -> ActiveTurn:
        deadline = asyncio.get_running_loop().time() + timeout
        while job_id not in self.active_turns:
            if asyncio.get_running_loop().time() >= deadline:
                raise TimeoutError(f"timed out waiting for active turn for {job_id}")
            await asyncio.sleep(0.01)
        return self.active_turns[job_id]

    def steer(self, job_id: str, text: str) -> bool:
        active_turn = self.active_turns.get(job_id)
        if active_turn is None:
            return False
        asyncio.create_task(self._steer_turn(active_turn, text))
        return True

    def get_pending_approval(self, job_id: str) -> dict[str, Any] | None:
        return self.pending_approvals.get(job_id)

    async def wait_for_pending_approval(self, job_id: str, *, timeout: float) -> dict[str, Any]:
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            approval = self.pending_approvals.get(job_id)
            if approval is not None:
                return approval
            if asyncio.get_running_loop().time() >= deadline:
                raise TimeoutError(f"timed out waiting for pending approval for {job_id}")
            await asyncio.sleep(0.01)

    def resolve_approval(self, job_id: str, request_id: Any, action: str) -> bool:
        approval = self.pending_approvals.get(job_id)
        active_turn = self.active_turns.get(job_id)
        if approval is None or active_turn is None:
            return False
        if approval.get("request_id") != request_id:
            return False
        response = codex_approval_response_for_action(approval, action)  # type: ignore[arg-type]
        asyncio.create_task(self._resolve_approval(active_turn.session, job_id, request_id, response))
        return True

    async def stop_user(self, user_id: str) -> None:
        await self.pool.stop_user(user_id)

    async def stop_all(self) -> None:
        await self.pool.stop_all()

    async def _steer_turn(self, active_turn: ActiveTurn, text: str) -> None:
        try:
            await active_turn.session.request(
                "turn/steer",
                {
                    "threadId": active_turn.thread_id,
                    "expectedTurnId": active_turn.turn_id,
                    "input": [{"type": "text", "text": text}],
                },
            )
        except Exception:  # noqa: BLE001
            return

    async def _resolve_approval(
        self,
        session: CodexAppServerSession,
        job_id: str,
        request_id: Any,
        response: dict[str, Any],
    ) -> None:
        try:
            await session.respond(request_id, response)
            self.pending_approvals.pop(job_id, None)
        except Exception:  # noqa: BLE001
            return

    async def _collect_turn(
        self,
        *,
        session: CodexAppServerSession,
        events_file: Path,
        request: AgentRunnerRequest,
        job_id: str,
        thread_id: str,
        turn_id: str,
    ) -> tuple[AgentRunnerStatus, str]:
        legacy_output_parts: list[str] = []
        final_output_text = ""
        agent_message_phases: dict[str, str | None] = {}
        async with asyncio.timeout(request.max_runtime_seconds):
            while True:
                message = await session.notifications.get()
                await self._append_event(
                    events_file,
                    AgentRunnerEvent(
                        type="codex.notification",
                        job_id=job_id,
                        provider=request.provider,
                        data={"message": message},
                    ),
                )
                approval = parse_codex_approval_request(
                    message,
                    job_id=job_id,
                    user_id=request.user_id,
                    session_id=request.session_id,
                )
                if approval is not None:
                    self.pending_approvals[job_id] = approval
                    await self._append_event(
                        events_file,
                        AgentRunnerEvent(
                            type="codex.approval_request",
                            job_id=job_id,
                            provider=request.provider,
                            message=approval.get("description"),
                            data={"approval": approval},
                        ),
                    )
                    continue
                if self._is_unsupported_server_request(message):
                    await self._decline_unsupported_server_request(
                        session=session,
                        events_file=events_file,
                        request=request,
                        job_id=job_id,
                        message=message,
                    )
                    continue
                self._record_agent_message_phase(message, agent_message_phases)
                completed_text = self._extract_completed_final_agent_message(message)
                if completed_text:
                    final_output_text = completed_text
                else:
                    delta = self._extract_streamable_final_delta(message, agent_message_phases)
                    if delta:
                        legacy_output_parts.append(delta)
                if self._is_turn_completed(message, thread_id=thread_id, turn_id=turn_id):
                    output_text = final_output_text or "".join(legacy_output_parts)
                    turn_status = message.get("params", {}).get("turn", {}).get("status")
                    if turn_status == "interrupted":
                        return AgentRunnerStatus.CANCELLED, output_text
                    return AgentRunnerStatus.COMPLETED, output_text

    async def _interrupt_turn(self, active_turn: ActiveTurn) -> None:
        try:
            await asyncio.wait_for(
                asyncio.shield(
                    active_turn.session.request(
                        "turn/interrupt",
                        {"threadId": active_turn.thread_id, "turnId": active_turn.turn_id},
                    )
                ),
                timeout=2,
            )
        except Exception:  # noqa: BLE001
            return

    def _agent_message_item(self, message: dict[str, Any]) -> dict[str, Any] | None:
        params = message.get("params", {})
        item = params.get("item")
        if isinstance(item, dict) and item.get("type") == "agentMessage":
            return item
        return None

    def _record_agent_message_phase(self, message: dict[str, Any], phases: dict[str, str | None]) -> None:
        if message.get("method") not in {"item/started", "item/completed"}:
            return
        item = self._agent_message_item(message)
        if item is None:
            return
        item_id = item.get("id")
        if isinstance(item_id, str) and item_id:
            phase = item.get("phase")
            phases[item_id] = phase if isinstance(phase, str) else None

    def _extract_completed_final_agent_message(self, message: dict[str, Any]) -> str:
        if message.get("method") != "item/completed":
            return ""
        item = self._agent_message_item(message)
        if item is None or item.get("phase") == "commentary":
            return ""
        text = item.get("text") or item.get("content")
        return text if isinstance(text, str) else ""

    def _extract_streamable_final_delta(self, message: dict[str, Any], phases: dict[str, str | None]) -> str:
        if message.get("method") != "item/agentMessage/delta":
            return ""
        params = message.get("params", {})
        delta = params.get("delta")
        if not isinstance(delta, str):
            return ""
        item_id = params.get("itemId") or params.get("item_id")
        if not isinstance(item_id, str) or not item_id:
            return delta
        if phases.get(item_id) == "commentary":
            return ""
        # If no phase metadata was seen, preserve the legacy behavior and treat it as final text.
        return delta

    def _is_turn_completed(self, message: dict[str, Any], *, thread_id: str, turn_id: str) -> bool:
        if message.get("method") != "turn/completed":
            return False
        params = message.get("params", {})
        message_thread_id = params.get("threadId")
        message_turn_id = params.get("turnId") or params.get("turn", {}).get("id")
        return message_thread_id == thread_id and message_turn_id == turn_id

    def _is_unsupported_server_request(self, message: dict[str, Any]) -> bool:
        return "id" in message and isinstance(message.get("method"), str)

    async def _decline_unsupported_server_request(
        self,
        *,
        session: CodexAppServerSession,
        events_file: Path,
        request: AgentRunnerRequest,
        job_id: str,
        message: dict[str, Any],
    ) -> None:
        request_id = message.get("id")
        method = str(message.get("method") or "")
        await session.respond_error(
            request_id,
            code=-32601,
            message=f"unsupported Codex server request: {method}",
            data={"method": method},
        )
        await self._append_event(
            events_file,
            AgentRunnerEvent(
                type="codex.server_request_unsupported",
                job_id=job_id,
                provider=request.provider,
                message=method,
                data={"request_id": request_id, "method": method},
            ),
        )

    async def _append_event(self, events_file: Path, event: AgentRunnerEvent) -> None:
        with events_file.open("a", encoding="utf-8") as f:
            f.write(json.dumps(event.model_dump(mode="json"), ensure_ascii=False) + "\n")
