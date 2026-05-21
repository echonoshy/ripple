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
    filesystem.insert(
        workspace.to_string_lossy().to_string(),
        json!({
            ".": "write",
            ".git": "write",
            ".agents": "read",
            ".codex": "read"
        }),
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
    for path in [
        config.sandbox.caches_root.join("uv-cache"),
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
