use std::collections::HashSet;
use std::fs::Metadata;
use std::time::UNIX_EPOCH;

use async_stream::stream;
use axum::body::{Body, Bytes};
use axum::extract::{Multipart, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Response, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::io::AsyncReadExt;
use uuid::Uuid;

use crate::api::users::{assert_workspace_save_within_quota, assert_workspace_writes_within_quota};
use crate::api::{audit_event, require_confirm, ApiError};
use crate::document_preview;
use crate::state::AppState;
use crate::storage::{sha256_hex, FileRefRecord};
use crate::user::user_id_from_headers;
use crate::workspace as ws;

pub const WORKSPACE_UPLOAD_BODY_LIMIT_BYTES: usize = 128 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub struct WorkspacePathQuery {
    path: Option<String>,
}

pub async fn list_workspace(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<WorkspacePathQuery>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let workspace = state.sandboxes.ensure_sandbox(&user_id)?;
    let listing = ws::list_directory(&workspace, query.path.as_deref().unwrap_or("/workspace"))
        .map_err(map_workspace_error)?;
    Ok(Json(
        serde_json::to_value(listing).unwrap_or_else(|_| json!({})),
    ))
}

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    q: Option<String>,
    limit: Option<usize>,
    scope: Option<String>,
    kind: Option<String>,
    file_type: Option<String>,
    include_hidden: Option<bool>,
    max_file_bytes: Option<u64>,
}

pub async fn search_workspace(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let workspace = state.sandboxes.ensure_sandbox(&user_id)?;
    let result = ws::search_files(
        &workspace,
        query.q.as_deref().unwrap_or(""),
        query.limit.unwrap_or(20).clamp(1, 50),
        query.scope.as_deref().unwrap_or("name"),
        query.kind.as_deref().unwrap_or("all"),
        query.file_type.as_deref().unwrap_or("all"),
        query.include_hidden.unwrap_or(false),
        query.max_file_bytes.unwrap_or(1024 * 1024),
    )
    .map_err(map_workspace_error)?;
    Ok(Json(
        serde_json::to_value(result).unwrap_or_else(|_| json!({})),
    ))
}

#[derive(Debug, Deserialize)]
pub struct FileQuery {
    path: String,
    limit: Option<usize>,
}

pub async fn get_workspace_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<FileQuery>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let workspace = state.sandboxes.workspace_dir(&user_id)?;
    if !workspace.exists() {
        return Err(ApiError::not_found(format!(
            "Sandbox for user {user_id:?} not found"
        )));
    }
    let preview = ws::preview_file(&workspace, &query.path, query.limit.unwrap_or(64 * 1024))
        .map_err(map_workspace_error)?;
    Ok(Json(
        serde_json::to_value(preview).unwrap_or_else(|_| json!({})),
    ))
}

#[derive(Debug, Deserialize)]
pub struct SaveFileInput {
    path: String,
    content: String,
    expected_modified_at: Option<String>,
}

pub async fn save_workspace_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<SaveFileInput>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let workspace = state.sandboxes.workspace_dir(&user_id)?;
    if !workspace.exists() {
        return Err(ApiError::not_found(format!(
            "Sandbox for user {user_id:?} not found"
        )));
    }
    let target = ws::validate_write_path(&input.path, &workspace).map_err(map_workspace_error)?;
    assert_workspace_save_within_quota(
        &state,
        &user_id,
        &target,
        input.content.as_bytes().len() as u64,
    )
    .await?;
    let preview = ws::save_text_file(
        &workspace,
        &input.path,
        &input.content,
        input.expected_modified_at.as_deref(),
    )
    .map_err(map_workspace_error)?;
    record_file_ref(
        &state,
        &user_id,
        &workspace,
        &target,
        &ws::mime_type_for_path(&target),
        input.content.as_bytes(),
        None,
    )
    .await?;
    Ok(Json(
        serde_json::to_value(preview).unwrap_or_else(|_| json!({})),
    ))
}

#[derive(Debug, Deserialize)]
pub struct RenameInput {
    path: String,
    name: String,
}

pub async fn rename_workspace(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<RenameInput>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let workspace = state.sandboxes.ensure_sandbox(&user_id)?;
    let entry =
        ws::rename_entry(&workspace, &input.path, &input.name).map_err(map_workspace_error)?;
    Ok(Json(
        serde_json::to_value(entry).unwrap_or_else(|_| json!({})),
    ))
}

