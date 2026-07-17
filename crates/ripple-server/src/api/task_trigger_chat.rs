use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use time::format_description::well_known::Rfc3339;
use time::{Duration as TimeDuration, OffsetDateTime, Time, UtcOffset};
use tokio::time::{sleep, Duration, Instant};

use crate::api::task_triggers::TaskTriggerCreateInput;
use crate::api::tasks::create_task_from_payload;
use crate::api::users::assert_can_create_run;
use crate::api::ApiError;
use crate::jobs::{AgentRunCreateRequest, AgentRunInfo};
use crate::sessions::SessionRecord;
use crate::state::AppState;

const TERMINAL_STATUSES: &[&str] = &["completed", "failed", "cancelled"];
const CONFIRM_WORDS: &[&str] = &[
    "y",
    "yes",
    "ok",
    "okay",
    "confirm",
    "create",
    "确认",
    "确定",
    "创建",
    "确认创建",
    "可以",
    "好的",
    "好",
    "同意",
];
const CANCEL_WORDS: &[&str] = &[
    "n",
    "no",
    "cancel",
    "stop",
    "取消",
    "放弃",
    "不要",
    "不用",
    "先不要",
];
const TRIGGER_DETAILS_MISSING_FIELD: &str = "trigger_details";

#[derive(Debug)]
pub(crate) struct TaskTriggerChatDecision {
    pub(crate) event: Value,
    pub(crate) status: String,
    pub(crate) clear_pending_control_request: bool,
    pub(crate) pending_control_request: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct TaskTriggerPhaseDraft {
    title: Option<String>,
    prompt: Option<String>,
    max_runs: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct TaskTriggerDraft {
    title: Option<String>,
    prompt: Option<String>,
    kind: Option<String>,
    timezone: Option<String>,
    run_at: Option<String>,
    interval_seconds: Option<u64>,
    enabled: Option<bool>,
    cwd: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    summary: Option<String>,
    output_schema: Option<Value>,
    max_runtime_seconds: Option<u64>,
    max_runs: Option<u64>,
    #[serde(default)]
    phases: Vec<TaskTriggerPhaseDraft>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TaskTriggerExtractionResult {
    is_task_trigger_request: bool,
    #[serde(default)]
    missing_fields: Vec<String>,
    clarification_question: Option<String>,
    task_trigger: Option<TaskTriggerDraft>,
}

enum TaskTriggerExtractionError {
    Api(ApiError),
    Invalid,
    Runtime,
}

#[derive(Debug, PartialEq, Eq)]
enum PendingTaskTriggerState {
    Draft,
    Confirmation,
}

fn pending_task_trigger_state(pending: &Value) -> Option<PendingTaskTriggerState> {
    match pending.get("type").and_then(Value::as_str) {
        Some("task_trigger_draft") => Some(PendingTaskTriggerState::Draft),
        Some(_) => None,
        None => Some(PendingTaskTriggerState::Confirmation),
    }
}

pub(crate) async fn maybe_handle_task_trigger_chat(
    state: &AppState,
    user_id: &str,
    session: &SessionRecord,
    workspace_root: PathBuf,
    user_input: &str,
    model: &str,
    effort: Option<String>,
) -> Result<Option<TaskTriggerChatDecision>, ApiError> {
    if let Some(pending) = session
        .pending_control_request
        .as_ref()
        .filter(|value| value.is_object())
    {
        return match pending_task_trigger_state(pending) {
            Some(PendingTaskTriggerState::Draft) => {
                handle_pending_task_trigger_draft(
                    state,
                    user_id,
                    session,
                    workspace_root,
                    pending,
                    user_input,
                    model,
                    effort,
                )
                .await
            }
            Some(PendingTaskTriggerState::Confirmation) => {
                handle_pending_task_trigger_confirmation(
                    state, user_id, session, pending, user_input,
                )
                .await
            }
            None => Ok(None),
        };
    }

    if !is_task_trigger_intent(user_input) {
        return Ok(None);
    }

    let extraction = match extract_task_trigger_with_codex(
        state,
        user_id,
        session,
        workspace_root,
        user_input,
        model,
        effort,
    )
    .await
    {
        Ok(extraction) => extraction,
        Err(TaskTriggerExtractionError::Invalid) => {
            return Ok(Some(idle_decision(task_trigger_extraction_failed_event(
                "任务触发器解析结果不合法，不是你的描述问题。请稍后重试。",
            ))));
        }
        Err(TaskTriggerExtractionError::Api(err)) => return Err(err),
        Err(TaskTriggerExtractionError::Runtime) => {
            return Ok(Some(idle_decision(task_trigger_extraction_failed_event(
                "任务触发器解析服务失败，不是你的描述问题。请稍后重试。",
            ))));
        }
    };

    if !extraction.is_task_trigger_request {
        return Ok(None);
    }

    if let Some(clarification) = task_trigger_extraction_clarification(&extraction) {
        return Ok(Some(awaiting_decision(
            task_trigger_clarification_event(&clarification),
            Some(task_trigger_draft_pending_value(
                user_input,
                &extraction,
                &clarification,
            )),
        )));
    }

    let proposal = match task_trigger_proposal_from_extraction(&extraction) {
        Ok(Some(proposal)) => proposal,
        Ok(None) => return Ok(None),
        Err(_) => {
            return Ok(Some(awaiting_decision(
                task_trigger_clarification_event(
                    "这个任务触发器还缺少有效的时间或执行内容，请补充后我再创建。",
                ),
                Some(task_trigger_draft_pending_value(
                    user_input,
                    &extraction,
                    "这个任务触发器还缺少有效的时间或执行内容，请补充后我再创建。",
                )),
            )));
        }
    };

    if let Some(clarification) = task_trigger_detail_clarification(&proposal.payload) {
        return Ok(Some(awaiting_decision(
            task_trigger_clarification_event(&clarification),
            Some(task_trigger_detail_pending_value(
                user_input,
                &proposal.payload,
                &clarification,
            )),
        )));
    }

    Ok(Some(awaiting_decision(
        task_trigger_proposal_event(&proposal),
        Some(proposal.payload),
    )))
}

async fn handle_pending_task_trigger_draft(
    state: &AppState,
    user_id: &str,
    session: &SessionRecord,
    workspace_root: PathBuf,
    pending: &Value,
    user_input: &str,
    model: &str,
    effort: Option<String>,
) -> Result<Option<TaskTriggerChatDecision>, ApiError> {
    if is_task_trigger_cancellation(user_input) {
        return Ok(Some(TaskTriggerChatDecision {
            event: task_trigger_cancelled_event("已取消创建这个任务触发器。"),
            status: "idle".to_string(),
            clear_pending_control_request: true,
            pending_control_request: None,
        }));
    }

    if is_task_trigger_confirmation(user_input) {
        return Ok(Some(awaiting_decision(
            task_trigger_clarification_event(
                pending
                    .get("clarification_question")
                    .and_then(Value::as_str)
                    .unwrap_or("这个任务触发器还缺少信息，请先补充。"),
            ),
            Some(pending.clone()),
        )));
    }

    let combined = combine_task_trigger_draft_followup(pending, user_input);
    let extraction = match extract_task_trigger_with_codex(
        state,
        user_id,
        session,
        workspace_root,
        &combined,
        model,
        effort,
    )
    .await
    {
        Ok(extraction) => extraction,
        Err(TaskTriggerExtractionError::Invalid) => {
            return Ok(Some(idle_decision(task_trigger_extraction_failed_event(
                "任务触发器解析结果不合法，不是你的描述问题。请稍后重试。",
            ))));
        }
        Err(TaskTriggerExtractionError::Api(err)) => return Err(err),
        Err(TaskTriggerExtractionError::Runtime) => {
            return Ok(Some(idle_decision(task_trigger_extraction_failed_event(
                "任务触发器解析服务失败，不是你的描述问题。请稍后重试。",
            ))));
        }
    };

    if !extraction.is_task_trigger_request {
        return Ok(None);
    }

    if let Some(clarification) = task_trigger_extraction_clarification(&extraction) {
        return Ok(Some(awaiting_decision(
            task_trigger_clarification_event(&clarification),
            Some(task_trigger_draft_pending_value(
                pending
                    .get("original_user_input")
                    .and_then(Value::as_str)
                    .unwrap_or(user_input),
                &extraction,
                &clarification,
            )),
        )));
    }

    let proposal = match task_trigger_proposal_from_extraction(&extraction) {
        Ok(Some(proposal)) => proposal,
        Ok(None) => return Ok(None),
        Err(_) => {
            let clarification = "这个任务触发器还缺少有效的时间或执行内容，请补充后我再创建。";
            return Ok(Some(awaiting_decision(
                task_trigger_clarification_event(clarification),
                Some(task_trigger_draft_pending_value(
                    pending
                        .get("original_user_input")
                        .and_then(Value::as_str)
                        .unwrap_or(user_input),
                    &extraction,
                    clarification,
                )),
            )));
        }
    };

    if !pending_requested_trigger_details(pending) {
        if let Some(clarification) = task_trigger_detail_clarification(&proposal.payload) {
            return Ok(Some(awaiting_decision(
                task_trigger_clarification_event(&clarification),
                Some(task_trigger_detail_pending_value(
                    pending
                        .get("original_user_input")
                        .and_then(Value::as_str)
                        .unwrap_or(user_input),
                    &proposal.payload,
                    &clarification,
                )),
            )));
        }
    }

    Ok(Some(awaiting_decision(
        task_trigger_proposal_event(&proposal),
        Some(proposal.payload),
    )))
}

async fn handle_pending_task_trigger_confirmation(
    state: &AppState,
    user_id: &str,
    session: &SessionRecord,
    pending: &Value,
    user_input: &str,
) -> Result<Option<TaskTriggerChatDecision>, ApiError> {
    if is_task_trigger_cancellation(user_input) {
        return Ok(Some(TaskTriggerChatDecision {
            event: task_trigger_cancelled_event(&build_task_trigger_cancelled_message(Some(
                pending,
            ))),
            status: "idle".to_string(),
            clear_pending_control_request: true,
            pending_control_request: None,
        }));
    }

    if is_task_trigger_confirmation(user_input) {
        let input = serde_json::from_value::<TaskTriggerCreateInput>(pending.clone())
            .map_err(|err| ApiError::bad_request(err.to_string()))?;
        let (task, actions) =
            create_task_for_trigger_input(state, user_id, &session.session_id, input).await?;
        let trigger = task_trigger_for_task_action(state, user_id, &task, actions.first()).await?;
        let message = build_task_trigger_created_message(&task, trigger.as_ref());
        return Ok(Some(TaskTriggerChatDecision {
            event: task_created_event(task, trigger, &message),
            status: "idle".to_string(),
            clear_pending_control_request: true,
            pending_control_request: None,
        }));
    }

    Ok(Some(awaiting_decision(
        task_trigger_pending_event(
            &build_task_trigger_pending_message(pending),
            pending.clone(),
        ),
        None,
    )))
}

async fn create_task_for_trigger_input(
    state: &AppState,
    user_id: &str,
    session_id: &str,
    input: TaskTriggerCreateInput,
) -> Result<(Value, Vec<Value>), ApiError> {
    let task_payload = task_payload_from_trigger_input(input);
    create_task_from_payload(&state.storage, user_id, Some(session_id), &task_payload).await
}

fn task_payload_from_trigger_input(input: TaskTriggerCreateInput) -> Value {
    let title = input.title;
    let prompt = input.prompt;
    let trigger = json!({
        "title": title.clone(),
        "prompt": prompt.clone(),
        "trigger_type": input.trigger_type,
        "kind": input.kind,
        "timezone": input.timezone,
        "run_at": input.run_at,
        "interval_seconds": input.interval_seconds,
        "enabled": input.enabled,
        "cwd": input.cwd,
        "model": input.model,
        "effort": input.effort,
        "summary": input.summary,
        "output_schema": input.output_schema,
        "max_runtime_seconds": input.max_runtime_seconds,
        "max_runs": input.max_runs,
        "missed_run_policy": input.missed_run_policy,
        "overlap_policy": input.overlap_policy,
        "failure_policy": input.failure_policy
    });
    if input.phases.is_empty() {
        return json!({
            "title": title.clone(),
            "objective": prompt.clone(),
            "status": "active",
            "actions": [
                {
                    "title": title,
                    "objective": prompt,
                    "kind": "execute",
                    "status": "confirmed",
                    "trigger": trigger
                }
            ]
        });
    }

    let mut previous_action_id: Option<String> = None;
    let actions = input
        .phases
        .into_iter()
        .enumerate()
        .map(|(index, phase)| {
            let action_id = format!("act-phase-{}", index + 1);
            let mut action = json!({
                "action_id": action_id,
                "title": phase.title,
                "objective": phase.prompt,
                "kind": "execute",
                "status": "confirmed",
                "sequence_index": index + 1,
                "max_runs": phase.max_runs.unwrap_or(1).max(1),
                "run_count": 0
            });
            if let Some(previous) = previous_action_id.take() {
                if let Some(object) = action.as_object_mut() {
                    object.insert("depends_on_action_ids".to_string(), json!([previous]));
                }
            }
            previous_action_id = action
                .get("action_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            action
        })
        .collect::<Vec<_>>();

    json!({
        "title": title,
        "objective": prompt,
        "status": "active",
        "trigger": trigger,
        "actions": actions
    })
}

async fn task_trigger_for_task_action(
    state: &AppState,
    user_id: &str,
    task: &Value,
    action: Option<&Value>,
) -> Result<Option<Value>, ApiError> {
    let Some(task_id) = task.get("task_id").and_then(Value::as_str) else {
        return Ok(None);
    };
    let action_id = action
        .and_then(|action| action.get("action_id"))
        .and_then(Value::as_str);
    let triggers = state.storage.list_task_triggers(user_id).await?;
    let task_triggers = triggers
        .into_iter()
        .filter(|trigger| trigger.get("task_id").and_then(Value::as_str) == Some(task_id))
        .collect::<Vec<_>>();
    if let Some(action_id) = action_id {
        if let Some(trigger) = task_triggers.iter().find(|trigger| {
            trigger.get("task_action_id").and_then(Value::as_str) == Some(action_id)
        }) {
            return Ok(Some(trigger.clone()));
        }
    }
    Ok(task_triggers.into_iter().find(|trigger| {
        trigger
            .get("task_action_id")
            .and_then(Value::as_str)
            .is_none()
    }))
}

async fn extract_task_trigger_with_codex(
    state: &AppState,
    user_id: &str,
    session: &SessionRecord,
    workspace_root: PathBuf,
    user_input: &str,
    model: &str,
    effort: Option<String>,
) -> Result<TaskTriggerExtractionResult, TaskTriggerExtractionError> {
    let prompt = build_task_trigger_extraction_prompt(user_input);
    let max_runtime_seconds = state.config.task_trigger_extraction_max_runtime_seconds;
    let runtime_dir = state
        .sandboxes
        .session_dir(user_id, &session.session_id)
        .map_err(|_| TaskTriggerExtractionError::Runtime)?;
    assert_can_create_run(state, user_id, max_runtime_seconds)
        .await
        .map_err(TaskTriggerExtractionError::Api)?;
    let create = AgentRunCreateRequest {
        prompt: prompt.clone(),
        provider: "codex".to_string(),
        base_instructions: None,
        turn_context: None,
        client_context: None,
        cwd: Some("/workspace".to_string()),
        input_items: vec![json!({"type": "text", "text": prompt})],
        model: Some(model.to_string()),
        effort,
        summary: None,
        output_schema: Some(task_trigger_extraction_output_schema()),
        max_runtime_seconds,
        task_trigger_id: None,
        task_trigger_title: None,
        task_trigger_reason: None,
        codex_thread_id: None,
        codex_persistent_thread: false,
        client_request_id: None,
        chat_user_input: None,
        chat_user_content: None,
        task_response: false,
    };
    let info = state
        .jobs
        .start(
            create,
            user_id.to_string(),
            Some(session.session_id.clone()),
            workspace_root,
            runtime_dir.clone(),
        )
        .await
        .map_err(|_| TaskTriggerExtractionError::Runtime)?;
    let final_info =
        wait_for_task_trigger_extraction(state, user_id, &info.job_id, max_runtime_seconds)
            .await
            .map_err(|_| TaskTriggerExtractionError::Runtime)?;
    if final_info.status != "completed" {
        return Err(TaskTriggerExtractionError::Runtime);
    }
    parse_task_trigger_extraction_output(&read_run_output(&final_info).await)
        .map_err(|_| TaskTriggerExtractionError::Invalid)
}

async fn wait_for_task_trigger_extraction(
    state: &AppState,
    user_id: &str,
    job_id: &str,
    max_runtime_seconds: u64,
) -> Result<AgentRunInfo, ApiError> {
    let deadline = Instant::now() + Duration::from_secs(max_runtime_seconds.max(1));
    loop {
        let Some(info) = state.jobs.info_for_user(job_id, user_id).await? else {
            return Err(ApiError::not_found("Task trigger extraction run not found"));
        };
        if TERMINAL_STATUSES.contains(&info.status.as_str()) {
            return Ok(info);
        }
        if Instant::now() >= deadline {
            return Err(ApiError::bad_request(
                "Task trigger extraction run timed out",
            ));
        }
        sleep(Duration::from_millis(50)).await;
    }
}

async fn read_run_output(info: &AgentRunInfo) -> String {
    if let Some(output_file) = info.output_file.as_deref() {
        if let Ok(text) = tokio::fs::read_to_string(output_file).await {
            return text;
        }
    }
    info.stdout_tail.clone()
}

fn task_trigger_extraction_output_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["is_task_trigger_request", "missing_fields", "clarification_question", "task_trigger"],
        "properties": {
            "is_task_trigger_request": {"type": "boolean"},
            "missing_fields": {"type": "array", "items": {"type": "string"}},
            "clarification_question": {"type": ["string", "null"]},
            "task_trigger": {
                "type": ["object", "null"],
                "additionalProperties": false,
                "required": [
                    "title",
                    "prompt",
                    "kind",
                    "timezone",
                    "run_at",
                    "interval_seconds",
                    "enabled",
                    "cwd",
                    "model",
                    "effort",
                    "summary",
                    "output_schema",
                    "max_runtime_seconds",
                    "max_runs",
                    "phases"
                ],
                "properties": {
                    "title": {"type": ["string", "null"]},
                    "prompt": {"type": ["string", "null"]},
                    "kind": {"type": ["string", "null"], "enum": ["once", "interval", null]},
                    "timezone": {"type": ["string", "null"]},
                    "run_at": {"type": ["string", "null"]},
                    "interval_seconds": {"type": ["integer", "null"], "minimum": 1},
                    "enabled": {"type": "boolean"},
                    "cwd": {"type": ["string", "null"]},
                    "model": {"type": ["string", "null"]},
                    "effort": {"type": ["string", "null"]},
                    "summary": {"type": "null"},
                    "output_schema": {"type": "null"},
                    "max_runtime_seconds": {"type": ["integer", "null"], "minimum": 1, "maximum": 86400},
                    "max_runs": {"type": ["integer", "null"], "minimum": 1},
                    "phases": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["title", "prompt", "max_runs"],
                            "properties": {
                                "title": {"type": ["string", "null"]},
                                "prompt": {"type": ["string", "null"]},
                                "max_runs": {"type": ["integer", "null"], "minimum": 1}
                            }
                        }
                    }
                }
            }
        }
    })
}

