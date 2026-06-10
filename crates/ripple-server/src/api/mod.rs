pub mod auth;
pub mod bilibili;
pub mod capabilities;
pub mod chat;
pub mod connectors;
pub mod documents;
pub mod health;
pub mod memory;
pub mod models;
pub mod openapi;
pub(crate) mod run_public;
pub mod runs;
pub mod sandboxes;
pub mod schedule_chat;
pub mod schedules;
pub mod sessions;
pub mod skill_chat;
pub mod skills;
pub mod users;
pub mod workspace;

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderValue, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, delete, get, patch, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use utoipa_axum::router::OpenApiRouter;
use uuid::Uuid;

use crate::state::AppState;
use crate::user::{user_id_from_headers, AuthContext};

#[derive(Debug, Deserialize, Default, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ListQuery {
    pub limit: Option<usize>,
    pub cursor: Option<String>,
}

pub(crate) fn paginate<T>(items: Vec<T>, query: &ListQuery) -> (Vec<T>, Option<String>) {
    let total = items.len();
    let offset = query
        .cursor
        .as_deref()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0)
        .min(total);
    let limit = query.limit.unwrap_or(total).clamp(1, 100);
    let end = offset.saturating_add(limit).min(total);
    let next_cursor = (end < total).then(|| end.to_string());
    (
        items.into_iter().skip(offset).take(end - offset).collect(),
        next_cursor,
    )
}

