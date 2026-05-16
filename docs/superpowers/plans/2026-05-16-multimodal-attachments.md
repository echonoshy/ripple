# Multimodal Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add backend support for user-uploaded images and attachments, pass image inputs to Codex app-server as structured input items, and surface image outputs from Codex back to Ripple clients.

**Architecture:** Ripple remains the control plane and stores uploaded files inside the current user's sandbox workspace. Chat Completions converts OpenAI-style content blocks into a typed internal input item list, while Codex app-server receives native `turn/start.input` entries such as `text`, `image`, and `localImage`. Output handling normalizes Codex `imageView`, `imageGeneration`, and dynamic `inputImage` events into user-scoped paths or URLs instead of exposing service `CODEX_HOME` internals.

**Tech Stack:** FastAPI, Pydantic, pathlib, pytest, Codex app-server JSON-RPC v2, Ripple `SandboxManager`, `ExternalAgentManager`, user workspace quota checks.

---

## Codex Reference Summary

`codex app-server` accepts image input directly in `turn/start.input`:

```json
[
  {"type": "localImage", "path": "/absolute/path/to/screenshot.png"},
  {"type": "image", "url": "https://example.com/photo.png"},
  {"type": "text", "text": "Please inspect this image."}
]
```

The app-server event stream echoes user image input as `userMessage.content` entries:

```json
[
  {"type": "localImage", "path": "/absolute/path/to/screenshot.png"},
  {"type": "text", "text": "Please inspect this image.", "text_elements": []}
]
```

Codex image-related output items to handle:

```json
{"type": "imageView", "id": "view-1", "path": "/absolute/path/to/image.png"}
```

```json
{
  "type": "imageGeneration",
  "id": "ig-1",
  "status": "completed",
  "result": "base64-png-payload",
  "revisedPrompt": "final prompt",
  "savedPath": "/service/codex-home/generated_images/session/ig-1.png"
}
```

```json
{"type": "inputImage", "imageUrl": "data:image/png;base64,..."}
```

Current Ripple gaps:

- `src/interfaces/server/routes.py::_extract_user_input` keeps only text blocks and drops images.
- `src/interfaces/server/codex_chat.py::build_codex_chat_prompt` produces one text prompt, so image input cannot reach Codex.
- `src/ripple/agent_runners/models.py::AgentRunnerRequest` only has `prompt: str`.
- `src/ripple/agent_runners/codex_app_server.py` always sends `input: [{"type": "text", "text": request.prompt}]`.
- `src/interfaces/server/codex_chat.py` already recognizes `imageView` and `imageGeneration` as tool events, but it does not copy generated images out of Codex service home or expose user-scoped media metadata.

## File Structure

- Create `src/interfaces/server/attachments.py`
  - Own upload validation, workspace-relative storage paths, media type detection, and generated image import helpers.
- Modify `src/interfaces/server/schemas.py`
  - Add response models for uploaded attachments.
- Modify `src/interfaces/server/routes.py`
  - Add upload endpoint.
  - Replace text-only extraction with multimodal input extraction.
- Modify `src/interfaces/server/codex_chat.py`
  - Build a text context prompt plus preserve user multimodal input items.
  - Persist user messages with text and attachment metadata.
  - Normalize image output events.
- Modify `src/ripple/agent_runners/models.py`
  - Add `input_items` to `AgentRunnerRequest`.
- Modify `src/ripple/agent_runners/codex_app_server.py`
  - Pass `request.input_items` to `turn/start`.
  - Convert unsupported or empty input to a text fallback.
- Modify tests:
  - `tests/test_workspace_routes.py` for upload route.
  - `tests/test_codex_chat_routes.py` for content block extraction and SSE image output.
  - `tests/test_codex_app_server_runner.py` for native Codex input item forwarding.

## Contracts

Internal input item shape:

```python
CodexInputItem = dict[str, Any]

# Supported values passed to app-server:
{"type": "text", "text": "..."}
{"type": "image", "url": "https://..."}
{"type": "localImage", "path": "/absolute/host/workspace/path.png"}
{"type": "attachment", "path": "/absolute/host/workspace/path.pdf", "name": "report.pdf", "mime_type": "application/pdf"}
```

