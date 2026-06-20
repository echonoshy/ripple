use std::ffi::OsString;
use std::path::{Path as FsPath, PathBuf};

use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::api::users::assert_workspace_save_within_quota;
use crate::jobs::AgentRunInfo;
use crate::state::AppState;
use crate::storage::{sha256_hex, FileRefRecord};
use crate::workspace as ws;

pub(crate) fn image_event_to_message_block(event: &Value) -> Option<Value> {
    match event.get("type").and_then(Value::as_str) {
        Some("image_generation") | Some("image_view") => {}
        _ => return None,
    }
    let workspace_path = event.get("workspace_path").and_then(Value::as_str)?;
    let mut object = serde_json::Map::new();
    object.insert("type".to_string(), json!("image"));
    object.insert("workspace_path".to_string(), json!(workspace_path));
    if let Some(mime_type) = event.get("mime_type").and_then(Value::as_str) {
        object.insert("mime_type".to_string(), json!(mime_type));
    }
    if let Some(size) = event.get("size").and_then(Value::as_u64) {
        object.insert("size".to_string(), json!(size));
    }
    if let Some(revised_prompt) = event.get("revised_prompt").and_then(Value::as_str) {
        object.insert("revised_prompt".to_string(), json!(revised_prompt));
    }
    Some(Value::Object(object))
}

pub(crate) async fn collect_chat_image_events(
    state: &AppState,
    user_id: &str,
    info: &AgentRunInfo,
    workspace_root: &FsPath,
) -> Vec<Value> {
    let mut image_events = Vec::new();
    let mut offset = 0_usize;
    if let Some(events_file) = info.events_file.as_deref() {
        for event in read_events_from_offset(FsPath::new(events_file), &mut offset).await {
            if let Some(image_event) =
                extract_image_event(state, user_id, &event, workspace_root).await
            {
                image_events.push(image_event);
            }
        }
    }
    image_events
}

pub(crate) async fn extract_image_event(
    state: &AppState,
    user_id: &str,
    event: &Value,
    workspace_root: &FsPath,
) -> Option<Value> {
    if event.get("type").and_then(Value::as_str) != Some("codex.notification") {
        return None;
    }
    let message = event.pointer("/data/message")?;
    if message.get("method").and_then(Value::as_str) != Some("item/completed") {
        return None;
    }
    let item = message.pointer("/params/item")?;
    let item_type = item.get("type").and_then(Value::as_str)?;
    if item_type == "imageView" {
        return Some(json!({
            "type": "image_view",
            "id": item.get("id").cloned().unwrap_or(Value::Null),
            "workspace_path": item.get("path").and_then(Value::as_str).and_then(|path| workspace_path_or_none(workspace_root, path))
        }));
    }
    if item_type != "imageGeneration" {
        return None;
    }

    let mut payload = json!({
        "type": "image_generation",
        "id": item.get("id").cloned().unwrap_or(Value::Null),
        "status": item.get("status").cloned().unwrap_or(Value::Null),
        "revised_prompt": item.get("revisedPrompt").cloned().unwrap_or(Value::Null)
    });
    if let Some(imported) = import_generated_image(state, user_id, workspace_root, item).await {
        if let Some(object) = payload.as_object_mut() {
            object.insert("workspace_path".to_string(), json!(imported.workspace_path));
            object.insert("mime_type".to_string(), json!("image/png"));
            object.insert("size".to_string(), json!(imported.size));
        }
    }
    Some(payload)
}

struct ImportedImage {
    workspace_path: String,
    size: usize,
}

async fn import_generated_image(
    state: &AppState,
    user_id: &str,
    workspace_root: &FsPath,
    item: &Value,
) -> Option<ImportedImage> {
    let item_id = item
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("generated-image");
    let data = if let Some(saved_path) = item.get("savedPath").and_then(Value::as_str) {
        read_generated_image_path(workspace_root, saved_path).await
    } else {
        None
    }
    .or_else(|| {
        item.get("result")
            .and_then(Value::as_str)
            .and_then(decode_base64_image_payload)
    })?;

    let now = OffsetDateTime::now_utc();
    let target_virtual_path = format!(
        "/workspace/outputs/images/{:04}/{:02}/{}.png",
        now.year(),
        u8::from(now.month()),
        sanitize_filename(item_id)
    );
    let target = ws::validate_write_path(&target_virtual_path, workspace_root).ok()?;
    let target_dir = target.parent()?;
    let write_lock = state.workspace_write_lock(user_id);
    let _write_guard = write_lock.lock_owned().await;
    assert_workspace_save_within_quota(state, user_id, &target, data.len() as u64)
        .await
        .ok()?;
    if tokio::fs::create_dir_all(target_dir).await.is_err() {
        return None;
    }
    if tokio::fs::write(&target, &data).await.is_err() {
        return None;
    }
    let workspace_path = workspace_path_or_none(workspace_root, target.to_str()?)?;
    let file_id = format!(
        "file-{}",
        &sha256_hex(format!("{user_id}:{workspace_path}").as_bytes())[..24]
    );
    state
        .storage
        .upsert_file_ref(&FileRefRecord {
            file_id,
            user_id: user_id.to_string(),
            storage_backend: "local".to_string(),
            storage_uri: workspace_path.clone(),
            workspace_path: Some(workspace_path.clone()),
            mime_type: Some("image/png".to_string()),
            size_bytes: Some(data.len() as u64),
            sha256: Some(sha256_hex(&data)),
            created_at: now_iso(),
            linked_session_id: None,
        })
        .await
        .ok()?;
    Some(ImportedImage {
        workspace_path,
        size: data.len(),
    })
}

