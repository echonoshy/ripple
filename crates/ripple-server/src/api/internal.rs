use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::state::AppState;

#[utoipa::path(
    post,
    path = "/internal/drain",
    tag = "health",
    responses(
        (status = 200, description = "Stop dispatching queued work", body = serde_json::Value),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(("bearerAuth" = []), ("apiKeyAuth" = []))
)]
pub async fn begin_drain(State(state): State<AppState>) -> Json<Value> {
    state.jobs.begin_drain();
    Json(json!({
        "draining": true,
        "active_jobs": state.jobs.active_count().await
    }))
}

#[utoipa::path(
    get,
    path = "/internal/drain/status",
    tag = "health",
    responses(
        (status = 200, description = "Current drain status", body = serde_json::Value),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(("bearerAuth" = []), ("apiKeyAuth" = []))
)]
pub async fn drain_status(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "draining": state.jobs.is_draining(),
        "active_jobs": state.jobs.active_count().await
    }))
}
