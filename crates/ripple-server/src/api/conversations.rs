use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
#[cfg(not(test))]
use tokio::time::{sleep, Duration};
use uuid::Uuid;

#[cfg(not(test))]
use crate::api::run_public::sanitize_user_visible_text;
#[cfg(not(test))]
use crate::api::users::assert_can_create_run;
use crate::api::ApiError;
#[cfg(not(test))]
use crate::jobs::{AgentRunCreateRequest, AgentRunInfo};
#[cfg(not(test))]
use crate::sessions::{CreateSessionInput, SessionStatus};
use crate::state::AppState;
use crate::user::{user_id_from_headers, validate_user_id};

const STATUS_PENDING_APPROVAL: &str = "pending_approval";
const STATUS_APPROVED: &str = "approved";
const STATUS_RUNNING: &str = "running";
#[cfg(not(test))]
const STATUS_AWAITING_TARGET_PERMISSION: &str = "awaiting_target_permission";
#[cfg(not(test))]
const STATUS_COMPLETED: &str = "completed";
#[cfg(not(test))]
const STATUS_FAILED: &str = "failed";
#[cfg(not(test))]
const STATUS_CANCELLED: &str = "cancelled";
const STATUS_REJECTED: &str = "rejected";
#[cfg(not(test))]
const TERMINAL_RUN_STATUSES: &[&str] = &["completed", "failed", "cancelled"];

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct DirectConversationCreateInput {
    pub contact_user_id: String,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct ConversationMessageCreateInput {
    pub text: String,
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct ConversationMessagesQuery {
    pub after_seq: Option<i64>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct ConversationReadInput {
    pub last_read_message_seq: i64,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct AgentInvocationCreateInput {
    pub target_user_id: String,
    pub prompt: String,
    pub context_message_count: Option<usize>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct AgentInvocationDecisionInput {
    pub note: Option<String>,
    pub reason: Option<String>,
}

#[utoipa::path(
    get,
    path = "/conversations",
    tag = "conversations",
    responses((status = 200, description = "Current user's conversations", body = serde_json::Value))
)]
pub async fn list_conversations(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = header_user_id(&headers)?;
    let conversations = state.storage.list_conversations_for_user(&user_id).await?;
    Ok(Json(json!({
        "conversations": conversations,
        "count": conversations.len()
    })))
}

#[utoipa::path(
    post,
    path = "/conversations/direct",
    tag = "conversations",
    request_body = DirectConversationCreateInput,
    responses((status = 200, description = "Created or reused direct conversation", body = serde_json::Value))
)]
pub async fn create_direct_conversation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<DirectConversationCreateInput>,
) -> Result<Json<Value>, ApiError> {
    let requester_user_id = header_user_id(&headers)?;
    let contact_user_id = clean_user_id(&input.contact_user_id, "contact_user_id")?;
    if contact_user_id == requester_user_id {
        return Err(ApiError::bad_request(
            "contact_user_id must be another user",
        ));
    }
    let conversation = state
        .storage
        .create_direct_conversation(&requester_user_id, &contact_user_id)
        .await?;
    Ok(Json(conversation))
}

#[utoipa::path(
    get,
    path = "/conversations/{conversation_id}/messages",
    tag = "conversations",
    params(("conversation_id" = String, Path, description = "Conversation id")),
    responses((status = 200, description = "Conversation messages", body = serde_json::Value))
)]
pub async fn list_conversation_messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(conversation_id): Path<String>,
    Query(query): Query<ConversationMessagesQuery>,
) -> Result<Json<Value>, ApiError> {
    let user_id = header_user_id(&headers)?;
    if state
        .storage
        .get_conversation_for_user(&user_id, &conversation_id)
        .await?
        .is_none()
    {
        return Err(ApiError::not_found("Conversation not found"));
    }
    let after_seq = query.after_seq.unwrap_or(0).max(0);
    let messages = state
        .storage
        .list_conversation_messages_for_user_after(&user_id, &conversation_id, after_seq)
        .await?;
    let latest_seq = state
        .storage
        .latest_conversation_message_seq(&conversation_id)
        .await?;
    let messages = hydrate_agent_invocation_messages(&state, messages).await?;
    Ok(Json(json!({
        "messages": messages,
        "count": messages.len(),
        "after_seq": after_seq,
        "latest_seq": latest_seq
    })))
}