#[derive(Debug, Deserialize)]
pub struct DownloadQuery {
    path: String,
}

fn workspace_download_etag(metadata: &Metadata) -> String {
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("W/\"{:x}-{modified_nanos:x}\"", metadata.len())
}

fn request_matches_etag(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(',')
                .map(str::trim)
                .any(|candidate| candidate == "*" || candidate == etag)
        })
}

fn streamed_file_body(path: std::path::PathBuf) -> Body {
    Body::from_stream(stream! {
        let mut file = match tokio::fs::File::open(path).await {
            Ok(file) => file,
            Err(err) => {
                yield Err::<Bytes, std::io::Error>(err);
                return;
            }
        };
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            let count = match file.read(&mut buffer).await {
                Ok(count) => count,
                Err(err) => {
                    yield Err::<Bytes, std::io::Error>(err);
                    return;
                }
            };
            if count == 0 {
                break;
            }
            yield Ok::<Bytes, std::io::Error>(Bytes::copy_from_slice(&buffer[..count]));
        }
    })
}

fn ascii_content_disposition_filename(filename: &str) -> String {
    let (stem, extension) = filename
        .rsplit_once('.')
        .filter(|(_, extension)| {
            !extension.is_empty()
                && extension.len() <= 16
                && extension.chars().all(|ch| ch.is_ascii_alphanumeric())
        })
        .map(|(stem, extension)| (stem, Some(extension)))
        .unwrap_or((filename, None));
    let mut fallback = String::new();
    let mut last_was_separator = false;
    for ch in stem.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
            fallback.push(ch);
            last_was_separator = false;
        } else if !last_was_separator {
            fallback.push('_');
            last_was_separator = true;
        }
    }
    let fallback = fallback
        .trim_matches(|ch| ch == '.' || ch == '-' || ch == '_')
        .to_string();
    let stem = if fallback.chars().any(|ch| ch.is_ascii_alphanumeric()) {
        fallback
    } else {
        "download".to_string()
    };
    match extension {
        Some(extension) => format!("{stem}.{extension}"),
        None => stem,
    }
}

fn content_disposition_header(disposition_type: &str, filename: &str) -> HeaderValue {
    let fallback = ascii_content_disposition_filename(filename);
    let encoded = url::form_urlencoded::byte_serialize(filename.as_bytes()).collect::<String>();
    HeaderValue::from_str(&format!(
        "{disposition_type}; filename=\"{fallback}\"; filename*=UTF-8''{encoded}"
    ))
    .unwrap_or_else(|_| HeaderValue::from_static("attachment"))
}

pub async fn download_workspace_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<DownloadQuery>,
) -> Result<Response<Body>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let workspace = state.sandboxes.workspace_dir(&user_id)?;
    let target =
        ws::validate_existing_path(&query.path, &workspace).map_err(map_workspace_error)?;
    if !target.is_file() {
        return Err(ApiError::bad_request("Path is not a file"));
    }
    let metadata = tokio::fs::metadata(&target).await?;
    let etag = workspace_download_etag(&metadata);
    let filename = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download");
    let mut response = if request_matches_etag(&headers, &etag) {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NOT_MODIFIED;
        response
    } else {
        Response::new(streamed_file_body(target.clone()))
    };
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&ws::mime_type_for_path(&target))
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    response.headers_mut().insert(
        header::ETAG,
        HeaderValue::from_str(&etag).unwrap_or_else(|_| HeaderValue::from_static("W/\"0-0\"")),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        content_disposition_header("attachment", filename),
    );
    Ok(response)
}

pub async fn preview_workspace_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<DownloadQuery>,
) -> Result<Response<Body>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let workspace = state.sandboxes.workspace_dir(&user_id)?;
    let preview =
        document_preview::render_document_preview(&state.config, &workspace, &user_id, &query.path)
            .await
            .map_err(map_workspace_error)?;
    let metadata = tokio::fs::metadata(&preview.pdf_path).await?;
    let etag = workspace_download_etag(&metadata);
    let mut response = if request_matches_etag(&headers, &etag) {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NOT_MODIFIED;
        response
    } else {
        Response::new(streamed_file_body(preview.pdf_path.clone()))
    };
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/pdf"),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    response.headers_mut().insert(
        header::ETAG,
        HeaderValue::from_str(&etag).unwrap_or_else(|_| HeaderValue::from_static("W/\"0-0\"")),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        content_disposition_header("inline", &preview.download_name),
    );
    Ok(response)
}

