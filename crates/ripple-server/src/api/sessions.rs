use std::collections::HashMap;
use std::path::{Path as FsPath, PathBuf};

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};

use crate::api::chat::{collect_chat_image_events, image_event_to_message_block};
use crate::api::run_public::sanitize_user_visible_text;
use crate::api::users::{assert_can_create_run, assert_can_create_session};
use crate::api::{connectors, paginate, ApiError, ListQuery};
use crate::jobs::AgentRunInfo;
use crate::sessions::{CreateSessionInput, SessionDetail, SessionRecord, SessionStatus};
use crate::state::AppState;
use crate::user::user_id_from_headers;

const MAX_SESSION_TITLE_CHARS: usize = 120;

#[derive(Debug, Deserialize)]
pub struct UpdateSessionInput {
    pub title: Option<String>,
    pub pinned: Option<bool>,
    pub model: Option<String>,
    #[serde(default, deserialize_with = "deserialize_nullable_field")]
    pub context_folder_path: Option<Option<String>>,
}

fn deserialize_nullable_field<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Serialize)]
struct SessionOverviewResponse {
    sessions: Vec<SessionOverviewItem>,
    sections: SessionOverviewSections,
    count: usize,
}

#[derive(Debug, Serialize)]
struct SessionOverviewSections {
    needs_input: Vec<String>,
    running: Vec<String>,
    pinned: Vec<String>,
    recent_sessions: Vec<String>,
}

#[derive(Debug, Serialize)]
struct SessionOverviewItem {
    session_id: String,
    title: String,
    pinned: bool,
    status: String,
    model: String,
    created_at: String,
    last_active: String,
    message_count: usize,
    changed_file_count: u32,
    pending_kind: Option<String>,
    pending_approval_count: u32,
    plan_progress: Option<Value>,
    current_step: Option<String>,
    last_run: Option<SessionOverviewRun>,
    last_message_preview: Option<String>,
}

#[derive(Debug, Serialize)]
struct SessionOverviewRun {
    job_id: String,
    status: String,
    updated_at: String,
    output_file: Option<String>,
    output_available: bool,
    error: Option<String>,
    prompt_preview: Option<String>,
}

pub async fn list_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let sessions = state.sessions.list_sessions(&user_id).await?;
    let total = sessions.len();
    let (sessions, next_cursor) = paginate(sessions, &query);
    Ok(Json(json!({
        "sessions": sessions,
        "count": sessions.len(),
        "total": total,
        "next_cursor": next_cursor
    })))
}

pub async fn session_overview(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let summaries = state.sessions.list_sessions(&user_id).await?;
    let runs_by_session = latest_runs_by_session(state.jobs.list_user(&user_id).await?);

    let mut items = Vec::new();
    for info in summaries {
        let Some(record) = state.sessions.load(&user_id, &info.session_id).await? else {
            continue;
        };
        let pending_kind = pending_kind(&record);
        let last_run = runs_by_session
            .get(&info.session_id)
            .map(|run| session_overview_run(&state, &user_id, run));
        let status = overview_status(&info.status, pending_kind.as_deref(), last_run.as_ref());
        items.push(SessionOverviewItem {
            session_id: info.session_id,
            title: info.title,
            pinned: info.pinned,
            status,
            model: info.model,
            created_at: info.created_at,
            last_active: info.last_active,
            message_count: info.message_count,
            changed_file_count: info.changed_file_count,
            pending_kind,
            pending_approval_count: info.pending_approval_count,
            plan_progress: record.plan_progress.clone(),
            current_step: current_plan_step(&record),
            last_run,
            last_message_preview: last_message_preview(&record.messages),
        });
    }

    Ok(Json(
        serde_json::to_value(SessionOverviewResponse {
            count: items.len(),
            sections: overview_sections(&items),
            sessions: items,
        })
        .unwrap_or_else(|_| json!({})),
    ))
}

pub async fn deprecated_tasks_api() -> Result<Json<Value>, ApiError> {
    Err(ApiError::new(
        StatusCode::GONE,
        "/v1/tasks has been removed. Use /v1/sessions instead.",
    ))
}