#[utoipa::path(
    post,
    path = "/conversations/{conversation_id}/messages",
    tag = "conversations",
    params(("conversation_id" = String, Path, description = "Conversation id")),
    request_body = ConversationMessageCreateInput,
    responses((status = 200, description = "Created conversation message", body = serde_json::Value))
)]
pub async fn create_conversation_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(conversation_id): Path<String>,
    Json(input): Json<ConversationMessageCreateInput>,
) -> Result<Json<Value>, ApiError> {
    let user_id = header_user_id(&headers)?;
    if state
        .storage
        .get_conversation_for_user(&user_id, &conversation_id)
        .await?
        .is_none()
    {
        return Err(ApiError::not_found("Conversation not found"));
    }
    let text = clean_required_text(&input.text, "text")?;
    let message = state
        .storage
        .append_conversation_message(
            &conversation_id,
            &user_id,
            "user",
            &user_id,
            "text",
            &json!({ "text": text }),
        )
        .await?;
    Ok(Json(message))
}

#[utoipa::path(
    post,
    path = "/conversations/{conversation_id}/read",
    tag = "conversations",
    params(("conversation_id" = String, Path, description = "Conversation id")),
    request_body = ConversationReadInput,
    responses((status = 200, description = "Updated conversation read marker", body = serde_json::Value))
)]
pub async fn mark_conversation_read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(conversation_id): Path<String>,
    Json(input): Json<ConversationReadInput>,
) -> Result<Json<Value>, ApiError> {
    let user_id = header_user_id(&headers)?;
    let participant = state
        .storage
        .mark_conversation_read(
            &user_id,
            &conversation_id,
            input.last_read_message_seq.max(0),
        )
        .await?
        .ok_or_else(|| ApiError::not_found("Conversation not found"))?;
    Ok(Json(json!({ "participant": participant })))
}

