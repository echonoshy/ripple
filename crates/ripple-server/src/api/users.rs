use std::path::{Path as FsPath, PathBuf};

use axum::body::Body;
use axum::extract::{Multipart, Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use axum::Extension;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::api::ApiError;
use crate::sandbox::workspace_size_bytes;
use crate::state::AppState;
use crate::user::{user_id_from_headers, AuthContext, AuthKind};

pub(crate) const MAX_SESSIONS_PER_USER: u64 = 200;
pub(crate) const MAX_RUNS_PER_DAY: u64 = 200;
pub(crate) const USER_AVATAR_UPLOAD_BODY_LIMIT_BYTES: usize = 5 * 1024 * 1024;
const USER_AVATAR_URI_PREFIX: &str = "/v1/users/me/avatar/";
const USER_AVATAR_FIELD_NAME: &str = "avatar";

#[derive(Debug, Clone, Deserialize)]
pub struct UserProfileUpdateRequest {
    pub display_name: Option<String>,
}

pub async fn current_user_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
    Extension(auth): Extension<AuthContext>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    Ok(Json(user_profile_json(&state, &user_id, &auth).await?))
}

pub async fn update_current_user_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
    Extension(auth): Extension<AuthContext>,
    Json(payload): Json<UserProfileUpdateRequest>,
) -> Result<Json<Value>, ApiError> {
    if auth.kind != AuthKind::User {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            json!({
                "code": "user_profile_read_only",
                "message": "Display name can only be changed by a signed-in user account."
            }),
        ));
    }

    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let display_name = normalize_display_name(payload.display_name)?;
    let updated = state
        .storage
        .update_auth_user_display_name(&user_id, display_name.as_deref())
        .await?;
    if !updated {
        return Err(ApiError::not_found("User not found"));
    }

    Ok(Json(user_profile_json(&state, &user_id, &auth).await?))
}

pub async fn upload_user_avatar(
    State(state): State<AppState>,
    headers: HeaderMap,
    Extension(auth): Extension<AuthContext>,
    mut multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    let previous_avatar_uri = state
        .storage
        .user_profile(&user_id)
        .await?
        .and_then(|profile| profile.avatar_uri);

    let mut upload: Option<(Vec<u8>, String)> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|err| ApiError::bad_request(err.to_string()))?
    {
        if field.name() != Some(USER_AVATAR_FIELD_NAME) {
            continue;
        }
        let content_type = field.content_type().map(str::to_string);
        let file_name = field.file_name().map(str::to_string);
        let extension = avatar_extension(content_type.as_deref(), file_name.as_deref())?;
        let bytes = field
            .bytes()
            .await
            .map_err(|err| ApiError::bad_request(err.to_string()))?;
        if bytes.is_empty() {
            return Err(ApiError::bad_request(json!({
                "code": "empty_avatar",
                "message": "Avatar image is empty."
            })));
        }
        if bytes.len() > USER_AVATAR_UPLOAD_BODY_LIMIT_BYTES {
            return Err(ApiError::bad_request(json!({
                "code": "avatar_too_large",
                "message": "Avatar image is too large."
            })));
        }
        upload = Some((bytes.to_vec(), extension.to_string()));
        break;
    }

    let Some((bytes, extension)) = upload else {
        return Err(ApiError::bad_request(json!({
            "code": "avatar_missing",
            "message": "Upload a file field named avatar."
        })));
    };

    let avatar_dir = user_avatar_dir(&state, &user_id)?;
    tokio::fs::create_dir_all(&avatar_dir).await?;
    let file_name = format!("avatar-{}.{}", Uuid::new_v4().simple(), extension);
    let file_path = avatar_dir.join(&file_name);
    tokio::fs::write(&file_path, bytes).await?;

    let avatar_uri = format!("{USER_AVATAR_URI_PREFIX}{file_name}");
    state
        .storage
        .upsert_user_avatar_uri(&user_id, Some(&avatar_uri))
        .await?;
    remove_avatar_file_for_uri(&state, &user_id, previous_avatar_uri.as_deref()).await?;

    Ok(Json(user_profile_json(&state, &user_id, &auth).await?))
}

