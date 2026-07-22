use std::collections::HashMap;
use std::path::Path as FsPath;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use url::{form_urlencoded, Url};

use crate::api::{audit_event, ApiError};
use crate::capabilities::{connector_definition, connector_info, enabled_connector_definitions};
use crate::connector_runtime::PendingBilibiliQr;
use crate::redaction::{redact_text, redact_value};
use crate::state::AppState;
use crate::user::user_id_from_headers;

mod bilibili;
mod feishu;
pub(crate) mod google_workspace;

#[cfg(test)]
use bilibili::parse_bilibili_cookie_fields_from_crossdomain_url;
pub(crate) use bilibili::read_valid_bilibili_credential_file;
use bilibili::{
    bilibili_app_url, bilibili_qrcode_generate, bilibili_qrcode_poll,
    bilibili_verify_credential_live,
};
pub(crate) use feishu::{
    cancel_setup as cancel_feishu_setup, invoke_for_agent as invoke_feishu_for_agent,
};

const BILIBILI_QRCODE_TTL_SECONDS: u64 = 180;
const BILIBILI_PENDING_TTL_SECONDS: u64 = 600;

#[utoipa::path(
    get,
    path = "/connectors",
    tag = "connectors",
    responses(
        (status = 200, description = "Available connector definitions", body = serde_json::Value),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn list_connectors(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "connectors": enabled_connector_definitions(&state.config).into_iter().map(connector_info).collect::<Vec<_>>()
    }))
}

#[utoipa::path(
    get,
    path = "/connectors/{connector_name}/status",
    tag = "connectors",
    params(("connector_name" = String, Path, description = "Connector name")),
    responses(
        (status = 200, description = "Connector status", body = serde_json::Value),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Connector not found", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn connector_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(connector_name): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    ensure_sandbox_exists(&state, &user_id)?;
    let status = connector_status_value(&state, &user_id, &connector_name).await?;
    clear_pending_auth_if_status_connected(&state, &user_id, &connector_name, &status).await;
    Ok(Json(status))
}

pub(crate) async fn connector_status_value(
    state: &AppState,
    user_id: &str,
    connector_name: &str,
) -> Result<Value, ApiError> {
    ensure_connector_enabled(state, connector_name)?;
    let workspace = state.sandboxes.workspace_dir(user_id)?;
    let credentials = state.sandboxes.credentials_dir(user_id)?;
    let mut status = match connector_name {
        "notion" => {
            let connected =
                read_json_string_field(&credentials.join("notion.json"), "api_token").is_some();
            json!({"name": connector_name, "connected": connected, "required": !connected, "detail": if connected {"Notion token is stored for this user."} else {"Notion token is missing for this user."}, "metadata": {}})
        }
        "google_workspace" => {
            let has_keyring = workspace.join(".config/gogcli/keyring").exists();
            let accounts = if has_keyring {
                if let Some(gog) = google_workspace::gog_binary(state) {
                    google_workspace::list_accounts(state, user_id, &gog, true, 30)
                        .await
                        .unwrap_or_default()
                } else {
                    Vec::new()
                }
            } else {
                Vec::new()
            };
            let connected = !accounts.is_empty();
            json!({"name": connector_name, "connected": connected, "required": !connected, "detail": if connected {"Google Workspace account is connected for this user."} else {"Google Workspace is not connected for this user."}, "metadata": {"has_client_config": credentials.join("gogcli-client.json").is_file(), "has_keyring": has_keyring, "account_count": accounts.len()}})
        }
        "feishu" => feishu::status(state, user_id).await,
        "bilibili" => {
            let credential =
                read_valid_bilibili_credential_file(&credentials.join("bilibili.json"));
            let connected = credential.is_some();
            let metadata = credential
                .as_ref()
                .map(|credential| {
                    json!({
                        "uname": credential.get("uname").and_then(Value::as_str).unwrap_or(""),
                        "mid": value_as_u64(credential.get("mid")).unwrap_or(0),
                        "expires_at": value_as_u64(credential.get("expires_at")).unwrap_or(0)
                    })
                })
                .unwrap_or_else(|| json!({}));
            json!({"name": connector_name, "connected": connected, "required": !connected, "detail": if connected {"Bilibili credentials are stored for this user."} else {"Bilibili credentials are missing for this user."}, "metadata": metadata})
        }
        "openai_codex" => codex_status(state).await,
        "codex_image_generation" | "codex_image_input" | "codex_web_search" => {
            json!({"name": connector_name, "connected": true, "required": false, "detail": "Provided by the server-side Codex runtime.", "metadata": {"auth_source": "codex_runtime"}})
        }
        _ => {
            return Err(ApiError::not_found(format!(
                "Connector {connector_name:?} not found"
            )))
        }
    };
    if let Some(object) = status.as_object_mut() {
        let pending_count = state
            .sessions
            .pending_connector_auth_count(user_id, connector_name)
            .await
            .unwrap_or(0);
        if pending_count > 0 {
            object.insert(
                "pending_auth".to_string(),
                json!({"count": pending_count, "cancel_path": format!("/v1/connectors/{connector_name}/auth/cancel")}),
            );
        }
    }
    Ok(status)
}

