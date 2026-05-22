use std::collections::BTreeMap;
use std::path::{Path as FsPath, PathBuf};

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::api::ApiError;
use crate::sandbox::workspace_size_bytes;
use crate::state::AppState;
use crate::user::{user_id_from_headers, validate_user_id};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct UserRecord {
    version: u32,
    user_id: String,
    display_name: String,
    created_at: String,
    updated_at: String,
    quota: BTreeMap<String, u64>,
}

#[derive(Debug, Deserialize)]
pub struct UserQuotaUpdateInput {
    max_workspace_mb: Option<u64>,
    max_sessions: Option<u64>,
    max_runs_per_day: Option<u64>,
    max_run_runtime_seconds: Option<u64>,
}

pub async fn current_user_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    let record = ensure_user_record(&state, &user_id).await?;
    Ok(Json(
        serde_json::to_value(record).unwrap_or_else(|_| json!({})),
    ))
}

pub async fn current_user_quota(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    quota_status(&state, &user_id).await
}

pub async fn update_user_quota(
    State(state): State<AppState>,
    Path(target_user_id): Path<String>,
    Json(input): Json<UserQuotaUpdateInput>,
) -> Result<Json<Value>, ApiError> {
    validate_user_id(&target_user_id).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&target_user_id)?;
    let mut record = ensure_user_record(&state, &target_user_id).await?;
    for (key, value) in [
        ("max_workspace_mb", input.max_workspace_mb),
        ("max_sessions", input.max_sessions),
        ("max_runs_per_day", input.max_runs_per_day),
        ("max_run_runtime_seconds", input.max_run_runtime_seconds),
    ] {
        if let Some(value) = value {
            record.quota.insert(key.to_string(), value);
        }
    }
    record.updated_at = now_iso();
    write_user_record(&state, &record).await?;
    quota_status(&state, &target_user_id).await
}

async fn quota_status(state: &AppState, user_id: &str) -> Result<Json<Value>, ApiError> {
    let record = ensure_user_record(state, user_id).await?;
    Ok(Json(json!({
        "user_id": user_id,
        "quota": record.quota,
        "usage": user_usage(state, user_id).await?
    })))
}

pub(crate) async fn assert_can_create_session(
    state: &AppState,
    user_id: &str,
) -> Result<(), ApiError> {
    state.sandboxes.ensure_sandbox(user_id)?;
    let record = ensure_user_record(state, user_id).await?;
    let usage = user_usage(state, user_id).await?;
    let max_sessions = quota_value(&record, "max_sessions");
    let used = usage_u64(&usage, "session_count");
    if used >= max_sessions {
        return Err(quota_error("sessions", max_sessions, used));
    }
    Ok(())
}

pub(crate) async fn assert_can_create_run(
    state: &AppState,
    user_id: &str,
    max_runtime_seconds: u64,
) -> Result<(), ApiError> {
    state.sandboxes.ensure_sandbox(user_id)?;
    let record = ensure_user_record(state, user_id).await?;
    let usage = user_usage(state, user_id).await?;
    let max_runs = quota_value(&record, "max_runs_per_day");
    let used_runs = usage_u64(&usage, "runs_today");
    if used_runs >= max_runs {
        return Err(quota_error("runs_per_day", max_runs, used_runs));
    }
    let max_runtime = quota_value(&record, "max_run_runtime_seconds");
    if max_runtime_seconds > max_runtime {
        return Err(quota_error(
            "run_runtime_seconds",
            max_runtime,
            max_runtime_seconds,
        ));
    }
    Ok(())
}

pub(crate) async fn assert_workspace_save_within_quota(
    state: &AppState,
    user_id: &str,
    target: &FsPath,
    new_content_bytes: u64,
) -> Result<(), ApiError> {
    assert_workspace_writes_within_quota(
        state,
        user_id,
        &[(target.to_path_buf(), new_content_bytes)],
    )
    .await
}