pub async fn get_user_avatar(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(file_name): Path<String>,
    Extension(_auth): Extension<AuthContext>,
) -> Result<Response, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    if !is_safe_avatar_file_name(&file_name) {
        return Err(ApiError::bad_request("invalid avatar file name"));
    }
    let expected_avatar_uri = format!("{USER_AVATAR_URI_PREFIX}{file_name}");
    let profile = state.storage.user_profile(&user_id).await?;
    if profile.and_then(|row| row.avatar_uri).as_deref() != Some(expected_avatar_uri.as_str()) {
        return Err(ApiError::not_found("Avatar not found"));
    }
    let path = user_avatar_dir(&state, &user_id)?.join(&file_name);
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| ApiError::not_found("Avatar not found"))?;
    Response::builder()
        .status(StatusCode::OK)
        .header(
            header::CONTENT_TYPE,
            avatar_content_type_from_file_name(&file_name),
        )
        .body(Body::from(bytes))
        .map_err(|err| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))
}

pub async fn delete_user_avatar(
    State(state): State<AppState>,
    headers: HeaderMap,
    Extension(auth): Extension<AuthContext>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    let previous_avatar_uri = state
        .storage
        .user_profile(&user_id)
        .await?
        .and_then(|profile| profile.avatar_uri);
    state.storage.upsert_user_avatar_uri(&user_id, None).await?;
    remove_avatar_file_for_uri(&state, &user_id, previous_avatar_uri.as_deref()).await?;
    Ok(Json(user_profile_json(&state, &user_id, &auth).await?))
}

async fn user_profile_json(
    state: &AppState,
    user_id: &str,
    auth: &AuthContext,
) -> Result<Value, ApiError> {
    let usage = user_usage(state, user_id).await.unwrap_or(json!({}));
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
        "auth": auth.public_json(),
        "profile": {
            "user_id": user_id,
            "user_name": user_name,
            "display_name": display_name,
            "login": login,
            "avatar_uri": avatar_uri
        },
        "avatar_uri": avatar_uri,
        "usage": usage,
        "limits": user_limits(state)
    }))
}

fn user_avatar_dir(state: &AppState, user_id: &str) -> Result<PathBuf, ApiError> {
    Ok(state
        .sandboxes
        .sandbox_dir(user_id)?
        .join("profile")
        .join("avatars"))
}

fn avatar_extension<'a>(
    content_type: Option<&str>,
    file_name: Option<&'a str>,
) -> Result<&'a str, ApiError> {
    match content_type
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/png" => return Ok("png"),
        "image/jpeg" | "image/jpg" => return Ok("jpg"),
        "image/webp" => return Ok("webp"),
        "image/gif" => return Ok("gif"),
        _ => {}
    }
    let extension = file_name
        .and_then(|name| name.rsplit('.').next())
        .map(str::to_ascii_lowercase)
        .ok_or_else(unsupported_avatar_type)?;
    match extension.as_str() {
        "png" => Ok("png"),
        "jpg" | "jpeg" => Ok("jpg"),
        "webp" => Ok("webp"),
        "gif" => Ok("gif"),
        _ => Err(unsupported_avatar_type()),
    }
}

fn unsupported_avatar_type() -> ApiError {
    ApiError::bad_request(json!({
        "code": "unsupported_avatar_type",
        "message": "Avatar must be a PNG, JPEG, WebP, or GIF image."
    }))
}

fn normalize_display_name(input: Option<String>) -> Result<Option<String>, ApiError> {
    let Some(value) = input else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > 80 {
        return Err(ApiError::bad_request(json!({
            "code": "display_name_too_long",
            "message": "Display name must be 80 characters or fewer."
        })));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(ApiError::bad_request(json!({
            "code": "display_name_invalid",
            "message": "Display name cannot contain control characters."
        })));
    }
    Ok(Some(trimmed.to_string()))
}

fn avatar_content_type(extension: &str) -> &'static str {
    match extension {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    }
}

fn avatar_content_type_from_file_name(file_name: &str) -> &'static str {
    avatar_content_type(file_name.rsplit('.').next().unwrap_or(""))
}

fn avatar_file_name_from_uri(uri: &str) -> Option<&str> {
    uri.strip_prefix(USER_AVATAR_URI_PREFIX)
        .filter(|file_name| is_safe_avatar_file_name(file_name))
}

