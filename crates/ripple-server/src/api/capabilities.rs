use std::collections::BTreeMap;
use std::time::Instant;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use serde_json::{json, Value};

use crate::api::connectors::{connector_status_value, read_valid_bilibili_credential_file};
use crate::api::skills::{
    public_skill_api_path, reconcile_user_skill_settings,
    reconcile_user_skill_settings_from_entries,
};
use crate::api::ApiError;
use crate::capabilities::{
    connector_info, enabled_connector_definitions, related_connector_for_skill,
    related_skills_for_connector,
};
use crate::codex::runtime_metadata::runtime_capability_metadata;
use crate::skills::{
    build_skill_manifest_with_options, read_user_skill_settings, write_user_skill_settings,
    SkillManifestEntry, SkillManifestOptions, UserSkillSettings,
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
    Ok(catalog_skill_manifest_for_user(state, user_id).await?.0)
}

pub(crate) async fn catalog_skill_manifest_for_user(
    state: &AppState,
    user_id: &str,
) -> Result<(SkillManifestOptions, Vec<SkillManifestEntry>), ApiError> {
    let started = Instant::now();
    let settings_file = state.sandboxes.skill_settings_file(user_id)?;
    let mut settings = read_user_skill_settings(&settings_file);
    let connector_statuses = catalog_connector_statuses(state, user_id).await?;
    let initial_options =
        skill_manifest_options_for_user_with_settings(&settings, connector_statuses.clone())?;
    let workspace = state.sandboxes.workspace_dir(user_id)?;
    let mut skills =
        build_skill_manifest_with_options(&state.config, Some(&workspace), &initial_options);
    if reconcile_user_skill_settings_from_entries(state, &mut settings, &skills)? {
        write_user_skill_settings(&settings_file, &settings)?;
    }
    let final_options =
        skill_manifest_options_for_user_with_settings(&settings, connector_statuses)?;
    if final_options != initial_options {
        skills = build_skill_manifest_with_options(&state.config, Some(&workspace), &final_options);
    }
    tracing::debug!(
        skill_count = skills.len(),
        elapsed_ms = started.elapsed().as_millis() as u64,
        "skill catalog prepared"
    );
    Ok((final_options, skills))
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
    let (options, skills) = catalog_skill_manifest_for_user(state, user_id).await?;
    let connector_statuses = options.connector_statuses.clone();
    let mut capabilities = Vec::new();
    for connector in enabled_connector_definitions(&state.config) {
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
        let mut capability = json!({
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
        });
        if connector.kind == "runtime_capability" {
            if let Some(object) = capability.as_object_mut() {
                object.insert(
                    "runtime".to_string(),
                    runtime_capability_metadata(connector.name, &state.config),
                );
            }
        }
        capabilities.push(capability);
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
    let started = Instant::now();
    let definitions = enabled_connector_definitions(&state.config);
    let mut pending = tokio::task::JoinSet::new();
    let mut results = (0..definitions.len())
        .map(|_| None)
        .collect::<Vec<Option<Result<bool, ApiError>>>>();

    for (index, connector) in definitions.iter().enumerate() {
        if connector.kind == "runtime_capability" {
            results[index] = Some(Ok(true));
            continue;
        }
        let state = state.clone();
        let user_id = user_id.to_string();
        let connector_name = connector.name;
        pending.spawn(async move {
            let connector_started = Instant::now();
            let result = connector_status_value(&state, &user_id, connector_name)
                .await
                .map(|status| {
                    status
                        .get("connected")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                });
            tracing::debug!(
                connector = connector_name,
                elapsed_ms = connector_started.elapsed().as_millis() as u64,
                "connector status check completed"
            );
            (index, result)
        });
    }

    while let Some(joined) = pending.join_next().await {
        let (index, result) = joined
            .map_err(|err| ApiError::bad_request(format!("connector status task failed: {err}")))?;
        results[index] = Some(result);
    }

    let mut statuses = BTreeMap::new();
    for (index, connector) in definitions.iter().enumerate() {
        let connected = results[index]
            .take()
            .expect("connector status result must be collected")?;
        statuses.insert(connector.name.to_string(), connected);
    }
    tracing::debug!(
        connector_count = definitions.len(),
        elapsed_ms = started.elapsed().as_millis() as u64,
        "connector catalog status checks completed"
    );
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
    public_skill.path = public_skill_api_path(skill, Some(workspace_root));
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
    if state.config.connector_enabled("google_workspace") {
        statuses.insert(
            "google_workspace".to_string(),
            workspace.join(".config/gogcli/keyring").exists(),
        );
    }
    if state.config.connector_enabled("notion") {
        statuses.insert(
            "notion".to_string(),
            read_json_string_field(&credentials.join("notion.json"), "api_token").is_some(),
        );
    }
    if state.config.connector_enabled("feishu") {
        statuses.insert(
            "feishu".to_string(),
            workspace.join(".lark-cli/config.json").is_file(),
        );
    }
    if state.config.connector_enabled("bilibili") {
        statuses.insert(
            "bilibili".to_string(),
            read_valid_bilibili_credential_file(&credentials.join("bilibili.json")).is_some(),
        );
    }
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