Only `text`, `image`, and `localImage` are sent directly to Codex app-server. Generic `attachment` items are rendered into the text prompt as workspace file references until Codex exposes a richer non-image attachment input.

Upload route:

```http
POST /v1/workspace/attachments
Content-Type: multipart/form-data

file=<binary>
kind=image|attachment
```

Response:

```json
{
  "path": "/workspace/.ripple/uploads/2026/05/16/<uuid>-photo.png",
  "host_path": "/Users/.../.ripple/sandboxes/alice/workspace/.ripple/uploads/2026/05/16/<uuid>-photo.png",
  "name": "photo.png",
  "mime_type": "image/png",
  "size": 12345,
  "kind": "image"
}
```

`host_path` is only for trusted local clients and tests. Public clients should use `path`.

## Task 1: Attachment Storage Helpers

**Files:**
- Create: `src/interfaces/server/attachments.py`
- Test: `tests/test_workspace_routes.py`

- [ ] **Step 1: Write failing tests for attachment path creation and upload safety**

Append to `tests/test_workspace_routes.py`:

```python
def test_upload_workspace_attachment_saves_file_under_user_workspace(tmp_path: Path, monkeypatch):
    client = _client(tmp_path, monkeypatch)

    response = client.post(
        "/v1/workspace/attachments",
        files={"file": ("photo.png", b"\x89PNG\r\n\x1a\nimage-bytes", "image/png")},
        data={"kind": "image"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["path"].startswith("/workspace/.ripple/uploads/")
    assert body["path"].endswith("-photo.png")
    assert body["name"] == "photo.png"
    assert body["mime_type"] == "image/png"
    assert body["size"] == len(b"\x89PNG\r\n\x1a\nimage-bytes")
    assert body["kind"] == "image"
    host_path = Path(body["host_path"])
    assert host_path.is_file()
    assert host_path.read_bytes() == b"\x89PNG\r\n\x1a\nimage-bytes"


def test_upload_workspace_attachment_rejects_path_traversal_filename(tmp_path: Path, monkeypatch):
    client = _client(tmp_path, monkeypatch)

    response = client.post(
        "/v1/workspace/attachments",
        files={"file": ("../secret.txt", b"secret", "text/plain")},
        data={"kind": "attachment"},
    )

    assert response.status_code == 200
    body = response.json()
    assert ".." not in body["path"]
    assert body["path"].endswith("-secret.txt")
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
uv run pytest tests/test_workspace_routes.py::test_upload_workspace_attachment_saves_file_under_user_workspace tests/test_workspace_routes.py::test_upload_workspace_attachment_rejects_path_traversal_filename -q
```

Expected: both tests fail with `404 Not Found` because `/v1/workspace/attachments` does not exist.

- [ ] **Step 3: Implement attachment helpers**

Create `src/interfaces/server/attachments.py`:

