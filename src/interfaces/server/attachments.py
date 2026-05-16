"""Workspace attachment storage for chat uploads and generated media."""

import base64
import mimetypes
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from ripple.sandbox.workspace import SANDBOX_VIRTUAL_ROOT, validate_path
from ripple.users.quota import assert_workspace_save_within_quota

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
            "name": self.name,
            "mime_type": self.mime_type,
            "size": self.size,
            "kind": self.kind,
        }


def sanitize_filename(filename: str | None) -> str:
    name = Path(filename or "upload.bin").name
    name = SAFE_FILENAME_RE.sub("-", name).strip(".-")
    return name or "upload.bin"


def detect_mime_type(filename: str | None, content_type: str | None = None) -> str:
    clean_content_type = (content_type or "").split(";", 1)[0].strip()
    if clean_content_type:
        return clean_content_type
    return mimetypes.guess_type(filename or "")[0] or "application/octet-stream"


def is_image_mime_type(mime_type: str) -> bool:
    return mime_type.lower().startswith("image/")


def workspace_path_for_host_path(workspace_root: Path, host_path: Path) -> str:
    relative = host_path.resolve().relative_to(workspace_root.resolve())
    if str(relative) == ".":
        return str(SANDBOX_VIRTUAL_ROOT)
    return str(SANDBOX_VIRTUAL_ROOT / relative)


def host_path_for_workspace_path(workspace_root: Path, workspace_path: str) -> Path:
    path = Path(workspace_path)
    if not _is_under_workspace_virtual_root(path):
        raise PermissionError("attachment path must be under /workspace")
    return validate_path(workspace_path, workspace_root)


def save_uploaded_attachment(
    *,
    config: Any,
    user_id: str,
    workspace_root: Path,
    filename: str | None,
    content_type: str | None,
    data: bytes,
    kind: str,
) -> StoredAttachment:
    safe_name = sanitize_filename(filename)
    mime_type = detect_mime_type(safe_name, content_type)
    resolved_kind = "image" if kind == "image" or is_image_mime_type(mime_type) else "attachment"
    today = datetime.now(timezone.utc)
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


def import_generated_image(
    *,
    config: Any,
    user_id: str,
    workspace_root: Path,
    item_id: str,
    source_path: Path | None = None,
    data: bytes | None = None,
) -> StoredAttachment:
    if data is None:
        if source_path is None:
            raise ValueError("source_path or data is required")
        data = source_path.read_bytes()
    safe_id = sanitize_filename(item_id or "generated-image")
    target_dir = workspace_root / ".ripple" / "generated"
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


def decode_base64_image_payload(payload: str) -> bytes:
    raw = payload
    if "," in payload and payload.startswith("data:"):
        raw = payload.split(",", 1)[1]
    return base64.b64decode(raw, validate=True)


def _is_under_workspace_virtual_root(path: Path) -> bool:
    try:
        path.relative_to(SANDBOX_VIRTUAL_ROOT)
        return True
    except ValueError:
        return False
