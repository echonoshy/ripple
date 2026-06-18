use serde_json::Value;
use sqlx::Row;

use super::{i64_to_u64, json_from_text, json_text, record_str, Storage};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunUsageStats {
    pub runs_today: u64,
    pub active_runs: u64,
}

impl Storage {
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
        let task_trigger_id = record.get("task_trigger_id").and_then(Value::as_str);
        let events_file = record.get("events_file").and_then(Value::as_str);
        let output_file = record.get("output_file").and_then(Value::as_str);
        sqlx::query(
            r#"
            INSERT INTO jobs (
                job_id, user_id, session_id, provider, status, created_at, updated_at,
                task_trigger_id, events_file, output_file, record_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(job_id) DO UPDATE SET
                user_id = excluded.user_id,
                session_id = excluded.session_id,
                provider = excluded.provider,
                status = excluded.status,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                task_trigger_id = excluded.task_trigger_id,
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
        .bind(task_trigger_id)
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

    pub async fn list_active_jobs(&self) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        let rows = sqlx::query(
            "SELECT record_json FROM jobs WHERE status IN ('queued', 'running') ORDER BY updated_at DESC",
        )
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

    pub async fn delete_job_for_user(&self, user_id: &str, job_id: &str) -> anyhow::Result<bool> {
        self.initialize().await?;
        let result = sqlx::query("DELETE FROM jobs WHERE user_id = ? AND job_id = ?")
            .bind(user_id)
            .bind(job_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn list_jobs_for_task_trigger(
        &self,
        user_id: &str,
        task_trigger_id: &str,
    ) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        let rows = sqlx::query(
            r#"
            SELECT record_json FROM jobs
            WHERE user_id = ? AND task_trigger_id = ?
            ORDER BY updated_at DESC
            "#,
        )
        .bind(user_id)
        .bind(task_trigger_id)
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
}
