use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::codex::runtime_metadata::{app_server_protocol_metadata, permission_profile_metadata};
use crate::config::{AppConfig, CliToolConfig};
use crate::runtime_checks::{
    ensure_nsjail_config_hardened, nsjail_config_hardening_details, probe_codex_linux_sandbox,
    probe_nsjail_runtime, resolve_executable,
};
use crate::sandbox::SandboxManager;
use crate::storage::{database_path, Storage};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckStatus {
    Pass,
    Warn,
    Fail,
}

impl CheckStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pass => "pass",
            Self::Warn => "warn",
            Self::Fail => "fail",
        }
    }
}

#[derive(Debug, Clone)]
pub struct DoctorCheck {
    pub name: String,
    pub category: String,
    pub status: CheckStatus,
    pub message: String,
    pub details: Value,
}

impl DoctorCheck {
    fn pass(name: &str, category: &str, message: impl Into<String>, details: Value) -> Self {
        Self {
            name: name.to_string(),
            category: category.to_string(),
            status: CheckStatus::Pass,
            message: message.into(),
            details,
        }
    }

    fn warn(name: &str, category: &str, message: impl Into<String>, details: Value) -> Self {
        Self {
            name: name.to_string(),
            category: category.to_string(),
            status: CheckStatus::Warn,
            message: message.into(),
            details,
        }
    }

    fn fail(name: &str, category: &str, message: impl Into<String>, details: Value) -> Self {
        Self {
            name: name.to_string(),
            category: category.to_string(),
            status: CheckStatus::Fail,
            message: message.into(),
            details,
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "name": self.name,
            "category": self.category,
            "status": self.status.as_str(),
            "message": self.message,
            "details": self.details
        })
    }
}

pub async fn readiness_report(config: &AppConfig) -> Value {
    let mut checks = vec![
        sqlite_check(config).await,
        writable_dir_check("sandboxes_root", &config.sandbox.sandboxes_root).await,
        writable_dir_check("caches_root", &config.sandbox.caches_root).await,
        executable_check(
            "codex_executable",
            "runtime",
            &config.codex.codex_executable,
            config.codex.enabled,
        ),
    ];
    if let Some(workspaces_root) = &config.sandbox.workspaces_root {
        checks.push(writable_dir_check("workspaces_root", workspaces_root).await);
    }
    let status = aggregate_status(&checks);
    let mut checks_object = serde_json::Map::new();
    for check in checks {
        checks_object.insert(check.name.clone(), check.to_json());
    }
    json!({
        "status": status,
        "service": "ripple-server",
        "generated_at": now_iso(),
        "checks": checks_object
    })
}

pub fn redact_deployment_paths(config: &AppConfig, value: Value) -> Value {
    let mut replacements = Vec::new();
    push_path_replacement(
        &mut replacements,
        &config.sandbox.sandboxes_root,
        "/sandbox/",
        "/sandbox",
    );
    if let Some(workspaces_root) = &config.sandbox.workspaces_root {
        push_path_replacement(
            &mut replacements,
            workspaces_root,
            "/workspace-storage/",
            "/workspace-storage",
        );
    }
    push_path_replacement(
        &mut replacements,
        &config.sandbox.caches_root,
        "/cache/",
        "/cache",
    );
    push_path_replacement(
        &mut replacements,
        &database_path(config),
        "/storage/",
        "/storage",
    );
    let codex_home = config.codex_home_path();
    push_path_replacement(
        &mut replacements,
        &codex_home,
        "/codex-home/",
        "/codex-home",
    );
    push_path_replacement(
        &mut replacements,
        &config.repo_root,
        "[host path redacted]/",
        "[host path redacted]",
    );
    if let Some(parent) = config.repo_root.parent() {
        push_path_replacement(
            &mut replacements,
            parent,
            "[host path redacted]/",
            "[host path redacted]",
        );
    }
    replacements.sort_by(|left: &(String, String), right| right.0.len().cmp(&left.0.len()));
    redact_value_paths(value, &replacements)
}

fn redact_value_paths(value: Value, replacements: &[(String, String)]) -> Value {
    match value {
        Value::String(text) => Value::String(redact_text_paths(&text, replacements)),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|value| redact_value_paths(value, replacements))
                .collect(),
        ),
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key, redact_value_paths(value, replacements)))
                .collect(),
        ),
        other => other,
    }
}

fn redact_text_paths(text: &str, replacements: &[(String, String)]) -> String {
    let mut out = text.to_string();
    for (from, to) in replacements {
        out = out.replace(from, to);
    }
    out
}

