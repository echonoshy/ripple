use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::api::{require_confirm, ApiError};
use crate::redaction::redact_text;
use crate::sandbox::SandboxManager;
use crate::state::AppState;
use crate::user::user_id_from_headers;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
pub struct MemorySettings {
    pub use_memories: bool,
    pub generate_memories: bool,
}

impl Default for MemorySettings {
    fn default() -> Self {
        Self {
            use_memories: true,
            generate_memories: true,
        }
    }
}

impl MemorySettings {
    pub fn enabled(self) -> bool {
        self.use_memories || self.generate_memories
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct MemorySettingsPatch {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub use_memories: Option<bool>,
    #[serde(default)]
    pub generate_memories: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct MemoryStatus {
    pub enabled: bool,
    pub use_memories: bool,
    pub generate_memories: bool,
    pub dedicated_tools: bool,
    pub disable_on_external_context: bool,
    pub summary_available: bool,
    pub last_updated_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct MemorySummary {
    pub summary_available: bool,
    pub memory_summary: Option<String>,
    pub memory: Option<String>,
    pub last_updated_at: Option<String>,
}

pub async fn memory_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<MemoryStatus>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    let settings = load_memory_settings(&state.sandboxes, &user_id).await?;
    let summary = read_memory_summary(&state.sandboxes, &user_id).await?;
    Ok(Json(MemoryStatus {
        enabled: settings.enabled(),
        use_memories: settings.use_memories,
        generate_memories: settings.generate_memories,
        dedicated_tools: false,
        disable_on_external_context: false,
        summary_available: summary.summary_available,
        last_updated_at: summary.last_updated_at,
    }))
}

pub async fn memory_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<MemorySummary>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    Ok(Json(read_memory_summary(&state.sandboxes, &user_id).await?))
}

pub async fn update_memory_settings_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(patch): Json<MemorySettingsPatch>,
) -> Result<Json<MemoryStatus>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    let settings = update_memory_settings(&state.sandboxes, &user_id, patch).await?;
    let summary = read_memory_summary(&state.sandboxes, &user_id).await?;
    Ok(Json(MemoryStatus {
        enabled: settings.enabled(),
        use_memories: settings.use_memories,
        generate_memories: settings.generate_memories,
        dedicated_tools: false,
        disable_on_external_context: false,
        summary_available: summary.summary_available,
        last_updated_at: summary.last_updated_at,
    }))
}

pub async fn reset_memory(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Option<Json<Value>>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    require_confirm(payload.as_ref().map(|value| &value.0), "memory reset")?;
    let workspace_root = state.sandboxes.ensure_sandbox(&user_id)?;
    let cancelled_runs = state.jobs.stop_user(&user_id).await?;
    state
        .jobs
        .reset_memory(user_id.clone(), workspace_root)
        .await
        .map_err(|err| ApiError::new(StatusCode::BAD_GATEWAY, err.to_string()))?;
    Ok(Json(json!({
        "ok": true,
        "user_id": user_id,
        "cancelled_run_count": cancelled_runs.len()
    })))
}

pub async fn load_memory_settings(
    sandboxes: &SandboxManager,
    user_id: &str,
) -> anyhow::Result<MemorySettings> {
    let path = memory_settings_file(sandboxes, user_id)?;
    match tokio::fs::read(&path).await {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(MemorySettings::default()),
        Err(err) => Err(err.into()),
    }
}

pub async fn update_memory_settings(
    sandboxes: &SandboxManager,
    user_id: &str,
    patch: MemorySettingsPatch,
) -> anyhow::Result<MemorySettings> {
    let mut settings = load_memory_settings(sandboxes, user_id).await?;
    if let Some(enabled) = patch.enabled {
        settings.use_memories = enabled;
        settings.generate_memories = enabled;
    }
    if let Some(use_memories) = patch.use_memories {
        settings.use_memories = use_memories;
    }
    if let Some(generate_memories) = patch.generate_memories {
        settings.generate_memories = generate_memories;
    }
    save_memory_settings(sandboxes, user_id, settings).await?;
    Ok(settings)
}

pub async fn save_memory_settings(
    sandboxes: &SandboxManager,
    user_id: &str,
    settings: MemorySettings,
) -> anyhow::Result<()> {
    let path = memory_settings_file(sandboxes, user_id)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(path, serde_json::to_vec_pretty(&settings)?).await?;
    Ok(())
}

pub async fn read_memory_summary(
    sandboxes: &SandboxManager,
    user_id: &str,
) -> anyhow::Result<MemorySummary> {
    let memory_root = sandboxes.codex_home_dir(user_id)?.join("memories");
    let memory_summary_path = memory_root.join("memory_summary.md");
    let memory_path = memory_root.join("MEMORY.md");
    let memory_summary = read_redacted_file(&memory_summary_path).await?;
    let memory = read_redacted_file(&memory_path).await?;
    if is_empty_bootstrap_memory_repository(&memory_root, &memory_summary, &memory).await? {
        return Ok(MemorySummary {
            summary_available: false,
            memory_summary: None,
            memory: None,
            last_updated_at: None,
        });
    }
    let last_updated_at = newest_modified_time(&[&memory_summary_path, &memory_path]).await;
    Ok(MemorySummary {
        summary_available: memory_summary.is_some() || memory.is_some(),
        memory_summary,
        memory,
        last_updated_at,
    })
}

