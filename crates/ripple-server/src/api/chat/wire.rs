use std::convert::Infallible;
use std::time::{SystemTime, UNIX_EPOCH};

use async_stream::stream;
use axum::body::{Body, Bytes};
use axum::http::{header, HeaderValue, Response};
use axum::response::IntoResponse;
use axum::Json;
use serde_json::{json, Value};
use uuid::Uuid;

pub(crate) fn response_id_for_session(session_id: &str) -> String {
    format!("resp_{session_id}")
}

pub(crate) fn responses_payload(
    model: &str,
    session_id: &str,
    output_text: String,
    usage: Value,
) -> Value {
    responses_payload_with_changed_files(model, session_id, output_text, usage, None)
}

pub(crate) fn responses_payload_with_changed_files(
    model: &str,
    session_id: &str,
    output_text: String,
    usage: Value,
    changed_files: Option<Value>,
) -> Value {
    responses_payload_with_id(
        &response_id_for_session(session_id),
        model,
        session_id,
        output_text,
        usage,
        changed_files,
    )
}

pub(crate) fn responses_payload_with_id(
    response_id: &str,
    model: &str,
    session_id: &str,
    output_text: String,
    usage: Value,
    changed_files: Option<Value>,
) -> Value {
    let mut payload = json!({
        "id": response_id,
        "object": "response",
        "created_at": now_epoch_seconds(),
        "status": "completed",
        "model": model,
        "output": [{
            "id": format!("msg_{}", &Uuid::new_v4().simple().to_string()[..24]),
            "type": "message",
            "status": "completed",
            "role": "assistant",
            "content": [{
                "type": "output_text",
                "text": output_text.clone(),
                "annotations": []
            }]
        }],
        "output_text": output_text,
        "usage": responses_usage(usage),
        "metadata": {
            "ripple_session_id": session_id
        }
    });
    payload["ripple_changed_files"] = changed_files.unwrap_or(Value::Null);
    payload
}

pub(crate) fn connector_auth_event_response(
    model: &str,
    session_id: &str,
    event: Value,
    stream_response: bool,
) -> Response<Body> {
    connector_auth_event_response_with_message(model, session_id, event, stream_response, true)
}

pub(crate) fn connector_auth_event_response_with_message(
    model: &str,
    session_id: &str,
    event: Value,
    stream_response: bool,
    emit_message: bool,
) -> Response<Body> {
    let public_event = public_connector_auth_event(&event);
    responses_control_event_response(
        model,
        session_id,
        public_event,
        stream_response,
        emit_message,
        None,
    )
}

pub(crate) fn control_plane_event_response(
    model: &str,
    session_id: &str,
    event: Value,
    stream_response: bool,
) -> Response<Body> {
    responses_control_event_response(
        model,
        session_id,
        event.clone(),
        stream_response,
        true,
        agent_stop_ask_user_event(&event),
    )
}

fn responses_control_event_response(
    model: &str,
    session_id: &str,
    event: Value,
    stream_response: bool,
    emit_message: bool,
    stop_event: Option<Value>,
) -> Response<Body> {
    let assistant_text = if emit_message {
        event_message(&event)
    } else {
        String::new()
    };
    let response_id = response_id_for_session(session_id);
    if stream_response {
        let item_id = format!("msg_{}", &Uuid::new_v4().simple().to_string()[..24]);
        let model_id = model.to_string();
        let stream_session_id = session_id.to_string();
        let header_session_id = stream_session_id.clone();
        let stream_event = ripple_stream_event(&event);
        let stop_stream_event = stop_event.map(|event| ripple_stream_event(&event));
        let stream = stream! {
            yield Ok::<Bytes, Infallible>(response_created_sse(&response_id, &model_id, &stream_session_id));
            yield Ok::<Bytes, Infallible>(sse_named_json(stream_event.get("type").and_then(Value::as_str).unwrap_or("ripple.event"), &stream_event));
            if let Some(stop_stream_event) = stop_stream_event {
                yield Ok::<Bytes, Infallible>(sse_named_json(stop_stream_event.get("type").and_then(Value::as_str).unwrap_or("ripple.event"), &stop_stream_event));
            }
            if !assistant_text.is_empty() {
                yield Ok::<Bytes, Infallible>(response_output_text_delta_sse(&response_id, &item_id, &assistant_text));
            }
            yield Ok::<Bytes, Infallible>(response_completed_sse(&response_id, &model_id, &stream_session_id, assistant_text, empty_usage(), None));
            yield Ok::<Bytes, Infallible>(Bytes::from_static(b"data: [DONE]\n\n"));
        };
        let mut response = Response::new(Body::from_stream(stream));
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/event-stream"),
        );
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        response.headers_mut().insert(
            "x-ripple-session-id",
            HeaderValue::from_str(&header_session_id)
                .unwrap_or_else(|_| HeaderValue::from_static("")),
        );
        return response;
    }

    let mut payload = responses_payload(model, session_id, assistant_text, empty_usage());
    payload["ripple_event"] = event;
    let mut response = Json(payload).into_response();
    response.headers_mut().insert(
        "x-ripple-session-id",
        HeaderValue::from_str(session_id).unwrap_or_else(|_| HeaderValue::from_static("")),
    );
    response
}

