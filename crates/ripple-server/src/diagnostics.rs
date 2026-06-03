use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;

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
    let checks = vec![
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
    checks.extend(connector_cli_checks(config));
    let (pass_count, warn_count, fail_count) = count_statuses(&checks);
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
                ".ripple/sandboxes/<user_id>/workspace",
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
                max_runtime_seconds: 3600,
            },
            schedule_extraction_max_runtime_seconds: 120,
            schedule_poll_interval_seconds: 15,
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