```python
"""Workspace attachment storage for uploaded chat files."""

import mimetypes
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from ripple.users.quota import assert_workspace_save_within_quota
from ripple.utils.config import Config

SAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


@dataclass(frozen=True)
class StoredAttachment:
    path: str
    host_path: Path
    name: str
    mime_type: str
    size: int
    kind: str

    def to_response(self) -> dict[str, object]:
        return {
            "path": self.path,
            "host_path": str(self.host_path),
            "name": self.name,
            "mime_type": self.mime_type,
            "size": self.size,
            "kind": self.kind,
        }


def sanitize_filename(filename: str | None) -> str:
    name = Path(filename or "upload.bin").name
    name = SAFE_FILENAME_RE.sub("-", name).strip(".-")
    return name or "upload.bin"


def is_image_mime_type(mime_type: str) -> bool:
    return mime_type.startswith("image/")


def workspace_path_for_host_path(workspace_root: Path, host_path: Path) -> str:
    relative = host_path.resolve().relative_to(workspace_root.resolve())
    return "/workspace/" + relative.as_posix()


def host_path_for_workspace_path(workspace_root: Path, workspace_path: str) -> Path:
    if not workspace_path.startswith("/workspace/"):
        raise PermissionError("attachment path must be under /workspace")
    relative = workspace_path.removeprefix("/workspace/")
    target = (workspace_root / relative).resolve()
    target.relative_to(workspace_root.resolve())
    return target


def save_uploaded_attachment(
    *,
    config: Config,
    user_id: str,
    workspace_root: Path,
    filename: str | None,
    content_type: str | None,
    data: bytes,
    kind: str,
) -> StoredAttachment:
    mime_type = content_type or mimetypes.guess_type(filename or "")[0] or "application/octet-stream"
    resolved_kind = "image" if kind == "image" or is_image_mime_type(mime_type) else "attachment"
    today = datetime.now(timezone.utc)
    safe_name = sanitize_filename(filename)
    target_dir = workspace_root / ".ripple" / "uploads" / f"{today:%Y}" / f"{today:%m}" / f"{today:%d}"
    target = target_dir / f"{uuid4().hex}-{safe_name}"
    assert_workspace_save_within_quota(config, user_id, target, len(data))
    target_dir.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return StoredAttachment(
        path=workspace_path_for_host_path(workspace_root, target),
        host_path=target,
        name=safe_name,
        mime_type=mime_type,
        size=len(data),
        kind=resolved_kind,
    )
```

- [ ] **Step 4: Add schemas and route**

Modify `src/interfaces/server/schemas.py`:

```python
class WorkspaceAttachmentResponse(BaseModel):
    path: str
    host_path: str
    name: str
    mime_type: str
    size: int
    kind: Literal["image", "attachment"]
```

Modify imports in `src/interfaces/server/routes.py`:

```python
from typing import Annotated

from fastapi import File, Form, UploadFile

from interfaces.server.attachments import save_uploaded_attachment
from interfaces.server.schemas import WorkspaceAttachmentResponse
```

Add route near the workspace routes:

```python
@router.post("/v1/workspace/attachments", response_model=WorkspaceAttachmentResponse)
async def upload_workspace_attachment(
    file: UploadFile = File(...),
    kind: Annotated[str, Form()] = "attachment",
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    """Save an uploaded image or attachment in the current user's workspace."""
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(status_code=500, detail="sandbox disabled")

    workspace_root = manager.sandbox_manager.config.workspace_dir(user_id)
    if not workspace_root.exists():
        await manager.sandbox_manager.get_or_create(user_id)

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")
    if kind not in {"image", "attachment"}:
        raise HTTPException(status_code=400, detail="kind must be image or attachment")

    try:
        attachment = save_uploaded_attachment(
            config=manager.sandbox_manager.config,
            user_id=user_id,
            workspace_root=workspace_root,
            filename=file.filename,
            content_type=file.content_type,
            data=data,
            kind=kind,
        )
    except PermissionError as e:
        raise HTTPException(status_code=403, detail="Access denied") from e
    except WorkspaceFileTooLargeError as e:
        raise HTTPException(status_code=413, detail="File is too large to upload") from e

    return attachment.to_response()
```

- [ ] **Step 5: Run tests**

Run:

```bash
uv run pytest tests/test_workspace_routes.py::test_upload_workspace_attachment_saves_file_under_user_workspace tests/test_workspace_routes.py::test_upload_workspace_attachment_rejects_path_traversal_filename -q
```

Expected: both tests pass.

## Task 2: Parse Multimodal Chat Input

**Files:**
- Modify: `src/interfaces/server/routes.py`
- Modify: `src/interfaces/server/codex_chat.py`
- Test: `tests/test_codex_chat_routes.py`

- [ ] **Step 1: Write failing test for OpenAI image content blocks**

Append to `tests/test_codex_chat_routes.py`:

