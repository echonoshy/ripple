"""MusicIdentify 工具 — 宿主侧音乐片段识别

通过 Shazam API 识别音频中的音乐片段。作为宿主侧内置工具执行，API key 从
`config/settings.yaml` 的 `services.shazam` 段读取，**不会进入沙箱、也不会出现在
模型上下文中**。

本工具由 `skills/podcast/music-identify` 升级而来：原先"SKILL + Python 脚本"的方式
需要把宿主配置暴露给沙箱，存在 key 泄漏风险；改为宿主侧 Tool 后，沙箱和模型只看到
业务参数和业务结果。
"""

import asyncio
from pathlib import Path
from typing import Any

import httpx
from pydantic import BaseModel, Field, model_validator

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.tools.base import Tool, ToolResult
from ripple.utils.config import get_config

DEFAULT_BASE_URL = "https://shazam-api.com/api"
DEFAULT_REQUEST_TIMEOUT = 60
DEFAULT_POLL_TIMEOUT = 60
DEFAULT_POLL_INTERVAL = 3


class MusicIdentifyInput(BaseModel):
    """MusicIdentify 工具输入"""

    audio_url: str | None = Field(default=None, description="公开可访问的音频 URL")
    file_path: str | None = Field(
        default=None,
        description="音频文件路径。沙箱内应使用 /workspace/ 开头的虚拟路径，工具会自动映射到宿主 workspace",
    )
    context_info: dict | None = Field(
        default=None,
        description="可选上下文（episode_url / title / podcast_name 等），仅原样回显，不影响识别",
    )

    @model_validator(mode="after")
    def _ensure_exactly_one_source(self) -> "MusicIdentifyInput":
        if bool(self.audio_url) == bool(self.file_path):
            raise ValueError("audio_url 和 file_path 必须且只能提供一个")
        return self


class MusicIdentifyTrack(BaseModel):
    """识别出的单条 track 信息"""

    title: str = ""
    subtitle: str = ""
    shazam_url: str = ""
    artwork_url: str = ""
    apple_music_url: str = ""


class MusicIdentifyResult(BaseModel):
    """单条识别结果（可能包含多条 track 命中）"""

    timecode: str = "00:00:00"
    track: MusicIdentifyTrack


class MusicIdentifyOutput(BaseModel):
    """MusicIdentify 工具输出"""

    matched: bool
    status: str
    results: list[MusicIdentifyResult]
    notes: str = ""


def _load_shazam_settings() -> dict[str, Any]:
    """从宿主 config/settings.yaml 读取 services.shazam.* 配置。"""
    config = get_config()
    api_key = config.get("services.shazam.api_key")
    if not api_key:
        raise RuntimeError("未配置 Shazam API key。请在 config/settings.yaml 的 services.shazam.api_key 下设置")
    return {
        "api_key": api_key,
        "base_url": config.get("services.shazam.base_url", DEFAULT_BASE_URL),
        "request_timeout": int(config.get("services.shazam.request_timeout", DEFAULT_REQUEST_TIMEOUT)),
        "poll_timeout": int(config.get("services.shazam.poll_timeout", DEFAULT_POLL_TIMEOUT)),
        "poll_interval": int(config.get("services.shazam.poll_interval", DEFAULT_POLL_INTERVAL)),
    }


def _resolve_audio_file_path(file_path: str, context: ToolUseContext) -> Path:
    """把输入的 file_path 解析为宿主上真正可读的绝对路径。

    沙箱场景下，`/workspace/foo.mp3` 这种虚拟路径会映射到宿主
    `.ripple/sessions/<id>/workspace/foo.mp3`。
    """
    if context.is_sandboxed and context.workspace_root:
        from ripple.sandbox.workspace import validate_path

        return validate_path(file_path, context.workspace_root)
    return Path(file_path).expanduser().resolve()


async def _submit_file(client: httpx.AsyncClient, base_url: str, path: Path) -> dict:
    """上传本地音频文件到 Shazam 识别队列。"""
    if not path.exists():
        raise FileNotFoundError(f"音频文件不存在: {path}")
    with path.open("rb") as f:
        files = {"file": (path.name, f)}
        resp = await client.post(f"{base_url}/recognize", files=files)
    resp.raise_for_status()
    return resp.json()


async def _submit_url(client: httpx.AsyncClient, base_url: str, audio_url: str) -> dict:
    """提交音频 URL 到 Shazam 识别队列。"""
    resp = await client.post(
        f"{base_url}/recognize",
        json={"url": audio_url},
        headers={"Content-Type": "application/json"},
    )
    resp.raise_for_status()
    return resp.json()


async def _poll_result(
    client: httpx.AsyncClient,
    base_url: str,
    uuid: str,
    timeout: int,
    interval: int,
) -> dict:
    """轮询识别结果，直到完成或超时。"""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        resp = await client.post(f"{base_url}/results/{uuid}")
        resp.raise_for_status()
        payload = resp.json()
        if payload.get("status") == "completed":
            return payload
        await asyncio.sleep(interval)
    return {"status": "timeout", "results": []}


def _extract_apple_music_url(track: dict) -> str:
    """从 Shazam track.hub.options.actions 里挑出 Apple Music 跳转链接。"""
    hub = track.get("hub") or {}
    for opt in hub.get("options") or []:
        for act in opt.get("actions") or []:
            uri = act.get("uri") or ""
            if "music.apple.com" in uri:
                return uri
    return ""


