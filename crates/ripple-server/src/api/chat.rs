use std::collections::{HashMap, HashSet};
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

use crate::api::capabilities::catalog_skill_manifest_options_for_user;
use crate::api::run_public::{sanitize_user_visible_text, sanitize_user_visible_value};
use crate::api::skill_chat::maybe_handle_skill_chat;
use crate::api::task_trigger_chat::{maybe_handle_task_trigger_chat, TaskTriggerChatDecision};
use crate::api::users::{assert_can_create_run, assert_can_create_session};
use crate::api::ApiError;
use crate::codex::events::{
    extract_codex_runtime_event, extract_plan_update_event, extract_tool_event, extract_usage_event,
};
use crate::jobs::{AgentRunCreateRequest, AgentRunInfo};
use crate::sessions::{
    extract_title_from_messages, record_usage, validate_session_id, CreateSessionInput,
    SessionRecord, SessionStatus,
};
use crate::skills::{build_skill_manifest_with_options, public_skill_path, SkillManifestOptions};
use crate::state::AppState;
use crate::user::user_id_from_headers;

pub(crate) mod connector_auth;
mod input;
mod media;
mod project_context;
mod prompt;
mod recent_context;
mod session_actions;
mod title;
mod wire;

#[cfg(test)]
use connector_auth::{connector_auth_message, decision_from_action, extract_notion_token};
use connector_auth::{
    connector_auth_poll_should_emit_message, connector_auth_poll_should_persist_message,
    connector_auth_status, continue_pending_connector_auth, maybe_handle_connector_auth,
    model_connector_auth_request_might_be_start, parse_model_connector_auth_request,
    persist_connector_auth_event, public_connector_auth_event, start_model_connector_auth_for_chat,
};
use input::extract_control_action_from_messages;
pub(crate) use input::{extract_caller_system_prompt, extract_user_input_and_items};
pub(crate) use media::{
    collect_chat_image_events, extract_image_event, image_event_to_message_block,
};
#[cfg(test)]
use media::{decode_base64_image_payload, workspace_path_or_none};
use project_context::collect_folder_context;
pub(crate) use prompt::{
    build_codex_chat_base_instructions, build_codex_chat_turn_context, RequiredSkillContext,
};
#[cfg(test)]
use recent_context::recent_task_triggers_context_from_records;
use recent_context::{recent_display_context, recent_task_triggers_context};
use session_actions::handle_session_control_action;
use title::spawn_session_title_generation;
use wire::{
    assistant_delta_sse, assistant_done_sse, connector_auth_event_response,
    connector_auth_event_response_with_message, control_plane_event_response, event_message,
    event_options, public_control_plane_event, response_created_sse, response_id_for_session,
    responses_payload, sse_for_event, sse_json, stream_error,
};

const TERMINAL_STATUSES: &[&str] = &["completed", "failed", "cancelled"];

#[derive(Debug, Deserialize)]
pub struct InternalChatRequest {
    pub model: Option<String>,
    pub messages: Vec<Value>,
    pub stream: Option<bool>,
    pub session_id: Option<String>,
    #[serde(default)]
    pub required_skill_ids: Vec<String>,
    #[serde(default)]
    pub preferred_skill_ids: Vec<String>,
    #[serde(default)]
    pub screen_context: Option<Value>,
    #[serde(default)]
    pub temporary: bool,
    pub max_turns: Option<u32>,
    pub effort: Option<String>,
    pub summary: Option<String>,
    #[serde(rename = "outputSchema")]
    pub output_schema: Option<Value>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct ResponsesCreateRequest {
    pub model: Option<String>,
    pub input: Value,
    pub instructions: Option<String>,
    pub stream: Option<bool>,
    pub previous_response_id: Option<String>,
    pub metadata: Option<Value>,
    pub store: Option<bool>,
    pub reasoning: Option<Value>,
    pub text: Option<Value>,
}

impl ResponsesCreateRequest {
    fn into_chat_request(self) -> Result<InternalChatRequest, ApiError> {
        let session_id =
            responses_session_id(self.previous_response_id.as_deref(), self.metadata.as_ref())?;
        let required_skill_ids = metadata_string_list(
            self.metadata.as_ref(),
            &["required_skill_ids", "selected_skill_ids"],
        )?;
        let preferred_skill_ids =
            metadata_string_list(self.metadata.as_ref(), &["preferred_skill_ids"])?;
        let screen_context = metadata_screen_context(self.metadata.as_ref())?;
        let effort = self
            .reasoning
            .as_ref()
            .and_then(|value| value.get("effort"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let summary = self
            .reasoning
            .as_ref()
            .and_then(|value| value.get("summary"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let output_schema = responses_output_schema(self.text.as_ref());
        Ok(InternalChatRequest {
            model: self.model,
            messages: responses_input_to_messages(self.input, self.instructions)?,
            stream: self.stream,
            session_id,
            required_skill_ids,
            preferred_skill_ids,
            screen_context,
            temporary: self.store == Some(false),
            max_turns: None,
            effort,
            summary,
            output_schema,
        })
    }
}

fn responses_session_id(
    previous_response_id: Option<&str>,
    metadata: Option<&Value>,
) -> Result<Option<String>, ApiError> {
    let metadata_session_id = metadata
        .and_then(|value| {
            value
                .get("ripple_session_id")
                .or_else(|| value.get("session_id"))
        })
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let session_id = metadata_session_id.or_else(|| {
        previous_response_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.strip_prefix("resp_").unwrap_or(value))
    });
    let Some(session_id) = session_id else {
        return Ok(None);
    };
    validate_session_id(session_id).map_err(ApiError::bad_request)?;
    Ok(Some(session_id.to_string()))
}

fn metadata_string_list(metadata: Option<&Value>, keys: &[&str]) -> Result<Vec<String>, ApiError> {
    let Some(metadata) = metadata else {
        return Ok(Vec::new());
    };
    let mut values = Vec::new();
    for key in keys {
        let Some(value) = metadata.get(*key) else {
            continue;
        };
        let Some(items) = value.as_array() else {
            return Err(ApiError::bad_request(format!(
                "{key} must be an array of strings"
            )));
        };
        for item in items {
            let Some(text) = item.as_str() else {
                return Err(ApiError::bad_request(format!(
                    "{key} must be an array of strings"
                )));
            };
            let trimmed = text.trim();
            if !trimmed.is_empty() && !values.iter().any(|existing| existing == trimmed) {
                values.push(trimmed.to_string());
            }
        }
    }
    Ok(values)
}

fn metadata_screen_context(metadata: Option<&Value>) -> Result<Option<Value>, ApiError> {
    let Some(metadata) = metadata else {
        return Ok(None);
    };
    for key in ["client_context", "screen_context"] {
        let Some(value) = metadata.get(key) else {
            continue;
        };
        if value.is_null() {
            continue;
        }
        if !value.is_object() {
            return Err(ApiError::bad_request(format!("{key} must be an object")));
        }
        return Ok(Some(value.clone()));
    }
    Ok(None)
}

fn context_requests_ui_explainer(screen_context: Option<&Value>) -> bool {
    screen_context_app_is_ripple(screen_context) || client_context_uses_mvp_schema(screen_context)
}

fn client_context_uses_mvp_schema(screen_context: Option<&Value>) -> bool {
    screen_context
        .and_then(|value| value.get("schema_version"))
        .and_then(Value::as_str)
        .map(str::trim)
        .map(|value| value.eq_ignore_ascii_case("ripple.client_context.v1"))
        .unwrap_or(false)
}

fn context_app_value(screen_context: Option<&Value>) -> Option<&str> {
    let value = screen_context?;
    value
        .get("app")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .pointer("/software/screen/app")
                .and_then(Value::as_str)
        })
        .or_else(|| {
            value
                .pointer("/software/host_app/app_id")
                .and_then(Value::as_str)
        })
}

fn is_ripple_app_value(value: &str) -> bool {
    let value = value.trim();
    value.eq_ignore_ascii_case("ripple")
        || value.eq_ignore_ascii_case("ripple.app")
        || value.eq_ignore_ascii_case("ripple.chat")
}

fn responses_input_to_messages(
    input: Value,
    instructions: Option<String>,
) -> Result<Vec<Value>, ApiError> {
    let mut messages = Vec::new();
    if let Some(instructions) = instructions
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        messages.push(json!({"role": "system", "content": instructions}));
    }
    match input {
        Value::String(text) => {
            messages.push(json!({"role": "user", "content": text}));
        }
        Value::Array(items) => {
            for item in items {
                let Some(object) = item.as_object() else {
                    return Err(ApiError::bad_request(
                        "Responses input array entries must be objects",
                    ));
                };
                let role = object.get("role").and_then(Value::as_str).unwrap_or("user");
                let content = object
                    .get("content")
                    .cloned()
                    .or_else(|| object.get("text").cloned())
                    .unwrap_or(Value::Null);
                messages.push(json!({
                    "role": role,
                    "content": normalize_responses_content(content)
                }));
            }
        }
        Value::Object(object) => {
            let role = object.get("role").and_then(Value::as_str).unwrap_or("user");
            let content = object
                .get("content")
                .cloned()
                .or_else(|| object.get("text").cloned())
                .unwrap_or(Value::Null);
            messages.push(json!({
                "role": role,
                "content": normalize_responses_content(content)
            }));
        }
        _ => {
            return Err(ApiError::bad_request(
                "Responses input must be a string, object, or array",
            ));
        }
    }
    Ok(messages)
}

fn normalize_responses_content(content: Value) -> Value {
    match content {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| match item {
                    Value::Object(mut object) => {
                        if object.get("type").and_then(Value::as_str) == Some("output_text") {
                            object.insert("type".to_string(), json!("text"));
                        }
                        Value::Object(object)
                    }
                    value => value,
                })
                .collect(),
        ),
        value => value,
    }
}

