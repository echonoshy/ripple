use serde_json::{json, Value};
use sqlx::Row;

use super::{json_from_text, json_text, record_str, Storage};

impl Storage {
    pub async fn upsert_agent_delegation(&self, record: &Value) -> anyhow::Result<()> {
        self.initialize().await?;
        let Some(delegation_id) = record.get("delegation_id").and_then(Value::as_str) else {
            anyhow::bail!("agent delegation record missing delegation_id");
        };
        sqlx::query(
            r#"
            INSERT INTO agent_delegations (
                delegation_id,
                requester_user_id,
                requester_session_id,
                target_user_id,
                target_session_id,
                target_job_id,
                status,
                task_title,
                created_at,
                updated_at,
                accepted_at,
                completed_at,
                record_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(delegation_id) DO UPDATE SET
                requester_user_id = excluded.requester_user_id,
                requester_session_id = excluded.requester_session_id,
                target_user_id = excluded.target_user_id,
                target_session_id = excluded.target_session_id,
                target_job_id = excluded.target_job_id,
                status = excluded.status,
                task_title = excluded.task_title,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                accepted_at = excluded.accepted_at,
                completed_at = excluded.completed_at,
                record_json = excluded.record_json
            "#,
        )
        .bind(delegation_id)
        .bind(record_str(record, "requester_user_id"))
        .bind(record_str(record, "requester_session_id"))
        .bind(record_str(record, "target_user_id"))
        .bind(record.get("target_session_id").and_then(Value::as_str))
        .bind(record.get("target_job_id").and_then(Value::as_str))
        .bind(record_str(record, "status"))
        .bind(record_str(record, "task_title"))
        .bind(record_str(record, "created_at"))
        .bind(record_str(record, "updated_at"))
        .bind(record.get("accepted_at").and_then(Value::as_str))
        .bind(record.get("completed_at").and_then(Value::as_str))
        .bind(json_text(record)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_agent_delegations_for_requester(
        &self,
        requester_user_id: &str,
    ) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        let rows = sqlx::query(
            r#"
            SELECT record_json FROM agent_delegations
            WHERE requester_user_id = ?
            ORDER BY updated_at DESC
            "#,
        )
        .bind(requester_user_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
            .collect()
    }

    pub async fn get_agent_delegation(&self, delegation_id: &str) -> anyhow::Result<Option<Value>> {
        self.initialize().await?;
        sqlx::query(
            r#"
            SELECT record_json FROM agent_delegations
            WHERE delegation_id = ?
            "#,
        )
        .bind(delegation_id)
        .fetch_optional(&self.pool)
        .await?
        .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
        .transpose()
    }

    pub async fn list_agent_delegations_for_target(
        &self,
        target_user_id: &str,
    ) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        let rows = sqlx::query(
            r#"
            SELECT record_json FROM agent_delegations
            WHERE target_user_id = ?
            ORDER BY updated_at DESC
            "#,
        )
        .bind(target_user_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
            .collect()
    }

    pub async fn append_agent_delegation_event(
        &self,
        delegation_id: &str,
        event_type: &str,
        actor_user_id: Option<&str>,
        payload: &Value,
    ) -> anyhow::Result<Value> {
        self.initialize().await?;
        let row = sqlx::query(
            r#"
            SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
            FROM agent_delegation_events
            WHERE delegation_id = ?
            "#,
        )
        .bind(delegation_id)
        .fetch_one(&self.pool)
        .await?;
        let seq = row.get::<i64, _>("next_seq");
        let created_at = agent_delegation_now_iso();
        let record = json!({
            "delegation_id": delegation_id,
            "seq": seq,
            "event_type": event_type,
            "actor_user_id": actor_user_id,
            "created_at": created_at,
            "payload": payload
        });
        sqlx::query(
            r#"
            INSERT INTO agent_delegation_events (
                delegation_id,
                seq,
                event_type,
                actor_user_id,
                created_at,
                record_json
            )
            VALUES (?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(delegation_id)
        .bind(seq)
        .bind(event_type)
        .bind(actor_user_id)
        .bind(created_at)
        .bind(json_text(&record)?)
        .execute(&self.pool)
        .await?;
        Ok(record)
    }

    pub async fn list_agent_delegation_events(
        &self,
        delegation_id: &str,
    ) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        let rows = sqlx::query(
            r#"
            SELECT record_json FROM agent_delegation_events
            WHERE delegation_id = ?
            ORDER BY seq ASC
            "#,
        )
        .bind(delegation_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
            .collect()
    }
}

fn agent_delegation_now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}