fn build_task_trigger_extraction_prompt(user_input: &str) -> String {
    format!(
        "You are a strict task-trigger extractor for Ripple.\n\
{}\n\n\
Extract whether the user wants Ripple to create a future or recurring Codex task.\n\
Return only data that matches the provided output schema.\n\n\
Rules:\n\
- Set is_task_trigger_request=true only when the user is asking to create a future/recurring task.\n\
- For relative time such as '2 minutes later' or '2分钟以后', convert it to an absolute ISO 8601 run_at with timezone offset.\n\
- Use kind='once' for one-time future tasks and kind='interval' for recurring tasks.\n\
- For interval task triggers, interval_seconds is required. For once task triggers, run_at is required.\n\
- For daily requests with a clock time, such as '每天 11:15', '每日11点15分', 'daily at 11:15', or 'every day at 11:15', use kind='interval', interval_seconds=86400, and set run_at to the next occurrence of that local clock time. Do not use the extraction time as run_at.\n\
- For weekly requests such as '一周一次', '每周一次', '每星期一次', or 'weekly', use kind='interval' and interval_seconds=604800. If no start day/time is provided, leave run_at=null.\n\
- If the user writes in Chinese and omits a timezone, prefer Asia/Shanghai for daily clock-time requests.\n\
- If the user says to run a recurring task a fixed number of times, set task_trigger.max_runs to that count.\n\
- If the user describes ordered phases such as 'A 做完再做 B', 'first A then B', or different instructions for run 1..N versus later runs, put each phase in task_trigger.phases with its own prompt and max_runs. Set task_trigger.max_runs to the sum of phase max_runs when every phase has a fixed count.\n\
- For non-phased task triggers, set task_trigger.phases=[] rather than duplicating task_trigger.prompt.\n\
- If the user asks to run more than once but does not provide a recurrence interval, set task_trigger=null, include interval_seconds in missing_fields, and ask how often it should repeat.\n\
- Always set task_trigger.summary=null. It is an internal Codex configuration field, not a free-form task description.\n\
- Always set task_trigger.output_schema=null.\n\
- task_trigger.prompt is the exact instruction Codex should receive when the trigger fires.\n\
- Preserve execution-time intent in task_trigger.prompt. For example, if the user asks for a filename based on the execution date/time, say to compute it at execution time rather than hard-coding the extraction time.\n\
- For task triggers that gather, search, summarize, or monitor information and then send/update an external service such as Feishu/Lark, Gmail, email, webhook, or chat, treat sources/scope, item count or output format, delivery target/method, and empty-result/failure behavior as important details. If they are absent, ask one concise clarification instead of proposing immediately.\n\
- Do not execute the task now. Do not create timers, cron jobs, sleep loops, or background daemons.\n\
- If required information is missing, set task_trigger=null, list missing_fields, and provide one concise clarification_question.\n\n\
User request:\n{}\n",
        current_time_context(),
        user_input.trim()
    )
}

