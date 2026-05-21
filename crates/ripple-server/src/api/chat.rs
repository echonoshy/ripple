use std::convert::Infallible;
use std::path::Path as FsPath;
use std::time::{SystemTime, UNIX_EPOCH};

use async_stream::stream;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, Response, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::time::{sleep, Duration, Instant};
use uuid::Uuid;

use crate::api::connectors::read_valid_bilibili_credential_file;
use crate::api::ApiError;
use crate::jobs::{AgentRunCreateRequest, AgentRunInfo};
use crate::sessions::{CreateSessionInput, SessionRecord};
use crate::skills::render_skill_manifest;
use crate::state::AppState;
use crate::user::user_id_from_headers;

const TERMINAL_STATUSES: &[&str] = &["completed", "failed", "cancelled"];

#[derive(Debug, Deserialize)]
pub struct ChatCompletionRequest {
    pub model: Option<String>,
    pub messages: Vec<Value>,
    pub stream: Option<bool>,
    pub session_id: Option<String>,
    pub max_turns: Option<u32>,
    pub effort: Option<String>,
    pub summary: Option<String>,
    #[serde(rename = "outputSchema")]
    pub output_schema: Option<Value>,
}

pub async fn chat_completions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ChatCompletionRequest>,
) -> Result<Response<Body>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let workspace_root = state.sandboxes.ensure_sandbox(&user_id)?;
    let (user_input, input_items, user_content) = extract_user_input_and_items(&request.messages)?;
    if user_input.trim().is_empty() && input_items.is_empty() {
        return Err(ApiError::bad_request("No user message found in messages"));
    }
    let caller_system_prompt = extract_caller_system_prompt(&request.messages);
    let (model, preset_effort) = state.config.resolve_model(request.model.as_deref());
    let effort = request.effort.clone().or(preset_effort);
    let mut session = load_or_create_session(&state, &user_id, &request).await?;
    session.status = "running".to_string();
    session.pending_permission_request = None;
    session.pending_question = None;
    session.pending_options = None;
    session.pending_schedule_request = None;
    state.sessions.save_record(session.clone()).await?;

    let prompt = build_codex_chat_prompt(
        &state,
        &user_id,
        &session.session_id,
        &workspace_root,
        &user_input,
        caller_system_prompt.as_deref(),
    );
    let mut native_items = input_items;
    native_items.push(json!({"type": "text", "text": prompt}));
    let runtime_dir = state.sandboxes.session_dir(&user_id, &session.session_id)?;
    let create = AgentRunCreateRequest {
        prompt,
        provider: "codex".to_string(),
        cwd: Some("/workspace".to_string()),
        input_items: native_items,
        model: Some(model.clone()),
        effort,
        summary: request.summary.clone(),
        output_schema: request.output_schema.clone(),
        max_runtime_seconds: state.config.codex.max_runtime_seconds,
        schedule_id: None,
        schedule_title: None,
        schedule_trigger: None,
    };
    let info = state
        .jobs
        .start(
            create,
            user_id.clone(),
            Some(session.session_id.clone()),
            workspace_root,
            runtime_dir.clone(),
        )
        .await
        .map_err(|err| ApiError::bad_request(err.to_string()))?;

    if request.stream.unwrap_or(false) {
        return Ok(stream_chat_response(
            state,
            user_id,
            session,
            runtime_dir,
            info,
            model,
            user_input,
            user_content,
        ));
    }

    let final_info =
        wait_for_chat_run(&state, &user_id, &runtime_dir, &mut session, &info.job_id).await?;
    if final_info.status != "completed" {
        session.status = "failed".to_string();
        state.sessions.save_record(session).await?;
        return Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            final_info
                .error
                .unwrap_or_else(|| "Codex run failed".to_string()),
        ));
    }
    let output_text = read_run_output(&final_info).await;
    append_chat_messages(&mut session, user_content, &user_input, &output_text);
    session.status = "idle".to_string();
    session.pending_permission_request = None;
    state.sessions.save_record(session.clone()).await?;

    let payload = chat_completion_payload(&model, &session.session_id, output_text);
    let mut response = Json(payload).into_response();
    response.headers_mut().insert(
        "x-ripple-session-id",
        HeaderValue::from_str(&session.session_id).unwrap_or_else(|_| HeaderValue::from_static("")),
    );
    Ok(response)
}

