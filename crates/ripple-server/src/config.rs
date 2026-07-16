use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Value as JsonValue};

pub const DEFAULT_CODEX_MAX_WORKERS_PER_POOL: usize = 8;
pub const DEFAULT_CODEX_MAX_TOTAL_POOL_WORKERS: usize = 256;
pub const DEFAULT_CODEX_RUNTIME_LOG_RETENTION_SECONDS: u64 = 24 * 60 * 60;
pub const DEFAULT_CODEX_RUNTIME_LOG_MAX_MB: u64 = 64;
pub const DEFAULT_CODEX_RUNTIME_LOG_CLEANUP_INTERVAL_SECONDS: u64 = 60 * 60;
pub const USER_CONNECTOR_NAMES: &[&str] = &["google_workspace", "notion", "feishu", "bilibili"];

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub repo_root: PathBuf,
    pub host: String,
    pub port: u16,
    pub api_keys: Vec<String>,
    pub security: SecurityConfig,
    pub user_auth: UserAuthConfig,
    pub api_docs: ApiDocsConfig,
    pub enabled_connectors: BTreeSet<String>,
    pub cors: CorsConfig,
    pub default_model: String,
    pub model_presets: BTreeMap<String, ModelPreset>,
    pub logging: LoggingConfig,
    pub sandbox: SandboxConfig,
    pub codex: CodexConfig,
    pub task_trigger_extraction_max_runtime_seconds: u64,
    pub task_trigger_poll_interval_seconds: u64,
    pub document_preview: DocumentPreviewConfig,
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
pub struct LoggingConfig {
    pub level: String,
}

#[derive(Clone, Debug)]
pub struct SecurityConfig {
    pub deployment_mode: String,
    pub require_confirm_for_risky_api: bool,
    pub require_https: bool,
}

impl Default for SecurityConfig {
    fn default() -> Self {
        Self {
            deployment_mode: "trusted-proxy".to_string(),
            require_confirm_for_risky_api: true,
            require_https: false,
        }
    }
}

#[derive(Clone, Debug)]
pub struct UserAuthConfig {
    pub enabled: bool,
    pub session_ttl_seconds: u64,
}

impl Default for UserAuthConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            session_ttl_seconds: 30 * 24 * 60 * 60,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ApiDocsConfig {
    pub enabled: bool,
    pub try_it_out_enabled: bool,
}

impl Default for ApiDocsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            try_it_out_enabled: true,
        }
    }
}

#[derive(Clone, Debug)]
pub struct DocumentPreviewConfig {
    pub cache_root: PathBuf,
    pub libreoffice_path: String,
    pub max_source_bytes: u64,
    pub conversion_timeout_seconds: u64,
}

#[derive(Clone, Debug, Default)]
pub struct CorsConfig {
    pub allowed_origins: Vec<String>,
    pub allow_any_origin: bool,
}

#[derive(Clone, Debug)]
pub struct SandboxConfig {
    pub sandboxes_root: PathBuf,
    pub workspaces_root: Option<PathBuf>,
    pub caches_root: PathBuf,
    pub idle_suspend_seconds: u64,
    pub retention_seconds: u64,
    pub max_workspace_mb: u64,
    pub tmpfs_size_mb: u64,
    pub nsjail_path: String,
    pub python_envs_root: PathBuf,
    pub python_env_uv_cache: PathBuf,
    pub python_env_max_packages: usize,
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
    pub approval_policy: JsonValue,
    pub sandbox_type: String,
    pub network_access: bool,
    pub idle_timeout_seconds: u64,
    pub max_workers_per_pool: usize,
    pub max_total_pool_workers: usize,
    pub max_runtime_seconds: u64,
    pub runtime_log_retention_seconds: u64,
    pub runtime_log_max_mb: u64,
    pub runtime_log_cleanup_interval_seconds: u64,
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
    logging: Option<RawLogging>,
    external_agents: Option<RawExternalAgents>,
    skills: Option<RawSkills>,
}

