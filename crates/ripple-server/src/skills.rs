use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::config::{resolve_path, AppConfig};

const SOURCE_RIPPLE: &str = "ripple";
const SOURCE_USER: &str = "user";
const STATUS_AVAILABLE: &str = "available";
const STATUS_CONFLICT_DISABLED: &str = "conflict_disabled";
const STATUS_MISSING_REQUIREMENTS: &str = "missing_requirements";
const KNOWN_CONNECTORS: &[&str] = &["bilibili", "feishu", "google_workspace", "lark", "notion"];

#[derive(Debug, Clone, Serialize)]
pub struct SkillManifestEntry {
    pub id: String,
    pub name: String,
    pub namespace: String,
    pub description: String,
    pub source: String,
    pub path: String,
    pub when_to_use: Option<String>,
    pub version: Option<String>,
    pub enabled: bool,
    pub status: String,
    pub conflict_with: Option<String>,
    pub requires_bins: Vec<String>,
    pub requires_connectors: Vec<String>,
    pub risk_flags: Vec<String>,
    pub missing_bins: Vec<String>,
    pub missing_connectors: Vec<String>,
}

pub fn build_skill_manifest(
    config: &AppConfig,
    workspace_root: Option<&Path>,
) -> Vec<SkillManifestEntry> {
    let mut entries = Vec::new();
    let mut shared_by_name = BTreeMap::new();
    for shared in shared_skill_dirs(config) {
        for skill in load_skills_from_dir(config, &shared, SOURCE_RIPPLE) {
            shared_by_name.entry(skill.name.clone()).or_insert(skill);
        }
    }
    let shared_names = shared_by_name.keys().cloned().collect::<BTreeSet<_>>();
    entries.extend(shared_by_name.into_values());

    let mut user_by_name = BTreeMap::new();
    if let Some(workspace_root) = workspace_root {
        for mut skill in load_skills_from_dir(config, &workspace_root.join("skills"), SOURCE_USER) {
            if shared_names.contains(&skill.name) {
                skill.enabled = false;
                skill.status = STATUS_CONFLICT_DISABLED.to_string();
                skill.conflict_with = Some(format!("{SOURCE_RIPPLE}:{}", skill.name));
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
    let entries = build_skill_manifest(config, workspace_root);
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
            if let Some(when_to_use) = entry.when_to_use {
                line.push_str(&format!("\n  when_to_use: {when_to_use}"));
            }
            if let Some(version) = entry.version {
                line.push_str(&format!("\n  version: {version}"));
            }
            if entry.status != STATUS_AVAILABLE {
                line.push_str(&format!("\n  status: {}", entry.status));
            }
            if !entry.enabled {
                line.push_str("\n  enabled: false");
            }
            if let Some(conflict_with) = entry.conflict_with {
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
                    render_requirement_list(&entry.requires_connectors, &entry.missing_connectors)
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

fn load_skills_from_dir(config: &AppConfig, dir: &Path, source: &str) -> Vec<SkillManifestEntry> {
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
            out.extend(load_skills_from_dir(config, &path, source));
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }
        if let Some(skill) = load_skill_file(config, &path, source) {
            out.push(skill);
        }
    }
    out
}

fn load_skill_file(config: &AppConfig, path: &Path, source: &str) -> Option<SkillManifestEntry> {
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
    let requires = nested_mapping(&metadata, "requires");
    let requires_bins = string_list_field(requires, "bins");
    let requires_connectors = string_list_field(requires, "connectors");
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
    let enabled = missing_bins.is_empty() && missing_connectors.is_empty();
    let status = if enabled {
        STATUS_AVAILABLE
    } else {
        STATUS_MISSING_REQUIREMENTS
    };
    Some(SkillManifestEntry {
        id: format!("{source}:{name}"),
        name,
        namespace: source.to_string(),
        description: metadata
            .get("description")
            .and_then(serde_yaml::Value::as_str)
            .unwrap_or("")
            .to_string(),
        source: source.to_string(),
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
        enabled,
        status: status.to_string(),
        conflict_with: None,
        requires_bins,
        requires_connectors,
        risk_flags,
        missing_bins,
        missing_connectors,
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
    let Some(mapping) = mapping else {
        return Vec::new();
    };
    string_list_from_candidates(
        [mapping.get(serde_yaml::Value::String(key.to_string()))]
            .into_iter()
            .flatten(),
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
    values
        .iter()
        .map(|value| {
            if missing.iter().any(|missing| missing == value) {
                format!("{value} (missing)")
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

        let rendered = render_skill_manifest(&config, None);
        assert!(rendered.contains("ripple:gmail"));
        assert!(rendered.contains("status: missing_requirements"));

        let _ = std::fs::remove_dir_all(root);
    }
}