pub(crate) async fn assert_workspace_writes_within_quota(
    state: &AppState,
    user_id: &str,
    targets: &[(PathBuf, u64)],
) -> Result<(), ApiError> {
    state.sandboxes.ensure_sandbox(user_id)?;
    let record = ensure_user_record(state, user_id).await?;
    let usage = user_usage(state, user_id).await?;
    let max_bytes = quota_value(&record, "max_workspace_mb").saturating_mul(1024 * 1024);
    let current_size = usage_u64(&usage, "workspace_size_bytes");
    let mut old_size = 0_u64;
    let mut new_size = 0_u64;
    for (target, bytes) in targets {
        old_size = old_size.saturating_add(
            target
                .metadata()
                .ok()
                .filter(|metadata| metadata.is_file())
                .map(|metadata| metadata.len())
                .unwrap_or(0),
        );
        new_size = new_size.saturating_add(*bytes);
    }
    let projected = current_size
        .saturating_sub(old_size)
        .saturating_add(new_size);
    if projected > max_bytes {
        return Err(quota_error("workspace_bytes", max_bytes, projected));
    }
    Ok(())
}

async fn user_usage(state: &AppState, user_id: &str) -> Result<Value, ApiError> {
    let sandbox_dir = state.sandboxes.sandbox_dir(user_id)?;
    let workspace = state.sandboxes.workspace_dir(user_id)?;
    let sessions_dir = state.sandboxes.sessions_dir(user_id)?;
    let today = now_iso().chars().take(10).collect::<String>();
    let mut runs_today = 0_u64;
    let mut active_runs = 0_u64;
    let mut records = list_job_meta_records(&sandbox_dir.join("agent-runs")).await?;
    if sessions_dir.exists() {
        let mut entries = tokio::fs::read_dir(&sessions_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            if entry.file_type().await?.is_dir() {
                records.extend(list_job_meta_records(&entry.path()).await?);
            }
        }
    }
    for record in records {
        let created = record
            .get("created_at")
            .and_then(Value::as_str)
            .unwrap_or("");
        if created.starts_with(&today) {
            runs_today += 1;
        }
        if record.get("status").and_then(Value::as_str) == Some("running") {
            active_runs += 1;
        }
    }
    let session_count = std::fs::read_dir(&sessions_dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .count();
    Ok(json!({
        "workspace_size_bytes": workspace_size_bytes(&workspace),
        "session_count": session_count,
        "runs_today": runs_today,
        "active_runs": active_runs
    }))
}

fn quota_value(record: &UserRecord, key: &str) -> u64 {
    record.quota.get(key).copied().unwrap_or(0)
}

fn usage_u64(usage: &Value, key: &str) -> u64 {
    usage.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn quota_error(resource: &str, limit: u64, used: u64) -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        json!({
            "code": "quota_exceeded",
            "resource": resource,
            "limit": limit,
            "used": used
        }),
    )
}

async fn list_job_meta_records(root: &std::path::Path) -> Result<Vec<Value>, ApiError> {
    let external_agents = root.join("external-agents");
    if !external_agents.exists() {
        return Ok(Vec::new());
    }
    let mut records = Vec::new();
    let mut entries = tokio::fs::read_dir(external_agents).await?;
    while let Some(entry) = entries.next_entry().await? {
        let meta = entry.path().join("meta.json");
        if !meta.is_file() {
            continue;
        }
        if let Ok(value) = serde_json::from_slice::<Value>(&tokio::fs::read(meta).await?) {
            if value.is_object() {
                records.push(value);
            }
        }
    }
    Ok(records)
}

async fn ensure_user_record(state: &AppState, user_id: &str) -> Result<UserRecord, ApiError> {
    let path = user_meta_path(state, user_id)?;
    if path.is_file() {
        if let Ok(mut record) = serde_json::from_slice::<UserRecord>(&tokio::fs::read(&path).await?)
        {
            let defaults = default_quota();
            for (key, value) in defaults {
                record.quota.entry(key).or_insert(value);
            }
            return Ok(record);
        }
    }
    let record = default_user_record(user_id);
    write_user_record(state, &record).await?;
    Ok(record)
}

async fn write_user_record(state: &AppState, record: &UserRecord) -> Result<(), ApiError> {
    let path = user_meta_path(state, &record.user_id)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(
        path,
        serde_json::to_vec_pretty(record).map_err(anyhow::Error::from)?,
    )
    .await?;
    Ok(())
}