async fn is_empty_bootstrap_memory_repository(
    memory_root: &std::path::Path,
    memory_summary: &Option<String>,
    memory: &Option<String>,
) -> anyhow::Result<bool> {
    let raw_memories_path = memory_root.join("raw_memories.md");
    let raw_memories = match tokio::fs::read_to_string(&raw_memories_path).await {
        Ok(contents) => contents,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(err.into()),
    };
    if !raw_memories_are_empty(&raw_memories) {
        return Ok(false);
    }
    if has_rollout_summary_files(&memory_root.join("rollout_summaries")).await? {
        return Ok(false);
    }
    Ok(memory_summary
        .as_deref()
        .into_iter()
        .chain(memory.as_deref())
        .any(looks_like_empty_bootstrap_memory))
}

fn raw_memories_are_empty(contents: &str) -> bool {
    let meaningful = contents
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| *line != "# Raw Memories")
        .collect::<Vec<_>>();
    meaningful == ["No raw memories yet."]
}

async fn has_rollout_summary_files(path: &std::path::Path) -> anyhow::Result<bool> {
    let mut entries = match tokio::fs::read_dir(path).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(err.into()),
    };
    while let Some(entry) = entries.next_entry().await? {
        if entry.file_type().await?.is_file() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn looks_like_empty_bootstrap_memory(contents: &str) -> bool {
    contents.contains("No durable user profile has been established")
        || contents.contains("Memory repository bootstrap state")
        || contents.contains("empty input set")
}

fn memory_settings_file(
    sandboxes: &SandboxManager,
    user_id: &str,
) -> anyhow::Result<std::path::PathBuf> {
    Ok(sandboxes.sandbox_dir(user_id)?.join("memory-settings.json"))
}

async fn read_redacted_file(path: &std::path::Path) -> anyhow::Result<Option<String>> {
    match tokio::fs::read_to_string(path).await {
        Ok(contents) => Ok(Some(redact_text(&contents))),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

async fn newest_modified_time(paths: &[&std::path::Path]) -> Option<String> {
    let mut newest: Option<SystemTime> = None;
    for path in paths {
        let Ok(metadata) = tokio::fs::metadata(path).await else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if newest.map_or(true, |current| modified > current) {
            newest = Some(modified);
        }
    }
    newest.and_then(system_time_to_iso)
}

fn system_time_to_iso(time: SystemTime) -> Option<String> {
    let duration = time.duration_since(UNIX_EPOCH).ok()?;
    let datetime = OffsetDateTime::from_unix_timestamp(duration.as_secs() as i64).ok()?;
    datetime.format(&Rfc3339).ok()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::Path;
    use std::sync::Arc;

    use super::*;
    use crate::config::{
        AppConfig, CodexConfig, CorsConfig, FeishuConfig, GogcliOAuthConfig, LoggingConfig,
        SandboxConfig, SecurityConfig, SkillsConfig,
    };
    use crate::sandbox::SandboxManager;

    #[tokio::test]
    async fn memory_settings_default_to_using_and_generating_memories() {
        let root =
            std::env::temp_dir().join(format!("ripple-memory-test-{}", uuid::Uuid::new_v4()));
        let sandboxes = SandboxManager::new(test_config(&root));

        let settings = load_memory_settings(&sandboxes, "alice").await.unwrap();

        assert!(settings.use_memories);
        assert!(settings.generate_memories);
        assert!(settings.enabled());

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn memory_settings_patch_enabled_and_specific_fields() {
        let root =
            std::env::temp_dir().join(format!("ripple-memory-test-{}", uuid::Uuid::new_v4()));
        let sandboxes = SandboxManager::new(test_config(&root));
        let patch = MemorySettingsPatch {
            enabled: Some(false),
            use_memories: Some(true),
            generate_memories: None,
        };

        let settings = update_memory_settings(&sandboxes, "alice", patch)
            .await
            .unwrap();
        let reloaded = load_memory_settings(&sandboxes, "alice").await.unwrap();

        assert!(settings.use_memories);
        assert!(!settings.generate_memories);
        assert_eq!(reloaded, settings);

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn memory_summary_reads_only_current_user_root() {
        let root =
            std::env::temp_dir().join(format!("ripple-memory-test-{}", uuid::Uuid::new_v4()));
        let sandboxes = SandboxManager::new(test_config(&root));
        let alice_memories = sandboxes.codex_home_dir("alice").unwrap().join("memories");
        let bob_memories = sandboxes.codex_home_dir("bob").unwrap().join("memories");
        std::fs::create_dir_all(&alice_memories).unwrap();
        std::fs::create_dir_all(&bob_memories).unwrap();
        std::fs::write(alice_memories.join("memory_summary.md"), "alice project").unwrap();
        std::fs::write(bob_memories.join("memory_summary.md"), "bob secret").unwrap();

        let summary = read_memory_summary(&sandboxes, "alice").await.unwrap();

        assert_eq!(summary.memory_summary.as_deref(), Some("alice project"));
        assert_ne!(summary.memory_summary.as_deref(), Some("bob secret"));
        assert!(summary.summary_available);

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn memory_summary_ignores_empty_bootstrap_repository() {
        let root =
            std::env::temp_dir().join(format!("ripple-memory-test-{}", uuid::Uuid::new_v4()));
        let sandboxes = SandboxManager::new(test_config(&root));
        let memories = sandboxes.codex_home_dir("alice").unwrap().join("memories");
        std::fs::create_dir_all(&memories).unwrap();
        std::fs::write(
            memories.join("raw_memories.md"),
            "# Raw Memories\n\nNo raw memories yet.\n",
        )
        .unwrap();
        std::fs::write(
            memories.join("memory_summary.md"),
            "## User Profile\n\nNo durable user profile has been established in this memory repository yet.",
        )
        .unwrap();
        std::fs::write(
            memories.join("MEMORY.md"),
            "# Task Group: Memory repository bootstrap state\n\nempty input set",
        )
        .unwrap();

        let summary = read_memory_summary(&sandboxes, "alice").await.unwrap();

        assert!(!summary.summary_available);
        assert!(summary.memory_summary.is_none());
        assert!(summary.memory.is_none());
        assert!(summary.last_updated_at.is_none());

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn memory_summary_keeps_bootstrap_text_when_rollout_evidence_exists() {
        let root =
            std::env::temp_dir().join(format!("ripple-memory-test-{}", uuid::Uuid::new_v4()));
        let sandboxes = SandboxManager::new(test_config(&root));
        let memories = sandboxes.codex_home_dir("alice").unwrap().join("memories");
        let rollout_summaries = memories.join("rollout_summaries");
        std::fs::create_dir_all(&rollout_summaries).unwrap();
        std::fs::write(
            memories.join("raw_memories.md"),
            "# Raw Memories\n\nNo raw memories yet.\n",
        )
        .unwrap();
        std::fs::write(
            memories.join("memory_summary.md"),
            "Memory repository bootstrap state, but backed by rollout evidence.",
        )
        .unwrap();
        std::fs::write(rollout_summaries.join("rollout-1.md"), "real evidence").unwrap();

        let summary = read_memory_summary(&sandboxes, "alice").await.unwrap();

        assert!(summary.summary_available);
        assert!(summary
            .memory_summary
            .as_deref()
            .unwrap_or_default()
            .contains("backed by rollout evidence"));

        let _ = std::fs::remove_dir_all(root);
    }

    fn test_config(root: &Path) -> Arc<AppConfig> {
        Arc::new(AppConfig {
            repo_root: root.to_path_buf(),
            host: "127.0.0.1".to_string(),
            port: 8810,
            api_keys: Vec::new(),
            security: SecurityConfig::default(),
            user_auth: crate::config::UserAuthConfig::default(),
            api_docs: crate::config::ApiDocsConfig::default(),
            cors: CorsConfig::default(),
            default_model: "codex-medium".to_string(),
            model_presets: BTreeMap::new(),
            logging: LoggingConfig {
                level: "debug".to_string(),
            },
            sandbox: SandboxConfig {
                sandboxes_root: root.join("sandboxes"),
                caches_root: root.join("cache"),
                idle_suspend_seconds: 1800,
                retention_seconds: 604_800,
                max_workspace_mb: 2048,
                tmpfs_size_mb: 512,
                nsjail_path: "nsjail".to_string(),
                python_envs_root: root.join("cache/python-envs"),
                python_env_uv_cache: root.join("cache/uv-cache"),
                python_env_max_packages: 20,
                uv_bin_dir: None,
                node_dir: None,
                lark_cli_install_root: None,
                notion_cli_install_root: None,
                gogcli_cli_install_root: None,
                cli_tools: Vec::new(),
                pypi_mirror_url: None,
                npm_registry_url: None,
            },
            codex: CodexConfig {
                enabled: true,
                codex_executable: "codex".to_string(),
                app_server_args: vec![
                    "app-server".to_string(),
                    "--listen".to_string(),
                    "stdio://".to_string(),
                ],
                codex_home: Some(root.join(".ripple/codex-service-home")),
                approval_policy: "never".to_string(),
                sandbox_type: "workspace-write".to_string(),
                network_access: true,
                idle_timeout_seconds: 1800,
                max_runtime_seconds: 3600,
            },
            schedule_extraction_max_runtime_seconds: 120,
            schedule_poll_interval_seconds: 15,
            document_preview: crate::config::DocumentPreviewConfig {
                cache_root: root.join("cache/previews"),
                libreoffice_path: "soffice".to_string(),
                max_source_bytes: 64 * 1024 * 1024,
                conversion_timeout_seconds: 120,
            },
            skills: SkillsConfig {
                shared_dirs: vec!["skills/*".to_string()],
            },
            public_base_url: None,
            feishu: FeishuConfig::default(),
            gogcli_oauth: GogcliOAuthConfig {
                auto_register_client: true,
                auto_from_request: true,
                callback_url: None,
                client_secret_json: None,
                client: None,
            },
        })
    }
}