fn task_trigger_draft_pending_value(
    original_user_input: &str,
    extraction: &TaskTriggerExtractionResult,
    clarification: &str,
) -> Value {
    json!({
        "type": "task_trigger_draft",
        "original_user_input": original_user_input.trim(),
        "missing_fields": extraction.missing_fields.clone(),
        "clarification_question": clarification,
        "partial_task_trigger": extraction
            .task_trigger
            .as_ref()
            .and_then(|task_trigger| serde_json::to_value(task_trigger).ok())
            .unwrap_or(Value::Null)
    })
}

fn task_trigger_detail_pending_value(
    original_user_input: &str,
    payload: &Value,
    clarification: &str,
) -> Value {
    json!({
        "type": "task_trigger_draft",
        "original_user_input": original_user_input.trim(),
        "missing_fields": [TRIGGER_DETAILS_MISSING_FIELD],
        "clarification_question": clarification,
        "partial_task_trigger": payload
    })
}

fn pending_requested_trigger_details(pending: &Value) -> bool {
    pending
        .get("missing_fields")
        .and_then(Value::as_array)
        .is_some_and(|fields| {
            fields
                .iter()
                .any(|field| field.as_str() == Some(TRIGGER_DETAILS_MISSING_FIELD))
        })
}

fn combine_task_trigger_draft_followup(pending: &Value, user_input: &str) -> String {
    let original = pending
        .get("original_user_input")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let question = pending
        .get("clarification_question")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let followup = user_input.trim();
    format!(
        "{original}\n\nPrevious clarification question: {question}\nUser follow-up answer: {followup}"
    )
}

