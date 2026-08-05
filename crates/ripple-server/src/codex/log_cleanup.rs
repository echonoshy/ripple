use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Context;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use tokio::time::MissedTickBehavior;
use tracing::{debug, warn};

use crate::config::AppConfig;

const CODEX_LOGS_DB_FILENAME: &str = "logs_2.sqlite";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodexRuntimeLogCleanupReport {
    pub scanned_databases: usize,
    pub cleaned_databases: usize,
    pub pruned_rows: u64,
    pub cleared_due_to_size: usize,
    pub skipped_databases: usize,
}

#[derive(Debug, Clone, Default)]
struct DatabaseCleanupOutcome {
    pruned_rows: u64,
    cleared_due_to_size: bool,
}

pub async fn maintenance_loop(config: Arc<AppConfig>) {
    let interval_seconds = config.codex.runtime_log_cleanup_interval_seconds.max(60);
    let mut interval = tokio::time::interval(Duration::from_secs(interval_seconds));
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        interval.tick().await;
        match cleanup_codex_runtime_logs_once(&config).await {
            Ok(report) => {
                if report.cleaned_databases > 0 || report.skipped_databases > 0 {
                    debug!(
                        scanned_databases = report.scanned_databases,
                        cleaned_databases = report.cleaned_databases,
                        pruned_rows = report.pruned_rows,
                        cleared_due_to_size = report.cleared_due_to_size,
                        skipped_databases = report.skipped_databases,
                        "completed Codex runtime log cleanup"
                    );
                }
            }
            Err(err) => {
                warn!(error = %err, "Codex runtime log cleanup failed");
            }
        }
    }
}

pub async fn cleanup_codex_runtime_logs_once(
    config: &AppConfig,
) -> anyhow::Result<CodexRuntimeLogCleanupReport> {
    cleanup_codex_runtime_logs_at(config, current_unix_seconds()).await
}

pub(crate) async fn cleanup_codex_runtime_logs_at(
    config: &AppConfig,
    now_unix_seconds: i64,
) -> anyhow::Result<CodexRuntimeLogCleanupReport> {
    let retention_seconds =
        i64::try_from(config.codex.runtime_log_retention_seconds).unwrap_or(i64::MAX);
    let cutoff = now_unix_seconds.saturating_sub(retention_seconds);
    let max_bytes = config
        .codex
        .runtime_log_max_mb
        .saturating_mul(1024)
        .saturating_mul(1024);
    let paths = discover_log_databases(config)?;
    let mut report = CodexRuntimeLogCleanupReport::default();

    for path in paths {
        report.scanned_databases += 1;
        match cleanup_log_database(&path, cutoff, max_bytes).await {
            Ok(outcome) => {
                if outcome.pruned_rows > 0 || outcome.cleared_due_to_size {
                    report.cleaned_databases += 1;
                }
                report.pruned_rows = report.pruned_rows.saturating_add(outcome.pruned_rows);
                if outcome.cleared_due_to_size {
                    report.cleared_due_to_size += 1;
                }
            }
            Err(err) => {
                report.skipped_databases += 1;
                warn!(
                    path = %path.display(),
                    error = %err,
                    "skipped Codex log cleanup for database"
                );
            }
        }
    }

    Ok(report)
}

async fn cleanup_log_database(
    path: &Path,
    cutoff_unix_seconds: i64,
    max_bytes: u64,
) -> anyhow::Result<DatabaseCleanupOutcome> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_millis(250));
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .with_context(|| format!("failed to open {}", path.display()))?;

    let has_logs_table = sqlx::query(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'logs' LIMIT 1",
    )
    .fetch_optional(&pool)
    .await?
    .is_some();
    if !has_logs_table {
        pool.close().await;
        return Ok(DatabaseCleanupOutcome::default());
    }

    let pruned_rows = sqlx::query("DELETE FROM logs WHERE ts < ?")
        .bind(cutoff_unix_seconds)
        .execute(&pool)
        .await?
        .rows_affected();
    if pruned_rows > 0 {
        compact_sqlite_database(&pool).await?;
    }

    let mut cleared_due_to_size = false;
    if sqlite_family_size_bytes(path)? > max_bytes {
        sqlx::query("DELETE FROM logs").execute(&pool).await?;
        compact_sqlite_database(&pool).await?;
        cleared_due_to_size = true;
    }

    pool.close().await;
    Ok(DatabaseCleanupOutcome {
        pruned_rows,
        cleared_due_to_size,
    })
}

async fn compact_sqlite_database(pool: &sqlx::SqlitePool) -> anyhow::Result<()> {
    let _ = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(pool)
        .await?;
    sqlx::query("VACUUM").execute(pool).await?;
    let _ = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(pool)
        .await?;
    Ok(())
}