pub async fn upload_workspace_attachment(
    State(state): State<AppState>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    save_workspace_attachment(state, headers, multipart).await
}

pub async fn upload_workspace_files(
    State(state): State<AppState>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    save_multipart_files(state, headers, multipart, "/workspace").await
}

async fn save_multipart_files(
    state: AppState,
    headers: HeaderMap,
    mut multipart: Multipart,
    default_dir: &str,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let workspace = state.sandboxes.ensure_sandbox(&user_id)?;
    let mut target_dir = default_dir.to_string();
    let mut overwrite = false;
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|err| ApiError::bad_request(err.to_string()))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "path" {
            target_dir = field
                .text()
                .await
                .map_err(|err| ApiError::bad_request(err.to_string()))?;
            continue;
        }
        if name == "overwrite" {
            overwrite = parse_bool_field(
                &field
                    .text()
                    .await
                    .map_err(|err| ApiError::bad_request(err.to_string()))?,
            );
            continue;
        }
        if name != "file" && name != "files" {
            continue;
        }
        let filename = field.file_name().unwrap_or("upload.bin").to_string();
        let bytes = field
            .bytes()
            .await
            .map_err(|err| ApiError::bad_request(err.to_string()))?
            .to_vec();
        files.push((sanitize_filename(&filename), bytes));
    }
    if files.is_empty() {
        return Err(ApiError::bad_request("No files uploaded"));
    }
    let dir = ws::validate_existing_path(&target_dir, &workspace).map_err(map_workspace_error)?;
    if !dir.is_dir() {
        return Err(ApiError::bad_request("Path is not a directory"));
    }

    let mut conflicts = Vec::new();
    let mut prepared = Vec::new();
    let mut seen_targets = HashSet::new();
    for (filename, bytes) in files {
        let path = ws::validate_write_path(&dir.join(&filename).to_string_lossy(), &workspace)
            .map_err(map_workspace_error)?;
        let virtual_path = ws::workspace_path(&workspace, &path).map_err(map_workspace_error)?;
        if (seen_targets.contains(&path) || path.exists()) && (path.is_dir() || !overwrite) {
            conflicts.push(json!({"name": filename, "path": virtual_path}));
        }
        seen_targets.insert(path.clone());
        prepared.push((path, bytes));
    }
    if !conflicts.is_empty() {
        return Err(ApiError::conflict(json!({
            "code": "workspace_upload_conflict",
            "conflicts": conflicts
        })));
    }

    let quota_targets = prepared
        .iter()
        .map(|(path, bytes)| (path.clone(), bytes.len() as u64))
        .collect::<Vec<_>>();
    assert_workspace_writes_within_quota(&state, &user_id, &quota_targets).await?;

    let mut entries = Vec::new();
    for (path, bytes) in prepared {
        tokio::fs::write(&path, &bytes).await?;
        record_file_ref(
            &state,
            &user_id,
            &workspace,
            &path,
            &ws::mime_type_for_path(&path),
            &bytes,
            None,
        )
        .await?;
        entries.push(
            serde_json::to_value(
                ws::entry_for_existing_path(&workspace, &path).map_err(map_workspace_error)?,
            )
            .unwrap_or_else(|_| json!({})),
        );
    }
    Ok(Json(json!({ "entries": entries })))
}

