use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tokio::sync::Mutex;
use walkdir::WalkDir;

use crate::config::AppConfig;
use crate::user::validate_user_id;

const SANDBOX_NODE_DIR: &str = "/opt/node";
const SANDBOX_NODE_BIN: &str = "/workspace/.local/bin";
const SANDBOX_NODE_PREFIX: &str = "/workspace/.local";
const SANDBOX_PNPM_STORE: &str = "/pnpm-store";
const SANDBOX_COREPACK_HOME: &str = "/corepack-cache";
const LARK_CLI_INSTALL_ROOT: &str = "/opt/lark-cli";
const LARK_CLI_SANDBOX_BIN_DIR: &str = "/opt/lark-cli/current/bin";
const NOTION_CLI_INSTALL_ROOT: &str = "/opt/notion-cli";
const NOTION_CLI_SANDBOX_BIN_DIR: &str = "/opt/notion-cli/current/bin";
const GOGCLI_CLI_INSTALL_ROOT: &str = "/opt/gogcli-cli";
const GOGCLI_CLI_SANDBOX_BIN_DIR: &str = "/opt/gogcli-cli/current/bin";
const LARK_CLI_SANDBOX_BINARY: &str = "/opt/lark-cli/current/bin/lark-cli";
const GOGCLI_CLI_SANDBOX_BINARY: &str = "/opt/gogcli-cli/current/bin/gog";

#[derive(Clone)]
pub struct SandboxManager {
    config: Arc<AppConfig>,
    user_locks: Arc<std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    deleted: Arc<std::sync::Mutex<HashSet<String>>>,
}

#[derive(Debug, Serialize)]
pub struct SandboxInfo {
    pub user_id: String,
    pub workspace_size_bytes: u64,
    pub session_count: usize,
    pub has_python_venv: bool,
    pub has_pnpm_setup: bool,
    pub has_lark_cli_config: bool,
    pub has_notion_token: bool,
    pub has_gogcli_client_config: bool,
    pub has_gogcli_login: bool,
}

impl SandboxManager {
    pub fn new(config: Arc<AppConfig>) -> Self {
        Self {
            config,
            user_locks: Arc::new(std::sync::Mutex::new(HashMap::new())),
            deleted: Arc::new(std::sync::Mutex::new(HashSet::new())),
        }
    }