fn is_safe_avatar_file_name(file_name: &str) -> bool {
    !file_name.is_empty()
        && file_name.starts_with("avatar-")
        && file_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

async fn remove_avatar_file_for_uri(
    state: &AppState,
    user_id: &str,
    uri: Option<&str>,
) -> Result<(), ApiError> {
    let Some(file_name) = uri.and_then(avatar_file_name_from_uri) else {
        return Ok(());
    };
    let path = user_avatar_dir(state, user_id)?.join(file_name);
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

pub(crate) async fn assert_can_create_session(
    state: &AppState,
    user_id: &str,
) -> Result<(), ApiError> {
    state.sandboxes.ensure_sandbox(user_id)?;
    let usage = user_usage(state, user_id).await?;
    let used = usage_u64(&usage, "session_count");
    if used >= MAX_SESSIONS_PER_USER {
        return Err(quota_error("sessions", MAX_SESSIONS_PER_USER, used));
    }
    Ok(())
}

pub(crate) async fn assert_can_create_run(
    state: &AppState,
    user_id: &str,
    max_runtime_seconds: u64,
) -> Result<(), ApiError> {
    if !state.config.codex.enabled {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({
                "code": "codex_disabled",
                "message": "Codex runtime is disabled for this server."
            }),
        ));
    }
    state.sandboxes.ensure_sandbox(user_id)?;
    let usage = user_usage(state, user_id).await?;
    let used_runs = usage_u64(&usage, "runs_today");
    if used_runs >= MAX_RUNS_PER_DAY {
        return Err(quota_error("runs_per_day", MAX_RUNS_PER_DAY, used_runs));
    }
    let max_runtime = state.config.codex.max_runtime_seconds;
    if max_runtime_seconds > max_runtime {
        return Err(quota_error(
            "run_runtime_seconds",
            max_runtime,
            max_runtime_seconds,
        ));
    }
    Ok(())
}

pub(crate) async fn assert_workspace_save_within_quota(
    state: &AppState,
    user_id: &str,
    target: &FsPath,
    new_content_bytes: u64,
) -> Result<(), ApiError> {
    assert_workspace_writes_within_quota(
        state,
        user_id,
        &[(target.to_path_buf(), new_content_bytes)],
    )
    .await
}

pub(crate) async fn assert_workspace_writes_within_quota(
    state: &AppState,
    user_id: &str,
    targets: &[(PathBuf, u64)],
) -> Result<(), ApiError> {
    state.sandboxes.ensure_sandbox(user_id)?;
    let usage = user_usage(state, user_id).await?;
    let max_bytes = state
        .config
        .sandbox
        .max_workspace_mb
        .saturating_mul(1024 * 1024);
    let current_size = usage_u64(&usage, "workspace_size_bytes");
    let mut old_size = 0_u64;
    let mut new_size = 0_u64;
    for (target, bytes) in targets {
        old_size = old_size.saturating_add(
            target
                .metadata()
                .ok()
                .filter(|metadata| metadata.is_file())
                .map(|metadata| metadata.len())
                .unwrap_or(0),
        );
        new_size = new_size.saturating_add(*bytes);
    }
    let projected = current_size
        .saturating_sub(old_size)
        .saturating_add(new_size);
    if projected > max_bytes {
        return Err(quota_error("workspace_bytes", max_bytes, projected));
    }
    Ok(())
}

async fn user_usage(state: &AppState, user_id: &str) -> Result<Value, ApiError> {
    let workspace = state.sandboxes.workspace_dir(user_id)?;
    let today = now_iso().chars().take(10).collect::<String>();
    let run_stats = state.storage.job_usage_stats(user_id, &today).await?;
    let session_count = state.storage.count_sessions(user_id).await?;
    let total_tokens = state.storage.total_tokens_used(user_id).await.unwrap_or(0);
    let token_breakdown = state
        .storage
        .token_usage_breakdown(user_id)
        .await
        .unwrap_or_default();
    let (daily_token_breakdown, weekly_token_breakdown) = state
        .storage
        .token_usage_by_period(user_id)
        .await
        .unwrap_or_else(|_| (Default::default(), Default::default()));
    Ok(json!({
        "workspace_size_bytes": workspace_size_bytes(&workspace),
        "session_count": session_count,
        "runs_today": run_stats.runs_today,
        "active_runs": run_stats.active_runs,
        "total_tokens": total_tokens,
        "total_input_tokens": token_breakdown.total_input_tokens,
        "total_output_tokens": token_breakdown.total_output_tokens,
        "daily_tokens": daily_token_breakdown.total_tokens(),
        "daily_input_tokens": daily_token_breakdown.total_input_tokens,
        "daily_output_tokens": daily_token_breakdown.total_output_tokens,
        "weekly_tokens": weekly_token_breakdown.total_tokens(),
        "weekly_input_tokens": weekly_token_breakdown.total_input_tokens,
        "weekly_output_tokens": weekly_token_breakdown.total_output_tokens
    }))
}

