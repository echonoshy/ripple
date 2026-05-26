use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::users::{assert_can_create_run, assert_can_create_session};
use crate::api::{connectors, ApiError};
use crate::sessions::{CreateSessionInput, SessionRecord};
use crate::state::AppState;
use crate::user::user_id_from_headers;

const MAX_SESSION_TITLE_CHARS: usize = 120;

#[derive(Debug, Deserialize)]
pub struct UpdateSessionInput {
    pub title: Option<String>,
    pub pinned: Option<bool>,
}

pub async fn list_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let sessions = state.sessions.list_sessions(&user_id).await?;
    Ok(Json(
        json!({ "sessions": sessions, "count": sessions.len() }),
    ))
}

pub async fn deprecated_tasks_api() -> Result<Json<Value>, ApiError> {
    Err(ApiError::new(
        StatusCode::GONE,
        "/v1/tasks has been removed. Use /v1/sessions instead.",
    ))
}

pub async fn create_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateSessionInput>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    assert_can_create_session(&state, &user_id).await?;
    let session = state.sessions.create_session(&user_id, input).await?;
    let detail = state
        .sessions
        .get_session(&user_id, &session.session_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Session not found"))?;
    Ok(Json(
        serde_json::to_value(detail.info).unwrap_or_else(|_| json!({})),
    ))
}

pub async fn get_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let _ = state
        .sessions
        .recover_stale_context_compaction(&user_id, &session_id)
        .await?;
    if state
        .sessions
        .load(&user_id, &session_id)
        .await?
        .is_some_and(|record| record.status == "suspended")
    {
        let _ = state.sessions.resume_session(&user_id, &session_id).await?;
    }
    let Some(session) = state.sessions.get_session(&user_id, &session_id).await? else {
        return Err(ApiError::not_found("Session not found"));
    };
    Ok(Json(
        serde_json::to_value(session).unwrap_or_else(|_| json!({})),
    ))
}

pub async fn update_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(input): Json<UpdateSessionInput>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let title = input
        .title
        .map(|title| {
            let title = title.trim().to_string();
            if title.is_empty() {
                return Err(ApiError::bad_request("Session name cannot be empty"));
            }
            if title.chars().count() > MAX_SESSION_TITLE_CHARS {
                return Err(ApiError::bad_request("Session name is too long"));
            }
            Ok(title)
        })
        .transpose()?;

    let Some(info) = state
        .sessions
        .update_session_metadata(&user_id, &session_id, title, input.pinned)
        .await?
    else {
        return Err(ApiError::not_found("Session not found"));
    };

    Ok(Json(
        serde_json::to_value(info).unwrap_or_else(|_| json!({})),
    ))
}

pub async fn delete_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let stopped = state
        .jobs
        .cancel_session_run(&user_id, &session_id)
        .await?
        .is_some();
    if state.sessions.delete_session(&user_id, &session_id).await? {
        Ok(Json(json!({ "ok": true, "stopped": stopped })))
    } else {
        Err(ApiError::not_found("Session not found"))
    }
}

pub async fn clear_session_context(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let _ = state
        .sessions
        .recover_stale_context_compaction(&user_id, &session_id)
        .await?;
    let Some(session) = state.sessions.load(&user_id, &session_id).await? else {
        return Err(ApiError::not_found("Session not found"));
    };
    if matches!(session.status.as_str(), "queued" | "running" | "compacting") {
        return Err(ApiError::conflict("Session is currently running"));
    }
    let Some(message_count) = state.sessions.clear_context(&user_id, &session_id).await? else {
        return Err(ApiError::not_found("Session not found"));
    };
    Ok(Json(
        json!({ "ok": true, "session_id": session_id, "message_count": message_count }),
    ))
}

pub async fn compact_session_context(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let lock = state.sessions.session_lock(&user_id, &session_id);
    let guard = lock.lock_owned().await;
    let _ = state
        .sessions
        .recover_context_compaction_after_lock(&user_id, &session_id)
        .await?;
    let Some(session) = state.sessions.load(&user_id, &session_id).await? else {
        return Err(ApiError::not_found("Session not found"));
    };
    if matches!(session.status.as_str(), "queued" | "running" | "compacting") {
        return Err(ApiError::conflict("Session is currently running"));
    }
    if session
        .codex_thread_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return Err(ApiError::conflict("Session has no Codex thread to compact"));
    }

    assert_can_create_run(&state, &user_id, state.config.codex.max_runtime_seconds).await?;
    let workspace_root = state.sandboxes.ensure_sandbox(&user_id)?;
    let Some(codex_thread_id) = state
        .sessions
        .begin_context_compaction(&user_id, &session_id)
        .await?
    else {
        return Err(ApiError::not_found("Session not found"));
    };
    let response_thread_id = codex_thread_id.clone();

    let jobs = state.jobs.clone();
    let sessions = state.sessions.clone();
    let compact_user_id = user_id.clone();
    let compact_session_id = session_id.clone();
    let max_runtime_seconds = state.config.codex.max_runtime_seconds;
    tokio::spawn(async move {
        let _guard = guard;
        let result = jobs
            .compact_thread(
                compact_user_id.clone(),
                workspace_root,
                codex_thread_id,
                max_runtime_seconds,
            )
            .await;
        let _ = sessions
            .finish_context_compaction(&compact_user_id, &compact_session_id, result.is_ok())
            .await;
    });

    Ok(Json(json!({
        "ok": true,
        "session_id": session_id,
        "codex_thread_id": response_thread_id,
        "status": "compacting"
    })))
}