async fn clear_pending_auth_if_status_connected(
    state: &AppState,
    user_id: &str,
    connector_name: &str,
    status: &Value,
) {
    if status.get("connected").and_then(Value::as_bool) == Some(true) {
        let _ = state
            .sessions
            .clear_pending_connector_auth(user_id, connector_name)
            .await;
    }
}

async fn clear_pending_auth_if_action_authorized(
    state: &AppState,
    user_id: &str,
    connector_name: &str,
    result: &Value,
) {
    if result.get("ok").and_then(Value::as_bool) == Some(true)
        && result.get("stage").and_then(Value::as_str) == Some("authorized")
    {
        let _ = state
            .sessions
            .clear_pending_connector_auth(user_id, connector_name)
            .await;
    }
}

#[utoipa::path(
    post,
    path = "/connectors/{connector_name}/auth/start",
    tag = "connectors",
    params(("connector_name" = String, Path, description = "Connector name")),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Connector auth start result", body = serde_json::Value),
        (status = 400, description = "Invalid auth request", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Connector not found", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn connector_auth_start(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(connector_name): Path<String>,
    body: Option<Json<Value>>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    let payload = body.map(|Json(value)| value).unwrap_or_else(|| json!({}));
    let result = connector_auth_start_action(
        &state,
        &user_id,
        &connector_name,
        &payload,
        request_base_url_from_headers(&headers).as_deref(),
    )
    .await?;
    clear_pending_auth_if_action_authorized(&state, &user_id, &connector_name, &result.0).await;
    Ok(result)
}

pub(crate) async fn connector_auth_start_action(
    state: &AppState,
    user_id: &str,
    connector_name: &str,
    payload: &Value,
    request_base_url: Option<&str>,
) -> Result<Json<Value>, ApiError> {
    ensure_connector_enabled(state, connector_name)?;
    state.sandboxes.ensure_sandbox(user_id)?;
    match connector_name {
        "notion" => notion_auth_start(state, user_id, payload).await,
        "google_workspace" => google_workspace::auth_start(state, user_id, request_base_url).await,
        "bilibili" => bilibili_auth_start(state, user_id).await,
        "feishu" => feishu::auth_start(state, user_id, payload).await,
        _ => Err(ApiError::not_found(format!(
            "Connector {connector_name:?} not found"
        ))),
    }
}

#[utoipa::path(
    post,
    path = "/connectors/{connector_name}/auth/complete",
    tag = "connectors",
    params(("connector_name" = String, Path, description = "Connector name")),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Connector auth completion result", body = serde_json::Value),
        (status = 400, description = "Invalid auth completion request", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Connector not found", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 405, description = "Connector does not support completion", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn connector_auth_complete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(connector_name): Path<String>,
    body: Option<Json<Value>>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    let payload = body.map(|Json(value)| value).unwrap_or_else(|| json!({}));
    let result =
        connector_auth_complete_action(&state, &user_id, &connector_name, &payload).await?;
    clear_pending_auth_if_action_authorized(&state, &user_id, &connector_name, &result.0).await;
    Ok(result)
}