fn latest_runs_by_session(jobs: Vec<AgentRunInfo>) -> HashMap<String, AgentRunInfo> {
    let mut out = HashMap::<String, AgentRunInfo>::new();
    for job in jobs {
        let Some(session_id) = job
            .metadata
            .get("session_id")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            continue;
        };
        let should_replace = out
            .get(&session_id)
            .map_or(true, |existing| existing.updated_at < job.updated_at);
        if should_replace {
            out.insert(session_id, job);
        }
    }
    out
}

fn session_overview_run(state: &AppState, user_id: &str, run: &AgentRunInfo) -> SessionOverviewRun {
    SessionOverviewRun {
        job_id: run.job_id.clone(),
        status: run.status.clone(),
        updated_at: run.updated_at.clone(),
        output_file: None,
        output_available: run.output_file.is_some(),
        error: run
            .error
            .as_deref()
            .map(|value| sanitize_user_visible_text(state, user_id, value)),
        prompt_preview: run
            .prompt_preview
            .as_deref()
            .map(|value| sanitize_user_visible_text(state, user_id, value)),
    }
}

fn overview_sections(items: &[SessionOverviewItem]) -> SessionOverviewSections {
    SessionOverviewSections {
        needs_input: items
            .iter()
            .filter(|item| {
                item.pending_kind.is_some()
                    || matches!(
                        item.status.as_str(),
                        "waiting_for_user" | "waiting_for_approval"
                    )
            })
            .map(|item| item.session_id.clone())
            .collect(),
        running: items
            .iter()
            .filter(|item| matches!(item.status.as_str(), "queued" | "running" | "compacting"))
            .map(|item| item.session_id.clone())
            .collect(),
        pinned: items
            .iter()
            .filter(|item| item.pinned)
            .map(|item| item.session_id.clone())
            .collect(),
        recent_sessions: items.iter().map(|item| item.session_id.clone()).collect(),
    }
}

fn overview_status(
    session_status: &str,
    pending_kind: Option<&str>,
    last_run: Option<&SessionOverviewRun>,
) -> String {
    if pending_kind == Some("approval") {
        return "waiting_for_approval".to_string();
    }
    if pending_kind.is_some() {
        return "waiting_for_user".to_string();
    }
    if let Some(run) = last_run {
        if matches!(run.status.as_str(), "queued" | "running") {
            return run.status.clone();
        }
    }
    session_status.to_string()
}

fn pending_kind(record: &SessionRecord) -> Option<String> {
    if record.pending_permission_request.is_some() {
        Some("approval".to_string())
    } else if record.pending_question.is_some() {
        Some("question".to_string())
    } else if record.pending_connector_auth.is_some() {
        Some("connector_auth".to_string())
    } else if record.pending_schedule_request.is_some() {
        Some("schedule_request".to_string())
    } else {
        None
    }
}

fn current_plan_step(record: &SessionRecord) -> Option<String> {
    if let Some(current) = record
        .plan_progress
        .as_ref()
        .and_then(|progress| {
            progress
                .get("currentTask")
                .or_else(|| progress.get("current_task"))
        })
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(current.to_string());
    }

    record
        .plan_steps
        .iter()
        .find(|step| {
            matches!(
                step.get("status").and_then(Value::as_str),
                Some("in_progress") | Some("inProgress") | Some("running")
            )
        })
        .and_then(plan_step_title)
        .or_else(|| record.plan_steps.last().and_then(plan_step_title))
}

