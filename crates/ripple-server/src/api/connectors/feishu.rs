use std::collections::BTreeSet;
use std::path::{Path as FsPath, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::{
    action_response, command_tail, filter_nsjail_stderr, looks_like_url, remove_file_if_exists,
    value_as_bool, value_as_u64,
};
use crate::api::ApiError;
use crate::config::{AppConfig, FeishuAppConfig};
use crate::connector_runtime::PendingFeishuSetup;
use crate::redaction::redact_text;
use crate::sandbox::SandboxManager;
use crate::state::AppState;

// The setup URL has no TTL supplied by lark-cli. This is a caller-facing
// refresh recommendation only; the server does not invalidate setup after it.
const SETUP_URL_DISPLAY_TTL_SECONDS: u64 = 300;

#[derive(Debug, Clone, PartialEq, Eq)]
enum DeviceAuthorizationCompletion {
    Completed,
    Pending { detail: String },
    Expired { detail: String },
    Failed { detail: String },
}

pub(super) async fn status(state: &AppState, user_id: &str) -> Value {
    let (connected, detail, mut metadata) = cli_login_status(state, user_id).await;
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

/// Return every application-enabled user scope, grouped by namespace and
/// marked according to the current user's access token.
pub(super) async fn permissions(state: &AppState, user_id: &str) -> Result<Value, ApiError> {
    let Some(lark) = lark_binary(state) else {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "Feishu permission probe is unavailable because lark-cli is not installed.",
        ));
    };

    let (connected, detail, metadata) = cli_login_status(state, user_id).await;
    if metadata.get("has_app_config").and_then(Value::as_bool) != Some(true) {
        return Ok(json!({
            "capabilities": {},
            "probe_status": "not_configured",
            "detail": detail
        }));
    }
    if metadata.get("auth_status_error").and_then(Value::as_bool) == Some(true) {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "Feishu permission probe could not verify the current user authorization.",
        ));
    }
    if metadata
        .get("auth_status_inconclusive")
        .and_then(Value::as_bool)
        == Some(true)
    {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "Feishu permission probe returned an inconclusive authorization status.",
        ));
    }

    let output = match run_lark(state, user_id, &lark, &["auth", "scopes"], None, 15).await {
        Ok(output) => output,
        Err(_) => {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "Feishu permission probe could not list application scopes.",
            ));
        }
    };
    if !output.status.success() {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "Feishu permission probe could not list application scopes.",
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout).to_string()
        + "\n"
        + &String::from_utf8_lossy(&output.stderr);
    let status = first_json_object(&text).ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_GATEWAY,
            "Feishu permission probe returned invalid application scope data.",
        )
    })?;
    let enabled_scopes = enabled_user_scopes(&status);
    let granted_scopes = if connected {
        user_scopes_for_permission_probe(state, user_id, &lark).await?
    } else {
        BTreeSet::new()
    };
    Ok(json!({
        "capabilities": scope_capabilities(&enabled_scopes, &granted_scopes),
        "probe_status": if connected {"ready"} else {"not_authorized"},
        "detail": detail
    }))
}

async fn user_scopes_for_permission_probe(
    state: &AppState,
    user_id: &str,
    lark: &FsPath,
) -> Result<BTreeSet<String>, ApiError> {
    let output = run_lark(state, user_id, lark, &["auth", "status"], None, 10)
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "Feishu permission probe could not read current user scopes.",
            )
        })?;
    if !output.status.success() {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "Feishu permission probe could not read current user scopes.",
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout).to_string()
        + "\n"
        + &String::from_utf8_lossy(&output.stderr);
    let status = first_json_object(&text).ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_GATEWAY,
            "Feishu permission probe returned invalid current user scope data.",
        )
    })?;
    Ok(user_granted_scopes(&status))
}

async fn user_scopes_from_status(
    state: &AppState,
    user_id: &str,
    lark: &FsPath,
) -> BTreeSet<String> {
    let args = lark_user_status_args();
    let Ok(output) = run_lark(state, user_id, lark, &args, None, 10).await else {
        return BTreeSet::new();
    };
    if !output.status.success() {
        return BTreeSet::new();
    }
    let text = String::from_utf8_lossy(&output.stdout).to_string()
        + "\n"
        + &String::from_utf8_lossy(&output.stderr);
    first_json_object(&text)
        .map(|status| user_granted_scopes(&status))
        .unwrap_or_default()
}

fn lark_user_status_args() -> [&'static str; 3] {
    ["auth", "status", "--verify"]
}

