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

use crate::api::ApiError;
use crate::jobs::{AgentRunCreateRequest, AgentRunInfo};
use crate::state::AppState;
use crate::user::user_id_from_headers;

const TERMINAL_STATUSES: &[&str] = &["completed", "failed", "cancelled"];

pub async fn list_runs(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let agent_runs_dir = state.sandboxes.sandbox_dir(&user_id)?.join("agent-runs");
    let runs = state.jobs.list_user(&user_id, &agent_runs_dir).await?;
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
    let agent_runs_dir = state.sandboxes.sandbox_dir(&user_id)?.join("agent-runs");
    let Some(events_file) = state
        .jobs
        .events_file_for_user(&job_id, &user_id, &agent_runs_dir)
        .await?
    else {
        return Err(ApiError::not_found("Agent run events not found"));
    };

    let from_start = query.from_start.unwrap_or(true);
    let follow = query.follow.unwrap_or(true);
    let heartbeat_seconds = query.heartbeat_seconds.unwrap_or(8).clamp(1, 60);
    let jobs = state.jobs.clone();
    let stream_user_id = user_id.clone();
    let stream_job_id = job_id.clone();
    let stream_agent_runs_dir = agent_runs_dir.clone();

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
                .status_for_user(&stream_job_id, &stream_user_id, &stream_agent_runs_dir)
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
    let agent_runs_dir = state.sandboxes.sandbox_dir(user_id)?.join("agent-runs");
    Ok(state
        .jobs
        .info_for_user(job_id, user_id, &agent_runs_dir)
        .await?)
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

fn extract_plan_update_event(event: &Value) -> Option<Value> {
    if event.get("type").and_then(Value::as_str) != Some("codex.notification") {
        return None;
    }
    let message = event.pointer("/data/message")?;
    if message.get("method").and_then(Value::as_str) != Some("turn/plan/updated") {
        return None;
    }
    let params = message.get("params")?;
    let raw_plan = params.get("plan")?.as_array()?;
    let turn_id = params
        .get("turnId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown-turn");
    let mut steps = Vec::new();
    for (index, item) in raw_plan.iter().enumerate() {
        let Some(step) = item.get("step").and_then(Value::as_str) else {
            continue;
        };
        if step.trim().is_empty() {
            continue;
        }
        steps.push(json!({
            "id": format!("codex-plan:{turn_id}:{index}"),
            "subject": step,
            "status": normalize_plan_step_status(item.get("status").and_then(Value::as_str))
        }));
    }
    let completed = steps
        .iter()
        .filter(|step| step.get("status").and_then(Value::as_str) == Some("completed"))
        .count();
    let current_task = steps
        .iter()
        .find(|step| step.get("status").and_then(Value::as_str) == Some("in_progress"))
        .or_else(|| {
            steps
                .iter()
                .find(|step| step.get("status").and_then(Value::as_str) == Some("pending"))
        })
        .and_then(|step| step.get("subject").and_then(Value::as_str));
    let total = steps.len();
    Some(json!({
        "type": "task_plan_updated",
        "thread_id": params.get("threadId").and_then(Value::as_str),
        "turn_id": turn_id,
        "explanation": params.get("explanation").and_then(Value::as_str),
        "steps": steps,
        "progress": {
            "completed": completed,
            "total": total,
            "currentTask": current_task
        },
        "allCompleted": completed == total
    }))
}

fn normalize_plan_step_status(status: Option<&str>) -> &'static str {
    match status {
        Some("completed") => "completed",
        Some("inProgress" | "in_progress") => "in_progress",
        _ => "pending",
    }
}

