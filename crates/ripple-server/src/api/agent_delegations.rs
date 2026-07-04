use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::time::{sleep, Duration};
use uuid::Uuid;

use crate::api::run_public::sanitize_user_visible_text;
use crate::api::users::assert_can_create_run;
use crate::api::ApiError;
use crate::jobs::{AgentRunCreateRequest, AgentRunInfo};
use crate::sessions::{CreateSessionInput, SessionStatus};
use crate::state::AppState;
use crate::user::{user_id_from_headers, validate_user_id};

const STATUS_PENDING_ACCEPTANCE: &str = "pending_acceptance";
const STATUS_RUNNING: &str = "running";
const STATUS_AWAITING_TARGET_PERMISSION: &str = "awaiting_target_permission";
const STATUS_AWAITING_REQUESTER_INFO: &str = "awaiting_requester_info";
const STATUS_COMPLETED: &str = "completed";
const STATUS_FAILED: &str = "failed";
const STATUS_CANCELLED: &str = "cancelled";
const STATUS_REJECTED: &str = "rejected";
const TERMINAL_RUN_STATUSES: &[&str] = &["completed", "failed", "cancelled"];
const DELEGATION_REQUEST_OPEN: &str = "<ripple_delegation_request>";
const DELEGATION_REQUEST_CLOSE: &str = "</ripple_delegation_request>";

#[derive(Debug, Clone, PartialEq, Eq)]
struct DelegationClarificationRequest {
    question: String,
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AgentDelegationListQuery {
    role: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AgentDelegationCreateInput {
    target_user_id: String,
    source_session_id: String,
    task_title: String,
    task_prompt: String,
}

#[derive(Debug, Deserialize)]
pub struct AgentDelegationDecisionInput {
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AgentDelegationAnswerInput {
    answer: String,
}

#[utoipa::path(
    get,
    path = "/agent-delegations",
    tag = "agent-delegations",
    responses((status = 200, description = "Agent delegations", body = serde_json::Value))
)]
pub async fn list_agent_delegations(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AgentDelegationListQuery>,
) -> Result<Json<Value>, ApiError> {
    let user_id = header_user_id(&headers)?;
    let role = query.role.as_deref().unwrap_or("sent");
    let delegations = if role == "received" {
        state
            .storage
            .list_agent_delegations_for_target(&user_id)
            .await?
    } else {
        state
            .storage
            .list_agent_delegations_for_requester(&user_id)
            .await?
    };
    Ok(Json(json!({
        "delegations": delegations,
        "count": delegations.len()
    })))
}

#[utoipa::path(
    post,
    path = "/agent-delegations",
    tag = "agent-delegations",
    request_body = serde_json::Value,
    responses((status = 200, description = "Created agent delegation", body = serde_json::Value))
)]
pub async fn create_agent_delegation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<AgentDelegationCreateInput>,
) -> Result<Json<Value>, ApiError> {
    let requester_user_id = header_user_id(&headers)?;
    let target_user_id = clean_required(&input.target_user_id, "target_user_id")?;
    validate_user_id(&target_user_id).map_err(ApiError::bad_request)?;
    if target_user_id == requester_user_id {
        return Err(ApiError::bad_request("target_user_id must be another user"));
    }

    let task_title = clean_required(&input.task_title, "task_title")?;
    let task_prompt = clean_required(&input.task_prompt, "task_prompt")?;
    let requester_session_id = clean_required(&input.source_session_id, "source_session_id")?;
    if state
        .sessions
        .load(&requester_user_id, &requester_session_id)
        .await?
        .is_none()
    {
        return Err(ApiError::not_found("Source session not found"));
    }

    let now = now_iso();
    let record = json!({
        "delegation_id": format!("dlg-{}", &Uuid::new_v4().simple().to_string()[..10]),
        "requester_user_id": requester_user_id,
        "requester_session_id": requester_session_id,
        "target_user_id": target_user_id,
        "target_session_id": null,
        "target_job_id": null,
        "status": STATUS_PENDING_ACCEPTANCE,
        "task_title": task_title,
        "task_prompt": task_prompt,
        "created_at": now,
        "updated_at": now
    });
    state.storage.upsert_agent_delegation(&record).await?;
    Ok(Json(record))
}

