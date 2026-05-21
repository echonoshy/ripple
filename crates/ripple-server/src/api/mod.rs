pub mod bilibili;
pub mod chat;
pub mod connectors;
pub mod documents;
pub mod health;
pub mod models;
pub mod runs;
pub mod sandboxes;
pub mod schedules;
pub mod sessions;
pub mod users;
pub mod workspace;

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    let v1 = Router::new()
        .route("/models", get(models::list_models))
        .route("/info", get(models::system_info))
        .route("/chat/completions", post(chat::chat_completions))
        .route("/users/me", get(users::current_user_profile))
        .route("/users/me/quota", get(users::current_user_quota))
        .route(
            "/users/:target_user_id/quota",
            axum::routing::put(users::update_user_quota),
        )
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
            post(sessions::poll_session_connector_auth),
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
        .nest("/v1", v1)
        .with_state(state)
}

async fn require_api_key(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Result<Response, ApiError> {
    if state.config.api_keys.is_empty() {
        return Ok(next.run(request).await);
    }
    let headers = request.headers();
    let bearer = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim);
    let x_api_key = headers
        .get("x-api-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim);
    let supplied = bearer.or(x_api_key);
    if supplied.is_some_and(|key| state.config.api_keys.iter().any(|expected| expected == key)) {
        Ok(next.run(request).await)
    } else {
        Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "Invalid or missing API key",
        ))
    }
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