fn extract_codex_runtime_event(event: &Value) -> Option<Value> {
    if event.get("type").and_then(Value::as_str) != Some("codex.notification") {
        return None;
    }
    let message = event.pointer("/data/message")?;
    let method = message.get("method").and_then(Value::as_str)?;
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
    match method {
        "turn/diff/updated" => {
            let mut payload = base_runtime_event("codex_turn_diff_updated", method, &params);
            if let Some(object) = payload.as_object_mut() {
                if let Some(diff) = params.get("diff") {
                    object.insert("diff".to_string(), diff.clone());
                } else {
                    object.insert("params".to_string(), params);
                }
            }
            Some(payload)
        }
        "item/commandExecution/outputDelta" | "item/commandExecution/delta" => {
            Some(tool_delta_event(method, &params, "command_execution"))
        }
        "item/fileChange/outputDelta" | "item/fileChange/delta" => {
            Some(tool_delta_event(method, &params, "file_change"))
        }
        "item/fileChange/patchUpdated" => {
            let mut payload = base_runtime_event("file_change_patch_updated", method, &params);
            if let Some(object) = payload.as_object_mut() {
                for key in ["patch", "changes", "status"] {
                    if let Some(value) = params.get(key) {
                        object.insert(key.to_string(), value.clone());
                    }
                }
            }
            Some(payload)
        }
        "warning" | "configWarning" | "deprecationNotice" | "guardianWarning" | "turn/warning" => {
            let mut payload = base_runtime_event("codex_warning", method, &params);
            if let Some(object) = payload.as_object_mut() {
                object.insert("message".to_string(), json!(message_text(&params)));
            }
            Some(payload)
        }
        "error" | "turn/error" => {
            let mut payload = base_runtime_event("codex_error", method, &params);
            if let Some(object) = payload.as_object_mut() {
                object.insert("message".to_string(), json!(message_text(&params)));
            }
            Some(payload)
        }
        "thread/compacted" | "thread/contextCompacted" | "context/compacted" => {
            Some(context_compaction_event(method, &params))
        }
        _ => {
            if params.pointer("/item/type").and_then(Value::as_str) == Some("contextCompaction") {
                Some(context_compaction_event(method, &params))
            } else {
                None
            }
        }
    }
}

fn base_runtime_event(event_type: &str, method: &str, params: &Value) -> Value {
    let item = params.get("item");
    let item_id = params
        .get("itemId")
        .or_else(|| params.get("item_id"))
        .and_then(Value::as_str)
        .or_else(|| item.and_then(|item| item.get("id")).and_then(Value::as_str));
    let mut payload = json!({
        "type": event_type,
        "codex_method": method,
        "thread_id": params.get("threadId").or_else(|| params.get("thread_id")).and_then(Value::as_str),
        "turn_id": params.get("turnId").or_else(|| params.get("turn_id")).and_then(Value::as_str)
    });
    if let (Some(object), Some(item_id)) = (payload.as_object_mut(), item_id) {
        object.insert("id".to_string(), json!(item_id));
    }
    payload
}

fn tool_delta_event(method: &str, params: &Value, kind: &str) -> Value {
    let mut payload = base_runtime_event("tool_output_delta", method, params);
    if let Some(object) = payload.as_object_mut() {
        object.insert("kind".to_string(), json!(kind));
        object.insert("delta".to_string(), json!(delta_text(params)));
        if let Some(stream) = params.get("stream").and_then(Value::as_str) {
            object.insert("stream".to_string(), json!(stream));
        }
    }
    payload
}

fn context_compaction_event(method: &str, params: &Value) -> Value {
    let mut payload = base_runtime_event("context_compaction", method, params);
    if let Some(status) = params.pointer("/item/status").and_then(Value::as_str) {
        if let Some(object) = payload.as_object_mut() {
            object.insert("status".to_string(), json!(status));
        }
    }
    payload
}

fn message_text(params: &Value) -> String {
    for key in ["message", "warning", "error", "detail", "details"] {
        if let Some(value) = params.get(key).and_then(Value::as_str) {
            return value.to_string();
        }
    }
    String::new()
}

fn delta_text(params: &Value) -> String {
    for key in ["delta", "output", "chunk", "text"] {
        if let Some(value) = params.get(key).and_then(Value::as_str) {
            return value.to_string();
        }
    }
    String::new()
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}
