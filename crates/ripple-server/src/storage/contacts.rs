use serde_json::{json, Value};
use sqlx::Row;

use super::{json_from_text, json_text, Storage};

impl Storage {
    pub async fn upsert_contact(
        &self,
        owner_user_id: &str,
        contact_user_id: &str,
        remark: Option<&str>,
    ) -> anyhow::Result<Value> {
        self.initialize().await?;
        let now = contact_now_iso();
        let existing = self.get_contact(owner_user_id, contact_user_id).await?;
        let created_at = existing
            .as_ref()
            .and_then(|record| record.get("created_at"))
            .and_then(Value::as_str)
            .unwrap_or(now.as_str())
            .to_string();
        let remark = remark
            .map(str::to_string)
            .or_else(|| {
                existing
                    .as_ref()
                    .and_then(|record| record.get("remark"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_default();
        let record = json!({
            "owner_user_id": owner_user_id,
            "contact_user_id": contact_user_id,
            "remark": remark,
            "created_at": created_at,
            "updated_at": now
        });
        sqlx::query(
            r#"
            INSERT INTO contacts (
                owner_user_id,
                contact_user_id,
                created_at,
                updated_at,
                record_json
            )
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(owner_user_id, contact_user_id) DO UPDATE SET
                updated_at = excluded.updated_at,
                record_json = excluded.record_json
            "#,
        )
        .bind(owner_user_id)
        .bind(contact_user_id)
        .bind(record.get("created_at").and_then(Value::as_str))
        .bind(record.get("updated_at").and_then(Value::as_str))
        .bind(json_text(&record)?)
        .execute(&self.pool)
        .await?;
        Ok(record)
    }

    pub async fn update_contact_remark(
        &self,
        owner_user_id: &str,
        contact_user_id: &str,
        remark: &str,
    ) -> anyhow::Result<Option<Value>> {
        self.initialize().await?;
        let Some(existing) = self.get_contact(owner_user_id, contact_user_id).await? else {
            return Ok(None);
        };
        let now = contact_now_iso();
        let created_at = existing
            .get("created_at")
            .and_then(Value::as_str)
            .unwrap_or(now.as_str())
            .to_string();
        let record = json!({
            "owner_user_id": owner_user_id,
            "contact_user_id": contact_user_id,
            "remark": remark,
            "created_at": created_at,
            "updated_at": now
        });
        sqlx::query(
            r#"
            UPDATE contacts
            SET updated_at = ?, record_json = ?
            WHERE owner_user_id = ? AND contact_user_id = ?
            "#,
        )
        .bind(record.get("updated_at").and_then(Value::as_str))
        .bind(json_text(&record)?)
        .bind(owner_user_id)
        .bind(contact_user_id)
        .execute(&self.pool)
        .await?;
        Ok(Some(record))
    }

    pub async fn get_contact(
        &self,
        owner_user_id: &str,
        contact_user_id: &str,
    ) -> anyhow::Result<Option<Value>> {
        self.initialize().await?;
        sqlx::query(
            r#"
            SELECT record_json FROM contacts
            WHERE owner_user_id = ? AND contact_user_id = ?
            "#,
        )
        .bind(owner_user_id)
        .bind(contact_user_id)
        .fetch_optional(&self.pool)
        .await?
        .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
        .transpose()
    }

    pub async fn list_contacts(&self, owner_user_id: &str) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        let rows = sqlx::query(
            r#"
            SELECT record_json FROM contacts
            WHERE owner_user_id = ?
            ORDER BY updated_at DESC, contact_user_id ASC
            "#,
        )
        .bind(owner_user_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
            .collect()
    }

    pub async fn delete_contact(
        &self,
        owner_user_id: &str,
        contact_user_id: &str,
    ) -> anyhow::Result<bool> {
        self.initialize().await?;
        let result = sqlx::query(
            r#"
            DELETE FROM contacts
            WHERE owner_user_id = ? AND contact_user_id = ?
            "#,
        )
        .bind(owner_user_id)
        .bind(contact_user_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }
}

fn contact_now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}
