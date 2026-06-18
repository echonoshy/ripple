use std::collections::HashMap;
use std::path::{Path as FsPath, PathBuf};
use std::process::Stdio;

use axum::extract::{OriginalUri, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::process::Command;
use url::Url;
use uuid::Uuid;

use super::{
    action_response, clean_config_url, command_tail, ensure_sandbox_exists, filter_nsjail_stderr,
    looks_like_email, now_epoch_seconds, remove_file_if_exists,
    restart_codex_runtime_for_credential_change, set_mode_0600, tail, value_as_bool,
    write_secret_json, AccountsQuery,
};
use crate::api::ApiError;
use crate::config::GogcliOAuthClient;
use crate::connector_runtime::PendingGogcliOAuth;
use crate::state::AppState;
use crate::user::user_id_from_headers;

const OAUTH_CALLBACK_PATH: &str = "/v1/sandboxes/gogcli/oauth/callback";
const OAUTH_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/auth";
const OAUTH_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v2/userinfo";
const WORKSPACE_BASIC_SCOPES: &[&str] = &[
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
const BASIC_SERVICES: &[&str] = &["gmail", "drive", "calendar", "docs", "sheets", "slides"];
const BASIC_SERVICES_ARG: &str = "gmail,drive,calendar,docs,sheets,slides";
const OAUTH_PENDING_TTL_SECONDS: u64 = 600;

#[derive(Clone, Debug)]
struct ClientConfig {
    client_id: String,
    client_secret: String,
}

#[derive(Clone, Debug)]
struct OAuthToken {
    access_token: String,
    refresh_token: String,
}

#[derive(Clone, Debug)]
struct OAuthIdentity {
    email: String,
    subject: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GogcliCallbackQuery {
    state: Option<String>,
    code: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

pub(super) async fn auth_start(
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

    let Some(callback_url) = resolve_oauth_callback_url(state, request_base_url) else {
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
        let Some(client_json) = configured_client_secret_json(state, &callback_url)? else {
            let callback_hint = format!(
                "{}{}",
                state
                    .config
                    .public_base_url
                    .as_deref()
                    .unwrap_or("<server.public_base_url>"),
                OAUTH_CALLBACK_PATH
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
        if let Err(err) = register_client_config(state, user_id, &gog, &client_json).await {
            return Ok(Json(action_response(
                "google_workspace",
                false,
                "server_config_failed",
                &format!("{err:?}"),
                json!({}),
            )));
        }
    }

    let Some(client_config) = read_client_config(state, user_id)? else {
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
        build_workspace_oauth_url(&client_config.client_id, &callback_url, &oauth_state)?;
    register_pending_oauth(state, &oauth_state, user_id, &callback_url);
    Ok(Json(action_response(
        "google_workspace",
        true,
        "awaiting_browser_callback",
        "Open oauth_url to continue.",
        json!({
            "oauth_url": oauth_url,
            "expires_in_seconds": OAUTH_PENDING_TTL_SECONDS,
            "callback_mode": "assisted",
            "assisted_callback_url": callback_url
        }),
    )))
}

pub(super) async fn auth_complete(
    state: &AppState,
    user_id: &str,
    payload: &Value,
) -> Result<Json<Value>, ApiError> {
    let callback_url = payload
        .get("callback_url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if !looks_like_callback_url(callback_url) {
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
        if let Some(pending) = pop_pending_oauth(state, &oauth_state) {
            if pending.user_id != user_id {
                return Ok(Json(action_response(
                    "google_workspace",
                    false,
                    "invalid_request",
                    "OAuth state belongs to a different Ripple user.",
                    json!({}),
                )));
            }
            return complete_oauth_callback(state, pending, callback_url).await;
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
    ensure_keyring_password(state, user_id).await?;
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
            BASIC_SERVICES_ARG,
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
    restart_codex_runtime_for_credential_change(state, user_id).await?;
    Ok(Json(action_response(
        "google_workspace",
        true,
        "authorized",
        "Google Workspace account authorized for this user.",
        json!({"email": email}),
    )))
}

pub(super) async fn accounts(
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
    let accounts = list_accounts(state, user_id, &gog, check, if check { 30 } else { 10 }).await?;
    let account_count = accounts.len();
    Ok(Json(json!({
        "has_client_config": has_client_config,
        "accounts": accounts,
        "count": account_count,
        "checked": check
    })))
}

pub(super) async fn list_accounts(
    state: &AppState,
    user_id: &str,
    gog: &FsPath,
    check: bool,
    timeout_seconds: u64,
) -> Result<Vec<Value>, ApiError> {
    let mut args = vec!["auth", "list", "--json"];
    if check {
        args.push("--check");
    }
    let output = run_gog(state, user_id, gog, &args, None, timeout_seconds).await?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_accounts(&stdout))
}

pub(super) async fn disconnect(
    state: &AppState,
    user_id: &str,
    payload: &Value,
) -> Result<Json<Value>, ApiError> {
    if value_as_bool(payload.get("all")).unwrap_or(false) {
        return disconnect_all(state, user_id).await;
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
    ensure_keyring_password(state, user_id).await?;
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
    restart_codex_runtime_for_credential_change(state, user_id).await?;
    let accounts = accounts(state, user_id, false).await?.0;
    Ok(Json(action_response(
        "google_workspace",
        true,
        "disconnected",
        "Google Workspace account removed from this user's keyring.",
        json!({"email": email, "accounts": accounts}),
    )))
}

async fn disconnect_all(state: &AppState, user_id: &str) -> Result<Json<Value>, ApiError> {
    clear_pending_oauth_for_user(state, user_id);
    let workspace = state.sandboxes.workspace_dir(user_id)?;
    let keyring = workspace.join(".config/gogcli/keyring");
    let keyring_removed = if keyring.exists() {
        tokio::fs::remove_dir_all(&keyring).await?;
        true
    } else {
        false
    };
    let pass_file = state.sandboxes.gogcli_keyring_pass_file(user_id)?;
    let password_removed = remove_file_if_exists(&pass_file).await?;
    state.sandboxes.write_nsjail_config(user_id)?;
    if keyring_removed || password_removed {
        restart_codex_runtime_for_credential_change(state, user_id).await?;
    }
    Ok(Json(action_response(
        "google_workspace",
        true,
        "disconnected",
        "All local Google Workspace account tokens were removed for this user.",
        json!({
            "all": true,
            "keyring_removed": keyring_removed,
            "password_removed": password_removed
        }),
    )))
}

pub(crate) async fn gogcli_accounts_alias(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AccountsQuery>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    ensure_sandbox_exists(&state, &user_id)?;
    accounts(&state, &user_id, query.check.unwrap_or(false)).await
}

pub(crate) async fn gogcli_oauth_callback(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Query(query): Query<GogcliCallbackQuery>,
) -> Response {
    let oauth_state = query.state.as_deref().unwrap_or("").trim().to_string();
    if oauth_state.is_empty() {
        return oauth_html(
            StatusCode::BAD_REQUEST,
            "Google 授权失败",
            "OAuth 回调缺少 state 参数。",
        );
    }

    let Some(pending) = pop_pending_oauth(&state, &oauth_state) else {
        return oauth_html(
            StatusCode::BAD_REQUEST,
            "Google 授权已过期",
            "找不到匹配的 OAuth 登录请求，可能已经超过 10 分钟或服务已重启。请回到 Ripple 重新发起授权。",
        );
    };

    if let Some(provider_error) = query.error.as_deref() {
        let detail = query.error_description.as_deref().unwrap_or(provider_error);
        return oauth_html(
            StatusCode::BAD_REQUEST,
            "Google 授权被拒绝",
            &format!("Google 返回错误：{detail}。请回到 Ripple 重新发起授权。"),
        );
    }

    if query.code.as_deref().unwrap_or("").trim().is_empty() {
        return oauth_html(
            StatusCode::BAD_REQUEST,
            "Google 授权失败",
            "OAuth 回调缺少 code 参数。",
        );
    }

    let callback_url =
        build_callback_auth_url(&pending.redirect_uri, uri.query().unwrap_or_default());
    match complete_oauth_callback(&state, pending.clone(), &callback_url).await {
        Ok(Json(value)) => {
            if value.get("ok").and_then(Value::as_bool) == Some(true) {
                oauth_html(
                    StatusCode::OK,
                    "Google 授权完成",
                    "Ripple 已保存 Google Workspace 授权。可以关闭这个页面，回到对话继续。",
                )
            } else {
                let detail = value
                    .get("detail")
                    .and_then(Value::as_str)
                    .unwrap_or("授权未完成。");
                oauth_html(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Google 授权未完成",
                    &format!("{detail} 请回到 Ripple 重新发起授权。"),
                )
            }
        }
        Err(err) => oauth_html(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Google 授权未完成",
            &format!("{err:?} 请回到 Ripple 重新发起授权。"),
        ),
    }
}

pub(super) fn gog_binary(state: &AppState) -> Option<PathBuf> {
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

async fn ensure_keyring_password(state: &AppState, user_id: &str) -> Result<String, ApiError> {
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

fn parse_accounts(stdout: &str) -> Vec<Value> {
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

fn resolve_oauth_callback_url(state: &AppState, request_base_url: Option<&str>) -> Option<String> {
    if let Some(explicit) =
        clean_config_url(state.config.gogcli_oauth.callback_url.as_deref(), true)
    {
        return Some(explicit);
    }
    if let Some(base) = clean_config_url(state.config.public_base_url.as_deref(), true) {
        return Some(format!("{base}{OAUTH_CALLBACK_PATH}"));
    }
    if !state.config.gogcli_oauth.auto_from_request {
        return None;
    }
    clean_config_url(request_base_url, false).map(|base| format!("{base}{OAUTH_CALLBACK_PATH}"))
}

fn configured_client_secret_json(
    state: &AppState,
    callback_url: &str,
) -> Result<Option<String>, ApiError> {
    if !state.config.gogcli_oauth.auto_register_client {
        return Ok(None);
    }
    if let Some(raw_json) = state.config.gogcli_oauth.client_secret_json.as_deref() {
        let mut value: Value =
            serde_json::from_str(raw_json).map_err(|err| ApiError::bad_request(err.to_string()))?;
        if parse_client_value(&value).is_none() {
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
    Ok(Some(build_client_secret_json(client, callback_url)?))
}

fn build_client_secret_json(
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
        json!(client.auth_uri.as_deref().unwrap_or(OAUTH_AUTH_URL)),
    );
    bucket.insert(
        "token_uri".to_string(),
        json!(client.token_uri.as_deref().unwrap_or(OAUTH_TOKEN_URL)),
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
    let Some(bucket) = mutable_client_bucket(value) else {
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

async fn register_client_config(
    state: &AppState,
    user_id: &str,
    gog: &FsPath,
    client_secret_raw: &str,
) -> Result<ClientConfig, ApiError> {
    let value: Value = serde_json::from_str(client_secret_raw)
        .map_err(|err| ApiError::bad_request(err.to_string()))?;
    let client = parse_client_value(&value)
        .ok_or_else(|| ApiError::bad_request("gogcli OAuth client is invalid"))?;
    let client_file = state.sandboxes.gogcli_client_config_file(user_id)?;
    let previous = if client_file.is_file() {
        Some(tokio::fs::read_to_string(&client_file).await?)
    } else {
        None
    };
    write_secret_json(&client_file, &value).await?;
    ensure_keyring_password(state, user_id).await?;
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

fn read_client_config(state: &AppState, user_id: &str) -> Result<Option<ClientConfig>, ApiError> {
    let path = state.sandboxes.gogcli_client_config_file(user_id)?;
    if !path.is_file() {
        return Ok(None);
    }
    let value = serde_json::from_slice::<Value>(&std::fs::read(path)?)
        .map_err(|err| ApiError::bad_request(err.to_string()))?;
    Ok(parse_client_value(&value))
}

fn parse_client_value(value: &Value) -> Option<ClientConfig> {
    let bucket = client_bucket(value)?;
    let client_id = bucket.get("client_id")?.as_str()?.trim();
    let client_secret = bucket.get("client_secret")?.as_str()?.trim();
    if client_id.is_empty() || client_secret.is_empty() {
        return None;
    }
    Some(ClientConfig {
        client_id: client_id.to_string(),
        client_secret: client_secret.to_string(),
    })
}

fn client_bucket(value: &Value) -> Option<&serde_json::Map<String, Value>> {
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

fn mutable_client_bucket(value: &mut Value) -> Option<&mut serde_json::Map<String, Value>> {
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

fn build_workspace_oauth_url(
    client_id: &str,
    redirect_uri: &str,
    oauth_state: &str,
) -> Result<String, ApiError> {
    let mut url =
        Url::parse(OAUTH_AUTH_URL).map_err(|err| ApiError::bad_request(err.to_string()))?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", &WORKSPACE_BASIC_SCOPES.join(" "))
        .append_pair("state", oauth_state)
        .append_pair("access_type", "offline")
        .append_pair("include_granted_scopes", "true")
        .append_pair("prompt", "consent select_account");
    Ok(url.to_string())
}

fn register_pending_oauth(state: &AppState, oauth_state: &str, user_id: &str, redirect_uri: &str) {
    let now = now_epoch_seconds();
    let pending = PendingGogcliOAuth {
        user_id: user_id.to_string(),
        redirect_uri: redirect_uri.to_string(),
        expires_at: now + OAUTH_PENDING_TTL_SECONDS,
    };
    let mut values = state
        .connector_runtime
        .gogcli_oauth
        .lock()
        .expect("pending oauth lock poisoned");
    cleanup_expired_oauth_locked(&mut values, now);
    values.insert(oauth_state.to_string(), pending);
}

fn pop_pending_oauth(state: &AppState, oauth_state: &str) -> Option<PendingGogcliOAuth> {
    let now = now_epoch_seconds();
    let mut values = state
        .connector_runtime
        .gogcli_oauth
        .lock()
        .expect("pending oauth lock poisoned");
    cleanup_expired_oauth_locked(&mut values, now);
    values
        .remove(oauth_state)
        .filter(|pending| pending.expires_at >= now)
}

pub(super) fn clear_pending_oauth_for_user(state: &AppState, user_id: &str) -> usize {
    let now = now_epoch_seconds();
    let mut values = state
        .connector_runtime
        .gogcli_oauth
        .lock()
        .expect("pending oauth lock poisoned");
    cleanup_expired_oauth_locked(&mut values, now);
    let before = values.len();
    values.retain(|_, pending| pending.user_id != user_id);
    before.saturating_sub(values.len())
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

fn looks_like_callback_url(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https") && url.host_str().is_some() && url.query().is_some()
}

fn build_callback_auth_url(redirect_uri: &str, query_string: &str) -> String {
    let query = query_string.trim_start_matches('?');
    if query.is_empty() {
        redirect_uri.to_string()
    } else if redirect_uri.contains('?') {
        format!("{redirect_uri}&{query}")
    } else {
        format!("{redirect_uri}?{query}")
    }
}

async fn complete_oauth_callback(
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
    let Some(client_config) = read_client_config(state, &pending.user_id)? else {
        return Ok(Json(action_response(
            "google_workspace",
            false,
            "server_config_invalid",
            "gogcli OAuth client is invalid.",
            json!({}),
        )));
    };
    let token = match exchange_oauth_code(
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
    let identity = match fetch_oauth_identity(&token.access_token).await {
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
    ensure_keyring_password(state, &pending.user_id).await?;
    state.sandboxes.write_nsjail_config(&pending.user_id)?;
    let import_payload = serde_json::to_string(&json!({
        "email": email,
        "subject": identity.subject,
        "services": BASIC_SERVICES,
        "scopes": WORKSPACE_BASIC_SCOPES,
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
    restart_codex_runtime_for_credential_change(state, &pending.user_id).await?;
    Ok(Json(action_response(
        "google_workspace",
        true,
        "authorized",
        "Google Workspace account authorized for this user.",
        json!({"email": email, "subject": identity.subject}),
    )))
}

async fn exchange_oauth_code(
    client_id: &str,
    client_secret: &str,
    code: &str,
    redirect_uri: &str,
) -> anyhow::Result<OAuthToken> {
    let response = reqwest::Client::new()
        .post(OAUTH_TOKEN_URL)
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
    Ok(OAuthToken {
        access_token,
        refresh_token,
    })
}

async fn fetch_oauth_identity(access_token: &str) -> anyhow::Result<OAuthIdentity> {
    let response = reqwest::Client::new()
        .get(USERINFO_URL)
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
    Ok(OAuthIdentity { email, subject })
}

fn oauth_html(status: StatusCode, title: &str, body: &str) -> Response {
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
