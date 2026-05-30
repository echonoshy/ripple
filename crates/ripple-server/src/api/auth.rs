use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::api::ApiError;
use crate::auth;
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AuthClaimRequest {
    pub invite_code: String,
    pub login: String,
    pub password: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AuthLoginRequest {
    pub login: String,
    pub password: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AuthPasswordChangeRequest {
    pub current_password: String,
    pub new_password: String,
}

pub async fn auth_config(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "user_auth": {
            "enabled": state.config.user_auth.enabled,
            "session_ttl_seconds": state.config.user_auth.session_ttl_seconds,
            "service_login_allowed": !state.config.api_keys.is_empty()
        }
    }))
}

pub async fn claim_invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<AuthClaimRequest>,
) -> Result<Json<Value>, ApiError> {
    ensure_user_auth_enabled(&state)?;
    let token = auth::claim_invite(
        &state.storage,
        &payload.invite_code,
        &payload.login,
        &payload.password,
        payload.display_name,
        state.config.user_auth.session_ttl_seconds,
        user_agent(&headers),
    )
    .await
    .map_err(auth_bad_request)?;
    state.sandboxes.ensure_sandbox(&token.user_id)?;
    Ok(Json(auth_token_json(token)))
}

pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<AuthLoginRequest>,
) -> Result<Json<Value>, ApiError> {
    ensure_user_auth_enabled(&state)?;
    let Some(token) = auth::login(
        &state.storage,
        &payload.login,
        &payload.password,
        state.config.user_auth.session_ttl_seconds,
        user_agent(&headers),
    )
    .await
    .map_err(auth_bad_request)?
    else {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            json!({
                "code": "invalid_login",
                "message": "Invalid login or password."
            }),
        ));
    };
    state.sandboxes.ensure_sandbox(&token.user_id)?;
    Ok(Json(auth_token_json(token)))
}

pub async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    ensure_user_auth_enabled(&state)?;
    let Some(token) = bearer_token(&headers) else {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            json!({
                "code": "unauthorized",
                "message": "Missing user session token."
            }),
        ));
    };
    let revoked = state
        .storage
        .revoke_auth_session(&auth::hash_secret(token))
        .await?;
    Ok(Json(json!({"ok": true, "revoked": revoked})))
}

pub async fn change_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<AuthPasswordChangeRequest>,
) -> Result<Json<Value>, ApiError> {
    ensure_user_auth_enabled(&state)?;
    let Some(token) = bearer_token(&headers) else {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            json!({
                "code": "unauthorized",
                "message": "Missing user session token."
            }),
        ));
    };
    let Some(session) = auth::authenticate_session_token(&state.storage, token)
        .await
        .map_err(auth_bad_request)?
    else {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            json!({
                "code": "unauthorized",
                "message": "Invalid or expired session."
            }),
        ));
    };
    auth::change_password(
        &state.storage,
        &session.user_id,
        &payload.current_password,
        &payload.new_password,
    )
    .await
    .map_err(auth_bad_request)?;
    Ok(Json(json!({"ok": true})))
}

fn ensure_user_auth_enabled(state: &AppState) -> Result<(), ApiError> {
    if state.config.user_auth.enabled {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::NOT_FOUND,
            json!({
                "code": "user_auth_disabled",
                "message": "User authentication is not enabled for this server."
            }),
        ))
    }
}

fn auth_bad_request(err: anyhow::Error) -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        json!({
            "code": "auth_request_invalid",
            "message": err.to_string()
        }),
    )
}

fn auth_token_json(token: auth::AuthToken) -> Value {
    let user_id = token.user_id;
    json!({
        "token": token.token,
        "token_type": token.token_type,
        "user_id": user_id.clone(),
        "login": token.login,
        "display_name": token.display_name,
        "expires_at": token.expires_at,
        "auth": {
            "kind": "user",
            "effective_user_id": user_id
        }
    })
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn user_agent(headers: &HeaderMap) -> Option<String> {
    headers
        .get("user-agent")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}
