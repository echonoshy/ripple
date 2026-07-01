use std::path::{Path, PathBuf};
use std::time::SystemTime;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde_json::{json, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::io::AsyncReadExt;

use crate::api::{audit_event, require_confirm, ApiError};
use crate::redaction::redact_text;
use crate::state::AppState;
use crate::user::user_id_from_headers;

const MAX_MEMORY_FILE_BYTES: u64 = 256 * 1024;
const CODEX_MEMORIES_DB: &str = "memories_1.sqlite";

#[utoipa::path(
    get,
    path = "/memory/status",
    tag = "memory",
    responses(
        (status = 200, description = "Codex memory status for the current user", body = serde_json::Value),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn memory_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;

    let paths = memory_paths(&state, &user_id)?;
    let summary_meta = tokio::fs::metadata(&paths.summary).await.ok();
    let registry_meta = tokio::fs::metadata(&paths.registry).await.ok();
    let raw_meta = tokio::fs::metadata(&paths.raw).await.ok();
    let db_meta = tokio::fs::metadata(&paths.db).await.ok();
    let last_updated_at = latest_modified_at([&summary_meta, &registry_meta, &raw_meta]);
    let stage1_output_count = stage1_output_count(&paths.db).await;

    Ok(Json(json!({
        "ok": true,
        "memory": {
            "enabled": state.config.codex.memory.enabled,
            "use_memories": state.config.codex.memory.use_memories,
            "generate_memories": state.config.codex.memory.generate_memories,
            "dedicated_tools": state.config.codex.memory.dedicated_tools,
            "disable_on_external_context": state.config.codex.memory.disable_on_external_context
        },
        "summary": {
            "available": summary_meta.as_ref().is_some_and(|metadata| metadata.is_file()),
            "registry_available": registry_meta.as_ref().is_some_and(|metadata| metadata.is_file()),
            "raw_available": raw_meta.as_ref().is_some_and(|metadata| metadata.is_file()),
            "last_updated_at": last_updated_at
        },
        "runtime": {
            "memories_db_available": db_meta.as_ref().is_some_and(|metadata| metadata.is_file()),
            "stage1_output_count": stage1_output_count
        }
    })))
}

#[utoipa::path(
    get,
    path = "/memory/summary",
    tag = "memory",
    responses(
        (status = 200, description = "Codex memory summary files for the current user", body = serde_json::Value),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn memory_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;

    let paths = memory_paths(&state, &user_id)?;
    let summary = read_redacted_memory_file(&paths.summary).await?;
    let registry = read_redacted_memory_file(&paths.registry).await?;
    let raw = read_redacted_memory_file(&paths.raw).await?;

    Ok(Json(json!({
        "ok": true,
        "summary": summary.map(|content| content.into_value()),
        "registry": registry.map(|content| content.into_value()),
        "raw": raw.map(|content| content.into_value())
    })))
}

#[utoipa::path(
    post,
    path = "/memory/reset",
    tag = "memory",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Reset Codex memory for the current user", body = serde_json::Value),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 412, description = "Confirmation required", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 502, description = "Codex app-server reset failed", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn reset_memory(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let payload = body.map(|Json(value)| value).unwrap_or_else(|| json!({}));
    if state.config.security.require_confirm_for_risky_api {
        require_confirm(Some(&payload), "memory.reset")?;
    }

    let workspace_root = state.sandboxes.ensure_sandbox(&user_id)?;
    let cancelled = state.jobs.stop_user(&user_id).await?;
    let codex_result = state
        .jobs
        .reset_codex_memory(user_id.clone(), workspace_root)
        .await
        .map_err(|err| ApiError::new(StatusCode::BAD_GATEWAY, err.to_string()))?;
    audit_event(
        &state,
        &user_id,
        "memory.reset",
        true,
        json!({"cancelled_run_count": cancelled.len()}),
    )
    .await?;

    Ok(Json(json!({
        "ok": true,
        "cancelled_run_count": cancelled.len(),
        "codex": codex_result
    })))
}

struct MemoryPaths {
    summary: PathBuf,
    registry: PathBuf,
    raw: PathBuf,
    db: PathBuf,
}

struct MemoryFileContent {
    text: String,
    truncated: bool,
}

impl MemoryFileContent {
    fn into_value(self) -> Value {
        json!({
            "text": self.text,
            "truncated": self.truncated
        })
    }
}

fn memory_paths(state: &AppState, user_id: &str) -> Result<MemoryPaths, ApiError> {
    let memory_root = state.sandboxes.codex_home_dir(user_id)?.join("memories");
    let sqlite_home = codex_sqlite_home_for_user(state, user_id)?;
    Ok(MemoryPaths {
        summary: memory_root.join("memory_summary.md"),
        registry: memory_root.join("MEMORY.md"),
        raw: memory_root.join("raw_memories.md"),
        db: sqlite_home.join(CODEX_MEMORIES_DB),
    })
}

fn codex_sqlite_home_for_user(state: &AppState, user_id: &str) -> Result<PathBuf, ApiError> {
    let codex_home = state.config.codex_home_path();
    let runtime_root = codex_home
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or(codex_home)
        .join("codex-runtime");
    Ok(runtime_root.join("users").join(user_id).join("sqlite"))
}

async fn read_redacted_memory_file(path: &Path) -> Result<Option<MemoryFileContent>, ApiError> {
    let Ok(metadata) = tokio::fs::metadata(path).await else {
        return Ok(None);
    };
    if !metadata.is_file() {
        return Ok(None);
    }

    let mut file = tokio::fs::File::open(path).await?;
    let mut bytes = Vec::new();
    let mut reader = (&mut file).take(MAX_MEMORY_FILE_BYTES.saturating_add(1));
    reader.read_to_end(&mut bytes).await?;
    let truncated =
        bytes.len() as u64 > MAX_MEMORY_FILE_BYTES || metadata.len() > MAX_MEMORY_FILE_BYTES;
    if truncated {
        bytes.truncate(MAX_MEMORY_FILE_BYTES as usize);
    }
    let text = String::from_utf8_lossy(&bytes).to_string();
    Ok(Some(MemoryFileContent {
        text: redact_text(&text),
        truncated,
    }))
}

fn latest_modified_at<'a>(
    metadatas: impl IntoIterator<Item = &'a Option<std::fs::Metadata>>,
) -> Option<String> {
    let latest = metadatas
        .into_iter()
        .filter_map(|metadata| metadata.as_ref())
        .filter_map(|metadata| metadata.modified().ok())
        .max();
    latest.map(system_time_to_iso)
}

fn system_time_to_iso(time: SystemTime) -> String {
    OffsetDateTime::from(time)
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

async fn stage1_output_count(db_path: &Path) -> Option<i64> {
    let Ok(metadata) = tokio::fs::metadata(db_path).await else {
        return None;
    };
    if !metadata.is_file() {
        return None;
    }
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .read_only(true)
        .create_if_missing(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .ok()?;
    let count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM stage1_outputs")
        .fetch_one(&pool)
        .await
        .ok();
    pool.close().await;
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_time_to_iso_formats_utc_timestamp() {
        let timestamp = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1);

        assert_eq!(system_time_to_iso(timestamp), "1970-01-01T00:00:01Z");
    }
}
