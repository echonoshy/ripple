use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Row, SqlitePool};
use tokio::sync::OnceCell;

use crate::config::AppConfig;
use crate::sessions::SessionRecord;

#[derive(Clone)]
pub struct Storage {
    pool: SqlitePool,
    initialized: Arc<OnceCell<()>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunUsageStats {
    pub runs_today: u64,
    pub active_runs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileRefRecord {
    pub file_id: String,
    pub user_id: String,
    pub storage_backend: String,
    pub storage_uri: String,
    pub workspace_path: Option<String>,
    pub mime_type: Option<String>,
    pub size_bytes: Option<u64>,
    pub sha256: Option<String>,
    pub created_at: String,
    pub linked_session_id: Option<String>,
}

impl Storage {
    pub fn new(config: Arc<AppConfig>) -> anyhow::Result<Self> {
        Self::open(database_path(&config))
    }

    pub fn open(path: impl AsRef<Path>) -> anyhow::Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).with_context(|| {
                format!("failed to create database directory {}", parent.display())
            })?;
        }
        if !path.exists() {
            std::fs::File::create(path)
                .with_context(|| format!("failed to create database file {}", path.display()))?;
        }
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .foreign_keys(true)
            .busy_timeout(Duration::from_millis(5_000));
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_lazy_with(options);
        Ok(Self {
            pool,
            initialized: Arc::new(OnceCell::new()),
        })
    }

    pub async fn initialize(&self) -> anyhow::Result<()> {
        self.initialized
            .get_or_try_init(|| async {
                for statement in SCHEMA_SQL.split(';') {
                    let statement = statement.trim();
                    if statement.is_empty() {
                        continue;
                    }
                    sqlx::query(statement).execute(&self.pool).await?;
                }
                ensure_schema_columns(&self.pool).await?;
                Ok(())
            })
            .await
            .map(|_| ())
    }

    pub async fn save_session(&self, record: &SessionRecord) -> anyhow::Result<()> {
        self.initialize().await?;
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            r#"
            INSERT INTO sessions (
                user_id, session_id, title, pinned, model, max_turns, caller_system_prompt,
                total_input_tokens, total_output_tokens, last_input_tokens,
                created_at, last_active, status, message_count,
                pending_question, pending_options_json, pending_permission_request_json,
                pending_connector_auth_json, pending_schedule_request_json, codex_thread_id,
                plan_steps_json, plan_progress_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, session_id) DO UPDATE SET
                title = excluded.title,
                pinned = excluded.pinned,
                model = excluded.model,
                max_turns = excluded.max_turns,
                caller_system_prompt = excluded.caller_system_prompt,
                total_input_tokens = excluded.total_input_tokens,
                total_output_tokens = excluded.total_output_tokens,
                last_input_tokens = excluded.last_input_tokens,
                created_at = excluded.created_at,
                last_active = excluded.last_active,
                status = excluded.status,
                message_count = excluded.message_count,
                pending_question = excluded.pending_question,
                pending_options_json = excluded.pending_options_json,
                pending_permission_request_json = excluded.pending_permission_request_json,
                pending_connector_auth_json = excluded.pending_connector_auth_json,
                pending_schedule_request_json = excluded.pending_schedule_request_json,
                codex_thread_id = excluded.codex_thread_id,
                plan_steps_json = excluded.plan_steps_json,
                plan_progress_json = excluded.plan_progress_json
            "#,
        )
        .bind(&record.user_id)
        .bind(&record.session_id)
        .bind(&record.title)
        .bind(i64::from(record.pinned))
        .bind(&record.model)
        .bind(i64::from(record.max_turns))
        .bind(&record.caller_system_prompt)
        .bind(u64_to_i64(record.total_input_tokens)?)
        .bind(u64_to_i64(record.total_output_tokens)?)
        .bind(u64_to_i64(record.last_input_tokens)?)
        .bind(&record.created_at)
        .bind(&record.last_active)
        .bind(&record.status)
        .bind(usize_to_i64(record.message_count)?)
        .bind(&record.pending_question)
        .bind(json_option_text(record.pending_options.as_ref())?)
        .bind(json_option_text(
            record.pending_permission_request.as_ref(),
        )?)
        .bind(json_option_text(record.pending_connector_auth.as_ref())?)
        .bind(json_option_text(record.pending_schedule_request.as_ref())?)
        .bind(&record.codex_thread_id)
        .bind(json_serialize_text(&record.plan_steps)?)
        .bind(json_option_text(record.plan_progress.as_ref())?)
        .execute(&mut *tx)
        .await?;

        sqlx::query("DELETE FROM session_messages WHERE user_id = ? AND session_id = ?")
            .bind(&record.user_id)
            .bind(&record.session_id)
            .execute(&mut *tx)
            .await?;
        for (seq, message) in record.messages.iter().enumerate() {
            sqlx::query(
                r#"
                INSERT INTO session_messages (user_id, session_id, seq, message_json)
                VALUES (?, ?, ?, ?)
                "#,
            )
            .bind(&record.user_id)
            .bind(&record.session_id)
            .bind(usize_to_i64(seq)?)
            .bind(json_text(message)?)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn load_session(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> anyhow::Result<Option<SessionRecord>> {
        self.initialize().await?;
        let Some(row) = sqlx::query(
            r#"
            SELECT user_id, session_id, title, model, max_turns, caller_system_prompt,
                   pinned,
                   total_input_tokens, total_output_tokens, last_input_tokens,
                   created_at, last_active, status, message_count,
                   pending_question, pending_options_json, pending_permission_request_json,
                   pending_connector_auth_json, pending_schedule_request_json, codex_thread_id,
                   plan_steps_json, plan_progress_json
            FROM sessions
            WHERE user_id = ? AND session_id = ?
            "#,
        )
        .bind(user_id)
        .bind(session_id)
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(None);
        };
        Ok(Some(self.session_from_row(row).await?))
    }

    pub async fn list_sessions(&self, user_id: &str) -> anyhow::Result<Vec<SessionRecord>> {
        self.initialize().await?;
        let rows = sqlx::query(
            r#"
            SELECT user_id, session_id, title, model, max_turns, caller_system_prompt,
                   pinned,
                   total_input_tokens, total_output_tokens, last_input_tokens,
                   created_at, last_active, status, message_count,
                   pending_question, pending_options_json, pending_permission_request_json,
                   pending_connector_auth_json, pending_schedule_request_json, codex_thread_id,
                   plan_steps_json, plan_progress_json
            FROM sessions
            WHERE user_id = ?
            ORDER BY last_active DESC
            "#,
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;
        let mut records = Vec::with_capacity(rows.len());
        for row in rows {
            records.push(self.session_from_row(row).await?);
        }
        Ok(records)
    }

    pub async fn list_session_ids(&self, user_id: &str) -> anyhow::Result<Vec<String>> {
        self.initialize().await?;
        let rows = sqlx::query(
            "SELECT session_id FROM sessions WHERE user_id = ? ORDER BY last_active DESC",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| row.get::<String, _>("session_id"))
            .collect())
    }

    pub async fn count_sessions(&self, user_id: &str) -> anyhow::Result<u64> {
        self.initialize().await?;
        let row = sqlx::query("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?")
            .bind(user_id)
            .fetch_one(&self.pool)
            .await?;
        i64_to_u64(row.get::<i64, _>("count"))
    }

    pub async fn total_tokens_used(&self, user_id: &str) -> anyhow::Result<u64> {
        self.initialize().await?;
        let row = sqlx::query("SELECT SUM(total_input_tokens + total_output_tokens) AS total FROM sessions WHERE user_id = ?")
            .bind(user_id)
            .fetch_one(&self.pool)
            .await?;
        let total = row.get::<Option<i64>, _>("total").unwrap_or(0);
        i64_to_u64(total)
    }

    pub async fn token_usage_by_period(&self, user_id: &str) -> anyhow::Result<(u64, u64)> {
        self.initialize().await?;
        let row_daily = sqlx::query("SELECT SUM(total_input_tokens + total_output_tokens) AS daily FROM sessions WHERE user_id = ? AND last_active >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day')")
            .bind(user_id)
            .fetch_one(&self.pool)
            .await?;
        let daily = row_daily.get::<Option<i64>, _>("daily").unwrap_or(0);

        let row_weekly = sqlx::query("SELECT SUM(total_input_tokens + total_output_tokens) AS weekly FROM sessions WHERE user_id = ? AND last_active >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days')")
            .bind(user_id)
            .fetch_one(&self.pool)
            .await?;
        let weekly = row_weekly.get::<Option<i64>, _>("weekly").unwrap_or(0);

        Ok((i64_to_u64(daily)?, i64_to_u64(weekly)?))
    }

    pub async fn session_exists(&self, user_id: &str, session_id: &str) -> anyhow::Result<bool> {
        self.initialize().await?;
        let row = sqlx::query(
            "SELECT 1 AS found FROM sessions WHERE user_id = ? AND session_id = ? LIMIT 1",
        )
        .bind(user_id)
        .bind(session_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.is_some())
    }

    pub async fn delete_session(&self, user_id: &str, session_id: &str) -> anyhow::Result<bool> {
        self.initialize().await?;
        let result = sqlx::query("DELETE FROM sessions WHERE user_id = ? AND session_id = ?")
            .bind(user_id)
            .bind(session_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn delete_user_data(&self, user_id: &str) -> anyhow::Result<()> {
        self.initialize().await?;
        let mut tx = self.pool.begin().await?;
        for table in [
            "session_messages",
            "sessions",
            "jobs",
            "schedules",
            "documents",
            "file_refs",
        ] {
            sqlx::query(&format!("DELETE FROM {table} WHERE user_id = ?"))
                .bind(user_id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn upsert_job(&self, record: &Value) -> anyhow::Result<()> {
        self.initialize().await?;
        let Some(job_id) = record.get("job_id").and_then(Value::as_str) else {
            anyhow::bail!("job record missing job_id");
        };
        let user_id = record.get("user_id").and_then(Value::as_str).unwrap_or("");
        let session_id = record.get("session_id").and_then(Value::as_str);
        let provider = record_str(record, "provider");
        let status = record_str(record, "status");
        let created_at = record_str(record, "created_at");
        let updated_at = record_str(record, "updated_at");
        let schedule_id = record.get("schedule_id").and_then(Value::as_str);
        let events_file = record.get("events_file").and_then(Value::as_str);
        let output_file = record.get("output_file").and_then(Value::as_str);
        sqlx::query(
            r#"
            INSERT INTO jobs (
                job_id, user_id, session_id, provider, status, created_at, updated_at,
                schedule_id, events_file, output_file, record_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(job_id) DO UPDATE SET
                user_id = excluded.user_id,
                session_id = excluded.session_id,
                provider = excluded.provider,
                status = excluded.status,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                schedule_id = excluded.schedule_id,
                events_file = excluded.events_file,
                output_file = excluded.output_file,
                record_json = excluded.record_json
            "#,
        )
        .bind(job_id)
        .bind(user_id)
        .bind(session_id)
        .bind(provider)
        .bind(status)
        .bind(created_at)
        .bind(updated_at)
        .bind(schedule_id)
        .bind(events_file)
        .bind(output_file)
        .bind(json_text(record)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_jobs_for_user(&self, user_id: &str) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        let rows =
            sqlx::query("SELECT record_json FROM jobs WHERE user_id = ? ORDER BY updated_at DESC")
                .bind(user_id)
                .fetch_all(&self.pool)
                .await?;
        rows.into_iter()
            .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
            .collect()
    }

    pub async fn get_job_for_user(
        &self,
        user_id: &str,
        job_id: &str,
    ) -> anyhow::Result<Option<Value>> {
        self.initialize().await?;
        let row = sqlx::query("SELECT record_json FROM jobs WHERE user_id = ? AND job_id = ?")
            .bind(user_id)
            .bind(job_id)
            .fetch_optional(&self.pool)
            .await?;
        row.map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
            .transpose()
    }

    pub async fn list_jobs_for_schedule(
        &self,
        user_id: &str,
        schedule_id: &str,
    ) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        let rows = sqlx::query(
            r#"
            SELECT record_json FROM jobs
            WHERE user_id = ? AND schedule_id = ?
            ORDER BY updated_at DESC
            "#,
        )
        .bind(user_id)
        .bind(schedule_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
            .collect()
    }

    pub async fn job_usage_stats(
        &self,
        user_id: &str,
        today_prefix: &str,
    ) -> anyhow::Result<RunUsageStats> {
        self.initialize().await?;
        let runs_row = sqlx::query(
            "SELECT COUNT(*) AS count FROM jobs WHERE user_id = ? AND created_at LIKE ?",
        )
        .bind(user_id)
        .bind(format!("{today_prefix}%"))
        .fetch_one(&self.pool)
        .await?;
        let active_row = sqlx::query(
            "SELECT COUNT(*) AS count FROM jobs WHERE user_id = ? AND status IN ('queued', 'running')",
        )
        .bind(user_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(RunUsageStats {
            runs_today: i64_to_u64(runs_row.get::<i64, _>("count"))?,
            active_runs: i64_to_u64(active_row.get::<i64, _>("count"))?,
        })
    }

    pub async fn replace_schedules(&self, user_id: &str, records: &[Value]) -> anyhow::Result<()> {
        self.initialize().await?;
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM schedules WHERE user_id = ?")
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        for record in records {
            insert_schedule_record(&mut tx, user_id, record).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn upsert_schedule(&self, user_id: &str, record: &Value) -> anyhow::Result<()> {
        self.initialize().await?;
        let Some(schedule_id) = record.get("schedule_id").and_then(Value::as_str) else {
            anyhow::bail!("schedule record missing schedule_id");
        };
        sqlx::query(
            r#"
            INSERT INTO schedules (user_id, schedule_id, status, next_run_at, updated_at, record_json)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, schedule_id) DO UPDATE SET
                status = excluded.status,
                next_run_at = excluded.next_run_at,
                updated_at = excluded.updated_at,
                record_json = excluded.record_json
            "#,
        )
        .bind(user_id)
        .bind(schedule_id)
        .bind(record_str(record, "status"))
        .bind(record.get("next_run_at").and_then(Value::as_str))
        .bind(record_str(record, "updated_at"))
        .bind(json_text(record)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete_schedule(&self, user_id: &str, schedule_id: &str) -> anyhow::Result<bool> {
        self.initialize().await?;
        let result = sqlx::query("DELETE FROM schedules WHERE user_id = ? AND schedule_id = ?")
            .bind(user_id)
            .bind(schedule_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn list_schedules(&self, user_id: &str) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        let rows = sqlx::query(
            "SELECT record_json FROM schedules WHERE user_id = ? ORDER BY next_run_at ASC, updated_at DESC",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
            .collect()
    }

    pub async fn list_schedule_user_ids(&self) -> anyhow::Result<Vec<String>> {
        self.initialize().await?;
        let rows = sqlx::query("SELECT DISTINCT user_id FROM schedules ORDER BY user_id ASC")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .into_iter()
            .map(|row| row.get::<String, _>("user_id"))
            .collect())
    }

    pub async fn replace_documents(&self, user_id: &str, records: &[Value]) -> anyhow::Result<()> {
        self.initialize().await?;
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM documents WHERE user_id = ?")
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        for record in records {
            insert_document_record(&mut tx, user_id, record).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn list_documents(&self, user_id: &str) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        let rows = sqlx::query(
            "SELECT record_json FROM documents WHERE user_id = ? ORDER BY updated_at DESC",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
            .collect()
    }

    pub async fn upsert_file_ref(&self, record: &FileRefRecord) -> anyhow::Result<()> {
        self.initialize().await?;
        sqlx::query(
            r#"
            INSERT INTO file_refs (
                file_id, user_id, storage_backend, storage_uri, workspace_path,
                mime_type, size_bytes, sha256, created_at, linked_session_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(file_id) DO UPDATE SET
                user_id = excluded.user_id,
                storage_backend = excluded.storage_backend,
                storage_uri = excluded.storage_uri,
                workspace_path = excluded.workspace_path,
                mime_type = excluded.mime_type,
                size_bytes = excluded.size_bytes,
                sha256 = excluded.sha256,
                created_at = excluded.created_at,
                linked_session_id = excluded.linked_session_id
            "#,
        )
        .bind(&record.file_id)
        .bind(&record.user_id)
        .bind(&record.storage_backend)
        .bind(&record.storage_uri)
        .bind(&record.workspace_path)
        .bind(&record.mime_type)
        .bind(record.size_bytes.map(u64_to_i64).transpose()?)
        .bind(&record.sha256)
        .bind(&record.created_at)
        .bind(&record.linked_session_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_file_refs(&self, user_id: &str) -> anyhow::Result<Vec<FileRefRecord>> {
        self.initialize().await?;
        let rows = sqlx::query(
            r#"
            SELECT file_id, user_id, storage_backend, storage_uri, workspace_path,
                   mime_type, size_bytes, sha256, created_at, linked_session_id
            FROM file_refs
            WHERE user_id = ?
            ORDER BY created_at DESC
            "#,
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(FileRefRecord {
                    file_id: row.get("file_id"),
                    user_id: row.get("user_id"),
                    storage_backend: row.get("storage_backend"),
                    storage_uri: row.get("storage_uri"),
                    workspace_path: row.get("workspace_path"),
                    mime_type: row.get("mime_type"),
                    size_bytes: row
                        .get::<Option<i64>, _>("size_bytes")
                        .map(i64_to_u64)
                        .transpose()?,
                    sha256: row.get("sha256"),
                    created_at: row.get("created_at"),
                    linked_session_id: row.get("linked_session_id"),
                })
            })
            .collect()
    }

    async fn session_from_row(
        &self,
        row: sqlx::sqlite::SqliteRow,
    ) -> anyhow::Result<SessionRecord> {
        let user_id = row.get::<String, _>("user_id");
        let session_id = row.get::<String, _>("session_id");
        let message_rows = sqlx::query(
            r#"
            SELECT message_json FROM session_messages
            WHERE user_id = ? AND session_id = ?
            ORDER BY seq ASC
            "#,
        )
        .bind(&user_id)
        .bind(&session_id)
        .fetch_all(&self.pool)
        .await?;
        let mut messages = Vec::with_capacity(message_rows.len());
        for message_row in message_rows {
            messages.push(json_from_text(
                message_row.get::<String, _>("message_json").as_str(),
            )?);
        }
        Ok(SessionRecord {
            session_id,
            user_id,
            title: row.get("title"),
            pinned: row.get::<i64, _>("pinned") != 0,
            model: row.get("model"),
            max_turns: i64_to_u32(row.get::<i64, _>("max_turns"))?,
            caller_system_prompt: row.get("caller_system_prompt"),
            total_input_tokens: i64_to_u64(row.get::<i64, _>("total_input_tokens"))?,
            total_output_tokens: i64_to_u64(row.get::<i64, _>("total_output_tokens"))?,
            last_input_tokens: i64_to_u64(row.get::<i64, _>("last_input_tokens"))?,
            created_at: row.get("created_at"),
            last_active: row.get("last_active"),
            status: row.get("status"),
            message_count: messages.len(),
            messages,
            pending_question: row.get("pending_question"),
            pending_options: json_option_from_text(
                row.get::<Option<String>, _>("pending_options_json"),
            )?,
            pending_permission_request: json_option_from_text(
                row.get::<Option<String>, _>("pending_permission_request_json"),
            )?,
            pending_connector_auth: json_option_from_text(
                row.get::<Option<String>, _>("pending_connector_auth_json"),
            )?,
            pending_schedule_request: json_option_from_text(
                row.get::<Option<String>, _>("pending_schedule_request_json"),
            )?,
            codex_thread_id: row.get("codex_thread_id"),
            plan_steps: serde_json::from_str(row.get::<String, _>("plan_steps_json").as_str())?,
            plan_progress: json_option_from_text(
                row.get::<Option<String>, _>("plan_progress_json"),
            )?,
        })
    }
}

pub fn database_path(config: &AppConfig) -> PathBuf {
    config.repo_root.join(".ripple/ripple.sqlite")
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push(hex_digit(byte >> 4));
        out.push(hex_digit(byte & 0x0f));
    }
    out
}

fn hex_digit(value: u8) -> char {
    match value {
        0..=9 => (b'0' + value) as char,
        _ => (b'a' + (value - 10)) as char,
    }
}

async fn insert_schedule_record(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    user_id: &str,
    record: &Value,
) -> anyhow::Result<()> {
    let Some(schedule_id) = record.get("schedule_id").and_then(Value::as_str) else {
        anyhow::bail!("schedule record missing schedule_id");
    };
    sqlx::query(
        r#"
        INSERT INTO schedules (user_id, schedule_id, status, next_run_at, updated_at, record_json)
        VALUES (?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(user_id)
    .bind(schedule_id)
    .bind(record_str(record, "status"))
    .bind(record.get("next_run_at").and_then(Value::as_str))
    .bind(record_str(record, "updated_at"))
    .bind(json_text(record)?)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn insert_document_record(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    user_id: &str,
    record: &Value,
) -> anyhow::Result<()> {
    let Some(document_id) = record.get("document_id").and_then(Value::as_str) else {
        anyhow::bail!("document record missing document_id");
    };
    sqlx::query(
        r#"
        INSERT INTO documents (user_id, document_id, updated_at, record_json)
        VALUES (?, ?, ?, ?)
        "#,
    )
    .bind(user_id)
    .bind(document_id)
    .bind(record_str(record, "updated_at"))
    .bind(json_text(record)?)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn json_text(value: &Value) -> anyhow::Result<String> {
    serde_json::to_string(value).map_err(anyhow::Error::from)
}

fn json_serialize_text<T: serde::Serialize>(value: &T) -> anyhow::Result<String> {
    serde_json::to_string(value).map_err(anyhow::Error::from)
}

fn json_option_text<T: serde::Serialize>(value: Option<&T>) -> anyhow::Result<Option<String>> {
    value
        .map(serde_json::to_string)
        .transpose()
        .map_err(anyhow::Error::from)
}

fn json_from_text(text: &str) -> anyhow::Result<Value> {
    serde_json::from_str(text).map_err(anyhow::Error::from)
}

fn json_option_from_text<T: serde::de::DeserializeOwned>(
    text: Option<String>,
) -> anyhow::Result<Option<T>> {
    text.map(|text| serde_json::from_str(&text))
        .transpose()
        .map_err(anyhow::Error::from)
}

fn record_str(record: &Value, key: &str) -> String {
    record
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn u64_to_i64(value: u64) -> anyhow::Result<i64> {
    i64::try_from(value).context("u64 value exceeds SQLite signed integer range")
}

fn usize_to_i64(value: usize) -> anyhow::Result<i64> {
    i64::try_from(value).context("usize value exceeds SQLite signed integer range")
}

fn i64_to_u64(value: i64) -> anyhow::Result<u64> {
    u64::try_from(value).context("SQLite integer is negative")
}

fn i64_to_u32(value: i64) -> anyhow::Result<u32> {
    u32::try_from(value).context("SQLite integer exceeds u32 range")
}

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS sessions (
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    title TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL,
    max_turns INTEGER NOT NULL,
    caller_system_prompt TEXT,
    total_input_tokens INTEGER NOT NULL DEFAULT 0,
    total_output_tokens INTEGER NOT NULL DEFAULT 0,
    last_input_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_active TEXT NOT NULL,
    status TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    pending_question TEXT,
    pending_options_json TEXT,
    pending_permission_request_json TEXT,
    pending_connector_auth_json TEXT,
    pending_schedule_request_json TEXT,
    codex_thread_id TEXT,
    plan_steps_json TEXT NOT NULL DEFAULT '[]',
    plan_progress_json TEXT,
    PRIMARY KEY (user_id, session_id)
);

CREATE TABLE IF NOT EXISTS session_messages (
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    message_json TEXT NOT NULL,
    PRIMARY KEY (user_id, session_id, seq),
    FOREIGN KEY (user_id, session_id)
        REFERENCES sessions(user_id, session_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    session_id TEXT,
    provider TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    schedule_id TEXT,
    events_file TEXT,
    output_file TEXT,
    record_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schedules (
    user_id TEXT NOT NULL,
    schedule_id TEXT NOT NULL,
    status TEXT NOT NULL,
    next_run_at TEXT,
    updated_at TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (user_id, schedule_id)
);

CREATE TABLE IF NOT EXISTS documents (
    user_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (user_id, document_id)
);

CREATE TABLE IF NOT EXISTS file_refs (
    file_id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    storage_backend TEXT NOT NULL,
    storage_uri TEXT NOT NULL,
    workspace_path TEXT,
    mime_type TEXT,
    size_bytes INTEGER,
    sha256 TEXT,
    created_at TEXT NOT NULL,
    linked_session_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_last_active
    ON sessions(user_id, last_active);
CREATE INDEX IF NOT EXISTS idx_sessions_user_status
    ON sessions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_session_messages_user_session_seq
    ON session_messages(user_id, session_id, seq);
CREATE INDEX IF NOT EXISTS idx_jobs_user_updated
    ON jobs(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_jobs_user_session
    ON jobs(user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_jobs_user_status
    ON jobs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_user_schedule
    ON jobs(user_id, schedule_id);
CREATE INDEX IF NOT EXISTS idx_schedules_user_status_next
    ON schedules(user_id, status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_documents_user_updated
    ON documents(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_file_refs_user_workspace_path
    ON file_refs(user_id, workspace_path);
"#;

async fn ensure_schema_columns(pool: &SqlitePool) -> anyhow::Result<()> {
    let rows = sqlx::query("PRAGMA table_info(sessions)")
        .fetch_all(pool)
        .await?;
    let has_pinned = rows
        .iter()
        .any(|row| row.get::<String, _>("name") == "pinned");
    if !has_pinned {
        sqlx::query("ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")
            .execute(pool)
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::SessionRecord;

    #[tokio::test]
    async fn stores_session_messages_in_sqlite() -> anyhow::Result<()> {
        let root =
            std::env::temp_dir().join(format!("ripple-storage-test-{}", uuid::Uuid::new_v4()));
        let storage = Storage::open(root.join(".ripple/ripple.sqlite"))?;
        let record = SessionRecord {
            session_id: "srv-test".to_string(),
            user_id: "alice".to_string(),
            title: "hello".to_string(),
            pinned: true,
            model: "codex-test".to_string(),
            max_turns: 200,
            caller_system_prompt: None,
            total_input_tokens: 1,
            total_output_tokens: 2,
            last_input_tokens: 1,
            created_at: "2026-05-22T00:00:00Z".to_string(),
            last_active: "2026-05-22T00:00:01Z".to_string(),
            status: "idle".to_string(),
            message_count: 1,
            messages: vec![serde_json::json!({"role": "user", "content": "hello"})],
            pending_question: None,
            pending_options: None,
            pending_permission_request: None,
            pending_connector_auth: None,
            pending_schedule_request: None,
            codex_thread_id: None,
            plan_steps: Vec::new(),
            plan_progress: None,
        };

        storage.save_session(&record).await?;
        let loaded = storage
            .load_session("alice", "srv-test")
            .await?
            .expect("session");

        assert_eq!(loaded.messages, record.messages);
        assert!(loaded.pinned);
        assert_eq!(loaded.total_output_tokens, 2);

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn job_usage_stats_use_sqlite_metadata() -> anyhow::Result<()> {
        let root =
            std::env::temp_dir().join(format!("ripple-storage-test-{}", uuid::Uuid::new_v4()));
        let storage = Storage::open(root.join(".ripple/ripple.sqlite"))?;
        storage
            .upsert_job(&serde_json::json!({
                "job_id": "agent-test",
                "provider": "codex",
                "user_id": "alice",
                "session_id": null,
                "status": "running",
                "created_at": "2026-05-22T00:00:00Z",
                "updated_at": "2026-05-22T00:00:00Z"
            }))
            .await?;

        assert_eq!(
            storage.job_usage_stats("alice", "2026-05-22").await?,
            RunUsageStats {
                runs_today: 1,
                active_runs: 1,
            }
        );

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn upsert_schedule_preserves_other_schedule_records() -> anyhow::Result<()> {
        let root =
            std::env::temp_dir().join(format!("ripple-storage-test-{}", uuid::Uuid::new_v4()));
        let storage = Storage::open(root.join(".ripple/ripple.sqlite"))?;

        storage
            .upsert_schedule(
                "alice",
                &serde_json::json!({
                    "schedule_id": "sch-one",
                    "status": "active",
                    "next_run_at": "2026-05-28T00:00:00Z",
                    "updated_at": "2026-05-28T00:00:00Z"
                }),
            )
            .await?;
        storage
            .upsert_schedule(
                "alice",
                &serde_json::json!({
                    "schedule_id": "sch-two",
                    "status": "active",
                    "next_run_at": "2026-05-28T01:00:00Z",
                    "updated_at": "2026-05-28T00:00:00Z"
                }),
            )
            .await?;
        storage
            .upsert_schedule(
                "alice",
                &serde_json::json!({
                    "schedule_id": "sch-one",
                    "status": "paused",
                    "next_run_at": null,
                    "updated_at": "2026-05-28T00:01:00Z"
                }),
            )
            .await?;

        let schedules = storage.list_schedules("alice").await?;

        assert_eq!(schedules.len(), 2);
        assert!(schedules.iter().any(|record| {
            record.get("schedule_id").and_then(Value::as_str) == Some("sch-one")
                && record.get("status").and_then(Value::as_str) == Some("paused")
        }));
        assert!(schedules.iter().any(|record| {
            record.get("schedule_id").and_then(Value::as_str) == Some("sch-two")
                && record.get("status").and_then(Value::as_str) == Some("active")
        }));

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn file_refs_store_file_metadata_without_content() -> anyhow::Result<()> {
        let root =
            std::env::temp_dir().join(format!("ripple-storage-test-{}", uuid::Uuid::new_v4()));
        let storage = Storage::open(root.join(".ripple/ripple.sqlite"))?;
        storage
            .upsert_file_ref(&FileRefRecord {
                file_id: "file-test".to_string(),
                user_id: "alice".to_string(),
                storage_backend: "local".to_string(),
                storage_uri: "/workspace/uploads/a.pdf".to_string(),
                workspace_path: Some("/workspace/uploads/a.pdf".to_string()),
                mime_type: Some("application/pdf".to_string()),
                size_bytes: Some(12),
                sha256: Some("abc".to_string()),
                created_at: "2026-05-22T00:00:00Z".to_string(),
                linked_session_id: Some("srv-test".to_string()),
            })
            .await?;

        let refs = storage.list_file_refs("alice").await?;
        assert_eq!(refs.len(), 1);
        assert_eq!(
            refs[0].workspace_path.as_deref(),
            Some("/workspace/uploads/a.pdf")
        );

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }
}
