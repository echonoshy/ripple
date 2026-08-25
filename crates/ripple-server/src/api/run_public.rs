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
            json!(run_file_available(
                state,
                user_id,
                run.output_file.as_deref()
            )),
        );
        object.insert(
            "events_available".to_string(),
            json!(run.events_file.is_some()),
        );
    }
    sanitize_run_visible_value(state, user_id, run, &value)
}

fn run_file_available(state: &AppState, user_id: &str, path: Option<&str>) -> bool {
    let Some(path) = path else {
        return false;
    };
    let Ok(sandbox_dir) = state.sandboxes.sandbox_dir(user_id) else {
        return false;
    };
    let Ok(sandbox_dir) = sandbox_dir.canonicalize() else {
        return false;
    };
    let Ok(resolved) = Path::new(path).canonicalize() else {
        return false;
    };
    resolved.starts_with(&sandbox_dir) && resolved.is_file()
}

pub(crate) fn sanitize_user_visible_value(state: &AppState, user_id: &str, value: &Value) -> Value {
    let replacements = path_replacements(state, user_id);
    sanitize_value_with_replacements(value, &replacements)
}

pub(crate) fn sanitize_user_visible_text(state: &AppState, user_id: &str, text: &str) -> String {
    let replacements = path_replacements(state, user_id);
    sanitize_text_with_replacements(text, &replacements)
}

pub(crate) fn sanitize_run_visible_value(
    state: &AppState,
    user_id: &str,
    run: &AgentRunInfo,
    value: &Value,
) -> Value {
    let replacements = run_path_replacements(state, user_id, run);
    sanitize_value_with_replacements(value, &replacements)
}

pub(crate) fn sanitize_run_visible_text(
    state: &AppState,
    user_id: &str,
    run: &AgentRunInfo,
    text: &str,
) -> String {
    let replacements = run_path_replacements(state, user_id, run);
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
    let codex_home = state.config.codex_home_path();
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

fn run_path_replacements(
    state: &AppState,
    user_id: &str,
    run: &AgentRunInfo,
) -> Vec<(String, String)> {
    let mut replacements = path_replacements(state, user_id);
    push_shared_folder_run_replacements(&mut replacements, run);
    sort_replacements(&mut replacements);
    replacements
}

fn push_shared_folder_run_replacements(
    replacements: &mut Vec<(String, String)>,
    run: &AgentRunInfo,
) {
    let shared_folder_root = run
        .metadata
        .get("shared_folder_root")
        .and_then(Value::as_str);
    let shared_folders_root = run
        .metadata
        .get("shared_folders_root")
        .and_then(Value::as_str);
    let shared_folder_id = run.metadata.get("shared_folder_id").and_then(Value::as_str);
    if let (Some(root), Some(folder_id)) = (shared_folder_root, shared_folder_id) {
        let virtual_root = format!("/shared-folder/{folder_id}");
        push_path_replacements(
            replacements,
            Path::new(root),
            &format!("{virtual_root}/"),
            &virtual_root,
        );
        if let Ok(canonical) = Path::new(root).canonicalize() {
            push_path_replacements(
                replacements,
                &canonical,
                &format!("{virtual_root}/"),
                &virtual_root,
            );
        }
    }
    if let Some(root) = shared_folders_root {
        push_path_replacements(
            replacements,
            Path::new(root),
            "/shared-folder/",
            "/shared-folder",
        );
        if let Ok(canonical) = Path::new(root).canonicalize() {
            push_path_replacements(
                replacements,
                &canonical,
                "/shared-folder/",
                "/shared-folder",
            );
        }
    }
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

    #[test]
    fn shared_folder_run_paths_become_virtual_paths() {
        let run = AgentRunInfo {
            job_id: "job_1".to_string(),
            provider: "codex".to_string(),
            status: "completed".to_string(),
            output_file: None,
            events_file: None,
            created_at: String::new(),
            updated_at: String::new(),
            exit_code: Some(0),
            prompt_preview: None,
            sandbox_cwd: None,
            stdout_tail: String::new(),
            stderr_tail: String::new(),
            error: None,
            req_id: None,
            client_req_id: None,
            pending_approval: None,
            pending_user_input: None,
            metadata: json!({
                "shared_folders_root": "/mnt/private/shared",
                "shared_folder_root": "/mnt/private/shared/a-folder",
                "shared_folder_id": "a-folder",
            }),
        };
        let mut replacements = Vec::new();
        push_shared_folder_run_replacements(&mut replacements, &run);
        sort_replacements(&mut replacements);

        let sanitized = sanitize_text_with_replacements(
            "read /mnt/private/shared/a-folder/nested/report.pdf",
            &replacements,
        );

        assert_eq!(sanitized, "read /shared-folder/a-folder/nested/report.pdf");
        assert_eq!(
            sanitize_text_with_replacements("root /mnt/private/shared", &replacements),
            "root /shared-folder"
        );
    }
}