fn user_meta_path(state: &AppState, user_id: &str) -> Result<PathBuf, ApiError> {
    Ok(state.sandboxes.sandbox_dir(user_id)?.join("user.json"))
}

fn default_user_record(user_id: &str) -> UserRecord {
    let now = now_iso();
    UserRecord {
        version: 1,
        user_id: user_id.to_string(),
        display_name: user_id.to_string(),
        created_at: now.clone(),
        updated_at: now,
        quota: default_quota(),
    }
}

fn default_quota() -> BTreeMap<String, u64> {
    BTreeMap::from([
        ("max_workspace_mb".to_string(), 2048),
        ("max_sessions".to_string(), 200),
        ("max_runs_per_day".to_string(), 200),
        ("max_run_runtime_seconds".to_string(), 3600),
    ])
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        AppConfig, CodexConfig, FeishuConfig, GogcliOAuthConfig, SandboxConfig, SkillsConfig,
    };
    use crate::state::AppState;
    use axum::response::IntoResponse;

    fn test_state() -> AppState {
        let root = std::env::temp_dir().join(format!("ripple-users-test-{}", uuid::Uuid::new_v4()));
        AppState::new(AppConfig {
            repo_root: root.clone(),
            host: "127.0.0.1".to_string(),
            port: 0,
            api_keys: Vec::new(),
            default_model: "codex-test".to_string(),
            model_presets: BTreeMap::new(),
            sandbox: SandboxConfig {
                sandboxes_root: root.join("sandboxes"),
                caches_root: root.join("cache"),
                idle_suspend_seconds: 1800,
                retention_seconds: 604_800,
                max_workspace_mb: 2048,
                tmpfs_size_mb: 512,
                nsjail_path: "nsjail".to_string(),
                uv_bin_dir: None,
                node_dir: None,
                lark_cli_install_root: None,
                notion_cli_install_root: None,
                gogcli_cli_install_root: None,
                pypi_mirror_url: None,
                npm_registry_url: None,
            },
            codex: CodexConfig {
                enabled: true,
                codex_executable: "codex".to_string(),
                app_server_args: Vec::new(),
                codex_home: None,
                approval_policy: "never".to_string(),
                sandbox_type: "workspace-write".to_string(),
                network_access: true,
                idle_timeout_seconds: 1800,
                max_runtime_seconds: 3600,
            },
            schedule_extraction_max_runtime_seconds: 120,
            skills: SkillsConfig {
                shared_dirs: Vec::new(),
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

    #[tokio::test]
    async fn run_quota_counts_session_job_records() {
        let state = test_state();
        let user_id = "quotauser";
        state.sandboxes.ensure_sandbox(user_id).unwrap();
        let mut record = ensure_user_record(&state, user_id).await.unwrap();
        record.quota.insert("max_runs_per_day".to_string(), 1);
        write_user_record(&state, &record).await.unwrap();

        let job_dir = state
            .sandboxes
            .session_dir(user_id, "session-1")
            .unwrap()
            .join("external-agents/agent-test");
        tokio::fs::create_dir_all(&job_dir).await.unwrap();
        tokio::fs::write(
            job_dir.join("meta.json"),
            serde_json::to_vec(&json!({
                "created_at": now_iso(),
                "status": "running"
            }))
            .unwrap(),
        )
        .await
        .unwrap();

        let err = assert_can_create_run(&state, user_id, 60)
            .await
            .unwrap_err();
        let response = err.into_response();

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn workspace_quota_rejects_projected_size() {
        let state = test_state();
        let user_id = "workspacequota";
        let workspace = state.sandboxes.ensure_sandbox(user_id).unwrap();
        let mut record = ensure_user_record(&state, user_id).await.unwrap();
        record.quota.insert("max_workspace_mb".to_string(), 0);
        write_user_record(&state, &record).await.unwrap();

        let err =
            assert_workspace_save_within_quota(&state, user_id, &workspace.join("new.txt"), 1)
                .await
                .unwrap_err();
        let response = err.into_response();

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}