pub(crate) async fn connector_auth_complete_action(
    state: &AppState,
    user_id: &str,
    connector_name: &str,
    payload: &Value,
) -> Result<Json<Value>, ApiError> {
    ensure_connector_enabled(state, connector_name)?;
    state.sandboxes.ensure_sandbox(user_id)?;
    match connector_name {
        "google_workspace" => google_workspace::auth_complete(state, user_id, payload).await,
        "bilibili" => bilibili_auth_complete(state, user_id, payload).await,
        "feishu" => feishu::auth_complete(state, user_id, payload).await,
        "notion" => Err(ApiError::new(
            StatusCode::METHOD_NOT_ALLOWED,
            "Notion uses auth_start with an api_token payload",
        )),
        _ => Err(ApiError::not_found(format!(
            "Connector {connector_name:?} not found"
        ))),
    }
}

#[utoipa::path(
    post,
    path = "/connectors/{connector_name}/auth/cancel",
    tag = "connectors",
    params(("connector_name" = String, Path, description = "Connector name")),
    responses(
        (status = 200, description = "Connector auth cancellation result", body = serde_json::Value),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Connector not found", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 405, description = "Connector does not support cancellation", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn connector_auth_cancel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(connector_name): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    ensure_connector_enabled(&state, &connector_name)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    let Some(definition) = connector_definition(&connector_name) else {
        return Err(ApiError::not_found(format!(
            "Connector {connector_name:?} not found"
        )));
    };
    if !definition.auth_cancel {
        return Err(ApiError::new(
            StatusCode::METHOD_NOT_ALLOWED,
            format!("Connector {connector_name:?} does not support auth cancellation"),
        ));
    }
    let cancelled = cancel_connector_auth_state(&state, &user_id, &connector_name).await?;
    Ok(Json(json!({
        "ok": true,
        "connector": connector_name,
        "cancelled": cancelled
    })))
}

