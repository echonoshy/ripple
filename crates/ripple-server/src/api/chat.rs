use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::ffi::OsString;
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
use crate::api::schedule_chat::{maybe_handle_schedule_chat, ScheduleChatDecision};
use crate::api::users::{
    assert_can_create_run, assert_can_create_session, assert_workspace_save_within_quota,
};
use crate::api::ApiError;
use crate::codex::events::{
    extract_codex_runtime_event, extract_plan_update_event, extract_tool_event, extract_usage_event,
};
use crate::jobs::{AgentRunCreateRequest, AgentRunInfo};
use crate::sessions::{
    extract_title_from_messages, record_usage, CreateSessionInput, SessionRecord,
};
use crate::skills::render_skill_manifest;
use crate::state::AppState;
use crate::storage::{sha256_hex, FileRefRecord};
use crate::user::user_id_from_headers;
use crate::workspace as ws;

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
    attachment_items: Vec<Value>,
    caller_system_prompt: Option<String>,
    prefix_event: Option<Value>,
}

struct CodexChatStream {
    state: AppState,
    user_id: String,
    session: SessionRecord,
    workspace_root: PathBuf,
    info: AgentRunInfo,
    model: String,
    user_input: String,
    user_content: Value,
    prefix_event: Option<Value>,
}

struct ChatRunFinal {
    info: AgentRunInfo,
    usage: Value,
}

pub async fn chat_completions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ChatCompletionRequest>,
) -> Result<Response<Body>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let workspace_root = state.sandboxes.ensure_sandbox(&user_id)?;
    let (user_input, input_items, user_content, attachment_items) =
        extract_user_input_and_items(&request.messages, &workspace_root)?;
    if user_input.trim().is_empty() && input_items.is_empty() {
        return Err(ApiError::bad_request("No user message found in messages"));
    }
    let caller_system_prompt = extract_caller_system_prompt(&request.messages);
    let (model, preset_effort) = state.config.resolve_model(request.model.as_deref());
    let effort = request.effort.clone().or(preset_effort);
    if let Some(session_id) = request.session_id.as_deref() {
        let _ = state
            .sessions
            .recover_stale_context_compaction(&user_id, session_id)
            .await?;
    }
    let session_run_lock = request
        .session_id
        .as_deref()
        .map(|session_id| state.sessions.session_lock(&user_id, session_id));
    let session_run_guard = match session_run_lock {
        Some(lock) => Some(lock.lock_owned().await),
        None => None,
    };
    let mut session = load_or_create_session(&state, &user_id, &request).await?;
    let effective_caller_system_prompt = caller_system_prompt
        .clone()
        .or_else(|| session.caller_system_prompt.clone());
    session.caller_system_prompt = effective_caller_system_prompt.clone();
    reconcile_stale_active_session(&state, &user_id, &mut session).await?;
    if session_has_active_run(&session) {
        return Err(ApiError::conflict("Session already has a running task"));
    }
    if let Some(decision) = maybe_handle_schedule_chat(
        &state,
        &user_id,
        &session,
        workspace_root.clone(),
        &user_input,
        &model,
        effort.clone(),
    )
    .await?
    {
        let public_event = persist_control_plane_chat_event(
            &state,
            &mut session,
            &user_content,
            &user_input,
            &decision,
        )
        .await?;
        return Ok(control_plane_event_response(
            &model,
            &session.session_id,
            public_event,
            request.stream.unwrap_or(false),
        ));
    }
    session.pending_permission_request = None;
    session.pending_question = None;
    session.pending_options = None;
    session.pending_schedule_request = None;
    clear_session_plan(&mut session);

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
            assert_can_create_run(&state, &user_id, state.config.codex.max_runtime_seconds).await?;
            session.status = "running".to_string();
            state.sessions.save_record(session.clone()).await?;
            let start = CodexChatStart {
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
                attachment_items: Vec::new(),
                caller_system_prompt: effective_caller_system_prompt.clone(),
                prefix_event: Some(public_connector_auth_event(&decision.event)),
            };
            let info = create_codex_chat_run_marking_start_failure(&start).await?;
            drop(session_run_guard);
            return finish_codex_chat_response(start, info).await;
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

    assert_can_create_run(&state, &user_id, state.config.codex.max_runtime_seconds).await?;
    session.status = "running".to_string();
    state.sessions.save_record(session.clone()).await?;

    let start = CodexChatStart {
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
        attachment_items,
        caller_system_prompt: effective_caller_system_prompt,
        prefix_event: None,
    };
    let info = create_codex_chat_run_marking_start_failure(&start).await?;
    drop(session_run_guard);
    finish_codex_chat_response(start, info).await
}

async fn create_codex_chat_run(args: &CodexChatStart) -> Result<AgentRunInfo, ApiError> {
    let prompt = build_codex_chat_prompt(
        &args.state,
        &args.user_id,
        &args.session.session_id,
        &args.workspace_root,
        &args.user_input,
        &args.attachment_items,
        args.caller_system_prompt.as_deref(),
    );
    let mut native_items = args.input_items.clone();
    native_items.push(json!({"type": "text", "text": prompt}));
    let runtime_dir = args
        .state
        .sandboxes
        .session_dir(&args.user_id, &args.session.session_id)?;
    let create = AgentRunCreateRequest {
        prompt,
        provider: "codex".to_string(),
        cwd: Some("/workspace".to_string()),
        input_items: native_items,
        model: Some(args.model.clone()),
        effort: args.effort.clone(),
        summary: args.request.summary.clone(),
        output_schema: args.request.output_schema.clone(),
        max_runtime_seconds: args.state.config.codex.max_runtime_seconds,
        schedule_id: None,
        schedule_title: None,
        schedule_trigger: None,
        codex_thread_id: args.session.codex_thread_id.clone(),
        codex_persistent_thread: true,
        chat_user_input: Some(args.user_input.clone()),
        chat_user_content: Some(args.user_content.clone()),
    };
    args.state
        .jobs
        .start(
            create,
            args.user_id.clone(),
            Some(args.session.session_id.clone()),
            args.workspace_root.clone(),
            runtime_dir,
        )
        .await
        .map_err(|err| ApiError::bad_request(err.to_string()))
}

async fn create_codex_chat_run_marking_start_failure(
    args: &CodexChatStart,
) -> Result<AgentRunInfo, ApiError> {
    match create_codex_chat_run(args).await {
        Ok(info) => Ok(info),
        Err(err) => {
            let mut session = args.session.clone();
            session.status = "failed".to_string();
            let _ = args
                .state
                .sessions
                .save_record_if_exists(session.clone())
                .await?;
            Err(err)
        }
    }
}

