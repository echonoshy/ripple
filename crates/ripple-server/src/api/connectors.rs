use std::collections::HashMap;
use std::path::{Path as FsPath, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::{OriginalUri, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::Json;
use reqwest::header;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex as AsyncMutex;
use url::{form_urlencoded, Url};
use uuid::Uuid;

use crate::api::ApiError;
use crate::config::{FeishuAppConfig, GogcliOAuthClient};
use crate::state::AppState;
use crate::user::user_id_from_headers;

const GOGCLI_OAUTH_CALLBACK_PATH: &str = "/v1/sandboxes/gogcli/oauth/callback";
const GOOGLE_OAUTH_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/auth";
const GOOGLE_OAUTH_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_WORKSPACE_BASIC_SCOPES: &[&str] = &[
    "email",
    "openid",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.settings.basic",
    "https://www.googleapis.com/auth/gmail.settings.sharing",
    "https://www.googleapis.com/auth/presentations",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/userinfo.email",
];
const GOGCLI_BASIC_SERVICES: &[&str] = &["gmail", "drive", "calendar", "docs", "sheets", "slides"];
const GOGCLI_BASIC_SERVICES_ARG: &str = "gmail,drive,calendar,docs,sheets,slides";
const GOGCLI_OAUTH_PENDING_TTL_SECONDS: u64 = 600;
const BILIBILI_QRCODE_GENERATE_URL: &str =
    "https://passport.bilibili.com/x/passport-login/web/qrcode/generate";
const BILIBILI_QRCODE_POLL_URL: &str =
    "https://passport.bilibili.com/x/passport-login/web/qrcode/poll";
const BILIBILI_NAV_URL: &str = "https://api.bilibili.com/x/web-interface/nav";
const BILIBILI_DEFAULT_UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BILIBILI_DEFAULT_REFERER: &str = "https://www.bilibili.com/";
const BILIBILI_QR_STATE_OK: i64 = 0;
const BILIBILI_QR_STATE_EXPIRED: i64 = 86038;
const BILIBILI_QR_STATE_NOT_CONFIRMED: i64 = 86090;
const BILIBILI_QR_STATE_NOT_SCANNED: i64 = 86101;
const BILIBILI_QRCODE_TTL_SECONDS: u64 = 180;
const BILIBILI_PENDING_TTL_SECONDS: u64 = 600;

#[derive(Clone, Debug)]
struct PendingGogcliOAuth {
    user_id: String,
    redirect_uri: String,
    expires_at: u64,
}

#[derive(Clone, Debug)]
struct GogcliClientConfig {
    client_id: String,
    client_secret: String,
}

#[derive(Clone, Debug)]
struct GoogleOAuthToken {
    access_token: String,
    refresh_token: String,
}

#[derive(Clone, Debug)]
struct GoogleOAuthIdentity {
    email: String,
    subject: String,
}

#[derive(Debug)]
struct PendingFeishuSetup {
    process: Child,
    url: String,
}

#[derive(Clone, Debug)]
struct PendingBilibiliQr {
    expires_at: u64,
}

#[derive(Debug)]
struct BilibiliQrCode {
    qrcode_key: String,
    qrcode_content: String,
}

#[derive(Debug)]
struct BilibiliPollResult {
    state: &'static str,
    raw_code: i64,
    raw_message: String,
    credential_fields: Option<Value>,
}

#[derive(Debug)]
struct BilibiliLiveCredential {
    is_login: bool,
    uname: String,
    mid: u64,
    raw_log: Option<String>,
}

static PENDING_GOGCLI_OAUTH: OnceLock<Mutex<HashMap<String, PendingGogcliOAuth>>> = OnceLock::new();
static PENDING_FEISHU_SETUP: OnceLock<AsyncMutex<HashMap<String, PendingFeishuSetup>>> =
    OnceLock::new();
static PENDING_BILIBILI_QR: OnceLock<Mutex<HashMap<String, PendingBilibiliQr>>> = OnceLock::new();

pub async fn list_connectors() -> Json<Value> {
    Json(json!({
        "connectors": [
            connector_info("google_workspace", "Google Workspace", "Gmail, Drive, Docs, Sheets, Slides, and Calendar through gogcli.", "oauth", "user_connector", "oauth_assisted", false, true),
            connector_info("notion", "Notion", "Notion API access through a per-user integration token.", "token", "user_connector", "token", false, true),
            connector_info("feishu", "Feishu", "Feishu/Lark access through browser authorization.", "oauth", "user_connector", "oauth_device", false, true),
            connector_info("bilibili", "Bilibili", "Bilibili session access through QR login credentials.", "qr", "user_connector", "qr", false, true),
            connector_info("openai_codex", "OpenAI Codex", "Server-side Codex CLI login used by the app-server executor.", "cli", "runtime_capability", "none", false, false),
            connector_info("codex_image_generation", "Image Generation", "Generate images through the server-side Codex runtime.", "runtime", "runtime_capability", "none", false, false),
            connector_info("codex_image_input", "Image Input", "Accept uploaded or remote images through Codex native input items.", "runtime", "runtime_capability", "none", false, false),
            connector_info("codex_web_search", "Web Search", "Use Codex runtime web/search capabilities.", "runtime", "runtime_capability", "none", false, false)
        ]
    }))
}

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
    let workspace = state.sandboxes.workspace_dir(user_id)?;
    let credentials = state.sandboxes.credentials_dir(user_id)?;
    let status = match connector_name {
        "notion" => {
            let connected =
                read_json_string_field(&credentials.join("notion.json"), "api_token").is_some();
            json!({"name": connector_name, "connected": connected, "required": !connected, "detail": if connected {"Notion token is stored for this user."} else {"Notion token is missing for this user."}, "metadata": {}})
        }
        "google_workspace" => {
            let connected = has_nonempty_file(&workspace.join(".config/gogcli/keyring"));
            json!({"name": connector_name, "connected": connected, "required": !connected, "detail": if connected {"Google Workspace account is connected for this user."} else {"Google Workspace is not connected for this user."}, "metadata": {"has_client_config": credentials.join("gogcli-client.json").is_file()}})
        }
        "feishu" => feishu_status(state, user_id).await,
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
    state.sandboxes.ensure_sandbox(user_id)?;
    match connector_name {
        "notion" => notion_auth_start(state, user_id, payload).await,
        "google_workspace" => google_auth_start(state, user_id, request_base_url).await,
        "bilibili" => bilibili_auth_start(state, user_id).await,
        "feishu" => feishu_auth_start(state, user_id, payload).await,
        _ => Err(ApiError::not_found(format!(
            "Connector {connector_name:?} not found"
        ))),
    }
}

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
    state.sandboxes.ensure_sandbox(user_id)?;
    match connector_name {
        "google_workspace" => google_auth_complete(state, user_id, payload).await,
        "bilibili" => bilibili_auth_complete(state, user_id, payload).await,
        "feishu" => feishu_auth_complete(state, user_id, payload).await,
        "notion" => Err(ApiError::new(
            StatusCode::METHOD_NOT_ALLOWED,
            "Notion uses auth_start with an api_token payload",
        )),
        _ => Err(ApiError::not_found(format!(
            "Connector {connector_name:?} not found"
        ))),
    }
}

pub async fn connector_disconnect(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(connector_name): Path<String>,
    body: Option<Json<Value>>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    let payload = body.map(|Json(value)| value).unwrap_or_else(|| json!({}));
    match connector_name.as_str() {
        "notion" => notion_disconnect(&state, &user_id).await,
        "google_workspace" => google_disconnect(&state, &user_id, &payload).await,
        "feishu" => feishu_disconnect(&state, &user_id).await,
        "bilibili" => bilibili_disconnect(&state, &user_id).await,
        _ => Err(ApiError::not_found(format!(
            "Connector {connector_name:?} not found"
        ))),
    }
}

#[derive(Debug, Deserialize)]
pub struct AccountsQuery {
    check: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct GogcliCallbackQuery {
    state: Option<String>,
    code: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

pub async fn connector_accounts(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(connector_name): Path<String>,
    Query(query): Query<AccountsQuery>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    ensure_sandbox_exists(&state, &user_id)?;
    if connector_name != "google_workspace" {
        return Err(ApiError::new(
            StatusCode::METHOD_NOT_ALLOWED,
            format!("Connector {connector_name:?} does not support accounts"),
        ));
    }
    google_accounts(&state, &user_id, query.check.unwrap_or(false)).await
}

pub async fn gogcli_accounts_alias(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AccountsQuery>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    ensure_sandbox_exists(&state, &user_id)?;
    google_accounts(&state, &user_id, query.check.unwrap_or(false)).await
}

pub async fn gogcli_oauth_callback(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Query(query): Query<GogcliCallbackQuery>,
) -> Response {
    let oauth_state = query.state.as_deref().unwrap_or("").trim().to_string();
    if oauth_state.is_empty() {
        return gogcli_oauth_html(
            StatusCode::BAD_REQUEST,
            "Google 授权失败",
            "OAuth 回调缺少 state 参数。",
        );
    }

    let Some(pending) = pop_pending_gogcli_oauth(&oauth_state) else {
        return gogcli_oauth_html(
            StatusCode::BAD_REQUEST,
            "Google 授权已过期",
            "找不到匹配的 OAuth 登录请求，可能已经超过 10 分钟或服务已重启。请回到 Ripple 重新发起授权。",
        );
    };

    if let Some(provider_error) = query.error.as_deref() {
        let detail = query.error_description.as_deref().unwrap_or(provider_error);
        return gogcli_oauth_html(
            StatusCode::BAD_REQUEST,
            "Google 授权被拒绝",
            &format!("Google 返回错误：{detail}。请回到 Ripple 重新发起授权。"),
        );
    }

    if query.code.as_deref().unwrap_or("").trim().is_empty() {
        return gogcli_oauth_html(
            StatusCode::BAD_REQUEST,
            "Google 授权失败",
            "OAuth 回调缺少 code 参数。",
        );
    }

    let callback_url =
        build_gogcli_callback_auth_url(&pending.redirect_uri, uri.query().unwrap_or_default());
    match complete_google_workspace_oauth_callback(&state, pending.clone(), &callback_url).await {
        Ok(Json(value)) => {
            if value.get("ok").and_then(Value::as_bool) == Some(true) {
                gogcli_oauth_html(
                    StatusCode::OK,
                    "Google 授权完成",
                    "Ripple 已保存 Google Workspace 授权。可以关闭这个页面，回到对话继续。",
                )
            } else {
                let detail = value
                    .get("detail")
                    .and_then(Value::as_str)
                    .unwrap_or("授权未完成。");
                gogcli_oauth_html(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Google 授权未完成",
                    &format!("{detail} 请回到 Ripple 重新发起授权。"),
                )
            }
        }
        Err(err) => gogcli_oauth_html(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Google 授权未完成",
            &format!("{err:?} 请回到 Ripple 重新发起授权。"),
        ),
    }
}

fn connector_info(
    name: &str,
    display_name: &str,
    description: &str,
    auth_type: &str,
    kind: &str,
    auth_flow: &str,
    web: bool,
    chat: bool,
) -> Value {
    json!({
        "name": name,
        "display_name": display_name,
        "description": description,
        "auth_type": auth_type,
        "kind": kind,
        "auth_flow": auth_flow,
        "auth_surfaces": {"web": web, "chat": chat},
        "auth_start_path": Value::Null,
        "auth_complete_path": Value::Null,
        "disconnect_path": Value::Null,
        "accounts_path": if name == "google_workspace" { json!("/v1/connectors/google_workspace/accounts") } else { Value::Null }
    })
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

async fn google_auth_start(
    state: &AppState,
    user_id: &str,
    request_base_url: Option<&str>,
) -> Result<Json<Value>, ApiError> {
    let Some(gog) = gog_binary(state) else {
        return Ok(Json(action_response(
            "google_workspace",
            false,
            "missing_cli",
            "gogcli is not installed. Ask an administrator to run scripts/install-gogcli-cli.sh.",
            json!({}),
        )));
    };

    let Some(callback_url) = resolve_gogcli_oauth_callback_url(state, request_base_url) else {
        return Ok(Json(action_response(
            "google_workspace",
            false,
            "server_config_required",
            "Google Workspace assisted OAuth callback is not configured. Configure server.gogcli_oauth.callback_url or server.public_base_url.",
            json!({}),
        )));
    };

    if !state
        .sandboxes
        .gogcli_client_config_file(user_id)?
        .is_file()
    {
        let Some(client_json) = configured_gogcli_client_secret_json(state, &callback_url)? else {
            let callback_hint = format!(
                "{}{}",
                state
                    .config
                    .public_base_url
                    .as_deref()
                    .unwrap_or("<server.public_base_url>"),
                GOGCLI_OAUTH_CALLBACK_PATH
            );
            return Ok(Json(action_response(
                "google_workspace",
                false,
                "server_config_required",
                &format!(
                    "Google Workspace OAuth client is not configured. Configure server.gogcli_oauth.client and allow redirect URI: {callback_hint}"
                ),
                json!({}),
            )));
        };
        if let Err(err) = register_gogcli_client_config(state, user_id, &gog, &client_json).await {
            return Ok(Json(action_response(
                "google_workspace",
                false,
                "server_config_failed",
                &format!("{err:?}"),
                json!({}),
            )));
        }
    }

    let Some(client_config) = read_gogcli_client_config(state, user_id)? else {
        return Ok(Json(action_response(
            "google_workspace",
            false,
            "server_config_invalid",
            "gogcli OAuth client is invalid.",
            json!({}),
        )));
    };

    let oauth_state = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let oauth_url =
        build_google_workspace_oauth_url(&client_config.client_id, &callback_url, &oauth_state)?;
    register_pending_gogcli_oauth(&oauth_state, user_id, &callback_url);
    Ok(Json(action_response(
        "google_workspace",
        true,
        "awaiting_browser_callback",
        "Open oauth_url to continue.",
        json!({
            "oauth_url": oauth_url,
            "expires_in_seconds": GOGCLI_OAUTH_PENDING_TTL_SECONDS,
            "callback_mode": "assisted",
            "assisted_callback_url": callback_url
        }),
    )))
}

async fn google_auth_complete(
    state: &AppState,
    user_id: &str,
    payload: &Value,
) -> Result<Json<Value>, ApiError> {
    let callback_url = payload
        .get("callback_url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if !looks_like_google_callback_url(callback_url) {
        return Ok(Json(action_response(
            "google_workspace",
            false,
            "invalid_request",
            "callback_url is invalid.",
            json!({}),
        )));
    }
    if !(callback_url.contains("code=") && callback_url.contains("state=")) {
        return Ok(Json(action_response(
            "google_workspace",
            false,
            "invalid_request",
            "callback_url must include code and state.",
            json!({}),
        )));
    }

    if let Some(oauth_state) = extract_oauth_state(callback_url) {
        if let Some(pending) = pop_pending_gogcli_oauth(&oauth_state) {
            if pending.user_id != user_id {
                return Ok(Json(action_response(
                    "google_workspace",
                    false,
                    "invalid_request",
                    "OAuth state belongs to a different Ripple user.",
                    json!({}),
                )));
            }
            return complete_google_workspace_oauth_callback(state, pending, callback_url).await;
        }
    }

    let email = payload
        .get("email")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if !looks_like_email(email) {
        return Ok(Json(action_response(
            "google_workspace",
            false,
            "invalid_request",
            "email is required for legacy gogcli callback completion.",
            json!({}),
        )));
    }
    let Some(gog) = gog_binary(state) else {
        return Ok(Json(action_response(
            "google_workspace",
            false,
            "missing_cli",
            "gogcli is not installed.",
            json!({}),
        )));
    };
    ensure_gog_keyring_password(state, user_id).await?;
    state.sandboxes.write_nsjail_config(user_id)?;
    let output = run_gog(
        state,
        user_id,
        &gog,
        &[
            "auth",
            "add",
            email,
            "--services",
            GOGCLI_BASIC_SERVICES_ARG,
            "--remote",
            "--step",
            "2",
            "--auth-url",
            callback_url,
        ],
        None,
        60,
    )
    .await?;
    if !output.status.success() {
        return Ok(Json(action_response(
            "google_workspace",
            false,
            "auth_failed",
            &format!(
                "gog auth add step 2 failed (exit {}): {}",
                output.status.code().unwrap_or(-1),
                command_tail(&output)
            ),
            json!({}),
        )));
    }
    Ok(Json(action_response(
        "google_workspace",
        true,
        "authorized",
        "Google Workspace account authorized for this user.",
        json!({"email": email}),
    )))
}

async fn feishu_status(state: &AppState, user_id: &str) -> Value {
    let (connected, detail, mut metadata) = feishu_cli_login_status(state, user_id).await;
    if let Ok(seed_file) = state.sandboxes.credentials_dir(user_id) {
        metadata["has_seed_credentials"] = json!(seed_file.join("feishu.json").is_file());
    }
    json!({
        "name": "feishu",
        "connected": connected,
        "required": !connected,
        "detail": detail,
        "metadata": metadata
    })
}

async fn feishu_auth_start(
    state: &AppState,
    user_id: &str,
    payload: &Value,
) -> Result<Json<Value>, ApiError> {
    let app_id = payload
        .get("app_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let app_secret = payload
        .get("app_secret")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let brand = payload
        .get("brand")
        .and_then(Value::as_str)
        .unwrap_or("feishu")
        .trim();
    if !app_id.is_empty() || !app_secret.is_empty() {
        if app_id.is_empty() || app_secret.is_empty() {
            return Ok(Json(action_response(
                "feishu",
                false,
                "invalid_credentials",
                "Both app_id and app_secret are required when seeding Feishu credentials.",
                json!({}),
            )));
        }
        let path = state
            .sandboxes
            .credentials_dir(user_id)?
            .join("feishu.json");
        write_secret_json(
            &path,
            &json!({"app_id": app_id, "app_secret": app_secret, "brand": if brand.is_empty() {"feishu"} else {brand}}),
        )
        .await?;
    }

    let force_new_setup = value_as_bool(payload.get("force_new_setup")).unwrap_or(false);
    let force_new_user_auth = value_as_bool(payload.get("force_new_user_auth")).unwrap_or(false);

    let (ok, msg) = ensure_lark_cli_config(state, user_id, force_new_setup).await?;
    state.sandboxes.write_nsjail_config(user_id)?;
    if looks_like_url(&msg) {
        return Ok(Json(action_response(
            "feishu",
            true,
            "awaiting_setup",
            "Open the setup URL to finish Feishu configuration.",
            json!({"setup_url": msg}),
        )));
    }
    if !ok {
        return Ok(Json(action_response(
            "feishu",
            false,
            "auth_failed",
            &msg,
            json!({}),
        )));
    }

    let (connected, _detail, metadata) = feishu_cli_login_status(state, user_id).await;
    if connected && !force_new_user_auth {
        return Ok(Json(action_response(
            "feishu",
            true,
            "authorized",
            "Feishu user authorization is already ready for this user.",
            json!({}),
        )));
    }
    if feishu_status_needs_setup(&metadata) {
        let (ok, msg) = ensure_lark_cli_config(state, user_id, true).await?;
        state.sandboxes.write_nsjail_config(user_id)?;
        if looks_like_url(&msg) {
            return Ok(Json(action_response(
                "feishu",
                true,
                "awaiting_setup",
                "Open the setup URL to finish Feishu configuration.",
                json!({"setup_url": msg}),
            )));
        }
        if !ok {
            return Ok(Json(action_response(
                "feishu",
                false,
                "auth_failed",
                &msg,
                json!({}),
            )));
        }
    }

    let data = match start_lark_user_auth(state, user_id, true).await {
        Ok(data) => data,
        Err(err) => {
            return Ok(Json(action_response(
                "feishu",
                false,
                "auth_failed",
                &err.to_string(),
                json!({}),
            )))
        }
    };
    Ok(Json(action_response(
        "feishu",
        true,
        "awaiting_user_auth",
        "Open oauth_url in a browser, finish Feishu authorization, then complete the auth flow.",
        data,
    )))
}

async fn feishu_auth_complete(
    state: &AppState,
    user_id: &str,
    payload: &Value,
) -> Result<Json<Value>, ApiError> {
    let device_code = payload
        .get("device_code")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if device_code.is_empty() {
        return Ok(Json(action_response(
            "feishu",
            false,
            "invalid_request",
            "device_code is required.",
            json!({}),
        )));
    }
    let complete_result = complete_lark_user_auth(state, user_id, device_code).await;
    state.sandboxes.write_nsjail_config(user_id)?;
    if complete_result.as_ref().is_ok_and(|ok| *ok) {
        return Ok(Json(action_response(
            "feishu",
            true,
            "authorized",
            "Feishu user authorization completed for this user.",
            json!({}),
        )));
    }

    let msg = complete_result
        .err()
        .map(|err| err.to_string())
        .unwrap_or_else(|| "Feishu user authorization is not ready yet.".to_string());
    let (connected, status_detail, status_metadata) =
        confirm_feishu_user_authorization(state, user_id).await;
    if connected {
        return Ok(Json(action_response(
            "feishu",
            true,
            "authorized",
            "Feishu user authorization completed for this user.",
            json!({"status_detail": status_detail, "status_metadata": status_metadata}),
        )));
    }
    let final_confirmation = is_feishu_auth_final_confirmation_message(&msg);
    let stage = if is_feishu_auth_pending_message(&msg) || final_confirmation {
        "pending"
    } else {
        "auth_failed"
    };
    Ok(Json(action_response(
        "feishu",
        stage == "pending",
        stage,
        if final_confirmation {
            "Feishu authorization was confirmed in the browser, but local user status is not ready yet."
        } else {
            &msg
        },
        json!({
            "device_code_finalized": final_confirmation,
            "status_detail": status_detail,
            "status_metadata": status_metadata
        }),
    )))
}

async fn feishu_disconnect(state: &AppState, user_id: &str) -> Result<Json<Value>, ApiError> {
    cancel_feishu_setup(user_id).await;
    let seed = state
        .sandboxes
        .credentials_dir(user_id)?
        .join("feishu.json");
    let removed_seed = remove_file_if_exists(&seed).await?;
    let lark_dir = state.sandboxes.workspace_dir(user_id)?.join(".lark-cli");
    let removed_workspace_config = if lark_dir.exists() {
        tokio::fs::remove_dir_all(&lark_dir).await?;
        true
    } else {
        false
    };
    state.sandboxes.write_nsjail_config(user_id)?;
    Ok(Json(action_response(
        "feishu",
        true,
        "disconnected",
        "Feishu connector state removed for this user.",
        json!({"seed_removed": removed_seed, "workspace_config_removed": removed_workspace_config}),
    )))
}

async fn bilibili_disconnect(state: &AppState, user_id: &str) -> Result<Json<Value>, ApiError> {
    let pending_scan_cancelled = release_pending_bilibili_qr(user_id).is_some();
    let path = state.sandboxes.bilibili_config_file(user_id)?;
    let removed = remove_file_if_exists(&path).await?;
    state.sandboxes.write_nsjail_config(user_id)?;
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
    register_pending_bilibili_qr(user_id);
    let encoded_content =
        form_urlencoded::byte_serialize(generated.qrcode_content.as_bytes()).collect::<String>();
    Ok(Json(action_response(
        "bilibili",
        true,
        "awaiting_user",
        "Open qrcode_image_url with the Bilibili app, then complete the auth flow.",
        json!({
            "bound": false,
            "qrcode_key": generated.qrcode_key,
            "qrcode_image_url": format!("/v1/bilibili/qrcode.png?content={encoded_content}"),
            "qrcode_content": generated.qrcode_content,
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
                        release_pending_bilibili_qr(user_id);
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
                            release_pending_bilibili_qr(user_id);
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
                        release_pending_bilibili_qr(user_id);
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
        release_pending_bilibili_qr(user_id);
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

async fn google_accounts(
    state: &AppState,
    user_id: &str,
    check: bool,
) -> Result<Json<Value>, ApiError> {
    let has_client_config = state
        .sandboxes
        .gogcli_client_config_file(user_id)?
        .is_file();
    let Some(gog) = gog_binary(state) else {
        return Ok(Json(json!({
            "has_client_config": has_client_config,
            "accounts": [],
            "count": 0,
            "checked": check
        })));
    };
    let mut args = vec!["auth", "list", "--json"];
    if check {
        args.push("--check");
    }
    let output = run_gog(
        state,
        user_id,
        &gog,
        &args,
        None,
        if check { 30 } else { 10 },
    )
    .await?;
    if !output.status.success() {
        return Ok(Json(json!({
            "has_client_config": has_client_config,
            "accounts": [],
            "count": 0,
            "checked": check
        })));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let accounts = parse_gog_accounts(&stdout);
    Ok(Json(json!({
        "has_client_config": has_client_config,
        "accounts": accounts,
        "count": accounts.len(),
        "checked": check
    })))
}

async fn google_disconnect(
    state: &AppState,
    user_id: &str,
    payload: &Value,
) -> Result<Json<Value>, ApiError> {
    let email = payload
        .get("email")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if !looks_like_email(email) {
        return Ok(Json(action_response(
            "google_workspace",
            false,
            "invalid_request",
            "email is required.",
            json!({}),
        )));
    }
    let Some(gog) = gog_binary(state) else {
        return Ok(Json(action_response(
            "google_workspace",
            false,
            "missing_cli",
            "gogcli is not installed.",
            json!({}),
        )));
    };
    ensure_gog_keyring_password(state, user_id).await?;
    let output = run_gog(
        state,
        user_id,
        &gog,
        &["auth", "remove", email, "--force"],
        None,
        15,
    )
    .await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Ok(Json(action_response(
            "google_workspace",
            false,
            "disconnect_failed",
            &format!(
                "gog auth remove failed (exit {}): {}",
                output.status.code().unwrap_or(-1),
                tail(
                    if stderr.trim().is_empty() {
                        &stdout
                    } else {
                        &stderr
                    },
                    500
                )
            ),
            json!({}),
        )));
    }
    let accounts = google_accounts(state, user_id, false).await?.0;
    Ok(Json(action_response(
        "google_workspace",
        true,
        "disconnected",
        "Google Workspace account removed from this user's keyring.",
        json!({"email": email, "accounts": accounts}),
    )))
}

fn lark_binary(state: &AppState) -> Option<PathBuf> {
    let root = state.config.sandbox.lark_cli_install_root.as_ref()?;
    let path = root.join("current/bin/lark-cli");
    path.is_file().then_some(path)
}

async fn run_lark(
    state: &AppState,
    user_id: &str,
    _lark: &FsPath,
    args: &[&str],
    stdin: Option<&str>,
    timeout_seconds: u64,
) -> Result<std::process::Output, ApiError> {
    let argv = state.sandboxes.nsjail_exec_argv(
        user_id,
        state.sandboxes.lark_cli_sandbox_binary(),
        args,
    )?;
    let mut command = Command::new(&argv[0]);
    command
        .args(&argv[1..])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if stdin.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command.spawn()?;
    if let Some(stdin_text) = stdin {
        use tokio::io::AsyncWriteExt;
        if let Some(mut child_stdin) = child.stdin.take() {
            child_stdin.write_all(stdin_text.as_bytes()).await?;
        }
    }
    tokio::time::timeout(
        Duration::from_secs(timeout_seconds),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| ApiError::new(StatusCode::GATEWAY_TIMEOUT, "lark-cli command timed out"))?
    .map(filter_nsjail_stderr)
    .map_err(ApiError::from)
}

async fn feishu_cli_login_status(state: &AppState, user_id: &str) -> (bool, String, Value) {
    let Some(lark) = lark_binary(state) else {
        return (
            false,
            "lark-cli is not installed for this server.".to_string(),
            json!({"has_app_config": false}),
        );
    };
    let has_app_config = state
        .sandboxes
        .workspace_dir(user_id)
        .map(|workspace| workspace.join(".lark-cli/config.json").is_file())
        .unwrap_or(false);
    if !has_app_config {
        return (
            false,
            "Feishu CLI app configuration is missing for this user.".to_string(),
            json!({"has_app_config": false}),
        );
    }

    let mut metadata = Map::new();
    metadata.insert("has_app_config".to_string(), json!(true));
    match run_lark(state, user_id, &lark, &["doctor"], None, 15).await {
        Ok(output) => {
            let doctor_output = String::from_utf8_lossy(&output.stdout).to_string()
                + "\n"
                + &String::from_utf8_lossy(&output.stderr);
            if let Some(parsed) = first_json_object(&doctor_output) {
                if let Some(checks) = parsed.get("checks").and_then(Value::as_array) {
                    let mut check_status = Map::new();
                    let mut check_messages = Map::new();
                    for check in checks {
                        let Some(name) = check.get("name").and_then(Value::as_str) else {
                            continue;
                        };
                        if let Some(status) = check.get("status").and_then(Value::as_str) {
                            check_status.insert(name.to_string(), json!(status));
                        }
                        if let Some(message) = check.get("message").and_then(Value::as_str) {
                            check_messages.insert(name.to_string(), json!(message));
                        }
                    }
                    for name in ["config_file", "app_resolved", "token_exists"] {
                        if let Some(status) = check_status.get(name).and_then(Value::as_str) {
                            if status != "pass" {
                                let detail = check_messages
                                    .get(name)
                                    .and_then(Value::as_str)
                                    .unwrap_or(match name {
                                        "config_file" => "Feishu CLI app configuration is missing.",
                                        "app_resolved" => {
                                            "Feishu CLI app configuration is invalid."
                                        }
                                        _ => "Feishu user authorization is missing.",
                                    });
                                metadata.insert(
                                    "doctor_checks".to_string(),
                                    Value::Object(check_status),
                                );
                                return (false, detail.to_string(), Value::Object(metadata));
                            }
                        }
                    }
                    metadata.insert("doctor_checks".to_string(), Value::Object(check_status));
                }
            }
        }
        Err(err) => {
            metadata.insert("doctor_error".to_string(), json!(format!("{err:?}")));
        }
    }

    let output = match run_lark(state, user_id, &lark, &["auth", "status"], None, 10).await {
        Ok(output) => output,
        Err(err) => {
            return (
                false,
                format!("Feishu auth status check failed: {err:?}"),
                Value::Object(metadata),
            )
        }
    };
    let text = String::from_utf8_lossy(&output.stdout).to_string()
        + "\n"
        + &String::from_utf8_lossy(&output.stderr);
    if let Some(parsed) = first_json_object(&text) {
        let mut has_user_auth_evidence = false;
        for (source, target) in [
            ("identity", "identity"),
            ("open_id", "open_id"),
            ("openId", "open_id"),
            ("userOpenId", "open_id"),
            ("tenant_key", "tenant_key"),
            ("tenantKey", "tenant_key"),
        ] {
            if let Some(value) = parsed.get(source).and_then(Value::as_str) {
                if !value.trim().is_empty() {
                    metadata.insert(target.to_string(), json!(value));
                    if target == "open_id"
                        || (target == "identity" && value.trim().eq_ignore_ascii_case("user"))
                    {
                        has_user_auth_evidence = true;
                    }
                }
            }
        }
        if parsed.get("ok").and_then(Value::as_bool) == Some(false) {
            let message = parsed
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Feishu user authorization is missing.");
            return (false, message.to_string(), Value::Object(metadata));
        }
        if has_user_auth_evidence {
            return (
                true,
                "Feishu user authorization is ready.".to_string(),
                Value::Object(metadata),
            );
        }
    }
    if output.status.success() {
        (
            false,
            "Feishu user authorization status is inconclusive.".to_string(),
            Value::Object(metadata),
        )
    } else {
        (false, command_tail(&output), Value::Object(metadata))
    }
}

async fn ensure_lark_cli_config(
    state: &AppState,
    user_id: &str,
    force_new_setup: bool,
) -> Result<(bool, String), ApiError> {
    if lark_binary(state).is_none() {
        return Ok((
            false,
            "lark-cli is not installed. Ask an administrator to run scripts/install-feishu-cli.sh."
                .to_string(),
        ));
    }
    let lark_dir = state.sandboxes.workspace_dir(user_id)?.join(".lark-cli");
    if force_new_setup {
        cancel_feishu_setup(user_id).await;
        if lark_dir.exists() {
            tokio::fs::remove_dir_all(&lark_dir).await?;
        }
    }
    if lark_dir.join("config.json").is_file() {
        return Ok((true, String::new()));
    }
    if let Some(app) = read_feishu_app_credentials(state, user_id)? {
        return inject_feishu_credentials(state, user_id, &app).await;
    }
    if let Some(result) = check_feishu_setup(state, user_id).await? {
        return Ok(result);
    }
    start_feishu_setup(state, user_id).await
}

fn read_feishu_app_credentials(
    state: &AppState,
    user_id: &str,
) -> Result<Option<FeishuAppConfig>, ApiError> {
    let seed_file = state
        .sandboxes
        .credentials_dir(user_id)?
        .join("feishu.json");
    if seed_file.is_file() {
        let value = serde_json::from_slice::<Value>(&std::fs::read(seed_file)?)
            .map_err(|err| ApiError::bad_request(err.to_string()))?;
        if let Some(app) = parse_feishu_app_credentials(&value) {
            return Ok(Some(app));
        }
    }
    Ok(state.config.feishu.app.clone())
}

fn parse_feishu_app_credentials(value: &Value) -> Option<FeishuAppConfig> {
    let app_id = value.get("app_id")?.as_str()?.trim();
    let app_secret = value.get("app_secret")?.as_str()?.trim();
    if app_id.is_empty() || app_secret.is_empty() {
        return None;
    }
    let brand = value
        .get("brand")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("feishu");
    Some(FeishuAppConfig {
        app_id: app_id.to_string(),
        app_secret: app_secret.to_string(),
        brand: brand.to_string(),
    })
}

async fn inject_feishu_credentials(
    state: &AppState,
    user_id: &str,
    app: &FeishuAppConfig,
) -> Result<(bool, String), ApiError> {
    let Some(lark) = lark_binary(state) else {
        return Ok((false, "lark-cli is not installed.".to_string()));
    };
    let output = run_lark(
        state,
        user_id,
        &lark,
        &[
            "config",
            "init",
            "--app-id",
            app.app_id.as_str(),
            "--app-secret-stdin",
            "--brand",
            app.brand.as_str(),
        ],
        Some(&format!("{}\n", app.app_secret)),
        30,
    )
    .await?;
    if output.status.success() {
        Ok((true, String::new()))
    } else {
        Ok((
            false,
            format!(
                "lark-cli credential injection failed (exit {}): {}",
                output.status.code().unwrap_or(-1),
                command_tail(&output)
            ),
        ))
    }
}

async fn start_feishu_setup(state: &AppState, user_id: &str) -> Result<(bool, String), ApiError> {
    let Some(_lark) = lark_binary(state) else {
        return Ok((false, "lark-cli is not installed.".to_string()));
    };
    let argv = state.sandboxes.nsjail_exec_argv(
        user_id,
        "/bin/bash",
        &[
            "-c",
            "/opt/lark-cli/current/bin/lark-cli config init --new --force-init 2>&1",
        ],
    )?;
    let mut command = Command::new(&argv[0]);
    command
        .args(&argv[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn()?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill().await;
        return Ok((false, "Unable to read lark-cli setup output.".to_string()));
    };
    let setup_url = extract_url_from_stdout(stdout, 30).await;
    if setup_url.is_empty() {
        let _ = child.kill().await;
        let _ = child.wait().await;
        return Ok((
            false,
            "Unable to extract setup URL from lark-cli config init --new output.".to_string(),
        ));
    }
    pending_feishu_setup_map().lock().await.insert(
        user_id.to_string(),
        PendingFeishuSetup {
            process: child,
            url: setup_url.clone(),
        },
    );
    Ok((false, setup_url))
}

async fn check_feishu_setup(
    state: &AppState,
    user_id: &str,
) -> Result<Option<(bool, String)>, ApiError> {
    let config_file = state
        .sandboxes
        .workspace_dir(user_id)?
        .join(".lark-cli/config.json");
    if config_file.is_file() {
        cancel_feishu_setup(user_id).await;
        return Ok(Some((true, String::new())));
    }
    let mut setups = pending_feishu_setup_map().lock().await;
    let Some(setup) = setups.get_mut(user_id) else {
        return Ok(None);
    };
    if let Some(status) = setup.process.try_wait()? {
        setups.remove(user_id);
        if !status.success() {
            return Ok(Some((
                false,
                format!(
                    "config init --new failed (exit={})",
                    status.code().unwrap_or(-1)
                ),
            )));
        }
        if config_file.is_file() {
            Ok(Some((true, String::new())))
        } else {
            Ok(Some((
                false,
                "config init --new exited but did not create config.json.".to_string(),
            )))
        }
    } else {
        Ok(Some((false, setup.url.clone())))
    }
}

pub(crate) async fn cancel_feishu_setup(user_id: &str) {
    let setup = pending_feishu_setup_map().lock().await.remove(user_id);
    if let Some(mut setup) = setup {
        let _ = setup.process.kill().await;
        let _ = setup.process.wait().await;
    }
}

fn pending_feishu_setup_map() -> &'static AsyncMutex<HashMap<String, PendingFeishuSetup>> {
    PENDING_FEISHU_SETUP.get_or_init(|| AsyncMutex::new(HashMap::new()))
}

async fn extract_url_from_stdout(
    stdout: tokio::process::ChildStdout,
    timeout_seconds: u64,
) -> String {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_seconds);
    let mut lines = BufReader::new(stdout).lines();
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return String::new();
        }
        match tokio::time::timeout(remaining.min(Duration::from_secs(5)), lines.next_line()).await {
            Ok(Ok(Some(line))) => {
                if let Some(url) = first_url_in_text(&line) {
                    tokio::spawn(
                        async move { while matches!(lines.next_line().await, Ok(Some(_))) {} },
                    );
                    return url;
                }
            }
            Ok(Ok(None)) | Ok(Err(_)) | Err(_) => return String::new(),
        }
    }
}

fn first_url_in_text(text: &str) -> Option<String> {
    text.split_whitespace()
        .find(|part| part.starts_with("http://") || part.starts_with("https://"))
        .map(|part| {
            part.trim_matches(|ch: char| {
                ch == '"' || ch == '\'' || ch == '`' || ch == ')' || ch == ']' || ch == '>'
            })
            .to_string()
        })
}

async fn start_lark_user_auth(
    state: &AppState,
    user_id: &str,
    force_new: bool,
) -> anyhow::Result<Value> {
    let Some(lark) = lark_binary(state) else {
        anyhow::bail!("lark-cli is not installed.");
    };
    if force_new {
        let output = run_lark(state, user_id, &lark, &["auth", "logout"], None, 10)
            .await
            .map_err(|err| anyhow::anyhow!("{err:?}"))?;
        if !output.status.success() {
            tracing::warn!(
                user_id = user_id,
                detail = command_tail(&output),
                "lark-cli auth logout before new device flow failed"
            );
        }
    }
    let output = run_lark(
        state,
        user_id,
        &lark,
        &["auth", "login", "--no-wait", "--json", "--domain", "all"],
        None,
        20,
    )
    .await
    .map_err(|err| anyhow::anyhow!("{err:?}"))?;
    if !output.status.success() {
        anyhow::bail!(
            "lark-cli auth login --no-wait failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            command_tail(&output)
        );
    }
    let merged = String::from_utf8_lossy(&output.stdout).to_string()
        + "\n"
        + &String::from_utf8_lossy(&output.stderr);
    let parsed = first_json_object(&merged).ok_or_else(|| {
        anyhow::anyhow!("Unable to parse lark-cli auth login --no-wait JSON output")
    })?;
    feishu_auth_start_payload(&parsed).ok_or_else(|| {
        anyhow::anyhow!("lark-cli auth login --no-wait output is missing oauth_url or device_code")
    })
}

async fn complete_lark_user_auth(
    state: &AppState,
    user_id: &str,
    device_code: &str,
) -> anyhow::Result<bool> {
    let Some(lark) = lark_binary(state) else {
        anyhow::bail!("lark-cli is not installed.");
    };
    let output = run_lark(
        state,
        user_id,
        &lark,
        &["auth", "login", "--device-code", device_code],
        None,
        60,
    )
    .await
    .map_err(|err| anyhow::anyhow!("{err:?}"))?;
    if output.status.success() {
        Ok(true)
    } else {
        anyhow::bail!(
            "{}",
            command_tail(&output)
                .trim()
                .to_string()
                .if_empty("lark-cli auth login --device-code failed")
        )
    }
}

async fn confirm_feishu_user_authorization(
    state: &AppState,
    user_id: &str,
) -> (bool, String, Value) {
    let mut last_detail = "Feishu user authorization status is not ready yet.".to_string();
    let mut last_metadata = json!({});
    for delay_seconds in [0_u64, 1, 2] {
        if delay_seconds > 0 {
            tokio::time::sleep(Duration::from_secs(delay_seconds)).await;
        }
        let (connected, detail, metadata) = feishu_cli_login_status(state, user_id).await;
        if connected {
            return (true, detail, metadata);
        }
        last_detail = detail;
        last_metadata = metadata;
    }
    (false, last_detail, last_metadata)
}

fn feishu_status_needs_setup(metadata: &Value) -> bool {
    let Some(checks) = metadata.get("doctor_checks").and_then(Value::as_object) else {
        return false;
    };
    ["config_file", "app_resolved"].into_iter().any(|name| {
        checks
            .get(name)
            .and_then(Value::as_str)
            .is_some_and(|status| status != "pass")
    })
}

fn feishu_auth_start_payload(value: &Value) -> Option<Value> {
    let data = value
        .get("data")
        .and_then(Value::as_object)
        .cloned()
        .map(Value::Object)
        .unwrap_or_else(|| value.clone());
    let oauth_url = data
        .get("verification_url")
        .or_else(|| data.get("verification_uri"))
        .or_else(|| data.get("oauth_url"))
        .or_else(|| data.get("auth_url"))
        .or_else(|| data.get("url"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let device_code = data
        .get("device_code")
        .or_else(|| data.get("deviceCode"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let mut out = Map::new();
    out.insert("oauth_url".to_string(), json!(oauth_url));
    out.insert("device_code".to_string(), json!(device_code));
    if let Some(expires) = value_as_u64(
        data.get("expires_in_seconds")
            .or_else(|| data.get("expires_in"))
            .or_else(|| data.get("expiresIn")),
    ) {
        out.insert("expires_in_seconds".to_string(), json!(expires));
    }
    Some(Value::Object(out))
}

fn first_json_object(text: &str) -> Option<Value> {
    for (index, ch) in text.char_indices() {
        if ch != '{' {
            continue;
        }
        let mut deserializer = serde_json::Deserializer::from_str(&text[index..]);
        if let Ok(value) = Value::deserialize(&mut deserializer) {
            if value.is_object() {
                return Some(value);
            }
        }
    }
    None
}

fn is_feishu_auth_pending_message(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    [
        "pending",
        "not yet",
        "not completed",
        "authorization_pending",
        "slow_down",
        "尚未",
        "未完成",
        "等待",
    ]
    .into_iter()
    .any(|marker| normalized.contains(marker))
}

fn is_feishu_auth_final_confirmation_message(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    [
        "本次授权请求用户最终确认后的结果",
        "请勿持续重试",
        "最终确认",
        "final confirmation",
    ]
    .into_iter()
    .any(|marker| normalized.contains(marker))
}

trait IfEmpty {
    fn if_empty(self, fallback: &str) -> String;
}

impl IfEmpty for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

fn action_response(name: &str, ok: bool, stage: &str, detail: &str, data: Value) -> Value {
    json!({
        "name": name,
        "ok": ok,
        "stage": stage,
        "detail": detail,
        "data": data
    })
}

fn gog_binary(state: &AppState) -> Option<PathBuf> {
    let root = state.config.sandbox.gogcli_cli_install_root.as_ref()?;
    let path = root.join("current/bin/gog");
    path.is_file().then_some(path)
}

async fn run_gog(
    state: &AppState,
    user_id: &str,
    _gog: &FsPath,
    args: &[&str],
    stdin: Option<&str>,
    timeout_seconds: u64,
) -> Result<std::process::Output, ApiError> {
    let argv =
        state
            .sandboxes
            .nsjail_exec_argv(user_id, state.sandboxes.gogcli_sandbox_binary(), args)?;
    let mut command = Command::new(&argv[0]);
    command
        .args(&argv[1..])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if stdin.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command.spawn()?;
    if let Some(stdin_text) = stdin {
        use tokio::io::AsyncWriteExt;
        if let Some(mut child_stdin) = child.stdin.take() {
            child_stdin.write_all(stdin_text.as_bytes()).await?;
        }
    }
    tokio::time::timeout(
        std::time::Duration::from_secs(timeout_seconds),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| ApiError::new(StatusCode::GATEWAY_TIMEOUT, "gog command timed out"))?
    .map(filter_nsjail_stderr)
    .map_err(ApiError::from)
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

async fn ensure_gog_keyring_password(state: &AppState, user_id: &str) -> Result<String, ApiError> {
    let path = state.sandboxes.gogcli_keyring_pass_file(user_id)?;
    if let Ok(password) = tokio::fs::read_to_string(&path).await {
        let password = password.trim().to_string();
        if !password.is_empty() {
            return Ok(password);
        }
    }
    let password = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&path, &password).await?;
    set_mode_0600(&path).await?;
    Ok(password)
}

fn parse_gog_accounts(stdout: &str) -> Vec<Value> {
    let Ok(value) = serde_json::from_str::<Value>(stdout) else {
        return Vec::new();
    };
    let raw = if let Some(accounts) = value.get("accounts").and_then(Value::as_array) {
        accounts.clone()
    } else if let Some(accounts) = value.as_array() {
        accounts.clone()
    } else {
        Vec::new()
    };
    raw.into_iter()
        .filter_map(|entry| {
            let email = entry.get("email")?.as_str()?.trim();
            if email.is_empty() {
                return None;
            }
            let alias = entry.get("alias").and_then(Value::as_str);
            let valid = entry.get("valid").and_then(|value| {
                value.as_bool().or_else(|| {
                    match value.as_str()?.trim().to_ascii_lowercase().as_str() {
                        "true" => Some(true),
                        "false" => Some(false),
                        _ => None,
                    }
                })
            });
            Some(json!({"email": email, "alias": alias, "valid": valid}))
        })
        .collect()
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

fn has_nonempty_file(dir: &FsPath) -> bool {
    std::fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .any(|entry| {
            entry
                .metadata()
                .map(|metadata| metadata.is_file() && metadata.len() > 0)
                .unwrap_or(false)
        })
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

pub(crate) fn read_valid_bilibili_credential_file(path: &FsPath) -> Option<Value> {
    if !path.is_file() {
        return None;
    }
    let value = serde_json::from_slice::<Value>(&std::fs::read(path).ok()?).ok()?;
    let credential = value.as_object()?;
    let sessdata = credential.get("sessdata")?.as_str()?.trim();
    if sessdata.is_empty() {
        return None;
    }
    let expires_at = value_as_u64(credential.get("expires_at")).unwrap_or(0);
    if expires_at > 0 && expires_at <= now_epoch_seconds() {
        return None;
    }
    Some(value)
}

async fn write_bilibili_credential(
    state: &AppState,
    user_id: &str,
    credential: &Value,
) -> Result<(), ApiError> {
    let path = state.sandboxes.bilibili_config_file(user_id)?;
    write_secret_json(&path, credential).await
}

async fn bilibili_qrcode_generate(client: &reqwest::Client) -> anyhow::Result<BilibiliQrCode> {
    let response = bilibili_http_get_json(client, BILIBILI_QRCODE_GENERATE_URL, None).await?;
    if value_as_i64(response.get("code")).unwrap_or(-1) != 0 {
        anyhow::bail!("Bilibili QR generate returned non-zero code: {response}");
    }
    let data = response.get("data").and_then(Value::as_object);
    let qrcode_key = data
        .and_then(|data| data.get("qrcode_key"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let qrcode_content = data
        .and_then(|data| data.get("url"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if qrcode_key.is_empty() || qrcode_content.is_empty() {
        anyhow::bail!("Bilibili QR generate response is missing qrcode_key or url: {response}");
    }
    Ok(BilibiliQrCode {
        qrcode_key,
        qrcode_content,
    })
}

async fn bilibili_qrcode_poll(
    client: &reqwest::Client,
    qrcode_key: &str,
) -> anyhow::Result<BilibiliPollResult> {
    let mut url = Url::parse(BILIBILI_QRCODE_POLL_URL)?;
    url.query_pairs_mut()
        .append_pair("qrcode_key", qrcode_key.trim());
    let response = bilibili_http_get_json(client, url.as_str(), None).await?;
    let data = response.get("data").and_then(Value::as_object);
    let raw_code = data
        .and_then(|data| value_as_i64(data.get("code")))
        .unwrap_or(-1);
    let raw_message = data
        .and_then(|data| data.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let result = match raw_code {
        BILIBILI_QR_STATE_OK => {
            let cross_url = data
                .and_then(|data| data.get("url"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let fields = parse_bilibili_cookie_fields_from_crossdomain_url(cross_url);
            if fields
                .get("sessdata")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty())
            {
                BilibiliPollResult {
                    state: "ok",
                    raw_code,
                    raw_message,
                    credential_fields: Some(fields),
                }
            } else {
                BilibiliPollResult {
                    state: "unknown",
                    raw_code,
                    raw_message: "status code 0 but SESSDATA was not present in data.url"
                        .to_string(),
                    credential_fields: None,
                }
            }
        }
        BILIBILI_QR_STATE_NOT_SCANNED => BilibiliPollResult {
            state: "waiting_scan",
            raw_code,
            raw_message,
            credential_fields: None,
        },
        BILIBILI_QR_STATE_NOT_CONFIRMED => BilibiliPollResult {
            state: "scanned",
            raw_code,
            raw_message,
            credential_fields: None,
        },
        BILIBILI_QR_STATE_EXPIRED => BilibiliPollResult {
            state: "expired",
            raw_code,
            raw_message,
            credential_fields: None,
        },
        _ => BilibiliPollResult {
            state: "unknown",
            raw_code,
            raw_message,
            credential_fields: None,
        },
    };
    Ok(result)
}

async fn bilibili_verify_credential_live(
    client: &reqwest::Client,
    sessdata: &str,
) -> BilibiliLiveCredential {
    let response = match bilibili_http_get_json(client, BILIBILI_NAV_URL, Some(sessdata)).await {
        Ok(response) => response,
        Err(err) => {
            return BilibiliLiveCredential {
                is_login: false,
                uname: String::new(),
                mid: 0,
                raw_log: Some(format!("nav request failed: {err}")),
            }
        }
    };
    let data = response
        .get("data")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let is_login = data
        .get("isLogin")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let uname = data
        .get("uname")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let mid = value_as_u64(data.get("mid")).unwrap_or(0);
    let raw_log = (!is_login).then(|| {
        format!(
            "nav returned isLogin=false (code={})",
            value_as_i64(response.get("code")).unwrap_or(-1)
        )
    });
    BilibiliLiveCredential {
        is_login,
        uname,
        mid,
        raw_log,
    }
}

async fn bilibili_http_get_json(
    client: &reqwest::Client,
    url: &str,
    sessdata: Option<&str>,
) -> anyhow::Result<Value> {
    let mut request = client
        .get(url)
        .header(header::USER_AGENT, BILIBILI_DEFAULT_UA)
        .header(header::REFERER, BILIBILI_DEFAULT_REFERER)
        .header(header::ACCEPT, "application/json, text/plain, */*");
    if let Some(sessdata) = sessdata {
        request = request.header(header::COOKIE, format!("SESSDATA={sessdata}"));
    }
    let response = request.send().await?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        anyhow::bail!(
            "Bilibili request failed: HTTP {}: {}",
            status.as_u16(),
            tail(&detail, 500)
        );
    }
    Ok(response.json::<Value>().await?)
}

fn parse_bilibili_cookie_fields_from_crossdomain_url(raw_url: &str) -> Value {
    let Some(url) = parse_url_or_query(raw_url) else {
        return json!({});
    };
    let mut fields = Map::new();
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "SESSDATA" if !value.trim().is_empty() => {
                fields.insert("sessdata".to_string(), json!(value.to_string()));
            }
            "bili_jct" if !value.trim().is_empty() => {
                fields.insert("bili_jct".to_string(), json!(value.to_string()));
            }
            "DedeUserID" if !value.trim().is_empty() => {
                fields.insert("dede_user_id".to_string(), json!(value.to_string()));
            }
            "DedeUserID__ckMd5" if !value.trim().is_empty() => {
                fields.insert("dede_user_id_ck_md5".to_string(), json!(value.to_string()));
            }
            "Expires" => {
                if let Ok(expires_at) = value.trim().parse::<u64>() {
                    fields.insert("expires_at".to_string(), json!(expires_at));
                }
            }
            _ => {}
        }
    }
    Value::Object(fields)
}

fn parse_url_or_query(raw_url: &str) -> Option<Url> {
    let raw_url = raw_url.trim();
    if raw_url.is_empty() {
        return None;
    }
    Url::parse(raw_url).ok().or_else(|| {
        Url::parse(&format!(
            "https://ripple.invalid/?{}",
            raw_url.trim_start_matches('?')
        ))
        .ok()
    })
}

fn register_pending_bilibili_qr(user_id: &str) {
    let now = now_epoch_seconds();
    let pending = PendingBilibiliQr {
        expires_at: now + BILIBILI_PENDING_TTL_SECONDS,
    };
    let mut values = pending_bilibili_qr_map()
        .lock()
        .expect("pending Bilibili QR lock poisoned");
    cleanup_expired_bilibili_qr_locked(&mut values, now);
    values.insert(user_id.to_string(), pending);
}

fn release_pending_bilibili_qr(user_id: &str) -> Option<PendingBilibiliQr> {
    let now = now_epoch_seconds();
    let mut values = pending_bilibili_qr_map()
        .lock()
        .expect("pending Bilibili QR lock poisoned");
    cleanup_expired_bilibili_qr_locked(&mut values, now);
    values.remove(user_id)
}

fn pending_bilibili_qr_map() -> &'static Mutex<HashMap<String, PendingBilibiliQr>> {
    PENDING_BILIBILI_QR.get_or_init(|| Mutex::new(HashMap::new()))
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

fn resolve_gogcli_oauth_callback_url(
    state: &AppState,
    request_base_url: Option<&str>,
) -> Option<String> {
    if let Some(explicit) =
        clean_config_url(state.config.gogcli_oauth.callback_url.as_deref(), true)
    {
        return Some(explicit);
    }
    if let Some(base) = clean_config_url(state.config.public_base_url.as_deref(), true) {
        return Some(format!("{base}{GOGCLI_OAUTH_CALLBACK_PATH}"));
    }
    if !state.config.gogcli_oauth.auto_from_request {
        return None;
    }
    clean_config_url(request_base_url, false)
        .map(|base| format!("{base}{GOGCLI_OAUTH_CALLBACK_PATH}"))
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

fn configured_gogcli_client_secret_json(
    state: &AppState,
    callback_url: &str,
) -> Result<Option<String>, ApiError> {
    if !state.config.gogcli_oauth.auto_register_client {
        return Ok(None);
    }
    if let Some(raw_json) = state.config.gogcli_oauth.client_secret_json.as_deref() {
        let mut value: Value =
            serde_json::from_str(raw_json).map_err(|err| ApiError::bad_request(err.to_string()))?;
        if parse_gogcli_client_value(&value).is_none() {
            return Err(ApiError::bad_request(
                "server.gogcli_oauth.client_secret_json is missing web/installed client_id",
            ));
        }
        ensure_callback_redirect_uri(&mut value, callback_url);
        return Ok(Some(
            serde_json::to_string_pretty(&value).map_err(anyhow::Error::from)?,
        ));
    }
    let Some(client) = state.config.gogcli_oauth.client.as_ref() else {
        return Ok(None);
    };
    Ok(Some(build_gogcli_client_secret_json(client, callback_url)?))
}

fn build_gogcli_client_secret_json(
    client: &GogcliOAuthClient,
    callback_url: &str,
) -> Result<String, ApiError> {
    let bucket_name = match client.client_type.as_deref().map(str::to_ascii_lowercase) {
        Some(value) if value == "desktop" || value == "installed" => "installed",
        _ => "web",
    };
    let mut bucket = serde_json::Map::new();
    bucket.insert("client_id".to_string(), json!(client.client_id));
    bucket.insert("client_secret".to_string(), json!(client.client_secret));
    bucket.insert(
        "auth_uri".to_string(),
        json!(client.auth_uri.as_deref().unwrap_or(GOOGLE_OAUTH_AUTH_URL)),
    );
    bucket.insert(
        "token_uri".to_string(),
        json!(client
            .token_uri
            .as_deref()
            .unwrap_or(GOOGLE_OAUTH_TOKEN_URL)),
    );
    bucket.insert(
        "auth_provider_x509_cert_url".to_string(),
        json!(client
            .auth_provider_x509_cert_url
            .as_deref()
            .unwrap_or("https://www.googleapis.com/oauth2/v1/certs")),
    );
    if let Some(project_id) = client.project_id.as_deref() {
        bucket.insert("project_id".to_string(), json!(project_id));
    }
    let mut redirect_uris = client.redirect_uris.clone();
    if !redirect_uris.iter().any(|value| value == callback_url) {
        redirect_uris.push(callback_url.to_string());
    }
    if !redirect_uris.is_empty() {
        bucket.insert("redirect_uris".to_string(), json!(redirect_uris));
    }
    let mut root = serde_json::Map::new();
    root.insert(bucket_name.to_string(), Value::Object(bucket));
    serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|err| ApiError::bad_request(err.to_string()))
}

fn ensure_callback_redirect_uri(value: &mut Value, callback_url: &str) {
    let Some(bucket) = mutable_gogcli_client_bucket(value) else {
        return;
    };
    let redirect_uris = bucket
        .entry("redirect_uris".to_string())
        .or_insert_with(|| json!([]));
    if let Some(values) = redirect_uris.as_array_mut() {
        if !values
            .iter()
            .any(|value| value.as_str() == Some(callback_url))
        {
            values.push(json!(callback_url));
        }
    }
}

async fn register_gogcli_client_config(
    state: &AppState,
    user_id: &str,
    gog: &FsPath,
    client_secret_raw: &str,
) -> Result<GogcliClientConfig, ApiError> {
    let value: Value = serde_json::from_str(client_secret_raw)
        .map_err(|err| ApiError::bad_request(err.to_string()))?;
    let client = parse_gogcli_client_value(&value)
        .ok_or_else(|| ApiError::bad_request("gogcli OAuth client is invalid"))?;
    let client_file = state.sandboxes.gogcli_client_config_file(user_id)?;
    let previous = if client_file.is_file() {
        Some(tokio::fs::read_to_string(&client_file).await?)
    } else {
        None
    };
    write_secret_json(&client_file, &value).await?;
    ensure_gog_keyring_password(state, user_id).await?;
    state.sandboxes.write_nsjail_config(user_id)?;

    let pending = state
        .sandboxes
        .workspace_dir(user_id)?
        .join(".config/gogcli/.pending-client.json");
    if let Some(parent) = pending.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(
        &pending,
        serde_json::to_vec_pretty(&value).map_err(anyhow::Error::from)?,
    )
    .await?;
    set_mode_0600(&pending).await?;
    let output = run_gog(
        state,
        user_id,
        gog,
        &[
            "auth",
            "credentials",
            "/workspace/.config/gogcli/.pending-client.json",
        ],
        None,
        30,
    )
    .await?;
    let _ = tokio::fs::remove_file(&pending).await;
    if !output.status.success() {
        if let Some(previous) = previous {
            tokio::fs::write(&client_file, previous).await?;
            set_mode_0600(&client_file).await?;
        } else {
            let _ = tokio::fs::remove_file(&client_file).await;
        }
        return Err(ApiError::bad_request(format!(
            "gog auth credentials failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            command_tail(&output)
        )));
    }
    Ok(client)
}

fn read_gogcli_client_config(
    state: &AppState,
    user_id: &str,
) -> Result<Option<GogcliClientConfig>, ApiError> {
    let path = state.sandboxes.gogcli_client_config_file(user_id)?;
    if !path.is_file() {
        return Ok(None);
    }
    let value = serde_json::from_slice::<Value>(&std::fs::read(path)?)
        .map_err(|err| ApiError::bad_request(err.to_string()))?;
    Ok(parse_gogcli_client_value(&value))
}

fn parse_gogcli_client_value(value: &Value) -> Option<GogcliClientConfig> {
    let bucket = gogcli_client_bucket(value)?;
    let client_id = bucket.get("client_id")?.as_str()?.trim();
    let client_secret = bucket.get("client_secret")?.as_str()?.trim();
    if client_id.is_empty() || client_secret.is_empty() {
        return None;
    }
    Some(GogcliClientConfig {
        client_id: client_id.to_string(),
        client_secret: client_secret.to_string(),
    })
}

fn gogcli_client_bucket(value: &Value) -> Option<&serde_json::Map<String, Value>> {
    for key in ["installed", "web"] {
        if let Some(bucket) = value.get(key).and_then(Value::as_object) {
            if bucket.get("client_id").and_then(Value::as_str).is_some() {
                return Some(bucket);
            }
        }
    }
    value
        .as_object()
        .filter(|bucket| bucket.get("client_id").and_then(Value::as_str).is_some())
}

fn mutable_gogcli_client_bucket(value: &mut Value) -> Option<&mut serde_json::Map<String, Value>> {
    for key in ["installed", "web"] {
        let has_client_id = value
            .get(key)
            .and_then(Value::as_object)
            .and_then(|bucket| bucket.get("client_id"))
            .and_then(Value::as_str)
            .is_some();
        if has_client_id {
            return value.get_mut(key)?.as_object_mut();
        }
    }
    value
        .as_object_mut()
        .filter(|bucket| bucket.get("client_id").and_then(Value::as_str).is_some())
}

fn build_google_workspace_oauth_url(
    client_id: &str,
    redirect_uri: &str,
    oauth_state: &str,
) -> Result<String, ApiError> {
    let mut url =
        Url::parse(GOOGLE_OAUTH_AUTH_URL).map_err(|err| ApiError::bad_request(err.to_string()))?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", &GOOGLE_WORKSPACE_BASIC_SCOPES.join(" "))
        .append_pair("state", oauth_state)
        .append_pair("access_type", "offline")
        .append_pair("include_granted_scopes", "true")
        .append_pair("prompt", "consent select_account");
    Ok(url.to_string())
}

fn register_pending_gogcli_oauth(oauth_state: &str, user_id: &str, redirect_uri: &str) {
    let now = now_epoch_seconds();
    let pending = PendingGogcliOAuth {
        user_id: user_id.to_string(),
        redirect_uri: redirect_uri.to_string(),
        expires_at: now + GOGCLI_OAUTH_PENDING_TTL_SECONDS,
    };
    let mut values = pending_oauth_map()
        .lock()
        .expect("pending oauth lock poisoned");
    cleanup_expired_oauth_locked(&mut values, now);
    values.insert(oauth_state.to_string(), pending);
}

fn pop_pending_gogcli_oauth(oauth_state: &str) -> Option<PendingGogcliOAuth> {
    let now = now_epoch_seconds();
    let mut values = pending_oauth_map()
        .lock()
        .expect("pending oauth lock poisoned");
    cleanup_expired_oauth_locked(&mut values, now);
    values
        .remove(oauth_state)
        .filter(|pending| pending.expires_at >= now)
}

fn pending_oauth_map() -> &'static Mutex<HashMap<String, PendingGogcliOAuth>> {
    PENDING_GOGCLI_OAUTH.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cleanup_expired_oauth_locked(values: &mut HashMap<String, PendingGogcliOAuth>, now: u64) {
    values.retain(|_, pending| pending.expires_at >= now);
}

fn extract_oauth_state(callback_url: &str) -> Option<String> {
    let url = Url::parse(callback_url).ok()?;
    url.query_pairs()
        .find_map(|(key, value)| (key == "state").then(|| value.trim().to_string()))
        .filter(|value| !value.is_empty())
}

fn callback_query_value(callback_url: &str, name: &str) -> Option<String> {
    let url = Url::parse(callback_url).ok()?;
    url.query_pairs()
        .find_map(|(key, value)| (key == name).then(|| value.trim().to_string()))
        .filter(|value| !value.is_empty())
}

fn looks_like_google_callback_url(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https") && url.host_str().is_some() && url.query().is_some()
}

fn build_gogcli_callback_auth_url(redirect_uri: &str, query_string: &str) -> String {
    let query = query_string.trim_start_matches('?');
    if query.is_empty() {
        redirect_uri.to_string()
    } else if redirect_uri.contains('?') {
        format!("{redirect_uri}&{query}")
    } else {
        format!("{redirect_uri}?{query}")
    }
}

async fn complete_google_workspace_oauth_callback(
    state: &AppState,
    pending: PendingGogcliOAuth,
    callback_url: &str,
) -> Result<Json<Value>, ApiError> {
    let Some(gog) = gog_binary(state) else {
        return Ok(Json(action_response(
            "google_workspace",
            false,
            "missing_cli",
            "gogcli is not installed.",
            json!({}),
        )));
    };
    let Some(code) = callback_query_value(callback_url, "code") else {
        return Ok(Json(action_response(
            "google_workspace",
            false,
            "invalid_request",
            "callback_url must include code.",
            json!({}),
        )));
    };
    let Some(client_config) = read_gogcli_client_config(state, &pending.user_id)? else {
        return Ok(Json(action_response(
            "google_workspace",
            false,
            "server_config_invalid",
            "gogcli OAuth client is invalid.",
            json!({}),
        )));
    };
    let token = match exchange_google_oauth_code(
        &client_config.client_id,
        &client_config.client_secret,
        &code,
        &pending.redirect_uri,
    )
    .await
    {
        Ok(token) => token,
        Err(err) => {
            return Ok(Json(action_response(
                "google_workspace",
                false,
                "auth_failed",
                &err.to_string(),
                json!({}),
            )))
        }
    };
    let identity = match fetch_google_oauth_identity(&token.access_token).await {
        Ok(identity) => identity,
        Err(err) => {
            return Ok(Json(action_response(
                "google_workspace",
                false,
                "auth_failed",
                &err.to_string(),
                json!({}),
            )))
        }
    };
    let email = identity.email.trim().to_ascii_lowercase();
    if !looks_like_email(&email) {
        return Ok(Json(action_response(
            "google_workspace",
            false,
            "auth_failed",
            "Google userinfo returned invalid email.",
            json!({}),
        )));
    }
    ensure_gog_keyring_password(state, &pending.user_id).await?;
    state.sandboxes.write_nsjail_config(&pending.user_id)?;
    let import_payload = serde_json::to_string(&json!({
        "email": email,
        "subject": identity.subject,
        "services": GOGCLI_BASIC_SERVICES,
        "scopes": GOOGLE_WORKSPACE_BASIC_SCOPES,
        "refresh_token": token.refresh_token
    }))
    .map_err(anyhow::Error::from)?;
    let output = run_gog(
        state,
        &pending.user_id,
        &gog,
        &["auth", "tokens", "import", "-"],
        Some(&import_payload),
        60,
    )
    .await?;
    if !output.status.success() {
        return Ok(Json(action_response(
            "google_workspace",
            false,
            "auth_failed",
            &format!(
                "gog auth tokens import failed (exit {}): {}",
                output.status.code().unwrap_or(-1),
                command_tail(&output)
            ),
            json!({}),
        )));
    }
    Ok(Json(action_response(
        "google_workspace",
        true,
        "authorized",
        "Google Workspace account authorized for this user.",
        json!({"email": email, "subject": identity.subject}),
    )))
}

async fn exchange_google_oauth_code(
    client_id: &str,
    client_secret: &str,
    code: &str,
    redirect_uri: &str,
) -> anyhow::Result<GoogleOAuthToken> {
    let response = reqwest::Client::new()
        .post(GOOGLE_OAUTH_TOKEN_URL)
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("code", code),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri),
        ])
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        anyhow::bail!(
            "Google token exchange failed: HTTP {}: {}",
            status.as_u16(),
            tail(&detail, 500)
        );
    }
    let data = response.json::<Value>().await?;
    let access_token = data
        .get("access_token")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let refresh_token = data
        .get("refresh_token")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if access_token.is_empty() {
        anyhow::bail!("Google token exchange did not return an access token.");
    }
    if refresh_token.is_empty() {
        anyhow::bail!(
            "Google token exchange did not return a refresh token; try authorizing again."
        );
    }
    Ok(GoogleOAuthToken {
        access_token,
        refresh_token,
    })
}

async fn fetch_google_oauth_identity(access_token: &str) -> anyhow::Result<GoogleOAuthIdentity> {
    let response = reqwest::Client::new()
        .get(GOOGLE_USERINFO_URL)
        .bearer_auth(access_token)
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        anyhow::bail!(
            "Google userinfo request failed: HTTP {}: {}",
            status.as_u16(),
            tail(&detail, 500)
        );
    }
    let data = response.json::<Value>().await?;
    let email = data
        .get("email")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if email.is_empty() {
        anyhow::bail!("Google userinfo did not return an email address.");
    }
    let subject = data
        .get("sub")
        .or_else(|| data.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(GoogleOAuthIdentity { email, subject })
}

fn gogcli_oauth_html(status: StatusCode, title: &str, body: &str) -> Response {
    (
        status,
        Html(format!(
            r#"<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{}</title>
    <style>
      body {{
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        line-height: 1.6;
        max-width: 720px;
        margin: 12vh auto;
        padding: 0 24px;
        color: #111827;
      }}
      h1 {{ font-size: 24px; margin-bottom: 12px; }}
      p {{ color: #374151; }}
    </style>
  </head>
  <body>
    <h1>{}</h1>
    <p>{}</p>
  </body>
</html>"#,
            escape_html(title),
            escape_html(title),
            escape_html(body)
        )),
    )
        .into_response()
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
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
    if let Some(codex_home) = &state.config.codex.codex_home {
        command.env("CODEX_HOME", codex_home);
    }
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

    #[test]
    fn extracts_feishu_auth_start_payload_from_lark_output() {
        let parsed = first_json_object(
            "prefix {\"data\":{\"verification_uri\":\"https://accounts.feishu.cn/device\",\"deviceCode\":\"device-123\",\"expiresIn\":600}} suffix",
        )
        .unwrap();
        let payload = feishu_auth_start_payload(&parsed).unwrap();

        assert_eq!(
            payload.get("oauth_url").and_then(Value::as_str),
            Some("https://accounts.feishu.cn/device")
        );
        assert_eq!(
            payload.get("device_code").and_then(Value::as_str),
            Some("device-123")
        );
        assert_eq!(value_as_u64(payload.get("expires_in_seconds")), Some(600));
    }

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

    #[tokio::test]
    async fn extracting_setup_url_keeps_stdout_drained_after_url() {
        let mut child = Command::new("/bin/bash")
            .args([
                "-c",
                "printf 'https://open.feishu.cn/page/cli?user_code=abc\\n'; sleep 0.1; printf 'still alive\\n'",
            ])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();

        let url = extract_url_from_stdout(stdout, 5).await;
        assert_eq!(url, "https://open.feishu.cn/page/cli?user_code=abc");

        let status = tokio::time::timeout(Duration::from_secs(2), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(
            status.success(),
            "setup stdout reader closed early: {status}"
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