#[utoipa::path(
    post,
    path = "/conversations/{conversation_id}/agent-invocations",
    tag = "conversations",
    params(("conversation_id" = String, Path, description = "Conversation id")),
    request_body = AgentInvocationCreateInput,
    responses((status = 200, description = "Created agent invocation", body = serde_json::Value))
)]
pub async fn create_agent_invocation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(conversation_id): Path<String>,
    Json(input): Json<AgentInvocationCreateInput>,
) -> Result<Json<Value>, ApiError> {
    let requester_user_id = header_user_id(&headers)?;
    let conversation = state
        .storage
        .get_conversation_for_user(&requester_user_id, &conversation_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Conversation not found"))?;
    let target_user_id = clean_user_id(&input.target_user_id, "target_user_id")?;
    if !conversation_has_user(&conversation, &target_user_id) {
        return Err(ApiError::bad_request(
            "target_user_id must be a conversation participant",
        ));
    }
    let prompt = clean_required_text(&input.prompt, "prompt")?;
    let mut messages = state
        .storage
        .list_conversation_messages_for_user(&requester_user_id, &conversation_id)
        .await?;
    let context_message_count = input.context_message_count.unwrap_or(20).clamp(1, 50);
    if messages.len() > context_message_count {
        messages = messages.split_off(messages.len() - context_message_count);
    }
    let now = now_iso();
    let requires_target_approval = requester_user_id != target_user_id;
    let status = if requires_target_approval {
        STATUS_PENDING_APPROVAL
    } else {
        STATUS_APPROVED
    };
    let invocation_id = format!("ainv-{}", &Uuid::new_v4().simple().to_string()[..10]);
    let mut invocation = json!({
        "invocation_id": invocation_id,
        "conversation_id": conversation_id,
        "request_message_id": null,
        "requester_user_id": requester_user_id,
        "target_user_id": target_user_id,
        "target_agent_id": format!("{}-agent", target_user_id),
        "status": status,
        "prompt": prompt,
        "requires_target_approval": requires_target_approval,
        "context_snapshot": {
            "conversation_id": conversation.get("conversation_id").and_then(Value::as_str),
            "messages": messages
        },
        "created_at": now,
        "updated_at": now,
        "approved_at": if requires_target_approval { Value::Null } else { json!(now) },
        "completed_at": null,
        "target_session_id": null,
        "target_job_id": null
    });
    state.storage.upsert_agent_invocation(&invocation).await?;

    let message = state
        .storage
        .append_conversation_message(
            &conversation_id,
            invocation
                .get("requester_user_id")
                .and_then(Value::as_str)
                .unwrap_or(""),
            "user",
            invocation
                .get("requester_user_id")
                .and_then(Value::as_str)
                .unwrap_or(""),
            "agent_invocation",
            &json!({
                "text": invocation.get("prompt").and_then(Value::as_str).unwrap_or(""),
                "invocation": invocation
            }),
        )
        .await?;
    if let Some(object) = invocation.as_object_mut() {
        object.insert(
            "request_message_id".to_string(),
            message.get("message_id").cloned().unwrap_or(Value::Null),
        );
        object.insert("updated_at".to_string(), json!(now_iso()));
    }
    state.storage.upsert_agent_invocation(&invocation).await?;
    if !requires_target_approval {
        invocation = start_approved_agent_invocation(&state, invocation).await?;
    }
    Ok(Json(invocation))
}

#[utoipa::path(
    post,
    path = "/agent-invocations/{invocation_id}/approve",
    tag = "agent-invocations",
    params(("invocation_id" = String, Path, description = "Agent invocation id")),
    request_body = AgentInvocationDecisionInput,
    responses((status = 200, description = "Approved agent invocation", body = serde_json::Value))
)]
pub async fn approve_agent_invocation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(invocation_id): Path<String>,
    Json(input): Json<AgentInvocationDecisionInput>,
) -> Result<Json<Value>, ApiError> {
    update_agent_invocation_decision(
        &state,
        &header_user_id(&headers)?,
        &invocation_id,
        STATUS_APPROVED,
        input.note.or(input.reason),
    )
    .await
    .map(Json)
}

#[utoipa::path(
    post,
    path = "/agent-invocations/{invocation_id}/reject",
    tag = "agent-invocations",
    params(("invocation_id" = String, Path, description = "Agent invocation id")),
    request_body = AgentInvocationDecisionInput,
    responses((status = 200, description = "Rejected agent invocation", body = serde_json::Value))
)]
pub async fn reject_agent_invocation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(invocation_id): Path<String>,
    Json(input): Json<AgentInvocationDecisionInput>,
) -> Result<Json<Value>, ApiError> {
    update_agent_invocation_decision(
        &state,
        &header_user_id(&headers)?,
        &invocation_id,
        STATUS_REJECTED,
        input.reason.or(input.note),
    )
    .await
    .map(Json)
}

fn header_user_id(headers: &HeaderMap) -> Result<String, ApiError> {
    user_id_from_headers(headers).map_err(ApiError::bad_request)
}

fn clean_user_id(value: &str, field: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(ApiError::bad_request(format!("{field} cannot be empty")));
    }
    validate_user_id(value).map_err(ApiError::bad_request)?;
    Ok(value.to_string())
}

fn clean_required_text(value: &str, field: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(ApiError::bad_request(format!("{field} cannot be empty")));
    }
    Ok(value.to_string())
}

