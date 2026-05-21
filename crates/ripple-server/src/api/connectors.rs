use std::path::{Path as FsPath, PathBuf};
use std::process::Stdio;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::process::Command;
use uuid::Uuid;

use crate::api::ApiError;
use crate::state::AppState;
use crate::user::user_id_from_headers;

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
        "google_workspace" | "feishu" | "bilibili" => Err(ApiError::new(
            StatusCode::METHOD_NOT_ALLOWED,
            format!("Connector {connector_name:?} auth_start is only available through chat in the current Rust backend slice"),
        )),
        _ => Err(ApiError::not_found(format!(
            "Connector {connector_name:?} not found"
        ))),
    }
}

pub async fn connector_auth_complete(
    Path(connector_name): Path<String>,
) -> Result<Json<Value>, ApiError> {
    match connector_name.as_str() {
        "google_workspace" | "feishu" | "bilibili" => Err(ApiError::new(
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