#[derive(Debug, Default, Deserialize)]
struct RawLogging {
    level: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RawServer {
    host: Option<String>,
    port: Option<u16>,
    api_keys: Option<Vec<String>>,
    security: Option<RawSecurity>,
    user_auth: Option<RawUserAuth>,
    api_docs: Option<RawApiDocs>,
    enabled_connectors: Option<Vec<String>>,
    cors: Option<RawCors>,
    sandbox: Option<RawSandbox>,
    codex_chat: Option<RawCodexChat>,
    task_trigger_extraction: Option<RawTaskTriggerExtraction>,
    task_triggers: Option<RawTaskTriggers>,
    document_preview: Option<RawDocumentPreview>,
    public_base_url: Option<String>,
    feishu: Option<RawFeishu>,
    gogcli_oauth: Option<RawGogcliOAuth>,
}

#[derive(Debug, Default, Deserialize)]
struct RawSecurity {
    deployment_mode: Option<String>,
    require_confirm_for_risky_api: Option<bool>,
    require_https: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct RawUserAuth {
    enabled: Option<bool>,
    session_ttl_seconds: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
struct RawApiDocs {
    enabled: Option<bool>,
    try_it_out_enabled: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct RawCors {
    allowed_origins: Option<Vec<String>>,
    allow_any_origin: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct RawCodexChat {
    max_runtime_seconds: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
struct RawTaskTriggerExtraction {
    max_runtime_seconds: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
struct RawTaskTriggers {
    poll_interval_seconds: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
struct RawDocumentPreview {
    cache_root: Option<String>,
    libreoffice_path: Option<String>,
    max_source_bytes: Option<u64>,
    conversion_timeout_seconds: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
struct RawSandbox {
    sandboxes_root: Option<String>,
    workspaces_root: Option<String>,
    caches_root: Option<String>,
    idle_suspend_seconds: Option<u64>,
    retention_seconds: Option<u64>,
    max_workspace_mb: Option<u64>,
    tmpfs_size_mb: Option<u64>,
    nsjail_path: Option<String>,
    python_envs_root: Option<String>,
    python_env_uv_cache: Option<String>,
    python_env_max_packages: Option<usize>,
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
    approval_policy: Option<serde_yaml::Value>,
    sandbox_type: Option<String>,
    network_access: Option<bool>,
    idle_timeout_seconds: Option<u64>,
    max_workers_per_pool: Option<usize>,
    max_total_pool_workers: Option<usize>,
    runtime_log_retention_seconds: Option<u64>,
    runtime_log_max_mb: Option<u64>,
    runtime_log_cleanup_interval_seconds: Option<u64>,
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
            if !env_flag_enabled("RIPPLE_ALLOW_DEFAULT_CONFIG") {
                anyhow::bail!(
                    "Ripple config {} does not exist; set RIPPLE_ALLOW_DEFAULT_CONFIG=1 to use built-in defaults explicitly",
                    config_path.display()
                );
            }
            RawConfig::default()
        };

        let mut server = raw.server.unwrap_or_default();
        let enabled_connectors = parse_enabled_connectors(server.enabled_connectors.take())?;
        let security = server.security.unwrap_or_default();
        let user_auth = server.user_auth.unwrap_or_default();
        let api_docs = server.api_docs.unwrap_or_default();
        let cors = server.cors.unwrap_or_default();
        let sandbox = server.sandbox.unwrap_or_default();
        let model = raw.model.unwrap_or_default();
        let public_base_url = clean_config_string(server.public_base_url.as_deref());
        let logging = raw.logging.unwrap_or_default();
        let feishu = parse_feishu_config(server.feishu);
        let gogcli_oauth_raw = server.gogcli_oauth.unwrap_or_default();
        let codex_raw = raw
            .external_agents
            .unwrap_or_default()
            .codex
            .unwrap_or_default();
        let codex_chat = server.codex_chat.unwrap_or_default();
        let task_trigger_extraction = server.task_trigger_extraction.unwrap_or_default();
        let task_triggers = server.task_triggers.unwrap_or_default();
        let document_preview = server.document_preview.unwrap_or_default();
        let skills_raw = raw.skills.unwrap_or_default();

        let model_presets = parse_model_presets(model.presets.unwrap_or_default());
        let default_model = model.default.unwrap_or_else(|| "codex-medium".to_string());
        let sandbox_sandboxes_root = resolve_path(
            &repo_root,
            sandbox
                .sandboxes_root
                .as_deref()
                .unwrap_or(".ripple/sandboxes"),
        );
        let sandbox_workspaces_root = clean_config_string(sandbox.workspaces_root.as_deref())
            .map(|value| resolve_path(&repo_root, &value));
        let sandbox_caches_root = resolve_path(
            &repo_root,
            sandbox
                .caches_root
                .as_deref()
                .unwrap_or(".ripple/sandboxes-cache"),
        );
        let python_envs_root = sandbox
            .python_envs_root
            .as_deref()
            .map(|value| resolve_path(&repo_root, value))
            .unwrap_or_else(|| sandbox_caches_root.join("python-envs"));
        let python_env_uv_cache = sandbox
            .python_env_uv_cache
            .as_deref()
            .map(|value| resolve_path(&repo_root, value))
            .unwrap_or_else(|| sandbox_caches_root.join("uv-cache"));
        let lark_cli_install_root = if enabled_connectors.contains("feishu") {
            sandbox
                .lark_cli_install_root
                .as_deref()
                .map(|value| resolve_path(&repo_root, value))
                .or_else(|| discover_vendor_root(&repo_root, "lark-cli", "lark-cli"))
        } else {
            None
        };
        let notion_cli_install_root = if enabled_connectors.contains("notion") {
            sandbox
                .notion_cli_install_root
                .as_deref()
                .map(|value| resolve_path(&repo_root, value))
                .or_else(|| discover_vendor_root(&repo_root, "notion-cli", "ntn"))
        } else {
            None
        };
        let gogcli_cli_install_root = if enabled_connectors.contains("google_workspace") {
            sandbox
                .gogcli_cli_install_root
                .as_deref()
                .map(|value| resolve_path(&repo_root, value))
                .or_else(|| discover_vendor_root(&repo_root, "gogcli-cli", "gog"))
        } else {
            None
        };

        let config = Self {
            repo_root: repo_root.clone(),
            host: server.host.unwrap_or_else(|| "0.0.0.0".to_string()),
            port: server.port.unwrap_or(8810),
            api_keys: server.api_keys.unwrap_or_default(),
            security: SecurityConfig {
                deployment_mode: clean_config_string(security.deployment_mode.as_deref())
                    .unwrap_or_else(|| "trusted-proxy".to_string()),
                require_confirm_for_risky_api: security
                    .require_confirm_for_risky_api
                    .unwrap_or(true),
                require_https: security.require_https.unwrap_or(false),
            },
            user_auth: UserAuthConfig {
                enabled: user_auth.enabled.unwrap_or(false),
                session_ttl_seconds: user_auth
                    .session_ttl_seconds
                    .unwrap_or_else(|| UserAuthConfig::default().session_ttl_seconds)
                    .max(60),
            },
            api_docs: ApiDocsConfig {
                enabled: api_docs
                    .enabled
                    .unwrap_or_else(|| ApiDocsConfig::default().enabled),
                try_it_out_enabled: api_docs
                    .try_it_out_enabled
                    .unwrap_or_else(|| ApiDocsConfig::default().try_it_out_enabled),
            },
            enabled_connectors,
            cors: CorsConfig {
                allowed_origins: cors
                    .allowed_origins
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|value| clean_config_string(Some(&value)))
                    .collect(),
                allow_any_origin: cors.allow_any_origin.unwrap_or(false),
            },
            default_model,
            model_presets,
            logging: LoggingConfig {
                level: clean_config_string(logging.level.as_deref())
                    .unwrap_or_else(|| "debug".to_string()),
            },
            sandbox: SandboxConfig {
                sandboxes_root: sandbox_sandboxes_root,
                workspaces_root: sandbox_workspaces_root,
                caches_root: sandbox_caches_root.clone(),
                idle_suspend_seconds: sandbox.idle_suspend_seconds.unwrap_or(1800),
                retention_seconds: sandbox.retention_seconds.unwrap_or(604_800),
                max_workspace_mb: sandbox.max_workspace_mb.unwrap_or(2048),
                tmpfs_size_mb: sandbox.tmpfs_size_mb.unwrap_or(512),
                nsjail_path: sandbox.nsjail_path.unwrap_or_else(|| "nsjail".to_string()),
                python_envs_root,
                python_env_uv_cache,
                python_env_max_packages: sandbox.python_env_max_packages.unwrap_or(20).max(1),
                uv_bin_dir: sandbox
                    .uv_bin_dir
                    .map(|value| resolve_path(&repo_root, &value))
                    .or_else(discover_uv_bin_dir),
                node_dir: sandbox
                    .node_dir
                    .map(|value| resolve_path(&repo_root, &value))
                    .or_else(discover_node_dir),
                lark_cli_install_root,
                notion_cli_install_root,
                gogcli_cli_install_root,
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
                codex_home: Some(
                    clean_config_string(codex_raw.codex_home.as_deref())
                        .map(|value| resolve_path(&repo_root, &value))
                        .unwrap_or_else(|| repo_root.join(".ripple/codex-service-home")),
                ),
                approval_policy: parse_codex_approval_policy(codex_raw.approval_policy)?,
                sandbox_type: codex_raw
                    .sandbox_type
                    .unwrap_or_else(|| "workspace-write".to_string()),
                network_access: codex_raw.network_access.unwrap_or(true),
                idle_timeout_seconds: codex_raw.idle_timeout_seconds.unwrap_or(1800),
                max_workers_per_pool: codex_raw
                    .max_workers_per_pool
                    .unwrap_or(DEFAULT_CODEX_MAX_WORKERS_PER_POOL)
                    .max(1),
                max_total_pool_workers: codex_raw
                    .max_total_pool_workers
                    .unwrap_or(DEFAULT_CODEX_MAX_TOTAL_POOL_WORKERS)
                    .max(1),
                max_runtime_seconds: codex_chat.max_runtime_seconds.unwrap_or(3600),
                runtime_log_retention_seconds: codex_raw
                    .runtime_log_retention_seconds
                    .unwrap_or(DEFAULT_CODEX_RUNTIME_LOG_RETENTION_SECONDS),
                runtime_log_max_mb: codex_raw
                    .runtime_log_max_mb
                    .unwrap_or(DEFAULT_CODEX_RUNTIME_LOG_MAX_MB),
                runtime_log_cleanup_interval_seconds: codex_raw
                    .runtime_log_cleanup_interval_seconds
                    .unwrap_or(DEFAULT_CODEX_RUNTIME_LOG_CLEANUP_INTERVAL_SECONDS)
                    .max(60),
            },
            task_trigger_extraction_max_runtime_seconds: task_trigger_extraction
                .max_runtime_seconds
                .unwrap_or(120)
                .max(1),
            task_trigger_poll_interval_seconds: task_triggers
                .poll_interval_seconds
                .unwrap_or(15)
                .max(1),
            document_preview: DocumentPreviewConfig {
                cache_root: document_preview
                    .cache_root
                    .as_deref()
                    .map(|value| resolve_path(&repo_root, value))
                    .unwrap_or_else(|| sandbox_caches_root.join("previews")),
                libreoffice_path: clean_config_string(document_preview.libreoffice_path.as_deref())
                    .unwrap_or_else(|| "soffice".to_string()),
                max_source_bytes: document_preview
                    .max_source_bytes
                    .unwrap_or(64 * 1024 * 1024)
                    .max(1),
                conversion_timeout_seconds: document_preview
                    .conversion_timeout_seconds
                    .unwrap_or(120)
                    .max(1),
            },
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
        };
        validate_runtime_config(&config)?;
        Ok(config)
    }

    pub fn connector_enabled(&self, name: &str) -> bool {
        self.enabled_connectors.contains(name)
    }

    pub fn resolve_model(&self, selected: Option<&str>) -> (String, Option<String>) {
        let alias = selected.unwrap_or(&self.default_model);
        if let Some(preset) = self.model_presets.get(alias) {
            return (preset.model.clone(), preset.reasoning_effort.clone());
        }
        (alias.to_string(), None)
    }

    pub fn codex_home_path(&self) -> PathBuf {
        self.codex
            .codex_home
            .clone()
            .unwrap_or_else(|| self.repo_root.join(".ripple/codex-service-home"))
    }

    pub fn tracing_filter(&self) -> String {
        tracing_filter_for_level(&self.logging.level)
    }
}

fn parse_enabled_connectors(raw: Option<Vec<String>>) -> anyhow::Result<BTreeSet<String>> {
    let connectors = raw.unwrap_or_else(|| default_enabled_connectors().into_iter().collect());
    let enabled = connectors
        .into_iter()
        .filter_map(|name| clean_config_string(Some(&name)))
        .map(|name| name.to_ascii_lowercase())
        .collect::<BTreeSet<_>>();
    let unknown = enabled
        .iter()
        .filter(|name| !USER_CONNECTOR_NAMES.contains(&name.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if !unknown.is_empty() {
        anyhow::bail!(
            "server.enabled_connectors contains unknown connector(s): {}",
            unknown.join(", ")
        );
    }
    Ok(enabled)
}

pub fn default_enabled_connectors() -> BTreeSet<String> {
    USER_CONNECTOR_NAMES
        .iter()
        .map(|name| (*name).to_string())
        .collect()
}

fn validate_runtime_config(config: &AppConfig) -> anyhow::Result<()> {
    if config.api_keys.is_empty()
        && !config.user_auth.enabled
        && is_wildcard_host(&config.host)
        && !env_flag_enabled("RIPPLE_ALLOW_OPEN_API")
    {
        anyhow::bail!(
            "server.api_keys cannot be empty when server.host is {}; set RIPPLE_ALLOW_OPEN_API=1 to allow unauthenticated public binding explicitly",
            config.host
        );
    }
    Ok(())
}

pub fn default_codex_approval_policy() -> JsonValue {
    json!({
        "granular": {
            "sandbox_approval": true,
            "rules": false,
            "skill_approval": false,
            "request_permissions": true,
            "mcp_elicitations": false
        }
    })
}

fn parse_codex_approval_policy(raw: Option<serde_yaml::Value>) -> anyhow::Result<JsonValue> {
    match raw {
        None | Some(serde_yaml::Value::Null) => Ok(default_codex_approval_policy()),
        Some(serde_yaml::Value::String(value)) => Ok(JsonValue::String(value)),
        Some(value) => serde_json::to_value(value)
            .map_err(|err| anyhow::anyhow!("external_agents.codex.approval_policy: {err}")),
    }
}

fn is_wildcard_host(host: &str) -> bool {
    matches!(host.trim(), "0.0.0.0" | "::" | "[::]")
}

fn env_flag_enabled(name: &str) -> bool {
    std::env::var(name)
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

pub fn default_tracing_filter() -> String {
    tracing_filter_for_level("debug")
}

fn tracing_filter_for_level(level: &str) -> String {
    let level = level.trim();
    if level.contains('=') || level.contains(',') {
        return level.to_string();
    }
    let level = level.to_ascii_lowercase();
    format!("ripple_server={level},tower_http=info,axum=info")
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
    use super::{default_codex_approval_policy, AppConfig};
    use serde_json::json;
    use std::sync::{Mutex, OnceLock};

    fn config_env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn with_temp_config<T>(name: &str, text: &str, f: impl FnOnce() -> T) -> T {
        let _guard = config_env_lock().lock().expect("config env lock poisoned");
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
        let _guard = config_env_lock().lock().expect("config env lock poisoned");
        let previous = std::env::var_os("RIPPLE_CONFIG");
        let previous_allow_default = std::env::var_os("RIPPLE_ALLOW_DEFAULT_CONFIG");
        let previous_allow_open = std::env::var_os("RIPPLE_ALLOW_OPEN_API");
        let config_path = std::env::temp_dir().join(format!(
            "ripple-missing-config-{}-{}.yaml",
            std::process::id(),
            "default-skills"
        ));
        std::env::set_var("RIPPLE_CONFIG", &config_path);
        std::env::set_var("RIPPLE_ALLOW_DEFAULT_CONFIG", "1");
        std::env::set_var("RIPPLE_ALLOW_OPEN_API", "1");

        let loaded = AppConfig::load();

        match previous {
            Some(value) => std::env::set_var("RIPPLE_CONFIG", value),
            None => std::env::remove_var("RIPPLE_CONFIG"),
        }
        match previous_allow_default {
            Some(value) => std::env::set_var("RIPPLE_ALLOW_DEFAULT_CONFIG", value),
            None => std::env::remove_var("RIPPLE_ALLOW_DEFAULT_CONFIG"),
        }
        match previous_allow_open {
            Some(value) => std::env::set_var("RIPPLE_ALLOW_OPEN_API", value),
            None => std::env::remove_var("RIPPLE_ALLOW_OPEN_API"),
        }

        let config = loaded.expect("load default config");
        assert_eq!(config.skills.shared_dirs, vec!["skills/*".to_string()]);
    }

    #[test]
    fn parses_enabled_connectors_allowlist() {
        let config = with_temp_config(
            "enabled-connectors",
            "server:\n  api_keys: [test-key]\n  enabled_connectors: [feishu]\n",
            AppConfig::load,
        )
        .expect("load config");

        assert!(config.connector_enabled("feishu"));
        assert!(!config.connector_enabled("google_workspace"));
        assert!(!config.connector_enabled("notion"));
        assert!(!config.connector_enabled("bilibili"));
    }

    #[test]
    fn enabled_connectors_default_to_all_user_connectors() {
        let config = with_temp_config(
            "default-enabled-connectors",
            "server:\n  api_keys: [test-key]\n",
            AppConfig::load,
        )
        .expect("load config");

        for connector in ["google_workspace", "notion", "feishu", "bilibili"] {
            assert!(config.connector_enabled(connector), "{connector}");
        }
    }

    #[test]
    fn rejects_unknown_enabled_connector() {
        let error = with_temp_config(
            "unknown-enabled-connector",
            "server:\n  api_keys: [test-key]\n  enabled_connectors: [unknown]\n",
            AppConfig::load,
        )
        .expect_err("unknown connector must fail");

        assert!(error
            .to_string()
            .contains("server.enabled_connectors contains unknown connector"));
    }

    #[test]
    fn disabled_connectors_do_not_resolve_configured_cli_roots() {
        let config = with_temp_config(
            "disabled-connector-cli-roots",
            r#"
server:
  api_keys: [test-key]
  enabled_connectors: [feishu]
  sandbox:
    lark_cli_install_root: /tmp/test-lark-cli
    notion_cli_install_root: /tmp/test-notion-cli
    gogcli_cli_install_root: /tmp/test-gogcli-cli
"#,
            AppConfig::load,
        )
        .expect("load config");

        assert_eq!(
            config.sandbox.lark_cli_install_root,
            Some(std::path::PathBuf::from("/tmp/test-lark-cli"))
        );
        assert!(config.sandbox.notion_cli_install_root.is_none());
        assert!(config.sandbox.gogcli_cli_install_root.is_none());
    }

    #[test]
    fn missing_config_requires_explicit_default_config_opt_in() {
        let _guard = config_env_lock().lock().expect("config env lock poisoned");
        let previous = std::env::var_os("RIPPLE_CONFIG");
        let previous_allow_default = std::env::var_os("RIPPLE_ALLOW_DEFAULT_CONFIG");
        let previous_allow_open = std::env::var_os("RIPPLE_ALLOW_OPEN_API");
        let config_path = std::env::temp_dir().join(format!(
            "ripple-missing-config-{}-{}.yaml",
            std::process::id(),
            "fail-closed"
        ));
        std::env::set_var("RIPPLE_CONFIG", &config_path);
        std::env::remove_var("RIPPLE_ALLOW_DEFAULT_CONFIG");
        std::env::set_var("RIPPLE_ALLOW_OPEN_API", "1");

        let loaded = AppConfig::load();

        match previous {
            Some(value) => std::env::set_var("RIPPLE_CONFIG", value),
            None => std::env::remove_var("RIPPLE_CONFIG"),
        }
        match previous_allow_default {
            Some(value) => std::env::set_var("RIPPLE_ALLOW_DEFAULT_CONFIG", value),
            None => std::env::remove_var("RIPPLE_ALLOW_DEFAULT_CONFIG"),
        }
        match previous_allow_open {
            Some(value) => std::env::set_var("RIPPLE_ALLOW_OPEN_API", value),
            None => std::env::remove_var("RIPPLE_ALLOW_OPEN_API"),
        }

        let err = loaded.expect_err("missing config should fail closed");
        assert!(err.to_string().contains("RIPPLE_ALLOW_DEFAULT_CONFIG"));
    }

    #[test]
    fn wildcard_host_requires_api_key_unless_open_api_is_explicit() {
        let _guard = config_env_lock().lock().expect("config env lock poisoned");
        let previous_config = std::env::var_os("RIPPLE_CONFIG");
        let previous_allow_open = std::env::var_os("RIPPLE_ALLOW_OPEN_API");
        std::env::remove_var("RIPPLE_ALLOW_OPEN_API");
        let path = std::env::temp_dir().join(format!(
            "ripple-config-test-{}-open-api-public-host.yaml",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            r#"
server:
  host: "0.0.0.0"
  api_keys: []
"#,
        )
        .expect("write temp config");
        std::env::set_var("RIPPLE_CONFIG", &path);

        let result = AppConfig::load();

        match previous_config {
            Some(value) => std::env::set_var("RIPPLE_CONFIG", value),
            None => std::env::remove_var("RIPPLE_CONFIG"),
        }
        match previous_allow_open {
            Some(value) => std::env::set_var("RIPPLE_ALLOW_OPEN_API", value),
            None => std::env::remove_var("RIPPLE_ALLOW_OPEN_API"),
        }
        let _ = std::fs::remove_file(path);

        let err = result.expect_err("public open API should fail closed");
        assert!(err.to_string().contains("RIPPLE_ALLOW_OPEN_API"));
    }

    #[test]
    fn wildcard_host_can_use_api_keys() {
        let result = with_temp_config(
            "public-host-with-api-key",
            r#"
server:
  host: "0.0.0.0"
  api_keys: ["test-key"]
"#,
            AppConfig::load,
        )
        .expect("public host with API key should load");

        assert_eq!(result.host, "0.0.0.0");
        assert_eq!(result.api_keys, vec!["test-key".to_string()]);
    }

    #[test]
    fn parses_task_trigger_poll_interval() {
        let config = with_temp_config(
            "task-trigger-poll",
            r#"
server:
  api_keys: ["test-key"]
  task_triggers:
    poll_interval_seconds: 30
"#,
            AppConfig::load,
        )
        .expect("load config");

        assert_eq!(config.task_trigger_poll_interval_seconds, 30);
    }

    #[test]
    fn codex_home_defaults_to_private_runtime_dir() {
        let config = with_temp_config(
            "default-codex-home",
            r#"
server:
  api_keys: ["test-key"]
external_agents:
  codex:
    enabled: true
"#,
            AppConfig::load,
        )
        .expect("load config");

        assert_eq!(
            config.codex.codex_home,
            Some(config.repo_root.join(".ripple/codex-service-home"))
        );
    }

    #[test]
    fn parses_codex_runtime_log_cleanup_config() {
        let config = with_temp_config(
            "codex-log-cleanup",
            r#"
server:
  api_keys: ["test-key"]
external_agents:
  codex:
    runtime_log_retention_seconds: 7200
    runtime_log_max_mb: 12
    runtime_log_cleanup_interval_seconds: 300
"#,
            AppConfig::load,
        )
        .expect("load config");

        assert_eq!(config.codex.runtime_log_retention_seconds, 7200);
        assert_eq!(config.codex.runtime_log_max_mb, 12);
        assert_eq!(config.codex.runtime_log_cleanup_interval_seconds, 300);
    }

    #[test]
    fn parses_security_and_cors_posture() {
        let config = with_temp_config(
            "security-cors",
            r#"
server:
  api_keys: ["test-key"]
  security:
    deployment_mode: "trusted-proxy"
    require_confirm_for_risky_api: true
    require_https: true
  cors:
    allowed_origins:
      - "https://ripple.example.com"
    allow_any_origin: false
"#,
            AppConfig::load,
        )
        .expect("load config");

        assert_eq!(config.security.deployment_mode, "trusted-proxy");
        assert!(config.security.require_confirm_for_risky_api);
        assert!(config.security.require_https);
        assert_eq!(
            config.cors.allowed_origins,
            vec!["https://ripple.example.com".to_string()]
        );
        assert!(!config.cors.allow_any_origin);
    }

    #[test]
    fn parses_user_auth_config() {
        let config = with_temp_config(
            "user-auth",
            r#"
server:
  host: "0.0.0.0"
  api_keys: []
  user_auth:
    enabled: true
    session_ttl_seconds: 3600
"#,
            AppConfig::load,
        )
        .expect("load config");

        assert!(config.user_auth.enabled);
        assert_eq!(config.user_auth.session_ttl_seconds, 3600);
    }

    #[test]
    fn parses_openapi_docs_config() {
        let config = with_temp_config(
            "openapi-docs",
            r#"
server:
  api_keys: ["test-key"]
  api_docs:
    enabled: false
    try_it_out_enabled: false
"#,
            AppConfig::load,
        )
        .expect("load config");

        assert!(!config.api_docs.enabled);
        assert!(!config.api_docs.try_it_out_enabled);
    }

    #[test]
    fn parses_configured_cli_tools() {
        let config = with_temp_config(
            "cli-tools",
            r#"
server:
  api_keys: ["test-key"]
  sandbox:
    cli_tools:
      - name: bilibili
        install_root: vendor/bilibili-cli
        sandbox_root: /opt/bilibili-cli
        bin_dirs:
          - current/bin
      - name: podcast
        install_root: vendor/podcast-cli
        sandbox_root: /opt/podcast-cli
        bin_dirs:
          - current/bin
"#,
            AppConfig::load,
        )
        .expect("load config");

        assert_eq!(config.sandbox.cli_tools.len(), 2);
        let bilibili = &config.sandbox.cli_tools[0];
        assert_eq!(bilibili.name, "bilibili");
        assert!(bilibili.install_root.ends_with("vendor/bilibili-cli"));
        assert_eq!(
            bilibili.sandbox_root,
            std::path::PathBuf::from("/opt/bilibili-cli")
        );
        assert_eq!(
            bilibili.bin_dirs,
            vec![std::path::PathBuf::from("current/bin")]
        );
        let podcast = &config.sandbox.cli_tools[1];
        assert_eq!(podcast.name, "podcast");
        assert!(podcast.install_root.ends_with("vendor/podcast-cli"));
        assert_eq!(
            podcast.sandbox_root,
            std::path::PathBuf::from("/opt/podcast-cli")
        );
        assert_eq!(
            podcast.bin_dirs,
            vec![std::path::PathBuf::from("current/bin")]
        );
    }

    #[test]
    fn parses_configured_workspace_root() {
        let config = with_temp_config(
            "workspace-root",
            r#"
server:
  api_keys: ["test-key"]
  sandbox:
    workspaces_root: "nas/workspaces"
"#,
            AppConfig::load,
        )
        .expect("load config");

        assert_eq!(
            config.sandbox.workspaces_root,
            Some(config.repo_root.join("nas/workspaces"))
        );
    }

    #[test]
    fn parses_codex_worker_pool_limits() {
        let config = with_temp_config(
            "codex-worker-limits",
            r#"
server:
  api_keys: ["test-key"]
external_agents:
  codex:
    max_workers_per_pool: 50
    max_total_pool_workers: 256
"#,
            AppConfig::load,
        )
        .expect("load config");

        assert_eq!(config.codex.max_workers_per_pool, 50);
        assert_eq!(config.codex.max_total_pool_workers, 256);
    }

    #[test]
    fn defaults_codex_approval_policy_to_granular_permissions() {
        let config = with_temp_config(
            "codex-approval-default",
            r#"
server:
  api_keys: ["test-key"]
"#,
            AppConfig::load,
        )
        .expect("load config");

        assert_eq!(
            config.codex.approval_policy,
            default_codex_approval_policy()
        );
    }

    #[test]
    fn parses_legacy_string_codex_approval_policy() {
        let config = with_temp_config(
            "codex-approval-string",
            r#"
server:
  api_keys: ["test-key"]
external_agents:
  codex:
    approval_policy: "never"
"#,
            AppConfig::load,
        )
        .expect("load config");

        assert_eq!(config.codex.approval_policy, json!("never"));
    }

    #[test]
    fn parses_granular_codex_approval_policy() {
        let config = with_temp_config(
            "codex-approval-granular",
            r#"
server:
  api_keys: ["test-key"]
external_agents:
  codex:
    approval_policy:
      granular:
        sandbox_approval: true
        rules: false
        skill_approval: false
        request_permissions: true
        mcp_elicitations: false
"#,
            AppConfig::load,
        )
        .expect("load config");

        assert_eq!(
            config.codex.approval_policy,
            default_codex_approval_policy()
        );
    }

    #[test]
    fn parses_stdout_logging_level() {
        let config = with_temp_config(
            "logging-level",
            r#"
server:
  api_keys: ["test-key"]
logging:
  level: "INFO"
"#,
            AppConfig::load,
        )
        .expect("load config");

        assert_eq!(config.logging.level, "INFO");
        assert_eq!(
            config.tracing_filter(),
            "ripple_server=info,tower_http=info,axum=info"
        );
    }
}