async fn save_workspace_attachment(
    state: AppState,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let workspace = state.sandboxes.ensure_sandbox(&user_id)?;
    let mut requested_kind = "attachment".to_string();
    let mut file: Option<(String, Option<String>, Vec<u8>)> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|err| ApiError::bad_request(err.to_string()))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "kind" {
            requested_kind = field
                .text()
                .await
                .map_err(|err| ApiError::bad_request(err.to_string()))?;
            continue;
        }
        if name != "file" && name != "files" {
            continue;
        }
        let filename = sanitize_filename(field.file_name().unwrap_or("upload.bin"));
        let content_type = field.content_type().map(str::to_string);
        let bytes = field
            .bytes()
            .await
            .map_err(|err| ApiError::bad_request(err.to_string()))?
            .to_vec();
        file = Some((filename, content_type, bytes));
    }

    let Some((filename, content_type, bytes)) = file else {
        return Err(ApiError::bad_request("No file uploaded"));
    };
    if bytes.is_empty() {
        return Err(ApiError::bad_request("Uploaded file is empty"));
    }

    let mime_type = content_type
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| ws::mime_type_for_path(std::path::Path::new(&filename)));
    let kind = if requested_kind.trim() == "image"
        || mime_type.to_ascii_lowercase().starts_with("image/")
    {
        "image"
    } else {
        "attachment"
    };
    let now = OffsetDateTime::now_utc();
    let target_dir = workspace
        .join("uploads")
        .join(format!("{:04}", now.year()))
        .join(format!("{:02}", u8::from(now.month())));
    let target = target_dir.join(format!("{}-{filename}", Uuid::new_v4().simple()));
    assert_workspace_save_within_quota(&state, &user_id, &target, bytes.len() as u64).await?;
    tokio::fs::create_dir_all(&target_dir).await?;
    tokio::fs::write(&target, &bytes).await?;
    let path = ws::workspace_path(&workspace, &target).map_err(map_workspace_error)?;
    record_file_ref(
        &state, &user_id, &workspace, &target, &mime_type, &bytes, None,
    )
    .await?;
    Ok(Json(json!({
        "path": path,
        "name": filename,
        "mime_type": mime_type,
        "size": bytes.len(),
        "kind": kind
    })))
}

fn sanitize_filename(name: &str) -> String {
    let clean = name
        .chars()
        .map(|ch| {
            if ch == '/' || ch == '\\' || ch.is_control() {
                '_'
            } else {
                ch
            }
        })
        .collect::<String>();
    if clean.trim().is_empty() {
        "upload.bin".to_string()
    } else {
        clean
    }
}

fn parse_bool_field(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

async fn record_file_ref(
    state: &AppState,
    user_id: &str,
    workspace: &std::path::Path,
    target: &std::path::Path,
    mime_type: &str,
    bytes: &[u8],
    linked_session_id: Option<String>,
) -> Result<(), ApiError> {
    let workspace_path = ws::workspace_path(workspace, target).map_err(map_workspace_error)?;
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
            workspace_path: Some(workspace_path),
            mime_type: Some(mime_type.to_string()),
            size_bytes: Some(bytes.len() as u64),
            sha256: Some(sha256_hex(bytes)),
            created_at: now_iso(),
            linked_session_id,
        })
        .await?;
    Ok(())
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

#[derive(Debug, Deserialize)]
pub struct DeleteInput {
    path: String,
    #[serde(default)]
    confirm: bool,
}

pub async fn delete_workspace(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<DeleteInput>,
) -> Result<StatusCode, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    if state.config.security.require_confirm_for_risky_api {
        require_confirm(Some(&json!({"confirm": input.confirm})), "workspace.delete")?;
    }
    let workspace = state.sandboxes.workspace_dir(&user_id)?;
    if !workspace.exists() {
        return Err(ApiError::not_found(format!("Sandbox not found")));
    }
    ws::delete_entry(&workspace, &input.path).map_err(map_workspace_error)?;
    audit_event(
        &state,
        &user_id,
        "workspace.delete",
        true,
        json!({"path": input.path}),
    )
    .await?;
    Ok(StatusCode::OK)
}

#[derive(Debug, Deserialize)]
pub struct CreateInput {
    path: String,
    kind: String, // "file" | "directory"
}

pub async fn create_workspace(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateInput>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let workspace = state.sandboxes.ensure_sandbox(&user_id)?;
    let entry =
        ws::create_entry(&workspace, &input.path, &input.kind).map_err(map_workspace_error)?;

    if input.kind == "file" {
        let target_path =
            ws::validate_existing_path(&entry.path, &workspace).map_err(map_workspace_error)?;
        record_file_ref(
            &state,
            &user_id,
            &workspace,
            &target_path,
            &ws::mime_type_for_path(&target_path),
            b"",
            None,
        )
        .await?;
    }

    Ok(Json(
        serde_json::to_value(entry).unwrap_or_else(|_| json!({})),
    ))
}

#[derive(Debug, Deserialize)]
pub struct PasteInput {
    path: String,
    destination_dir: String,
    action: String, // "move" | "copy"
}

