use std::path::Path;

use axum::extract::{Path as AxumPath, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::api::{audit_event, require_confirm, ApiError};
use crate::state::AppState;
use crate::storage::ProjectRecord;
use crate::user::user_id_from_headers;
use crate::workspace as ws;

const MAX_PROJECT_NAME_CHARS: usize = 120;

#[derive(Debug, Deserialize)]
pub struct ProjectCreateInput {
    name: String,
    root_path: String,
}

#[derive(Debug, Deserialize, Default)]
pub struct ProjectUpdateInput {
    name: Option<String>,
    root_path: Option<String>,
}

pub async fn list_projects(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let workspace = state.sandboxes.ensure_sandbox(&user_id)?;
    let projects = state
        .storage
        .list_projects(&user_id)
        .await?
        .into_iter()
        .map(|record| public_project(&record, &workspace))
        .collect::<Vec<_>>();
    Ok(Json(json!({
        "projects": projects,
        "count": projects.len()
    })))
}

pub async fn create_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<ProjectCreateInput>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let workspace = state.sandboxes.ensure_sandbox(&user_id)?;
    let name = normalize_project_name(&input.name)?;
    let root_path = normalize_project_root(&workspace, &input.root_path)?;
    let now = now_iso();
    let record = ProjectRecord {
        project_id: format!("prj-{}", &Uuid::new_v4().simple().to_string()[..12]),
        user_id,
        name,
        root_path,
        created_at: now.clone(),
        updated_at: now.clone(),
        last_active_at: now,
    };
    state.storage.upsert_project(&record).await?;
    Ok(Json(public_project(&record, &workspace)))
}

pub async fn update_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(project_id): AxumPath<String>,
    Json(input): Json<ProjectUpdateInput>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let workspace = state.sandboxes.ensure_sandbox(&user_id)?;
    let Some(mut record) = state.storage.get_project(&user_id, &project_id).await? else {
        return Err(ApiError::not_found("Project not found"));
    };
    if let Some(name) = input.name {
        record.name = normalize_project_name(&name)?;
    }
    if let Some(root_path) = input.root_path {
        record.root_path = normalize_project_root(&workspace, &root_path)?;
    }
    let now = now_iso();
    record.updated_at = now.clone();
    record.last_active_at = now;
    state.storage.upsert_project(&record).await?;
    Ok(Json(public_project(&record, &workspace)))
}

pub async fn delete_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(project_id): AxumPath<String>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_confirm(Some(&input), "delete_project")?;
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let deleted = state.storage.delete_project(&user_id, &project_id).await?;
    if !deleted {
        return Err(ApiError::not_found("Project not found"));
    }
    audit_event(
        &state,
        &user_id,
        "delete_project",
        true,
        json!({ "project_id": project_id }),
    )
    .await?;
    Ok(Json(json!({ "ok": true, "project_id": project_id })))
}

fn normalize_project_name(raw: &str) -> Result<String, ApiError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("Project name cannot be empty"));
    }
    if name.chars().count() > MAX_PROJECT_NAME_CHARS {
        return Err(ApiError::bad_request("Project name is too long"));
    }
    Ok(name.to_string())
}

fn normalize_project_root(workspace: &Path, raw_path: &str) -> Result<String, ApiError> {
    let path = ws::validate_existing_path(raw_path, workspace)
        .map_err(|err| ApiError::bad_request(err.to_string()))?;
    if !path.is_dir() {
        return Err(ApiError::bad_request("Project root must be a directory"));
    }
    ws::workspace_path(workspace, &path).map_err(|err| ApiError::bad_request(err.to_string()))
}

fn public_project(record: &ProjectRecord, workspace: &Path) -> Value {
    json!({
        "project_id": record.project_id.clone(),
        "name": record.name.clone(),
        "root_path": record.root_path.clone(),
        "created_at": record.created_at.clone(),
        "updated_at": record.updated_at.clone(),
        "last_active_at": record.last_active_at.clone(),
        "exists": project_root_exists(workspace, &record.root_path)
    })
}

fn project_root_exists(workspace: &Path, root_path: &str) -> bool {
    ws::validate_existing_path(root_path, workspace)
        .ok()
        .is_some_and(|path| path.is_dir())
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}
