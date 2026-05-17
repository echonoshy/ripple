import mimetypes
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from interfaces.server.schemas import (
    WorkspaceEntry,
    WorkspaceFilePreviewResponse,
    WorkspaceListingResponse,
    WorkspaceSearchResponse,
)
from ripple.sandbox.workspace import SANDBOX_VIRTUAL_ROOT, validate_path

DEFAULT_PREVIEW_LIMIT_BYTES = 64 * 1024
MAX_PREVIEW_LIMIT_BYTES = 256 * 1024
MAX_SAVE_BYTES = 1024 * 1024
DEFAULT_SEARCH_LIMIT = 20
MAX_SEARCH_LIMIT = 50
DEFAULT_SEARCH_MAX_FILE_BYTES = 1024 * 1024
SEARCH_SKIP_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".ripple",
    ".venv",
    "__pycache__",
    "dist",
    "node_modules",
}
SEARCH_SCOPES = {"all", "name", "content"}
SEARCH_KINDS = {"all", "file", "directory"}
SEARCH_FILE_TYPES = {"all", "code", "markdown", "text", "image"}
CODE_EXTENSIONS = {
    ".c",
    ".cc",
    ".cpp",
    ".cs",
    ".css",
    ".go",
    ".html",
    ".java",
    ".js",
    ".jsx",
    ".kt",
    ".lua",
    ".php",
    ".py",
    ".rb",
    ".rs",
    ".scss",
    ".sh",
    ".sql",
    ".swift",
    ".ts",
    ".tsx",
    ".vue",
}
MARKDOWN_EXTENSIONS = {".md", ".markdown", ".mdx", ".rst"}
TEXT_EXTENSIONS = {
    ".cfg",
    ".conf",
    ".csv",
    ".env",
    ".ini",
    ".json",
    ".jsonl",
    ".log",
    ".txt",
    ".toml",
    ".xml",
    ".yaml",
    ".yml",
}


class BinaryFileError(ValueError):
    pass


class WorkspaceFileConflictError(ValueError):
    pass


class WorkspaceFileTooLargeError(ValueError):
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


def search_workspace_files(
    workspace_root: Path,
    query: str,
    *,
    limit: int = DEFAULT_SEARCH_LIMIT,
    scope: str = "all",
    kind: str = "all",
    file_type: str = "all",
    include_hidden: bool = False,
    max_file_bytes: int = DEFAULT_SEARCH_MAX_FILE_BYTES,
) -> WorkspaceSearchResponse:
    normalized_query = query.strip().lower()
    capped_limit = max(1, min(limit, MAX_SEARCH_LIMIT))
    normalized_scope = scope if scope in SEARCH_SCOPES else "all"
    normalized_kind = kind if kind in SEARCH_KINDS else "all"
    normalized_file_type = file_type if file_type in SEARCH_FILE_TYPES else "all"
    capped_max_file_bytes = max(1, max_file_bytes)
    if not normalized_query:
        return WorkspaceSearchResponse(query=query, count=0, entries=[])

    root = validate_path(SANDBOX_VIRTUAL_ROOT, workspace_root)
    matches: list[WorkspaceEntry] = []
    stack = [root]
    while stack and len(matches) < capped_limit:
        current = stack.pop()
        try:
            children = sorted(current.iterdir(), key=lambda path: (not path.is_dir(), path.name.lower()))
        except OSError:
            continue

        for child in children:
            if len(matches) >= capped_limit:
                break
            if child.name in SEARCH_SKIP_DIRS:
                continue
            if not include_hidden and _is_hidden_workspace_path(workspace_root, child):
                continue
            try:
                validate_path(child, workspace_root)
            except PermissionError:
                continue
            entry = _entry_for_path(workspace_root, child)
            if child.is_dir():
                if (
                    normalized_kind != "file"
                    and normalized_file_type == "all"
                    and normalized_scope != "content"
                    and _path_matches_query(entry, normalized_query)
                ):
                    matches.append(entry)
                    if len(matches) >= capped_limit:
                        break
                if not child.is_symlink():
                    stack.append(child)
                continue
            if not child.is_file():
                continue
            if normalized_kind == "directory":
                continue
            if not _file_type_matches(child, normalized_file_type):
                continue

            path_match = normalized_scope != "content" and _path_matches_query(entry, normalized_query)
            content_match = normalized_scope != "name" and _file_content_matches(
                child,
                normalized_query,
                max_file_bytes=capped_max_file_bytes,
            )
            if path_match or content_match:
                matches.append(entry)

    matches.sort(key=lambda entry: entry.path.lower())
    return WorkspaceSearchResponse(query=query, count=len(matches), entries=matches)


