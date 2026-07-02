use std::collections::{BTreeMap, HashMap};
use std::path::{Component, Path};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::sync::Mutex;
use walkdir::{DirEntry, WalkDir};

const MAX_REPORTED_CHANGES: usize = 200;

#[derive(Clone, Default)]
pub struct WorkspaceChangeTracker {
    snapshots: Arc<Mutex<HashMap<String, WorkspaceSnapshot>>>,
}

#[derive(Clone, Debug, Default)]
struct WorkspaceSnapshot {
    files: BTreeMap<String, FileSnapshot>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileSnapshot {
    size: u64,
    modified_ms: Option<u128>,
    modified_at: Option<String>,
}

#[derive(Clone, Debug)]
struct WorkspaceChange {
    path: String,
    status: &'static str,
}

impl WorkspaceChangeTracker {
    pub async fn ensure_baseline(
        &self,
        user_id: &str,
        workspace_root: &Path,
    ) -> anyhow::Result<()> {
        {
            let snapshots = self.snapshots.lock().await;
            if snapshots.contains_key(user_id) {
                return Ok(());
            }
        }
        let snapshot = scan_workspace_async(workspace_root).await?;
        let mut snapshots = self.snapshots.lock().await;
        snapshots.entry(user_id.to_string()).or_insert(snapshot);
        Ok(())
    }

    pub async fn scan_event(
        &self,
        user_id: &str,
        workspace_root: &Path,
    ) -> anyhow::Result<Option<Value>> {
        let Some(changed_files) = self.scan_changed_files(user_id, workspace_root).await? else {
            return Ok(None);
        };
        let change_count = changed_files
            .get("change_count")
            .and_then(Value::as_u64)
            .unwrap_or_else(|| {
                changed_files
                    .get("files")
                    .and_then(Value::as_array)
                    .map(|files| files.len() as u64)
                    .unwrap_or(0)
            });
        Ok(Some(json!({
            "type": "workspace_files_changed",
            "changes": changed_files.get("files").cloned().unwrap_or_else(|| json!([])),
            "change_count": change_count,
            "truncated": changed_files.get("truncated").and_then(Value::as_bool).unwrap_or(false),
            "ignored": {
                "directories": IGNORED_DIR_NAMES
            },
            "ripple_changed_files": changed_files
        })))
    }

    pub async fn scan_changed_files(
        &self,
        user_id: &str,
        workspace_root: &Path,
    ) -> anyhow::Result<Option<Value>> {
        let next = scan_workspace_async(workspace_root).await?;
        let mut snapshots = self.snapshots.lock().await;
        let previous = snapshots.insert(user_id.to_string(), next.clone());
        let Some(previous) = previous else {
            return Ok(None);
        };

        let changes = diff_snapshots(&previous, &next);
        if changes.is_empty() {
            return Ok(None);
        }

        let change_count = changes.len();
        let files = changes
            .iter()
            .take(MAX_REPORTED_CHANGES)
            .map(|change| {
                json!({
                    "path": change.path,
                    "status": change.status,
                    "additions": Value::Null,
                    "deletions": Value::Null,
                    "previous_path": Value::Null
                })
            })
            .collect::<Vec<_>>();

        Ok(Some(json!({
            "files": files,
            "change_count": change_count,
            "truncated": change_count > MAX_REPORTED_CHANGES,
            "source": "workspace_snapshot"
        })))
    }
}

async fn scan_workspace_async(workspace_root: &Path) -> anyhow::Result<WorkspaceSnapshot> {
    let workspace_root = workspace_root.to_path_buf();
    tokio::task::spawn_blocking(move || scan_workspace(&workspace_root)).await?
}

fn scan_workspace(workspace_root: &Path) -> anyhow::Result<WorkspaceSnapshot> {
    let mut files = BTreeMap::new();
    if !workspace_root.exists() {
        return Ok(WorkspaceSnapshot { files });
    }

    for entry in WalkDir::new(workspace_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| should_visit_entry(workspace_root, entry))
    {
        let entry = entry?;
        let path = entry.path();
        if path == workspace_root {
            continue;
        }
        let Ok(relative) = path.strip_prefix(workspace_root) else {
            continue;
        };
        if should_ignore_relative_path(relative) {
            continue;
        }

        let metadata = std::fs::symlink_metadata(path)?;
        if !metadata.is_file() {
            continue;
        }
        if should_ignore_file(relative) {
            continue;
        }

        let relative_path = slash_path(relative);
        if relative_path.is_empty() {
            continue;
        }
        files.insert(
            relative_path,
            FileSnapshot {
                size: metadata.len(),
                modified_ms: metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis()),
                modified_at: metadata
                    .modified()
                    .ok()
                    .and_then(|time| OffsetDateTime::from(time).format(&Rfc3339).ok()),
            },
        );
    }

