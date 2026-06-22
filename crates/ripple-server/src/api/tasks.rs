use std::collections::{BTreeMap, BTreeSet};

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::{Duration as TimeDuration, OffsetDateTime};
use tokio::time::{sleep, Duration, Instant};
use uuid::Uuid;

use crate::api::run_public::{sanitize_user_visible_text, sanitize_user_visible_value};
use crate::api::users::assert_can_create_run;
use crate::api::{paginate, ApiError, ListQuery};
use crate::codex::events::extract_plan_update_event;
use crate::jobs::{AgentRunCreateRequest, AgentRunInfo};
use crate::sessions::{SessionRecord, SessionStatus};
use crate::state::AppState;
use crate::storage::Storage;
use crate::user::user_id_from_headers;

#[derive(Debug, Clone)]
pub(crate) struct TaskRunTriggerContext {
    pub(crate) trigger_id: String,
    pub(crate) task_trigger_title: String,
    pub(crate) task_trigger_reason: String,
    pub(crate) complete_action_on_success: Option<bool>,
    pub(crate) prompt: Option<String>,
    pub(crate) cwd: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
    pub(crate) summary: Option<String>,
    pub(crate) output_schema: Option<Value>,
    pub(crate) max_runtime_seconds: Option<u64>,
}

pub async fn list_tasks(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let records = state.storage.list_tasks(&user_id).await?;
    Ok(Json(task_list_response(&state, &user_id, records, &query)?))
}

pub async fn list_session_tasks(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    require_session(&state, &user_id, &session_id).await?;
    let records = state
        .storage
        .list_tasks_for_session(&user_id, &session_id)
        .await?;
    Ok(Json(task_list_response(&state, &user_id, records, &query)?))
}

pub async fn create_task(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let (task, actions) = create_task_from_payload(&state.storage, &user_id, None, &input).await?;
    Ok(Json(json!({
        "task": public_task_value(&state, &user_id, task),
        "actions": public_task_action_values(&state, &user_id, actions)
    })))
}

pub async fn get_task(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let task = load_task(&state.storage, &user_id, &task_id).await?;
    let actions =
        sort_task_actions_for_execution(state.storage.list_task_actions(&user_id, &task_id).await?);
    Ok(Json(json!({
        "task": public_task_value(&state, &user_id, task),
        "actions": public_task_action_values(&state, &user_id, actions)
    })))
}

pub async fn update_task(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let mut task = load_task(&state.storage, &user_id, &task_id).await?;
    merge_task_updates(&mut task, &input)?;
    let actions =
        sort_task_actions_for_execution(state.storage.list_task_actions(&user_id, &task_id).await?);
    let trigger_records =
        task_trigger_records_from_task_and_actions(&user_id, &task, &actions, &now_iso())?;
    validate_enabled_task_triggers_have_source_session(&task, &trigger_records)?;
    state.storage.upsert_task(&user_id, &task).await?;
    persist_new_task_trigger_records(&state.storage, &user_id, &task, &trigger_records).await?;
    if let Some(status) = task
        .get("status")
        .and_then(Value::as_str)
        .filter(|status| matches!(*status, "completed" | "cancelled" | "archived"))
    {
        disable_task_triggers_for_terminal_task(&state.storage, &user_id, &task_id, status).await?;
    }
    append_task_event(
        &state.storage,
        &user_id,
        &task_id,
        "task_updated",
        json!({"updates": input}),
    )
    .await?;
    Ok(Json(json!({
        "task": public_task_value(&state, &user_id, task),
        "actions": public_task_action_values(&state, &user_id, actions)
    })))
}

pub async fn cancel_task(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let mut task = load_task(&state.storage, &user_id, &task_id).await?;
    transition_task_status(&mut task, "cancelled")?;
    set_field(&mut task, "updated_at", json!(now_iso()));
    state.storage.upsert_task(&user_id, &task).await?;
    append_task_event(
        &state.storage,
        &user_id,
        &task_id,
        "task_cancelled",
        json!({}),
    )
    .await?;
    disable_task_triggers_for_terminal_task(&state.storage, &user_id, &task_id, "cancelled")
        .await?;
    let actions =
        sort_task_actions_for_execution(state.storage.list_task_actions(&user_id, &task_id).await?);
    Ok(Json(json!({
        "task": public_task_value(&state, &user_id, task),
        "actions": public_task_action_values(&state, &user_id, actions)
    })))
}

pub async fn delete_task(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let _ = load_task(&state.storage, &user_id, &task_id).await?;
    let deleted = state.storage.delete_task(&user_id, &task_id).await?;
    if !deleted {
        return Err(ApiError::not_found("Task not found"));
    }
    Ok(Json(json!({
        "ok": true,
        "task_id": task_id
    })))
}

pub async fn confirm_task(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let mut task = load_task(&state.storage, &user_id, &task_id).await?;
    transition_task_status(&mut task, "active")?;
    set_field(&mut task, "requires_confirmation", json!(false));
    set_field(&mut task, "updated_at", json!(now_iso()));
    state.storage.upsert_task(&user_id, &task).await?;

    let mut actions =
        sort_task_actions_for_execution(state.storage.list_task_actions(&user_id, &task_id).await?);
    for action in &mut actions {
        if action.get("status").and_then(Value::as_str) == Some("candidate") {
            set_field(action, "status", json!("confirmed"));
            set_field(action, "requires_confirmation", json!(false));
            set_field(action, "updated_at", json!(now_iso()));
            state
                .storage
                .upsert_task_action(&user_id, &task_id, action)
                .await?;
        }
    }
    activate_pending_task_triggers(&state.storage, &user_id, &task_id).await?;
    append_task_event(
        &state.storage,
        &user_id,
        &task_id,
        "task_confirmed",
        json!({}),
    )
    .await?;
    let actions =
        sort_task_actions_for_execution(state.storage.list_task_actions(&user_id, &task_id).await?);
    Ok(Json(json!({
        "task": public_task_value(&state, &user_id, task),
        "actions": public_task_action_values(&state, &user_id, actions)
    })))
}

pub async fn run_task_now(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let info = execute_task_action(&state, &user_id, &task_id, None).await?;
    Ok(Json(
        serde_json::to_value(info).unwrap_or_else(|_| json!({})),
    ))
}

pub async fn list_task_actions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let _ = load_task(&state.storage, &user_id, &task_id).await?;
    let actions =
        sort_task_actions_for_execution(state.storage.list_task_actions(&user_id, &task_id).await?);
    let count = actions.len();
    Ok(Json(json!({
        "actions": public_task_action_values(&state, &user_id, actions),
        "count": count
    })))
}

pub async fn create_task_action(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let task = load_task(&state.storage, &user_id, &task_id).await?;
    let now = now_iso();
    let action = action_record_from_payload(&input, &user_id, &task_id, &task, &now, None)?;
    let trigger_records =
        task_trigger_records_from_actions(&user_id, &task, std::slice::from_ref(&action), &now)?;
    validate_enabled_task_triggers_have_source_session(&task, &trigger_records)?;
    state
        .storage
        .upsert_task_action(&user_id, &task_id, &action)
        .await?;
    persist_new_task_trigger_records(&state.storage, &user_id, &task, &trigger_records).await?;
    let _ = refresh_task_progress(&state.storage, &user_id, &task_id).await?;
    append_task_event(
        &state.storage,
        &user_id,
        &task_id,
        "task_action_created",
        json!({"action_id": action.get("action_id").cloned().unwrap_or(Value::Null)}),
    )
    .await?;
    Ok(Json(public_task_action_response(&state, &user_id, action)))
}

pub async fn update_task_action(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((task_id, action_id)): Path<(String, String)>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let (task, action, actions) =
        update_task_action_record(&state.storage, &user_id, &task_id, &action_id, &input, None)
            .await?;
    Ok(Json(json!({
        "task": public_task_value(&state, &user_id, task),
        "action": public_task_action_value(&state, &user_id, action),
        "actions": public_task_action_values(&state, &user_id, actions)
    })))
}

pub async fn list_task_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let _ = load_task(&state.storage, &user_id, &task_id).await?;
    let events = state.storage.list_task_events(&user_id, &task_id).await?;
    let count = events.len();
    Ok(Json(json!({
        "events": public_values(&state, &user_id, events),
        "count": count
    })))
}

pub(crate) async fn persist_task_update(
    storage: &Storage,
    user_id: &str,
    session_id: Option<&str>,
    arguments: &Value,
) -> Result<Value, ApiError> {
    let mode = arguments
        .get("mode")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("task_update missing mode"))?;
    let target = arguments
        .get("target")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("task_update missing target"))?;
    if target != "task" {
        return Err(ApiError::bad_request(
            "task_update currently supports only task",
        ));
    }
    if !matches!(
        mode,
        "propose"
            | "create"
            | "update_task"
            | "create_action"
            | "update_action"
            | "start_action"
            | "complete_action"
            | "block_action"
            | "wait_user"
            | "complete_task"
    ) {
        return Err(ApiError::bad_request(
            "task_update mode is not supported for task",
        ));
    }
    if !matches!(mode, "propose" | "create") {
        return persist_task_update_mutation(storage, user_id, mode, arguments).await;
    }

    let mut payload = if let Some(task) = arguments.get("task").filter(|value| value.is_object()) {
        task.clone()
    } else {
        arguments.clone()
    };
    if let Some(object) = payload.as_object_mut() {
        object.remove("mode");
        object.remove("target");
        object.remove("task");
        if !object.contains_key("actions") {
            if let Some(actions) = arguments.get("actions").cloned() {
                object.insert("actions".to_string(), actions);
            }
        }
        if mode == "propose" {
            object
                .entry("status".to_string())
                .or_insert_with(|| json!("candidate"));
            object
                .entry("requires_confirmation".to_string())
                .or_insert_with(|| json!(true));
        }
    }
    if let Some(clarification) = task_update_clarification_response(target, mode, &payload) {
        return Ok(clarification);
    }
    let (task, actions) = create_task_from_payload(storage, user_id, session_id, &payload).await?;
    Ok(json!({
        "ok": true,
        "target": target,
        "mode": mode,
        "task": task,
        "actions": actions,
        "message": "Task saved."
    }))
}

fn task_update_clarification_response(target: &str, mode: &str, payload: &Value) -> Option<Value> {
    let missing_fields = task_update_missing_clarity_fields(payload);
    if missing_fields.is_empty() {
        return None;
    }
    let question = task_update_clarification_question(&missing_fields);
    Some(json!({
        "ok": false,
        "target": target,
        "mode": mode,
        "code": "task_needs_clarification",
        "missing_fields": missing_fields,
        "clarification_question": question,
        "message": question
    }))
}

fn task_update_missing_clarity_fields(payload: &Value) -> Vec<String> {
    let mut missing = Vec::new();
    if clean_value_text(payload.get("title"))
        .or_else(|| clean_value_text(payload.get("objective")))
        .is_none()
    {
        push_missing_field(&mut missing, "title");
    }

    let actions = payload.get("actions").and_then(Value::as_array);
    if actions
        .map(|actions| actions.iter().any(task_update_action_has_next_step))
        .unwrap_or(false)
        == false
    {
        push_missing_field(&mut missing, "actions");
    }

    collect_missing_trigger_time_fields(payload, &mut missing);
    if let Some(actions) = actions {
        for action in actions {
            collect_missing_trigger_time_fields(action, &mut missing);
        }
    }

    collect_missing_external_detail_fields(payload, &mut missing);
    missing
}