def rename_workspace_entry(
    workspace_root: Path,
    requested_path: str | Path,
    *,
    new_name: str,
) -> WorkspaceEntry:
    resolved = _resolve_workspace_path(workspace_root, requested_path)
    if resolved.host_path == workspace_root.resolve():
        raise ValueError("Workspace root cannot be renamed")
    clean_name = _validate_new_entry_name(new_name)
    if not resolved.host_path.exists():
        target = resolved.host_path.with_name(clean_name)
        validate_path(target, workspace_root)
        if target.exists():
            return _entry_for_path(workspace_root, target)
        raise FileNotFoundError(resolved.virtual_path)

    if clean_name == resolved.host_path.name:
        return _entry_for_path(workspace_root, resolved.host_path)

    target = resolved.host_path.with_name(clean_name)
    validate_path(target, workspace_root)
    if target.exists():
        raise FileExistsError(_virtual_path(workspace_root, target))

    renamed = resolved.host_path.rename(target)
    return _entry_for_path(workspace_root, renamed)


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


def save_workspace_text_file(
    workspace_root: Path,
    requested_path: str | Path,
    *,
    content: str,
    expected_modified_at: str | None = None,
) -> WorkspaceFilePreviewResponse:
    resolved = _resolve_workspace_path(workspace_root, requested_path)
    if not resolved.host_path.exists():
        raise FileNotFoundError(resolved.virtual_path)
    if not resolved.host_path.is_file():
        raise IsADirectoryError(resolved.virtual_path)

    stat = resolved.host_path.stat()
    current_modified_at = _format_mtime(stat.st_mtime)
    if expected_modified_at is not None and expected_modified_at != current_modified_at:
        raise WorkspaceFileConflictError(resolved.virtual_path)

    existing_sample = resolved.host_path.read_bytes()[: min(stat.st_size, 4096)]
    if _looks_binary(existing_sample):
        raise BinaryFileError(resolved.virtual_path)

    raw = content.encode("utf-8")
    if len(raw) > MAX_SAVE_BYTES:
        raise WorkspaceFileTooLargeError(resolved.virtual_path)

    resolved.host_path.write_bytes(raw)
    return preview_workspace_file(
        workspace_root,
        resolved.virtual_path,
        limit_bytes=min(max(len(raw), 1), MAX_PREVIEW_LIMIT_BYTES),
    )


def _resolve_workspace_path(workspace_root: Path, requested_path: str | Path) -> ResolvedWorkspacePath:
    host_path = validate_path(requested_path, workspace_root)
    return ResolvedWorkspacePath(host_path=host_path, virtual_path=_virtual_path(workspace_root, host_path))


def _validate_new_entry_name(new_name: str) -> str:
    clean_name = new_name.strip()
    if not clean_name or clean_name in {".", ".."}:
        raise ValueError("Name cannot be empty")
    if Path(clean_name).name != clean_name or "/" in clean_name or "\\" in clean_name:
        raise ValueError("Name must not contain path separators")
    return clean_name


def _is_hidden_workspace_path(workspace_root: Path, path: Path) -> bool:
    try:
        relative = path.resolve().relative_to(workspace_root.resolve())
    except ValueError:
        return True
    return any(part.startswith(".") for part in relative.parts)


def _path_matches_query(entry: WorkspaceEntry, normalized_query: str) -> bool:
    return normalized_query in f"{entry.name}\n{entry.path}".lower()


def _file_type_matches(path: Path, file_type: str) -> bool:
    if file_type == "all":
        return True
    suffix = path.suffix.lower()
    mime_type = mimetypes.guess_type(path.name)[0] or ""
    if file_type == "code":
        return suffix in CODE_EXTENSIONS
    if file_type == "markdown":
        return suffix in MARKDOWN_EXTENSIONS
    if file_type == "text":
        return suffix in TEXT_EXTENSIONS or suffix in MARKDOWN_EXTENSIONS or mime_type.startswith("text/")
    if file_type == "image":
        return mime_type.startswith("image/")
    return True


def _file_content_matches(path: Path, normalized_query: str, *, max_file_bytes: int) -> bool:
    try:
        stat = path.stat()
        if stat.st_size > max_file_bytes:
            return False
        raw = path.read_bytes()
    except OSError:
        return False
    if _looks_binary(raw[:4096]):
        return False
    return normalized_query in raw.decode("utf-8", errors="replace").lower()


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
        mime_type=None if kind == "directory" else mimetypes.guess_type(path.name)[0],
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