#[utoipa::path(
    get,
    path = "/agent-delegations/{delegation_id}",
    tag = "agent-delegations",
    responses((status = 200, description = "Agent delegation", body = serde_json::Value))
)]
pub async fn get_agent_delegation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(delegation_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = header_user_id(&headers)?;
    let record = load_visible_delegation(&state, &user_id, &delegation_id).await?;
    Ok(Json(record))
}

#[utoipa::path(
    post,
    path = "/agent-delegations/{delegation_id}/cancel",
    tag = "agent-delegations",
    request_body = serde_json::Value,
    responses((status = 200, description = "Cancelled agent delegation", body = serde_json::Value))
)]
pub async fn cancel_agent_delegation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(delegation_id): Path<String>,
    Json(input): Json<AgentDelegationDecisionInput>,
) -> Result<Json<Value>, ApiError> {
    update_delegation_status(
        &state,
        &header_user_id(&headers)?,
        &delegation_id,
        STATUS_CANCELLED,
        "requester",
        input.reason,
    )
    .await
    .map(Json)
}

#[utoipa::path(
    post,
    path = "/agent-delegations/{delegation_id}/accept",
    tag = "agent-delegations",
    request_body = serde_json::Value,
    responses((status = 200, description = "Accepted agent delegation", body = serde_json::Value))
)]
pub async fn accept_agent_delegation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(delegation_id): Path<String>,
    Json(input): Json<AgentDelegationDecisionInput>,
) -> Result<Json<Value>, ApiError> {
    let target_user_id = header_user_id(&headers)?;
    let mut record = load_visible_delegation(&state, &target_user_id, &delegation_id).await?;
    ensure_role(&record, &target_user_id, "target")?;
    ensure_status(&record, STATUS_PENDING_ACCEPTANCE)?;

    let prompt = target_agent_prompt(&record)?;
    let session_title = format!("委托任务：{}", delegation_title(&record));
    let mut session = state
        .sessions
        .create_session(
            &target_user_id,
            CreateSessionInput {
                model: Some(state.config.default_model.clone()),
                max_turns: Some(200),
                system_prompt: Some(agent_delegation_base_instructions()),
                context_folder_path: None,
            },
        )
        .await?;
    session.title = session_title;
    session.set_status(SessionStatus::Queued);
    session.messages.push(json!({
        "role": "user",
        "content": prompt.clone(),
        "created_at": now_iso()
    }));
    session.message_count = session.messages.len();
    state
        .sessions
        .save_record_if_exists(session.clone())
        .await?;

    let info = start_target_agent_run(
        &state,
        &target_user_id,
        &session.session_id,
        prompt.clone(),
        delegation_prompt(&record)?.to_string(),
    )
    .await?;

    let now = now_iso();
    set_field(&mut record, "status", json!(STATUS_RUNNING));
    set_field(&mut record, "target_session_id", json!(session.session_id));
    set_field(&mut record, "target_job_id", json!(info.job_id.clone()));
    set_field(&mut record, "accepted_at", json!(now));
    set_field(&mut record, "updated_at", json!(now));
    if let Some(reason) = clean_optional(input.reason) {
        set_field(&mut record, "acceptance_note", json!(reason));
    }
    state.storage.upsert_agent_delegation(&record).await?;
    spawn_agent_delegation_monitor(state.clone(), delegation_id, target_user_id, info.job_id);
    Ok(Json(record))
}

#[utoipa::path(
    post,
    path = "/agent-delegations/{delegation_id}/reject",
    tag = "agent-delegations",
    request_body = serde_json::Value,
    responses((status = 200, description = "Rejected agent delegation", body = serde_json::Value))
)]
pub async fn reject_agent_delegation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(delegation_id): Path<String>,
    Json(input): Json<AgentDelegationDecisionInput>,
) -> Result<Json<Value>, ApiError> {
    update_delegation_status(
        &state,
        &header_user_id(&headers)?,
        &delegation_id,
        STATUS_REJECTED,
        "target",
        input.reason,
    )
    .await
    .map(Json)
}