pub(crate) fn event_message(event: &Value) -> String {
    event
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

pub(crate) fn public_control_plane_event(event: &Value) -> Value {
    let Some(object) = event.as_object() else {
        return event.clone();
    };
    let mut object = object.clone();
    object.remove("user_content");
    object.retain(|_, value| !value.is_null());
    Value::Object(object)
}

pub(crate) fn event_options(event: &Value) -> Option<Vec<String>> {
    let options = event.get("options")?.as_array()?;
    Some(
        options
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
    )
}

pub(crate) fn sse_json(value: &Value) -> Bytes {
    let value = versioned_event(value);
    Bytes::from(format!(
        "data: {}\n\n",
        serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string())
    ))
}

pub(crate) fn sse_for_event(value: &Value) -> Bytes {
    let event = ripple_stream_event(value);
    sse_named_json(
        event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("ripple.event"),
        &event,
    )
}

pub(crate) fn assistant_delta_sse(response_id: &str, item_id: &str, delta: &str) -> Bytes {
    response_output_text_delta_sse(response_id, item_id, delta)
}

pub(crate) fn assistant_done_sse(
    model: &str,
    response_id: &str,
    session_id: &str,
    output_text: String,
    usage: Value,
) -> Bytes {
    response_completed_sse(response_id, model, session_id, output_text, usage, None)
}

pub(crate) fn assistant_done_sse_with_changed_files(
    model: &str,
    response_id: &str,
    session_id: &str,
    output_text: String,
    usage: Value,
    changed_files: Option<Value>,
) -> Bytes {
    response_completed_sse(
        response_id,
        model,
        session_id,
        output_text,
        usage,
        changed_files,
    )
}

pub(crate) fn response_created_sse(response_id: &str, model: &str, session_id: &str) -> Bytes {
    sse_named_json(
        "response.created",
        &json!({
            "type": "response.created",
            "response": {
                "id": response_id,
                "object": "response",
                "created_at": now_epoch_seconds(),
                "status": "in_progress",
                "model": model,
                "metadata": {
                    "ripple_session_id": session_id
                }
            }
        }),
    )
}

pub(crate) fn response_output_text_delta_sse(
    response_id: &str,
    item_id: &str,
    delta: &str,
) -> Bytes {
    sse_named_json(
        "response.output_text.delta",
        &json!({
            "type": "response.output_text.delta",
            "response_id": response_id,
            "item_id": item_id,
            "output_index": 0,
            "content_index": 0,
            "delta": delta
        }),
    )
}

pub(crate) fn response_completed_sse(
    response_id: &str,
    model: &str,
    session_id: &str,
    output_text: String,
    usage: Value,
    changed_files: Option<Value>,
) -> Bytes {
    let response = responses_payload_with_id(
        response_id,
        model,
        session_id,
        output_text,
        usage,
        changed_files,
    );
    sse_named_json(
        "response.completed",
        &json!({
            "type": "response.completed",
            "response": response
        }),
    )
}

pub(crate) fn stream_error(message: &str, error_type: &str) -> Value {
    json!({
        "error": {
            "message": message,
            "type": error_type
        }
    })
}

fn sse_named_json(event_name: &str, value: &Value) -> Bytes {
    Bytes::from(format!(
        "event: {event_name}\ndata: {}\n\n",
        serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string())
    ))
}

fn agent_stop_ask_user_event(event: &Value) -> Option<Value> {
    let question = event.get("question").and_then(Value::as_str)?;
    let options = event_options(event).unwrap_or_default();
    Some(json!({
        "type": "agent_stop",
        "stop_reason": "ask_user",
        "metadata": {
            "message": event_message(event),
            "question": question,
            "options": options,
            "task_trigger": event.get("task_trigger").cloned().unwrap_or_else(|| json!({}))
        }
    }))
}