async fn load_or_create_session(
    state: &AppState,
    user_id: &str,
    request: &ChatCompletionRequest,
) -> Result<SessionRecord, ApiError> {
    if let Some(session_id) = request.session_id.as_deref() {
        if let Some(session) = state.sessions.load(user_id, session_id)? {
            return Ok(session);
        }
    }
    Ok(state
        .sessions
        .create_session(
            user_id,
            CreateSessionInput {
                model: request.model.clone(),
                max_turns: request.max_turns,
                system_prompt: None,
            },
        )
        .await?)
}

fn build_codex_chat_prompt(
    state: &AppState,
    user_id: &str,
    session_id: &str,
    workspace_root: &FsPath,
    user_input: &str,
    system_prompt: Option<&str>,
) -> String {
    format!(
        "You are Codex, running as Ripple's trusted execution plane.\n\
Ripple is the control plane: it owns user identity, sandbox isolation, connector state, permissions, and API/session lifecycle. Do the real work inside the current user's workspace.\n\n\
## Ripple Session\n\
- user_id: {user_id}\n\
- session_id: {session_id}\n\
- workspace: current working directory\n\n\
## Connector Status\n\
{}\n\n\
## Execution Environment Guardrails\n\
- Do not run or mention `proxy_on` in user-facing Codex app-server tasks.\n\
- Do not collect connector credentials inside Codex; if a required connector is not connected, ask the user to authorize it through Ripple.\n\n\
## Available Skills\n\
{}\n\n\
## System Instructions\n\
{}\n\n\
## Current User Request\n\
{}\n",
        connector_manifest(state, user_id),
        render_skill_manifest(&state.config, Some(workspace_root)),
        system_prompt.unwrap_or("(none)"),
        if user_input.trim().is_empty() {
            "(The user provided image input without additional text.)"
        } else {
            user_input
        }
    )
}

fn connector_manifest(state: &AppState, user_id: &str) -> String {
    let workspace = state.sandboxes.workspace_dir(user_id).ok();
    let credentials = state.sandboxes.credentials_dir(user_id).ok();
    let has = |path: Option<&FsPath>| path.is_some_and(FsPath::exists);
    let google = workspace
        .as_ref()
        .map(|path| path.join(".config/gogcli/keyring"));
    let feishu = workspace
        .as_ref()
        .map(|path| path.join(".lark-cli/config.json"));
    let notion = credentials.as_ref().map(|path| path.join("notion.json"));
    let bilibili = credentials.as_ref().map(|path| path.join("bilibili.json"));
    let bilibili_connected = bilibili
        .as_deref()
        .is_some_and(|path| read_valid_bilibili_credential_file(path).is_some());
    [
        ("google_workspace", has(google.as_deref())),
        ("notion", has(notion.as_deref())),
        ("feishu", has(feishu.as_deref())),
        ("bilibili", bilibili_connected),
        ("openai_codex", true),
        ("codex_image_generation", true),
        ("codex_image_input", true),
        ("codex_web_search", true),
    ]
    .into_iter()
    .map(|(name, connected)| {
        format!(
            "- {name}: {}",
            if connected {
                "connected"
            } else {
                "not_connected"
            }
        )
    })
    .collect::<Vec<_>>()
    .join("\n")
}

async fn wait_for_chat_run(
    state: &AppState,
    user_id: &str,
    runtime_dir: &FsPath,
    session: &mut SessionRecord,
    job_id: &str,
) -> Result<AgentRunInfo, ApiError> {
    let deadline =
        Instant::now() + Duration::from_secs(state.config.codex.max_runtime_seconds.max(1));
    loop {
        let Some(info) = state
            .jobs
            .info_for_user(job_id, user_id, runtime_dir)
            .await?
        else {
            return Err(ApiError::not_found("Agent run not found"));
        };
        if let Some(approval) = info.pending_approval.clone() {
            session.status = "awaiting_permission".to_string();
            session.pending_permission_request = Some(approval.clone());
            state.sessions.save_record(session.clone()).await?;
            return Err(ApiError::conflict(json!({
                "message": "Codex approval required",
                "approval": approval
            })));
        }
        if TERMINAL_STATUSES.contains(&info.status.as_str()) {
            return Ok(info);
        }
        if Instant::now() >= deadline {
            session.status = "failed".to_string();
            state.sessions.save_record(session.clone()).await?;
            return Err(ApiError::new(
                StatusCode::GATEWAY_TIMEOUT,
                "Codex chat run timed out",
            ));
        }
        sleep(Duration::from_millis(50)).await;
    }
}

