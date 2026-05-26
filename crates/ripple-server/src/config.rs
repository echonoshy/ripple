use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub repo_root: PathBuf,
    pub host: String,
    pub port: u16,
    pub api_keys: Vec<String>,
    pub default_model: String,
    pub model_presets: BTreeMap<String, ModelPreset>,
    pub sandbox: SandboxConfig,
    pub codex: CodexConfig,
    pub schedule_extraction_max_runtime_seconds: u64,
    pub skills: SkillsConfig,
    pub public_base_url: Option<String>,
    pub feishu: FeishuConfig,
    pub gogcli_oauth: GogcliOAuthConfig,
}

#[derive(Clone, Debug)]
pub struct ModelPreset {
    pub model: String,
    pub reasoning_effort: Option<String>,
}

#[derive(Clone, Debug)]
pub struct SandboxConfig {
    pub sandboxes_root: PathBuf,
    pub caches_root: PathBuf,
    pub idle_suspend_seconds: u64,
    pub retention_seconds: u64,
    pub max_workspace_mb: u64,
    pub tmpfs_size_mb: u64,
    pub nsjail_path: String,
    pub uv_bin_dir: Option<PathBuf>,
    pub node_dir: Option<PathBuf>,
    pub lark_cli_install_root: Option<PathBuf>,
    pub notion_cli_install_root: Option<PathBuf>,
    pub gogcli_cli_install_root: Option<PathBuf>,
    pub cli_tools: Vec<CliToolConfig>,
    pub pypi_mirror_url: Option<String>,
    pub npm_registry_url: Option<String>,
}

#[derive(Clone, Debug)]
pub struct CliToolConfig {
    pub name: String,
    pub install_root: PathBuf,
    pub sandbox_root: PathBuf,
    pub bin_dirs: Vec<PathBuf>,
}

#[derive(Clone, Debug)]
pub struct CodexConfig {
    pub enabled: bool,
    pub codex_executable: String,
    pub app_server_args: Vec<String>,
    pub codex_home: Option<PathBuf>,
    pub approval_policy: String,
    pub sandbox_type: String,
    pub network_access: bool,
    pub idle_timeout_seconds: u64,
    pub max_runtime_seconds: u64,
}

