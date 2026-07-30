use std::path::{Path, PathBuf};

use serde_json::Value;
use tokio::process::Command;

use crate::config::AppConfig;
use crate::python_env::ripple_py_bin_dir;
use crate::user::validate_user_id;

pub(super) const INHERITED_NETWORK_ENV: &[&str] = &[
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "CURL_CA_BUNDLE",
    "REQUESTS_CA_BUNDLE",
    "ARK_API_KEY",
];

const CODEX_NATIVE_HARDENING_CONFIG_OVERRIDES: &[&str] = &[
    "include_apps_instructions=false",
    "features.apps=false",
    "features.plugins=false",
    "skills.include_instructions=false",
    "skills.bundled.enabled=false",
];

const CODEX_NATIVE_ENABLED_FEATURES: &[&str] =
    &["request_permissions_tool", "exec_permission_approvals"];

pub(super) struct NodeRuntimePaths {
    pub(super) bin: PathBuf,
    pub(super) prefix: PathBuf,
    pub(super) tmp: PathBuf,
    pub(super) compile_cache: PathBuf,
}

pub(super) fn codex_home_for_user(config: &AppConfig, user_id: &str) -> anyhow::Result<PathBuf> {
    Ok(codex_runtime_home_for_user(config, user_id)?.join("codex-home"))
}

pub(super) fn codex_runtime_home_for_user(
    config: &AppConfig,
    user_id: &str,
) -> anyhow::Result<PathBuf> {
    validate_user_id(user_id).map_err(anyhow::Error::msg)?;
    let codex_home = config.codex_home_path();
    let runtime_root = codex_home
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| codex_home.clone())
        .join("codex-runtime");
    Ok(runtime_root.join("users").join(user_id))
}

pub(super) fn codex_sqlite_home_for_user(
    config: &AppConfig,
    user_id: &str,
) -> anyhow::Result<PathBuf> {
    validate_user_id(user_id).map_err(anyhow::Error::msg)?;
    Ok(config
        .codex_sqlite_root_path()
        .join("users")
        .join(user_id)
        .join("sqlite"))
}

pub(super) fn node_runtime_paths(runtime_home: &Path) -> NodeRuntimePaths {
    let node_home = runtime_home.join("node");
    NodeRuntimePaths {
        bin: node_home.join("bin"),
        prefix: node_home.join("prefix"),
        tmp: node_home.join("tmp"),
        compile_cache: node_home.join("compile-cache"),
    }
}

pub(super) fn requires_service_codex_auth(config: &AppConfig) -> bool {
    let executable_name = Path::new(&config.codex.codex_executable)
        .file_name()
        .and_then(|name| name.to_str());
    executable_name == Some("codex")
        || config
            .codex
            .app_server_args
            .iter()
            .any(|arg| arg == "app-server")
}

pub(super) fn inherit_env_allowlist(command: &mut Command, keys: &[&str]) {
    for key in keys {
        if let Some(value) = std::env::var_os(key) {
            if !value.is_empty() {
                command.env(*key, value);
            }
        }
    }
}

pub(super) async fn read_json_string_field(path: &Path, field: &str) -> Option<String> {
    let value = serde_json::from_slice::<Value>(&tokio::fs::read(path).await.ok()?).ok()?;
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(super) fn connector_credential_env(
    credentials_dir: &Path,
) -> Vec<(String, std::ffi::OsString)> {
    let bilibili_file = credentials_dir.join("bilibili.json");
    if bilibili_file.is_file() {
        vec![(
            "BILIBILI_CREDENTIAL_FILE".to_string(),
            bilibili_file.into_os_string(),
        )]
    } else {
        Vec::new()
    }
}

pub(super) fn hardened_app_server_args(configured: &[String]) -> Vec<String> {
    let mut args = configured.to_vec();
    for config_override in CODEX_NATIVE_HARDENING_CONFIG_OVERRIDES {
        args.push("-c".to_string());
        args.push((*config_override).to_string());
    }
    for feature in CODEX_NATIVE_ENABLED_FEATURES {
        args.push("--enable".to_string());
        args.push((*feature).to_string());
    }
    args
}

pub(super) fn runtime_path(
    config: &AppConfig,
    extra_prefixes: &[PathBuf],
) -> Option<std::ffi::OsString> {
    let mut entries = Vec::new();
    entries.extend(extra_prefixes.iter().cloned());
    entries.push(ripple_py_bin_dir(config));
    if let Some(uv_bin_dir) = &config.sandbox.uv_bin_dir {
        entries.push(uv_bin_dir.clone());
    }
    if let Some(node_dir) = &config.sandbox.node_dir {
        entries.push(node_dir.join("bin"));
    }
    if let Some(root) = &config.sandbox.lark_cli_install_root {
        entries.push(root.join("current/bin"));
    }
    if let Some(root) = &config.sandbox.notion_cli_install_root {
        entries.push(root.join("current/bin"));
    }
    if let Some(root) = &config.sandbox.gogcli_cli_install_root {
        entries.push(root.join("current/bin"));
    }
    for tool in &config.sandbox.cli_tools {
        for bin_dir in &tool.bin_dirs {
            entries.push(tool.install_root.join(bin_dir));
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        entries.extend(std::env::split_paths(&path));
    }
    if entries.is_empty() {
        return None;
    }
    std::env::join_paths(entries).ok()
}

#[cfg(test)]
mod tests {
    use super::INHERITED_NETWORK_ENV;

    #[test]
    fn inherits_ark_api_key_for_custom_coding_plan_providers() {
        assert!(INHERITED_NETWORK_ENV.contains(&"ARK_API_KEY"));
    }
}
