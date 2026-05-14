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


class JsonRpcError(RuntimeError):
    """Raised when app-server returns a JSON-RPC error."""


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
        sandbox_config: Any | None = None,
        env: dict[str, str] | None = None,
    ):
        self.user_key = user_key
        self.codex_executable = codex_executable
        self.app_server_args = app_server_args
        self.cwd = cwd
        self.sandbox_config = sandbox_config
        self.env = env or {}
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
        argv = [self.codex_executable, *self.app_server_args]
        process_cwd = str(self.cwd)
        if self.sandbox_config is not None:
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
        await self._write(payload)
        self.last_active_at = _now()
        response = await future
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
    env: dict[str, str] | None = None
    idle_timeout_seconds: int = 1800
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
                sandbox_config=sandbox_config,
                env=self.env,
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
        env: dict[str, str] | None = None,
        idle_timeout_seconds: int = 1800,
    ):
        self.name = "codex"
        self.approval_policy = approval_policy
        self.sandbox_type = _normalize_sandbox_type(sandbox_type)
        self.sandbox_policy_type = _sandbox_policy_type(self.sandbox_type)
        self.network_access = network_access
        self.pool = CodexAppServerPool(
            codex_executable=codex_executable,
            app_server_args=app_server_args or ["app-server", "--listen", "stdio://"],
            env=env,
            idle_timeout_seconds=idle_timeout_seconds,
        )
        self.active_turns: dict[str, ActiveTurn] = {}

    async def run(self, request: AgentRunnerRequest, *, job_dir: Path) -> AgentRunnerResult:
        job_id = request.job_id or "agent-job"
        job_dir.mkdir(parents=True, exist_ok=True)
        events_file = job_dir / "events.jsonl"
        output_file = job_dir / "output.txt"
        output_text = ""
        exit_code: int | None = None
        status = AgentRunnerStatus.FAILED
        error: str | None = None

        await self._append_event(
            events_file,
            AgentRunnerEvent(
                type="runner.started",
                job_id=job_id,
                provider=request.provider,
                data={
                    "cwd": str(request.metadata.get("sandbox_cwd") or request.cwd),
                    "host_cwd": str(request.cwd),
                    "runner": "codex-app-server",
                    "user_id": request.user_id,
                },
            ),
        )

        runner_cwd = str(request.metadata.get("sandbox_cwd") or request.cwd)
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
                        "sandbox": self.sandbox_policy_type,
                        "serviceName": "ripple",
                    },
                )
                thread_id = thread_result.get("thread", {}).get("id")
                if not isinstance(thread_id, str) or not thread_id:
                    raise RuntimeError("codex app-server did not return a thread id")

                turn_result = await session.request(
                    "turn/start",
                    {
                        "threadId": thread_id,
                        "input": [{"type": "text", "text": request.prompt}],
                        "cwd": runner_cwd,
                        "approvalPolicy": self.approval_policy,
                        "sandboxPolicy": {
                            "type": self.sandbox_type,
                            "writableRoots": [runner_cwd],
                            "networkAccess": self.network_access,
                        },
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
        output_parts: list[str] = []
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
                text = self._extract_text(message)
                if text:
                    output_parts.append(text)
                if self._is_turn_completed(message, thread_id=thread_id, turn_id=turn_id):
                    turn_status = message.get("params", {}).get("turn", {}).get("status")
                    if turn_status == "interrupted":
                        return AgentRunnerStatus.CANCELLED, "".join(output_parts)
                    return AgentRunnerStatus.COMPLETED, "".join(output_parts)

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

    def _extract_text(self, message: dict[str, Any]) -> str:
        params = message.get("params", {})
        delta = params.get("delta")
        if isinstance(delta, str):
            return delta
        item = params.get("item")
        if isinstance(item, dict):
            text = item.get("text") or item.get("content")
            if isinstance(text, str):
                return text
        return ""

    def _is_turn_completed(self, message: dict[str, Any], *, thread_id: str, turn_id: str) -> bool:
        if message.get("method") != "turn/completed":
            return False
        params = message.get("params", {})
        message_thread_id = params.get("threadId")
        message_turn_id = params.get("turnId") or params.get("turn", {}).get("id")
        return message_thread_id == thread_id and message_turn_id == turn_id

    async def _append_event(self, events_file: Path, event: AgentRunnerEvent) -> None:
        with events_file.open("a", encoding="utf-8") as f:
            f.write(json.dumps(event.model_dump(mode="json"), ensure_ascii=False) + "\n")
