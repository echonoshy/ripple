use std::convert::Infallible;

use async_stream::stream;
use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::time::{sleep, Duration};
use uuid::Uuid;

use crate::api::users::assert_can_create_run;
use crate::api::{paginate, ApiError, ListQuery};
use crate::auth::now_iso;
use crate::jobs::{AgentRunCreateRequest, AgentRunInfo};
use crate::state::AppState;
use crate::storage::Storage;
use crate::user::user_id_from_headers;

const TASK_SESSION_STATUSES: &[&str] = &[
    "pending_confirm",
    "in_progress",
    "waiting_user",
    "completed",
    "cancelled",
    "failed",
];

const TASK_SPEC_STATUSES: &[&str] = &[
    "pending_confirm",
    "confirmed",
    "in_progress",
    "waiting_user",
    "completed",
    "cancelled",
    "failed",
];

const TASK_RUN_STATUSES: &[&str] = &[
    "in_progress",
    "waiting_user",
    "completed",
    "cancelled",
    "failed",
];

const CONFIRMATION_STATUSES: &[&str] = &["requested", "accepted", "rejected", "cancelled"];

const TERMINAL_TASK_SESSION_STATUSES: &[&str] = &["completed", "cancelled", "failed"];

#[utoipa::path(
    get,
    path = "/task-sessions",
    tag = "task-sessions",
    params(crate::api::ListQuery),
    responses(
        (status = 200, description = "Paginated task session list", body = serde_json::Value),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn list_task_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let records = state.storage.list_task_sessions(&user_id).await?;
    let total = records.len();
    let (sessions, next_cursor) = paginate(records, &query)?;
    Ok(Json(json!({
        "task_sessions": sessions,
        "count": total,
        "next_cursor": next_cursor
    })))
}

#[utoipa::path(
    post,
    path = "/task-sessions",
    tag = "task-sessions",
    request_body = crate::api::openapi::GenericJsonObject,
    responses(
        (status = 200, description = "Created task session", body = serde_json::Value),
        (status = 400, description = "Invalid task session payload", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn create_task_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let now = now_iso();
    let mut session = task_session_from_payload(&input, &user_id, &now)?;
    let session_id = required_str(&session, "session_id")?.to_string();
    state
        .storage
        .upsert_task_session(&user_id, &session)
        .await?;

    let initial_message = input
        .get("initial_message")
        .or_else(|| input.get("message"))
        .cloned();
    if let Some(message) = initial_message {
        let event = event_record(
            &user_id,
            &session_id,
            "task_session_message",
            json!({"message": message}),
            &now,
        );
        state
            .storage
            .upsert_task_session_event(&user_id, &session_id, &event)
            .await?;
    }

    let mut created_spec = None;
    if let Some(task_spec) = input.get("task_spec").filter(|value| value.is_object()) {
        let spec = task_spec_from_payload(task_spec, &user_id, &session_id, &now)?;
        set_field(
            &mut session,
            "current_task_spec_id",
            spec.get("task_spec_id").cloned().unwrap_or(Value::Null),
        );
        set_field(&mut session, "status", json!("pending_confirm"));
        set_field(&mut session, "needs_user_action", json!(true));
        set_field(&mut session, "updated_at", json!(now.clone()));
        state
            .storage
            .upsert_task_session_spec(&user_id, &session_id, &spec)
            .await?;
        state
            .storage
            .upsert_task_session(&user_id, &session)
            .await?;
        append_task_session_event(
            &state.storage,
            &user_id,
            &session_id,
            "task_spec_drafted",
            json!({"task_spec_id": spec.get("task_spec_id").cloned().unwrap_or(Value::Null)}),
        )
        .await?;
        created_spec = Some(spec);
    } else {
        append_task_session_event(
            &state.storage,
            &user_id,
            &session_id,
            "task_session_created",
            json!({}),
        )
        .await?;
    }

    Ok(Json(json!({
        "task_session": session,
        "task_spec": created_spec
    })))
}

#[utoipa::path(
    get,
    path = "/task-sessions/{session_id}",
    tag = "task-sessions",
    params(("session_id" = String, Path, description = "Task session id")),
    responses(
        (status = 200, description = "Task session detail", body = serde_json::Value),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Task session not found", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn get_task_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    Ok(Json(
        task_session_detail(&state.storage, &user_id, &session_id).await?,
    ))
}

