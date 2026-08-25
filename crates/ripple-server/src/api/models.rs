use std::collections::{BTreeMap, BTreeSet};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde_json::{json, Value};

use crate::api::ApiError;
use crate::config::{AppConfig, ModelPreset};
use crate::redaction::redact_text;
use crate::skills::build_skill_manifest;
use crate::state::AppState;
use crate::user::user_id_from_headers;

const SUPPORTED_THINK_LEVELS: &[&str] = &["low", "medium", "high", "xhigh"];

#[utoipa::path(
    get,
    path = "/models",
    tag = "models",
    responses(
        (status = 200, description = "Available Codex runtime models and Ripple presets", body = serde_json::Value),
        (status = 503, description = "Codex runtime model catalog unavailable", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn list_models(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let workspace_root = state
        .sandboxes
        .ensure_sandbox(&user_id)
        .map_err(|err| ApiError::bad_request(err.to_string()))?;
    let runtime = state
        .jobs
        .codex_runtime_info(user_id, workspace_root)
        .await
        .map_err(|err| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({
                    "code": "codex_runtime_models_unavailable",
                    "message": "Codex runtime model catalog is unavailable",
                    "detail": redact_text(&err.to_string())
                }),
            )
        })?;
    let data = model_catalog_from_runtime(&state.config, &runtime);
    Ok(Json(json!({
        "object": "list",
        "data": data,
        "default_model": state.config.default_model,
        "supported_think_levels": SUPPORTED_THINK_LEVELS,
        "think_level_param": {
            "responses": "think_level or reasoning.effort",
            "runs": "think_level or effort"
        }
    })))
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
        "supported_think_levels": SUPPORTED_THINK_LEVELS,
        "max_turns": 200
    }))
}

fn model_catalog_from_runtime(config: &AppConfig, runtime: &Value) -> Vec<Value> {
    build_model_catalog(
        &config.model_presets,
        runtime,
        config.codex.requires_service_auth,
    )
}

fn build_model_catalog(
    presets: &BTreeMap<String, ModelPreset>,
    runtime: &Value,
    include_runtime_models: bool,
) -> Vec<Value> {
    let mut data = Vec::new();
    let mut seen = BTreeSet::new();

    if include_runtime_models {
        for item in runtime_model_items(runtime) {
            let Some(entry) = runtime_model_entry(item) else {
                continue;
            };
            let Some(id) = entry.get("id").and_then(Value::as_str) else {
                continue;
            };
            if seen.insert(id.to_string()) {
                data.push(entry);
            }
        }
    }

    for (alias, preset) in presets {
        if !seen.insert(alias.clone()) {
            continue;
        }
        data.push(preset_model_entry(alias, preset));
    }

    data
}

fn runtime_model_items(runtime: &Value) -> Vec<&Value> {
    let models = runtime.get("models").unwrap_or(runtime);
    if let Some(items) = models.as_array() {
        return items.iter().collect();
    }
    for key in ["data", "models", "items"] {
        if let Some(items) = models.get(key).and_then(Value::as_array) {
            return items.iter().collect();
        }
    }
    Vec::new()
}

fn runtime_model_entry(item: &Value) -> Option<Value> {
    if let Some(id) = item
        .as_str()
        .map(clean_model_id)
        .filter(|id| !id.is_empty())
    {
        return Some(json!({
            "id": id,
            "object": "model",
            "created": 0,
            "owned_by": "codex",
            "provider": "codex",
            "display_name": model_display_name(&id),
            "source": "codex_runtime",
            "available": true,
            "supported_think_levels": SUPPORTED_THINK_LEVELS
        }));
    }

    let object = item.as_object()?;
    let id = string_field(object, &["id", "model", "name", "slug"])?;
    let created = object.get("created").and_then(Value::as_i64).unwrap_or(0);
    let provider = string_field(object, &["provider", "model_provider", "modelProvider"])
        .unwrap_or_else(|| "codex".to_string());
    let owned_by =
        string_field(object, &["owned_by", "ownedBy", "owner"]).unwrap_or_else(|| provider.clone());
    let display_name = string_field(object, &["display_name", "displayName", "label", "title"])
        .unwrap_or_else(|| model_display_name(&id));

    let mut entry = serde_json::Map::new();
    entry.insert("id".to_string(), json!(id));
    entry.insert("object".to_string(), json!("model"));
    entry.insert("created".to_string(), json!(created));
    entry.insert("owned_by".to_string(), json!(owned_by));
    entry.insert("provider".to_string(), json!(provider));
    entry.insert("display_name".to_string(), json!(display_name));
    entry.insert("source".to_string(), json!("codex_runtime"));
    entry.insert("available".to_string(), json!(true));
    entry.insert(
        "supported_think_levels".to_string(),
        json!(SUPPORTED_THINK_LEVELS),
    );

    if let Some(context_window) = numeric_field(
        object,
        &[
            "context_window",
            "contextWindow",
            "model_context_window",
            "modelContextWindow",
        ],
    ) {
        entry.insert("context_window".to_string(), json!(context_window));
    }
    if let Some(capabilities) = object.get("capabilities") {
        entry.insert("capabilities".to_string(), capabilities.clone());
    }
    if let Some(description) = string_field(object, &["description"]) {
        entry.insert("description".to_string(), json!(description));
    }

    Some(Value::Object(entry))
}