#[derive(Clone, Debug)]
pub struct SkillsConfig {
    pub shared_dirs: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct FeishuConfig {
    pub app: Option<FeishuAppConfig>,
}

#[derive(Clone, Debug)]
pub struct FeishuAppConfig {
    pub app_id: String,
    pub app_secret: String,
    pub brand: String,
}

#[derive(Clone, Debug)]
pub struct GogcliOAuthConfig {
    pub auto_register_client: bool,
    pub auto_from_request: bool,
    pub callback_url: Option<String>,
    pub client_secret_json: Option<String>,
    pub client: Option<GogcliOAuthClient>,
}

#[derive(Clone, Debug)]
pub struct GogcliOAuthClient {
    pub client_type: Option<String>,
    pub client_id: String,
    pub client_secret: String,
    pub project_id: Option<String>,
    pub auth_uri: Option<String>,
    pub token_uri: Option<String>,
    pub auth_provider_x509_cert_url: Option<String>,
    pub redirect_uris: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RawConfig {
    server: Option<RawServer>,
    model: Option<RawModel>,
    external_agents: Option<RawExternalAgents>,
    skills: Option<RawSkills>,
}

#[derive(Debug, Default, Deserialize)]
struct RawServer {
    host: Option<String>,
    port: Option<u16>,
    api_keys: Option<Vec<String>>,
    sandbox: Option<RawSandbox>,
    codex_chat: Option<RawCodexChat>,
    schedule_extraction: Option<RawScheduleExtraction>,
    public_base_url: Option<String>,
    feishu: Option<RawFeishu>,
    gogcli_oauth: Option<RawGogcliOAuth>,
}

#[derive(Debug, Default, Deserialize)]
struct RawCodexChat {
    max_runtime_seconds: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
struct RawScheduleExtraction {
    max_runtime_seconds: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
struct RawSandbox {
    sandboxes_root: Option<String>,
    caches_root: Option<String>,
    idle_suspend_seconds: Option<u64>,
    retention_seconds: Option<u64>,
    max_workspace_mb: Option<u64>,
    tmpfs_size_mb: Option<u64>,
    nsjail_path: Option<String>,
    uv_bin_dir: Option<String>,
    node_dir: Option<String>,
    lark_cli_install_root: Option<String>,
    notion_cli_install_root: Option<String>,
    gogcli_cli_install_root: Option<String>,
    cli_tools: Option<Vec<RawCliTool>>,
    pypi_mirror_url: Option<String>,
    npm_registry_url: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RawCliTool {
    name: Option<String>,
    install_root: Option<String>,
    sandbox_root: Option<String>,
    bin_dirs: Option<Vec<String>>,
}

#[derive(Debug, Default, Deserialize)]
struct RawModel {
    default: Option<String>,
    presets: Option<BTreeMap<String, BTreeMap<String, serde_yaml::Value>>>,
}

#[derive(Debug, Default, Deserialize)]
struct RawExternalAgents {
    codex: Option<RawCodex>,
}

#[derive(Debug, Default, Deserialize)]
struct RawCodex {
    enabled: Option<bool>,
    codex_executable: Option<String>,
    app_server_args: Option<Vec<String>>,
    codex_home: Option<String>,
    approval_policy: Option<String>,
    sandbox_type: Option<String>,
    network_access: Option<bool>,
    idle_timeout_seconds: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
struct RawSkills {
    shared_dirs: Option<Vec<String>>,
}

#[derive(Debug, Default, Deserialize)]
struct RawFeishu {
    app: Option<RawFeishuApp>,
    app_id: Option<String>,
    app_secret: Option<String>,
    brand: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RawFeishuApp {
    app_id: Option<String>,
    app_secret: Option<String>,
    brand: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RawGogcliOAuth {
    auto_register_client: Option<bool>,
    auto_from_request: Option<bool>,
    callback_url: Option<String>,
    client_secret_json: Option<String>,
    client: Option<RawGogcliOAuthClient>,
}

#[derive(Debug, Default, Deserialize)]
struct RawGogcliOAuthClient {
    #[serde(rename = "type")]
    client_type: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
    project_id: Option<String>,
    auth_uri: Option<String>,
    token_uri: Option<String>,
    auth_provider_x509_cert_url: Option<String>,
    redirect_uris: Option<Vec<String>>,
}

impl AppConfig {
    pub fn load() -> anyhow::Result<Self> {
        let repo_root = std::env::current_dir()?;
        let config_path = std::env::var("RIPPLE_CONFIG")
            .map(PathBuf::from)
            .unwrap_or_else(|_| repo_root.join("config/settings.yaml"));
        let raw = if config_path.exists() {
            let text = std::fs::read_to_string(&config_path)?;
            serde_yaml::from_str::<RawConfig>(&text)?
        } else {
            RawConfig::default()
        };

        let server = raw.server.unwrap_or_default();
        let sandbox = server.sandbox.unwrap_or_default();
        let model = raw.model.unwrap_or_default();
        let public_base_url = clean_config_string(server.public_base_url.as_deref());
        let feishu = parse_feishu_config(server.feishu);
        let gogcli_oauth_raw = server.gogcli_oauth.unwrap_or_default();
        let codex_raw = raw
            .external_agents
            .unwrap_or_default()
            .codex
            .unwrap_or_default();
        let codex_chat = server.codex_chat.unwrap_or_default();
        let schedule_extraction = server.schedule_extraction.unwrap_or_default();
        let skills_raw = raw.skills.unwrap_or_default();

        let model_presets = parse_model_presets(model.presets.unwrap_or_default());
        let default_model = model.default.unwrap_or_else(|| "codex-medium".to_string());

        Ok(Self {
            repo_root: repo_root.clone(),
            host: server.host.unwrap_or_else(|| "0.0.0.0".to_string()),
            port: server.port.unwrap_or(8810),
            api_keys: server.api_keys.unwrap_or_default(),
            default_model,
            model_presets,
            sandbox: SandboxConfig {
                sandboxes_root: resolve_path(
                    &repo_root,
                    sandbox
                        .sandboxes_root
                        .as_deref()
                        .unwrap_or(".ripple/sandboxes"),
                ),
                caches_root: resolve_path(
                    &repo_root,
                    sandbox
                        .caches_root
                        .as_deref()
                        .unwrap_or(".ripple/sandboxes-cache"),
                ),
                idle_suspend_seconds: sandbox.idle_suspend_seconds.unwrap_or(1800),
                retention_seconds: sandbox.retention_seconds.unwrap_or(604_800),
                max_workspace_mb: sandbox.max_workspace_mb.unwrap_or(2048),
                tmpfs_size_mb: sandbox.tmpfs_size_mb.unwrap_or(512),
                nsjail_path: sandbox.nsjail_path.unwrap_or_else(|| "nsjail".to_string()),
                uv_bin_dir: sandbox
                    .uv_bin_dir
                    .map(|value| resolve_path(&repo_root, &value))
                    .or_else(discover_uv_bin_dir),
                node_dir: sandbox
                    .node_dir
                    .map(|value| resolve_path(&repo_root, &value))
                    .or_else(discover_node_dir),
                lark_cli_install_root: sandbox
                    .lark_cli_install_root
                    .map(|value| resolve_path(&repo_root, &value))
                    .or_else(|| discover_vendor_root(&repo_root, "lark-cli", "lark-cli")),
                notion_cli_install_root: sandbox
                    .notion_cli_install_root
                    .map(|value| resolve_path(&repo_root, &value))
                    .or_else(|| discover_vendor_root(&repo_root, "notion-cli", "ntn")),
                gogcli_cli_install_root: sandbox
                    .gogcli_cli_install_root
                    .map(|value| resolve_path(&repo_root, &value))
                    .or_else(|| discover_vendor_root(&repo_root, "gogcli-cli", "gog")),
                cli_tools: parse_cli_tools(&repo_root, sandbox.cli_tools)?,
                pypi_mirror_url: sandbox.pypi_mirror_url,
                npm_registry_url: sandbox.npm_registry_url,
            },
            codex: CodexConfig {
                enabled: codex_raw.enabled.unwrap_or(true),
                codex_executable: codex_raw
                    .codex_executable
                    .unwrap_or_else(|| "codex".to_string()),
                app_server_args: codex_raw.app_server_args.unwrap_or_else(|| {
                    vec![
                        "app-server".to_string(),
                        "--listen".to_string(),
                        "stdio://".to_string(),
                    ]
                }),
                codex_home: codex_raw
                    .codex_home
                    .map(|value| resolve_path(&repo_root, &value)),
                approval_policy: codex_raw
                    .approval_policy
                    .unwrap_or_else(|| "never".to_string()),
                sandbox_type: codex_raw
                    .sandbox_type
                    .unwrap_or_else(|| "workspace-write".to_string()),
                network_access: codex_raw.network_access.unwrap_or(true),
                idle_timeout_seconds: codex_raw.idle_timeout_seconds.unwrap_or(1800),
                max_runtime_seconds: codex_chat.max_runtime_seconds.unwrap_or(3600),
            },
            schedule_extraction_max_runtime_seconds: schedule_extraction
                .max_runtime_seconds
                .unwrap_or(120)
                .max(1),
            skills: SkillsConfig {
                shared_dirs: skills_raw
                    .shared_dirs
                    .unwrap_or_else(|| vec!["skills/*".to_string()]),
            },
            public_base_url,
            feishu,
            gogcli_oauth: GogcliOAuthConfig {
                auto_register_client: gogcli_oauth_raw.auto_register_client.unwrap_or(true),
                auto_from_request: gogcli_oauth_raw.auto_from_request.unwrap_or(true),
                callback_url: clean_config_string(gogcli_oauth_raw.callback_url.as_deref()),
                client_secret_json: clean_config_string(
                    gogcli_oauth_raw.client_secret_json.as_deref(),
                ),
                client: parse_gogcli_oauth_client(gogcli_oauth_raw.client),
            },
        })
    }

    pub fn resolve_model(&self, selected: Option<&str>) -> (String, Option<String>) {
        let alias = selected.unwrap_or(&self.default_model);
        if let Some(preset) = self.model_presets.get(alias) {
            return (preset.model.clone(), preset.reasoning_effort.clone());
        }
        (alias.to_string(), None)
    }
}

fn parse_cli_tools(
    repo_root: &Path,
    raw_tools: Option<Vec<RawCliTool>>,
) -> anyhow::Result<Vec<CliToolConfig>> {
    let mut tools = Vec::new();
    for raw in raw_tools.unwrap_or_default() {
        let name = clean_config_string(raw.name.as_deref())
            .ok_or_else(|| anyhow::anyhow!("sandbox.cli_tools entry is missing name"))?;
        let install_root = clean_config_string(raw.install_root.as_deref())
            .ok_or_else(|| anyhow::anyhow!("sandbox.cli_tools.{name} is missing install_root"))?;
        let sandbox_root = clean_config_string(raw.sandbox_root.as_deref())
            .unwrap_or_else(|| format!("/opt/{name}-cli"));
        let bin_dirs = raw
            .bin_dirs
            .unwrap_or_else(|| vec!["current/bin".to_string()]);
        let bin_dirs = bin_dirs
            .into_iter()
            .map(|value| PathBuf::from(value.trim()))
            .filter(|path| !path.as_os_str().is_empty())
            .collect::<Vec<_>>();
        if bin_dirs.is_empty() {
            anyhow::bail!("sandbox.cli_tools.{name} must have at least one bin_dir");
        }
        tools.push(CliToolConfig {
            name,
            install_root: resolve_path(repo_root, &install_root),
            sandbox_root: PathBuf::from(sandbox_root),
            bin_dirs,
        });
    }
    Ok(tools)
}

fn parse_feishu_config(raw: Option<RawFeishu>) -> FeishuConfig {
    let Some(raw) = raw else {
        return FeishuConfig::default();
    };
    let app = raw.app.unwrap_or_default();
    let app_id = clean_config_string(app.app_id.as_deref().or(raw.app_id.as_deref()));
    let app_secret = clean_config_string(app.app_secret.as_deref().or(raw.app_secret.as_deref()));
    let brand = clean_config_string(app.brand.as_deref().or(raw.brand.as_deref()))
        .unwrap_or_else(|| "feishu".to_string());
    FeishuConfig {
        app: app_id
            .zip(app_secret)
            .map(|(app_id, app_secret)| FeishuAppConfig {
                app_id,
                app_secret,
                brand,
            }),
    }
}

fn parse_gogcli_oauth_client(raw: Option<RawGogcliOAuthClient>) -> Option<GogcliOAuthClient> {
    let raw = raw?;
    let client_id = clean_config_string(raw.client_id.as_deref())?;
    let client_secret = clean_config_string(raw.client_secret.as_deref())?;
    Some(GogcliOAuthClient {
        client_type: clean_config_string(raw.client_type.as_deref()),
        client_id,
        client_secret,
        project_id: clean_config_string(raw.project_id.as_deref()),
        auth_uri: clean_config_string(raw.auth_uri.as_deref()),
        token_uri: clean_config_string(raw.token_uri.as_deref()),
        auth_provider_x509_cert_url: clean_config_string(
            raw.auth_provider_x509_cert_url.as_deref(),
        ),
        redirect_uris: raw
            .redirect_uris
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| clean_config_string(Some(&value)))
            .collect(),
    })
}

fn clean_config_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn parse_model_presets(
    raw: BTreeMap<String, BTreeMap<String, serde_yaml::Value>>,
) -> BTreeMap<String, ModelPreset> {
    raw.into_iter()
        .map(|(alias, fields)| {
            let model = fields
                .iter()
                .find_map(|(key, value)| {
                    if key == "reasoning_effort" {
                        None
                    } else {
                        value.as_str().map(str::to_string)
                    }
                })
                .unwrap_or_else(|| alias.clone());
            let reasoning_effort = fields
                .get("reasoning_effort")
                .and_then(serde_yaml::Value::as_str)
                .map(str::to_string);
            (
                alias,
                ModelPreset {
                    model,
                    reasoning_effort,
                },
            )
        })
        .collect()
}

pub fn resolve_path(base: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        base.join(path)
    }
}

fn discover_uv_bin_dir() -> Option<PathBuf> {
    find_on_path("uv").and_then(|path| path.parent().map(Path::to_path_buf))
}

fn discover_node_dir() -> Option<PathBuf> {
    let node = find_on_path("node")?;
    let bin = node.parent()?;
    if bin.file_name().and_then(|name| name.to_str()) == Some("bin") {
        bin.parent().map(Path::to_path_buf)
    } else {
        None
    }
}

fn discover_vendor_root(repo_root: &Path, vendor_name: &str, binary_name: &str) -> Option<PathBuf> {
    for root in [
        repo_root.join("vendor").join(vendor_name),
        PathBuf::from(format!("/opt/{vendor_name}")),
    ] {
        if root.join("current/bin").join(binary_name).is_file() {
            return Some(root);
        }
    }
    None
}

fn find_on_path(binary: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(binary))
        .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::AppConfig;