async fn finish_codex_chat_response(
    args: CodexChatStart,
    info: AgentRunInfo,
) -> Result<Response<Body>, ApiError> {
    let CodexChatStart {
        state,
        user_id,
        mut session,
        workspace_root,
        request,
        model,
        effort: _,
        user_input,
        input_items: _,
        user_content,
        attachment_items: _,
        caller_system_prompt: _,
        prefix_event,
    } = args;

    if request.stream.unwrap_or(false) {
        return Ok(stream_chat_response(CodexChatStream {
            state,
            user_id,
            session,
            workspace_root,
            info,
            model,
            user_input,
            user_content,
            prefix_event,
        }));
    }

    let ChatRunFinal {
        info: final_info,
        usage,
    } = wait_for_chat_run(&state, &user_id, &mut session, &info.job_id).await?;
    if final_info.status != "completed" {
        session.status = if final_info.status == "cancelled" {
            "cancelled".to_string()
        } else {
            "failed".to_string()
        };
        let _ = state.sessions.save_record_if_exists(session).await?;
        return Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            final_info
                .error
                .unwrap_or_else(|| "Codex run failed".to_string()),
        ));
    }
    let output_text = read_run_output(&final_info).await;
    let image_events =
        collect_chat_image_events(&state, &user_id, &final_info, &workspace_root).await;
    record_codex_thread(&mut session, &final_info);
    append_chat_messages_with_images(
        &mut session,
        user_content,
        &user_input,
        &output_text,
        &image_events,
    );
    record_usage(&mut session, &usage);
    session.status = "idle".to_string();
    session.pending_permission_request = None;
    let _ = state
        .sessions
        .save_record_if_exists(session.clone())
        .await?;

    let mut payload = chat_completion_payload(&model, &session.session_id, output_text);
    payload["usage"] = usage;
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
    let session_run_guard = state
        .sessions
        .session_lock(&user_id, &session_id)
        .lock_owned()
        .await;
    let Some(mut session) = state.sessions.load(&user_id, &session_id).await? else {
        return Err(ApiError::not_found("Session not found"));
    };
    reconcile_stale_active_session(&state, &user_id, &mut session).await?;
    if session_has_active_run(&session) {
        return Err(ApiError::conflict("Session already has a running task"));
    }
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
        assert_can_create_run(&state, &user_id, state.config.codex.max_runtime_seconds).await?;
        session.status = "running".to_string();
        clear_session_plan(&mut session);
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
        let caller_system_prompt = session.caller_system_prompt.clone();
        let start = CodexChatStart {
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
            attachment_items: Vec::new(),
            caller_system_prompt,
            prefix_event: Some(public_connector_auth_event(&decision.event)),
        };
        let info = create_codex_chat_run_marking_start_failure(&start).await?;
        drop(session_run_guard);
        return finish_codex_chat_response(start, info).await;
    }

    let emit_message = connector_auth_poll_should_emit_message(&decision.event, &pending);
    if connector_auth_poll_should_persist_message(&decision.event, &pending) {
        persist_connector_auth_event(&state, &mut session, &Value::Null, "", &decision.event)
            .await?;
    } else {
        session.status = connector_auth_status(&decision.event).to_string();
        state.sessions.save_record(session.clone()).await?;
    }
    Ok(connector_auth_event_response_with_message(
        &model,
        &session.session_id,
        decision.event,
        request.stream.unwrap_or(true),
        emit_message,
    ))
}