    pub fn user_lock(&self, user_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.user_locks.lock().expect("user locks poisoned");
        locks
            .entry(user_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub fn sandbox_dir(&self, user_id: &str) -> anyhow::Result<PathBuf> {
        validate_user_id(user_id).map_err(anyhow::Error::msg)?;
        Ok(self.config.sandbox.sandboxes_root.join(user_id))
    }

    pub fn workspace_dir(&self, user_id: &str) -> anyhow::Result<PathBuf> {
        Ok(self.sandbox_dir(user_id)?.join("workspace"))
    }

    pub fn credentials_dir(&self, user_id: &str) -> anyhow::Result<PathBuf> {
        Ok(self.sandbox_dir(user_id)?.join("credentials"))
    }

    pub fn sessions_dir(&self, user_id: &str) -> anyhow::Result<PathBuf> {
        Ok(self.sandbox_dir(user_id)?.join("sessions"))
    }

    pub fn session_dir(&self, user_id: &str, session_id: &str) -> anyhow::Result<PathBuf> {
        Ok(self.sessions_dir(user_id)?.join(session_id))
    }

    pub fn ensure_sandbox(&self, user_id: &str) -> anyhow::Result<PathBuf> {
        let sandbox_dir = self.sandbox_dir(user_id)?;
        let workspace_dir = sandbox_dir.join("workspace");
        std::fs::create_dir_all(sandbox_dir.join("credentials"))?;
        std::fs::create_dir_all(sandbox_dir.join("sessions"))?;
        std::fs::create_dir_all(&workspace_dir)?;
        self.deleted
            .lock()
            .expect("deleted sandbox set poisoned")
            .remove(user_id);
        self.write_nsjail_config(user_id)?;
        Ok(workspace_dir)
    }

    pub fn teardown_sandbox(&self, user_id: &str, allow_default: bool) -> anyhow::Result<bool> {
        if user_id == "default" && !allow_default {
            anyhow::bail!("default user sandbox cannot be torn down");
        }
        let dir = self.sandbox_dir(user_id)?;
        if dir.exists() {
            std::fs::remove_dir_all(dir)?;
            self.user_locks
                .lock()
                .expect("user locks poisoned")
                .remove(user_id);
            self.deleted
                .lock()
                .expect("deleted sandbox set poisoned")
                .insert(user_id.to_string());
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn list_user_sandboxes(&self) -> anyhow::Result<Vec<String>> {
        let root = &self.config.sandbox.sandboxes_root;
        if !root.exists() {
            return Ok(Vec::new());
        }
        let mut users = Vec::new();
        for entry in std::fs::read_dir(root)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                if let Some(name) = entry.file_name().to_str() {
                    users.push(name.to_string());
                }
            }
        }
        users.sort();
        Ok(users)
    }

    pub fn sandbox_summary(
        &self,
        user_id: &str,
        session_count: usize,
    ) -> anyhow::Result<Option<SandboxInfo>> {
        if self
            .deleted
            .lock()
            .expect("deleted sandbox set poisoned")
            .contains(user_id)
        {
            return Ok(None);
        }
        let sandbox_dir = self.sandbox_dir(user_id)?;
        if !sandbox_dir.exists() {
            return Ok(None);
        }
        let workspace = self.workspace_dir(user_id)?;
        if !workspace.is_dir() {
            return Ok(None);
        }
        Ok(Some(SandboxInfo {
            user_id: user_id.to_string(),
            workspace_size_bytes: workspace_size_bytes(&workspace),
            session_count,
            has_python_venv: workspace.join(".venv/pyvenv.cfg").is_file(),
            has_pnpm_setup: workspace.join(".local/.node-setup-done").is_file(),
            has_lark_cli_config: workspace.join(".lark-cli/config.json").is_file(),
            has_notion_token: self.notion_config_file(user_id)?.is_file(),
            has_gogcli_client_config: self.gogcli_client_config_file(user_id)?.is_file(),
            has_gogcli_login: has_gogcli_login(&workspace),
        }))
    }

    pub fn notion_config_file(&self, user_id: &str) -> anyhow::Result<PathBuf> {
        Ok(self.credentials_dir(user_id)?.join("notion.json"))
    }

    pub fn gogcli_client_config_file(&self, user_id: &str) -> anyhow::Result<PathBuf> {
        Ok(self.credentials_dir(user_id)?.join("gogcli-client.json"))
    }

    pub fn gogcli_keyring_pass_file(&self, user_id: &str) -> anyhow::Result<PathBuf> {
        Ok(self.credentials_dir(user_id)?.join("gogcli-keyring.pass"))
    }

    pub fn bilibili_config_file(&self, user_id: &str) -> anyhow::Result<PathBuf> {
        Ok(self.credentials_dir(user_id)?.join("bilibili.json"))
    }

    pub fn write_nsjail_config(&self, user_id: &str) -> anyhow::Result<PathBuf> {
        let cfg = self.sandbox_dir(user_id)?.join("nsjail.cfg");
        if let Some(parent) = cfg.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&cfg, self.generate_nsjail_config(user_id)?)?;
        Ok(cfg)
    }

    pub fn nsjail_exec_argv(
        &self,
        user_id: &str,
        program: &str,
        args: &[&str],
    ) -> anyhow::Result<Vec<String>> {
        let cfg = self.write_nsjail_config(user_id)?;
        let mut argv = vec![
            self.config.sandbox.nsjail_path.clone(),
            "--config".to_string(),
            cfg.to_string_lossy().to_string(),
            "--".to_string(),
            program.to_string(),
        ];
        argv.extend(args.iter().map(|arg| arg.to_string()));
        Ok(argv)
    }

    pub fn lark_cli_sandbox_binary(&self) -> &'static str {
        LARK_CLI_SANDBOX_BINARY
    }

