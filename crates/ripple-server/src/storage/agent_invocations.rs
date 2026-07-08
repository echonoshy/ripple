use serde_json::Value;
use sqlx::Row;

use super::{json_from_text, json_text, record_str, Storage};

impl Storage {
    pub async fn upsert_agent_invocation(&self, record: &Value) -> anyhow::Result<()> {
        self.initialize().await?;
        let Some(invocation_id) = record.get("invocation_id").and_then(Value::as_str) else {
            anyhow::bail!("agent invocation record missing invocation_id");
        };
        sqlx::query(
            r#"
            INSERT INTO agent_invocations (
                invocation_id, conversation_id, request_message_id, requester_user_id,
                target_user_id, status, created_at, updated_at, approved_at, completed_at,
                target_session_id, target_job_id, record_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(invocation_id) DO UPDATE SET
                conversation_id = excluded.conversation_id,
                request_message_id = excluded.request_message_id,
                requester_user_id = excluded.requester_user_id,
                target_user_id = excluded.target_user_id,
                status = excluded.status,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                approved_at = excluded.approved_at,
                completed_at = excluded.completed_at,
                target_session_id = excluded.target_session_id,
                target_job_id = excluded.target_job_id,
                record_json = excluded.record_json
            "#,
        )
        .bind(invocation_id)
        .bind(record_str(record, "conversation_id"))
        .bind(record.get("request_message_id").and_then(Value::as_str))
        .bind(record_str(record, "requester_user_id"))
        .bind(record_str(record, "target_user_id"))
        .bind(record_str(record, "status"))
        .bind(record_str(record, "created_at"))
        .bind(record_str(record, "updated_at"))
        .bind(record.get("approved_at").and_then(Value::as_str))
        .bind(record.get("completed_at").and_then(Value::as_str))
        .bind(record.get("target_session_id").and_then(Value::as_str))
        .bind(record.get("target_job_id").and_then(Value::as_str))
        .bind(json_text(record)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_agent_invocation(&self, invocation_id: &str) -> anyhow::Result<Option<Value>> {
        self.initialize().await?;
        sqlx::query(
            r#"
            SELECT record_json FROM agent_invocations
            WHERE invocation_id = ?
            "#,
        )
        .bind(invocation_id)
        .fetch_optional(&self.pool)
        .await?
        .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
        .transpose()
    }

    pub async fn list_agent_invocations_for_conversation(
        &self,
        conversation_id: &str,
    ) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        let rows = sqlx::query(
            r#"
            SELECT record_json FROM agent_invocations
            WHERE conversation_id = ?
            ORDER BY updated_at DESC, invocation_id ASC
            "#,
        )
        .bind(conversation_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
            .collect()
    }
}