fn conversation_has_user(conversation: &Value, user_id: &str) -> bool {
    conversation
        .get("participants")
        .and_then(Value::as_array)
        .map(|participants| {
            participants.iter().any(|participant| {
                participant.get("user_id").and_then(Value::as_str) == Some(user_id)
                    && participant.get("status").and_then(Value::as_str) == Some("active")
            })
        })
        .unwrap_or(false)
}

async fn update_agent_invocation_decision(
    state: &AppState,
    actor_user_id: &str,
    invocation_id: &str,
    next_status: &str,
    note: Option<String>,
) -> Result<Value, ApiError> {
    let mut invocation = state
        .storage
        .get_agent_invocation(invocation_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Agent invocation not found"))?;
    if invocation.get("target_user_id").and_then(Value::as_str) != Some(actor_user_id) {
        return Err(ApiError::not_found("Agent invocation not found"));
    }
    if invocation.get("status").and_then(Value::as_str) != Some(STATUS_PENDING_APPROVAL) {
        return Err(ApiError::conflict(
            "Agent invocation is not pending approval",
        ));
    }
    let conversation_id = invocation
        .get("conversation_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("Agent invocation missing conversation_id"))?
        .to_string();
    let now = now_iso();
    if let Some(object) = invocation.as_object_mut() {
        object.insert("status".to_string(), json!(next_status));
        object.insert("updated_at".to_string(), json!(now.clone()));
        object.insert(format!("{next_status}_at"), json!(now.clone()));
        object.insert("approved_by_user_id".to_string(), json!(actor_user_id));
        if let Some(note) = clean_optional_text(note) {
            object.insert("decision_note".to_string(), json!(note));
        }
    }
    state.storage.upsert_agent_invocation(&invocation).await?;
    append_agent_invocation_event(
        state,
        &conversation_id,
        actor_user_id,
        next_status,
        &invocation,
        None,
    )
    .await?;
    if next_status == STATUS_APPROVED {
        invocation = start_approved_agent_invocation(state, invocation).await?;
    }
    Ok(invocation)
}

async fn hydrate_agent_invocation_messages(
    state: &AppState,
    mut messages: Vec<Value>,
) -> Result<Vec<Value>, ApiError> {
    for message in &mut messages {
        let Some(invocation_id) = message
            .pointer("/body/invocation/invocation_id")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            continue;
        };
        let Some(latest) = state.storage.get_agent_invocation(&invocation_id).await? else {
            continue;
        };
        if let Some(body) = message.get_mut("body").and_then(Value::as_object_mut) {
            body.insert("invocation".to_string(), latest);
        }
    }
    Ok(messages)
}

async fn start_approved_agent_invocation(
    state: &AppState,
    mut invocation: Value,
) -> Result<Value, ApiError> {
    if let Err(err) = ensure_invocation_status(&invocation, &[STATUS_APPROVED]) {
        return Err(err);
    }

    #[cfg(test)]
    {
        let now = now_iso();
        let target_user_id = invocation
            .get("target_user_id")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let invocation_id = invocation
            .get("invocation_id")
            .and_then(Value::as_str)
            .unwrap_or("ainv-test")
            .to_string();
        if let Some(object) = invocation.as_object_mut() {
            object.insert("status".to_string(), json!(STATUS_RUNNING));
            object.insert("updated_at".to_string(), json!(now));
            object.insert(
                "target_session_id".to_string(),
                json!(format!("test-session-{invocation_id}")),
            );
            object.insert(
                "target_job_id".to_string(),
                json!(format!("test-job-{invocation_id}")),
            );
        }
        state.storage.upsert_agent_invocation(&invocation).await?;
        let conversation_id = required_invocation_str(&invocation, "conversation_id")?.to_string();
        append_agent_invocation_event(
            state,
            &conversation_id,
            &target_user_id,
            STATUS_RUNNING,
            &invocation,
            Some("Agent run started."),
        )
        .await?;
        Ok(invocation)
    }

    #[cfg(not(test))]
    {
        match start_agent_invocation_run(state, &invocation).await {
            Ok((session_id, info)) => {
                let now = now_iso();
                let target_user_id =
                    required_invocation_str(&invocation, "target_user_id")?.to_string();
                let conversation_id =
                    required_invocation_str(&invocation, "conversation_id")?.to_string();
                if let Some(object) = invocation.as_object_mut() {
                    object.insert("status".to_string(), json!(STATUS_RUNNING));
                    object.insert("updated_at".to_string(), json!(now));
                    object.insert("target_session_id".to_string(), json!(session_id));
                    object.insert("target_job_id".to_string(), json!(info.job_id.clone()));
                }
                state.storage.upsert_agent_invocation(&invocation).await?;
                append_agent_invocation_event(
                    state,
                    &conversation_id,
                    &target_user_id,
                    STATUS_RUNNING,
                    &invocation,
                    Some("Agent run started."),
                )
                .await?;
                spawn_agent_invocation_monitor(
                    state.clone(),
                    required_invocation_str(&invocation, "invocation_id")?.to_string(),
                    target_user_id,
                    info.job_id,
                );
                Ok(invocation)
            }
            Err(err) => {
                let error = err
                    .detail
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| err.detail.to_string());
                mark_agent_invocation_status(state, invocation, STATUS_FAILED, Some(error)).await
            }
        }
    }
}

