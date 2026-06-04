use std::path::{Component, Path, PathBuf};

use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::api::capabilities::{
    catalog_skill_manifest_options_for_user as capability_catalog_skill_manifest_options_for_user,
    skill_manifest_options_for_user as capability_skill_manifest_options_for_user,
};
use crate::api::{require_confirm, ApiError};
use crate::capabilities::related_connector_for_skill;
use crate::python_env::validate_requirement;
use crate::skills::{
    build_skill_manifest_with_options, read_user_skill_settings, write_user_skill_settings,
    SkillManifestEntry, SkillManifestOptions, UserSkillRecord, UserSkillSettings,
    UserSkillValidationCheck, UserSkillValidationResult,
};
use crate::state::AppState;
use crate::user::user_id_from_headers;

#[derive(Debug, Deserialize)]
pub struct SkillDraftInput {
    pub name: Option<String>,
    pub display_name: Option<String>,
    pub description: String,
    pub when_to_use: Option<String>,
    #[serde(default)]
    pub steps: Vec<String>,
    pub output_format: Option<String>,
    pub kind: Option<String>,
    pub runtime: Option<String>,
    pub entry: Option<String>,
    #[serde(default)]
    pub python_packages: Vec<String>,
    pub script: Option<String>,
    #[serde(default)]
    pub requires_connectors: Vec<String>,
    #[serde(default)]
    pub requires_user_confirmation: bool,
    pub test_example: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SkillPatchRequest {
    pub enabled: Option<bool>,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub when_to_use: Option<String>,
    pub steps: Option<Vec<String>>,
    pub output_format: Option<String>,
    pub kind: Option<String>,
    pub runtime: Option<String>,
    pub entry: Option<String>,
    pub python_packages: Option<Vec<String>>,
    pub script: Option<String>,
    pub requires_connectors: Option<Vec<String>>,
    pub requires_user_confirmation: Option<bool>,
    pub test_example: Option<String>,
}

#[utoipa::path(
    get,
    path = "/skills",
    tag = "skills",
    responses(
        (status = 200, description = "User-facing skill list", body = serde_json::Value),
        (status = 401, description = "Invalid or missing API key", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn list_skills(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    let skills = load_skill_infos(&state, &user_id).await?;
    Ok(Json(json!({ "skills": skills })))
}

#[utoipa::path(
    get,
    path = "/skills/{skill_id}",
    tag = "skills",
    params(("skill_id" = String, Path, description = "Skill id, for example user:project-weekly-review")),
    responses(
        (status = 200, description = "Skill detail", body = serde_json::Value),
        (status = 404, description = "Skill not found", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn get_skill(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(skill_id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    let settings = read_settings(&state, &user_id)?;
    let skill = find_catalog_skill(&state, &user_id, &skill_id).await?;
    Ok(Json(skill_info(&skill, &settings)))
}

#[utoipa::path(
    post,
    path = "/skills",
    tag = "skills",
    request_body = serde_json::Value,
    responses(
        (status = 201, description = "Created skill draft", body = serde_json::Value),
        (status = 400, description = "Invalid skill draft", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn create_skill(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<SkillDraftInput>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    Ok((
        StatusCode::CREATED,
        Json(create_user_skill_draft(&state, &user_id, input, false)?),
    ))
}

#[utoipa::path(
    patch,
    path = "/skills/{skill_id}",
    tag = "skills",
    params(("skill_id" = String, Path, description = "Skill id, for example user:project-weekly-review")),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Updated skill", body = serde_json::Value),
        (status = 403, description = "Read-only skill", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Skill not found", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 409, description = "Validation required", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn update_skill(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(skill_id): AxumPath<String>,
    Json(input): Json<SkillPatchRequest>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    let skill = find_skill(&state, &user_id, &skill_id)?;
    ensure_user_skill(&skill)?;
    let mut settings = read_settings(&state, &user_id)?;
    let has_content_update = input.display_name.is_some()
        || input.description.is_some()
        || input.when_to_use.is_some()
        || input.steps.is_some()
        || input.output_format.is_some()
        || input.kind.is_some()
        || input.runtime.is_some()
        || input.entry.is_some()
        || input.python_packages.is_some()
        || input.script.is_some()
        || input.requires_connectors.is_some()
        || input.requires_user_confirmation.is_some()
        || input.test_example.is_some();

    if has_content_update {
        let draft = merged_patch_input(&skill, &input);
        validate_draft_input(&draft)?;
        std::fs::write(&skill.path, render_skill_markdown(&skill.name, &draft)?)?;
        if normalized_input_kind(&draft) == "executable" {
            if let (Some(entry), Some(script)) = (
                normalized_entry(draft.entry.as_deref()).as_deref(),
                draft.script.as_deref(),
            ) {
                if !safe_relative_entry_path(entry) {
                    return Err(ApiError::bad_request(
                        "entry must be a relative path inside the skill directory",
                    ));
                }
                let skill_root = PathBuf::from(&skill.path)
                    .parent()
                    .unwrap_or_else(|| Path::new(""))
                    .to_path_buf();
                let script_path = skill_root.join(entry);
                if let Some(parent) = script_path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(script_path, script)?;
            }
        }
        let record = settings
            .records
            .entry(skill_id.clone())
            .or_insert_with(UserSkillRecord::default);
        record.desired_state = "draft".to_string();
        record.validation = None;
        record.updated_at = Some(now_iso());
        record.last_tested_at = None;
        settings.enabled_skill_ids.remove(&skill_id);
    }

    if let Some(enabled) = input.enabled {
        let record = settings
            .records
            .entry(skill_id.clone())
            .or_insert_with(UserSkillRecord::default);
        if enabled {
            if !record
                .validation
                .as_ref()
                .map(|validation| validation_matches_skill(validation, &skill))
                .unwrap_or_else(|| settings.enabled_skill_ids.contains(&skill_id))
            {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    json!({
                        "code": "validation_required",
                        "message": "Test this skill before enabling it."
                    }),
                ));
            }
            record.desired_state = "enabled".to_string();
            settings.enabled_skill_ids.insert(skill_id.clone());
        } else {
            record.desired_state = "disabled".to_string();
            settings.enabled_skill_ids.remove(&skill_id);
        }
        record.updated_at = Some(now_iso());
    }

    if !has_content_update && input.enabled.is_none() {
        return Err(ApiError::bad_request("No skill update fields provided"));
    }

    write_settings(&state, &user_id, &settings)?;
    let updated = find_skill(&state, &user_id, &skill_id)?;
    Ok(Json(skill_info(&updated, &settings)))
}

#[utoipa::path(
    delete,
    path = "/skills/{skill_id}",
    tag = "skills",
    params(("skill_id" = String, Path, description = "Skill id, for example user:project-weekly-review")),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Archived skill", body = serde_json::Value),
        (status = 403, description = "Read-only skill", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Skill not found", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 412, description = "Confirmation required", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn delete_skill(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(skill_id): AxumPath<String>,
    body: Option<Json<Value>>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    require_confirm(body.as_ref().map(|Json(value)| value), "delete_skill")?;
    let skill = find_skill(&state, &user_id, &skill_id)?;
    ensure_user_skill(&skill)?;
    archive_skill_path(&state, &user_id, &skill)?;

    let mut settings = read_settings(&state, &user_id)?;
    let record = settings
        .records
        .entry(skill_id.clone())
        .or_insert_with(UserSkillRecord::default);
    record.desired_state = "archived".to_string();
    record.updated_at = Some(now_iso());
    settings.enabled_skill_ids.remove(&skill_id);
    write_settings(&state, &user_id, &settings)?;

    Ok(Json(skill_info(&skill, &settings)))
}

#[utoipa::path(
    post,
    path = "/skills/{skill_id}/validate",
    tag = "skills",
    params(("skill_id" = String, Path, description = "Skill id, for example user:project-weekly-review")),
    responses(
        (status = 200, description = "Validation result", body = serde_json::Value),
        (status = 403, description = "Read-only skill", body = crate::api::openapi::ApiErrorEnvelope),
        (status = 404, description = "Skill not found", body = crate::api::openapi::ApiErrorEnvelope)
    ),
    security(
        ("bearerAuth" = []),
        ("apiKeyAuth" = [])
    )
)]
pub async fn validate_skill(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(skill_id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    let skill = find_skill(&state, &user_id, &skill_id)?;
    ensure_user_skill(&skill)?;
    let validation = validate_user_skill(&state.config, &skill)?;
    let mut settings = read_settings(&state, &user_id)?;
    let record = settings
        .records
        .entry(skill_id)
        .or_insert_with(UserSkillRecord::default);
    record.validation = Some(validation.clone());
    record.updated_at = Some(now_iso());
    record.last_tested_at = validation.validated_at.clone();
    write_settings(&state, &user_id, &settings)?;
    Ok(Json(
        serde_json::to_value(validation).map_err(anyhow::Error::from)?,
    ))
}

pub(crate) fn skill_manifest_options_for_user(
    state: &AppState,
    user_id: &str,
) -> anyhow::Result<SkillManifestOptions> {
    capability_skill_manifest_options_for_user(state, user_id)
}

pub(crate) fn create_user_skill_draft(
    state: &AppState,
    user_id: &str,
    input: SkillDraftInput,
    allow_name_suffix: bool,
) -> Result<Value, ApiError> {
    let workspace = state.sandboxes.workspace_dir(user_id)?;
    validate_draft_input(&input)?;
    let mut name = skill_name_from_input(input.name.as_deref(), input.display_name.as_deref());
    let mut dir = workspace.join("skills").join(&name);
    if dir.exists() {
        if !allow_name_suffix {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                json!({
                    "code": "skill_exists",
                    "message": "A skill with this name already exists."
                }),
            ));
        }
        let base = name.clone();
        for index in 2..1000 {
            let candidate = format!("{base}-{index}");
            let candidate_dir = workspace.join("skills").join(&candidate);
            if !candidate_dir.exists() {
                name = candidate;
                dir = candidate_dir;
                break;
            }
        }
    }
    let skill_id = format!("user:{name}");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("SKILL.md"), render_skill_markdown(&name, &input)?)?;
    if normalized_input_kind(&input) == "executable" {
        if let (Some(entry), Some(script)) = (
            normalized_entry(input.entry.as_deref()).as_deref(),
            input.script.as_deref(),
        ) {
            if safe_relative_entry_path(entry) {
                let script_path = dir.join(entry);
                if let Some(parent) = script_path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(script_path, script)?;
            }
        }
    }

    let mut settings = read_settings(state, user_id)?;
    let now = now_iso();
    settings.records.insert(
        skill_id.clone(),
        UserSkillRecord {
            desired_state: "draft".to_string(),
            validation: None,
            created_at: Some(now.clone()),
            updated_at: Some(now),
            last_tested_at: None,
        },
    );
    settings.enabled_skill_ids.remove(&skill_id);
    write_settings(state, user_id, &settings)?;

    let skill = find_skill(state, user_id, &skill_id)?;
    Ok(skill_info(&skill, &settings))
}

async fn load_skill_infos(state: &AppState, user_id: &str) -> Result<Vec<Value>, ApiError> {
    let settings = read_settings(state, user_id)?;
    let workspace = state.sandboxes.workspace_dir(user_id)?;
    let options = capability_catalog_skill_manifest_options_for_user(state, user_id).await?;
    let mut skills = build_skill_manifest_with_options(&state.config, Some(&workspace), &options)
        .iter()
        .map(|skill| skill_info(skill, &settings))
        .collect::<Vec<_>>();
    skills.sort_by(|left, right| {
        left.get("id")
            .and_then(Value::as_str)
            .cmp(&right.get("id").and_then(Value::as_str))
    });
    Ok(skills)
}

async fn find_catalog_skill(
    state: &AppState,
    user_id: &str,
    skill_id: &str,
) -> Result<SkillManifestEntry, ApiError> {
    let workspace = state.sandboxes.workspace_dir(user_id)?;
    let options = capability_catalog_skill_manifest_options_for_user(state, user_id).await?;
    build_skill_manifest_with_options(&state.config, Some(&workspace), &options)
        .into_iter()
        .find(|skill| skill.id == skill_id)
        .ok_or_else(|| ApiError::not_found(format!("Skill {skill_id:?} not found")))
}

fn find_skill(
    state: &AppState,
    user_id: &str,
    skill_id: &str,
) -> Result<SkillManifestEntry, ApiError> {
    let workspace = state.sandboxes.workspace_dir(user_id)?;
    let options = skill_manifest_options_for_user(state, user_id)?;
    build_skill_manifest_with_options(&state.config, Some(&workspace), &options)
        .into_iter()
        .find(|skill| skill.id == skill_id)
        .ok_or_else(|| ApiError::not_found(format!("Skill {skill_id:?} not found")))
}

fn read_settings(state: &AppState, user_id: &str) -> Result<UserSkillSettings, ApiError> {
    let settings_file = state.sandboxes.skill_settings_file(user_id)?;
    Ok(read_user_skill_settings(&settings_file))
}

fn write_settings(
    state: &AppState,
    user_id: &str,
    settings: &UserSkillSettings,
) -> Result<(), ApiError> {
    let settings_file = state.sandboxes.skill_settings_file(user_id)?;
    write_user_skill_settings(&settings_file, settings)?;
    Ok(())
}

fn skill_info(skill: &SkillManifestEntry, settings: &UserSkillSettings) -> Value {
    let record = settings.records.get(&skill.id);
    let desired_state = desired_state_for_skill(skill, settings);
    let validation = record.and_then(|record| record.validation.clone());
    let user_status = user_status_for_skill(skill, &desired_state, validation.as_ref());
    let read_only = skill.source != "user";
    json!({
        "id": skill.id,
        "type": "skill",
        "name": skill.name,
        "display_name": skill.display_name,
        "description": skill.description,
        "source": skill.source,
        "display_source": skill.display_source,
        "read_only": read_only,
        "can_edit": !read_only,
        "can_delete": !read_only,
        "enabled": desired_state == "enabled" && skill.enabled && skill.status == "available",
        "desired_state": desired_state,
        "computed_status": skill.status,
        "user_status": user_status,
        "status_label": user_status_label(&user_status),
        "path": skill.path,
        "when_to_use": skill.when_to_use,
        "version": skill.version,
        "kind": skill.kind,
        "runtime": skill.runtime,
        "entry": skill.entry,
        "python_packages": skill.python_packages,
        "content_hash": skill.content_hash,
        "requires_connectors": skill.requires_connectors,
        "related_connector": related_connector_for_skill(skill),
        "risk_flags": skill.risk_flags,
        "validation": validation,
        "created_at": record.and_then(|record| record.created_at.clone()),
        "updated_at": record.and_then(|record| record.updated_at.clone()),
        "last_tested_at": record.and_then(|record| record.last_tested_at.clone())
    })
}

fn desired_state_for_skill(skill: &SkillManifestEntry, settings: &UserSkillSettings) -> String {
    if skill.source != "user" {
        return "enabled".to_string();
    }
    settings
        .records
        .get(&skill.id)
        .map(|record| record.desired_state.clone())
        .unwrap_or_else(|| {
            if settings.enabled_skill_ids.contains(&skill.id) {
                "enabled".to_string()
            } else {
                "pending_enable".to_string()
            }
        })
}

fn user_status_for_skill(
    skill: &SkillManifestEntry,
    desired_state: &str,
    validation: Option<&UserSkillValidationResult>,
) -> String {
    if desired_state == "disabled" || desired_state == "archived" {
        return "disabled".to_string();
    }
    if desired_state == "draft" || desired_state == "pending_enable" {
        return "not_enabled".to_string();
    }
    if skill.status == "blocked_by_connector_auth" {
        return "needs_connection".to_string();
    }
    if skill.status == "missing_requirements" {
        return "unavailable".to_string();
    }
    if skill.status == "conflict_disabled"
        || skill.status == "invalid"
        || validation
            .map(|validation| !validation_matches_skill(validation, skill))
            .unwrap_or(false)
    {
        return "needs_fix".to_string();
    }
    if desired_state == "enabled" && skill.enabled && skill.status == "available" {
        return "available".to_string();
    }
    "not_enabled".to_string()
}

fn user_status_label(status: &str) -> &'static str {
    match status {
        "available" => "可用",
        "needs_connection" => "需要连接",
        "needs_fix" => "需要修复",
        "disabled" => "已停用",
        "unavailable" => "暂不可用",
        _ => "未启用",
    }
}

fn ensure_user_skill(skill: &SkillManifestEntry) -> Result<(), ApiError> {
    if skill.source == "user" {
        return Ok(());
    }
    Err(ApiError::new(
        StatusCode::FORBIDDEN,
        json!({
            "code": "read_only",
            "message": "Ripple built-in skills are read-only."
        }),
    ))
}

fn validate_draft_input(input: &SkillDraftInput) -> Result<(), ApiError> {
    if input.description.trim().is_empty() {
        return Err(ApiError::bad_request("description is required"));
    }
    if normalized_input_kind(input) == "text"
        && input.steps.iter().all(|step| step.trim().is_empty())
    {
        return Err(ApiError::bad_request("at least one step is required"));
    }
    Ok(())
}

fn skill_name_from_input(name: Option<&str>, display_name: Option<&str>) -> String {
    let seed = name
        .filter(|value| !value.trim().is_empty())
        .or_else(|| display_name.filter(|value| !value.trim().is_empty()))
        .unwrap_or("skill");
    let mut out = String::new();
    let mut last_dash = false;
    for ch in seed.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() {
        format!(
            "skill-{}",
            Uuid::new_v4()
                .simple()
                .to_string()
                .chars()
                .take(8)
                .collect::<String>()
        )
    } else {
        out
    }
}

fn render_skill_markdown(name: &str, input: &SkillDraftInput) -> anyhow::Result<String> {
    let display_name = input.display_name.as_deref().unwrap_or(name);
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("name: {}\n", yaml_scalar(name)?));
    out.push_str(&format!("display_name: {}\n", yaml_scalar(display_name)?));
    out.push_str(&format!(
        "description: {}\n",
        yaml_scalar(input.description.trim())?
    ));
    if let Some(when_to_use) = input
        .when_to_use
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        out.push_str(&format!(
            "when_to_use: {}\n",
            yaml_scalar(when_to_use.trim())?
        ));
    }
    let kind = normalized_input_kind(input);
    let runtime = normalized_runtime(input.runtime.as_deref(), &kind);
    let entry = if kind == "executable" {
        normalized_entry(input.entry.as_deref())
    } else {
        input
            .entry
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let python_packages = cleaned_python_packages(&input.python_packages);
    let connectors = cleaned_connectors(&input.requires_connectors);
    if kind != "text"
        || runtime.is_some()
        || entry.is_some()
        || !python_packages.is_empty()
        || !connectors.is_empty()
    {
        out.push_str("metadata:\n");
        out.push_str(&format!("  kind: {}\n", yaml_scalar(&kind)?));
        if let Some(runtime) = runtime.as_deref() {
            out.push_str(&format!("  runtime: {}\n", yaml_scalar(runtime)?));
        }
        if let Some(entry) = entry.as_deref() {
            out.push_str(&format!("  entry: {}\n", yaml_scalar(entry)?));
        }
        if !python_packages.is_empty() || !connectors.is_empty() {
            out.push_str("  requires:\n");
        }
        if !python_packages.is_empty() {
            out.push_str("    python_packages:\n");
            for package in &python_packages {
                out.push_str(&format!("      - {}\n", yaml_scalar(package)?));
            }
        }
        if !connectors.is_empty() {
            out.push_str("    connectors:\n");
            for connector in connectors {
                out.push_str(&format!("      - {}\n", yaml_scalar(&connector)?));
            }
        }
    } else if !input.requires_connectors.is_empty() {
        out.push_str("metadata:\n  requires:\n    connectors:\n");
        for connector in cleaned_connectors(&input.requires_connectors) {
            out.push_str(&format!("      - {}\n", yaml_scalar(&connector)?));
        }
    }
    out.push_str("---\n\n");
    out.push_str(&format!("# {display_name}\n\n"));
    if let Some(when_to_use) = input
        .when_to_use
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        out.push_str("## When To Use\n");
        out.push_str(when_to_use.trim());
        out.push_str("\n\n");
    }
    if kind == "executable" {
        out.push_str("## Execution\n");
        out.push_str("Run the Python entrypoint declared in the skill metadata.\n\n");
    } else {
        out.push_str("## Steps\n");
        for step in input.steps.iter().filter(|step| !step.trim().is_empty()) {
            out.push_str("- ");
            out.push_str(step.trim());
            out.push('\n');
        }
        out.push('\n');
    }
    if let Some(output_format) = input
        .output_format
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        out.push_str("## Output Format\n");
        out.push_str(output_format.trim());
        out.push_str("\n\n");
    }
    out.push_str("## Safety\n");
    if input.requires_user_confirmation {
        out.push_str("- User confirmation required: yes\n\n");
    } else {
        out.push_str("- User confirmation required: no\n\n");
    }
    if let Some(test_example) = input
        .test_example
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        out.push_str("## Test Example\n");
        out.push_str(test_example.trim());
        out.push('\n');
    }
    Ok(out)
}