fn current_time_context() -> String {
    let utc = OffsetDateTime::now_utc();
    let shanghai = UtcOffset::from_hms(8, 0, 0)
        .map(|offset| utc.to_offset(offset))
        .unwrap_or(utc);
    format!(
        "Current time: {} UTC; {} Asia/Shanghai.",
        format_time(utc),
        format_time(shanghai)
    )
}

fn format_time(value: OffsetDateTime) -> String {
    value
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn parse_task_trigger_extraction_output(text: &str) -> Result<TaskTriggerExtractionResult, String> {
    serde_json::from_str::<TaskTriggerExtractionResult>(text.trim()).map_err(|err| err.to_string())
}

fn task_trigger_extraction_clarification(result: &TaskTriggerExtractionResult) -> Option<String> {
    if !result.is_task_trigger_request {
        return None;
    }
    if let Some(question) = result
        .clarification_question
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(question.to_string());
    }
    if !result.missing_fields.is_empty() {
        return Some(format!("还需要补充：{}", result.missing_fields.join("、")));
    }
    if result.task_trigger.is_none() {
        return Some("还需要补充任务触发器的时间和执行内容。".to_string());
    }
    None
}

fn task_trigger_detail_clarification(payload: &Value) -> Option<String> {
    if !should_request_task_trigger_details(payload) {
        return None;
    }

    Some(
        "这个自动化还需要补充一些执行细节后再创建，避免运行时找错来源或发错对象。请一次性补充：\n\
- 新闻来源或信息范围：例如指定网站、关键词、语言、时间范围，或排除哪些来源。\n\
- 筛选和输出：每次发几条、按什么标准选、是否要摘要、链接和格式。\n\
- 飞书发送或外部更新方式：发给联系人、群、机器人还是 Webhook，或更新哪个表格、文档、数据库、服务，以及可识别的账号、群名或 ID。\n\
- 空结果或发送失败时怎么处理，是否需要保存运行输出。"
            .to_string(),
    )
}

fn should_request_task_trigger_details(payload: &Value) -> bool {
    let text = format!(
        "{}\n{}",
        value_string(payload, "title"),
        value_string(payload, "prompt")
    )
    .to_ascii_lowercase();

    let gathers_information = contains_any(
        &text,
        &[
            "新闻",
            "资讯",
            "搜索",
            "搜集",
            "收集",
            "查找",
            "检索",
            "摘要",
            "监控",
            "news",
            "latest",
            "search",
            "collect",
            "digest",
            "summarize",
            "monitor",
        ],
    );
    let updates_external_service = contains_any(
        &text,
        &[
            "飞书",
            "feishu",
            "lark",
            "发消息",
            "发给",
            "发送",
            "通知",
            "推送",
            "webhook",
            "email",
            "gmail",
            "mail",
            "send",
            "notify",
            "message",
            "更新",
            "写入",
            "写到",
            "同步",
            "追加",
            "表格",
            "飞书文档",
            "google sheet",
            "google sheets",
            "sheet",
            "sheets",
            "spreadsheet",
            "docs",
            "notion",
            "database",
            "update",
            "write",
            "append",
            "sync",
        ],
    );

    if !(gathers_information && updates_external_service) {
        return false;
    }

    let detail_buckets = [
        contains_any(
            &text,
            &[
                "来源",
                "新闻源",
                "source",
                "site:",
                "rss",
                "网站",
                "媒体",
                "公众号",
                "关键词",
                "排除",
                "语言",
                "时间范围",
            ],
        ),
        contains_any(
            &text,
            &[
                "几条", "条", "top", "最多", "摘要", "链接", "格式", "markdown", "列表", "筛选",
                "标准", "重要",
            ],
        ),
        contains_any(
            &text,
            &[
                "群",
                "群聊",
                "机器人",
                "webhook",
                "open_id",
                "user_id",
                "chat_id",
                "union_id",
                "邮箱",
                "账号",
                "联系人",
                "目标",
                "表格",
                "飞书文档",
                "google sheet",
                "google sheets",
                "sheet",
                "sheets",
                "spreadsheet",
                "docs",
                "notion",
                "database",
                "@",
            ],
        ),
        contains_any(
            &text,
            &[
                "失败",
                "重试",
                "暂停",
                "跳过",
                "空结果",
                "没有新闻",
                "找不到",
                "保存",
                "文件",
                "输出",
                "日志",
                "retry",
                "failure",
            ],
        ),
    ];
    let detail_count = detail_buckets
        .iter()
        .filter(|has_detail| **has_detail)
        .count();

    detail_count < 3
}

