use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::api::ApiError;
use crate::state::AppState;
use crate::user::{user_id_from_headers, validate_user_id};

const STATUS_PENDING: &str = "pending";

#[derive(Debug, Deserialize)]
pub struct ContactRequestListQuery {
    role: Option<String>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct ContactRequestCreateInput {
    pub target_user_id: String,
    pub message: Option<String>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct ContactRequestDecisionInput {
    pub reason: Option<String>,
}

#[utoipa::path(
    get,
    path = "/contact-requests",
    tag = "contact-requests",
    responses((status = 200, description = "Current user's contact requests", body = serde_json::Value))
)]
pub async fn list_contact_requests(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ContactRequestListQuery>,
) -> Result<Json<Value>, ApiError> {
    let user_id = header_user_id(&headers)?;
    let role = query.role.as_deref().unwrap_or("received");
    let requests = if role == "sent" {
        state
            .storage
            .list_contact_requests_for_requester(&user_id)
            .await?
    } else {
        state
            .storage
            .list_contact_requests_for_target(&user_id)
            .await?
    };
    let mut enriched = Vec::with_capacity(requests.len());
    for request in requests {
        enriched.push(enrich_contact_request(&state, request).await?);
    }
    Ok(Json(json!({
        "requests": enriched,
        "count": enriched.len()
    })))
}

#[utoipa::path(
    post,
    path = "/contact-requests",
    tag = "contact-requests",
    request_body = ContactRequestCreateInput,
    responses((status = 200, description = "Created contact request", body = serde_json::Value))
)]
pub async fn create_contact_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<ContactRequestCreateInput>,
) -> Result<Json<Value>, ApiError> {
    let requester_user_id = header_user_id(&headers)?;
    let target_user_id = clean_user_id(&input.target_user_id, "target_user_id")?;
    if target_user_id == requester_user_id {
        return Err(ApiError::bad_request("target_user_id must be another user"));
    }
    if state
        .storage
        .get_contact(&requester_user_id, &target_user_id)
        .await?
        .is_some()
    {
        return Err(ApiError::bad_request("target_user_id is already a contact"));
    }

    let message = input
        .message
        .as_deref()
        .map(clean_optional_text)
        .transpose()?;
    let now = now_iso();
    let record = json!({
        "request_id": format!("creq-{}", &Uuid::new_v4().simple().to_string()[..10]),
        "requester_user_id": requester_user_id,
        "target_user_id": target_user_id,
        "status": STATUS_PENDING,
        "message": message,
        "created_at": now,
        "updated_at": now
    });
    state.storage.upsert_contact_request(&record).await?;
    Ok(Json(enrich_contact_request(&state, record).await?))
}

#[utoipa::path(
    post,
    path = "/contact-requests/{request_id}/accept",
    tag = "contact-requests",
    request_body = ContactRequestDecisionInput,
    responses((status = 200, description = "Accepted contact request", body = serde_json::Value))
)]
pub async fn accept_contact_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(request_id): Path<String>,
    Json(_input): Json<ContactRequestDecisionInput>,
) -> Result<Json<Value>, ApiError> {
    let target_user_id = header_user_id(&headers)?;
    let record = state
        .storage
        .accept_contact_request_bidirectional(&request_id, &target_user_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Contact request not found"))?;
    Ok(Json(enrich_contact_request(&state, record).await?))
}

#[utoipa::path(
    post,
    path = "/contact-requests/{request_id}/reject",
    tag = "contact-requests",
    request_body = ContactRequestDecisionInput,
    responses((status = 200, description = "Rejected contact request", body = serde_json::Value))
)]
pub async fn reject_contact_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(request_id): Path<String>,
    Json(input): Json<ContactRequestDecisionInput>,
) -> Result<Json<Value>, ApiError> {
    let target_user_id = header_user_id(&headers)?;
    let reason = input
        .reason
        .as_deref()
        .map(clean_optional_text)
        .transpose()?;
    let record = state
        .storage
        .reject_contact_request(&request_id, &target_user_id, reason.as_deref())
        .await?
        .ok_or_else(|| ApiError::not_found("Contact request not found"))?;
    Ok(Json(enrich_contact_request(&state, record).await?))
}

async fn enrich_contact_request(state: &AppState, mut request: Value) -> Result<Value, ApiError> {
    let requester_user_id = request
        .get("requester_user_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("Contact request missing requester_user_id"))?
        .to_string();
    let target_user_id = request
        .get("target_user_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("Contact request missing target_user_id"))?
        .to_string();
    let requester_profile = user_profile_json(state, &requester_user_id).await?;
    let target_profile = user_profile_json(state, &target_user_id).await?;
    if let Some(object) = request.as_object_mut() {
        object.insert("requester_profile".to_string(), requester_profile);
        object.insert("target_profile".to_string(), target_profile);
    }
    Ok(request)
}

async fn user_profile_json(state: &AppState, user_id: &str) -> Result<Value, ApiError> {
    let stored_profile = state.storage.user_profile(user_id).await?;
    let auth_user = state.storage.auth_user_by_id(user_id).await?;
    let login = auth_user.as_ref().map(|user| user.login.clone());
    let display_name = auth_user
        .as_ref()
        .and_then(|user| user.display_name.clone());
    let user_name = display_name
        .clone()
        .or_else(|| login.clone())
        .unwrap_or_else(|| user_id.to_string());
    let avatar_uri = stored_profile.and_then(|profile| profile.avatar_uri);

    Ok(json!({
        "user_id": user_id,
        "user_name": user_name,
        "display_name": display_name,
        "login": login,
        "avatar_uri": avatar_uri
    }))
}

fn header_user_id(headers: &HeaderMap) -> Result<String, ApiError> {
    user_id_from_headers(headers).map_err(ApiError::bad_request)
}

fn clean_user_id(value: &str, field: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(ApiError::bad_request(format!("{field} cannot be empty")));
    }
    validate_user_id(value).map_err(ApiError::bad_request)?;
    Ok(value.to_string())
}

fn clean_optional_text(value: &str) -> Result<String, ApiError> {
    let text = value.trim();
    if text.chars().count() > 500 {
        return Err(ApiError::bad_request(
            "message must be 500 characters or fewer",
        ));
    }
    Ok(text.to_string())
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}
