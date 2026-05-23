use std::path::PathBuf;

use serde::Deserialize;
use serde_json::{json, Map, Value};
use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, UtcOffset};
use tokio::time::{sleep, Duration, Instant};

use crate::api::schedules::{create_schedule_for_user, ScheduleCreateInput};
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

#[derive(Debug)]
pub(crate) struct ScheduleChatDecision {
    pub(crate) event: Value,
    pub(crate) status: String,
    pub(crate) clear_pending_schedule: bool,
    pub(crate) pending_schedule_request: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScheduleDraft {
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
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScheduleExtractionResult {
    is_schedule_request: bool,
    #[serde(default)]
    missing_fields: Vec<String>,
    clarification_question: Option<String>,
    schedule: Option<ScheduleDraft>,
}

enum ScheduleExtractionError {
    Api(ApiError),
    Invalid,
    Runtime,
}

pub(crate) async fn maybe_handle_schedule_chat(
    state: &AppState,
    user_id: &str,
    session: &SessionRecord,
    workspace_root: PathBuf,
    user_input: &str,
    model: &str,
    effort: Option<String>,
) -> Result<Option<ScheduleChatDecision>, ApiError> {
    if let Some(pending) = session
        .pending_schedule_request
        .as_ref()
        .filter(|value| value.is_object())
    {
        return handle_pending_schedule_confirmation(state, user_id, pending, user_input).await;
    }

    if !is_schedule_intent(user_input) {
        return Ok(None);
    }

    let extraction = match extract_schedule_with_codex(
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
        Err(ScheduleExtractionError::Invalid) => {
            return Ok(Some(idle_decision(schedule_extraction_failed_event(
                "定时任务解析结果不合法，不是你的描述问题。请稍后重试。",
            ))));
        }
        Err(ScheduleExtractionError::Api(err)) => return Err(err),
        Err(ScheduleExtractionError::Runtime) => {
            return Ok(Some(idle_decision(schedule_extraction_failed_event(
                "定时任务解析服务失败，不是你的描述问题。请稍后重试。",
            ))));
        }
    };

    if !extraction.is_schedule_request {
        return Ok(None);
    }

    if let Some(clarification) = schedule_extraction_clarification(&extraction) {
        return Ok(Some(awaiting_decision(
            schedule_clarification_event(&clarification),
            None,
        )));
    }

    let proposal = match schedule_proposal_from_extraction(&extraction) {
        Ok(Some(proposal)) => proposal,
        Ok(None) => return Ok(None),
        Err(_) => {
            return Ok(Some(awaiting_decision(
                schedule_clarification_event(
                    "这个定时任务还缺少有效的时间或执行内容，请补充后我再创建。",
                ),
                None,
            )));
        }
    };

    Ok(Some(awaiting_decision(
        schedule_proposal_event(&proposal),
        Some(proposal.payload),
    )))
}

async fn handle_pending_schedule_confirmation(
    state: &AppState,
    user_id: &str,
    pending: &Value,
    user_input: &str,
) -> Result<Option<ScheduleChatDecision>, ApiError> {
    if is_schedule_cancellation(user_input) {
        return Ok(Some(ScheduleChatDecision {
            event: schedule_cancelled_event(&build_schedule_cancelled_message(Some(pending))),
            status: "idle".to_string(),
            clear_pending_schedule: true,
            pending_schedule_request: None,
        }));
    }

    if is_schedule_confirmation(user_input) {
        let input = serde_json::from_value::<ScheduleCreateInput>(pending.clone())
            .map_err(|err| ApiError::bad_request(err.to_string()))?;
        let record = create_schedule_for_user(state, user_id, input).await?;
        let message = build_schedule_created_message(&record);
        return Ok(Some(ScheduleChatDecision {
            event: schedule_created_event(record, &message),
            status: "idle".to_string(),
            clear_pending_schedule: true,
            pending_schedule_request: None,
        }));
    }

    Ok(Some(awaiting_decision(
        schedule_pending_event(&build_schedule_pending_message(pending), pending.clone()),
        None,
    )))
}

async fn extract_schedule_with_codex(
    state: &AppState,
    user_id: &str,
    session: &SessionRecord,
    workspace_root: PathBuf,
    user_input: &str,
    model: &str,
    effort: Option<String>,
) -> Result<ScheduleExtractionResult, ScheduleExtractionError> {
    let prompt = build_schedule_extraction_prompt(user_input);
    let max_runtime_seconds = state.config.schedule_extraction_max_runtime_seconds;
    let runtime_dir = state
        .sandboxes
        .session_dir(user_id, &session.session_id)
        .map_err(|_| ScheduleExtractionError::Runtime)?;
    assert_can_create_run(state, user_id, max_runtime_seconds)
        .await
        .map_err(ScheduleExtractionError::Api)?;
    let create = AgentRunCreateRequest {
        prompt: prompt.clone(),
        provider: "codex".to_string(),
        cwd: Some("/workspace".to_string()),
        input_items: vec![json!({"type": "text", "text": prompt})],
        model: Some(model.to_string()),
        effort,
        summary: None,
        output_schema: Some(schedule_extraction_output_schema()),
        max_runtime_seconds,
        schedule_id: None,
        schedule_title: None,
        schedule_trigger: None,
        codex_thread_id: None,
        codex_persistent_thread: false,
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
        .map_err(|_| ScheduleExtractionError::Runtime)?;
    let final_info =
        wait_for_schedule_extraction(state, user_id, &info.job_id, max_runtime_seconds)
            .await
            .map_err(|_| ScheduleExtractionError::Runtime)?;
    if final_info.status != "completed" {
        return Err(ScheduleExtractionError::Runtime);
    }
    parse_schedule_extraction_output(&read_run_output(&final_info).await)
        .map_err(|_| ScheduleExtractionError::Invalid)
}

async fn wait_for_schedule_extraction(
    state: &AppState,
    user_id: &str,
    job_id: &str,
    max_runtime_seconds: u64,
) -> Result<AgentRunInfo, ApiError> {
    let deadline = Instant::now() + Duration::from_secs(max_runtime_seconds.max(1));
    loop {
        let Some(info) = state.jobs.info_for_user(job_id, user_id).await? else {
            return Err(ApiError::not_found("Schedule extraction run not found"));
        };
        if TERMINAL_STATUSES.contains(&info.status.as_str()) {
            return Ok(info);
        }
        if Instant::now() >= deadline {
            return Err(ApiError::bad_request("Schedule extraction run timed out"));
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

fn schedule_extraction_output_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["is_schedule_request", "missing_fields", "clarification_question", "schedule"],
        "properties": {
            "is_schedule_request": {"type": "boolean"},
            "missing_fields": {"type": "array", "items": {"type": "string"}},
            "clarification_question": {"type": ["string", "null"]},
            "schedule": {
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
                    "max_runs"
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
                    "max_runs": {"type": ["integer", "null"], "minimum": 1}
                }
            }
        }
    })
}

fn build_schedule_extraction_prompt(user_input: &str) -> String {
    format!(
        "You are a strict schedule-request extractor for Ripple.\n\
{}\n\n\
Extract whether the user wants Ripple to create a future or recurring Codex task.\n\
Return only data that matches the provided output schema.\n\n\
Rules:\n\
- Set is_schedule_request=true only when the user is asking to create a future/recurring task.\n\
- For relative time such as '2 minutes later' or '2分钟以后', convert it to an absolute ISO 8601 run_at with timezone offset.\n\
- Use kind='once' for one-time future tasks and kind='interval' for recurring tasks.\n\
- For interval schedules, interval_seconds is required. For once schedules, run_at is required.\n\
- If the user says to run a recurring task a fixed number of times, set schedule.max_runs to that count.\n\
- If the user asks to run more than once but does not provide a recurrence interval, set schedule=null, include interval_seconds in missing_fields, and ask how often it should repeat.\n\
- Always set schedule.summary=null. It is an internal Codex configuration field, not a free-form task description.\n\
- Always set schedule.output_schema=null.\n\
- schedule.prompt is the exact instruction Codex should receive when the schedule fires.\n\
- Preserve execution-time intent in schedule.prompt. For example, if the user asks for a filename based on the execution date/time, say to compute it at execution time rather than hard-coding the extraction time.\n\
- Do not execute the task now. Do not create timers, cron jobs, sleep loops, or background daemons.\n\
- If required information is missing, set schedule=null, list missing_fields, and provide one concise clarification_question.\n\n\
User request:\n{}\n",
        current_time_context(),
        user_input.trim()
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

fn parse_schedule_extraction_output(text: &str) -> Result<ScheduleExtractionResult, String> {
    serde_json::from_str::<ScheduleExtractionResult>(text.trim()).map_err(|err| err.to_string())
}

fn schedule_extraction_clarification(result: &ScheduleExtractionResult) -> Option<String> {
    if !result.is_schedule_request {
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
    if result.schedule.is_none() {
        return Some("还需要补充定时任务的时间和执行内容。".to_string());
    }
    None
}

struct ScheduleProposal {
    payload: Value,
    message: String,
    question: String,
    options: Vec<String>,
}

fn schedule_proposal_from_extraction(
    result: &ScheduleExtractionResult,
) -> Result<Option<ScheduleProposal>, String> {
    if !result.is_schedule_request {
        return Ok(None);
    }
    let Some(schedule) = result.schedule.as_ref() else {
        return Ok(None);
    };
    let payload = normalize_schedule_payload(schedule)?;
    Ok(Some(ScheduleProposal {
        message: build_schedule_confirmation_message(&payload),
        question: "要创建这个定时任务吗？".to_string(),
        options: vec!["确认创建".to_string(), "取消".to_string()],
        payload,
    }))
}

fn normalize_schedule_payload(draft: &ScheduleDraft) -> Result<Value, String> {
    let title = clean_optional_string(draft.title.as_deref())
        .ok_or_else(|| "title is required".to_string())?;
    let prompt = clean_optional_string(draft.prompt.as_deref())
        .ok_or_else(|| "prompt is required".to_string())?;
    let kind = clean_optional_string(draft.kind.as_deref()).unwrap_or_else(|| "once".to_string());
    if kind != "once" && kind != "interval" {
        return Err("kind must be once or interval".to_string());
    }
    let timezone =
        clean_optional_string(draft.timezone.as_deref()).unwrap_or_else(|| "UTC".to_string());
    let run_at = clean_optional_string(draft.run_at.as_deref());
    let interval_seconds = draft.interval_seconds;
    if kind == "once" && run_at.is_none() {
        return Err("run_at is required for once schedules".to_string());
    }
    if kind == "interval" && interval_seconds.is_none() {
        return Err("interval_seconds is required for interval schedules".to_string());
    }
    if kind != "interval" && draft.max_runs.is_some() {
        return Err("max_runs is only supported for interval schedules".to_string());
    }

    let mut payload = Map::new();
    payload.insert("title".to_string(), json!(title));
    payload.insert("prompt".to_string(), json!(prompt));
    payload.insert("kind".to_string(), json!(kind));
    payload.insert("timezone".to_string(), json!(timezone));
    payload.insert("run_at".to_string(), option_string(run_at));
    payload.insert("interval_seconds".to_string(), option_u64(interval_seconds));
    payload.insert("enabled".to_string(), json!(draft.enabled.unwrap_or(true)));
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
    payload.insert("max_runs".to_string(), option_u64(draft.max_runs));

    let value = Value::Object(payload);
    serde_json::from_value::<ScheduleCreateInput>(value.clone()).map_err(|err| err.to_string())?;
    Ok(value)
}

fn clean_optional_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn option_string(value: Option<String>) -> Value {
    value.map(Value::String).unwrap_or(Value::Null)
}

fn option_u64(value: Option<u64>) -> Value {
    value.map(|value| json!(value)).unwrap_or(Value::Null)
}

fn schedule_proposal_event(proposal: &ScheduleProposal) -> Value {
    json!({
        "type": "schedule_proposed",
        "message": proposal.message,
        "question": proposal.question,
        "options": proposal.options,
        "schedule": proposal.payload
    })
}

fn schedule_clarification_event(message: &str) -> Value {
    json!({
        "type": "schedule_clarification_required",
        "message": message,
        "question": message,
        "options": []
    })
}

fn schedule_extraction_failed_event(message: &str) -> Value {
    json!({"type": "schedule_extraction_failed", "message": message})
}

fn schedule_created_event(record: Value, message: &str) -> Value {
    json!({"type": "schedule_created", "message": message, "schedule": record})
}

fn schedule_cancelled_event(message: &str) -> Value {
    json!({"type": "schedule_cancelled", "message": message})
}

fn schedule_pending_event(message: &str, payload: Value) -> Value {
    json!({
        "type": "schedule_pending_confirmation",
        "message": message,
        "question": "要创建这个定时任务吗？",
        "options": ["确认创建", "取消"],
        "schedule": payload
    })
}

fn idle_decision(event: Value) -> ScheduleChatDecision {
    ScheduleChatDecision {
        event,
        status: "idle".to_string(),
        clear_pending_schedule: false,
        pending_schedule_request: None,
    }
}

fn awaiting_decision(
    event: Value,
    pending_schedule_request: Option<Value>,
) -> ScheduleChatDecision {
    ScheduleChatDecision {
        event,
        status: "awaiting_user_input".to_string(),
        clear_pending_schedule: false,
        pending_schedule_request,
    }
}

fn build_schedule_confirmation_message(payload: &Value) -> String {
    let title = value_string(payload, "title");
    let prompt = value_string(payload, "prompt");
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
        "我可以创建这个定时任务：\n\
- 标题：{title}\n\
- 类型：{}\n\
- 时间：{timing}（时区：{}）\n\
- 次数：{}\n\
- 执行内容：{prompt}\n\n\
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

fn build_schedule_created_message(record: &Value) -> String {
    let next_line = record
        .get("next_run_at")
        .and_then(Value::as_str)
        .map(|next| format!("下一次运行时间：{next}"))
        .unwrap_or_else(|| "当前没有下一次运行时间。".to_string());
    format!(
        "已创建定时任务「{}」。{next_line}",
        value_string(record, "title")
    )
}

fn build_schedule_cancelled_message(payload: Option<&Value>) -> String {
    let title = payload
        .map(|value| value_string(value, "title"))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "这个定时任务".to_string());
    format!("已取消创建「{title}」。")
}

fn build_schedule_pending_message(payload: &Value) -> String {
    let title = value_string(payload, "title");
    let title = if title.is_empty() {
        "这个定时任务".to_string()
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

fn is_schedule_intent(text: &str) -> bool {
    let stripped = text.trim();
    if stripped.is_empty() {
        return false;
    }
    let normalized = stripped.to_ascii_lowercase();
    let markers = [
        "定时",
        "定一个",
        "周期",
        "重复",
        "每天",
        "每周",
        "每月",
        "每年",
        "每隔",
        "提醒",
        "闹钟",
        "schedule",
        "scheduled",
        "recurring",
        "remind",
    ];
    markers.iter().any(|marker| normalized.contains(marker)) || has_relative_time(&normalized)
}

fn has_relative_time(text: &str) -> bool {
    let has_number = text.chars().any(|ch| ch.is_ascii_digit());
    if !has_number {
        return false;
    }
    let has_unit = [
        "秒", "分钟", "小时", "天", "周", "个月", "second", "minute", "hour", "day", "week",
    ]
    .iter()
    .any(|unit| text.contains(unit));
    has_unit
        && (text.contains('后')
            || text.contains("以后")
            || text.contains("之后")
            || text.contains("later"))
}

fn is_schedule_confirmation(text: &str) -> bool {
    let normalized = normalize_reply(text);
    CONFIRM_WORDS.iter().any(|word| normalized == *word)
}

fn is_schedule_cancellation(text: &str) -> bool {
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
    fn detects_schedule_intent_and_confirmation_words() {
        assert!(is_schedule_intent("5分钟后提醒我检查构建"));
        assert!(is_schedule_intent("schedule this every day"));
        assert!(!is_schedule_intent("帮我检查构建"));
        assert!(is_schedule_confirmation("确认创建"));
        assert!(is_schedule_cancellation("取消。"));
    }

    #[test]
    fn normalizes_schedule_payload() {
        let draft = ScheduleDraft {
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
        };

        let payload = normalize_schedule_payload(&draft).expect("payload");

        assert_eq!(payload.get("timezone").and_then(Value::as_str), Some("UTC"));
        assert_eq!(
            payload.get("interval_seconds").and_then(Value::as_u64),
            Some(86_400)
        );
        assert_eq!(payload.get("max_runs").and_then(Value::as_u64), Some(3));
    }
}
