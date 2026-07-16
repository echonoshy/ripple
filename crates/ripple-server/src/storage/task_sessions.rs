use serde_json::{json, Value};
use sqlx::Row;

use super::{json_from_text, json_text, record_str, Storage};

impl Storage {
    pub async fn save_task_session_idempotency(
        &self,
        user_id: &str,
        action: &str,
        idempotency_key: &str,
        request: &Value,
        response: &Value,
        created_at: &str,
    ) -> anyhow::Result<bool> {
        self.initialize().await?;
        let result = sqlx::query(
            r#"
            INSERT OR IGNORE INTO task_session_idempotency (
                user_id, action, idempotency_key, request_json, response_json, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(user_id)
        .bind(action)
        .bind(idempotency_key)
        .bind(json_text(request)?)
        .bind(json_text(response)?)
        .bind(created_at)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn get_task_session_idempotency(
        &self,
        user_id: &str,
        action: &str,
        idempotency_key: &str,
    ) -> anyhow::Result<Option<Value>> {
        self.initialize().await?;
        let row = sqlx::query(
            r#"
            SELECT request_json, response_json, created_at
            FROM task_session_idempotency
            WHERE user_id = ? AND action = ? AND idempotency_key = ?
            "#,
        )
        .bind(user_id)
        .bind(action)
        .bind(idempotency_key)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| {
            Ok(json!({
                "request": json_from_text(row.get::<String, _>("request_json").as_str())?,
                "response": json_from_text(row.get::<String, _>("response_json").as_str())?,
                "created_at": row.get::<String, _>("created_at")
            }))
        })
        .transpose()
    }

    pub async fn upsert_task_session(&self, user_id: &str, record: &Value) -> anyhow::Result<()> {
        self.initialize().await?;
        let Some(session_id) = record.get("session_id").and_then(Value::as_str) else {
            anyhow::bail!("task session record missing session_id");
        };
        let needs_user_action = record
            .get("needs_user_action")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        sqlx::query(
            r#"
            INSERT INTO task_sessions (
                user_id, session_id, status, source_surface, source_id,
                needs_user_action, updated_at, record_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, session_id) DO UPDATE SET
                status = excluded.status,
                source_surface = excluded.source_surface,
                source_id = excluded.source_id,
                needs_user_action = excluded.needs_user_action,
                updated_at = excluded.updated_at,
                record_json = excluded.record_json
            "#,
        )
        .bind(user_id)
        .bind(session_id)
        .bind(record_str(record, "status"))
        .bind(record.get("source_surface").and_then(Value::as_str))
        .bind(record.get("source_id").and_then(Value::as_str))
        .bind(if needs_user_action { 1_i64 } else { 0_i64 })
        .bind(record_str(record, "updated_at"))
        .bind(json_text(record)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_task_session(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> anyhow::Result<Option<Value>> {
        self.initialize().await?;
        sqlx::query(
            r#"
            SELECT record_json FROM task_sessions
            WHERE user_id = ? AND session_id = ?
            "#,
        )
        .bind(user_id)
        .bind(session_id)
        .fetch_optional(&self.pool)
        .await?
        .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
        .transpose()
    }

    pub async fn list_task_sessions(&self, user_id: &str) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        let rows = sqlx::query(
            r#"
            SELECT record_json FROM task_sessions
            WHERE user_id = ?
            ORDER BY updated_at DESC
            "#,
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
            .collect()
    }

    pub async fn delete_task_session(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> anyhow::Result<bool> {
        self.initialize().await?;
        let mut tx = self.pool.begin().await?;
        for table in [
            "task_session_confirmations",
            "task_session_events",
            "task_session_runs",
            "task_session_specs",
        ] {
            sqlx::query(&format!(
                "DELETE FROM {table} WHERE user_id = ? AND session_id = ?"
            ))
            .bind(user_id)
            .bind(session_id)
            .execute(&mut *tx)
            .await?;
        }
        let result = sqlx::query("DELETE FROM task_sessions WHERE user_id = ? AND session_id = ?")
            .bind(user_id)
            .bind(session_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn upsert_task_session_spec(
        &self,
        user_id: &str,
        session_id: &str,
        record: &Value,
    ) -> anyhow::Result<()> {
        self.initialize().await?;
        let Some(task_spec_id) = record.get("task_spec_id").and_then(Value::as_str) else {
            anyhow::bail!("task spec record missing task_spec_id");
        };
        sqlx::query(
            r#"
            INSERT INTO task_session_specs (
                user_id, session_id, task_spec_id, status, task_type, updated_at, record_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, session_id, task_spec_id) DO UPDATE SET
                status = excluded.status,
                task_type = excluded.task_type,
                updated_at = excluded.updated_at,
                record_json = excluded.record_json
            "#,
        )
        .bind(user_id)
        .bind(session_id)
        .bind(task_spec_id)
        .bind(record_str(record, "status"))
        .bind(record_str(record, "task_type"))
        .bind(record_str(record, "updated_at"))
        .bind(json_text(record)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_task_session_spec(
        &self,
        user_id: &str,
        session_id: &str,
        task_spec_id: &str,
    ) -> anyhow::Result<Option<Value>> {
        self.initialize().await?;
        sqlx::query(
            r#"
            SELECT record_json FROM task_session_specs
            WHERE user_id = ? AND session_id = ? AND task_spec_id = ?
            "#,
        )
        .bind(user_id)
        .bind(session_id)
        .bind(task_spec_id)
        .fetch_optional(&self.pool)
        .await?
        .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
        .transpose()
    }

    pub async fn list_task_session_specs(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        let rows = sqlx::query(
            r#"
            SELECT record_json FROM task_session_specs
            WHERE user_id = ? AND session_id = ?
            ORDER BY updated_at ASC
            "#,
        )
        .bind(user_id)
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
            .collect()
    }

    pub async fn upsert_task_session_run(
        &self,
        user_id: &str,
        session_id: &str,
        record: &Value,
    ) -> anyhow::Result<()> {
        self.initialize().await?;
        let Some(run_id) = record.get("run_id").and_then(Value::as_str) else {
            anyhow::bail!("task run record missing run_id");
        };
        sqlx::query(
            r#"
            INSERT INTO task_session_runs (
                user_id, session_id, run_id, task_spec_id, status, updated_at, record_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, session_id, run_id) DO UPDATE SET
                task_spec_id = excluded.task_spec_id,
                status = excluded.status,
                updated_at = excluded.updated_at,
                record_json = excluded.record_json
            "#,
        )
        .bind(user_id)
        .bind(session_id)
        .bind(run_id)
        .bind(record.get("task_spec_id").and_then(Value::as_str))
        .bind(record_str(record, "status"))
        .bind(record_str(record, "updated_at"))
        .bind(json_text(record)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_task_session_run(
        &self,
        user_id: &str,
        session_id: &str,
        run_id: &str,
    ) -> anyhow::Result<Option<Value>> {
        self.initialize().await?;
        sqlx::query(
            r#"
            SELECT record_json FROM task_session_runs
            WHERE user_id = ? AND session_id = ? AND run_id = ?
            "#,
        )
        .bind(user_id)
        .bind(session_id)
        .bind(run_id)
        .fetch_optional(&self.pool)
        .await?
        .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
        .transpose()
    }

    pub async fn list_task_session_runs(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        let rows = sqlx::query(
            r#"
            SELECT record_json FROM task_session_runs
            WHERE user_id = ? AND session_id = ?
            ORDER BY updated_at ASC
            "#,
        )
        .bind(user_id)
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
            .collect()
    }

    pub async fn list_active_task_session_runs(&self) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        let rows = sqlx::query(
            r#"
            SELECT record_json FROM task_session_runs
            WHERE status IN ('in_progress', 'waiting_user')
            ORDER BY updated_at ASC
            "#,
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
            .collect()
    }

    pub async fn upsert_task_session_event(
        &self,
        user_id: &str,
        session_id: &str,
        record: &Value,
    ) -> anyhow::Result<()> {
        self.initialize().await?;
        let Some(event_id) = record.get("event_id").and_then(Value::as_str) else {
            anyhow::bail!("task session event record missing event_id");
        };
        sqlx::query(
            r#"
            INSERT INTO task_session_events (user_id, session_id, event_id, created_at, record_json)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id, session_id, event_id) DO UPDATE SET
                created_at = excluded.created_at,
                record_json = excluded.record_json
            "#,
        )
        .bind(user_id)
        .bind(session_id)
        .bind(event_id)
        .bind(record_str(record, "created_at"))
        .bind(json_text(record)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_task_session_events(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        let rows = sqlx::query(
            r#"
            SELECT seq, record_json FROM task_session_events
            WHERE user_id = ? AND session_id = ?
            ORDER BY seq ASC
            "#,
        )
        .bind(user_id)
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(task_session_event_from_row).collect()
    }

    pub async fn latest_task_session_event_seq(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> anyhow::Result<Option<i64>> {
        self.initialize().await?;
        let row = sqlx::query(
            r#"
            SELECT seq FROM task_session_events
            WHERE user_id = ? AND session_id = ?
            ORDER BY seq DESC
            LIMIT 1
            "#,
        )
        .bind(user_id)
        .bind(session_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| row.get::<i64, _>("seq")))
    }

    pub async fn list_task_session_events_after_seq(
        &self,
        user_id: &str,
        session_id: &str,
        after_seq: i64,
    ) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        let rows = sqlx::query(
            r#"
            SELECT seq, record_json FROM task_session_events
            WHERE user_id = ? AND session_id = ? AND seq > ?
            ORDER BY seq ASC
            "#,
        )
        .bind(user_id)
        .bind(session_id)
        .bind(after_seq)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(task_session_event_from_row).collect()
    }

    pub async fn upsert_task_session_confirmation(
        &self,
        user_id: &str,
        session_id: &str,
        record: &Value,
    ) -> anyhow::Result<()> {
        self.initialize().await?;
        let Some(confirmation_id) = record.get("confirmation_id").and_then(Value::as_str) else {
            anyhow::bail!("task confirmation record missing confirmation_id");
        };
        sqlx::query(
            r#"
            INSERT INTO task_session_confirmations (
                user_id, session_id, confirmation_id, status, updated_at, record_json
            )
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, session_id, confirmation_id) DO UPDATE SET
                status = excluded.status,
                updated_at = excluded.updated_at,
                record_json = excluded.record_json
            "#,
        )
        .bind(user_id)
        .bind(session_id)
        .bind(confirmation_id)
        .bind(record_str(record, "status"))
        .bind(record_str(record, "updated_at"))
        .bind(json_text(record)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_task_session_confirmation(
        &self,
        user_id: &str,
        session_id: &str,
        confirmation_id: &str,
    ) -> anyhow::Result<Option<Value>> {
        self.initialize().await?;
        sqlx::query(
            r#"
            SELECT record_json FROM task_session_confirmations
            WHERE user_id = ? AND session_id = ? AND confirmation_id = ?
            "#,
        )
        .bind(user_id)
        .bind(session_id)
        .bind(confirmation_id)
        .fetch_optional(&self.pool)
        .await?
        .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
        .transpose()
    }

    pub async fn list_task_session_confirmations(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        let rows = sqlx::query(
            r#"
            SELECT record_json FROM task_session_confirmations
            WHERE user_id = ? AND session_id = ?
            ORDER BY updated_at ASC
            "#,
        )
        .bind(user_id)
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
            .collect()
    }
}

fn task_session_event_from_row(row: sqlx::sqlite::SqliteRow) -> anyhow::Result<Value> {
    let seq = row.get::<i64, _>("seq");
    let mut event = json_from_text(row.get::<String, _>("record_json").as_str())?;
    if let Some(object) = event.as_object_mut() {
        object.insert("seq".to_string(), json!(seq));
    }
    Ok(event)
}