fn stream_chat_response(
    state: AppState,
    user_id: String,
    mut session: SessionRecord,
    runtime_dir: std::path::PathBuf,
    info: AgentRunInfo,
    model: String,
    user_input: String,
    user_content: Value,
) -> Response<Body> {
    let session_id = session.session_id.clone();
    let chunk_id = format!("chatcmpl-{}", &Uuid::new_v4().simple().to_string()[..24]);
    let created = now_epoch_seconds();
    let events_file = info.events_file.as_ref().map(std::path::PathBuf::from);
    let job_id = info.job_id.clone();
    let stream = stream! {
        yield Ok::<Bytes, Infallible>(Bytes::from(chunk(&chunk_id, &model, created, json!({"role": "assistant"}), None)));
        let mut offset = 0_usize;
        let mut emitted = String::new();
        loop {
            if let Some(events_file) = events_file.as_deref() {
                for event in read_events_from_offset(events_file, &mut offset).await {
                    if let Some(delta) = extract_agent_delta(&event) {
                        emitted.push_str(&delta);
                        yield Ok::<Bytes, Infallible>(Bytes::from(chunk(&chunk_id, &model, created, json!({"content": delta}), None)));
                    }
                }
            }
            let info = state
                .jobs
                .info_for_user(&job_id, &user_id, &runtime_dir)
                .await
                .ok()
                .flatten();
            let Some(info) = info else {
                yield Ok::<Bytes, Infallible>(sse_json(&json!({"type": "error", "message": "Agent run not found"})));
                break;
            };
            if let Some(approval) = info.pending_approval.clone() {
                session.status = "awaiting_permission".to_string();
                session.pending_permission_request = Some(approval.clone());
                let _ = state.sessions.save_record(session.clone()).await;
                yield Ok::<Bytes, Infallible>(sse_json(&json!({"type": "approval_required", "approval": approval})));
                break;
            }
            if TERMINAL_STATUSES.contains(&info.status.as_str()) {
                if info.status == "completed" {
                    let output_text = read_run_output(&info).await;
                    if emitted.is_empty() && !output_text.is_empty() {
                        emitted = output_text.clone();
                        yield Ok::<Bytes, Infallible>(Bytes::from(chunk(&chunk_id, &model, created, json!({"content": output_text}), None)));
                    }
                    append_chat_messages(&mut session, user_content.clone(), &user_input, &emitted);
                    session.status = "idle".to_string();
                    session.pending_permission_request = None;
                    let _ = state.sessions.save_record(session.clone()).await;
                    yield Ok::<Bytes, Infallible>(Bytes::from(chunk(&chunk_id, &model, created, json!({}), Some("stop"))));
                } else {
                    session.status = "failed".to_string();
                    let _ = state.sessions.save_record(session.clone()).await;
                    yield Ok::<Bytes, Infallible>(sse_json(&json!({"type": "error", "message": info.error.unwrap_or_else(|| "Codex run failed".to_string())})));
                }
                break;
            }
            sleep(Duration::from_millis(50)).await;
        }
        yield Ok::<Bytes, Infallible>(Bytes::from_static(b"data: [DONE]\n\n"));
    };
    let mut response = Response::new(Body::from_stream(stream));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response.headers_mut().insert(
        "x-ripple-session-id",
        HeaderValue::from_str(&session_id).unwrap_or_else(|_| HeaderValue::from_static("")),
    );
    response
}

