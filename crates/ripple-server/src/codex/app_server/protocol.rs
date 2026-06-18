use std::collections::HashMap;

use serde_json::{json, Value};

use super::AgentRunnerRequest;

pub(super) fn notification_thread_id(message: &Value) -> Option<String> {
    let params = message.get("params")?;
    params
        .get("threadId")
        .or_else(|| params.get("thread_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            params
                .get("thread")
                .and_then(|thread| thread.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

pub(super) fn notification_turn_id(message: &Value) -> Option<String> {
    let params = message.get("params")?;
    params
        .get("turnId")
        .or_else(|| params.get("turn_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            params
                .get("turn")
                .and_then(|turn| turn.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

pub(super) fn is_context_compaction_completed(message: &Value, thread_id: &str) -> bool {
    if !message_thread_matches(message, thread_id) {
        return false;
    }
    match message.get("method").and_then(Value::as_str) {
        Some("thread/compacted") => true,
        Some("item/completed") => {
            message.pointer("/params/item/type").and_then(Value::as_str)
                == Some("contextCompaction")
        }
        Some("turn/completed") => message
            .pointer("/params/turn/status")
            .and_then(Value::as_str)
            .map_or(true, |status| status == "completed"),
        _ => false,
    }
}

pub(super) fn is_compaction_turn_failed(message: &Value, thread_id: &str) -> bool {
    message_thread_matches(message, thread_id)
        && message.get("method").and_then(Value::as_str) == Some("turn/completed")
        && message
            .pointer("/params/turn/status")
            .and_then(Value::as_str)
            == Some("failed")
}

fn message_thread_matches(message: &Value, thread_id: &str) -> bool {
    notification_thread_id(message).as_deref() == Some(thread_id)
}

pub(super) fn parse_approval_request(
    message: &Value,
    job_id: &str,
    request: &AgentRunnerRequest,
) -> Option<Value> {
    let method = message.get("method")?.as_str()?;
    let action = match method {
        "item/commandExecution/requestApproval" => "command_execution",
        "item/fileChange/requestApproval" => "file_change",
        "item/permissions/requestApproval" => "permissions",
        "execCommandApproval" => "exec_command",
        "applyPatchApproval" => "apply_patch",
        _ => return None,
    };
    let request_id = message.get("id")?.clone();
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
    Some(json!({
        "source": "codex",
        "job_id": job_id,
        "user_id": request.user_id,
        "session_id": request.session_id,
        "thread_id": params.get("threadId").or_else(|| params.get("conversationId")).cloned().unwrap_or(Value::Null),
        "turn_id": params.get("turnId").cloned().unwrap_or(Value::Null),
        "request_id": request_id,
        "method": method,
        "action": action,
        "description": approval_description(action, &params),
        "metadata": params
    }))
}

fn approval_description(action: &str, params: &Value) -> String {
    if matches!(action, "command_execution" | "exec_command") {
        if let Some(command) = params.get("command") {
            if let Some(command) = command.as_str() {
                return command.to_string();
            }
            if let Some(parts) = command.as_array() {
                return parts
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ");
            }
        }
    }
    params
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or(action)
        .replace('_', " ")
}

pub(super) fn is_unsupported_server_request(message: &Value) -> bool {
    message.get("id").is_some() && message.get("method").and_then(Value::as_str).is_some()
}

pub(super) fn record_agent_message_phase(
    message: &Value,
    phases: &mut HashMap<String, Option<String>>,
) {
    let method = message.get("method").and_then(Value::as_str);
    if !matches!(method, Some("item/started") | Some("item/completed")) {
        return;
    }
    let Some(item) = message.pointer("/params/item") else {
        return;
    };
    if item.get("type").and_then(Value::as_str) != Some("agentMessage") {
        return;
    }
    if let Some(id) = item.get("id").and_then(Value::as_str) {
        phases.insert(
            id.to_string(),
            item.get("phase")
                .and_then(Value::as_str)
                .map(str::to_string),
        );
    }
}

pub(super) fn completed_final_agent_message(message: &Value) -> Option<String> {
    if message.get("method").and_then(Value::as_str) != Some("item/completed") {
        return None;
    }
    let item = message.pointer("/params/item")?;
    if item.get("type").and_then(Value::as_str) != Some("agentMessage")
        || item.get("phase").and_then(Value::as_str) == Some("commentary")
    {
        return None;
    }
    item.get("text")
        .or_else(|| item.get("content"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub(super) fn streamable_final_delta(
    message: &Value,
    phases: &HashMap<String, Option<String>>,
) -> Option<String> {
    if message.get("method").and_then(Value::as_str) != Some("item/agentMessage/delta") {
        return None;
    }
    let delta = message.pointer("/params/delta").and_then(Value::as_str)?;
    if let Some(item_id) = message
        .pointer("/params/itemId")
        .or_else(|| message.pointer("/params/item_id"))
        .and_then(Value::as_str)
    {
        if phases.get(item_id).and_then(|phase| phase.as_deref()) == Some("commentary") {
            return None;
        }
    }
    Some(delta.to_string())
}

pub(super) fn is_turn_completed(message: &Value, thread_id: &str, turn_id: &str) -> bool {
    message.get("method").and_then(Value::as_str) == Some("turn/completed")
        && message.pointer("/params/threadId").and_then(Value::as_str) == Some(thread_id)
        && (message.pointer("/params/turnId").and_then(Value::as_str) == Some(turn_id)
            || message.pointer("/params/turn/id").and_then(Value::as_str) == Some(turn_id))
}