pub(crate) fn require_confirm(payload: Option<&Value>, action: &str) -> Result<(), ApiError> {
    let confirmed = payload
        .and_then(|value| value.get("confirm"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if confirmed {
        return Ok(());
    }
    Err(ApiError::new(
        StatusCode::PRECONDITION_REQUIRED,
        json!({
            "code": "confirmation_required",
            "message": format!("{action} requires confirm: true"),
            "action": action,
            "confirm_required": true
        }),
    ))
}

pub(crate) async fn audit_event(
    state: &AppState,
    user_id: &str,
    action: &str,
    confirmed: bool,
    details: Value,
) -> Result<(), ApiError> {
    use tokio::io::AsyncWriteExt;

    let audit_path = state.config.repo_root.join(".ripple/audit.jsonl");
    if let Some(parent) = audit_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let record = json!({
        "version": 1,
        "event_id": format!("audit-{}", Uuid::new_v4().simple()),
        "action": action,
        "user_id": user_id,
        "confirmed": confirmed,
        "details": details,
        "created_at": now_iso()
    });
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(audit_path)
        .await?;
    let line = serde_json::to_string(&record).map_err(anyhow::Error::from)?;
    file.write_all(line.as_bytes()).await?;
    file.write_all(b"\n").await?;
    Ok(())
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

pub fn router(state: AppState) -> Router {
    let public_v1 = Router::new()
        .route("/auth/config", get(auth::auth_config))
        .route("/auth/invite/claim", post(auth::claim_invite))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/password", post(auth::change_password));

    let protected_v1: OpenApiRouter<AppState> = OpenApiRouter::new()
        .routes(utoipa_axum::routes!(models::list_models))
        .routes(utoipa_axum::routes!(models::system_info))
        .route("/tasks", any(sessions::deprecated_tasks_api))
        .route("/tasks/*task_path", any(sessions::deprecated_tasks_api))
        .routes(utoipa_axum::routes!(chat::chat_completions))
        .routes(utoipa_axum::routes!(health::ready))
        .routes(utoipa_axum::routes!(health::doctor))
        .route("/users/me", get(users::current_user_profile))
        .route(
            "/users/me/profile",
            patch(users::update_current_user_profile),
        )
        .route(
            "/users/me/avatar",
            post(users::upload_user_avatar)
                .delete(users::delete_user_avatar)
                .layer(DefaultBodyLimit::max(
                    users::USER_AVATAR_UPLOAD_BODY_LIMIT_BYTES,
                )),
        )
        .route("/users/me/avatar/:file_name", get(users::get_user_avatar))
        .route(
            "/sessions",
            get(sessions::list_sessions).post(sessions::create_session),
        )
        .route("/sessions/overview", get(sessions::session_overview))
        .route(
            "/sessions/suspended",
            get(sessions::list_suspended_sessions),
        )
        .route(
            "/sessions/:session_id",
            get(sessions::get_session)
                .patch(sessions::update_session)
                .delete(sessions::delete_session),
        )
        .route("/sessions/:session_id/stop", post(sessions::stop_session))
        .route(
            "/sessions/:session_id/memory/disable",
            post(sessions::disable_session_memory),
        )
        .route(
            "/sessions/:session_id/context/clear",
            post(sessions::clear_session_context),
        )
        .route(
            "/sessions/:session_id/context/compact",
            post(sessions::compact_session_context),
        )
        .route(
            "/sessions/:session_id/codex-thread",
            get(sessions::get_session_codex_thread),
        )
        .route(
            "/sessions/:session_id/suspend",
            post(sessions::suspend_session),
        )
        .route(
            "/sessions/:session_id/resume",
            post(sessions::resume_session),
        )
        .route(
            "/sessions/:session_id/permissions/resolve",
            post(sessions::resolve_permission_request),
        )
        .route(
            "/sessions/:session_id/connector-auth/poll",
            post(chat::poll_session_connector_auth),
        )
        .route(
            "/sessions/:session_id/connector-auth/cancel",
            post(sessions::cancel_connector_auth),
        )
        .route("/sessions/:session_id/usage", get(sessions::session_usage))
        .route(
            "/sandboxes",
            get(sandboxes::get_sandbox)
                .post(sandboxes::create_sandbox)
                .delete(sandboxes::delete_sandbox),
        )
        .route("/sandbox/info", get(sandboxes::sandbox_info))
        .route("/memory/status", get(memory::memory_status))
        .route("/memory/summary", get(memory::memory_summary))
        .route(
            "/memory/settings",
            patch(memory::update_memory_settings_handler),
        )
        .route("/memory/reset", post(memory::reset_memory))
        .route("/workspace", get(workspace::list_workspace))
        .route("/workspace/search", get(workspace::search_workspace))
        .route(
            "/workspace/file",
            get(workspace::get_workspace_file).put(workspace::save_workspace_file),
        )
        .route("/workspace/rename", post(workspace::rename_workspace))
        .route("/workspace/delete", post(workspace::delete_workspace))
        .route("/workspace/create", post(workspace::create_workspace))
        .route("/workspace/paste", post(workspace::paste_workspace))
        .route(
            "/workspace/upload",
            post(workspace::upload_workspace_files).layer(DefaultBodyLimit::max(
                workspace::WORKSPACE_UPLOAD_BODY_LIMIT_BYTES,
            )),
        )
        .route(
            "/workspace/attachments",
            post(workspace::upload_workspace_attachment).layer(DefaultBodyLimit::max(
                workspace::WORKSPACE_UPLOAD_BODY_LIMIT_BYTES,
            )),
        )
        .route(
            "/workspace/download",
            get(workspace::download_workspace_file),
        )
        .route("/workspace/preview", get(workspace::preview_workspace_file))
        .routes(utoipa_axum::routes!(capabilities::list_capabilities))
        .routes(utoipa_axum::routes!(skills::list_skills))
        .routes(utoipa_axum::routes!(skills::get_skill))
        .routes(utoipa_axum::routes!(skills::create_skill))
        .routes(utoipa_axum::routes!(skills::update_skill))
        .routes(utoipa_axum::routes!(skills::delete_skill))
        .routes(utoipa_axum::routes!(skills::validate_skill))
        .routes(utoipa_axum::routes!(connectors::list_connectors))
        .routes(utoipa_axum::routes!(connectors::connector_status))
        .routes(utoipa_axum::routes!(connectors::connector_auth_start))
        .routes(utoipa_axum::routes!(connectors::connector_auth_complete))
        .routes(utoipa_axum::routes!(connectors::connector_auth_cancel))
        .routes(utoipa_axum::routes!(connectors::connector_disconnect))
        .routes(utoipa_axum::routes!(connectors::connector_accounts))
        .route(
            "/sandboxes/gogcli-accounts",
            get(connectors::gogcli_accounts_alias),
        )
        .routes(utoipa_axum::routes!(runs::list_runs, runs::create_run))
        .routes(utoipa_axum::routes!(runs::get_run))
        .routes(utoipa_axum::routes!(runs::run_events))
        .routes(utoipa_axum::routes!(runs::run_output))
        .routes(utoipa_axum::routes!(runs::steer_run))
        .routes(utoipa_axum::routes!(runs::cancel_run))
        .route(
            "/documents",
            get(documents::list_documents).post(documents::create_document),
        )
        .route(
            "/documents/:document_id",
            get(documents::get_document)
                .patch(documents::update_document)
                .delete(documents::delete_document),
        )
        .route(
            "/schedules",
            get(schedules::list_schedules).post(schedules::create_schedule),
        )
        .route(
            "/schedules/:schedule_id",
            get(schedules::get_schedule)
                .patch(schedules::update_schedule)
                .delete(schedules::delete_schedule),
        )
        .route(
            "/schedules/:schedule_id/runs",
            get(schedules::schedule_runs),
        )
        .route(
            "/schedules/:schedule_id/runs/:job_id",
            delete(schedules::delete_schedule_run),
        )
        .route(
            "/schedules/:schedule_id/run-now",
            post(schedules::run_schedule_now),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_api_key,
        ));

    let v1: OpenApiRouter<AppState> = OpenApiRouter::from(public_v1).merge(protected_v1);
    let root: OpenApiRouter<AppState> = OpenApiRouter::with_openapi(openapi::base_openapi())
        .routes(utoipa_axum::routes!(health::health))
        .route("/v1/bilibili/qrcode.png", get(bilibili::qrcode_png))
        .route(
            "/v1/sandboxes/gogcli/oauth/callback",
            get(connectors::gogcli_oauth_callback),
        )
        .nest("/v1", v1);
    let (mut router, openapi) = root.split_for_parts();
    if state.config.api_docs.enabled {
        router = router.merge(openapi::docs_router(
            openapi,
            state.config.api_docs.try_it_out_enabled,
        ));
    }
    router.with_state(state)
}

async fn require_api_key(
    State(state): State<AppState>,
    mut request: Request<Body>,
    next: Next,
) -> Result<Response, ApiError> {
    let auth_context = authenticate_request(&state, request.headers()).await?;
    let effective_user_id = auth_context.effective_user_id.clone();
    let header_value = HeaderValue::from_str(&effective_user_id)
        .map_err(|err| ApiError::bad_request(err.to_string()))?;
    request
        .headers_mut()
        .insert("x-ripple-user-id", header_value);
    request.extensions_mut().insert(auth_context);
    Ok(next.run(request).await)
}

async fn authenticate_request(
    state: &AppState,
    headers: &axum::http::HeaderMap,
) -> Result<AuthContext, ApiError> {
    if state.config.api_keys.is_empty() && !state.config.user_auth.enabled {
        let user_id = user_id_from_headers(headers).map_err(ApiError::bad_request)?;
        return Ok(AuthContext::open(user_id));
    }

    let bearer = supplied_bearer_token(headers);
    let supplied = bearer.or_else(|| supplied_x_api_key(headers));
    if let Some(key) = supplied {
        if state.config.api_keys.iter().any(|expected| expected == key) {
            let user_id = user_id_from_headers(headers).map_err(ApiError::bad_request)?;
            return Ok(AuthContext::service(user_id));
        }
    }

    if state.config.user_auth.enabled {
        if let Some(token) = bearer {
            if let Some(session) =
                crate::auth::authenticate_session_token(&state.storage, token).await?
            {
                return Ok(AuthContext::user(session.user_id));
            }
        }
        return Err(invalid_api_key());
    }

    if supplied.is_some() {
        return Err(invalid_api_key());
    }

    Err(invalid_api_key())
}

fn supplied_bearer_token(headers: &axum::http::HeaderMap) -> Option<&str> {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|key| !key.is_empty())
}

fn supplied_x_api_key(headers: &axum::http::HeaderMap) -> Option<&str> {
    headers
        .get("x-api-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|key| !key.is_empty())
}

fn invalid_api_key() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "Invalid or missing API key")
}

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    detail: Value,
}

impl ApiError {
    pub fn new(status: StatusCode, detail: impl Into<Value>) -> Self {
        Self {
            status,
            detail: detail.into(),
        }
    }

    pub fn bad_request(detail: impl Into<Value>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, detail)
    }

    pub fn not_found(detail: impl Into<Value>) -> Self {
        Self::new(StatusCode::NOT_FOUND, detail)
    }

    pub fn conflict(detail: impl Into<Value>) -> Self {
        Self::new(StatusCode::CONFLICT, detail)
    }

    pub fn not_implemented(detail: impl Into<Value>) -> Self {
        Self::new(StatusCode::NOT_IMPLEMENTED, detail)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let request_id = format!("req-{}", Uuid::new_v4().simple());
        let (code, message, details) = error_fields(self.status, &self.detail);
        let mut response = (
            self.status,
            Json(json!({
                "detail": self.detail,
                "error": {
                    "code": code,
                    "message": message,
                    "request_id": request_id,
                    "details": details
                }
            })),
        )
            .into_response();
        response.headers_mut().insert(
            "x-request-id",
            HeaderValue::from_str(&request_id).unwrap_or_else(|_| HeaderValue::from_static("")),
        );
        response
    }
}

