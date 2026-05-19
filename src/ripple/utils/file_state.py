"""Small helpers for durable file-backed state.

These helpers keep Ripple's fast local-file storage simple while avoiding the
most common failure mode: replacing a good state file with a partial write.
"""

import json
import os
import tempfile
from pathlib import Path
from typing import Any, Callable


def _fsync_parent(path: Path) -> None:
    try:
        dir_fd = os.open(path.parent, os.O_DIRECTORY)
    except OSError:
        return
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


def atomic_write_text(path: Path, text: str) -> None:
    """Atomically replace a text file with flush/fsync + rename."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        tmp_path.replace(path)
        _fsync_parent(path)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


def atomic_write_json(
    path: Path,
    data: Any,
    *,
    indent: int | None = 2,
    default: Callable[[Any], Any] | None = None,
) -> None:
    """Atomically write JSON, leaving the existing file intact on errors."""
    kwargs: dict[str, Any] = {"ensure_ascii": False, "indent": indent}
    if default is not None:
        kwargs["default"] = default
    text = json.dumps(data, **kwargs) + "\n"
    atomic_write_text(path, text)


def atomic_write_lines(path: Path, lines: list[str]) -> None:
    """Atomically write newline-terminated text lines."""
    atomic_write_text(path, "".join(f"{line}\n" for line in lines))


def read_json_or_default(path: Path, default: Any) -> Any:
    """Read JSON from a file, returning default for missing/corrupt content."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def read_jsonl_tolerant(path: Path) -> list[dict[str, Any]]:
    """Read valid JSON object lines and skip blank/corrupt/non-object lines."""
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    try:
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    record = json.loads(stripped)
                except json.JSONDecodeError:
                    continue
                if isinstance(record, dict):
                    records.append(record)
    except OSError:
        return records
    return records


def count_jsonl_records(path: Path) -> int:
    """Count non-empty JSONL records by physical lines, even if one is corrupt."""
    if not path.exists():
        return 0
    count = 0
    try:
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    count += 1
    except OSError:
        return 0
    return count


def append_jsonl(path: Path, record: Any) -> None:
    """Append one JSONL record and fsync it."""
    append_lines(path, [json.dumps(record, ensure_ascii=False)])


def append_lines(path: Path, lines: list[str]) -> None:
    """Append newline-terminated lines and fsync them."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        for line in lines:
            handle.write(line + "\n")
        handle.flush()
        os.fsync(handle.fileno())