fn preset_model_entry(alias: &str, preset: &ModelPreset) -> Value {
    json!({
        "id": alias,
        "object": "model",
        "created": 0,
        "owned_by": "ripple",
        "provider": "codex",
        "display_name": model_display_name(alias),
        "source": "preset",
        "model": preset.model.clone(),
        "default_think_level": preset.reasoning_effort.clone(),
        "available": true,
        "supported_think_levels": SUPPORTED_THINK_LEVELS
    })
}

fn string_field(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(Value::as_str))
        .map(clean_model_id)
        .filter(|value| !value.is_empty())
}

fn numeric_field(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(Value::as_u64))
}

fn clean_model_id(value: &str) -> String {
    value.trim().to_string()
}

fn model_display_name(id: &str) -> String {
    match id {
        "codex-low" => "Lite".to_string(),
        "codex-medium" => "Plus".to_string(),
        "codex-high" => "Pro".to_string(),
        "codex-xhigh" => "Ultra".to_string(),
        _ => display_name_from_model_id(id),
    }
}

fn display_name_from_model_id(id: &str) -> String {
    if !id.to_ascii_lowercase().starts_with("gpt-") {
        return id.to_string();
    }
    id.split('-')
        .map(|part| {
            if part.eq_ignore_ascii_case("gpt") {
                "GPT".to_string()
            } else if part
                .chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_alphabetic())
            {
                let mut chars = part.chars();
                let Some(first) = chars.next() else {
                    return String::new();
                };
                format!("{}{}", first.to_ascii_uppercase(), chars.as_str())
            } else {
                part.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_catalog_merges_runtime_models_and_presets() {
        let mut presets = BTreeMap::new();
        presets.insert(
            "codex-high".to_string(),
            ModelPreset {
                model: "gpt-5.5".to_string(),
                reasoning_effort: Some("high".to_string()),
            },
        );
        let runtime = json!({
            "available": true,
            "models": {
                "data": [
                    {
                        "id": "gpt-5.3-codex-spark",
                        "contextWindow": 200000,
                        "capabilities": {"tools": true}
                    }
                ]
            }
        });

        let catalog = build_model_catalog(&presets, &runtime, true);

        assert_eq!(catalog.len(), 2);
        assert_eq!(
            catalog[0].get("id").and_then(Value::as_str),
            Some("gpt-5.3-codex-spark")
        );
        assert_eq!(
            catalog[0].get("display_name").and_then(Value::as_str),
            Some("GPT-5.3-Codex-Spark")
        );
        assert_eq!(
            catalog[0].get("context_window").and_then(Value::as_u64),
            Some(200000)
        );
        assert_eq!(
            catalog[1].get("id").and_then(Value::as_str),
            Some("codex-high")
        );
        assert_eq!(
            catalog[1]
                .get("default_think_level")
                .and_then(Value::as_str),
            Some("high")
        );
    }

    #[test]
    fn model_catalog_keeps_runtime_entry_when_preset_id_matches() {
        let mut presets = BTreeMap::new();
        presets.insert(
            "gpt-5.4-mini".to_string(),
            ModelPreset {
                model: "gpt-5.5".to_string(),
                reasoning_effort: Some("medium".to_string()),
            },
        );
        let runtime = json!({
            "models": {
                "data": ["gpt-5.4-mini"]
            }
        });

        let catalog = build_model_catalog(&presets, &runtime, true);

        assert_eq!(catalog.len(), 1);
        assert_eq!(
            catalog[0].get("source").and_then(Value::as_str),
            Some("codex_runtime")
        );
    }

    #[test]
    fn model_catalog_omits_builtin_runtime_models_for_provider_auth() {
        let mut presets = BTreeMap::new();
        presets.insert(
            "codex-medium".to_string(),
            ModelPreset {
                model: "qwen3.7-plus".to_string(),
                reasoning_effort: Some("medium".to_string()),
            },
        );
        let runtime = json!({
            "models": {
                "data": ["gpt-5.5"]
            }
        });

        let catalog = build_model_catalog(&presets, &runtime, false);

        assert_eq!(catalog.len(), 1);
        assert_eq!(
            catalog[0].get("id").and_then(Value::as_str),
            Some("codex-medium")
        );
        assert_eq!(
            catalog[0].get("model").and_then(Value::as_str),
            Some("qwen3.7-plus")
        );
    }
}