    fn with_temp_config<T>(name: &str, text: &str, f: impl FnOnce() -> T) -> T {
        let previous = std::env::var_os("RIPPLE_CONFIG");
        let path = std::env::temp_dir().join(format!(
            "ripple-config-test-{}-{name}.yaml",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, text).expect("write temp config");
        std::env::set_var("RIPPLE_CONFIG", &path);

        let result = f();

        match previous {
            Some(value) => std::env::set_var("RIPPLE_CONFIG", value),
            None => std::env::remove_var("RIPPLE_CONFIG"),
        }
        let _ = std::fs::remove_file(path);
        result
    }

    #[test]
    fn default_skills_shared_dirs_use_top_level_skills() {
        let previous = std::env::var_os("RIPPLE_CONFIG");
        let config_path = std::env::temp_dir().join(format!(
            "ripple-missing-config-{}-{}.yaml",
            std::process::id(),
            "default-skills"
        ));
        std::env::set_var("RIPPLE_CONFIG", &config_path);

        let loaded = AppConfig::load();

        match previous {
            Some(value) => std::env::set_var("RIPPLE_CONFIG", value),
            None => std::env::remove_var("RIPPLE_CONFIG"),
        }

        let config = loaded.expect("load default config");
        assert_eq!(config.skills.shared_dirs, vec!["skills/*".to_string()]);
    }

    #[test]
    fn parses_configured_cli_tools() {
        let config = with_temp_config(
            "cli-tools",
            r#"
server:
  sandbox:
    cli_tools:
      - name: bilibili
        install_root: vendor/bilibili-cli
        sandbox_root: /opt/bilibili-cli
        bin_dirs:
          - current/bin
"#,
            AppConfig::load,
        )
        .expect("load config");

        assert_eq!(config.sandbox.cli_tools.len(), 1);
        let tool = &config.sandbox.cli_tools[0];
        assert_eq!(tool.name, "bilibili");
        assert!(tool.install_root.ends_with("vendor/bilibili-cli"));
        assert_eq!(
            tool.sandbox_root,
            std::path::PathBuf::from("/opt/bilibili-cli")
        );
        assert_eq!(tool.bin_dirs, vec![std::path::PathBuf::from("current/bin")]);
    }
}