fn plan_step_title(step: &Value) -> Option<String> {
    step.get("subject")
        .or_else(|| step.get("step"))
        .or_else(|| step.get("title"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn last_message_preview(messages: &[Value]) -> Option<String> {
    messages
        .iter()
        .rev()
        .filter_map(|message| message.get("content"))
        .filter_map(message_content_preview)
        .map(|preview| truncate_preview(&preview, 180))
        .find(|preview| !preview.is_empty())
}

fn message_content_preview(content: &Value) -> Option<String> {
    match content {
        Value::String(text) => {
            let text = text.trim();
            if text.is_empty() {
                None
            } else {
                Some(text.to_string())
            }
        }
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(message_content_part_preview)
                .collect::<Vec<_>>()
                .join(" ");
            if text.trim().is_empty() {
                None
            } else {
                Some(text)
            }
        }
        _ => None,
    }
}

fn message_content_part_preview(item: &Value) -> Option<String> {
    if let Some(text) = item
        .get("text")
        .or_else(|| item.get("content"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(text.to_string());
    }
    match item.get("type").and_then(Value::as_str) {
        Some("image" | "input_image" | "image_url" | "localImage" | "local_image") => {
            Some("Image".to_string())
        }
        Some("file" | "attachment") => item
            .get("name")
            .and_then(Value::as_str)
            .map(|name| format!("Attachment: {name}"))
            .or_else(|| Some("Attachment".to_string())),
        _ => None,
    }
}

fn truncate_preview(value: &str, max_chars: usize) -> String {
    let mut out = value.chars().take(max_chars).collect::<String>();
    if value.chars().count() > max_chars {
        out.push_str("...");
    }
    out
}

pub async fn create_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateSessionInput>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    assert_can_create_session(&state, &user_id).await?;
    let session = state
        .sessions
        .create_session(&user_id, input)
        .await
        .map_err(|err| ApiError::bad_request(err.to_string()))?;
    let detail = state
        .sessions
        .get_session(&user_id, &session.session_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Session not found"))?;
    Ok(Json(
        serde_json::to_value(detail.info).unwrap_or_else(|_| json!({})),
    ))
}

pub async fn get_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let _ = state
        .sessions
        .recover_stale_context_compaction(&user_id, &session_id)
        .await?;
    if state
        .sessions
        .load(&user_id, &session_id)
        .await?
        .is_some_and(|record| record.status_kind() == SessionStatus::Suspended)
    {
        let _ = state.sessions.resume_session(&user_id, &session_id).await?;
    }
    let Some(mut session) = state.sessions.get_session(&user_id, &session_id).await? else {
        return Err(ApiError::not_found("Session not found"));
    };
    backfill_generated_images_from_runs(&state, &user_id, &session_id, &mut session).await?;
    Ok(Json(
        serde_json::to_value(session).unwrap_or_else(|_| json!({})),
    ))
}

async fn backfill_generated_images_from_runs(
    state: &AppState,
    user_id: &str,
    session_id: &str,
    detail: &mut SessionDetail,
) -> Result<(), ApiError> {
    let Ok(workspace_root) = state.sandboxes.workspace_dir(user_id) else {
        return Ok(());
    };
    let mut jobs = state
        .jobs
        .list_user(user_id)
        .await?
        .into_iter()
        .filter(|job| {
            job.status == "completed"
                && job_belongs_to_session(job, session_id)
                && job
                    .metadata
                    .get("chat_user_input")
                    .and_then(Value::as_str)
                    .is_some()
        })
        .collect::<Vec<_>>();
    jobs.sort_by(|left, right| left.updated_at.cmp(&right.updated_at));

    for job in jobs {
        let blocks = collect_chat_image_events(state, user_id, &job, &workspace_root)
            .await
            .into_iter()
            .filter_map(|event| image_event_to_message_block(&event))
            .collect::<Vec<_>>();
        append_image_blocks_to_session_detail(&mut detail.messages, &job.updated_at, blocks);
    }
    Ok(())
}

fn job_belongs_to_session(job: &AgentRunInfo, session_id: &str) -> bool {
    if job.metadata.get("session_id").and_then(Value::as_str) == Some(session_id) {
        return true;
    }
    job.events_file
        .as_deref()
        .is_some_and(|path| path_has_session_component(path, session_id))
        || job
            .output_file
            .as_deref()
            .is_some_and(|path| path_has_session_component(path, session_id))
}

fn path_has_session_component(path: &str, session_id: &str) -> bool {
    let components = std::path::Path::new(path)
        .components()
        .filter_map(|component| component.as_os_str().to_str());
    let mut previous_was_sessions = false;
    for component in components {
        if previous_was_sessions && component == session_id {
            return true;
        }
        previous_was_sessions = component == "sessions";
    }
    false
}

fn append_image_blocks_to_session_detail(
    messages: &mut [Value],
    job_updated_at: &str,
    image_blocks: Vec<Value>,
) {
    if image_blocks.is_empty() {
        return;
    }

    let target_index = messages
        .iter()
        .enumerate()
        .filter(|(_, message)| message.get("role").and_then(Value::as_str) == Some("assistant"))
        .find(|(_, message)| {
            message
                .get("created_at")
                .and_then(Value::as_str)
                .is_some_and(|created_at| created_at >= job_updated_at)
        })
        .map(|(index, _)| index)
        .or_else(|| {
            messages
                .iter()
                .enumerate()
                .rev()
                .find(|(_, message)| {
                    message.get("role").and_then(Value::as_str) == Some("assistant")
                })
                .map(|(index, _)| index)
        });

    let Some(target_index) = target_index else {
        return;
    };

    let mut existing_paths = messages
        .iter()
        .filter_map(|message| message.get("content").and_then(Value::as_array))
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("image"))
        .filter_map(|item| item.get("workspace_path").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<std::collections::HashSet<_>>();

    let Some(content) = messages[target_index]
        .get_mut("content")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for block in image_blocks {
        let Some(workspace_path) = block.get("workspace_path").and_then(Value::as_str) else {
            continue;
        };
        if existing_paths.insert(workspace_path.to_string()) {
            content.push(block);
        }
    }
}

pub async fn update_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(input): Json<UpdateSessionInput>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let title = input
        .title
        .map(|title| {
            let title = title.trim().to_string();
            if title.is_empty() {
                return Err(ApiError::bad_request("Session name cannot be empty"));
            }
            if title.chars().count() > MAX_SESSION_TITLE_CHARS {
                return Err(ApiError::bad_request("Session name is too long"));
            }
            Ok(title)
        })
        .transpose()?;
    let model = input
        .model
        .map(|model| {
            let model = model.trim().to_string();
            if model.is_empty() {
                return Err(ApiError::bad_request("Session model cannot be empty"));
            }
            Ok(model)
        })
        .transpose()?;

    let Some(info) = state
        .sessions
        .update_session_metadata(
            &user_id,
            &session_id,
            title,
            input.pinned,
            input.context_folder_path,
            model,
        )
        .await?
    else {
        return Err(ApiError::not_found("Session not found"));
    };

    Ok(Json(
        serde_json::to_value(info).unwrap_or_else(|_| json!({})),
    ))
}

pub async fn delete_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let session_run_lock = state.sessions.session_lock(&user_id, &session_id);
    let _session_run_guard = session_run_lock.lock_owned().await;
    let stopped = state
        .jobs
        .cancel_session_run(&user_id, &session_id)
        .await?
        .is_some();
    if state.sessions.delete_session(&user_id, &session_id).await? {
        Ok(Json(json!({ "ok": true, "stopped": stopped })))
    } else {
        Err(ApiError::not_found("Session not found"))
    }
}

