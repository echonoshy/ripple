use sqlx::Row;

use super::Storage;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoogleOAuthTransactionRecord {
    pub state_hash: String,
    pub user_id: String,
    pub session_id: Option<String>,
    pub resume_mode: String,
    pub redirect_uri: String,
    pub status: String,
    pub failure_stage: Option<String>,
    pub failure_message: Option<String>,
    pub expires_at: u64,
}

impl Storage {
    pub async fn create_google_oauth_transaction(
        &self,
        record: &GoogleOAuthTransactionRecord,
    ) -> anyhow::Result<()> {
        self.initialize().await?;
        let now = crate::auth::now_iso();
        sqlx::query(
            "DELETE FROM google_oauth_transactions WHERE expires_at < CAST(strftime('%s', 'now') AS INTEGER)",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r#"
            INSERT INTO google_oauth_transactions (
                state_hash, user_id, session_id, resume_mode, redirect_uri, status,
                failure_stage, failure_message, expires_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&record.state_hash)
        .bind(&record.user_id)
        .bind(&record.session_id)
        .bind(&record.resume_mode)
        .bind(&record.redirect_uri)
        .bind(&record.status)
        .bind(&record.failure_stage)
        .bind(&record.failure_message)
        .bind(i64::try_from(record.expires_at).unwrap_or(i64::MAX))
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn claim_google_oauth_transaction(
        &self,
        state_hash: &str,
        now_epoch_seconds: u64,
    ) -> anyhow::Result<Option<GoogleOAuthTransactionRecord>> {
        self.initialize().await?;
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            r#"
            SELECT state_hash, user_id, session_id, resume_mode, redirect_uri, status,
                   failure_stage, failure_message, expires_at
            FROM google_oauth_transactions
            WHERE state_hash = ? AND status = 'pending' AND expires_at >= ?
            "#,
        )
        .bind(state_hash)
        .bind(i64::try_from(now_epoch_seconds).unwrap_or(i64::MAX))
        .fetch_optional(&mut *tx)
        .await?;
        let Some(row) = row else {
            tx.commit().await?;
            return Ok(None);
        };
        let updated = sqlx::query(
            "UPDATE google_oauth_transactions SET status = 'processing', updated_at = ? WHERE state_hash = ? AND status = 'pending'",
        )
        .bind(crate::auth::now_iso())
        .bind(state_hash)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            tx.commit().await?;
            return Ok(None);
        }
        let record = google_oauth_transaction_from_row(row)?;
        tx.commit().await?;
        Ok(Some(record))
    }

    pub async fn google_oauth_transaction(
        &self,
        state_hash: &str,
        user_id: &str,
    ) -> anyhow::Result<Option<GoogleOAuthTransactionRecord>> {
        self.initialize().await?;
        let row = sqlx::query(
            r#"
            SELECT state_hash, user_id, session_id, resume_mode, redirect_uri, status,
                   failure_stage, failure_message, expires_at
            FROM google_oauth_transactions
            WHERE state_hash = ? AND user_id = ?
            "#,
        )
        .bind(state_hash)
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(google_oauth_transaction_from_row).transpose()
    }

    pub async fn finish_google_oauth_transaction(
        &self,
        state_hash: &str,
        status: &str,
        failure_stage: Option<&str>,
        failure_message: Option<&str>,
    ) -> anyhow::Result<bool> {
        self.initialize().await?;
        let result = sqlx::query(
            r#"
            UPDATE google_oauth_transactions
            SET status = ?, failure_stage = ?, failure_message = ?, updated_at = ?
            WHERE state_hash = ? AND status = 'processing'
            "#,
        )
        .bind(status)
        .bind(failure_stage)
        .bind(failure_message)
        .bind(crate::auth::now_iso())
        .bind(state_hash)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn cancel_google_oauth_transactions_for_user(
        &self,
        user_id: &str,
    ) -> anyhow::Result<u64> {
        self.initialize().await?;
        let result = sqlx::query(
            r#"
            UPDATE google_oauth_transactions
            SET status = 'cancelled', failure_stage = 'auth_failed',
                failure_message = 'Google Workspace authorization was cancelled.', updated_at = ?
            WHERE user_id = ? AND status IN ('pending', 'processing')
            "#,
        )
        .bind(crate::auth::now_iso())
        .bind(user_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }
}

fn google_oauth_transaction_from_row(
    row: sqlx::sqlite::SqliteRow,
) -> anyhow::Result<GoogleOAuthTransactionRecord> {
    let expires_at = row.get::<i64, _>("expires_at");
    Ok(GoogleOAuthTransactionRecord {
        state_hash: row.get("state_hash"),
        user_id: row.get("user_id"),
        session_id: row.get("session_id"),
        resume_mode: row.get("resume_mode"),
        redirect_uri: row.get("redirect_uri"),
        status: row.get("status"),
        failure_stage: row.get("failure_stage"),
        failure_message: row.get("failure_message"),
        expires_at: u64::try_from(expires_at).unwrap_or(0),
    })
}