```python
def test_chat_completions_preserves_image_content_blocks_for_codex(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="looked at image")
    client = _client(tmp_path, monkeypatch, provider)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "What is in this image?"},
                        {"type": "image_url", "image_url": {"url": "https://example.com/cat.png"}},
                    ],
                }
            ],
        },
    )

    assert response.status_code == 200
    request = provider.requests[0]
    assert {"type": "image", "url": "https://example.com/cat.png"} in request.input_items
    assert request.input_items[-1] == {"type": "text", "text": "What is in this image?"}
    assert "What is in this image?" in request.prompt
```

- [ ] **Step 2: Write failing test for uploaded local image references**

Append to `tests/test_codex_chat_routes.py`:

```python
def test_chat_completions_converts_workspace_image_path_to_local_image(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="looked at local image")
    client = _client(tmp_path, monkeypatch, provider)
    upload = client.post(
        "/v1/workspace/attachments",
        files={"file": ("diagram.png", b"\x89PNG\r\n\x1a\nbytes", "image/png")},
        data={"kind": "image"},
    )
    assert upload.status_code == 200
    image_path = upload.json()["path"]

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Inspect this diagram."},
                        {
                            "type": "file",
                            "file": {
                                "path": image_path,
                                "name": "diagram.png",
                                "mime_type": "image/png",
                            },
                        },
                    ],
                }
            ],
        },
    )

    assert response.status_code == 200
    local_images = [item for item in provider.requests[0].input_items if item["type"] == "localImage"]
    assert len(local_images) == 1
    assert local_images[0]["path"].endswith("diagram.png")
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
uv run pytest tests/test_codex_chat_routes.py::test_chat_completions_preserves_image_content_blocks_for_codex tests/test_codex_chat_routes.py::test_chat_completions_converts_workspace_image_path_to_local_image -q
```

Expected: fail because `AgentRunnerRequest` has no `input_items` and routes only extract text.

- [ ] **Step 4: Add `input_items` to runner request**

Modify `src/ripple/agent_runners/models.py`:

```python
class AgentRunnerRequest(BaseModel):
    provider: str
    prompt: str
    cwd: Path
    input_items: list[dict[str, Any]] = Field(default_factory=list)
    job_id: str | None = None
    max_runtime_seconds: int = Field(default=1800, ge=1, le=86_400)
    user_id: str | None = None
    session_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
```

- [ ] **Step 5: Implement multimodal extraction**

Modify `src/interfaces/server/routes.py`:

```python
from interfaces.server.attachments import host_path_for_workspace_path, is_image_mime_type
```

Replace `_extract_user_input` with:

```python
def _extract_user_input(request: ChatCompletionRequest) -> str:
    text, _items = _extract_user_input_and_items(request, workspace_root=None)
    return text


def _extract_user_input_and_items(
    request: ChatCompletionRequest,
    *,
    workspace_root: Path | None,
) -> tuple[str, list[dict[str, Any]]]:
    for msg in reversed(request.messages):
        if msg.role != "user":
            continue
        if isinstance(msg.content, str):
            text = msg.content
            return text, [{"type": "text", "text": text}] if text.strip() else []
        if not isinstance(msg.content, list):
            return "", []

        texts: list[str] = []
        images: list[dict[str, Any]] = []
        attachments: list[dict[str, Any]] = []
        for block in msg.content:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "text":
                text = str(block.get("text") or "")
                if text:
                    texts.append(text)
                continue
            if block_type == "image_url":
                image_url = block.get("image_url")
                if isinstance(image_url, dict):
                    url = image_url.get("url")
                else:
                    url = image_url
                if isinstance(url, str) and url:
                    images.append({"type": "image", "url": url})
                continue
            if block_type == "file":
                file_info = block.get("file")
                if not isinstance(file_info, dict):
                    continue
                path = file_info.get("path")
                name = file_info.get("name")
                mime_type = str(file_info.get("mime_type") or file_info.get("mimeType") or "")
                if not isinstance(path, str) or not path:
                    continue
                if path.startswith("/workspace/") and workspace_root is not None:
                    host_path = host_path_for_workspace_path(workspace_root, path)
                    if is_image_mime_type(mime_type):
                        images.append({"type": "localImage", "path": str(host_path)})
                    else:
                        attachments.append(
                            {
                                "type": "attachment",
                                "path": str(host_path),
                                "workspace_path": path,
                                "name": str(name or Path(path).name),
                                "mime_type": mime_type or "application/octet-stream",
                            }
                        )
        text = "\n".join(texts)
        items = [*images]
        if text.strip():
            items.append({"type": "text", "text": text})
        return text, items + attachments
    return "", []
```