fn responses_output_schema(text: Option<&Value>) -> Option<Value> {
    let format = text?.get("format")?;
    if format.get("type").and_then(Value::as_str) == Some("json_schema") {
        return format
            .get("schema")
            .cloned()
            .or_else(|| Some(format.clone()));
    }
    None
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct ConnectorAuthPollRequest {
    pub model: Option<String>,
    pub stream: Option<bool>,
    pub effort: Option<String>,
}

struct CodexChatStart {
    state: AppState,
    user_id: String,
    session: SessionRecord,
    workspace_root: PathBuf,
    request: InternalChatRequest,
    model: String,
    effort: Option<String>,
    user_input: String,
    input_items: Vec<Value>,
    user_content: Value,
    attachment_items: Vec<Value>,
    caller_system_prompt: Option<String>,
    prefix_event: Option<Value>,
    folder_context_evidence: Option<String>,
    folder_context_event: Option<Value>,
    request_base_url: Option<String>,
    skill_options: SkillManifestOptions,
    required_skills: Vec<RequiredSkillContext>,
}

struct CodexChatStream {
    state: AppState,
    user_id: String,
    session: SessionRecord,
    workspace_root: PathBuf,
    info: AgentRunInfo,
    model: String,
    effort: Option<String>,
    user_input: String,
    user_content: Value,
    prefix_event: Option<Value>,
    folder_context_event: Option<Value>,
    request_base_url: Option<String>,
}

struct ChatRunFinal {
    info: AgentRunInfo,
    usage: Value,
}

async fn prepare_chat_skill_context(
    state: &AppState,
    user_id: &str,
    workspace_root: &FsPath,
    request: &InternalChatRequest,
) -> Result<(SkillManifestOptions, Vec<RequiredSkillContext>), ApiError> {
    let skill_options = catalog_skill_manifest_options_for_user(state, user_id).await?;
    let required_skill_ids = effective_required_skill_ids(request);
    let required_skills = required_skill_contexts(
        state,
        Some(workspace_root),
        &skill_options,
        &required_skill_ids,
    )?;
    Ok((skill_options, required_skills))
}

fn effective_required_skill_ids(request: &InternalChatRequest) -> Vec<String> {
    let mut ids = request.required_skill_ids.clone();
    if context_requests_ui_explainer(request.screen_context.as_ref())
        && !ids
            .iter()
            .any(|id| id == "ripple:ripple-ui-explainer" || id == "ripple-ui-explainer")
    {
        ids.push("ripple:ripple-ui-explainer".to_string());
    }
    ids
}

fn screen_context_app_is_ripple(screen_context: Option<&Value>) -> bool {
    context_app_value(screen_context)
        .map(is_ripple_app_value)
        .unwrap_or(false)
}

fn required_skill_contexts(
    state: &AppState,
    workspace_root: Option<&FsPath>,
    skill_options: &SkillManifestOptions,
    required_skill_ids: &[String],
) -> Result<Vec<RequiredSkillContext>, ApiError> {
    let mut contexts = Vec::new();
    for requested in required_skill_ids {
        let requested = requested.trim();
        if requested.is_empty() {
            continue;
        }
        if contexts
            .iter()
            .any(|skill: &RequiredSkillContext| skill.id == requested || skill.name == requested)
        {
            continue;
        }
        let entries =
            build_skill_manifest_with_options(&state.config, workspace_root, skill_options);
        let matches = entries
            .into_iter()
            .filter(|entry| {
                entry.enabled
                    && entry.status == "available"
                    && (entry.id == requested || entry.name == requested)
            })
            .collect::<Vec<_>>();
        let Some(entry) = matches.first() else {
            return Err(ApiError::bad_request(format!(
                "Required skill '{requested}' is not available"
            )));
        };
        let content = std::fs::read_to_string(&entry.path).map_err(|err| {
            ApiError::bad_request(format!(
                "Failed to read required skill '{}': {err}",
                entry.id
            ))
        })?;
        contexts.push(RequiredSkillContext {
            id: entry.id.clone(),
            name: entry.name.clone(),
            path: public_skill_path(FsPath::new(&entry.path), workspace_root),
            content_hash: entry.content_hash.clone(),
            content,
        });
    }
    Ok(contexts)
}

#[utoipa::path(
    post,
    path = "/responses",
    tag = "chat",
    request_body = ResponsesCreateRequest,
    responses(
        (status = 200, description = "Responses API-compatible response or SSE stream", body = serde_json::Value),
        (status = 400, description = "Invalid responses request", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 409, description = "Session already has work in progress", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn create_response(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ResponsesCreateRequest>,
) -> Result<Response<Body>, ApiError> {
    let request = request.into_chat_request()?;
    handle_chat_request(state, headers, request).await
}

async fn handle_chat_request(
    state: AppState,
    headers: HeaderMap,
    request: InternalChatRequest,
) -> Result<Response<Body>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let workspace_root = state.sandboxes.ensure_sandbox(&user_id)?;
    let control_action = extract_control_action_from_messages(&request.messages);
    let (mut user_input, input_items, mut user_content, attachment_items) =
        extract_user_input_and_items(&request.messages, &workspace_root)?;
    if let Some(control_action) = control_action.as_ref() {
        if user_input.trim().is_empty() {
            if let Some(label) = control_action.label.as_deref() {
                user_input = label.to_string();
                user_content = json!([{"type": "text", "text": label}]);
            }
        }
    }
    if user_input.trim().is_empty() && input_items.is_empty() && control_action.is_none() {
        return Err(ApiError::bad_request("No user message found in messages"));
    }
    let caller_system_prompt = extract_caller_system_prompt(&request.messages);
    let (model, preset_effort) = state.config.resolve_model(request.model.as_deref());
    let effort = request.effort.clone().or(preset_effort);
    if let Some(session_id) = request.session_id.as_deref() {
        validate_session_id(session_id).map_err(ApiError::bad_request)?;
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
    apply_requested_chat_model(
        &mut session,
        request.model.as_deref(),
        &state.config.default_model,
    );
    if session_has_active_run(&session) {
        return Err(ApiError::conflict("Session already has work in progress"));
    }
    let request_base_url = request_base_url_from_headers(&headers);
    if let Some(control_action) = control_action.as_ref() {
        let decision = handle_session_control_action(
            &state,
            &user_id,
            &mut session,
            control_action,
            request_base_url.as_deref(),
        )
        .await?;
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
    if let Some(decision) = maybe_handle_skill_chat(&state, &user_id, &session, &user_input)? {
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
    if let Some(decision) = maybe_handle_task_trigger_chat(
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
    session.pending_control_request = None;
    clear_session_plan(&mut session);

    if let Some(decision) = maybe_handle_connector_auth(
        &state,
        &user_id,
        &mut session,
        &user_input,
        request_base_url.as_deref(),
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
            session.set_status(SessionStatus::Running);
            state.sessions.save_record(session.clone()).await?;
            let folder_context = collect_folder_context(
                &workspace_root,
                session.context_folder_path.as_deref(),
                &resume_user_input,
            );
            let (skill_options, required_skills) =
                prepare_chat_skill_context(&state, &user_id, &workspace_root, &request).await?;
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
                folder_context_evidence: folder_context
                    .as_ref()
                    .map(|context| context.prompt_section.clone()),
                folder_context_event: folder_context.map(|context| context.runtime_event),
                request_base_url: request_base_url.clone(),
                skill_options,
                required_skills,
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
    session.set_status(SessionStatus::Running);
    state.sessions.save_record(session.clone()).await?;

    let folder_context = collect_folder_context(
        &workspace_root,
        session.context_folder_path.as_deref(),
        &user_input,
    );
    let (skill_options, required_skills) =
        prepare_chat_skill_context(&state, &user_id, &workspace_root, &request).await?;
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
        folder_context_evidence: folder_context
            .as_ref()
            .map(|context| context.prompt_section.clone()),
        folder_context_event: folder_context.map(|context| context.runtime_event),
        request_base_url,
        skill_options,
        required_skills,
    };
    let info = create_codex_chat_run_marking_start_failure(&start).await?;
    drop(session_run_guard);
    finish_codex_chat_response(start, info).await
}

async fn create_codex_chat_run(args: &CodexChatStart) -> Result<AgentRunInfo, ApiError> {
    let recent_display_context = recent_display_context(&args.session.messages);
    let recent_task_triggers_context =
        recent_task_triggers_context(&args.state, &args.user_id).await?;
    let base_instructions = build_codex_chat_base_instructions();
    let turn_context = build_codex_chat_turn_context(
        &args.state,
        &args.user_id,
        &args.session.session_id,
        &args.workspace_root,
        args.session.context_folder_path.as_deref(),
        args.folder_context_evidence.as_deref(),
        recent_display_context.as_deref(),
        recent_task_triggers_context.as_deref(),
        &args.skill_options,
        &args.required_skills,
        args.request.screen_context.as_ref(),
        &args.attachment_items,
        args.caller_system_prompt.as_deref(),
    );
    let prompt = chat_turn_prompt(&args.user_input);
    let mut native_items = args.input_items.clone();
    native_items.push(json!({"type": "text", "text": prompt}));
    let runtime_dir = args
        .state
        .sandboxes
        .session_dir(&args.user_id, &args.session.session_id)?;
    let create = AgentRunCreateRequest {
        prompt,
        provider: "codex".to_string(),
        base_instructions: Some(base_instructions),
        turn_context: Some(turn_context),
        cwd: Some(chat_cwd_for_session(&args.session)),
        input_items: native_items,
        model: Some(args.model.clone()),
        effort: args.effort.clone(),
        summary: args.request.summary.clone(),
        output_schema: args.request.output_schema.clone(),
        max_runtime_seconds: args.state.config.codex.max_runtime_seconds,
        task_trigger_id: None,
        task_trigger_title: None,
        task_trigger_reason: None,
        codex_thread_id: args.session.codex_thread_id.clone(),
        codex_persistent_thread: !args.request.temporary,
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

fn chat_turn_prompt(user_input: &str) -> String {
    let trimmed = user_input.trim();
    if trimmed.is_empty() {
        "(The user provided image input without additional text.)".to_string()
    } else {
        trimmed.to_string()
    }
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
        effort,
        user_input,
        input_items: _,
        user_content,
        attachment_items: _,
        caller_system_prompt: _,
        prefix_event,
        folder_context_evidence: _,
        folder_context_event,
        request_base_url,
        skill_options: _,
        required_skills: _,
    } = args;

    if request.stream.unwrap_or(false) {
        return Ok(stream_chat_response(CodexChatStream {
            state,
            user_id,
            session,
            workspace_root,
            info,
            model,
            effort,
            user_input,
            user_content,
            prefix_event,
            folder_context_event,
            request_base_url,
        }));
    }

    let ChatRunFinal {
        info: final_info,
        usage,
    } = wait_for_chat_run(&state, &user_id, &mut session, &info.job_id).await?;
    if final_info.status != "completed" {
        session.status = if final_info.status == "cancelled" {
            SessionStatus::Cancelled.as_str().to_string()
        } else {
            SessionStatus::Failed.as_str().to_string()
        };
        session.pending_permission_request = None;
        session.pending_question = None;
        session.pending_options = None;
        let _ = state.sessions.save_record_if_exists(session).await?;
        let error = final_info
            .error
            .unwrap_or_else(|| "Codex run failed".to_string());
        return Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            sanitize_user_visible_text(&state, &user_id, &error),
        ));
    }
    let output_text = read_run_output(&state, &user_id, &final_info).await;
    record_codex_thread(&mut session, &final_info);
    record_usage(&mut session, &usage);
    clear_session_plan(&mut session);
    if let Some(event) = maybe_persist_model_connector_auth_request(
        &state,
        &user_id,
        &mut session,
        &user_content,
        &user_input,
        &output_text,
        request_base_url.as_deref(),
    )
    .await?
    {
        return Ok(connector_auth_event_response(
            &model,
            &session.session_id,
            event,
            false,
        ));
    }
    let image_events =
        collect_chat_image_events(&state, &user_id, &final_info, &workspace_root).await;
    let title_fallback = append_chat_messages_with_images(
        &mut session,
        user_content,
        &user_input,
        &output_text,
        &image_events,
    );
    session.set_status(SessionStatus::Idle);
    session.pending_permission_request = None;
    session.pending_question = None;
    session.pending_options = None;
    let _ = state
        .sessions
        .save_record_if_exists(session.clone())
        .await?;
    if let Some(fallback_title) = title_fallback {
        spawn_session_title_generation(
            state.clone(),
            user_id.clone(),
            workspace_root.clone(),
            session.session_id.clone(),
            fallback_title,
            user_input.clone(),
            output_text.clone(),
            model.clone(),
            effort.clone(),
        );
    }

    let mut payload = responses_payload(&model, &session.session_id, output_text, usage);
    if let Some(event) = prefix_event {
        payload["ripple_event"] = event;
    }
    if let Some(event) = folder_context_event {
        payload["ripple_folder_context_search"] = event;
    }
    let mut response = Json(payload).into_response();
    response.headers_mut().insert(
        "x-ripple-session-id",
        HeaderValue::from_str(&session.session_id).unwrap_or_else(|_| HeaderValue::from_static("")),
    );
    Ok(response)
}

async fn maybe_persist_model_connector_auth_request(
    state: &AppState,
    user_id: &str,
    session: &mut SessionRecord,
    user_content: &Value,
    user_input: &str,
    output_text: &str,
    request_base_url: Option<&str>,
) -> Result<Option<Value>, ApiError> {
    let Some(request) = parse_model_connector_auth_request(output_text) else {
        return Ok(None);
    };
    let decision = start_model_connector_auth_for_chat(
        state,
        user_id,
        session,
        &request,
        user_input,
        request_base_url,
    )
    .await?;
    let event = decision.event;
    persist_connector_auth_event(state, session, user_content, user_input, &event).await?;
    Ok(Some(event))
}

#[utoipa::path(
    post,
    path = "/sessions/{session_id}/connector-auth/poll",
    tag = "sessions",
    params(("session_id" = String, Path, description = "Session id")),
    request_body = ConnectorAuthPollRequest,
    responses(
        (status = 200, description = "Connector auth poll result", body = serde_json::Value),
        (status = 400, description = "Invalid poll request", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Session not found", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 409, description = "Session already has work in progress", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
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
        return Err(ApiError::conflict("Session already has work in progress"));
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
    apply_requested_chat_model(
        &mut session,
        request.model.as_deref(),
        &state.config.default_model,
    );
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
        session.set_status(SessionStatus::Running);
        clear_session_plan(&mut session);
        state.sessions.save_record(session.clone()).await?;
        let chat_request = InternalChatRequest {
            model: request.model,
            messages: vec![json!({"role": "user", "content": resume_user_input})],
            stream: request.stream,
            session_id: Some(session_id),
            required_skill_ids: Vec::new(),
            preferred_skill_ids: Vec::new(),
            screen_context: None,
            temporary: false,
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
        let folder_context = collect_folder_context(
            &workspace_root,
            session.context_folder_path.as_deref(),
            &user_input,
        );
        let (skill_options, required_skills) =
            prepare_chat_skill_context(&state, &user_id, &workspace_root, &chat_request).await?;
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
            folder_context_evidence: folder_context
                .as_ref()
                .map(|context| context.prompt_section.clone()),
            folder_context_event: folder_context.map(|context| context.runtime_event),
            request_base_url: None,
            skill_options,
            required_skills,
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
    request: &InternalChatRequest,
) -> Result<SessionRecord, ApiError> {
    if let Some(session_id) = request.session_id.as_deref() {
        validate_session_id(session_id).map_err(ApiError::bad_request)?;
        if let Some(session) = state.sessions.load(user_id, session_id).await? {
            return Ok(session);
        }
    }
    assert_can_create_session(state, user_id).await?;
    Ok(state
        .sessions
        .create_session_with_id(
            user_id,
            CreateSessionInput {
                model: request.model.clone(),
                max_turns: request.max_turns,
                system_prompt: None,
                context_folder_path: None,
            },
            request.session_id.as_deref(),
        )
        .await?)
}

fn chat_cwd_for_session(session: &SessionRecord) -> String {
    session
        .context_folder_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("/workspace")
        .to_string()
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
                if let Some(runtime_event) = extract_codex_runtime_event(&event) {
                    let public_runtime_event =
                        sanitize_user_visible_value(state, user_id, &runtime_event);
                    if record_session_runtime_event(session, &public_runtime_event) {
                        let _ = state
                            .sessions
                            .save_record_if_exists(session.clone())
                            .await?;
                    }
                }
            }
        }
        if let Some(approval) = info.pending_approval.clone() {
            session.set_status(SessionStatus::AwaitingPermission);
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
        if let Some(user_input) = info.pending_user_input.clone() {
            let public_user_input = sanitize_user_visible_value(state, user_id, &user_input);
            record_session_pending_user_input(session, &public_user_input);
            let _ = state
                .sessions
                .save_record_if_exists(session.clone())
                .await?;
            return Err(ApiError::conflict(json!({
                "message": "Codex user input required",
                "user_input": public_user_input
            })));
        }
        if TERMINAL_STATUSES.contains(&info.status.as_str()) {
            return Ok(ChatRunFinal {
                info,
                usage: latest_usage,
            });
        }
        if Instant::now() >= deadline {
            session.set_status(SessionStatus::Failed);
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

fn record_session_pending_user_input(session: &mut SessionRecord, user_input: &Value) {
    session.set_status(SessionStatus::AwaitingUserInput);
    session.pending_question = user_input_question(user_input)
        .or_else(|| Some("Codex is waiting for your input.".to_string()));
    session.pending_options = user_input_options(user_input);
}

fn record_session_runtime_event(session: &mut SessionRecord, event: &Value) -> bool {
    match event.get("type").and_then(Value::as_str) {
        Some("user_input_requested") => {
            record_session_pending_user_input(session, event);
            true
        }
        Some("thread_status_changed") => {
            let status = event.get("status").and_then(Value::as_str).unwrap_or("");
            let pending_input = event
                .pointer("/runtime/pendingUserInputRequests")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                > 0;
            if pending_input || status == "waitingOnUserInput" {
                session.set_status(SessionStatus::WaitingForUser);
                return true;
            }
            if status == "running"
                && session.pending_permission_request.is_none()
                && session.pending_question.is_none()
            {
                session.set_status(SessionStatus::Running);
                return true;
            }
            if status == "failed"
                || status == "systemError"
                || event
                    .pointer("/runtime/hasSystemError")
                    .and_then(Value::as_bool)
                    == Some(true)
            {
                session.set_status(SessionStatus::Failed);
                return true;
            }
            false
        }
        _ => false,
    }
}

fn user_input_question(user_input: &Value) -> Option<String> {
    user_input
        .get("questions")
        .and_then(Value::as_array)
        .and_then(|questions| questions.first())
        .and_then(|question| {
            question
                .get("question")
                .or_else(|| question.get("prompt"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn user_input_options(user_input: &Value) -> Option<Vec<String>> {
    let labels = user_input
        .get("questions")
        .and_then(Value::as_array)
        .and_then(|questions| questions.first())
        .and_then(|question| question.get("options"))
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|option| {
            option
                .get("label")
                .or_else(|| option.get("value"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .collect::<Vec<_>>();
    (!labels.is_empty()).then_some(labels)
}

fn stream_chat_response(args: CodexChatStream) -> Response<Body> {
    let CodexChatStream {
        state,
        user_id,
        mut session,
        workspace_root,
        info,
        model,
        effort,
        user_input,
        user_content,
        prefix_event,
        folder_context_event,
        request_base_url,
    } = args;
    let session_id = session.session_id.clone();
    let header_session_id = session_id.clone();
    let response_id = response_id_for_session(&session_id);
    let response_item_id = format!("msg_{}", &Uuid::new_v4().simple().to_string()[..24]);
    let events_file = info.events_file.as_ref().map(std::path::PathBuf::from);
    let job_id = info.job_id.clone();
    let stream = stream! {
        yield Ok::<Bytes, Infallible>(response_created_sse(&response_id, &model, &session_id));
        if let Some(event) = prefix_event {
            yield Ok::<Bytes, Infallible>(sse_for_event(&event));
            let message = event_message(&event);
            if !message.is_empty() {
                yield Ok::<Bytes, Infallible>(assistant_delta_sse(&response_id, &response_item_id, &format!("{message}\n\n")));
                yield Ok::<Bytes, Infallible>(sse_for_event(&json!({"type": "new_turn"})));
            }
        }
        if let Some(event) = folder_context_event {
            yield Ok::<Bytes, Infallible>(sse_for_event(&event));
        }
        let mut offset = 0_usize;
        let mut emitted = String::new();
        let mut image_events = Vec::<Value>::new();
        let mut latest_usage = empty_usage();
        let mut agent_messages = AgentMessageTracker::default();
        let mut model_connector_auth_buffer: Option<String> = None;
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
                        yield Ok::<Bytes, Infallible>(sse_for_event(&image_event));
                        last_emit = now_epoch_seconds();
                        continue;
                    }
                    if let Some(plan_event) = extract_plan_update_event(&event) {
                        let public_plan_event =
                            sanitize_user_visible_value(&state, &user_id, &plan_event);
                        record_session_plan_update(&mut session, &public_plan_event);
                        let _ = state.sessions.save_record_if_exists(session.clone()).await;
                        yield Ok::<Bytes, Infallible>(sse_for_event(&public_plan_event));
                        last_emit = now_epoch_seconds();
                        continue;
                    }
                    if let Some(runtime_event) = extract_codex_runtime_event(&event) {
                        let public_runtime_event = sanitize_user_visible_value(&state, &user_id, &runtime_event);
                        if record_session_runtime_event(&mut session, &public_runtime_event) {
                            let _ = state.sessions.save_record_if_exists(session.clone()).await;
                        }
                        yield Ok::<Bytes, Infallible>(sse_for_event(&public_runtime_event));
                        last_emit = now_epoch_seconds();
                        continue;
                    }
                    if let Some(tool_event) = extract_tool_event(&event) {
                        let public_tool_event = sanitize_user_visible_value(&state, &user_id, &tool_event);
                        yield Ok::<Bytes, Infallible>(sse_for_event(&public_tool_event));
                        last_emit = now_epoch_seconds();
                        continue;
                    }
                    if let Some(delta) = agent_messages.handle_delta(&event) {
                        let delta = sanitize_user_visible_text(&state, &user_id, &delta);
                        if let Some(delta) = gate_model_connector_auth_stream_text(
                            &mut model_connector_auth_buffer,
                            &emitted,
                            delta,
                        ) {
                            emitted.push_str(&delta);
                            yield Ok::<Bytes, Infallible>(assistant_delta_sse(&response_id, &response_item_id, &delta));
                            last_emit = now_epoch_seconds();
                        }
                        continue;
                    }
                    if let Some(text) = agent_messages.handle_item(&event) {
                        let text = sanitize_user_visible_text(&state, &user_id, &text);
                        if let Some(text) = gate_model_connector_auth_stream_text(
                            &mut model_connector_auth_buffer,
                            &emitted,
                            text,
                        ) {
                            emitted.push_str(&text);
                            yield Ok::<Bytes, Infallible>(assistant_delta_sse(&response_id, &response_item_id, &text));
                            last_emit = now_epoch_seconds();
                        }
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
                session.set_status(SessionStatus::AwaitingPermission);
                let public_approval = sanitize_user_visible_value(&state, &user_id, &approval);
                session.pending_permission_request = Some(public_approval.clone());
                let _ = state.sessions.save_record_if_exists(session.clone()).await;
                yield Ok::<Bytes, Infallible>(sse_for_event(&json!({"type": "approval_required", "approval": public_approval})));
                yield Ok::<Bytes, Infallible>(assistant_done_sse(&model, &response_id, &session_id, emitted.clone(), latest_usage.clone()));
                break;
            }
            if let Some(user_input) = info.pending_user_input.clone() {
                let public_user_input = sanitize_user_visible_value(&state, &user_id, &user_input);
                record_session_pending_user_input(&mut session, &public_user_input);
                let _ = state.sessions.save_record_if_exists(session.clone()).await;
                yield Ok::<Bytes, Infallible>(sse_for_event(&json!({"type": "user_input_required", "user_input": public_user_input})));
                yield Ok::<Bytes, Infallible>(assistant_done_sse(&model, &response_id, &session_id, emitted.clone(), latest_usage.clone()));
                break;
            }
            if TERMINAL_STATUSES.contains(&info.status.as_str()) {
                if info.status == "completed" {
                    let output_text = read_run_output(&state, &user_id, &info).await;
                    record_codex_thread(&mut session, &info);
                    record_usage(&mut session, &latest_usage);
                    clear_session_plan(&mut session);
                    let auth_output_text = if output_text.trim().is_empty() {
                        model_connector_auth_buffer.as_deref().unwrap_or("")
                    } else {
                        output_text.as_str()
                    };
                    match maybe_persist_model_connector_auth_request(
                        &state,
                        &user_id,
                        &mut session,
                        &user_content,
                        &user_input,
                        auth_output_text,
                        request_base_url.as_deref(),
                    )
                    .await
                    {
                        Ok(Some(event)) => {
                            let public_event = public_connector_auth_event(&event);
                            yield Ok::<Bytes, Infallible>(sse_for_event(&public_event));
                            let message = event_message(&event);
                            if !message.is_empty() {
                                yield Ok::<Bytes, Infallible>(assistant_delta_sse(&response_id, &response_item_id, &message));
                            }
                            yield Ok::<Bytes, Infallible>(assistant_done_sse(&model, &response_id, &session_id, message, latest_usage.clone()));
                            break;
                        }
                        Ok(None) => {}
                        Err(err) => {
                        yield Ok::<Bytes, Infallible>(sse_json(&stream_error_for_user(&state, &user_id, &format!("{err:?}"), "server_error")));
                            break;
                        }
                    }
                    if emitted.is_empty() && !output_text.is_empty() {
                        emitted = output_text.clone();
                        yield Ok::<Bytes, Infallible>(assistant_delta_sse(&response_id, &response_item_id, &output_text));
                    }
                    let title_fallback = append_chat_messages_with_images(
                        &mut session,
                        user_content.clone(),
                        &user_input,
                        &emitted,
                        &image_events,
                    );
                    session.set_status(SessionStatus::Idle);
                    session.pending_permission_request = None;
                    session.pending_question = None;
                    session.pending_options = None;
                    let _ = state.sessions.save_record_if_exists(session.clone()).await;
                    if let Some(fallback_title) = title_fallback {
                        spawn_session_title_generation(
                            state.clone(),
                            user_id.clone(),
                            workspace_root.clone(),
                            session.session_id.clone(),
                            fallback_title,
                            user_input.clone(),
                            emitted.clone(),
                            model.clone(),
                            effort.clone(),
                        );
                    }
                    if usage_total_tokens(&latest_usage) > 0 {
                        yield Ok::<Bytes, Infallible>(sse_for_event(&json!({"type": "usage", "usage": latest_usage})));
                    }
                    yield Ok::<Bytes, Infallible>(assistant_done_sse(&model, &response_id, &session_id, emitted.clone(), latest_usage.clone()));
                } else {
                    session.status = if info.status == "cancelled" {
                        SessionStatus::Cancelled.as_str().to_string()
                    } else {
                        SessionStatus::Failed.as_str().to_string()
                    };
                    session.pending_permission_request = None;
                    session.pending_question = None;
                    session.pending_options = None;
                    let _ = state.sessions.save_record_if_exists(session.clone()).await;
                    let error_type = if info.status == "cancelled" { "cancelled" } else { "server_error" };
                    yield Ok::<Bytes, Infallible>(sse_json(&stream_error_for_user(&state, &user_id, &info.error.unwrap_or_else(|| "Codex run failed".to_string()), error_type)));
                }
                break;
            }
            let now = now_epoch_seconds();
            if now.saturating_sub(last_emit) >= 8 {
                yield Ok::<Bytes, Infallible>(sse_for_event(&json!({"type": "heartbeat", "ts": now})));
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
        HeaderValue::from_str(&header_session_id).unwrap_or_else(|_| HeaderValue::from_static("")),
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
    session.status_kind().is_active_run()
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
        "completed" => SessionStatus::Idle.as_str(),
        "cancelled" => SessionStatus::Cancelled.as_str(),
        _ => SessionStatus::Failed.as_str(),
    }
    .to_string();
    session.pending_permission_request = None;
    session.pending_question = None;
    session.pending_options = None;
    clear_session_plan(session);
    let _ = state
        .sessions
        .save_record_if_exists(session.clone())
        .await?;
    Ok(())
}

pub(crate) async fn finalize_chat_run_for_session(
    state: &AppState,
    user_id: &str,
    session_id: &str,
    info: &AgentRunInfo,
) -> Result<(), ApiError> {
    let Some(mut session) = state.sessions.load(user_id, session_id).await? else {
        return Err(ApiError::not_found("Session not found"));
    };
    if info.status == "completed"
        && finalize_stale_completed_chat_run(state, &mut session, info).await?
    {
        return Ok(());
    }
    session.status = match info.status.as_str() {
        "completed" => SessionStatus::Idle.as_str(),
        "cancelled" => SessionStatus::Cancelled.as_str(),
        _ => SessionStatus::Failed.as_str(),
    }
    .to_string();
    session.pending_permission_request = None;
    session.pending_question = None;
    session.pending_options = None;
    clear_session_plan(&mut session);
    let _ = state
        .sessions
        .save_record_if_exists(session.clone())
        .await?;
    Ok(())
}

pub(crate) async fn recover_session_run_state(
    state: &AppState,
    user_id: &str,
    session_id: &str,
) -> Result<(), ApiError> {
    let Some(mut session) = state.sessions.load(user_id, session_id).await? else {
        return Ok(());
    };
    reconcile_stale_active_session(state, user_id, &mut session).await?;
    if session.pending_permission_request.is_none() && !session.status_kind().is_awaiting_approval()
    {
        return Ok(());
    }
    if state.jobs.has_active_session_run(user_id, session_id).await {
        return Ok(());
    }
    let Some(info) = state
        .jobs
        .recover_stale_stored_session_run(user_id, session_id)
        .await?
    else {
        session.pending_permission_request = None;
        session.pending_question = None;
        session.pending_options = None;
        session.set_status(SessionStatus::Failed);
        let _ = state.sessions.save_record_if_exists(session).await?;
        return Ok(());
    };
    if TERMINAL_STATUSES.contains(&info.status.as_str()) {
        finalize_chat_run_for_session(state, user_id, session_id, &info).await?;
    }
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
    let output_text = read_run_output(state, &session.user_id, info).await;
    let usage = read_run_usage(info).await;
    let image_events = match state.sandboxes.workspace_dir(&session.user_id) {
        Ok(workspace_root) => {
            collect_chat_image_events(state, &session.user_id, info, &workspace_root).await
        }
        Err(_) => Vec::new(),
    };
    record_codex_thread(session, info);
    let _ = append_chat_messages_with_images(
        session,
        user_content,
        &user_input,
        &output_text,
        &image_events,
    );
    record_usage(session, &usage);
    session.set_status(SessionStatus::Idle);
    session.pending_permission_request = None;
    session.pending_question = None;
    session.pending_options = None;
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

fn apply_requested_chat_model(
    session: &mut SessionRecord,
    requested_model: Option<&str>,
    default_model: &str,
) {
    let next_model = requested_model
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .unwrap_or(default_model);
    session.model = next_model.to_string();
}

async fn persist_control_plane_chat_event(
    state: &AppState,
    session: &mut SessionRecord,
    user_content: &Value,
    user_input: &str,
    decision: &TaskTriggerChatDecision,
) -> Result<Value, ApiError> {
    let public_event = public_control_plane_event(&decision.event);
    let _ = append_chat_messages(
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
    if decision.clear_pending_control_request {
        session.pending_control_request = None;
    } else if let Some(pending) = decision.pending_control_request.clone() {
        session.pending_control_request = Some(pending);
    }
    state.sessions.save_record(session.clone()).await?;
    Ok(public_event)
}

fn append_chat_messages(
    session: &mut SessionRecord,
    user_content: Value,
    user_input: &str,
    assistant_text: &str,
) -> Option<String> {
    append_chat_messages_with_images(session, user_content, user_input, assistant_text, &[])
}

fn append_chat_messages_with_images(
    session: &mut SessionRecord,
    user_content: Value,
    user_input: &str,
    assistant_text: &str,
    image_events: &[Value],
) -> Option<String> {
    let should_generate_title = session.messages.is_empty() && session.title.trim().is_empty();
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
    if should_generate_title {
        let title = session.title.trim();
        if !title.is_empty() {
            return Some(title.to_string());
        }
    }
    None
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

async fn read_run_output(state: &AppState, user_id: &str, info: &AgentRunInfo) -> String {
    let text = if let Some(output_file) = info.output_file.as_deref() {
        tokio::fs::read_to_string(output_file)
            .await
            .unwrap_or_else(|_| info.stdout_tail.clone())
    } else {
        info.stdout_tail.clone()
    };
    sanitize_user_visible_text(state, user_id, &text)
}

fn stream_error_for_user(
    state: &AppState,
    user_id: &str,
    message: &str,
    error_type: &str,
) -> Value {
    stream_error(
        &sanitize_user_visible_text(state, user_id, message),
        error_type,
    )
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

async fn read_events_from_offset(events_file: &FsPath, offset: &mut usize) -> Vec<Value> {
    crate::api::read_jsonl_events_from_offset(events_file, offset).await
}

#[derive(Default)]
struct AgentMessageTracker {
    phases: HashMap<String, Option<String>>,
    final_delta_item_ids: HashSet<String>,
    update_delta_item_ids: HashSet<String>,
}

fn gate_model_connector_auth_stream_text(
    buffer: &mut Option<String>,
    emitted: &str,
    text: String,
) -> Option<String> {
    if !emitted.is_empty() {
        return Some(text);
    }
    if let Some(buffered) = buffer.as_mut() {
        buffered.push_str(&text);
        if model_connector_auth_request_might_be_start(buffered) {
            return None;
        }
        return buffer.take();
    }
    if model_connector_auth_request_might_be_start(&text) {
        *buffer = Some(text);
        None
    } else {
        Some(text)
    }
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
    use std::collections::BTreeMap;

    use crate::config::{
        AppConfig, CodexConfig, CorsConfig, FeishuConfig, GogcliOAuthConfig, LoggingConfig,
        SandboxConfig, SecurityConfig, SkillsConfig, UserAuthConfig,
    };

    fn test_config(root: &FsPath) -> AppConfig {
        AppConfig {
            repo_root: root.to_path_buf(),
            host: "127.0.0.1".to_string(),
            port: 0,
            api_keys: vec!["test-key".to_string()],
            security: SecurityConfig::default(),
            user_auth: UserAuthConfig::default(),
            api_docs: crate::config::ApiDocsConfig::default(),
            cors: CorsConfig::default(),
            default_model: "codex-test".to_string(),
            model_presets: BTreeMap::new(),
            logging: LoggingConfig {
                level: "debug".to_string(),
            },
            sandbox: SandboxConfig {
                sandboxes_root: root.join("sandboxes"),
                workspaces_root: None,
                caches_root: root.join("cache"),
                idle_suspend_seconds: 1800,
                retention_seconds: 604_800,
                max_workspace_mb: 2048,
                tmpfs_size_mb: 64,
                nsjail_path: "nsjail".to_string(),
                python_envs_root: root.join("cache/python-envs"),
                python_env_uv_cache: root.join("cache/uv-cache"),
                python_env_max_packages: 20,
                uv_bin_dir: None,
                node_dir: None,
                lark_cli_install_root: None,
                notion_cli_install_root: None,
                gogcli_cli_install_root: None,
                cli_tools: Vec::new(),
                pypi_mirror_url: None,
                npm_registry_url: None,
            },
            codex: CodexConfig {
                enabled: true,
                codex_executable: "codex".to_string(),
                app_server_args: Vec::new(),
                codex_home: None,
                approval_policy: "never".to_string(),
                sandbox_type: "workspace-write".to_string(),
                network_access: true,
                idle_timeout_seconds: 1800,
                max_workers_per_pool: 8,
                max_total_pool_workers: 256,
                max_runtime_seconds: 3600,
                runtime_log_retention_seconds: 86_400,
                runtime_log_max_mb: 64,
                runtime_log_cleanup_interval_seconds: 3600,
            },
            task_trigger_extraction_max_runtime_seconds: 120,
            task_trigger_poll_interval_seconds: 15,
            document_preview: crate::config::DocumentPreviewConfig {
                cache_root: root.join("cache/previews"),
                libreoffice_path: "soffice".to_string(),
                max_source_bytes: 64 * 1024 * 1024,
                conversion_timeout_seconds: 120,
            },
            skills: SkillsConfig {
                shared_dirs: Vec::new(),
            },
            public_base_url: None,
            feishu: FeishuConfig::default(),
            gogcli_oauth: GogcliOAuthConfig {
                auto_register_client: true,
                auto_from_request: true,
                callback_url: None,
                client_secret_json: None,
                client: None,
            },
        }
    }

    fn cleanup_test_root(root: &FsPath) -> anyhow::Result<()> {
        let temp_dir = std::env::temp_dir().canonicalize()?;
        let canonical_root = if root.exists() {
            root.canonicalize()?
        } else {
            root.to_path_buf()
        };
        let is_named_test_root = root
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("ripple-chat-test-"));
        if !canonical_root.starts_with(&temp_dir) || !is_named_test_root {
            anyhow::bail!("refusing to remove non-temp test root {}", root.display());
        }
        if root.exists() {
            std::fs::remove_dir_all(root)?;
        }
        Ok(())
    }

    #[test]
    fn cleanup_test_root_refuses_repo_runtime_dir() {
        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(std::path::Path::parent)
            .unwrap()
            .to_path_buf();

        let error = cleanup_test_root(&repo_root.join(".ripple")).unwrap_err();

        assert!(error
            .to_string()
            .contains("refusing to remove non-temp test root"));
    }

    #[tokio::test]
    async fn codex_chat_context_omits_local_proxy_helper() {
        let root = std::env::temp_dir().join(format!("ripple-chat-test-{}", Uuid::new_v4()));
        let state = AppState::new(test_config(&root));
        let workspace_root = state
            .sandboxes
            .ensure_sandbox("alice")
            .expect("create sandbox");

        let base_instructions = build_codex_chat_base_instructions();
        let turn_context = build_codex_chat_turn_context(
            &state,
            "alice",
            "session-1",
            &workspace_root,
            None,
            None,
            None,
            None,
            &crate::skills::SkillManifestOptions::default(),
            &[],
            None,
            &[],
            None,
        );
        let prompt = format!("{base_instructions}\n{turn_context}");

        assert!(!prompt.contains("proxy_on"));
        assert!(prompt.contains(
            "Do not implement model-provider, OpenAI-compatible, Responses API, or chat-completions adapters inside Ripple"
        ));
        assert!(prompt.contains(
            "Model-provider compatibility is owned by the Codex app-server configuration"
        ));
        assert!(prompt.contains("python --with <package> --"));
        assert!(
            prompt.contains("Do not install temporary Python packages with pip install --target")
        );
        assert!(prompt.contains("Do not create node_modules under /workspace or /workspace/.tmp"));
        assert!(prompt.contains(
            "write temporary analysis, render, OCR, conversion, and inspection artifacts to $TMPDIR or /workspace/.tmp"
        ));
        assert!(prompt.contains(
            "Do not write derived inspection files into /workspace root unless the user explicitly asks for those files as deliverables"
        ));
        assert!(!prompt.contains("write it under /workspace/outputs"));
        assert!(prompt.contains("- codex_image_generation: disabled_by_default"));
        assert!(prompt.contains("Do not generate images unless the current user explicitly asks"));
        assert!(prompt.contains("When creating or updating a skill"));
        assert!(prompt.contains("Ask one consolidated clarification"));
        assert!(prompt.contains("instead of asking repeatedly"));
        assert!(prompt.contains("<ripple_connector_auth_request>"));
        assert!(prompt.contains(
            "For product, company, support, or shared-knowledge questions, read the matching Available Skill before web_search"
        ));
        assert!(prompt.contains("task_update"));
        assert!(prompt.contains("Task actions may have triggers"));
        assert!(prompt.contains(
            "Tasks inferred from prior session context, memories, or recent work must use `mode=\"propose\"`"
        ));
        assert!(prompt.contains(
            "If the task goal, next action, timing, scope, or delivery target is unclear"
        ));
        assert!(prompt.contains(
            "ask one concise clarification question and do not call `codex_app.task_update` yet"
        ));
        assert!(prompt.contains("If `codex_app.task_update` returns `ok=false` with `code=\"task_needs_clarification\"`"));
        assert!(!prompt.contains("two related control-plane concepts"));
        assert!(!prompt.contains("automations are explicit standalone"));
        assert!(!prompt.contains("automation_update"));
        assert!(!prompt.contains("ripple_session_events"));
        assert!(!prompt.contains(
            "Google Workspace, Notion, and Feishu authorization is handled by Ripple before the Codex turn starts"
        ));

        cleanup_test_root(&root).expect("cleanup test root");
    }

    #[tokio::test]
    async fn stream_error_sanitizes_host_paths() {
        let root = std::env::temp_dir().join(format!("ripple-chat-test-{}", Uuid::new_v4()));
        let state = AppState::new(test_config(&root));
        let workspace_root = state.sandboxes.ensure_sandbox("alice").unwrap();
        let leaked = workspace_root.join("outputs/error.log");

        let event = stream_error_for_user(
            &state,
            "alice",
            &format!("failed while reading {}", leaked.display()),
            "server_error",
        );

        let message = event
            .pointer("/error/message")
            .and_then(Value::as_str)
            .expect("error message");
        assert!(message.contains("outputs/error.log"));
        assert!(!message.contains(root.to_string_lossy().as_ref()));
        assert!(!message.contains(".ripple/sandboxes"));

        cleanup_test_root(&root).expect("cleanup test root");
    }

    #[tokio::test]
    async fn codex_chat_context_prefers_context_folder_files_with_web_as_supplement() {
        let root = std::env::temp_dir().join(format!("ripple-chat-test-{}", Uuid::new_v4()));
        let state = AppState::new(test_config(&root));
        let workspace_root = state
            .sandboxes
            .ensure_sandbox("alice")
            .expect("create sandbox");

        let prompt = build_codex_chat_turn_context(
            &state,
            "alice",
            "session-1",
            &workspace_root,
            Some("/workspace/genius_club"),
            Some("Matches:\n1. /workspace/genius_club/001.txt:1\n   天才俱乐部成员名单"),
            None,
            None,
            &crate::skills::SkillManifestOptions::default(),
            &[],
            None,
            &[],
            None,
        );

        assert!(prompt.contains("Context folder: /workspace/genius_club"));
        assert!(prompt.contains("default reading and search scope"));
        assert!(prompt.contains("write new files under this folder"));
        assert!(prompt.contains("Use web_search as a supplement"));
        assert!(prompt.contains("Folder Context Evidence"));
        assert!(prompt.contains("/workspace/genius_club/001.txt:1"));
        assert!(!prompt.contains("Ripple Project"));
        assert!(!prompt.contains("Project root"));

        cleanup_test_root(&root).expect("cleanup test root");
    }

    #[tokio::test]
    async fn codex_chat_context_does_not_inject_shared_knowledge_evidence() {
        let root = std::env::temp_dir().join(format!("ripple-chat-test-{}", Uuid::new_v4()));
        let state = AppState::new(test_config(&root));
        let workspace_root = state
            .sandboxes
            .ensure_sandbox("alice")
            .expect("create sandbox");

        let prompt = build_codex_chat_turn_context(
            &state,
            "alice",
            "session-1",
            &workspace_root,
            None,
            None,
            None,
            None,
            &crate::skills::SkillManifestOptions::default(),
            &[],
            None,
            &[],
            None,
        );

        assert!(!prompt.contains("## Shared Knowledge Evidence"));
        assert!(!prompt.contains("knowledge/shared/ripple.md"));
        assert!(!prompt.contains("viaim 公司推出的一款 Agent 工具"));
        assert!(!prompt.contains("## Current User Request"));

        cleanup_test_root(&root).expect("cleanup test root");
    }

    #[tokio::test]
    async fn codex_chat_context_includes_required_skill_and_screen_context() {
        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(std::path::Path::parent)
            .unwrap()
            .to_path_buf();
        let root = std::env::temp_dir().join(format!("ripple-chat-test-{}", Uuid::new_v4()));
        let mut config = test_config(&root);
        config.repo_root = repo_root;
        config.skills.shared_dirs = vec!["skills/*".to_string()];
        let state = AppState::new(config);
        let workspace_root = state
            .sandboxes
            .ensure_sandbox("alice")
            .expect("create sandbox");
        let skill_options = crate::skills::SkillManifestOptions::default();
        let required_skills = required_skill_contexts(
            &state,
            Some(&workspace_root),
            &skill_options,
            &["ripple:ripple-ui-explainer".to_string()],
        )
        .expect("required skill context");
        let screen_context = json!({
            "app": "ripple",
            "screen_id": "session.chat",
            "active_view": "sessions",
            "target": {
                "data_ripple": "composer-model-button",
                "aria_label": "选择模型"
            }
        });

        let prompt = build_codex_chat_turn_context(
            &state,
            "alice",
            "session-1",
            &workspace_root,
            None,
            None,
            None,
            None,
            &skill_options,
            &required_skills,
            Some(&screen_context),
            &[],
            None,
        );

        assert!(prompt.contains("## Required Skills"));
        assert!(prompt.contains("ripple:ripple-ui-explainer"));
        assert!(prompt.contains("Ripple UI Explainer"));
        assert!(prompt.contains("SKILL.md"));
        assert!(prompt.contains("## Screen Context"));
        assert!(prompt.contains("\"app\": \"ripple\""));
        assert!(prompt.contains("\"screen_id\": \"session.chat\""));
        assert!(prompt.contains("Do not assume uploaded screenshots are Ripple UI"));

        cleanup_test_root(&root).expect("cleanup test root");
    }

    #[test]
    fn responses_metadata_extracts_required_skills_and_screen_context() {
        let request = ResponsesCreateRequest {
            model: Some("codex-test".to_string()),
            input: json!([{"role": "user", "content": "这个按钮有什么用？"}]),
            instructions: None,
            stream: Some(false),
            previous_response_id: None,
            metadata: Some(json!({
                "ripple_session_id": "session-skill",
                "required_skill_ids": ["ripple:ripple-ui-explainer"],
                "preferred_skill_ids": ["ripple:other"],
                "screen_context": {
                    "app": "ripple",
                    "screen_id": "session.chat"
                }
            })),
            store: None,
            reasoning: None,
            text: None,
        };

        let chat = request.into_chat_request().expect("chat request");

        assert_eq!(chat.session_id.as_deref(), Some("session-skill"));
        assert_eq!(
            chat.required_skill_ids,
            vec!["ripple:ripple-ui-explainer".to_string()]
        );
        assert_eq!(chat.preferred_skill_ids, vec!["ripple:other".to_string()]);
        assert_eq!(
            chat.screen_context
                .as_ref()
                .and_then(|value| value.pointer("/screen_id"))
                .and_then(Value::as_str),
            Some("session.chat")
        );
    }

    #[test]
    fn responses_metadata_prefers_client_context_over_screen_context() {
        let request = ResponsesCreateRequest {
            model: Some("codex-test".to_string()),
            input: json!([{"role": "user", "content": "这个页面是什么？"}]),
            instructions: None,
            stream: Some(false),
            previous_response_id: None,
            metadata: Some(json!({
                "ripple_session_id": "session-client-context",
                "screen_context": {
                    "app": "ripple",
                    "screen_id": "legacy.screen"
                },
                "client_context": {
                    "schema_version": "ripple.client_context.v1",
                    "software": {
                        "host_app": {
                            "app_id": "viaim.meeting"
                        },
                        "screen": {
                            "screen_id": "meeting.detail"
                        }
                    },
                    "devices": [{
                        "kind": "ai_headset",
                        "state": {
                            "noise_control": "anc"
                        }
                    }]
                }
            })),
            store: None,
            reasoning: None,
            text: None,
        };

        let chat = request.into_chat_request().expect("chat request");

        assert_eq!(chat.session_id.as_deref(), Some("session-client-context"));
        assert_eq!(
            chat.screen_context
                .as_ref()
                .and_then(|value| value.pointer("/schema_version"))
                .and_then(Value::as_str),
            Some("ripple.client_context.v1")
        );
        assert_eq!(
            chat.screen_context
                .as_ref()
                .and_then(|value| value.pointer("/software/screen/screen_id"))
                .and_then(Value::as_str),
            Some("meeting.detail")
        );
        assert_eq!(
            chat.screen_context
                .as_ref()
                .and_then(|value| value.pointer("/devices/0/kind"))
                .and_then(Value::as_str),
            Some("ai_headset")
        );
    }

    #[test]
    fn screen_context_only_autorequires_ripple_skill_for_ripple_app() {
        let request = InternalChatRequest {
            model: None,
            messages: Vec::new(),
            stream: None,
            session_id: None,
            required_skill_ids: Vec::new(),
            preferred_skill_ids: Vec::new(),
            screen_context: Some(json!({
                "app": "ripple",
                "screen_id": "session.chat"
            })),
            temporary: false,
            max_turns: None,
            effort: None,
            summary: None,
            output_schema: None,
        };

        assert_eq!(
            effective_required_skill_ids(&request),
            vec!["ripple:ripple-ui-explainer".to_string()]
        );

        let other_app_request = InternalChatRequest {
            screen_context: Some(json!({
                "app": "figma",
                "screen_id": "canvas"
            })),
            ..request
        };

        assert!(effective_required_skill_ids(&other_app_request).is_empty());
    }

    #[test]
    fn client_context_autorequires_ripple_skill_for_mvp_schema() {
        let request = InternalChatRequest {
            model: None,
            messages: Vec::new(),
            stream: None,
            session_id: None,
            required_skill_ids: Vec::new(),
            preferred_skill_ids: Vec::new(),
            screen_context: Some(json!({
                "schema_version": "ripple.client_context.v1",
                "software": {
                    "host_app": {
                        "app_id": "viaim.meeting"
                    },
                    "screen": {
                        "screen_id": "meeting.detail"
                    }
                },
                "devices": [{
                    "kind": "ai_headset"
                }]
            })),
            temporary: false,
            max_turns: None,
            effort: None,
            summary: None,
            output_schema: None,
        };

        assert_eq!(
            effective_required_skill_ids(&request),
            vec!["ripple:ripple-ui-explainer".to_string()]
        );
    }

    #[tokio::test]
    async fn codex_chat_context_includes_recent_display_context_without_user_request() {
        let root = std::env::temp_dir().join(format!("ripple-chat-test-{}", Uuid::new_v4()));
        let state = AppState::new(test_config(&root));
        let workspace_root = state
            .sandboxes
            .ensure_sandbox("alice")
            .expect("create sandbox");

        let prompt = build_codex_chat_turn_context(
            &state,
            "alice",
            "session-1",
            &workspace_root,
            None,
            None,
            Some("user: 创建一个定时任务\nassistant: 你希望多久执行一次？"),
            None,
            &crate::skills::SkillManifestOptions::default(),
            &[],
            None,
            &[],
            None,
        );

        assert!(prompt.contains("## Recent Ripple Display Context"));
        assert!(prompt.contains("创建一个定时任务"));
        assert!(prompt.contains("你希望多久执行一次？"));
        assert!(!prompt.contains("## Current User Request"));
        assert!(!prompt.contains("一周一次"));

        cleanup_test_root(&root).expect("cleanup test root");
    }

    #[test]
    fn recent_display_context_keeps_last_twenty_messages() {
        let messages = (1..=21)
            .map(|index| {
                json!({
                    "role": "user",
                    "content": format!("message-{index:02}")
                })
            })
            .collect::<Vec<_>>();

        let context = recent_display_context(&messages).expect("context");

        assert!(!context.contains("message-01"));
        assert!(context.contains("message-02"));
        assert!(context.contains("message-21"));
    }

    #[test]
    fn recent_task_triggers_context_is_structured_and_limited() {
        let records = vec![json!({
            "trigger_id": "sch-price",
            "title": "MacBook Pro price monitor",
            "prompt": "监控二手 M4 Pro 和 M5 Pro MacBook Pro 的价格。",
            "kind": "interval",
            "timezone": "Asia/Shanghai",
            "interval_seconds": 604800,
            "enabled": true,
            "status": "active",
            "next_run_at": "2026-06-12T10:00:00Z",
            "updated_at": "2026-06-05T10:00:00Z"
        })];

        let context = recent_task_triggers_context_from_records(records).expect("context");

        assert!(context.contains("\"trigger_id\": \"sch-price\""));
        assert!(context.contains("\"title\": \"MacBook Pro price monitor\""));
        assert!(context.contains("\"interval_seconds\": 604800"));
        assert!(context.contains("\"prompt\": \"监控二手 M4 Pro 和 M5 Pro MacBook Pro 的价格。\""));
    }

    #[tokio::test]
    async fn codex_chat_context_includes_recent_task_triggers_context() {
        let root = std::env::temp_dir().join(format!("ripple-chat-test-{}", Uuid::new_v4()));
        let state = AppState::new(test_config(&root));
        let workspace_root = state
            .sandboxes
            .ensure_sandbox("alice")
            .expect("create sandbox");

        let prompt = build_codex_chat_turn_context(
            &state,
            "alice",
            "session-1",
            &workspace_root,
            None,
            None,
            None,
            Some(
                r#"[
  {
    "trigger_id": "sch-price",
    "title": "MacBook Pro price monitor",
    "prompt": "监控二手 M4 Pro 和 M5 Pro MacBook Pro 的价格。"
  }
]"#,
            ),
            &crate::skills::SkillManifestOptions::default(),
            &[],
            None,
            &[],
            None,
        );

        assert!(prompt.contains("## Recent Task Triggers"));
        assert!(!prompt.contains("## Recent Automations"));
        assert!(prompt.contains("\"trigger_id\": \"sch-price\""));
        assert!(prompt.contains("监控二手 M4 Pro 和 M5 Pro MacBook Pro 的价格"));

        cleanup_test_root(&root).expect("cleanup test root");
    }

    #[test]
    fn extracts_notion_token_without_trailing_punctuation() {
        assert_eq!(
            extract_notion_token("token: secret_abcdefghijklmnopqrstuvwxyz，").as_deref(),
            Some("secret_abcdefghijklmnopqrstuvwxyz")
        );
        assert_eq!(extract_notion_token("secret_short"), None);
    }

    #[test]
    fn requested_chat_model_updates_session_metadata() {
        let now = now_iso();
        let mut session = SessionRecord {
            session_id: "srv-test".to_string(),
            user_id: "alice".to_string(),
            title: String::new(),
            pinned: false,
            context_folder_path: None,
            model: "codex-medium".to_string(),
            max_turns: 200,
            caller_system_prompt: None,
            total_input_tokens: 0,
            total_output_tokens: 0,
            last_input_tokens: 0,
            created_at: now.clone(),
            last_active: now,
            status: "idle".to_string(),
            message_count: 0,
            messages: Vec::new(),
            pending_question: None,
            pending_options: None,
            pending_permission_request: None,
            pending_connector_auth: None,
            pending_control_request: None,
            codex_thread_id: None,
            memory_disabled: false,
            plan_steps: Vec::new(),
            plan_progress: None,
        };

        apply_requested_chat_model(&mut session, Some("codex-high"), "codex-medium");

        assert_eq!(session.model, "codex-high");
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

        assert!(message.contains("[BILIBILI_AUTH_SKILL]"));
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
            context_folder_path: None,
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
            pending_control_request: None,
            codex_thread_id: None,
            memory_disabled: false,
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

        cleanup_test_root(&root).expect("cleanup test root");
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

        cleanup_test_root(&root).expect("cleanup test root");
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
