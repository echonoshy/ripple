use std::path::Path;

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::api::ApiError;
use crate::state::AppState;
use crate::storage::{sha256_hex, FileRefRecord};
use crate::user::user_id_from_headers;
use crate::workspace as ws;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DocumentState {
    version: u32,
    documents: Vec<DocumentRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DocumentRecord {
    document_id: String,
    title: String,
    path: String,
    kind: String,
    source: String,
    linked_session_id: Option<String>,
    summary: String,
    created_at: String,
    updated_at: String,
    last_modified_at: String,
}

#[derive(Debug, Deserialize)]
pub struct DocumentListQuery {
    q: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DocumentCreateInput {
    title: String,
    path: String,
    linked_session_id: Option<String>,
    #[serde(default)]
    summary: String,
}

#[derive(Debug, Deserialize)]
pub struct DocumentUpdateInput {
    title: Option<String>,
    linked_session_id: Option<String>,
    summary: Option<String>,
}

pub async fn list_documents(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<DocumentListQuery>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let mut documents = load_document_state(&state, &user_id).await?.documents;
    if let Some(q) = query.q.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        let q = q.to_ascii_lowercase();
        documents.retain(|doc| {
            [doc.title.as_str(), doc.path.as_str(), doc.summary.as_str()]
                .join("\n")
                .to_ascii_lowercase()
                .contains(&q)
        });
    }
    documents.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(Json(
        json!({ "documents": documents, "count": documents.len() }),
    ))
}

pub async fn create_document(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<DocumentCreateInput>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let workspace = state.sandboxes.workspace_dir(&user_id)?;
    if !workspace.exists() {
        return Err(ApiError::not_found(format!(
            "Sandbox for user {user_id:?} not found"
        )));
    }
    let target =
        ws::validate_existing_path(&input.path, &workspace).map_err(map_workspace_error)?;
    if !target.is_file() {
        return Err(ApiError::not_found("Path not found"));
    }
    let title = input.title.trim();
    if title.is_empty() {
        return Err(ApiError::bad_request("title is required"));
    }
    let mut state_doc = load_document_state(&state, &user_id).await?;
    let now = now_iso();
    let document = DocumentRecord {
        document_id: format!("doc-{}", &Uuid::new_v4().simple().to_string()[..12]),
        title: title.to_string(),
        path: ws::workspace_path(&workspace, &target).map_err(map_workspace_error)?,
        kind: infer_kind(&target),
        source: "workspace".to_string(),
        linked_session_id: input.linked_session_id,
        summary: input.summary,
        created_at: now.clone(),
        updated_at: now.clone(),
        last_modified_at: now,
    };
    state_doc.documents.push(document.clone());
    record_document_file_ref(&state, &user_id, &target, &document).await?;
    save_document_state(&state, &user_id, &state_doc).await?;
    Ok(Json(
        serde_json::to_value(document).unwrap_or_else(|_| json!({})),
    ))
}

pub async fn get_document(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(document_id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let Some(document) = load_document_state(&state, &user_id)
        .await?
        .documents
        .into_iter()
        .find(|doc| doc.document_id == document_id)
    else {
        return Err(ApiError::not_found("Document not found"));
    };
    Ok(Json(
        serde_json::to_value(document).unwrap_or_else(|_| json!({})),
    ))
}

pub async fn update_document(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(document_id): AxumPath<String>,
    Json(input): Json<DocumentUpdateInput>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let mut document_state = load_document_state(&state, &user_id).await?;
    let Some(document) = document_state
        .documents
        .iter_mut()
        .find(|doc| doc.document_id == document_id)
    else {
        return Err(ApiError::not_found("Document not found"));
    };
    if let Some(title) = input.title {
        let title = title.trim();
        if title.is_empty() {
            return Err(ApiError::bad_request("title is required"));
        }
        document.title = title.to_string();
    }
    if input.linked_session_id.is_some() {
        document.linked_session_id = input.linked_session_id;
    }
    if let Some(summary) = input.summary {
        document.summary = summary;
    }
    document.updated_at = now_iso();
    let out = document.clone();
    save_document_state(&state, &user_id, &document_state).await?;
    Ok(Json(
        serde_json::to_value(out).unwrap_or_else(|_| json!({})),
    ))
}

pub async fn delete_document(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(document_id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let mut document_state = load_document_state(&state, &user_id).await?;
    let before = document_state.documents.len();
    document_state
        .documents
        .retain(|doc| doc.document_id != document_id);
    if document_state.documents.len() == before {
        return Err(ApiError::not_found("Document not found"));
    }
    save_document_state(&state, &user_id, &document_state).await?;
    Ok(Json(json!({ "ok": true, "document_id": document_id })))
}

async fn load_document_state(state: &AppState, user_id: &str) -> Result<DocumentState, ApiError> {
    let documents = state
        .storage
        .list_documents(user_id)
        .await?
        .into_iter()
        .filter_map(|value| serde_json::from_value::<DocumentRecord>(value).ok())
        .collect::<Vec<_>>();
    Ok(DocumentState {
        version: 1,
        documents,
    })
}

async fn save_document_state(
    state: &AppState,
    user_id: &str,
    document_state: &DocumentState,
) -> Result<(), ApiError> {
    let records = document_state
        .documents
        .iter()
        .cloned()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(anyhow::Error::from)?;
    state.storage.replace_documents(user_id, &records).await?;
    Ok(())
}

fn infer_kind(path: &Path) -> String {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "md" | "markdown" => "markdown",
        "txt" => "text",
        "json" | "yaml" | "yml" => "data",
        _ => "file",
    }
    .to_string()
}

fn map_workspace_error(err: anyhow::Error) -> ApiError {
    let message = err.to_string();
    if message.contains("Access denied") {
        ApiError::new(axum::http::StatusCode::FORBIDDEN, "Access denied")
    } else {
        ApiError::bad_request(message)
    }
}

async fn record_document_file_ref(
    state: &AppState,
    user_id: &str,
    target: &Path,
    document: &DocumentRecord,
) -> Result<(), ApiError> {
    let bytes = tokio::fs::read(target).await?;
    let file_id = document.document_id.clone();
    state
        .storage
        .upsert_file_ref(&FileRefRecord {
            file_id,
            user_id: user_id.to_string(),
            storage_backend: "local".to_string(),
            storage_uri: document.path.clone(),
            workspace_path: Some(document.path.clone()),
            mime_type: Some(ws::mime_type_for_path(target)),
            size_bytes: Some(bytes.len() as u64),
            sha256: Some(sha256_hex(&bytes)),
            created_at: now_iso(),
            linked_session_id: document.linked_session_id.clone(),
        })
        .await?;
    Ok(())
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}
