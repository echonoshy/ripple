use std::collections::BTreeMap;
use std::path::PathBuf;

use axum::extract::{Path, State};
use axum::http::HeaderMap;
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

async fn user_usage(state: &AppState, user_id: &str) -> Result<Value, ApiError> {
    let sandbox_dir = state.sandboxes.sandbox_dir(user_id)?;
    let workspace = state.sandboxes.workspace_dir(user_id)?;
    let sessions_dir = state.sandboxes.sessions_dir(user_id)?;
    let today = now_iso().chars().take(10).collect::<String>();
    let mut runs_today = 0_u64;
    let mut active_runs = 0_u64;
    for root in [sandbox_dir.join("agent-runs"), sessions_dir.clone()] {
        for record in list_job_meta_records(&root).await? {
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