    pub fn gogcli_sandbox_binary(&self) -> &'static str {
        GOGCLI_CLI_SANDBOX_BINARY
    }

    fn generate_nsjail_config(&self, user_id: &str) -> anyhow::Result<String> {
        let workspace = self.workspace_dir(user_id)?;
        let mut mounts = Vec::new();
        for path in [
            "/usr",
            "/lib",
            "/lib64",
            "/bin",
            "/sbin",
            "/etc/resolv.conf",
            "/etc/ssl",
        ] {
            if Path::new(path).exists() {
                mounts.push(mount_block(Some(path), path, false, None));
            }
        }
        self.add_common_nsjail_mounts(&mut mounts)?;
        mounts.push(mount_block(
            Some(workspace.to_string_lossy().as_ref()),
            "/workspace",
            true,
            None,
        ));
        let bilibili_credential = self.bilibili_config_file(user_id)?;
        if bilibili_credential.is_file() {
            mounts.push(mount_block(
                Some(bilibili_credential.to_string_lossy().as_ref()),
                "/workspace/.bilibili/sessdata.json",
                false,
                None,
            ));
        }
        mounts.push(mount_block(None, "/proc", false, Some("proc")));
        mounts.push(mount_block_with_options(
            None,
            "/tmp",
            true,
            Some("tmpfs"),
            Some(&format!("size={}M", self.config.sandbox.tmpfs_size_mb)),
        ));
        for dev in ["/dev/null", "/dev/zero", "/dev/urandom", "/dev/random"] {
            if Path::new(dev).exists() {
                mounts.push(mount_block(Some(dev), dev, false, None));
            }
        }
        let envars = self
            .sandbox_env(user_id)?
            .into_iter()
            .map(|(key, value)| format!("envar: {:?}", format!("{key}={value}")))
            .collect::<Vec<_>>()
            .join("\n");

        Ok(format!(
            r#"name: "ripple-sandbox-{user_id}"
mode: ONCE
clone_newuser: true
clone_newns: true
clone_newpid: true
clone_newipc: true
clone_newuts: true
clone_newnet: false
hostname: "sandbox"
cwd: "/workspace"
time_limit: 120
rlimit_as_type: INF
rlimit_cpu_type: SOFT
rlimit_fsize: 1024
rlimit_nofile: 8192
rlimit_nproc_type: SOFT
skip_setsid: true
disable_no_new_privs: false
keep_env: false
{envars}

{}
"#,
            mounts.join("\n\n")
        ))
    }

    fn add_common_nsjail_mounts(&self, mounts: &mut Vec<String>) -> anyhow::Result<()> {
        if let Some(uv_bin_dir) = &self.config.sandbox.uv_bin_dir {
            if uv_bin_dir.exists() {
                mounts.push(mount_block(
                    Some(uv_bin_dir.to_string_lossy().as_ref()),
                    uv_bin_dir.to_string_lossy().as_ref(),
                    false,
                    None,
                ));
            }
        }

        if let Some(node_dir) = &self.config.sandbox.node_dir {
            if node_dir.exists() {
                mounts.push(mount_block(
                    Some(node_dir.to_string_lossy().as_ref()),
                    SANDBOX_NODE_DIR,
                    false,
                    None,
                ));
            }
            let pnpm_store = self.config.sandbox.caches_root.join("pnpm-store");
            let corepack_home = self.config.sandbox.caches_root.join("corepack-cache");
            std::fs::create_dir_all(&pnpm_store)?;
            std::fs::create_dir_all(&corepack_home)?;
            mounts.push(mount_block(
                Some(pnpm_store.to_string_lossy().as_ref()),
                SANDBOX_PNPM_STORE,
                true,
                None,
            ));
            mounts.push(mount_block(
                Some(corepack_home.to_string_lossy().as_ref()),
                SANDBOX_COREPACK_HOME,
                true,
                None,
            ));
        }

        for (host_root, sandbox_root) in [
            (
                self.config.sandbox.lark_cli_install_root.as_ref(),
                LARK_CLI_INSTALL_ROOT,
            ),
            (
                self.config.sandbox.notion_cli_install_root.as_ref(),
                NOTION_CLI_INSTALL_ROOT,
            ),
            (
                self.config.sandbox.gogcli_cli_install_root.as_ref(),
                GOGCLI_CLI_INSTALL_ROOT,
            ),
        ] {
            if let Some(host_root) = host_root.filter(|path| path.exists()) {
                mounts.push(mount_block(
                    Some(host_root.to_string_lossy().as_ref()),
                    sandbox_root,
                    false,
                    None,
                ));
            }
        }
        for tool in &self.config.sandbox.cli_tools {
            if tool.install_root.exists() {
                mounts.push(mount_block(
                    Some(tool.install_root.to_string_lossy().as_ref()),
                    tool.sandbox_root.to_string_lossy().as_ref(),
                    false,
                    None,
                ));
            }
        }
        Ok(())
    }

    fn sandbox_env(&self, user_id: &str) -> anyhow::Result<Vec<(String, String)>> {
        let mut path_parts = vec![
            "/usr/local/sbin".to_string(),
            "/usr/local/bin".to_string(),
            "/usr/sbin".to_string(),
            "/usr/bin".to_string(),
            "/sbin".to_string(),
            "/bin".to_string(),
        ];
        if let Some(uv_bin_dir) = &self.config.sandbox.uv_bin_dir {
            path_parts.insert(0, uv_bin_dir.to_string_lossy().to_string());
        }
        if self.config.sandbox.node_dir.is_some() {
            path_parts.insert(0, SANDBOX_NODE_DIR.to_string() + "/bin");
            path_parts.insert(0, SANDBOX_NODE_BIN.to_string());
        }
        if self.config.sandbox.lark_cli_install_root.is_some() {
            path_parts.insert(0, LARK_CLI_SANDBOX_BIN_DIR.to_string());
        }
        if self.config.sandbox.notion_cli_install_root.is_some() {
            path_parts.insert(0, NOTION_CLI_SANDBOX_BIN_DIR.to_string());
        }
        if self.config.sandbox.gogcli_cli_install_root.is_some() {
            path_parts.insert(0, GOGCLI_CLI_SANDBOX_BIN_DIR.to_string());
        }
        for tool in self.config.sandbox.cli_tools.iter().rev() {
            for bin_dir in tool.bin_dirs.iter().rev() {
                path_parts.insert(
                    0,
                    tool.sandbox_root
                        .join(bin_dir)
                        .to_string_lossy()
                        .to_string(),
                );
            }
        }

        let mut env = vec![
            ("PATH".to_string(), path_parts.join(":")),
            ("HOME".to_string(), "/workspace".to_string()),
            ("USER".to_string(), "sandbox".to_string()),
            ("SHELL".to_string(), "/bin/bash".to_string()),
            ("TERM".to_string(), "xterm-256color".to_string()),
            ("LANG".to_string(), "C.UTF-8".to_string()),
            (
                "TZ".to_string(),
                std::env::var("TZ").unwrap_or_else(|_| "UTC".to_string()),
            ),
            (
                "UV_CACHE_DIR".to_string(),
                "/workspace/.cache/uv".to_string(),
            ),
            ("UV_LINK_MODE".to_string(), "copy".to_string()),
            ("PYTHONDONTWRITEBYTECODE".to_string(), "1".to_string()),
        ];

        if let Some(url) = &self.config.sandbox.pypi_mirror_url {
            env.push(("UV_INDEX_URL".to_string(), url.clone()));
            env.push(("PIP_INDEX_URL".to_string(), url.clone()));
        }
        if let Some(token) = read_json_string_field(&self.notion_config_file(user_id)?, "api_token")
        {
            env.push(("NOTION_API_TOKEN".to_string(), token));
        }
        if self.config.sandbox.gogcli_cli_install_root.is_some() {
            env.push((
                "XDG_CONFIG_HOME".to_string(),
                "/workspace/.config".to_string(),
            ));
            env.push(("GOG_KEYRING_BACKEND".to_string(), "file".to_string()));
            if let Ok(password) = std::fs::read_to_string(self.gogcli_keyring_pass_file(user_id)?) {
                let password = password.trim();
                if !password.is_empty() {
                    env.push(("GOG_KEYRING_PASSWORD".to_string(), password.to_string()));
                }
            }
        }
        if self.config.sandbox.node_dir.is_some() {
            env.push(("PNPM_HOME".to_string(), SANDBOX_NODE_BIN.to_string()));
            env.push(("PNPM_STORE_DIR".to_string(), SANDBOX_PNPM_STORE.to_string()));
            env.push((
                "NPM_CONFIG_PREFIX".to_string(),
                SANDBOX_NODE_PREFIX.to_string(),
            ));
            env.push((
                "COREPACK_HOME".to_string(),
                SANDBOX_COREPACK_HOME.to_string(),
            ));
            env.push(("COREPACK_ENABLE_AUTO_PIN".to_string(), "0".to_string()));
            env.push((
                "COREPACK_ENABLE_DOWNLOAD_PROMPT".to_string(),
                "0".to_string(),
            ));
            if let Some(url) = &self.config.sandbox.npm_registry_url {
                env.push(("NPM_CONFIG_REGISTRY".to_string(), url.clone()));
                env.push(("COREPACK_NPM_REGISTRY".to_string(), url.clone()));
            }
        }
        for key in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "http_proxy",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
            "NO_PROXY",
            "no_proxy",
        ] {
            if let Ok(value) = std::env::var(key) {
                if !value.trim().is_empty() {
                    env.push((key.to_string(), value));
                }
            }
        }
        Ok(env)
    }
}