pub async fn get_session_codex_thread(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let _ = state
        .sessions
        .recover_stale_context_compaction(&user_id, &session_id)
        .await?;
    let Some(session) = state.sessions.load(&user_id, &session_id).await? else {
        return Err(ApiError::not_found("Session not found"));
    };
    if matches!(session.status.as_str(), "queued" | "running" | "compacting") {
        return Err(ApiError::conflict("Session is currently running"));
    }
    let Some(codex_thread_id) = session
        .codex_thread_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
    else {
        return Err(ApiError::conflict("Session has no Codex thread"));
    };
    let workspace_root = state.sandboxes.ensure_sandbox(&user_id)?;
    let thread = state
        .jobs
        .read_thread(user_id, workspace_root, codex_thread_id.clone())
        .await
        .map_err(|err| ApiError::bad_request(err.to_string()))?;

    Ok(Json(json!({
        "ok": true,
        "session_id": session_id,
        "codex_thread_id": codex_thread_id,
        "thread": thread.get("thread").cloned().unwrap_or(Value::Null)
    })))
}

pub async fn stop_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let _ = state
        .sessions
        .recover_stale_context_compaction(&user_id, &session_id)
        .await?;
    let Some(mut session) = state.sessions.load(&user_id, &session_id).await? else {
        return Err(ApiError::not_found("Session not found"));
    };
    let connector_auth_cancelled = pending_connector_auth_name(&session);
    let stopped = state.jobs.cancel_session_run(&user_id, &session_id).await?;
    if let Some(info) = stopped {
        session.status = "cancelled".to_string();
        clear_pending_waits(&mut session, true);
        state.sessions.save_record(session).await?;
        cancel_connector_runtime_if_needed(&user_id, connector_auth_cancelled.as_deref()).await;
        Ok(Json(json!({
            "ok": true,
            "session_id": session_id,
            "stopped": true,
            "job_id": info.job_id,
            "status": info.status,
            "connector_auth_cancelled": connector_auth_cancelled.is_some(),
            "connector": connector_auth_cancelled
        })))
    } else if matches!(session.status.as_str(), "queued" | "running")
        || connector_auth_cancelled.is_some()
    {
        session.status = "cancelled".to_string();
        clear_pending_waits(&mut session, true);
        state.sessions.save_record(session).await?;
        cancel_connector_runtime_if_needed(&user_id, connector_auth_cancelled.as_deref()).await;
        Ok(Json(json!({
            "ok": true,
            "session_id": session_id,
            "stopped": false,
            "status": "cancelled",
            "connector_auth_cancelled": connector_auth_cancelled.is_some(),
            "connector": connector_auth_cancelled
        })))
    } else {
        Ok(Json(json!({
            "ok": true,
            "session_id": session_id,
            "stopped": false,
            "connector_auth_cancelled": false
        })))
    }
}

pub async fn cancel_connector_auth(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let Some(mut session) = state.sessions.load(&user_id, &session_id).await? else {
        return Err(ApiError::not_found("Session not found"));
    };
    let connector = pending_connector_auth_name(&session);
    if connector.is_some() {
        session.status = "cancelled".to_string();
        clear_pending_waits(&mut session, true);
        state.sessions.save_record(session).await?;
        cancel_connector_runtime_if_needed(&user_id, connector.as_deref()).await;
    }
    Ok(Json(json!({
        "ok": true,
        "session_id": session_id,
        "connector_auth_cancelled": connector.is_some(),
        "connector": connector
    })))
}

fn pending_connector_auth_name(session: &SessionRecord) -> Option<String> {
    session
        .pending_connector_auth
        .as_ref()
        .and_then(|pending| pending.get("connector"))
        .and_then(Value::as_str)
        .filter(|connector| !connector.trim().is_empty())
        .map(ToString::to_string)
}

