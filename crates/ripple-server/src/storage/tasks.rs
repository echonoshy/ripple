use serde_json::Value;
use sqlx::Row;

use super::{json_from_text, json_text, record_str, Storage};

impl Storage {
    pub async fn upsert_task(&self, user_id: &str, record: &Value) -> anyhow::Result<()> {
        self.initialize().await?;
        let Some(task_id) = record.get("task_id").and_then(Value::as_str) else {
            anyhow::bail!("task record missing task_id");
        };
        sqlx::query(
            r#"
            INSERT INTO tasks (
                user_id, task_id, status, priority, due_at, source_session_id, updated_at, record_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, task_id) DO UPDATE SET
                status = excluded.status,
                priority = excluded.priority,
                due_at = excluded.due_at,
                source_session_id = excluded.source_session_id,
                updated_at = excluded.updated_at,
                record_json = excluded.record_json
            "#,
        )
        .bind(user_id)
        .bind(task_id)
        .bind(record_str(record, "status"))
        .bind(record_str(record, "priority"))
        .bind(record.get("due_at").and_then(Value::as_str))
        .bind(record.get("source_session_id").and_then(Value::as_str))
        .bind(record_str(record, "updated_at"))
        .bind(json_text(record)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_task(&self, user_id: &str, task_id: &str) -> anyhow::Result<Option<Value>> {
        self.initialize().await?;
        sqlx::query(
            r#"
            SELECT record_json FROM tasks
            WHERE user_id = ? AND task_id = ?
            "#,
        )
        .bind(user_id)
        .bind(task_id)
        .fetch_optional(&self.pool)
        .await?
        .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
        .transpose()
    }

    pub async fn delete_task(&self, user_id: &str, task_id: &str) -> anyhow::Result<bool> {
        self.initialize().await?;
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM task_events WHERE user_id = ? AND task_id = ?")
            .bind(user_id)
            .bind(task_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM task_actions WHERE user_id = ? AND task_id = ?")
            .bind(user_id)
            .bind(task_id)
            .execute(&mut *tx)
            .await?;
        let result = sqlx::query("DELETE FROM tasks WHERE user_id = ? AND task_id = ?")
            .bind(user_id)
            .bind(task_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn list_tasks(&self, user_id: &str) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        let rows = sqlx::query(
            r#"
            SELECT record_json FROM tasks
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

    pub async fn list_task_user_ids(&self) -> anyhow::Result<Vec<String>> {
        self.initialize().await?;
        let rows = sqlx::query("SELECT DISTINCT user_id FROM tasks ORDER BY user_id ASC")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .into_iter()
            .map(|row| row.get::<String, _>("user_id"))
            .collect())
    }

    pub async fn list_tasks_for_session(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        let rows = sqlx::query(
            r#"
            SELECT record_json FROM tasks
            WHERE user_id = ? AND source_session_id = ?
            ORDER BY updated_at DESC
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

    pub async fn upsert_task_action(
        &self,
        user_id: &str,
        task_id: &str,
        record: &Value,
    ) -> anyhow::Result<()> {
        self.initialize().await?;
        let Some(action_id) = record.get("action_id").and_then(Value::as_str) else {
            anyhow::bail!("task action record missing action_id");
        };
        sqlx::query(
            r#"
            INSERT INTO task_actions (
                user_id, task_id, action_id, kind, status, next_wakeup_at, updated_at, record_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, task_id, action_id) DO UPDATE SET
                kind = excluded.kind,
                status = excluded.status,
                next_wakeup_at = excluded.next_wakeup_at,
                updated_at = excluded.updated_at,
                record_json = excluded.record_json
            "#,
        )
        .bind(user_id)
        .bind(task_id)
        .bind(action_id)
        .bind(record_str(record, "kind"))
        .bind(record_str(record, "status"))
        .bind(record.get("next_wakeup_at").and_then(Value::as_str))
        .bind(record_str(record, "updated_at"))
        .bind(json_text(record)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_task_actions(
        &self,
        user_id: &str,
        task_id: &str,
    ) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        let rows = sqlx::query(
            r#"
            SELECT record_json FROM task_actions
            WHERE user_id = ? AND task_id = ?
            ORDER BY
                CASE WHEN next_wakeup_at IS NULL THEN 1 ELSE 0 END,
                next_wakeup_at ASC,
                updated_at DESC
            "#,
        )
        .bind(user_id)
        .bind(task_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
            .collect()
    }

    pub async fn upsert_task_event(
        &self,
        user_id: &str,
        task_id: &str,
        record: &Value,
    ) -> anyhow::Result<()> {
        self.initialize().await?;
        let Some(event_id) = record.get("event_id").and_then(Value::as_str) else {
            anyhow::bail!("task event record missing event_id");
        };
        sqlx::query(
            r#"
            INSERT INTO task_events (user_id, task_id, event_id, created_at, record_json)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id, task_id, event_id) DO UPDATE SET
                created_at = excluded.created_at,
                record_json = excluded.record_json
            "#,
        )
        .bind(user_id)
        .bind(task_id)
        .bind(event_id)
        .bind(record_str(record, "created_at"))
        .bind(json_text(record)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_task_events(
        &self,
        user_id: &str,
        task_id: &str,
    ) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        let rows = sqlx::query(
            r#"
            SELECT record_json FROM task_events
            WHERE user_id = ? AND task_id = ?
            ORDER BY created_at ASC
            "#,
        )
        .bind(user_id)
        .bind(task_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
            .collect()
    }
}
