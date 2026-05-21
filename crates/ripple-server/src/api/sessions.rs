use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::ApiError;
use crate::sessions::CreateSessionInput;
use crate::state::AppState;
use crate::user::user_id_from_headers;

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

pub async fn create_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateSessionInput>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
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
    let Some(session) = state.sessions.get_session(&user_id, &session_id).await? else {
        return Err(ApiError::not_found("Session not found"));
    };
    Ok(Json(
        serde_json::to_value(session).unwrap_or_else(|_| json!({})),
    ))
}

pub async fn delete_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    if state.sessions.delete_session(&user_id, &session_id).await? {
        Ok(Json(json!({ "ok": true })))
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
    let Some(message_count) = state.sessions.clear_context(&user_id, &session_id).await? else {
        return Err(ApiError::not_found("Session not found"));
    };
    Ok(Json(
        json!({ "ok": true, "session_id": session_id, "message_count": message_count }),
    ))
}

pub async fn stop_session(Path(session_id): Path<String>) -> Json<Value> {
    Json(json!({ "ok": true, "session_id": session_id, "stopped": false }))
}

pub async fn suspend_session(Path(session_id): Path<String>) -> Json<Value> {
    Json(json!({ "ok": true, "session_id": session_id }))
}

pub async fn resume_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    get_session(State(state), headers, Path(session_id)).await
}

pub async fn list_suspended_sessions() -> Json<Value> {
    Json(json!({ "sessions": [], "count": 0 }))
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
    let Some(mut session) = state.sessions.load(&user_id, &session_id)? else {
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
    Ok(Json(json!({
        "ok": true,
        "session_id": session_id,
        "job_id": job_id,
        "action": input.action
    })))
}

pub async fn poll_session_connector_auth(
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Err(ApiError::not_implemented(format!(
        "Connector auth polling is not implemented in Rust backend yet for session {session_id}"
    )))
}

pub async fn session_usage(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let Some(session) = state.sessions.get_session(&user_id, &session_id).await? else {
        return Err(ApiError::not_found("Session not found"));
    };
    Ok(Json(json!({
        "session_id": session_id,
        "total_input_tokens": 0,
        "total_output_tokens": 0,
        "total_tokens": 0,
        "last_input_tokens": 0,
        "message_count": session.messages.len()
    })))
}
