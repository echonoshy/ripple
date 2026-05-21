use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tokio::sync::Mutex;
use walkdir::WalkDir;

use crate::config::AppConfig;
use crate::user::validate_user_id;

#[derive(Clone)]
pub struct SandboxManager {
    config: Arc<AppConfig>,
    user_locks: Arc<std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>>,
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
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn list_user_sessions(&self, user_id: &str) -> anyhow::Result<Vec<String>> {
        let sessions_dir = self.sessions_dir(user_id)?;
        if !sessions_dir.exists() {
            return Ok(Vec::new());
        }
        let mut sessions = Vec::new();
        for entry in std::fs::read_dir(sessions_dir)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() && entry.path().join("meta.json").is_file() {
                if let Some(name) = entry.file_name().to_str() {
                    sessions.push(name.to_string());
                }
            }
        }
        sessions.sort();
        Ok(sessions)
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

    pub fn sandbox_summary(&self, user_id: &str) -> anyhow::Result<Option<SandboxInfo>> {
        let sandbox_dir = self.sandbox_dir(user_id)?;
        if !sandbox_dir.exists() {
            return Ok(None);
        }
        let workspace = self.workspace_dir(user_id)?;
        Ok(Some(SandboxInfo {
            user_id: user_id.to_string(),
            workspace_size_bytes: workspace_size_bytes(&workspace),
            session_count: self.list_user_sessions(user_id)?.len(),
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
        mounts.push(mount_block(None, "/tmp", true, Some("tmpfs")));

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
envar: "HOME=/workspace"
envar: "USER=sandbox"
envar: "SHELL=/bin/bash"
envar: "LANG=C.UTF-8"
envar: "PATH=/usr/local/bin:/usr/bin:/bin"

{}
"#,
            mounts.join("\n\n")
        ))
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
    lines.push("}".to_string());
    lines.join("\n")
}
