use std::path::Path;
use std::sync::Arc;

use serde_json::Value;

use crate::config::AppConfig;
use crate::sessions::SessionRecord;
use crate::storage::Storage;

#[derive(Debug, Default)]
pub struct MigrationReport {
    pub sessions_imported: usize,
    pub jobs_imported: usize,
    pub documents_imported: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}

impl MigrationReport {
    pub fn print(&self) {
        println!("SQLite migration completed");
        println!("sessions_imported={}", self.sessions_imported);
        println!("jobs_imported={}", self.jobs_imported);
        println!("documents_imported={}", self.documents_imported);
        println!("skipped={}", self.skipped);
        if !self.errors.is_empty() {
            println!("errors={}", self.errors.len());
            for error in &self.errors {
                println!("error_path={error}");
            }
        }
    }
}

pub async fn migrate_files_to_sqlite(config: AppConfig) -> anyhow::Result<MigrationReport> {
    let config = Arc::new(config);
    let storage = Storage::new(config.clone())?;
    storage.initialize().await?;
    migrate_sandboxes(&storage, &config.sandbox.sandboxes_root).await
}

async fn migrate_sandboxes(
    storage: &Storage,
    sandboxes_root: &Path,
) -> anyhow::Result<MigrationReport> {
    let mut report = MigrationReport::default();
    if !sandboxes_root.exists() {
        return Ok(report);
    }
    let mut users = tokio::fs::read_dir(sandboxes_root).await?;
    while let Some(entry) = users.next_entry().await? {
        if !entry.file_type().await?.is_dir() {
            report.skipped += 1;
            continue;
        }
        let Some(user_id) = entry.file_name().to_str().map(str::to_string) else {
            report.skipped += 1;
            continue;
        };
        migrate_user_sandbox(storage, &user_id, &entry.path(), &mut report).await;
    }
    Ok(report)
}

async fn migrate_user_sandbox(
    storage: &Storage,
    user_id: &str,
    sandbox_dir: &Path,
    report: &mut MigrationReport,
) {
    migrate_sessions(storage, user_id, &sandbox_dir.join("sessions"), report).await;
    migrate_job_root(
        storage,
        &sandbox_dir.join("agent-runs/external-agents"),
        report,
    )
    .await;
    migrate_session_job_roots(storage, &sandbox_dir.join("sessions"), report).await;
    migrate_documents(
        storage,
        user_id,
        &sandbox_dir.join("documents/index.json"),
        report,
    )
    .await;
}

async fn migrate_sessions(
    storage: &Storage,
    user_id: &str,
    sessions_dir: &Path,
    report: &mut MigrationReport,
) {
    if !sessions_dir.exists() {
        return;
    }
    let Ok(mut entries) = tokio::fs::read_dir(sessions_dir).await else {
        report.errors.push(sessions_dir.display().to_string());
        return;
    };
    loop {
        let entry = match entries.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(_) => {
                report.errors.push(sessions_dir.display().to_string());
                break;
            }
        };
        let Ok(file_type) = entry.file_type().await else {
            report.skipped += 1;
            continue;
        };
        if !file_type.is_dir() {
            report.skipped += 1;
            continue;
        }
        let session_dir = entry.path();
        let meta_path = session_dir.join("meta.json");
        let Some(mut record) = read_json::<SessionRecord>(&meta_path, report).await else {
            continue;
        };
        if record.user_id.is_empty() {
            record.user_id = user_id.to_string();
        }
        if let Some(messages) = read_jsonl(session_dir.join("messages.jsonl"), report).await {
            record.messages = messages;
        }
        record.message_count = record.messages.len();
        if storage.save_session(&record).await.is_ok() {
            report.sessions_imported += 1;
        } else {
            report.errors.push(meta_path.display().to_string());
        }
    }
}

async fn migrate_job_root(storage: &Storage, root: &Path, report: &mut MigrationReport) {
    if !root.exists() {
        return;
    }
    let Ok(mut entries) = tokio::fs::read_dir(root).await else {
        report.errors.push(root.display().to_string());
        return;
    };
    loop {
        let entry = match entries.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(_) => {
                report.errors.push(root.display().to_string());
                break;
            }
        };
        let Ok(file_type) = entry.file_type().await else {
            report.skipped += 1;
            continue;
        };
        if !file_type.is_dir() {
            report.skipped += 1;
            continue;
        }
        let meta_path = entry.path().join("meta.json");
        let Some(record) = read_json_value(&meta_path, report).await else {
            continue;
        };
        if storage.upsert_job(&record).await.is_ok() {
            report.jobs_imported += 1;
        } else {
            report.errors.push(meta_path.display().to_string());
        }
    }
}

async fn migrate_session_job_roots(
    storage: &Storage,
    sessions_dir: &Path,
    report: &mut MigrationReport,
) {
    if !sessions_dir.exists() {
        return;
    }
    let Ok(mut sessions) = tokio::fs::read_dir(sessions_dir).await else {
        report.errors.push(sessions_dir.display().to_string());
        return;
    };
    while let Ok(Some(session)) = sessions.next_entry().await {
        migrate_job_root(storage, &session.path().join("external-agents"), report).await;
    }
}