pub async fn clear_session_context(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let _ = state
        .sessions
        .recover_stale_context_compaction(&user_id, &session_id)
        .await?;
    let Some(session) = state.sessions.load(&user_id, &session_id).await? else {
        return Err(ApiError::not_found("Session not found"));
    };
    if session.status_kind().is_busy() {
        return Err(ApiError::conflict("Session is currently running"));
    }
    let Some(message_count) = state.sessions.clear_context(&user_id, &session_id).await? else {
        return Err(ApiError::not_found("Session not found"));
    };
    Ok(Json(
        json!({ "ok": true, "session_id": session_id, "message_count": message_count }),
    ))
}

pub async fn compact_session_context(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let lock = state.sessions.session_lock(&user_id, &session_id);
    let guard = lock.lock_owned().await;
    let _ = state
        .sessions
        .recover_context_compaction_after_lock(&user_id, &session_id)
        .await?;
    let Some(session) = state.sessions.load(&user_id, &session_id).await? else {
        return Err(ApiError::not_found("Session not found"));
    };
    if session.status_kind().is_busy() {
        return Err(ApiError::conflict("Session is currently running"));
    }
    if session
        .codex_thread_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return Err(ApiError::conflict("Session has no Codex thread to compact"));
    }

    assert_can_create_run(&state, &user_id, state.config.codex.max_runtime_seconds).await?;
    let workspace_root = state.sandboxes.ensure_sandbox(&user_id)?;
    let compact_cwd = session_cwd_for_context_folder(&workspace_root, &session);
    let Some(codex_thread_id) = state
        .sessions
        .begin_context_compaction(&user_id, &session_id)
        .await?
    else {
        return Err(ApiError::not_found("Session not found"));
    };
    let response_thread_id = codex_thread_id.clone();

    let jobs = state.jobs.clone();
    let sessions = state.sessions.clone();
    let compact_user_id = user_id.clone();
    let compact_session_id = session_id.clone();
    let max_runtime_seconds = state.config.codex.max_runtime_seconds;
    tokio::spawn(async move {
        let _guard = guard;
        let result = jobs
            .compact_thread(
                compact_user_id.clone(),
                workspace_root,
                compact_cwd,
                codex_thread_id,
                max_runtime_seconds,
            )
            .await;
        let _ = sessions
            .finish_context_compaction(&compact_user_id, &compact_session_id, result.is_ok())
            .await;
    });

    Ok(Json(json!({
        "ok": true,
        "session_id": session_id,
        "codex_thread_id": response_thread_id,
        "status": "compacting"
    })))
}