#[utoipa::path(
    post,
    path = "/agent-delegations/{delegation_id}/answer",
    tag = "agent-delegations",
    request_body = serde_json::Value,
    responses((status = 200, description = "Answered agent delegation clarification", body = serde_json::Value))
)]
pub async fn answer_agent_delegation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(delegation_id): Path<String>,
    Json(input): Json<AgentDelegationAnswerInput>,
) -> Result<Json<Value>, ApiError> {
    let requester_user_id = header_user_id(&headers)?;
    let mut record = load_visible_delegation(&state, &requester_user_id, &delegation_id).await?;
    ensure_role(&record, &requester_user_id, "requester")?;
    ensure_status(&record, STATUS_AWAITING_REQUESTER_INFO)?;

    let answer = clean_required(&input.answer, "answer")?;
    let target_user = target_user_id(&record)?.to_string();
    let target_session_id = record
        .get("target_session_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("Agent delegation missing target_session_id"))?
        .to_string();
    let followup_prompt = target_agent_followup_prompt(&record, &answer)?;
    append_followup_to_target_session(&state, &record, &target_session_id, &followup_prompt)
        .await?;

    let info = start_target_agent_run(
        &state,
        &target_user,
        &target_session_id,
        followup_prompt.clone(),
        answer.clone(),
    )
    .await?;
    let event = state
        .storage
        .append_agent_delegation_event(
            &delegation_id,
            "clarification_answer",
            Some(&requester_user_id),
            &json!({
                "answer": answer,
                "target_user_id": target_user.clone(),
                "target_session_id": target_session_id.clone(),
                "target_job_id": info.job_id,
                "previous_clarification": record.get("pending_clarification").cloned().unwrap_or(Value::Null)
            }),
        )
        .await?;
    append_answer_to_requester_session(&state, &record, &answer, &info).await?;

    let now = now_iso();
    set_field(&mut record, "status", json!(STATUS_RUNNING));
    set_field(&mut record, "target_job_id", json!(info.job_id.clone()));
    set_field(&mut record, "updated_at", json!(now));
    set_field(&mut record, "pending_clarification", Value::Null);
    set_field(&mut record, "last_answer_event", event);
    state.storage.upsert_agent_delegation(&record).await?;
    spawn_agent_delegation_monitor(state.clone(), delegation_id, target_user, info.job_id);
    Ok(Json(record))
}

async fn update_delegation_status(
    state: &AppState,
    user_id: &str,
    delegation_id: &str,
    status: &str,
    required_role: &str,
    reason: Option<String>,
) -> Result<Value, ApiError> {
    let mut record = load_visible_delegation(state, user_id, delegation_id).await?;
    ensure_role(&record, user_id, required_role)?;
    if matches!(status, STATUS_REJECTED | STATUS_CANCELLED) {
        ensure_status(&record, STATUS_PENDING_ACCEPTANCE)?;
    }
    let now = now_iso();
    set_field(&mut record, "status", json!(status));
    set_field(&mut record, "updated_at", json!(now));
    if matches!(status, STATUS_REJECTED | STATUS_CANCELLED) {
        set_field(&mut record, "completed_at", json!(now));
    }
    if let Some(reason) = clean_optional(reason) {
        set_field(&mut record, "reason", json!(reason));
    }
    state.storage.upsert_agent_delegation(&record).await?;
    Ok(record)
}

async fn load_visible_delegation(
    state: &AppState,
    user_id: &str,
    delegation_id: &str,
) -> Result<Value, ApiError> {
    let record = state
        .storage
        .get_agent_delegation(delegation_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Agent delegation not found"))?;
    if is_requester(&record, user_id) || is_target(&record, user_id) {
        return Ok(record);
    }
    Err(ApiError::not_found("Agent delegation not found"))
}

fn ensure_role(record: &Value, user_id: &str, role: &str) -> Result<(), ApiError> {
    let allowed = match role {
        "requester" => is_requester(record, user_id),
        "target" => is_target(record, user_id),
        _ => false,
    };
    if allowed {
        Ok(())
    } else {
        Err(ApiError::not_found("Agent delegation not found"))
    }
}

fn ensure_status(record: &Value, status: &str) -> Result<(), ApiError> {
    if record.get("status").and_then(Value::as_str) == Some(status) {
        Ok(())
    } else {
        Err(ApiError::conflict(
            "Agent delegation is not in the expected status",
        ))
    }
}

fn header_user_id(headers: &HeaderMap) -> Result<String, ApiError> {
    user_id_from_headers(headers).map_err(ApiError::bad_request)
}

fn is_requester(record: &Value, user_id: &str) -> bool {
    record.get("requester_user_id").and_then(Value::as_str) == Some(user_id)
}

fn is_target(record: &Value, user_id: &str) -> bool {
    record.get("target_user_id").and_then(Value::as_str) == Some(user_id)
}

fn clean_required(value: &str, field: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty() {
        Err(ApiError::bad_request(format!("{field} cannot be empty")))
    } else {
        Ok(value.to_string())
    }
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn set_field(record: &mut Value, key: &str, value: Value) {
    if let Some(object) = record.as_object_mut() {
        object.insert(key.to_string(), value);
    }
}

fn required_record_str<'a>(record: &'a Value, key: &str) -> Result<&'a str, ApiError> {
    record
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request(format!("Agent delegation missing {key}")))
}