fn push_path_replacement(
    replacements: &mut Vec<(String, String)>,
    path: &Path,
    child_replacement: &str,
    exact_replacement: &str,
) {
    let path = slash_path(path);
    if path.is_empty() || path == "/" {
        return;
    }
    replacements.push((format!("{path}/"), child_replacement.to_string()));
    replacements.push((path, exact_replacement.to_string()));
}

fn slash_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

pub async fn doctor_report(config: &AppConfig) -> Value {
    let mut checks = vec![
        security_check(config),
        cors_check(config),
        sqlite_check(config).await,
        writable_dir_check("sandboxes_root", &config.sandbox.sandboxes_root).await,
        writable_dir_check("caches_root", &config.sandbox.caches_root).await,
        executable_check(
            "codex_executable",
            "runtime",
            &config.codex.codex_executable,
            config.codex.enabled,
        ),
        codex_app_server_runtime_config_check(config),
        executable_check(
            "connector_nsjail",
            "connectors",
            &config.sandbox.nsjail_path,
            true,
        ),
        codex_linux_sandbox_check(config).await,
        connector_nsjail_config_check(config).await,
        connector_nsjail_runtime_check(config).await,
    ];
    if let Some(workspaces_root) = &config.sandbox.workspaces_root {
        checks.push(writable_dir_check("workspaces_root", workspaces_root).await);
    }
    checks.extend(connector_cli_checks(config));
    let (pass_count, warn_count, fail_count) = count_statuses(&checks);
    let workspace_backup_path = if config.sandbox.workspaces_root.is_some() {
        "sandbox.workspaces_root/<user_id>/workspace"
    } else {
        ".ripple/sandboxes/<user_id>/workspace"
    };
    json!({
        "status": aggregate_status(&checks),
        "service": "ripple-server",
        "generated_at": now_iso(),
        "deployment_mode": config.security.deployment_mode,
        "checks": checks.iter().map(DoctorCheck::to_json).collect::<Vec<_>>(),
        "summary": {
            "pass": pass_count,
            "warn": warn_count,
            "fail": fail_count
        },
        "backup_contract": {
            "include": [
                ".ripple/ripple.sqlite",
                ".ripple/ripple.sqlite-wal",
                ".ripple/ripple.sqlite-shm",
                workspace_backup_path,
                ".ripple/sandboxes/<user_id>/credentials",
                ".ripple/sandboxes/<user_id>/agent-runs",
                ".ripple/sandboxes/<user_id>/sessions"
            ],
            "exclude": [
                ".ripple/sandboxes-cache"
            ],
            "codex_auth": "re-login the service CODEX_HOME after restore instead of copying auth into user workspaces"
        }
    })
}

pub fn has_failed_checks(report: &Value) -> bool {
    report
        .get("checks")
        .and_then(Value::as_array)
        .is_some_and(|checks| {
            checks
                .iter()
                .any(|check| check.get("status").and_then(Value::as_str) == Some("fail"))
        })
}

async fn sqlite_check(config: &AppConfig) -> DoctorCheck {
    let path = database_path(config);
    match Storage::open(&path) {
        Ok(storage) => match storage.initialize().await {
            Ok(()) => DoctorCheck::pass(
                "sqlite",
                "storage",
                "SQLite database is reachable and migrations are applied.",
                json!({"path": path}),
            ),
            Err(err) => DoctorCheck::fail(
                "sqlite",
                "storage",
                format!("SQLite initialization failed: {err}"),
                json!({"path": path}),
            ),
        },
        Err(err) => DoctorCheck::fail(
            "sqlite",
            "storage",
            format!("SQLite open failed: {err}"),
            json!({"path": path}),
        ),
    }
}

async fn writable_dir_check(name: &str, path: &Path) -> DoctorCheck {
    if let Err(err) = tokio::fs::create_dir_all(path).await {
        return DoctorCheck::fail(
            name,
            "filesystem",
            format!("Directory cannot be created: {err}"),
            json!({"path": path}),
        );
    }
    let probe = path.join(format!(".ripple-doctor-{}.tmp", Uuid::new_v4()));
    match tokio::fs::write(&probe, b"ok").await {
        Ok(()) => {
            let _ = tokio::fs::remove_file(&probe).await;
            DoctorCheck::pass(
                name,
                "filesystem",
                "Directory is writable.",
                json!({"path": path}),
            )
        }
        Err(err) => DoctorCheck::fail(
            name,
            "filesystem",
            format!("Directory is not writable: {err}"),
            json!({"path": path}),
        ),
    }
}

