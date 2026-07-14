use serde_json::{json, Value};

use crate::api::run_public::sanitize_user_visible_value;
use crate::api::ApiError;
use crate::state::AppState;

const RECENT_DISPLAY_CONTEXT_MESSAGES: usize = 20;
const RECENT_DISPLAY_CONTEXT_MAX_CHARS: usize = 16_000;
const RECENT_TASK_TRIGGERS_CONTEXT_LIMIT: usize = 10;
const RECENT_TASK_TRIGGERS_CONTEXT_MAX_CHARS: usize = 16_000;
const RECENT_TASK_TRIGGER_PROMPT_MAX_CHARS: usize = 1_200;

#[cfg(test)]
pub(super) fn recent_display_context(messages: &[Value]) -> Option<String> {
    recent_display_context_since(messages, None)
}

pub(super) fn recent_display_context_since(
    messages: &[Value],
    synced_message_count: Option<usize>,
) -> Option<String> {
    let messages = synced_message_count
        .and_then(|count| messages.get(count..))
        .unwrap_or(messages);
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

pub(super) async fn recent_task_triggers_context(
    state: &AppState,
    user_id: &str,
) -> Result<Option<String>, ApiError> {
    let records = state
        .storage
        .list_task_triggers(user_id)
        .await?
        .into_iter()
        .map(|record| sanitize_user_visible_value(state, user_id, &record))
        .collect::<Vec<_>>();
    Ok(recent_task_triggers_context_from_records(records))
}

pub(super) fn recent_task_triggers_context_from_records(mut records: Vec<Value>) -> Option<String> {
    records.sort_by(|left, right| {
        let right_key = trigger_recency_key(right);
        let left_key = trigger_recency_key(left);
        right_key.cmp(&left_key)
    });
    let triggers = records
        .into_iter()
        .filter_map(recent_task_trigger_context_value)
        .take(RECENT_TASK_TRIGGERS_CONTEXT_LIMIT)
        .collect::<Vec<_>>();
    if triggers.is_empty() {
        return None;
    }
    let context = serde_json::to_string_pretty(&triggers).ok()?;
    Some(truncate_context(
        &context,
        RECENT_TASK_TRIGGERS_CONTEXT_MAX_CHARS,
    ))
}

fn trigger_recency_key(record: &Value) -> Option<String> {
    record
        .get("updated_at")
        .or_else(|| record.get("created_at"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

fn recent_task_trigger_context_value(record: Value) -> Option<Value> {
    let trigger_id = clean_value_string(record.get("trigger_id")?)?;
    let title = clean_value_string(record.get("title")?)?;
    let prompt = clean_value_string(record.get("prompt")?)?;
    let mut object = serde_json::Map::new();
    object.insert("trigger_id".to_string(), json!(trigger_id));
    object.insert("title".to_string(), json!(title));
    object.insert(
        "prompt".to_string(),
        json!(truncate_context(
            &prompt,
            RECENT_TASK_TRIGGER_PROMPT_MAX_CHARS
        )),
    );
    copy_trigger_field(&record, &mut object, "kind");
    copy_trigger_field(&record, &mut object, "timezone");
    copy_trigger_field(&record, &mut object, "run_at");
    copy_trigger_field(&record, &mut object, "interval_seconds");
    copy_trigger_field(&record, &mut object, "enabled");
    copy_trigger_field(&record, &mut object, "status");
    copy_trigger_field(&record, &mut object, "next_run_at");
    copy_trigger_field(&record, &mut object, "last_run_at");
    copy_trigger_field(&record, &mut object, "last_run_status");
    copy_trigger_field(&record, &mut object, "updated_at");
    Some(Value::Object(object))
}

fn copy_trigger_field(record: &Value, object: &mut serde_json::Map<String, Value>, key: &str) {
    if let Some(value) = record.get(key).filter(|value| !value.is_null()) {
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