- [ ] **Step 6: Thread input items through chat start**

Modify `src/interfaces/server/codex_chat.py` signatures:

```python
def build_codex_chat_prompt(
    *,
    session: Session,
    user_input: str,
    system_prompt: str | None,
    attachment_items: list[dict[str, Any]] | None = None,
) -> str:
```

Inside `build_codex_chat_prompt`, add an attachment section before `## Current User Request`:

```python
    attachments = attachment_items or []
    attachment_lines = [
        f"- {item.get('name')}: {item.get('workspace_path')} ({item.get('mime_type')})"
        for item in attachments
        if item.get("type") == "attachment"
    ]
    attachment_section = "\n".join(attachment_lines) if attachment_lines else "(none)"
```

Then include:

```python
        "## Attachments\n"
        f"{attachment_section}\n\n"
```

Modify `_start_chat_run`:

```python
def _start_chat_run(
    *,
    session: Session,
    prompt: str,
    input_items: list[dict[str, Any]],
    model: str,
    config: Config,
) -> tuple[ExternalAgentManager, AgentJob]:
```

Pass `input_items=input_items` into `AgentRunnerRequest`.

- [ ] **Step 7: Use multimodal extraction in routes**

Modify `src/interfaces/server/routes.py` inside `chat_completions` after session creation:

```python
workspace_root = session.context.workspace_root if session.context else None
user_input, input_items = _extract_user_input_and_items(request, workspace_root=workspace_root)
attachment_items = [item for item in input_items if item.get("type") == "attachment"]
codex_input_items = [item for item in input_items if item.get("type") != "attachment"]
prompt = build_codex_chat_prompt(
    session=session,
    user_input=user_input,
    system_prompt=caller_system_prompt,
    attachment_items=attachment_items,
)
```

When starting the run:

```python
manager, job = _start_chat_run(
    session=session,
    prompt=prompt,
    input_items=codex_input_items,
    model=request.model,
    config=config,
)
```

- [ ] **Step 8: Run focused tests**

Run:

```bash
uv run pytest tests/test_codex_chat_routes.py::test_chat_completions_preserves_image_content_blocks_for_codex tests/test_codex_chat_routes.py::test_chat_completions_converts_workspace_image_path_to_local_image -q
```

Expected: both tests pass.

## Task 3: Send Native Input Items to Codex App-Server

**Files:**
- Modify: `src/ripple/agent_runners/codex_app_server.py`
- Test: `tests/test_codex_app_server_runner.py`

- [ ] **Step 1: Write failing provider test**

Append to `tests/test_codex_app_server_runner.py`:

```python
@pytest.mark.asyncio
async def test_app_server_provider_forwards_multimodal_input_items(tmp_path):
    provider = _provider(tmp_path)
    request = _request(tmp_path, prompt="inspect image").model_copy(
        update={
            "input_items": [
                {"type": "localImage", "path": str(tmp_path / "diagram.png")},
                {"type": "text", "text": "inspect image"},
            ]
        }
    )
    request.cwd.mkdir(parents=True)
    (tmp_path / "diagram.png").write_bytes(b"fake-png")

    result = await provider.run(request, job_dir=tmp_path / "job")

    assert result.status == AgentRunnerStatus.COMPLETED
    calls = _read_jsonl(tmp_path / "app-server.jsonl")
    turn_start = next(call for call in calls if call["method"] == "turn/start")
    assert turn_start["params"]["input"] == [
        {"type": "localImage", "path": str(tmp_path / "diagram.png")},
        {"type": "text", "text": "inspect image"},
    ]
```

- [ ] **Step 2: Update the fake app-server to read first text item**

Modify the fake `turn/start` handler in `_write_fake_app_server` so existing tests still pass:

```python
        text_items = [item.get("text", "") for item in params["input"] if item.get("type") == "text"]
        text = text_items[-1] if text_items else ""
```

- [ ] **Step 3: Run focused test and verify failure**

Run:

```bash
uv run pytest tests/test_codex_app_server_runner.py::test_app_server_provider_forwards_multimodal_input_items -q
```

Expected: fail because provider still sends only `request.prompt`.

- [ ] **Step 4: Implement input item forwarding**

Modify `src/ripple/agent_runners/codex_app_server.py` before `turn/start`:

```python
                input_items = request.input_items or [{"type": "text", "text": request.prompt}]
                codex_input_items = [
                    item
                    for item in input_items
                    if item.get("type") in {"text", "image", "localImage", "skill", "mention"}
                ]
                if not codex_input_items:
                    codex_input_items = [{"type": "text", "text": request.prompt}]
```

Change `turn/start` payload:

```python
                        "input": codex_input_items,
```

- [ ] **Step 5: Run provider tests**

Run:

```bash
uv run pytest tests/test_codex_app_server_runner.py -q
```

Expected: pass.

## Task 4: Normalize Image Output Events

**Files:**
- Modify: `src/interfaces/server/attachments.py`
- Modify: `src/interfaces/server/codex_chat.py`
- Test: `tests/test_codex_chat_routes.py`

- [ ] **Step 1: Write failing SSE test for image output events**

Append to `tests/test_codex_chat_routes.py`:

```python
class CodexImageEventProvider:
    def __init__(self):
        self.requests: list[AgentRunnerRequest] = []

    async def run(self, request: AgentRunnerRequest, *, job_dir: Path) -> AgentRunnerResult:
        self.requests.append(request)
        job_dir.mkdir(parents=True, exist_ok=True)
        events_file = job_dir / "events.jsonl"
        output_file = job_dir / "output.txt"
        generated = job_dir / "generated.png"
        generated.write_bytes(b"png")
        events = [
            AgentRunnerEvent(
                type="codex.notification",
                job_id=request.job_id or "job-test",
                provider=request.provider,
                data={
                    "message": {
                        "method": "item/completed",
                        "params": {
                            "item": {
                                "type": "imageView",
                                "id": "view-1",
                                "path": str(request.cwd / "diagram.png"),
                            }
                        },
                    }
                },
            ),
            AgentRunnerEvent(
                type="codex.notification",
                job_id=request.job_id or "job-test",
                provider=request.provider,
                data={
                    "message": {
                        "method": "item/completed",
                        "params": {
                            "item": {
                                "type": "imageGeneration",
                                "id": "ig-1",
                                "status": "completed",
                                "result": "cG5n",
                                "revisedPrompt": "draw a diagram",
                                "savedPath": str(generated),
                            }
                        },
                    }
                },
            ),
            AgentRunnerEvent(
                type="codex.notification",
                job_id=request.job_id or "job-test",
                provider=request.provider,
                data={"message": {"method": "item/agentMessage/delta", "params": {"delta": "done"}}},
            ),
        ]
        events_file.write_text(
            "".join(json.dumps(event.model_dump(mode="json"), ensure_ascii=False) + "\n" for event in events),
            encoding="utf-8",
        )
        output_file.write_text("done", encoding="utf-8")
        return AgentRunnerResult(
            job_id=request.job_id or "job-test",
            provider=request.provider,
            status=AgentRunnerStatus.COMPLETED,
            events_file=events_file,
            output_file=output_file,
            stdout_tail="done",
        )


def test_chat_completions_stream_bridges_codex_image_items_to_sse(tmp_path: Path, monkeypatch):
    provider = CodexImageEventProvider()
    client = _client(tmp_path, monkeypatch, provider)

    with client.stream(
        "POST",
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": True,
            "messages": [{"role": "user", "content": "Generate an image"}],
        },
    ) as response:
        body = response.read().decode("utf-8")

    assert response.status_code == 200
    assert '"type": "image_view"' in body
    assert '"type": "image_generation"' in body
    assert '"workspace_path": "/workspace/.ripple/generated/' in body
    assert '"saved_path"' not in body
    assert '"result": "cG5n"' not in body
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
uv run pytest tests/test_codex_chat_routes.py::test_chat_completions_stream_bridges_codex_image_items_to_sse -q
```