fn requester_user_id(record: &Value) -> Result<&str, ApiError> {
    required_record_str(record, "requester_user_id")
}

fn requester_session_id(record: &Value) -> Result<&str, ApiError> {
    required_record_str(record, "requester_session_id")
}

fn target_user_id(record: &Value) -> Result<&str, ApiError> {
    required_record_str(record, "target_user_id")
}

fn delegation_title(record: &Value) -> String {
    record
        .get("task_title")
        .and_then(Value::as_str)
        .unwrap_or("Agent delegation")
        .to_string()
}

fn delegation_prompt(record: &Value) -> Result<&str, ApiError> {
    required_record_str(record, "task_prompt")
}

fn target_agent_prompt(record: &Value) -> Result<String, ApiError> {
    Ok(format!(
        "你正在代表用户 {target} 处理来自用户 {requester} 的一次委托任务。\n\n任务标题：{title}\n\n任务内容：\n{prompt}\n\n请只完成本次委托，不要尝试访问其他用户的工作区。完成后直接给出可返回给 {requester} 的结果。如果你需要当前用户授权某个具体操作，请通过正常 Codex approval/user-input 流程等待用户处理。\n\n如果你缺少的是请求方 {requester} 才能提供的信息，不要猜测，也不要输出最终结果。请只输出如下 XML 标记包裹的 JSON：\n{open}{{\"type\":\"clarification_request\",\"target\":\"requester\",\"question\":\"你需要请求方补充的问题\",\"reason\":\"为什么缺少这个信息\"}}{close}",
        target = target_user_id(record)?,
        requester = requester_user_id(record)?,
        title = delegation_title(record),
        prompt = delegation_prompt(record)?,
        open = DELEGATION_REQUEST_OPEN,
        close = DELEGATION_REQUEST_CLOSE
    ))
}

fn agent_delegation_base_instructions() -> String {
    format!(
        "你是 Ripple 中被授权执行一次跨用户委托任务的 Codex agent。你只能使用当前目标用户的 workspace、connector 和授权上下文；不能假设可以读取请求方的文件系统或凭证。完成任务后，用清晰、可转发的结果总结回复。如果缺少请求方信息，请输出 {open}...{close} 结构化请求，由 Ripple 暂停委托并转给请求方；不要自行模拟跨用户对话。",
        open = DELEGATION_REQUEST_OPEN,
        close = DELEGATION_REQUEST_CLOSE
    )
}

