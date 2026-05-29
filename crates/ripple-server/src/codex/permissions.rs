use std::io;
use std::path::Path;

use serde_json::{json, Value};

use crate::config::AppConfig;

pub const RIPPLE_CODEX_PERMISSION_PROFILE: &str = "ripple_workspace";

pub fn thread_permission_config(workspace: &Path, config: &AppConfig) -> Value {
    let mut filesystem = serde_json::Map::new();
    filesystem.insert(":minimal".to_string(), json!("read"));
    filesystem.insert(
        config.sandbox.sandboxes_root.to_string_lossy().to_string(),
        json!("none"),
    );
    let mut workspace_rules = serde_json::Map::new();
    workspace_rules.insert(".".to_string(), json!("write"));
    workspace_rules.insert(".git".to_string(), json!("write"));
    workspace_rules.insert(".agents".to_string(), json!("read"));
    workspace_rules.insert(".codex".to_string(), json!("read"));
    for native_skill_root in [".agents/skills", ".codex/skills"] {
        if path_exists_for_permission_rule(&workspace.join(native_skill_root)) {
            workspace_rules.insert(native_skill_root.to_string(), json!("none"));
        }
    }
    filesystem.insert(
        workspace.to_string_lossy().to_string(),
        Value::Object(workspace_rules),
    );
    for path in [
        config.sandbox.uv_bin_dir.as_deref(),
        config.sandbox.node_dir.as_deref(),
        config.sandbox.lark_cli_install_root.as_deref(),
        config.sandbox.notion_cli_install_root.as_deref(),
        config.sandbox.gogcli_cli_install_root.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        filesystem.insert(path.to_string_lossy().to_string(), json!("read"));
    }
    for tool in &config.sandbox.cli_tools {
        filesystem.insert(
            tool.install_root.to_string_lossy().to_string(),
            json!("read"),
        );
    }
    for path in [
        config.sandbox.caches_root.join("bin"),
        config.sandbox.python_envs_root.clone(),
        config.sandbox.caches_root.join("python-env-locks"),
    ] {
        filesystem.insert(path.to_string_lossy().to_string(), json!("read"));
    }
    for path in [
        config.sandbox.caches_root.join("pnpm-store"),
        config.sandbox.caches_root.join("corepack-cache"),
    ] {
        filesystem.insert(path.to_string_lossy().to_string(), json!("write"));
    }
    if let Some(codex_home) = config.codex.codex_home.as_deref() {
        filesystem.insert(codex_home.to_string_lossy().to_string(), json!("none"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        filesystem.insert(
            Path::new(&home)
                .join(".codex")
                .to_string_lossy()
                .to_string(),
            json!("none"),
        );
    }
    json!({
        "default_permissions": RIPPLE_CODEX_PERMISSION_PROFILE,
        "permissions": {
            RIPPLE_CODEX_PERMISSION_PROFILE: {
                "filesystem": filesystem,
                "network": {"enabled": config.codex.network_access}
            }
        },
        "shell_environment_policy": {"exclude": ["CODEX_HOME"]}
    })
}

fn path_exists_for_permission_rule(path: &Path) -> bool {
    match std::fs::symlink_metadata(path) {
        Ok(_) => true,
        Err(err) if err.kind() == io::ErrorKind::NotFound => false,
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::thread_permission_config;
    use crate::config::{
        AppConfig, CodexConfig, CorsConfig, FeishuConfig, GogcliOAuthConfig, LoggingConfig,
        SandboxConfig, SecurityConfig, SkillsConfig,
    };

    #[test]
    fn omits_missing_native_skill_deny_paths_from_workspace_rules() {
        let workspace =
            std::env::temp_dir().join(format!("ripple-permissions-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workspace).expect("create workspace");
        let config = test_config();

        let permissions = thread_permission_config(&workspace, &config);

        let workspace_rules = permissions
            .pointer("/permissions/ripple_workspace/filesystem")
            .and_then(|filesystem| filesystem.get(workspace.to_string_lossy().as_ref()))
            .and_then(|rules| rules.as_object())
            .expect("workspace filesystem rules");
        assert_eq!(workspace_rules.get(".agents"), Some(&json!("read")));
        assert_eq!(workspace_rules.get(".codex"), Some(&json!("read")));
        assert!(!workspace_rules.contains_key(".agents/skills"));
        assert!(!workspace_rules.contains_key(".codex/skills"));

        let _ = std::fs::remove_dir_all(workspace);
    }

    #[test]
    fn shared_uv_cache_is_not_writable_by_codex_turns() {
        let workspace =
            std::env::temp_dir().join(format!("ripple-permissions-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workspace).expect("create workspace");
        let config = test_config();

        let permissions = thread_permission_config(&workspace, &config);
        let filesystem = permissions
            .pointer("/permissions/ripple_workspace/filesystem")
            .and_then(|filesystem| filesystem.as_object())
            .expect("filesystem rules");
        let uv_cache = config.sandbox.caches_root.join("uv-cache");

        assert_ne!(
            filesystem.get(uv_cache.to_string_lossy().as_ref()),
            Some(&json!("write"))
        );

        let _ = std::fs::remove_dir_all(workspace);
    }

    fn test_config() -> AppConfig {
        let root = std::env::temp_dir().join(format!(
            "ripple-permissions-config-{}",
            uuid::Uuid::new_v4()
        ));
        AppConfig {
            repo_root: root.clone(),
            host: "127.0.0.1".to_string(),
            port: 8810,
            api_keys: Vec::new(),
            security: SecurityConfig::default(),
            user_auth: crate::config::UserAuthConfig::default(),
            cors: CorsConfig::default(),
            default_model: "codex-medium".to_string(),
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
                tmpfs_size_mb: 512,
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
                app_server_args: vec![
                    "app-server".to_string(),
                    "--listen".to_string(),
                    "stdio://".to_string(),
                ],
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
                shared_dirs: vec!["skills/*".to_string()],
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
        }
    }
}