Expected: fail because current stream emits generic `tool_result` with raw `saved_path`.

- [ ] **Step 3: Add generated image import helper**

Append to `src/interfaces/server/attachments.py`:

```python
def import_generated_image(
    *,
    config: Config,
    user_id: str,
    workspace_root: Path,
    source_path: Path,
    item_id: str,
) -> StoredAttachment:
    data = source_path.read_bytes()
    target_dir = workspace_root / ".ripple" / "generated"
    safe_id = sanitize_filename(item_id)
    target = target_dir / f"{safe_id}.png"
    assert_workspace_save_within_quota(config, user_id, target, len(data))
    target_dir.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return StoredAttachment(
        path=workspace_path_for_host_path(workspace_root, target),
        host_path=target,
        name=target.name,
        mime_type="image/png",
        size=len(data),
        kind="image",
    )
```

- [ ] **Step 4: Normalize image events in `codex_chat.py`**

Modify imports:

```python
from interfaces.server.attachments import import_generated_image, workspace_path_for_host_path
```

Add helper:

```python
def _workspace_path_or_none(workspace_root: Path | None, path: str | None) -> str | None:
    if not workspace_root or not path:
        return None
    try:
        return workspace_path_for_host_path(workspace_root, Path(path))
    except (ValueError, PermissionError):
        return None
```

Add image event extraction:

```python
def _extract_image_event(
    event: dict[str, Any],
    *,
    session: Session,
    config: Config,
) -> dict[str, Any] | None:
    if event.get("type") != "codex.notification":
        return None
    message = (event.get("data") or {}).get("message")
    if not isinstance(message, dict):
        return None
    if message.get("method") != "item/completed":
        return None
    params = message.get("params") or {}
    item = params.get("item")
    if not isinstance(item, dict):
        return None
    workspace_root = session.context.workspace_root if session.context else None
    if item.get("type") == "imageView":
        path = item.get("path")
        return {
            "type": "image_view",
            "id": item.get("id"),
            "path": path,
            "workspace_path": _workspace_path_or_none(workspace_root, path),
        }
    if item.get("type") == "imageGeneration":
        payload: dict[str, Any] = {
            "type": "image_generation",
            "id": item.get("id"),
            "status": item.get("status"),
            "revised_prompt": item.get("revisedPrompt"),
        }
        saved_path = item.get("savedPath")
        if workspace_root and isinstance(saved_path, str) and Path(saved_path).is_file():
            imported = import_generated_image(
                config=config,
                user_id=session.user_id,
                workspace_root=workspace_root,
                source_path=Path(saved_path),
                item_id=str(item.get("id") or "generated-image"),
            )
            payload["workspace_path"] = imported.path
            payload["mime_type"] = imported.mime_type
            payload["size"] = imported.size
        return payload
    return None
```

In both streaming loops, check image event before generic tool event:

```python
image_event = _extract_image_event(event, session=session, config=config)
if image_event:
    yield _chunk(chunk_id, model, created, {"tool_calls": [image_event]})
    continue
```

For non-stream responses, keep the final assistant text unchanged; image metadata is available in stored events and SSE. Do not include raw `result` base64 in SSE.

- [ ] **Step 5: Run focused image event test**

Run:

```bash
uv run pytest tests/test_codex_chat_routes.py::test_chat_completions_stream_bridges_codex_image_items_to_sse -q
```

Expected: pass.

## Task 5: Persist User Attachment Metadata

**Files:**
- Modify: `src/interfaces/server/codex_chat.py`
- Test: `tests/test_codex_chat_routes.py`

- [ ] **Step 1: Write failing persistence test**

Append to `tests/test_codex_chat_routes.py`:

