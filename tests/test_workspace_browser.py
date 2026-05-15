from pathlib import Path

import pytest

from interfaces.server.workspace_browser import (
    BinaryFileError,
    WorkspaceFileConflictError,
    browse_workspace_directory,
    preview_workspace_file,
    save_workspace_text_file,
)


def test_browse_workspace_directory_sorts_directories_before_files(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "zeta.txt").write_text("z", encoding="utf-8")
    (workspace / "alpha").mkdir()
    (workspace / ".config").mkdir()
    (workspace / "beta.md").write_text("b", encoding="utf-8")

    listing = browse_workspace_directory(workspace, "/workspace")

    assert listing.path == "/workspace"
    assert listing.parent_path is None
    assert [entry.name for entry in listing.entries] == [".config", "alpha", "beta.md", "zeta.txt"]
    assert [entry.kind for entry in listing.entries] == ["directory", "directory", "file", "file"]
    assert listing.entries[0].is_hidden is True
    assert listing.entries[2].path == "/workspace/beta.md"


def test_browse_workspace_directory_supports_nested_relative_paths(tmp_path: Path):
    workspace = tmp_path / "workspace"
    nested = workspace / "src" / "app"
    nested.mkdir(parents=True)
    (nested / "page.tsx").write_text("export default null", encoding="utf-8")

    listing = browse_workspace_directory(workspace, "src/app")

    assert listing.path == "/workspace/src/app"
    assert listing.parent_path == "/workspace/src"
    assert [entry.path for entry in listing.entries] == ["/workspace/src/app/page.tsx"]


def test_browse_workspace_directory_rejects_symlink_escape(tmp_path: Path):
    workspace = tmp_path / "workspace"
    outside = tmp_path / "outside"
    workspace.mkdir()
    outside.mkdir()
    (workspace / "escape").symlink_to(outside, target_is_directory=True)

    with pytest.raises(PermissionError):
        browse_workspace_directory(workspace, "/workspace/escape")


def test_preview_workspace_file_returns_truncated_text(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "notes.md").write_text("hello world", encoding="utf-8")

    preview = preview_workspace_file(workspace, "/workspace/notes.md", limit_bytes=5)

    assert preview.path == "/workspace/notes.md"
    assert preview.name == "notes.md"
    assert preview.content == "hello"
    assert preview.truncated is True
    assert preview.encoding == "utf-8"


def test_preview_workspace_file_rejects_binary_files(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "image.bin").write_bytes(b"\x00\x01\x02\x03")

    with pytest.raises(BinaryFileError):
        preview_workspace_file(workspace, "/workspace/image.bin")


def test_save_workspace_text_file_updates_utf8_content(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    target = workspace / "notes.md"
    target.write_text("before", encoding="utf-8")
    previous = preview_workspace_file(workspace, "/workspace/notes.md")

    saved = save_workspace_text_file(
        workspace,
        "/workspace/notes.md",
        content="after\n",
        expected_modified_at=previous.modified_at,
    )

    assert target.read_text(encoding="utf-8") == "after\n"
    assert saved.path == "/workspace/notes.md"
    assert saved.content == "after\n"
    assert saved.truncated is False


def test_save_workspace_text_file_rejects_stale_modified_at(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    target = workspace / "notes.md"
    target.write_text("current", encoding="utf-8")

    with pytest.raises(WorkspaceFileConflictError):
        save_workspace_text_file(
            workspace,
            "/workspace/notes.md",
            content="overwrite",
            expected_modified_at="2000-01-01T00:00:00+00:00",
        )

    assert target.read_text(encoding="utf-8") == "current"