fn discover_log_databases(config: &AppConfig) -> anyhow::Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    collect_existing_user_runtime_log_databases(config, &mut paths)?;
    collect_existing_legacy_codex_home_log_databases(config, &mut paths)?;
    let service_logs = config.codex_home_path().join(CODEX_LOGS_DB_FILENAME);
    if service_logs.is_file() {
        paths.push(service_logs);
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn collect_existing_user_runtime_log_databases(
    config: &AppConfig,
    paths: &mut Vec<PathBuf>,
) -> anyhow::Result<()> {
    let users_root = codex_runtime_users_root(config);
    if !users_root.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(&users_root)
        .with_context(|| format!("failed to read {}", users_root.display()))?
    {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let candidate = entry.path().join("sqlite").join(CODEX_LOGS_DB_FILENAME);
        if candidate.is_file() {
            paths.push(candidate);
        }
    }
    Ok(())
}

fn collect_existing_legacy_codex_home_log_databases(
    config: &AppConfig,
    paths: &mut Vec<PathBuf>,
) -> anyhow::Result<()> {
    let sandboxes_root = &config.sandbox.sandboxes_root;
    if !sandboxes_root.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(sandboxes_root)
        .with_context(|| format!("failed to read {}", sandboxes_root.display()))?
    {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let candidate = entry.path().join("codex-home").join(CODEX_LOGS_DB_FILENAME);
        if candidate.is_file() {
            paths.push(candidate);
        }
    }
    Ok(())
}

fn codex_runtime_users_root(config: &AppConfig) -> PathBuf {
    config.codex_sqlite_root_path().join("users")
}

fn sqlite_family_size_bytes(path: &Path) -> anyhow::Result<u64> {
    let mut total = match std::fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => 0,
        Err(err) => return Err(err.into()),
    };
    for suffix in ["-wal", "-shm"] {
        let sidecar = sqlite_sidecar_path(path, suffix);
        match std::fs::metadata(&sidecar) {
            Ok(metadata) => total = total.saturating_add(metadata.len()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
    }
    Ok(total)
}

fn sqlite_sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn current_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
    use sqlx::{Row, SqlitePool};

    use super::*;
    use crate::config::{
        ApiDocsConfig, AppConfig, CodexConfig, CorsConfig, DocumentPreviewConfig, FeishuConfig,
        GogcliOAuthConfig, LoggingConfig, SandboxConfig, SecurityConfig, SkillsConfig,
        UserAuthConfig,
    };

    #[tokio::test]
    async fn cleanup_prunes_old_logs_without_touching_restore_state() -> anyhow::Result<()> {
        let root = temp_root("codex-log-prune");
        let mut config = test_config(&root);
        config.codex.runtime_log_retention_seconds = 3_600;
        config.codex.runtime_log_max_mb = 64;
        let now = 1_800_000_000_i64;
        let user_id = "usr_log_prune";
        let logs_path = logs_path(&root, user_id);
        let state_path = logs_path.with_file_name("state_5.sqlite");
        let session_marker = root
            .join(".ripple/sandboxes")
            .join(user_id)
            .join("codex-home/sessions/srv-test/marker.txt");

        let pool = create_logs_db(&logs_path).await?;
        insert_log(&pool, now - 7_200, "old").await?;
        insert_log(&pool, now - 60, "recent").await?;
        pool.close().await;

        std::fs::write(&state_path, b"state stays")?;
        std::fs::create_dir_all(session_marker.parent().expect("session marker parent"))?;
        std::fs::write(&session_marker, b"session stays")?;

        let report = cleanup_codex_runtime_logs_at(&config, now).await?;

        assert_eq!(report.scanned_databases, 1);
        assert_eq!(report.pruned_rows, 1);
        assert_eq!(row_count(&logs_path).await?, 1);
        assert_eq!(remaining_feedback_bodies(&logs_path).await?, vec!["recent"]);
        assert_eq!(std::fs::read_to_string(&state_path)?, "state stays");
        assert_eq!(std::fs::read_to_string(&session_marker)?, "session stays");

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn cleanup_clears_log_database_when_it_exceeds_size_limit() -> anyhow::Result<()> {
        let root = temp_root("codex-log-size");
        let mut config = test_config(&root);
        config.codex.runtime_log_retention_seconds = 86_400;
        config.codex.runtime_log_max_mb = 1;
        let now = 1_800_000_000_i64;
        let logs_path = logs_path(&root, "usr_log_size");
        let pool = create_logs_db(&logs_path).await?;
        let large_body = "x".repeat(2 * 1024 * 1024);
        insert_log(&pool, now - 60, &large_body).await?;
        pool.close().await;

        let report = cleanup_codex_runtime_logs_at(&config, now).await?;

        assert_eq!(report.scanned_databases, 1);
        assert_eq!(report.cleared_due_to_size, 1);
        assert_eq!(row_count(&logs_path).await?, 0);
        assert!(sqlite_family_size_bytes(&logs_path)? <= 1_024 * 1_024);

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn cleanup_prunes_legacy_codex_home_log_database() -> anyhow::Result<()> {
        let root = temp_root("codex-log-legacy");
        let mut config = test_config(&root);
        config.codex.runtime_log_retention_seconds = 3_600;
        let now = 1_800_000_000_i64;
        let logs_path = root.join(".ripple/sandboxes/usr_legacy/codex-home/logs_2.sqlite");
        let pool = create_logs_db(&logs_path).await?;
        insert_log(&pool, now - 7_200, "old legacy").await?;
        pool.close().await;

        let report = cleanup_codex_runtime_logs_at(&config, now).await?;

        assert_eq!(report.scanned_databases, 1);
        assert_eq!(report.pruned_rows, 1);
        assert_eq!(row_count(&logs_path).await?, 0);

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    async fn create_logs_db(path: &Path) -> anyhow::Result<SqlitePool> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_millis(5_000));
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        sqlx::query(
            r#"
CREATE TABLE logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    ts_nanos INTEGER NOT NULL,
    level TEXT NOT NULL,
    target TEXT NOT NULL,
    feedback_log_body TEXT,
    module_path TEXT,
    file TEXT,
    line INTEGER,
    thread_id TEXT,
    process_uuid TEXT,
    estimated_bytes INTEGER NOT NULL DEFAULT 0
);
"#,
        )
        .execute(&pool)
        .await?;
        Ok(pool)
    }

    async fn insert_log(pool: &SqlitePool, ts: i64, body: &str) -> anyhow::Result<()> {
        sqlx::query(
            r#"
INSERT INTO logs (
    ts, ts_nanos, level, target, feedback_log_body, estimated_bytes
) VALUES (?, 0, 'INFO', 'test', ?, ?)
"#,
        )
        .bind(ts)
        .bind(body)
        .bind(i64::try_from(body.len()).unwrap_or(i64::MAX))
        .execute(pool)
        .await?;
        Ok(())
    }

    async fn row_count(path: &Path) -> anyhow::Result<i64> {
        let pool = open_logs_db(path).await?;
        let row = sqlx::query("SELECT COUNT(*) AS count FROM logs")
            .fetch_one(&pool)
            .await?;
        pool.close().await;
        Ok(row.get("count"))
    }

    async fn remaining_feedback_bodies(path: &Path) -> anyhow::Result<Vec<String>> {
        let pool = open_logs_db(path).await?;
        let rows = sqlx::query("SELECT feedback_log_body FROM logs ORDER BY ts ASC")
            .fetch_all(&pool)
            .await?;
        pool.close().await;
        Ok(rows
            .into_iter()
            .filter_map(|row| row.get::<Option<String>, _>("feedback_log_body"))
            .collect())
    }

    async fn open_logs_db(path: &Path) -> anyhow::Result<SqlitePool> {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(false)
            .busy_timeout(Duration::from_millis(5_000));
        Ok(SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?)
    }

    fn logs_path(root: &Path, user_id: &str) -> PathBuf {
        root.join(".ripple/codex-runtime/users")
            .join(user_id)
            .join("sqlite/logs_2.sqlite")
    }

    fn temp_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ripple-{name}-{}", uuid::Uuid::new_v4()))
    }

    fn test_config(root: &Path) -> AppConfig {
        AppConfig {
            repo_root: root.to_path_buf(),
            host: "127.0.0.1".to_string(),
            port: 8810,
            api_keys: vec!["test-key".to_string()],
            enabled_connectors: crate::config::default_enabled_connectors(),
            security: SecurityConfig::default(),
            user_auth: UserAuthConfig::default(),
            api_docs: ApiDocsConfig::default(),
            cors: CorsConfig::default(),
            default_model: "codex-medium".to_string(),
            model_presets: BTreeMap::new(),
            model_fallback_chain: Vec::new(),
            logging: LoggingConfig {
                level: "debug".to_string(),
            },
            storage: crate::config::StorageConfig {
                sqlite_max_connections: 50,
            },
            sandbox: SandboxConfig {
                sandboxes_root: root.join(".ripple/sandboxes"),
                workspaces_root: None,
                caches_root: root.join(".ripple/sandboxes-cache"),
                idle_suspend_seconds: 1800,
                retention_seconds: 604_800,
                max_workspace_mb: 2048,
                tmpfs_size_mb: 512,
                nsjail_path: "nsjail".to_string(),
                python_envs_root: root.join(".ripple/sandboxes-cache/python-envs"),
                python_env_uv_cache: root.join(".ripple/sandboxes-cache/uv-cache"),
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
                sqlite_root: None,
                approval_policy: serde_json::json!("never"),
                sandbox_type: "workspace-write".to_string(),
                network_access: true,
                idle_timeout_seconds: 1800,
                max_workers_per_pool: 8,
                max_total_pool_workers: 256,
                max_runtime_seconds: 3600,
                runtime_log_retention_seconds: 86_400,
                runtime_log_max_mb: 64,
                runtime_log_cleanup_interval_seconds: 3600,
            },
            task_trigger_extraction_max_runtime_seconds: 120,
            task_trigger_poll_interval_seconds: 15,
            document_preview: DocumentPreviewConfig {
                cache_root: root.join(".ripple/sandboxes-cache/previews"),
                libreoffice_path: "soffice".to_string(),
                max_source_bytes: 64 * 1024 * 1024,
                conversion_timeout_seconds: 120,
            },
            skills: SkillsConfig {
                shared_dirs: vec!["skills/*".to_string()],
                ..SkillsConfig::default()
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
