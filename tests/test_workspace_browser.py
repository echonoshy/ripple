from pathlib import Path

import pytest

from interfaces.server.workspace_browser import (
    BinaryFileError,
    WorkspaceFileConflictError,
    browse_workspace_directory,
    preview_workspace_file,
    rename_workspace_entry,
    save_workspace_text_file,
    search_workspace_files,
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


def test_search_workspace_files_matches_paths_and_skips_system_dirs(tmp_path: Path):
    workspace = tmp_path / "workspace"
    (workspace / "src" / "components").mkdir(parents=True)
    (workspace / ".git").mkdir(parents=True)
    (workspace / ".ripple" / "uploads").mkdir(parents=True)
    (workspace / "node_modules" / "pkg").mkdir(parents=True)
    (workspace / "src" / "components" / "TaskComposer.tsx").write_text("export {}", encoding="utf-8")
    (workspace / ".git" / "TaskComposer.tsx").write_text("ignored", encoding="utf-8")
    (workspace / ".ripple" / "uploads" / "TaskComposer.tsx").write_text("ignored", encoding="utf-8")
    (workspace / "node_modules" / "pkg" / "TaskComposer.tsx").write_text("ignored", encoding="utf-8")

    results = search_workspace_files(workspace, "taskcomposer")

    assert [entry.path for entry in results.entries] == ["/workspace/src/components/TaskComposer.tsx"]
    assert results.query == "taskcomposer"
    assert results.entries[0].match == "name"


def test_search_workspace_files_defaults_to_name_scope(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "config.json").write_text("{}", encoding="utf-8")
    (workspace / "AGENTS.md").write_text("mentions json in content", encoding="utf-8")

    results = search_workspace_files(workspace, "json")

    assert [entry.path for entry in results.entries] == ["/workspace/config.json"]
    assert results.entries[0].match == "name"


def test_search_workspace_files_ranks_name_path_and_content_matches(tmp_path: Path):
    workspace = tmp_path / "workspace"
    (workspace / "docs" / "json-guide").mkdir(parents=True)
    (workspace / "src").mkdir()
    (workspace / "config.json").write_text("{}", encoding="utf-8")
    (workspace / "docs" / "json-guide" / "notes.md").write_text("notes", encoding="utf-8")
    (workspace / "AGENTS.md").write_text("mentions json in content", encoding="utf-8")

    results = search_workspace_files(workspace, "json", scope="all")

    assert [entry.path for entry in results.entries] == [
        "/workspace/config.json",
        "/workspace/docs/json-guide",
        "/workspace/docs/json-guide/notes.md",
        "/workspace/AGENTS.md",
    ]
    assert [entry.match for entry in results.entries] == ["name", "name", "path", "content"]


def test_search_workspace_files_supports_scope_type_and_hidden_filters(tmp_path: Path):
    workspace = tmp_path / "workspace"
    (workspace / "src").mkdir(parents=True)
    (workspace / "docs").mkdir()
    (workspace / ".hidden").mkdir()
    (workspace / "src" / "notes.ts").write_text("needle in code", encoding="utf-8")
    (workspace / "docs" / "notes.md").write_text("needle in markdown", encoding="utf-8")
    (workspace / "image.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    (workspace / ".hidden" / "notes.txt").write_text("needle hidden", encoding="utf-8")

    code_results = search_workspace_files(workspace, "needle", scope="content", file_type="code")
    hidden_results = search_workspace_files(workspace, "needle", scope="content", include_hidden=True)
    directory_results = search_workspace_files(workspace, "doc", scope="name", kind="directory")

    assert [entry.path for entry in code_results.entries] == ["/workspace/src/notes.ts"]
    assert [entry.path for entry in hidden_results.entries] == [
        "/workspace/.hidden/notes.txt",
        "/workspace/docs/notes.md",
        "/workspace/src/notes.ts",
    ]
    assert [entry.path for entry in directory_results.entries] == ["/workspace/docs"]


def test_rename_workspace_entry_supports_files_and_directories(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "notes.txt").write_text("hello", encoding="utf-8")
    (workspace / "drafts").mkdir()

    renamed_file = rename_workspace_entry(workspace, "/workspace/notes.txt", new_name="README.md")
    renamed_dir = rename_workspace_entry(workspace, "/workspace/drafts", new_name="docs")

    assert renamed_file.name == "README.md"
    assert renamed_file.path == "/workspace/README.md"
    assert (workspace / "README.md").read_text(encoding="utf-8") == "hello"
    assert not (workspace / "notes.txt").exists()
    assert renamed_dir.name == "docs"
    assert renamed_dir.path == "/workspace/docs"
    assert (workspace / "docs").is_dir()


def test_rename_workspace_entry_rejects_conflicts_and_path_segments(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "notes.txt").write_text("hello", encoding="utf-8")
    (workspace / "README.md").write_text("existing", encoding="utf-8")

    with pytest.raises(FileExistsError):
        rename_workspace_entry(workspace, "/workspace/notes.txt", new_name="README.md")

    with pytest.raises(ValueError):
        rename_workspace_entry(workspace, "/workspace/notes.txt", new_name="../escape.txt")

    assert (workspace / "notes.txt").read_text(encoding="utf-8") == "hello"


def test_rename_workspace_entry_is_idempotent_after_successful_duplicate_submit(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "notes.txt").write_text("hello", encoding="utf-8")

    first = rename_workspace_entry(workspace, "/workspace/notes.txt", new_name="README.md")
    second = rename_workspace_entry(workspace, "/workspace/notes.txt", new_name="README.md")

    assert first.path == "/workspace/README.md"
    assert second.path == "/workspace/README.md"
    assert (workspace / "README.md").read_text(encoding="utf-8") == "hello"
