use serde_json::Value;
use sqlx::Row;

use super::{json_from_text, json_text, record_str, Storage};

impl Storage {
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
