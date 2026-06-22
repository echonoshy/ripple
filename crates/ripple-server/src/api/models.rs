use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use serde_json::{json, Value};

use crate::api::ApiError;
use crate::redaction::redact_text;
use crate::skills::build_skill_manifest;
use crate::state::AppState;
use crate::user::user_id_from_headers;

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
    path = "/runtime/codex",
    tag = "models",
    responses(
        (status = 200, description = "Codex app-server runtime model catalog, capabilities, and account limits", body = serde_json::Value),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn codex_runtime_info(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let workspace_root = state
        .sandboxes
        .ensure_sandbox(&user_id)
        .map_err(|err| ApiError::bad_request(err.to_string()))?;
    let runtime = match state.jobs.codex_runtime_info(user_id, workspace_root).await {
        Ok(runtime) => runtime,
        Err(err) => json!({
            "available": false,
            "error": redact_text(&err.to_string()),
            "models": {
                "data": [],
                "nextCursor": null
            },
            "model_provider_capabilities": null,
            "rate_limits": null
        }),
    };
    Ok(Json(runtime))
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