#[utoipa::path(
    post,
    path = "/connectors/{connector_name}/disconnect",
    tag = "connectors",
    params(("connector_name" = String, Path, description = "Connector name")),
    request_body = Option<crate::api::openapi::ConnectorDisconnectRequest>,
    responses(
        (status = 200, description = "Connector disconnect result", body = serde_json::Value),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Connector not found", body = crate::api::openapi::ApiErrorEnvelope),
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn connector_disconnect(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(connector_name): Path<String>,
    body: Option<Json<Value>>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    ensure_connector_enabled(&state, &connector_name)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    let payload = body.map(|Json(value)| value).unwrap_or_else(|| json!({}));
    audit_event(
        &state,
        &user_id,
        "connector.disconnect",
        true,
        json!({"connector": connector_name}),
    )
    .await?;
    match connector_name.as_str() {
        "notion" => notion_disconnect(&state, &user_id).await,
        "google_workspace" => google_workspace::disconnect(&state, &user_id, &payload).await,
        "feishu" => feishu::disconnect(&state, &user_id).await,
        "bilibili" => bilibili_disconnect(&state, &user_id).await,
        _ => Err(ApiError::not_found(format!(
            "Connector {connector_name:?} not found"
        ))),
    }
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct AccountsQuery {
    check: Option<bool>,
}

#[utoipa::path(
    get,
    path = "/connectors/{connector_name}/accounts",
    tag = "connectors",
    params(
        ("connector_name" = String, Path, description = "Connector name"),
        AccountsQuery
    ),
    responses(
        (status = 200, description = "Connector account list", body = serde_json::Value),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Connector not found", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 405, description = "Connector does not support accounts", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn connector_accounts(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(connector_name): Path<String>,
    Query(query): Query<AccountsQuery>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    ensure_connector_enabled(&state, &connector_name)?;
    ensure_sandbox_exists(&state, &user_id)?;
    if connector_name != "google_workspace" {
        return Err(ApiError::new(
            StatusCode::METHOD_NOT_ALLOWED,
            format!("Connector {connector_name:?} does not support accounts"),
        ));
    }
    google_workspace::accounts(&state, &user_id, query.check.unwrap_or(false)).await
}

fn ensure_sandbox_exists(state: &AppState, user_id: &str) -> Result<(), ApiError> {
    if state.sandboxes.sandbox_dir(user_id)?.exists() {
        Ok(())
    } else {
        Err(ApiError::not_found(format!(
            "Sandbox for user {user_id:?} not found"
        )))
    }
}

pub(crate) fn ensure_connector_enabled(
    state: &AppState,
    connector_name: &str,
) -> Result<(), ApiError> {
    let Some(definition) = connector_definition(connector_name) else {
        return Err(ApiError::not_found(format!(
            "Connector {connector_name:?} not found"
        )));
    };
    if definition.kind == "user_connector" && !state.config.connector_enabled(connector_name) {
        return Err(ApiError::not_found(format!(
            "Connector {connector_name:?} not found"
        )));
    }
    Ok(())
}

async fn restart_codex_runtime_for_credential_change(
    state: &AppState,
    user_id: &str,
) -> Result<(), ApiError> {
    let _ = state.jobs.stop_user(user_id).await?;
    Ok(())
}

async fn cancel_connector_auth_state(
    state: &AppState,
    user_id: &str,
    connector_name: &str,
) -> Result<bool, ApiError> {
    ensure_connector_enabled(state, connector_name)?;
    let sessions = state
        .sessions
        .cancel_pending_connector_auth(user_id, connector_name)
        .await?;
    let runtime_cancelled = match connector_name {
        "google_workspace" => google_workspace::clear_pending_oauth_for_user(state, user_id) > 0,
        "feishu" => cancel_feishu_setup(state, user_id).await,
        "bilibili" => release_pending_bilibili_qr(state, user_id).is_some(),
        "notion" => false,
        _ => false,
    };
    Ok(sessions > 0 || runtime_cancelled)
}

async fn notion_auth_start(
    state: &AppState,
    user_id: &str,
    payload: &Value,
) -> Result<Json<Value>, ApiError> {
    let token = payload
        .get("api_token")
        .or_else(|| payload.get("token"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if token.is_empty() {
        return Ok(Json(action_response(
            "notion",
            false,
            "missing_token",
            "api_token is required.",
            json!({}),
        )));
    }
    if !(token.starts_with("ntn_") || token.starts_with("secret_")) {
        return Ok(Json(action_response(
            "notion",
            false,
            "invalid_token",
            "Notion token must start with `ntn_` or `secret_`.",
            json!({}),
        )));
    }
    if token.len() < 20 || token.len() > 200 {
        return Ok(Json(action_response(
            "notion",
            false,
            "invalid_token",
            &format!("Notion token length is unexpected: {}.", token.len()),
            json!({}),
        )));
    }
    let path = state.sandboxes.notion_config_file(user_id)?;
    write_secret_json(&path, &json!({"api_token": token})).await?;
    state.sandboxes.write_nsjail_config(user_id)?;
    restart_codex_runtime_for_credential_change(state, user_id).await?;
    Ok(Json(action_response(
        "notion",
        true,
        "authorized",
        "Notion token has been stored for this user.",
        json!({"token_preview": mask_secret(token)}),
    )))
}

async fn notion_disconnect(state: &AppState, user_id: &str) -> Result<Json<Value>, ApiError> {
    let path = state.sandboxes.notion_config_file(user_id)?;
    let removed = remove_file_if_exists(&path).await?;
    state.sandboxes.write_nsjail_config(user_id)?;
    if removed {
        restart_codex_runtime_for_credential_change(state, user_id).await?;
    }
    Ok(Json(action_response(
        "notion",
        true,
        "disconnected",
        if removed {
            "Notion token removed for this user."
        } else {
            "No Notion token was stored."
        },
        json!({"credential_removed": removed}),
    )))
}

async fn bilibili_disconnect(state: &AppState, user_id: &str) -> Result<Json<Value>, ApiError> {
    let pending_scan_cancelled = release_pending_bilibili_qr(state, user_id).is_some();
    let path = state.sandboxes.bilibili_config_file(user_id)?;
    let removed = remove_file_if_exists(&path).await?;
    state.sandboxes.write_nsjail_config(user_id)?;
    if removed {
        restart_codex_runtime_for_credential_change(state, user_id).await?;
    }
    Ok(Json(action_response(
        "bilibili",
        true,
        "disconnected",
        if removed {
            "Bilibili credentials removed for this user."
        } else {
            "No Bilibili credentials were stored."
        },
        json!({"credential_removed": removed, "pending_scan_cancelled": pending_scan_cancelled}),
    )))
}

async fn bilibili_auth_start(state: &AppState, user_id: &str) -> Result<Json<Value>, ApiError> {
    if let Some(credential) = read_bilibili_credential(state, user_id)? {
        return Ok(Json(action_response(
            "bilibili",
            true,
            "authorized",
            "Bilibili account is already connected for this user.",
            json!({
                "bound": true,
                "uname": credential.get("uname").and_then(Value::as_str).unwrap_or(""),
                "mid": value_as_u64(credential.get("mid")).unwrap_or(0),
                "expires_at": value_as_u64(credential.get("expires_at")).unwrap_or(0)
            }),
        )));
    }

    let client = reqwest::Client::new();
    let generated = match bilibili_qrcode_generate(&client).await {
        Ok(generated) => generated,
        Err(err) => {
            return Ok(Json(action_response(
                "bilibili",
                false,
                "auth_failed",
                &err.to_string(),
                json!({}),
            )))
        }
    };
    register_pending_bilibili_qr(state, user_id);
    let encoded_content =
        form_urlencoded::byte_serialize(generated.qrcode_content.as_bytes()).collect::<String>();
    let app_url = bilibili_app_url(&generated.qrcode_content);
    Ok(Json(action_response(
        "bilibili",
        true,
        "awaiting_user",
        "Scan the QR code with the Bilibili app, then complete the auth flow.",
        json!({
            "bound": false,
            "qrcode_key": generated.qrcode_key,
            "qrcode_image_url": format!("/v1/bilibili/qrcode.png?content={encoded_content}"),
            "qrcode_content": generated.qrcode_content,
            "app_url": app_url,
            "expires_in_seconds": BILIBILI_QRCODE_TTL_SECONDS
        }),
    )))
}

async fn bilibili_auth_complete(
    state: &AppState,
    user_id: &str,
    payload: &Value,
) -> Result<Json<Value>, ApiError> {
    let qrcode_key = payload
        .get("qrcode_key")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if qrcode_key.is_empty() {
        return Ok(Json(action_response(
            "bilibili",
            false,
            "invalid_request",
            "qrcode_key is required.",
            json!({}),
        )));
    }
    let max_wait = value_as_u64(payload.get("max_wait_seconds"))
        .unwrap_or(30)
        .clamp(5, 300);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(max_wait);
    let mut last_state = "waiting_scan".to_string();
    let mut last_raw_message = String::new();
    let client = reqwest::Client::new();

    while tokio::time::Instant::now() < deadline {
        match bilibili_qrcode_poll(&client, qrcode_key).await {
            Ok(result) => {
                last_state = result.state.to_string();
                last_raw_message = result.raw_message.clone();
                match result.state {
                    "expired" => {
                        release_pending_bilibili_qr(state, user_id);
                        return Ok(Json(action_response(
                            "bilibili",
                            true,
                            "expired",
                            "Bilibili QR code expired.",
                            json!({"raw_code": result.raw_code, "raw_message": result.raw_message}),
                        )));
                    }
                    "ok" => {
                        let fields = result.credential_fields.unwrap_or_else(|| json!({}));
                        let sessdata = fields
                            .get("sessdata")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .trim();
                        if sessdata.is_empty() {
                            release_pending_bilibili_qr(state, user_id);
                            return Ok(Json(action_response(
                                "bilibili",
                                false,
                                "auth_failed",
                                "Bilibili returned success without SESSDATA.",
                                json!({}),
                            )));
                        }
                        let live = bilibili_verify_credential_live(&client, sessdata).await;
                        let mut credential = fields.as_object().cloned().unwrap_or_default();
                        credential.insert("bound_at".to_string(), json!(now_epoch_seconds()));
                        credential.insert("uname".to_string(), json!(live.uname));
                        credential.insert("mid".to_string(), json!(live.mid));
                        if let Some(raw_log) = live.raw_log {
                            credential.insert("verify_log".to_string(), json!(raw_log));
                        }
                        credential.insert("is_login".to_string(), json!(live.is_login));
                        let credential = Value::Object(credential);
                        write_bilibili_credential(state, user_id, &credential).await?;
                        state.sandboxes.write_nsjail_config(user_id)?;
                        release_pending_bilibili_qr(state, user_id);
                        restart_codex_runtime_for_credential_change(state, user_id).await?;
                        return Ok(Json(action_response(
                            "bilibili",
                            true,
                            "authorized",
                            "Bilibili credentials stored for this user.",
                            json!({
                                "uname": credential.get("uname").and_then(Value::as_str).unwrap_or(""),
                                "mid": value_as_u64(credential.get("mid")).unwrap_or(0),
                                "expires_at": value_as_u64(credential.get("expires_at")).unwrap_or(0)
                            }),
                        )));
                    }
                    _ => {}
                }
            }
            Err(err) => {
                tracing::warn!(
                    user_id = user_id,
                    error = %err,
                    "Bilibili QR poll failed"
                );
            }
        }

        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        tokio::time::sleep(remaining.min(Duration::from_secs(2))).await;
    }

    let stage = if max_wait >= 90 { "timeout" } else { "pending" };
    if stage == "timeout" {
        release_pending_bilibili_qr(state, user_id);
    }
    Ok(Json(action_response(
        "bilibili",
        true,
        stage,
        if stage == "pending" {
            "Bilibili QR scan is still pending."
        } else {
            "Bilibili QR poll timed out."
        },
        json!({"last_state": last_state, "last_raw_message": last_raw_message, "waited_seconds": max_wait}),
    )))
}

fn action_response(name: &str, ok: bool, stage: &str, detail: &str, data: Value) -> Value {
    json!({
        "name": name,
        "ok": ok,
        "stage": stage,
        "detail": redact_text(detail),
        "data": redact_value(&data)
    })
}

fn filter_nsjail_stderr(mut output: std::process::Output) -> std::process::Output {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let filtered = stderr
        .lines()
        .filter(|line| {
            !["[I]", "[D]", "[W]", "[E]", "[F]"]
                .iter()
                .any(|prefix| line.starts_with(prefix))
        })
        .collect::<Vec<_>>()
        .join("\n");
    output.stderr = filtered.into_bytes();
    output
}

async fn write_secret_json(path: &FsPath, value: &Value) -> Result<(), ApiError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(
        path,
        serde_json::to_vec_pretty(value).map_err(anyhow::Error::from)?,
    )
    .await?;
    set_mode_0600(path).await?;
    Ok(())
}

async fn set_mode_0600(path: &FsPath) -> Result<(), ApiError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = std::fs::Permissions::from_mode(0o600);
        tokio::fs::set_permissions(path, permissions).await?;
    }
    Ok(())
}

async fn remove_file_if_exists(path: &FsPath) -> Result<bool, ApiError> {
    if path.exists() {
        tokio::fs::remove_file(path).await?;
        Ok(true)
    } else {
        Ok(false)
    }
}

fn read_json_string_field(path: &FsPath, field: &str) -> Option<String> {
    let value = serde_json::from_slice::<Value>(&std::fs::read(path).ok()?).ok()?;
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn mask_secret(value: &str) -> String {
    if value.is_empty() {
        String::new()
    } else {
        format!("{}...({} chars)", &value[..value.len().min(6)], value.len())
    }
}

fn looks_like_email(value: &str) -> bool {
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    !local.trim().is_empty() && domain.contains('.') && !domain.contains(char::is_whitespace)
}

fn looks_like_url(value: &str) -> bool {
    value.starts_with("http://") || value.starts_with("https://")
}

fn tail(value: &str, max_chars: usize) -> String {
    if value.len() <= max_chars {
        value.to_string()
    } else {
        value[value.len() - max_chars..].to_string()
    }
}

fn command_tail(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    tail(
        if stderr.trim().is_empty() {
            &stdout
        } else {
            &stderr
        },
        500,
    )
}

fn read_bilibili_credential(state: &AppState, user_id: &str) -> Result<Option<Value>, ApiError> {
    Ok(read_valid_bilibili_credential_file(
        &state.sandboxes.bilibili_config_file(user_id)?,
    ))
}

async fn write_bilibili_credential(
    state: &AppState,
    user_id: &str,
    credential: &Value,
) -> Result<(), ApiError> {
    let path = state.sandboxes.bilibili_config_file(user_id)?;
    write_secret_json(&path, credential).await
}

fn register_pending_bilibili_qr(state: &AppState, user_id: &str) {
    let now = now_epoch_seconds();
    let pending = PendingBilibiliQr {
        expires_at: now + BILIBILI_PENDING_TTL_SECONDS,
    };
    let mut values = state
        .connector_runtime
        .bilibili_qr
        .lock()
        .expect("pending Bilibili QR lock poisoned");
    cleanup_expired_bilibili_qr_locked(&mut values, now);
    values.insert(user_id.to_string(), pending);
}

fn release_pending_bilibili_qr(state: &AppState, user_id: &str) -> Option<PendingBilibiliQr> {
    let now = now_epoch_seconds();
    let mut values = state
        .connector_runtime
        .bilibili_qr
        .lock()
        .expect("pending Bilibili QR lock poisoned");
    cleanup_expired_bilibili_qr_locked(&mut values, now);
    values.remove(user_id)
}

fn cleanup_expired_bilibili_qr_locked(values: &mut HashMap<String, PendingBilibiliQr>, now: u64) {
    values.retain(|_, pending| pending.expires_at >= now);
}

fn value_as_i64(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
        .or_else(|| value.as_str()?.trim().parse::<i64>().ok())
}

fn value_as_u64(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|value| u64::try_from(value).ok()))
        .or_else(|| value.as_str()?.trim().parse::<u64>().ok())
}