def _build_output(raw: dict) -> MusicIdentifyOutput:
    """把 Shazam 原始响应精简为工具的业务输出结构。"""
    results: list[MusicIdentifyResult] = []
    for item in raw.get("results") or []:
        track = item.get("track") or {}
        results.append(
            MusicIdentifyResult(
                timecode=item.get("timecode") or "00:00:00",
                track=MusicIdentifyTrack(
                    title=track.get("title", ""),
                    subtitle=track.get("subtitle", ""),
                    shazam_url=track.get("url", ""),
                    artwork_url=((track.get("images") or {}).get("coverart") or ""),
                    apple_music_url=_extract_apple_music_url(track),
                ),
            )
        )
    return MusicIdentifyOutput(
        matched=bool(results),
        status=raw.get("status", "unknown"),
        results=results,
        notes=(
            "若 results 为空，视为未识别到可命中的音乐；返回的 URL 通常是详情页或平台跳转，不一定是可直接播放的音频流。"
        ),
    )


class MusicIdentifyTool(Tool[MusicIdentifyInput, MusicIdentifyOutput]):
    """识别音频片段中的音乐（通过 Shazam API）

    典型用途：
    - 识别播客片头 / 片尾 / 中插音乐
    - 判断某段是不是歌，为"跳过音乐"提供依据
    - 生成歌曲卡片或 Apple Music 跳转链接

    注意：
    - 输入需要提供 `audio_url` 或 `file_path` 之一；沙箱路径用 /workspace/ 开头
    - API key 由宿主进程从配置读取，工具不接受、不回显任何密钥字段
    - 无识别结果时返回 `matched=false` + 空 `results`，不抛异常
    - 当前不做自动音乐切片，需上游传入合适的短片段
    """

    def __init__(self):
        self.name = "MusicIdentify"
        self.description = (
            "Identify music in an audio clip via Shazam. Provide either `audio_url` "
            "(publicly accessible audio) or `file_path` (sandbox path like /workspace/xxx.mp3). "
            "Returns matched tracks with title, artist, Shazam and Apple Music URLs. "
            "Useful for detecting intro/outro music in podcasts or deciding whether a clip is a song."
        )
        self.max_result_size_chars = 50_000

    async def call(
        self,
        args: MusicIdentifyInput | dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage | None,
    ) -> ToolResult[MusicIdentifyOutput]:
        if isinstance(args, dict):
            args = MusicIdentifyInput(**args)

        try:
            cfg = _load_shazam_settings()
        except RuntimeError as e:
            return ToolResult(
                data=MusicIdentifyOutput(matched=False, status="failed", results=[], notes=str(e)),
            )

        headers = {"Authorization": f"Bearer {cfg['api_key']}"}
        async with httpx.AsyncClient(headers=headers, timeout=cfg["request_timeout"]) as client:
            try:
                if args.file_path:
                    path = _resolve_audio_file_path(args.file_path, context)
                    submit = await _submit_file(client, cfg["base_url"], path)
                else:
                    assert args.audio_url is not None
                    submit = await _submit_url(client, cfg["base_url"], args.audio_url)
            except FileNotFoundError as e:
                return ToolResult(
                    data=MusicIdentifyOutput(matched=False, status="failed", results=[], notes=str(e)),
                )
            except PermissionError as e:
                return ToolResult(
                    data=MusicIdentifyOutput(matched=False, status="failed", results=[], notes=str(e)),
                )
            except httpx.HTTPError as e:
                return ToolResult(
                    data=MusicIdentifyOutput(
                        matched=False,
                        status="failed",
                        results=[],
                        notes=f"提交阶段 HTTP 错误: {e}",
                    ),
                )

            uuid = submit.get("uuid")
            if not uuid:
                return ToolResult(
                    data=MusicIdentifyOutput(
                        matched=False,
                        status="failed",
                        results=[],
                        notes=f"提交未返回 uuid: {submit}",
                    ),
                )

            try:
                raw = await _poll_result(
                    client,
                    cfg["base_url"],
                    uuid,
                    timeout=cfg["poll_timeout"],
                    interval=cfg["poll_interval"],
                )
            except httpx.HTTPError as e:
                return ToolResult(
                    data=MusicIdentifyOutput(
                        matched=False,
                        status="failed",
                        results=[],
                        notes=f"轮询阶段 HTTP 错误: {e}",
                    ),
                )

        return ToolResult(data=_build_output(raw))

    def is_concurrency_safe(self, input: MusicIdentifyInput | dict[str, Any]) -> bool:
        return True

    def _get_parameters_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "audio_url": {
                    "type": "string",
                    "description": "公开可访问的音频 URL（和 file_path 二选一）",
                },
                "file_path": {
                    "type": "string",
                    "description": "音频文件路径（和 audio_url 二选一）。沙箱内请使用 /workspace/ 开头的路径",
                },
                "context_info": {
                    "type": "object",
                    "description": "可选上下文（episode_url / title / podcast_name 等），不影响识别，仅便于上下游串联",
                    "properties": {
                        "episode_url": {"type": "string"},
                        "title": {"type": "string"},
                        "podcast_name": {"type": "string"},
                    },
                    "additionalProperties": True,
                },
            },
            "required": [],
        }
