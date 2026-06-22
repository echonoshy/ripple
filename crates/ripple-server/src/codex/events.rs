use serde_json::{json, Value};

pub fn extract_plan_update_event(event: &Value) -> Option<Value> {
    if event.get("type").and_then(Value::as_str) != Some("codex.notification") {
        return None;
    }
    let message = event.pointer("/data/message")?;
    if message.get("method").and_then(Value::as_str) != Some("turn/plan/updated") {
        return None;
    }
    let params = message.get("params")?;
    let raw_plan = params.get("plan")?.as_array()?;
    let turn_id = params
        .get("turnId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown-turn");
    let mut steps = Vec::new();
    for (index, item) in raw_plan.iter().enumerate() {
        let Some(step) = item.get("step").and_then(Value::as_str) else {
            continue;
        };
        if step.trim().is_empty() {
            continue;
        }
        steps.push(json!({
            "id": format!("codex-plan:{turn_id}:{index}"),
            "subject": step,
            "status": normalize_plan_step_status(item.get("status").and_then(Value::as_str))
        }));
    }
    let completed = steps
        .iter()
        .filter(|step| step.get("status").and_then(Value::as_str) == Some("completed"))
        .count();
    let current_task = steps
        .iter()
        .find(|step| step.get("status").and_then(Value::as_str) == Some("in_progress"))
        .or_else(|| {
            steps
                .iter()
                .find(|step| step.get("status").and_then(Value::as_str) == Some("pending"))
        })
        .and_then(|step| step.get("subject").and_then(Value::as_str));
    let total = steps.len();
    Some(json!({
        "type": "task_plan_updated",
        "thread_id": params.get("threadId").and_then(Value::as_str),
        "turn_id": turn_id,
        "explanation": params.get("explanation").and_then(Value::as_str),
        "steps": steps,
        "progress": {
            "completed": completed,
            "total": total,
            "currentTask": current_task
        },
        "allCompleted": completed == total
    }))
}

pub fn extract_codex_runtime_event(event: &Value) -> Option<Value> {
    if event.get("type").and_then(Value::as_str) != Some("codex.notification") {
        return None;
    }
    let message = event.pointer("/data/message")?;
    let method = message.get("method").and_then(Value::as_str)?;
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
    match method {
        "turn/diff/updated" => {
            let mut payload = base_runtime_event("codex_turn_diff_updated", method, &params);
            if let Some(object) = payload.as_object_mut() {
                if let Some(diff) = params.get("diff") {
                    object.insert("diff".to_string(), diff.clone());
                } else {
                    object.insert("params".to_string(), params);
                }
            }
            Some(payload)
        }
        "item/commandExecution/outputDelta" | "item/commandExecution/delta" => {
            Some(tool_delta_event(method, &params, "command_execution"))
        }
        "item/fileChange/outputDelta" | "item/fileChange/delta" => {
            Some(tool_delta_event(method, &params, "file_change"))
        }
        "item/fileChange/patchUpdated" => {
            let mut payload = base_runtime_event("file_change_patch_updated", method, &params);
            if let Some(object) = payload.as_object_mut() {
                for key in ["patch", "changes", "status"] {
                    if let Some(value) = params.get(key) {
                        object.insert(key.to_string(), value.clone());
                    }
                }
            }
            Some(payload)
        }
        "model/rerouted" => {
            let mut payload = base_runtime_event("model_rerouted", method, &params);
            if let Some(object) = payload.as_object_mut() {
                copy_param_as(object, &params, "fromModel", "from_model");
                copy_param_as(object, &params, "toModel", "to_model");
                copy_param_as(object, &params, "reason", "reason");
            }
            Some(payload)
        }
        "model/verification" => {
            let mut payload = base_runtime_event("model_verification", method, &params);
            if let Some(object) = payload.as_object_mut() {
                object.insert(
                    "verifications".to_string(),
                    params
                        .get("verifications")
                        .cloned()
                        .unwrap_or_else(|| json!([])),
                );
            }
            Some(payload)
        }
        "thread/status/changed" => {
            let mut payload = base_runtime_event("thread_status_changed", method, &params);
            if let Some(object) = payload.as_object_mut() {
                for key in ["status", "runtime"] {
                    if let Some(value) = params.get(key) {
                        object.insert(key.to_string(), value.clone());
                    }
                }
            }
            Some(payload)
        }
        "item/tool/requestUserInput" => Some(user_input_requested_event(
            method,
            &params,
            message.get("id").cloned(),
        )),
        "warning" | "configWarning" | "deprecationNotice" | "guardianWarning" | "turn/warning" => {
            let mut payload = base_runtime_event("codex_warning", method, &params);
            if let Some(object) = payload.as_object_mut() {
                object.insert("message".to_string(), json!(message_text(&params)));
            }
            Some(payload)
        }
        "error" | "turn/error" => {
            let mut payload = base_runtime_event("codex_error", method, &params);
            if let Some(object) = payload.as_object_mut() {
                object.insert("message".to_string(), json!(message_text(&params)));
            }
            Some(payload)
        }
        "thread/compacted" | "thread/contextCompacted" | "context/compacted" => {
            Some(context_compaction_event(method, &params))
        }
        _ => {
            if params.pointer("/item/type").and_then(Value::as_str) == Some("contextCompaction") {
                Some(context_compaction_event(method, &params))
            } else {
                None
            }
        }
    }
}

