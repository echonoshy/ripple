use serde_json::{json, Value};
use sqlx::Row;

use super::{json_from_text, json_text, Storage};

impl Storage {
    pub async fn create_prepared_feishu_mail(&self, record: &Value) -> anyhow::Result<()> {
        self.initialize().await?;
        let prepared_mail_id = required_string(record, "prepared_mail_id")?;
        let user_id = required_string(record, "user_id")?;
        let session_id = required_string(record, "session_id")?;
        let status = required_string(record, "status")?;
        let created_at = required_string(record, "created_at")?;
        let updated_at = required_string(record, "updated_at")?;
        sqlx::query(
            r#"
            INSERT INTO prepared_feishu_mails (
                prepared_mail_id, user_id, session_id, status, created_at, updated_at, record_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(prepared_mail_id)
        .bind(user_id)
        .bind(session_id)
        .bind(status)
        .bind(created_at)
        .bind(updated_at)
        .bind(json_text(record)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_prepared_feishu_mail(
        &self,
        user_id: &str,
        session_id: &str,
        prepared_mail_id: &str,
    ) -> anyhow::Result<Option<Value>> {
        self.initialize().await?;
        sqlx::query(
            r#"
            SELECT status, record_json FROM prepared_feishu_mails
            WHERE user_id = ? AND session_id = ? AND prepared_mail_id = ?
            "#,
        )
        .bind(user_id)
        .bind(session_id)
        .bind(prepared_mail_id)
        .fetch_optional(&self.pool)
        .await?
        .map(|row| {
            let mut record = json_from_text(row.get::<String, _>("record_json").as_str())?;
            record["status"] = json!(row.get::<String, _>("status"));
            Ok(record)
        })
        .transpose()
    }

    /// Atomically marks a prepared mail as sending. A returned record whose status is not
    /// `sending` was already claimed or completed, and must never be sent again automatically.
    pub async fn claim_prepared_feishu_mail_for_send(
        &self,
        user_id: &str,
        session_id: &str,
        prepared_mail_id: &str,
        updated_at: &str,
    ) -> anyhow::Result<Option<Value>> {
        self.initialize().await?;
        let changed = sqlx::query(
            r#"
            UPDATE prepared_feishu_mails
            SET status = 'sending', updated_at = ?
            WHERE user_id = ? AND session_id = ? AND prepared_mail_id = ? AND status = 'prepared'
            "#,
        )
        .bind(updated_at)
        .bind(user_id)
        .bind(session_id)
        .bind(prepared_mail_id)
        .execute(&self.pool)
        .await?
        .rows_affected();
        let Some(mut record) = self
            .get_prepared_feishu_mail(user_id, session_id, prepared_mail_id)
            .await?
        else {
            return Ok(None);
        };
        if changed > 0 {
            record["status"] = json!("sending");
            record["updated_at"] = json!(updated_at);
            self.save_prepared_feishu_mail(&record).await?;
        }
        Ok(Some(record))
    }

    pub async fn save_prepared_feishu_mail(&self, record: &Value) -> anyhow::Result<()> {
        self.initialize().await?;
        let prepared_mail_id = required_string(record, "prepared_mail_id")?;
        let user_id = required_string(record, "user_id")?;
        let session_id = required_string(record, "session_id")?;
        let status = required_string(record, "status")?;
        let updated_at = required_string(record, "updated_at")?;
        let result = sqlx::query(
            r#"
            UPDATE prepared_feishu_mails
            SET status = ?, updated_at = ?, record_json = ?
            WHERE user_id = ? AND session_id = ? AND prepared_mail_id = ?
            "#,
        )
        .bind(status)
        .bind(updated_at)
        .bind(json_text(record)?)
        .bind(user_id)
        .bind(session_id)
        .bind(prepared_mail_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            anyhow::bail!("prepared Feishu mail was not found");
        }
        Ok(())
    }
}

fn required_string<'a>(record: &'a Value, field: &str) -> anyhow::Result<&'a str> {
    record
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("prepared Feishu mail missing {field}"))
}