#[cfg(not(test))]
async fn start_agent_invocation_run(
    state: &AppState,
    invocation: &Value,
) -> Result<(String, AgentRunInfo), ApiError> {
    let target_user_id = required_invocation_str(invocation, "target_user_id")?.to_string();
    let prompt = agent_invocation_prompt(invocation)?;
    let session_title = agent_invocation_session_title(invocation);
    let mut session = state
        .sessions
        .create_session(
            &target_user_id,
            CreateSessionInput {
                model: Some(state.config.default_model.clone()),
                max_turns: Some(200),
                system_prompt: Some(agent_invocation_base_instructions()),
                context_folder_path: None,
            },
        )
        .await?;
    session.title = session_title;
    session.set_status(SessionStatus::Queued);
    session.messages.push(json!({
        "role": "user",
        "content": prompt.clone(),
        "created_at": now_iso(),
        "metadata": {
            "agent_invocation_id": invocation.get("invocation_id").and_then(Value::as_str),
            "conversation_id": invocation.get("conversation_id").and_then(Value::as_str)
        }
    }));
    session.message_count = session.messages.len();
    state
        .sessions
        .save_record_if_exists(session.clone())
        .await?;

    let (model, effort) = state.config.resolve_model(Some(&session.model));
    let create = AgentRunCreateRequest {
        prompt: prompt.clone(),
        provider: "codex".to_string(),
        base_instructions: Some(agent_invocation_base_instructions()),
        turn_context: None,
        client_context: None,
        browser_context: None,
        cwd: None,
        input_items: vec![json!({"type": "text", "text": prompt})],
        model: Some(model),
        effort,
        summary: None,
        output_schema: None,
        max_runtime_seconds: state.config.codex.max_runtime_seconds,
        task_trigger_id: None,
        task_trigger_title: None,
        task_trigger_reason: None,
        codex_thread_id: session.codex_thread_id.clone(),
        codex_persistent_thread: true,
        memory_disabled: true,
        chat_user_input: invocation
            .get("prompt")
            .and_then(Value::as_str)
            .map(str::to_string),
        chat_user_content: Some(invocation.clone()),
    };
    assert_can_create_run(state, &target_user_id, create.max_runtime_seconds).await?;
    let workspace_root = state.sandboxes.ensure_sandbox(&target_user_id)?;
    let runtime_dir = state
        .sandboxes
        .session_dir(&target_user_id, &session.session_id)?;
    let info = state
        .jobs
        .start(
            create,
            target_user_id,
            Some(session.session_id.clone()),
            workspace_root,
            runtime_dir,
        )
        .await
        .map_err(|err| ApiError::bad_request(err.to_string()))?;
    Ok((session.session_id, info))
}

