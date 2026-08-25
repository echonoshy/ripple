use std::convert::Infallible;
use std::path::Path as FsPath;
use std::time::{SystemTime, UNIX_EPOCH};

use async_stream::stream;
use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::time::{sleep, Duration};

use crate::api::chat::finalize_chat_run_for_session;
use crate::api::run_public::{
    public_run_value, sanitize_run_visible_text, sanitize_run_visible_value,
};
use crate::api::users::assert_can_create_run;
use crate::api::{paginate, ApiError, ListQuery};
use crate::codex::events::{extract_codex_runtime_event, extract_plan_update_event};
use crate::jobs::{AgentRunCreateRequest, AgentRunInfo};
use crate::state::AppState;
use crate::user::user_id_from_headers;

const TERMINAL_STATUSES: &[&str] = &["completed", "failed", "cancelled"];

#[utoipa::path(
    get,
    path = "/runs",
    tag = "runs",
    params(crate::api::ListQuery),
    responses(
        (status = 200, description = "Paginated run list", body = serde_json::Value),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn list_runs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let runs = state.jobs.list_user(&user_id).await?;
    let total = runs.len();
    let (runs, next_cursor) = paginate(runs, &query)?;
    let runs = runs
        .iter()
        .map(|run| public_run_value(&state, &user_id, run))
        .collect::<Vec<_>>();
    Ok(Json(json!({
        "runs": runs,
        "count": runs.len(),
        "total": total,
        "next_cursor": next_cursor
    })))
}