fn value_as_bool(value: Option<&Value>) -> Option<bool> {
    let value = value?;
    value.as_bool().or_else(|| {
        value.as_i64().map(|number| number != 0).or_else(|| {
            let normalized = value.as_str()?.trim().to_ascii_lowercase();
            if normalized.is_empty() {
                Some(false)
            } else {
                Some(!matches!(normalized.as_str(), "0" | "false" | "no"))
            }
        })
    })
}

fn request_base_url_from_headers(headers: &HeaderMap) -> Option<String> {
    let host =
        first_header(headers, "x-forwarded-host").or_else(|| first_header(headers, "host"))?;
    let proto = first_header(headers, "x-forwarded-proto").unwrap_or_else(|| "http".to_string());
    if proto != "http" && proto != "https" {
        return None;
    }
    clean_base_url(&format!("{proto}://{host}"), false)
}

fn first_header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn clean_config_url(raw: Option<&str>, preserve_path: bool) -> Option<String> {
    clean_base_url(raw?, preserve_path)
}

fn clean_base_url(raw: &str, preserve_path: bool) -> Option<String> {
    let mut url = Url::parse(raw.trim()).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    if url.host_str().is_none() {
        return None;
    }
    url.set_query(None);
    url.set_fragment(None);
    if preserve_path {
        let path = url.path().trim_end_matches('/').to_string();
        url.set_path(&path);
    } else {
        url.set_path("");
    }
    Some(url.as_str().trim_end_matches('/').to_string())
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

async fn codex_status(state: &AppState) -> Value {
    let mut command = tokio::process::Command::new(&state.config.codex.codex_executable);
    command.args(["login", "status"]);
    command.env("CODEX_HOME", state.config.codex_home_path());
    match tokio::time::timeout(std::time::Duration::from_secs(10), command.output()).await {
        Ok(Ok(output)) => {
            let text = String::from_utf8_lossy(&output.stdout).to_string()
                + "\n"
                + &String::from_utf8_lossy(&output.stderr);
            let connected = output.status.success() && text.contains("Logged in");
            json!({
                "name": "openai_codex",
                "connected": connected,
                "required": !connected,
                "detail": if connected {"Codex CLI is logged in for the server user."} else {"Codex CLI is not logged in."},
                "metadata": {"status_output": text.lines().next().unwrap_or("")}
            })
        }
        Ok(Err(err)) => {
            json!({"name": "openai_codex", "connected": false, "required": true, "detail": format!("Codex CLI login status failed: {err}"), "metadata": {"status": "status_error"}})
        }
        Err(_) => {
            json!({"name": "openai_codex", "connected": false, "required": true, "detail": "Codex CLI login status timed out.", "metadata": {"status": "timeout"}})
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn parses_payload_bool_values() {
        assert_eq!(value_as_bool(Some(&json!(true))), Some(true));
        assert_eq!(value_as_bool(Some(&json!("false"))), Some(false));
        assert_eq!(value_as_bool(Some(&json!("yes"))), Some(true));
        assert_eq!(value_as_bool(Some(&json!(0))), Some(false));
        assert_eq!(value_as_bool(Some(&json!(1))), Some(true));
    }

    #[test]
    fn filters_nsjail_log_lines_from_stderr() {
        let status = std::process::Command::new("sh")
            .args(["-c", "exit 7"])
            .status()
            .unwrap();
        let output = std::process::Output {
            status,
            stdout: Vec::new(),
            stderr: b"[I] nsjail info\nreal error\n[W] nsjail warning\n".to_vec(),
        };
        let filtered = filter_nsjail_stderr(output);

        assert_eq!(String::from_utf8_lossy(&filtered.stderr), "real error");
        assert_eq!(filtered.status.code(), Some(7));
    }

    #[test]
    fn parses_bilibili_crossdomain_cookie_fields() {
        let fields = parse_bilibili_cookie_fields_from_crossdomain_url(
            "https://passport.biligame.com/x/passport-login/web/crossDomain?DedeUserID=12345&DedeUserID__ckMd5=abc&Expires=1731536000&SESSDATA=a%2Cb%2Cc&bili_jct=jct",
        );

        assert_eq!(
            fields.get("sessdata").and_then(Value::as_str),
            Some("a,b,c")
        );
        assert_eq!(fields.get("bili_jct").and_then(Value::as_str), Some("jct"));
        assert_eq!(
            fields.get("dede_user_id").and_then(Value::as_str),
            Some("12345")
        );
        assert_eq!(
            fields.get("dede_user_id_ck_md5").and_then(Value::as_str),
            Some("abc")
        );
        assert_eq!(value_as_u64(fields.get("expires_at")), Some(1_731_536_000));
    }

    #[test]
    fn builds_bilibili_app_deep_link_from_scan_url() {
        let app_url = bilibili_app_url(
            "https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=abc&from=",
        );

        assert_eq!(
            app_url,
            "bilibili://browser?url=https%3A%2F%2Faccount.bilibili.com%2Fh5%2Faccount-h5%2Fauth%2Fscan-web%3Fnavhide%3D1%26callback%3Dclose%26qrcode_key%3Dabc%26from%3D"
        );
    }

    #[test]
    fn reads_only_nonexpired_bilibili_credentials() {
        let dir = std::env::temp_dir().join(format!(
            "ripple-bilibili-credential-test-{}",
            Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bilibili.json");

        std::fs::write(
            &path,
            serde_json::to_vec(&json!({
                "sessdata": "sess",
                "expires_at": now_epoch_seconds() + 3600,
                "uname": "alice",
                "mid": 42
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(read_valid_bilibili_credential_file(&path).is_some());

        std::fs::write(
            &path,
            serde_json::to_vec(&json!({"sessdata": "sess", "expires_at": 1})).unwrap(),
        )
        .unwrap();
        assert!(read_valid_bilibili_credential_file(&path).is_none());

        std::fs::write(
            &path,
            serde_json::to_vec(&json!({"sessdata": "  "})).unwrap(),
        )
        .unwrap();
        assert!(read_valid_bilibili_credential_file(&path).is_none());

        let _ = std::fs::remove_dir_all(dir);
    }
}