fn contains_any(text: &str, markers: &[&str]) -> bool {
    markers.iter().any(|marker| text.contains(marker))
}

struct TaskTriggerProposal {
    payload: Value,
    message: String,
    question: String,
    options: Vec<String>,
}

fn task_trigger_proposal_from_extraction(
    result: &TaskTriggerExtractionResult,
) -> Result<Option<TaskTriggerProposal>, String> {
    if !result.is_task_trigger_request {
        return Ok(None);
    }
    let Some(task_trigger) = result.task_trigger.as_ref() else {
        return Ok(None);
    };
    let payload = normalize_task_trigger_payload(task_trigger)?;
    Ok(Some(TaskTriggerProposal {
        message: build_task_trigger_confirmation_message(&payload),
        question: "要创建这个任务触发器吗？".to_string(),
        options: vec!["确认创建".to_string(), "取消".to_string()],
        payload,
    }))
}

fn normalize_task_trigger_payload(draft: &TaskTriggerDraft) -> Result<Value, String> {
    let title = clean_optional_string(draft.title.as_deref())
        .ok_or_else(|| "title is required".to_string())?;
    let prompt = clean_optional_string(draft.prompt.as_deref())
        .ok_or_else(|| "prompt is required".to_string())?;
    let source_text = format!("{title}\n{prompt}");
    let mut kind =
        clean_optional_string(draft.kind.as_deref()).unwrap_or_else(|| "once".to_string());
    if kind != "once" && kind != "interval" {
        return Err("kind must be once or interval".to_string());
    }
    let draft_timezone = clean_optional_string(draft.timezone.as_deref());
    let mut timezone = draft_timezone.clone().unwrap_or_else(|| "UTC".to_string());
    let mut run_at = clean_optional_string(draft.run_at.as_deref());
    let mut interval_seconds = draft.interval_seconds;

    if let Some(daily_time) = daily_time_intent(&source_text) {
        kind = "interval".to_string();
        interval_seconds = Some(86_400);
        if draft_timezone.is_none() && prefers_shanghai_timezone(&source_text) {
            timezone = "Asia/Shanghai".to_string();
        }
        run_at = Some(next_daily_run_at(
            daily_time,
            &timezone,
            OffsetDateTime::now_utc(),
        )?);
    }

    if kind == "once" && run_at.is_none() {
        return Err("run_at is required for once task trigger".to_string());
    }
    if kind == "interval" && interval_seconds.is_none() {
        return Err("interval_seconds is required for interval task trigger".to_string());
    }
    if kind != "interval" && draft.max_runs.is_some() {
        return Err("max_runs is only supported for interval task trigger".to_string());
    }
    let phases = normalize_task_trigger_phases(&draft.phases)?;
    if !phases.is_empty() && kind != "interval" {
        return Err("phased task triggers require interval task triggers".to_string());
    }
    let phase_total_runs = if phases.is_empty() {
        None
    } else {
        Some(
            phases
                .iter()
                .filter_map(|phase| phase.get("max_runs").and_then(Value::as_u64))
                .sum::<u64>(),
        )
    };
    let max_runs = draft.max_runs.or(phase_total_runs);

    let mut payload = Map::new();
    payload.insert("title".to_string(), json!(title));
    payload.insert("prompt".to_string(), json!(prompt));
    payload.insert("kind".to_string(), json!(kind));
    payload.insert("timezone".to_string(), json!(timezone));
    payload.insert("run_at".to_string(), option_string(run_at));
    payload.insert("interval_seconds".to_string(), option_u64(interval_seconds));
    payload.insert(
        "enabled".to_string(),
        json!(trigger_enabled_from_intent(&source_text, draft.enabled)),
    );
    payload.insert(
        "cwd".to_string(),
        option_string(clean_optional_string(draft.cwd.as_deref())),
    );
    payload.insert(
        "model".to_string(),
        option_string(clean_optional_string(draft.model.as_deref())),
    );
    payload.insert(
        "effort".to_string(),
        option_string(clean_optional_string(draft.effort.as_deref())),
    );
    let _summary = draft.summary.as_deref();
    payload.insert("summary".to_string(), Value::Null);
    payload.insert(
        "output_schema".to_string(),
        draft.output_schema.clone().unwrap_or(Value::Null),
    );
    payload.insert(
        "max_runtime_seconds".to_string(),
        json!(draft.max_runtime_seconds.unwrap_or(1800).clamp(1, 86_400)),
    );
    payload.insert("max_runs".to_string(), option_u64(max_runs));
    payload.insert("phases".to_string(), Value::Array(phases));

    let value = Value::Object(payload);
    serde_json::from_value::<TaskTriggerCreateInput>(value.clone())
        .map_err(|err| err.to_string())?;
    Ok(value)
}

fn normalize_task_trigger_phases(
    draft_phases: &[TaskTriggerPhaseDraft],
) -> Result<Vec<Value>, String> {
    draft_phases
        .iter()
        .enumerate()
        .filter(|(_, phase)| phase.title.is_some() || phase.prompt.is_some())
        .map(|(index, phase)| {
            let prompt = clean_optional_string(phase.prompt.as_deref())
                .ok_or_else(|| "phase prompt is required".to_string())?;
            let title = clean_optional_string(phase.title.as_deref())
                .unwrap_or_else(|| format!("阶段 {}", index + 1));
            Ok(json!({
                "title": title,
                "prompt": prompt,
                "max_runs": phase.max_runs.unwrap_or(1).max(1)
            }))
        })
        .collect()
}

fn clean_optional_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[derive(Clone, Copy)]
struct DailyTimeIntent {
    hour: u8,
    minute: u8,
}

fn daily_time_intent(text: &str) -> Option<DailyTimeIntent> {
    if !has_daily_recurrence_marker(text) {
        return None;
    }
    extract_time_of_day(text)
}

fn has_daily_recurrence_marker(text: &str) -> bool {
    let normalized = text.to_ascii_lowercase();
    ["每天", "每日", "天天", "daily", "every day", "each day"]
        .iter()
        .any(|marker| normalized.contains(marker))
}

fn extract_time_of_day(text: &str) -> Option<DailyTimeIntent> {
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        if !chars[index].is_ascii_digit() {
            index += 1;
            continue;
        }

        let start = index;
        let Some((hour, after_hour)) = read_number(&chars, index) else {
            index += 1;
            continue;
        };
        let mut cursor = skip_spaces(&chars, after_hour);
        let mut minute = None;

        if matches!(chars.get(cursor), Some(':') | Some('：')) {
            cursor += 1;
            cursor = skip_spaces(&chars, cursor);
            if let Some((value, after_minute)) = read_number(&chars, cursor) {
                minute = Some(value);
                cursor = after_minute;
            }
        } else if matches!(chars.get(cursor), Some('点') | Some('時') | Some('时')) {
            cursor += 1;
            cursor = skip_spaces(&chars, cursor);
            if let Some((value, after_minute)) = read_number(&chars, cursor) {
                minute = Some(value);
                cursor = after_minute;
                cursor = skip_spaces(&chars, cursor);
                if matches!(chars.get(cursor), Some('分')) {
                    cursor += 1;
                }
            } else {
                minute = Some(0);
            }
        }

        if let Some(minute) = minute {
            if hour <= 23 && minute <= 59 {
                let hour = adjust_hour_for_meridiem(&chars, start, hour as u8);
                return Some(DailyTimeIntent {
                    hour,
                    minute: minute as u8,
                });
            }
        }

        index = start + 1;
    }
    None
}