fn user_granted_scopes(status: &Value) -> BTreeSet<String> {
    let scope = status
        .pointer("/identities/user/scope")
        .and_then(Value::as_str)
        .or_else(|| status.get("scope").and_then(Value::as_str))
        .unwrap_or("");
    scope
        .split_ascii_whitespace()
        .map(str::trim)
        .filter(|scope| !scope.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn enabled_user_scopes(status: &Value) -> BTreeSet<String> {
    status
        .get("userScopes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|scope| !scope.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn scope_capabilities(
    enabled_scopes: &BTreeSet<String>,
    granted_scopes: &BTreeSet<String>,
) -> Value {
    let mut namespaces = Map::new();
    for scope in enabled_scopes {
        let namespace = scope
            .split_once(':')
            .map(|(prefix, _)| prefix)
            .unwrap_or(scope);
        let entry = namespaces
            .entry(namespace.to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(scopes) = entry.as_object_mut() {
            scopes.insert(scope.clone(), json!(granted_scopes.contains(scope)));
        }
    }
    Value::Object(namespaces)
}

/// Execute a lark-cli business command for exactly one Ripple user. The
/// caller supplies argv only; credentials, config paths, and the nsjail
/// environment remain server-owned.
pub(crate) async fn invoke_for_agent(
    config: &AppConfig,
    sandboxes: &SandboxManager,
    user_id: &str,
    args: &[String],
) -> Result<Value, ApiError> {
    if !config.connector_enabled("feishu") {
        return Ok(json!({
            "ok": false,
            "code": "connector_disabled",
            "connector": "feishu",
            "message": "Feishu connector is disabled on this server."
        }));
    }
    if args.is_empty()
        || args.len() > 64
        || args
            .iter()
            .any(|arg| arg.is_empty() || arg.len() > 4096 || arg.contains('\0'))
    {
        return Ok(json!({
            "ok": false,
            "code": "invalid_arguments",
            "message": "feishu_cli requires 1-64 non-empty arguments."
        }));
    }
    if matches!(args[0].as_str(), "auth" | "config" | "doctor" | "whoami") {
        return Ok(json!({
            "ok": false,
            "code": "connector_control_plane_only",
            "connector": "feishu",
            "message": "Feishu authentication and configuration are managed by Ripple, not by agent commands."
        }));
    }

    sandboxes.prepare_lark_cli_credentials(user_id)?;
    let config_file = sandboxes.lark_cli_config_dir(user_id)?.join("config.json");
    if !config_file.is_file() {
        return Ok(json!({
            "ok": false,
            "code": "connector_auth_required",
            "connector": "feishu",
            "message": "Feishu app configuration is not ready for this user."
        }));
    }
    let auth_status =
        run_lark_with_sandbox(sandboxes, user_id, &["auth", "status"], None, 15).await?;
    if !auth_status.status.success() {
        return Ok(json!({
            "ok": false,
            "code": "connector_auth_required",
            "connector": "feishu",
            "message": "Feishu user authorization is not ready for this user."
        }));
    }
    let argv = args.iter().map(String::as_str).collect::<Vec<_>>();
    let output = run_lark_with_sandbox(sandboxes, user_id, &argv, None, 60).await?;
    let stdout = redact_text(&strip_lark_update_notice(&String::from_utf8_lossy(
        &output.stdout,
    )));
    let stderr = redact_text(&String::from_utf8_lossy(&output.stderr));
    Ok(json!({
        "ok": output.status.success(),
        "connector": "feishu",
        "exit_code": output.status.code(),
        "stdout": stdout,
        "stderr": stderr
    }))
}

/// Extract explicit user scopes from trusted lark-cli permission errors. The
/// CLI may return a structured `permission_violations` payload, a structured
/// `missing_scope` error, or the known plaintext
/// `insufficient permissions (required scope: ...)` error.
/// Model output never influences the scopes requested by the control plane.
pub(crate) fn missing_user_scopes_from_cli_result(result: &Value) -> BTreeSet<String> {
    let mut scopes = BTreeSet::new();
    let failed = result.get("ok").and_then(Value::as_bool) == Some(false);
    for key in ["stdout", "stderr"] {
        let Some(text) = result.get(key).and_then(Value::as_str) else {
            continue;
        };
        if let Some(value) = first_json_object(text) {
            collect_permission_violation_scopes(&value, &mut scopes);
            if failed {
                collect_missing_scope_error_scopes(&value, &mut scopes);
            }
        }
        if failed {
            collect_lark_plaintext_required_scopes(text, &mut scopes);
        }
    }
    scopes
}

fn collect_lark_plaintext_required_scopes(text: &str, scopes: &mut BTreeSet<String>) {
    const PREFIX: &str = "insufficient permissions (required scope:";

    for (index, _) in text.match_indices(PREFIX) {
        let scope = &text[index + PREFIX.len()..];
        let Some(end) = scope.find(')') else {
            continue;
        };
        add_valid_scope(&scope[..end], scopes);
    }
}

fn collect_missing_scope_error_scopes(value: &Value, scopes: &mut BTreeSet<String>) {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_missing_scope_error_scopes(value, scopes);
            }
        }
        Value::Object(object) => {
            if object.get("type").and_then(Value::as_str) == Some("missing_scope") {
                if let Some(message) = object.get("message").and_then(Value::as_str) {
                    collect_missing_scope_message_scopes(message, scopes);
                }
            }
            for value in object.values() {
                if value.is_object() || value.is_array() {
                    collect_missing_scope_error_scopes(value, scopes);
                }
            }
        }
        _ => {}
    }
}

fn collect_missing_scope_message_scopes(message: &str, scopes: &mut BTreeSet<String>) {
    const PREFIX: &str = "missing required scope(s):";

    let Some(required_scopes) = message.trim().strip_prefix(PREFIX) else {
        return;
    };
    for scope in required_scopes.split(',') {
        add_valid_scope(scope, scopes);
    }
}

fn collect_permission_violation_scopes(value: &Value, scopes: &mut BTreeSet<String>) {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_permission_violation_scopes(value, scopes);
            }
        }
        Value::Object(object) => {
            for (key, value) in object {
                if key == "permission_violations" {
                    collect_scopes_from_permission_violation(value, scopes);
                }
                collect_permission_violation_scopes(value, scopes);
            }
        }
        _ => {}
    }
}