#[cfg(not(test))]
fn spawn_agent_invocation_monitor(
    state: AppState,
    invocation_id: String,
    target_user_id: String,
    job_id: String,
) {
    tokio::spawn(async move {
        for _ in 0..720 {
            match state.jobs.info_for_user(&job_id, &target_user_id).await {
                Ok(Some(info)) if TERMINAL_RUN_STATUSES.contains(&info.status.as_str()) => {
                    let _ = finalize_agent_invocation_run(&state, &invocation_id, &info).await;
                    return;
                }
                Ok(Some(info))
                    if info.pending_approval.is_some() || info.pending_user_input.is_some() =>
                {
                    let _ = mark_agent_invocation_status_by_id(
                        &state,
                        &invocation_id,
                        STATUS_AWAITING_TARGET_PERMISSION,
                        None,
                    )
                    .await;
                }
                Ok(Some(_)) => {
                    let _ = mark_agent_invocation_status_by_id(
                        &state,
                        &invocation_id,
                        STATUS_RUNNING,
                        None,
                    )
                    .await;
                }
                Ok(None) => {
                    let _ = mark_agent_invocation_status_by_id(
                        &state,
                        &invocation_id,
                        STATUS_FAILED,
                        Some("Target agent run not found".to_string()),
                    )
                    .await;
                    return;
                }
                Err(err) => {
                    let _ = mark_agent_invocation_status_by_id(
                        &state,
                        &invocation_id,
                        STATUS_FAILED,
                        Some(err.to_string()),
                    )
                    .await;
                    return;
                }
            }
            sleep(Duration::from_secs(5)).await;
        }
        let _ = mark_agent_invocation_status_by_id(
            &state,
            &invocation_id,
            STATUS_FAILED,
            Some("Target agent monitor timed out".to_string()),
        )
        .await;
    });
}

#[cfg(not(test))]
async fn finalize_agent_invocation_run(
    state: &AppState,
    invocation_id: &str,
    info: &AgentRunInfo,
) -> Result<(), ApiError> {
    let invocation = state
        .storage
        .get_agent_invocation(invocation_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Agent invocation not found"))?;
    let output = read_run_output(state, &invocation, info).await;
    let status = match info.status.as_str() {
        "completed" => STATUS_COMPLETED,
        "cancelled" => STATUS_CANCELLED,
        _ => STATUS_FAILED,
    };
    let now = now_iso();
    let mut final_record = invocation;
    if let Some(object) = final_record.as_object_mut() {
        object.insert("status".to_string(), json!(status));
        object.insert("updated_at".to_string(), json!(now.clone()));
        object.insert("completed_at".to_string(), json!(now));
        object.insert("result_status".to_string(), json!(info.status.as_str()));
        object.insert("result_job_id".to_string(), json!(info.job_id.as_str()));
        object.insert(
            "result_output_available".to_string(),
            json!(!output.trim().is_empty()),
        );
        if output.trim().is_empty() {
            object.insert("result_text".to_string(), Value::Null);
        } else {
            object.insert("result_text".to_string(), json!(output.trim()));
        }
        if let Some(error) = info
            .error
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            object.insert("error".to_string(), json!(error));
        }
    }
    state.storage.upsert_agent_invocation(&final_record).await?;
    let conversation_id = required_invocation_str(&final_record, "conversation_id")?.to_string();
    let target_user_id = required_invocation_str(&final_record, "target_user_id")?.to_string();
    let text = if output.trim().is_empty() {
        format!("Agent run ended with status {}.", info.status)
    } else {
        output.trim().to_string()
    };
    append_agent_invocation_event(
        state,
        &conversation_id,
        &target_user_id,
        status,
        &final_record,
        Some(text.as_str()),
    )
    .await?;
    update_target_session_after_invocation_run(state, &final_record, info, &output).await?;
    Ok(())
}