pub async fn paste_workspace(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<PasteInput>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let workspace = state.sandboxes.ensure_sandbox(&user_id)?;

    if input.action == "copy" {
        let copy_size =
            ws::copy_source_size(&workspace, &input.path).map_err(map_workspace_error)?;
        let destination =
            ws::paste_destination_path(&workspace, &input.path, &input.destination_dir)
                .map_err(map_workspace_error)?;
        assert_workspace_save_within_quota(&state, &user_id, &destination, copy_size).await?;
    }

    let entry = ws::paste_entry(
        &workspace,
        &input.path,
        &input.destination_dir,
        &input.action,
    )
    .map_err(map_workspace_error)?;

    if input.action == "copy" {
        let target_path =
            ws::validate_existing_path(&entry.path, &workspace).map_err(map_workspace_error)?;
        if target_path.is_file() {
            if let Ok(bytes) = tokio::fs::read(&target_path).await {
                record_file_ref(
                    &state,
                    &user_id,
                    &workspace,
                    &target_path,
                    &ws::mime_type_for_path(&target_path),
                    &bytes,
                    None,
                )
                .await?;
            }
        } else {
            let mut walk = walkdir::WalkDir::new(&target_path)
                .into_iter()
                .filter_map(Result::ok);
            while let Some(e) = walk.next() {
                let p = e.path();
                if p.is_file() {
                    if let Ok(bytes) = tokio::fs::read(p).await {
                        record_file_ref(
                            &state,
                            &user_id,
                            &workspace,
                            p,
                            &ws::mime_type_for_path(p),
                            &bytes,
                            None,
                        )
                        .await?;
                    }
                }
            }
        }
    } else if input.action == "move" {
        let target_path =
            ws::validate_existing_path(&entry.path, &workspace).map_err(map_workspace_error)?;
        if target_path.is_file() {
            if let Ok(bytes) = tokio::fs::read(&target_path).await {
                record_file_ref(
                    &state,
                    &user_id,
                    &workspace,
                    &target_path,
                    &ws::mime_type_for_path(&target_path),
                    &bytes,
                    None,
                )
                .await?;
            }
        }
    }

    Ok(Json(
        serde_json::to_value(entry).unwrap_or_else(|_| json!({})),
    ))
}