    Ok(WorkspaceSnapshot { files })
}

fn diff_snapshots(previous: &WorkspaceSnapshot, next: &WorkspaceSnapshot) -> Vec<WorkspaceChange> {
    let mut changes = Vec::new();

    for (path, previous_file) in &previous.files {
        match next.files.get(path) {
            Some(next_file) if next_file != previous_file => changes.push(WorkspaceChange {
                path: path.clone(),
                status: "modified",
            }),
            Some(_) => {}
            None => changes.push(WorkspaceChange {
                path: path.clone(),
                status: "deleted",
            }),
        }
    }

    for path in next.files.keys() {
        if previous.files.contains_key(path) {
            continue;
        }
        changes.push(WorkspaceChange {
            path: path.clone(),
            status: "added",
        });
    }

    changes.sort_by(|left, right| left.path.cmp(&right.path));
    changes
}

fn should_visit_entry(workspace_root: &Path, entry: &DirEntry) -> bool {
    if entry.path() == workspace_root {
        return true;
    }
    let Ok(relative) = entry.path().strip_prefix(workspace_root) else {
        return false;
    };
    !should_ignore_relative_path(relative)
}

fn should_ignore_relative_path(relative: &Path) -> bool {
    relative.components().any(|component| {
        let Component::Normal(name) = component else {
            return false;
        };
        let Some(name) = name.to_str() else {
            return false;
        };
        IGNORED_DIR_NAMES.iter().any(|ignored| *ignored == name)
    })
}

fn should_ignore_file(relative: &Path) -> bool {
    relative
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| {
            name.ends_with(".pyc")
                || name.ends_with(".pyo")
                || name.ends_with(".log")
                || name.ends_with(".tmp")
        })
        .unwrap_or(false)
}

fn slash_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

const IGNORED_DIR_NAMES: &[&str] = &[
    ".android-sdk",
    ".cache",
    ".gradle",
    ".mypy_cache",
    ".next",
    ".pytest_cache",
    ".ruff_cache",
    ".tmp",
    ".venv",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "target",
    "venv",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn first_scan_seeds_then_reports_added_modified_deleted_files() -> anyhow::Result<()> {
        let root = temp_workspace();
        std::fs::create_dir_all(&root)?;
        let tracker = WorkspaceChangeTracker::default();

        tracker.ensure_baseline("alice", &root).await?;
        std::fs::write(root.join("note.md"), "one")?;

        let event = tracker
            .scan_event("alice", &root)
            .await?
            .expect("added file event");
        assert_eq!(event["type"], "workspace_files_changed");
        assert_eq!(event["changes"][0]["path"], "note.md");
        assert_eq!(event["changes"][0]["status"], "added");
        assert_eq!(event["ripple_changed_files"]["files"][0]["path"], "note.md");
        assert_eq!(
            event["ripple_changed_files"]["files"][0]["additions"],
            Value::Null
        );

        std::fs::write(root.join("note.md"), "two longer")?;
        let event = tracker
            .scan_event("alice", &root)
            .await?
            .expect("modified file event");
        assert_eq!(event["changes"][0]["status"], "modified");

        std::fs::remove_file(root.join("note.md"))?;
        let event = tracker
            .scan_event("alice", &root)
            .await?
            .expect("deleted file event");
        assert_eq!(event["changes"][0]["status"], "deleted");

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn ignored_directories_do_not_emit_changes() -> anyhow::Result<()> {
        let root = temp_workspace();
        std::fs::create_dir_all(&root)?;
        let tracker = WorkspaceChangeTracker::default();

        tracker.ensure_baseline("alice", &root).await?;
        std::fs::create_dir_all(root.join(".tmp"))?;
        std::fs::write(root.join(".tmp/inspection.txt"), "noise")?;
        std::fs::create_dir_all(root.join("node_modules/pkg"))?;
        std::fs::write(root.join("node_modules/pkg/index.js"), "noise")?;

        assert!(tracker.scan_event("alice", &root).await?.is_none());

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    fn temp_workspace() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "ripple-workspace-changes-test-{}",
            uuid::Uuid::new_v4()
        ))
    }
}