fn read_number(chars: &[char], start: usize) -> Option<(u32, usize)> {
    let mut cursor = start;
    let mut value = 0_u32;
    let mut digits = 0;
    while let Some(ch) = chars.get(cursor).filter(|ch| ch.is_ascii_digit()) {
        value = value * 10 + ch.to_digit(10)?;
        cursor += 1;
        digits += 1;
    }
    (digits > 0).then_some((value, cursor))
}

fn skip_spaces(chars: &[char], mut index: usize) -> usize {
    while chars.get(index).is_some_and(|ch| ch.is_whitespace()) {
        index += 1;
    }
    index
}

fn adjust_hour_for_meridiem(chars: &[char], start: usize, hour: u8) -> u8 {
    let context_start = start.saturating_sub(4);
    let context_end = (start + 8).min(chars.len());
    let context: String = chars[context_start..context_end].iter().collect();
    let context = context.to_ascii_lowercase();
    if (context.contains("下午") || context.contains("晚上") || context.contains("pm")) && hour < 12
    {
        return hour + 12;
    }
    if (context.contains("上午") || context.contains("早上") || context.contains("am"))
        && hour == 12
    {
        return 0;
    }
    hour
}

fn prefers_shanghai_timezone(text: &str) -> bool {
    text.chars()
        .any(|ch| ('\u{4e00}'..='\u{9fff}').contains(&ch))
}

fn trigger_enabled_from_intent(text: &str, _extracted_enabled: Option<bool>) -> bool {
    let normalized = text.to_ascii_lowercase();
    let explicit_disabled = [
        "不要启用",
        "先不要启用",
        "不启用",
        "暂停",
        "先暂停",
        "保存但不启用",
        "disabled",
        "disable",
        "paused",
        "inactive",
    ]
    .iter()
    .any(|marker| normalized.contains(marker));
    !explicit_disabled
}

fn next_daily_run_at(
    intent: DailyTimeIntent,
    timezone: &str,
    now: OffsetDateTime,
) -> Result<String, String> {
    let offset = timezone_offset(timezone)
        .ok_or_else(|| format!("unsupported timezone for daily clock time: {timezone}"))?;
    let local_now = now.to_offset(offset);
    let time = Time::from_hms(intent.hour, intent.minute, 0).map_err(|err| err.to_string())?;
    let mut next = local_now.replace_time(time);
    if next <= local_now {
        next += TimeDuration::days(1);
    }
    Ok(format_time(next.to_offset(UtcOffset::UTC)))
}

fn timezone_offset(timezone: &str) -> Option<UtcOffset> {
    let timezone = timezone.trim();
    match timezone {
        "UTC" | "Etc/UTC" | "Z" => Some(UtcOffset::UTC),
        "Asia/Shanghai" | "Asia/Hong_Kong" | "Asia/Taipei" => UtcOffset::from_hms(8, 0, 0).ok(),
        "Asia/Tokyo" | "Asia/Seoul" => UtcOffset::from_hms(9, 0, 0).ok(),
        _ => parse_utc_offset(timezone),
    }
}

fn parse_utc_offset(value: &str) -> Option<UtcOffset> {
    let (sign, rest) = match value.as_bytes().first()? {
        b'+' => (1, &value[1..]),
        b'-' => (-1, &value[1..]),
        _ => return None,
    };
    let mut parts = rest.split(':');
    let hour = parts.next()?.parse::<i8>().ok()?;
    let minute = parts.next().unwrap_or("0").parse::<i8>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    UtcOffset::from_hms(sign * hour, sign * minute, 0).ok()
}

fn option_string(value: Option<String>) -> Value {
    value.map(Value::String).unwrap_or(Value::Null)
}

fn option_u64(value: Option<u64>) -> Value {
    value.map(|value| json!(value)).unwrap_or(Value::Null)
}

fn task_trigger_proposal_event(proposal: &TaskTriggerProposal) -> Value {
    json!({
        "type": "task_trigger_proposed",
        "message": proposal.message,
        "question": proposal.question,
        "options": proposal.options,
        "task_trigger": proposal.payload
    })
}

fn task_trigger_clarification_event(message: &str) -> Value {
    json!({
        "type": "task_trigger_clarification_required",
        "message": message,
        "question": message,
        "options": []
    })
}

fn task_trigger_extraction_failed_event(message: &str) -> Value {
    json!({"type": "task_trigger_extraction_failed", "message": message})
}

fn task_created_event(task: Value, task_trigger: Option<Value>, message: &str) -> Value {
    json!({
        "type": "task_created",
        "message": message,
        "task": task,
        "task_trigger": task_trigger
    })
}

fn task_trigger_cancelled_event(message: &str) -> Value {
    json!({"type": "task_trigger_cancelled", "message": message})
}

fn task_trigger_pending_event(message: &str, payload: Value) -> Value {
    json!({
        "type": "task_trigger_pending_confirmation",
        "message": message,
        "question": "要创建这个任务触发器吗？",
        "options": ["确认创建", "取消"],
        "task_trigger": payload
    })
}

fn idle_decision(event: Value) -> TaskTriggerChatDecision {
    TaskTriggerChatDecision {
        event,
        status: "idle".to_string(),
        clear_pending_control_request: false,
        pending_control_request: None,
    }
}

fn awaiting_decision(
    event: Value,
    pending_control_request: Option<Value>,
) -> TaskTriggerChatDecision {
    TaskTriggerChatDecision {
        event,
        status: "awaiting_user_input".to_string(),
        clear_pending_control_request: false,
        pending_control_request,
    }
}

fn build_task_trigger_confirmation_message(payload: &Value) -> String {
    let title = value_string(payload, "title");
    let prompt = value_string(payload, "prompt");
    let phases = phase_summary(payload);
    let timezone_name = value_string(payload, "timezone");
    let kind = value_string(payload, "kind");
    let timing = if kind == "interval" {
        let mut timing = format!(
            "每 {}",
            human_interval(
                payload
                    .get("interval_seconds")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
            )
        );
        if let Some(run_at) = payload.get("run_at").and_then(Value::as_str) {
            timing.push_str(&format!("，从 {run_at} 开始"));
        }
        timing
    } else {
        format!(
            "在 {}",
            payload
                .get("run_at")
                .and_then(Value::as_str)
                .unwrap_or("未指定时间")
        )
    };
    format!(
        "我可以创建这个任务触发器：\n\
- 标题：{title}\n\
- 类型：{}\n\
- 时间：{timing}（时区：{}）\n\
- 次数：{}\n\
- 执行内容：{prompt}{phases}\n\n\
回复“确认创建”来创建，或回复“取消”放弃。",
        if kind == "interval" {
            "周期任务"
        } else {
            "一次性任务"
        },
        if timezone_name.is_empty() {
            "UTC".to_string()
        } else {
            timezone_name
        },
        run_limit_label(payload)
    )
}

