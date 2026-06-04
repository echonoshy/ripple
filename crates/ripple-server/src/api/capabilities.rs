use std::collections::BTreeMap;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use serde_json::{json, Value};

use crate::api::connectors::{connector_status_value, read_valid_bilibili_credential_file};
use crate::api::skills::reconcile_user_skill_settings;
use crate::api::ApiError;
use crate::capabilities::{
    connector_definitions, connector_info, related_connector_for_skill,
    related_skills_for_connector,
};
use crate::skills::{
    build_skill_manifest_with_options, public_skill_path, read_user_skill_settings,
    write_user_skill_settings, SkillManifestEntry, SkillManifestOptions, UserSkillSettings,
};
use crate::state::AppState;
use crate::user::user_id_from_headers;

#[utoipa::path(
    get,
    path = "/capabilities",
    tag = "capabilities",
    responses(
        (status = 200, description = "Unified capability catalog", body = serde_json::Value),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn list_capabilities(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    Ok(Json(json!({
        "capabilities": capability_catalog(&state, &user_id).await?
    })))
}

pub(crate) fn skill_manifest_options_for_user(
    state: &AppState,
    user_id: &str,
) -> anyhow::Result<SkillManifestOptions> {
    let settings_file = state.sandboxes.skill_settings_file(user_id)?;
    let mut settings = read_user_skill_settings(&settings_file);
    let connector_statuses = lightweight_connector_statuses(state, user_id)?;
    if reconcile_user_skill_settings(state, user_id, &mut settings, connector_statuses.clone())
        .map_err(|error| anyhow::anyhow!("failed to reconcile user skills: {error:?}"))?
    {
        write_user_skill_settings(&settings_file, &settings)?;
    }
    skill_manifest_options_for_user_with_settings(&settings, connector_statuses)
}

pub(crate) async fn catalog_skill_manifest_options_for_user(
    state: &AppState,
    user_id: &str,
) -> Result<SkillManifestOptions, ApiError> {
    let settings_file = state.sandboxes.skill_settings_file(user_id)?;
    let mut settings = read_user_skill_settings(&settings_file);
    let connector_statuses = catalog_connector_statuses(state, user_id).await?;
    if reconcile_user_skill_settings(state, user_id, &mut settings, connector_statuses.clone())? {
        write_user_skill_settings(&settings_file, &settings)?;
    }
    Ok(skill_manifest_options_for_user_with_settings(
        &settings,
        connector_statuses,
    )?)
}

fn skill_manifest_options_for_user_with_settings(
    settings: &UserSkillSettings,
    connector_statuses: BTreeMap<String, bool>,
) -> anyhow::Result<SkillManifestOptions> {
    Ok(SkillManifestOptions {
        enabled_user_skill_ids: settings.enabled_manifest_skill_ids(),
        validated_user_skill_ids: settings.validated_manifest_skill_ids(),
        validated_user_skill_hashes: settings.validated_manifest_skill_hashes(),
        archived_user_skill_ids: settings.archived_skill_ids(),
        connector_statuses,
    })
}

async fn capability_catalog(state: &AppState, user_id: &str) -> Result<Vec<Value>, ApiError> {
    let workspace = state.sandboxes.workspace_dir(user_id)?;
    let settings_file = state.sandboxes.skill_settings_file(user_id)?;
    let mut settings = read_user_skill_settings(&settings_file);
    let connector_statuses = catalog_connector_statuses(state, user_id).await?;
    if reconcile_user_skill_settings(state, user_id, &mut settings, connector_statuses.clone())? {
        write_user_skill_settings(&settings_file, &settings)?;
    }
    let options = skill_manifest_options_for_user_with_settings(&settings, connector_statuses)?;
    let skills = build_skill_manifest_with_options(&state.config, Some(&workspace), &options);
    let connector_statuses = options.connector_statuses.clone();
    let mut capabilities = Vec::new();
    for connector in connector_definitions() {
        let connected = connector_statuses
            .get(connector.name)
            .copied()
            .unwrap_or(connector.kind == "runtime_capability");
        let capability_type = if connector.kind == "runtime_capability" {
            "runtime_capability"
        } else {
            "connector"
        };
        let id_prefix = if connector.kind == "runtime_capability" {
            "runtime"
        } else {
            "connector"
        };
        let status = if connected {
            "available"
        } else {
            "blocked_by_connector_auth"
        };
        capabilities.push(json!({
            "id": format!("{id_prefix}:{}", connector.name),
            "type": capability_type,
            "name": connector.name,
            "display_name": connector.display_name,
            "description": connector.description,
            "source": "ripple",
            "status": status,
            "enabled": connected,
            "requirements": connector_requirements(connector.name, connector.kind, connected),
            "related_skills": related_skills_for_connector(connector, &skills),
            "related_connector": Value::Null,
            "connector": connector_info(connector)
        }));
    }
    capabilities.extend(
        skills
            .iter()
            .map(|skill| skill_capability(skill, &workspace)),
    );
    capabilities.sort_by(|left, right| {
        left.get("id")
            .and_then(Value::as_str)
            .cmp(&right.get("id").and_then(Value::as_str))
    });
    Ok(capabilities)
}

async fn catalog_connector_statuses(
    state: &AppState,
    user_id: &str,
) -> Result<BTreeMap<String, bool>, ApiError> {
    let mut statuses = BTreeMap::new();
    for connector in connector_definitions() {
        if connector.kind == "runtime_capability" {
            statuses.insert(connector.name.to_string(), true);
            continue;
        }
        let status = connector_status_value(state, user_id, connector.name).await?;
        statuses.insert(
            connector.name.to_string(),
            status
                .get("connected")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        );
    }
    Ok(statuses)
}

fn connector_requirements(name: &str, kind: &str, connected: bool) -> Vec<Value> {
    if kind == "runtime_capability" {
        return Vec::new();
    }
    vec![json!({
        "kind": "connector_auth",
        "name": name,
        "status": if connected { "satisfied" } else { "not_connected" }
    })]
}

fn skill_capability(skill: &SkillManifestEntry, workspace_root: &std::path::Path) -> Value {
    let mut public_skill = skill.clone();
    public_skill.path = public_skill_path(std::path::Path::new(&skill.path), Some(workspace_root));
    json!({
        "id": skill.id,
        "type": "skill",
        "name": skill.name,
        "display_name": skill.display_name,
        "description": skill.description,
        "source": skill.source,
        "display_source": skill.display_source,
        "kind": skill.kind,
        "runtime": skill.runtime,
        "entry": skill.entry,
        "python_packages": skill.python_packages,
        "content_hash": skill.content_hash,
        "status": skill.status,
        "enabled": skill.enabled,
        "requirements": skill_requirements(skill),
        "related_skills": [],
        "related_connector": related_connector_for_skill(skill),
        "skill": public_skill
    })
}

fn skill_requirements(skill: &SkillManifestEntry) -> Vec<Value> {
    let mut requirements = Vec::new();
    for bin in &skill.requires_bins {
        requirements.push(json!({
            "kind": "bin",
            "name": bin,
            "status": if skill.missing_bins.iter().any(|missing| missing == bin) {
                "missing"
            } else {
                "satisfied"
            }
        }));
    }
    for connector in &skill.requires_connectors {
        requirements.push(json!({
            "kind": "connector",
            "name": connector,
            "status": if skill.missing_connectors.iter().any(|missing| missing == connector) {
                "missing"
            } else if skill.blocked_connectors.iter().any(|blocked| blocked == connector) {
                "not_connected"
            } else {
                "satisfied"
            }
        }));
    }
    requirements
}

pub(crate) fn lightweight_connector_statuses(
    state: &AppState,
    user_id: &str,
) -> anyhow::Result<BTreeMap<String, bool>> {
    let workspace = state.sandboxes.workspace_dir(user_id)?;
    let credentials = state.sandboxes.credentials_dir(user_id)?;
    let mut statuses = BTreeMap::new();
    statuses.insert(
        "google_workspace".to_string(),
        workspace.join(".config/gogcli/keyring").exists(),
    );
    statuses.insert(
        "notion".to_string(),
        read_json_string_field(&credentials.join("notion.json"), "api_token").is_some(),
    );
    statuses.insert(
        "feishu".to_string(),
        workspace.join(".lark-cli/config.json").is_file(),
    );
    statuses.insert(
        "bilibili".to_string(),
        read_valid_bilibili_credential_file(&credentials.join("bilibili.json")).is_some(),
    );
    statuses.insert("openai_codex".to_string(), true);
    statuses.insert("codex_image_generation".to_string(), true);
    statuses.insert("codex_image_input".to_string(), true);
    statuses.insert("codex_web_search".to_string(), true);
    Ok(statuses)
}

fn read_json_string_field(path: &std::path::Path, field: &str) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&text).ok()?;
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}