fn yaml_scalar(value: &str) -> anyhow::Result<String> {
    let mut rendered = serde_yaml::to_string(value)?;
    if rendered.ends_with('\n') {
        rendered.pop();
    }
    Ok(rendered)
}

fn cleaned_connectors(connectors: &[String]) -> Vec<String> {
    let mut out = connectors
        .iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    out.sort();
    out.dedup();
    out
}

fn cleaned_python_packages(packages: &[String]) -> Vec<String> {
    let mut out = packages
        .iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    out.sort();
    out.dedup();
    out
}

fn normalized_input_kind(input: &SkillDraftInput) -> String {
    input
        .kind
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| {
            if input.runtime.is_some()
                || input.entry.is_some()
                || !input.python_packages.is_empty()
                || input.script.is_some()
            {
                "executable".to_string()
            } else {
                "text".to_string()
            }
        })
}

fn normalized_runtime(runtime: Option<&str>, kind: &str) -> Option<String> {
    runtime
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
        .or_else(|| (kind == "executable").then(|| "python".to_string()))
}

fn normalized_entry(entry: Option<&str>) -> Option<String> {
    entry
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| Some("scripts/run.py".to_string()))
}

fn merged_patch_input(skill: &SkillManifestEntry, patch: &SkillPatchRequest) -> SkillDraftInput {
    SkillDraftInput {
        name: Some(skill.name.clone()),
        display_name: Some(
            patch
                .display_name
                .clone()
                .unwrap_or_else(|| skill.display_name.clone()),
        ),
        description: patch
            .description
            .clone()
            .unwrap_or_else(|| skill.description.clone()),
        when_to_use: patch
            .when_to_use
            .clone()
            .or_else(|| skill.when_to_use.clone()),
        steps: patch
            .steps
            .clone()
            .unwrap_or_else(|| vec!["Follow the saved workflow.".to_string()]),
        output_format: patch.output_format.clone(),
        kind: patch.kind.clone().or_else(|| Some(skill.kind.clone())),
        runtime: patch.runtime.clone().or_else(|| skill.runtime.clone()),
        entry: patch.entry.clone().or_else(|| skill.entry.clone()),
        python_packages: patch
            .python_packages
            .clone()
            .unwrap_or_else(|| skill.python_packages.clone()),
        script: patch.script.clone(),
        requires_connectors: patch
            .requires_connectors
            .clone()
            .unwrap_or_else(|| skill.requires_connectors.clone()),
        requires_user_confirmation: patch.requires_user_confirmation.unwrap_or(false),
        test_example: patch.test_example.clone(),
    }
}