fn phase_summary(payload: &Value) -> String {
    let Some(phases) = payload.get("phases").and_then(Value::as_array) else {
        return String::new();
    };
    if phases.is_empty() {
        return String::new();
    }
    let lines = phases
        .iter()
        .enumerate()
        .map(|(index, phase)| {
            let title = phase.get("title").and_then(Value::as_str).unwrap_or("阶段");
            let max_runs = phase.get("max_runs").and_then(Value::as_u64).unwrap_or(1);
            format!("\n  {}. {}（{} 次）", index + 1, title, max_runs)
        })
        .collect::<String>();
    format!("\n- 阶段：{lines}")
}

fn build_task_trigger_created_message(task: &Value, task_trigger: Option<&Value>) -> String {
    let next_line = task_trigger
        .and_then(|record| record.get("next_run_at"))
        .and_then(Value::as_str)
        .map(|next| format!("下一次运行时间：{next}"))
        .unwrap_or_else(|| "当前没有下一次运行时间。".to_string());
    format!(
        "已创建任务「{}」，并添加定时触发器。{next_line}",
        value_string(task, "title")
    )
}

fn build_task_trigger_cancelled_message(payload: Option<&Value>) -> String {
    let title = payload
        .map(|value| value_string(value, "title"))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "这个任务触发器".to_string());
    format!("已取消创建「{title}」。")
}

fn build_task_trigger_pending_message(payload: &Value) -> String {
    let title = value_string(payload, "title");
    let title = if title.is_empty() {
        "这个任务触发器".to_string()
    } else {
        title
    };
    format!("「{title}」还在等待确认。请回复“确认创建”或“取消”。")
}

fn value_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

fn human_interval(seconds: u64) -> String {
    if seconds == 0 {
        return "指定间隔".to_string();
    }
    for (unit, label) in [
        (7 * 24 * 3600, "周"),
        (24 * 3600, "天"),
        (3600, "小时"),
        (60, "分钟"),
    ] {
        if seconds % unit == 0 {
            return format!("{} {label}", seconds / unit);
        }
    }
    format!("{seconds} 秒")
}

fn run_limit_label(payload: &Value) -> String {
    if payload.get("kind").and_then(Value::as_str) != Some("interval") {
        return "1 次".to_string();
    }
    if let Some(max_runs) = payload.get("max_runs").and_then(Value::as_u64) {
        if max_runs > 0 {
            return format!("最多 {max_runs} 次");
        }
    }
    "不限次数".to_string()
}

fn is_task_trigger_intent(text: &str) -> bool {
    let stripped = text.trim();
    if stripped.is_empty() {
        return false;
    }
    let normalized = stripped.to_ascii_lowercase();
    let explicit_markers = [
        "定时任务",
        "定时",
        "自动化",
        "自动执行",
        "task_trigger",
        "schedule",
        "scheduled",
        "automation",
        "automate",
        "recurring",
    ];
    let recurring_markers = [
        "周期",
        "重复",
        "每天",
        "每周",
        "每月",
        "每年",
        "每隔",
        "every day",
        "every week",
        "every month",
        "every year",
        "every hour",
        "hourly",
    ];
    explicit_markers
        .iter()
        .chain(recurring_markers.iter())
        .any(|marker| normalized.contains(marker))
}

fn is_task_trigger_confirmation(text: &str) -> bool {
    let normalized = normalize_reply(text);
    CONFIRM_WORDS.iter().any(|word| normalized == *word)
}

fn is_task_trigger_cancellation(text: &str) -> bool {
    let normalized = normalize_reply(text);
    CANCEL_WORDS.iter().any(|word| normalized == *word)
}