async fn migrate_documents(
    storage: &Storage,
    user_id: &str,
    path: &Path,
    report: &mut MigrationReport,
) {
    let Some(value) = read_json_value(path, report).await else {
        return;
    };
    let records = value
        .get("documents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let count = records.len();
    if storage.replace_documents(user_id, &records).await.is_ok() {
        report.documents_imported += count;
    } else {
        report.errors.push(path.display().to_string());
    }
}

async fn read_json<T: serde::de::DeserializeOwned>(
    path: impl AsRef<Path>,
    report: &mut MigrationReport,
) -> Option<T> {
    let path = path.as_ref();
    if !path.is_file() {
        return None;
    }
    match tokio::fs::read(path).await {
        Ok(bytes) => match serde_json::from_slice::<T>(&bytes) {
            Ok(value) => Some(value),
            Err(_) => {
                report.errors.push(path.display().to_string());
                None
            }
        },
        Err(_) => {
            report.errors.push(path.display().to_string());
            None
        }
    }
}

async fn read_json_value(path: impl AsRef<Path>, report: &mut MigrationReport) -> Option<Value> {
    read_json(path, report).await
}

async fn read_jsonl(path: impl AsRef<Path>, report: &mut MigrationReport) -> Option<Vec<Value>> {
    let path = path.as_ref();
    if !path.is_file() {
        return None;
    }
    let text = match tokio::fs::read_to_string(path).await {
        Ok(text) => text,
        Err(_) => {
            report.errors.push(path.display().to_string());
            return None;
        }
    };
    let mut messages = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(value) => messages.push(value),
            Err(_) => report.errors.push(path.display().to_string()),
        }
    }
    Some(messages)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    use crate::config::{
        CodexConfig, CorsConfig, FeishuConfig, GogcliOAuthConfig, LoggingConfig, SandboxConfig,
        SecurityConfig, SkillsConfig, UserAuthConfig,
    };

    fn test_config(root: &Path) -> AppConfig {
        AppConfig {
            repo_root: root.to_path_buf(),
            host: "127.0.0.1".to_string(),
            port: 0,
            api_keys: Vec::new(),
            enabled_connectors: crate::config::default_enabled_connectors(),
            security: SecurityConfig::default(),
            user_auth: UserAuthConfig::default(),
            api_docs: crate::config::ApiDocsConfig::default(),
            cors: CorsConfig::default(),
            default_model: "codex-test".to_string(),
            model_presets: BTreeMap::new(),
            logging: LoggingConfig {
                level: "debug".to_string(),
            },
            storage: crate::config::StorageConfig {
                sqlite_max_connections: 50,
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
                app_server_args: Vec::new(),
                codex_home: None,
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
            document_preview: crate::config::DocumentPreviewConfig {
                cache_root: root.join("cache/previews"),
                libreoffice_path: "soffice".to_string(),
                max_source_bytes: 64 * 1024 * 1024,
                conversion_timeout_seconds: 120,
            },
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
        }
    }

    #[tokio::test]
    async fn migrates_legacy_session_and_job_files_idempotently() -> anyhow::Result<()> {
        let root =
            std::env::temp_dir().join(format!("ripple-migration-test-{}", uuid::Uuid::new_v4()));
        let session_dir = root.join("sandboxes/alice/sessions/srv-legacy");
        tokio::fs::create_dir_all(&session_dir).await?;
        tokio::fs::write(
            session_dir.join("meta.json"),
            serde_json::to_vec(&serde_json::json!({
                "session_id": "srv-legacy",
                "user_id": "alice",
                "title": "",
                "model": "codex-test",
                "max_turns": 200,
                "total_input_tokens": 0,
                "total_output_tokens": 0,
                "last_input_tokens": 0,
                "created_at": "2026-05-22T00:00:00Z",
                "last_active": "2026-05-22T00:00:00Z",
                "status": "idle",
                "message_count": 0,
                "messages": [],
                "pending_question": null,
                "pending_options": null,
                "pending_permission_request": null,
                "pending_connector_auth": null,
                "pending_control_request": null,
                "codex_thread_id": null,
                "plan_steps": [],
                "plan_progress": null
            }))?,
        )
        .await?;
        tokio::fs::write(
            session_dir.join("messages.jsonl"),
            "{\"role\":\"user\",\"content\":\"hello\"}\n",
        )
        .await?;
        let job_dir = root.join("sandboxes/alice/agent-runs/external-agents/agent-legacy");
        tokio::fs::create_dir_all(&job_dir).await?;
        tokio::fs::write(
            job_dir.join("meta.json"),
            serde_json::to_vec(&serde_json::json!({
                "job_id": "agent-legacy",
                "provider": "codex",
                "user_id": "alice",
                "session_id": "srv-legacy",
                "status": "completed",
                "created_at": "2026-05-22T00:00:00Z",
                "updated_at": "2026-05-22T00:00:01Z"
            }))?,
        )
        .await?;

        let config = test_config(&root);
        let first = migrate_files_to_sqlite(config.clone()).await?;
        let second = migrate_files_to_sqlite(config.clone()).await?;
        let storage = Storage::new(Arc::new(config))?;
        let session = storage
            .load_session("alice", "srv-legacy")
            .await?
            .expect("session");

        assert_eq!(first.sessions_imported, 1);
        assert_eq!(second.sessions_imported, 1);
        assert_eq!(session.messages.len(), 1);
        assert_eq!(storage.list_jobs_for_user("alice").await?.len(), 1);
        assert!(session_dir.join("meta.json").is_file());

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }
}