fn error_fields(status: StatusCode, detail: &Value) -> (String, String, Value) {
    let status_code = status_code_slug(status).to_string();
    match detail {
        Value::Object(object) => {
            let code = object
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or(&status_code)
                .to_string();
            let message = object
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| object.get("detail").and_then(Value::as_str))
                .map(str::to_string)
                .unwrap_or_else(|| {
                    status
                        .canonical_reason()
                        .unwrap_or("Request failed")
                        .to_string()
                });
            (code, message, detail.clone())
        }
        Value::String(message) => (status_code, message.clone(), detail.clone()),
        _ => (
            status_code,
            status
                .canonical_reason()
                .unwrap_or("Request failed")
                .to_string(),
            detail.clone(),
        ),
    }
}

fn status_code_slug(status: StatusCode) -> &'static str {
    match status {
        StatusCode::BAD_REQUEST => "bad_request",
        StatusCode::UNAUTHORIZED => "unauthorized",
        StatusCode::FORBIDDEN => "forbidden",
        StatusCode::NOT_FOUND => "not_found",
        StatusCode::CONFLICT => "conflict",
        StatusCode::GONE => "gone",
        StatusCode::PRECONDITION_REQUIRED => "precondition_required",
        StatusCode::SERVICE_UNAVAILABLE => "service_unavailable",
        StatusCode::GATEWAY_TIMEOUT => "gateway_timeout",
        StatusCode::NOT_IMPLEMENTED => "not_implemented",
        _ => "request_failed",
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(value: anyhow::Error) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, value.to_string())
    }
}

impl From<std::io::Error> for ApiError {
    fn from(value: std::io::Error) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use axum::body::{to_bytes, Body};
    use axum::http::{header, Method, Request, StatusCode};
    use serde_json::{json, Value};
    use tower::ServiceExt;

    use super::*;
    use crate::config::{
        AppConfig, CodexConfig, CorsConfig, FeishuConfig, GogcliOAuthConfig, LoggingConfig,
        SandboxConfig, SecurityConfig, SkillsConfig, UserAuthConfig,
    };
    fn test_state(api_keys: Vec<String>) -> AppState {
        test_state_with_shared_dirs(api_keys, Vec::new())
    }

    fn test_state_with_shared_dirs(api_keys: Vec<String>, shared_dirs: Vec<String>) -> AppState {
        let root =
            std::env::temp_dir().join(format!("ripple-api-auth-test-{}", uuid::Uuid::new_v4()));
        test_state_from_root(api_keys, shared_dirs, root, None, None)
    }

    fn test_state_with_shared_dirs_and_google_cli(
        api_keys: Vec<String>,
        shared_dirs: Vec<String>,
        gogcli_cli_install_root: std::path::PathBuf,
        nsjail_path: std::path::PathBuf,
    ) -> AppState {
        let root =
            std::env::temp_dir().join(format!("ripple-api-auth-test-{}", uuid::Uuid::new_v4()));
        test_state_from_root(
            api_keys,
            shared_dirs,
            root,
            Some(gogcli_cli_install_root),
            Some(nsjail_path),
        )
    }

    fn test_state_from_root(
        api_keys: Vec<String>,
        shared_dirs: Vec<String>,
        root: std::path::PathBuf,
        gogcli_cli_install_root: Option<std::path::PathBuf>,
        nsjail_path: Option<std::path::PathBuf>,
    ) -> AppState {
        AppState::new(AppConfig {
            repo_root: root.clone(),
            host: "127.0.0.1".to_string(),
            port: 0,
            api_keys,
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
                nsjail_path: nsjail_path
                    .map(|path| path.to_string_lossy().to_string())
                    .unwrap_or_else(|| "nsjail".to_string()),
                python_envs_root: root.join("cache/python-envs"),
                python_env_uv_cache: root.join("cache/uv-cache"),
                python_env_max_packages: 20,
                uv_bin_dir: None,
                node_dir: None,
                lark_cli_install_root: None,
                notion_cli_install_root: None,
                gogcli_cli_install_root,
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
            skills: SkillsConfig { shared_dirs },
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

    async fn request_json(
        state: AppState,
        method: Method,
        path: &str,
        key: &str,
        user_id: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(path);
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {key}"));
        if let Some(user_id) = user_id {
            builder = builder.header("X-Ripple-User-Id", user_id);
        }
        if body.is_some() {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
        }
        let body = body
            .map(|value| Body::from(value.to_string()))
            .unwrap_or_else(Body::empty);
        let response = router(state)
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}));
        (status, value)
    }

    async fn request_bytes(
        state: AppState,
        method: Method,
        path: &str,
        key: &str,
        user_id: Option<&str>,
        content_type: Option<&str>,
        body: Vec<u8>,
    ) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        let mut builder = Request::builder().method(method).uri(path);
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {key}"));
        if let Some(user_id) = user_id {
            builder = builder.header("X-Ripple-User-Id", user_id);
        }
        if let Some(content_type) = content_type {
            builder = builder.header(header::CONTENT_TYPE, content_type);
        }
        let response = router(state)
            .oneshot(builder.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec();
        (status, headers, bytes)
    }

    #[tokio::test]
    async fn service_key_uses_trusted_header_user() {
        let state = test_state(vec!["service-key".to_string()]);

        let (status, body) = request_json(
            state,
            Method::GET,
            "/v1/users/me",
            "service-key",
            Some("upstream-user"),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body.get("user_id").and_then(Value::as_str),
            Some("upstream-user")
        );
        assert_eq!(
            body.pointer("/auth/kind").and_then(Value::as_str),
            Some("service")
        );
    }

    #[tokio::test]
    async fn service_key_defaults_to_default_user_without_header() {
        let state = test_state(vec!["service-key".to_string()]);

        let (status, body) = request_json(
            state,
            Method::GET,
            "/v1/users/me",
            "service-key",
            None,
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.get("user_id").and_then(Value::as_str), Some("default"));
        assert_eq!(
            body.pointer("/auth/kind").and_then(Value::as_str),
            Some("service")
        );
    }

