use serde_json::Value;
use sqlx::Row;

use super::{json_from_text, json_text, record_str, Storage};

impl Storage {
    pub async fn replace_task_triggers(
        &self,
        user_id: &str,
        records: &[Value],
    ) -> anyhow::Result<()> {
        self.initialize().await?;
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM task_triggers WHERE user_id = ?")
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        for record in records {
            insert_task_trigger_record(&mut tx, user_id, record).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn upsert_task_trigger(&self, user_id: &str, record: &Value) -> anyhow::Result<()> {
        self.initialize().await?;
        let Some(trigger_id) = record.get("trigger_id").and_then(Value::as_str) else {
            anyhow::bail!("task trigger record missing trigger_id");
        };
        sqlx::query(
            r#"
            INSERT INTO task_triggers (user_id, trigger_id, status, next_run_at, updated_at, record_json)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, trigger_id) DO UPDATE SET
                status = excluded.status,
                next_run_at = excluded.next_run_at,
                updated_at = excluded.updated_at,
                record_json = excluded.record_json
            "#,
        )
        .bind(user_id)
        .bind(trigger_id)
        .bind(record_str(record, "status"))
        .bind(record.get("next_run_at").and_then(Value::as_str))
        .bind(record_str(record, "updated_at"))
        .bind(json_text(record)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete_task_trigger(
        &self,
        user_id: &str,
        trigger_id: &str,
    ) -> anyhow::Result<bool> {
        self.initialize().await?;
        let result = sqlx::query("DELETE FROM task_triggers WHERE user_id = ? AND trigger_id = ?")
            .bind(user_id)
            .bind(trigger_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn list_task_triggers(&self, user_id: &str) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        let rows = sqlx::query(
            "SELECT record_json FROM task_triggers WHERE user_id = ? ORDER BY next_run_at ASC, updated_at DESC",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
            .collect()
    }

    pub async fn list_task_trigger_user_ids(&self) -> anyhow::Result<Vec<String>> {
        self.initialize().await?;
        let rows = sqlx::query("SELECT DISTINCT user_id FROM task_triggers ORDER BY user_id ASC")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .into_iter()
            .map(|row| row.get::<String, _>("user_id"))
            .collect())
    }
}

async fn insert_task_trigger_record(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    user_id: &str,
    record: &Value,
) -> anyhow::Result<()> {
    let Some(trigger_id) = record.get("trigger_id").and_then(Value::as_str) else {
        anyhow::bail!("task trigger record missing trigger_id");
    };
    sqlx::query(
        r#"
        INSERT INTO task_triggers (user_id, trigger_id, status, next_run_at, updated_at, record_json)
        VALUES (?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(user_id)
    .bind(trigger_id)
    .bind(record_str(record, "status"))
    .bind(record.get("next_run_at").and_then(Value::as_str))
    .bind(record_str(record, "updated_at"))
    .bind(json_text(record)?)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