fn session_cwd_for_context_folder(workspace_root: &FsPath, session: &SessionRecord) -> PathBuf {
    let Some(context_folder_path) = session
        .context_folder_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return workspace_root.to_path_buf();
    };
    if context_folder_path == "/workspace" {
        return workspace_root.to_path_buf();
    }
    if let Some(relative) = context_folder_path.strip_prefix("/workspace/") {
        return workspace_root.join(relative);
    }
    workspace_root.to_path_buf()
}

pub async fn get_session_codex_thread(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let _ = state
        .sessions
        .recover_stale_context_compaction(&user_id, &session_id)
        .await?;
    let Some(session) = state.sessions.load(&user_id, &session_id).await? else {
        return Err(ApiError::not_found("Session not found"));
    };
    if session.status_kind().is_busy() {
        return Err(ApiError::conflict("Session is currently running"));
    }
    let Some(codex_thread_id) = session
        .codex_thread_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
    else {
        return Err(ApiError::conflict("Session has no Codex thread"));
    };
    let workspace_root = state.sandboxes.ensure_sandbox(&user_id)?;
    let thread = state
        .jobs
        .read_thread(user_id, workspace_root, codex_thread_id.clone())
        .await
        .map_err(|err| ApiError::bad_request(err.to_string()))?;

    Ok(Json(json!({
        "ok": true,
        "session_id": session_id,
        "codex_thread_id": codex_thread_id,
        "thread": thread.get("thread").cloned().unwrap_or(Value::Null)
    })))
}

