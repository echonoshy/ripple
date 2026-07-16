use std::convert::Infallible;

use async_stream::stream;
use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::time::{sleep, Duration};
use tracing::warn;
use uuid::Uuid;

use crate::api::connectors::{connector_auth_start_action, connector_status_value};
use crate::api::users::assert_can_create_run;
use crate::api::{paginate, ApiError, ListQuery};
use crate::auth::now_iso;
use crate::jobs::{AgentRunCreateRequest, AgentRunInfo};
use crate::state::AppState;
use crate::storage::Storage;
use crate::user::user_id_from_headers;

#[derive(Debug, Deserialize, Default)]
pub struct TaskSessionListQuery {
    pub limit: Option<usize>,
    pub cursor: Option<String>,
    pub req_id: Option<String>,
}

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

const RIPPLE_EXECUTORS: &[&str] = &["ripple", "vitana", "ripple_vitana"];

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
    Query(query): Query<TaskSessionListQuery>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let records = state
        .storage
        .list_task_sessions(&user_id)
        .await?
        .into_iter()
        .filter(|session| {
            query.req_id.as_deref().map_or(true, |req_id| {
                session.get("req_id").and_then(Value::as_str) == Some(req_id)
            })
        })
        .collect::<Vec<_>>();
    let query_page = ListQuery {
        limit: query.limit,
        cursor: query.cursor,
    };
    let (records, next_cursor) = paginate(records, &query_page)?;
    let mut items = Vec::with_capacity(records.len());
    for session in records {
        items.push(simple_task_session_from_record(&state.storage, &user_id, session).await?);
    }
    Ok(Json(json!({
        "items": items,
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
    if let Some(response) =
        load_task_command_replay(&state.storage, &user_id, "create", &input).await?
    {
        return Ok(Json(response));
    }
    let _ = required_str(&input, "req_id")?;
    let _ = required_str(&input, "idempotency_key")?;
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
        .or_else(|| input.get("content"))
        .cloned();
    if let Some(message) = initial_message.as_ref() {
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
        set_field(&mut session, "draft_version", json!(1));
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

    let mut assistant_message = None;
    if created_spec.is_none() {
        if let Some(message) = initial_message.as_ref().and_then(Value::as_str) {
            let extraction = extract_task_spec_turn_with_codex(
                &state,
                &user_id,
                &session_id,
                &session,
                None,
                &input,
                message,
            )
            .await?;
            let projection = persist_task_spec_turn_projection(
                &state.storage,
                &user_id,
                &session_id,
                &session,
                None,
                extraction,
            )
            .await?;
            assistant_message = Some(projection.assistant_message);
        }
    }
    let public_session =
        simple_task_session_from_storage(&state.storage, &user_id, &session_id).await?;
    let mut response = json!({"task_session": public_session});
    if let Some(message) = assistant_message {
        set_field(&mut response, "assistant_message", json!(message));
    }
    save_task_command_response(&state.storage, &user_id, "create", &input, &response).await?;
    Ok(Json(response))
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
    maybe_resume_after_connector_auth(&state, &user_id, &session_id).await?;
    Ok(Json(json!({
        "task_session": simple_task_session_from_storage(&state.storage, &user_id, &session_id).await?
    })))
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
    let action = format!("message:{session_id}");
    if let Some(response) =
        load_task_command_replay(&state.storage, &user_id, &action, &input).await?
    {
        return Ok(Json(response));
    }
    let session = load_task_session(&state.storage, &user_id, &session_id).await?;
    validate_task_req_id(&session, &input)?;
    validate_expected_draft_version(&session, &input, "expected_draft_version")?;
    let content = string_field(&input, "content")
        .or_else(|| string_field(&input, "message"))
        .ok_or_else(|| ApiError::bad_request("message content is required"))?;
    append_task_session_event(
        &state.storage,
        &user_id,
        &session_id,
        "task_session_message",
        json!({
            "role": "user",
            "content": content,
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
        &content,
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
    let response = json!({
        "task_session": simple_task_session_from_storage(&state.storage, &user_id, &session_id).await?,
        "assistant_message": projection.assistant_message
    });
    save_task_command_response(&state.storage, &user_id, &action, &input, &response).await?;
    Ok(Json(response))
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
    merge_callback_fields(&mut session, &input);
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
        let run = create_task_run_record(
            &state.storage,
            &user_id,
            &session_id,
            &confirmed_task_spec_id,
            &input,
        )
        .await?;
        maybe_start_ripple_task_execution(
            state.clone(),
            user_id.clone(),
            session_id.clone(),
            run.clone(),
            spec.clone(),
            &input,
        );
        Some(run)
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
    path = "/task-sessions/{task_id}/confirm",
    tag = "task-sessions",
    params(("task_id" = String, Path, description = "Task session id")),
    request_body = crate::api::openapi::GenericJsonObject,
    responses(
        (status = 200, description = "Confirmed task and started execution", body = serde_json::Value),
        (status = 400, description = "Invalid confirmation", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 409, description = "Draft version conflict", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(("bearerAuth" = []), ("apiKeyAuth" = []))
)]
pub async fn confirm_task_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let action = format!("confirm:{session_id}");
    if let Some(response) =
        load_task_command_replay(&state.storage, &user_id, &action, &input).await?
    {
        return Ok(Json(response));
    }
    let session = load_task_session(&state.storage, &user_id, &session_id).await?;
    validate_task_req_id(&session, &input)?;
    let spec = current_task_spec(&state.storage, &user_id, &session_id, &session)
        .await?
        .ok_or_else(|| {
            ApiError::conflict(json!({
                "code": "task_draft_not_ready",
                "message": "任务草稿尚未准备完成。",
                "task_id": session_id,
                "req_id": input.get("req_id").cloned().unwrap_or(Value::Null)
            }))
        })?;
    let now = now_iso();
    let (confirmed_session, confirmed_spec) =
        freeze_task_confirmation(&session, &spec, &input, &now)?;
    state
        .storage
        .upsert_task_session_spec(&user_id, &session_id, &confirmed_spec)
        .await?;
    state
        .storage
        .upsert_task_session(&user_id, &confirmed_session)
        .await?;
    append_task_session_event(
        &state.storage,
        &user_id,
        &session_id,
        "task_spec_confirmed",
        json!({
            "task_spec_id": confirmed_spec.get("task_spec_id").cloned().unwrap_or(Value::Null),
            "draft_version": confirmed_session.get("draft_version").cloned().unwrap_or(Value::Null)
        }),
    )
    .await?;

    let task_spec_id = required_str(&confirmed_spec, "task_spec_id")?.to_string();
    let mut execution_input = input.clone();
    set_field(&mut execution_input, "auto_execute", json!(true));
    set_field(&mut execution_input, "executor", json!("ripple"));
    let mut run = create_task_run_record(
        &state.storage,
        &user_id,
        &session_id,
        &task_spec_id,
        &execution_input,
    )
    .await?;

    let missing_connector = first_missing_connector(&state, &user_id, &confirmed_spec).await?;
    if let Some(connector) = missing_connector {
        let auth = connector_auth_start_action(
            &state,
            &user_id,
            &connector,
            &json!({
                "task_id": session_id,
                "execution_id": run.get("run_id").cloned().unwrap_or(Value::Null)
            }),
            None,
        )
        .await?
        .0;
        set_field(&mut run, "status", json!("waiting_user"));
        set_field(&mut run, "updated_at", json!(now_iso()));
        persist_task_run_status_projection(&state.storage, &user_id, &session_id, &run).await?;
        let mut waiting_session = load_task_session(&state.storage, &user_id, &session_id).await?;
        let auth_url = auth
            .pointer("/data/oauth_url")
            .or_else(|| auth.pointer("/data/auth_url"))
            .or_else(|| auth.get("oauth_url"))
            .or_else(|| auth.get("auth_url"))
            .cloned()
            .unwrap_or(Value::Null);
        let mut required_action = json!({
            "type": "connector_auth",
            "message": format!("需要完成 {connector} 授权后继续执行。"),
            "connector": connector,
            "auth_url": auth_url
        });
        if let Some(expires) = auth
            .pointer("/data/expires_at")
            .or_else(|| auth.pointer("/data/expires_in_seconds"))
        {
            set_field(&mut required_action, "expires_at", expires.clone());
        }
        set_field(
            &mut waiting_session,
            "waiting_reason",
            json!("connector_auth"),
        );
        set_field(&mut waiting_session, "required_action", required_action);
        set_field(&mut waiting_session, "needs_user_action", json!(true));
        set_field(&mut waiting_session, "updated_at", json!(now_iso()));
        state
            .storage
            .upsert_task_session(&user_id, &waiting_session)
            .await?;
    } else {
        maybe_start_ripple_task_execution(
            state.clone(),
            user_id.clone(),
            session_id.clone(),
            run,
            confirmed_spec,
            &execution_input,
        );
    }

    let response = json!({
        "task_session": simple_task_session_from_storage(&state.storage, &user_id, &session_id).await?
    });
    save_task_command_response(&state.storage, &user_id, &action, &input, &response).await?;
    Ok(Json(response))
}

fn freeze_task_confirmation(
    session: &Value,
    spec: &Value,
    input: &Value,
    now: &str,
) -> Result<(Value, Value), ApiError> {
    validate_task_req_id(session, input)?;
    let version = validate_expected_draft_version(session, input, "draft_version")?;
    if session.get("status").and_then(Value::as_str) != Some("pending_confirm") {
        return Err(ApiError::conflict(json!({
            "code": "task_not_pending_confirmation",
            "message": "任务当前不在待确认状态。",
            "task_id": session.get("session_id").cloned().unwrap_or(Value::Null),
            "req_id": input.get("req_id").cloned().unwrap_or(Value::Null)
        })));
    }
    let mut next_session = session.clone();
    set_field(&mut next_session, "status", json!("in_progress"));
    set_field(&mut next_session, "needs_user_action", json!(false));
    set_field(&mut next_session, "confirmed_version", json!(version));
    set_field(&mut next_session, "waiting_reason", Value::Null);
    set_field(&mut next_session, "required_action", Value::Null);
    set_field(&mut next_session, "updated_at", json!(now));
    let mut next_spec = spec.clone();
    set_field(&mut next_spec, "status", json!("confirmed"));
    set_field(&mut next_spec, "confirmed_at", json!(now));
    set_field(&mut next_spec, "updated_at", json!(now));
    Ok((next_session, next_spec))
}

async fn first_missing_connector(
    state: &AppState,
    user_id: &str,
    spec: &Value,
) -> Result<Option<String>, ApiError> {
    let draft = simple_task_draft(spec);
    let connectors = draft
        .get("required_connectors")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for connector in connectors {
        let Some(connector) = connector.as_str() else {
            continue;
        };
        let status = connector_status_value(state, user_id, connector).await?;
        if status.get("connected").and_then(Value::as_bool) != Some(true) {
            return Ok(Some(connector.to_string()));
        }
    }
    Ok(None)
}

fn waiting_connector_name(session: &Value) -> Option<&str> {
    if session.get("status").and_then(Value::as_str) != Some("waiting_user")
        || session.get("waiting_reason").and_then(Value::as_str) != Some("connector_auth")
        || session
            .pointer("/required_action/type")
            .and_then(Value::as_str)
            != Some("connector_auth")
    {
        return None;
    }
    session
        .pointer("/required_action/connector")
        .and_then(Value::as_str)
}

async fn maybe_resume_after_connector_auth(
    state: &AppState,
    user_id: &str,
    session_id: &str,
) -> Result<(), ApiError> {
    let session = load_task_session(&state.storage, user_id, session_id).await?;
    let Some(connector) = waiting_connector_name(&session) else {
        return Ok(());
    };
    let status = connector_status_value(state, user_id, connector).await?;
    if status.get("connected").and_then(Value::as_bool) != Some(true) {
        return Ok(());
    }
    let Some(mut run) = current_task_run(&state.storage, user_id, session_id, &session).await?
    else {
        return Ok(());
    };
    if run.get("status").and_then(Value::as_str) != Some("waiting_user") {
        return Ok(());
    }
    let Some(spec) = current_task_spec(&state.storage, user_id, session_id, &session).await? else {
        return Ok(());
    };
    set_field(&mut run, "status", json!("in_progress"));
    set_field(&mut run, "updated_at", json!(now_iso()));
    persist_task_run_status_projection(&state.storage, user_id, session_id, &run).await?;
    let mut resumed_session = load_task_session(&state.storage, user_id, session_id).await?;
    set_field(&mut resumed_session, "waiting_reason", Value::Null);
    set_field(&mut resumed_session, "required_action", Value::Null);
    set_field(&mut resumed_session, "needs_user_action", json!(false));
    set_field(&mut resumed_session, "updated_at", json!(now_iso()));
    state
        .storage
        .upsert_task_session(user_id, &resumed_session)
        .await?;
    let mut execution_input = json!({
        "auto_execute": true,
        "executor": "ripple",
        "req_id": session.get("req_id").cloned().unwrap_or(Value::Null)
    });
    for key in ["model", "effort"] {
        if let Some(value) = run.get(key) {
            set_field(&mut execution_input, key, value.clone());
        }
    }
    maybe_start_ripple_task_execution(
        state.clone(),
        user_id.to_string(),
        session_id.to_string(),
        run,
        spec,
        &execution_input,
    );
    Ok(())
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
    let spec = load_task_session_spec(&state.storage, &user_id, &session_id, &task_spec_id).await?;
    maybe_start_ripple_task_execution(
        state.clone(),
        user_id.clone(),
        session_id.clone(),
        run.clone(),
        spec,
        &input,
    );
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
    post,
    path = "/task-sessions/{task_id}/cancel",
    tag = "task-sessions",
    params(("task_id" = String, Path, description = "Task session id")),
    request_body = crate::api::openapi::GenericJsonObject,
    responses(
        (status = 200, description = "Cancelled task", body = serde_json::Value),
        (status = 400, description = "Invalid cancellation", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 409, description = "Task is already terminal", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(("bearerAuth" = []), ("apiKeyAuth" = []))
)]
pub async fn cancel_task_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let action = format!("cancel:{session_id}");
    if let Some(response) =
        load_task_command_replay(&state.storage, &user_id, &action, &input).await?
    {
        return Ok(Json(response));
    }
    let session = load_task_session(&state.storage, &user_id, &session_id).await?;
    let run = current_task_run(&state.storage, &user_id, &session_id, &session).await?;
    let (cancelled_session, cancelled_run) =
        cancel_task_records(&session, run.as_ref(), &input, &now_iso())?;
    if let Some(run) = cancelled_run.as_ref() {
        persist_task_run_status_projection(&state.storage, &user_id, &session_id, run).await?;
    } else if session.get("status").and_then(Value::as_str) != Some("cancelled") {
        append_task_session_event(
            &state.storage,
            &user_id,
            &session_id,
            "task_run_cancelled",
            json!({
                "reason": input.get("reason").cloned().unwrap_or_else(|| json!("cancelled_by_user"))
            }),
        )
        .await?;
    }
    state
        .storage
        .upsert_task_session(&user_id, &cancelled_session)
        .await?;
    let response = json!({
        "task_session": simple_task_session_from_storage(&state.storage, &user_id, &session_id).await?
    });
    save_task_command_response(&state.storage, &user_id, &action, &input, &response).await?;
    Ok(Json(response))
}

fn cancel_task_records(
    session: &Value,
    run: Option<&Value>,
    input: &Value,
    now: &str,
) -> Result<(Value, Option<Value>), ApiError> {
    validate_task_req_id(session, input)?;
    let status = session
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("waiting_user");
    if matches!(status, "completed" | "failed") {
        return Err(ApiError::conflict(json!({
            "code": "task_already_terminal",
            "message": "已经结束的任务不能取消。",
            "task_id": session.get("session_id").cloned().unwrap_or(Value::Null),
            "req_id": input.get("req_id").cloned().unwrap_or(Value::Null)
        })));
    }
    if status == "cancelled" {
        return Ok((session.clone(), run.cloned()));
    }
    let reason = input
        .get("reason")
        .cloned()
        .unwrap_or_else(|| json!("cancelled_by_user"));
    let mut cancelled_session = session.clone();
    set_field(&mut cancelled_session, "status", json!("cancelled"));
    set_field(&mut cancelled_session, "needs_user_action", json!(false));
    set_field(&mut cancelled_session, "waiting_reason", Value::Null);
    set_field(&mut cancelled_session, "required_action", Value::Null);
    set_field(&mut cancelled_session, "updated_at", json!(now));
    let cancelled_run = run.map(|run| {
        let mut run = run.clone();
        set_field(&mut run, "status", json!("cancelled"));
        set_field(&mut run, "cancelled_at", json!(now));
        set_field(&mut run, "cancellation_reason", reason);
        set_field(&mut run, "updated_at", json!(now));
        run
    });
    Ok((cancelled_session, cancelled_run))
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

fn simple_task_session_view(session: &Value, spec: Option<&Value>, run: Option<&Value>) -> Value {
    let internal_status = session
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("waiting_user");
    let run_status = run
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str);
    let status = simple_task_status(internal_status, spec, run_status);
    let phase = simple_task_phase(&status, spec, run);

    let mut view = Map::new();
    view.insert(
        "task_id".to_string(),
        session.get("session_id").cloned().unwrap_or(Value::Null),
    );
    for key in [
        "req_id",
        "title",
        "model",
        "effort",
        "waiting_reason",
        "needs_user_action",
        "draft_version",
        "latest_message",
        "callback_url",
    ] {
        copy_optional_field(&mut view, key, session, key);
    }
    view.insert("status".to_string(), json!(status));
    view.insert("phase".to_string(), json!(phase));
    copy_optional_field(&mut view, "created_at", session, "created_at");
    copy_optional_field(&mut view, "updated_at", session, "updated_at");

    if let Some(spec) = spec {
        let draft = simple_task_draft(spec);
        view.insert("task_draft".to_string(), draft.clone());
        if task_spec_is_confirmed(spec) {
            let mut confirmed = draft.as_object().cloned().unwrap_or_default();
            confirmed.insert(
                "confirmed_version".to_string(),
                session
                    .get("draft_version")
                    .cloned()
                    .or_else(|| spec.get("version").cloned())
                    .unwrap_or_else(|| json!(1)),
            );
            if let Some(confirmed_at) = spec.get("confirmed_at") {
                confirmed.insert("confirmed_at".to_string(), confirmed_at.clone());
            }
            view.insert("confirmed_task".to_string(), Value::Object(confirmed));
        }
    }

    if let Some(run) = run {
        view.insert("current_execution".to_string(), simple_execution_view(run));
    }
    if let Some(required_action) = simple_required_action(session, &status) {
        view.insert("required_action".to_string(), required_action);
    }
    Value::Object(view)
}

fn simple_task_status(
    session_status: &str,
    spec: Option<&Value>,
    run_status: Option<&str>,
) -> &'static str {
    match run_status.unwrap_or(session_status) {
        "in_progress" => "running",
        "completed" => "completed",
        "cancelled" => "cancelled",
        "failed" => "failed",
        "pending_confirm" => "pending_confirmation",
        "waiting_user" if run_status.is_some() => "waiting_user",
        "waiting_user"
            if spec
                .and_then(|value| value.get("status"))
                .and_then(Value::as_str)
                == Some("pending_confirm") =>
        {
            "pending_confirmation"
        }
        "waiting_user" => "waiting_user",
        "queued" => "queued",
        "analyzing" => "analyzing",
        _ => "waiting_user",
    }
}

fn simple_task_phase(status: &str, spec: Option<&Value>, run: Option<&Value>) -> &'static str {
    match status {
        "pending_confirmation" => "confirmation",
        "queued" | "running" => "execution",
        "waiting_user" if run.is_some() => "execution",
        "completed" | "cancelled" | "failed" => "terminal",
        _ if run.is_some() => "execution",
        _ if spec.is_some() => "draft",
        _ => "draft",
    }
}

fn simple_task_draft(spec: &Value) -> Value {
    let required_fields = spec
        .get("parameters")
        .or_else(|| spec.get("required_fields"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let connector = spec
        .get("connector")
        .and_then(Value::as_str)
        .or_else(|| required_fields.get("connector").and_then(Value::as_str))
        .or_else(|| required_fields.get("channel").and_then(Value::as_str))
        .map(str::to_string);
    let action = spec
        .get("action")
        .and_then(Value::as_str)
        .or_else(|| spec.get("task_type").and_then(Value::as_str));
    let summary = spec
        .get("summary")
        .and_then(Value::as_str)
        .or_else(|| spec.get("impact_summary").and_then(Value::as_str))
        .or_else(|| spec.get("goal").and_then(Value::as_str));

    let mut draft = Map::new();
    if let Some(action) = action {
        draft.insert("action".to_string(), json!(action));
    }
    if let Some(connector) = connector.as_deref() {
        draft.insert("connector".to_string(), json!(connector));
    }
    if let Some(summary) = summary {
        draft.insert("summary".to_string(), json!(summary));
    }
    draft.insert("parameters".to_string(), required_fields);
    if let Some(required_connectors) = spec.get("required_connectors") {
        draft.insert(
            "required_connectors".to_string(),
            required_connectors.clone(),
        );
    } else if let Some(connector) = connector.as_deref() {
        draft.insert("required_connectors".to_string(), json!([connector]));
    }
    Value::Object(draft)
}

fn simple_execution_view(run: &Value) -> Value {
    let mut execution = Map::new();
    execution.insert(
        "execution_id".to_string(),
        run.get("run_id").cloned().unwrap_or(Value::Null),
    );
    let status = run
        .get("status")
        .and_then(Value::as_str)
        .map(|value| simple_task_status(value, None, Some(value)))
        .unwrap_or("running");
    execution.insert("status".to_string(), json!(status));
    for key in [
        "external_run_id",
        "started_at",
        "completed_at",
        "result_summary",
        "result",
        "failure_reason",
        "cancellation_reason",
    ] {
        copy_optional_field(&mut execution, key, run, key);
    }
    Value::Object(execution)
}

fn simple_required_action(session: &Value, status: &str) -> Option<Value> {
    if let Some(action) = session
        .get("required_action")
        .filter(|value| value.is_object())
    {
        return Some(action.clone());
    }
    match status {
        "waiting_user" => Some(json!({
            "type": "reply",
            "message": session.get("latest_message").cloned().unwrap_or_else(|| json!("请补充任务信息。"))
        })),
        "pending_confirmation" => Some(json!({
            "type": "confirm",
            "message": "任务信息已完整，请确认。",
            "draft_version": session.get("draft_version").cloned().unwrap_or_else(|| json!(1))
        })),
        _ => None,
    }
}

fn task_spec_is_confirmed(spec: &Value) -> bool {
    matches!(
        spec.get("status").and_then(Value::as_str),
        Some("confirmed" | "in_progress" | "waiting_user" | "completed" | "cancelled" | "failed")
    )
}

fn copy_optional_field(
    target: &mut Map<String, Value>,
    target_key: &str,
    source: &Value,
    source_key: &str,
) {
    if let Some(value) = source.get(source_key).filter(|value| !value.is_null()) {
        target.insert(target_key.to_string(), value.clone());
    }
}

async fn load_task_command_replay(
    storage: &Storage,
    user_id: &str,
    action: &str,
    input: &Value,
) -> Result<Option<Value>, ApiError> {
    let req_id = required_str(input, "req_id")?;
    let idempotency_key = required_str(input, "idempotency_key")?;
    let Some(stored) = storage
        .get_task_session_idempotency(user_id, action, idempotency_key)
        .await?
    else {
        return Ok(None);
    };
    if stored.get("request") != Some(input) {
        return Err(ApiError::conflict(json!({
            "code": "idempotency_conflict",
            "message": "同一个幂等键不能用于不同的请求。",
            "task_id": input.get("task_id").cloned().unwrap_or(Value::Null),
            "req_id": req_id
        })));
    }
    Ok(stored.get("response").cloned())
}

async fn save_task_command_response(
    storage: &Storage,
    user_id: &str,
    action: &str,
    input: &Value,
    response: &Value,
) -> Result<(), ApiError> {
    let idempotency_key = required_str(input, "idempotency_key")?;
    let inserted = storage
        .save_task_session_idempotency(
            user_id,
            action,
            idempotency_key,
            input,
            response,
            &now_iso(),
        )
        .await?;
    if inserted {
        return Ok(());
    }
    let replay = load_task_command_replay(storage, user_id, action, input).await?;
    if replay.as_ref() == Some(response) {
        Ok(())
    } else {
        Err(ApiError::conflict(json!({
            "code": "idempotency_conflict",
            "message": "幂等请求已经由另一个操作处理。",
            "req_id": input.get("req_id").cloned().unwrap_or(Value::Null)
        })))
    }
}

fn validate_expected_draft_version(
    session: &Value,
    input: &Value,
    field: &str,
) -> Result<u64, ApiError> {
    let expected = input.get(field).and_then(Value::as_u64).ok_or_else(|| {
        ApiError::bad_request(json!({
            "code": "missing_draft_version",
            "message": format!("{field} is required")
        }))
    })?;
    let current = session
        .get("draft_version")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if expected != current {
        return Err(ApiError::conflict(json!({
            "code": "draft_version_conflict",
            "message": "任务草稿已经更新，请刷新后重新确认。",
            "task_id": session.get("session_id").cloned().unwrap_or(Value::Null),
            "req_id": input.get("req_id").cloned().unwrap_or(Value::Null)
        })));
    }
    Ok(current)
}

fn validate_task_req_id(session: &Value, input: &Value) -> Result<(), ApiError> {
    let req_id = required_str(input, "req_id")?;
    if session.get("req_id").and_then(Value::as_str) != Some(req_id) {
        return Err(ApiError::conflict(json!({
            "code": "req_id_conflict",
            "message": "req_id 与任务创建时不一致。",
            "task_id": session.get("session_id").cloned().unwrap_or(Value::Null),
            "req_id": req_id
        })));
    }
    Ok(())
}

async fn simple_task_session_from_storage(
    storage: &Storage,
    user_id: &str,
    session_id: &str,
) -> Result<Value, ApiError> {
    let session = load_task_session(storage, user_id, session_id).await?;
    simple_task_session_from_record(storage, user_id, session).await
}

async fn simple_task_session_from_record(
    storage: &Storage,
    user_id: &str,
    session: Value,
) -> Result<Value, ApiError> {
    let session_id = required_str(&session, "session_id")?;
    let spec = current_task_spec(storage, user_id, session_id, &session).await?;
    let run = current_task_run(storage, user_id, session_id, &session).await?;
    Ok(simple_task_session_view(
        &session,
        spec.as_ref(),
        run.as_ref(),
    ))
}

async fn current_task_run(
    storage: &Storage,
    user_id: &str,
    session_id: &str,
    session: &Value,
) -> Result<Option<Value>, ApiError> {
    let run_id = session
        .get("current_run_id")
        .or_else(|| session.get("latest_run_id"))
        .and_then(Value::as_str);
    if let Some(run_id) = run_id {
        storage
            .get_task_session_run(user_id, session_id, run_id)
            .await
            .map_err(ApiError::from)
    } else {
        Ok(storage
            .list_task_session_runs(user_id, session_id)
            .await?
            .into_iter()
            .last())
    }
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
    record.remove("content");
    record.remove("idempotency_key");
    record.remove("expected_draft_version");
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
    record
        .entry("draft_version".to_string())
        .or_insert_with(|| json!(0));
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
    for key in ["model", "effort"] {
        if let Some(value) = payload.get(key) {
            record.insert(key.to_string(), value.clone());
        }
    }
    copy_callback_fields(&mut record, &session);
    copy_callback_fields(&mut record, payload);
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
    merge_callback_fields(&mut session, payload);
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

fn maybe_start_ripple_task_execution(
    state: AppState,
    user_id: String,
    session_id: String,
    run: Value,
    task_spec: Value,
    input: &Value,
) {
    if !ripple_execution_requested(input) {
        return;
    }

    let input = input.clone();
    tokio::spawn(async move {
        if let Err(err) = run_ripple_task_execution(
            state,
            user_id.clone(),
            session_id.clone(),
            run,
            task_spec,
            input,
        )
        .await
        {
            warn!(
                user_id = %user_id,
                session_id = %session_id,
                error = ?err,
                "Ripple task execution failed before status projection"
            );
        }
    });
}

async fn run_ripple_task_execution(
    state: AppState,
    user_id: String,
    session_id: String,
    run: Value,
    task_spec: Value,
    input: Value,
) -> Result<(), ApiError> {
    let run_id = required_str(&run, "run_id")?.to_string();
    let task_spec_id = required_str(&run, "task_spec_id")?.to_string();
    let max_runtime_seconds = input
        .get("max_runtime_seconds")
        .and_then(Value::as_u64)
        .unwrap_or(state.config.codex.max_runtime_seconds)
        .clamp(1, 86_400);

    if let Err(err) = assert_can_create_run(&state, &user_id, max_runtime_seconds).await {
        let mut failed = run.clone();
        set_field(&mut failed, "status", json!("failed"));
        set_field(
            &mut failed,
            "failure_reason",
            json!(format!("Ripple executor could not start: {err:?}")),
        );
        persist_task_run_status_projection(&state.storage, &user_id, &session_id, &failed).await?;
        return Ok(());
    }

    let workspace_root = match state.sandboxes.ensure_sandbox(&user_id) {
        Ok(path) => path,
        Err(err) => {
            let mut failed = run.clone();
            set_field(&mut failed, "status", json!("failed"));
            set_field(
                &mut failed,
                "failure_reason",
                json!(format!("Ripple executor sandbox failed: {err}")),
            );
            persist_task_run_status_projection(&state.storage, &user_id, &session_id, &failed)
                .await?;
            return Ok(());
        }
    };
    let runtime_dir = match state.sandboxes.sandbox_dir(&user_id) {
        Ok(path) => path.join("agent-runs"),
        Err(err) => {
            let mut failed = run.clone();
            set_field(&mut failed, "status", json!("failed"));
            set_field(
                &mut failed,
                "failure_reason",
                json!(format!("Ripple executor runtime directory failed: {err}")),
            );
            persist_task_run_status_projection(&state.storage, &user_id, &session_id, &failed)
                .await?;
            return Ok(());
        }
    };

    let session = load_task_session(&state.storage, &user_id, &session_id).await?;
    let (model, effort) = resolve_task_model_effort(&state, &session, &input);
    let prompt = build_ripple_task_execution_prompt(&session, &task_spec, &run);
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
        output_schema: None,
        max_runtime_seconds,
        task_trigger_id: None,
        task_trigger_title: None,
        task_trigger_reason: None,
        codex_thread_id: None,
        codex_persistent_thread: false,
        client_request_id: string_field(&input, "client_request_id")
            .or_else(|| string_field(&input, "req_id")),
        chat_user_input: None,
        chat_user_content: None,
    };

    let info = state
        .jobs
        .start(
            create,
            user_id.clone(),
            Some(session_id.clone()),
            workspace_root,
            runtime_dir,
        )
        .await;

    match info {
        Ok(info) => {
            let mut updated_run = state
                .storage
                .get_task_session_run(&user_id, &session_id, &run_id)
                .await?
                .unwrap_or(run);
            set_field(&mut updated_run, "external_run_id", json!(info.job_id));
            set_field(&mut updated_run, "task_spec_id", json!(task_spec_id));
            set_field(&mut updated_run, "updated_at", json!(now_iso()));
            state
                .storage
                .upsert_task_session_run(&user_id, &session_id, &updated_run)
                .await?;
            monitor_task_execution_job(state, user_id, session_id, run_id, info.job_id).await?;
        }
        Err(err) => {
            let mut updated_run = state
                .storage
                .get_task_session_run(&user_id, &session_id, &run_id)
                .await?
                .unwrap_or(run);
            if !should_apply_execution_result(&updated_run) {
                return Ok(());
            }
            set_field(&mut updated_run, "status", json!("failed"));
            set_field(
                &mut updated_run,
                "failure_reason",
                json!(format!("Ripple executor failed: {err}")),
            );
            set_field(&mut updated_run, "task_spec_id", json!(task_spec_id));
            persist_task_run_status_projection(&state.storage, &user_id, &session_id, &updated_run)
                .await?;
        }
    }
    Ok(())
}

async fn monitor_task_execution_job(
    state: AppState,
    user_id: String,
    session_id: String,
    run_id: String,
    job_id: String,
) -> Result<(), ApiError> {
    loop {
        let Some(info) = state.jobs.info_for_user(&job_id, &user_id).await? else {
            return Ok(());
        };
        if matches!(info.status.as_str(), "queued" | "running") {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            continue;
        }
        let Some(mut run) = state
            .storage
            .get_task_session_run(&user_id, &session_id, &run_id)
            .await?
        else {
            return Ok(());
        };
        if matches!(
            run.get("status").and_then(Value::as_str),
            Some("completed" | "failed" | "cancelled")
        ) {
            return Ok(());
        }
        if info.status == "completed" {
            let output = read_agent_run_output(&info).await;
            let execution_result = task_execution_result_from_output(&output);
            set_field(&mut run, "status", json!("completed"));
            set_field(
                &mut run,
                "result_summary",
                json!(execution_result.result_summary),
            );
            if let Some(result) = execution_result.result {
                set_field(&mut run, "result", result);
            }
        } else {
            let reason = info
                .error
                .or_else(|| {
                    let tail = info.stderr_tail.trim();
                    (!tail.is_empty()).then(|| tail.to_string())
                })
                .unwrap_or_else(|| format!("Ripple executor finished with status {}", info.status));
            set_field(&mut run, "status", json!("failed"));
            set_field(&mut run, "failure_reason", json!(reason));
        }
        persist_task_run_status_projection(&state.storage, &user_id, &session_id, &run).await?;
        return Ok(());
    }
}

pub async fn reconcile_recoverable_task_session_runs(state: AppState) -> anyhow::Result<usize> {
    let runs = state.storage.list_active_task_session_runs().await?;
    let mut reconciled = 0;
    for run in runs {
        let Some(user_id) = string_field(&run, "user_id") else {
            continue;
        };
        let Some(session_id) = string_field(&run, "session_id") else {
            continue;
        };
        let Some(run_id) = string_field(&run, "run_id") else {
            continue;
        };
        let Some(job_id) = string_field(&run, "external_run_id") else {
            continue;
        };
        let monitor_state = state.clone();
        tokio::spawn(async move {
            if let Err(err) =
                monitor_task_execution_job(monitor_state, user_id, session_id, run_id, job_id).await
            {
                warn!(error = ?err, "failed to reconcile recovered TaskSession run");
            }
        });
        reconciled += 1;
    }
    Ok(reconciled)
}

fn should_apply_execution_result(run: &Value) -> bool {
    run.get("status").and_then(Value::as_str) != Some("cancelled")
}

struct TaskExecutionResult {
    result_summary: String,
    result: Option<Value>,
}

fn task_execution_result_from_output(output: &str) -> TaskExecutionResult {
    let trimmed = output.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        let result_summary = value
            .get("result_summary")
            .or_else(|| value.get("summary"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| "任务已完成。".to_string());
        let result = value.get("result").cloned().or(Some(value));
        return TaskExecutionResult {
            result_summary,
            result,
        };
    }

    TaskExecutionResult {
        result_summary: if trimmed.is_empty() {
            "任务已完成。".to_string()
        } else {
            trimmed.chars().take(1000).collect()
        },
        result: if trimmed.is_empty() {
            None
        } else {
            Some(json!({"content": trimmed}))
        },
    }
}

fn build_ripple_task_execution_prompt(session: &Value, task_spec: &Value, run: &Value) -> String {
    format!(
        "You are the Ripple/Vitana task executor.\n\
Execute the confirmed TaskSpec for the user. Do the real work when possible using the available workspace and tools.\n\
Do not ask for confirmation again unless execution is blocked by missing user input or authorization.\n\
When finished, return a concise completion summary. If you can return structured JSON, use {{\"result_summary\":\"...\",\"result\":{{...}}}}.\n\n\
TaskSession:\n{}\n\n\
TaskSpec:\n{}\n\n\
TaskRun:\n{}\n",
        serde_json::to_string(session).unwrap_or_else(|_| "{}".to_string()),
        serde_json::to_string(task_spec).unwrap_or_else(|_| "{}".to_string()),
        serde_json::to_string(run).unwrap_or_else(|_| "{}".to_string()),
    )
}

fn ripple_execution_requested(input: &Value) -> bool {
    if input.get("auto_execute").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    string_field(input, "executor")
        .as_deref()
        .is_some_and(is_ripple_executor)
}

fn is_ripple_executor(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    RIPPLE_EXECUTORS.contains(&normalized.as_str())
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

    let (model, effort) = resolve_task_model_effort(state, session, input);
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
    let draft_version = session
        .get("draft_version")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .saturating_add(1);
    set_field(&mut next_session, "draft_version", json!(draft_version));
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
    spawn_task_session_callback(
        storage.clone(),
        user_id.to_string(),
        session_id.to_string(),
        event.clone(),
    );
    Ok(event)
}

fn spawn_task_session_callback(
    storage: Storage,
    user_id: String,
    session_id: String,
    event: Value,
) {
    tokio::spawn(async move {
        if let Err(err) = post_task_session_callback(&storage, &user_id, &session_id, event).await {
            warn!(
                user_id = %user_id,
                session_id = %session_id,
                error = %err,
                "task session callback delivery failed"
            );
        }
    });
}

async fn post_task_session_callback(
    storage: &Storage,
    user_id: &str,
    session_id: &str,
    event: Value,
) -> Result<(), String> {
    let event = task_session_event_with_seq(storage, user_id, session_id, event).await;
    let Some(callback_url) =
        task_session_callback_url(storage, user_id, session_id, &event).await?
    else {
        return Ok(());
    };
    let data = task_status_sse_payload(storage, user_id, session_id, Some(&event))
        .await
        .map_err(|err| format!("{err:?}"))?;
    let body = json!({
        "event": "task.status",
        "id": data.get("seq").cloned().unwrap_or(Value::Null),
        "data": data
    });
    let mut request = reqwest::Client::new().post(callback_url.as_str());
    if let Some(event_id) = body.pointer("/data/event_id").and_then(Value::as_str) {
        request = request.header("X-Ripple-Event-Id", event_id);
    }
    if let Some(task_id) = body.pointer("/data/task_id").and_then(Value::as_str) {
        request = request.header("X-Ripple-Task-Id", task_id);
    }
    if let Some(req_id) = body.pointer("/data/req_id").and_then(Value::as_str) {
        request = request.header("X-Ripple-Req-Id", req_id);
    }
    let response = request
        .json(&body)
        .send()
        .await
        .map_err(|err| err.to_string())?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("callback returned HTTP {}", response.status()))
    }
}

async fn task_session_event_with_seq(
    storage: &Storage,
    user_id: &str,
    session_id: &str,
    event: Value,
) -> Value {
    let Some(event_id) = event.get("event_id").and_then(Value::as_str) else {
        return event;
    };
    match storage.list_task_session_events(user_id, session_id).await {
        Ok(events) => events
            .into_iter()
            .find(|candidate| candidate.get("event_id").and_then(Value::as_str) == Some(event_id))
            .unwrap_or(event),
        Err(_) => event,
    }
}

async fn task_session_callback_url(
    storage: &Storage,
    user_id: &str,
    session_id: &str,
    event: &Value,
) -> Result<Option<String>, String> {
    if let Some(callback_url) = callback_url_from_value(event) {
        return Ok(Some(callback_url));
    }
    if let Some(callback_url) = event.get("payload").and_then(callback_url_from_value) {
        return Ok(Some(callback_url));
    }
    if let Some(run_id) = event
        .get("payload")
        .and_then(|payload| payload.get("run_id"))
        .and_then(Value::as_str)
    {
        if let Some(run) = storage
            .get_task_session_run(user_id, session_id, run_id)
            .await
            .map_err(|err| err.to_string())?
        {
            if let Some(callback_url) = callback_url_from_value(&run) {
                return Ok(Some(callback_url));
            }
        }
    }
    let Some(session) = storage
        .get_task_session(user_id, session_id)
        .await
        .map_err(|err| err.to_string())?
    else {
        return Ok(None);
    };
    Ok(callback_url_from_value(&session))
}

fn callback_url_from_value(value: &Value) -> Option<String> {
    value
        .get("callback_url")
        .and_then(Value::as_str)
        .or_else(|| value.get("callback").and_then(Value::as_str))
        .or_else(|| {
            value
                .get("callback")
                .and_then(|callback| callback.get("url"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            value
                .get("callback")
                .and_then(|callback| callback.get("callback_url"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn merge_callback_fields(target: &mut Value, source: &Value) {
    if let Some(callback_url) = callback_url_from_value(source) {
        set_field(target, "callback_url", json!(callback_url));
    }
    if let Some(callback) = source.get("callback").filter(|value| !value.is_null()) {
        set_field(target, "callback", callback.clone());
    }
}

fn copy_callback_fields(target: &mut Map<String, Value>, source: &Value) {
    if let Some(callback_url) = callback_url_from_value(source) {
        target.insert("callback_url".to_string(), json!(callback_url));
    }
    if let Some(callback) = source.get("callback").filter(|value| !value.is_null()) {
        target.insert("callback".to_string(), callback.clone());
    }
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
    let internal_status = task_status_for_sse_event(event_type, &event_payload, &session);
    let run_status = run
        .as_ref()
        .and_then(|run| run.get("status"))
        .and_then(Value::as_str)
        .or_else(|| event_payload.get("status").and_then(Value::as_str))
        .filter(|status| TASK_RUN_STATUSES.contains(status));
    let task_status = simple_task_status(&internal_status, spec.as_ref(), run_status);
    let phase = simple_task_phase(task_status, spec.as_ref(), run.as_ref());
    let needs_user_action = session
        .get("needs_user_action")
        .and_then(Value::as_bool)
        .unwrap_or(task_status == "pending_confirmation" || task_status == "waiting_user");
    let action = spec
        .as_ref()
        .map(simple_task_draft)
        .and_then(|draft| draft.get("action").cloned())
        .unwrap_or(Value::Null);

    Ok(json!({
        "event_id": event.and_then(|event| event.get("event_id")).cloned().unwrap_or(Value::Null),
        "seq": event.and_then(|event| event.get("seq")).cloned().unwrap_or(Value::Null),
        "created_at": event
            .and_then(|event| event.get("created_at"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(now_iso),
        "task_id": session_id,
        "req_id": session.get("req_id").cloned().unwrap_or(Value::Null),
        "event_type": event_type,
        "task_status": task_status,
        "phase": phase,
        "waiting_reason": session.get("waiting_reason").cloned().unwrap_or(Value::Null),
        "needs_user_action": needs_user_action,
        "required_action": session.get("required_action").cloned().unwrap_or(Value::Null),
        "execution_id": run_id,
        "action": action,
        "latest_message": session.get("latest_message").cloned().unwrap_or(Value::Null),
        "result_summary": run
            .as_ref()
            .and_then(|run| run.get("result_summary"))
            .cloned()
            .unwrap_or(Value::Null),
        "result": run
            .as_ref()
            .and_then(|run| run.get("result"))
            .cloned()
            .unwrap_or(Value::Null),
        "failure_reason": run
            .as_ref()
            .and_then(|run| {
                run.get("failure_reason")
                    .or_else(|| run.get("cancellation_reason"))
            })
            .cloned()
            .unwrap_or(Value::Null)
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

fn resolve_task_model_effort(
    state: &AppState,
    session: &Value,
    input: &Value,
) -> (String, Option<String>) {
    let selected_model = string_field(input, "model").or_else(|| string_field(session, "model"));
    let selected_effort = string_field(input, "effort").or_else(|| string_field(session, "effort"));
    let (model, preset_effort) = state.config.resolve_model(selected_model.as_deref());
    (model, selected_effort.or(preset_effort))
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

    #[tokio::test]
    async fn task_session_model_effort_is_persisted_on_run_for_auth_resume() -> anyhow::Result<()> {
        let (storage, root) = temp_storage()?;
        let user_id = "alice";
        let now = "2026-07-16T00:00:00Z";
        let session = task_session_from_payload(
            &json!({"session_id": "ts-model-resume", "title": "模型恢复测试"}),
            user_id,
            now,
        )
        .expect("task session payload should be valid");
        storage.upsert_task_session(user_id, &session).await?;
        let spec = task_spec_from_payload(
            &json!({
                "task_spec_id": "spec-model-resume",
                "task_type": "todo",
                "goal": "验证授权恢复时保留模型参数"
            }),
            user_id,
            "ts-model-resume",
            now,
        )
        .expect("task spec payload should be valid");
        storage
            .upsert_task_session_spec(user_id, "ts-model-resume", &spec)
            .await?;

        let run = create_task_run_record(
            &storage,
            user_id,
            "ts-model-resume",
            "spec-model-resume",
            &json!({"model": "codex-request", "effort": "high"}),
        )
        .await
        .expect("task run should be created");
        assert_eq!(
            run.get("model").and_then(Value::as_str),
            Some("codex-request")
        );
        assert_eq!(run.get("effort").and_then(Value::as_str), Some("high"));

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

    #[test]
    fn simple_task_session_projection_hides_private_spec_and_run_fields() {
        let session = json!({
            "session_id": "task-test",
            "title": "给张三发消息",
            "status": "in_progress",
            "draft_version": 2,
            "created_at": "2026-07-16T00:00:00Z",
            "updated_at": "2026-07-16T00:01:00Z"
        });
        let spec = json!({
            "task_spec_id": "spec-test",
            "status": "confirmed",
            "task_type": "send_message",
            "goal": "把项目进展发给张三",
            "required_fields": {
                "connector": "feishu",
                "recipient": {"id": "ou_123", "display_name": "张三"},
                "content": "项目已经进入联调阶段"
            },
            "required_connectors": ["feishu"],
            "impact_summary": "将通过飞书给张三发送消息",
            "confirmed_at": "2026-07-16T00:00:30Z"
        });
        let run = json!({
            "run_id": "execution-test",
            "status": "in_progress",
            "external_run_id": "job-test",
            "started_at": "2026-07-16T00:00:31Z"
        });

        let view = simple_task_session_view(&session, Some(&spec), Some(&run));

        assert_eq!(
            view.pointer("/task_id").and_then(Value::as_str),
            Some("task-test")
        );
        assert_eq!(
            view.pointer("/status").and_then(Value::as_str),
            Some("running")
        );
        assert_eq!(
            view.pointer("/phase").and_then(Value::as_str),
            Some("execution")
        );
        assert_eq!(
            view.pointer("/task_draft/action").and_then(Value::as_str),
            Some("send_message")
        );
        assert_eq!(
            view.pointer("/task_draft/connector")
                .and_then(Value::as_str),
            Some("feishu")
        );
        assert_eq!(
            view.pointer("/confirmed_task/confirmed_version")
                .and_then(Value::as_u64),
            Some(2)
        );
        assert_eq!(
            view.pointer("/current_execution/execution_id")
                .and_then(Value::as_str),
            Some("execution-test")
        );
        assert!(view.get("session_id").is_none());
        assert!(view.pointer("/task_draft/task_spec_id").is_none());
        assert!(view.pointer("/current_execution/run_id").is_none());
    }

    #[tokio::test]
    async fn task_session_idempotency_preserves_first_request_and_response() -> anyhow::Result<()> {
        let (storage, root) = temp_storage()?;
        let first_request = json!({"content": "第一次请求"});
        let first_response = json!({"task_session": {"task_id": "task-test"}});

        let inserted = storage
            .save_task_session_idempotency(
                "alice",
                "create",
                "via-20260716-000123",
                &first_request,
                &first_response,
                "2026-07-16T00:00:00Z",
            )
            .await?;
        assert!(inserted);

        let duplicate = storage
            .save_task_session_idempotency(
                "alice",
                "create",
                "via-20260716-000123",
                &json!({"content": "不同请求"}),
                &json!({"task_session": {"task_id": "task-other"}}),
                "2026-07-16T00:00:01Z",
            )
            .await?;
        assert!(!duplicate);

        let stored = storage
            .get_task_session_idempotency("alice", "create", "via-20260716-000123")
            .await?
            .expect("idempotency record should exist");
        assert_eq!(stored.pointer("/request"), Some(&first_request));
        assert_eq!(stored.pointer("/response"), Some(&first_response));

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn task_spec_turn_increments_public_draft_version() -> anyhow::Result<()> {
        let (storage, root) = temp_storage()?;
        let session = task_session_from_payload(
            &json!({
                "session_id": "task-version",
                "req_id": "via-20260716-000123",
                "draft_version": 1,
                "goal": "给张三发送会议通知"
            }),
            "alice",
            "2026-07-16T00:00:00Z",
        )
        .expect("task session payload should be valid");
        storage.upsert_task_session("alice", &session).await?;

        let projection = persist_task_spec_turn_projection(
            &storage,
            "alice",
            "task-version",
            &session,
            None,
            TaskSpecTurnExtractionResult {
                assistant_message: Some("任务信息已完整，请确认。".to_string()),
                ready_to_confirm: true,
                missing_fields: Vec::new(),
                task_spec: Some(json!({
                    "task_type": "send_message",
                    "goal": "给张三发送会议通知",
                    "required_fields": {"connector": "feishu", "recipient": {"id": "ou_123", "display_name": "张三"}}
                })),
                extraction_run_id: None,
            },
        )
        .await
        .expect("task spec projection should persist");
        let stored_session = storage
            .get_task_session("alice", "task-version")
            .await?
            .expect("task session should exist");
        let view = simple_task_session_view(&stored_session, Some(&projection.task_spec), None);

        assert_eq!(
            view.pointer("/draft_version").and_then(Value::as_u64),
            Some(2)
        );
        assert_eq!(
            view.pointer("/status").and_then(Value::as_str),
            Some("pending_confirmation")
        );
        assert_eq!(
            view.pointer("/phase").and_then(Value::as_str),
            Some("confirmation")
        );
        assert_eq!(
            view.pointer("/required_action/type")
                .and_then(Value::as_str),
            Some("confirm")
        );

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn command_replay_rejects_a_reused_key_with_different_input() -> anyhow::Result<()> {
        let (storage, root) = temp_storage()?;
        let original = json!({
            "req_id": "via-20260716-000123",
            "idempotency_key": "create-123",
            "content": "创建任务"
        });
        storage
            .save_task_session_idempotency(
                "alice",
                "create",
                "create-123",
                &original,
                &json!({"task_session": {"task_id": "task-test"}}),
                "2026-07-16T00:00:00Z",
            )
            .await?;

        let replay = load_task_command_replay(&storage, "alice", "create", &original)
            .await
            .expect("same request should replay")
            .expect("replay response should exist");
        assert_eq!(
            replay
                .pointer("/task_session/task_id")
                .and_then(Value::as_str),
            Some("task-test")
        );

        let conflict = load_task_command_replay(
            &storage,
            "alice",
            "create",
            &json!({
                "req_id": "via-20260716-000123",
                "idempotency_key": "create-123",
                "content": "不同任务"
            }),
        )
        .await
        .expect_err("different request must conflict");
        assert_eq!(conflict.status, axum::http::StatusCode::CONFLICT);
        assert_eq!(
            conflict.detail.get("code").and_then(Value::as_str),
            Some("idempotency_conflict")
        );

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn stale_draft_version_returns_contract_error() {
        let error = validate_expected_draft_version(
            &json!({"session_id": "task-test", "draft_version": 3}),
            &json!({"req_id": "via-20260716-000123", "expected_draft_version": 2}),
            "expected_draft_version",
        )
        .expect_err("stale version must be rejected");

        assert_eq!(error.status, axum::http::StatusCode::CONFLICT);
        assert_eq!(
            error.detail.get("code").and_then(Value::as_str),
            Some("draft_version_conflict")
        );
        assert_eq!(
            error.detail.get("task_id").and_then(Value::as_str),
            Some("task-test")
        );
    }

    #[test]
    fn confirmation_freezes_the_current_draft_version() {
        let (session, spec) = freeze_task_confirmation(
            &json!({
                "session_id": "task-test",
                "req_id": "via-20260716-000123",
                "status": "pending_confirm",
                "draft_version": 2
            }),
            &json!({
                "task_spec_id": "spec-test",
                "status": "pending_confirm",
                "task_type": "send_message",
                "required_fields": {"connector": "feishu"}
            }),
            &json!({
                "req_id": "via-20260716-000123",
                "draft_version": 2
            }),
            "2026-07-16T00:00:30Z",
        )
        .expect("confirmation should succeed");

        assert_eq!(
            session.get("confirmed_version").and_then(Value::as_u64),
            Some(2)
        );
        assert_eq!(
            session.get("status").and_then(Value::as_str),
            Some("in_progress")
        );
        assert_eq!(
            spec.get("status").and_then(Value::as_str),
            Some("confirmed")
        );
        assert_eq!(
            spec.get("confirmed_at").and_then(Value::as_str),
            Some("2026-07-16T00:00:30Z")
        );
    }

    #[test]
    fn cancellation_marks_both_task_and_execution_terminal() {
        let (session, run) = cancel_task_records(
            &json!({
                "session_id": "task-test",
                "req_id": "via-20260716-000123",
                "status": "in_progress"
            }),
            Some(&json!({"run_id": "execution-test", "status": "in_progress"})),
            &json!({
                "req_id": "via-20260716-000123",
                "reason": "cancelled_by_user"
            }),
            "2026-07-16T00:01:00Z",
        )
        .expect("cancellation should succeed");

        assert_eq!(
            session.get("status").and_then(Value::as_str),
            Some("cancelled")
        );
        assert_eq!(
            run.as_ref()
                .and_then(|value| value.get("status"))
                .and_then(Value::as_str),
            Some("cancelled")
        );
        assert_eq!(
            run.as_ref()
                .and_then(|value| value.get("cancellation_reason"))
                .and_then(Value::as_str),
            Some("cancelled_by_user")
        );
    }

    #[tokio::test]
    async fn callback_payload_uses_only_simplified_public_ids() -> anyhow::Result<()> {
        let (storage, root) = temp_storage()?;
        storage
            .upsert_task_session(
                "alice",
                &json!({
                    "user_id": "alice",
                    "session_id": "task-test",
                    "req_id": "via-20260716-000123",
                    "status": "completed",
                    "needs_user_action": false,
                    "current_task_spec_id": "spec-test",
                    "latest_run_id": "execution-test",
                    "updated_at": "2026-07-16T00:02:00Z"
                }),
            )
            .await?;
        storage
            .upsert_task_session_spec(
                "alice",
                "task-test",
                &json!({
                    "task_spec_id": "spec-test",
                    "status": "completed",
                    "task_type": "send_message",
                    "updated_at": "2026-07-16T00:02:00Z"
                }),
            )
            .await?;
        storage
            .upsert_task_session_run(
                "alice",
                "task-test",
                &json!({
                    "run_id": "execution-test",
                    "task_spec_id": "spec-test",
                    "status": "completed",
                    "result_summary": "消息已发送",
                    "updated_at": "2026-07-16T00:02:00Z"
                }),
            )
            .await?;
        let event = append_task_session_event(
            &storage,
            "alice",
            "task-test",
            "task_run_completed",
            json!({"run_id": "execution-test", "task_spec_id": "spec-test"}),
        )
        .await
        .expect("callback event should persist");

        let payload = task_status_sse_payload(&storage, "alice", "task-test", Some(&event))
            .await
            .expect("callback payload should build");
        assert_eq!(
            payload.get("task_id").and_then(Value::as_str),
            Some("task-test")
        );
        assert_eq!(
            payload.get("req_id").and_then(Value::as_str),
            Some("via-20260716-000123")
        );
        assert_eq!(
            payload.get("execution_id").and_then(Value::as_str),
            Some("execution-test")
        );
        assert_eq!(
            payload.get("task_status").and_then(Value::as_str),
            Some("completed")
        );
        assert_eq!(
            payload.get("phase").and_then(Value::as_str),
            Some("terminal")
        );
        for private_field in ["task_session_id", "session_id", "task_spec_id", "run_id"] {
            assert!(
                payload.get(private_field).is_none(),
                "{private_field} leaked"
            );
        }

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn connector_auth_resume_requires_the_waiting_execution_state() {
        assert_eq!(
            waiting_connector_name(&json!({
                "status": "waiting_user",
                "waiting_reason": "connector_auth",
                "required_action": {"type": "connector_auth", "connector": "feishu"}
            })),
            Some("feishu")
        );
        assert_eq!(
            waiting_connector_name(&json!({
                "status": "in_progress",
                "waiting_reason": "connector_auth",
                "required_action": {"type": "connector_auth", "connector": "feishu"}
            })),
            None
        );
    }

    #[test]
    fn cancelled_execution_does_not_accept_a_late_result() {
        assert!(!should_apply_execution_result(
            &json!({"status": "cancelled"})
        ));
        assert!(should_apply_execution_result(
            &json!({"status": "in_progress"})
        ));
    }
}