pub fn extract_tool_event(event: &Value) -> Option<Value> {
    if event.get("type").and_then(Value::as_str) != Some("codex.notification") {
        return None;
    }
    let message = event.pointer("/data/message")?;
    let method = message.get("method").and_then(Value::as_str)?;
    let params = message.get("params")?;
    let item = params.get("item")?;
    let item_id = item.get("id").and_then(Value::as_str)?;
    if item_id.is_empty() {
        return None;
    }
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
    if matches!(
        item_type,
        "userMessage" | "agentMessage" | "plan" | "reasoning" | "hookPrompt" | "contextCompaction"
    ) {
        return None;
    }
    match method {
        "item/started" => Some(json!({
            "type": "tool_call",
            "id": item_id,
            "name": tool_name_for_item(item),
            "input": tool_arguments_for_item(item),
            "status": "running"
        })),
        "item/completed" => Some(json!({
            "type": "tool_result",
            "tool_use_id": item_id,
            "content": tool_result_for_item(item)
        })),
        _ => None,
    }
}

pub fn extract_usage_event(event: &Value) -> Option<Value> {
    if event.get("type").and_then(Value::as_str) != Some("codex.notification") {
        return None;
    }
    let message = event.pointer("/data/message")?;
    if message.get("method").and_then(Value::as_str) != Some("thread/tokenUsage/updated") {
        return None;
    }
    let token_usage = message.pointer("/params/tokenUsage")?;
    let total = token_usage.get("total")?;
    let last = token_usage.get("last")?;
    let mut usage = json!({
        "prompt_tokens": int_value(last.get("inputTokens")),
        "completion_tokens": int_value(last.get("outputTokens")),
        "total_tokens": int_value(last.get("totalTokens")),
        "last_prompt_tokens": int_value(last.get("inputTokens")),
        "cached_input_tokens": int_value(last.get("cachedInputTokens")),
        "reasoning_output_tokens": int_value(last.get("reasoningOutputTokens"))
    });
    if let Some(model_context_window) = token_usage
        .get("modelContextWindow")
        .and_then(Value::as_u64)
    {
        usage["model_context_window"] = json!(model_context_window);
    }
    if total.is_object() && last.is_object() {
        Some(usage)
    } else {
        None
    }
}

fn normalize_plan_step_status(status: Option<&str>) -> &'static str {
    match status {
        Some("completed") => "completed",
        Some("inProgress" | "in_progress") => "in_progress",
        _ => "pending",
    }
}