pub async fn stop_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let _ = state
        .sessions
        .recover_stale_context_compaction(&user_id, &session_id)
        .await?;
    let Some(mut session) = state.sessions.load(&user_id, &session_id).await? else {
        return Err(ApiError::not_found("Session not found"));
    };
    let connector_auth_cancelled = pending_connector_auth_name(&session);
    let stopped = state.jobs.cancel_session_run(&user_id, &session_id).await?;
    if let Some(info) = stopped {
        session.set_status(SessionStatus::Cancelled);
        clear_pending_waits(&mut session, true);
        state.sessions.save_record(session).await?;
        cancel_connector_runtime_if_needed(&state, &user_id, connector_auth_cancelled.as_deref())
            .await;
        Ok(Json(json!({
            "ok": true,
            "session_id": session_id,
            "stopped": true,
            "job_id": info.job_id,
            "status": info.status,
            "connector_auth_cancelled": connector_auth_cancelled.is_some(),
            "connector": connector_auth_cancelled
        })))
    } else if session.status_kind().is_active_run() || connector_auth_cancelled.is_some() {
        session.set_status(SessionStatus::Cancelled);
        clear_pending_waits(&mut session, true);
        state.sessions.save_record(session).await?;
        cancel_connector_runtime_if_needed(&state, &user_id, connector_auth_cancelled.as_deref())
            .await;
        Ok(Json(json!({
            "ok": true,
            "session_id": session_id,
            "stopped": false,
            "status": "cancelled",
            "connector_auth_cancelled": connector_auth_cancelled.is_some(),
            "connector": connector_auth_cancelled
        })))
    } else {
        Ok(Json(json!({
            "ok": true,
            "session_id": session_id,
            "stopped": false,
            "connector_auth_cancelled": false
        })))
    }
}

pub async fn cancel_connector_auth(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let Some(mut session) = state.sessions.load(&user_id, &session_id).await? else {
        return Err(ApiError::not_found("Session not found"));
    };
    let connector = pending_connector_auth_name(&session);
    if connector.is_some() {
        session.set_status(SessionStatus::Cancelled);
        clear_pending_waits(&mut session, true);
        state.sessions.save_record(session).await?;
        cancel_connector_runtime_if_needed(&state, &user_id, connector.as_deref()).await;
    }
    Ok(Json(json!({
        "ok": true,
        "session_id": session_id,
        "connector_auth_cancelled": connector.is_some(),
        "connector": connector
    })))
}

fn pending_connector_auth_name(session: &SessionRecord) -> Option<String> {
    session
        .pending_connector_auth
        .as_ref()
        .and_then(|pending| pending.get("connector"))
        .and_then(Value::as_str)
        .filter(|connector| !connector.trim().is_empty())
        .map(ToString::to_string)
}

fn clear_pending_waits(session: &mut SessionRecord, include_connector_auth: bool) {
    session.pending_permission_request = None;
    session.pending_question = None;
    session.pending_options = None;
    if include_connector_auth {
        session.pending_connector_auth = None;
    }
}

async fn cancel_connector_runtime_if_needed(
    state: &AppState,
    user_id: &str,
    connector: Option<&str>,
) {
    if connector == Some("feishu") {
        connectors::cancel_feishu_setup(state, user_id).await;
    }
}

pub async fn suspend_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let _ = state.jobs.cancel_session_run(&user_id, &session_id).await?;
    let Some(record) = state
        .sessions
        .suspend_session(&user_id, &session_id)
        .await?
    else {
        return Err(ApiError::not_found(
            "Session not found or already suspended",
        ));
    };
    Ok(Json(json!({
        "ok": true,
        "session_id": record.session_id,
        "status": "suspended"
    })))
}

pub async fn resume_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let Some(record) = state.sessions.resume_session(&user_id, &session_id).await? else {
        return Err(ApiError::not_found("Suspended session not found"));
    };
    let detail = state
        .sessions
        .get_session(&user_id, &record.session_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Session not found"))?;
    Ok(Json(
        serde_json::to_value(detail.info).unwrap_or_else(|_| json!({})),
    ))
}

pub async fn list_suspended_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let sessions = state.sessions.list_suspended_sessions(&user_id).await?;
    Ok(Json(
        json!({ "sessions": sessions, "count": sessions.len() }),
    ))
}

#[derive(Debug, Deserialize)]
pub struct PermissionResolveInput {
    action: String,
    #[serde(default)]
    job_id: Option<String>,
    #[serde(default)]
    request_id: Option<Value>,
}