fn task_update_action_has_next_step(action: &Value) -> bool {
    action.is_object()
        && clean_value_text(action.get("title"))
            .or_else(|| clean_value_text(action.get("objective")))
            .or_else(|| clean_value_text(action.get("description")))
            .is_some()
}

fn collect_missing_trigger_time_fields(value: &Value, missing: &mut Vec<String>) {
    if let Some(trigger) = value.get("trigger").filter(|value| value.is_object()) {
        collect_missing_single_trigger_time_field(trigger, missing);
    }
    if let Some(triggers) = value.get("triggers").and_then(Value::as_array) {
        for trigger in triggers.iter().filter(|value| value.is_object()) {
            collect_missing_single_trigger_time_field(trigger, missing);
        }
    }
}

fn collect_missing_single_trigger_time_field(trigger: &Value, missing: &mut Vec<String>) {
    let kind = clean_value_text(trigger.get("kind")).unwrap_or_else(|| {
        if trigger.get("interval_seconds").is_some() {
            "interval".to_string()
        } else {
            "once".to_string()
        }
    });
    match kind.as_str() {
        "once" => {
            if clean_value_text(trigger.get("run_at")).is_none() {
                push_missing_field(missing, "run_at");
            }
        }
        "interval" => {
            if trigger_u64_field(trigger, "interval_seconds").is_none() {
                push_missing_field(missing, "interval_seconds");
            }
        }
        _ => push_missing_field(missing, "trigger_kind"),
    }
}