pub fn workspace_size_bytes(workspace: &Path) -> u64 {
    if !workspace.exists() {
        return 0;
    }
    WalkDir::new(workspace)
        .into_iter()
        .filter_map(Result::ok)
        .filter_map(|entry| entry.metadata().ok())
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
        .sum()
}

fn has_gogcli_login(workspace: &Path) -> bool {
    let keyring = workspace.join(".config/gogcli/keyring");
    if !keyring.is_dir() {
        return false;
    }
    std::fs::read_dir(keyring)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .any(|entry| {
            entry
                .metadata()
                .map(|m| m.is_file() && m.len() > 0)
                .unwrap_or(false)
        })
}

fn mount_block(src: Option<&str>, dst: &str, rw: bool, fstype: Option<&str>) -> String {
    mount_block_with_options(src, dst, rw, fstype, None)
}

fn mount_block_with_options(
    src: Option<&str>,
    dst: &str,
    rw: bool,
    fstype: Option<&str>,
    options: Option<&str>,
) -> String {
    let mut lines = vec!["mount {".to_string()];
    if let Some(src) = src {
        lines.push(format!("  src: {:?}", src));
    }
    lines.push(format!("  dst: {:?}", dst));
    if let Some(fstype) = fstype {
        lines.push(format!("  fstype: {:?}", fstype));
    } else {
        lines.push("  is_bind: true".to_string());
    }
    lines.push(format!("  rw: {}", if rw { "true" } else { "false" }));
    if let Some(options) = options {
        lines.push(format!("  options: {:?}", options));
    }
    lines.push("}".to_string());
    lines.join("\n")
}

