use std::path::Path as FsPath;

use serde_json::{json, Value};

use crate::api::ApiError;
use crate::workspace as ws;

#[derive(Debug, Clone)]
pub(crate) struct ExtractedControlAction {
    pub label: Option<String>,
    pub action: Value,
}

pub(crate) fn extract_user_input_and_items(
    messages: &[Value],
    workspace_root: &FsPath,
) -> Result<(String, Vec<Value>, Value, Vec<Value>), ApiError> {
    let Some(message) = messages
        .iter()
        .rev()
        .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))
    else {
        return Err(ApiError::bad_request("No user message found in messages"));
    };
    let content = message.get("content").cloned().unwrap_or(Value::Null);
    let mut parts = Vec::new();
    let mut items = Vec::new();
    let mut user_content = Vec::new();
    let mut attachment_items = Vec::new();
    match &content {
        Value::String(text) => {
            parts.push(text.clone());
            if !text.trim().is_empty() {
                user_content.push(json!({"type": "text", "text": text}));
            }
        }
        Value::Array(entries) => {
            for entry in entries {
                let item_type = entry.get("type").and_then(Value::as_str).unwrap_or("");
                match item_type {
                    "text" | "input_text" => {
                        if let Some(text) = entry.get("text").and_then(Value::as_str) {
                            parts.push(text.to_string());
                            user_content.push(json!({"type": "text", "text": text}));
                        }
                    }
                    "image" | "input_image" | "image_url" => {
                        if let Some(url) = image_url(entry) {
                            validate_image_url(&url)?;
                            items.push(json!({"type": "image", "url": url}));
                            user_content.push(json!({"type": "image", "url": url}));
                        }
                    }
                    "localImage" | "local_image" => {
                        items.push(entry.clone());
                        user_content.push(entry.clone());
                    }
                    "file" => {
                        if let Some(file_item) = file_item_from_block(entry, workspace_root)? {
                            match file_item.get("type").and_then(Value::as_str) {
                                Some("localImage") | Some("image") => items.push(file_item.clone()),
                                Some("attachment") => attachment_items.push(file_item.clone()),
                                _ => {}
                            }
                            user_content.push(user_content_for_file_item(&file_item));
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    Ok((
        parts.join("\n"),
        items,
        Value::Array(user_content),
        attachment_items,
    ))
}

pub(crate) fn extract_control_action_from_messages(
    messages: &[Value],
) -> Option<ExtractedControlAction> {
    let message = messages
        .iter()
        .rev()
        .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))?;
    let entries = message.get("content")?.as_array()?;
    let entry = entries
        .iter()
        .find(|entry| entry.get("type").and_then(Value::as_str) == Some("ripple_control_action"))?;
    let action = entry
        .get("action")
        .filter(|value| value.is_object())?
        .clone();
    let label = entry
        .get("label")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Some(ExtractedControlAction { label, action })
}

fn image_url(entry: &Value) -> Option<String> {
    entry
        .get("url")
        .and_then(Value::as_str)
        .or_else(|| entry.pointer("/image_url/url").and_then(Value::as_str))
        .or_else(|| entry.get("image_url").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn validate_image_url(url: &str) -> Result<(), ApiError> {
    if is_remote_image_url(url) {
        return Err(ApiError::bad_request(
            "remote image URLs are not supported; upload the image into the workspace or use an inline data URL",
        ));
    }
    Ok(())
}

fn is_remote_image_url(url: &str) -> bool {
    let Some((scheme, _)) = url.trim().split_once(':') else {
        return false;
    };
    scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")
}

fn file_item_from_block(entry: &Value, workspace_root: &FsPath) -> Result<Option<Value>, ApiError> {
    let Some(file_info) = entry.get("file").filter(|value| value.is_object()) else {
        return Ok(None);
    };
    let url = file_info
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let path = file_info
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if path.is_none() {
        let Some(url) = url else {
            return Ok(None);
        };
        let name = file_info
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                FsPath::new(url)
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("attachment")
                    .to_string()
            });
        let mime_type = file_info
            .get("mime_type")
            .or_else(|| file_info.get("mimeType"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| ws::mime_type_for_path(FsPath::new(&name)));
        if is_image_mime_type(&mime_type) {
            validate_image_url(url)?;
            return Ok(Some(json!({
                "type": "image",
                "url": url,
                "name": name,
                "mime_type": mime_type
            })));
        }
        return Ok(None);
    }
    let path = path.unwrap_or_default();
    let name = file_info
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            FsPath::new(path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("attachment")
                .to_string()
        });
    let mime_type = file_info
        .get("mime_type")
        .or_else(|| file_info.get("mimeType"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| ws::mime_type_for_path(FsPath::new(&name)));

    if path.starts_with("/workspace/") || path == "/workspace" {
        let host_path = ws::validate_existing_path(path, workspace_root)
            .map_err(|err| ApiError::bad_request(err.to_string()))?;
        if !host_path.is_file() {
            return Err(ApiError::bad_request(format!("{path} is not a file")));
        }
        let workspace_path = ws::workspace_path(workspace_root, &host_path)
            .map_err(|err| ApiError::bad_request(err.to_string()))?;
        if is_image_mime_type(&mime_type) {
            return Ok(Some(json!({
                "type": "localImage",
                "path": host_path.to_string_lossy(),
                "workspace_path": workspace_path,
                "name": name,
                "mime_type": mime_type
            })));
        }
        return Ok(Some(json!({
            "type": "attachment",
            "path": host_path.to_string_lossy(),
            "workspace_path": workspace_path,
            "name": name,
            "mime_type": mime_type
        })));
    }

    if let Some(url) = url {
        if is_image_mime_type(&mime_type) {
            validate_image_url(url)?;
            return Ok(Some(json!({
                "type": "image",
                "url": url,
                "name": name,
                "mime_type": mime_type
            })));
        }
    }
    Ok(None)
}

fn user_content_for_file_item(item: &Value) -> Value {
    match item.get("type").and_then(Value::as_str) {
        Some("localImage") => json!({
            "type": "localImage",
            "path": item.get("workspace_path").cloned().unwrap_or(Value::Null),
            "name": item.get("name").cloned().unwrap_or(Value::Null),
            "mime_type": item.get("mime_type").cloned().unwrap_or(Value::Null)
        }),
        Some("attachment") => json!({
            "type": "attachment",
            "path": item.get("workspace_path").cloned().unwrap_or(Value::Null),
            "name": item.get("name").cloned().unwrap_or(Value::Null),
            "mime_type": item.get("mime_type").cloned().unwrap_or(Value::Null)
        }),
        Some("image") => json!({
            "type": "image",
            "url": item.get("url").cloned().unwrap_or(Value::Null)
        }),
        _ => item.clone(),
    }
}

fn is_image_mime_type(mime_type: &str) -> bool {
    mime_type.trim().to_ascii_lowercase().starts_with("image/")
}

pub(crate) fn extract_caller_system_prompt(messages: &[Value]) -> Option<String> {
    let text = messages
        .iter()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("system"))
        .filter_map(|message| content_text(message.get("content")?))
        .collect::<Vec<_>>()
        .join("\n\n");
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

fn content_text(content: &Value) -> Option<String> {
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(entries) => {
            let text = entries
                .iter()
                .filter_map(|entry| entry.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{extract_control_action_from_messages, extract_user_input_and_items};

    #[test]
    fn extracts_ripple_control_action_content_block() {
        let action = extract_control_action_from_messages(&[json!({
            "role": "user",
            "content": [
                {
                    "type": "ripple_control_action",
                    "label": "Connect Google Workspace",
                    "action": {
                        "type": "connector.auth.start",
                        "connector": "google_workspace",
                        "source": "connectors_page"
                    }
                }
            ]
        })])
        .expect("control action");

        assert_eq!(action.label.as_deref(), Some("Connect Google Workspace"));
        assert_eq!(
            action
                .action
                .get("type")
                .and_then(serde_json::Value::as_str),
            Some("connector.auth.start")
        );
        assert_eq!(
            action
                .action
                .get("connector")
                .and_then(serde_json::Value::as_str),
            Some("google_workspace")
        );
    }

    #[test]
    fn rejects_remote_http_image_content_block() {
        let root = std::env::temp_dir();
        let err = extract_user_input_and_items(
            &[json!({
                "role": "user",
                "content": [
                    {"type": "text", "text": "read this"},
                    {"type": "image_url", "image_url": {"url": "https://example.com/image.png"}}
                ]
            })],
            &root,
        )
        .expect_err("remote image URLs should be rejected before Codex app-server");

        assert!(format!("{err:?}").contains("remote image URLs"));
    }

    #[test]
    fn rejects_remote_image_file_url() {
        let root = std::env::temp_dir();
        let err = extract_user_input_and_items(
            &[json!({
                "role": "user",
                "content": [
                    {
                        "type": "file",
                        "file": {
                            "url": "http://example.com/chart.png",
                            "name": "chart.png",
                            "mime_type": "image/png"
                        }
                    }
                ]
            })],
            &root,
        )
        .expect_err("remote image file URLs should be rejected before Codex app-server");

        assert!(format!("{err:?}").contains("remote image URLs"));
    }

    #[test]
    fn accepts_inline_data_image_content_block() {
        let root = std::env::temp_dir();
        let (_text, items, _content, attachments) = extract_user_input_and_items(
            &[json!({
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": "data:image/png;base64,SGVsbG8="}
                ]
            })],
            &root,
        )
        .expect("inline data image URL should still be accepted");

        assert_eq!(items.len(), 1);
        assert_eq!(
            items[0].get("url").and_then(serde_json::Value::as_str),
            Some("data:image/png;base64,SGVsbG8=")
        );
        assert!(attachments.is_empty());
    }
}