fn collect_missing_external_detail_fields(payload: &Value, missing: &mut Vec<String>) {
    let text = task_update_clarity_text(payload).to_ascii_lowercase();
    let gathers_information = task_update_contains_any(
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
    let updates_external_service = task_update_contains_any(
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
        return;
    }

    if !task_update_contains_any(
        &text,
        &[
            "来源",
            "范围",
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
    ) {
        push_missing_field(missing, "source_scope");
    }
    if !task_update_contains_any(
        &text,
        &[
            "几条", "条", "top", "最多", "摘要", "链接", "格式", "markdown", "列表", "筛选",
            "标准", "重要",
        ],
    ) {
        push_missing_field(missing, "output_format");
    }
    if !task_update_contains_any(
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
    ) {
        push_missing_field(missing, "delivery_target");
    }
    if !task_update_contains_any(
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
    ) {
        push_missing_field(missing, "failure_behavior");
    }
}

fn task_update_clarity_text(payload: &Value) -> String {
    let mut parts = Vec::new();
    collect_task_update_text(payload, &mut parts);
    parts.join("\n")
}

fn collect_task_update_text(value: &Value, parts: &mut Vec<String>) {
    if let Some(object) = value.as_object() {
        for key in [
            "title",
            "objective",
            "description",
            "prompt",
            "source_summary",
        ] {
            if let Some(text) = clean_value_text(object.get(key)) {
                parts.push(text);
            }
        }
        for key in ["actions", "triggers"] {
            if let Some(items) = object.get(key).and_then(Value::as_array) {
                for item in items {
                    collect_task_update_text(item, parts);
                }
            }
        }
        if let Some(trigger) = object.get("trigger") {
            collect_task_update_text(trigger, parts);
        }
    }
}

fn task_update_clarification_question(missing_fields: &[String]) -> String {
    if missing_fields.iter().any(|field| field == "actions") {
        return "这个任务还缺少明确的下一步。请补充希望我具体执行哪一步，以及完成后要产出什么。"
            .to_string();
    }
    if missing_fields
        .iter()
        .any(|field| field == "run_at" || field == "interval_seconds")
    {
        return "这个任务需要未来或重复执行，但还缺少明确的运行时间或频率。请补充什么时候执行，或多久重复一次。"
            .to_string();
    }
    if missing_fields.iter().any(|field| {
        matches!(
            field.as_str(),
            "source_scope" | "output_format" | "delivery_target" | "failure_behavior"
        )
    }) {
        return "这个任务涉及搜集信息并发送或更新外部服务。请补充来源范围、输出格式、发送或更新目标，以及空结果或失败时怎么处理。"
            .to_string();
    }
    "这个任务还缺少关键信息。请补充任务目标和你希望我执行的下一步。".to_string()
}

fn clean_value_text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn trigger_u64_field(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(|value| {
        value.as_u64().or_else(|| {
            value
                .as_str()
                .and_then(|text| text.trim().parse::<u64>().ok())
        })
    })
}

fn task_update_contains_any(text: &str, markers: &[&str]) -> bool {
    markers.iter().any(|marker| text.contains(marker))
}

fn push_missing_field(missing: &mut Vec<String>, field: &str) {
    if !missing.iter().any(|existing| existing == field) {
        missing.push(field.to_string());
    }
}

pub async fn trigger_due_task_actions(
    state: &AppState,
) -> Result<BTreeMap<String, Vec<String>>, ApiError> {
    let now = OffsetDateTime::now_utc();
    let mut triggered = BTreeMap::<String, Vec<String>>::new();
    for user_id in state.storage.list_task_user_ids().await? {
        let trigger_owned_actions = state
            .storage
            .list_task_triggers(&user_id)
            .await?
            .into_iter()
            .filter_map(|trigger| {
                let task_id = trigger.get("task_id").and_then(Value::as_str)?;
                let action_id = trigger.get("task_action_id").and_then(Value::as_str)?;
                Some((task_id.to_string(), action_id.to_string()))
            })
            .collect::<BTreeSet<_>>();
        let tasks = state.storage.list_tasks(&user_id).await?;
        for task in tasks {
            if task_is_not_runnable(&task) {
                continue;
            }
            let Some(task_id) = task.get("task_id").and_then(Value::as_str) else {
                continue;
            };
            let actions = sort_task_actions_for_execution(
                state.storage.list_task_actions(&user_id, task_id).await?,
            );
            let all_actions = actions.clone();
            for mut action in actions {
                if action.get("status").and_then(Value::as_str) != Some("confirmed") {
                    continue;
                }
                if !action_dependencies_satisfied(&action, &all_actions) {
                    continue;
                }
                let had_next_wakeup_at = action
                    .get("next_wakeup_at")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .is_some();
                normalize_action_wakeup_fields(&mut action);
                let Some(action_id) = action
                    .get("action_id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                else {
                    continue;
                };
                if trigger_owned_actions.contains(&(task_id.to_string(), action_id.clone())) {
                    continue;
                }
                let Some(wakeup_at_text) = action_wakeup_at(&action).map(str::to_string) else {
                    continue;
                };
                let wakeup_at = match parse_datetime(&wakeup_at_text) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                if wakeup_at > now {
                    continue;
                }
                if !had_next_wakeup_at {
                    let mut updated = action.clone();
                    set_field(&mut updated, "updated_at", json!(now_iso()));
                    state
                        .storage
                        .upsert_task_action(&user_id, task_id, &updated)
                        .await?;
                }
                append_task_event(
                    &state.storage,
                    &user_id,
                    task_id,
                    "task_action_due_triggered",
                    json!({
                        "action_id": action_id,
                        "next_wakeup_at": wakeup_at_text
                    }),
                )
                .await?;
                match execute_task_action(state, &user_id, task_id, Some(action_id.as_str())).await
                {
                    Ok(_) => {
                        triggered
                            .entry(user_id.clone())
                            .or_default()
                            .push(format!("{task_id}:{action_id}"));
                    }
                    Err(err) => {
                        let _ = update_task_action_record(
                            &state.storage,
                            &user_id,
                            task_id,
                            &action_id,
                            &json!({
                                "status": "blocked",
                                "last_error": format!("{err:?}")
                            }),
                            Some("block_action"),
                        )
                        .await;
                    }
                }
            }
        }
    }
    Ok(triggered)
}

pub(crate) async fn create_task_from_payload(
    storage: &Storage,
    user_id: &str,
    default_session_id: Option<&str>,
    payload: &Value,
) -> Result<(Value, Vec<Value>), ApiError> {
    let now = now_iso();
    let task = task_record_from_payload(payload, user_id, default_session_id, &now)?;
    let task_id = task
        .get("task_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("task missing task_id"))?
        .to_string();
    let actions = payload
        .get("actions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(index, action)| {
            action_record_from_payload(
                &action,
                user_id,
                &task_id,
                &task,
                &now,
                Some((index + 1) as u64),
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let actions = sort_task_actions_for_execution(actions);
    let trigger_records =
        task_trigger_records_from_task_and_actions(user_id, &task, &actions, &now)?;
    validate_enabled_task_triggers_have_source_session(&task, &trigger_records)?;

    storage.upsert_task(user_id, &task).await?;
    for action in &actions {
        storage
            .upsert_task_action(user_id, &task_id, action)
            .await?;
    }
    persist_new_task_trigger_records(storage, user_id, &task, &trigger_records).await?;
    let task = refresh_task_progress(storage, user_id, &task_id).await?;
    append_task_event(
        storage,
        user_id,
        &task_id,
        "task_created",
        json!({
            "action_count": actions.len(),
            "trigger_count": trigger_records.len()
        }),
    )
    .await?;
    Ok((task, actions))
}

async fn persist_task_update_mutation(
    storage: &Storage,
    user_id: &str,
    mode: &str,
    arguments: &Value,
) -> Result<Value, ApiError> {
    let task_id = arguments
        .get("task_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("task_update missing task_id"))?;
    match mode {
        "update_task" => {
            let updates = arguments
                .get("updates")
                .filter(|value| value.is_object())
                .cloned()
                .unwrap_or_else(|| {
                    let mut updates = arguments.clone();
                    if let Some(object) = updates.as_object_mut() {
                        object.remove("mode");
                        object.remove("target");
                        object.remove("task_id");
                    }
                    updates
                });
            let mut task = load_task(storage, user_id, task_id).await?;
            merge_task_updates(&mut task, &updates)?;
            let actions =
                sort_task_actions_for_execution(storage.list_task_actions(user_id, task_id).await?);
            let trigger_records =
                task_trigger_records_from_task_and_actions(user_id, &task, &actions, &now_iso())?;
            validate_enabled_task_triggers_have_source_session(&task, &trigger_records)?;
            storage.upsert_task(user_id, &task).await?;
            persist_new_task_trigger_records(storage, user_id, &task, &trigger_records).await?;
            if let Some(status) = task
                .get("status")
                .and_then(Value::as_str)
                .filter(|status| matches!(*status, "completed" | "cancelled" | "archived"))
            {
                disable_task_triggers_for_terminal_task(storage, user_id, task_id, status).await?;
            }
            append_task_event(
                storage,
                user_id,
                task_id,
                "task_updated",
                json!({"updates": updates}),
            )
            .await?;
            Ok(json!({
                "ok": true,
                "mode": mode,
                "target": "task",
                "task": task,
                "actions": actions,
                "message": "Task updated."
            }))
        }
        "create_action" => {
            let task = load_task(storage, user_id, task_id).await?;
            let action_payload = arguments
                .get("action")
                .filter(|value| value.is_object())
                .cloned()
                .ok_or_else(|| ApiError::bad_request("task_update create_action missing action"))?;
            let now = now_iso();
            let action =
                action_record_from_payload(&action_payload, user_id, task_id, &task, &now, None)?;
            let trigger_records = task_trigger_records_from_actions(
                user_id,
                &task,
                std::slice::from_ref(&action),
                &now,
            )?;
            validate_enabled_task_triggers_have_source_session(&task, &trigger_records)?;
            storage
                .upsert_task_action(user_id, task_id, &action)
                .await?;
            persist_new_task_trigger_records(storage, user_id, &task, &trigger_records).await?;
            append_task_event(
                storage,
                user_id,
                task_id,
                "task_action_created",
                json!({"action_id": action.get("action_id").cloned().unwrap_or(Value::Null)}),
            )
            .await?;
            let task = refresh_task_progress(storage, user_id, task_id).await?;
            let actions =
                sort_task_actions_for_execution(storage.list_task_actions(user_id, task_id).await?);
            Ok(json!({
                "ok": true,
                "mode": mode,
                "target": "task",
                "task": task,
                "action": action,
                "actions": actions,
                "message": "Task action created."
            }))
        }
        "update_action" | "start_action" | "complete_action" | "block_action" | "wait_user" => {
            let action_id = arguments
                .get("action_id")
                .and_then(Value::as_str)
                .ok_or_else(|| ApiError::bad_request("task_update missing action_id"))?;
            let updates = updates_for_action_mode(mode, arguments)?;
            let (task, action, actions) = update_task_action_record(
                storage,
                user_id,
                task_id,
                action_id,
                &updates,
                Some(mode),
            )
            .await?;
            Ok(json!({
                "ok": true,
                "mode": mode,
                "target": "task",
                "task": task,
                "action": action,
                "actions": actions,
                "message": "Task action updated."
            }))
        }
        "complete_task" => {
            let mut task = load_task(storage, user_id, task_id).await?;
            set_task_status_internal(&mut task, "completed");
            set_field(&mut task, "updated_at", json!(now_iso()));
            storage.upsert_task(user_id, &task).await?;
            disable_task_triggers_for_terminal_task(storage, user_id, task_id, "completed").await?;
            append_task_event(storage, user_id, task_id, "task_completed", json!({})).await?;
            let actions =
                sort_task_actions_for_execution(storage.list_task_actions(user_id, task_id).await?);
            Ok(json!({
                "ok": true,
                "mode": mode,
                "target": "task",
                "task": task,
                "actions": actions,
                "message": "Task completed."
            }))
        }
        _ => Err(ApiError::bad_request("unsupported task_update mode")),
    }
}

async fn update_task_action_record(
    storage: &Storage,
    user_id: &str,
    task_id: &str,
    action_id: &str,
    updates: &Value,
    event_hint: Option<&str>,
) -> Result<(Value, Value, Vec<Value>), ApiError> {
    let task_for_triggers = load_task(storage, user_id, task_id).await?;
    let mut action = load_task_action(storage, user_id, task_id, action_id).await?;
    let previous_status = action
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("confirmed")
        .to_string();
    merge_task_action_updates(&mut action, updates)?;
    let trigger_records = task_trigger_records_from_actions(
        user_id,
        &task_for_triggers,
        std::slice::from_ref(&action),
        &now_iso(),
    )?;
    validate_enabled_task_triggers_have_source_session(&task_for_triggers, &trigger_records)?;
    storage
        .upsert_task_action(user_id, task_id, &action)
        .await?;
    persist_new_task_trigger_records(storage, user_id, &task_for_triggers, &trigger_records)
        .await?;
    let new_status = action
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or(previous_status.as_str())
        .to_string();
    let event_type = event_hint
        .and_then(event_type_for_task_update_mode)
        .or_else(|| event_type_for_action_status_change(&previous_status, &new_status));
    if let Some(event_type) = event_type {
        append_task_event(
            storage,
            user_id,
            task_id,
            event_type,
            json!({
                "action_id": action_id,
                "status": new_status,
                "updates": updates
            }),
        )
        .await?;
    }
    let task = refresh_task_progress(storage, user_id, task_id).await?;
    let actions =
        sort_task_actions_for_execution(storage.list_task_actions(user_id, task_id).await?);
    Ok((task, action, actions))
}

fn updates_for_action_mode(mode: &str, arguments: &Value) -> Result<Value, ApiError> {
    let mut updates = arguments
        .get("updates")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let Some(object) = updates.as_object_mut() else {
        return Err(ApiError::bad_request(
            "task_update updates must be an object",
        ));
    };
    match mode {
        "start_action" => {
            object.insert("status".to_string(), json!("in_progress"));
        }
        "complete_action" => {
            object.insert("status".to_string(), json!("completed"));
            if let Some(summary) = arguments.get("result_summary").cloned() {
                object.insert("result_summary".to_string(), summary);
            }
        }
        "block_action" => {
            object.insert("status".to_string(), json!("blocked"));
            if let Some(reason) = arguments
                .get("reason")
                .or_else(|| arguments.get("last_error"))
                .cloned()
            {
                object.insert("last_error".to_string(), reason);
            }
        }
        "wait_user" => {
            object.insert("status".to_string(), json!("waiting_user"));
            if let Some(reason) = arguments.get("reason").cloned() {
                object.insert("waiting_reason".to_string(), reason);
            }
        }
        _ => {}
    }
    Ok(updates)
}

fn merge_task_action_updates(action: &mut Value, input: &Value) -> Result<(), ApiError> {
    let Some(updates) = input.as_object() else {
        return Err(ApiError::bad_request(
            "task action update payload must be an object",
        ));
    };
    for (key, value) in updates {
        if matches!(
            key.as_str(),
            "task_id" | "action_id" | "user_id" | "created_at"
        ) {
            continue;
        }
        if key == "status" {
            let next = value
                .as_str()
                .ok_or_else(|| ApiError::bad_request("task action status must be a string"))?;
            transition_action_status(action, next)?;
        } else if key == "title" {
            let Some(title) = value
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                return Err(ApiError::bad_request("task action title cannot be empty"));
            };
            set_field(action, key, json!(title));
        } else {
            set_field(action, key, value.clone());
        }
    }
    set_field(action, "updated_at", json!(now_iso()));
    normalize_action_wakeup_fields(action);
    Ok(())
}

fn normalize_action_wakeup_fields(action: &mut Value) {
    if action
        .get("next_wakeup_at")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
    {
        return;
    }
    if let Some(due_at) = action
        .get("due_at")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
    {
        set_field(action, "next_wakeup_at", json!(due_at));
        return;
    }
    if let Some(wakeup_at) = relative_action_wakeup_at(action) {
        set_field(action, "next_wakeup_at", json!(wakeup_at));
    }
}

fn relative_action_wakeup_at(action: &Value) -> Option<String> {
    let seconds = action
        .get("due_in_seconds")
        .and_then(|value| {
            value.as_i64().or_else(|| {
                value
                    .as_str()
                    .and_then(|text| text.trim().parse::<i64>().ok())
            })
        })
        .filter(|value| *value >= 0)?;
    let base = action
        .get("created_at")
        .or_else(|| action.get("updated_at"))
        .and_then(Value::as_str)
        .and_then(|value| OffsetDateTime::parse(value, &Rfc3339).ok())?;
    base.checked_add(time::Duration::seconds(seconds))?
        .format(&Rfc3339)
        .ok()
}

fn task_is_not_runnable(task: &Value) -> bool {
    matches!(
        task.get("status").and_then(Value::as_str),
        Some("candidate" | "completed" | "cancelled" | "archived")
    )
}

fn action_wakeup_at(action: &Value) -> Option<&str> {
    action
        .get("next_wakeup_at")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            action
                .get("due_at")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
}

fn sort_task_actions_for_execution(mut actions: Vec<Value>) -> Vec<Value> {
    actions.sort_by(|a, b| action_execution_key(a).cmp(&action_execution_key(b)));
    actions
}

fn action_execution_key(action: &Value) -> (u64, String, String, String) {
    (
        action_sequence_index(action),
        action_text_field(action, "created_at"),
        action_text_field(action, "updated_at"),
        action_text_field(action, "action_id"),
    )
}

fn action_sequence_index(action: &Value) -> u64 {
    action_u64_field(action, "sequence_index")
        .or_else(|| action_u64_field(action, "sequence"))
        .unwrap_or(u64::MAX)
}

fn action_text_field(action: &Value, key: &str) -> String {
    action
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn action_u64_field(action: &Value, key: &str) -> Option<u64> {
    action.get(key).and_then(|value| {
        value.as_u64().or_else(|| {
            value
                .as_str()
                .and_then(|text| text.trim().parse::<u64>().ok())
        })
    })
}

fn action_run_count(action: &Value) -> u64 {
    action_u64_field(action, "run_count").unwrap_or(0)
}

fn action_max_runs(action: &Value) -> Option<u64> {
    action_u64_field(action, "max_runs").map(|value| value.max(1))
}

fn should_complete_action_after_run(action: &Value, next_run_count: u64) -> bool {
    action_max_runs(action).map_or(true, |max_runs| next_run_count >= max_runs)
}

fn action_dependency_ids(action: &Value) -> Vec<String> {
    let Some(value) = action
        .get("depends_on_action_ids")
        .or_else(|| action.get("depends_on"))
        .or_else(|| action.get("dependencies"))
    else {
        return Vec::new();
    };
    if let Some(items) = value.as_array() {
        return items
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect();
    }
    value
        .as_str()
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(|item| vec![item.to_string()])
        .unwrap_or_default()
}

fn action_dependencies_satisfied(action: &Value, actions: &[Value]) -> bool {
    unsatisfied_action_dependency_ids(action, actions).is_empty()
}

fn unsatisfied_action_dependency_ids(action: &Value, actions: &[Value]) -> Vec<String> {
    action_dependency_ids(action)
        .into_iter()
        .filter(|dependency_id| {
            !actions.iter().any(|candidate| {
                candidate.get("action_id").and_then(Value::as_str) == Some(dependency_id.as_str())
                    && candidate.get("status").and_then(Value::as_str) == Some("completed")
            })
        })
        .collect()
}

fn action_is_runnable(action: &Value, actions: &[Value]) -> bool {
    action
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("confirmed")
        == "confirmed"
        && action_dependencies_satisfied(action, actions)
}

pub(crate) async fn task_action_dependency_wait_reason(
    storage: &Storage,
    user_id: &str,
    task_id: &str,
    action_id: &str,
) -> Result<Option<String>, ApiError> {
    let actions =
        sort_task_actions_for_execution(storage.list_task_actions(user_id, task_id).await?);
    let Some(action) = actions
        .iter()
        .find(|action| action.get("action_id").and_then(Value::as_str) == Some(action_id))
    else {
        return Ok(None);
    };
    if action.get("status").and_then(Value::as_str) != Some("confirmed") {
        return Ok(None);
    }
    let waiting_for = unsatisfied_action_dependency_ids(action, &actions);
    if waiting_for.is_empty() {
        Ok(None)
    } else {
        Ok(Some(format!(
            "Waiting for dependencies: {}",
            waiting_for.join(", ")
        )))
    }
}

fn parse_datetime(value: &str) -> Result<OffsetDateTime, ApiError> {
    OffsetDateTime::parse(value, &Rfc3339)
        .map(|value| value.to_offset(time::UtcOffset::UTC))
        .map_err(|_| ApiError::bad_request("invalid datetime"))
}

fn iso_datetime(value: OffsetDateTime) -> Result<String, ApiError> {
    value
        .format(&Rfc3339)
        .map_err(|_| ApiError::bad_request("invalid datetime"))
}

async fn refresh_task_progress(
    storage: &Storage,
    user_id: &str,
    task_id: &str,
) -> Result<Value, ApiError> {
    let mut task = load_task(storage, user_id, task_id).await?;
    let previous_status = task
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("active")
        .to_string();
    let actions =
        sort_task_actions_for_execution(storage.list_task_actions(user_id, task_id).await?);
    let total = actions.len() as u64;
    let completed = actions
        .iter()
        .filter(|action| action.get("status").and_then(Value::as_str) == Some("completed"))
        .count() as u64;
    let current = current_action_for_progress(&actions);
    let percent = if total == 0 {
        0
    } else {
        (completed * 100) / total
    };
    let mut progress = json!({
        "completed": completed,
        "total": total,
        "percent": percent
    });
    if let Some(current) = current {
        if let Some(object) = progress.as_object_mut() {
            object.insert(
                "current_action_id".to_string(),
                current.get("action_id").cloned().unwrap_or(Value::Null),
            );
            object.insert(
                "current_action_title".to_string(),
                current.get("title").cloned().unwrap_or(Value::Null),
            );
        }
    }
    set_field(&mut task, "progress", progress);
    if total > 0 && completed == total {
        set_task_status_internal(&mut task, "completed");
    } else if actions
        .iter()
        .any(|action| action.get("status").and_then(Value::as_str) == Some("in_progress"))
    {
        set_task_status_internal(&mut task, "in_progress");
    } else if actions
        .iter()
        .any(|action| action.get("status").and_then(Value::as_str) == Some("waiting_user"))
    {
        set_task_status_internal(&mut task, "waiting_user");
    } else if actions
        .iter()
        .any(|action| action.get("status").and_then(Value::as_str) == Some("blocked"))
    {
        set_task_status_internal(&mut task, "blocked");
    } else if completed > 0 && completed < total && task_trigger_values(&task).is_empty() {
        set_task_status_internal(&mut task, "in_progress");
    } else if !matches!(
        previous_status.as_str(),
        "candidate" | "cancelled" | "archived"
    ) {
        set_task_status_internal(&mut task, "active");
    }
    set_field(&mut task, "updated_at", json!(now_iso()));
    storage.upsert_task(user_id, &task).await?;
    if previous_status != "completed"
        && task.get("status").and_then(Value::as_str) == Some("completed")
    {
        append_task_event(storage, user_id, task_id, "task_completed", json!({})).await?;
    }
    Ok(task)
}

fn current_action_for_progress(actions: &[Value]) -> Option<&Value> {
    let mut action_refs = actions.iter().collect::<Vec<_>>();
    action_refs.sort_by(|a, b| action_execution_key(a).cmp(&action_execution_key(b)));
    for status in [
        "in_progress",
        "waiting_user",
        "blocked",
        "confirmed",
        "candidate",
    ] {
        if let Some(action) = action_refs
            .iter()
            .copied()
            .find(|action| action.get("status").and_then(Value::as_str) == Some(status))
        {
            return Some(action);
        }
    }
    None
}

fn task_list_response(
    state: &AppState,
    user_id: &str,
    records: Vec<Value>,
    query: &ListQuery,
) -> Result<Value, ApiError> {
    let total = records.len();
    let (items, next_cursor) = paginate(records, query)?;
    Ok(json!({
        "tasks": public_values(state, user_id, items),
        "count": total,
        "next_cursor": next_cursor
    }))
}

fn task_record_from_payload(
    payload: &Value,
    user_id: &str,
    default_session_id: Option<&str>,
    now: &str,
) -> Result<Value, ApiError> {
    let Some(input) = payload.as_object() else {
        return Err(ApiError::bad_request("task payload must be an object"));
    };
    let title = input
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::bad_request("task title is required"))?;
    let task_id = input
        .get("task_id")
        .and_then(Value::as_str)
        .map(stable_id)
        .unwrap_or_else(|| generated_id("task"));
    let requires_confirmation = input
        .get("requires_confirmation")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let status = input
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or(if requires_confirmation {
            "candidate"
        } else {
            "active"
        });
    validate_task_status(status)?;

    let mut record = input.clone();
    record.remove("actions");
    record.insert("user_id".to_string(), json!(user_id));
    record.insert("task_id".to_string(), json!(task_id));
    record.insert("title".to_string(), json!(title));
    record
        .entry("objective".to_string())
        .or_insert_with(|| json!(title));
    record.insert("status".to_string(), json!(status));
    record
        .entry("priority".to_string())
        .or_insert_with(|| json!("normal"));
    record
        .entry("requires_confirmation".to_string())
        .or_insert_with(|| json!(requires_confirmation));
    if !record.contains_key("source_session_id") {
        if let Some(session_id) = default_session_id {
            record.insert("source_session_id".to_string(), json!(session_id));
        }
    }
    record
        .entry("created_at".to_string())
        .or_insert_with(|| json!(now));
    record.insert("updated_at".to_string(), json!(now));
    Ok(Value::Object(record))
}

fn action_record_from_payload(
    payload: &Value,
    user_id: &str,
    task_id: &str,
    task: &Value,
    now: &str,
    default_sequence_index: Option<u64>,
) -> Result<Value, ApiError> {
    let Some(input) = payload.as_object() else {
        return Err(ApiError::bad_request(
            "task action payload must be an object",
        ));
    };
    let title = input
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::bad_request("task action title is required"))?;
    let action_id = input
        .get("action_id")
        .and_then(Value::as_str)
        .map(stable_id)
        .unwrap_or_else(|| generated_id("act"));
    let requires_confirmation = input
        .get("requires_confirmation")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let task_is_candidate = task.get("status").and_then(Value::as_str) == Some("candidate");
    let default_status = if requires_confirmation || task_is_candidate {
        "candidate"
    } else {
        "confirmed"
    };
    let status = input
        .get("status")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|value| *value != "pending")
        .unwrap_or(default_status);
    validate_action_status(status)?;

    let mut record = input.clone();
    record.insert("user_id".to_string(), json!(user_id));
    record.insert("task_id".to_string(), json!(task_id));
    record.insert("action_id".to_string(), json!(action_id));
    record.insert("title".to_string(), json!(title));
    record
        .entry("objective".to_string())
        .or_insert_with(|| json!(title));
    record
        .entry("kind".to_string())
        .or_insert_with(|| json!("next_step"));
    record.insert("status".to_string(), json!(status));
    record
        .entry("assignee".to_string())
        .or_insert_with(|| json!("codex"));
    record
        .entry("requires_confirmation".to_string())
        .or_insert_with(|| json!(requires_confirmation));
    if let Some(sequence_index) = default_sequence_index {
        record
            .entry("sequence_index".to_string())
            .or_insert_with(|| json!(sequence_index));
    }
    if let Some(max_runs) = action_max_runs(&Value::Object(record.clone())) {
        record.insert("max_runs".to_string(), json!(max_runs));
    }
    record
        .entry("run_count".to_string())
        .or_insert_with(|| json!(0));
    if !record.contains_key("source_session_id") {
        if let Some(session_id) = task.get("source_session_id").and_then(Value::as_str) {
            record.insert("source_session_id".to_string(), json!(session_id));
        }
    }
    record
        .entry("created_at".to_string())
        .or_insert_with(|| json!(now));
    record.insert("updated_at".to_string(), json!(now));
    let mut record = Value::Object(record);
    normalize_action_wakeup_fields(&mut record);
    Ok(record)
}

fn task_trigger_records_from_task_and_actions(
    user_id: &str,
    task: &Value,
    actions: &[Value],
    now: &str,
) -> Result<Vec<Value>, ApiError> {
    let mut records = Vec::new();
    for trigger in task_trigger_values(task) {
        records.push(task_trigger_record_from_payload(
            user_id, task, None, trigger, now,
        )?);
    }
    records.extend(task_trigger_records_from_actions(
        user_id, task, actions, now,
    )?);
    Ok(records)
}

fn task_trigger_records_from_actions(
    user_id: &str,
    task: &Value,
    actions: &[Value],
    now: &str,
) -> Result<Vec<Value>, ApiError> {
    let mut records = Vec::new();
    for action in actions {
        for trigger in action_trigger_values(action) {
            records.push(task_trigger_record_from_payload(
                user_id,
                task,
                Some(action),
                trigger,
                now,
            )?);
        }
    }
    Ok(records)
}

fn task_has_source_session(task: &Value) -> bool {
    task.get("source_session_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
}

fn validate_enabled_task_triggers_have_source_session(
    task: &Value,
    triggers: &[Value],
) -> Result<(), ApiError> {
    if triggers.iter().any(|trigger| {
        trigger
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }) && !task_has_source_session(task)
    {
        return Err(ApiError::bad_request(
            "Enabled task trigger requires source_session_id",
        ));
    }
    Ok(())
}

async fn persist_new_task_trigger_records(
    storage: &Storage,
    user_id: &str,
    task: &Value,
    records: &[Value],
) -> Result<(), ApiError> {
    validate_enabled_task_triggers_have_source_session(task, records)?;
    if records.is_empty() {
        return Ok(());
    }
    let existing = storage.list_task_triggers(user_id).await?;
    for record in records {
        if existing
            .iter()
            .any(|stored| task_trigger_record_has_same_id(stored, record))
        {
            storage.upsert_task_trigger(user_id, record).await?;
            continue;
        }
        if existing
            .iter()
            .any(|stored| task_trigger_record_matches_identity(stored, record))
        {
            continue;
        }
        storage.upsert_task_trigger(user_id, record).await?;
    }
    Ok(())
}

fn task_trigger_record_has_same_id(existing: &Value, record: &Value) -> bool {
    existing.get("trigger_id").and_then(Value::as_str)
        == record.get("trigger_id").and_then(Value::as_str)
}

fn task_trigger_record_matches_identity(existing: &Value, record: &Value) -> bool {
    const KEYS: &[&str] = &[
        "task_id",
        "task_action_id",
        "title",
        "prompt",
        "kind",
        "timezone",
        "run_at",
        "interval_seconds",
    ];
    if task_trigger_type_for_value(existing) != task_trigger_type_for_value(record) {
        return false;
    }
    KEYS.iter()
        .all(|key| existing.get(*key) == record.get(*key))
}

fn task_trigger_type_for_value(record: &Value) -> &str {
    record
        .get("trigger_type")
        .or_else(|| record.get("triggerType"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("time")
}

fn task_trigger_values(task: &Value) -> Vec<&Value> {
    let mut triggers = Vec::new();
    if let Some(trigger) = task.get("trigger").filter(|value| value.is_object()) {
        triggers.push(trigger);
    }
    if let Some(values) = task.get("triggers").and_then(Value::as_array) {
        triggers.extend(values.iter().filter(|value| value.is_object()));
    }
    triggers
}

fn action_trigger_values(action: &Value) -> Vec<&Value> {
    let mut triggers = Vec::new();
    if let Some(trigger) = action.get("trigger").filter(|value| value.is_object()) {
        triggers.push(trigger);
    }
    if let Some(values) = action.get("triggers").and_then(Value::as_array) {
        triggers.extend(values.iter().filter(|value| value.is_object()));
    }
    triggers
}

fn task_trigger_record_from_payload(
    user_id: &str,
    task: &Value,
    action: Option<&Value>,
    trigger: &Value,
    now: &str,
) -> Result<Value, ApiError> {
    let task_id = task
        .get("task_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("task trigger missing task_id"))?;
    let action_id = action.and_then(|action| action.get("action_id").and_then(Value::as_str));
    let trigger_type = task_trigger_type_for_value(trigger);
    let kind = trigger
        .get("kind")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            if trigger.get("interval_seconds").is_some() {
                "interval"
            } else {
                "once"
            }
        });
    if !matches!(kind, "once" | "interval") {
        return Err(ApiError::bad_request(
            "task trigger kind must be one of: once, interval",
        ));
    }
    if trigger_type != "time" {
        return Err(ApiError::bad_request(
            "task trigger trigger_type must be one of: time",
        ));
    }
    let timezone = trigger
        .get("timezone")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("UTC");
    let run_at = trigger
        .get("run_at")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| parse_datetime(value).and_then(|parsed| iso_datetime(parsed)))
        .transpose()?;
    let interval_seconds = trigger
        .get("interval_seconds")
        .and_then(Value::as_u64)
        .or_else(|| {
            trigger
                .get("interval_seconds")
                .and_then(Value::as_str)
                .and_then(|value| value.trim().parse::<u64>().ok())
        });
    if kind == "once" && run_at.is_none() {
        return Err(ApiError::bad_request(
            "run_at is required for once task triggers",
        ));
    }
    if kind == "interval" && interval_seconds.is_none() {
        return Err(ApiError::bad_request(
            "interval_seconds is required for interval task triggers",
        ));
    }
    let requested_enabled = trigger
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let needs_confirmation = task.get("status").and_then(Value::as_str) == Some("candidate")
        || task
            .get("requires_confirmation")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || action.is_some_and(|action| {
            action.get("status").and_then(Value::as_str) == Some("candidate")
                || action
                    .get("requires_confirmation")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
        });
    let enabled = requested_enabled && !needs_confirmation;
    let now_dt = parse_datetime(now)?;
    let next_run_at = if enabled {
        compute_task_trigger_next_run_at(kind, run_at.as_deref(), interval_seconds, now_dt)?
    } else {
        None
    };
    let title = trigger
        .get("title")
        .and_then(Value::as_str)
        .or_else(|| action.and_then(|action| action.get("title").and_then(Value::as_str)))
        .or_else(|| task.get("title").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::bad_request("task trigger title is required"))?;
    let prompt = trigger
        .get("prompt")
        .and_then(Value::as_str)
        .or_else(|| action.and_then(|action| action.get("objective").and_then(Value::as_str)))
        .or_else(|| action.and_then(|action| action.get("description").and_then(Value::as_str)))
        .or_else(|| action.and_then(|action| action.get("title").and_then(Value::as_str)))
        .or_else(|| task.get("objective").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::bad_request("task trigger prompt is required"))?;
    let max_runtime_seconds = trigger
        .get("max_runtime_seconds")
        .and_then(Value::as_u64)
        .unwrap_or(1800)
        .clamp(1, 86_400);
    let max_runs = trigger.get("max_runs").and_then(Value::as_u64);
    let output_schema = trigger
        .get("output_schema")
        .or_else(|| trigger.get("outputSchema"))
        .cloned()
        .unwrap_or(Value::Null);

    Ok(json!({
        "trigger_id": generated_id("trg"),
        "user_id": user_id,
        "trigger_type": trigger_type,
        "title": title,
        "prompt": prompt,
        "kind": kind,
        "timezone": timezone,
        "run_at": run_at,
        "interval_seconds": interval_seconds,
        "enabled": enabled,
        "status": if needs_confirmation {
            "pending_confirmation"
        } else if enabled {
            "active"
        } else {
            "paused"
        },
        "next_run_at": next_run_at,
        "last_run_at": Value::Null,
        "last_run_id": Value::Null,
        "last_error": Value::Null,
        "failure_reason": Value::Null,
        "last_run_status": Value::Null,
        "missed_run_policy": trigger_string(trigger, "missed_run_policy", "run_once"),
        "overlap_policy": trigger_string(trigger, "overlap_policy", "skip"),
        "failure_policy": trigger_string(trigger, "failure_policy", "pause"),
        "cwd": trigger_optional_string_value(trigger, "cwd"),
        "model": trigger_optional_string_value(trigger, "model"),
        "effort": trigger_optional_string_value(trigger, "effort"),
        "summary": trigger_optional_string_value(trigger, "summary"),
        "output_schema": output_schema,
        "max_runtime_seconds": max_runtime_seconds,
        "max_runs": max_runs,
        "task_id": task_id,
        "task_action_id": action_id,
        "enable_on_confirm": requested_enabled,
        "run_count": 0,
        "created_at": now,
        "updated_at": now
    }))
}

async fn activate_pending_task_triggers(
    storage: &Storage,
    user_id: &str,
    task_id: &str,
) -> Result<(), ApiError> {
    let now = now_iso();
    let now_dt = parse_datetime(&now)?;
    for mut trigger in storage.list_task_triggers(user_id).await? {
        if trigger.get("task_id").and_then(Value::as_str) != Some(task_id) {
            continue;
        }
        if trigger.get("status").and_then(Value::as_str) != Some("pending_confirmation") {
            continue;
        }
        let enable_on_confirm = trigger
            .get("enable_on_confirm")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        if enable_on_confirm {
            let kind = trigger
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("once");
            let run_at = trigger.get("run_at").and_then(Value::as_str);
            let interval_seconds = trigger
                .get("interval_seconds")
                .and_then(Value::as_u64)
                .or_else(|| {
                    trigger
                        .get("interval_seconds")
                        .and_then(Value::as_str)
                        .and_then(|value| value.trim().parse::<u64>().ok())
                });
            let next_run_at =
                compute_task_trigger_next_run_at(kind, run_at, interval_seconds, now_dt)?;
            set_field(&mut trigger, "enabled", json!(true));
            set_field(&mut trigger, "status", json!("active"));
            set_field(
                &mut trigger,
                "next_run_at",
                next_run_at.map(Value::String).unwrap_or(Value::Null),
            );
        } else {
            set_field(&mut trigger, "enabled", json!(false));
            set_field(&mut trigger, "status", json!("paused"));
            set_field(&mut trigger, "next_run_at", Value::Null);
        }
        if let Some(object) = trigger.as_object_mut() {
            object.remove("enable_on_confirm");
        }
        set_field(&mut trigger, "updated_at", json!(now));
        storage.upsert_task_trigger(user_id, &trigger).await?;
    }
    Ok(())
}

async fn disable_task_triggers_for_terminal_task(
    storage: &Storage,
    user_id: &str,
    task_id: &str,
    status: &str,
) -> Result<(), ApiError> {
    let now = now_iso();
    for mut trigger in storage.list_task_triggers(user_id).await? {
        if trigger.get("task_id").and_then(Value::as_str) != Some(task_id) {
            continue;
        }
        set_field(&mut trigger, "enabled", json!(false));
        set_field(&mut trigger, "status", json!(status));
        set_field(&mut trigger, "next_run_at", Value::Null);
        set_field(&mut trigger, "updated_at", json!(now));
        storage.upsert_task_trigger(user_id, &trigger).await?;
    }
    Ok(())
}

fn compute_task_trigger_next_run_at(
    kind: &str,
    run_at: Option<&str>,
    interval_seconds: Option<u64>,
    now: OffsetDateTime,
) -> Result<Option<String>, ApiError> {
    if kind == "once" {
        let Some(run_at) = run_at else {
            return Err(ApiError::bad_request(
                "run_at is required for once task triggers",
            ));
        };
        return Ok(Some(run_at.to_string()));
    }
    let interval_seconds = interval_seconds.ok_or_else(|| {
        ApiError::bad_request("interval_seconds is required for interval task triggers")
    })?;
    let mut next = match run_at {
        Some(run_at) => parse_datetime(run_at)?,
        None => now + TimeDuration::seconds(interval_seconds as i64),
    };
    while next <= now {
        next += TimeDuration::seconds(interval_seconds as i64);
    }
    Ok(Some(iso_datetime(next)?))
}

fn trigger_string(trigger: &Value, key: &str, fallback: &str) -> String {
    trigger
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn trigger_optional_string_value(trigger: &Value, key: &str) -> Value {
    trigger
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| json!(value))
        .unwrap_or(Value::Null)
}

fn merge_task_updates(task: &mut Value, input: &Value) -> Result<(), ApiError> {
    let Some(updates) = input.as_object() else {
        return Err(ApiError::bad_request(
            "task update payload must be an object",
        ));
    };
    if !task.is_object() {
        return Err(ApiError::bad_request("stored task record is invalid"));
    }
    for (key, value) in updates {
        if matches!(
            key.as_str(),
            "task_id" | "user_id" | "created_at" | "actions"
        ) {
            continue;
        }
        if key == "status" {
            let next = value
                .as_str()
                .ok_or_else(|| ApiError::bad_request("task status must be a string"))?;
            transition_task_status(task, next)?;
        } else if key == "title" {
            let Some(title) = value
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                return Err(ApiError::bad_request("task title cannot be empty"));
            };
            set_field(task, key, json!(title));
        } else {
            set_field(task, key, value.clone());
        }
    }
    set_field(task, "updated_at", json!(now_iso()));
    Ok(())
}

fn validate_task_status(status: &str) -> Result<(), ApiError> {
    if matches!(
        status,
        "candidate"
            | "active"
            | "in_progress"
            | "waiting_user"
            | "blocked"
            | "completed"
            | "cancelled"
            | "archived"
    ) {
        Ok(())
    } else {
        Err(ApiError::bad_request(format!(
            "invalid task status: {status}"
        )))
    }
}

fn validate_action_status(status: &str) -> Result<(), ApiError> {
    if matches!(
        status,
        "candidate"
            | "confirmed"
            | "in_progress"
            | "waiting_user"
            | "blocked"
            | "completed"
            | "cancelled"
    ) {
        Ok(())
    } else {
        Err(ApiError::bad_request(format!(
            "invalid task action status: {status}"
        )))
    }
}

fn transition_task_status(task: &mut Value, next: &str) -> Result<(), ApiError> {
    validate_task_status(next)?;
    let current = task
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("active");
    if current == next || allowed_task_transition(current, next) {
        set_field(task, "status", json!(next));
        Ok(())
    } else {
        Err(ApiError::bad_request(format!(
            "invalid task status transition: {current} -> {next}"
        )))
    }
}

fn transition_action_status(action: &mut Value, next: &str) -> Result<(), ApiError> {
    validate_action_status(next)?;
    let current = action
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("confirmed");
    if current == next || allowed_action_transition(current, next) {
        set_field(action, "status", json!(next));
        Ok(())
    } else {
        Err(ApiError::bad_request(format!(
            "invalid task action status transition: {current} -> {next}"
        )))
    }
}

fn allowed_task_transition(current: &str, next: &str) -> bool {
    matches!(
        (current, next),
        ("candidate", "active")
            | ("candidate", "cancelled")
            | ("active", "in_progress")
            | ("active", "cancelled")
            | ("in_progress", "waiting_user")
            | ("in_progress", "blocked")
            | ("in_progress", "completed")
            | ("in_progress", "cancelled")
            | ("waiting_user", "in_progress")
            | ("waiting_user", "cancelled")
            | ("blocked", "in_progress")
            | ("blocked", "cancelled")
            | ("completed", "archived")
            | ("cancelled", "archived")
    )
}

fn allowed_action_transition(current: &str, next: &str) -> bool {
    matches!(
        (current, next),
        ("candidate", "confirmed")
            | ("candidate", "cancelled")
            | ("confirmed", "in_progress")
            | ("confirmed", "completed")
            | ("confirmed", "blocked")
            | ("confirmed", "cancelled")
            | ("in_progress", "completed")
            | ("in_progress", "confirmed")
            | ("in_progress", "waiting_user")
            | ("in_progress", "blocked")
            | ("in_progress", "cancelled")
            | ("waiting_user", "in_progress")
            | ("waiting_user", "cancelled")
            | ("blocked", "in_progress")
            | ("blocked", "cancelled")
    )
}

fn set_task_status_internal(task: &mut Value, next: &str) {
    set_field(task, "status", json!(next));
}

fn event_type_for_task_update_mode(mode: &str) -> Option<&'static str> {
    match mode {
        "start_action" => Some("task_action_started"),
        "complete_action" => Some("task_action_completed"),
        "block_action" => Some("task_action_blocked"),
        "wait_user" => Some("task_action_waiting_user"),
        "update_action" => Some("task_action_updated"),
        _ => None,
    }
}

fn event_type_for_action_status_change(previous: &str, next: &str) -> Option<&'static str> {
    if previous == next {
        return Some("task_action_updated");
    }
    match next {
        "in_progress" => Some("task_action_started"),
        "completed" => Some("task_action_completed"),
        "blocked" => Some("task_action_blocked"),
        "waiting_user" => Some("task_action_waiting_user"),
        "cancelled" => Some("task_action_cancelled"),
        _ => Some("task_action_updated"),
    }
}

async fn load_task(storage: &Storage, user_id: &str, task_id: &str) -> Result<Value, ApiError> {
    storage
        .get_task(user_id, task_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Task not found"))
}

async fn load_task_action(
    storage: &Storage,
    user_id: &str,
    task_id: &str,
    action_id: &str,
) -> Result<Value, ApiError> {
    storage
        .list_task_actions(user_id, task_id)
        .await?
        .into_iter()
        .find(|record| record.get("action_id").and_then(Value::as_str) == Some(action_id))
        .ok_or_else(|| ApiError::not_found("Task action not found"))
}

async fn require_session(
    state: &AppState,
    user_id: &str,
    session_id: &str,
) -> Result<(), ApiError> {
    if state.sessions.load(user_id, session_id).await?.is_some() {
        Ok(())
    } else {
        Err(ApiError::not_found("Session not found"))
    }
}

async fn execute_task_action(
    state: &AppState,
    user_id: &str,
    task_id: &str,
    action_id: Option<&str>,
) -> Result<AgentRunInfo, ApiError> {
    execute_task_action_inner(state, user_id, task_id, action_id, None).await
}

pub(crate) async fn execute_task_action_for_trigger(
    state: &AppState,
    user_id: &str,
    task_id: &str,
    action_id: Option<&str>,
    trigger: TaskRunTriggerContext,
) -> Result<AgentRunInfo, ApiError> {
    execute_task_action_inner(state, user_id, task_id, action_id, Some(&trigger)).await
}

async fn execute_task_action_inner(
    state: &AppState,
    user_id: &str,
    task_id: &str,
    action_id: Option<&str>,
    trigger: Option<&TaskRunTriggerContext>,
) -> Result<AgentRunInfo, ApiError> {
    let task = load_task(&state.storage, user_id, task_id).await?;
    let status = task
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("active");
    if status == "candidate" {
        return Err(ApiError::bad_request(
            "Task must be confirmed before it can run.",
        ));
    }
    if matches!(status, "completed" | "cancelled" | "archived") {
        return Err(ApiError::bad_request(format!(
            "Task cannot run while status is {status}."
        )));
    }
    let session_id = task
        .get("source_session_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ApiError::bad_request("Task run-now requires source_session_id"))?;
    let session_run_lock = state.sessions.session_lock(user_id, &session_id);
    let _session_run_guard = session_run_lock.lock_owned().await;
    let mut session = state
        .sessions
        .load(user_id, &session_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Session not found"))?;
    if session.status_kind().is_busy() || session.status_kind().is_awaiting_approval() {
        return Err(ApiError::conflict("Session already has work in progress"));
    }
    let action = match action_id {
        Some(action_id) => {
            load_runnable_task_action(&state.storage, user_id, task_id, action_id).await?
        }
        None => ensure_runnable_action(&state.storage, user_id, task_id, &task).await?,
    };
    let action_id = action
        .get("action_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("Task action missing action_id"))?
        .to_string();

    let workspace_root = state.sandboxes.ensure_sandbox(user_id)?;
    let runtime_dir = state.sandboxes.session_dir(user_id, &session_id)?;
    let max_runtime_seconds = trigger
        .and_then(|trigger| trigger.max_runtime_seconds)
        .unwrap_or(state.config.codex.max_runtime_seconds);
    assert_can_create_run(state, user_id, max_runtime_seconds).await?;
    let (task, action, actions) = update_task_action_record(
        &state.storage,
        user_id,
        task_id,
        &action_id,
        &json!({"status": "in_progress"}),
        Some("start_action"),
    )
    .await?;
    let trigger_prompt = trigger
        .and_then(|trigger| trigger.prompt.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let prompt = task_run_prompt(&task, &action, &actions, trigger_prompt);
    let selected_model = trigger
        .and_then(|trigger| trigger.model.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(session.model.as_str());
    let (model, preset_effort) = state.config.resolve_model(Some(selected_model));
    let effort = trigger
        .and_then(|trigger| trigger.effort.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or(preset_effort);
    let cwd = trigger
        .and_then(|trigger| trigger.cwd.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("/workspace")
        .to_string();
    let summary = trigger
        .and_then(|trigger| trigger.summary.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let output_schema = trigger
        .and_then(|trigger| trigger.output_schema.clone())
        .filter(|value| !value.is_null());
    let create = AgentRunCreateRequest {
        prompt: prompt.clone(),
        provider: "codex".to_string(),
        base_instructions: None,
        turn_context: None,
        cwd: Some(cwd),
        input_items: vec![json!({"type": "text", "text": prompt.clone()})],
        model: Some(model),
        effort,
        summary,
        output_schema,
        max_runtime_seconds,
        task_trigger_id: trigger.map(|trigger| trigger.trigger_id.clone()),
        task_trigger_title: trigger.map(|trigger| trigger.task_trigger_title.clone()),
        task_trigger_reason: trigger.map(|trigger| trigger.task_trigger_reason.clone()),
        codex_thread_id: session.codex_thread_id.clone(),
        codex_persistent_thread: true,
        chat_user_input: Some(prompt.clone()),
        chat_user_content: None,
    };
    let info = match state
        .jobs
        .start(
            create,
            user_id.to_string(),
            Some(session_id.clone()),
            workspace_root,
            runtime_dir,
        )
        .await
    {
        Ok(info) => info,
        Err(err) => {
            let message = err.to_string();
            let _ = update_task_action_record(
                &state.storage,
                user_id,
                task_id,
                &action_id,
                &json!({
                    "status": "blocked",
                    "last_error": message
                }),
                Some("block_action"),
            )
            .await;
            return Err(ApiError::bad_request(message));
        }
    };
    session.set_status(SessionStatus::Running);
    if let Err(err) = state.sessions.save_record_if_exists(session.clone()).await {
        let message = format!("{err:?}");
        let _ = update_task_action_record(
            &state.storage,
            user_id,
            task_id,
            &action_id,
            &json!({
                "status": "blocked",
                "last_error": message
            }),
            Some("block_action"),
        )
        .await;
        return Err(err.into());
    }
    append_task_event(
        &state.storage,
        user_id,
        task_id,
        "task_run_started",
        json!({
            "action_id": action_id,
            "run_id": info.job_id
        }),
    )
    .await?;

    let final_info = match wait_for_task_run(
        state,
        user_id,
        task_id,
        &session_id,
        &info.job_id,
        max_runtime_seconds,
    )
    .await
    {
        Ok(info) => info,
        Err(err) => {
            let message = format!("{err:?}");
            let _ = update_task_action_record(
                &state.storage,
                user_id,
                task_id,
                &action_id,
                &json!({
                    "status": "blocked",
                    "last_run_id": info.job_id,
                    "last_error": message
                }),
                Some("block_action"),
            )
            .await;
            session.set_status(SessionStatus::Failed);
            let _ = state.sessions.save_record_if_exists(session).await;
            return Err(err);
        }
    };
    let output_text = read_run_output(&final_info).await;
    record_codex_thread(&mut session, &final_info);
    session.set_status(match final_info.status.as_str() {
        "cancelled" => SessionStatus::Cancelled,
        "failed" => SessionStatus::Failed,
        _ => SessionStatus::Idle,
    });
    if final_info.status == "completed" {
        let result_summary = sanitize_user_visible_text(state, user_id, &output_text);
        if !result_summary.trim().is_empty() {
            append_assistant_message(&mut session, &result_summary);
        }
        let latest_action = load_task_action(&state.storage, user_id, task_id, &action_id).await?;
        let latest_action_status = latest_action
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("confirmed");
        let next_action_run_count = action_run_count(&latest_action).saturating_add(1);
        let complete_action_on_success = trigger
            .and_then(|trigger| trigger.complete_action_on_success)
            .unwrap_or_else(|| {
                should_complete_action_after_run(&latest_action, next_action_run_count)
            });
        let action_result_summary = if output_text.trim().is_empty() {
            "Task run completed.".to_string()
        } else {
            result_summary
        };
        if latest_action_status == "in_progress" {
            if complete_action_on_success {
                let updates = json!({
                    "status": "completed",
                    "last_run_id": final_info.job_id,
                    "run_count": next_action_run_count,
                    "result_summary": action_result_summary
                });
                let _ = update_task_action_record(
                    &state.storage,
                    user_id,
                    task_id,
                    &action_id,
                    &updates,
                    Some("complete_action"),
                )
                .await?;
            } else {
                requeue_task_action_after_recurring_iteration(
                    &state.storage,
                    user_id,
                    task_id,
                    &action_id,
                    &final_info.job_id,
                    &action_result_summary,
                    next_action_run_count,
                )
                .await?;
            }
        } else if latest_action_status == "completed" && !complete_action_on_success {
            requeue_task_action_after_recurring_iteration(
                &state.storage,
                user_id,
                task_id,
                &action_id,
                &final_info.job_id,
                &action_result_summary,
                next_action_run_count,
            )
            .await?;
        } else {
            let _ = update_task_action_record(
                &state.storage,
                user_id,
                task_id,
                &action_id,
                &json!({
                    "last_run_id": final_info.job_id,
                    "run_count": next_action_run_count
                }),
                None,
            )
            .await?;
        }
    } else {
        let error = final_info
            .error
            .clone()
            .unwrap_or_else(|| final_info.status.clone());
        let _ = update_task_action_record(
            &state.storage,
            user_id,
            task_id,
            &action_id,
            &json!({
                "status": "blocked",
                "last_run_id": final_info.job_id,
                "last_error": error
            }),
            Some("block_action"),
        )
        .await?;
    }
    state.sessions.save_record_if_exists(session).await?;
    Ok(final_info)
}

async fn requeue_task_action_after_recurring_iteration(
    storage: &Storage,
    user_id: &str,
    task_id: &str,
    action_id: &str,
    run_id: &str,
    result_summary: &str,
    run_count: u64,
) -> Result<(), ApiError> {
    let mut action = load_task_action(storage, user_id, task_id, action_id).await?;
    set_field(&mut action, "status", json!("confirmed"));
    set_field(&mut action, "last_run_id", json!(run_id));
    set_field(&mut action, "run_count", json!(run_count));
    set_field(&mut action, "result_summary", json!(result_summary));
    set_field(&mut action, "updated_at", json!(now_iso()));
    storage
        .upsert_task_action(user_id, task_id, &action)
        .await?;
    append_task_event(
        storage,
        user_id,
        task_id,
        "task_action_updated",
        json!({
            "action_id": action_id,
            "status": "confirmed",
            "updates": {
                "status": "confirmed",
                "last_run_id": run_id,
                "run_count": run_count,
                "result_summary": result_summary
            }
        }),
    )
    .await?;
    let _ = refresh_task_progress(storage, user_id, task_id).await?;
    Ok(())
}

async fn load_runnable_task_action(
    storage: &Storage,
    user_id: &str,
    task_id: &str,
    action_id: &str,
) -> Result<Value, ApiError> {
    let actions =
        sort_task_actions_for_execution(storage.list_task_actions(user_id, task_id).await?);
    let action = actions
        .iter()
        .find(|record| record.get("action_id").and_then(Value::as_str) == Some(action_id))
        .cloned()
        .ok_or_else(|| ApiError::not_found("Task action not found"))?;
    let status = action
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("confirmed");
    if status != "confirmed" {
        return Err(ApiError::bad_request(format!(
            "Task action cannot run while status is {status}."
        )));
    }
    if !action_dependencies_satisfied(&action, &actions) {
        return Err(ApiError::bad_request(
            "Task action cannot run before its dependencies complete.",
        ));
    }
    Ok(action)
}

async fn ensure_runnable_action(
    storage: &Storage,
    user_id: &str,
    task_id: &str,
    task: &Value,
) -> Result<Value, ApiError> {
    let actions =
        sort_task_actions_for_execution(storage.list_task_actions(user_id, task_id).await?);
    if let Some(action) = actions
        .iter()
        .find(|action| action_is_runnable(action, &actions))
        .cloned()
    {
        return Ok(action);
    }
    if !actions.is_empty() {
        return Err(ApiError::bad_request("No task action is ready to run yet."));
    }
    let now = now_iso();
    let action = action_record_from_payload(
        &json!({
            "action_id": "act-run-task",
            "title": "执行任务",
            "kind": "execute",
            "status": "confirmed"
        }),
        user_id,
        task_id,
        task,
        &now,
        Some(1),
    )?;
    storage
        .upsert_task_action(user_id, task_id, &action)
        .await?;
    append_task_event(
        storage,
        user_id,
        task_id,
        "task_action_created",
        json!({"action_id": "act-run-task"}),
    )
    .await?;
    Ok(action)
}

fn previous_step_results_for_prompt(current_action: &Value, actions: &[Value]) -> String {
    let current_action_id = current_action
        .get("action_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let current_sequence = action_sequence_index(current_action);
    let dependency_ids = action_dependency_ids(current_action)
        .into_iter()
        .collect::<BTreeSet<_>>();
    let mut seen = BTreeSet::new();
    let mut lines = Vec::new();

    for action in sort_task_actions_for_execution(actions.to_vec()) {
        let action_id = action
            .get("action_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        if action_id.is_empty() || action_id == current_action_id {
            continue;
        }
        if action.get("status").and_then(Value::as_str) != Some("completed") {
            continue;
        }
        let is_dependency = dependency_ids.contains(action_id);
        let is_prior_sequence =
            current_sequence != u64::MAX && action_sequence_index(&action) < current_sequence;
        if !is_dependency && !is_prior_sequence {
            continue;
        }
        if !seen.insert(action_id.to_string()) {
            continue;
        }

        let title = action
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Untitled step");
        let objective = action
            .get("objective")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let result_summary = action
            .get("result_summary")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Completed without a saved result summary.");
        let last_run_id = action
            .get("last_run_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());

        let mut line = format!("- Action {action_id}: {title}");
        if let Some(objective) = objective.filter(|objective| *objective != title) {
            line.push_str(&format!("\n  Objective: {objective}"));
        }
        line.push_str(&format!("\n  Result: {result_summary}"));
        if let Some(last_run_id) = last_run_id {
            line.push_str(&format!("\n  Last run: {last_run_id}"));
        }
        lines.push(line);
    }

    if lines.is_empty() {
        "None.".to_string()
    } else {
        lines.join("\n")
    }
}

fn task_run_prompt(
    task: &Value,
    action: &Value,
    actions: &[Value],
    run_instruction: Option<&str>,
) -> String {
    let task_id = task.get("task_id").and_then(Value::as_str).unwrap_or("");
    let task_title = task.get("title").and_then(Value::as_str).unwrap_or("任务");
    let task_objective = task
        .get("objective")
        .and_then(Value::as_str)
        .unwrap_or(task_title);
    let action_id = action
        .get("action_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let action_title = action
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("下一步");
    let action_objective = action
        .get("objective")
        .and_then(Value::as_str)
        .unwrap_or(action_title);
    let run_instruction = run_instruction
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(action_objective);
    let next_action_run_count = action_run_count(action).saturating_add(1);
    let action_run_limit = action_max_runs(action)
        .map(|max_runs| max_runs.to_string())
        .unwrap_or_else(|| "unlimited".to_string());
    let source = task
        .get("source_summary")
        .and_then(Value::as_str)
        .unwrap_or("");
    let previous_results = previous_step_results_for_prompt(action, actions);
    format!(
        "Run this Ripple task.\nTask ID: {task_id}\nTask title: {task_title}\nTask objective: {task_objective}\nCurrent action ID: {action_id}\nCurrent action: {action_title}\nAction objective: {action_objective}\nRun instruction: {run_instruction}\nCurrent action run: {next_action_run_count}/{action_run_limit}\nSource context:\n{source}\n\nPrevious step results:\n{previous_results}\n\nUse `codex_app.task_update` to update this task's progress. Call start_action when beginning, complete_action when done, wait_user when user input is needed, and block_action if blocked. Consider previous step results when they are relevant to the current action, but do not force unrelated parallel work into this step. Return a concise update for the user in the same language as the task."
    )
}

async fn wait_for_task_run(
    state: &AppState,
    user_id: &str,
    task_id: &str,
    session_id: &str,
    job_id: &str,
    max_runtime_seconds: u64,
) -> Result<AgentRunInfo, ApiError> {
    let deadline = Instant::now() + Duration::from_secs(max_runtime_seconds.max(1));
    let mut event_offset = 0_usize;
    loop {
        let Some(info) = state.jobs.info_for_user(job_id, user_id).await? else {
            return Err(ApiError::not_found("Task run not found"));
        };
        if let Some(events_file) = info.events_file.as_deref() {
            for event in read_new_run_events(events_file, &mut event_offset).await {
                if let Some(plan_event) = extract_plan_update_event(&event) {
                    persist_task_plan_update(&state.storage, user_id, task_id, &plan_event).await?;
                }
            }
        }
        if matches!(info.status.as_str(), "completed" | "failed" | "cancelled") {
            return Ok(info);
        }
        if let Some(approval) = info.pending_approval.clone() {
            if let Some(mut session) = state.sessions.load(user_id, session_id).await? {
                session.set_status(SessionStatus::AwaitingPermission);
                session.pending_permission_request = Some(approval.clone());
                let _ = state.sessions.save_record_if_exists(session).await?;
            }
            return Err(ApiError::conflict(json!({
                "message": "Codex approval required",
                "approval": approval
            })));
        }
        if Instant::now() >= deadline {
            return Err(ApiError::bad_request("Task run timed out"));
        }
        sleep(Duration::from_millis(50)).await;
    }
}

async fn read_new_run_events(path: &str, offset: &mut usize) -> Vec<Value> {
    crate::api::read_jsonl_events_from_offset(std::path::Path::new(path), offset).await
}

async fn persist_task_plan_update(
    storage: &Storage,
    user_id: &str,
    task_id: &str,
    plan_event: &Value,
) -> Result<(), ApiError> {
    let mut task = load_task(storage, user_id, task_id).await?;
    if let Some(steps) = plan_event.get("steps").cloned() {
        set_field(&mut task, "plan_steps", steps);
    }
    if let Some(progress) = plan_event.get("progress").cloned() {
        set_field(&mut task, "plan_progress", progress);
    }
    set_field(&mut task, "updated_at", json!(now_iso()));
    storage.upsert_task(user_id, &task).await?;
    append_task_event(
        storage,
        user_id,
        task_id,
        "task_plan_updated",
        json!({"plan": plan_event}),
    )
    .await?;
    Ok(())
}

async fn read_run_output(info: &AgentRunInfo) -> String {
    if let Some(output_file) = info.output_file.as_deref() {
        if let Ok(text) = tokio::fs::read_to_string(output_file).await {
            return text;
        }
    }
    info.stdout_tail.clone()
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

fn append_assistant_message(session: &mut SessionRecord, text: &str) {
    session.messages.push(json!({
        "role": "assistant",
        "content": [{"type": "text", "text": text}],
        "created_at": now_iso()
    }));
    session.message_count = session.messages.len();
    session.last_active = now_iso();
}

pub(crate) async fn append_task_event(
    storage: &Storage,
    user_id: &str,
    task_id: &str,
    event_type: &str,
    details: Value,
) -> Result<(), ApiError> {
    let now = now_iso();
    let record = json!({
        "event_id": generated_id("evt"),
        "task_id": task_id,
        "user_id": user_id,
        "event_type": event_type,
        "payload": details,
        "created_at": now
    });
    storage.upsert_task_event(user_id, task_id, &record).await?;
    Ok(())
}

fn public_task_value(state: &AppState, user_id: &str, value: Value) -> Value {
    sanitize_user_visible_value(state, user_id, &value)
}

fn public_values(state: &AppState, user_id: &str, values: Vec<Value>) -> Vec<Value> {
    values
        .into_iter()
        .map(|value| sanitize_user_visible_value(state, user_id, &value))
        .collect()
}

fn public_task_action_value(state: &AppState, user_id: &str, mut action: Value) -> Value {
    normalize_action_wakeup_fields(&mut action);
    sanitize_user_visible_value(state, user_id, &action)
}

fn public_task_action_values(state: &AppState, user_id: &str, actions: Vec<Value>) -> Vec<Value> {
    sort_task_actions_for_execution(actions)
        .into_iter()
        .map(|action| public_task_action_value(state, user_id, action))
        .collect()
}

fn public_task_action_response(state: &AppState, user_id: &str, action: Value) -> Value {
    json!({
        "action": public_task_action_value(state, user_id, action)
    })
}

fn set_field(record: &mut Value, key: &str, value: Value) {
    if let Some(object) = record.as_object_mut() {
        object.insert(key.to_string(), value);
    }
}

fn generated_id(prefix: &str) -> String {
    format!("{prefix}-{}", &Uuid::new_v4().simple().to_string()[..10])
}

fn stable_id(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return generated_id("id");
    }
    let mut id = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
            id.push(ch);
        } else {
            id.push('-');
        }
    }
    id.trim_matches('-').chars().take(80).collect()
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_storage() -> anyhow::Result<(Storage, std::path::PathBuf)> {
        let root = std::env::temp_dir().join(format!("ripple-tasks-test-{}", Uuid::new_v4()));
        let storage = Storage::open(root.join(".ripple/ripple.sqlite"))?;
        Ok((storage, root))
    }

    #[test]
    fn recurring_action_can_return_to_confirmed_after_iteration() {
        assert!(allowed_action_transition("in_progress", "confirmed"));
    }

    #[test]
    fn task_run_prompt_includes_completed_prior_step_results() {
        let task = json!({
            "task_id": "task-pipeline",
            "title": "Launch report",
            "objective": "Research then write the launch report",
            "source_summary": "User asked for a two-step workflow."
        });
        let first = json!({
            "action_id": "act-research",
            "title": "Research launch facts",
            "objective": "Collect launch facts",
            "status": "completed",
            "sequence_index": 1,
            "result_summary": "Found pricing, launch date, and three risks.",
            "last_run_id": "agent-research"
        });
        let current = json!({
            "action_id": "act-write",
            "title": "Write launch report",
            "objective": "Write the report from the research",
            "status": "confirmed",
            "sequence_index": 2,
            "depends_on_action_ids": ["act-research"]
        });
        let later = json!({
            "action_id": "act-send",
            "title": "Send launch report",
            "objective": "Send the report",
            "status": "completed",
            "sequence_index": 3,
            "result_summary": "Sent the report.",
            "last_run_id": "agent-send"
        });
        let actions = vec![first, current.clone(), later];

        let prompt = task_run_prompt(&task, &current, &actions, None);

        assert!(prompt.contains("Previous step results:"));
        assert!(prompt.contains("act-research"));
        assert!(prompt.contains("Found pricing, launch date, and three risks."));
        assert!(prompt.contains("agent-research"));
        assert!(!prompt.contains("agent-send"));
    }

    #[test]
    fn sequence_index_does_not_block_parallel_action_without_dependencies() {
        let first = json!({
            "action_id": "act-research",
            "status": "in_progress",
            "sequence_index": 1
        });
        let current = json!({
            "action_id": "act-independent",
            "status": "confirmed",
            "sequence_index": 2
        });
        let actions = vec![first, current.clone()];

        assert!(action_is_runnable(&current, &actions));
    }

    #[tokio::test]
    async fn task_update_create_without_action_asks_clarification_without_persisting(
    ) -> anyhow::Result<()> {
        let (storage, root) = temp_storage()?;

        let output = persist_task_update(
            &storage,
            "alice",
            Some("session-1"),
            &json!({
                "mode": "create",
                "target": "task",
                "task": {
                    "task_id": "task-needs-next-step",
                    "title": "跟进项目进展",
                    "objective": "跟进项目进展"
                }
            }),
        )
        .await
        .unwrap_or_else(|err| panic!("task_update should return clarification: {err:?}"));

        assert_eq!(output.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            output.get("code").and_then(Value::as_str),
            Some("task_needs_clarification")
        );
        assert!(
            output
                .get("missing_fields")
                .and_then(Value::as_array)
                .is_some_and(|fields| fields.iter().any(|field| field == "actions")),
            "expected missing actions in {output}"
        );
        assert!(storage
            .get_task("alice", "task-needs-next-step")
            .await?
            .is_none());

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn task_update_propose_with_trigger_missing_time_asks_clarification_without_persisting(
    ) -> anyhow::Result<()> {
        let (storage, root) = temp_storage()?;

        let output = persist_task_update(
            &storage,
            "alice",
            Some("session-1"),
            &json!({
                "mode": "propose",
                "target": "task",
                "task": {
                    "task_id": "task-trigger-missing-time",
                    "title": "检查构建",
                    "objective": "检查构建状态并总结结果",
                    "actions": [
                        {
                            "title": "检查构建状态",
                            "objective": "检查构建状态并总结结果",
                            "trigger": {
                                "kind": "once"
                            }
                        }
                    ]
                }
            }),
        )
        .await
        .unwrap_or_else(|err| panic!("task_update should return clarification: {err:?}"));

        assert_eq!(output.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            output.get("code").and_then(Value::as_str),
            Some("task_needs_clarification")
        );
        assert!(
            output
                .get("missing_fields")
                .and_then(Value::as_array)
                .is_some_and(|fields| fields.iter().any(|field| field == "run_at")),
            "expected missing run_at in {output}"
        );
        assert!(storage
            .get_task("alice", "task-trigger-missing-time")
            .await?
            .is_none());

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn task_update_create_without_goal_asks_clarification_without_persisting(
    ) -> anyhow::Result<()> {
        let (storage, root) = temp_storage()?;

        let output = persist_task_update(
            &storage,
            "alice",
            Some("session-1"),
            &json!({
                "mode": "create",
                "target": "task",
                "task": {
                    "task_id": "task-needs-goal",
                    "actions": [
                        {
                            "title": "检查状态",
                            "objective": "检查状态并总结"
                        }
                    ]
                }
            }),
        )
        .await
        .unwrap_or_else(|err| panic!("task_update should return clarification: {err:?}"));

        assert_eq!(output.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            output.get("code").and_then(Value::as_str),
            Some("task_needs_clarification")
        );
        assert!(
            output
                .get("missing_fields")
                .and_then(Value::as_array)
                .is_some_and(|fields| fields.iter().any(|field| field == "title")),
            "expected missing title in {output}"
        );
        assert!(storage
            .get_task("alice", "task-needs-goal")
            .await?
            .is_none());

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn task_update_create_external_monitor_update_without_details_asks_clarification(
    ) -> anyhow::Result<()> {
        let (storage, root) = temp_storage()?;

        let output = persist_task_update(
            &storage,
            "alice",
            Some("session-1"),
            &json!({
                "mode": "create",
                "target": "task",
                "task": {
                    "task_id": "task-external-update-needs-details",
                    "title": "每日 issue 表格更新",
                    "objective": "每天监控 GitHub issue，如果有新条目就更新 Google Sheets。",
                    "actions": [
                        {
                            "title": "监控 issue 并更新表格",
                            "objective": "每天监控 GitHub issue，如果有新条目就更新 Google Sheets。"
                        }
                    ]
                }
            }),
        )
        .await
        .unwrap_or_else(|err| panic!("task_update should return clarification: {err:?}"));

        assert_eq!(output.get("ok").and_then(Value::as_bool), Some(false));
        assert!(
            output
                .get("missing_fields")
                .and_then(Value::as_array)
                .is_some_and(|fields| fields.iter().any(|field| field == "source_scope")),
            "expected missing source_scope in {output}"
        );
        assert!(storage
            .get_task("alice", "task-external-update-needs-details")
            .await?
            .is_none());

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn task_update_create_with_clear_action_still_persists() -> anyhow::Result<()> {
        let (storage, root) = temp_storage()?;

        let output = persist_task_update(
            &storage,
            "alice",
            Some("session-1"),
            &json!({
                "mode": "create",
                "target": "task",
                "task": {
                    "task_id": "task-clear",
                    "title": "检查构建",
                    "objective": "检查构建状态并总结结果",
                    "actions": [
                        {
                            "action_id": "act-check-build",
                            "title": "检查构建状态",
                            "objective": "检查构建状态并总结结果"
                        }
                    ]
                }
            }),
        )
        .await
        .unwrap_or_else(|err| panic!("task_update should persist clear task: {err:?}"));

        assert_eq!(output.get("ok").and_then(Value::as_bool), Some(true));
        let task = storage
            .get_task("alice", "task-clear")
            .await?
            .expect("task should persist");
        assert_eq!(task.get("status").and_then(Value::as_str), Some("active"));

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn direct_task_creation_can_still_create_task_without_actions() -> anyhow::Result<()> {
        let (storage, root) = temp_storage()?;

        let (task, actions) = create_task_from_payload(
            &storage,
            "alice",
            Some("session-1"),
            &json!({
                "task_id": "task-direct",
                "title": "直接创建任务",
                "objective": "直接创建一个没有预设 action 的任务"
            }),
        )
        .await
        .unwrap_or_else(|err| panic!("direct create should still work: {err:?}"));

        assert_eq!(
            task.get("task_id").and_then(Value::as_str),
            Some("task-direct")
        );
        assert!(actions.is_empty());
        assert!(storage.get_task("alice", "task-direct").await?.is_some());

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn refresh_progress_marks_task_active_when_actions_are_ready() -> anyhow::Result<()> {
        let (storage, root) = temp_storage()?;
        let user_id = "alice";
        let task_id = "task-recurring";

        storage
            .upsert_task(
                user_id,
                &json!({
                    "task_id": task_id,
                    "user_id": user_id,
                    "title": "Check index",
                    "objective": "Check the index repeatedly",
                    "status": "in_progress",
                    "created_at": "2026-06-18T00:00:00Z",
                    "updated_at": "2026-06-18T00:00:00Z"
                }),
            )
            .await?;
        storage
            .upsert_task_action(
                user_id,
                task_id,
                &json!({
                    "action_id": "act-check",
                    "task_id": task_id,
                    "user_id": user_id,
                    "title": "Check index",
                    "objective": "Check the index once",
                    "status": "confirmed",
                    "created_at": "2026-06-18T00:00:00Z",
                    "updated_at": "2026-06-18T00:00:00Z"
                }),
            )
            .await?;

        let task = refresh_task_progress(&storage, user_id, task_id)
            .await
            .expect("refresh task progress");

        assert_eq!(task.get("status").and_then(Value::as_str), Some("active"));
        assert_eq!(
            task.pointer("/progress/completed").and_then(Value::as_u64),
            Some(0)
        );
        assert_eq!(
            task.pointer("/progress/total").and_then(Value::as_u64),
            Some(1)
        );

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }
}