fn validate_user_skill(
    config: &crate::config::AppConfig,
    skill: &SkillManifestEntry,
) -> Result<UserSkillValidationResult, ApiError> {
    let text = std::fs::read_to_string(&skill.path)?;
    let mut checks = Vec::new();
    let mut issues = Vec::new();

    push_check(
        &mut checks,
        &mut issues,
        "frontmatter",
        frontmatter_parses(&text),
        "Skill frontmatter parses.",
        "Fix the SKILL.md YAML frontmatter.",
    );
    push_check(
        &mut checks,
        &mut issues,
        "format",
        !skill.name.trim().is_empty()
            && !skill.description.trim().is_empty()
            && body_has_content(&text),
        "Skill has a name, description, and body.",
        "Add a name, description, and body content.",
    );
    push_check(
        &mut checks,
        &mut issues,
        "kind",
        skill.kind == "text" || skill.kind == "executable",
        "Skill kind is supported.",
        "Skill kind must be text or executable.",
    );
    if skill.kind == "executable" {
        validate_python_skill(config, skill, &mut checks, &mut issues);
    }
    push_check(
        &mut checks,
        &mut issues,
        "safety",
        safety_check_passes(&text),
        "Safety rules are explicit.",
        "Dangerous operations must require user confirmation and must not store credentials.",
    );
    push_check(
        &mut checks,
        &mut issues,
        "dependencies",
        skill.missing_connectors.is_empty()
            && skill.blocked_connectors.is_empty()
            && skill.missing_bins.is_empty(),
        "Required services and system support are available.",
        "Connect required services or ask an administrator to enable missing system support.",
    );
    let passed = checks.iter().all(|check| check.status == "passed");
    Ok(UserSkillValidationResult {
        passed,
        content_hash: Some(skill.content_hash.clone()),
        checks,
        issues,
        preview: Some(build_validation_preview(skill, &text)),
        validated_at: Some(now_iso()),
    })
}