async fn read_generated_image_path(workspace_root: &FsPath, raw_path: &str) -> Option<Vec<u8>> {
    let path = host_path_for_image_event_path(workspace_root, raw_path)?;
    let metadata = tokio::fs::metadata(&path).await.ok()?;
    if !metadata.is_file() {
        return None;
    }
    tokio::fs::read(path).await.ok()
}

pub(crate) fn workspace_path_or_none(workspace_root: &FsPath, raw_path: &str) -> Option<String> {
    let path = host_path_for_image_event_path(workspace_root, raw_path)?;
    let workspace = workspace_root.canonicalize().ok()?;
    let resolved = resolve_path_for_workspace_check(&path)?;
    if !resolved.starts_with(&workspace) {
        return None;
    }
    let relative = resolved.strip_prefix(&workspace).ok()?;
    if relative.as_os_str().is_empty() {
        Some("/workspace".to_string())
    } else {
        Some(format!(
            "/workspace/{}",
            relative.to_string_lossy().replace('\\', "/")
        ))
    }
}

fn resolve_path_for_workspace_check(path: &FsPath) -> Option<PathBuf> {
    if path.exists() {
        return path.canonicalize().ok();
    }
    canonicalize_existing_prefix(path).or_else(|| Some(normalize_path(path)))
}

fn canonicalize_existing_prefix(path: &FsPath) -> Option<PathBuf> {
    let mut current = path;
    let mut missing = Vec::<OsString>::new();
    while !current.exists() {
        missing.push(current.file_name()?.to_os_string());
        current = current.parent()?;
    }
    let mut resolved = current.canonicalize().ok()?;
    for component in missing.iter().rev() {
        resolved.push(component);
    }
    Some(resolved)
}

fn host_path_for_image_event_path(workspace_root: &FsPath, raw_path: &str) -> Option<PathBuf> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        if let Ok(relative) = path.strip_prefix("/workspace") {
            Some(workspace_root.join(relative))
        } else {
            Some(path)
        }
    } else {
        Some(workspace_root.join(path))
    }
}

fn normalize_path(path: &FsPath) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn sanitize_filename(name: &str) -> String {
    let clean = name
        .chars()
        .map(|ch| {
            if ch == '/' || ch == '\\' || ch.is_control() {
                '-'
            } else {
                ch
            }
        })
        .collect::<String>()
        .trim_matches(|ch: char| ch == ' ' || ch == '.' || ch == '-')
        .to_string();
    if clean.is_empty() {
        "generated-image".to_string()
    } else {
        clean
    }
}

pub(crate) fn decode_base64_image_payload(payload: &str) -> Option<Vec<u8>> {
    let raw = if payload.starts_with("data:") {
        payload.split_once(',')?.1
    } else {
        payload
    };
    decode_base64(raw)
}

fn decode_base64(input: &str) -> Option<Vec<u8>> {
    let mut buffer = Vec::new();
    let mut quartet = [0_u8; 4];
    let mut count = 0_usize;
    for ch in input.chars().filter(|ch| !ch.is_ascii_whitespace()) {
        let value = match ch {
            'A'..='Z' => ch as u8 - b'A',
            'a'..='z' => ch as u8 - b'a' + 26,
            '0'..='9' => ch as u8 - b'0' + 52,
            '+' => 62,
            '/' => 63,
            '=' => 64,
            _ => return None,
        };
        quartet[count] = value;
        count += 1;
        if count == 4 {
            push_base64_quartet(&mut buffer, quartet)?;
            count = 0;
        }
    }
    if count != 0 {
        return None;
    }
    Some(buffer)
}

fn push_base64_quartet(buffer: &mut Vec<u8>, quartet: [u8; 4]) -> Option<()> {
    let pad = quartet
        .iter()
        .rev()
        .take_while(|value| **value == 64)
        .count();
    if pad > 2 || quartet[..4 - pad].iter().any(|value| *value == 64) {
        return None;
    }
    let a = quartet[0];
    let b = quartet[1];
    let c = if quartet[2] == 64 { 0 } else { quartet[2] };
    let d = if quartet[3] == 64 { 0 } else { quartet[3] };
    buffer.push((a << 2) | (b >> 4));
    if pad < 2 {
        buffer.push((b << 4) | (c >> 2));
    }
    if pad == 0 {
        buffer.push((c << 6) | d);
    }
    Some(())
}

async fn read_events_from_offset(events_file: &FsPath, offset: &mut usize) -> Vec<Value> {
    let Ok(bytes) = tokio::fs::read(events_file).await else {
        return Vec::new();
    };
    if bytes.len() < *offset {
        *offset = 0;
    }
    let slice = &bytes[*offset..];
    *offset = bytes.len();
    slice
        .split(|byte| *byte == b'\n')
        .filter_map(|line| {
            if line.iter().all(u8::is_ascii_whitespace) {
                return None;
            }
            serde_json::from_slice::<Value>(line).ok()
        })
        .filter(|value| value.is_object())
        .collect()
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}
