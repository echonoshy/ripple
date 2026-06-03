use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::skills::build_skill_manifest;
use crate::state::AppState;

#[utoipa::path(
    get,
    path = "/models",
    tag = "models",
    responses(
        (status = 200, description = "Available model presets", body = serde_json::Value),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn list_models(State(state): State<AppState>) -> Json<Value> {
    let data = state
        .config
        .model_presets
        .keys()
        .map(|id| {
            json!({
                "id": id,
                "object": "model",
                "created": 0,
                "owned_by": "ripple"
            })
        })
        .collect::<Vec<_>>();
    Json(json!({ "object": "list", "data": data }))
}

#[utoipa::path(
    get,
    path = "/info",
    tag = "models",
    responses(
        (status = 200, description = "System metadata and skill manifest", body = serde_json::Value),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn system_info(State(state): State<AppState>) -> Json<Value> {
    let presets = state
        .config
        .model_presets
        .iter()
        .map(|(alias, preset)| (alias.clone(), json!(preset.model)))
        .collect::<serde_json::Map<_, _>>();
    Json(json!({
        "tools": [],
        "skills": build_skill_manifest(&state.config, None),
        "model_presets": presets,
        "default_model": state.config.default_model,
        "max_turns": 200
    }))
}