fn target_agent_followup_prompt(record: &Value, answer: &str) -> Result<String, ApiError> {
    Ok(format!(
        "请求方 {requester} 已经补充了信息。请基于原始委托任务继续执行，并在完成后直接给出可返回给 {requester} 的结果。\n\n原始任务标题：{title}\n\n原始任务内容：\n{prompt}\n\n请求方补充信息：\n{answer}\n\n如果仍然缺少请求方信息，请继续只输出如下 XML 标记包裹的 JSON：\n{open}{{\"type\":\"clarification_request\",\"target\":\"requester\",\"question\":\"你需要请求方补充的问题\",\"reason\":\"为什么缺少这个信息\"}}{close}",
        requester = requester_user_id(record)?,
        title = delegation_title(record),
        prompt = delegation_prompt(record)?,
        answer = answer.trim(),
        open = DELEGATION_REQUEST_OPEN,
        close = DELEGATION_REQUEST_CLOSE
    ))
}

async fn start_target_agent_run(
    state: &AppState,
    target_user_id: &str,
    target_session_id: &str,
    prompt: String,
    chat_user_input: String,
) -> Result<AgentRunInfo, ApiError> {
    let Some(session) = state
        .sessions
        .load(target_user_id, target_session_id)
        .await?
    else {
        return Err(ApiError::not_found("Target session not found"));
    };
    let (model, effort) = state.config.resolve_model(Some(&session.model));
    let create = AgentRunCreateRequest {
        prompt: prompt.clone(),
        provider: "codex".to_string(),
        base_instructions: Some(agent_delegation_base_instructions()),
        turn_context: None,
        client_context: None,
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
        chat_user_input: Some(chat_user_input),
        chat_user_content: None,
    };
    assert_can_create_run(state, target_user_id, create.max_runtime_seconds).await?;
    let workspace_root = state.sandboxes.ensure_sandbox(target_user_id)?;
    let runtime_dir = state
        .sandboxes
        .session_dir(target_user_id, target_session_id)?;
    state
        .jobs
        .start(
            create,
            target_user_id.to_string(),
            Some(target_session_id.to_string()),
            workspace_root,
            runtime_dir,
        )
        .await
        .map_err(|err| ApiError::bad_request(err.to_string()))
}

fn parse_delegation_clarification_request(output: &str) -> Option<DelegationClarificationRequest> {
    let start = output.find(DELEGATION_REQUEST_OPEN)? + DELEGATION_REQUEST_OPEN.len();
    let rest = &output[start..];
    let end = rest.find(DELEGATION_REQUEST_CLOSE)?;
    let payload = rest[..end].trim();
    let value: Value = serde_json::from_str(payload).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("clarification_request") {
        return None;
    }
    let target = value
        .get("target")
        .and_then(Value::as_str)
        .unwrap_or("requester");
    if target != "requester" {
        return None;
    }
    let question = value.get("question").and_then(Value::as_str)?.trim();
    if question.is_empty() {
        return None;
    }
    let reason = value
        .get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Some(DelegationClarificationRequest {
        question: question.to_string(),
        reason,
    })
}

fn spawn_agent_delegation_monitor(
    state: AppState,
    delegation_id: String,
    target_user_id: String,
    job_id: String,
) {
    tokio::spawn(async move {
        for _ in 0..720 {
            match state.jobs.info_for_user(&job_id, &target_user_id).await {
                Ok(Some(info)) if TERMINAL_RUN_STATUSES.contains(&info.status.as_str()) => {
                    let _ = finalize_agent_delegation_run(&state, &delegation_id, &info).await;
                    return;
                }
                Ok(Some(info))
                    if info.pending_approval.is_some() || info.pending_user_input.is_some() =>
                {
                    let _ = mark_delegation_status(
                        &state,
                        &delegation_id,
                        STATUS_AWAITING_TARGET_PERMISSION,
                        None,
                    )
                    .await;
                }
                Ok(Some(_)) => {
                    let _ =
                        mark_delegation_status(&state, &delegation_id, STATUS_RUNNING, None).await;
                }
                Ok(None) => {
                    let _ = mark_delegation_status(
                        &state,
                        &delegation_id,
                        STATUS_FAILED,
                        Some("Target agent run not found".to_string()),
                    )
                    .await;
                    return;
                }
                Err(err) => {
                    let _ = mark_delegation_status(
                        &state,
                        &delegation_id,
                        STATUS_FAILED,
                        Some(err.to_string()),
                    )
                    .await;
                    return;
                }
            }
            sleep(Duration::from_secs(5)).await;
        }
        let _ = mark_delegation_status(
            &state,
            &delegation_id,
            STATUS_FAILED,
            Some("Target agent monitor timed out".to_string()),
        )
        .await;
    });
}

