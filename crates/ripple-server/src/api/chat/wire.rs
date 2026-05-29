use std::convert::Infallible;
use std::time::{SystemTime, UNIX_EPOCH};

use async_stream::stream;
use axum::body::{Body, Bytes};
use axum::http::{header, HeaderValue, Response};
use axum::response::IntoResponse;
use axum::Json;
use serde_json::{json, Value};
use uuid::Uuid;

pub(crate) fn chat_completion_payload(model: &str, session_id: &str, output_text: String) -> Value {
    json!({
        "id": format!("chatcmpl-{}", &Uuid::new_v4().simple().to_string()[..24]),
        "object": "chat.completion",
        "created": now_epoch_seconds(),
        "model": model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": output_text},
            "finish_reason": "stop"
        }],
        "usage": empty_usage(),
        "session_id": session_id
    })
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
    if stream_response {
        let chunk_id = format!("chatcmpl-{}", &Uuid::new_v4().simple().to_string()[..24]);
        let model_id = model.to_string();
        let created = now_epoch_seconds();
        let message = if emit_message {
            event_message(&event)
        } else {
            String::new()
        };
        let stream = stream! {
            yield Ok::<Bytes, Infallible>(Bytes::from(chunk(&chunk_id, &model_id, created, json!({"role": "assistant"}), None)));
            yield Ok::<Bytes, Infallible>(sse_json(&public_event));
            if !message.is_empty() {
                yield Ok::<Bytes, Infallible>(Bytes::from(chunk(&chunk_id, &model_id, created, json!({"content": message}), None)));
            }
            yield Ok::<Bytes, Infallible>(Bytes::from(chunk(&chunk_id, &model_id, created, json!({}), Some("stop"))));
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
            HeaderValue::from_str(session_id).unwrap_or_else(|_| HeaderValue::from_static("")),
        );
        return response;
    }

    let output_text = if emit_message {
        event_message(&event)
    } else {
        String::new()
    };
    let mut payload = chat_completion_payload(model, session_id, output_text);
    payload["connector_auth"] = public_event;
    let mut response = Json(payload).into_response();
    response.headers_mut().insert(
        "x-ripple-session-id",
        HeaderValue::from_str(session_id).unwrap_or_else(|_| HeaderValue::from_static("")),
    );
    response
}

pub(crate) fn control_plane_event_response(
    model: &str,
    session_id: &str,
    event: Value,
    stream_response: bool,
) -> Response<Body> {
    let assistant_text = event_message(&event);
    if stream_response {
        let chunk_id = format!("chatcmpl-{}", &Uuid::new_v4().simple().to_string()[..24]);
        let model_id = model.to_string();
        let created = now_epoch_seconds();
        let stream = stream! {
            yield Ok::<Bytes, Infallible>(Bytes::from(chunk(&chunk_id, &model_id, created, json!({"role": "assistant"}), None)));
            yield Ok::<Bytes, Infallible>(sse_json(&event));
            if let Some(stop_event) = agent_stop_ask_user_event(&event) {
                yield Ok::<Bytes, Infallible>(sse_json(&stop_event));
            }
            if !assistant_text.is_empty() {
                yield Ok::<Bytes, Infallible>(Bytes::from(chunk(&chunk_id, &model_id, created, json!({"content": assistant_text}), None)));
            }
            yield Ok::<Bytes, Infallible>(Bytes::from(chunk(&chunk_id, &model_id, created, json!({}), Some("stop"))));
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
            HeaderValue::from_str(session_id).unwrap_or_else(|_| HeaderValue::from_static("")),
        );
        return response;
    }

    let mut payload = chat_completion_payload(model, session_id, assistant_text);
    payload["event"] = event;
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

pub(crate) fn chunk(
    chunk_id: &str,
    model: &str,
    created: u64,
    delta: Value,
    finish_reason: Option<&str>,
) -> String {
    let mut choice = json!({"index": 0, "delta": delta, "finish_reason": finish_reason});
    if finish_reason.is_none() {
        choice["finish_reason"] = Value::Null;
    }
    format!(
        "data: {}\n\n",
        serde_json::to_string(&json!({
            "id": chunk_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [choice]
        }))
        .unwrap_or_else(|_| "{}".to_string())
    )
}

pub(crate) fn sse_json(value: &Value) -> Bytes {
    let value = versioned_event(value);
    Bytes::from(format!(
        "data: {}\n\n",
        serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string())
    ))
}

pub(crate) fn stream_error(message: &str, error_type: &str) -> Value {
    json!({
        "error": {
            "message": message,
            "type": error_type
        }
    })
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
            "schedule": event.get("schedule").cloned().unwrap_or_else(|| json!({}))
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
