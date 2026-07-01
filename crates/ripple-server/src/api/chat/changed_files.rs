use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Component, Path};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

const MAX_TEXT_BYTES: u64 = 512 * 1024;
const MAX_EXACT_DIFF_LINES: usize = 2_000;
const IGNORED_TOP_LEVEL_DIRS: &[&str] = &[
    ".agents",
    ".codex",
    ".git",
    ".gradle",
    ".ripple",
    ".superpowers",
    "build",
    "dist",
    "node_modules",
    "target",
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ChangedFile {
    pub path: String,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub previous_path: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct WorkspaceSnapshot {
    files: BTreeMap<String, FileSnapshot>,
}

#[derive(Clone, Debug)]
struct FileSnapshot {
    digest: String,
    size: u64,
    lines: Option<Vec<String>>,
}

#[derive(Default)]
struct DiffFileBuilder {
    path: String,
    previous_path: Option<String>,
    status: Option<&'static str>,
    additions: u32,
    deletions: u32,
}

pub(crate) fn snapshot_workspace(workspace_root: &Path) -> anyhow::Result<WorkspaceSnapshot> {
    let mut snapshot = WorkspaceSnapshot::default();
    for entry in WalkDir::new(workspace_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| should_include_entry(workspace_root, entry.path()))
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if !entry.file_type().is_file() || entry.file_type().is_symlink() {
            continue;
        }
        let Ok(relative_path) = relative_workspace_path(workspace_root, path) else {
            continue;
        };
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let digest = digest_file(path)?;
        let lines = if metadata.len() <= MAX_TEXT_BYTES {
            std::fs::read(path)
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .map(|text| text.lines().map(str::to_string).collect())
        } else {
            None
        };
        snapshot.files.insert(
            relative_path,
            FileSnapshot {
                digest,
                size: metadata.len(),
                lines,
            },
        );
    }
    Ok(snapshot)
}

pub(crate) fn changed_files_from_workspace_snapshots(
    before: &WorkspaceSnapshot,
    after: &WorkspaceSnapshot,
) -> Vec<ChangedFile> {
    let mut changed = Vec::new();

    for (path, before_file) in &before.files {
        match after.files.get(path) {
            Some(after_file)
                if before_file.digest == after_file.digest
                    && before_file.size == after_file.size => {}
            Some(after_file) => {
                let (additions, deletions) =
                    line_change_counts(before_file.lines.as_deref(), after_file.lines.as_deref());
                changed.push(ChangedFile {
                    path: path.clone(),
                    status: "modified".to_string(),
                    additions,
                    deletions,
                    previous_path: None,
                });
            }
            None => changed.push(ChangedFile {
                path: path.clone(),
                status: "deleted".to_string(),
                additions: 0,
                deletions: before_file
                    .lines
                    .as_ref()
                    .map(|lines| lines.len().try_into().unwrap_or(u32::MAX))
                    .unwrap_or(0),
                previous_path: None,
            }),
        }
    }

    for (path, after_file) in &after.files {
        if before.files.contains_key(path) {
            continue;
        }
        changed.push(ChangedFile {
            path: path.clone(),
            status: "added".to_string(),
            additions: after_file
                .lines
                .as_ref()
                .map(|lines| lines.len().try_into().unwrap_or(u32::MAX))
                .unwrap_or(0),
            deletions: 0,
            previous_path: None,
        });
    }

    changed.sort_by(|left, right| left.path.cmp(&right.path));
    changed
}

pub(crate) fn changed_files_from_runtime_events(events: &[Value]) -> Vec<ChangedFile> {
    let mut changed = Vec::new();
    for event in events {
        if event.get("type").and_then(Value::as_str) != Some("codex_turn_diff_updated") {
            continue;
        }
        let Some(diff) = event.get("diff").and_then(Value::as_str) else {
            continue;
        };
        changed.extend(changed_files_from_unified_diff(diff));
    }
    merge_changed_files(Vec::new(), changed)
}

pub(crate) fn merge_changed_files(
    fallback: Vec<ChangedFile>,
    preferred: Vec<ChangedFile>,
) -> Vec<ChangedFile> {
    let mut by_path = BTreeMap::<String, ChangedFile>::new();
    for file in fallback.into_iter().chain(preferred) {
        if file.path.trim().is_empty() {
            continue;
        }
        by_path.insert(file.path.clone(), file);
    }
    by_path.into_values().collect()
}

pub(crate) fn changed_files_payload(changed_files: &[ChangedFile]) -> Value {
    json!({
        "files": changed_file_values(changed_files)
    })
}

pub(crate) fn changed_files_message_block(changed_files: &[ChangedFile]) -> Option<Value> {
    if changed_files.is_empty() {
        return None;
    }
    Some(json!({
        "type": "changed_files",
        "files": changed_file_values(changed_files)
    }))
}

fn changed_file_values(changed_files: &[ChangedFile]) -> Vec<Value> {
    changed_files
        .iter()
        .filter(|file| !file.path.trim().is_empty())
        .map(|file| {
            let mut value = json!({
                "path": file.path,
                "status": file.status,
                "additions": file.additions,
                "deletions": file.deletions
            });
            if let Some(previous_path) = file
                .previous_path
                .as_deref()
                .map(str::trim)
                .filter(|path| !path.is_empty())
            {
                value["previous_path"] = json!(previous_path);
            }
            value
        })
        .collect()
}

fn changed_files_from_unified_diff(diff: &str) -> Vec<ChangedFile> {
    let mut changed = Vec::new();
    let mut current: Option<DiffFileBuilder> = None;

    for line in diff.lines() {
        if line.starts_with("diff --git ") {
            push_diff_file(&mut changed, current.take());
            let (previous_path, path) = parse_diff_header(line);
            current = Some(DiffFileBuilder {
                path,
                previous_path,
                status: None,
                additions: 0,
                deletions: 0,
            });
            continue;
        }

        let Some(file) = current.as_mut() else {
            continue;
        };
        if line.starts_with("new file mode") {
            file.status = Some("added");
        } else if line.starts_with("deleted file mode") {
            file.status = Some("deleted");
        } else if let Some(path) = line.strip_prefix("rename from ") {
            file.previous_path = normalize_changed_path(path);
            file.status = Some("renamed");
        } else if let Some(path) = line.strip_prefix("rename to ") {
            if let Some(path) = normalize_changed_path(path) {
                file.path = path;
            }
            file.status = Some("renamed");
        } else if let Some(path) = line.strip_prefix("--- ") {
            if path.trim() == "/dev/null" {
                file.status = Some("added");
            }
        } else if let Some(path) = line.strip_prefix("+++ ") {
            if path.trim() == "/dev/null" {
                file.status = Some("deleted");
            } else if let Some(path) = normalize_changed_path(path) {
                file.path = path;
            }
        } else if line.starts_with('+') && !line.starts_with("+++") {
            file.additions = file.additions.saturating_add(1);
        } else if line.starts_with('-') && !line.starts_with("---") {
            file.deletions = file.deletions.saturating_add(1);
        }
    }

    push_diff_file(&mut changed, current);
    changed
}

fn push_diff_file(changed: &mut Vec<ChangedFile>, file: Option<DiffFileBuilder>) {
    let Some(file) = file else {
        return;
    };
    if file.path.trim().is_empty() {
        return;
    }
    changed.push(ChangedFile {
        path: file.path,
        status: file.status.unwrap_or("modified").to_string(),
        additions: file.additions,
        deletions: file.deletions,
        previous_path: file.previous_path,
    });
}

fn parse_diff_header(line: &str) -> (Option<String>, String) {
    let mut parts = line.split_whitespace();
    let _ = parts.next();
    let _ = parts.next();
    let previous_path = parts.next().and_then(normalize_changed_path);
    let path = parts
        .next()
        .and_then(normalize_changed_path)
        .or_else(|| previous_path.clone())
        .unwrap_or_default();
    (previous_path, path)
}

fn normalize_changed_path(raw: &str) -> Option<String> {
    let mut path = raw.trim().trim_matches('"').replace('\\', "/");
    if path == "/dev/null" || path.is_empty() {
        return None;
    }
    for prefix in ["a/", "b/", "./", "/workspace/"] {
        if let Some(stripped) = path.strip_prefix(prefix) {
            path = stripped.to_string();
        }
    }
    if let Some((_, tail)) = path.split_once("/workspace/") {
        path = tail.to_string();
    }
    let path = path.trim_start_matches('/').trim().to_string();
    (!path.is_empty()).then_some(path)
}

fn should_include_entry(workspace_root: &Path, path: &Path) -> bool {
    if path == workspace_root {
        return true;
    }
    let Ok(relative) = path.strip_prefix(workspace_root) else {
        return false;
    };
    let Some(Component::Normal(first)) = relative.components().next() else {
        return true;
    };
    let first = first.to_string_lossy();
    !IGNORED_TOP_LEVEL_DIRS
        .iter()
        .any(|ignored| *ignored == first)
}

fn relative_workspace_path(workspace_root: &Path, path: &Path) -> anyhow::Result<String> {
    let relative = path.strip_prefix(workspace_root)?;
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

fn digest_file(path: &Path) -> anyhow::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn line_change_counts(before: Option<&[String]>, after: Option<&[String]>) -> (u32, u32) {
    let (Some(before), Some(after)) = (before, after) else {
        return (0, 0);
    };
    if before.len().saturating_mul(after.len()) > MAX_EXACT_DIFF_LINES * MAX_EXACT_DIFF_LINES {
        return line_count_delta(before.len(), after.len());
    }
    let common = longest_common_subsequence_len(before, after);
    (
        after
            .len()
            .saturating_sub(common)
            .try_into()
            .unwrap_or(u32::MAX),
        before
            .len()
            .saturating_sub(common)
            .try_into()
            .unwrap_or(u32::MAX),
    )
}

fn line_count_delta(before_len: usize, after_len: usize) -> (u32, u32) {
    (
        after_len
            .saturating_sub(before_len)
            .try_into()
            .unwrap_or(u32::MAX),
        before_len
            .saturating_sub(after_len)
            .try_into()
            .unwrap_or(u32::MAX),
    )
}

fn longest_common_subsequence_len(left: &[String], right: &[String]) -> usize {
    let mut previous = vec![0_usize; right.len() + 1];
    let mut current = vec![0_usize; right.len() + 1];
    for left_line in left {
        for (index, right_line) in right.iter().enumerate() {
            current[index + 1] = if left_line == right_line {
                previous[index] + 1
            } else {
                current[index].max(previous[index + 1])
            };
        }
        std::mem::swap(&mut previous, &mut current);
        current.fill(0);
    }
    previous[right.len()]
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use uuid::Uuid;

    use super::*;

    #[test]
    fn runtime_diff_events_become_structured_changed_files_without_patch() {
        let diff = [
            "diff --git a/app/src/App.tsx b/app/src/App.tsx",
            "index 1111111..2222222 100644",
            "--- a/app/src/App.tsx",
            "+++ b/app/src/App.tsx",
            "@@ -1,2 +1,3 @@",
            " keep",
            "-old",
            "+new",
            "+extra",
            "diff --git a/docs/new.md b/docs/new.md",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/docs/new.md",
            "@@ -0,0 +1,2 @@",
            "+hello",
            "+world",
        ]
        .join("\n");

        let changed = changed_files_from_runtime_events(&[json!({
            "type": "codex_turn_diff_updated",
            "diff": diff
        })]);

        assert_eq!(changed.len(), 2);
        assert_eq!(changed[0].path, "app/src/App.tsx");
        assert_eq!(changed[0].status, "modified");
        assert_eq!(changed[0].additions, 2);
        assert_eq!(changed[0].deletions, 1);
        assert_eq!(changed[1].path, "docs/new.md");
        assert_eq!(changed[1].status, "added");
        assert_eq!(changed[1].additions, 2);
        assert_eq!(changed[1].deletions, 0);
        assert!(changed_files_payload(&changed)
            .to_string()
            .find("patch")
            .is_none());
    }

    #[test]
    fn workspace_snapshots_detect_file_changes_without_patch() {
        let root = std::env::temp_dir().join(format!("ripple-changed-files-{}", Uuid::new_v4()));
        std::fs::create_dir_all(root.join("docs")).expect("create docs dir");
        std::fs::write(root.join("existing.md"), "before\n").expect("write existing file");
        std::fs::write(root.join("docs/remove.md"), "remove\n").expect("write removed file");

        let before = snapshot_workspace(&root).expect("before snapshot");
        std::fs::write(root.join("existing.md"), "before\nafter\n").expect("modify file");
        std::fs::write(root.join("docs/new.md"), "hello\n").expect("add file");
        std::fs::remove_file(root.join("docs/remove.md")).expect("remove file");
        let after = snapshot_workspace(&root).expect("after snapshot");

        let changed = changed_files_from_workspace_snapshots(&before, &after);
        let payload = changed_files_payload(&changed);

        assert_eq!(payload["files"].as_array().expect("files").len(), 3);
        assert!(payload.to_string().find("patch").is_none());
        assert!(changed.iter().any(|file| {
            file.path == "existing.md" && file.status == "modified" && file.additions == 1
        }));
        assert!(changed
            .iter()
            .any(|file| file.path == "docs/new.md" && file.status == "added"));
        assert!(changed
            .iter()
            .any(|file| file.path == "docs/remove.md" && file.status == "deleted"));

        let _ = std::fs::remove_dir_all(root);
    }
}
