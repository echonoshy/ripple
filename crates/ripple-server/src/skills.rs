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