fn map_workspace_error(err: anyhow::Error) -> ApiError {
    let message = err.to_string();
    if message.contains("Access denied") {
        ApiError::new(StatusCode::FORBIDDEN, "Access denied")
    } else if message.contains("No such file") || message.contains("not found") {
        ApiError::not_found("Path not found")
    } else if message.contains("File changed on disk") {
        ApiError::conflict("File changed on disk")
    } else if message.contains("Binary files") {
        ApiError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, message)
    } else {
        ApiError::bad_request(message)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use axum::body::{to_bytes, Body};
    use axum::http::{header, Method, Request, StatusCode};
    use serde_json::{json, Value};
    use tower::ServiceExt;

    use crate::api::router;
    use crate::config::{
        AppConfig, CodexConfig, CorsConfig, FeishuConfig, GogcliOAuthConfig, LoggingConfig,
        SandboxConfig, SecurityConfig, SkillsConfig, UserAuthConfig,
    };
    use crate::state::AppState;

    fn test_state(max_workspace_mb: u64) -> AppState {
        let root = std::env::temp_dir().join(format!(
            "ripple-api-workspace-test-{}",
            uuid::Uuid::new_v4()
        ));
        AppState::new(AppConfig {
            repo_root: root.clone(),
            host: "127.0.0.1".to_string(),
            port: 0,
            api_keys: vec!["service-key".to_string()],
            security: SecurityConfig::default(),
            user_auth: UserAuthConfig::default(),
            api_docs: crate::config::ApiDocsConfig::default(),
            cors: CorsConfig::default(),
            default_model: "codex-test".to_string(),
            model_presets: BTreeMap::new(),
            logging: LoggingConfig {
                level: "debug".to_string(),
            },
            sandbox: SandboxConfig {
                sandboxes_root: root.join("sandboxes"),
                caches_root: root.join("cache"),
                idle_suspend_seconds: 1800,
                retention_seconds: 604_800,
                max_workspace_mb,
                tmpfs_size_mb: 512,
                nsjail_path: "nsjail".to_string(),
                python_envs_root: root.join("cache/python-envs"),
                python_env_uv_cache: root.join("cache/uv-cache"),
                python_env_max_packages: 20,
                uv_bin_dir: None,
                node_dir: None,
                lark_cli_install_root: None,
                notion_cli_install_root: None,
                gogcli_cli_install_root: None,
                cli_tools: Vec::new(),
                pypi_mirror_url: None,
                npm_registry_url: None,
            },
            codex: CodexConfig {
                enabled: true,
                codex_executable: "codex".to_string(),
                app_server_args: Vec::new(),
                codex_home: None,
                approval_policy: "never".to_string(),
                sandbox_type: "workspace-write".to_string(),
                network_access: true,
                idle_timeout_seconds: 1800,
                max_runtime_seconds: 3600,
            },
            schedule_extraction_max_runtime_seconds: 120,
            schedule_poll_interval_seconds: 15,
            document_preview: crate::config::DocumentPreviewConfig {
                cache_root: root.join("cache/previews"),
                libreoffice_path: "soffice".to_string(),
                max_source_bytes: 64 * 1024 * 1024,
                conversion_timeout_seconds: 120,
            },
            skills: SkillsConfig {
                shared_dirs: Vec::new(),
            },
            public_base_url: None,
            feishu: FeishuConfig::default(),
            gogcli_oauth: GogcliOAuthConfig {
                auto_register_client: true,
                auto_from_request: true,
                callback_url: None,
                client_secret_json: None,
                client: None,
            },
        })
    }

    async fn request_json(
        state: AppState,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header(header::AUTHORIZATION, "Bearer service-key")
            .header("X-Ripple-User-Id", "alice");
        if body.is_some() {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
        }
        let body = body
            .map(|value| Body::from(value.to_string()))
            .unwrap_or_else(Body::empty);
        let response = router(state)
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}));
        (status, value)
    }

    async fn request_bytes(
        state: AppState,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header(header::AUTHORIZATION, "Bearer service-key")
            .header("X-Ripple-User-Id", "alice");
        if body.is_some() {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
        }
        let body = body
            .map(|value| Body::from(value.to_string()))
            .unwrap_or_else(Body::empty);
        let response = router(state)
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let (parts, body) = response.into_parts();
        let bytes = to_bytes(body, usize::MAX).await.unwrap().to_vec();
        (parts.status, parts.headers, bytes)
    }

    #[tokio::test]
    async fn download_workspace_file_uses_utf8_content_disposition_for_non_ascii_filename(
    ) -> anyhow::Result<()> {
        let state = test_state(2048);
        let workspace = state.sandboxes.ensure_sandbox("alice")?;
        let filename = "上市公司联系人一页展示.pptx";
        std::fs::write(workspace.join(filename), b"deck")?;

        let encoded_path =
            url::form_urlencoded::byte_serialize(format!("/workspace/{filename}").as_bytes())
                .collect::<String>();
        let (status, headers, body) = request_bytes(
            state,
            Method::GET,
            &format!("/v1/workspace/download?path={encoded_path}"),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, b"deck");
        let disposition = headers
            .get(header::CONTENT_DISPOSITION)
            .expect("content-disposition header")
            .to_str()?;
        assert!(
            disposition.contains("filename=\"download.pptx\""),
            "{disposition}"
        );
        assert!(
            disposition.contains(
                "filename*=UTF-8''%E4%B8%8A%E5%B8%82%E5%85%AC%E5%8F%B8%E8%81%94%E7%B3%BB%E4%BA%BA%E4%B8%80%E9%A1%B5%E5%B1%95%E7%A4%BA.pptx"
            ),
            "{disposition}"
        );
        assert!(!disposition.contains("上市公司"), "{disposition}");
        Ok(())
    }

    #[tokio::test]
    async fn paste_copy_checks_quota_before_writing() -> anyhow::Result<()> {
        let state = test_state(0);
        let workspace = state.sandboxes.ensure_sandbox("alice")?;
        std::fs::write(workspace.join("source.txt"), "new bytes")?;
        std::fs::create_dir_all(workspace.join("dest"))?;

        let (status, body) = request_json(
            state,
            Method::POST,
            "/v1/workspace/paste",
            Some(json!({
                "path": "/workspace/source.txt",
                "destination_dir": "/workspace/dest",
                "action": "copy"
            })),
        )
        .await;

        assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");
        assert!(!workspace.join("dest/source.txt").exists());
        Ok(())
    }
}
