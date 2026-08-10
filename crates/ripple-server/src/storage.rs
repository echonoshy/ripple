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

use crate::config::{AppConfig, DEFAULT_SQLITE_MAX_CONNECTIONS};
use crate::sessions::SessionRecord;

mod auth;
mod jobs;
mod prepared_mail;
mod schema;
mod task_triggers;
mod tasks;

pub use auth::{
    AuthInviteClaim, AuthInviteCreate, AuthInviteCreated, AuthSessionCreate, AuthSessionRecord,
    AuthUserRecord,
};
pub use jobs::RunUsageStats;
pub use schema::CURRENT_SCHEMA_VERSION;

#[derive(Clone)]
pub struct Storage {
    pool: SqlitePool,
    initialized: Arc<OnceCell<()>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TokenUsageBreakdown {
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
}

impl TokenUsageBreakdown {
    pub fn total_tokens(&self) -> u64 {
        self.total_input_tokens
            .saturating_add(self.total_output_tokens)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TokenUsageEventRecord {
    pub event_id: String,
    pub user_id: String,
    pub session_id: Option<String>,
    pub job_id: Option<String>,
    pub task_trigger_id: Option<String>,
    pub turn_id: Option<String>,
    pub source: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub cached_input_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub model_context_window: Option<u64>,
    pub occurred_at: String,
    pub record_json: Value,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UserProfileRecord {
    pub user_id: String,
    pub avatar_uri: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Storage {
    pub fn new(config: Arc<AppConfig>) -> anyhow::Result<Self> {
        Self::open_with_max_connections(
            database_path(&config),
            config.storage.sqlite_max_connections,
        )
    }

    pub fn open(path: impl AsRef<Path>) -> anyhow::Result<Self> {
        Self::open_with_max_connections(path, DEFAULT_SQLITE_MAX_CONNECTIONS)
    }

    fn open_with_max_connections(
        path: impl AsRef<Path>,
        max_connections: u32,
    ) -> anyhow::Result<Self> {
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
            // Session creation and run-state persistence share this pool. Keep
            // enough short-lived connections available for concurrent requests.
            .max_connections(max_connections)
            .connect_lazy_with(options);
        Ok(Self {
            pool,
            initialized: Arc::new(OnceCell::new()),
        })
    }

    pub async fn initialize(&self) -> anyhow::Result<()> {
        self.initialized
            .get_or_try_init(|| async {
                schema::initialize_schema(&self.pool).await?;
                self.backfill_legacy_token_usage_events().await?;
                Ok(())
            })
            .await
            .map(|_| ())
    }

    pub async fn schema_version(&self) -> anyhow::Result<i64> {
        self.initialize().await?;
        let row = sqlx::query("SELECT MAX(version) AS version FROM schema_migrations")
            .fetch_one(&self.pool)
            .await?;
        Ok(row
            .get::<Option<i64>, _>("version")
            .unwrap_or(CURRENT_SCHEMA_VERSION))
    }

    async fn backfill_legacy_token_usage_events(&self) -> anyhow::Result<()> {
        sqlx::query(
            r#"
            INSERT OR IGNORE INTO token_usage_events (
                event_id, user_id, session_id, job_id, task_trigger_id, turn_id, source,
                input_tokens, output_tokens, total_tokens, cached_input_tokens,
                reasoning_output_tokens, model_context_window, occurred_at, created_at, record_json
            )
            SELECT
                'legacy-session:' || user_id || ':' || session_id,
                user_id,
                session_id,
                NULL,
                NULL,
                NULL,
                'legacy_session',
                total_input_tokens,
                total_output_tokens,
                total_input_tokens + total_output_tokens,
                0,
                0,
                NULL,
                last_active,
                strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                '{}'
            FROM sessions AS s
            WHERE (total_input_tokens > 0 OR total_output_tokens > 0)
              AND NOT EXISTS (
                SELECT 1 FROM token_usage_events AS e
                WHERE e.user_id = s.user_id
                  AND e.session_id = s.session_id
              )
            "#,
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn save_session(&self, record: &SessionRecord) -> anyhow::Result<()> {
        self.initialize().await?;
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            r#"
            INSERT INTO sessions (
                user_id, session_id, title, pinned, model, max_turns, caller_system_prompt,
                context_folder_path, session_kind, shared_folder_id,
                total_input_tokens, total_output_tokens, last_input_tokens,
                created_at, last_active, status, message_count,
                pending_question, pending_options_json, pending_permission_request_json,
                pending_connector_auth_json, pending_control_request_json, codex_thread_id,
                codex_synced_message_count,
                memory_disabled, plan_steps_json, plan_progress_json, task_callback_url
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, session_id) DO UPDATE SET
                title = excluded.title,
                pinned = excluded.pinned,
                model = excluded.model,
                max_turns = excluded.max_turns,
                caller_system_prompt = excluded.caller_system_prompt,
                context_folder_path = excluded.context_folder_path,
                session_kind = excluded.session_kind,
                shared_folder_id = excluded.shared_folder_id,
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
                pending_control_request_json = excluded.pending_control_request_json,
                codex_thread_id = excluded.codex_thread_id,
                codex_synced_message_count = excluded.codex_synced_message_count,
                memory_disabled = excluded.memory_disabled,
                plan_steps_json = excluded.plan_steps_json,
                plan_progress_json = excluded.plan_progress_json,
                task_callback_url = excluded.task_callback_url
            "#,
        )
        .bind(&record.user_id)
        .bind(&record.session_id)
        .bind(&record.title)
        .bind(i64::from(record.pinned))
        .bind(&record.model)
        .bind(i64::from(record.max_turns))
        .bind(&record.caller_system_prompt)
        .bind(&record.context_folder_path)
        .bind(&record.session_kind)
        .bind(&record.shared_folder_id)
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
        .bind(json_option_text(record.pending_control_request.as_ref())?)
        .bind(&record.codex_thread_id)
        .bind(usize_to_i64(
            record.codex_synced_message_count.min(record.messages.len()),
        )?)
        .bind(if record.memory_disabled { 1_i64 } else { 0_i64 })
        .bind(json_serialize_text(&record.plan_steps)?)
        .bind(json_option_text(record.plan_progress.as_ref())?)
        .bind(&record.task_callback_url)
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
                   context_folder_path, session_kind, shared_folder_id,
                   total_input_tokens, total_output_tokens, last_input_tokens,
                   created_at, last_active, status, message_count,
                   pending_question, pending_options_json, pending_permission_request_json,
                   pending_connector_auth_json, pending_control_request_json, codex_thread_id,
                   codex_synced_message_count,
                   memory_disabled, plan_steps_json, plan_progress_json, task_callback_url
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
                   context_folder_path, session_kind, shared_folder_id,
                   total_input_tokens, total_output_tokens, last_input_tokens,
                   created_at, last_active, status, message_count,
                   pending_question, pending_options_json, pending_permission_request_json,
                   pending_connector_auth_json, pending_control_request_json, codex_thread_id,
                   codex_synced_message_count,
                   memory_disabled, plan_steps_json, plan_progress_json, task_callback_url
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
        let breakdown = self.token_usage_breakdown(user_id).await?;
        Ok(breakdown.total_tokens())
    }

    pub async fn token_usage_breakdown(
        &self,
        user_id: &str,
    ) -> anyhow::Result<TokenUsageBreakdown> {
        self.initialize().await?;
        let row = sqlx::query(
            r#"
            WITH usage_rows AS (
              SELECT input_tokens AS input, output_tokens AS output
              FROM token_usage_events
              WHERE user_id = ?
              UNION ALL
              SELECT total_input_tokens AS input, total_output_tokens AS output
              FROM sessions AS s
              WHERE s.user_id = ?
                AND (s.total_input_tokens > 0 OR s.total_output_tokens > 0)
                AND NOT EXISTS (
                  SELECT 1 FROM token_usage_events AS e
                  WHERE e.user_id = s.user_id
                    AND e.session_id = s.session_id
                )
            )
            SELECT
              SUM(input) AS input,
              SUM(output) AS output
            FROM usage_rows
            "#,
        )
        .bind(user_id)
        .bind(user_id)
        .fetch_one(&self.pool)
        .await?;
        let input = row.get::<Option<i64>, _>("input").unwrap_or(0);
        let output = row.get::<Option<i64>, _>("output").unwrap_or(0);
        Ok(TokenUsageBreakdown {
            total_input_tokens: i64_to_u64(input)?,
            total_output_tokens: i64_to_u64(output)?,
        })
    }

    pub async fn token_usage_by_period(
        &self,
        user_id: &str,
    ) -> anyhow::Result<(TokenUsageBreakdown, TokenUsageBreakdown)> {
        self.initialize().await?;
        let row_daily = sqlx::query(
            r#"
            WITH usage_rows AS (
              SELECT input_tokens AS input, output_tokens AS output
              FROM token_usage_events
              WHERE user_id = ?
                AND occurred_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day')
              UNION ALL
              SELECT total_input_tokens AS input, total_output_tokens AS output
              FROM sessions AS s
              WHERE s.user_id = ?
                AND s.last_active >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day')
                AND (s.total_input_tokens > 0 OR s.total_output_tokens > 0)
                AND NOT EXISTS (
                  SELECT 1 FROM token_usage_events AS e
                  WHERE e.user_id = s.user_id
                    AND e.session_id = s.session_id
                )
            )
            SELECT
              SUM(input) AS input,
              SUM(output) AS output
            FROM usage_rows
            "#,
        )
        .bind(user_id)
        .bind(user_id)
        .fetch_one(&self.pool)
        .await?;
        let daily_input = row_daily.get::<Option<i64>, _>("input").unwrap_or(0);
        let daily_output = row_daily.get::<Option<i64>, _>("output").unwrap_or(0);

        let row_weekly = sqlx::query(
            r#"
            WITH usage_rows AS (
              SELECT input_tokens AS input, output_tokens AS output
              FROM token_usage_events
              WHERE user_id = ?
                AND occurred_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days')
              UNION ALL
              SELECT total_input_tokens AS input, total_output_tokens AS output
              FROM sessions AS s
              WHERE s.user_id = ?
                AND s.last_active >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days')
                AND (s.total_input_tokens > 0 OR s.total_output_tokens > 0)
                AND NOT EXISTS (
                  SELECT 1 FROM token_usage_events AS e
                  WHERE e.user_id = s.user_id
                    AND e.session_id = s.session_id
                )
            )
            SELECT
              SUM(input) AS input,
              SUM(output) AS output
            FROM usage_rows
            "#,
        )
        .bind(user_id)
        .bind(user_id)
        .fetch_one(&self.pool)
        .await?;
        let weekly_input = row_weekly.get::<Option<i64>, _>("input").unwrap_or(0);
        let weekly_output = row_weekly.get::<Option<i64>, _>("output").unwrap_or(0);

        Ok((
            TokenUsageBreakdown {
                total_input_tokens: i64_to_u64(daily_input)?,
                total_output_tokens: i64_to_u64(daily_output)?,
            },
            TokenUsageBreakdown {
                total_input_tokens: i64_to_u64(weekly_input)?,
                total_output_tokens: i64_to_u64(weekly_output)?,
            },
        ))
    }

    pub async fn upsert_token_usage_event(
        &self,
        event: &TokenUsageEventRecord,
    ) -> anyhow::Result<()> {
        self.initialize().await?;
        sqlx::query(
            r#"
            INSERT INTO token_usage_events (
                event_id, user_id, session_id, job_id, task_trigger_id, turn_id, source,
                input_tokens, output_tokens, total_tokens, cached_input_tokens,
                reasoning_output_tokens, model_context_window, occurred_at, created_at, record_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?)
            ON CONFLICT(event_id) DO UPDATE SET
                user_id = excluded.user_id,
                session_id = excluded.session_id,
                job_id = excluded.job_id,
                task_trigger_id = excluded.task_trigger_id,
                turn_id = excluded.turn_id,
                source = excluded.source,
                input_tokens = excluded.input_tokens,
                output_tokens = excluded.output_tokens,
                total_tokens = excluded.total_tokens,
                cached_input_tokens = excluded.cached_input_tokens,
                reasoning_output_tokens = excluded.reasoning_output_tokens,
                model_context_window = excluded.model_context_window,
                occurred_at = excluded.occurred_at,
                record_json = excluded.record_json
            "#,
        )
        .bind(&event.event_id)
        .bind(&event.user_id)
        .bind(&event.session_id)
        .bind(&event.job_id)
        .bind(&event.task_trigger_id)
        .bind(&event.turn_id)
        .bind(&event.source)
        .bind(u64_to_i64(event.input_tokens)?)
        .bind(u64_to_i64(event.output_tokens)?)
        .bind(u64_to_i64(event.total_tokens)?)
        .bind(u64_to_i64(event.cached_input_tokens)?)
        .bind(u64_to_i64(event.reasoning_output_tokens)?)
        .bind(event.model_context_window.map(u64_to_i64).transpose()?)
        .bind(&event.occurred_at)
        .bind(json_text(&event.record_json)?)
        .execute(&self.pool)
        .await?;
        Ok(())
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
            "task_triggers",
            "task_events",
            "task_actions",
            "tasks",
            "documents",
            "file_refs",
            "user_profiles",
        ] {
            sqlx::query(&format!("DELETE FROM {table} WHERE user_id = ?"))
                .bind(user_id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn user_profile(&self, user_id: &str) -> anyhow::Result<Option<UserProfileRecord>> {
        self.initialize().await?;
        let row = sqlx::query(
            r#"
            SELECT user_id, avatar_uri, created_at, updated_at
            FROM user_profiles
            WHERE user_id = ?
            "#,
        )
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(user_profile_from_row).transpose()
    }

    pub async fn upsert_user_avatar_uri(
        &self,
        user_id: &str,
        avatar_uri: Option<&str>,
    ) -> anyhow::Result<UserProfileRecord> {
        self.initialize().await?;
        let now = crate::auth::now_iso();
        sqlx::query(
            r#"
            INSERT INTO user_profiles (user_id, avatar_uri, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                avatar_uri = excluded.avatar_uri,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(user_id)
        .bind(avatar_uri)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        self.user_profile(user_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("failed to load user profile"))
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

    pub async fn get_document(
        &self,
        user_id: &str,
        document_id: &str,
    ) -> anyhow::Result<Option<Value>> {
        self.initialize().await?;
        let row =
            sqlx::query("SELECT record_json FROM documents WHERE user_id = ? AND document_id = ?")
                .bind(user_id)
                .bind(document_id)
                .fetch_optional(&self.pool)
                .await?;
        row.map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
            .transpose()
    }

    pub async fn upsert_document(&self, user_id: &str, record: &Value) -> anyhow::Result<()> {
        self.initialize().await?;
        let Some(document_id) = record.get("document_id").and_then(Value::as_str) else {
            anyhow::bail!("document record missing document_id");
        };
        sqlx::query(
            r#"
            INSERT INTO documents (user_id, document_id, updated_at, record_json)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, document_id) DO UPDATE SET
                updated_at = excluded.updated_at,
                record_json = excluded.record_json
            "#,
        )
        .bind(user_id)
        .bind(document_id)
        .bind(record_str(record, "updated_at"))
        .bind(json_text(record)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete_document(&self, user_id: &str, document_id: &str) -> anyhow::Result<bool> {
        self.initialize().await?;
        let result = sqlx::query("DELETE FROM documents WHERE user_id = ? AND document_id = ?")
            .bind(user_id)
            .bind(document_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() > 0)
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
        let message_count = messages.len();
        let codex_synced_message_count =
            i64_to_usize(row.get::<i64, _>("codex_synced_message_count"))?.min(message_count);
        Ok(SessionRecord {
            session_id,
            user_id,
            title: row.get("title"),
            pinned: row.get::<i64, _>("pinned") != 0,
            model: row.get("model"),
            max_turns: i64_to_u32(row.get::<i64, _>("max_turns"))?,
            caller_system_prompt: row.get("caller_system_prompt"),
            context_folder_path: row.get("context_folder_path"),
            session_kind: row.get("session_kind"),
            shared_folder_id: row.get("shared_folder_id"),
            total_input_tokens: i64_to_u64(row.get::<i64, _>("total_input_tokens"))?,
            total_output_tokens: i64_to_u64(row.get::<i64, _>("total_output_tokens"))?,
            last_input_tokens: i64_to_u64(row.get::<i64, _>("last_input_tokens"))?,
            created_at: row.get("created_at"),
            last_active: row.get("last_active"),
            status: row.get("status"),
            message_count,
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
            pending_control_request: json_option_from_text(
                row.get::<Option<String>, _>("pending_control_request_json"),
            )?,
            codex_thread_id: row.get("codex_thread_id"),
            codex_synced_message_count,
            memory_disabled: row.get::<i64, _>("memory_disabled") != 0,
            plan_steps: serde_json::from_str(row.get::<String, _>("plan_steps_json").as_str())?,
            plan_progress: json_option_from_text(
                row.get::<Option<String>, _>("plan_progress_json"),
            )?,
            task_callback_url: row.get("task_callback_url"),
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

fn user_profile_from_row(row: sqlx::sqlite::SqliteRow) -> anyhow::Result<UserProfileRecord> {
    Ok(UserProfileRecord {
        user_id: row.get("user_id"),
        avatar_uri: row.get("avatar_uri"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
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

fn i64_to_usize(value: i64) -> anyhow::Result<usize> {
    usize::try_from(value).context("SQLite integer exceeds usize range")
}

fn i64_to_u32(value: i64) -> anyhow::Result<u32> {
    u32::try_from(value).context("SQLite integer exceeds u32 range")
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
            context_folder_path: Some("/workspace/demo".to_string()),
            session_kind: "workspace".to_string(),
            shared_folder_id: None,
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
            pending_control_request: None,
            codex_thread_id: None,
            codex_synced_message_count: 99,
            memory_disabled: false,
            plan_steps: Vec::new(),
            plan_progress: None,
            task_callback_url: None,
        };

        storage.save_session(&record).await?;
        let loaded = storage
            .load_session("alice", "srv-test")
            .await?
            .expect("session");

        assert_eq!(loaded.messages, record.messages);
        assert!(loaded.pinned);
        assert_eq!(
            loaded.context_folder_path.as_deref(),
            Some("/workspace/demo")
        );
        assert_eq!(loaded.total_output_tokens, 2);
        assert_eq!(loaded.codex_synced_message_count, 1);

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn prepared_feishu_mail_can_only_be_claimed_once() -> anyhow::Result<()> {
        let root =
            std::env::temp_dir().join(format!("ripple-storage-test-{}", uuid::Uuid::new_v4()));
        let storage = Storage::open(root.join(".ripple/ripple.sqlite"))?;
        let record = serde_json::json!({
            "prepared_mail_id": "mail-test",
            "user_id": "alice",
            "session_id": "task-session",
            "status": "prepared",
            "created_at": "2026-07-21T00:00:00Z",
            "updated_at": "2026-07-21T00:00:00Z",
            "to": ["alice@example.com"],
            "subject": "测试",
            "html": "<p>测试</p>"
        });
        storage.create_prepared_feishu_mail(&record).await?;

        let first = storage
            .claim_prepared_feishu_mail_for_send(
                "alice",
                "task-session",
                "mail-test",
                "2026-07-21T00:01:00Z",
            )
            .await?
            .expect("prepared mail");
        assert_eq!(first.get("status").and_then(Value::as_str), Some("sending"));
        let second = storage
            .claim_prepared_feishu_mail_for_send(
                "alice",
                "task-session",
                "mail-test",
                "2026-07-21T00:02:00Z",
            )
            .await?
            .expect("claimed mail");
        assert_eq!(
            second.get("status").and_then(Value::as_str),
            Some("sending")
        );

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn token_usage_breakdown_sums_input_and_output_tokens() -> anyhow::Result<()> {
        let root =
            std::env::temp_dir().join(format!("ripple-storage-test-{}", uuid::Uuid::new_v4()));
        let storage = Storage::open(root.join(".ripple/ripple.sqlite"))?;
        let mut record = SessionRecord {
            session_id: "srv-token-a".to_string(),
            user_id: "alice".to_string(),
            title: "tokens".to_string(),
            pinned: false,
            context_folder_path: None,
            session_kind: "workspace".to_string(),
            shared_folder_id: None,
            model: "codex-test".to_string(),
            max_turns: 200,
            caller_system_prompt: None,
            total_input_tokens: 120,
            total_output_tokens: 30,
            last_input_tokens: 120,
            created_at: "2026-05-22T00:00:00Z".to_string(),
            last_active: "2026-05-22T00:00:01Z".to_string(),
            status: "idle".to_string(),
            message_count: 1,
            messages: Vec::new(),
            pending_question: None,
            pending_options: None,
            pending_permission_request: None,
            pending_connector_auth: None,
            pending_control_request: None,
            codex_thread_id: None,
            codex_synced_message_count: 0,
            memory_disabled: false,
            plan_steps: Vec::new(),
            plan_progress: None,
            task_callback_url: None,
        };
        storage.save_session(&record).await?;
        record.session_id = "srv-token-b".to_string();
        record.total_input_tokens = 80;
        record.total_output_tokens = 20;
        storage.save_session(&record).await?;

        let breakdown = storage.token_usage_breakdown("alice").await?;

        assert_eq!(breakdown.total_input_tokens, 200);
        assert_eq!(breakdown.total_output_tokens, 50);

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn token_usage_breakdown_prefers_ledger_without_double_counting_sessions(
    ) -> anyhow::Result<()> {
        let root =
            std::env::temp_dir().join(format!("ripple-storage-test-{}", uuid::Uuid::new_v4()));
        let storage = Storage::open(root.join(".ripple/ripple.sqlite"))?;
        let record = SessionRecord {
            session_id: "srv-token-ledger".to_string(),
            user_id: "alice".to_string(),
            title: "tokens".to_string(),
            pinned: false,
            context_folder_path: None,
            session_kind: "workspace".to_string(),
            shared_folder_id: None,
            model: "codex-test".to_string(),
            max_turns: 200,
            caller_system_prompt: None,
            total_input_tokens: 120,
            total_output_tokens: 30,
            last_input_tokens: 120,
            created_at: "2026-05-22T00:00:00Z".to_string(),
            last_active: "2026-05-22T00:00:01Z".to_string(),
            status: "idle".to_string(),
            message_count: 1,
            messages: Vec::new(),
            pending_question: None,
            pending_options: None,
            pending_permission_request: None,
            pending_connector_auth: None,
            pending_control_request: None,
            codex_thread_id: None,
            codex_synced_message_count: 0,
            memory_disabled: false,
            plan_steps: Vec::new(),
            plan_progress: None,
            task_callback_url: None,
        };
        storage.save_session(&record).await?;
        storage
            .upsert_token_usage_event(&TokenUsageEventRecord {
                event_id: "codex-job:agent-test:turn-1".to_string(),
                user_id: "alice".to_string(),
                session_id: Some("srv-token-ledger".to_string()),
                job_id: Some("agent-test".to_string()),
                task_trigger_id: None,
                turn_id: Some("turn-1".to_string()),
                source: "codex_job".to_string(),
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
                cached_input_tokens: 1,
                reasoning_output_tokens: 2,
                model_context_window: Some(200_000),
                occurred_at: "2026-05-22T00:00:02Z".to_string(),
                record_json: serde_json::json!({"usage": "test"}),
            })
            .await?;

        let breakdown = storage.token_usage_breakdown("alice").await?;

        assert_eq!(breakdown.total_input_tokens, 10);
        assert_eq!(breakdown.total_output_tokens, 5);

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn token_usage_by_period_sums_input_and_output_tokens() -> anyhow::Result<()> {
        let root =
            std::env::temp_dir().join(format!("ripple-storage-test-{}", uuid::Uuid::new_v4()));
        let storage = Storage::open(root.join(".ripple/ripple.sqlite"))?;
        let now = time::OffsetDateTime::now_utc();
        let format_time = |time: time::OffsetDateTime| {
            time.format(&time::format_description::well_known::Rfc3339)
                .unwrap()
        };
        let mut record = SessionRecord {
            session_id: "srv-token-window-daily".to_string(),
            user_id: "alice".to_string(),
            title: "tokens".to_string(),
            pinned: false,
            context_folder_path: None,
            session_kind: "workspace".to_string(),
            shared_folder_id: None,
            model: "codex-test".to_string(),
            max_turns: 200,
            caller_system_prompt: None,
            total_input_tokens: 120,
            total_output_tokens: 30,
            last_input_tokens: 120,
            created_at: format_time(now - Duration::from_secs(2 * 60 * 60)),
            last_active: format_time(now - Duration::from_secs(2 * 60 * 60)),
            status: "idle".to_string(),
            message_count: 1,
            messages: Vec::new(),
            pending_question: None,
            pending_options: None,
            pending_permission_request: None,
            pending_connector_auth: None,
            pending_control_request: None,
            codex_thread_id: None,
            codex_synced_message_count: 0,
            memory_disabled: false,
            plan_steps: Vec::new(),
            plan_progress: None,
            task_callback_url: None,
        };
        storage.save_session(&record).await?;

        record.session_id = "srv-token-window-weekly".to_string();
        record.total_input_tokens = 80;
        record.total_output_tokens = 20;
        record.last_active = format_time(now - Duration::from_secs(3 * 24 * 60 * 60));
        storage.save_session(&record).await?;

        record.session_id = "srv-token-window-old".to_string();
        record.total_input_tokens = 40;
        record.total_output_tokens = 10;
        record.last_active = format_time(now - Duration::from_secs(9 * 24 * 60 * 60));
        storage.save_session(&record).await?;

        let (daily, weekly) = storage.token_usage_by_period("alice").await?;

        assert_eq!(daily.total_input_tokens, 120);
        assert_eq!(daily.total_output_tokens, 30);
        assert_eq!(weekly.total_input_tokens, 200);
        assert_eq!(weekly.total_output_tokens, 50);

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn token_usage_by_period_filters_ledger_events_by_occurrence_time() -> anyhow::Result<()>
    {
        let root =
            std::env::temp_dir().join(format!("ripple-storage-test-{}", uuid::Uuid::new_v4()));
        let storage = Storage::open(root.join(".ripple/ripple.sqlite"))?;
        let now = time::OffsetDateTime::now_utc();
        let format_time = |time: time::OffsetDateTime| {
            time.format(&time::format_description::well_known::Rfc3339)
                .unwrap()
        };
        let record = SessionRecord {
            session_id: "srv-token-ledger-window".to_string(),
            user_id: "alice".to_string(),
            title: "tokens".to_string(),
            pinned: false,
            context_folder_path: None,
            session_kind: "workspace".to_string(),
            shared_folder_id: None,
            model: "codex-test".to_string(),
            max_turns: 200,
            caller_system_prompt: None,
            total_input_tokens: 120,
            total_output_tokens: 30,
            last_input_tokens: 120,
            created_at: format_time(now),
            last_active: format_time(now),
            status: "idle".to_string(),
            message_count: 1,
            messages: Vec::new(),
            pending_question: None,
            pending_options: None,
            pending_permission_request: None,
            pending_connector_auth: None,
            pending_control_request: None,
            codex_thread_id: None,
            codex_synced_message_count: 0,
            memory_disabled: false,
            plan_steps: Vec::new(),
            task_callback_url: None,
            plan_progress: None,
        };
        storage.save_session(&record).await?;
        storage
            .upsert_token_usage_event(&TokenUsageEventRecord {
                event_id: "codex-job:agent-window:turn-1".to_string(),
                user_id: "alice".to_string(),
                session_id: Some("srv-token-ledger-window".to_string()),
                job_id: Some("agent-window".to_string()),
                task_trigger_id: None,
                turn_id: Some("turn-1".to_string()),
                source: "codex_job".to_string(),
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
                cached_input_tokens: 0,
                reasoning_output_tokens: 0,
                model_context_window: None,
                occurred_at: format_time(now - Duration::from_secs(9 * 24 * 60 * 60)),
                record_json: serde_json::json!({"usage": "old"}),
            })
            .await?;

        let (daily, weekly) = storage.token_usage_by_period("alice").await?;

        assert_eq!(daily.total_input_tokens, 0);
        assert_eq!(daily.total_output_tokens, 0);
        assert_eq!(weekly.total_input_tokens, 0);
        assert_eq!(weekly.total_output_tokens, 0);

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn user_profile_avatar_uri_is_persisted_without_image_blob() -> anyhow::Result<()> {
        let root =
            std::env::temp_dir().join(format!("ripple-storage-test-{}", uuid::Uuid::new_v4()));
        let storage = Storage::open(root.join(".ripple/ripple.sqlite"))?;
        let avatar_uri = "/v1/users/me/avatar/avatar.png";

        assert!(storage.user_profile("alice").await?.is_none());

        let profile = storage
            .upsert_user_avatar_uri("alice", Some(avatar_uri))
            .await?;
        assert_eq!(profile.user_id, "alice");
        assert_eq!(profile.avatar_uri.as_deref(), Some(avatar_uri));

        let reloaded = storage
            .user_profile("alice")
            .await?
            .expect("profile row should exist");
        assert_eq!(reloaded.avatar_uri.as_deref(), Some(avatar_uri));

        let cleared = storage.upsert_user_avatar_uri("alice", None).await?;
        assert_eq!(cleared.avatar_uri, None);
        assert_eq!(
            storage
                .user_profile("alice")
                .await?
                .and_then(|row| row.avatar_uri),
            None
        );

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
    async fn records_schema_migration_version() -> anyhow::Result<()> {
        let root =
            std::env::temp_dir().join(format!("ripple-storage-test-{}", uuid::Uuid::new_v4()));
        let storage = Storage::open(root.join(".ripple/ripple.sqlite"))?;

        assert_eq!(storage.schema_version().await?, CURRENT_SCHEMA_VERSION);

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn new_schema_does_not_create_legacy_task_session_tables() -> anyhow::Result<()> {
        let root =
            std::env::temp_dir().join(format!("ripple-storage-test-{}", uuid::Uuid::new_v4()));
        let storage = Storage::open(root.join(".ripple/ripple.sqlite"))?;
        storage.initialize().await?;

        for table in [
            "task_sessions",
            "task_session_specs",
            "task_session_runs",
            "task_session_events",
            "task_session_confirmations",
        ] {
            let found =
                sqlx::query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
                    .bind(table)
                    .fetch_optional(&storage.pool)
                    .await?;
            assert!(found.is_none(), "legacy table {table} must not be created");
        }

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn initialize_removes_legacy_project_schema() -> anyhow::Result<()> {
        let root =
            std::env::temp_dir().join(format!("ripple-storage-test-{}", uuid::Uuid::new_v4()));
        let db_path = root.join(".ripple/ripple.sqlite");
        let storage = Storage::open(&db_path)?;
        let record = SessionRecord {
            session_id: "srv-legacy-project".to_string(),
            user_id: "alice".to_string(),
            title: "legacy".to_string(),
            pinned: false,
            context_folder_path: None,
            session_kind: "workspace".to_string(),
            shared_folder_id: None,
            model: "codex-test".to_string(),
            max_turns: 200,
            caller_system_prompt: None,
            total_input_tokens: 0,
            total_output_tokens: 0,
            last_input_tokens: 0,
            created_at: "2026-05-22T00:00:00Z".to_string(),
            last_active: "2026-05-22T00:00:01Z".to_string(),
            status: "idle".to_string(),
            message_count: 0,
            messages: Vec::new(),
            pending_question: None,
            pending_options: None,
            pending_permission_request: None,
            pending_connector_auth: None,
            pending_control_request: None,
            codex_thread_id: None,
            codex_synced_message_count: 0,
            memory_disabled: false,
            plan_steps: Vec::new(),
            plan_progress: None,
            task_callback_url: None,
        };
        storage.save_session(&record).await?;
        for statement in [
            "ALTER TABLE sessions ADD COLUMN project_id TEXT",
            "ALTER TABLE sessions ADD COLUMN project_name TEXT",
            "ALTER TABLE sessions ADD COLUMN project_root TEXT",
        ] {
            sqlx::query(statement).execute(&storage.pool).await?;
        }
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS projects (
                user_id TEXT NOT NULL,
                project_id TEXT NOT NULL,
                name TEXT NOT NULL,
                root_path TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_active_at TEXT NOT NULL,
                PRIMARY KEY (user_id, project_id)
            )
            "#,
        )
        .execute(&storage.pool)
        .await?;
        sqlx::query(
            "INSERT INTO projects (user_id, project_id, name, root_path, created_at, updated_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind("alice")
        .bind("prj-demo")
        .bind("Demo")
        .bind("/workspace/demo")
        .bind("2026-05-22T00:00:00Z")
        .bind("2026-05-22T00:00:00Z")
        .bind("2026-05-22T00:00:00Z")
        .execute(&storage.pool)
        .await?;
        sqlx::query(
            r#"
            CREATE TABLE api_keys (
                key_id TEXT PRIMARY KEY NOT NULL,
                key_hash TEXT NOT NULL,
                kind TEXT NOT NULL,
                user_id TEXT,
                display_name TEXT,
                created_at TEXT NOT NULL,
                revoked_at TEXT
            )
            "#,
        )
        .execute(&storage.pool)
        .await?;
        sqlx::query(
            r#"
            CREATE TABLE users (
                user_id TEXT PRIMARY KEY NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                record_json TEXT NOT NULL
            )
            "#,
        )
        .execute(&storage.pool)
        .await?;
        sqlx::query(
            "UPDATE sessions SET project_id = ?, project_name = ?, project_root = ? WHERE user_id = ? AND session_id = ?",
        )
        .bind("prj-demo")
        .bind("Demo")
        .bind("/workspace/demo")
        .bind("alice")
        .bind("srv-legacy-project")
        .execute(&storage.pool)
        .await?;
        drop(storage);

        let storage = Storage::open(&db_path)?;
        let loaded = storage
            .load_session("alice", "srv-legacy-project")
            .await?
            .expect("session");
        assert_eq!(loaded.context_folder_path, None);

        let columns = sqlx::query("PRAGMA table_info(sessions)")
            .fetch_all(&storage.pool)
            .await?
            .into_iter()
            .map(|row| row.get::<String, _>("name"))
            .collect::<Vec<_>>();
        assert!(!columns.iter().any(|column| column == "project_id"));
        assert!(!columns.iter().any(|column| column == "project_name"));
        assert!(!columns.iter().any(|column| column == "project_root"));

        let legacy_project_table = sqlx::query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('projects', 'api_keys', 'users')",
        )
        .fetch_optional(&storage.pool)
        .await?;
        assert!(legacy_project_table.is_none());

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn auth_invite_claim_login_and_session_lifecycle() -> anyhow::Result<()> {
        let root =
            std::env::temp_dir().join(format!("ripple-storage-test-{}", uuid::Uuid::new_v4()));
        let storage = Storage::open(root.join(".ripple/ripple.sqlite"))?;

        storage
            .create_auth_invite(&AuthInviteCreate {
                invite_id: "inv-test".to_string(),
                code_hash: "invite-hash".to_string(),
                max_uses: 1,
                expires_at: Some("2026-06-01T00:00:00Z".to_string()),
                created_by: Some("admin".to_string()),
                created_at: "2026-05-29T00:00:00Z".to_string(),
            })
            .await?;

        let claimed = storage
            .claim_auth_invite(&AuthInviteClaim {
                code_hash: "invite-hash".to_string(),
                user_id: "usr_test".to_string(),
                login: "Alice@Example.com".to_string(),
                login_normalized: "alice@example.com".to_string(),
                password_hash: "argon2-hash".to_string(),
                display_name: Some("Alice".to_string()),
                now: "2026-05-29T00:00:01Z".to_string(),
            })
            .await?;
        assert_eq!(claimed.user_id, "usr_test");
        assert_eq!(claimed.login, "Alice@Example.com");

        let duplicate = storage
            .claim_auth_invite(&AuthInviteClaim {
                code_hash: "invite-hash".to_string(),
                user_id: "usr_other".to_string(),
                login: "Other@example.com".to_string(),
                login_normalized: "other@example.com".to_string(),
                password_hash: "argon2-hash".to_string(),
                display_name: None,
                now: "2026-05-29T00:00:02Z".to_string(),
            })
            .await;
        assert!(duplicate.is_err(), "single-use invite must be exhausted");

        let by_login = storage
            .auth_user_by_login("alice@example.com")
            .await?
            .expect("auth user");
        assert_eq!(by_login.user_id, "usr_test");
        assert_eq!(by_login.status, "active");

        storage
            .create_auth_session(&AuthSessionCreate {
                session_id: "auth-session".to_string(),
                user_id: "usr_test".to_string(),
                token_hash: "token-hash".to_string(),
                created_at: "2026-05-29T00:00:03Z".to_string(),
                expires_at: "2026-06-28T00:00:03Z".to_string(),
                user_agent: Some("test-agent".to_string()),
            })
            .await?;
        let session = storage
            .authenticate_auth_session("token-hash", "2026-05-29T00:00:04Z")
            .await?
            .expect("auth session");
        assert_eq!(session.user_id, "usr_test");
        assert_eq!(session.login, "Alice@Example.com");

        assert!(storage.revoke_auth_session("token-hash").await?);
        assert!(storage
            .authenticate_auth_session("token-hash", "2026-05-29T00:00:05Z")
            .await?
            .is_none());

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn upsert_task_trigger_preserves_other_trigger_records() -> anyhow::Result<()> {
        let root =
            std::env::temp_dir().join(format!("ripple-storage-test-{}", uuid::Uuid::new_v4()));
        let storage = Storage::open(root.join(".ripple/ripple.sqlite"))?;

        storage
            .upsert_task_trigger(
                "alice",
                &serde_json::json!({
                    "trigger_id": "trg-one",
                    "status": "active",
                    "next_run_at": "2026-05-28T00:00:00Z",
                    "updated_at": "2026-05-28T00:00:00Z"
                }),
            )
            .await?;
        storage
            .upsert_task_trigger(
                "alice",
                &serde_json::json!({
                    "trigger_id": "trg-two",
                    "status": "active",
                    "next_run_at": "2026-05-28T01:00:00Z",
                    "updated_at": "2026-05-28T00:00:00Z"
                }),
            )
            .await?;
        storage
            .upsert_task_trigger(
                "alice",
                &serde_json::json!({
                    "trigger_id": "trg-one",
                    "status": "paused",
                    "next_run_at": null,
                    "updated_at": "2026-05-28T00:01:00Z"
                }),
            )
            .await?;

        let triggers = storage.list_task_triggers("alice").await?;

        assert_eq!(triggers.len(), 2);
        assert!(triggers.iter().any(|record| {
            record.get("trigger_id").and_then(Value::as_str) == Some("trg-one")
                && record.get("status").and_then(Value::as_str) == Some("paused")
        }));
        assert!(triggers.iter().any(|record| {
            record.get("trigger_id").and_then(Value::as_str) == Some("trg-two")
                && record.get("status").and_then(Value::as_str) == Some("active")
        }));

        let table_rows = sqlx::query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_triggers'",
        )
        .fetch_all(&storage.pool)
        .await?;
        let table_names = table_rows
            .into_iter()
            .map(|row| row.get::<String, _>("name"))
            .collect::<Vec<_>>();
        assert_eq!(table_names, vec!["task_triggers"]);

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn initialize_removes_legacy_schedule_schema() -> anyhow::Result<()> {
        let root =
            std::env::temp_dir().join(format!("ripple-storage-test-{}", uuid::Uuid::new_v4()));
        let storage = Storage::open(root.join(".ripple/ripple.sqlite"))?;

        sqlx::query(
            r#"
            CREATE TABLE jobs (
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
            )
            "#,
        )
        .execute(&storage.pool)
        .await?;
        sqlx::query("CREATE INDEX idx_jobs_user_schedule ON jobs(user_id, schedule_id)")
            .execute(&storage.pool)
            .await?;
        sqlx::query(
            r#"
            INSERT INTO jobs (
                job_id, user_id, session_id, provider, status, created_at, updated_at,
                schedule_id, events_file, output_file, record_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind("agent-legacy")
        .bind("alice")
        .bind(Option::<String>::None)
        .bind("codex")
        .bind("completed")
        .bind("2026-05-28T00:00:00Z")
        .bind("2026-05-28T00:01:00Z")
        .bind("sch-legacy")
        .bind(Option::<String>::None)
        .bind(Option::<String>::None)
        .bind(
            serde_json::json!({
                "job_id": "agent-legacy",
                "user_id": "alice",
                "provider": "codex",
                "status": "completed",
                "created_at": "2026-05-28T00:00:00Z",
                "updated_at": "2026-05-28T00:01:00Z",
                "schedule_id": "sch-legacy",
                "schedule_title": "legacy",
                "schedule_trigger": "scheduled"
            })
            .to_string(),
        )
        .execute(&storage.pool)
        .await?;
        sqlx::query(
            r#"
            CREATE TABLE schedules (
                user_id TEXT NOT NULL,
                schedule_id TEXT NOT NULL,
                status TEXT NOT NULL,
                next_run_at TEXT,
                updated_at TEXT NOT NULL,
                record_json TEXT NOT NULL,
                PRIMARY KEY (user_id, schedule_id)
            )
            "#,
        )
        .execute(&storage.pool)
        .await?;
        sqlx::query(
            "CREATE INDEX idx_schedules_user_status_next ON schedules(user_id, status, next_run_at)",
        )
        .execute(&storage.pool)
        .await?;

        storage.initialize().await?;

        let job_columns = sqlx::query("PRAGMA table_info(jobs)")
            .fetch_all(&storage.pool)
            .await?
            .into_iter()
            .map(|row| row.get::<String, _>("name"))
            .collect::<Vec<_>>();
        assert!(job_columns.iter().any(|column| column == "task_trigger_id"));
        assert!(!job_columns.iter().any(|column| column == "schedule_id"));

        let legacy_table = sqlx::query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schedules'",
        )
        .fetch_optional(&storage.pool)
        .await?;
        assert!(legacy_table.is_none());

        let legacy_indexes = sqlx::query(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_jobs_user_schedule', 'idx_schedules_user_status_next')",
        )
        .fetch_all(&storage.pool)
        .await?;
        assert!(legacy_indexes.is_empty());

        let record_json = sqlx::query("SELECT record_json FROM jobs WHERE job_id = ?")
            .bind("agent-legacy")
            .fetch_one(&storage.pool)
            .await?
            .get::<String, _>("record_json");
        let record: Value = serde_json::from_str(&record_json)?;
        assert!(record.get("schedule_id").is_none());
        assert!(record.get("schedule_title").is_none());
        assert!(record.get("schedule_trigger").is_none());

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