fn base_runtime_event(event_type: &str, method: &str, params: &Value) -> Value {
    let item = params.get("item");
    let item_id = params
        .get("itemId")
        .or_else(|| params.get("item_id"))
        .and_then(Value::as_str)
        .or_else(|| item.and_then(|item| item.get("id")).and_then(Value::as_str));
    let mut payload = json!({
        "type": event_type,
        "codex_method": method,
        "thread_id": params.get("threadId").or_else(|| params.get("thread_id")).and_then(Value::as_str),
        "turn_id": params.get("turnId").or_else(|| params.get("turn_id")).and_then(Value::as_str)
    });
    if let (Some(object), Some(item_id)) = (payload.as_object_mut(), item_id) {
        object.insert("id".to_string(), json!(item_id));
    }
    payload
}

fn tool_delta_event(method: &str, params: &Value, kind: &str) -> Value {
    let mut payload = base_runtime_event("tool_output_delta", method, params);
    if let Some(object) = payload.as_object_mut() {
        object.insert("kind".to_string(), json!(kind));
        object.insert("delta".to_string(), json!(delta_text(params)));
        if let Some(stream) = params.get("stream").and_then(Value::as_str) {
            object.insert("stream".to_string(), json!(stream));
        }
    }
    payload
}

fn user_input_requested_event(method: &str, params: &Value, request_id: Option<Value>) -> Value {
    let mut payload = base_runtime_event("user_input_requested", method, params);
    if let Some(object) = payload.as_object_mut() {
        if let Some(request_id) = request_id {
            object.insert("request_id".to_string(), request_id);
        }
        object.insert(
            "questions".to_string(),
            params
                .get("questions")
                .cloned()
                .unwrap_or_else(|| json!([])),
        );
        object.insert(
            "auto_resolution_ms".to_string(),
            params
                .get("autoResolutionMs")
                .cloned()
                .unwrap_or(Value::Null),
        );
    }
    payload
}

fn copy_param_as(
    object: &mut serde_json::Map<String, Value>,
    params: &Value,
    source: &str,
    target: &str,
) {
    if let Some(value) = params.get(source) {
        object.insert(target.to_string(), value.clone());
    }
}

fn context_compaction_event(method: &str, params: &Value) -> Value {
    let mut payload = base_runtime_event("context_compaction", method, params);
    if let Some(status) = params.pointer("/item/status").and_then(Value::as_str) {
        if let Some(object) = payload.as_object_mut() {
            object.insert("status".to_string(), json!(status));
        }
    }
    payload
}

fn tool_name_for_item(item: &Value) -> String {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
    match item_type {
        "commandExecution" => "command_execution".to_string(),
        "fileChange" => "file_change".to_string(),
        "mcpToolCall" => {
            let server = item.get("server").and_then(Value::as_str);
            let tool = item.get("tool").and_then(Value::as_str);
            match (server, tool) {
                (Some(server), Some(tool)) => format!("{server}.{tool}"),
                _ => "mcp_tool_call".to_string(),
            }
        }
        "dynamicToolCall" => {
            let namespace = item.get("namespace").and_then(Value::as_str).unwrap_or("");
            let tool = item.get("tool").and_then(Value::as_str).unwrap_or("");
            if !namespace.is_empty() && !tool.is_empty() {
                format!("{namespace}.{tool}")
            } else if !tool.is_empty() {
                tool.to_string()
            } else {
                "dynamic_tool_call".to_string()
            }
        }
        "collabAgentToolCall" => item
            .get("tool")
            .and_then(Value::as_str)
            .map(|tool| format!("agent.{tool}"))
            .unwrap_or_else(|| "agent_tool_call".to_string()),
        "webSearch" => "web_search".to_string(),
        "imageView" => "view_image".to_string(),
        "imageGeneration" => "image_generation".to_string(),
        _ => {
            if item_type.is_empty() {
                "codex_item".to_string()
            } else {
                item_type.to_string()
            }
        }
    }
}

