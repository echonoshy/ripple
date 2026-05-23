use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde_json::{json, Value};

use crate::api::ApiError;
use crate::state::AppState;
use crate::user::user_id_from_headers;

pub async fn create_sandbox(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    let summary = state.sandboxes.sandbox_summary(&user_id)?.ok_or_else(|| {
        ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "sandbox creation failed")
    })?;
    Ok(Json(
        serde_json::to_value(summary).unwrap_or_else(|_| json!({})),
    ))
}

pub async fn get_sandbox(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let Some(summary) = state.sandboxes.sandbox_summary(&user_id)? else {
        return Err(ApiError::not_found(format!(
            "Sandbox for user {user_id:?} not found"
        )));
    };
    Ok(Json(
        serde_json::to_value(summary).unwrap_or_else(|_| json!({})),
    ))
}

pub async fn delete_sandbox(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let cancelled_runs = state.jobs.stop_user(&user_id).await?;
    match state.sandboxes.teardown_sandbox(&user_id, false) {
        Ok(true) => {
            state.storage.delete_user_data(&user_id).await?;
            state.sessions.clear_user_cache(&user_id).await;
            state.jobs.clear_user_cache(&user_id).await;
            Ok(Json(json!({
                "ok": true,
                "user_id": user_id,
                "cancelled_run_count": cancelled_runs.len()
            })))
        }
        Ok(false) => Err(ApiError::not_found(format!(
            "Sandbox for user {user_id:?} not found"
        ))),
        Err(err) => Err(ApiError::conflict(err.to_string())),
    }
}

pub async fn sandbox_info(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "enabled": true,
        "mode": "nsjail",
        "sandboxes_root": state.config.sandbox.sandboxes_root,
        "caches_root": state.config.sandbox.caches_root,
        "resource_limits": {
            "max_workspace_mb": state.config.sandbox.max_workspace_mb,
            "command_timeout": 120
        },
        "runtimes": {
            "codex": {
                "enabled": state.config.codex.enabled,
                "executable": state.config.codex.codex_executable
            }
        }
    }))
}