fn clear_pending_waits(session: &mut SessionRecord, include_connector_auth: bool) {
    session.pending_permission_request = None;
    session.pending_question = None;
    session.pending_options = None;
    if include_connector_auth {
        session.pending_connector_auth = None;
    }
}

async fn cancel_connector_runtime_if_needed(user_id: &str, connector: Option<&str>) {
    if connector == Some("feishu") {
        connectors::cancel_feishu_setup(user_id).await;
    }
}

pub async fn suspend_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let _ = state.jobs.cancel_session_run(&user_id, &session_id).await?;
    let Some(record) = state
        .sessions
        .suspend_session(&user_id, &session_id)
        .await?
    else {
        return Err(ApiError::not_found(
            "Session not found or already suspended",
        ));
    };
    Ok(Json(json!({
        "ok": true,
        "session_id": record.session_id,
        "status": "suspended"
    })))
}

pub async fn resume_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let Some(record) = state.sessions.resume_session(&user_id, &session_id).await? else {
        return Err(ApiError::not_found("Suspended session not found"));
    };
    let detail = state
        .sessions
        .get_session(&user_id, &record.session_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Session not found"))?;
    Ok(Json(
        serde_json::to_value(detail.info).unwrap_or_else(|_| json!({})),
    ))
}

pub async fn list_suspended_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let sessions = state.sessions.list_suspended_sessions(&user_id).await?;
    Ok(Json(
        json!({ "sessions": sessions, "count": sessions.len() }),
    ))
}

#[derive(Debug, Deserialize)]
pub struct PermissionResolveInput {
    action: String,
    #[serde(default)]
    job_id: Option<String>,
    #[serde(default)]
    request_id: Option<Value>,
}

pub async fn resolve_permission_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(input): Json<PermissionResolveInput>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let Some(mut session) = state.sessions.load(&user_id, &session_id).await? else {
        return Err(ApiError::not_found("Session not found"));
    };
    let pending = session
        .pending_permission_request
        .clone()
        .ok_or_else(|| ApiError::conflict("No pending permission request"))?;
    let job_id = input
        .job_id
        .or_else(|| {
            pending
                .get("job_id")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .ok_or_else(|| ApiError::bad_request("Pending permission request is missing job_id"))?;
    let request_id = input
        .request_id
        .or_else(|| pending.get("request_id").cloned())
        .ok_or_else(|| ApiError::bad_request("Pending permission request is missing request_id"))?;
    let resolved = state
        .jobs
        .resolve_approval_for_user(&job_id, &user_id, &request_id, &input.action)
        .await
        .map_err(|err| ApiError::bad_request(err.to_string()))?;
    if !resolved {
        return Err(ApiError::conflict(
            "Pending permission request is no longer active",
        ));
    }
    session.pending_permission_request = None;
    session.status = "running".to_string();
    state.sessions.save_record(session).await?;
    tokio::spawn(finalize_resolved_permission_session(
        state.clone(),
        user_id.clone(),
        session_id.clone(),
        job_id.clone(),
    ));
    Ok(Json(json!({
        "ok": true,
        "session_id": session_id,
        "job_id": job_id,
        "action": input.action
    })))
}

async fn finalize_resolved_permission_session(
    state: AppState,
    user_id: String,
    session_id: String,
    job_id: String,
) {
    let deadline = tokio::time::Instant::now()
        + std::time::Duration::from_secs(state.config.codex.max_runtime_seconds.max(1) + 5);
    loop {
        let info = state
            .jobs
            .info_for_user(&job_id, &user_id)
            .await
            .ok()
            .flatten();
        if let Some(info) = info {
            if matches!(info.status.as_str(), "completed" | "failed" | "cancelled") {
                if let Ok(Some(mut session)) = state.sessions.load(&user_id, &session_id).await {
                    if session.pending_permission_request.is_none()
                        && matches!(
                            session.status.as_str(),
                            "running" | "awaiting_permission" | "waiting_for_approval"
                        )
                    {
                        session.status = match info.status.as_str() {
                            "completed" => "idle",
                            "cancelled" => "cancelled",
                            _ => "failed",
                        }
                        .to_string();
                        let _ = state.sessions.save_record_if_exists(session).await;
                    }
                }
                return;
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

pub async fn session_usage(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let Some(session) = state.sessions.load(&user_id, &session_id).await? else {
        return Err(ApiError::not_found("Session not found"));
    };
    Ok(Json(json!({
        "session_id": session_id,
        "total_input_tokens": session.total_input_tokens,
        "total_output_tokens": session.total_output_tokens,
        "total_tokens": session.total_input_tokens.saturating_add(session.total_output_tokens),
        "last_input_tokens": session.last_input_tokens,
        "message_count": session.messages.len()
    })))
}