pub async fn resolve_permission_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(input): Json<PermissionResolveInput>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let Some(mut session) = state.sessions.load(&user_id, &session_id).await? else {
        return Err(ApiError::not_found("Session not found"));
    };
    let pending = session
        .pending_permission_request
        .clone()
        .ok_or_else(|| ApiError::conflict("No pending permission request"))?;
    let job_id = input
        .job_id
        .or_else(|| {
            pending
                .get("job_id")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .ok_or_else(|| ApiError::bad_request("Pending permission request is missing job_id"))?;
    let request_id = input
        .request_id
        .or_else(|| pending.get("request_id").cloned())
        .ok_or_else(|| ApiError::bad_request("Pending permission request is missing request_id"))?;
    let resolved = state
        .jobs
        .resolve_approval_for_user(&job_id, &user_id, &request_id, &input.action)
        .await
        .map_err(|err| ApiError::bad_request(err.to_string()))?;
    if !resolved {
        return Err(ApiError::conflict(
            "Pending permission request is no longer active",
        ));
    }
    session.pending_permission_request = None;
    session.set_status(SessionStatus::Running);
    state.sessions.save_record(session).await?;
    tokio::spawn(finalize_resolved_permission_session(
        state.clone(),
        user_id.clone(),
        session_id.clone(),
        job_id.clone(),
    ));
    Ok(Json(json!({
        "ok": true,
        "session_id": session_id,
        "job_id": job_id,
        "action": input.action
    })))
}

async fn finalize_resolved_permission_session(
    state: AppState,
    user_id: String,
    session_id: String,
    job_id: String,
) {
    let deadline = tokio::time::Instant::now()
        + std::time::Duration::from_secs(state.config.codex.max_runtime_seconds.max(1) + 5);
    loop {
        let info = state
            .jobs
            .info_for_user(&job_id, &user_id)
            .await
            .ok()
            .flatten();
        if let Some(info) = info {
            if matches!(info.status.as_str(), "completed" | "failed" | "cancelled") {
                if let Ok(Some(mut session)) = state.sessions.load(&user_id, &session_id).await {
                    if session.pending_permission_request.is_none()
                        && (session.status_kind() == SessionStatus::Running
                            || session.status_kind().is_awaiting_approval())
                    {
                        session.status = match info.status.as_str() {
                            "completed" => SessionStatus::Idle.as_str(),
                            "cancelled" => SessionStatus::Cancelled.as_str(),
                            _ => SessionStatus::Failed.as_str(),
                        }
                        .to_string();
                        let _ = state.sessions.save_record_if_exists(session).await;
                    }
                }
                return;
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

pub async fn session_usage(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let Some(session) = state.sessions.load(&user_id, &session_id).await? else {
        return Err(ApiError::not_found("Session not found"));
    };
    Ok(Json(json!({
        "session_id": session_id,
        "total_input_tokens": session.total_input_tokens,
        "total_output_tokens": session.total_output_tokens,
        "total_tokens": session.total_input_tokens.saturating_add(session.total_output_tokens),
        "last_input_tokens": session.last_input_tokens,
        "message_count": session.messages.len()
    })))
}

pub async fn disable_session_memory(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let Some(existing) = state.sessions.load(&user_id, &session_id).await? else {
        return Err(ApiError::not_found("Session not found"));
    };
    if existing.status_kind().is_busy() {
        return Err(ApiError::conflict("Session is currently running"));
    }
    let session = state
        .sessions
        .disable_session_memory(&user_id, &session_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Session not found"))?;
    let mut codex_thread_memory_mode = "skipped_no_thread";
    if let Some(thread_id) = session
        .codex_thread_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
    {
        let workspace_root = state.sandboxes.ensure_sandbox(&user_id)?;
        state
            .jobs
            .disable_thread_memory(user_id.clone(), workspace_root, thread_id.clone())
            .await
            .map_err(|err| ApiError::new(StatusCode::BAD_GATEWAY, err.to_string()))?;
        codex_thread_memory_mode = "disabled";
    }
    Ok(Json(json!({
        "ok": true,
        "session_id": session_id,
        "memory_disabled": true,
        "codex_thread_memory_mode": codex_thread_memory_mode
    })))
}