#[utoipa::path(
    post,
    path = "/runs",
    tag = "runs",
    request_body = AgentRunCreateRequest,
    responses(
        (status = 200, description = "Created run", body = serde_json::Value),
        (status = 400, description = "Invalid run request", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn create_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<AgentRunCreateRequest>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let workspace_root = state.sandboxes.ensure_sandbox(&user_id)?;
    let runtime_dir = state.sandboxes.sandbox_dir(&user_id)?.join("agent-runs");
    let input = resolve_turn_config(&state, input);
    ensure_workspace_change_baseline(&state, &user_id, &workspace_root).await;
    assert_can_create_run(&state, &user_id, input.max_runtime_seconds).await?;
    let info = state
        .jobs
        .start(input, user_id.clone(), None, workspace_root, runtime_dir)
        .await
        .map_err(|err| ApiError::bad_request(err.to_string()))?;
    Ok(Json(public_run_value(&state, &user_id, &info)))
}

#[utoipa::path(
    get,
    path = "/runs/{job_id}",
    tag = "runs",
    params(("job_id" = String, Path, description = "Run id")),
    responses(
        (status = 200, description = "Run detail", body = serde_json::Value),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Run not found", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn get_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let Some(info) = info_for_user(&state, &user_id, &job_id).await? else {
        return Err(ApiError::not_found("Agent run not found"));
    };
    Ok(Json(public_run_value(&state, &user_id, &info)))
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct RunEventsQuery {
    from_start: Option<bool>,
    follow: Option<bool>,
    heartbeat_seconds: Option<u64>,
}

#[utoipa::path(
    get,
    path = "/runs/{job_id}/events",
    tag = "runs",
    params(
        ("job_id" = String, Path, description = "Run id"),
        RunEventsQuery
    ),
    responses(
        (status = 200, description = "Server-sent run event stream", content_type = "text/event-stream", body = crate::api::openapi::SseEvent),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Run events not found", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn run_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<String>,
    Query(query): Query<RunEventsQuery>,
) -> Result<Response<Body>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let Some(info) = info_for_user(&state, &user_id, &job_id).await? else {
        return Err(ApiError::not_found("Agent run not found"));
    };
    let Some(events_file) = state.jobs.events_file_for_user(&job_id, &user_id).await? else {
        return Err(ApiError::not_found("Agent run events not found"));
    };

    let from_start = query.from_start.unwrap_or(true);
    let follow = query.follow.unwrap_or(true);
    let heartbeat_seconds = query.heartbeat_seconds.unwrap_or(8).clamp(1, 60);
    let jobs = state.jobs.clone();
    let stream_user_id = user_id.clone();
    let stream_job_id = job_id.clone();
    let event_state = state.clone();
    let event_run = info;

    let body_stream = stream! {
        let mut offset = initial_offset(&events_file, from_start).await;
        let mut last_emit = now_epoch_seconds();
        loop {
            let events = read_events_from_offset(&events_file, &mut offset).await;
            for event in events {
                let public_event = sanitize_run_visible_value(&event_state, &stream_user_id, &event_run, &event);
                yield Ok::<Bytes, Infallible>(sse_json(&public_event));
                if let Some(plan_event) = extract_plan_update_event(&event) {
                    let public_plan_event = sanitize_run_visible_value(&event_state, &stream_user_id, &event_run, &plan_event);
                    yield Ok::<Bytes, Infallible>(sse_json(&public_plan_event));
                }
                if let Some(runtime_event) = extract_codex_runtime_event(&event) {
                    let public_runtime_event = sanitize_run_visible_value(&event_state, &stream_user_id, &event_run, &runtime_event);
                    yield Ok::<Bytes, Infallible>(sse_json(&public_runtime_event));
                }
                last_emit = now_epoch_seconds();
            }

            let status = jobs
                .status_for_user(&stream_job_id, &stream_user_id)
                .await
                .ok()
                .flatten()
                .unwrap_or_else(|| "completed".to_string());
            if TERMINAL_STATUSES.contains(&status.as_str())
                && event_run
                    .metadata
                    .get("shared_folder_response")
                    .and_then(Value::as_bool)
                    != Some(true)
            {
                if let Ok(workspace_root) = event_state.sandboxes.workspace_dir(&stream_user_id) {
                    if let Some(workspace_changes_event) =
                        workspace_files_changed_event(&event_state, &stream_user_id, &workspace_root).await
                    {
                        yield Ok::<Bytes, Infallible>(sse_json(&workspace_changes_event));
                    }
                }
            }
            if !follow || TERMINAL_STATUSES.contains(&status.as_str()) {
                yield Ok::<Bytes, Infallible>(Bytes::from_static(b"data: [DONE]\n\n"));
                break;
            }

            let now = now_epoch_seconds();
            if now.saturating_sub(last_emit) >= heartbeat_seconds {
                yield Ok::<Bytes, Infallible>(sse_json(&json!({"type": "heartbeat", "ts": now})));
                last_emit = now;
            }
            sleep(Duration::from_millis(50)).await;
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
    Ok(response)
}

#[utoipa::path(
    get,
    path = "/runs/{job_id}/output",
    tag = "runs",
    params(("job_id" = String, Path, description = "Run id")),
    responses(
        (status = 200, description = "Run output text download", content_type = "text/plain", body = String),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Run output not found", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn run_output(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<String>,
) -> Result<Response<Body>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let Some(info) = info_for_user(&state, &user_id, &job_id).await? else {
        return Err(ApiError::not_found("Agent run not found"));
    };
    let Some(output_file) = info.output_file.as_deref() else {
        return Err(ApiError::not_found("Agent run output not found"));
    };
    let output_path = FsPath::new(output_file);
    let sandbox_dir = state.sandboxes.sandbox_dir(&user_id)?;
    let resolved = match output_path.canonicalize() {
        Ok(resolved) => resolved,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(ApiError::not_found("Agent run output not found"));
        }
        Err(err) => return Err(ApiError::from(err)),
    };
    let sandbox_dir = sandbox_dir.canonicalize().map_err(ApiError::from)?;
    if !resolved.starts_with(&sandbox_dir) || !resolved.is_file() {
        return Err(ApiError::not_found("Agent run output not found"));
    }
    let bytes = tokio::fs::read(resolved).await?;
    let text = String::from_utf8_lossy(&bytes);
    let text = sanitize_run_visible_text(&state, &user_id, &info, &text);
    let mut response = Response::new(Body::from(text));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{job_id}-output.txt\""))
            .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
    );
    Ok(response)
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct SteerInput {
    prompt: Option<String>,
    message: Option<String>,
    text: Option<String>,
}