async fn load_or_create_session(
    state: &AppState,
    user_id: &str,
    request: &ChatCompletionRequest,
) -> Result<SessionRecord, ApiError> {
    if let Some(session_id) = request.session_id.as_deref() {
        if let Some(session) = state.sessions.load(user_id, session_id).await? {
            return Ok(session);
        }
    }
    assert_can_create_session(state, user_id).await?;
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
    attachment_items: &[Value],
    system_prompt: Option<&str>,
) -> String {
    let attachment_lines = attachment_items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("attachment"))
        .map(|item| {
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("attachment");
            let path = item
                .get("workspace_path")
                .and_then(Value::as_str)
                .unwrap_or("");
            let mime_type = item
                .get("mime_type")
                .and_then(Value::as_str)
                .unwrap_or("application/octet-stream");
            format!("- {name}: {path} ({mime_type})")
        })
        .collect::<Vec<_>>();
    let attachment_section = if attachment_lines.is_empty() {
        "(none)".to_string()
    } else {
        attachment_lines.join("\n")
    };
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
- Do not call legacy Ripple connector auth tools such as `GoogleWorkspaceLoginStart`, `GoogleWorkspaceLoginComplete`, `GoogleWorkspaceAuthStatus`, `GoogleWorkspaceLogout`, `NotionTokenSet`, `BilibiliLoginStart`, `BilibiliLoginPoll`, `BilibiliAuthStatus`, `BilibiliLogout`, or `AskUser`.\n\
- Google Workspace, Notion, and Feishu authorization is handled by Ripple before the Codex turn starts. For Bilibili tasks, follow the `bilibili` CLI workflow documented by the Bilibili skills.\n\
- Do not collect connector credentials inside Codex; if Google Workspace, Notion, or Feishu is required and not connected, ask the user to authorize it through Ripple.\n\n\
## Available Skills\n\
{}\n\n\
## System Instructions\n\
{}\n\n\
## Conversation State\n\
- The Codex persistent thread is the authoritative execution context and conversation history. Ripple may store display messages, but it does not replay prior turns into this prompt.\n\n\
## Attachments\n\
{}\n\n\
## Current User Request\n\
{}\n",
        connector_manifest(state, user_id),
        render_skill_manifest(&state.config, Some(workspace_root)),
        system_prompt.unwrap_or("(none)"),
        attachment_section,
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
    session: &mut SessionRecord,
    job_id: &str,
) -> Result<ChatRunFinal, ApiError> {
    let deadline =
        Instant::now() + Duration::from_secs(state.config.codex.max_runtime_seconds.max(1));
    let mut latest_usage = empty_usage();
    let mut offset = 0_usize;
    loop {
        let Some(info) = state.jobs.info_for_user(job_id, user_id).await? else {
            return Err(ApiError::not_found("Agent run not found"));
        };
        if let Some(events_file) = info.events_file.as_deref() {
            for event in read_events_from_offset(FsPath::new(events_file), &mut offset).await {
                if let Some(usage_event) = extract_usage_event(&event) {
                    latest_usage = usage_event;
                    continue;
                }
                if let Some(plan_event) = extract_plan_update_event(&event) {
                    record_session_plan_update(session, &plan_event);
                    let _ = state
                        .sessions
                        .save_record_if_exists(session.clone())
                        .await?;
                }
            }
        }
        if let Some(approval) = info.pending_approval.clone() {
            session.status = "awaiting_permission".to_string();
            session.pending_permission_request = Some(approval.clone());
            let _ = state
                .sessions
                .save_record_if_exists(session.clone())
                .await?;
            return Err(ApiError::conflict(json!({
                "message": "Codex approval required",
                "approval": approval
            })));
        }
        if TERMINAL_STATUSES.contains(&info.status.as_str()) {
            return Ok(ChatRunFinal {
                info,
                usage: latest_usage,
            });
        }
        if Instant::now() >= deadline {
            session.status = "failed".to_string();
            let _ = state
                .sessions
                .save_record_if_exists(session.clone())
                .await?;
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
        workspace_root,
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
        let mut image_events = Vec::<Value>::new();
        let mut latest_usage = empty_usage();
        let mut agent_messages = AgentMessageTracker::default();
        let mut last_emit = now_epoch_seconds();
        loop {
            if let Some(events_file) = events_file.as_deref() {
                for event in read_events_from_offset(events_file, &mut offset).await {
                    if let Some(usage_event) = extract_usage_event(&event) {
                        latest_usage = usage_event;
                        continue;
                    }
                    if let Some(image_event) =
                        extract_image_event(&state, &user_id, &event, &workspace_root).await
                    {
                        image_events.push(image_event.clone());
                        yield Ok::<Bytes, Infallible>(sse_json(&image_event));
                        last_emit = now_epoch_seconds();
                        continue;
                    }
                    if let Some(plan_event) = extract_plan_update_event(&event) {
                        record_session_plan_update(&mut session, &plan_event);
                        let _ = state.sessions.save_record_if_exists(session.clone()).await;
                        yield Ok::<Bytes, Infallible>(sse_json(&plan_event));
                        last_emit = now_epoch_seconds();
                        continue;
                    }
                    if let Some(runtime_event) = extract_codex_runtime_event(&event) {
                        yield Ok::<Bytes, Infallible>(sse_json(&runtime_event));
                        last_emit = now_epoch_seconds();
                        continue;
                    }
                    if let Some(tool_event) = extract_tool_event(&event) {
                        yield Ok::<Bytes, Infallible>(sse_json(&tool_event));
                        last_emit = now_epoch_seconds();
                        continue;
                    }
                    if let Some(delta) = agent_messages.handle_delta(&event) {
                        emitted.push_str(&delta);
                        yield Ok::<Bytes, Infallible>(Bytes::from(chunk(&chunk_id, &model, created, json!({"content": delta}), None)));
                        last_emit = now_epoch_seconds();
                        continue;
                    }
                    if let Some(text) = agent_messages.handle_item(&event) {
                        emitted.push_str(&text);
                        yield Ok::<Bytes, Infallible>(Bytes::from(chunk(&chunk_id, &model, created, json!({"content": text}), None)));
                        last_emit = now_epoch_seconds();
                        continue;
                    }
                }
            }
            let info = state
                .jobs
                .info_for_user(&job_id, &user_id)
                .await
                .ok()
                .flatten();
            let Some(info) = info else {
                yield Ok::<Bytes, Infallible>(sse_json(&stream_error("Agent run not found", "server_error")));
                break;
            };
            if let Some(approval) = info.pending_approval.clone() {
                session.status = "awaiting_permission".to_string();
                session.pending_permission_request = Some(approval.clone());
                let _ = state.sessions.save_record_if_exists(session.clone()).await;
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
                    record_codex_thread(&mut session, &info);
                    append_chat_messages_with_images(
                        &mut session,
                        user_content.clone(),
                        &user_input,
                        &emitted,
                        &image_events,
                    );
                    record_usage(&mut session, &latest_usage);
                    session.status = "idle".to_string();
                    session.pending_permission_request = None;
                    clear_session_plan(&mut session);
                    let _ = state.sessions.save_record_if_exists(session.clone()).await;
                    if usage_total_tokens(&latest_usage) > 0 {
                        yield Ok::<Bytes, Infallible>(sse_json(&json!({"type": "usage", "usage": latest_usage})));
                    }
                    yield Ok::<Bytes, Infallible>(Bytes::from(chunk(&chunk_id, &model, created, json!({}), Some("stop"))));
                } else {
                    session.status = if info.status == "cancelled" {
                        "cancelled".to_string()
                    } else {
                        "failed".to_string()
                    };
                    let _ = state.sessions.save_record_if_exists(session.clone()).await;
                    let error_type = if info.status == "cancelled" { "cancelled" } else { "server_error" };
                    yield Ok::<Bytes, Infallible>(sse_json(&stream_error(&info.error.unwrap_or_else(|| "Codex run failed".to_string()), error_type)));
                }
                break;
            }
            let now = now_epoch_seconds();
            if now.saturating_sub(last_emit) >= 8 {
                yield Ok::<Bytes, Infallible>(sse_json(&json!({"type": "heartbeat", "ts": now})));
                last_emit = now;
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

fn record_codex_thread(session: &mut SessionRecord, info: &AgentRunInfo) {
    if let Some(thread_id) = info
        .metadata
        .get("codex_thread_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        session.codex_thread_id = Some(thread_id.to_string());
    }
}

fn session_has_active_run(session: &SessionRecord) -> bool {
    matches!(session.status.as_str(), "queued" | "running")
}

async fn reconcile_stale_active_session(
    state: &AppState,
    user_id: &str,
    session: &mut SessionRecord,
) -> Result<(), ApiError> {
    if !session_has_active_run(session) {
        return Ok(());
    }
    if state
        .jobs
        .has_active_session_run(user_id, &session.session_id)
        .await
    {
        return Ok(());
    }
    let Some(latest_info) = state
        .jobs
        .recover_stale_stored_session_run(user_id, &session.session_id)
        .await?
    else {
        return Ok(());
    };
    let latest_status = latest_info.status.clone();
    if !TERMINAL_STATUSES.contains(&latest_status.as_str()) {
        return Ok(());
    }
    if latest_status == "completed"
        && finalize_stale_completed_chat_run(state, session, &latest_info).await?
    {
        return Ok(());
    }

    session.status = match latest_status.as_str() {
        "completed" => "idle",
        "cancelled" => "cancelled",
        _ => "failed",
    }
    .to_string();
    session.pending_permission_request = None;
    clear_session_plan(session);
    let _ = state
        .sessions
        .save_record_if_exists(session.clone())
        .await?;
    Ok(())
}

async fn finalize_stale_completed_chat_run(
    state: &AppState,
    session: &mut SessionRecord,
    info: &AgentRunInfo,
) -> Result<bool, ApiError> {
    let Some(user_input) = info
        .metadata
        .get("chat_user_input")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return Ok(false);
    };
    let user_content = info
        .metadata
        .get("chat_user_content")
        .cloned()
        .unwrap_or(Value::Null);
    let output_text = read_run_output(info).await;
    let usage = read_run_usage(info).await;
    let image_events = match state.sandboxes.workspace_dir(&session.user_id) {
        Ok(workspace_root) => {
            collect_chat_image_events(state, &session.user_id, info, &workspace_root).await
        }
        Err(_) => Vec::new(),
    };
    record_codex_thread(session, info);
    append_chat_messages_with_images(
        session,
        user_content,
        &user_input,
        &output_text,
        &image_events,
    );
    record_usage(session, &usage);
    session.status = "idle".to_string();
    session.pending_permission_request = None;
    clear_session_plan(session);
    let _ = state
        .sessions
        .save_record_if_exists(session.clone())
        .await?;
    Ok(true)
}

fn record_session_plan_update(session: &mut SessionRecord, update: &Value) {
    if update.get("allCompleted").and_then(Value::as_bool) == Some(true) {
        clear_session_plan(session);
        return;
    }
    session.plan_steps = update
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    session.plan_progress = update
        .get("progress")
        .filter(|value| value.is_object())
        .cloned();
}

fn clear_session_plan(session: &mut SessionRecord) {
    session.plan_steps.clear();
    session.plan_progress = None;
}

async fn persist_control_plane_chat_event(
    state: &AppState,
    session: &mut SessionRecord,
    user_content: &Value,
    user_input: &str,
    decision: &ScheduleChatDecision,
) -> Result<Value, ApiError> {
    let public_event = public_control_plane_event(&decision.event);
    append_chat_messages(
        session,
        user_content.clone(),
        user_input,
        &event_message(&decision.event),
    );
    session.status = decision.status.clone();
    if decision.status == "awaiting_user_input" {
        session.pending_question = decision
            .event
            .get("question")
            .and_then(Value::as_str)
            .map(str::to_string);
        session.pending_options = event_options(&decision.event);
    } else {
        session.pending_question = None;
        session.pending_options = None;
    }
    session.pending_permission_request = None;
    if decision.clear_pending_schedule {
        session.pending_schedule_request = None;
    } else if let Some(pending) = decision.pending_schedule_request.clone() {
        session.pending_schedule_request = Some(pending);
    }
    state.sessions.save_record(session.clone()).await?;
    Ok(public_event)
}

fn append_chat_messages(
    session: &mut SessionRecord,
    user_content: Value,
    user_input: &str,
    assistant_text: &str,
) {
    append_chat_messages_with_images(session, user_content, user_input, assistant_text, &[]);
}

fn append_chat_messages_with_images(
    session: &mut SessionRecord,
    user_content: Value,
    user_input: &str,
    assistant_text: &str,
    image_events: &[Value],
) {
    let mut assistant_content = vec![json!({"type": "text", "text": assistant_text})];
    let mut seen_image_paths = HashSet::<String>::new();
    for image_event in image_events {
        let Some(block) = image_event_to_message_block(image_event) else {
            continue;
        };
        let Some(workspace_path) = block.get("workspace_path").and_then(Value::as_str) else {
            continue;
        };
        if seen_image_paths.insert(workspace_path.to_string()) {
            assistant_content.push(block);
        }
    }

    session.messages.push(json!({
        "role": "user",
        "content": if user_content.is_null() { json!(user_input) } else { user_content },
        "created_at": now_iso()
    }));
    session.messages.push(json!({
        "role": "assistant",
        "content": assistant_content,
        "created_at": now_iso()
    }));
    session.message_count = session.messages.len();
    if session.title.trim().is_empty() {
        session.title = extract_title_from_messages(&session.messages);
    }
}

pub(crate) fn image_event_to_message_block(event: &Value) -> Option<Value> {
    match event.get("type").and_then(Value::as_str) {
        Some("image_generation") | Some("image_view") => {}
        _ => return None,
    }
    let workspace_path = event.get("workspace_path").and_then(Value::as_str)?;
    let mut object = serde_json::Map::new();
    object.insert("type".to_string(), json!("image"));
    object.insert("workspace_path".to_string(), json!(workspace_path));
    if let Some(mime_type) = event.get("mime_type").and_then(Value::as_str) {
        object.insert("mime_type".to_string(), json!(mime_type));
    }
    if let Some(size) = event.get("size").and_then(Value::as_u64) {
        object.insert("size".to_string(), json!(size));
    }
    if let Some(revised_prompt) = event.get("revised_prompt").and_then(Value::as_str) {
        object.insert("revised_prompt".to_string(), json!(revised_prompt));
    }
    Some(Value::Object(object))
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

    for connector in ["notion", "google_workspace", "feishu"] {
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
            notion_token_guidance_message(),
            Some(
                json!({"name": "notion", "ok": true, "stage": "awaiting_token", "detail": "api_token is required.", "data": {}}),
            ),
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
            notion_token_guidance_message(),
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
    } else if is_terminal_connector_auth_stage(&stage) {
        session.pending_connector_auth = None;
        Ok(ConnectorAuthDecision {
            event,
            resume_user_input: None,
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
    let stage = event.get("stage").and_then(Value::as_str).unwrap_or("");
    if event.get("type").and_then(Value::as_str) == Some("connector_auth_required")
        && !is_terminal_connector_auth_stage(stage)
    {
        "awaiting_user_input"
    } else {
        "idle"
    }
}

fn is_terminal_connector_auth_stage(stage: &str) -> bool {
    matches!(stage, "auth_failed" | "invalid_request")
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

fn connector_auth_poll_should_emit_message(event: &Value, previous_pending: &Value) -> bool {
    connector_auth_poll_should_persist_message(event, previous_pending)
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
        "bilibili" => {
            if let Some(data) = data {
                let qrcode_image_url = data.get("qrcode_image_url").and_then(Value::as_str);
                let qrcode_content = data.get("qrcode_content").and_then(Value::as_str);
                if let (Some(qrcode_image_url), Some(qrcode_content)) =
                    (qrcode_image_url, qrcode_content)
                {
                    let app_url = data
                        .get("app_url")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let app_url_section = if app_url.trim().is_empty() {
                        String::new()
                    } else {
                        format!("\n\n{app_url}")
                    };
                    format!(
                        "[BILIBILI_AUTH]\nB 站扫码登录\n\n{qrcode_image_url}\n\n{qrcode_content}{app_url_section}\n\n扫码或点链接确认后，回到这里发送「好了」。"
                    )
                } else if stage == "authorized" {
                    connector_authorized_message(connector).to_string()
                } else {
                    detail.to_string()
                }
            } else if stage == "authorized" {
                connector_authorized_message(connector).to_string()
            } else {
                detail.to_string()
            }
        }
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

fn notion_token_guidance_message() -> &'static str {
    "我需要先绑定 Notion integration token，才能读取你的 Notion 内容。\n\n\
获取方式：\n\
1. 打开 https://www.notion.so/profile/integrations\n\
2. 创建或选择一个 Internal Integration。\n\
3. 复制 Token，格式通常以 ntn_ 或 secret_ 开头。\n\
4. 回到这里，把 Token 直接粘贴发送给我。\n\n\
另外，请在 Notion 里把要读取的 page 或 database Share 给这个 Integration；否则 token 正确也可能读不到内容。"
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
    connector_auth_event_response_with_message(model, session_id, event, stream_response, true)
}

fn connector_auth_event_response_with_message(
    model: &str,
    session_id: &str,
    event: Value,
    stream_response: bool,
    emit_message: bool,
) -> Response<Body> {
    let public_event = public_connector_auth_event(&event);
    if stream_response {
        let chunk_id = format!("chatcmpl-{}", &Uuid::new_v4().simple().to_string()[..24]);
        let model_id = model.to_string();
        let created = now_epoch_seconds();
        let message = if emit_message {
            event_message(&event)
        } else {
            String::new()
        };
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

    let output_text = if emit_message {
        event_message(&event)
    } else {
        String::new()
    };
    let mut payload = chat_completion_payload(model, session_id, output_text);
    payload["connector_auth"] = public_event;
    let mut response = Json(payload).into_response();
    response.headers_mut().insert(
        "x-ripple-session-id",
        HeaderValue::from_str(session_id).unwrap_or_else(|_| HeaderValue::from_static("")),
    );
    response
}

fn control_plane_event_response(
    model: &str,
    session_id: &str,
    event: Value,
    stream_response: bool,
) -> Response<Body> {
    let assistant_text = event_message(&event);
    if stream_response {
        let chunk_id = format!("chatcmpl-{}", &Uuid::new_v4().simple().to_string()[..24]);
        let model_id = model.to_string();
        let created = now_epoch_seconds();
        let stream = stream! {
            yield Ok::<Bytes, Infallible>(Bytes::from(chunk(&chunk_id, &model_id, created, json!({"role": "assistant"}), None)));
            yield Ok::<Bytes, Infallible>(sse_json(&event));
            if let Some(stop_event) = agent_stop_ask_user_event(&event) {
                yield Ok::<Bytes, Infallible>(sse_json(&stop_event));
            }
            if !assistant_text.is_empty() {
                yield Ok::<Bytes, Infallible>(Bytes::from(chunk(&chunk_id, &model_id, created, json!({"content": assistant_text}), None)));
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

    let mut payload = chat_completion_payload(model, session_id, assistant_text);
    payload["event"] = event;
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

fn public_control_plane_event(event: &Value) -> Value {
    let Some(object) = event.as_object() else {
        return event.clone();
    };
    let mut object = object.clone();
    object.remove("user_content");
    object.retain(|_, value| !value.is_null());
    Value::Object(object)
}

fn event_options(event: &Value) -> Option<Vec<String>> {
    let options = event.get("options")?.as_array()?;
    Some(
        options
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
    )
}

fn agent_stop_ask_user_event(event: &Value) -> Option<Value> {
    let question = event.get("question").and_then(Value::as_str)?;
    let options = event_options(event).unwrap_or_default();
    Some(json!({
        "type": "agent_stop",
        "stop_reason": "ask_user",
        "metadata": {
            "message": event_message(event),
            "question": question,
            "options": options,
            "schedule": event.get("schedule").cloned().unwrap_or_else(|| json!({}))
        }
    }))
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
            "choices": [choice]
        }))
        .unwrap_or_else(|_| "{}".to_string())
    )
}

fn usage_total_tokens(usage: &Value) -> u64 {
    usage
        .get("total_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0)
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

async fn read_run_usage(info: &AgentRunInfo) -> Value {
    let mut usage = empty_usage();
    let mut offset = 0_usize;
    if let Some(events_file) = info.events_file.as_deref() {
        for event in read_events_from_offset(FsPath::new(events_file), &mut offset).await {
            if let Some(usage_event) = extract_usage_event(&event) {
                usage = usage_event;
            }
        }
    }
    usage
}

pub(crate) async fn collect_chat_image_events(
    state: &AppState,
    user_id: &str,
    info: &AgentRunInfo,
    workspace_root: &FsPath,
) -> Vec<Value> {
    let mut image_events = Vec::new();
    let mut offset = 0_usize;
    if let Some(events_file) = info.events_file.as_deref() {
        for event in read_events_from_offset(FsPath::new(events_file), &mut offset).await {
            if let Some(image_event) =
                extract_image_event(state, user_id, &event, workspace_root).await
            {
                image_events.push(image_event);
            }
        }
    }
    image_events
}

async fn extract_image_event(
    state: &AppState,
    user_id: &str,
    event: &Value,
    workspace_root: &FsPath,
) -> Option<Value> {
    if event.get("type").and_then(Value::as_str) != Some("codex.notification") {
        return None;
    }
    let message = event.pointer("/data/message")?;
    if message.get("method").and_then(Value::as_str) != Some("item/completed") {
        return None;
    }
    let item = message.pointer("/params/item")?;
    let item_type = item.get("type").and_then(Value::as_str)?;
    if item_type == "imageView" {
        return Some(json!({
            "type": "image_view",
            "id": item.get("id").cloned().unwrap_or(Value::Null),
            "workspace_path": item.get("path").and_then(Value::as_str).and_then(|path| workspace_path_or_none(workspace_root, path))
        }));
    }
    if item_type != "imageGeneration" {
        return None;
    }

    let mut payload = json!({
        "type": "image_generation",
        "id": item.get("id").cloned().unwrap_or(Value::Null),
        "status": item.get("status").cloned().unwrap_or(Value::Null),
        "revised_prompt": item.get("revisedPrompt").cloned().unwrap_or(Value::Null)
    });
    if let Some(imported) = import_generated_image(state, user_id, workspace_root, item).await {
        if let Some(object) = payload.as_object_mut() {
            object.insert("workspace_path".to_string(), json!(imported.workspace_path));
            object.insert("mime_type".to_string(), json!("image/png"));
            object.insert("size".to_string(), json!(imported.size));
        }
    }
    Some(payload)
}

struct ImportedImage {
    workspace_path: String,
    size: usize,
}

async fn import_generated_image(
    state: &AppState,
    user_id: &str,
    workspace_root: &FsPath,
    item: &Value,
) -> Option<ImportedImage> {
    let item_id = item
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("generated-image");
    let data = if let Some(saved_path) = item.get("savedPath").and_then(Value::as_str) {
        read_generated_image_path(workspace_root, saved_path).await
    } else {
        None
    }
    .or_else(|| {
        item.get("result")
            .and_then(Value::as_str)
            .and_then(decode_base64_image_payload)
    })?;

    let now = OffsetDateTime::now_utc();
    let target_dir = workspace_root
        .join("outputs")
        .join("images")
        .join(format!("{:04}", now.year()))
        .join(format!("{:02}", u8::from(now.month())));
    let target = target_dir.join(format!("{}.png", sanitize_filename(item_id)));
    assert_workspace_save_within_quota(state, user_id, &target, data.len() as u64)
        .await
        .ok()?;
    if tokio::fs::create_dir_all(&target_dir).await.is_err() {
        return None;
    }
    if tokio::fs::write(&target, &data).await.is_err() {
        return None;
    }
    let workspace_path = workspace_path_or_none(workspace_root, target.to_str()?)?;
    let file_id = format!(
        "file-{}",
        &sha256_hex(format!("{user_id}:{workspace_path}").as_bytes())[..24]
    );
    state
        .storage
        .upsert_file_ref(&FileRefRecord {
            file_id,
            user_id: user_id.to_string(),
            storage_backend: "local".to_string(),
            storage_uri: workspace_path.clone(),
            workspace_path: Some(workspace_path.clone()),
            mime_type: Some("image/png".to_string()),
            size_bytes: Some(data.len() as u64),
            sha256: Some(sha256_hex(&data)),
            created_at: now_iso(),
            linked_session_id: None,
        })
        .await
        .ok()?;
    Some(ImportedImage {
        workspace_path,
        size: data.len(),
    })
}

async fn read_generated_image_path(workspace_root: &FsPath, raw_path: &str) -> Option<Vec<u8>> {
    let path = host_path_for_image_event_path(workspace_root, raw_path)?;
    let metadata = tokio::fs::metadata(&path).await.ok()?;
    if !metadata.is_file() {
        return None;
    }
    tokio::fs::read(path).await.ok()
}

fn workspace_path_or_none(workspace_root: &FsPath, raw_path: &str) -> Option<String> {
    let path = host_path_for_image_event_path(workspace_root, raw_path)?;
    let workspace = workspace_root.canonicalize().ok()?;
    let resolved = resolve_path_for_workspace_check(&path)?;
    if !resolved.starts_with(&workspace) {
        return None;
    }
    let relative = resolved.strip_prefix(&workspace).ok()?;
    if relative.as_os_str().is_empty() {
        Some("/workspace".to_string())
    } else {
        Some(format!(
            "/workspace/{}",
            relative.to_string_lossy().replace('\\', "/")
        ))
    }
}

fn resolve_path_for_workspace_check(path: &FsPath) -> Option<PathBuf> {
    if path.exists() {
        return path.canonicalize().ok();
    }
    canonicalize_existing_prefix(path).or_else(|| Some(normalize_path(path)))
}

fn canonicalize_existing_prefix(path: &FsPath) -> Option<PathBuf> {
    let mut current = path;
    let mut missing = Vec::<OsString>::new();
    while !current.exists() {
        missing.push(current.file_name()?.to_os_string());
        current = current.parent()?;
    }
    let mut resolved = current.canonicalize().ok()?;
    for component in missing.iter().rev() {
        resolved.push(component);
    }
    Some(resolved)
}

fn host_path_for_image_event_path(workspace_root: &FsPath, raw_path: &str) -> Option<PathBuf> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        if let Ok(relative) = path.strip_prefix("/workspace") {
            Some(workspace_root.join(relative))
        } else {
            Some(path)
        }
    } else {
        Some(workspace_root.join(path))
    }
}

fn normalize_path(path: &FsPath) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn sanitize_filename(name: &str) -> String {
    let clean = name
        .chars()
        .map(|ch| {
            if ch == '/' || ch == '\\' || ch.is_control() {
                '-'
            } else {
                ch
            }
        })
        .collect::<String>()
        .trim_matches(|ch: char| ch == ' ' || ch == '.' || ch == '-')
        .to_string();
    if clean.is_empty() {
        "generated-image".to_string()
    } else {
        clean
    }
}

fn decode_base64_image_payload(payload: &str) -> Option<Vec<u8>> {
    let raw = if payload.starts_with("data:") {
        payload.split_once(',')?.1
    } else {
        payload
    };
    decode_base64(raw)
}

fn decode_base64(input: &str) -> Option<Vec<u8>> {
    let mut buffer = Vec::new();
    let mut quartet = [0_u8; 4];
    let mut count = 0_usize;
    for ch in input.chars().filter(|ch| !ch.is_ascii_whitespace()) {
        let value = match ch {
            'A'..='Z' => ch as u8 - b'A',
            'a'..='z' => ch as u8 - b'a' + 26,
            '0'..='9' => ch as u8 - b'0' + 52,
            '+' => 62,
            '/' => 63,
            '=' => 64,
            _ => return None,
        };
        quartet[count] = value;
        count += 1;
        if count == 4 {
            push_base64_quartet(&mut buffer, quartet)?;
            count = 0;
        }
    }
    if count != 0 {
        return None;
    }
    Some(buffer)
}

fn push_base64_quartet(buffer: &mut Vec<u8>, quartet: [u8; 4]) -> Option<()> {
    let pad = quartet
        .iter()
        .rev()
        .take_while(|value| **value == 64)
        .count();
    if pad > 2 || quartet[..4 - pad].iter().any(|value| *value == 64) {
        return None;
    }
    let a = quartet[0];
    let b = quartet[1];
    let c = if quartet[2] == 64 { 0 } else { quartet[2] };
    let d = if quartet[3] == 64 { 0 } else { quartet[3] };
    buffer.push((a << 2) | (b >> 4));
    if pad < 2 {
        buffer.push((b << 4) | (c >> 2));
    }
    if pad == 0 {
        buffer.push((c << 6) | d);
    }
    Some(())
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

#[derive(Default)]
struct AgentMessageTracker {
    phases: HashMap<String, Option<String>>,
    final_delta_item_ids: HashSet<String>,
    update_delta_item_ids: HashSet<String>,
}

impl AgentMessageTracker {
    fn handle_delta(&mut self, event: &Value) -> Option<String> {
        let (item_id, delta) = agent_message_delta(event)?;
        if let Some(item_id) = item_id {
            if self.phases.get(&item_id).and_then(|phase| phase.as_deref()) == Some("commentary") {
                self.update_delta_item_ids.insert(item_id);
                return None;
            }
            self.final_delta_item_ids.insert(item_id);
        }
        Some(delta)
    }

    fn handle_item(&mut self, event: &Value) -> Option<String> {
        let item = agent_message_item(event)?;
        let item_id = agent_message_item_id(item);
        let phase = agent_message_phase(item);
        if let Some(item_id) = item_id.as_deref() {
            self.phases.insert(item_id.to_string(), phase.clone());
        }
        if codex_notification_method(event) != Some("item/completed") {
            return None;
        }
        if phase.as_deref() == Some("commentary") {
            return None;
        }
        if item_id
            .as_ref()
            .is_some_and(|item_id| self.final_delta_item_ids.contains(item_id))
        {
            return None;
        }
        agent_message_text(item)
    }
}

fn codex_notification_message(event: &Value) -> Option<&Value> {
    if event.get("type").and_then(Value::as_str) != Some("codex.notification") {
        return None;
    }
    event.pointer("/data/message")
}

fn codex_notification_method(event: &Value) -> Option<&str> {
    codex_notification_message(event)?.get("method")?.as_str()
}

fn agent_message_item(event: &Value) -> Option<&Value> {
    let item = codex_notification_message(event)?.pointer("/params/item")?;
    (item.get("type").and_then(Value::as_str) == Some("agentMessage")).then_some(item)
}

fn agent_message_item_id(item: &Value) -> Option<String> {
    item.get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn agent_message_phase(item: &Value) -> Option<String> {
    item.get("phase")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn agent_message_text(item: &Value) -> Option<String> {
    item.get("text")
        .or_else(|| item.get("content"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn agent_message_delta(event: &Value) -> Option<(Option<String>, String)> {
    let message = codex_notification_message(event)?;
    if message.get("method").and_then(Value::as_str) != Some("item/agentMessage/delta") {
        return None;
    }
    let params = message.get("params")?;
    let delta = params
        .get("delta")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())?
        .to_string();
    let item_id = params
        .get("itemId")
        .or_else(|| params.get("item_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Some((item_id, delta))
}

fn sse_json(value: &Value) -> Bytes {
    Bytes::from(format!(
        "data: {}\n\n",
        serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string())
    ))
}

fn stream_error(message: &str, error_type: &str) -> Value {
    json!({
        "error": {
            "message": message,
            "type": error_type
        }
    })
}

fn extract_user_input_and_items(
    messages: &[Value],
    workspace_root: &FsPath,
) -> Result<(String, Vec<Value>, Value, Vec<Value>), ApiError> {
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
    let mut user_content = Vec::new();
    let mut attachment_items = Vec::new();
    match &content {
        Value::String(text) => {
            parts.push(text.clone());
            if !text.trim().is_empty() {
                user_content.push(json!({"type": "text", "text": text}));
            }
        }
        Value::Array(entries) => {
            for entry in entries {
                let item_type = entry.get("type").and_then(Value::as_str).unwrap_or("");
                match item_type {
                    "text" | "input_text" => {
                        if let Some(text) = entry.get("text").and_then(Value::as_str) {
                            parts.push(text.to_string());
                            user_content.push(json!({"type": "text", "text": text}));
                        }
                    }
                    "image" | "input_image" | "image_url" => {
                        if let Some(url) = image_url(entry) {
                            items.push(json!({"type": "image", "url": url}));
                            user_content.push(json!({"type": "image", "url": url}));
                        }
                    }
                    "localImage" | "local_image" => {
                        items.push(entry.clone());
                        user_content.push(entry.clone());
                    }
                    "file" => {
                        if let Some(file_item) = file_item_from_block(entry, workspace_root)? {
                            match file_item.get("type").and_then(Value::as_str) {
                                Some("localImage") | Some("image") => items.push(file_item.clone()),
                                Some("attachment") => attachment_items.push(file_item.clone()),
                                _ => {}
                            }
                            user_content.push(user_content_for_file_item(&file_item));
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    Ok((
        parts.join("\n"),
        items,
        Value::Array(user_content),
        attachment_items,
    ))
}

fn image_url(entry: &Value) -> Option<String> {
    entry
        .get("url")
        .and_then(Value::as_str)
        .or_else(|| entry.pointer("/image_url/url").and_then(Value::as_str))
        .or_else(|| entry.get("image_url").and_then(Value::as_str))
        .map(str::to_string)
}

fn file_item_from_block(entry: &Value, workspace_root: &FsPath) -> Result<Option<Value>, ApiError> {
    let Some(file_info) = entry.get("file").filter(|value| value.is_object()) else {
        return Ok(None);
    };
    let Some(path) = file_info
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let name = file_info
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            FsPath::new(path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("attachment")
                .to_string()
        });
    let mime_type = file_info
        .get("mime_type")
        .or_else(|| file_info.get("mimeType"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| ws::mime_type_for_path(FsPath::new(&name)));

    if path.starts_with("/workspace/") || path == "/workspace" {
        let host_path = ws::validate_existing_path(path, workspace_root)
            .map_err(|err| ApiError::bad_request(err.to_string()))?;
        if !host_path.is_file() {
            return Err(ApiError::bad_request(format!("{path} is not a file")));
        }
        let workspace_path = ws::workspace_path(workspace_root, &host_path)
            .map_err(|err| ApiError::bad_request(err.to_string()))?;
        if is_image_mime_type(&mime_type) {
            return Ok(Some(json!({
                "type": "localImage",
                "path": host_path.to_string_lossy(),
                "workspace_path": workspace_path,
                "name": name,
                "mime_type": mime_type
            })));
        }
        return Ok(Some(json!({
            "type": "attachment",
            "path": host_path.to_string_lossy(),
            "workspace_path": workspace_path,
            "name": name,
            "mime_type": mime_type
        })));
    }

    if let Some(url) = file_info
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if is_image_mime_type(&mime_type) {
            return Ok(Some(json!({
                "type": "image",
                "url": url,
                "name": name,
                "mime_type": mime_type
            })));
        }
    }
    Ok(None)
}

fn user_content_for_file_item(item: &Value) -> Value {
    match item.get("type").and_then(Value::as_str) {
        Some("localImage") => json!({
            "type": "localImage",
            "path": item.get("workspace_path").cloned().unwrap_or(Value::Null),
            "name": item.get("name").cloned().unwrap_or(Value::Null),
            "mime_type": item.get("mime_type").cloned().unwrap_or(Value::Null)
        }),
        Some("attachment") => json!({
            "type": "attachment",
            "path": item.get("workspace_path").cloned().unwrap_or(Value::Null),
            "name": item.get("name").cloned().unwrap_or(Value::Null),
            "mime_type": item.get("mime_type").cloned().unwrap_or(Value::Null)
        }),
        Some("image") => json!({
            "type": "image",
            "url": item.get("url").cloned().unwrap_or(Value::Null)
        }),
        _ => item.clone(),
    }
}

fn is_image_mime_type(mime_type: &str) -> bool {
    mime_type.trim().to_ascii_lowercase().starts_with("image/")
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

    #[test]
    fn bilibili_auth_message_renders_manual_qr_card_tag() {
        let message = connector_auth_message(
            "bilibili",
            &json!({
                "stage": "awaiting_user",
                "detail": "Open qrcode_image_url with the Bilibili app.",
                "data": {
                    "qrcode_image_url": "/v1/bilibili/qrcode.png?content=encoded",
                    "qrcode_content": "https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=abc",
                    "app_url": "bilibili://browser?url=https%3A%2F%2Faccount.bilibili.com%2Fh5%2Faccount-h5%2Fauth%2Fscan-web%3Fqrcode_key%3Dabc"
                }
            }),
        );

        assert!(message.contains("[BILIBILI_AUTH]"));
        assert!(message.contains("/v1/bilibili/qrcode.png"));
        assert!(message.contains("https://account.bilibili.com/h5/account-h5/auth/scan-web"));
        assert!(message.contains("bilibili://browser?url="));
    }

    #[test]
    fn connector_auth_poll_emits_text_only_for_meaningful_progress() {
        let previous = json!({"setup_url": "https://open.feishu.cn/page/cli?user_code=abc"});
        let unchanged = json!({
            "type": "connector_auth_required",
            "stage": "awaiting_setup",
            "message": "重复的飞书 setup 文案",
            "action": {"data": {"setup_url": "https://open.feishu.cn/page/cli?user_code=abc"}}
        });
        let changed = json!({
            "type": "connector_auth_required",
            "stage": "awaiting_user_auth",
            "message": "新的飞书账号授权文案",
            "action": {"data": {"oauth_url": "https://accounts.feishu.cn/device"}}
        });
        let failed = json!({
            "type": "connector_auth_required",
            "stage": "auth_failed",
            "message": "config init --new failed (exit=141)",
            "action": {"data": {}}
        });

        assert!(!connector_auth_poll_should_emit_message(
            &unchanged, &previous
        ));
        assert!(connector_auth_poll_should_emit_message(&changed, &previous));
        assert!(connector_auth_poll_should_emit_message(&failed, &previous));
    }

    #[test]
    fn auth_failed_connector_action_clears_pending_auth() {
        let now = now_iso();
        let mut session = SessionRecord {
            session_id: "srv-test".to_string(),
            user_id: "alice".to_string(),
            title: String::new(),
            pinned: false,
            model: "codex-test".to_string(),
            max_turns: 200,
            caller_system_prompt: None,
            total_input_tokens: 0,
            total_output_tokens: 0,
            last_input_tokens: 0,
            created_at: now.clone(),
            last_active: now,
            status: "awaiting_user_input".to_string(),
            message_count: 0,
            messages: Vec::new(),
            pending_question: None,
            pending_options: None,
            pending_permission_request: None,
            pending_connector_auth: Some(json!({"connector": "feishu"})),
            pending_schedule_request: None,
            codex_thread_id: None,
            plan_steps: Vec::new(),
            plan_progress: None,
        };

        let decision = decision_from_action(
            &mut session,
            "feishu",
            json!({
                "name": "feishu",
                "ok": false,
                "stage": "auth_failed",
                "detail": "config init --new failed (exit=141)",
                "data": {}
            }),
            "继续发飞书消息".to_string(),
        )
        .expect("decision");

        assert!(session.pending_connector_auth.is_none());
        assert_eq!(decision.resume_user_input, None);
        assert_eq!(
            decision.event.get("type").and_then(Value::as_str),
            Some("connector_auth_required")
        );
        assert_eq!(connector_auth_status(&decision.event), "idle");
    }

    #[test]
    fn decodes_base64_image_payloads() {
        assert_eq!(
            decode_base64_image_payload("data:image/png;base64,SGVsbG8=").as_deref(),
            Some(&b"Hello"[..])
        );
        assert_eq!(decode_base64_image_payload("not base64!"), None);
    }

    #[test]
    fn maps_image_event_paths_to_workspace_paths() {
        let root = std::env::temp_dir().join(format!("ripple-chat-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(root.join("dir")).expect("create temp workspace");

        assert_eq!(
            workspace_path_or_none(&root, "/workspace/dir/image.png").as_deref(),
            Some("/workspace/dir/image.png")
        );
        assert_eq!(
            workspace_path_or_none(&root, root.join("dir/image.png").to_str().unwrap()).as_deref(),
            Some("/workspace/dir/image.png")
        );
        assert_eq!(
            workspace_path_or_none(&root, root.join("../outside.png").to_str().unwrap()),
            None
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn extracts_workspace_file_blocks_as_attachments_or_local_images() {
        let root = std::env::temp_dir().join(format!("ripple-chat-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(root.join("docs")).expect("create docs");
        std::fs::write(root.join("docs/report.txt"), "hello").expect("write attachment");
        std::fs::write(root.join("docs/chart.png"), b"png").expect("write image");

        let messages = vec![json!({
            "role": "user",
            "content": [
                {"type": "text", "text": "read these"},
                {"type": "file", "file": {"path": "/workspace/docs/report.txt", "name": "report.txt", "mime_type": "text/plain"}},
                {"type": "file", "file": {"path": "/workspace/docs/chart.png", "name": "chart.png", "mime_type": "image/png"}}
            ]
        })];
        let (text, input_items, user_content, attachments) =
            extract_user_input_and_items(&messages, &root).expect("extract");

        assert_eq!(text, "read these");
        assert_eq!(input_items.len(), 1);
        assert_eq!(
            input_items[0].get("type").and_then(Value::as_str),
            Some("localImage")
        );
        assert_eq!(attachments.len(), 1);
        assert_eq!(
            attachments[0].get("workspace_path").and_then(Value::as_str),
            Some("/workspace/docs/report.txt")
        );
        assert!(user_content
            .as_array()
            .expect("user content")
            .iter()
            .any(|item| item.get("type").and_then(Value::as_str) == Some("attachment")));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn agent_message_tracker_filters_commentary_and_uses_completed_fallback() {
        let mut tracker = AgentMessageTracker::default();
        let commentary_started = json!({
            "type": "codex.notification",
            "data": {"message": {"method": "item/started", "params": {"item": {"id": "u1", "type": "agentMessage", "phase": "commentary"}}}}
        });
        let commentary_delta = json!({
            "type": "codex.notification",
            "data": {"message": {"method": "item/agentMessage/delta", "params": {"itemId": "u1", "delta": "hidden"}}}
        });
        let final_completed = json!({
            "type": "codex.notification",
            "data": {"message": {"method": "item/completed", "params": {"item": {"id": "f1", "type": "agentMessage", "text": "final"}}}}
        });
        let final_delta = json!({
            "type": "codex.notification",
            "data": {"message": {"method": "item/agentMessage/delta", "params": {"itemId": "f2", "delta": "delta"}}}
        });
        let final_completed_after_delta = json!({
            "type": "codex.notification",
            "data": {"message": {"method": "item/completed", "params": {"item": {"id": "f2", "type": "agentMessage", "text": "delta"}}}}
        });

        assert_eq!(tracker.handle_item(&commentary_started), None);
        assert_eq!(tracker.handle_delta(&commentary_delta), None);
        assert_eq!(
            tracker.handle_item(&final_completed).as_deref(),
            Some("final")
        );
        assert_eq!(tracker.handle_delta(&final_delta).as_deref(), Some("delta"));
        assert_eq!(tracker.handle_item(&final_completed_after_delta), None);
    }
}
