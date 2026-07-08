use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde_json::{json, Value};

use crate::api::ApiError;
use crate::browser_commands::BrowserCommandCompleteError;
use crate::state::AppState;
use crate::user::user_id_from_headers;

#[utoipa::path(
    post,
    path = "/browser/commands/{command_id}/result",
    tag = "browser",
    params(("command_id" = String, Path, description = "Browser command id")),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Browser command result accepted", body = serde_json::Value),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 403, description = "Browser command belongs to another user", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Browser command not found", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn submit_browser_command_result(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(command_id): Path<String>,
    Json(result): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state
        .browser_commands
        .complete(&user_id, &command_id, result)
        .await
        .map_err(|err| match err {
            BrowserCommandCompleteError::NotFound => {
                ApiError::not_found("Browser command not found")
            }
            BrowserCommandCompleteError::UserMismatch => ApiError::new(
                StatusCode::FORBIDDEN,
                "Browser command belongs to another user",
            ),
        })?;
    Ok(Json(json!({ "ok": true })))
}