#[utoipa::path(
    post,
    path = "/runs/{job_id}/steer",
    tag = "runs",
    params(("job_id" = String, Path, description = "Run id")),
    request_body = SteerInput,
    responses(
        (status = 200, description = "Updated run after steering", body = serde_json::Value),
        (status = 400, description = "Invalid steering request", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Run not found", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 409, description = "Run is not active or ready", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn steer_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<String>,
    Json(input): Json<SteerInput>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let Some(info) = info_for_user(&state, &user_id, &job_id).await? else {
        return Err(ApiError::not_found("Agent run not found"));
    };
    if info
        .metadata
        .get("shared_folder_response")
        .and_then(Value::as_bool)
        == Some(true)
    {
        return Err(ApiError::conflict(
            "Shared-folder responses do not support steering",
        ));
    }
    if !state.jobs.is_live_for_user(&job_id, &user_id).await {
        return Err(ApiError::conflict("Agent run is not active"));
    }
    let prompt = input
        .prompt
        .or(input.message)
        .or(input.text)
        .unwrap_or_default()
        .trim()
        .to_string();
    if prompt.is_empty() {
        return Err(ApiError::bad_request("prompt is required"));
    }
    if !state.jobs.steer(&job_id, prompt).await {
        return Err(ApiError::conflict("Agent run is not ready for steering"));
    }
    Ok(Json(public_run_value(&state, &user_id, &info)))
}

#[utoipa::path(
    post,
    path = "/runs/{job_id}/cancel",
    tag = "runs",
    params(("job_id" = String, Path, description = "Run id")),
    responses(
        (status = 200, description = "Cancelled run", body = serde_json::Value),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Run not found", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 409, description = "Run is not active", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn cancel_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    if !state.jobs.is_live_for_user(&job_id, &user_id).await {
        let Some(_info) = info_for_user(&state, &user_id, &job_id).await? else {
            return Err(ApiError::not_found("Agent run not found"));
        };
        return Err(ApiError::conflict("Agent run is not active"));
    }
    let Some(info) = state.jobs.cancel_for_user(&job_id, &user_id).await? else {
        return Err(ApiError::not_found("Agent run not found"));
    };
    if let Some(session_id) = info.metadata.get("session_id").and_then(Value::as_str) {
        let _ = finalize_chat_run_for_session(&state, &user_id, session_id, &info).await;
    }
    Ok(Json(public_run_value(&state, &user_id, &info)))
}

fn resolve_turn_config(
    state: &AppState,
    mut input: AgentRunCreateRequest,
) -> AgentRunCreateRequest {
    if let Some(model) = input.model.as_deref() {
        let (resolved_model, preset_effort) = state.config.resolve_model(Some(model));
        input.model = Some(resolved_model);
        if input.effort.is_none() {
            input.effort = preset_effort;
        }
    }
    input
}

async fn info_for_user(
    state: &AppState,
    user_id: &str,
    job_id: &str,
) -> Result<Option<AgentRunInfo>, ApiError> {
    Ok(state.jobs.info_for_user(job_id, user_id).await?)
}

async fn ensure_workspace_change_baseline(
    state: &AppState,
    user_id: &str,
    workspace_root: &FsPath,
) {
    if let Err(err) = state
        .workspace_changes
        .ensure_baseline(user_id, workspace_root)
        .await
    {
        tracing::warn!(
            user_id,
            error = %err,
            "failed to seed workspace change baseline"
        );
    }
}

async fn workspace_files_changed_event(
    state: &AppState,
    user_id: &str,
    workspace_root: &FsPath,
) -> Option<Value> {
    match state
        .workspace_changes
        .scan_event(user_id, workspace_root)
        .await
    {
        Ok(event) => event,
        Err(err) => {
            tracing::warn!(
                user_id,
                error = %err,
                "failed to scan workspace changes"
            );
            None
        }
    }
}

async fn initial_offset(events_file: &FsPath, from_start: bool) -> usize {
    if from_start {
        return 0;
    }
    tokio::fs::metadata(events_file)
        .await
        .map(|metadata| metadata.len() as usize)
        .unwrap_or(0)
}

async fn read_events_from_offset(events_file: &FsPath, offset: &mut usize) -> Vec<Value> {
    crate::api::read_jsonl_events_from_offset(events_file, offset).await
}

fn sse_json(value: &Value) -> Bytes {
    let value = versioned_event(value);
    Bytes::from(format!(
        "data: {}\n\n",
        serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string())
    ))
}

fn versioned_event(value: &Value) -> Value {
    let Some(object) = value.as_object() else {
        return value.clone();
    };
    if object.contains_key("event_version") {
        return value.clone();
    }
    let mut object = object.clone();
    object.insert("event_version".to_string(), json!(1));
    Value::Object(object)
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}