#[utoipa::path(
    patch,
    path = "/task-sessions/{session_id}",
    tag = "task-sessions",
    params(("session_id" = String, Path, description = "Task session id")),
    request_body = crate::api::openapi::GenericJsonObject,
    responses(
        (status = 200, description = "Updated task session", body = serde_json::Value),
        (status = 400, description = "Invalid task session update", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Task session not found", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn update_task_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let mut session = load_task_session(&state.storage, &user_id, &session_id).await?;
    merge_task_session_updates(&mut session, &input)?;
    state
        .storage
        .upsert_task_session(&user_id, &session)
        .await?;
    append_task_session_event(
        &state.storage,
        &user_id,
        &session_id,
        "task_session_updated",
        json!({"updates": input}),
    )
    .await?;
    Ok(Json(
        task_session_detail(&state.storage, &user_id, &session_id).await?,
    ))
}

#[utoipa::path(
    post,
    path = "/task-sessions/{session_id}/messages",
    tag = "task-sessions",
    params(("session_id" = String, Path, description = "Task session id")),
    request_body = crate::api::openapi::GenericJsonObject,
    responses(
        (status = 200, description = "Appended task session message", body = serde_json::Value),
        (status = 400, description = "Invalid message payload", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Task session not found", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn append_task_session_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let mut session = load_task_session(&state.storage, &user_id, &session_id).await?;
    let role = string_field(&input, "role").unwrap_or_else(|| "user".to_string());
    if !matches!(role.as_str(), "user" | "assistant" | "agent" | "system") {
        return Err(ApiError::bad_request("message role is invalid"));
    }
    let content = string_field(&input, "content")
        .ok_or_else(|| ApiError::bad_request("message content is required"))?;
    let now = now_iso();
    let event = event_record(
        &user_id,
        &session_id,
        "task_session_message",
        json!({
            "role": role,
            "content": content,
            "metadata": input.get("metadata").cloned().unwrap_or(Value::Null)
        }),
        &now,
    );
    set_field(&mut session, "latest_message", json!(content));
    if let Some(status) = string_field(&input, "status") {
        validate_status(&status, TASK_SESSION_STATUSES, "task session status")?;
        set_field(&mut session, "status", json!(status));
    }
    if let Some(needs_user_action) = input.get("needs_user_action").and_then(Value::as_bool) {
        set_field(&mut session, "needs_user_action", json!(needs_user_action));
    }
    set_field(&mut session, "updated_at", json!(now));
    state
        .storage
        .upsert_task_session_event(&user_id, &session_id, &event)
        .await?;
    state
        .storage
        .upsert_task_session(&user_id, &session)
        .await?;
    Ok(Json(json!({
        "task_session": session,
        "event": event
    })))
}

#[utoipa::path(
    post,
    path = "/task-sessions/{session_id}/spec-turns",
    tag = "task-sessions",
    params(("session_id" = String, Path, description = "Task session id")),
    request_body = crate::api::openapi::GenericJsonObject,
    responses(
        (status = 200, description = "Processed one conversational TaskSpec completion turn", body = serde_json::Value),
        (status = 400, description = "Invalid spec turn payload", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Task session not found", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn process_task_spec_turn(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let message = string_field(&input, "message")
        .or_else(|| string_field(&input, "content"))
        .ok_or_else(|| ApiError::bad_request("spec turn message is required"))?;
    let session = load_task_session(&state.storage, &user_id, &session_id).await?;
    let user_event = append_task_session_event(
        &state.storage,
        &user_id,
        &session_id,
        "task_session_message",
        json!({
            "role": "user",
            "content": message,
            "metadata": input.get("metadata").cloned().unwrap_or(Value::Null)
        }),
    )
    .await?;
    let current_spec = current_task_spec(&state.storage, &user_id, &session_id, &session).await?;
    let extraction = extract_task_spec_turn_with_codex(
        &state,
        &user_id,
        &session_id,
        &session,
        current_spec.as_ref(),
        &input,
        &message,
    )
    .await?;
    let projection = persist_task_spec_turn_projection(
        &state.storage,
        &user_id,
        &session_id,
        &session,
        current_spec,
        extraction,
    )
    .await?;
    let detail = task_session_detail(&state.storage, &user_id, &session_id).await?;
    Ok(Json(json!({
        "task_session": detail.get("task_session").cloned().unwrap_or(Value::Null),
        "task_spec": projection.task_spec,
        "assistant_message": projection.assistant_message,
        "missing_fields": projection.missing_fields,
        "ready_to_confirm": projection.ready_to_confirm,
        "extraction_run_id": projection.extraction_run_id,
        "events": {
            "user_message": user_event,
            "assistant_message": projection.assistant_event,
            "spec_event": projection.spec_event
        },
        "detail": detail
    })))
}

#[utoipa::path(
    post,
    path = "/task-sessions/{session_id}/task-specs",
    tag = "task-sessions",
    params(("session_id" = String, Path, description = "Task session id")),
    request_body = crate::api::openapi::GenericJsonObject,
    responses(
        (status = 200, description = "Created task spec", body = serde_json::Value),
        (status = 400, description = "Invalid task spec payload", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Task session not found", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn create_task_spec(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let mut session = load_task_session(&state.storage, &user_id, &session_id).await?;
    let now = now_iso();
    let spec = task_spec_from_payload(&input, &user_id, &session_id, &now)?;
    set_field(
        &mut session,
        "current_task_spec_id",
        spec.get("task_spec_id").cloned().unwrap_or(Value::Null),
    );
    set_field(&mut session, "status", json!("pending_confirm"));
    set_field(&mut session, "needs_user_action", json!(true));
    set_field(
        &mut session,
        "latest_message",
        json!(spec
            .get("impact_summary")
            .and_then(Value::as_str)
            .unwrap_or("TaskSpec is ready for confirmation")),
    );
    set_field(&mut session, "updated_at", json!(now));
    state
        .storage
        .upsert_task_session_spec(&user_id, &session_id, &spec)
        .await?;
    state
        .storage
        .upsert_task_session(&user_id, &session)
        .await?;
    append_task_session_event(
        &state.storage,
        &user_id,
        &session_id,
        "task_spec_drafted",
        json!({"task_spec_id": spec.get("task_spec_id").cloned().unwrap_or(Value::Null)}),
    )
    .await?;
    Ok(Json(json!({
        "task_session": session,
        "task_spec": spec
    })))
}

#[utoipa::path(
    patch,
    path = "/task-sessions/{session_id}/task-specs/{task_spec_id}",
    tag = "task-sessions",
    params(
        ("session_id" = String, Path, description = "Task session id"),
        ("task_spec_id" = String, Path, description = "Task spec id")
    ),
    request_body = crate::api::openapi::GenericJsonObject,
    responses(
        (status = 200, description = "Updated task spec", body = serde_json::Value),
        (status = 400, description = "Invalid task spec update", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Task session or spec not found", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn update_task_spec(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((session_id, task_spec_id)): Path<(String, String)>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let _ = load_task_session(&state.storage, &user_id, &session_id).await?;
    let mut spec =
        load_task_session_spec(&state.storage, &user_id, &session_id, &task_spec_id).await?;
    merge_task_spec_updates(&mut spec, &input)?;
    state
        .storage
        .upsert_task_session_spec(&user_id, &session_id, &spec)
        .await?;
    append_task_session_event(
        &state.storage,
        &user_id,
        &session_id,
        "task_spec_updated",
        json!({"task_spec_id": task_spec_id, "updates": input}),
    )
    .await?;
    Ok(Json(json!({"task_spec": spec})))
}

#[utoipa::path(
    post,
    path = "/task-sessions/{session_id}/task-specs/{task_spec_id}/confirm",
    tag = "task-sessions",
    params(
        ("session_id" = String, Path, description = "Task session id"),
        ("task_spec_id" = String, Path, description = "Task spec id")
    ),
    request_body = crate::api::openapi::GenericJsonObject,
    responses(
        (status = 200, description = "Confirmed task spec", body = serde_json::Value),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Task session or spec not found", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn confirm_task_spec(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((session_id, task_spec_id)): Path<(String, String)>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let mut session = load_task_session(&state.storage, &user_id, &session_id).await?;
    let mut spec =
        load_task_session_spec(&state.storage, &user_id, &session_id, &task_spec_id).await?;
    let now = now_iso();
    set_field(&mut spec, "status", json!("confirmed"));
    set_field(&mut spec, "confirmed_at", json!(now.clone()));
    set_field(&mut spec, "updated_at", json!(now.clone()));
    set_field(&mut session, "status", json!("in_progress"));
    set_field(&mut session, "needs_user_action", json!(false));
    set_field(&mut session, "current_task_spec_id", json!(task_spec_id));
    set_field(&mut session, "updated_at", json!(now));
    state
        .storage
        .upsert_task_session_spec(&user_id, &session_id, &spec)
        .await?;
    state
        .storage
        .upsert_task_session(&user_id, &session)
        .await?;
    append_task_session_event(
        &state.storage,
        &user_id,
        &session_id,
        "task_spec_confirmed",
        json!({"task_spec_id": task_spec_id}),
    )
    .await?;
    let confirmed_task_spec_id = required_str(&spec, "task_spec_id")?.to_string();
    let run = if input.get("start_run").and_then(Value::as_bool) == Some(true) {
        Some(
            create_task_run_record(
                &state.storage,
                &user_id,
                &session_id,
                &confirmed_task_spec_id,
                &input,
            )
            .await?,
        )
    } else {
        None
    };
    Ok(Json(json!({
        "task_session": session,
        "task_spec": spec,
        "run": run
    })))
}

#[utoipa::path(
    post,
    path = "/task-sessions/{session_id}/task-specs/{task_spec_id}/runs",
    tag = "task-sessions",
    params(
        ("session_id" = String, Path, description = "Task session id"),
        ("task_spec_id" = String, Path, description = "Task spec id")
    ),
    request_body = crate::api::openapi::GenericJsonObject,
    responses(
        (status = 200, description = "Started task run", body = serde_json::Value),
        (status = 400, description = "Invalid task run payload", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Task session or spec not found", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 409, description = "Task spec requires confirmation", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn start_task_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((session_id, task_spec_id)): Path<(String, String)>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let spec = load_task_session_spec(&state.storage, &user_id, &session_id, &task_spec_id).await?;
    if spec.get("status").and_then(Value::as_str) == Some("pending_confirm")
        && input.get("confirm").and_then(Value::as_bool) != Some(true)
    {
        return Err(ApiError::conflict(json!({
            "code": "task_spec_confirmation_required",
            "message": "TaskSpec must be confirmed before it can run.",
            "task_spec_id": task_spec_id
        })));
    }
    let run = create_task_run_record(&state.storage, &user_id, &session_id, &task_spec_id, &input)
        .await?;
    Ok(Json(json!({
        "run": run,
        "detail": task_session_detail(&state.storage, &user_id, &session_id).await?
    })))
}

#[utoipa::path(
    patch,
    path = "/task-sessions/{session_id}/runs/{run_id}",
    tag = "task-sessions",
    params(
        ("session_id" = String, Path, description = "Task session id"),
        ("run_id" = String, Path, description = "Task run id")
    ),
    request_body = crate::api::openapi::GenericJsonObject,
    responses(
        (status = 200, description = "Updated task run", body = serde_json::Value),
        (status = 400, description = "Invalid task run update", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Task session or run not found", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn update_task_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((session_id, run_id)): Path<(String, String)>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let mut run = load_task_session_run(&state.storage, &user_id, &session_id, &run_id).await?;
    merge_task_run_updates(&mut run, &input)?;
    persist_task_run_status_projection(&state.storage, &user_id, &session_id, &run).await?;
    Ok(Json(json!({
        "run": run,
        "detail": task_session_detail(&state.storage, &user_id, &session_id).await?
    })))
}

#[utoipa::path(
    post,
    path = "/task-sessions/{session_id}/runs/{run_id}/cancel",
    tag = "task-sessions",
    params(
        ("session_id" = String, Path, description = "Task session id"),
        ("run_id" = String, Path, description = "Task run id")
    ),
    request_body = crate::api::openapi::GenericJsonObject,
    responses(
        (status = 200, description = "Cancelled task run", body = serde_json::Value),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Task session or run not found", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn cancel_task_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((session_id, run_id)): Path<(String, String)>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let mut run = load_task_session_run(&state.storage, &user_id, &session_id, &run_id).await?;
    let reason = input
        .get("reason")
        .cloned()
        .unwrap_or_else(|| json!("cancelled_by_user"));
    let now = now_iso();
    set_field(&mut run, "status", json!("cancelled"));
    set_field(&mut run, "cancelled_at", json!(now.clone()));
    set_field(&mut run, "cancellation_reason", reason);
    set_field(&mut run, "updated_at", json!(now));
    persist_task_run_status_projection(&state.storage, &user_id, &session_id, &run).await?;
    Ok(Json(json!({
        "run": run,
        "detail": task_session_detail(&state.storage, &user_id, &session_id).await?
    })))
}

#[utoipa::path(
    get,
    path = "/task-sessions/{session_id}/events",
    tag = "task-sessions",
    params(
        ("session_id" = String, Path, description = "Task session id"),
        crate::api::ListQuery
    ),
    responses(
        (status = 200, description = "Task session event timeline", body = serde_json::Value),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Task session not found", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn list_task_session_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let _ = load_task_session(&state.storage, &user_id, &session_id).await?;
    let events = state
        .storage
        .list_task_session_events(&user_id, &session_id)
        .await?;
    let total = events.len();
    let (events, next_cursor) = paginate(events, &query)?;
    Ok(Json(json!({
        "events": events,
        "count": total,
        "next_cursor": next_cursor
    })))
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct TaskSessionEventsStreamQuery {
    from_start: Option<bool>,
    follow: Option<bool>,
    close_on_terminal: Option<bool>,
    heartbeat_seconds: Option<u64>,
    after_seq: Option<i64>,
}

#[utoipa::path(
    get,
    path = "/task-sessions/{session_id}/events/stream",
    tag = "task-sessions",
    params(
        ("session_id" = String, Path, description = "Task session id"),
        TaskSessionEventsStreamQuery
    ),
    responses(
        (status = 200, description = "Server-sent task status event stream", content_type = "text/event-stream", body = crate::api::openapi::SseEvent),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Task session not found", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn stream_task_session_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Query(query): Query<TaskSessionEventsStreamQuery>,
) -> Result<Response<Body>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let _ = load_task_session(&state.storage, &user_id, &session_id).await?;

    let follow = query.follow.unwrap_or(true);
    let close_on_terminal = query.close_on_terminal.unwrap_or(true);
    let heartbeat_seconds = query.heartbeat_seconds.unwrap_or(8).clamp(1, 60);
    let mut cursor_seq = query
        .after_seq
        .or_else(|| last_event_id_seq_from_headers(&headers));
    let from_start = query.from_start.unwrap_or(cursor_seq.is_none());
    if !from_start && cursor_seq.is_none() {
        cursor_seq = state
            .storage
            .latest_task_session_event_seq(&user_id, &session_id)
            .await?;
    }

    let storage = state.storage.clone();
    let stream_user_id = user_id.clone();
    let stream_session_id = session_id.clone();

    let body_stream = stream! {
        let mut cursor_seq = cursor_seq;
        let mut first_poll = true;
        let mut last_emit = now_epoch_seconds();

        loop {
            let events_result = if first_poll && from_start && cursor_seq.is_none() {
                storage
                    .list_task_session_events(&stream_user_id, &stream_session_id)
                    .await
            } else if let Some(seq) = cursor_seq {
                storage
                    .list_task_session_events_after_seq(&stream_user_id, &stream_session_id, seq)
                    .await
            } else {
                storage
                    .list_task_session_events(&stream_user_id, &stream_session_id)
                    .await
            };

            let events = match events_result {
                Ok(events) => events,
                Err(_) => {
                    yield Ok::<Bytes, Infallible>(sse_json_event(
                        "error",
                        None,
                        &json!({
                            "type": "error",
                            "message": "failed to load task session events"
                        }),
                    ));
                    break;
                }
            };

            let mut emitted = false;
            let mut failed = false;
            for event in events {
                let seq = event.get("seq").and_then(Value::as_i64);
                match task_status_sse_payload(&storage, &stream_user_id, &stream_session_id, Some(&event)).await {
                    Ok(payload) => {
                        let sse_id = seq.map(|value| value.to_string());
                        yield Ok::<Bytes, Infallible>(sse_json_event(
                            "task.status",
                            sse_id.as_deref(),
                            &payload,
                        ));
                        if let Some(seq) = seq {
                            cursor_seq = Some(seq);
                        }
                        emitted = true;
                        last_emit = now_epoch_seconds();
                    }
                    Err(_) => {
                        yield Ok::<Bytes, Infallible>(sse_json_event(
                            "error",
                            None,
                            &json!({
                                "type": "error",
                                "message": "failed to project task status"
                            }),
                        ));
                        failed = true;
                        break;
                    }
                }
            }
            if failed {
                break;
            }

            if first_poll && !emitted {
                if let Ok(payload) =
                    task_status_sse_payload(&storage, &stream_user_id, &stream_session_id, None).await
                {
                    yield Ok::<Bytes, Infallible>(sse_json_event("task.status", None, &payload));
                    last_emit = now_epoch_seconds();
                }
            }

            let status = storage
                .get_task_session(&stream_user_id, &stream_session_id)
                .await
                .ok()
                .flatten()
                .and_then(|session| string_field(&session, "status"))
                .unwrap_or_else(|| "completed".to_string());
            if !follow || (close_on_terminal && is_terminal_task_session_status(&status)) {
                yield Ok::<Bytes, Infallible>(Bytes::from_static(b"data: [DONE]\n\n"));
                break;
            }

            first_poll = false;
            let now = now_epoch_seconds();
            if now.saturating_sub(last_emit) >= heartbeat_seconds {
                yield Ok::<Bytes, Infallible>(sse_json_event(
                    "heartbeat",
                    None,
                    &json!({"type": "heartbeat", "ts": now_iso()}),
                ));
                last_emit = now;
            }
            sleep(Duration::from_millis(500)).await;
        }
    };

    let mut response = Response::new(Body::from_stream(body_stream));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response.headers_mut().insert(
        header::HeaderName::from_static("x-accel-buffering"),
        HeaderValue::from_static("no"),
    );
    Ok(response)
}

#[utoipa::path(
    post,
    path = "/task-sessions/{session_id}/confirmations",
    tag = "task-sessions",
    params(("session_id" = String, Path, description = "Task session id")),
    request_body = crate::api::openapi::GenericJsonObject,
    responses(
        (status = 200, description = "Created confirmation card", body = serde_json::Value),
        (status = 400, description = "Invalid confirmation payload", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Task session not found", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn create_confirmation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let mut session = load_task_session(&state.storage, &user_id, &session_id).await?;
    let now = now_iso();
    let confirmation = confirmation_from_payload(&input, &user_id, &session_id, &now)?;
    set_field(&mut session, "status", json!("waiting_user"));
    set_field(&mut session, "needs_user_action", json!(true));
    set_field(
        &mut session,
        "latest_message",
        json!(confirmation
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Waiting for your confirmation")),
    );
    set_field(&mut session, "updated_at", json!(now));
    state
        .storage
        .upsert_task_session_confirmation(&user_id, &session_id, &confirmation)
        .await?;
    state
        .storage
        .upsert_task_session(&user_id, &session)
        .await?;
    append_task_session_event(
        &state.storage,
        &user_id,
        &session_id,
        "task_confirmation_requested",
        json!({"confirmation_id": confirmation.get("confirmation_id").cloned().unwrap_or(Value::Null)}),
    )
    .await?;
    Ok(Json(json!({
        "task_session": session,
        "confirmation": confirmation
    })))
}

#[utoipa::path(
    post,
    path = "/task-sessions/{session_id}/confirmations/{confirmation_id}/respond",
    tag = "task-sessions",
    params(
        ("session_id" = String, Path, description = "Task session id"),
        ("confirmation_id" = String, Path, description = "Confirmation id")
    ),
    request_body = crate::api::openapi::GenericJsonObject,
    responses(
        (status = 200, description = "Recorded confirmation response", body = serde_json::Value),
        (status = 400, description = "Invalid confirmation response", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Task session or confirmation not found", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn respond_confirmation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((session_id, confirmation_id)): Path<(String, String)>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let mut session = load_task_session(&state.storage, &user_id, &session_id).await?;
    let mut confirmation = state
        .storage
        .get_task_session_confirmation(&user_id, &session_id, &confirmation_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Task confirmation not found"))?;
    let decision = string_field(&input, "decision")
        .or_else(|| string_field(&input, "action"))
        .ok_or_else(|| ApiError::bad_request("confirmation decision is required"))?;
    let accepted = matches!(
        decision.as_str(),
        "allow" | "allowed" | "accept" | "accepted" | "yes"
    );
    let rejected = matches!(
        decision.as_str(),
        "deny" | "denied" | "reject" | "rejected" | "no"
    );
    if !accepted && !rejected {
        return Err(ApiError::bad_request(
            "confirmation decision must be allow or deny",
        ));
    }
    let now = now_iso();
    set_field(
        &mut confirmation,
        "status",
        json!(if accepted { "accepted" } else { "rejected" }),
    );
    set_field(&mut confirmation, "decision", json!(decision));
    set_field(
        &mut confirmation,
        "response",
        input.get("response").cloned().unwrap_or(Value::Null),
    );
    set_field(&mut confirmation, "responded_at", json!(now.clone()));
    set_field(&mut confirmation, "updated_at", json!(now.clone()));
    let critical = confirmation
        .get("critical")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    set_field(&mut session, "needs_user_action", json!(false));
    set_field(
        &mut session,
        "status",
        json!(if rejected && critical {
            "cancelled"
        } else {
            "in_progress"
        }),
    );
    set_field(&mut session, "updated_at", json!(now));
    state
        .storage
        .upsert_task_session_confirmation(&user_id, &session_id, &confirmation)
        .await?;
    state
        .storage
        .upsert_task_session(&user_id, &session)
        .await?;
    append_task_session_event(
        &state.storage,
        &user_id,
        &session_id,
        "task_confirmation_responded",
        json!({
            "confirmation_id": confirmation_id,
            "decision": confirmation.get("decision").cloned().unwrap_or(Value::Null),
            "status": confirmation.get("status").cloned().unwrap_or(Value::Null)
        }),
    )
    .await?;
    Ok(Json(json!({
        "task_session": session,
        "confirmation": confirmation
    })))
}

async fn task_session_detail(
    storage: &Storage,
    user_id: &str,
    session_id: &str,
) -> Result<Value, ApiError> {
    let task_session = load_task_session(storage, user_id, session_id).await?;
    let specs = storage.list_task_session_specs(user_id, session_id).await?;
    let runs = storage.list_task_session_runs(user_id, session_id).await?;
    let events = storage
        .list_task_session_events(user_id, session_id)
        .await?;
    let confirmations = storage
        .list_task_session_confirmations(user_id, session_id)
        .await?;
    Ok(json!({
        "task_session": task_session,
        "task_specs": specs,
        "runs": runs,
        "events": events,
        "confirmations": confirmations
    }))
}

async fn load_task_session(
    storage: &Storage,
    user_id: &str,
    session_id: &str,
) -> Result<Value, ApiError> {
    storage
        .get_task_session(user_id, session_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Task session not found"))
}

async fn load_task_session_spec(
    storage: &Storage,
    user_id: &str,
    session_id: &str,
    task_spec_id: &str,
) -> Result<Value, ApiError> {
    storage
        .get_task_session_spec(user_id, session_id, task_spec_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Task spec not found"))
}

async fn load_task_session_run(
    storage: &Storage,
    user_id: &str,
    session_id: &str,
    run_id: &str,
) -> Result<Value, ApiError> {
    storage
        .get_task_session_run(user_id, session_id, run_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Task run not found"))
}

fn task_session_from_payload(payload: &Value, user_id: &str, now: &str) -> Result<Value, ApiError> {
    let Some(input) = payload.as_object() else {
        return Err(ApiError::bad_request(
            "task session payload must be an object",
        ));
    };
    let session_id = string_field(payload, "session_id")
        .map(|value| validate_record_id(&value, "session_id").map(|_| value))
        .transpose()?
        .unwrap_or_else(|| generated_id("ts"));
    let goal = string_field(payload, "goal").or_else(|| string_field(payload, "objective"));
    let task_type = string_field(payload, "task_type");
    let title = string_field(payload, "title")
        .or_else(|| goal.clone())
        .or_else(|| task_type.clone())
        .unwrap_or_else(|| "任务会话".to_string());
    let status = string_field(payload, "status").unwrap_or_else(|| {
        if input.contains_key("task_spec") {
            "pending_confirm".to_string()
        } else {
            "waiting_user".to_string()
        }
    });
    validate_status(&status, TASK_SESSION_STATUSES, "task session status")?;
    let needs_user_action = payload
        .get("needs_user_action")
        .and_then(Value::as_bool)
        .unwrap_or(status == "pending_confirm" || status == "waiting_user");
    let mut record = input.clone();
    record.remove("task_spec");
    record.remove("initial_message");
    record.remove("message");
    record.insert("user_id".to_string(), json!(user_id));
    record.insert("session_id".to_string(), json!(session_id));
    record.insert("title".to_string(), json!(title));
    if let Some(goal) = goal {
        record.insert("goal".to_string(), json!(goal));
    }
    if let Some(task_type) = task_type {
        record.insert("task_type".to_string(), json!(task_type));
    }
    record
        .entry("source_surface".to_string())
        .or_insert_with(|| json!("vitana"));
    record
        .entry("executor".to_string())
        .or_insert_with(|| json!("vitana"));
    record.insert("status".to_string(), json!(status));
    record.insert("needs_user_action".to_string(), json!(needs_user_action));
    let latest_message = record
        .get("goal")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    record
        .entry("latest_message".to_string())
        .or_insert_with(|| json!(latest_message));
    record
        .entry("created_at".to_string())
        .or_insert_with(|| json!(now));
    record.insert("updated_at".to_string(), json!(now));
    Ok(Value::Object(record))
}

fn task_spec_from_payload(
    payload: &Value,
    user_id: &str,
    session_id: &str,
    now: &str,
) -> Result<Value, ApiError> {
    let Some(input) = payload.as_object() else {
        return Err(ApiError::bad_request("task spec payload must be an object"));
    };
    let task_spec_id = string_field(payload, "task_spec_id")
        .map(|value| validate_record_id(&value, "task_spec_id").map(|_| value))
        .transpose()?
        .unwrap_or_else(|| generated_id("spec"));
    let task_type = string_field(payload, "task_type").unwrap_or_else(|| "other".to_string());
    let goal = string_field(payload, "goal").or_else(|| string_field(payload, "objective"));
    let status = string_field(payload, "status").unwrap_or_else(|| "pending_confirm".to_string());
    validate_status(&status, TASK_SPEC_STATUSES, "task spec status")?;
    let mut record = input.clone();
    record.insert("user_id".to_string(), json!(user_id));
    record.insert("session_id".to_string(), json!(session_id));
    record.insert("task_spec_id".to_string(), json!(task_spec_id));
    record.insert("task_type".to_string(), json!(task_type));
    if let Some(goal) = goal {
        record.insert("goal".to_string(), json!(goal));
    }
    record
        .entry("required_fields".to_string())
        .or_insert_with(|| json!({}));
    record
        .entry("source_refs".to_string())
        .or_insert_with(|| json!([]));
    record
        .entry("risk_level".to_string())
        .or_insert_with(|| json!("low"));
    record.insert("status".to_string(), json!(status));
    record
        .entry("created_at".to_string())
        .or_insert_with(|| json!(now));
    record.insert("updated_at".to_string(), json!(now));
    Ok(Value::Object(record))
}

fn confirmation_from_payload(
    payload: &Value,
    user_id: &str,
    session_id: &str,
    now: &str,
) -> Result<Value, ApiError> {
    let Some(input) = payload.as_object() else {
        return Err(ApiError::bad_request(
            "confirmation payload must be an object",
        ));
    };
    let confirmation_id = string_field(payload, "confirmation_id")
        .map(|value| validate_record_id(&value, "confirmation_id").map(|_| value))
        .transpose()?
        .unwrap_or_else(|| generated_id("conf"));
    let title = string_field(payload, "title")
        .ok_or_else(|| ApiError::bad_request("confirmation title is required"))?;
    let status = string_field(payload, "status").unwrap_or_else(|| "requested".to_string());
    validate_status(&status, CONFIRMATION_STATUSES, "confirmation status")?;
    let mut record = input.clone();
    record.insert("user_id".to_string(), json!(user_id));
    record.insert("session_id".to_string(), json!(session_id));
    record.insert("confirmation_id".to_string(), json!(confirmation_id));
    record.insert("title".to_string(), json!(title));
    record.insert("status".to_string(), json!(status));
    record
        .entry("confirmation_type".to_string())
        .or_insert_with(|| json!("allow_deny"));
    record
        .entry("critical".to_string())
        .or_insert_with(|| json!(true));
    record
        .entry("created_at".to_string())
        .or_insert_with(|| json!(now));
    record.insert("updated_at".to_string(), json!(now));
    Ok(Value::Object(record))
}

async fn create_task_run_record(
    storage: &Storage,
    user_id: &str,
    session_id: &str,
    task_spec_id: &str,
    payload: &Value,
) -> Result<Value, ApiError> {
    let mut session = load_task_session(storage, user_id, session_id).await?;
    let mut spec = load_task_session_spec(storage, user_id, session_id, task_spec_id).await?;
    let now = now_iso();
    let run_id = string_field(payload, "run_id")
        .map(|value| validate_record_id(&value, "run_id").map(|_| value))
        .transpose()?
        .unwrap_or_else(|| generated_id("run"));
    let mut record = Map::new();
    record.insert("user_id".to_string(), json!(user_id));
    record.insert("session_id".to_string(), json!(session_id));
    record.insert("task_spec_id".to_string(), json!(task_spec_id));
    record.insert("run_id".to_string(), json!(run_id));
    record.insert("status".to_string(), json!("in_progress"));
    record.insert(
        "executor".to_string(),
        json!(string_field(payload, "executor").unwrap_or_else(|| {
            session
                .get("executor")
                .and_then(Value::as_str)
                .unwrap_or("vitana")
                .to_string()
        })),
    );
    if let Some(job_id) =
        string_field(payload, "job_id").or_else(|| string_field(payload, "external_run_id"))
    {
        record.insert("external_run_id".to_string(), json!(job_id));
    }
    if let Some(value) = payload.get("input") {
        record.insert("input".to_string(), value.clone());
    }
    if let Some(value) = payload.get("metadata") {
        record.insert("metadata".to_string(), value.clone());
    }
    record.insert("started_at".to_string(), json!(now.clone()));
    record.insert("created_at".to_string(), json!(now.clone()));
    record.insert("updated_at".to_string(), json!(now.clone()));
    let run = Value::Object(record);
    set_field(&mut spec, "status", json!("in_progress"));
    set_field(&mut spec, "updated_at", json!(now.clone()));
    set_field(&mut session, "status", json!("in_progress"));
    set_field(&mut session, "needs_user_action", json!(false));
    set_field(&mut session, "current_task_spec_id", json!(task_spec_id));
    set_field(
        &mut session,
        "current_run_id",
        run.get("run_id").cloned().unwrap_or(Value::Null),
    );
    set_field(
        &mut session,
        "latest_run_id",
        run.get("run_id").cloned().unwrap_or(Value::Null),
    );
    set_field(&mut session, "updated_at", json!(now));
    storage
        .upsert_task_session_run(user_id, session_id, &run)
        .await?;
    storage
        .upsert_task_session_spec(user_id, session_id, &spec)
        .await?;
    storage.upsert_task_session(user_id, &session).await?;
    append_task_session_event(
        storage,
        user_id,
        session_id,
        "task_run_started",
        json!({
            "run_id": run.get("run_id").cloned().unwrap_or(Value::Null),
            "task_spec_id": task_spec_id
        }),
    )
    .await?;
    Ok(run)
}

async fn persist_task_run_status_projection(
    storage: &Storage,
    user_id: &str,
    session_id: &str,
    run: &Value,
) -> Result<(), ApiError> {
    let mut session = load_task_session(storage, user_id, session_id).await?;
    let now = now_iso();
    storage
        .upsert_task_session_run(user_id, session_id, run)
        .await?;
    let run_status = run
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("in_progress");
    if let Some(task_spec_id) = run.get("task_spec_id").and_then(Value::as_str) {
        if let Some(mut spec) = storage
            .get_task_session_spec(user_id, session_id, task_spec_id)
            .await?
        {
            set_field(&mut spec, "status", json!(run_status));
            set_field(&mut spec, "updated_at", json!(now.clone()));
            if run_status == "completed" {
                set_field(&mut spec, "completed_at", json!(now.clone()));
            }
            storage
                .upsert_task_session_spec(user_id, session_id, &spec)
                .await?;
        }
    }
    set_field(&mut session, "status", json!(run_status));
    set_field(
        &mut session,
        "needs_user_action",
        json!(run_status == "waiting_user"),
    );
    if matches!(run_status, "completed" | "cancelled" | "failed") {
        set_field(&mut session, "current_run_id", Value::Null);
    } else {
        set_field(
            &mut session,
            "current_run_id",
            run.get("run_id").cloned().unwrap_or(Value::Null),
        );
    }
    set_field(
        &mut session,
        "latest_run_id",
        run.get("run_id").cloned().unwrap_or(Value::Null),
    );
    if let Some(summary) = run.get("result_summary") {
        set_field(&mut session, "latest_message", summary.clone());
    } else if let Some(reason) = run
        .get("failure_reason")
        .or_else(|| run.get("cancellation_reason"))
    {
        set_field(&mut session, "latest_message", reason.clone());
    }
    set_field(&mut session, "updated_at", json!(now));
    storage.upsert_task_session(user_id, &session).await?;
    append_task_session_event(
        storage,
        user_id,
        session_id,
        event_type_for_run_status(run_status),
        json!({
            "run_id": run.get("run_id").cloned().unwrap_or(Value::Null),
            "status": run_status
        }),
    )
    .await?;
    Ok(())
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct TaskSpecTurnExtractionResult {
    #[serde(default)]
    assistant_message: Option<String>,
    #[serde(default)]
    ready_to_confirm: bool,
    #[serde(default)]
    missing_fields: Vec<String>,
    #[serde(default)]
    task_spec: Option<Value>,
    #[serde(default, skip)]
    extraction_run_id: Option<String>,
}

struct TaskSpecTurnProjection {
    task_spec: Value,
    assistant_message: String,
    missing_fields: Vec<String>,
    ready_to_confirm: bool,
    extraction_run_id: Option<String>,
    assistant_event: Value,
    spec_event: Value,
}

async fn extract_task_spec_turn_with_codex(
    state: &AppState,
    user_id: &str,
    session_id: &str,
    session: &Value,
    current_spec: Option<&Value>,
    input: &Value,
    message: &str,
) -> Result<TaskSpecTurnExtractionResult, ApiError> {
    let workspace_root = state.sandboxes.ensure_sandbox(user_id)?;
    let runtime_dir = state.sandboxes.sandbox_dir(user_id)?.join("agent-runs");
    let max_runtime_seconds = input
        .get("max_runtime_seconds")
        .and_then(Value::as_u64)
        .unwrap_or(state.config.task_trigger_extraction_max_runtime_seconds)
        .clamp(1, 600);
    assert_can_create_run(state, user_id, max_runtime_seconds).await?;

    let model = string_field(input, "model").unwrap_or_else(|| state.config.default_model.clone());
    let effort = string_field(input, "effort");
    let prompt = build_task_spec_turn_prompt(
        session,
        current_spec,
        &task_session_message_history(&state.storage, user_id, session_id).await?,
        message,
        input,
    );
    let create = AgentRunCreateRequest {
        prompt: prompt.clone(),
        provider: "codex".to_string(),
        base_instructions: None,
        turn_context: None,
        client_context: None,
        cwd: Some("/workspace".to_string()),
        input_items: vec![json!({"type": "text", "text": prompt})],
        model: Some(model),
        effort,
        summary: None,
        output_schema: Some(task_spec_turn_output_schema()),
        max_runtime_seconds,
        task_trigger_id: None,
        task_trigger_title: None,
        task_trigger_reason: None,
        codex_thread_id: None,
        codex_persistent_thread: false,
        client_request_id: string_field(input, "client_request_id"),
        chat_user_input: None,
        chat_user_content: None,
    };
    let info = state
        .jobs
        .run_internal(
            create,
            user_id.to_string(),
            Some(session_id.to_string()),
            workspace_root,
            runtime_dir,
        )
        .await
        .map_err(|err| ApiError::bad_request(format!("TaskSpec extraction failed: {err}")))?;
    if info.status != "completed" {
        return Err(ApiError::bad_request("TaskSpec extraction run failed"));
    }
    let mut extraction = parse_task_spec_turn_output(&read_agent_run_output(&info).await)?;
    normalize_task_spec_turn_extraction(&mut extraction);
    Ok(with_extraction_run_id(extraction, &info.job_id))
}

fn with_extraction_run_id(
    mut extraction: TaskSpecTurnExtractionResult,
    job_id: &str,
) -> TaskSpecTurnExtractionResult {
    extraction.extraction_run_id = Some(job_id.to_string());
    if let Some(spec) = extraction.task_spec.as_mut() {
        if let Some(object) = spec.as_object_mut() {
            object
                .entry("metadata".to_string())
                .or_insert_with(|| json!({}));
            if let Some(metadata) = object.get_mut("metadata").and_then(Value::as_object_mut) {
                metadata.insert("spec_extraction_run_id".to_string(), json!(job_id));
            }
        }
    }
    extraction
}

async fn persist_task_spec_turn_projection(
    storage: &Storage,
    user_id: &str,
    session_id: &str,
    session: &Value,
    current_spec: Option<Value>,
    extraction: TaskSpecTurnExtractionResult,
) -> Result<TaskSpecTurnProjection, ApiError> {
    let now = now_iso();
    let ready_to_confirm = extraction.ready_to_confirm && extraction.task_spec.is_some();
    let status = if ready_to_confirm {
        "pending_confirm"
    } else {
        "waiting_user"
    };
    let assistant_message = task_spec_turn_assistant_message(&extraction, ready_to_confirm);
    let mut next_session = session.clone();
    set_field(&mut next_session, "status", json!(status));
    set_field(&mut next_session, "needs_user_action", json!(true));
    set_field(
        &mut next_session,
        "latest_message",
        json!(assistant_message.clone()),
    );
    set_field(&mut next_session, "updated_at", json!(now.clone()));

    let mut saved_spec = Value::Null;
    let mut spec_event = Value::Null;
    let extraction_run_id = extraction.extraction_run_id.clone();
    if let Some(mut spec_payload) = extraction.task_spec.clone() {
        if let Some(object) = spec_payload.as_object_mut() {
            object.insert("status".to_string(), json!(status));
            object.entry("task_type".to_string()).or_insert_with(|| {
                session
                    .get("task_type")
                    .cloned()
                    .unwrap_or_else(|| json!("other"))
            });
            if let Some(goal) = session.get("goal") {
                object
                    .entry("goal".to_string())
                    .or_insert_with(|| goal.clone());
            }
        }
        let (spec, event_type) = if let Some(mut existing) = current_spec {
            merge_task_spec_updates(&mut existing, &spec_payload)?;
            (existing, "task_spec_updated")
        } else {
            (
                task_spec_from_payload(&spec_payload, user_id, session_id, &now)?,
                "task_spec_drafted",
            )
        };
        let task_spec_id = required_str(&spec, "task_spec_id")?.to_string();
        set_field(
            &mut next_session,
            "current_task_spec_id",
            json!(task_spec_id.clone()),
        );
        storage
            .upsert_task_session_spec(user_id, session_id, &spec)
            .await?;
        spec_event = append_task_session_event(
            storage,
            user_id,
            session_id,
            event_type,
            json!({
                "task_spec_id": task_spec_id,
                "status": status,
                "missing_fields": extraction.missing_fields.clone()
            }),
        )
        .await?;
        saved_spec = spec;
    }

    storage.upsert_task_session(user_id, &next_session).await?;
    let assistant_event = append_task_session_event(
        storage,
        user_id,
        session_id,
        "task_session_message",
        json!({
            "role": "agent",
            "content": assistant_message,
            "metadata": {
                "source": "task_spec_turn",
                "ready_to_confirm": ready_to_confirm,
                "missing_fields": extraction.missing_fields.clone(),
                "task_spec_id": saved_spec.get("task_spec_id").cloned().unwrap_or(Value::Null),
                "extraction_run_id": extraction_run_id.clone()
            }
        }),
    )
    .await?;
    let status_event_type = if ready_to_confirm {
        "task_spec_ready_for_confirmation"
    } else {
        "task_spec_waiting_user"
    };
    append_task_session_event(
        storage,
        user_id,
        session_id,
        status_event_type,
        json!({
            "task_spec_id": saved_spec.get("task_spec_id").cloned().unwrap_or(Value::Null),
            "missing_fields": extraction.missing_fields.clone(),
            "assistant_message": assistant_message
        }),
    )
    .await?;

    Ok(TaskSpecTurnProjection {
        task_spec: saved_spec,
        assistant_message,
        missing_fields: extraction.missing_fields,
        ready_to_confirm,
        extraction_run_id,
        assistant_event,
        spec_event,
    })
}

async fn current_task_spec(
    storage: &Storage,
    user_id: &str,
    session_id: &str,
    session: &Value,
) -> Result<Option<Value>, ApiError> {
    if let Some(task_spec_id) = session.get("current_task_spec_id").and_then(Value::as_str) {
        if let Some(spec) = storage
            .get_task_session_spec(user_id, session_id, task_spec_id)
            .await?
        {
            return Ok(Some(spec));
        }
    }
    Ok(storage
        .list_task_session_specs(user_id, session_id)
        .await?
        .into_iter()
        .last())
}

async fn task_session_message_history(
    storage: &Storage,
    user_id: &str,
    session_id: &str,
) -> Result<Vec<Value>, ApiError> {
    let events = storage
        .list_task_session_events(user_id, session_id)
        .await?;
    Ok(events
        .into_iter()
        .filter(|event| {
            event.get("event_type").and_then(Value::as_str) == Some("task_session_message")
        })
        .filter_map(|event| event.get("payload").cloned())
        .collect())
}

fn task_spec_turn_assistant_message(
    extraction: &TaskSpecTurnExtractionResult,
    ready_to_confirm: bool,
) -> String {
    if let Some(message) = extraction
        .assistant_message
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return message.to_string();
    }
    if ready_to_confirm {
        return "TaskSpec 已生成，请确认后开始执行。".to_string();
    }
    if !extraction.missing_fields.is_empty() {
        return format!("还需要补充：{}", extraction.missing_fields.join("、"));
    }
    "还需要补充任务目标、执行对象或执行方式。".to_string()
}

fn normalize_task_spec_turn_extraction(extraction: &mut TaskSpecTurnExtractionResult) {
    extraction
        .missing_fields
        .retain(|field| !field.trim().is_empty());
    extraction.missing_fields.sort();
    extraction.missing_fields.dedup();
    if extraction.missing_fields.is_empty() && extraction.task_spec.is_some() {
        extraction.ready_to_confirm = true;
    }
    if extraction.task_spec.is_none() {
        extraction.ready_to_confirm = false;
    }
}

fn parse_task_spec_turn_output(text: &str) -> Result<TaskSpecTurnExtractionResult, ApiError> {
    serde_json::from_str::<TaskSpecTurnExtractionResult>(text.trim()).map_err(|err| {
        ApiError::bad_request(format!("TaskSpec extraction output is invalid: {err}"))
    })
}

async fn read_agent_run_output(info: &AgentRunInfo) -> String {
    if let Some(output_file) = info.output_file.as_deref() {
        if let Ok(text) = tokio::fs::read_to_string(output_file).await {
            return text;
        }
    }
    info.stdout_tail.clone()
}

fn task_spec_turn_output_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["assistant_message", "ready_to_confirm", "missing_fields", "task_spec"],
        "properties": {
            "assistant_message": {"type": ["string", "null"]},
            "ready_to_confirm": {"type": "boolean"},
            "missing_fields": {"type": "array", "items": {"type": "string"}},
            "task_spec": {
                "type": ["object", "null"],
                "additionalProperties": true,
                "properties": {
                    "task_spec_id": {"type": ["string", "null"]},
                    "task_type": {"type": ["string", "null"]},
                    "goal": {"type": ["string", "null"]},
                    "required_fields": {"type": "object", "additionalProperties": true},
                    "source_refs": {"type": "array", "items": {"type": "object", "additionalProperties": true}},
                    "risk_level": {"type": ["string", "null"]},
                    "impact_summary": {"type": ["string", "null"]},
                    "metadata": {"type": "object", "additionalProperties": true}
                }
            }
        }
    })
}

fn build_task_spec_turn_prompt(
    session: &Value,
    current_spec: Option<&Value>,
    message_history: &[Value],
    latest_message: &str,
    input: &Value,
) -> String {
    let required_fields = input
        .get("required_fields")
        .cloned()
        .or_else(|| input.get("required_fields_schema").cloned())
        .unwrap_or(Value::Null);
    format!(
        "You are a strict TaskSpec turn extractor for Ripple/Vitana task center.\n\
Current time: {}.\n\
Return only JSON matching the provided output schema.\n\n\
Goal:\n\
- Decide whether the task has enough information to create a confirmable TaskSpec.\n\
- If information is missing, ask one concise clarification question in assistant_message.\n\
- If information is sufficient, set ready_to_confirm=true and provide task_spec.\n\
- Never execute the task. Never say the task is already done.\n\n\
TaskSession:\n{}\n\n\
Existing TaskSpec, if any:\n{}\n\n\
Message history:\n{}\n\n\
Latest user message:\n{}\n\n\
Caller-required fields or schema:\n{}\n\n\
TaskSpec rules:\n\
- task_spec.task_type should be specific, such as todo, send_message, create_document, search_summarize, connector_action, or other.\n\
- task_spec.goal must describe the executable user intent.\n\
- task_spec.required_fields is an object of collected execution fields. Keep unknown fields out of required_fields and list them in missing_fields.\n\
- source_refs should include referenced sessions, files, documents, records, or external objects when available.\n\
- risk_level is low, medium, or high.\n\
- impact_summary explains what will happen after confirmation.\n\
- If delivery target, recipient, channel, source scope, file, time, account, permission, or failure behavior matters but is missing, set ready_to_confirm=false.\n",
        now_iso(),
        serde_json::to_string(session).unwrap_or_else(|_| "{}".to_string()),
        current_spec
            .and_then(|spec| serde_json::to_string(spec).ok())
            .unwrap_or_else(|| "null".to_string()),
        serde_json::to_string(message_history).unwrap_or_else(|_| "[]".to_string()),
        latest_message.trim(),
        serde_json::to_string(&required_fields).unwrap_or_else(|_| "null".to_string())
    )
}

fn merge_task_session_updates(session: &mut Value, input: &Value) -> Result<(), ApiError> {
    let Some(updates) = input.as_object() else {
        return Err(ApiError::bad_request(
            "task session update payload must be an object",
        ));
    };
    for (key, value) in updates {
        if matches!(key.as_str(), "user_id" | "session_id" | "created_at") {
            continue;
        }
        if key == "status" {
            let status = value
                .as_str()
                .ok_or_else(|| ApiError::bad_request("task session status must be a string"))?;
            validate_status(status, TASK_SESSION_STATUSES, "task session status")?;
        }
        set_field(session, key, value.clone());
    }
    set_field(session, "updated_at", json!(now_iso()));
    Ok(())
}

fn merge_task_spec_updates(spec: &mut Value, input: &Value) -> Result<(), ApiError> {
    let Some(updates) = input.as_object() else {
        return Err(ApiError::bad_request(
            "task spec update payload must be an object",
        ));
    };
    for (key, value) in updates {
        if matches!(
            key.as_str(),
            "user_id" | "session_id" | "task_spec_id" | "created_at"
        ) {
            continue;
        }
        if key == "status" {
            let status = value
                .as_str()
                .ok_or_else(|| ApiError::bad_request("task spec status must be a string"))?;
            validate_status(status, TASK_SPEC_STATUSES, "task spec status")?;
        }
        set_field(spec, key, value.clone());
    }
    set_field(spec, "updated_at", json!(now_iso()));
    Ok(())
}

fn merge_task_run_updates(run: &mut Value, input: &Value) -> Result<(), ApiError> {
    let Some(updates) = input.as_object() else {
        return Err(ApiError::bad_request(
            "task run update payload must be an object",
        ));
    };
    let now = now_iso();
    for (key, value) in updates {
        if matches!(
            key.as_str(),
            "user_id" | "session_id" | "run_id" | "task_spec_id" | "created_at"
        ) {
            continue;
        }
        if key == "status" {
            let status = value
                .as_str()
                .ok_or_else(|| ApiError::bad_request("task run status must be a string"))?;
            validate_status(status, TASK_RUN_STATUSES, "task run status")?;
            if status == "completed" && run.get("completed_at").is_none() {
                set_field(run, "completed_at", json!(now.clone()));
            } else if status == "failed" && run.get("failed_at").is_none() {
                set_field(run, "failed_at", json!(now.clone()));
            } else if status == "cancelled" && run.get("cancelled_at").is_none() {
                set_field(run, "cancelled_at", json!(now.clone()));
            }
        }
        set_field(run, key, value.clone());
    }
    set_field(run, "updated_at", json!(now));
    Ok(())
}

async fn append_task_session_event(
    storage: &Storage,
    user_id: &str,
    session_id: &str,
    event_type: &str,
    payload: Value,
) -> Result<Value, ApiError> {
    let now = now_iso();
    let event = event_record(user_id, session_id, event_type, payload, &now);
    storage
        .upsert_task_session_event(user_id, session_id, &event)
        .await?;
    Ok(event)
}

fn event_record(
    user_id: &str,
    session_id: &str,
    event_type: &str,
    payload: Value,
    now: &str,
) -> Value {
    json!({
        "event_id": generated_id("evt"),
        "user_id": user_id,
        "session_id": session_id,
        "event_type": event_type,
        "payload": payload,
        "created_at": now
    })
}

fn event_type_for_run_status(status: &str) -> &'static str {
    match status {
        "completed" => "task_run_completed",
        "cancelled" => "task_run_cancelled",
        "failed" => "task_run_failed",
        "waiting_user" => "task_run_waiting_user",
        _ => "task_run_updated",
    }
}

async fn task_status_sse_payload(
    storage: &Storage,
    user_id: &str,
    session_id: &str,
    event: Option<&Value>,
) -> Result<Value, ApiError> {
    let session = load_task_session(storage, user_id, session_id).await?;
    let event_type = event
        .and_then(|event| event.get("event_type"))
        .and_then(Value::as_str)
        .unwrap_or("task_status_snapshot");
    let event_payload = event
        .and_then(|event| event.get("payload"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let task_spec_id = event_payload
        .get("task_spec_id")
        .and_then(Value::as_str)
        .or_else(|| session.get("current_task_spec_id").and_then(Value::as_str))
        .map(str::to_string);
    let run_id = event_payload
        .get("run_id")
        .and_then(Value::as_str)
        .or_else(|| session.get("current_run_id").and_then(Value::as_str))
        .or_else(|| session.get("latest_run_id").and_then(Value::as_str))
        .map(str::to_string);
    let confirmation_id = event_payload
        .get("confirmation_id")
        .and_then(Value::as_str)
        .map(str::to_string);

    let run = match run_id.as_deref() {
        Some(run_id) => {
            storage
                .get_task_session_run(user_id, session_id, run_id)
                .await?
        }
        None => None,
    };
    let spec = match task_spec_id.as_deref() {
        Some(task_spec_id) => {
            storage
                .get_task_session_spec(user_id, session_id, task_spec_id)
                .await?
        }
        None => None,
    };
    let confirmation = match confirmation_id.as_deref() {
        Some(confirmation_id) => {
            storage
                .get_task_session_confirmation(user_id, session_id, confirmation_id)
                .await?
        }
        None => None,
    };

    let task_status = task_status_for_sse_event(event_type, &event_payload, &session);
    let run_status = run
        .as_ref()
        .and_then(|run| run.get("status"))
        .and_then(Value::as_str)
        .or_else(|| event_payload.get("status").and_then(Value::as_str))
        .filter(|status| TASK_RUN_STATUSES.contains(status));
    let task_spec_status = spec
        .as_ref()
        .and_then(|spec| spec.get("status"))
        .and_then(Value::as_str);
    let confirmation_status = confirmation
        .as_ref()
        .and_then(|confirmation| confirmation.get("status"))
        .and_then(Value::as_str)
        .or_else(|| {
            if event_type == "task_confirmation_responded" {
                event_payload.get("status").and_then(Value::as_str)
            } else {
                None
            }
        });
    let needs_user_action = session
        .get("needs_user_action")
        .and_then(Value::as_bool)
        .unwrap_or(task_status == "pending_confirm" || task_status == "waiting_user");

    Ok(json!({
        "type": "task_status",
        "event_version": 1,
        "event_id": event.and_then(|event| event.get("event_id")).cloned().unwrap_or(Value::Null),
        "sse_id": event.and_then(|event| event.get("seq")).cloned().unwrap_or(Value::Null),
        "created_at": event
            .and_then(|event| event.get("created_at"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(now_iso),
        "task_session_id": session_id,
        "session_id": session_id,
        "event_type": event_type,
        "task_status": task_status,
        "needs_user_action": needs_user_action,
        "task_spec_id": task_spec_id,
        "task_spec_status": task_spec_status,
        "run_id": run_id,
        "run_status": run_status,
        "external_run_id": run
            .as_ref()
            .and_then(|run| run.get("external_run_id"))
            .cloned()
            .unwrap_or(Value::Null),
        "confirmation_id": confirmation_id,
        "confirmation_status": confirmation_status,
        "latest_message": session.get("latest_message").cloned().unwrap_or(Value::Null),
        "result_summary": run
            .as_ref()
            .and_then(|run| run.get("result_summary"))
            .cloned()
            .unwrap_or(Value::Null),
        "failure_reason": run
            .as_ref()
            .and_then(|run| {
                run.get("failure_reason")
                    .or_else(|| run.get("cancellation_reason"))
            })
            .cloned()
            .unwrap_or(Value::Null),
        "task_session": task_session_sse_summary(&session),
        "payload": event_payload
    }))
}

fn task_status_for_sse_event(event_type: &str, payload: &Value, session: &Value) -> String {
    let status = match event_type {
        "task_spec_drafted" => payload
            .get("status")
            .and_then(Value::as_str)
            .or(Some("pending_confirm")),
        "task_spec_confirmed" | "task_run_started" => Some("in_progress"),
        "task_spec_ready_for_confirmation" => Some("pending_confirm"),
        "task_spec_waiting_user" => Some("waiting_user"),
        "task_confirmation_requested" | "task_run_waiting_user" => Some("waiting_user"),
        "task_run_completed" => Some("completed"),
        "task_run_cancelled" => Some("cancelled"),
        "task_run_failed" => Some("failed"),
        "task_run_updated" => payload.get("status").and_then(Value::as_str),
        _ => session.get("status").and_then(Value::as_str),
    };
    status.unwrap_or("in_progress").to_string()
}

fn task_session_sse_summary(session: &Value) -> Value {
    let mut summary = Map::new();
    for key in [
        "session_id",
        "title",
        "status",
        "needs_user_action",
        "source_surface",
        "source_id",
        "task_type",
        "goal",
        "current_task_spec_id",
        "current_run_id",
        "latest_run_id",
        "latest_message",
        "updated_at",
    ] {
        if let Some(value) = session.get(key) {
            summary.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(summary)
}

fn is_terminal_task_session_status(status: &str) -> bool {
    TERMINAL_TASK_SESSION_STATUSES.contains(&status)
}

fn last_event_id_seq_from_headers(headers: &HeaderMap) -> Option<i64> {
    headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<i64>().ok())
}

fn sse_json_event(event_name: &str, id: Option<&str>, value: &Value) -> Bytes {
    let mut frame = String::new();
    if let Some(id) = id {
        frame.push_str("id: ");
        frame.push_str(&sanitize_sse_field(id));
        frame.push('\n');
    }
    frame.push_str("event: ");
    frame.push_str(&sanitize_sse_field(event_name));
    frame.push('\n');
    frame.push_str("data: ");
    frame.push_str(&serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string()));
    frame.push_str("\n\n");
    Bytes::from(frame)
}

fn sanitize_sse_field(value: &str) -> String {
    value
        .chars()
        .filter(|ch| *ch != '\r' && *ch != '\n')
        .collect()
}

fn now_epoch_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn validate_status(status: &str, allowed: &[&str], label: &str) -> Result<(), ApiError> {
    if allowed.contains(&status) {
        Ok(())
    } else {
        Err(ApiError::bad_request(format!("invalid {label}: {status}")))
    }
}

fn validate_record_id(value: &str, field: &str) -> Result<(), ApiError> {
    if value.is_empty() || value.len() > 64 {
        return Err(ApiError::bad_request(format!(
            "{field} must be 1-64 characters"
        )));
    }
    if value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        Ok(())
    } else {
        Err(ApiError::bad_request(format!(
            "{field} must match ^[a-zA-Z0-9_-]{{1,64}}$"
        )))
    }
}

fn required_str<'a>(value: &'a Value, key: &str) -> Result<&'a str, ApiError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request(format!("{key} is required")))
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn set_field(value: &mut Value, key: &str, next: Value) {
    if let Some(object) = value.as_object_mut() {
        object.insert(key.to_string(), next);
    }
}

fn generated_id(prefix: &str) -> String {
    format!("{prefix}-{}", &Uuid::new_v4().simple().to_string()[..12])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_storage() -> anyhow::Result<(Storage, std::path::PathBuf)> {
        let root =
            std::env::temp_dir().join(format!("ripple-task-sessions-test-{}", Uuid::new_v4()));
        let storage = Storage::open(root.join(".ripple/ripple.sqlite"))?;
        Ok((storage, root))
    }

    #[tokio::test]
    async fn task_session_spec_run_lifecycle_persists_projection() -> anyhow::Result<()> {
        let (storage, root) = temp_storage()?;
        let user_id = "alice";
        let now = "2026-07-08T00:00:00Z";
        let session = task_session_from_payload(
            &json!({
                "session_id": "ts-test",
                "title": "发送消息",
                "source_surface": "record_detail",
                "source_id": "record-1"
            }),
            user_id,
            now,
        )
        .expect("task session payload should be valid");
        storage.upsert_task_session(user_id, &session).await?;

        let spec = task_spec_from_payload(
            &json!({
                "task_spec_id": "spec-test",
                "task_type": "send_message",
                "goal": "把行动项发给张三",
                "required_fields": {"channel": "feishu"}
            }),
            user_id,
            "ts-test",
            now,
        )
        .expect("task spec payload should be valid");
        storage
            .upsert_task_session_spec(user_id, "ts-test", &spec)
            .await?;

        let run = create_task_run_record(
            &storage,
            user_id,
            "ts-test",
            "spec-test",
            &json!({"run_id": "run-test"}),
        )
        .await
        .expect("task run should start");
        assert_eq!(
            run.get("status").and_then(Value::as_str),
            Some("in_progress")
        );

        let mut completed = run.clone();
        merge_task_run_updates(
            &mut completed,
            &json!({"status": "completed", "result_summary": "已生成消息草稿"}),
        )
        .expect("task run update should be valid");
        persist_task_run_status_projection(&storage, user_id, "ts-test", &completed)
            .await
            .expect("task run projection should persist");

        let detail = task_session_detail(&storage, user_id, "ts-test")
            .await
            .expect("task session detail should load");
        assert_eq!(
            detail
                .pointer("/task_session/status")
                .and_then(Value::as_str),
            Some("completed")
        );
        assert_eq!(
            detail
                .pointer("/task_specs/0/status")
                .and_then(Value::as_str),
            Some("completed")
        );
        assert!(detail
            .get("events")
            .and_then(Value::as_array)
            .is_some_and(|events| events.len() >= 2));

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn invalid_task_session_status_is_rejected() {
        let result = task_session_from_payload(
            &json!({"session_id": "ts-test", "status": "active"}),
            "alice",
            "2026-07-08T00:00:00Z",
        );
        assert!(result.is_err());
    }
}