fn tool_arguments_for_item(item: &Value) -> Value {
    match item.get("type").and_then(Value::as_str).unwrap_or("") {
        "commandExecution" => json!({
            "command": item.get("command").cloned().unwrap_or(Value::Null),
            "cwd": item.get("cwd").cloned().unwrap_or(Value::Null),
            "source": item.get("source").cloned().unwrap_or(Value::Null)
        }),
        "mcpToolCall" => json!({
            "server": item.get("server").cloned().unwrap_or(Value::Null),
            "tool": item.get("tool").cloned().unwrap_or(Value::Null),
            "arguments": item.get("arguments").cloned().unwrap_or_else(|| json!({}))
        }),
        "dynamicToolCall" => json!({
            "namespace": item.get("namespace").cloned().unwrap_or(Value::Null),
            "tool": item.get("tool").cloned().unwrap_or(Value::Null),
            "arguments": item.get("arguments").cloned().unwrap_or_else(|| json!({}))
        }),
        "fileChange" => {
            json!({"changes": item.get("changes").cloned().unwrap_or_else(|| json!([]))})
        }
        "webSearch" => json!({
            "query": item.get("query").cloned().unwrap_or(Value::Null),
            "action": item.get("action").cloned().unwrap_or(Value::Null)
        }),
        "imageView" => json!({"path": item.get("path").cloned().unwrap_or(Value::Null)}),
        "imageGeneration" => json!({
            "status": item.get("status").cloned().unwrap_or(Value::Null),
            "revised_prompt": item.get("revisedPrompt").cloned().unwrap_or(Value::Null)
        }),
        "collabAgentToolCall" => json!({
            "tool": item.get("tool").cloned().unwrap_or(Value::Null),
            "prompt": item.get("prompt").cloned().unwrap_or(Value::Null),
            "model": item.get("model").cloned().unwrap_or(Value::Null),
            "receiver_thread_ids": item.get("receiverThreadIds").cloned().unwrap_or_else(|| json!([]))
        }),
        _ => item.clone(),
    }
}

fn tool_result_for_item(item: &Value) -> Value {
    match item.get("type").and_then(Value::as_str).unwrap_or("") {
        "commandExecution" => json!({
            "status": item.get("status").cloned().unwrap_or(Value::Null),
            "exit_code": item.get("exitCode").cloned().unwrap_or(Value::Null),
            "duration_ms": item.get("durationMs").cloned().unwrap_or(Value::Null),
            "output": item.get("aggregatedOutput").cloned().unwrap_or_else(|| json!(""))
        }),
        "mcpToolCall" => json!({
            "status": item.get("status").cloned().unwrap_or(Value::Null),
            "result": item.get("result").cloned().unwrap_or(Value::Null),
            "error": item.get("error").cloned().unwrap_or(Value::Null),
            "duration_ms": item.get("durationMs").cloned().unwrap_or(Value::Null)
        }),
        "dynamicToolCall" => json!({
            "status": item.get("status").cloned().unwrap_or(Value::Null),
            "success": item.get("success").cloned().unwrap_or(Value::Null),
            "content_items": item.get("contentItems").cloned().unwrap_or_else(|| json!([])),
            "duration_ms": item.get("durationMs").cloned().unwrap_or(Value::Null)
        }),
        "fileChange" => json!({
            "status": item.get("status").cloned().unwrap_or(Value::Null),
            "changes": item.get("changes").cloned().unwrap_or_else(|| json!([]))
        }),
        "webSearch" => json!({
            "query": item.get("query").cloned().unwrap_or(Value::Null),
            "action": item.get("action").cloned().unwrap_or(Value::Null)
        }),
        "imageView" => json!({"path": item.get("path").cloned().unwrap_or(Value::Null)}),
        "imageGeneration" => json!({
            "status": item.get("status").cloned().unwrap_or(Value::Null),
            "revised_prompt": item.get("revisedPrompt").cloned().unwrap_or(Value::Null),
            "saved_path": item.get("savedPath").cloned().unwrap_or(Value::Null)
        }),
        "collabAgentToolCall" => json!({
            "status": item.get("status").cloned().unwrap_or(Value::Null),
            "receiver_thread_ids": item.get("receiverThreadIds").cloned().unwrap_or_else(|| json!([])),
            "agents_states": item.get("agentsStates").cloned().unwrap_or_else(|| json!({}))
        }),
        _ => item.clone(),
    }
}

