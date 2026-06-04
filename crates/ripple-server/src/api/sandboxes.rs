use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde_json::{json, Value};

use crate::api::{audit_event, require_confirm, ApiError};
use crate::state::AppState;
use crate::user::user_id_from_headers;

pub async fn create_sandbox(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    let summary = sandbox_summary(&state, &user_id).await?.ok_or_else(|| {
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
    let Some(summary) = sandbox_summary(&state, &user_id).await? else {
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
    body: Option<Json<Value>>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let payload = body.map(|Json(value)| value).unwrap_or_else(|| json!({}));
    if state.config.security.require_confirm_for_risky_api {
        require_confirm(Some(&payload), "sandbox.delete")?;
    }
    audit_event(
        &state,
        &user_id,
        "sandbox.delete",
        true,
        json!({"user_id": user_id}),
    )
    .await?;
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
        "deployment_mode": state.config.security.deployment_mode,
        "sandboxes_root": "/sandbox",
        "caches_root": "/cache",
        "security": {
            "trusted_proxy_mode": state.config.security.deployment_mode == "trusted-proxy",
            "requires_confirm_for_risky_api": state.config.security.require_confirm_for_risky_api,
            "cors": {
                "allow_any_origin": state.config.cors.allow_any_origin,
                "allowed_origins": state.config.cors.allowed_origins
            },
            "notes": [
                "Ripple is a single-node trusted-team control plane.",
                "Codex app-server is a trusted host process; Codex shell commands are constrained by Codex Linux sandbox plus Ripple managed permissions.",
                "Connector CLI auth/status commands are constrained by nsjail when configured."
            ]
        },
        "execution": {
            "codex": {
                "enabled": state.config.codex.enabled,
                "runtime_boundary": "managed_permissions",
                "process_boundary": "host_app_server_process",
                "shell_boundary": "codex_linux_sandbox",
                "executable": state.config.codex.codex_executable,
                "permission_profile": "ripple-managed",
                "linux_sandbox": {
                    "uses_bubblewrap": true,
                    "requires_pid_namespace": true,
                    "fresh_proc": true,
                    "fail_closed": true
                }
            },
            "connectors": {
                "runtime_boundary": "nsjail",
                "nsjail_path": state.config.sandbox.nsjail_path,
                "process_isolation": {
                    "clone_newuser": true,
                    "clone_newpid": true,
                    "clone_newipc": true,
                    "clone_newuts": true,
                    "fresh_proc": true,
                    "clone_newnet": false,
                    "fail_closed": true
                }
            },
            "workspace": {
                "isolation_unit": "user_id",
                "path": ".ripple/sandboxes/<user_id>/workspace"
            }
        },
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

async fn sandbox_summary(
    state: &AppState,
    user_id: &str,
) -> Result<Option<crate::sandbox::SandboxInfo>, ApiError> {
    let session_count =
        usize::try_from(state.storage.count_sessions(user_id).await?).unwrap_or(usize::MAX);
    Ok(state.sandboxes.sandbox_summary(user_id, session_count)?)
}