fn read_json_string_field(path: &Path, field: &str) -> Option<String> {
    let value = serde_json::from_slice::<Value>(&std::fs::read(path).ok()?).ok()?;
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        AppConfig, CliToolConfig, CodexConfig, FeishuConfig, GogcliOAuthConfig, SandboxConfig,
        SkillsConfig,
    };

    fn test_config(root: &Path) -> Arc<AppConfig> {
        let lark_root = root.join("vendor/lark-cli");
        let notion_root = root.join("vendor/notion-cli");
        let gog_root = root.join("vendor/gogcli-cli");
        let bilibili_root = root.join("vendor/bilibili-cli");
        let node_root = root.join("node");
        for path in [
            lark_root.join("current/bin"),
            notion_root.join("current/bin"),
            gog_root.join("current/bin"),
            bilibili_root.join("current/bin"),
            node_root.join("bin"),
        ] {
            std::fs::create_dir_all(path).unwrap();
        }
        Arc::new(AppConfig {
            repo_root: root.to_path_buf(),
            host: "127.0.0.1".to_string(),
            port: 0,
            api_keys: Vec::new(),
            security: crate::config::SecurityConfig::default(),
            cors: crate::config::CorsConfig::default(),
            default_model: "codex-test".to_string(),
            model_presets: Default::default(),
            logging: crate::config::LoggingConfig {
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
                uv_bin_dir: Some(root.join("uv-bin")),
                node_dir: Some(node_root),
                lark_cli_install_root: Some(lark_root),
                notion_cli_install_root: Some(notion_root),
                gogcli_cli_install_root: Some(gog_root),
                cli_tools: vec![CliToolConfig {
                    name: "bilibili".to_string(),
                    install_root: bilibili_root,
                    sandbox_root: PathBuf::from("/opt/bilibili-cli"),
                    bin_dirs: vec![PathBuf::from("current/bin")],
                }],
                pypi_mirror_url: Some("https://pypi.example/simple".to_string()),
                npm_registry_url: Some("https://npm.example".to_string()),
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
            skills: SkillsConfig {
                shared_dirs: Vec::new(),
            },
            public_base_url: None,
            feishu: FeishuConfig::default(),
            gogcli_oauth: GogcliOAuthConfig {
                auto_register_client: true,
                auto_from_request: true,
                callback_url: None,
                client_secret_json: None,
                client: None,
            },
        })
    }

    #[test]
    fn nsjail_config_includes_cli_cache_and_connector_env() {
        let root =
            std::env::temp_dir().join(format!("ripple-sandbox-test-{}", uuid::Uuid::new_v4()));
        let manager = SandboxManager::new(test_config(&root));
        let user_id = "sandboxuser";
        manager.ensure_sandbox(user_id).unwrap();
        let credentials = manager.credentials_dir(user_id).unwrap();
        std::fs::write(
            credentials.join("notion.json"),
            r#"{"api_token":"secret_test"}"#,
        )
        .unwrap();
        std::fs::write(credentials.join("gogcli-keyring.pass"), "pw").unwrap();

        let cfg = manager.generate_nsjail_config(user_id).unwrap();

        assert!(cfg.contains(r#"dst: "/opt/lark-cli""#));
        assert!(cfg.contains(r#"dst: "/opt/notion-cli""#));
        assert!(cfg.contains(r#"dst: "/opt/gogcli-cli""#));
        assert!(cfg.contains(r#"dst: "/opt/bilibili-cli""#));
        assert!(cfg.contains("UV_CACHE_DIR=/workspace/.cache/uv"));
        assert!(cfg.contains(r#"dst: "/pnpm-store""#));
        assert!(cfg.contains(r#"options: "size=64M""#));
        assert!(cfg.contains("NOTION_API_TOKEN=secret_test"));
        assert!(cfg.contains("GOG_KEYRING_PASSWORD=pw"));
        assert!(cfg.contains("/opt/gogcli-cli/current/bin"));
        assert!(cfg.contains("/opt/bilibili-cli/current/bin"));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn nsjail_exec_argv_targets_sandbox_binary() {
        let root =
            std::env::temp_dir().join(format!("ripple-sandbox-test-{}", uuid::Uuid::new_v4()));
        let manager = SandboxManager::new(test_config(&root));
        let argv = manager
            .nsjail_exec_argv(
                "sandboxuser",
                manager.gogcli_sandbox_binary(),
                &["--json", "auth", "list"],
            )
            .unwrap();

        assert_eq!(argv[0], "nsjail");
        assert_eq!(argv[1], "--config");
        assert_eq!(argv[3], "--");
        assert_eq!(argv[4], "/opt/gogcli-cli/current/bin/gog");
        assert_eq!(argv[5], "--json");
        assert_eq!(argv[6], "auth");
        assert_eq!(argv[7], "list");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn nsjail_exec_argv_can_start_feishu_setup_shell() {
        let root =
            std::env::temp_dir().join(format!("ripple-sandbox-test-{}", uuid::Uuid::new_v4()));
        let manager = SandboxManager::new(test_config(&root));
        let argv = manager
            .nsjail_exec_argv(
                "sandboxuser",
                "/bin/bash",
                &[
                    "-c",
                    "/opt/lark-cli/current/bin/lark-cli config init --new --force-init 2>&1",
                ],
            )
            .unwrap();

        assert_eq!(argv[0], "nsjail");
        assert_eq!(argv[3], "--");
        assert_eq!(argv[4], "/bin/bash");
        assert_eq!(argv[5], "-c");
        assert!(argv[6].contains("/opt/lark-cli/current/bin/lark-cli config init --new"));
        assert!(argv[6].contains("2>&1"));

        let _ = std::fs::remove_dir_all(root);
    }
}
