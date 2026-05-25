pub mod bilibili;
pub mod chat;
pub mod connectors;
pub mod documents;
pub mod health;
pub mod models;
pub mod runs;
pub mod sandboxes;
pub mod schedule_chat;
pub mod schedules;
pub mod sessions;
pub mod users;
pub mod workspace;

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderValue, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::state::AppState;
use crate::user::{user_id_from_headers, AuthContext};

pub fn router(state: AppState) -> Router {
    let v1 = Router::new()
        .route("/models", get(models::list_models))
        .route("/info", get(models::system_info))
        .route("/tasks", any(sessions::deprecated_tasks_api))
        .route("/tasks/*task_path", any(sessions::deprecated_tasks_api))
        .route("/chat/completions", post(chat::chat_completions))
        .route("/users/me", get(users::current_user_profile))
        .route(
            "/sessions",
            get(sessions::list_sessions).post(sessions::create_session),
        )
        .route(
            "/sessions/suspended",
            get(sessions::list_suspended_sessions),
        )
        .route(
            "/sessions/:session_id",
            get(sessions::get_session).delete(sessions::delete_session),
        )
        .route("/sessions/:session_id/stop", post(sessions::stop_session))
        .route(
            "/sessions/:session_id/context/clear",
            post(sessions::clear_session_context),
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
        .route("/workspace", get(workspace::list_workspace))
        .route("/workspace/search", get(workspace::search_workspace))
        .route(
            "/workspace/file",
            get(workspace::get_workspace_file).put(workspace::save_workspace_file),
        )
        .route("/workspace/rename", post(workspace::rename_workspace))
        .route("/workspace/upload", post(workspace::upload_workspace_files))
        .route(
            "/workspace/attachments",
            post(workspace::upload_workspace_attachment),
        )
        .route(
            "/workspace/download",
            get(workspace::download_workspace_file),
        )
        .route("/connectors", get(connectors::list_connectors))
        .route(
            "/connectors/:connector_name/status",
            get(connectors::connector_status),
        )
        .route(
            "/connectors/:connector_name/auth/start",
            post(connectors::connector_auth_start),
        )
        .route(
            "/connectors/:connector_name/auth/complete",
            post(connectors::connector_auth_complete),
        )
        .route(
            "/connectors/:connector_name/disconnect",
            post(connectors::connector_disconnect),
        )
        .route(
            "/connectors/:connector_name/accounts",
            get(connectors::connector_accounts),
        )
        .route(
            "/sandboxes/gogcli-accounts",
            get(connectors::gogcli_accounts_alias),
        )
        .route("/runs", get(runs::list_runs).post(runs::create_run))
        .route("/runs/:job_id", get(runs::get_run))
        .route("/runs/:job_id/events", get(runs::run_events))
        .route("/runs/:job_id/steer", post(runs::steer_run))
        .route("/runs/:job_id/cancel", post(runs::cancel_run))
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
            "/schedules/:schedule_id/run-now",
            post(schedules::run_schedule_now),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_api_key,
        ))
        .with_state(state.clone());

    Router::new()
        .route("/health", get(health::health))
        .route("/v1/bilibili/qrcode.png", get(bilibili::qrcode_png))
        .route(
            "/v1/sandboxes/gogcli/oauth/callback",
            get(connectors::gogcli_oauth_callback),
        )
        .nest("/v1", v1)
        .with_state(state)
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
    if state.config.api_keys.is_empty() {
        let user_id = user_id_from_headers(headers).map_err(ApiError::bad_request)?;
        return Ok(AuthContext::open(user_id));
    }

    let supplied = supplied_api_key(headers);
    if let Some(key) = supplied {
        if state.config.api_keys.iter().any(|expected| expected == key) {
            let user_id = user_id_from_headers(headers).map_err(ApiError::bad_request)?;
            return Ok(AuthContext::service(user_id));
        }
        return Err(invalid_api_key());
    }

    Err(invalid_api_key())
}

fn supplied_api_key(headers: &axum::http::HeaderMap) -> Option<&str> {
    let bearer = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim);
    let x_api_key = headers
        .get("x-api-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim);
    bearer.or(x_api_key).filter(|key| !key.is_empty())
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
        (self.status, Json(json!({ "detail": self.detail }))).into_response()
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
        AppConfig, CodexConfig, FeishuConfig, GogcliOAuthConfig, SandboxConfig, SkillsConfig,
    };
    fn test_state(api_keys: Vec<String>) -> AppState {
        let root =
            std::env::temp_dir().join(format!("ripple-api-auth-test-{}", uuid::Uuid::new_v4()));
        AppState::new(AppConfig {
            repo_root: root.clone(),
            host: "127.0.0.1".to_string(),
            port: 0,
            api_keys,
            default_model: "codex-test".to_string(),
            model_presets: BTreeMap::new(),
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