fn message_text(params: &Value) -> String {
    for key in [
        "message",
        "warning",
        "error",
        "detail",
        "details",
        "additionalDetails",
    ] {
        if let Some(value) = params.get(key).and_then(message_text_value) {
            return value;
        }
    }
    String::new()
}

fn message_text_value(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        if !text.is_empty() {
            return Some(text.to_string());
        }
    }
    let object = value.as_object()?;
    for key in ["message", "detail", "details", "additionalDetails"] {
        if let Some(text) = object.get(key).and_then(message_text_value) {
            return Some(text);
        }
    }
    None
}

fn delta_text(params: &Value) -> String {
    for key in ["delta", "output", "chunk", "text"] {
        if let Some(value) = params.get(key).and_then(Value::as_str) {
            return value.to_string();
        }
    }
    String::new()
}

fn int_value(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_plan_update_for_frontend() {
        let event = json!({
            "type": "codex.notification",
            "data": {
                "message": {
                    "method": "turn/plan/updated",
                    "params": {
                        "threadId": "thread-1",
                        "turnId": "turn-1",
                        "explanation": "working",
                        "plan": [
                            {"step": "Inspect", "status": "completed"},
                            {"step": "Patch", "status": "inProgress"}
                        ]
                    }
                }
            }
        });

        let update = extract_plan_update_event(&event).expect("plan update");

        assert_eq!(
            update.get("type").and_then(Value::as_str),
            Some("task_plan_updated")
        );
        assert_eq!(
            update
                .pointer("/progress/completed")
                .and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(
            update.pointer("/steps/1/status").and_then(Value::as_str),
            Some("in_progress")
        );
        assert_eq!(
            update.get("allCompleted").and_then(Value::as_bool),
            Some(false)
        );
    }

    #[test]
    fn extracts_usage_update() {
        let event = json!({
            "type": "codex.notification",
            "data": {
                "message": {
                    "method": "thread/tokenUsage/updated",
                    "params": {
                        "tokenUsage": {
                            "modelContextWindow": 200000,
                            "total": {"inputTokens": 100},
                            "last": {
                                "inputTokens": 10,
                                "outputTokens": 5,
                                "totalTokens": 15,
                                "cachedInputTokens": 3,
                                "reasoningOutputTokens": 2
                            }
                        }
                    }
                }
            }
        });

        let usage = extract_usage_event(&event).expect("usage");

        assert_eq!(usage.get("prompt_tokens").and_then(Value::as_u64), Some(10));
        assert_eq!(
            usage.get("completion_tokens").and_then(Value::as_u64),
            Some(5)
        );
        assert_eq!(
            usage.get("last_prompt_tokens").and_then(Value::as_u64),
            Some(10)
        );
        assert_eq!(
            usage.get("model_context_window").and_then(Value::as_u64),
            Some(200000)
        );
    }

    #[test]
    fn extracts_nested_error_message_for_runtime_event() {
        let event = json!({
            "type": "codex.notification",
            "data": {
                "message": {
                    "method": "error",
                    "params": {
                        "threadId": "thread-1",
                        "turnId": "turn-1",
                        "error": {
                            "message": "Reconnecting... 2/5",
                            "additionalDetails": "request timed out"
                        },
                        "willRetry": true
                    }
                }
            }
        });

        let runtime_event = extract_codex_runtime_event(&event).expect("runtime event");

        assert_eq!(
            runtime_event.get("message").and_then(Value::as_str),
            Some("Reconnecting... 2/5")
        );
    }

    #[test]
    fn extracts_model_status_and_user_input_runtime_events() {
        let model = json!({
            "type": "codex.notification",
            "data": {
                "message": {
                    "method": "model/rerouted",
                    "params": {
                        "threadId": "thread-1",
                        "turnId": "turn-1",
                        "fromModel": "gpt-5-mini",
                        "toModel": "gpt-5",
                        "reason": "highRiskCyberActivity"
                    }
                }
            }
        });
        let status = json!({
            "type": "codex.notification",
            "data": {
                "message": {
                    "method": "thread/status/changed",
                    "params": {
                        "threadId": "thread-1",
                        "status": "waitingOnUserInput",
                        "runtime": {
                            "pendingUserInputRequests": 1
                        }
                    }
                }
            }
        });
        let user_input = json!({
            "type": "codex.notification",
            "data": {
                "message": {
                    "id": "input-1",
                    "method": "item/tool/requestUserInput",
                    "params": {
                        "threadId": "thread-1",
                        "turnId": "turn-1",
                        "itemId": "item-1",
                        "questions": [{
                            "id": "budget",
                            "header": "预算",
                            "question": "客户预算是多少？",
                            "options": [{
                                "label": "10 万以内",
                                "description": "按低预算方案继续"
                            }]
                        }],
                        "autoResolutionMs": null
                    }
                }
            }
        });

        let model_event = extract_codex_runtime_event(&model).expect("model reroute event");
        let status_event = extract_codex_runtime_event(&status).expect("thread status event");
        let input_event = extract_codex_runtime_event(&user_input).expect("user input event");

        assert_eq!(
            model_event.get("type").and_then(Value::as_str),
            Some("model_rerouted")
        );
        assert_eq!(
            model_event.get("from_model").and_then(Value::as_str),
            Some("gpt-5-mini")
        );
        assert_eq!(
            status_event.get("type").and_then(Value::as_str),
            Some("thread_status_changed")
        );
        assert_eq!(
            status_event
                .pointer("/runtime/pendingUserInputRequests")
                .and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(
            input_event.get("type").and_then(Value::as_str),
            Some("user_input_requested")
        );
        assert_eq!(
            input_event
                .pointer("/questions/0/question")
                .and_then(Value::as_str),
            Some("客户预算是多少？")
        );
    }

    #[test]
    fn extracts_command_tool_call_and_result() {
        let started = json!({
            "type": "codex.notification",
            "data": {
                "message": {
                    "method": "item/started",
                    "params": {
                        "item": {
                            "id": "item-1",
                            "type": "commandExecution",
                            "command": "cargo check",
                            "cwd": "/workspace",
                            "source": "model"
                        }
                    }
                }
            }
        });
        let completed = json!({
            "type": "codex.notification",
            "data": {
                "message": {
                    "method": "item/completed",
                    "params": {
                        "item": {
                            "id": "item-1",
                            "type": "commandExecution",
                            "status": "completed",
                            "exitCode": 0,
                            "durationMs": 42,
                            "aggregatedOutput": "ok"
                        }
                    }
                }
            }
        });

        let call = extract_tool_event(&started).expect("tool call");
        let result = extract_tool_event(&completed).expect("tool result");

        assert_eq!(call.get("type").and_then(Value::as_str), Some("tool_call"));
        assert_eq!(
            call.get("name").and_then(Value::as_str),
            Some("command_execution")
        );
        assert_eq!(
            result.get("type").and_then(Value::as_str),
            Some("tool_result")
        );
        assert_eq!(
            result.pointer("/content/exit_code").and_then(Value::as_u64),
            Some(0)
        );
    }
}