fn validate_python_skill(
    config: &crate::config::AppConfig,
    skill: &SkillManifestEntry,
    checks: &mut Vec<UserSkillValidationCheck>,
    issues: &mut Vec<String>,
) {
    push_check(
        checks,
        issues,
        "runtime",
        skill.runtime.as_deref() == Some("python"),
        "Python runtime is supported.",
        "Only Python executable skills are supported.",
    );

    let entry_valid = skill
        .entry
        .as_deref()
        .map(safe_relative_entry_path)
        .unwrap_or(false);
    let entry_file = skill.entry.as_deref().and_then(|entry| {
        PathBuf::from(&skill.path)
            .parent()
            .map(|parent| parent.join(entry))
    });
    let entry_exists = entry_file
        .as_ref()
        .map(|path| path.is_file())
        .unwrap_or(false);
    let entry_is_python = entry_file
        .as_ref()
        .and_then(|path| path.extension())
        .and_then(|ext| ext.to_str())
        == Some("py");
    push_check(
        checks,
        issues,
        "entry",
        entry_valid && entry_exists && entry_is_python,
        "Python entrypoint is a safe in-skill .py file.",
        if !entry_valid {
            "Python entry must be a relative path inside the skill directory."
        } else if !entry_exists {
            "Python entry file is missing."
        } else {
            "Python entry file must use the .py extension."
        },
    );

    let packages = cleaned_python_packages(&skill.python_packages);
    let packages_valid = packages.len() <= config.sandbox.python_env_max_packages
        && packages
            .iter()
            .all(|package| validate_requirement(package).is_ok());
    push_check(
        checks,
        issues,
        "python_packages",
        packages_valid,
        "Python package requirements are supported.",
        "Python package requirements must be pinned package specs without URLs, paths, or whitespace.",
    );
}

