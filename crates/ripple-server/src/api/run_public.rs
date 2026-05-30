use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::jobs::AgentRunInfo;
use crate::state::AppState;

pub(crate) fn public_run_value(state: &AppState, user_id: &str, run: &AgentRunInfo) -> Value {
    let mut value = serde_json::to_value(run).unwrap_or_else(|_| json!({}));
    if let Some(object) = value.as_object_mut() {
        object.insert("output_file".to_string(), Value::Null);
        object.insert("events_file".to_string(), Value::Null);
        object.insert(
            "output_available".to_string(),
            json!(run.output_file.is_some()),
        );
        object.insert(
            "events_available".to_string(),
            json!(run.events_file.is_some()),
        );
    }
    sanitize_user_visible_value(state, user_id, &value)
}

pub(crate) fn sanitize_user_visible_value(state: &AppState, user_id: &str, value: &Value) -> Value {
    let replacements = path_replacements(state, user_id);
    sanitize_value_with_replacements(value, &replacements)
}

pub(crate) fn sanitize_user_visible_text(state: &AppState, user_id: &str, text: &str) -> String {
    let replacements = path_replacements(state, user_id);
    sanitize_text_with_replacements(text, &replacements)
}

fn sanitize_value_with_replacements(value: &Value, replacements: &[(String, String)]) -> Value {
    match value {
        Value::String(text) => Value::String(sanitize_text_with_replacements(text, replacements)),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| sanitize_value_with_replacements(value, replacements))
                .collect(),
        ),
        Value::Object(object) => {
            let mut sanitized = Map::new();
            for (key, value) in object {
                sanitized.insert(
                    key.clone(),
                    sanitize_value_with_replacements(value, replacements),
                );
            }
            Value::Object(sanitized)
        }
        _ => value.clone(),
    }
}

fn sanitize_text_with_replacements(text: &str, replacements: &[(String, String)]) -> String {
    let mut out = text.to_string();
    for (from, to) in replacements {
        out = out.replace(from, to);
    }
    out
}

fn path_replacements(state: &AppState, user_id: &str) -> Vec<(String, String)> {
    let workspace_dir = state.sandboxes.workspace_dir(user_id).ok();
    let sandbox_dir = state.sandboxes.sandbox_dir(user_id).ok();
    let mut replacements =
        path_replacements_for_dirs(workspace_dir.as_deref(), sandbox_dir.as_deref());
    push_path_replacements(
        &mut replacements,
        &state.config.sandbox.caches_root,
        "/cache/",
        "/cache",
    );
    let codex_home = state
        .config
        .codex
        .codex_home
        .clone()
        .unwrap_or_else(|| state.config.repo_root.join(".ripple/codex-service-home"));
    push_path_replacements(
        &mut replacements,
        &codex_home,
        "/codex-home/",
        "/codex-home",
    );
    push_relative_runtime_replacements(&mut replacements, &state.config.repo_root, user_id);
    push_path_replacements(
        &mut replacements,
        &state.config.repo_root,
        "[host path redacted]/",
        "[host path redacted]",
    );
    if let Some(parent) = state.config.repo_root.parent() {
        push_path_replacements(
            &mut replacements,
            parent,
            "[host path redacted]/",
            "[host path redacted]",
        );
    }
    sort_replacements(&mut replacements);
    replacements
}

fn path_replacements_for_dirs(
    workspace_dir: Option<&Path>,
    sandbox_dir: Option<&Path>,
) -> Vec<(String, String)> {
    let mut replacements = Vec::new();
    if let Some(workspace_dir) = workspace_dir {
        push_path_replacements(&mut replacements, workspace_dir, "", "/workspace");
        if let Ok(canonical) = workspace_dir.canonicalize() {
            push_path_replacements(&mut replacements, &canonical, "", "/workspace");
        }
    }
    if let Some(sandbox_dir) = sandbox_dir {
        push_path_replacements(&mut replacements, sandbox_dir, "/sandbox/", "/sandbox");
        if let Ok(canonical) = sandbox_dir.canonicalize() {
            push_path_replacements(&mut replacements, &canonical, "/sandbox/", "/sandbox");
        }
    }
    sort_replacements(&mut replacements);
    replacements
}

fn sort_replacements(replacements: &mut Vec<(String, String)>) {
    replacements.sort_by(|left, right| right.0.len().cmp(&left.0.len()));
    replacements.dedup();
}

