use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::state::AppState;

#[utoipa::path(
    get,
    path = "/health",
    tag = "health",
    responses((status = 200, description = "Liveness response", body = serde_json::Value))
)]
pub async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "service": "ripple-rust-server"
    }))
}

#[utoipa::path(
    get,
    path = "/health/ready",
    tag = "health",
    responses(
        (status = 200, description = "Readiness diagnostics", body = serde_json::Value),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn ready(State(state): State<AppState>) -> Json<Value> {
    let report = crate::diagnostics::readiness_report(&state.config).await;
    Json(crate::diagnostics::redact_deployment_paths(
        &state.config,
        report,
    ))
}

#[utoipa::path(
    get,
    path = "/diagnostics/doctor",
    tag = "health",
    responses(
        (status = 200, description = "Full diagnostic report", body = serde_json::Value),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn doctor(State(state): State<AppState>) -> Json<Value> {
    let report = crate::diagnostics::doctor_report(&state.config).await;
    Json(crate::diagnostics::redact_deployment_paths(
        &state.config,
        report,
    ))
}
