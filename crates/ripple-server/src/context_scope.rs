use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use crate::workspace as ws;

const MAX_LINKED_ROOTS: usize = 512;
const MAX_DIRECT_ROOTS: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkedContextRoot {
    pub logical_path: String,
    pub workspace_path: String,
    pub canonical_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct ContextScope {
    pub context_root: PathBuf,
    pub context_root_workspace_path: String,
    pub direct_roots: Vec<PathBuf>,
    pub linked_roots: Vec<LinkedContextRoot>,
    pub discovered_link_count: usize,
    pub rejected_link_count: usize,
}

impl ContextScope {
    pub fn context_root_read_only(&self) -> bool {
        !self.linked_roots.is_empty()
    }
}

pub fn resolve_context_scope(
    workspace_root: &Path,
    context_root: &Path,
) -> anyhow::Result<ContextScope> {
    let workspace_root = workspace_root.canonicalize()?;
    let context_root = context_root.canonicalize()?;
    if !context_root.starts_with(&workspace_root) || !context_root.is_dir() {
        anyhow::bail!("Context root must be a directory inside the user workspace");
    }

    let context_root_workspace_path = ws::workspace_path(&workspace_root, &context_root)?;
    let mut scope = ContextScope {
        context_root: context_root.clone(),
        context_root_workspace_path,
        direct_roots: Vec::new(),
        linked_roots: Vec::new(),
        discovered_link_count: 0,
        rejected_link_count: 0,
    };
    if context_root == workspace_root {
        return Ok(scope);
    }

    let mut entries = std::fs::read_dir(&context_root)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    entries.sort();
    let mut seen_targets = HashSet::new();

    for entry_path in entries {
        let Ok(metadata) = std::fs::symlink_metadata(&entry_path) else {
            continue;
        };
        if !metadata.file_type().is_symlink() {
            if metadata.is_dir()
                && !is_hidden_entry(&entry_path)
                && scope.direct_roots.len() < MAX_DIRECT_ROOTS
            {
                if let Ok(canonical_path) = entry_path.canonicalize() {
                    if canonical_path.starts_with(&context_root) {
                        scope.direct_roots.push(canonical_path);
                    }
                }
            }
            continue;
        }
        scope.discovered_link_count = scope.discovered_link_count.saturating_add(1);
        if scope.linked_roots.len() >= MAX_LINKED_ROOTS {
            scope.rejected_link_count = scope.rejected_link_count.saturating_add(1);
            continue;
        }

        let Some(linked_root) = resolve_linked_root(
            &workspace_root,
            &context_root,
            &scope.context_root_workspace_path,
            &entry_path,
        ) else {
            scope.rejected_link_count = scope.rejected_link_count.saturating_add(1);
            continue;
        };
        if seen_targets.insert(linked_root.canonical_path.clone()) {
            scope.linked_roots.push(linked_root);
        }
    }

    Ok(scope)
}

fn is_hidden_entry(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name.to_string_lossy().starts_with('.'))
}

fn resolve_linked_root(
    workspace_root: &Path,
    context_root: &Path,
    context_root_workspace_path: &str,
    entry_path: &Path,
) -> Option<LinkedContextRoot> {
    let target = entry_path.canonicalize().ok()?;
    if !target.is_dir()
        || !target.starts_with(workspace_root)
        || target.starts_with(context_root)
        || context_root.starts_with(&target)
        || is_hidden_top_level_target(workspace_root, &target)
    {
        return None;
    }

    let workspace_path = ws::workspace_path(workspace_root, &target).ok()?;
    let validated = ws::validate_existing_path(&workspace_path, workspace_root).ok()?;
    if validated != target {
        return None;
    }
    let name = entry_path.file_name()?.to_string_lossy();
    let logical_path = format!(
        "{}/{}",
        context_root_workspace_path.trim_end_matches('/'),
        name
    );
    Some(LinkedContextRoot {
        logical_path,
        workspace_path,
        canonical_path: target,
    })
}

fn is_hidden_top_level_target(workspace_root: &Path, target: &Path) -> bool {
    let Ok(relative) = target.strip_prefix(workspace_root) else {
        return true;
    };
    let Some(Component::Normal(first)) = relative.components().next() else {
        return true;
    };
    first.to_string_lossy().starts_with('.')
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[cfg(unix)]
    #[test]
    fn resolves_only_direct_directory_links_inside_workspace() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("ripple-context-scope-{}", Uuid::new_v4()));
        let space = root.join("space");
        let record = root.join("record");
        let hidden = root.join(".codex");
        let outside = std::env::temp_dir().join(format!("ripple-outside-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&space)?;
        std::fs::create_dir_all(&record)?;
        std::fs::create_dir_all(&hidden)?;
        std::fs::create_dir_all(&outside)?;
        std::os::unix::fs::symlink(&record, space.join("record"))?;
        std::os::unix::fs::symlink(&hidden, space.join("hidden"))?;
        std::os::unix::fs::symlink(&outside, space.join("outside"))?;

        let scope = resolve_context_scope(&root, &space)?;

        assert_eq!(scope.discovered_link_count, 3);
        assert_eq!(scope.rejected_link_count, 2);
        assert_eq!(scope.linked_roots.len(), 1);
        assert_eq!(
            scope.linked_roots[0].logical_path,
            "/workspace/space/record"
        );
        assert_eq!(scope.linked_roots[0].workspace_path, "/workspace/record");

        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn resolves_direct_and_linked_roots_in_mixed_context() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("ripple-context-scope-{}", Uuid::new_v4()));
        let space = root.join("space");
        let direct_record = space.join("direct-record");
        let linked_record = root.join("linked-record");
        std::fs::create_dir_all(&direct_record)?;
        std::fs::create_dir_all(&linked_record)?;
        std::fs::create_dir_all(space.join(".internal"))?;
        std::os::unix::fs::symlink(&linked_record, space.join("linked-record"))?;

        let scope = resolve_context_scope(&root, &space)?;

        assert!(scope.context_root_read_only());
        assert_eq!(scope.direct_roots, vec![direct_record.canonicalize()?]);
        assert_eq!(scope.linked_roots.len(), 1);
        assert_eq!(scope.linked_roots[0].canonical_path, linked_record);

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }
}
