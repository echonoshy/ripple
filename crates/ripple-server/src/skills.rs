use std::collections::{BTreeMap, BTreeSet};
use std::path::Component;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::{resolve_path, AppConfig};

const SOURCE_RIPPLE: &str = "ripple";
const SOURCE_USER: &str = "user";
const STATUS_AVAILABLE: &str = "available";
const STATUS_DRAFT: &str = "draft";
const STATUS_INVALID: &str = "invalid";
const STATUS_PENDING_ENABLE: &str = "pending_enable";
const STATUS_CONFLICT_DISABLED: &str = "conflict_disabled";
const STATUS_MISSING_REQUIREMENTS: &str = "missing_requirements";
const STATUS_BLOCKED_BY_CONNECTOR_AUTH: &str = "blocked_by_connector_auth";
const KNOWN_CONNECTORS: &[&str] = &["bilibili", "feishu", "google_workspace", "lark", "notion"];

#[derive(Debug, Clone, Serialize)]
pub struct SkillManifestEntry {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub namespace: String,
    pub description: String,
    pub source: String,
    pub display_source: String,
    pub path: String,
    pub when_to_use: Option<String>,
    pub version: Option<String>,
    pub kind: String,
    pub runtime: Option<String>,
    pub entry: Option<String>,
    pub python_packages: Vec<String>,
    pub content_hash: String,
    pub enabled: bool,
    pub status: String,
    pub conflict_with: Option<String>,
    pub requires_bins: Vec<String>,
    pub requires_connectors: Vec<String>,
    pub risk_flags: Vec<String>,
    pub missing_bins: Vec<String>,
    pub missing_connectors: Vec<String>,
    pub blocked_connectors: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SkillManifestOptions {
    pub enabled_user_skill_ids: BTreeSet<String>,
    pub validated_user_skill_ids: BTreeSet<String>,
    pub validated_user_skill_hashes: BTreeMap<String, String>,
    pub archived_user_skill_ids: BTreeSet<String>,
    pub connector_statuses: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct UserSkillSettings {
    #[serde(default)]
    pub enabled_skill_ids: BTreeSet<String>,
    #[serde(default)]
    pub records: BTreeMap<String, UserSkillRecord>,
}

impl UserSkillSettings {
    pub fn enabled_manifest_skill_ids(&self) -> BTreeSet<String> {
        let mut ids = self.enabled_skill_ids.clone();
        for (id, record) in &self.records {
            if record.desired_state == "enabled" {
                ids.insert(id.clone());
            } else {
                ids.remove(id);
            }
        }
        ids
    }

    pub fn validated_manifest_skill_ids(&self) -> BTreeSet<String> {
        let mut ids = self.enabled_skill_ids.clone();
        for (id, record) in &self.records {
            if record
                .validation
                .as_ref()
                .map(|validation| validation.passed)
                .unwrap_or(false)
            {
                ids.insert(id.clone());
            } else {
                ids.remove(id);
            }
        }
        ids
    }

    pub fn archived_skill_ids(&self) -> BTreeSet<String> {
        self.records
            .iter()
            .filter(|(_, record)| record.desired_state == "archived")
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub fn validated_manifest_skill_hashes(&self) -> BTreeMap<String, String> {
        self.records
            .iter()
            .filter_map(|(id, record)| {
                let validation = record.validation.as_ref()?;
                if !validation.passed {
                    return None;
                }
                Some((id.clone(), validation.content_hash.clone()?))
            })
            .collect()
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UserSkillRecord {
    pub desired_state: String,
    #[serde(default)]
    pub validation: Option<UserSkillValidationResult>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub last_tested_at: Option<String>,
}

impl Default for UserSkillRecord {
    fn default() -> Self {
        Self {
            desired_state: STATUS_DRAFT.to_string(),
            validation: None,
            created_at: None,
            updated_at: None,
            last_tested_at: None,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct UserSkillValidationResult {
    pub passed: bool,
    #[serde(default)]
    pub content_hash: Option<String>,
    #[serde(default)]
    pub checks: Vec<UserSkillValidationCheck>,
    #[serde(default)]
    pub issues: Vec<String>,
    #[serde(default)]
    pub preview: Option<String>,
    #[serde(default)]
    pub validated_at: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct UserSkillValidationCheck {
    pub name: String,
    pub status: String,
    pub message: String,
}

pub fn build_skill_manifest(
    config: &AppConfig,
    workspace_root: Option<&Path>,
) -> Vec<SkillManifestEntry> {
    build_skill_manifest_with_options(config, workspace_root, &SkillManifestOptions::default())
}

pub fn build_skill_manifest_with_options(
    config: &AppConfig,
    workspace_root: Option<&Path>,
    options: &SkillManifestOptions,
) -> Vec<SkillManifestEntry> {
    let mut entries = Vec::new();
    let mut shared_by_name = BTreeMap::new();
    for shared in shared_skill_dirs(config) {
        for skill in load_skills_from_dir(config, &shared, SOURCE_RIPPLE, options) {
            shared_by_name.entry(skill.name.clone()).or_insert(skill);
        }
    }
    let shared_names = shared_by_name.keys().cloned().collect::<BTreeSet<_>>();
    entries.extend(shared_by_name.into_values());

    let mut user_by_name = BTreeMap::new();
    if let Some(workspace_root) = workspace_root {
        for mut skill in
            load_skills_from_dir(config, &workspace_root.join("skills"), SOURCE_USER, options)
        {
            if options.archived_user_skill_ids.contains(&skill.id) {
                continue;
            }
            let validated_for_current_content = options
                .validated_user_skill_hashes
                .get(&skill.id)
                .map(|hash| hash == &skill.content_hash)
                .unwrap_or(false)
                && options.validated_user_skill_ids.contains(&skill.id);
            if shared_names.contains(&skill.name) {
                skill.enabled = false;
                skill.status = STATUS_CONFLICT_DISABLED.to_string();
                skill.conflict_with = Some(format!("{SOURCE_RIPPLE}:{}", skill.name));
            } else if skill.status == STATUS_INVALID {
                skill.enabled = false;
            } else if !options.enabled_user_skill_ids.contains(&skill.id) {
                skill.enabled = false;
                skill.status = STATUS_PENDING_ENABLE.to_string();
            } else if !validated_for_current_content {
                skill.enabled = false;
                skill.status = STATUS_INVALID.to_string();
            }
            user_by_name.entry(skill.name.clone()).or_insert(skill);
        }
    }
    entries.extend(user_by_name.into_values());
    entries.sort_by(|left, right| {
        left.id
            .cmp(&right.id)
            .then_with(|| left.path.cmp(&right.path))
    });
    entries
}

pub fn render_skill_manifest(config: &AppConfig, workspace_root: Option<&Path>) -> String {
    render_skill_manifest_with_options(config, workspace_root, &SkillManifestOptions::default())
}

pub fn render_skill_manifest_with_options(
    config: &AppConfig,
    workspace_root: Option<&Path>,
    options: &SkillManifestOptions,
) -> String {
    let entries = build_skill_manifest_with_options(config, workspace_root, options)
        .into_iter()
        .filter(|entry| entry.enabled && entry.status == STATUS_AVAILABLE)
        .collect::<Vec<_>>();
    render_skill_entries(entries)
}

pub fn render_all_skill_manifest_with_options(
    config: &AppConfig,
    workspace_root: Option<&Path>,
    options: &SkillManifestOptions,
) -> String {
    render_skill_entries(build_skill_manifest_with_options(
        config,
        workspace_root,
        options,
    ))
}

fn render_skill_entries(entries: Vec<SkillManifestEntry>) -> String {
    if entries.is_empty() {
        return "- no skills available".to_string();
    }
    entries
        .into_iter()
        .map(|entry| {
            let mut line = format!(
                "- {} ({}): {}\n  path: {}",
                entry.id,
                entry.source,
                if entry.description.is_empty() {
                    "(no description)"
                } else {
                    &entry.description
                },
                entry.path
            );
            if let Some(when_to_use) = &entry.when_to_use {
                line.push_str(&format!("\n  when_to_use: {when_to_use}"));
            }
            if let Some(version) = &entry.version {
                line.push_str(&format!("\n  version: {version}"));
            }
            line.push_str(&format!("\n  kind: {}", entry.kind));
            if let Some(runtime) = &entry.runtime {
                line.push_str(&format!("\n  runtime: {runtime}"));
            }
            if let Some(skill_entry) = &entry.entry {
                line.push_str(&format!("\n  entry: {skill_entry}"));
            }
            if !entry.python_packages.is_empty() {
                line.push_str(&format!(
                    "\n  python_packages: {}",
                    entry.python_packages.join(", ")
                ));
            }
            if entry.kind == "executable"
                && entry.runtime.as_deref() == Some("python")
                && entry.entry.is_some()
            {
                line.push_str(&format!("\n  execute: {}", python_execute_command(&entry)));
            }
            line.push_str(&format!("\n  content_hash: {}", entry.content_hash));
            if entry.status != STATUS_AVAILABLE {
                line.push_str(&format!("\n  status: {}", entry.status));
            }
            if !entry.enabled {
                line.push_str("\n  enabled: false");
            }
            if let Some(conflict_with) = &entry.conflict_with {
                line.push_str(&format!("\n  conflict_with: {conflict_with}"));
            }
            if !entry.requires_bins.is_empty() {
                line.push_str(&format!(
                    "\n  requires_bins: {}",
                    render_requirement_list(&entry.requires_bins, &entry.missing_bins)
                ));
            }
            if !entry.requires_connectors.is_empty() {
                line.push_str(&format!(
                    "\n  requires_connectors: {}",
                    render_requirement_list_with_blocked(
                        &entry.requires_connectors,
                        &entry.missing_connectors,
                        &entry.blocked_connectors
                    )
                ));
            }
            if !entry.risk_flags.is_empty() {
                line.push_str(&format!("\n  risk_flags: {}", entry.risk_flags.join(", ")));
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn read_user_skill_settings(path: &Path) -> UserSkillSettings {
    let Ok(text) = std::fs::read_to_string(path) else {
        return UserSkillSettings::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn write_user_skill_settings(path: &Path, settings: &UserSkillSettings) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(settings)?)?;
    Ok(())
}

fn shared_skill_dirs(config: &AppConfig) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for pattern in &config.skills.shared_dirs {
        if pattern.contains('*') {
            let Some((prefix, suffix)) = pattern.split_once('*') else {
                continue;
            };
            let base = resolve_path(&config.repo_root, prefix.trim_end_matches('/'));
            let suffix = suffix.trim_start_matches('/');
            if let Ok(read_dir) = std::fs::read_dir(base) {
                for entry in read_dir.flatten() {
                    let path = entry.path().join(suffix);
                    if path.is_dir() {
                        dirs.push(path);
                    }
                }
            }
        } else {
            let path = resolve_path(&config.repo_root, pattern);
            if path.is_dir() {
                dirs.push(path);
            }
        }
    }
    dirs
}

fn load_skills_from_dir(
    config: &AppConfig,
    dir: &Path,
    source: &str,
    options: &SkillManifestOptions,
) -> Vec<SkillManifestEntry> {
    let mut out = Vec::new();
    if !dir.is_dir() {
        return out;
    }
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return out;
    };
    let mut paths = read_dir
        .flatten()
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    paths.sort();
    for path in paths {
        if path.is_dir() {
            out.extend(load_skills_from_dir(config, &path, source, options));
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }
        if let Some(skill) = load_skill_file(config, &path, source, options) {
            out.push(skill);
        }
    }
    out
}

fn load_skill_file(
    config: &AppConfig,
    path: &Path,
    source: &str,
    options: &SkillManifestOptions,
) -> Option<SkillManifestEntry> {
    let text = std::fs::read_to_string(path).ok()?;
    let metadata = parse_frontmatter(&text).unwrap_or_default();
    let is_entry = path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md");
    if !is_entry && !metadata.contains_key("name") && !metadata.contains_key("description") {
        return None;
    }
    let name = metadata
        .get("name")
        .and_then(serde_yaml::Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .map(str::to_string)
        })?;
    let display_name = metadata
        .get("display_name")
        .or_else(|| metadata.get("display-name"))
        .or_else(|| {
            metadata
                .get("metadata")
                .and_then(serde_yaml::Value::as_mapping)
                .and_then(|metadata| {
                    metadata
                        .get(serde_yaml::Value::String("display_name".to_string()))
                        .or_else(|| {
                            metadata.get(serde_yaml::Value::String("display-name".to_string()))
                        })
                })
        })
        .and_then(serde_yaml::Value::as_str)
        .unwrap_or(&name)
        .to_string();
    let requires = nested_mapping(&metadata, "requires");
    let requires_bins = string_list_field(requires, "bins");
    let requires_connectors = string_list_field(requires, "connectors");
    let python_packages = string_list_field_candidates(
        requires,
        &["python_packages", "python-packages", "python_packages"],
    );
    let kind = metadata_value(&metadata, "kind")
        .and_then(serde_yaml::Value::as_str)
        .map(normalized_kind)
        .unwrap_or_else(|| "text".to_string());
    let runtime = metadata_value(&metadata, "runtime")
        .and_then(serde_yaml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase);
    let entry = metadata_value(&metadata, "entry")
        .and_then(serde_yaml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let content_hash = content_hash_for_skill(path, entry.as_deref());
    let risk_flags = string_list_from_candidates(
        [
            metadata_value(&metadata, "risk"),
            metadata_value(&metadata, "risk_flags"),
            metadata_value(&metadata, "risk-flags"),
        ]
        .into_iter()
        .flatten(),
    );
    let missing_bins = requires_bins
        .iter()
        .filter(|bin| !bin_available(config, bin))
        .cloned()
        .collect::<Vec<_>>();
    let missing_connectors = requires_connectors
        .iter()
        .filter(|connector| !connector_available(connector))
        .cloned()
        .collect::<Vec<_>>();
    let blocked_connectors = requires_connectors
        .iter()
        .filter(|connector| {
            connector_available(connector)
                && options.connector_statuses.get(connector.as_str()).copied() == Some(false)
        })
        .cloned()
        .collect::<Vec<_>>();
    let mut enabled =
        missing_bins.is_empty() && missing_connectors.is_empty() && blocked_connectors.is_empty();
    let mut status = if !missing_bins.is_empty() || !missing_connectors.is_empty() {
        STATUS_MISSING_REQUIREMENTS
    } else if !blocked_connectors.is_empty() {
        STATUS_BLOCKED_BY_CONNECTOR_AUTH
    } else {
        STATUS_AVAILABLE
    };
    if source == SOURCE_USER
        && (kind != "text" && kind != "executable"
            || kind == "executable" && runtime.as_deref() != Some("python"))
    {
        enabled = false;
        status = STATUS_INVALID;
    }
    Some(SkillManifestEntry {
        id: format!("{source}:{name}"),
        name,
        display_name,
        namespace: source.to_string(),
        description: metadata
            .get("description")
            .and_then(serde_yaml::Value::as_str)
            .unwrap_or("")
            .to_string(),
        source: source.to_string(),
        display_source: if source == SOURCE_USER {
            "user"
        } else {
            "system"
        }
        .to_string(),
        path: path.to_string_lossy().to_string(),
        when_to_use: metadata
            .get("when-to-use")
            .or_else(|| metadata.get("when_to_use"))
            .and_then(serde_yaml::Value::as_str)
            .map(str::to_string),
        version: metadata
            .get("version")
            .and_then(serde_yaml::Value::as_str)
            .map(str::to_string),
        kind,
        runtime,
        entry,
        python_packages,
        content_hash,
        enabled,
        status: status.to_string(),
        conflict_with: None,
        requires_bins,
        requires_connectors,
        risk_flags,
        missing_bins,
        missing_connectors,
        blocked_connectors,
    })
}

fn parse_frontmatter(text: &str) -> Option<BTreeMap<String, serde_yaml::Value>> {
    let rest = text.strip_prefix("---\n")?;
    let (yaml, _) = rest.split_once("\n---")?;
    serde_yaml::from_str(yaml).ok()
}

fn nested_mapping<'a>(
    metadata: &'a BTreeMap<String, serde_yaml::Value>,
    key: &str,
) -> Option<&'a serde_yaml::Mapping> {
    metadata_value(metadata, key).and_then(serde_yaml::Value::as_mapping)
}

fn metadata_value<'a>(
    metadata: &'a BTreeMap<String, serde_yaml::Value>,
    key: &str,
) -> Option<&'a serde_yaml::Value> {
    metadata.get(key).or_else(|| {
        metadata
            .get("metadata")
            .and_then(serde_yaml::Value::as_mapping)
            .and_then(|metadata| metadata.get(serde_yaml::Value::String(key.to_string())))
    })
}

fn string_list_field(mapping: Option<&serde_yaml::Mapping>, key: &str) -> Vec<String> {
    string_list_field_candidates(mapping, &[key])
}

fn string_list_field_candidates(
    mapping: Option<&serde_yaml::Mapping>,
    keys: &[&str],
) -> Vec<String> {
    let Some(mapping) = mapping else {
        return Vec::new();
    };
    string_list_from_candidates(
        keys.iter()
            .filter_map(|key| mapping.get(serde_yaml::Value::String((*key).to_string()))),
    )
}

fn string_list_from_candidates<'a>(
    values: impl Iterator<Item = &'a serde_yaml::Value>,
) -> Vec<String> {
    let mut out = Vec::new();
    for value in values {
        match value {
            serde_yaml::Value::String(value) => push_clean(&mut out, value),
            serde_yaml::Value::Sequence(values) => {
                for value in values {
                    if let Some(value) = value.as_str() {
                        push_clean(&mut out, value);
                    }
                }
            }
            _ => {}
        }
    }
    out.sort();
    out.dedup();
    out
}

fn push_clean(out: &mut Vec<String>, value: &str) {
    let value = value.trim();
    if !value.is_empty() {
        out.push(value.to_string());
    }
}

fn render_requirement_list(values: &[String], missing: &[String]) -> String {
    render_requirement_list_with_blocked(values, missing, &[])
}

fn render_requirement_list_with_blocked(
    values: &[String],
    missing: &[String],
    blocked: &[String],
) -> String {
    values
        .iter()
        .map(|value| {
            if missing.iter().any(|missing| missing == value) {
                format!("{value} (missing)")
            } else if blocked.iter().any(|blocked| blocked == value) {
                format!("{value} (not_connected)")
            } else {
                value.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn connector_available(connector: &str) -> bool {
    KNOWN_CONNECTORS.contains(&connector)
}

fn bin_available(config: &AppConfig, bin: &str) -> bool {
    if let Some(root) = matching_vendor_root(config, bin) {
        if root.join("current/bin").join(bin).is_file() {
            return true;
        }
    }
    for tool in &config.sandbox.cli_tools {
        for bin_dir in &tool.bin_dirs {
            if tool.install_root.join(bin_dir).join(bin).is_file() {
                return true;
            }
        }
    }
    std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).any(|entry| entry.join(bin).is_file()))
        .unwrap_or(false)
}

fn matching_vendor_root<'a>(config: &'a AppConfig, bin: &str) -> Option<&'a Path> {
    match bin {
        "gog" => config.sandbox.gogcli_cli_install_root.as_deref(),
        "lark-cli" => config.sandbox.lark_cli_install_root.as_deref(),
        "ntn" => config.sandbox.notion_cli_install_root.as_deref(),
        _ => None,
    }
}

fn normalized_kind(value: &str) -> String {
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "" => "text".to_string(),
        "python" => "executable".to_string(),
        _ => normalized,
    }
}

fn content_hash_for_skill(path: &Path, entry: Option<&str>) -> String {
    let mut hasher = Sha256::new();
    hash_file_if_readable(&mut hasher, "SKILL.md", path);
    if let Some(entry) = entry.filter(|entry| safe_relative_path(entry)) {
        if let Some(parent) = path.parent() {
            let entry_path = parent.join(entry);
            if entry_path != path {
                hash_file_if_readable(&mut hasher, entry, &entry_path);
            }
        }
    }
    format!("sha256:{}", hex_digest(hasher.finalize().as_slice()))
}

fn hash_file_if_readable(hasher: &mut Sha256, label: &str, path: &Path) {
    hasher.update(label.as_bytes());
    hasher.update(b"\0");
    if let Ok(bytes) = std::fs::read(path) {
        hasher.update(bytes);
    }
    hasher.update(b"\0");
}

fn safe_relative_path(value: &str) -> bool {
    let path = Path::new(value);
    !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn python_execute_command(entry: &SkillManifestEntry) -> String {
    let mut command = String::from("ripple-py python");
    for package in &entry.python_packages {
        command.push_str(" --with ");
        command.push_str(package);
    }
    command.push_str(" -- ");
    if let Some(skill_entry) = &entry.entry {
        command.push_str(skill_entry);
    }
    command
}

fn hex_digest(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        AppConfig, CodexConfig, CorsConfig, FeishuConfig, GogcliOAuthConfig, LoggingConfig,
        SandboxConfig, SecurityConfig, SkillsConfig, UserAuthConfig,
    };
    use uuid::Uuid;

    fn test_config(root: &Path, shared_dirs: Vec<String>) -> AppConfig {
        AppConfig {
            repo_root: root.to_path_buf(),
            host: "127.0.0.1".to_string(),
            port: 0,
            api_keys: vec!["test-key".to_string()],
            security: SecurityConfig::default(),
            user_auth: UserAuthConfig::default(),
            api_docs: crate::config::ApiDocsConfig::default(),
            cors: CorsConfig::default(),
            default_model: "codex-test".to_string(),
            model_presets: BTreeMap::new(),
            logging: LoggingConfig {
                level: "debug".to_string(),
            },
            sandbox: SandboxConfig {
                sandboxes_root: root.join("sandboxes"),
                caches_root: root.join("cache"),
                idle_suspend_seconds: 1800,
                retention_seconds: 604_800,
                max_workspace_mb: 2048,
                tmpfs_size_mb: 64,
                nsjail_path: "nsjail".to_string(),
                python_envs_root: root.join("cache/python-envs"),
                python_env_uv_cache: root.join("cache/uv-cache"),
                python_env_max_packages: 20,
                uv_bin_dir: None,
                node_dir: None,
                lark_cli_install_root: None,
                notion_cli_install_root: None,
                gogcli_cli_install_root: None,
                cli_tools: Vec::new(),
                pypi_mirror_url: None,
                npm_registry_url: None,
            },
            codex: CodexConfig {
                enabled: true,
                codex_executable: "codex".to_string(),
                app_server_args: Vec::new(),
                codex_home: None,
                approval_policy: "never".to_string(),
                sandbox_type: "workspace-write".to_string(),
                network_access: true,
                idle_timeout_seconds: 1800,
                max_runtime_seconds: 3600,
            },
            schedule_extraction_max_runtime_seconds: 120,
            schedule_poll_interval_seconds: 15,
            document_preview: crate::config::DocumentPreviewConfig {
                cache_root: root.join("cache/previews"),
                libreoffice_path: "soffice".to_string(),
                max_source_bytes: 64 * 1024 * 1024,
                conversion_timeout_seconds: 120,
            },
            skills: SkillsConfig { shared_dirs },
            public_base_url: None,
            feishu: FeishuConfig::default(),
            gogcli_oauth: GogcliOAuthConfig {
                auto_register_client: true,
                auto_from_request: true,
                callback_url: None,
                client_secret_json: None,
                client: None,
            },
        }
    }

    fn write_skill(path: &Path, frontmatter: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, format!("---\n{frontmatter}\n---\n# Test skill\n")).unwrap();
    }

    #[test]
    fn shared_skill_wins_and_user_conflict_is_disabled() {
        let root = std::env::temp_dir().join(format!("ripple-skills-test-{}", Uuid::new_v4()));
        let shared = root.join("shared/demo/SKILL.md");
        let workspace = root.join("workspace");
        let user = workspace.join("skills/demo/SKILL.md");
        write_skill(
            &shared,
            r#"name: demo
description: shared demo
version: "1.0.0""#,
        );
        write_skill(
            &user,
            r#"name: demo
description: user demo
version: "9.9.9""#,
        );
        let config = test_config(
            &root,
            vec![root.join("shared").to_string_lossy().to_string()],
        );

        let entries = build_skill_manifest(&config, Some(&workspace));

        let shared_entry = entries
            .iter()
            .find(|entry| entry.id == "ripple:demo")
            .unwrap();
        assert_eq!(shared_entry.source, "ripple");
        assert!(shared_entry.enabled);
        assert_eq!(shared_entry.description, "shared demo");
        let user_entry = entries
            .iter()
            .find(|entry| entry.id == "user:demo")
            .unwrap();
        assert_eq!(user_entry.source, "user");
        assert!(!user_entry.enabled);
        assert_eq!(user_entry.status, "conflict_disabled");
        assert_eq!(user_entry.conflict_with.as_deref(), Some("ripple:demo"));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn user_skills_default_to_pending_enable() {
        let root = std::env::temp_dir().join(format!("ripple-skills-test-{}", Uuid::new_v4()));
        let workspace = root.join("workspace");
        let user = workspace.join("skills/user-demo/SKILL.md");
        write_skill(
            &user,
            r#"name: user-demo
description: user demo
version: "1.0.0""#,
        );
        let config = test_config(&root, Vec::new());

        let entries = build_skill_manifest(&config, Some(&workspace));
        let entry = entries
            .iter()
            .find(|entry| entry.id == "user:user-demo")
            .unwrap();

        assert_eq!(entry.source, "user");
        assert!(!entry.enabled);
        assert_eq!(entry.status, "pending_enable");

        let rendered = render_skill_manifest(&config, Some(&workspace));
        assert!(!rendered.contains("user:user-demo"));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn manifest_records_requirements_and_missing_status() {
        let root = std::env::temp_dir().join(format!("ripple-skills-test-{}", Uuid::new_v4()));
        let shared = root.join("shared/gmail/SKILL.md");
        write_skill(
            &shared,
            r#"name: gmail
description: Gmail workflow
requires:
  bins:
    - definitely-missing-ripple-test-bin
  connectors:
    - google_workspace
risk:
  - destructive"#,
        );
        let config = test_config(
            &root,
            vec![root.join("shared").to_string_lossy().to_string()],
        );

        let entries = build_skill_manifest(&config, None);
        let entry = entries
            .iter()
            .find(|entry| entry.id == "ripple:gmail")
            .unwrap();

        assert_eq!(
            entry.requires_bins,
            vec!["definitely-missing-ripple-test-bin"]
        );
        assert_eq!(entry.requires_connectors, vec!["google_workspace"]);
        assert_eq!(entry.risk_flags, vec!["destructive"]);
        assert!(!entry.enabled);
        assert_eq!(entry.status, "missing_requirements");

        let rendered =
            render_all_skill_manifest_with_options(&config, None, &SkillManifestOptions::default());
        assert!(rendered.contains("ripple:gmail"));
        assert!(rendered.contains("status: missing_requirements"));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn manifest_records_python_executable_metadata_and_content_hash() {
        let root = std::env::temp_dir().join(format!("ripple-skills-test-{}", Uuid::new_v4()));
        let workspace = root.join("workspace");
        let skill = workspace.join("skills/py-demo/SKILL.md");
        let script = workspace.join("skills/py-demo/scripts/run.py");
        write_skill(
            &skill,
            r#"name: py-demo
description: Python demo
metadata:
  kind: executable
  runtime: python
  entry: scripts/run.py
  requires:
    python_packages:
      - pandas==2.2.3
    connectors:
      - google_workspace"#,
        );
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::write(&script, "print('hello')\n").unwrap();
        let config = test_config(&root, Vec::new());

        let entries = build_skill_manifest(&config, Some(&workspace));
        let entry = entries
            .iter()
            .find(|entry| entry.id == "user:py-demo")
            .unwrap();

        assert_eq!(entry.display_source, "user");
        assert_eq!(entry.kind, "executable");
        assert_eq!(entry.runtime.as_deref(), Some("python"));
        assert_eq!(entry.entry.as_deref(), Some("scripts/run.py"));
        assert_eq!(entry.python_packages, vec!["pandas==2.2.3"]);
        assert!(!entry.content_hash.is_empty());

        let original_hash = entry.content_hash.clone();
        std::fs::write(&script, "print('changed')\n").unwrap();
        let changed = build_skill_manifest(&config, Some(&workspace))
            .into_iter()
            .find(|entry| entry.id == "user:py-demo")
            .unwrap();
        assert_ne!(changed.content_hash, original_hash);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn connector_backed_shared_skills_block_when_connector_is_not_connected() {
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .unwrap()
            .to_path_buf();
        let fake_gog_root =
            std::env::temp_dir().join(format!("ripple-gog-test-{}", Uuid::new_v4()));
        let fake_gog = fake_gog_root.join("current/bin/gog");
        std::fs::create_dir_all(fake_gog.parent().unwrap()).unwrap();
        std::fs::write(&fake_gog, "").unwrap();
        let mut config = test_config(&repo_root, vec!["skills/gog".to_string()]);
        config.sandbox.gogcli_cli_install_root = Some(fake_gog_root.clone());
        let mut options = SkillManifestOptions::default();
        options
            .connector_statuses
            .insert("google_workspace".to_string(), false);

        let entries = build_skill_manifest_with_options(&config, None, &options);
        let entry = entries
            .iter()
            .find(|entry| entry.id == "ripple:gog-gmail")
            .expect("gog-gmail skill should exist");

        assert_eq!(entry.requires_connectors, vec!["google_workspace"]);
        assert_eq!(entry.blocked_connectors, vec!["google_workspace"]);
        assert_eq!(entry.status, "blocked_by_connector_auth");
        assert!(!entry.enabled);

        let rendered = render_skill_manifest_with_options(&config, None, &options);
        assert!(!rendered.contains("ripple:gog-gmail"));

        let _ = std::fs::remove_dir_all(fake_gog_root);
    }
}