fn append_chat_messages(
    session: &mut SessionRecord,
    user_content: Value,
    user_input: &str,
    assistant_text: &str,
) {
    session.messages.push(json!({
        "role": "user",
        "content": if user_content.is_null() { json!(user_input) } else { user_content },
        "created_at": now_iso()
    }));
    session.messages.push(json!({
        "role": "assistant",
        "content": [{"type": "text", "text": assistant_text}],
        "created_at": now_iso()
    }));
    session.message_count = session.messages.len();
}

fn chat_completion_payload(model: &str, session_id: &str, output_text: String) -> Value {
    json!({
        "id": format!("chatcmpl-{}", &Uuid::new_v4().simple().to_string()[..24]),
        "object": "chat.completion",
        "created": now_epoch_seconds(),
        "model": model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": output_text},
            "finish_reason": "stop"
        }],
        "usage": empty_usage(),
        "session_id": session_id
    })
}

fn chunk(
    chunk_id: &str,
    model: &str,
    created: u64,
    delta: Value,
    finish_reason: Option<&str>,
) -> String {
    let mut choice = json!({"index": 0, "delta": delta, "finish_reason": finish_reason});
    if finish_reason.is_none() {
        choice["finish_reason"] = Value::Null;
    }
    format!(
        "data: {}\n\n",
        serde_json::to_string(&json!({
            "id": chunk_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [choice],
            "usage": empty_usage()
        }))
        .unwrap_or_else(|_| "{}".to_string())
    )
}

fn empty_usage() -> Value {
    json!({
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "last_prompt_tokens": 0,
        "cached_input_tokens": 0,
        "reasoning_output_tokens": 0
    })
}

async fn read_run_output(info: &AgentRunInfo) -> String {
    if let Some(output_file) = info.output_file.as_deref() {
        if let Ok(text) = tokio::fs::read_to_string(output_file).await {
            return text;
        }
    }
    info.stdout_tail.clone()
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

fn extract_agent_delta(event: &Value) -> Option<String> {
    if event.get("type").and_then(Value::as_str) != Some("codex.notification") {
        return None;
    }
    let message = event.pointer("/data/message")?;
    if message.get("method").and_then(Value::as_str) != Some("item/agentMessage/delta") {
        return None;
    }
    message
        .pointer("/params/delta")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn sse_json(value: &Value) -> Bytes {
    Bytes::from(format!(
        "data: {}\n\n",
        serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string())
    ))
}

fn extract_user_input_and_items(
    messages: &[Value],
) -> Result<(String, Vec<Value>, Value), ApiError> {
    let Some(message) = messages
        .iter()
        .rev()
        .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))
    else {
        return Err(ApiError::bad_request("No user message found in messages"));
    };
    let content = message.get("content").cloned().unwrap_or(Value::Null);
    let mut parts = Vec::new();
    let mut items = Vec::new();
    match &content {
        Value::String(text) => parts.push(text.clone()),
        Value::Array(entries) => {
            for entry in entries {
                let item_type = entry.get("type").and_then(Value::as_str).unwrap_or("");
                match item_type {
                    "text" | "input_text" => {
                        if let Some(text) = entry.get("text").and_then(Value::as_str) {
                            parts.push(text.to_string());
                        }
                    }
                    "image" | "input_image" | "image_url" => {
                        if let Some(url) = image_url(entry) {
                            items.push(json!({"type": "image", "url": url}));
                        }
                    }
                    "localImage" | "local_image" => items.push(entry.clone()),
                    _ => {}
                }
            }
        }
        _ => {}
    }
    Ok((parts.join("\n"), items, content))
}

fn image_url(entry: &Value) -> Option<String> {
    entry
        .get("url")
        .and_then(Value::as_str)
        .or_else(|| entry.pointer("/image_url/url").and_then(Value::as_str))
        .or_else(|| entry.get("image_url").and_then(Value::as_str))
        .map(str::to_string)
}

fn extract_caller_system_prompt(messages: &[Value]) -> Option<String> {
    let text = messages
        .iter()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("system"))
        .filter_map(|message| content_text(message.get("content")?))
        .collect::<Vec<_>>()
        .join("\n\n");
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

fn content_text(content: &Value) -> Option<String> {
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(entries) => {
            let text = entries
                .iter()
                .filter_map(|entry| entry.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        }
        _ => None,
    }
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}