async fn codex_linux_sandbox_check(config: &AppConfig) -> DoctorCheck {
    match probe_codex_linux_sandbox(config).await {
        Ok(details) => DoctorCheck::pass(
            "codex_linux_sandbox",
            "runtime",
            "Codex Linux sandbox prerequisites are available.",
            details,
        ),
        Err(err) => DoctorCheck::fail(
            "codex_linux_sandbox",
            "runtime",
            format!("Codex Linux sandbox prerequisites failed: {err}"),
            json!({
                "codex_executable": config.codex.codex_executable,
                "required": config.codex.enabled,
                "fail_closed": true
            }),
        ),
    }
}

fn codex_app_server_runtime_config_check(config: &AppConfig) -> DoctorCheck {
    let args = &config.codex.app_server_args;
    let has_app_server = args.iter().any(|arg| arg == "app-server");
    let has_stdio_listen = args
        .windows(2)
        .any(|window| window[0] == "--listen" && window[1] == "stdio://");
    let listen = if has_stdio_listen {
        json!("stdio://")
    } else {
        Value::Null
    };
    let details = json!({
        "enabled": config.codex.enabled,
        "codex_executable": config.codex.codex_executable,
        "app_server_args": args,
        "listen": listen,
        "sandbox_type": config.codex.sandbox_type,
        "approval_policy": config.codex.approval_policy,
        "managed_permissions_profile": permission_profile_metadata(config)
            .get("id")
            .cloned()
            .unwrap_or(Value::Null),
        "permission_profile": permission_profile_metadata(config),
        "app_server_protocol": app_server_protocol_metadata(),
        "worker_pool": {
            "max_workers_per_pool": config.codex.max_workers_per_pool,
            "max_total_pool_workers": config.codex.max_total_pool_workers,
            "idle_timeout_seconds": config.codex.idle_timeout_seconds
        }
    });
    if !config.codex.enabled {
        return DoctorCheck::warn(
            "codex_app_server_runtime",
            "runtime",
            "Codex app-server runtime is disabled.",
            details,
        );
    }
    if !has_app_server || !has_stdio_listen {
        return DoctorCheck::fail(
            "codex_app_server_runtime",
            "runtime",
            "Codex runtime must launch `codex app-server --listen stdio://`.",
            details,
        );
    }
    DoctorCheck::pass(
        "codex_app_server_runtime",
        "runtime",
        "Codex app-server runtime configuration is ready.",
        details,
    )
}

async fn connector_nsjail_config_check(config: &AppConfig) -> DoctorCheck {
    let manager = SandboxManager::new(Arc::new(config.clone()));
    let user_id = format!("doctorcfg_{}", Uuid::new_v4().simple());
    let result = (|| -> anyhow::Result<Value> {
        manager.ensure_sandbox(&user_id)?;
        let cfg = manager.write_nsjail_config(&user_id)?;
        let cfg_text = std::fs::read_to_string(&cfg)?;
        ensure_nsjail_config_hardened(&cfg_text)?;
        Ok(json!({
            "probe_config_path": cfg,
            "probe_cleanup": true,
            "hardening": nsjail_config_hardening_details(&cfg_text)
        }))
    })();
    let _ = manager.teardown_sandbox(&user_id, true);
    match result {
        Ok(details) => DoctorCheck::pass(
            "connector_nsjail_config",
            "connectors",
            "Generated nsjail config declares required process isolation and fresh /proc.",
            details,
        ),
        Err(err) => DoctorCheck::fail(
            "connector_nsjail_config",
            "connectors",
            format!("Generated nsjail config failed hardening validation: {err}"),
            json!({"fail_closed": true}),
        ),
    }
}

async fn connector_nsjail_runtime_check(config: &AppConfig) -> DoctorCheck {
    match probe_nsjail_runtime(Arc::new(config.clone())).await {
        Ok(details) => DoctorCheck::pass(
            "connector_nsjail_runtime",
            "connectors",
            "nsjail runtime probe succeeded with fresh /proc.",
            details,
        ),
        Err(err) => DoctorCheck::fail(
            "connector_nsjail_runtime",
            "connectors",
            format!("nsjail runtime probe failed: {err}"),
            json!({
                "configured_nsjail": config.sandbox.nsjail_path,
                "fail_closed": true
            }),
        ),
    }
}