fn normalize_reply(text: &str) -> String {
    text.trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|ch| {
            !ch.is_whitespace()
                && !matches!(
                    ch,
                    '。' | '.'
                        | '!'
                        | '！'
                        | '?'
                        | '？'
                        | ','
                        | '，'
                        | ';'
                        | '；'
                        | ':'
                        | '：'
                        | '"'
                        | '\''
                        | '“'
                        | '”'
                        | '‘'
                        | '’'
                )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_task_trigger_intent_and_confirmation_words() {
        assert!(!is_task_trigger_intent("5分钟后提醒我检查构建"));
        assert!(is_task_trigger_intent("帮我创建一个新的自动化"));
        assert!(is_task_trigger_intent("创建一个定时任务，5分钟后检查构建"));
        assert!(is_task_trigger_intent("schedule this every day"));
        assert!(is_task_trigger_intent(
            "create automation to check prices every day"
        ));
        assert!(!is_task_trigger_intent("帮我检查构建"));
        assert!(is_task_trigger_confirmation("确认创建"));
        assert!(is_task_trigger_cancellation("取消。"));
    }

    #[test]
    fn only_claims_pending_control_requests_owned_by_task_triggers() {
        assert_eq!(
            pending_task_trigger_state(&json!({"type": "task_trigger_draft"})),
            Some(PendingTaskTriggerState::Draft)
        );
        assert_eq!(
            pending_task_trigger_state(&json!({
                "title": "Check build",
                "prompt": "Check the build status",
                "kind": "interval"
            })),
            Some(PendingTaskTriggerState::Confirmation)
        );
        assert_eq!(
            pending_task_trigger_state(&json!({
                "type": "task_execution",
                "active": true,
                "req_id": "req-1"
            })),
            None
        );
        assert_eq!(
            pending_task_trigger_state(&json!({"type": "future_control_state"})),
            None
        );
    }

    #[test]
    fn normalizes_task_trigger_payload() {
        let draft = TaskTriggerDraft {
            title: Some("日报".to_string()),
            prompt: Some("生成日报".to_string()),
            kind: Some("interval".to_string()),
            timezone: None,
            run_at: None,
            interval_seconds: Some(86_400),
            enabled: Some(true),
            cwd: None,
            model: None,
            effort: None,
            summary: None,
            output_schema: None,
            max_runtime_seconds: None,
            max_runs: Some(3),
            phases: Vec::new(),
        };

        let payload = normalize_task_trigger_payload(&draft).expect("payload");

        assert_eq!(payload.get("timezone").and_then(Value::as_str), Some("UTC"));
        assert_eq!(
            payload.get("interval_seconds").and_then(Value::as_u64),
            Some(86_400)
        );
        assert_eq!(payload.get("max_runs").and_then(Value::as_u64), Some(3));
    }

    #[test]
    fn normalizes_phased_task_trigger_payload_and_sums_runs() {
        let draft = TaskTriggerDraft {
            title: Some("京东价格定时查询".to_string()),
            prompt: Some("分阶段查询价格并告知用户。".to_string()),
            kind: Some("interval".to_string()),
            timezone: Some("Asia/Shanghai".to_string()),
            run_at: None,
            interval_seconds: Some(60),
            enabled: Some(true),
            cwd: None,
            model: None,
            effort: None,
            summary: None,
            output_schema: None,
            max_runtime_seconds: None,
            max_runs: None,
            phases: vec![
                TaskTriggerPhaseDraft {
                    title: Some("查询 iPhone 价格".to_string()),
                    prompt: Some("去京东查询 iPhone 17 Pro Max 官方店铺价格。".to_string()),
                    max_runs: Some(5),
                },
                TaskTriggerPhaseDraft {
                    title: Some("查询 Mac mini 价格".to_string()),
                    prompt: Some("去京东查询 Mac mini M4 价格。".to_string()),
                    max_runs: Some(2),
                },
            ],
        };

        let payload = normalize_task_trigger_payload(&draft).expect("payload");

        assert_eq!(payload.get("max_runs").and_then(Value::as_u64), Some(7));
        assert_eq!(
            payload
                .pointer("/phases/0/max_runs")
                .and_then(Value::as_u64),
            Some(5)
        );
        assert_eq!(
            payload
                .pointer("/phases/1/max_runs")
                .and_then(Value::as_u64),
            Some(2)
        );
    }

    #[test]
    fn phased_task_trigger_input_builds_task_level_trigger_and_action_dependencies() {
        let input = serde_json::from_value::<TaskTriggerCreateInput>(json!({
            "title": "京东价格定时查询",
            "prompt": "分阶段查询价格并告知用户。",
            "kind": "interval",
            "timezone": "Asia/Shanghai",
            "run_at": null,
            "interval_seconds": 60,
            "enabled": true,
            "cwd": null,
            "model": null,
            "effort": null,
            "summary": null,
            "output_schema": null,
            "max_runtime_seconds": 60,
            "max_runs": 7,
            "phases": [
                {
                    "title": "查询 iPhone 价格",
                    "prompt": "去京东查询 iPhone 17 Pro Max 官方店铺价格。",
                    "max_runs": 5
                },
                {
                    "title": "查询 Mac mini 价格",
                    "prompt": "去京东查询 Mac mini M4 价格。",
                    "max_runs": 2
                }
            ]
        }))
        .expect("input");

        let payload = task_payload_from_trigger_input(input);

        assert!(payload.get("trigger").is_some(), "{payload}");
        assert!(payload.pointer("/actions/0/trigger").is_none(), "{payload}");
        assert_eq!(
            payload
                .pointer("/actions/0/max_runs")
                .and_then(Value::as_u64),
            Some(5)
        );
        assert_eq!(
            payload
                .pointer("/actions/1/depends_on_action_ids/0")
                .and_then(Value::as_str),
            Some("act-phase-1")
        );
    }

    #[test]
    fn corrects_daily_time_requests_misread_as_once() {
        let draft = TaskTriggerDraft {
            title: Some("新闻的猪突猛进".to_string()),
            prompt: Some(
                "每天11:15 分， 搜一下最近的财经资讯， 把最重要的几条， 写到一个文件里面。"
                    .to_string(),
            ),
            kind: Some("once".to_string()),
            timezone: Some("Asia/Shanghai".to_string()),
            run_at: Some("2026-06-01T04:02:00Z".to_string()),
            interval_seconds: None,
            enabled: Some(true),
            cwd: None,
            model: None,
            effort: None,
            summary: None,
            output_schema: None,
            max_runtime_seconds: None,
            max_runs: None,
            phases: Vec::new(),
        };

        let payload = normalize_task_trigger_payload(&draft).expect("payload");

        assert_eq!(
            payload.get("kind").and_then(Value::as_str),
            Some("interval")
        );
        assert_eq!(
            payload.get("interval_seconds").and_then(Value::as_u64),
            Some(86_400)
        );
        assert!(
            payload
                .get("run_at")
                .and_then(Value::as_str)
                .is_some_and(|run_at| run_at.contains("T03:15:00Z")),
            "run_at should keep 11:15 Asia/Shanghai instead of the extraction time: {payload:?}"
        );
    }

    #[test]
    fn asks_for_more_details_before_external_news_delivery_task_trigger() {
        let draft = TaskTriggerDraft {
            title: Some("每日 AI 新闻飞书发送".to_string()),
            prompt: Some(
                "每天早上9点搜集一下 ai 相关的新闻，并且在飞书上给胡胖发消息，把新闻发给他。"
                    .to_string(),
            ),
            kind: Some("interval".to_string()),
            timezone: Some("Asia/Shanghai".to_string()),
            run_at: Some("2026-06-08T01:00:00Z".to_string()),
            interval_seconds: Some(86_400),
            enabled: Some(true),
            cwd: None,
            model: None,
            effort: None,
            summary: None,
            output_schema: None,
            max_runtime_seconds: None,
            max_runs: None,
            phases: Vec::new(),
        };

        let payload = normalize_task_trigger_payload(&draft).expect("payload");
        let clarification = task_trigger_detail_clarification(&payload).expect("clarification");

        assert!(clarification.contains("新闻来源"));
        assert!(clarification.contains("飞书"));
        assert!(clarification.contains("失败"));
    }

    #[test]
    fn asks_for_more_details_before_external_monitor_update_task_trigger() {
        let draft = TaskTriggerDraft {
            title: Some("每日 issue 表格更新".to_string()),
            prompt: Some(
                "每天早上9点监控 GitHub issue，如果有新条目就更新 Google Sheets。".to_string(),
            ),
            kind: Some("interval".to_string()),
            timezone: Some("Asia/Shanghai".to_string()),
            run_at: Some("2026-06-08T01:00:00Z".to_string()),
            interval_seconds: Some(86_400),
            enabled: Some(true),
            cwd: None,
            model: None,
            effort: None,
            summary: None,
            output_schema: None,
            max_runtime_seconds: None,
            max_runs: None,
            phases: Vec::new(),
        };

        let payload = normalize_task_trigger_payload(&draft).expect("payload");
        let clarification = task_trigger_detail_clarification(&payload).expect("clarification");

        assert!(clarification.contains("来源"));
        assert!(clarification.contains("更新"));
        assert!(clarification.contains("失败"));
    }

    #[test]
    fn does_not_ask_extra_details_for_simple_internal_task_trigger() {
        let draft = TaskTriggerDraft {
            title: Some("检查构建".to_string()),
            prompt: Some("检查构建状态并总结结果。".to_string()),
            kind: Some("interval".to_string()),
            timezone: Some("UTC".to_string()),
            run_at: None,
            interval_seconds: Some(3_600),
            enabled: Some(true),
            cwd: None,
            model: None,
            effort: None,
            summary: None,
            output_schema: None,
            max_runtime_seconds: None,
            max_runs: None,
            phases: Vec::new(),
        };

        let payload = normalize_task_trigger_payload(&draft).expect("payload");

        assert!(task_trigger_detail_clarification(&payload).is_none());
    }

    #[test]
    fn does_not_ask_extra_details_for_simple_external_reminder() {
        let draft = TaskTriggerDraft {
            title: Some("飞书喝水提醒".to_string()),
            prompt: Some("每天早上9点在飞书发消息提醒我喝水。".to_string()),
            kind: Some("interval".to_string()),
            timezone: Some("Asia/Shanghai".to_string()),
            run_at: Some("2026-06-08T01:00:00Z".to_string()),
            interval_seconds: Some(86_400),
            enabled: Some(true),
            cwd: None,
            model: None,
            effort: None,
            summary: None,
            output_schema: None,
            max_runtime_seconds: None,
            max_runs: None,
            phases: Vec::new(),
        };

        let payload = normalize_task_trigger_payload(&draft).expect("payload");

        assert!(task_trigger_detail_clarification(&payload).is_none());
    }
}
