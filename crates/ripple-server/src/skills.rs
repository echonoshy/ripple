use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::config::{resolve_path, AppConfig};

#[derive(Debug, Clone, Serialize)]
pub struct SkillManifestEntry {
    pub name: String,
    pub description: String,
    pub source: String,
    pub path: String,
    pub when_to_use: Option<String>,
    pub version: Option<String>,
}

pub fn build_skill_manifest(
    config: &AppConfig,
    workspace_root: Option<&Path>,
) -> Vec<SkillManifestEntry> {
    let mut skills = BTreeMap::new();
    for shared in shared_skill_dirs(config) {
        load_skills_from_dir(&shared, "shared", &mut skills);
    }
    if let Some(workspace_root) = workspace_root {
        load_skills_from_dir(&workspace_root.join("skills"), "workspace", &mut skills);
    }
    skills.into_values().collect()
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
                entry.name,
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

fn load_skills_from_dir(dir: &Path, source: &str, out: &mut BTreeMap<String, SkillManifestEntry>) {
    if !dir.is_dir() {
        return;
    }
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        if path.is_dir() {
            load_skills_from_dir(&path, source, out);
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }
        if let Some(skill) = load_skill_file(&path, source) {
            out.insert(skill.name.clone(), skill);
        }
    }
}

fn load_skill_file(path: &Path, source: &str) -> Option<SkillManifestEntry> {
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
    Some(SkillManifestEntry {
        name,
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
    })
}

fn parse_frontmatter(text: &str) -> Option<BTreeMap<String, serde_yaml::Value>> {
    let rest = text.strip_prefix("---\n")?;
    let (yaml, _) = rest.split_once("\n---")?;
    serde_yaml::from_str(yaml).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        AppConfig, CodexConfig, CorsConfig, FeishuConfig, GogcliOAuthConfig, LoggingConfig,
        SandboxConfig, SecurityConfig, SkillsConfig,
    };
    use uuid::Uuid;

    fn test_config(root: &Path, shared_dirs: Vec<String>) -> AppConfig {
        AppConfig {
            repo_root: root.to_path_buf(),
            host: "127.0.0.1".to_string(),
            port: 0,
            api_keys: vec!["test-key".to_string()],
            security: SecurityConfig::default(),
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
        let config = test_config(&root, vec![root.join("shared").to_string_lossy().to_string()]);

        let entries = build_skill_manifest(&config, Some(&workspace));

        let shared_entry = entries.iter().find(|entry| entry.id == "ripple:demo").unwrap();
        assert_eq!(shared_entry.source, "ripple");
        assert!(shared_entry.enabled);
        assert_eq!(shared_entry.description, "shared demo");
        let user_entry = entries.iter().find(|entry| entry.id == "user:demo").unwrap();
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
        let config = test_config(&root, vec![root.join("shared").to_string_lossy().to_string()]);

        let entries = build_skill_manifest(&config, None);
        let entry = entries.iter().find(|entry| entry.id == "ripple:gmail").unwrap();

        assert_eq!(entry.requires_bins, vec!["definitely-missing-ripple-test-bin"]);
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