fn executable_check(name: &str, category: &str, executable: &str, required: bool) -> DoctorCheck {
    let found = resolve_executable(executable);
    match (required, found) {
        (_, Some(path)) => DoctorCheck::pass(
            name,
            category,
            "Executable found.",
            json!({"configured": executable, "resolved": path}),
        ),
        (false, None) => DoctorCheck::warn(
            name,
            category,
            "Executable is not configured, but this capability is disabled.",
            json!({"configured": executable}),
        ),
        (true, None) => DoctorCheck::fail(
            name,
            category,
            "Executable was not found on PATH or at the configured absolute path.",
            json!({"configured": executable}),
        ),
    }
}

fn security_check(config: &AppConfig) -> DoctorCheck {
    let mut warnings = Vec::new();
    if config.api_keys.is_empty() {
        warnings.push("server.api_keys is empty");
    }
    if config.security.deployment_mode != "trusted-proxy" {
        warnings.push("deployment_mode is not trusted-proxy");
    }
    if !config.security.require_confirm_for_risky_api {
        warnings.push("risky API confirmation is disabled");
    }
    if config
        .public_base_url
        .as_deref()
        .is_some_and(|url| url.starts_with("http://"))
        && config.security.require_https
    {
        warnings.push("public_base_url uses HTTP while require_https is true");
    }
    if warnings.is_empty() {
        DoctorCheck::pass(
            "config.security",
            "security",
            "Security posture matches the single-node trusted-proxy recommendation.",
            json!({
                "deployment_mode": config.security.deployment_mode,
                "require_confirm_for_risky_api": config.security.require_confirm_for_risky_api,
                "require_https": config.security.require_https
            }),
        )
    } else {
        DoctorCheck::warn(
            "config.security",
            "security",
            warnings.join("; "),
            json!({
                "deployment_mode": config.security.deployment_mode,
                "require_confirm_for_risky_api": config.security.require_confirm_for_risky_api,
                "require_https": config.security.require_https
            }),
        )
    }
}

fn cors_check(config: &AppConfig) -> DoctorCheck {
    if config.cors.allow_any_origin {
        return DoctorCheck::warn(
            "config.cors",
            "security",
            "CORS allows any origin.",
            json!({"allow_any_origin": true, "allowed_origins": config.cors.allowed_origins}),
        );
    }
    DoctorCheck::pass(
        "config.cors",
        "security",
        "CORS is restricted by default.",
        json!({
            "allow_any_origin": false,
            "allowed_origins": config.cors.allowed_origins
        }),
    )
}

fn connector_cli_checks(config: &AppConfig) -> Vec<DoctorCheck> {
    let mut checks = Vec::new();
    add_optional_vendor_check(
        &mut checks,
        "connector_lark_cli",
        config.sandbox.lark_cli_install_root.as_ref(),
        "lark-cli",
    );
    add_optional_vendor_check(
        &mut checks,
        "connector_notion_cli",
        config.sandbox.notion_cli_install_root.as_ref(),
        "ntn",
    );
    add_optional_vendor_check(
        &mut checks,
        "connector_gogcli",
        config.sandbox.gogcli_cli_install_root.as_ref(),
        "gog",
    );
    for tool in &config.sandbox.cli_tools {
        checks.push(cli_tool_check(tool));
    }
    checks
}

fn add_optional_vendor_check(
    checks: &mut Vec<DoctorCheck>,
    name: &str,
    root: Option<&PathBuf>,
    binary: &str,
) {
    let Some(root) = root else {
        checks.push(DoctorCheck::warn(
            name,
            "connectors",
            "Connector CLI root is not configured or discovered.",
            json!({"binary": binary}),
        ));
        return;
    };
    let path = root.join("current/bin").join(binary);
    if path.is_file() {
        checks.push(DoctorCheck::pass(
            name,
            "connectors",
            "Connector CLI binary found.",
            json!({"path": path}),
        ));
    } else {
        checks.push(DoctorCheck::warn(
            name,
            "connectors",
            "Connector CLI binary is missing.",
            json!({"path": path}),
        ));
    }
}

fn cli_tool_check(tool: &CliToolConfig) -> DoctorCheck {
    let found = tool
        .bin_dirs
        .iter()
        .any(|bin_dir| tool.install_root.join(bin_dir).is_dir());
    if found {
        DoctorCheck::pass(
            &format!("connector_tool_{}", tool.name),
            "connectors",
            "Configured connector tool bin directory exists.",
            json!({"install_root": tool.install_root, "bin_dirs": tool.bin_dirs}),
        )
    } else {
        DoctorCheck::warn(
            &format!("connector_tool_{}", tool.name),
            "connectors",
            "Configured connector tool bin directory is missing.",
            json!({"install_root": tool.install_root, "bin_dirs": tool.bin_dirs}),
        )
    }
}