fn collect_scopes_from_permission_violation(value: &Value, scopes: &mut BTreeSet<String>) {
    match value {
        Value::String(scope) => add_valid_scope(scope, scopes),
        Value::Array(values) => {
            for value in values {
                collect_scopes_from_permission_violation(value, scopes);
            }
        }
        Value::Object(object) => {
            for key in ["scope", "scopes", "missing_scopes", "required_scopes"] {
                if let Some(value) = object.get(key) {
                    collect_scopes_from_permission_violation(value, scopes);
                }
            }
            for value in object.values() {
                if value.is_object() || value.is_array() {
                    collect_scopes_from_permission_violation(value, scopes);
                }
            }
        }
        _ => {}
    }
}

fn add_valid_scope(value: &str, scopes: &mut BTreeSet<String>) {
    let scope = value.trim();
    if !scope.is_empty()
        && scope.len() <= 256
        && scope.contains(':')
        && scope
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-' | b'.'))
    {
        scopes.insert(scope.to_string());
    }
}

/// CLI update notices are service-maintenance metadata, not part of a user's
/// requested Feishu operation. Keep them out of the agent-visible tool result
/// so they cannot leak into the user-facing answer.
fn strip_lark_update_notice(stdout: &str) -> String {
    let Ok(mut output) = serde_json::from_str::<Value>(stdout) else {
        return stdout.to_string();
    };
    let Some(root) = output.as_object_mut() else {
        return stdout.to_string();
    };
    let Some(notices) = root.get_mut("_notice").and_then(Value::as_object_mut) else {
        return stdout.to_string();
    };

    notices.remove("update");
    if notices.is_empty() {
        root.remove("_notice");
    }

    serde_json::to_string(&output).unwrap_or_else(|_| stdout.to_string())
}

pub(super) async fn auth_start_with_recommendation(
    state: &AppState,
    user_id: &str,
    payload: &Value,
) -> Result<Json<Value>, ApiError> {
    auth_start_for_request(state, user_id, payload, None).await
}

pub(super) async fn auth_start_for_scopes(
    state: &AppState,
    user_id: &str,
    payload: &Value,
    requested_scopes: &BTreeSet<String>,
) -> Result<Json<Value>, ApiError> {
    auth_start_for_request(state, user_id, payload, Some(requested_scopes)).await
}

