use std::convert::Infallible;
use std::path::{Path as FsPath, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use async_stream::stream;
use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, Response, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::time::{sleep, Duration, Instant};
use uuid::Uuid;

use crate::api::connectors::{
    connector_auth_complete_action, connector_auth_start_action, connector_status_value,
    read_valid_bilibili_credential_file,
};
use crate::api::ApiError;
use crate::jobs::{AgentRunCreateRequest, AgentRunInfo};
use crate::sessions::{CreateSessionInput, SessionRecord};
use crate::skills::render_skill_manifest;
use crate::state::AppState;
use crate::user::user_id_from_headers;

const TERMINAL_STATUSES: &[&str] = &["completed", "failed", "cancelled"];
const DONE_SIGNALS: &[&str] = &[
    "好了",
    "扫好了",
    "授权好了",
    "完成了",
    "已完成",
    "done",
    "ok",
    "confirmed",
];

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

#[derive(Debug, Deserialize)]
pub struct ConnectorAuthPollRequest {
    pub model: Option<String>,
    pub stream: Option<bool>,
    pub effort: Option<String>,
}

struct ConnectorAuthDecision {
    event: Value,
    resume_user_input: Option<String>,
}

struct CodexChatStart {
    state: AppState,
    user_id: String,
    session: SessionRecord,
    workspace_root: PathBuf,
    request: ChatCompletionRequest,
    model: String,
    effort: Option<String>,
    user_input: String,
    input_items: Vec<Value>,
    user_content: Value,
    caller_system_prompt: Option<String>,
    prefix_event: Option<Value>,
}

struct CodexChatStream {
    state: AppState,
    user_id: String,
    session: SessionRecord,
    runtime_dir: PathBuf,
    info: AgentRunInfo,
    model: String,
    user_input: String,
    user_content: Value,
    prefix_event: Option<Value>,
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
    session.pending_permission_request = None;
    session.pending_question = None;
    session.pending_options = None;
    session.pending_schedule_request = None;

    if let Some(decision) = maybe_handle_connector_auth(
        &state,
        &user_id,
        &mut session,
        &user_input,
        request_base_url_from_headers(&headers).as_deref(),
    )
    .await?
    {
        if let Some(resume_user_input) = decision.resume_user_input {
            persist_connector_auth_event(
                &state,
                &mut session,
                &user_content,
                &user_input,
                &decision.event,
            )
            .await?;
            session.pending_connector_auth = None;
            session.status = "running".to_string();
            state.sessions.save_record(session.clone()).await?;
            return start_codex_chat_response(CodexChatStart {
                state,
                user_id,
                session,
                workspace_root,
                request,
                model,
                effort,
                user_input: resume_user_input.clone(),
                input_items: Vec::new(),
                user_content: json!(resume_user_input),
                caller_system_prompt,
                prefix_event: Some(public_connector_auth_event(&decision.event)),
            })
            .await;
        }
        persist_connector_auth_event(
            &state,
            &mut session,
            &user_content,
            &user_input,
            &decision.event,
        )
        .await?;
        return Ok(connector_auth_event_response(
            &model,
            &session.session_id,
            decision.event,
            request.stream.unwrap_or(false),
        ));
    }

    session.status = "running".to_string();
    state.sessions.save_record(session.clone()).await?;

    start_codex_chat_response(CodexChatStart {
        state,
        user_id,
        session,
        workspace_root,
        request,
        model,
        effort,
        user_input,
        input_items,
        user_content,
        caller_system_prompt,
        prefix_event: None,
    })
    .await
}

async fn start_codex_chat_response(args: CodexChatStart) -> Result<Response<Body>, ApiError> {
    let CodexChatStart {
        state,
        user_id,
        mut session,
        workspace_root,
        request,
        model,
        effort,
        user_input,
        input_items,
        user_content,
        caller_system_prompt,
        prefix_event,
    } = args;
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
        summary: request.summary,
        output_schema: request.output_schema,
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
        return Ok(stream_chat_response(CodexChatStream {
            state,
            user_id,
            session,
            runtime_dir,
            info,
            model,
            user_input,
            user_content,
            prefix_event,
        }));
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

    let mut payload = chat_completion_payload(&model, &session.session_id, output_text);
    if let Some(event) = prefix_event {
        payload["connector_auth"] = event;
    }
    let mut response = Json(payload).into_response();
    response.headers_mut().insert(
        "x-ripple-session-id",
        HeaderValue::from_str(&session.session_id).unwrap_or_else(|_| HeaderValue::from_static("")),
    );
    Ok(response)
}

pub async fn poll_session_connector_auth(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(request): Json<ConnectorAuthPollRequest>,
) -> Result<Response<Body>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let workspace_root = state.sandboxes.ensure_sandbox(&user_id)?;
    let Some(mut session) = state.sessions.load(&user_id, &session_id)? else {
        return Err(ApiError::not_found("Session not found"));
    };
    let pending = session
        .pending_connector_auth
        .clone()
        .ok_or_else(|| ApiError::conflict("No pending connector auth"))?;
    let connector = pending
        .get("connector")
        .and_then(Value::as_str)
        .unwrap_or("");
    if connector != "feishu" && connector != "google_workspace" {
        return Err(ApiError::conflict(
            "Pending connector auth cannot be polled",
        ));
    }

    let (model, preset_effort) = state.config.resolve_model(request.model.as_deref());
    let effort = request.effort.clone().or(preset_effort);
    let decision = continue_pending_connector_auth(&state, &user_id, &mut session, "").await?;
    let Some(decision) = decision else {
        return Err(ApiError::conflict(
            "Pending connector auth cannot be polled",
        ));
    };
    if let Some(resume_user_input) = decision.resume_user_input {
        persist_connector_auth_event(&state, &mut session, &Value::Null, "", &decision.event)
            .await?;
        session.pending_connector_auth = None;
        session.status = "running".to_string();
        state.sessions.save_record(session.clone()).await?;
        let chat_request = ChatCompletionRequest {
            model: request.model,
            messages: vec![json!({"role": "user", "content": resume_user_input})],
            stream: request.stream,
            session_id: Some(session_id),
            max_turns: None,
            effort: request.effort,
            summary: None,
            output_schema: None,
        };
        let user_input = chat_request
            .messages
            .first()
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        return start_codex_chat_response(CodexChatStart {
            state,
            user_id,
            session,
            workspace_root,
            request: chat_request,
            model,
            effort,
            user_input: user_input.clone(),
            input_items: Vec::new(),
            user_content: json!(user_input),
            caller_system_prompt: None,
            prefix_event: Some(public_connector_auth_event(&decision.event)),
        })
        .await;
    }

    if connector_auth_poll_should_persist_message(&decision.event, &pending) {
        persist_connector_auth_event(&state, &mut session, &Value::Null, "", &decision.event)
            .await?;
    } else {
        session.status = connector_auth_status(&decision.event).to_string();
        state.sessions.save_record(session.clone()).await?;
    }
    Ok(connector_auth_event_response(
        &model,
        &session.session_id,
        decision.event,
        request.stream.unwrap_or(true),
    ))
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

fn stream_chat_response(args: CodexChatStream) -> Response<Body> {
    let CodexChatStream {
        state,
        user_id,
        mut session,
        runtime_dir,
        info,
        model,
        user_input,
        user_content,
        prefix_event,
    } = args;
    let session_id = session.session_id.clone();
    let chunk_id = format!("chatcmpl-{}", &Uuid::new_v4().simple().to_string()[..24]);
    let created = now_epoch_seconds();
    let events_file = info.events_file.as_ref().map(std::path::PathBuf::from);
    let job_id = info.job_id.clone();
    let stream = stream! {
        if let Some(event) = prefix_event {
            yield Ok::<Bytes, Infallible>(Bytes::from(chunk(&chunk_id, &model, created, json!({"role": "assistant"}), None)));
            yield Ok::<Bytes, Infallible>(sse_json(&event));
            let message = event_message(&event);
            if !message.is_empty() {
                yield Ok::<Bytes, Infallible>(Bytes::from(chunk(&chunk_id, &model, created, json!({"content": format!("{message}\n\n")}), None)));
                yield Ok::<Bytes, Infallible>(sse_json(&json!({"type": "new_turn"})));
            }
        } else {
            yield Ok::<Bytes, Infallible>(Bytes::from(chunk(&chunk_id, &model, created, json!({"role": "assistant"}), None)));
        }
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

async fn maybe_handle_connector_auth(
    state: &AppState,
    user_id: &str,
    session: &mut SessionRecord,
    user_input: &str,
    request_base_url: Option<&str>,
) -> Result<Option<ConnectorAuthDecision>, ApiError> {
    if session.pending_connector_auth.is_some() {
        return continue_pending_connector_auth(state, user_id, session, user_input).await;
    }

    for connector in ["notion", "google_workspace", "feishu", "bilibili"] {
        if !mentions_connector(connector, user_input) {
            continue;
        }
        let force_reauth = connector == "feishu" && is_reauth_intent(user_input);
        if connector_is_connected(state, user_id, connector).await? && !force_reauth {
            continue;
        }
        return start_connector_auth_for_chat(
            state,
            user_id,
            session,
            connector,
            user_input,
            request_base_url,
            force_reauth,
        )
        .await
        .map(Some);
    }
    Ok(None)
}

async fn continue_pending_connector_auth(
    state: &AppState,
    user_id: &str,
    session: &mut SessionRecord,
    user_input: &str,
) -> Result<Option<ConnectorAuthDecision>, ApiError> {
    let Some(pending) = session.pending_connector_auth.clone() else {
        return Ok(None);
    };
    let connector = pending
        .get("connector")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if connector.is_empty() {
        return Ok(None);
    }
    if connector_is_connected(state, user_id, &connector).await? {
        let event = connector_auth_event(
            &connector,
            "connector_auth_updated",
            "authorized",
            connector_authorized_message(&connector),
            None,
        );
        return Ok(Some(ConnectorAuthDecision {
            event,
            resume_user_input: pending_resume_user_input(&pending),
        }));
    }

    match connector.as_str() {
        "google_workspace" => {
            let event = connector_auth_event(
                "google_workspace",
                "connector_auth_required",
                pending_stage(&pending, "awaiting_browser_callback"),
                "Google 授权还没有完成。请在刚才打开的 Google 页面点击允许，Ripple 会自动继续。",
                pending.get("action").cloned(),
            );
            Ok(Some(ConnectorAuthDecision {
                event,
                resume_user_input: None,
            }))
        }
        "feishu" => continue_feishu_auth(state, user_id, session, &pending, user_input).await,
        "bilibili" => continue_bilibili_auth(state, user_id, session, &pending, user_input).await,
        "notion" => continue_notion_auth(state, user_id, session, &pending, user_input).await,
        _ => Ok(None),
    }
}

async fn start_connector_auth_for_chat(
    state: &AppState,
    user_id: &str,
    session: &mut SessionRecord,
    connector: &str,
    user_input: &str,
    request_base_url: Option<&str>,
    force_reauth: bool,
) -> Result<ConnectorAuthDecision, ApiError> {
    let payload = match connector {
        "notion" => extract_notion_token(user_input)
            .map(|token| json!({"api_token": token}))
            .unwrap_or_else(|| json!({})),
        "feishu" if force_reauth => json!({"force_new_user_auth": true}),
        _ => json!({}),
    };
    let is_empty_payload = payload
        .as_object()
        .map(serde_json::Map::is_empty)
        .unwrap_or(true);
    if connector == "notion" && is_empty_payload {
        let event = connector_auth_event(
            "notion",
            "connector_auth_required",
            "awaiting_token",
            "请提供 Notion integration token（以 ntn_ 或 secret_ 开头），我会保存到当前 user 的凭证里。",
            Some(json!({"name": "notion", "ok": true, "stage": "awaiting_token", "detail": "api_token is required.", "data": {}})),
        );
        session.pending_connector_auth = Some(pending_from_event(
            connector,
            &event,
            user_input.to_string(),
        ));
        return Ok(ConnectorAuthDecision {
            event,
            resume_user_input: None,
        });
    }

    let action = connector_auth_start_action(state, user_id, connector, &payload, request_base_url)
        .await?
        .0;
    let resume_user_input = if connector == "notion" {
        String::new()
    } else {
        user_input.to_string()
    };
    decision_from_action(session, connector, action, resume_user_input)
}

async fn continue_notion_auth(
    state: &AppState,
    user_id: &str,
    session: &mut SessionRecord,
    pending: &Value,
    user_input: &str,
) -> Result<Option<ConnectorAuthDecision>, ApiError> {
    let Some(token) = extract_notion_token(user_input) else {
        let event = connector_auth_event(
            "notion",
            "connector_auth_required",
            "awaiting_token",
            "请把 Notion integration token 发给我（以 ntn_ 或 secret_ 开头）。",
            pending.get("action").cloned(),
        );
        return Ok(Some(ConnectorAuthDecision {
            event,
            resume_user_input: None,
        }));
    };
    let action =
        connector_auth_start_action(state, user_id, "notion", &json!({"api_token": token}), None)
            .await?
            .0;
    Ok(Some(decision_from_action(
        session,
        "notion",
        action,
        pending_resume_user_input(pending).unwrap_or_default(),
    )?))
}

async fn continue_feishu_auth(
    state: &AppState,
    user_id: &str,
    session: &mut SessionRecord,
    pending: &Value,
    user_input: &str,
) -> Result<Option<ConnectorAuthDecision>, ApiError> {
    if pending
        .get("device_code_finalized")
        .and_then(Value::as_bool)
        == Some(true)
        && !is_reauth_intent(user_input)
    {
        let event = connector_auth_event(
            "feishu",
            "connector_auth_required",
            pending_stage(pending, "pending"),
            "飞书还没有确认到用户授权完成。请确认飞书页面已经点击允许/确认；如果页面已经关闭，请回复「重新授权」。",
            pending.get("action").cloned(),
        );
        return Ok(Some(ConnectorAuthDecision {
            event,
            resume_user_input: None,
        }));
    }
    if is_reauth_intent(user_input) {
        let action = connector_auth_start_action(
            state,
            user_id,
            "feishu",
            &json!({"force_new_user_auth": true}),
            None,
        )
        .await?
        .0;
        return Ok(Some(decision_from_action(
            session,
            "feishu",
            action,
            pending_resume_user_input(pending).unwrap_or_else(|| user_input.to_string()),
        )?));
    }
    let device_code = pending
        .get("device_code")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let action = if device_code.is_empty() {
        connector_auth_start_action(state, user_id, "feishu", &json!({}), None)
            .await?
            .0
    } else {
        connector_auth_complete_action(
            state,
            user_id,
            "feishu",
            &json!({"device_code": device_code}),
        )
        .await?
        .0
    };
    Ok(Some(decision_from_action(
        session,
        "feishu",
        action,
        pending_resume_user_input(pending).unwrap_or_else(|| user_input.to_string()),
    )?))
}

async fn continue_bilibili_auth(
    state: &AppState,
    user_id: &str,
    session: &mut SessionRecord,
    pending: &Value,
    user_input: &str,
) -> Result<Option<ConnectorAuthDecision>, ApiError> {
    if !is_done_signal(user_input) {
        let event = connector_auth_event(
            "bilibili",
            "connector_auth_required",
            pending_stage(pending, "awaiting_user"),
            "Bilibili 扫码登录还在等待完成。请用 B 站 App 扫码并确认登录，扫完后回我「好了」。",
            pending.get("action").cloned(),
        );
        return Ok(Some(ConnectorAuthDecision {
            event,
            resume_user_input: None,
        }));
    }
    let qrcode_key = pending
        .get("qrcode_key")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if qrcode_key.is_empty() {
        let event = connector_auth_event(
            "bilibili",
            "connector_auth_required",
            "invalid_request",
            "Bilibili 授权状态缺少 qrcode_key，请重新发起扫码登录。",
            pending.get("action").cloned(),
        );
        return Ok(Some(ConnectorAuthDecision {
            event,
            resume_user_input: None,
        }));
    }
    let action = connector_auth_complete_action(
        state,
        user_id,
        "bilibili",
        &json!({"qrcode_key": qrcode_key, "max_wait_seconds": 30}),
    )
    .await?
    .0;
    Ok(Some(decision_from_action(
        session,
        "bilibili",
        action,
        pending_resume_user_input(pending).unwrap_or_else(|| user_input.to_string()),
    )?))
}

fn decision_from_action(
    session: &mut SessionRecord,
    connector: &str,
    action: Value,
    resume_user_input: String,
) -> Result<ConnectorAuthDecision, ApiError> {
    let stage = action
        .get("stage")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let event_type = if stage == "authorized" {
        "connector_auth_updated"
    } else {
        "connector_auth_required"
    };
    let message = connector_auth_message(connector, &action);
    let mut event = connector_auth_event(connector, event_type, &stage, &message, Some(action));
    if connector == "notion" {
        event["user_content"] = json!([{"type": "text", "text": "[Notion token redacted]"}]);
    }
    if stage == "authorized" {
        session.pending_connector_auth = None;
        Ok(ConnectorAuthDecision {
            event,
            resume_user_input: if resume_user_input.trim().is_empty() {
                None
            } else {
                Some(resume_user_input)
            },
        })
    } else {
        session.pending_connector_auth =
            Some(pending_from_event(connector, &event, resume_user_input));
        Ok(ConnectorAuthDecision {
            event,
            resume_user_input: None,
        })
    }
}

async fn persist_connector_auth_event(
    state: &AppState,
    session: &mut SessionRecord,
    user_content: &Value,
    user_input: &str,
    event: &Value,
) -> Result<(), ApiError> {
    if !user_input.trim().is_empty() {
        let persisted_user_content = event
            .get("user_content")
            .filter(|value| value.is_array())
            .cloned()
            .unwrap_or_else(|| {
                if user_content.is_null() {
                    json!(user_input)
                } else {
                    user_content.clone()
                }
            });
        session.messages.push(json!({
            "role": "user",
            "content": persisted_user_content,
            "created_at": now_iso()
        }));
    }
    if let Some(message) = event.get("message").and_then(Value::as_str) {
        if !message.trim().is_empty() {
            session.messages.push(json!({
                "role": "assistant",
                "content": [{"type": "text", "text": message}],
                "created_at": now_iso()
            }));
        }
    }
    if connector_auth_status(event) == "idle" {
        session.pending_connector_auth = None;
    }
    session.status = connector_auth_status(event).to_string();
    state.sessions.save_record(session.clone()).await?;
    Ok(())
}

fn connector_auth_status(event: &Value) -> &'static str {
    if event.get("type").and_then(Value::as_str) == Some("connector_auth_required") {
        "awaiting_user_input"
    } else {
        "idle"
    }
}

fn connector_auth_poll_should_persist_message(event: &Value, previous_pending: &Value) -> bool {
    let stage = event.get("stage").and_then(Value::as_str).unwrap_or("");
    if event.get("type").and_then(Value::as_str) == Some("connector_auth_updated") {
        return true;
    }
    if stage == "auth_failed" || stage == "invalid_request" {
        return true;
    }

    let Some(data) = event.pointer("/action/data").and_then(Value::as_object) else {
        return false;
    };
    if data.get("device_code_finalized").and_then(Value::as_bool) == Some(true) {
        return true;
    }

    for key in ["setup_url", "oauth_url"] {
        let value = data.get(key).and_then(Value::as_str).unwrap_or("");
        if !value.is_empty()
            && previous_pending
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                != value
        {
            return true;
        }
    }
    false
}

fn public_connector_auth_event(event: &Value) -> Value {
    let Some(object) = event.as_object() else {
        return event.clone();
    };
    let mut object = object.clone();
    object.remove("user_content");
    object.retain(|_, value| !value.is_null());
    Value::Object(object)
}

fn pending_from_event(connector: &str, event: &Value, resume_user_input: String) -> Value {
    let data = event
        .pointer("/action/data")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut pending = serde_json::Map::new();
    pending.insert("connector".to_string(), json!(connector));
    pending.insert(
        "stage".to_string(),
        event
            .get("stage")
            .cloned()
            .unwrap_or_else(|| json!("pending")),
    );
    pending.insert("resume_user_input".to_string(), json!(resume_user_input));
    pending.insert(
        "action".to_string(),
        event.get("action").cloned().unwrap_or(Value::Null),
    );
    for key in [
        "device_code",
        "oauth_url",
        "setup_url",
        "qrcode_key",
        "callback_mode",
        "assisted_callback_url",
        "device_code_finalized",
    ] {
        if let Some(value) = data.get(key) {
            pending.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(pending)
}

fn connector_auth_event(
    connector: &str,
    event_type: &str,
    stage: &str,
    message: &str,
    action: Option<Value>,
) -> Value {
    json!({
        "type": event_type,
        "connector": connector,
        "display_name": connector_display_name(connector),
        "auth_flow": connector_auth_flow(connector),
        "stage": stage,
        "message": message,
        "action": action
    })
}

fn connector_auth_message(connector: &str, action: &Value) -> String {
    let stage = action
        .get("stage")
        .and_then(Value::as_str)
        .unwrap_or("pending");
    let detail = action.get("detail").and_then(Value::as_str).unwrap_or("");
    let data = action.get("data").and_then(Value::as_object);
    match connector {
        "google_workspace" => data
            .and_then(|data| data.get("oauth_url"))
            .and_then(Value::as_str)
            .map(|url| {
                format!(
                    "[GOOGLE_AUTH]\nGoogle Workspace 授权\n\n请打开下面的授权链接并点击允许：\n\n{url}\n\n授权完成后 Ripple 会自动继续。"
                )
            })
            .unwrap_or_else(|| {
                if stage == "authorized" {
                    connector_authorized_message(connector).to_string()
                } else {
                    detail.to_string()
                }
            }),
        "feishu" => {
            if let Some(setup_url) = data
                .and_then(|data| data.get("setup_url"))
                .and_then(Value::as_str)
            {
                format!(
                    "[FEISHU_SETUP]\n第 1/2 步：准备飞书连接。\n\n首次使用需要在飞书页面完成一次性准备。完成后 Ripple 会自动进入账号授权。\n\n{setup_url}\n\n请保持当前页面打开；Ripple 会自动检查并继续第 2 步。"
                )
            } else if let Some(oauth_url) = data
                .and_then(|data| data.get("oauth_url"))
                .and_then(Value::as_str)
            {
                format!(
                    "[FEISHU_AUTH]\n第 2/2 步：授权你的飞书账号。\n\n授权后 Ripple 会以你的飞书账号继续执行刚才的请求；发送消息会显示为你本人。\n\n{oauth_url}\n\n请保持当前页面打开；授权完成后 Ripple 会自动继续。"
                )
            } else if stage == "authorized" {
                connector_authorized_message(connector).to_string()
            } else {
                detail.to_string()
            }
        }
        "bilibili" => data
            .and_then(|data| data.get("qrcode_image_url"))
            .and_then(Value::as_str)
            .map(|url| {
                format!(
                    "请打开这个二维码链接，用 B 站 App 扫码并确认登录：\n\n{url}\n\n扫完后回到这里告诉我「好了」。"
                )
            })
            .unwrap_or_else(|| {
                if stage == "authorized" {
                    connector_authorized_message(connector).to_string()
                } else {
                    detail.to_string()
                }
            }),
        "notion" => {
            if stage == "authorized" {
                connector_authorized_message(connector).to_string()
            } else {
                detail.to_string()
            }
        }
        _ => detail.to_string(),
    }
}

async fn connector_is_connected(
    state: &AppState,
    user_id: &str,
    connector: &str,
) -> Result<bool, ApiError> {
    Ok(connector_status_value(state, user_id, connector)
        .await?
        .get("connected")
        .and_then(Value::as_bool)
        .unwrap_or(false))
}

fn connector_display_name(connector: &str) -> &'static str {
    match connector {
        "google_workspace" => "Google Workspace",
        "notion" => "Notion",
        "feishu" => "Feishu",
        "bilibili" => "Bilibili",
        _ => "Connector",
    }
}

fn connector_auth_flow(connector: &str) -> &'static str {
    match connector {
        "google_workspace" => "oauth_assisted",
        "notion" => "token",
        "feishu" => "oauth_device",
        "bilibili" => "qr",
        _ => "unknown",
    }
}

fn connector_authorized_message(connector: &str) -> &'static str {
    match connector {
        "google_workspace" => "Google Workspace 授权已完成。继续执行刚才的请求。",
        "notion" => "Notion token 已保存。继续执行刚才的请求。",
        "feishu" => "飞书授权已完成。继续执行刚才的请求。",
        "bilibili" => "Bilibili 已授权。继续执行刚才的请求。",
        _ => "Connector authorization completed. Continuing.",
    }
}

fn pending_resume_user_input(pending: &Value) -> Option<String> {
    pending
        .get("resume_user_input")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn pending_stage<'a>(pending: &'a Value, fallback: &'a str) -> &'a str {
    pending
        .get("stage")
        .and_then(Value::as_str)
        .unwrap_or(fallback)
}

fn mentions_connector(connector: &str, text: &str) -> bool {
    let normalized = text.to_ascii_lowercase();
    match connector {
        "google_workspace" => [
            "google",
            "gmail",
            "gog",
            "drive",
            "calendar",
            "docs",
            "sheets",
            "slides",
            "workspace",
            "谷歌",
            "日历",
            "邮箱",
        ]
        .into_iter()
        .any(|marker| normalized.contains(marker) || text.contains(marker)),
        "notion" => {
            normalized.contains("notion")
                || normalized.contains("ntn_")
                || normalized.contains("secret_")
        }
        "feishu" => {
            normalized.contains("feishu")
                || normalized.contains("lark")
                || text.contains("飞书")
                || text.contains("飛書")
        }
        "bilibili" => {
            normalized.contains("bilibili")
                || normalized.contains("b站")
                || normalized.contains("bv")
                || text.contains("哔哩")
                || text.contains("B站")
        }
        _ => false,
    }
}

fn is_done_signal(text: &str) -> bool {
    let normalized = text.trim().to_ascii_lowercase();
    DONE_SIGNALS
        .iter()
        .any(|signal| normalized.contains(&signal.to_ascii_lowercase()))
}

fn is_reauth_intent(text: &str) -> bool {
    let normalized = text.to_ascii_lowercase();
    normalized.contains("reauth")
        || normalized.contains("restart")
        || text.contains("重新授权")
        || text.contains("重新登录")
}

fn extract_notion_token(text: &str) -> Option<String> {
    text.split(|ch: char| ch.is_whitespace() || ch == '"' || ch == '\'' || ch == '`')
        .map(|part| {
            part.trim_matches(|ch: char| ch == ',' || ch == ';' || ch == '，' || ch == '。')
        })
        .find(|part| {
            (part.starts_with("ntn_") || part.starts_with("secret_"))
                && part.len() >= 20
                && part.len() <= 200
        })
        .map(str::to_string)
}

fn request_base_url_from_headers(headers: &HeaderMap) -> Option<String> {
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get("host"))?
        .to_str()
        .ok()?
        .split(',')
        .next()?
        .trim();
    if host.is_empty() {
        return None;
    }
    let proto = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| *value == "http" || *value == "https")
        .unwrap_or("http");
    Some(format!("{proto}://{host}"))
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

fn connector_auth_event_response(
    model: &str,
    session_id: &str,
    event: Value,
    stream_response: bool,
) -> Response<Body> {
    let public_event = public_connector_auth_event(&event);
    if stream_response {
        let chunk_id = format!("chatcmpl-{}", &Uuid::new_v4().simple().to_string()[..24]);
        let model_id = model.to_string();
        let created = now_epoch_seconds();
        let message = event_message(&event);
        let stream = stream! {
            yield Ok::<Bytes, Infallible>(Bytes::from(chunk(&chunk_id, &model_id, created, json!({"role": "assistant"}), None)));
            yield Ok::<Bytes, Infallible>(sse_json(&public_event));
            if !message.is_empty() {
                yield Ok::<Bytes, Infallible>(Bytes::from(chunk(&chunk_id, &model_id, created, json!({"content": message}), None)));
            }
            yield Ok::<Bytes, Infallible>(Bytes::from(chunk(&chunk_id, &model_id, created, json!({}), Some("stop"))));
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
            HeaderValue::from_str(session_id).unwrap_or_else(|_| HeaderValue::from_static("")),
        );
        return response;
    }

    let mut payload = chat_completion_payload(model, session_id, event_message(&event));
    payload["connector_auth"] = public_event;
    let mut response = Json(payload).into_response();
    response.headers_mut().insert(
        "x-ripple-session-id",
        HeaderValue::from_str(session_id).unwrap_or_else(|_| HeaderValue::from_static("")),
    );
    response
}

fn event_message(event: &Value) -> String {
    event
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_notion_token_without_trailing_punctuation() {
        assert_eq!(
            extract_notion_token("token: secret_abcdefghijklmnopqrstuvwxyz，").as_deref(),
            Some("secret_abcdefghijklmnopqrstuvwxyz")
        );
        assert_eq!(extract_notion_token("secret_short"), None);
    }

    #[test]
    fn public_connector_auth_event_hides_internal_user_content() {
        let event = json!({
            "type": "connector_auth_updated",
            "connector": "notion",
            "stage": "authorized",
            "action": null,
            "user_content": [{"type": "text", "text": "[Notion token redacted]"}]
        });
        let public = public_connector_auth_event(&event);

        assert!(public.get("user_content").is_none());
        assert!(public.get("action").is_none());
        assert_eq!(
            public.get("connector").and_then(Value::as_str),
            Some("notion")
        );
    }

    #[test]
    fn connector_auth_poll_persists_only_meaningful_progress() {
        let previous = json!({"oauth_url": "https://old.example/auth"});
        let unchanged = json!({
            "type": "connector_auth_required",
            "stage": "awaiting_user_auth",
            "action": {"data": {"oauth_url": "https://old.example/auth"}}
        });
        let changed = json!({
            "type": "connector_auth_required",
            "stage": "awaiting_user_auth",
            "action": {"data": {"oauth_url": "https://new.example/auth"}}
        });
        let authorized = json!({
            "type": "connector_auth_updated",
            "stage": "authorized"
        });

        assert!(!connector_auth_poll_should_persist_message(
            &unchanged, &previous
        ));
        assert!(connector_auth_poll_should_persist_message(
            &changed, &previous
        ));
        assert!(connector_auth_poll_should_persist_message(
            &authorized,
            &previous
        ));
    }
}
