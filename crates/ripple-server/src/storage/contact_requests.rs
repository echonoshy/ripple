use serde_json::{json, Value};
use sqlx::Row;

use super::{json_from_text, json_text, record_str, Storage};

impl Storage {
    pub async fn upsert_contact_request(&self, record: &Value) -> anyhow::Result<()> {
        self.initialize().await?;
        let Some(request_id) = record.get("request_id").and_then(Value::as_str) else {
            anyhow::bail!("contact request record missing request_id");
        };
        sqlx::query(
            r#"
            INSERT INTO contact_requests (
                request_id,
                requester_user_id,
                target_user_id,
                status,
                created_at,
                updated_at,
                completed_at,
                record_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(request_id) DO UPDATE SET
                requester_user_id = excluded.requester_user_id,
                target_user_id = excluded.target_user_id,
                status = excluded.status,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                completed_at = excluded.completed_at,
                record_json = excluded.record_json
            "#,
        )
        .bind(request_id)
        .bind(record_str(record, "requester_user_id"))
        .bind(record_str(record, "target_user_id"))
        .bind(record_str(record, "status"))
        .bind(record_str(record, "created_at"))
        .bind(record_str(record, "updated_at"))
        .bind(record.get("completed_at").and_then(Value::as_str))
        .bind(json_text(record)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_contact_request(&self, request_id: &str) -> anyhow::Result<Option<Value>> {
        self.initialize().await?;
        sqlx::query(
            r#"
            SELECT record_json FROM contact_requests
            WHERE request_id = ?
            "#,
        )
        .bind(request_id)
        .fetch_optional(&self.pool)
        .await?
        .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
        .transpose()
    }

    pub async fn list_contact_requests_for_requester(
        &self,
        requester_user_id: &str,
    ) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        let rows = sqlx::query(
            r#"
            SELECT record_json FROM contact_requests
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

    pub async fn list_contact_requests_for_target(
        &self,
        target_user_id: &str,
    ) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        let rows = sqlx::query(
            r#"
            SELECT record_json FROM contact_requests
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

    pub async fn accept_contact_request_bidirectional(
        &self,
        request_id: &str,
        target_user_id: &str,
    ) -> anyhow::Result<Option<Value>> {
        let mut record = match self.get_contact_request(request_id).await? {
            Some(record) => record,
            None => return Ok(None),
        };
        let requester_user_id = record_str(&record, "requester_user_id").to_string();
        let record_target_user_id = record_str(&record, "target_user_id");
        let status = record_str(&record, "status");
        if record_target_user_id != target_user_id || status != "pending" {
            return Ok(None);
        }

        let now = contact_request_now_iso();
        set_field(&mut record, "status", json!("accepted"));
        set_field(&mut record, "updated_at", json!(now));
        set_field(&mut record, "completed_at", json!(now));
        self.upsert_contact_request(&record).await?;
        self.upsert_contact(&requester_user_id, target_user_id, None)
            .await?;
        self.upsert_contact(target_user_id, &requester_user_id, None)
            .await?;
        Ok(Some(record))
    }

    pub async fn reject_contact_request(
        &self,
        request_id: &str,
        target_user_id: &str,
        reason: Option<&str>,
    ) -> anyhow::Result<Option<Value>> {
        let mut record = match self.get_contact_request(request_id).await? {
            Some(record) => record,
            None => return Ok(None),
        };
        let record_target_user_id = record_str(&record, "target_user_id");
        let status = record_str(&record, "status");
        if record_target_user_id != target_user_id || status != "pending" {
            return Ok(None);
        }

        let now = contact_request_now_iso();
        set_field(&mut record, "status", json!("rejected"));
        set_field(&mut record, "updated_at", json!(now));
        set_field(&mut record, "completed_at", json!(now));
        if let Some(reason) = reason.filter(|value| !value.trim().is_empty()) {
            set_field(&mut record, "reason", json!(reason.trim()));
        }
        self.upsert_contact_request(&record).await?;
        Ok(Some(record))
    }
}

fn set_field(record: &mut Value, key: &str, value: Value) {
    if let Some(object) = record.as_object_mut() {
        object.insert(key.to_string(), value);
    }
}

fn contact_request_now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}