fn push_path_replacements(
    replacements: &mut Vec<(String, String)>,
    path: &Path,
    child_replacement: &str,
    exact_replacement: &str,
) {
    let path = slash_path(path);
    if path.is_empty() || path == "/" {
        return;
    }
    replacements.push((format!("{path}/"), child_replacement.to_string()));
    replacements.push((path, exact_replacement.to_string()));
}

fn push_literal_replacement(replacements: &mut Vec<(String, String)>, from: String, to: &str) {
    if !from.is_empty() {
        replacements.push((from, to.to_string()));
    }
}

fn push_relative_runtime_replacements(
    replacements: &mut Vec<(String, String)>,
    repo_root: &Path,
    user_id: &str,
) {
    let workspace = format!(".ripple/sandboxes/{user_id}/workspace/");
    let sandbox = format!(".ripple/sandboxes/{user_id}/");
    push_literal_replacement(replacements, workspace, "");
    push_literal_replacement(replacements, sandbox, "/sandbox/");
    push_literal_replacement(
        replacements,
        ".ripple/sandboxes-cache/".to_string(),
        "/cache/",
    );
    push_literal_replacement(
        replacements,
        ".ripple/codex-service-home/".to_string(),
        "/codex-home/",
    );
    if let Some(repo_name) = repo_root.file_name().and_then(|name| name.to_str()) {
        push_literal_replacement(
            replacements,
            format!("/{repo_name}/.ripple/sandboxes/{user_id}/workspace/"),
            "/",
        );
        push_literal_replacement(
            replacements,
            format!("/{repo_name}/.ripple/sandboxes/{user_id}/"),
            "/sandbox/",
        );
        push_literal_replacement(
            replacements,
            format!("/{repo_name}/.ripple/sandboxes-cache/"),
            "/cache/",
        );
        push_literal_replacement(
            replacements,
            format!("/{repo_name}/.ripple/codex-service-home/"),
            "/codex-home/",
        );
    }
}

fn slash_path(path: &Path) -> String {
    let path = PathBuf::from(path);
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_host_paths_become_workspace_relative_links() {
        let workspace = Path::new("/host/root/.ripple/sandboxes/lake/workspace");
        let sandbox = Path::new("/host/root/.ripple/sandboxes/lake");
        let replacements = path_replacements_for_dirs(Some(workspace), Some(sandbox));

        let text = "Saved [report](/host/root/.ripple/sandboxes/lake/workspace/outputs/report.md)";

        let sanitized = sanitize_text_with_replacements(text, &replacements);

        assert_eq!(sanitized, "Saved [report](outputs/report.md)");
        assert!(!sanitized.contains("/host/root"));
        assert!(!sanitized.contains(".ripple/sandboxes"));
    }

    #[test]
    fn non_workspace_sandbox_paths_are_kept_virtual() {
        let workspace = Path::new("/host/root/.ripple/sandboxes/lake/workspace");
        let sandbox = Path::new("/host/root/.ripple/sandboxes/lake");
        let replacements = path_replacements_for_dirs(Some(workspace), Some(sandbox));

        let text = "/host/root/.ripple/sandboxes/lake/agent-runs/external-agents/agent/output.txt";

        let sanitized = sanitize_text_with_replacements(text, &replacements);

        assert_eq!(
            sanitized,
            "/sandbox/agent-runs/external-agents/agent/output.txt"
        );
        assert!(!sanitized.contains("/host/root"));
    }

    #[test]
    fn relative_runtime_paths_are_hidden() {
        let mut replacements = Vec::new();
        push_relative_runtime_replacements(
            &mut replacements,
            Path::new("/home/lake/ripple"),
            "lake",
        );
        sort_replacements(&mut replacements);

        let text = "diff --git a/.ripple/sandboxes/lake/workspace/outputs/report.md b/ripple/.ripple/sandboxes/lake/workspace/outputs/report.md";

        let sanitized = sanitize_text_with_replacements(text, &replacements);

        assert!(sanitized.contains("a/outputs/report.md"));
        assert!(sanitized.contains("b/outputs/report.md"));
        assert!(!sanitized.contains(".ripple/sandboxes"));
    }

    #[test]
    fn repo_parent_prefix_is_redacted_for_split_path_fragments() {
        let mut replacements = Vec::new();
        push_path_replacements(
            &mut replacements,
            Path::new("/home/lake/workspace"),
            "[host path redacted]/",
            "[host path redacted]",
        );
        sort_replacements(&mut replacements);

        let sanitized = sanitize_text_with_replacements("](/home/lake/workspace", &replacements);

        assert_eq!(sanitized, "]([host path redacted]");
    }
}