async fn finalize_agent_delegation_run(
    state: &AppState,
    delegation_id: &str,
    info: &AgentRunInfo,
) -> Result<(), ApiError> {
    let record = state
        .storage
        .get_agent_delegation(delegation_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Agent delegation not found"))?;
    let output = read_run_output(state, &record, info).await;
    if info.status == "completed" {
        if let Some(request) = parse_delegation_clarification_request(&output) {
            handle_delegation_clarification_request(state, record, info, request).await?;
            return Ok(());
        }
    }
    update_target_session_after_run(state, &record, info, &output).await?;
    append_result_to_requester_session(state, &record, info, &output).await?;
    let status = match info.status.as_str() {
        "completed" => STATUS_COMPLETED,
        "cancelled" => STATUS_CANCELLED,
        _ => STATUS_FAILED,
    };
    mark_delegation_status(state, delegation_id, status, info.error.clone()).await?;
    Ok(())
}

async fn handle_delegation_clarification_request(
    state: &AppState,
    mut record: Value,
    info: &AgentRunInfo,
    request: DelegationClarificationRequest,
) -> Result<(), ApiError> {
    let delegation_id = required_record_str(&record, "delegation_id")?.to_string();
    let target_user = target_user_id(&record)?.to_string();
    let event = state
        .storage
        .append_agent_delegation_event(
            &delegation_id,
            "clarification_request",
            Some(&target_user),
            &json!({
                "question": request.question.clone(),
                "reason": request.reason.clone(),
                "target": "requester",
                "target_job_id": info.job_id,
                "target_session_id": record.get("target_session_id").cloned().unwrap_or(Value::Null)
            }),
        )
        .await?;

    update_target_session_for_clarification(state, &record, info, &request).await?;
    append_clarification_to_requester_session(state, &record, info, &request, &event).await?;

    let now = now_iso();
    set_field(&mut record, "status", json!(STATUS_AWAITING_REQUESTER_INFO));
    set_field(&mut record, "updated_at", json!(now));
    set_field(&mut record, "pending_clarification", event);
    state.storage.upsert_agent_delegation(&record).await?;
    Ok(())
}

async fn mark_delegation_status(
    state: &AppState,
    delegation_id: &str,
    status: &str,
    error: Option<String>,
) -> Result<(), ApiError> {
    let mut record = state
        .storage
        .get_agent_delegation(delegation_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Agent delegation not found"))?;
    let now = now_iso();
    set_field(&mut record, "status", json!(status));
    set_field(&mut record, "updated_at", json!(now));
    if matches!(status, STATUS_COMPLETED | STATUS_FAILED | STATUS_CANCELLED) {
        set_field(&mut record, "completed_at", json!(now));
    }
    if let Some(error) = error.filter(|value| !value.trim().is_empty()) {
        set_field(&mut record, "error", json!(error));
    }
    state.storage.upsert_agent_delegation(&record).await?;
    Ok(())
}

async fn update_target_session_for_clarification(
    state: &AppState,
    record: &Value,
    info: &AgentRunInfo,
    request: &DelegationClarificationRequest,
) -> Result<(), ApiError> {
    let target_user = target_user_id(record)?.to_string();
    let Some(target_session) = record.get("target_session_id").and_then(Value::as_str) else {
        return Ok(());
    };
    let Some(mut session) = state.sessions.load(&target_user, target_session).await? else {
        return Ok(());
    };
    session.set_status(SessionStatus::WaitingForUser);
    session.pending_question = None;
    session.pending_permission_request = None;
    if let Some(thread_id) = info.metadata.get("codex_thread_id").and_then(Value::as_str) {
        session.codex_thread_id = Some(thread_id.to_string());
    }
    let body = if let Some(reason) = request.reason.as_deref() {
        format!(
            "已向请求方请求补充信息：\n\n{}\n\n原因：{}",
            request.question, reason
        )
    } else {
        format!("已向请求方请求补充信息：\n\n{}", request.question)
    };
    session.messages.push(json!({
        "role": "assistant",
        "content": [{"type": "text", "text": body}],
        "created_at": now_iso(),
        "metadata": {
            "agent_delegation_id": record.get("delegation_id").and_then(Value::as_str),
            "delegation_event_type": "clarification_request",
            "target_job_id": info.job_id,
            "target_status": info.status
        }
    }));
    session.message_count = session.messages.len();
    session.last_active = now_iso();
    state.sessions.save_record_if_exists(session).await?;
    Ok(())
}

async fn append_clarification_to_requester_session(
    state: &AppState,
    record: &Value,
    info: &AgentRunInfo,
    request: &DelegationClarificationRequest,
    event: &Value,
) -> Result<(), ApiError> {
    let delegation_id = required_record_str(record, "delegation_id")?.to_string();
    let requester = requester_user_id(record)?.to_string();
    let requester_session = requester_session_id(record)?.to_string();
    let target = target_user_id(record)?.to_string();
    let Some(mut session) = state.sessions.load(&requester, &requester_session).await? else {
        return Ok(());
    };
    let title = delegation_title(record);
    let body = if let Some(reason) = request.reason.as_deref() {
        format!(
            "来自 {target} 的委托任务「{title}」需要你补充信息：\n\n{}\n\n原因：{}",
            request.question, reason
        )
    } else {
        format!(
            "来自 {target} 的委托任务「{title}」需要你补充信息：\n\n{}",
            request.question
        )
    };
    session.set_status(SessionStatus::AwaitingUserInput);
    session.pending_question = Some(request.question.clone());
    session.pending_control_request = Some(json!({
        "type": "agent_delegation_clarification",
        "delegation_id": delegation_id.clone(),
        "target_user_id": target.clone(),
        "target_job_id": info.job_id,
        "question": request.question.clone(),
        "reason": request.reason.clone(),
        "answer_endpoint": format!("/v1/agent-delegations/{delegation_id}/answer"),
        "event": event
    }));
    session.messages.push(json!({
        "role": "assistant",
        "content": [{"type": "text", "text": body}],
        "created_at": now_iso(),
        "metadata": {
            "agent_delegation_id": delegation_id,
            "delegation_event_type": "clarification_request",
            "target_user_id": target,
            "target_job_id": info.job_id,
            "target_status": info.status
        }
    }));
    session.message_count = session.messages.len();
    session.last_active = now_iso();
    state.sessions.save_record_if_exists(session).await?;
    Ok(())
}

async fn append_followup_to_target_session(
    state: &AppState,
    record: &Value,
    target_session_id: &str,
    followup_prompt: &str,
) -> Result<(), ApiError> {
    let target_user = target_user_id(record)?.to_string();
    let Some(mut session) = state.sessions.load(&target_user, target_session_id).await? else {
        return Err(ApiError::not_found("Target session not found"));
    };
    session.set_status(SessionStatus::Queued);
    session.pending_question = None;
    session.pending_permission_request = None;
    session.messages.push(json!({
        "role": "user",
        "content": followup_prompt,
        "created_at": now_iso(),
        "metadata": {
            "agent_delegation_id": record.get("delegation_id").and_then(Value::as_str),
            "delegation_event_type": "clarification_answer"
        }
    }));
    session.message_count = session.messages.len();
    session.last_active = now_iso();
    state.sessions.save_record_if_exists(session).await?;
    Ok(())
}

async fn append_answer_to_requester_session(
    state: &AppState,
    record: &Value,
    answer: &str,
    info: &AgentRunInfo,
) -> Result<(), ApiError> {
    let requester = requester_user_id(record)?.to_string();
    let requester_session = requester_session_id(record)?.to_string();
    let target = target_user_id(record)?.to_string();
    let Some(mut session) = state.sessions.load(&requester, &requester_session).await? else {
        return Ok(());
    };
    session.set_status(SessionStatus::Idle);
    session.pending_question = None;
    session.pending_control_request = None;
    let title = delegation_title(record);
    session.messages.push(json!({
        "role": "user",
        "content": [{"type": "text", "text": format!("回复 {target} 的委托任务「{title}」：\n\n{}", answer.trim())}],
        "created_at": now_iso(),
        "metadata": {
            "agent_delegation_id": record.get("delegation_id").and_then(Value::as_str),
            "delegation_event_type": "clarification_answer",
            "target_user_id": target,
            "target_job_id": info.job_id
        }
    }));
    session.message_count = session.messages.len();
    session.last_active = now_iso();
    state.sessions.save_record_if_exists(session).await?;
    Ok(())
}

async fn update_target_session_after_run(
    state: &AppState,
    record: &Value,
    info: &AgentRunInfo,
    output: &str,
) -> Result<(), ApiError> {
    let target_user = target_user_id(record)?.to_string();
    let Some(target_session) = record.get("target_session_id").and_then(Value::as_str) else {
        return Ok(());
    };
    let Some(mut session) = state.sessions.load(&target_user, target_session).await? else {
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
        format!("委托任务已结束，状态：{}。", info.status)
    } else {
        output.trim().to_string()
    };
    session.messages.push(json!({
        "role": "assistant",
        "content": [{"type": "text", "text": body}],
        "created_at": now_iso(),
        "metadata": {
            "agent_delegation_id": record.get("delegation_id").and_then(Value::as_str),
            "target_job_id": info.job_id,
            "target_status": info.status
        }
    }));
    session.message_count = session.messages.len();
    session.last_active = now_iso();
    state.sessions.save_record_if_exists(session).await?;
    Ok(())
}

async fn append_result_to_requester_session(
    state: &AppState,
    record: &Value,
    info: &AgentRunInfo,
    output: &str,
) -> Result<(), ApiError> {
    let requester = requester_user_id(record)?.to_string();
    let requester_session = requester_session_id(record)?.to_string();
    let target = target_user_id(record)?.to_string();
    let Some(mut session) = state.sessions.load(&requester, &requester_session).await? else {
        return Ok(());
    };
    let title = delegation_title(record);
    let body = if output.trim().is_empty() {
        format!(
            "来自 {target} 的委托任务「{title}」已结束，状态：{}。",
            info.status
        )
    } else {
        format!(
            "来自 {target} 的委托任务「{title}」已完成，结果如下：\n\n{}",
            output.trim()
        )
    };
    session.messages.push(json!({
        "role": "assistant",
        "content": [{"type": "text", "text": body}],
        "created_at": now_iso(),
        "metadata": {
            "agent_delegation_id": record.get("delegation_id").and_then(Value::as_str),
            "target_user_id": target,
            "target_job_id": info.job_id,
            "target_status": info.status
        }
    }));
    session.message_count = session.messages.len();
    session.last_active = now_iso();
    state.sessions.save_record_if_exists(session).await?;
    Ok(())
}

async fn read_run_output(state: &AppState, record: &Value, info: &AgentRunInfo) -> String {
    let Ok(target_user) = target_user_id(record) else {
        return String::new();
    };
    let Some(output_file) = info.output_file.as_deref() else {
        return String::new();
    };
    match tokio::fs::read_to_string(output_file).await {
        Ok(text) => sanitize_user_visible_text(state, target_user, &text),
        Err(_) => String::new(),
    }
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_clarification_request_marker() {
        let output = r#"
I need one more thing.
<ripple_delegation_request>{"type":"clarification_request","target":"requester","question":"Which customer segment should I use?","reason":"The brief references two segments."}</ripple_delegation_request>
"#;

        let request =
            parse_delegation_clarification_request(output).expect("clarification request");

        assert_eq!(request.question, "Which customer segment should I use?");
        assert_eq!(
            request.reason.as_deref(),
            Some("The brief references two segments.")
        );
    }

    #[test]
    fn ignores_non_clarification_output() {
        let output = "Task completed. Here is the final answer.";

        assert!(parse_delegation_clarification_request(output).is_none());
    }
}
