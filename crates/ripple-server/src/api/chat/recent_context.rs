use serde_json::{json, Value};

use crate::api::run_public::sanitize_user_visible_value;
use crate::api::ApiError;
use crate::state::AppState;

const RECENT_DISPLAY_CONTEXT_MESSAGES: usize = 20;
const RECENT_DISPLAY_CONTEXT_MAX_CHARS: usize = 16_000;
const RECENT_AUTOMATIONS_CONTEXT_LIMIT: usize = 10;
const RECENT_AUTOMATIONS_CONTEXT_MAX_CHARS: usize = 16_000;
const RECENT_AUTOMATION_PROMPT_MAX_CHARS: usize = 1_200;

pub(super) fn recent_display_context(messages: &[Value]) -> Option<String> {
    let mut lines = messages
        .iter()
        .rev()
        .filter_map(display_context_line)
        .take(RECENT_DISPLAY_CONTEXT_MESSAGES)
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return None;
    }
    lines.reverse();
    let joined = lines.join("\n");
    Some(truncate_display_context(&joined))
}

fn display_context_line(message: &Value) -> Option<String> {
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("message")
        .trim();
    let content = message_content_text(message.get("content")?)
        .trim()
        .to_string();
    if content.is_empty() {
        return None;
    }
    Some(format!("{role}: {content}"))
}

fn message_content_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    if let Some(items) = content.as_array() {
        return items
            .iter()
            .filter_map(|item| {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    return Some(text.trim().to_string());
                }
                if item.get("type").and_then(Value::as_str) == Some("attachment") {
                    let name = item
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("attachment");
                    return Some(format!("[attachment: {name}]"));
                }
                None
            })
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
    }
    String::new()
}

fn truncate_display_context(value: &str) -> String {
    truncate_context(value, RECENT_DISPLAY_CONTEXT_MAX_CHARS)
}

pub(super) async fn recent_automations_context(
    state: &AppState,
    user_id: &str,
) -> Result<Option<String>, ApiError> {
    let schedules = state
        .storage
        .list_schedules(user_id)
        .await?
        .into_iter()
        .map(|schedule| sanitize_user_visible_value(state, user_id, &schedule))
        .collect::<Vec<_>>();
    Ok(recent_automations_context_from_schedules(schedules))
}

pub(super) fn recent_automations_context_from_schedules(
    mut schedules: Vec<Value>,
) -> Option<String> {
    schedules.sort_by(|left, right| {
        let right_key = schedule_recency_key(right);
        let left_key = schedule_recency_key(left);
        right_key.cmp(&left_key)
    });
    let automations = schedules
        .into_iter()
        .filter_map(recent_automation_context_value)
        .take(RECENT_AUTOMATIONS_CONTEXT_LIMIT)
        .collect::<Vec<_>>();
    if automations.is_empty() {
        return None;
    }
    let context = serde_json::to_string_pretty(&automations).ok()?;
    Some(truncate_context(
        &context,
        RECENT_AUTOMATIONS_CONTEXT_MAX_CHARS,
    ))
}

fn schedule_recency_key(schedule: &Value) -> Option<String> {
    schedule
        .get("updated_at")
        .or_else(|| schedule.get("created_at"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

fn recent_automation_context_value(schedule: Value) -> Option<Value> {
    let schedule_id = clean_value_string(schedule.get("schedule_id")?)?;
    let title = clean_value_string(schedule.get("title")?)?;
    let prompt = clean_value_string(schedule.get("prompt")?)?;
    let mut object = serde_json::Map::new();
    object.insert("schedule_id".to_string(), json!(schedule_id));
    object.insert("title".to_string(), json!(title));
    object.insert(
        "prompt".to_string(),
        json!(truncate_context(
            &prompt,
            RECENT_AUTOMATION_PROMPT_MAX_CHARS
        )),
    );
    copy_schedule_field(&schedule, &mut object, "kind");
    copy_schedule_field(&schedule, &mut object, "timezone");
    copy_schedule_field(&schedule, &mut object, "run_at");
    copy_schedule_field(&schedule, &mut object, "interval_seconds");
    copy_schedule_field(&schedule, &mut object, "enabled");
    copy_schedule_field(&schedule, &mut object, "status");
    copy_schedule_field(&schedule, &mut object, "next_run_at");
    copy_schedule_field(&schedule, &mut object, "last_run_at");
    copy_schedule_field(&schedule, &mut object, "last_run_status");
    copy_schedule_field(&schedule, &mut object, "updated_at");
    Some(Value::Object(object))
}

fn copy_schedule_field(schedule: &Value, object: &mut serde_json::Map<String, Value>, key: &str) {
    if let Some(value) = schedule.get(key).filter(|value| !value.is_null()) {
        object.insert(key.to_string(), value.clone());
    }
}

fn clean_value_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn truncate_context(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut chars = value.chars().rev().take(max_chars).collect::<Vec<_>>();
    chars.reverse();
    format!("[truncated]\n{}", chars.into_iter().collect::<String>())
}