fn aggregate_status(checks: &[DoctorCheck]) -> &'static str {
    if checks.iter().any(|check| check.status == CheckStatus::Fail) {
        "not_ready"
    } else if checks.iter().any(|check| check.status == CheckStatus::Warn) {
        "degraded"
    } else {
        "ready"
    }
}

fn count_statuses(checks: &[DoctorCheck]) -> (usize, usize, usize) {
    let mut pass_count = 0;
    let mut warn_count = 0;
    let mut fail_count = 0;
    for check in checks {
        match check.status {
            CheckStatus::Pass => pass_count += 1,
            CheckStatus::Warn => warn_count += 1,
            CheckStatus::Fail => fail_count += 1,
        }
    }
    (pass_count, warn_count, fail_count)
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

pub async fn doctor_report_for_config(config: AppConfig) -> Value {
    let config = Arc::new(config);
    doctor_report(&config).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        AppConfig, CodexConfig, CorsConfig, DocumentPreviewConfig, GogcliOAuthConfig,
        LoggingConfig, SandboxConfig, SecurityConfig, SkillsConfig, UserAuthConfig,
    };

    #[tokio::test]
    async fn doctor_report_includes_sandbox_runtime_checks() {
        let root =
            std::env::temp_dir().join(format!("ripple-doctor-test-{}", uuid::Uuid::new_v4()));
        let report = doctor_report_for_config(test_config(&root)).await;
        let checks = report
            .get("checks")
            .and_then(Value::as_array)
            .expect("doctor checks");
        let names = checks
            .iter()
            .filter_map(|check| check.get("name").and_then(Value::as_str))
            .collect::<Vec<_>>();

        assert!(names.contains(&"codex_linux_sandbox"));
        assert!(names.contains(&"connector_nsjail_runtime"));
        assert!(names.contains(&"connector_nsjail_config"));
        let codex_runtime = checks
            .iter()
            .find(|check| {
                check.get("name").and_then(Value::as_str) == Some("codex_app_server_runtime")
            })
            .expect("codex app-server runtime check");
        assert_eq!(
            codex_runtime
                .pointer("/details/permission_profile/id")
                .and_then(Value::as_str),
            Some("ripple_workspace")
        );
        assert_eq!(
            codex_runtime
                .pointer("/details/app_server_protocol/transport")
                .and_then(Value::as_str),
            Some("stdio")
        );
        assert!(codex_runtime
            .pointer("/details/app_server_protocol/methods")
            .and_then(Value::as_array)
            .is_some_and(|methods| methods
                .iter()
                .any(|method| method == "account/workspaceMessages/read")));

        let _ = std::fs::remove_dir_all(root);
    }

    fn test_config(root: &Path) -> AppConfig {
        AppConfig {
            repo_root: root.to_path_buf(),
            host: "127.0.0.1".to_string(),
            port: 8810,
            api_keys: vec!["test-key".to_string()],
            security: SecurityConfig::default(),
            user_auth: UserAuthConfig::default(),
            api_docs: crate::config::ApiDocsConfig::default(),
            cors: CorsConfig::default(),
            default_model: "codex-medium".to_string(),
            model_presets: Default::default(),
            logging: LoggingConfig {
                level: "debug".to_string(),
            },
            sandbox: SandboxConfig {
                sandboxes_root: root.join("sandboxes"),
                workspaces_root: None,
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
                app_server_args: vec![
                    "app-server".to_string(),
                    "--listen".to_string(),
                    "stdio://".to_string(),
                ],
                codex_home: Some(root.join(".ripple/codex-service-home")),
                approval_policy: "never".to_string(),
                sandbox_type: "workspace-write".to_string(),
                network_access: true,
                idle_timeout_seconds: 1800,
                max_workers_per_pool: 8,
                max_total_pool_workers: 256,
                memory: crate::config::CodexMemoryConfig::default(),
                max_runtime_seconds: 3600,
                runtime_log_retention_seconds: 86_400,
                runtime_log_max_mb: 64,
                runtime_log_cleanup_interval_seconds: 3600,
            },
            task_trigger_extraction_max_runtime_seconds: 120,
            task_trigger_poll_interval_seconds: 15,
            document_preview: DocumentPreviewConfig {
                cache_root: root.join("cache/previews"),
                libreoffice_path: "soffice".to_string(),
                max_source_bytes: 64 * 1024 * 1024,
                conversion_timeout_seconds: 120,
            },
            skills: SkillsConfig {
                shared_dirs: vec!["skills/*".to_string()],
            },
            public_base_url: None,
            feishu: Default::default(),
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