async fn auth_start_for_request(
    state: &AppState,
    user_id: &str,
    payload: &Value,
    requested_scopes: Option<&BTreeSet<String>>,
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
        super::write_secret_json(
            &path,
            &json!({"app_id": app_id, "app_secret": app_secret, "brand": if brand.is_empty() {"feishu"} else {brand}}),
        )
        .await?;
    }

    let force_new_setup = value_as_bool(payload.get("force_new_setup")).unwrap_or(false);
    let force_new_user_auth = value_as_bool(payload.get("force_new_user_auth")).unwrap_or(false);

    let (ok, msg) = ensure_cli_config(state, user_id, force_new_setup).await?;
    state.sandboxes.write_nsjail_config(user_id)?;
    if looks_like_url(&msg) {
        return Ok(Json(action_response(
            "feishu",
            true,
            "awaiting_setup",
            "Open the setup URL to finish Feishu configuration.",
            json!({
                "setup_url": msg,
                "expires_in_seconds": SETUP_URL_DISPLAY_TTL_SECONDS
            }),
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

    let (_connected, _detail, metadata) = cli_login_status(state, user_id).await;
    let granted_scopes = if let Some(lark) = lark_binary(state) {
        user_scopes_from_status(state, user_id, &lark).await
    } else {
        BTreeSet::new()
    };
    if let Some(requested_scopes) = requested_scopes {
        if can_reuse_user_authorization(requested_scopes, &granted_scopes, force_new_user_auth) {
            return Ok(Json(action_response(
                "feishu",
                true,
                "authorized",
                "Feishu user authorization is already ready for this user.",
                json!({}),
            )));
        }
    }
    if status_needs_setup(&metadata) {
        let (ok, msg) = ensure_cli_config(state, user_id, true).await?;
        state.sandboxes.write_nsjail_config(user_id)?;
        if looks_like_url(&msg) {
            return Ok(Json(action_response(
                "feishu",
                true,
                "awaiting_setup",
                "Open the setup URL to finish Feishu configuration.",
                json!({
                    "setup_url": msg,
                    "expires_in_seconds": SETUP_URL_DISPLAY_TTL_SECONDS
                }),
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

    let auth_result = match requested_scopes {
        Some(requested_scopes) => {
            let authorization_scopes = granted_scopes
                .union(requested_scopes)
                .cloned()
                .collect::<BTreeSet<_>>();
            start_lark_user_auth(state, user_id, &authorization_scopes).await
        }
        None => start_lark_recommended_user_auth(state, user_id).await,
    };
    let data = match auth_result {
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

pub(super) async fn auth_complete(
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
    let required_scopes = requested_scopes_from_completion_payload(payload);
    let completion = complete_lark_user_auth(state, user_id, device_code)
        .await
        .unwrap_or_else(|error| DeviceAuthorizationCompletion::Failed {
            detail: error.to_string(),
        });
    state.sandboxes.write_nsjail_config(user_id)?;
    let (connected, status_detail, status_metadata) =
        confirm_user_authorization(state, user_id).await;
    let granted_scopes = if connected {
        if let Some(lark) = lark_binary(state) {
            user_scopes_from_status(state, user_id, &lark).await
        } else {
            BTreeSet::new()
        }
    } else {
        BTreeSet::new()
    };
    let missing_scopes = missing_required_scopes(&required_scopes, &granted_scopes);
    if connected && (required_scopes.is_empty() || missing_scopes.is_empty()) {
        return Ok(Json(action_response(
            "feishu",
            true,
            "authorized",
            "Feishu user authorization completed for this user.",
            json!({}),
        )));
    }
    if matches!(completion, DeviceAuthorizationCompletion::Completed) && !missing_scopes.is_empty()
    {
        let scopes = missing_scopes.into_iter().collect::<Vec<_>>();
        return Ok(Json(action_response(
            "feishu",
            false,
            "auth_failed",
            &format!(
                "飞书授权已完成，但未授予任务所需权限：{}。请确认飞书应用已启用这些权限并通过管理员审批，然后重新发起任务。",
                scopes.join(", ")
            ),
            json!({
                "missing_scopes": scopes,
                "required_action_type": "awaiting_admin_authorization"
            }),
        )));
    }
    let retryable_expiration = matches!(&completion, DeviceAuthorizationCompletion::Expired { .. });
    let permission_approval_required = matches!(
        &completion,
        DeviceAuthorizationCompletion::Failed { detail }
            if is_auth_pending_approval_message(detail)
    );
    let (stage, ok, message, device_code_finalized) = match completion {
        DeviceAuthorizationCompletion::Completed => (
            "pending",
            true,
            "Feishu authorization was confirmed, but local user status is not ready yet. Please wait a moment and try again.".to_string(),
            true,
        ),
        DeviceAuthorizationCompletion::Pending { detail } => (
            "pending",
            true,
            detail,
            false,
        ),
        DeviceAuthorizationCompletion::Expired { detail } => (
            "auth_failed",
            false,
            detail,
            false,
        ),
        DeviceAuthorizationCompletion::Failed { detail } => {
            let pending_approval = is_auth_pending_approval_message(&detail);
            if pending_approval {
                (
                    "auth_failed",
                    false,
                    "Feishu app authorization is pending administrator approval. Ask the Feishu app administrator to approve the requested permissions, then start authorization again.".to_string(),
                    false,
                )
            } else {
                ("auth_failed", false, detail, false)
            }
        }
    };
    Ok(Json(action_response(
        "feishu",
        ok,
        stage,
        &message,
        json!({
            "device_code_finalized": device_code_finalized,
            "retryable_reason": retryable_expiration.then_some("device_code_expired"),
            "required_action_type": permission_approval_required
                .then_some("awaiting_admin_authorization"),
            "status_detail": status_detail,
            "status_metadata": status_metadata
        }),
    )))
}

fn requested_scopes_from_completion_payload(payload: &Value) -> BTreeSet<String> {
    payload
        .get("required_scopes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|scope| !scope.is_empty() && scope.len() <= 256)
        .filter(|scope| {
            scope.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-' | b'.')
            })
        })
        .map(str::to_string)
        .collect()
}

fn missing_required_scopes(
    required_scopes: &BTreeSet<String>,
    granted_scopes: &BTreeSet<String>,
) -> BTreeSet<String> {
    required_scopes
        .iter()
        .filter(|scope| !feishu_scope_is_granted(scope, granted_scopes))
        .cloned()
        .collect()
}

fn feishu_scope_is_granted(scope: &str, granted_scopes: &BTreeSet<String>) -> bool {
    granted_scopes.contains(scope)
        || match scope {
            "contact:user.basic_profile:readonly" => {
                granted_scopes.contains("contact:user.base:readonly")
            }
            "contact:user.base:readonly" => {
                granted_scopes.contains("contact:user.basic_profile:readonly")
            }
            _ => false,
        }
}

fn can_reuse_user_authorization(
    requested_scopes: &BTreeSet<String>,
    granted_scopes: &BTreeSet<String>,
    force_new_user_auth: bool,
) -> bool {
    !force_new_user_auth && missing_required_scopes(requested_scopes, granted_scopes).is_empty()
}

pub(super) async fn disconnect(state: &AppState, user_id: &str) -> Result<Json<Value>, ApiError> {
    cancel_setup(state, user_id).await;
    let seed = state
        .sandboxes
        .credentials_dir(user_id)?
        .join("feishu.json");
    let removed_seed = remove_file_if_exists(&seed).await?;
    let lark_dir = state.sandboxes.lark_cli_credentials_dir(user_id)?;
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
    run_lark_with_sandbox(&state.sandboxes, user_id, args, stdin, timeout_seconds).await
}

async fn run_lark_with_sandbox(
    sandboxes: &SandboxManager,
    user_id: &str,
    args: &[&str],
    stdin: Option<&str>,
    timeout_seconds: u64,
) -> Result<std::process::Output, ApiError> {
    sandboxes.prepare_lark_cli_credentials(user_id)?;
    let argv = sandboxes.nsjail_exec_argv(user_id, sandboxes.lark_cli_sandbox_binary(), args)?;
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

async fn cli_login_status(state: &AppState, user_id: &str) -> (bool, String, Value) {
    let Some(lark) = lark_binary(state) else {
        return (
            false,
            "lark-cli is not installed for this server.".to_string(),
            json!({"has_app_config": false}),
        );
    };
    if let Err(error) = state.sandboxes.prepare_lark_cli_credentials(user_id) {
        return (
            false,
            format!("Unable to prepare Feishu credentials for this user: {error}"),
            json!({"has_app_config": false}),
        );
    }
    let has_app_config = state
        .sandboxes
        .lark_cli_config_dir(user_id)
        .map(|config| config.join("config.json").is_file())
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
            metadata.insert("auth_status_error".to_string(), json!(true));
            return (
                false,
                format!("Feishu auth status check failed: {err:?}"),
                Value::Object(metadata),
            );
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
        metadata.insert("auth_status_inconclusive".to_string(), json!(true));
        (
            false,
            "Feishu user authorization status is inconclusive.".to_string(),
            Value::Object(metadata),
        )
    } else {
        metadata.insert("auth_status_error".to_string(), json!(true));
        (false, command_tail(&output), Value::Object(metadata))
    }
}

async fn ensure_cli_config(
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
    state.sandboxes.prepare_lark_cli_credentials(user_id)?;
    let lark_dir = state.sandboxes.lark_cli_config_dir(user_id)?;
    if force_new_setup {
        cancel_setup(state, user_id).await;
        if lark_dir.exists() {
            tokio::fs::remove_dir_all(&lark_dir).await?;
        }
    }
    if lark_dir.join("config.json").is_file() {
        return Ok((true, String::new()));
    }
    if let Some(app) = read_app_credentials(state, user_id)? {
        return inject_credentials(state, user_id, &app).await;
    }
    if let Some(result) = check_setup(state, user_id).await? {
        if !setup_check_needs_retry(&result) {
            return Ok(result);
        }
    }
    start_setup(state, user_id).await
}

/// A finished setup that did not create a configuration file cannot be
/// completed by asking the user to revisit its old URL. Start a new device
/// setup so the caller receives a fresh URL instead.
fn setup_check_needs_retry(result: &(bool, String)) -> bool {
    !result.0 && !looks_like_url(&result.1)
}

fn read_app_credentials(
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
        if let Some(app) = parse_app_credentials(&value) {
            return Ok(Some(app));
        }
    }
    Ok(state.config.feishu.app.clone())
}

fn parse_app_credentials(value: &Value) -> Option<FeishuAppConfig> {
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

async fn inject_credentials(
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

async fn start_setup(state: &AppState, user_id: &str) -> Result<(bool, String), ApiError> {
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
    state.connector_runtime.feishu_setup.lock().await.insert(
        user_id.to_string(),
        PendingFeishuSetup {
            process: child,
            url: setup_url.clone(),
        },
    );
    Ok((false, setup_url))
}

async fn check_setup(state: &AppState, user_id: &str) -> Result<Option<(bool, String)>, ApiError> {
    let config_file = state
        .sandboxes
        .lark_cli_config_dir(user_id)?
        .join("config.json");
    if config_file.is_file() {
        cancel_setup(state, user_id).await;
        return Ok(Some((true, String::new())));
    }
    let mut setups = state.connector_runtime.feishu_setup.lock().await;
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

pub(crate) async fn cancel_setup(state: &AppState, user_id: &str) -> bool {
    let setup = state
        .connector_runtime
        .feishu_setup
        .lock()
        .await
        .remove(user_id);
    if let Some(mut setup) = setup {
        let _ = setup.process.kill().await;
        let _ = setup.process.wait().await;
        true
    } else {
        false
    }
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
    scopes: &BTreeSet<String>,
) -> anyhow::Result<Value> {
    let Some(lark) = lark_binary(state) else {
        anyhow::bail!("lark-cli is not installed.");
    };
    let args = lark_user_auth_args(scopes)?;
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let output = run_lark(state, user_id, &lark, &arg_refs, None, 20)
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
    auth_start_payload(&parsed).ok_or_else(|| {
        anyhow::anyhow!("lark-cli auth login --no-wait output is missing oauth_url or device_code")
    })
}

async fn start_lark_recommended_user_auth(
    state: &AppState,
    user_id: &str,
) -> anyhow::Result<Value> {
    let Some(lark) = lark_binary(state) else {
        anyhow::bail!("lark-cli is not installed.");
    };
    let args = lark_recommended_user_auth_args();
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let output = run_lark(state, user_id, &lark, &arg_refs, None, 20)
        .await
        .map_err(|err| anyhow::anyhow!("{err:?}"))?;
    if !output.status.success() {
        anyhow::bail!(
            "lark-cli auth login --recommend --no-wait failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            command_tail(&output)
        );
    }
    let merged = String::from_utf8_lossy(&output.stdout).to_string()
        + "\n"
        + &String::from_utf8_lossy(&output.stderr);
    let parsed = first_json_object(&merged).ok_or_else(|| {
        anyhow::anyhow!("Unable to parse lark-cli auth login --recommend --no-wait JSON output")
    })?;
    auth_start_payload(&parsed).ok_or_else(|| {
        anyhow::anyhow!(
            "lark-cli auth login --recommend --no-wait output is missing oauth_url or device_code"
        )
    })
}

fn lark_recommended_user_auth_args() -> Vec<String> {
    vec![
        "auth".to_string(),
        "login".to_string(),
        "--no-wait".to_string(),
        "--json".to_string(),
        "--recommend".to_string(),
    ]
}

fn lark_user_auth_args(scopes: &BTreeSet<String>) -> anyhow::Result<Vec<String>> {
    let scope_value = scopes.iter().cloned().collect::<Vec<_>>().join(" ");
    if scope_value.is_empty() {
        anyhow::bail!("Feishu user authorization requires at least one scope.");
    }
    Ok(vec![
        "auth".to_string(),
        "login".to_string(),
        "--no-wait".to_string(),
        "--json".to_string(),
        "--scope".to_string(),
        scope_value,
    ])
}

async fn complete_lark_user_auth(
    state: &AppState,
    user_id: &str,
    device_code: &str,
) -> anyhow::Result<DeviceAuthorizationCompletion> {
    let Some(lark) = lark_binary(state) else {
        anyhow::bail!("lark-cli is not installed.");
    };
    let output = run_lark(
        state,
        user_id,
        &lark,
        &["auth", "login", "--device-code", device_code, "--json"],
        None,
        60,
    )
    .await
    .map_err(|err| anyhow::anyhow!("{err:?}"))?;
    if output.status.success() {
        Ok(DeviceAuthorizationCompletion::Completed)
    } else {
        Ok(classify_device_authorization_failure(&command_tail(
            &output,
        )))
    }
}

fn classify_device_authorization_failure(output: &str) -> DeviceAuthorizationCompletion {
    let detail = output
        .trim()
        .to_string()
        .if_empty("Feishu user authorization is not ready yet.");
    let normalized = auth_error_code(output)
        .unwrap_or_else(|| detail.to_ascii_lowercase())
        .to_ascii_lowercase();
    if ["expired", "invalid_device"]
        .into_iter()
        .any(|marker| normalized.contains(marker))
    {
        return DeviceAuthorizationCompletion::Expired { detail };
    }
    if is_auth_pending_approval_message(&normalized)
        || [
            "invalid_grant",
            "access_denied",
            "authorization_denied",
            "denied",
            "revoked",
        ]
        .into_iter()
        .any(|marker| normalized.contains(marker))
    {
        return DeviceAuthorizationCompletion::Failed { detail };
    }

    // The device flow reports an HTTP 400 while the user has not completed the
    // browser confirmation. Unknown non-terminal responses are deliberately
    // retained as pending, because dropping the device code starts a new flow.
    DeviceAuthorizationCompletion::Pending { detail }
}

fn auth_error_code(output: &str) -> Option<String> {
    let value = first_json_object(output)?;
    for pointer in [
        "/error/code",
        "/data/error/code",
        "/code",
        "/error/error",
        "/data/error/error",
    ] {
        if let Some(code) = value.pointer(pointer).and_then(Value::as_str) {
            let code = code.trim();
            if !code.is_empty() {
                return Some(code.to_string());
            }
        }
    }
    None
}

async fn confirm_user_authorization(state: &AppState, user_id: &str) -> (bool, String, Value) {
    let mut last_detail = "Feishu user authorization status is not ready yet.".to_string();
    let mut last_metadata = json!({});
    for delay_seconds in [0_u64, 1, 2] {
        if delay_seconds > 0 {
            tokio::time::sleep(Duration::from_secs(delay_seconds)).await;
        }
        let (connected, detail, metadata) = cli_login_status(state, user_id).await;
        if connected {
            return (true, detail, metadata);
        }
        last_detail = detail;
        last_metadata = metadata;
    }
    (false, last_detail, last_metadata)
}

fn status_needs_setup(metadata: &Value) -> bool {
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

fn auth_start_payload(value: &Value) -> Option<Value> {
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

fn is_auth_pending_approval_message(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("pending approval") || normalized.contains("管理员审批")
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

#[cfg(test)]
mod tests {
    use std::process::Stdio;
    use std::time::Duration;

    use serde_json::json;
    use tokio::process::Command;

    use super::*;

    #[test]
    fn extracts_auth_start_payload_from_lark_output() {
        let parsed = first_json_object(
            "prefix {\"data\":{\"verification_uri\":\"https://accounts.feishu.cn/device\",\"deviceCode\":\"device-123\",\"expiresIn\":600}} suffix",
        )
        .unwrap();
        let payload = auth_start_payload(&parsed).unwrap();

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
    fn recommended_auth_uses_only_the_recommend_flag() {
        assert_eq!(
            lark_recommended_user_auth_args(),
            vec!["auth", "login", "--no-wait", "--json", "--recommend"]
        );
    }

    #[test]
    fn extracts_only_structured_missing_scopes_from_permission_violation() {
        let result = json!({
            "stdout": "prefix {\"error\":{\"type\":\"missing_scope\",\"permission_violations\":[{\"scopes\":[\"base:app:readonly\",\"space:document:write\"]}]}}",
            "stderr": "permission_violations: im:message should not be parsed from plain text"
        });

        assert_eq!(
            missing_user_scopes_from_cli_result(&result),
            [
                "base:app:readonly".to_string(),
                "space:document:write".to_string(),
            ]
            .into_iter()
            .collect()
        );
    }

    #[test]
    fn extracts_required_scope_from_lark_plaintext_permission_error() {
        let result = json!({
            "ok": false,
            "stdout": "Error: insufficient permissions (required scope: mail:user_mailbox:readonly)"
        });

        assert_eq!(
            missing_user_scopes_from_cli_result(&result),
            ["mail:user_mailbox:readonly".to_string()]
                .into_iter()
                .collect()
        );
    }

    #[test]
    fn extracts_required_scopes_from_lark_missing_scope_json_error() {
        let result = json!({
            "ok": false,
            "stderr": "{\"error\":{\"type\":\"missing_scope\",\"message\":\"missing required scope(s): contact:user.basic_profile:readonly, task:task:write\"}}"
        });

        assert_eq!(
            missing_user_scopes_from_cli_result(&result),
            [
                "contact:user.basic_profile:readonly".to_string(),
                "task:task:write".to_string(),
            ]
            .into_iter()
            .collect()
        );
    }

    #[test]
    fn completion_rejects_existing_token_missing_the_requested_scope() {
        let payload = json!({
            "device_code": "device-123",
            "required_scopes": [
                "contact:user:search",
                "mail:user_mailbox.message:send"
            ]
        });
        let required = requested_scopes_from_completion_payload(&payload);
        let granted = ["contact:user:search".to_string()].into_iter().collect();

        assert_eq!(
            missing_required_scopes(&required, &granted),
            ["mail:user_mailbox.message:send".to_string()]
                .into_iter()
                .collect()
        );
    }

    #[test]
    fn ignores_plaintext_scope_marker_from_successful_cli_output() {
        let result = json!({
            "ok": true,
            "stdout": "quoted text: insufficient permissions (required scope: mail:user_mailbox:readonly)"
        });

        assert!(missing_user_scopes_from_cli_result(&result).is_empty());
    }

    #[test]
    fn pending_approval_is_terminal_device_auth_failure() {
        let message = "authorization failed: Unable to authorize. The app is pending approval.";

        assert_eq!(
            classify_device_authorization_failure(message),
            DeviceAuthorizationCompletion::Failed {
                detail: message.to_string()
            }
        );
    }

    #[test]
    fn pending_device_auth_json_is_not_terminal() {
        let output = r#"{"error":{"code":"authorization_pending","message":"waiting for user"}}"#;

        assert_eq!(
            classify_device_authorization_failure(output),
            DeviceAuthorizationCompletion::Pending {
                detail: output.to_string()
            }
        );
    }

    #[test]
    fn expired_device_code_is_retryable() {
        let output = r#"{"error":{"code":"expired_token","message":"device code expired"}}"#;

        assert_eq!(
            classify_device_authorization_failure(output),
            DeviceAuthorizationCompletion::Expired {
                detail: output.to_string()
            }
        );
    }

    #[test]
    fn strips_only_maintenance_update_notice_from_agent_output() {
        let output = strip_lark_update_notice(
            r#"{
                "ok": true,
                "data": {"message_id": "om_123"},
                "_notice": {
                    "update": {"current": "1.0.34", "latest": "1.0.74"},
                    "rate_limit": {"remaining": 99}
                }
            }"#,
        );
        let value: Value = serde_json::from_str(&output).unwrap();

        assert_eq!(
            value.pointer("/data/message_id").and_then(Value::as_str),
            Some("om_123")
        );
        assert!(value.pointer("/_notice/update").is_none());
        assert_eq!(
            value
                .pointer("/_notice/rate_limit/remaining")
                .and_then(Value::as_u64),
            Some(99)
        );
    }

    #[test]
    fn preserves_non_json_lark_output() {
        let output = "lark-cli diagnostic output";

        assert_eq!(strip_lark_update_notice(output), output);
    }

    #[test]
    fn user_auth_requests_only_requested_scopes() {
        let scopes = ["im:message", "im:message.send_as_user"]
            .into_iter()
            .map(str::to_string)
            .collect();
        let args = lark_user_auth_args(&scopes).unwrap();

        assert_eq!(
            args,
            vec![
                "auth",
                "login",
                "--no-wait",
                "--json",
                "--scope",
                "im:message im:message.send_as_user"
            ]
        );
        assert!(!args.iter().any(|arg| arg == "--domain"));
        assert!(!args.iter().any(|arg| arg == "--recommend"));
    }

    #[test]
    fn groups_enabled_scopes_and_marks_user_grants() {
        let granted_scopes = user_granted_scopes(&json!({
            "identities": {
                "user": {
                    "scope": "docx:document drive:drive:readonly mail:user_mailbox.message:readonly"
                }
            }
        }));
        let enabled_scopes = enabled_user_scopes(&json!({
            "userScopes": [
                "docx:document",
                "docx:document:create",
                "drive:drive:readonly",
                "drive:file:upload",
                "mail:user_mailbox.message:readonly",
                "mail:user_mailbox.message:send"
            ]
        }));
        let capabilities = scope_capabilities(&enabled_scopes, &granted_scopes);

        assert_eq!(
            capabilities.pointer("/docx/docx:document"),
            Some(&json!(true))
        );
        assert_eq!(
            capabilities.pointer("/docx/docx:document:create"),
            Some(&json!(false))
        );
        assert_eq!(
            capabilities.pointer("/drive/drive:file:upload"),
            Some(&json!(false))
        );
        assert_eq!(
            capabilities.pointer("/mail/mail:user_mailbox.message:send"),
            Some(&json!(false))
        );
    }

    #[test]
    fn falls_back_to_top_level_scope_for_older_lark_cli_status() {
        let scopes = user_granted_scopes(&json!({
            "scope": "drive:file:upload mail:user_mailbox.message:send"
        }));

        assert_eq!(scopes.len(), 2);
        assert!(scopes.contains("drive:file:upload"));
        assert!(scopes.contains("mail:user_mailbox.message:send"));
    }

    #[test]
    fn authorization_scope_check_verifies_the_token_with_feishu() {
        assert_eq!(
            lark_user_status_args().as_slice(),
            ["auth", "status", "--verify"]
        );
    }

    #[test]
    fn authorization_reuses_verified_token_only_when_all_scopes_are_granted() {
        let requested = ["contact:user:search", "mail:user_mailbox.message:send"]
            .into_iter()
            .map(str::to_string)
            .collect();
        let granted = [
            "contact:user:search",
            "mail:user_mailbox.message:send",
            "mail:user_mailbox.message:modify",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();

        assert!(can_reuse_user_authorization(&requested, &granted, false));
    }

    #[test]
    fn authorization_starts_again_for_missing_scopes_or_explicit_reauth() {
        let requested = ["mail:user_mailbox.message:send".to_string()]
            .into_iter()
            .collect();
        let missing = BTreeSet::new();
        let granted = ["mail:user_mailbox.message:send".to_string()]
            .into_iter()
            .collect();

        assert!(!can_reuse_user_authorization(&requested, &missing, false));
        assert!(!can_reuse_user_authorization(&requested, &granted, true));
    }

    #[test]
    fn contact_base_scope_aliases_do_not_force_reauthorization() {
        let requested = [
            "contact:user.basic_profile:readonly",
            "contact:user.base:readonly",
            "task:task:write",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        let granted = ["contact:user.base:readonly", "task:task:write"]
            .into_iter()
            .map(str::to_string)
            .collect();

        assert!(missing_required_scopes(&requested, &granted).is_empty());
        assert!(can_reuse_user_authorization(&requested, &granted, false));
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
    fn auth_start_payload_expires_supports_json_numbers() {
        let payload = auth_start_payload(&json!({
            "verification_uri": "https://accounts.feishu.cn/device",
            "device_code": "device-123",
            "expires_in": 600
        }))
        .unwrap();

        assert_eq!(value_as_u64(payload.get("expires_in_seconds")), Some(600));
    }

    #[test]
    fn failed_setup_check_requires_a_fresh_setup_url() {
        assert!(setup_check_needs_retry(&(
            false,
            "config init --new failed (exit=1)".to_string()
        )));
        assert!(setup_check_needs_retry(&(
            false,
            "config init --new exited but did not create config.json.".to_string()
        )));
        assert!(!setup_check_needs_retry(&(true, String::new())));
        assert!(!setup_check_needs_retry(&(
            false,
            "https://open.feishu.cn/page/cli?user_code=fresh".to_string()
        )));
    }
}
