use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::state::AppState;

pub async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "service": "ripple-rust-server"
    }))
}

pub async fn ready(State(state): State<AppState>) -> Json<Value> {
    Json(crate::diagnostics::readiness_report(&state.config).await)
}

pub async fn doctor(State(state): State<AppState>) -> Json<Value> {
    Json(crate::diagnostics::doctor_report(&state.config).await)
}