    #[tokio::test]
    async fn avatar_upload_persists_profile_uri_and_serves_image_file() {
        let state = test_state(vec!["service-key".to_string()]);
        let boundary = "ripple-avatar-boundary";
        let avatar_bytes = b"\x89PNG\r\n\x1a\nripple-avatar";
        let mut body = Vec::new();
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"avatar\"; filename=\"avatar.png\"\r\nContent-Type: image/png\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(avatar_bytes);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

        let (status, _, bytes) = request_bytes(
            state.clone(),
            Method::POST,
            "/v1/users/me/avatar",
            "service-key",
            Some("avatar-user"),
            Some(&format!("multipart/form-data; boundary={boundary}")),
            body,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let uploaded: Value = serde_json::from_slice(&bytes).unwrap();
        let avatar_uri = uploaded
            .pointer("/profile/avatar_uri")
            .and_then(Value::as_str)
            .expect("avatar uri should be present");
        assert!(avatar_uri.starts_with("/v1/users/me/avatar/"));

        let (status, profile) = request_json(
            state.clone(),
            Method::GET,
            "/v1/users/me",
            "service-key",
            Some("avatar-user"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            profile
                .pointer("/profile/avatar_uri")
                .and_then(Value::as_str),
            Some(avatar_uri)
        );

        let (status, headers, bytes) = request_bytes(
            state,
            Method::GET,
            avatar_uri,
            "service-key",
            Some("avatar-user"),
            None,
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some("image/png")
        );
        assert_eq!(bytes, avatar_bytes);
    }

    #[tokio::test]
    async fn invalid_service_key_is_rejected() {
        let state = test_state(vec!["service-key".to_string()]);

        let (status, _) =
            request_json(state, Method::GET, "/v1/users/me", "wrong-key", None, None).await;

        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn open_dev_mode_uses_header_user() {
        let state = test_state(Vec::new());

        let (status, body) = request_json(
            state,
            Method::GET,
            "/v1/users/me",
            "ignored-key",
            Some("dev-user"),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body.get("user_id").and_then(Value::as_str),
            Some("dev-user")
        );
        assert_eq!(
            body.pointer("/auth/kind").and_then(Value::as_str),
            Some("open")
        );
    }

    #[tokio::test]
    async fn invalid_header_user_is_rejected() {
        let state = test_state(vec!["service-key".to_string()]);

        let (status, body) = request_json(
            state,
            Method::GET,
            "/v1/users/me",
            "service-key",
            Some("../alice"),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body.get("detail").and_then(Value::as_str),
            Some("user_id must match ^[a-zA-Z0-9_-]{1,64}$")
        );
    }

    #[tokio::test]
    async fn sandbox_info_does_not_expose_host_paths() {
        let root = std::env::temp_dir().join(format!(
            "ripple-api-sandbox-info-paths-{}",
            uuid::Uuid::new_v4()
        ));
        let state = test_state_from_root(
            vec!["service-key".to_string()],
            Vec::new(),
            root.clone(),
            None,
            None,
        );

        let (status, body) = request_json(
            state,
            Method::GET,
            "/v1/sandbox/info",
            "service-key",
            Some("sandbox-info-user"),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body.get("sandboxes_root").and_then(Value::as_str),
            Some("/sandbox")
        );
        assert_eq!(
            body.get("caches_root").and_then(Value::as_str),
            Some("/cache")
        );
        assert!(!body.to_string().contains(root.to_string_lossy().as_ref()));

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn health_ready_does_not_expose_host_paths() {
        let root = std::env::temp_dir().join(format!(
            "ripple-api-health-ready-paths-{}",
            uuid::Uuid::new_v4()
        ));
        let state = test_state_from_root(
            vec!["service-key".to_string()],
            Vec::new(),
            root.clone(),
            None,
            None,
        );

        let (status, body) = request_json(
            state,
            Method::GET,
            "/v1/health/ready",
            "service-key",
            Some("health-ready-user"),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        let body_text = body.to_string();
        assert!(!body_text.contains(root.to_string_lossy().as_ref()));
        assert!(body_text.contains("/sandbox") || body_text.contains("/cache"));

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn diagnostics_doctor_http_does_not_expose_host_paths() {
        let root =
            std::env::temp_dir().join(format!("ripple-api-doctor-paths-{}", uuid::Uuid::new_v4()));
        let state = test_state_from_root(
            vec!["service-key".to_string()],
            Vec::new(),
            root.clone(),
            None,
            None,
        );

        let (status, body) = request_json(
            state,
            Method::GET,
            "/v1/diagnostics/doctor",
            "service-key",
            Some("doctor-user"),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        let body_text = body.to_string();
        assert!(!body_text.contains(root.to_string_lossy().as_ref()));
        assert!(body_text.contains("/sandbox") || body_text.contains("/cache"));

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn capabilities_route_lists_connectors_runtime_and_skills() {
        let shared_root = std::env::temp_dir().join(format!(
            "ripple-api-shared-skills-test-{}",
            uuid::Uuid::new_v4()
        ));
        let shared_skill = shared_root.join("demo/SKILL.md");
        std::fs::create_dir_all(shared_skill.parent().unwrap()).unwrap();
        std::fs::write(
            &shared_skill,
            "---\nname: shared-demo\ndescription: Shared demo\n---\n# Shared demo\n",
        )
        .unwrap();
        let state = test_state_with_shared_dirs(
            vec!["service-key".to_string()],
            vec![shared_root.to_string_lossy().to_string()],
        );
        let workspace = state.sandboxes.ensure_sandbox("skill-user").unwrap();
        let user_skill = workspace.join("skills/user-demo/SKILL.md");
        std::fs::create_dir_all(user_skill.parent().unwrap()).unwrap();
        std::fs::write(
            &user_skill,
            "---\nname: user-demo\ndescription: User demo\n---\n# User demo\n",
        )
        .unwrap();

        let (status, body) = request_json(
            state,
            Method::GET,
            "/v1/capabilities",
            "service-key",
            Some("skill-user"),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        let capabilities = body
            .get("capabilities")
            .and_then(Value::as_array)
            .expect("capabilities array");
        assert!(capabilities.iter().any(|entry| {
            entry.get("id").and_then(Value::as_str) == Some("connector:google_workspace")
                && entry.get("type").and_then(Value::as_str) == Some("connector")
        }));
        assert!(capabilities.iter().any(|entry| {
            entry.get("id").and_then(Value::as_str) == Some("runtime:codex_web_search")
                && entry.get("type").and_then(Value::as_str) == Some("runtime_capability")
        }));
        assert!(capabilities.iter().any(|entry| {
            entry.get("id").and_then(Value::as_str) == Some("ripple:shared-demo")
                && entry.get("type").and_then(Value::as_str) == Some("skill")
                && entry.get("enabled").and_then(Value::as_bool) == Some(true)
        }));
        assert!(capabilities.iter().any(|entry| {
            entry.get("id").and_then(Value::as_str) == Some("user:user-demo")
                && entry.get("type").and_then(Value::as_str) == Some("skill")
                && entry.get("enabled").and_then(Value::as_bool) == Some(false)
                && entry.get("status").and_then(Value::as_str) == Some("pending_enable")
        }));
        let user_capability = capabilities
            .iter()
            .find(|entry| entry.get("id").and_then(Value::as_str) == Some("user:user-demo"))
            .expect("user skill capability");
        assert_eq!(
            user_capability
                .pointer("/skill/path")
                .and_then(Value::as_str),
            Some("/workspace/skills/user-demo/SKILL.md")
        );
        assert!(!user_capability
            .pointer("/skill/path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains(workspace.to_string_lossy().as_ref()));

        let _ = std::fs::remove_dir_all(shared_root);
    }

    #[tokio::test]
    async fn skill_patch_allows_confirmation_required_skill_after_auto_validation() {
        let state = test_state(vec!["service-key".to_string()]);
        let workspace = state
            .sandboxes
            .ensure_sandbox("skill-confirm-user")
            .unwrap();

        let (status, created) = request_json(
            state.clone(),
            Method::POST,
            "/v1/skills",
            "service-key",
            Some("skill-confirm-user"),
            Some(json!({
                "display_name": "Careful Review",
                "description": "Review work that needs explicit confirmation.",
                "steps": ["Inspect the request", "Ask before risky actions"],
                "requires_connectors": [],
                "requires_user_confirmation": true
            })),
        )
        .await;

        assert_eq!(status, StatusCode::CREATED);
        let skill_id = created.get("id").and_then(Value::as_str).expect("skill id");
        assert_eq!(
            created.get("desired_state").and_then(Value::as_str),
            Some("pending_confirmation")
        );
        assert_eq!(
            created.get("user_status").and_then(Value::as_str),
            Some("needs_confirmation")
        );
        assert_eq!(
            created
                .pointer("/validation/passed")
                .and_then(Value::as_bool),
            Some(true)
        );

        let rendered_before_enable = crate::skills::render_skill_manifest_with_options(
            &state.config,
            Some(&workspace),
            &crate::api::skills::skill_manifest_options_for_user(&state, "skill-confirm-user")
                .unwrap(),
        );
        assert!(!rendered_before_enable.contains(skill_id));

        let (status, enabled) = request_json(
            state,
            Method::PATCH,
            &format!("/v1/skills/{skill_id}"),
            "service-key",
            Some("skill-confirm-user"),
            Some(json!({"enabled": true})),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            enabled.get("desired_state").and_then(Value::as_str),
            Some("enabled")
        );
        assert_eq!(
            enabled.get("user_status").and_then(Value::as_str),
            Some("available")
        );
    }

    #[tokio::test]
    async fn skills_route_returns_user_facing_skills_without_runtime_capabilities() {
        let shared_root = std::env::temp_dir().join(format!(
            "ripple-api-skills-v2-shared-{}",
            uuid::Uuid::new_v4()
        ));
        let shared_skill = shared_root.join("shared-demo/SKILL.md");
        std::fs::create_dir_all(shared_skill.parent().unwrap()).unwrap();
        std::fs::write(
            &shared_skill,
            "---\nname: shared-demo\ndescription: Shared demo\n---\n# Shared demo\n",
        )
        .unwrap();
        let state = test_state_with_shared_dirs(
            vec!["service-key".to_string()],
            vec![shared_root.to_string_lossy().to_string()],
        );
        let workspace = state.sandboxes.ensure_sandbox("skill-user").unwrap();
        let user_skill = workspace.join("skills/user-demo/SKILL.md");
        std::fs::create_dir_all(user_skill.parent().unwrap()).unwrap();
        std::fs::write(
            &user_skill,
            "---\nname: user-demo\ndescription: User demo\n---\n# User demo\n",
        )
        .unwrap();

        let (status, body) = request_json(
            state,
            Method::GET,
            "/v1/skills",
            "service-key",
            Some("skill-user"),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        let skills = body
            .get("skills")
            .and_then(Value::as_array)
            .expect("skills array");
        assert!(skills.iter().any(|entry| {
            entry.get("id").and_then(Value::as_str) == Some("ripple:shared-demo")
                && entry.get("read_only").and_then(Value::as_bool) == Some(true)
                && entry.get("user_status").and_then(Value::as_str) == Some("available")
        }));
        let user_entry = skills
            .iter()
            .find(|entry| entry.get("id").and_then(Value::as_str) == Some("user:user-demo"))
            .expect("user skill entry");
        assert_eq!(
            user_entry.get("read_only").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            user_entry.get("desired_state").and_then(Value::as_str),
            Some("draft")
        );
        assert_eq!(
            user_entry.get("user_status").and_then(Value::as_str),
            Some("needs_fix")
        );
        assert_eq!(
            user_entry.get("path").and_then(Value::as_str),
            Some("/workspace/skills/user-demo/SKILL.md")
        );
        assert!(!user_entry
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains(workspace.to_string_lossy().as_ref()));
        assert!(!skills.iter().any(|entry| {
            entry.get("type").and_then(Value::as_str) == Some("runtime_capability")
                || entry
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .starts_with("runtime:")
        }));

        let _ = std::fs::remove_dir_all(shared_root);
    }

    #[tokio::test]
    async fn skills_route_uses_lightweight_google_status_without_cli_check() {
        let fake_gog_root = std::env::temp_dir().join(format!(
            "ripple-api-skills-gog-root-{}",
            uuid::Uuid::new_v4()
        ));
        let fake_gog = fake_gog_root.join("current/bin/gog");
        std::fs::create_dir_all(fake_gog.parent().unwrap()).unwrap();
        std::fs::write(&fake_gog, "#!/bin/sh\nexit 0\n").unwrap();

        let marker = fake_gog_root.join("gog-invoked");
        let fake_nsjail = fake_gog_root.join("fake-nsjail");
        std::fs::write(
            &fake_nsjail,
            format!(
                "#!/bin/sh\ntouch '{}'\nprintf '{{\"accounts\":[]}}'\n",
                marker.display()
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake_gog, std::fs::Permissions::from_mode(0o755)).unwrap();
            std::fs::set_permissions(&fake_nsjail, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(std::path::Path::parent)
            .unwrap()
            .to_path_buf();
        let state = test_state_with_shared_dirs_and_google_cli(
            vec!["service-key".to_string()],
            vec![repo_root.join("skills/gog").to_string_lossy().to_string()],
            fake_gog_root.clone(),
            fake_nsjail,
        );
        let workspace = state.sandboxes.ensure_sandbox("skill-gog-user").unwrap();
        let keyring = workspace.join(".config/gogcli/keyring");
        std::fs::create_dir_all(keyring.parent().unwrap()).unwrap();
        std::fs::write(&keyring, "stale-keyring").unwrap();

        let (status, body) = request_json(
            state,
            Method::GET,
            "/v1/skills",
            "service-key",
            Some("skill-gog-user"),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        let skills = body
            .get("skills")
            .and_then(Value::as_array)
            .expect("skills array");
        let sheets = skills
            .iter()
            .find(|entry| entry.get("id").and_then(Value::as_str) == Some("ripple:gog-sheets"))
            .expect("gog-sheets skill");
        assert!(
            !marker.exists(),
            "skills listing should not invoke gog status checks"
        );
        assert_eq!(
            sheets.get("user_status").and_then(Value::as_str),
            Some("available")
        );
        assert_eq!(sheets.get("enabled").and_then(Value::as_bool), Some(true));

        let _ = std::fs::remove_dir_all(fake_gog_root);
    }

    #[tokio::test]
    async fn user_skill_validation_uses_real_google_account_status() {
        let fake_gog_root = std::env::temp_dir().join(format!(
            "ripple-api-skills-gog-root-{}",
            uuid::Uuid::new_v4()
        ));
        let fake_gog = fake_gog_root.join("current/bin/gog");
        std::fs::create_dir_all(fake_gog.parent().unwrap()).unwrap();
        std::fs::write(&fake_gog, "#!/bin/sh\nexit 0\n").unwrap();

        let fake_nsjail = fake_gog_root.join("fake-nsjail");
        std::fs::write(
            &fake_nsjail,
            "#!/bin/sh\ncase \" $* \" in\n  *\" --check \"*) printf '{\"accounts\":[]}' ;;\n  *) printf '{\"accounts\":[{\"email\":\"stale@example.com\"}]}' ;;\nesac\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake_gog, std::fs::Permissions::from_mode(0o755)).unwrap();
            std::fs::set_permissions(&fake_nsjail, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let state = test_state_with_shared_dirs_and_google_cli(
            vec!["service-key".to_string()],
            Vec::new(),
            fake_gog_root.clone(),
            fake_nsjail,
        );
        let workspace = state
            .sandboxes
            .ensure_sandbox("skill-google-validation-user")
            .unwrap();
        let keyring = workspace.join(".config/gogcli/keyring");
        std::fs::create_dir_all(keyring.parent().unwrap()).unwrap();
        std::fs::write(&keyring, "stale-keyring").unwrap();

        let (status, created) = request_json(
            state.clone(),
            Method::POST,
            "/v1/skills",
            "service-key",
            Some("skill-google-validation-user"),
            Some(json!({
                "display_name": "Google Draft",
                "description": "Use Google Workspace.",
                "steps": ["Read recent mail"],
                "requires_connectors": ["google_workspace"],
                "requires_user_confirmation": false
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(
            created
                .pointer("/validation/passed")
                .and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            created.get("user_status").and_then(Value::as_str),
            Some("needs_connection")
        );
        assert!(created
            .pointer("/validation/checks")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .any(|check| {
                check.get("name").and_then(Value::as_str) == Some("dependencies")
                    && check.get("status").and_then(Value::as_str) == Some("failed")
            }));

        let _ = std::fs::remove_dir_all(fake_gog_root);
    }

    #[tokio::test]
    async fn user_skill_crud_validation_and_archive_flow() {
        let state = test_state(vec!["service-key".to_string()]);
        let workspace = state.sandboxes.ensure_sandbox("skill-crud-user").unwrap();

        let (status, created) = request_json(
            state.clone(),
            Method::POST,
            "/v1/skills",
            "service-key",
            Some("skill-crud-user"),
            Some(json!({
                "display_name": "Project Weekly Review",
                "description": "Summarize project updates into my weekly review format.",
                "when_to_use": "When I ask for a project weekly review.",
                "steps": ["Collect updates", "Group risks and next actions"],
                "output_format": "A short weekly review with sections for progress, risks, and next actions.",
                "requires_connectors": [],
                "requires_user_confirmation": false,
                "test_example": "Create a weekly review from two sample updates."
            })),
        )
        .await;

        assert_eq!(status, StatusCode::CREATED);
        let skill_id = created
            .get("id")
            .and_then(Value::as_str)
            .expect("created skill id")
            .to_string();
        assert!(skill_id.starts_with("user:"));
        assert_eq!(
            created.get("desired_state").and_then(Value::as_str),
            Some("enabled")
        );
        assert_eq!(
            created.get("user_status").and_then(Value::as_str),
            Some("available")
        );
        assert_eq!(
            created
                .pointer("/validation/passed")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            created
                .pointer("/validation/checks")
                .and_then(Value::as_array)
                .unwrap()
                .iter()
                .filter(|check| check.get("status").and_then(Value::as_str) == Some("passed"))
                .count(),
            5
        );
        assert!(workspace
            .join("skills/project-weekly-review/SKILL.md")
            .is_file());

        let rendered = crate::skills::render_skill_manifest_with_options(
            &state.config,
            Some(&workspace),
            &crate::api::skills::skill_manifest_options_for_user(&state, "skill-crud-user")
                .unwrap(),
        );
        assert!(rendered.contains(&skill_id));

        let (status, archived) = request_json(
            state.clone(),
            Method::DELETE,
            &format!("/v1/skills/{skill_id}"),
            "service-key",
            Some("skill-crud-user"),
            Some(json!({"confirm": true})),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            archived.get("desired_state").and_then(Value::as_str),
            Some("archived")
        );
        assert!(!workspace
            .join("skills/project-weekly-review/SKILL.md")
            .exists());

        let rendered = crate::skills::render_skill_manifest_with_options(
            &state.config,
            Some(&workspace),
            &crate::api::skills::skill_manifest_options_for_user(&state, "skill-crud-user")
                .unwrap(),
        );
        assert!(!rendered.contains(&skill_id));
    }

    #[tokio::test]
    async fn skill_patch_preserves_existing_body_and_safety_sections() {
        let state = test_state(vec!["service-key".to_string()]);
        let workspace = state
            .sandboxes
            .ensure_sandbox("skill-patch-preserve-user")
            .unwrap();

        let (status, created) = request_json(
            state.clone(),
            Method::POST,
            "/v1/skills",
            "service-key",
            Some("skill-patch-preserve-user"),
            Some(json!({
                "display_name": "Risky Review",
                "description": "Initial description.",
                "when_to_use": "When reviewing risky changes.",
                "steps": ["Collect risky changes", "Ask before writing"],
                "output_format": "A concise risk report.",
                "requires_connectors": ["notion"],
                "requires_user_confirmation": true,
                "test_example": "Review two risky changes."
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let skill_id = created.get("id").and_then(Value::as_str).expect("skill id");

        let (status, _updated) = request_json(
            state,
            Method::PATCH,
            &format!("/v1/skills/{skill_id}"),
            "service-key",
            Some("skill-patch-preserve-user"),
            Some(json!({
                "description": "Updated description."
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let text = std::fs::read_to_string(workspace.join("skills/risky-review/SKILL.md")).unwrap();
        assert!(text.contains("description: Updated description."));
        assert!(text.contains("- Collect risky changes"));
        assert!(text.contains("- Ask before writing"));
        assert!(text.contains("A concise risk report."));
        assert!(text.contains("- User confirmation required: yes"));
        assert!(text.contains("Review two risky changes."));
        assert!(text.contains("connectors:"));
        assert!(text.contains("- notion"));
    }

    #[tokio::test]
    async fn python_user_skill_validates_hash_and_requires_current_hash_to_render() {
        let state = test_state(vec!["service-key".to_string()]);
        let workspace = state.sandboxes.ensure_sandbox("python-skill-user").unwrap();

        let (status, created) = request_json(
            state.clone(),
            Method::POST,
            "/v1/skills",
            "service-key",
            Some("python-skill-user"),
            Some(json!({
                "display_name": "Python Report",
                "description": "Create a report with a Python helper.",
                "when_to_use": "When I ask for a Python-generated report.",
                "kind": "executable",
                "runtime": "python",
                "entry": "scripts/run.py",
                "python_packages": ["pandas==2.2.3"],
                "script": "import pandas as pd\nprint(pd.__name__)\n",
                "requires_connectors": [],
                "requires_user_confirmation": false
            })),
        )
        .await;

        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(
            created.get("kind").and_then(Value::as_str),
            Some("executable")
        );
        assert_eq!(
            created.get("runtime").and_then(Value::as_str),
            Some("python")
        );
        assert_eq!(
            created.get("entry").and_then(Value::as_str),
            Some("scripts/run.py")
        );
        assert_eq!(
            created
                .get("python_packages")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(1)
        );
        let skill_id = created
            .get("id")
            .and_then(Value::as_str)
            .expect("created skill id")
            .to_string();
        assert!(workspace
            .join("skills/python-report/scripts/run.py")
            .is_file());
        assert_eq!(
            created.get("desired_state").and_then(Value::as_str),
            Some("enabled")
        );
        assert_eq!(
            created.get("user_status").and_then(Value::as_str),
            Some("available")
        );
        assert_eq!(
            created
                .pointer("/validation/passed")
                .and_then(Value::as_bool),
            Some(true)
        );
        let validated_hash = created
            .pointer("/validation/content_hash")
            .and_then(Value::as_str)
            .expect("validation hash")
            .to_string();
        assert_eq!(
            created.get("content_hash").and_then(Value::as_str),
            Some(validated_hash.as_str())
        );

        let rendered = crate::skills::render_skill_manifest_with_options(
            &state.config,
            Some(&workspace),
            &crate::api::skills::skill_manifest_options_for_user(&state, "python-skill-user")
                .unwrap(),
        );
        assert!(rendered.contains(&skill_id));
        assert!(rendered.contains("ripple-py python --with pandas==2.2.3 --"));

        std::fs::write(
            workspace.join("skills/python-report/scripts/run.py"),
            "print('changed')\n",
        )
        .unwrap();
        let rendered_after_change = crate::skills::render_skill_manifest_with_options(
            &state.config,
            Some(&workspace),
            &crate::api::skills::skill_manifest_options_for_user(&state, "python-skill-user")
                .unwrap(),
        );
        assert!(rendered_after_change.contains(&skill_id));

        let (status, refreshed) = request_json(
            state.clone(),
            Method::GET,
            &format!("/v1/skills/{skill_id}"),
            "service-key",
            Some("python-skill-user"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            refreshed.get("user_status").and_then(Value::as_str),
            Some("available")
        );
        assert_ne!(
            refreshed.pointer("/validation/content_hash"),
            created.pointer("/validation/content_hash")
        );

        let (status, disabled) = request_json(
            state.clone(),
            Method::PATCH,
            &format!("/v1/skills/{skill_id}"),
            "service-key",
            Some("python-skill-user"),
            Some(json!({"enabled": false})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            disabled.get("desired_state").and_then(Value::as_str),
            Some("disabled")
        );

        std::fs::write(
            workspace.join("skills/python-report/scripts/run.py"),
            "print('changed while disabled')\n",
        )
        .unwrap();
        let rendered_after_disabled_change = crate::skills::render_skill_manifest_with_options(
            &state.config,
            Some(&workspace),
            &crate::api::skills::skill_manifest_options_for_user(&state, "python-skill-user")
                .unwrap(),
        );
        assert!(!rendered_after_disabled_change.contains(&skill_id));
    }

    #[tokio::test]
    async fn user_python_skill_validation_rejects_non_python_runtime_and_unsafe_entry() {
        let state = test_state(vec!["service-key".to_string()]);
        state
            .sandboxes
            .ensure_sandbox("invalid-python-skill-user")
            .unwrap();

        let (status, created) = request_json(
            state.clone(),
            Method::POST,
            "/v1/skills",
            "service-key",
            Some("invalid-python-skill-user"),
            Some(json!({
                "display_name": "Unsupported Runtime Skill",
                "description": "Attempt to run an unsupported executable runtime.",
                "kind": "executable",
                "runtime": "ruby",
                "entry": "../run.rb",
                "script": "puts 'nope'",
                "requires_connectors": []
            })),
        )
        .await;

        assert_eq!(status, StatusCode::CREATED);
        let skill_id = created
            .get("id")
            .and_then(Value::as_str)
            .expect("created skill id");

        let (status, validation) = request_json(
            state.clone(),
            Method::POST,
            &format!("/v1/skills/{skill_id}/validate"),
            "service-key",
            Some("invalid-python-skill-user"),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            validation.get("passed").and_then(Value::as_bool),
            Some(false)
        );
        let issues = validation
            .get("issues")
            .and_then(Value::as_array)
            .expect("issues");
        assert!(issues.iter().any(|issue| {
            issue
                .as_str()
                .unwrap_or_default()
                .contains("Only Python executable skills are supported")
        }));
        assert!(issues.iter().any(|issue| {
            issue
                .as_str()
                .unwrap_or_default()
                .contains("entry must be a relative path inside the skill directory")
        }));
    }

    #[tokio::test]
    async fn shared_skills_are_read_only_for_user_skill_routes() {
        let shared_root = std::env::temp_dir().join(format!(
            "ripple-api-skills-v2-readonly-{}",
            uuid::Uuid::new_v4()
        ));
        let shared_skill = shared_root.join("shared-demo/SKILL.md");
        std::fs::create_dir_all(shared_skill.parent().unwrap()).unwrap();
        std::fs::write(
            &shared_skill,
            "---\nname: shared-demo\ndescription: Shared demo\n---\n# Shared demo\n",
        )
        .unwrap();
        let state = test_state_with_shared_dirs(
            vec!["service-key".to_string()],
            vec![shared_root.to_string_lossy().to_string()],
        );

        let (status, patch_body) = request_json(
            state.clone(),
            Method::PATCH,
            "/v1/skills/ripple:shared-demo",
            "service-key",
            Some("skill-user"),
            Some(json!({"enabled": false})),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(
            patch_body.pointer("/error/code").and_then(Value::as_str),
            Some("read_only")
        );

        let (status, delete_body) = request_json(
            state,
            Method::DELETE,
            "/v1/skills/ripple:shared-demo",
            "service-key",
            Some("skill-user"),
            Some(json!({"confirm": true})),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(
            delete_body.pointer("/error/code").and_then(Value::as_str),
            Some("read_only")
        );

        let _ = std::fs::remove_dir_all(shared_root);
    }

    #[tokio::test]
    async fn chat_can_create_available_skill_without_starting_codex() {
        let state = test_state(vec!["service-key".to_string()]);
        let workspace = state.sandboxes.ensure_sandbox("skill-chat-user").unwrap();

        let (status, body) = request_json(
            state,
            Method::POST,
            "/v1/chat/completions",
            "service-key",
            Some("skill-chat-user"),
            Some(json!({
                "model": "codex-test",
                "messages": [{
                    "role": "user",
                    "content": "把这个流程保存成一个能力：每周整理项目进展，先列进展，再列风险，最后列下周行动。"
                }],
                "stream": false
            })),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body.pointer("/event/type").and_then(Value::as_str),
            Some("skill_draft_created")
        );
        assert_eq!(
            body.pointer("/event/skill/desired_state")
                .and_then(Value::as_str),
            Some("enabled")
        );
        assert_eq!(
            body.pointer("/event/skill/user_status")
                .and_then(Value::as_str),
            Some("available")
        );
        assert_eq!(
            body.pointer("/event/skill/validation/passed")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert!(workspace
            .join("skills/saved-conversation-skill/SKILL.md")
            .is_file());
    }

    #[tokio::test]
    async fn chat_asks_for_skill_details_before_saving_sparse_workflow() {
        let state = test_state(vec!["service-key".to_string()]);
        let workspace = state
            .sandboxes
            .ensure_sandbox("skill-chat-details-user")
            .unwrap();

        let (status, body) = request_json(
            state.clone(),
            Method::POST,
            "/v1/chat/completions",
            "service-key",
            Some("skill-chat-details-user"),
            Some(json!({
                "model": "codex-test",
                "messages": [{
                    "role": "user",
                    "content": "把这个流程保存成一个能力：处理消息"
                }],
                "stream": false
            })),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body.pointer("/event/type").and_then(Value::as_str),
            Some("skill_clarification_required")
        );
        let message = body
            .pointer("/event/message")
            .and_then(Value::as_str)
            .expect("clarification message");
        assert!(message.contains("使用场景"), "{message}");
        assert!(message.contains("步骤"), "{message}");
        assert!(message.contains("输出"), "{message}");
        assert!(!workspace
            .join("skills/saved-conversation-skill/SKILL.md")
            .is_file());

        let session_id = body
            .get("session_id")
            .and_then(Value::as_str)
            .expect("session id");
        let reloaded = state
            .sessions
            .load("skill-chat-details-user", session_id)
            .await
            .unwrap()
            .expect("session");
        assert_eq!(reloaded.status, "awaiting_user_input");
        assert_eq!(
            reloaded
                .pending_schedule_request
                .as_ref()
                .and_then(|value| value.get("type"))
                .and_then(Value::as_str),
            Some("skill_draft")
        );
    }

    #[tokio::test]
    async fn chat_creates_skill_after_one_detail_followup() {
        let state = test_state(vec!["service-key".to_string()]);
        let workspace = state
            .sandboxes
            .ensure_sandbox("skill-chat-followup-user")
            .unwrap();

        let (_status, first) = request_json(
            state.clone(),
            Method::POST,
            "/v1/chat/completions",
            "service-key",
            Some("skill-chat-followup-user"),
            Some(json!({
                "model": "codex-test",
                "messages": [{
                    "role": "user",
                    "content": "把这个流程保存成一个能力：处理消息"
                }],
                "stream": false
            })),
        )
        .await;
        let session_id = first
            .get("session_id")
            .and_then(Value::as_str)
            .expect("session id");

        let (status, second) = request_json(
            state,
            Method::POST,
            "/v1/chat/completions",
            "service-key",
            Some("skill-chat-followup-user"),
            Some(json!({
                "model": "codex-test",
                "session_id": session_id,
                "messages": [{
                    "role": "user",
                    "content": "场景是整理飞书群里的项目更新；步骤是读取消息、提炼进展和风险；输出 Markdown 列表；发送消息前要确认；测试样例是给三条项目消息生成摘要。"
                }],
                "stream": false
            })),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            second.pointer("/event/type").and_then(Value::as_str),
            Some("skill_draft_created")
        );
        assert!(workspace
            .join("skills/saved-conversation-skill/SKILL.md")
            .is_file());
    }

    #[tokio::test]
    async fn user_management_routes_are_not_registered() {
        let state = test_state(vec!["service-key".to_string()]);
        let cases = [
            (Method::GET, "/v1/users/me/quota", None),
            (
                Method::PUT,
                "/v1/users/alice/quota",
                Some(json!({ "max_sessions": 1 })),
            ),
            (
                Method::POST,
                "/v1/users/alice/api-keys",
                Some(json!({ "display_name": "Alice laptop" })),
            ),
            (
                Method::POST,
                "/v1/api-keys/trusted-clients",
                Some(json!({ "display_name": "upstream app" })),
            ),
            (
                Method::POST,
                "/v1/api-keys/admin",
                Some(json!({ "display_name": "admin" })),
            ),
            (Method::DELETE, "/v1/api-keys/key_test", None),
        ];

        for (method, path, body) in cases {
            let (status, _) = request_json(
                state.clone(),
                method,
                path,
                "service-key",
                Some("upstream-user"),
                body,
            )
            .await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
        }
    }
}