fn usage_u64(usage: &Value, key: &str) -> u64 {
    usage.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn quota_error(resource: &str, limit: u64, used: u64) -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        json!({
            "code": "quota_exceeded",
            "resource": resource,
            "limit": limit,
            "used": used
        }),
    )
}

pub(crate) fn user_limits(state: &AppState) -> Value {
    json!({
        "max_workspace_bytes": state.config.sandbox.max_workspace_mb.saturating_mul(1024 * 1024),
        "max_workspace_mb": state.config.sandbox.max_workspace_mb,
        "max_sessions": MAX_SESSIONS_PER_USER,
        "max_runs_per_day": MAX_RUNS_PER_DAY,
        "max_run_runtime_seconds": state.config.codex.max_runtime_seconds
    })
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::time::Duration;

    use super::*;
    use crate::config::{
        AppConfig, CodexConfig, CorsConfig, FeishuConfig, GogcliOAuthConfig, LoggingConfig,
        SandboxConfig, SecurityConfig, SkillsConfig, UserAuthConfig,
    };
    use crate::sessions::SessionRecord;
    use crate::state::AppState;
    use axum::response::IntoResponse;

    fn test_state() -> AppState {
        let root = std::env::temp_dir().join(format!("ripple-users-test-{}", uuid::Uuid::new_v4()));
        AppState::new(AppConfig {
            repo_root: root.clone(),
            host: "127.0.0.1".to_string(),
            port: 0,
            api_keys: Vec::new(),
            security: SecurityConfig::default(),
            user_auth: UserAuthConfig::default(),
            api_docs: crate::config::ApiDocsConfig::default(),
            cors: CorsConfig::default(),
            default_model: "codex-test".to_string(),
            model_presets: BTreeMap::new(),
            logging: LoggingConfig {
                level: "debug".to_string(),
            },
            sandbox: SandboxConfig {
                sandboxes_root: root.join("sandboxes"),
                caches_root: root.join("cache"),
                idle_suspend_seconds: 1800,
                retention_seconds: 604_800,
                max_workspace_mb: 2048,
                tmpfs_size_mb: 512,
                nsjail_path: "nsjail".to_string(),
                python_envs_root: root.join("cache/python-envs"),
                python_env_uv_cache: root.join("cache/uv-cache"),
                python_env_max_packages: 20,
                uv_bin_dir: None,
                node_dir: None,
                lark_cli_install_root: None,
                notion_cli_install_root: None,
                gogcli_cli_install_root: None,
                cli_tools: Vec::new(),
                pypi_mirror_url: None,
                npm_registry_url: None,
            },
            codex: CodexConfig {
                enabled: true,
                codex_executable: "codex".to_string(),
                app_server_args: Vec::new(),
                codex_home: None,
                approval_policy: "never".to_string(),
                sandbox_type: "workspace-write".to_string(),
                network_access: true,
                idle_timeout_seconds: 1800,
                max_runtime_seconds: 3600,
            },
            schedule_extraction_max_runtime_seconds: 120,
            schedule_poll_interval_seconds: 15,
            document_preview: crate::config::DocumentPreviewConfig {
                cache_root: root.join("cache/previews"),
                libreoffice_path: "soffice".to_string(),
                max_source_bytes: 64 * 1024 * 1024,
                conversion_timeout_seconds: 120,
            },
            skills: SkillsConfig {
                shared_dirs: Vec::new(),
            },
            public_base_url: None,
            feishu: FeishuConfig::default(),
            gogcli_oauth: GogcliOAuthConfig {
                auto_register_client: true,
                auto_from_request: true,
                callback_url: None,
                client_secret_json: None,
                client: None,
            },
        })
    }

    #[tokio::test]
    async fn run_limit_rejects_runtime_above_config_limit() {
        let mut config = test_state().config.as_ref().clone();
        config.codex.max_runtime_seconds = 60;
        let state = AppState::new(config);
        let user_id = "runtime-limit-user";
        state.sandboxes.ensure_sandbox(user_id).unwrap();

        let err = assert_can_create_run(&state, user_id, 61)
            .await
            .unwrap_err();
        let response = err.into_response();

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn workspace_limit_rejects_projected_size_from_config() {
        let mut config = test_state().config.as_ref().clone();
        config.sandbox.max_workspace_mb = 0;
        let state = AppState::new(config);
        let user_id = "workspace-limit-user";
        let workspace = state.sandboxes.ensure_sandbox(user_id).unwrap();

        let err =
            assert_workspace_save_within_quota(&state, user_id, &workspace.join("new.txt"), 1)
                .await
                .unwrap_err();
        let response = err.into_response();

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn user_usage_exposes_windowed_token_input_output_breakdown() -> anyhow::Result<()> {
        let state = test_state();
        let user_id = "usage-token-user";
        state.sandboxes.ensure_sandbox(user_id)?;
        let now = OffsetDateTime::now_utc();
        let format_time = |time: OffsetDateTime| time.format(&Rfc3339).unwrap();
        let mut record = SessionRecord {
            session_id: "usage-token-daily".to_string(),
            user_id: user_id.to_string(),
            title: "tokens".to_string(),
            pinned: false,
            project_id: None,
            project_name: None,
            project_root: None,
            context_folder_path: None,
            model: "codex-test".to_string(),
            max_turns: 200,
            caller_system_prompt: None,
            total_input_tokens: 120,
            total_output_tokens: 30,
            last_input_tokens: 120,
            created_at: format_time(now - Duration::from_secs(2 * 60 * 60)),
            last_active: format_time(now - Duration::from_secs(2 * 60 * 60)),
            status: "idle".to_string(),
            message_count: 1,
            messages: Vec::new(),
            pending_question: None,
            pending_options: None,
            pending_permission_request: None,
            pending_connector_auth: None,
            pending_schedule_request: None,
            codex_thread_id: None,
            plan_steps: Vec::new(),
            plan_progress: None,
        };
        state.storage.save_session(&record).await?;

        record.session_id = "usage-token-weekly".to_string();
        record.total_input_tokens = 80;
        record.total_output_tokens = 20;
        record.last_active = format_time(now - Duration::from_secs(3 * 24 * 60 * 60));
        state.storage.save_session(&record).await?;

        let usage = user_usage(&state, user_id).await.expect("usage");

        assert_eq!(usage["daily_input_tokens"], json!(120));
        assert_eq!(usage["daily_output_tokens"], json!(30));
        assert_eq!(usage["daily_tokens"], json!(150));
        assert_eq!(usage["weekly_input_tokens"], json!(200));
        assert_eq!(usage["weekly_output_tokens"], json!(50));
        assert_eq!(usage["weekly_tokens"], json!(250));

        Ok(())
    }

    #[tokio::test]
    async fn current_user_profile_includes_server_avatar_uri_and_user_name() -> anyhow::Result<()> {
        let state = test_state();
        let user_id = "profile-avatar-user";
        let avatar_uri = "/v1/users/me/avatar/avatar.png";
        state.sandboxes.ensure_sandbox(user_id)?;
        state
            .storage
            .upsert_user_avatar_uri(user_id, Some(avatar_uri))
            .await?;
        let mut headers = HeaderMap::new();
        headers.insert("x-ripple-user-id", user_id.parse()?);

        let Json(body) = current_user_profile(
            State(state),
            headers,
            Extension(AuthContext::service(user_id.to_string())),
        )
        .await
        .expect("profile");

        assert_eq!(
            body.pointer("/profile/user_name").and_then(Value::as_str),
            Some(user_id)
        );
        assert_eq!(
            body.pointer("/profile/avatar_uri").and_then(Value::as_str),
            Some(avatar_uri)
        );
        assert_eq!(
            body.get("avatar_uri").and_then(Value::as_str),
            Some(avatar_uri)
        );

        Ok(())
    }

    #[tokio::test]
    async fn update_current_user_profile_persists_display_name() -> anyhow::Result<()> {
        let state = test_state();
        let invite = state
            .storage
            .create_user_auth_invite(1, None, Some("test"))
            .await?;
        let token = crate::auth::claim_invite(
            &state.storage,
            &invite.code,
            "alice@example.com",
            "correct-password",
            Some("Alice".to_string()),
            3600,
            None,
        )
        .await?;
        let mut headers = HeaderMap::new();
        headers.insert("x-ripple-user-id", token.user_id.parse()?);

        let Json(body) = update_current_user_profile(
            State(state.clone()),
            headers,
            Extension(AuthContext::user(token.user_id.clone())),
            Json(UserProfileUpdateRequest {
                display_name: Some("Alice Liu".to_string()),
            }),
        )
        .await
        .expect("updated profile");

        assert_eq!(
            body.pointer("/profile/display_name")
                .and_then(Value::as_str),
            Some("Alice Liu")
        );
        assert_eq!(
            state
                .storage
                .auth_user_by_id(&token.user_id)
                .await?
                .and_then(|user| user.display_name),
            Some("Alice Liu".to_string())
        );

        Ok(())
    }
}
