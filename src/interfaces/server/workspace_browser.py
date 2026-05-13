import mimetypes
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from interfaces.server.schemas import (
    WorkspaceEntry,
    WorkspaceFilePreviewResponse,
    WorkspaceListingResponse,
)
from ripple.sandbox.workspace import SANDBOX_VIRTUAL_ROOT, validate_path

DEFAULT_PREVIEW_LIMIT_BYTES = 64 * 1024
MAX_PREVIEW_LIMIT_BYTES = 256 * 1024


class BinaryFileError(ValueError):
    pass


@dataclass(frozen=True)
class ResolvedWorkspacePath:
    host_path: Path
    virtual_path: str


def browse_workspace_directory(
    workspace_root: Path,
    requested_path: str | Path = SANDBOX_VIRTUAL_ROOT,
) -> WorkspaceListingResponse:
    resolved = _resolve_workspace_path(workspace_root, requested_path)
    if not resolved.host_path.exists():
        raise FileNotFoundError(resolved.virtual_path)
    if not resolved.host_path.is_dir():
        raise NotADirectoryError(resolved.virtual_path)

    entries = [_entry_for_path(workspace_root, child) for child in resolved.host_path.iterdir()]
    entries.sort(key=lambda entry: (entry.kind != "directory", entry.name.lower()))

    return WorkspaceListingResponse(
        path=resolved.virtual_path,
        parent_path=_parent_virtual_path(resolved.virtual_path),
        entries=entries,
    )


def preview_workspace_file(
    workspace_root: Path,
    requested_path: str | Path,
    *,
    limit_bytes: int = DEFAULT_PREVIEW_LIMIT_BYTES,
) -> WorkspaceFilePreviewResponse:
    resolved = _resolve_workspace_path(workspace_root, requested_path)
    if not resolved.host_path.exists():
        raise FileNotFoundError(resolved.virtual_path)
    if not resolved.host_path.is_file():
        raise IsADirectoryError(resolved.virtual_path)

    limit = max(1, min(limit_bytes, MAX_PREVIEW_LIMIT_BYTES))
    stat = resolved.host_path.stat()
    raw = resolved.host_path.read_bytes()[: limit + 1]
    if _looks_binary(raw):
        raise BinaryFileError(resolved.virtual_path)

    truncated = len(raw) > limit or stat.st_size > limit
    content = raw[:limit].decode("utf-8", errors="replace")
    mime_type = mimetypes.guess_type(resolved.host_path.name)[0] or "text/plain"

    return WorkspaceFilePreviewResponse(
        path=resolved.virtual_path,
        name=resolved.host_path.name,
        size_bytes=stat.st_size,
        modified_at=_format_mtime(stat.st_mtime),
        mime_type=mime_type,
        encoding="utf-8",
        content=content,
        truncated=truncated,
    )


def _resolve_workspace_path(workspace_root: Path, requested_path: str | Path) -> ResolvedWorkspacePath:
    host_path = validate_path(requested_path, workspace_root)
    return ResolvedWorkspacePath(host_path=host_path, virtual_path=_virtual_path(workspace_root, host_path))


def _entry_for_path(workspace_root: Path, path: Path) -> WorkspaceEntry:
    stat = path.stat()
    kind = "directory" if path.is_dir() else "file"
    return WorkspaceEntry(
        name=path.name,
        path=_virtual_path(workspace_root, path),
        kind=kind,
        size_bytes=0 if kind == "directory" else stat.st_size,
        modified_at=_format_mtime(stat.st_mtime),
        is_hidden=path.name.startswith("."),
    )


def _virtual_path(workspace_root: Path, host_path: Path) -> str:
    relative = host_path.absolute().relative_to(workspace_root.absolute())
    if str(relative) == ".":
        return str(SANDBOX_VIRTUAL_ROOT)
    return str(SANDBOX_VIRTUAL_ROOT / relative)


def _parent_virtual_path(virtual_path: str) -> str | None:
    path = Path(virtual_path)
    if path == SANDBOX_VIRTUAL_ROOT:
        return None
    parent = path.parent
    if parent == Path("/"):
        return str(SANDBOX_VIRTUAL_ROOT)
    return str(parent)


def _format_mtime(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, tz=UTC).isoformat()


def _looks_binary(raw: bytes) -> bool:
    if not raw:
        return False
    if b"\x00" in raw:
        return True
    sample = raw[:1024]
    control_count = sum(1 for byte in sample if byte < 32 and byte not in (9, 10, 13))
    return control_count / len(sample) > 0.30