#[cfg(not(test))]
async fn update_target_session_after_invocation_run(
    state: &AppState,
    invocation: &Value,
    info: &AgentRunInfo,
    output: &str,
) -> Result<(), ApiError> {
    let target_user_id = required_invocation_str(invocation, "target_user_id")?.to_string();
    let Some(target_session_id) = invocation.get("target_session_id").and_then(Value::as_str)
    else {
        return Ok(());
    };
    let Some(mut session) = state
        .sessions
        .load(&target_user_id, target_session_id)
        .await?
    else {
        return Ok(());
    };
    if let Some(thread_id) = info.metadata.get("codex_thread_id").and_then(Value::as_str) {
        session.codex_thread_id = Some(thread_id.to_string());
    }
    if info.status == "completed" {
        session.set_status(SessionStatus::Idle);
        session.pending_permission_request = None;
    } else if info.status == "cancelled" {
        session.set_status(SessionStatus::Cancelled);
    } else {
        session.set_status(SessionStatus::Failed);
    }
    let body = if output.trim().is_empty() {
        format!("Agent run ended with status {}.", info.status)
    } else {
        output.trim().to_string()
    };
    session.messages.push(json!({
        "role": "assistant",
        "content": [{"type": "text", "text": body}],
        "created_at": now_iso(),
        "metadata": {
            "agent_invocation_id": invocation.get("invocation_id").and_then(Value::as_str),
            "conversation_id": invocation.get("conversation_id").and_then(Value::as_str),
            "target_job_id": info.job_id,
            "target_status": info.status
        }
    }));
    session.message_count = session.messages.len();
    session.last_active = now_iso();
    state.sessions.save_record_if_exists(session).await?;
    Ok(())
}

#[cfg(not(test))]
async fn mark_agent_invocation_status_by_id(
    state: &AppState,
    invocation_id: &str,
    status: &str,
    error: Option<String>,
) -> Result<Value, ApiError> {
    let invocation = state
        .storage
        .get_agent_invocation(invocation_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Agent invocation not found"))?;
    mark_agent_invocation_status(state, invocation, status, error).await
}

#[cfg(not(test))]
async fn mark_agent_invocation_status(
    state: &AppState,
    mut invocation: Value,
    status: &str,
    error: Option<String>,
) -> Result<Value, ApiError> {
    let previous_status = invocation
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let now = now_iso();
    if let Some(object) = invocation.as_object_mut() {
        object.insert("status".to_string(), json!(status));
        object.insert("updated_at".to_string(), json!(now.clone()));
        if matches!(status, STATUS_COMPLETED | STATUS_FAILED | STATUS_CANCELLED) {
            object.insert("completed_at".to_string(), json!(now));
        }
        if let Some(error) = error.filter(|value| !value.trim().is_empty()) {
            object.insert("error".to_string(), json!(error));
        }
    }
    state.storage.upsert_agent_invocation(&invocation).await?;
    if previous_status != status {
        let conversation_id = required_invocation_str(&invocation, "conversation_id")?.to_string();
        let target_user_id = required_invocation_str(&invocation, "target_user_id")?.to_string();
        append_agent_invocation_event(
            state,
            &conversation_id,
            &target_user_id,
            status,
            &invocation,
            None,
        )
        .await?;
    }
    Ok(invocation)
}

async fn append_agent_invocation_event(
    state: &AppState,
    conversation_id: &str,
    actor_user_id: &str,
    event_type: &str,
    invocation: &Value,
    text: Option<&str>,
) -> Result<Value, ApiError> {
    state
        .storage
        .append_conversation_message(
            conversation_id,
            actor_user_id,
            "agent",
            format!("{actor_user_id}-agent").as_str(),
            "agent_invocation_event",
            &json!({
                "event_type": event_type,
                "invocation_id": invocation.get("invocation_id").and_then(Value::as_str),
                "actor_user_id": actor_user_id,
                "text": text,
                "invocation": invocation
            }),
        )
        .await
        .map_err(ApiError::from)
}

fn ensure_invocation_status(invocation: &Value, allowed: &[&str]) -> Result<(), ApiError> {
    let status = invocation
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("");
    if allowed.contains(&status) {
        Ok(())
    } else {
        Err(ApiError::conflict(
            "Agent invocation is not in the expected status",
        ))
    }
}

fn required_invocation_str<'a>(invocation: &'a Value, key: &str) -> Result<&'a str, ApiError> {
    invocation
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request(format!("Agent invocation missing {key}")))
}

