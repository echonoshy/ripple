use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::ApiError;
use crate::state::AppState;
use crate::user::{user_id_from_headers, validate_user_id};

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct ContactCreateInput {
    pub contact_user_id: String,
    pub remark: Option<String>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct ContactUpdateInput {
    pub remark: String,
}

#[utoipa::path(
    get,
    path = "/contacts",
    tag = "contacts",
    responses((status = 200, description = "Current user's contacts", body = serde_json::Value))
)]
pub async fn list_contacts(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let owner_user_id = header_user_id(&headers)?;
    let contacts = state.storage.list_contacts(&owner_user_id).await?;
    let mut enriched = Vec::with_capacity(contacts.len());
    for contact in contacts {
        enriched.push(enrich_contact(&state, contact).await?);
    }
    Ok(Json(json!({
        "contacts": enriched,
        "count": enriched.len()
    })))
}

#[utoipa::path(
    post,
    path = "/contacts",
    tag = "contacts",
    request_body = ContactCreateInput,
    responses((status = 200, description = "Added contact", body = serde_json::Value))
)]
pub async fn add_contact(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<ContactCreateInput>,
) -> Result<Json<Value>, ApiError> {
    let owner_user_id = header_user_id(&headers)?;
    let contact_user_id = clean_user_id(&input.contact_user_id, "contact_user_id")?;
    if contact_user_id == owner_user_id {
        return Err(ApiError::bad_request(
            "contact_user_id must be another user",
        ));
    }
    let remark = input.remark.as_deref().map(clean_remark).transpose()?;
    let contact = state
        .storage
        .upsert_contact(&owner_user_id, &contact_user_id, remark.as_deref())
        .await?;
    Ok(Json(enrich_contact(&state, contact).await?))
}

#[utoipa::path(
    patch,
    path = "/contacts/{contact_user_id}",
    tag = "contacts",
    params(("contact_user_id" = String, Path, description = "Contact user id")),
    request_body = ContactUpdateInput,
    responses((status = 200, description = "Updated contact", body = serde_json::Value))
)]
pub async fn update_contact(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(contact_user_id): Path<String>,
    Json(input): Json<ContactUpdateInput>,
) -> Result<Json<Value>, ApiError> {
    let owner_user_id = header_user_id(&headers)?;
    let contact_user_id = clean_user_id(&contact_user_id, "contact_user_id")?;
    let remark = clean_remark(&input.remark)?;
    let contact = state
        .storage
        .update_contact_remark(&owner_user_id, &contact_user_id, &remark)
        .await?
        .ok_or_else(|| ApiError::not_found("Contact not found"))?;
    Ok(Json(enrich_contact(&state, contact).await?))
}

#[utoipa::path(
    delete,
    path = "/contacts/{contact_user_id}",
    tag = "contacts",
    params(("contact_user_id" = String, Path, description = "Contact user id")),
    responses((status = 200, description = "Removed contact", body = serde_json::Value))
)]
pub async fn delete_contact(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(contact_user_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let owner_user_id = header_user_id(&headers)?;
    let contact_user_id = clean_user_id(&contact_user_id, "contact_user_id")?;
    let deleted = state
        .storage
        .delete_contact(&owner_user_id, &contact_user_id)
        .await?;
    Ok(Json(json!({
        "deleted": deleted,
        "contact_user_id": contact_user_id
    })))
}

async fn enrich_contact(state: &AppState, mut contact: Value) -> Result<Value, ApiError> {
    let contact_user_id = contact
        .get("contact_user_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("Contact record missing contact_user_id"))?
        .to_string();
    let profile = contact_profile_json(state, &contact_user_id).await?;
    if let Some(object) = contact.as_object_mut() {
        object.insert("profile".to_string(), profile);
    }
    Ok(contact)
}

async fn contact_profile_json(state: &AppState, user_id: &str) -> Result<Value, ApiError> {
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

fn clean_remark(value: &str) -> Result<String, ApiError> {
    let remark = value.trim();
    if remark.chars().count() > 200 {
        return Err(ApiError::bad_request(
            "remark must be 200 characters or fewer",
        ));
    }
    Ok(remark.to_string())
}
