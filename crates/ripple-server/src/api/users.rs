use std::path::{Path as FsPath, PathBuf};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Extension;
use axum::Json;
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::api::ApiError;
use crate::sandbox::workspace_size_bytes;
use crate::state::AppState;
use crate::user::{user_id_from_headers, AuthContext};

pub(crate) const MAX_SESSIONS_PER_USER: u64 = 200;
pub(crate) const MAX_RUNS_PER_DAY: u64 = 200;

pub async fn current_user_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
    Extension(auth): Extension<AuthContext>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    let usage = user_usage(&state, &user_id).await.unwrap_or(json!({}));
    Ok(Json(json!({
        "user_id": user_id,
        "auth": auth.public_json(),
        "usage": usage,
        "limits": user_limits(&state)
    })))
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
    let (daily_tokens, weekly_tokens) = state
        .storage
        .token_usage_by_period(user_id)
        .await
        .unwrap_or((0, 0));
    Ok(json!({
        "workspace_size_bytes": workspace_size_bytes(&workspace),
        "session_count": session_count,
        "runs_today": run_stats.runs_today,
        "active_runs": run_stats.active_runs,
        "total_tokens": total_tokens,
        "daily_tokens": daily_tokens,
        "weekly_tokens": weekly_tokens
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

    use super::*;
    use crate::config::{
        AppConfig, CodexConfig, CorsConfig, FeishuConfig, GogcliOAuthConfig, LoggingConfig,
        SandboxConfig, SecurityConfig, SkillsConfig,
    };
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
}