#[cfg(not(test))]
fn agent_invocation_session_title(invocation: &Value) -> String {
    let prompt = invocation
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or("Agent collaboration")
        .trim();
    let preview: String = prompt.chars().take(32).collect();
    if preview.is_empty() {
        "Agent 协作".to_string()
    } else {
        format!("Agent 协作：{preview}")
    }
}

#[cfg(not(test))]
fn agent_invocation_base_instructions() -> String {
    "你是 Ripple 协作对话中被 @ 提及并获得授权的 Codex agent。你只代表目标用户执行任务，只能使用目标用户自己的 workspace、connector 和授权上下文。人和人的 conversation 是共享上下文，不代表你可以跨用户读取文件或凭证。完成后给出可直接回写到共享对话的结果；如果需要目标用户批准某个具体操作，请走正常 Codex approval/user-input 流程。".to_string()
}

#[cfg(not(test))]
fn agent_invocation_prompt(invocation: &Value) -> Result<String, ApiError> {
    let requester = required_invocation_str(invocation, "requester_user_id")?;
    let target = required_invocation_str(invocation, "target_user_id")?;
    let prompt = required_invocation_str(invocation, "prompt")?;
    let context = format_context_snapshot(
        invocation
            .get("context_snapshot")
            .and_then(|snapshot| snapshot.get("messages"))
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]),
    );
    Ok(format!(
        "你正在代表用户 {target} 处理共享对话中来自用户 {requester} 的 @agent 请求。\n\n用户请求：\n{prompt}\n\n共享对话上下文快照：\n{context}\n\n请基于以上共享上下文完成任务。不要访问其他用户的 workspace 或凭证；如果任务需要目标用户授权外部操作，请等待目标用户在 Codex approval/user-input 中确认。完成后输出一段可以回写到这条共享 conversation 的结果。",
    ))
}

#[cfg(not(test))]
fn format_context_snapshot(messages: &[Value]) -> String {
    if messages.is_empty() {
        return "（没有可用的上下文消息）".to_string();
    }
    messages
        .iter()
        .filter_map(|message| {
            let sender = message
                .get("sender_user_id")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let kind = message
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("message");
            let text = message_text_for_prompt(message);
            if text.trim().is_empty() {
                None
            } else {
                Some(format!("- {sender} ({kind}): {}", text.trim()))
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(not(test))]
fn message_text_for_prompt(message: &Value) -> String {
    if let Some(text) = message.pointer("/body/text").and_then(Value::as_str) {
        return text.to_string();
    }
    if let Some(prompt) = message
        .pointer("/body/invocation/prompt")
        .and_then(Value::as_str)
    {
        return prompt.to_string();
    }
    String::new()
}

#[cfg(not(test))]
async fn read_run_output(state: &AppState, invocation: &Value, info: &AgentRunInfo) -> String {
    let target_user = invocation
        .get("target_user_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let text = if let Some(output_file) = info.output_file.as_deref() {
        tokio::fs::read_to_string(output_file)
            .await
            .unwrap_or_else(|_| info.stdout_tail.clone())
    } else {
        info.stdout_tail.clone()
    };
    sanitize_user_visible_text(state, target_user, &text)
}

fn clean_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}
