use std::collections::HashMap;
use std::path::{Path as FsPath, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{OriginalUri, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::process::Command;
use url::Url;
use uuid::Uuid;

use crate::api::ApiError;
use crate::config::GogcliOAuthClient;
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

static PENDING_GOGCLI_OAUTH: OnceLock<Mutex<HashMap<String, PendingGogcliOAuth>>> = OnceLock::new();

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
    let workspace = state.sandboxes.workspace_dir(&user_id)?;
    let credentials = state.sandboxes.credentials_dir(&user_id)?;
    let status = match connector_name.as_str() {
        "notion" => {
            let connected =
                read_json_string_field(&credentials.join("notion.json"), "api_token").is_some();
            json!({"name": connector_name, "connected": connected, "required": !connected, "detail": if connected {"Notion token is stored for this user."} else {"Notion token is missing for this user."}, "metadata": {}})
        }
        "google_workspace" => {
            let connected = has_nonempty_file(&workspace.join(".config/gogcli/keyring"));
            json!({"name": connector_name, "connected": connected, "required": !connected, "detail": if connected {"Google Workspace account is connected for this user."} else {"Google Workspace is not connected for this user."}, "metadata": {"has_client_config": credentials.join("gogcli-client.json").is_file()}})
        }
        "feishu" => {
            let connected = workspace.join(".lark-cli/config.json").is_file();
            json!({"name": connector_name, "connected": connected, "required": !connected, "detail": if connected {"Feishu CLI configuration exists for this user."} else {"Feishu CLI app configuration is missing for this user."}, "metadata": {}})
        }
        "bilibili" => {
            let connected = credentials.join("bilibili.json").is_file();
            json!({"name": connector_name, "connected": connected, "required": !connected, "detail": if connected {"Bilibili credentials are stored for this user."} else {"Bilibili credentials are missing for this user."}, "metadata": {}})
        }
        "openai_codex" => codex_status(&state).await,
        "codex_image_generation" | "codex_image_input" | "codex_web_search" => {
            json!({"name": connector_name, "connected": true, "required": false, "detail": "Provided by the server-side Codex runtime.", "metadata": {"auth_source": "codex_runtime"}})
        }
        _ => {
            return Err(ApiError::not_found(format!(
                "Connector {connector_name:?} not found"
            )))
        }
    };
    Ok(Json(status))
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
    match connector_name.as_str() {
        "notion" => notion_auth_start(&state, &user_id, &payload).await,
        "google_workspace" => google_auth_start(
            &state,
            &user_id,
            request_base_url_from_headers(&headers).as_deref(),
        )
        .await,
        "feishu" | "bilibili" => Err(ApiError::new(
            StatusCode::METHOD_NOT_ALLOWED,
            format!("Connector {connector_name:?} auth_start is only available through chat in the current Rust backend slice"),
        )),
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
    match connector_name.as_str() {
        "google_workspace" => google_auth_complete(&state, &user_id, &payload).await,
        "feishu" | "bilibili" => Err(ApiError::new(
            StatusCode::METHOD_NOT_ALLOWED,
            format!("Connector {connector_name:?} auth_complete is only available through chat in the current Rust backend slice"),
        )),
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

async fn feishu_disconnect(state: &AppState, user_id: &str) -> Result<Json<Value>, ApiError> {
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
        json!({"credential_removed": removed}),
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
    gog: &FsPath,
    args: &[&str],
    stdin: Option<&str>,
    timeout_seconds: u64,
) -> Result<std::process::Output, ApiError> {
    let workspace = state.sandboxes.workspace_dir(user_id)?;
    let credentials = state.sandboxes.credentials_dir(user_id)?;
    let mut command = Command::new(gog);
    command
        .args(args)
        .current_dir(&workspace)
        .env("HOME", &workspace)
        .env("USER", "sandbox")
        .env("XDG_CONFIG_HOME", workspace.join(".config"))
        .env("GOG_KEYRING_BACKEND", "file")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Ok(password) = tokio::fs::read_to_string(credentials.join("gogcli-keyring.pass")).await {
        let password = password.trim();
        if !password.is_empty() {
            command.env("GOG_KEYRING_PASSWORD", password);
        }
    }
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
    .map_err(ApiError::from)
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
    let pending_arg = pending.to_string_lossy().to_string();
    let output = run_gog(
        state,
        user_id,
        gog,
        &["auth", "credentials", pending_arg.as_str()],
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