fn empty_usage() -> Value {
    json!({
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "last_prompt_tokens": 0,
        "cached_input_tokens": 0,
        "reasoning_output_tokens": 0
    })
}

fn responses_usage(usage: Value) -> Value {
    let input_tokens = usage
        .get("prompt_tokens")
        .or_else(|| usage.get("input_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output_tokens = usage
        .get("completion_tokens")
        .or_else(|| usage.get("output_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let total_tokens = usage
        .get("total_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(input_tokens + output_tokens);
    let cached_tokens = usage
        .get("cached_input_tokens")
        .or_else(|| usage.pointer("/input_tokens_details/cached_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let reasoning_tokens = usage
        .get("reasoning_output_tokens")
        .or_else(|| usage.pointer("/output_tokens_details/reasoning_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    json!({
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
        "input_tokens_details": {
            "cached_tokens": cached_tokens
        },
        "output_tokens_details": {
            "reasoning_tokens": reasoning_tokens
        }
    })
}

fn public_connector_auth_event(event: &Value) -> Value {
    let Some(object) = event.as_object() else {
        return event.clone();
    };
    let mut object = object.clone();
    object.remove("user_content");
    object.retain(|key, value| {
        if key == "action" && value.is_null() {
            return false;
        }
        !value.is_null()
    });
    Value::Object(object)
}

fn ripple_stream_event(value: &Value) -> Value {
    let value = versioned_event(value);
    let Some(object) = value.as_object() else {
        return json!({
            "type": "ripple.event",
            "event": value
        });
    };
    let mut object = object.clone();
    let original_type = object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("event")
        .to_string();
    object.insert("type".to_string(), json!(format!("ripple.{original_type}")));
    object.insert("ripple_event_type".to_string(), json!(original_type));
    Value::Object(object)
}

fn versioned_event(value: &Value) -> Value {
    let Some(object) = value.as_object() else {
        return value.clone();
    };
    if object.contains_key("event_version") {
        return value.clone();
    }
    let mut object = object.clone();
    object.insert("event_version".to_string(), json!(1));
    Value::Object(object)
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn changed_files_payload() -> Value {
        json!({
            "files": [{
                "path": "app/src/App.tsx",
                "status": "modified",
                "additions": Value::Null,
                "deletions": Value::Null,
                "previous_path": Value::Null
            }],
            "change_count": 1,
            "truncated": false,
            "source": "workspace_snapshot"
        })
    }

    #[test]
    fn responses_payload_includes_changed_files_when_provided() {
        let payload = responses_payload_with_changed_files(
            "codex-high",
            "session-1",
            "done".to_string(),
            empty_usage(),
            Some(changed_files_payload()),
        );

        assert_eq!(
            payload["ripple_changed_files"]["files"][0]["path"],
            "app/src/App.tsx"
        );
        assert_eq!(
            payload["ripple_changed_files"]["files"][0]["additions"],
            Value::Null
        );
        assert_eq!(payload["ripple_changed_files"]["change_count"], 1);
    }

    #[test]
    fn responses_payload_sets_null_changed_files_when_missing() {
        let payload =
            responses_payload("codex-high", "session-1", "done".to_string(), empty_usage());

        assert_eq!(payload["ripple_changed_files"], Value::Null);
    }

    #[test]
    fn response_completed_sse_wraps_changed_files_inside_response() {
        let bytes = assistant_done_sse_with_changed_files(
            "codex-high",
            "resp_session_1",
            "session-1",
            "done".to_string(),
            empty_usage(),
            Some(changed_files_payload()),
        );
        let text = std::str::from_utf8(bytes.as_ref()).expect("valid sse");
        assert!(text.starts_with("event: response.completed\n"));
        let data_line = text
            .lines()
            .find(|line| line.starts_with("data: "))
            .expect("data line");
        let value: Value =
            serde_json::from_str(data_line.trim_start_matches("data: ")).expect("json data");

        assert_eq!(value["type"], "response.completed");
        assert_eq!(
            value["response"]["ripple_changed_files"]["files"][0]["path"],
            "app/src/App.tsx"
        );
        assert_eq!(
            value["response"]["ripple_changed_files"]["files"][0]["previous_path"],
            Value::Null
        );
    }
}