```python
def test_chat_completions_persists_user_image_blocks(tmp_path: Path, monkeypatch):
    provider = InstantCodexProvider(output="done")
    client = _client(tmp_path, monkeypatch, provider)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "codex-medium",
            "stream": False,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "See image"},
                        {"type": "image_url", "image_url": {"url": "https://example.com/a.png"}},
                    ],
                }
            ],
        },
    )
    assert response.status_code == 200
    body = response.json()

    session = client.get(f"/v1/sessions/{body['session_id']}")
    user_message = session.json()["messages"][0]
    assert user_message["message"]["content"] == [
        {"type": "text", "text": "See image"},
        {"type": "image", "url": "https://example.com/a.png"},
    ]
```

- [ ] **Step 2: Update session message appending**

Modify `_append_session_messages` signature:

```python
def _append_session_messages(
    session: Session,
    user_input: str,
    assistant_text: str,
    *,
    user_content: list[dict[str, Any]] | None = None,
) -> None:
```

Implementation:

```python
    content = user_content if user_content else user_input
    session.messages.append(create_user_message(content=content, created_at=user_created_at))
```

When calling `_append_session_messages`, pass:

```python
user_content=[
    item
    for item in input_items
    if item.get("type") in {"text", "image", "localImage"}
]
```

- [ ] **Step 3: Run persistence test**

Run:

```bash
uv run pytest tests/test_codex_chat_routes.py::test_chat_completions_persists_user_image_blocks -q
```

Expected: pass.

## Task 6: Regression and Formatting

**Files:**
- All modified backend files.

- [ ] **Step 1: Run focused backend tests**

Run:

```bash
uv run pytest tests/test_workspace_routes.py tests/test_codex_chat_routes.py tests/test_codex_app_server_runner.py -q
```

Expected: pass.

- [ ] **Step 2: Run full backend tests**

Run:

```bash
uv run pytest
```

Expected: pass.

- [ ] **Step 3: Format and lint**

Run:

```bash
uv run ruff format .
uv run ruff check .
```

Expected: format succeeds and ruff reports no errors.

- [ ] **Step 4: Manual app-server probe**

Run a local chat request with an uploaded image:

```bash
curl -sS -H "Authorization: Bearer $RIPPLE_API_KEY" \
  -H "X-Ripple-User-Id: alice" \
  -F "kind=image" \
  -F "file=@/absolute/path/to/screenshot.png;type=image/png" \
  http://127.0.0.1:8000/v1/workspace/attachments
```

Then use the returned `/workspace/...` path in chat:

```bash
curl -sS -H "Authorization: Bearer $RIPPLE_API_KEY" \
  -H "X-Ripple-User-Id: alice" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:8000/v1/chat/completions \
  -d '{
    "model": "codex-medium",
    "stream": true,
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "Describe this image briefly."},
        {"type": "file", "file": {"path": "/workspace/.ripple/uploads/YYYY/MM/DD/<file>.png", "name": "screenshot.png", "mime_type": "image/png"}}
      ]
    }]
  }'
```

Expected:

- Request reaches Codex with a `localImage` input item.
- SSE text output still streams normally.
- Any generated image output appears as `image_generation` with `/workspace/.ripple/generated/...png`.

## Rollout Notes

- This plan does not expose arbitrary service `CODEX_HOME` files. Generated images are copied into the user's workspace before they are returned to clients.
- Generic non-image attachments are not sent as native Codex binary input. They are saved and referenced in the prompt by workspace path so Codex can inspect them through filesystem tools when appropriate.
- The upload endpoint is user-scoped by `X-Ripple-User-Id` and stores files under that user's long-lived workspace.
- The existing OpenAI-compatible text-only request shape continues to work because `input_items` defaults to a single text item.

## Self-Review

- Spec coverage: image input, file upload, generic attachments, image output, generated output import, SSE, session persistence, and tests are covered.
- Placeholder scan: no unresolved placeholder markers or unspecified test steps remain.
- Type consistency: `input_items`, `localImage`, `image`, `attachment`, `workspace_path`, and `savedPath` names are used consistently with Ripple and Codex app-server conventions.