fn validation_matches_skill(
    validation: &UserSkillValidationResult,
    skill: &SkillManifestEntry,
) -> bool {
    validation.passed && validation.content_hash.as_deref() == Some(skill.content_hash.as_str())
}

fn frontmatter_parses(text: &str) -> bool {
    let Some(rest) = text.strip_prefix("---\n") else {
        return false;
    };
    let Some((yaml, _)) = rest.split_once("\n---") else {
        return false;
    };
    serde_yaml::from_str::<serde_yaml::Value>(yaml).is_ok()
}

fn body_has_content(text: &str) -> bool {
    text.split_once("\n---")
        .map(|(_, body)| body.trim())
        .filter(|body| !body.is_empty())
        .is_some()
}

fn safe_relative_entry_path(value: &str) -> bool {
    let path = Path::new(value);
    !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn push_check(
    checks: &mut Vec<UserSkillValidationCheck>,
    issues: &mut Vec<String>,
    name: &str,
    passed: bool,
    passed_message: &str,
    failed_message: &str,
) {
    let message = if passed {
        passed_message.to_string()
    } else {
        issues.push(failed_message.to_string());
        failed_message.to_string()
    };
    checks.push(UserSkillValidationCheck {
        name: name.to_string(),
        status: if passed { "passed" } else { "failed" }.to_string(),
        message,
    });
}

fn safety_check_passes(text: &str) -> bool {
    let lower = text.to_lowercase();
    let stores_secret = [
        "保存 token",
        "保存token",
        "save token",
        "store token",
        "cookie",
        "oauth credential",
        "auth.json",
        "codex_home",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    if stores_secret {
        return false;
    }
    let destructive = [
        "send email",
        "发送邮件",
        "delete",
        "删除",
        "share",
        "分享",
        "write",
        "写入",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    !destructive || lower.contains("user confirmation required: yes")
}

fn build_validation_preview(skill: &SkillManifestEntry, text: &str) -> String {
    let example = text
        .split_once("## Test Example")
        .map(|(_, rest)| {
            rest.lines()
                .skip(1)
                .take_while(|line| !line.starts_with("## "))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    format!(
        "Preview for {}: {}",
        skill.display_name,
        example.trim().chars().take(240).collect::<String>()
    )
}

fn archive_skill_path(
    state: &AppState,
    user_id: &str,
    skill: &SkillManifestEntry,
) -> Result<(), ApiError> {
    let archive_root = state.sandboxes.skill_archive_dir(user_id)?;
    std::fs::create_dir_all(&archive_root)?;
    let path = PathBuf::from(&skill.path);
    let source = archive_source_path(&path);
    if !source.exists() {
        return Ok(());
    }
    let archive_name = format!(
        "{}-{}",
        skill.name,
        OffsetDateTime::now_utc().unix_timestamp()
    );
    let destination = unique_archive_path(&archive_root, &archive_name);
    std::fs::rename(source, destination)?;
    Ok(())
}

fn archive_source_path(path: &Path) -> PathBuf {
    if path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md") {
        path.parent().unwrap_or(path).to_path_buf()
    } else {
        path.to_path_buf()
    }
}

fn unique_archive_path(root: &Path, name: &str) -> PathBuf {
    let base = root.join(name);
    if !base.exists() {
        return base;
    }
    for index in 1..1000 {
        let candidate = root.join(format!("{name}-{index}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    root.join(format!("{name}-{}", Uuid::new_v4().simple()))
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}
