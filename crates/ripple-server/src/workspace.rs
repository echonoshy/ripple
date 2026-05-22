use std::path::{Component, Path, PathBuf};

use mime_guess::MimeGuess;
use serde::Serialize;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use walkdir::WalkDir;

const CODE_EXTENSIONS: &[&str] = &[
    "c", "cc", "cpp", "cs", "css", "go", "html", "java", "js", "jsx", "kt", "lua", "php", "py",
    "rb", "rs", "scss", "sh", "sql", "swift", "ts", "tsx", "vue",
];
const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdx", "rst"];
const TEXT_EXTENSIONS: &[&str] = &[
    "cfg", "conf", "csv", "env", "ini", "json", "jsonl", "log", "txt", "toml", "xml", "yaml", "yml",
];

#[derive(Debug, Serialize)]
pub struct WorkspaceEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size_bytes: u64,
    pub modified_at: String,
    pub is_hidden: bool,
    pub mime_type: Option<String>,
    #[serde(rename = "match")]
    pub match_kind: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceListing {
    pub path: String,
    pub parent_path: Option<String>,
    pub entries: Vec<WorkspaceEntry>,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceSearchResponse {
    pub query: String,
    pub count: usize,
    pub entries: Vec<WorkspaceEntry>,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceFilePreview {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    pub modified_at: String,
    pub mime_type: String,
    pub encoding: String,
    pub content: String,
    pub truncated: bool,
}

pub fn list_directory(workspace_root: &Path, path: &str) -> anyhow::Result<WorkspaceListing> {
    let dir = validate_existing_path(path, workspace_root)?;
    if !dir.is_dir() {
        anyhow::bail!("Path is not a directory");
    }
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        entries.push(entry_for_path(workspace_root, &entry.path(), None)?);
    }
    entries.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
        ("directory", "file") => std::cmp::Ordering::Less,
        ("file", "directory") => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(WorkspaceListing {
        path: workspace_path(workspace_root, &dir)?,
        parent_path: parent_workspace_path(workspace_root, &dir),
        entries,
    })
}

pub fn preview_file(
    workspace_root: &Path,
    path: &str,
    limit: usize,
) -> anyhow::Result<WorkspaceFilePreview> {
    let target = validate_existing_path(path, workspace_root)?;
    if !target.is_file() {
        anyhow::bail!("Path is not a file");
    }
    let metadata = target.metadata()?;
    let bytes = std::fs::read(&target)?;
    if bytes
        .iter()
        .take(limit.min(bytes.len()))
        .any(|byte| *byte == 0)
    {
        anyhow::bail!("Binary files cannot be previewed");
    }
    let truncated = bytes.len() > limit;
    let selected = if truncated { &bytes[..limit] } else { &bytes };
    let content = String::from_utf8_lossy(selected).into_owned();
    Ok(WorkspaceFilePreview {
        path: workspace_path(workspace_root, &target)?,
        name: target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_string(),
        size_bytes: metadata.len(),
        modified_at: modified_at(&metadata),
        mime_type: mime_type_for_path(&target),
        encoding: "utf-8".to_string(),
        content,
        truncated,
    })
}

pub fn save_text_file(
    workspace_root: &Path,
    path: &str,
    content: &str,
    expected_modified_at: Option<&str>,
) -> anyhow::Result<WorkspaceFilePreview> {
    let target = validate_write_path(path, workspace_root)?;
    if target.is_dir() {
        anyhow::bail!("Path is not a file");
    }
    if let Some(expected) = expected_modified_at {
        if target.exists() {
            let current = modified_at(&target.metadata()?);
            if current != expected {
                anyhow::bail!("File changed on disk");
            }
        }
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&target, content)?;
    preview_file(workspace_root, path, content.len().max(64 * 1024))
}

pub fn rename_entry(
    workspace_root: &Path,
    path: &str,
    new_name: &str,
) -> anyhow::Result<WorkspaceEntry> {
    if new_name.contains('/') || new_name.contains('\\') || new_name == "." || new_name == ".." {
        anyhow::bail!("Invalid name");
    }
    let target = validate_existing_path(path, workspace_root)?;
    let Some(parent) = target.parent() else {
        anyhow::bail!("Path has no parent");
    };
    let destination = parent.join(new_name);
    let destination = validate_write_path(
        &workspace_path(workspace_root, &destination)?,
        workspace_root,
    )?;
    if destination.exists() {
        anyhow::bail!("A file or folder with that name already exists");
    }
    std::fs::rename(&target, &destination)?;
    entry_for_path(workspace_root, &destination, None)
}

pub fn entry_for_existing_path(
    workspace_root: &Path,
    path: &Path,
) -> anyhow::Result<WorkspaceEntry> {
    let target = validate_existing_path(&workspace_path(workspace_root, path)?, workspace_root)?;
    entry_for_path(workspace_root, &target, None)
}

pub fn search_files(
    workspace_root: &Path,
    query: &str,
    limit: usize,
    scope: &str,
    kind: &str,
    file_type: &str,
    include_hidden: bool,
    max_file_bytes: u64,
) -> anyhow::Result<WorkspaceSearchResponse> {
    let normalized_query = query.trim().to_lowercase();
    if normalized_query.is_empty() {
        return Ok(WorkspaceSearchResponse {
            query: query.to_string(),
            count: 0,
            entries: Vec::new(),
        });
    }
    let normalized_scope = if matches!(scope, "all" | "name" | "content") {
        scope
    } else {
        "name"
    };
    let normalized_kind = if matches!(kind, "all" | "file" | "directory") {
        kind
    } else {
        "all"
    };
    let normalized_file_type =
        if matches!(file_type, "all" | "code" | "markdown" | "text" | "image") {
            file_type
        } else {
            "all"
        };
    let max_file_bytes = max_file_bytes.max(1);
    let mut entries = Vec::new();
    for entry in WalkDir::new(workspace_root)
        .into_iter()
        .filter_map(Result::ok)
    {
        if entries.len() >= limit {
            break;
        }
        let path = entry.path();
        if path == workspace_root {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if !include_hidden && name.starts_with('.') {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if normalized_kind == "file" && !metadata.is_file() {
            continue;
        }
        if normalized_kind == "directory" && !metadata.is_dir() {
            continue;
        }
        if metadata.is_dir() && normalized_file_type != "all" {
            continue;
        }
        if metadata.is_file() && !file_type_matches(path, normalized_file_type) {
            continue;
        }
        let mut match_kind = None;
        if normalized_scope != "content" {
            let rel = workspace_path(workspace_root, path)?;
            if name.to_lowercase().contains(&normalized_query)
                || rel.to_lowercase().contains(&normalized_query)
            {
                match_kind = Some("name".to_string());
            }
        }
        if match_kind.is_none()
            && normalized_scope != "name"
            && metadata.is_file()
            && metadata.len() <= max_file_bytes
        {
            if let Ok(text) = std::fs::read_to_string(path) {
                if text.to_lowercase().contains(&normalized_query) {
                    match_kind = Some("content".to_string());
                }
            }
        }
        if match_kind.is_some() {
            entries.push(entry_for_path(workspace_root, path, match_kind)?);
        }
    }
    Ok(WorkspaceSearchResponse {
        query: query.to_string(),
        count: entries.len(),
        entries,
    })
}

fn file_type_matches(path: &Path, file_type: &str) -> bool {
    if file_type == "all" {
        return true;
    }
    let suffix = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime_type = mime_type_for_path(path);
    match file_type {
        "code" => CODE_EXTENSIONS.contains(&suffix.as_str()),
        "markdown" => MARKDOWN_EXTENSIONS.contains(&suffix.as_str()),
        "text" => {
            TEXT_EXTENSIONS.contains(&suffix.as_str())
                || MARKDOWN_EXTENSIONS.contains(&suffix.as_str())
                || mime_type.starts_with("text/")
        }
        "image" => mime_type.starts_with("image/"),
        _ => true,
    }
}

pub fn validate_existing_path(input: &str, workspace_root: &Path) -> anyhow::Result<PathBuf> {
    let target = map_workspace_path(input, workspace_root);
    let resolved = target.canonicalize()?;
    let workspace = workspace_root.canonicalize()?;
    if !resolved.starts_with(&workspace) {
        anyhow::bail!("Access denied");
    }
    Ok(resolved)
}

pub fn validate_write_path(input: &str, workspace_root: &Path) -> anyhow::Result<PathBuf> {
    let target = map_workspace_path(input, workspace_root);
    let workspace = workspace_root.canonicalize()?;
    let parent = target.parent().unwrap_or(workspace_root);
    let resolved_parent = if parent.exists() {
        parent.canonicalize()?
    } else {
        normalize_path(parent)
    };
    if !resolved_parent.starts_with(&workspace) {
        anyhow::bail!("Access denied");
    }
    Ok(resolved_parent.join(target.file_name().unwrap_or_default()))
}

pub fn workspace_path(workspace_root: &Path, path: &Path) -> anyhow::Result<String> {
    let workspace = workspace_root.canonicalize()?;
    let resolved = if path.exists() {
        path.canonicalize()?
    } else {
        normalize_path(path)
    };
    let relative = resolved.strip_prefix(&workspace).unwrap_or(Path::new(""));
    if relative.as_os_str().is_empty() {
        Ok("/workspace".to_string())
    } else {
        Ok(format!(
            "/workspace/{}",
            relative.to_string_lossy().replace('\\', "/")
        ))
    }
}

fn map_workspace_path(input: &str, workspace_root: &Path) -> PathBuf {
    let path = PathBuf::from(input);
    if path.is_absolute() {
        if let Ok(relative) = path.strip_prefix("/workspace") {
            workspace_root.join(relative)
        } else {
            path
        }
    } else {
        workspace_root.join(path)
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn entry_for_path(
    workspace_root: &Path,
    path: &Path,
    match_kind: Option<String>,
) -> anyhow::Result<WorkspaceEntry> {
    let metadata = path.metadata()?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_string();
    Ok(WorkspaceEntry {
        is_hidden: name.starts_with('.'),
        name,
        path: workspace_path(workspace_root, path)?,
        kind: if metadata.is_dir() {
            "directory"
        } else {
            "file"
        }
        .to_string(),
        size_bytes: if metadata.is_file() {
            metadata.len()
        } else {
            0
        },
        modified_at: modified_at(&metadata),
        mime_type: metadata.is_file().then(|| mime_type_for_path(path)),
        match_kind,
    })
}

fn parent_workspace_path(workspace_root: &Path, dir: &Path) -> Option<String> {
    if dir == workspace_root {
        return None;
    }
    dir.parent()
        .and_then(|parent| workspace_path(workspace_root, parent).ok())
}

fn modified_at(metadata: &std::fs::Metadata) -> String {
    metadata
        .modified()
        .ok()
        .and_then(|time| {
            let datetime: OffsetDateTime = time.into();
            datetime.format(&Rfc3339).ok()
        })
        .unwrap_or_default()
}

pub fn mime_type_for_path(path: &Path) -> String {
    MimeGuess::from_path(path)
        .first_or_octet_stream()
        .essence_str()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn search_files_filters_by_file_type() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("ripple-workspace-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root)?;
        std::fs::write(root.join("main.rs"), "fn main() {}")?;
        std::fs::write(root.join("notes.md"), "hello notes")?;
        std::fs::write(root.join("image.png"), b"png")?;

        let code = search_files(&root, "main", 20, "name", "all", "code", false, 1024)?;
        assert_eq!(code.count, 1);
        assert_eq!(code.entries[0].path, "/workspace/main.rs");

        let markdown = search_files(&root, "notes", 20, "name", "all", "markdown", false, 1024)?;
        assert_eq!(markdown.count, 1);
        assert_eq!(markdown.entries[0].path, "/workspace/notes.md");

        let image = search_files(&root, "image", 20, "name", "all", "image", false, 1024)?;
        assert_eq!(image.count, 1);
        assert_eq!(image.entries[0].path, "/workspace/image.png");

        let empty = search_files(&root, "", 20, "name", "all", "all", false, 1024)?;
        assert_eq!(empty.count, 0);

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }
}
