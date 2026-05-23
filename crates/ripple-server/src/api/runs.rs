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

use crate::api::users::assert_can_create_run;
use crate::api::ApiError;
use crate::codex::events::{extract_codex_runtime_event, extract_plan_update_event};
use crate::jobs::{AgentRunCreateRequest, AgentRunInfo};
use crate::state::AppState;
use crate::user::user_id_from_headers;

const TERMINAL_STATUSES: &[&str] = &["completed", "failed", "cancelled"];

pub async fn list_runs(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let runs = state.jobs.list_user(&user_id).await?;
    Ok(Json(json!({ "runs": runs, "count": runs.len() })))
}

pub async fn create_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<AgentRunCreateRequest>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let workspace_root = state.sandboxes.ensure_sandbox(&user_id)?;
    let runtime_dir = state.sandboxes.sandbox_dir(&user_id)?.join("agent-runs");
    let input = resolve_turn_config(&state, input);
    assert_can_create_run(&state, &user_id, input.max_runtime_seconds).await?;
    let info = state
        .jobs
        .start(input, user_id, None, workspace_root, runtime_dir)
        .await
        .map_err(|err| ApiError::bad_request(err.to_string()))?;
    Ok(Json(
        serde_json::to_value(info).unwrap_or_else(|_| json!({})),
    ))
}

pub async fn get_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let Some(info) = info_for_user(&state, &user_id, &job_id).await? else {
        return Err(ApiError::not_found("Agent run not found"));
    };
    Ok(Json(
        serde_json::to_value(info).unwrap_or_else(|_| json!({})),
    ))
}

#[derive(Debug, Deserialize)]
pub struct RunEventsQuery {
    from_start: Option<bool>,
    follow: Option<bool>,
    heartbeat_seconds: Option<u64>,
}

pub async fn run_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<String>,
    Query(query): Query<RunEventsQuery>,
) -> Result<Response<Body>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let Some(events_file) = state.jobs.events_file_for_user(&job_id, &user_id).await? else {
        return Err(ApiError::not_found("Agent run events not found"));
    };

    let from_start = query.from_start.unwrap_or(true);
    let follow = query.follow.unwrap_or(true);
    let heartbeat_seconds = query.heartbeat_seconds.unwrap_or(8).clamp(1, 60);
    let jobs = state.jobs.clone();
    let stream_user_id = user_id.clone();
    let stream_job_id = job_id.clone();

    let body_stream = stream! {
        let mut offset = initial_offset(&events_file, from_start).await;
        let mut last_emit = now_epoch_seconds();
        loop {
            let events = read_events_from_offset(&events_file, &mut offset).await;
            for event in events {
                yield Ok::<Bytes, Infallible>(sse_json(&event));
                if let Some(plan_event) = extract_plan_update_event(&event) {
                    yield Ok::<Bytes, Infallible>(sse_json(&plan_event));
                }
                if let Some(runtime_event) = extract_codex_runtime_event(&event) {
                    yield Ok::<Bytes, Infallible>(sse_json(&runtime_event));
                }
                last_emit = now_epoch_seconds();
            }

            let status = jobs
                .status_for_user(&stream_job_id, &stream_user_id)
                .await
                .ok()
                .flatten()
                .unwrap_or_else(|| "completed".to_string());
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

#[derive(Debug, Deserialize)]
pub struct SteerInput {
    prompt: Option<String>,
    message: Option<String>,
    text: Option<String>,
}

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
    Ok(Json(
        serde_json::to_value(info).unwrap_or_else(|_| json!({})),
    ))
}

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
    Ok(Json(
        serde_json::to_value(info).unwrap_or_else(|_| json!({})),
    ))
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
    let Ok(bytes) = tokio::fs::read(events_file).await else {
        return Vec::new();
    };
    if bytes.len() < *offset {
        *offset = 0;
    }
    let slice = &bytes[*offset..];
    *offset = bytes.len();
    slice
        .split(|byte| *byte == b'\n')
        .filter_map(|line| {
            if line.iter().all(u8::is_ascii_whitespace) {
                return None;
            }
            serde_json::from_slice::<Value>(line).ok()
        })
        .filter(|value| value.is_object())
        .collect()
}

fn sse_json(value: &Value) -> Bytes {
    Bytes::from(format!(
        "data: {}\n\n",
        serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string())
    ))
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}
