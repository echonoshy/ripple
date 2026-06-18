use serde::{Deserialize, Serialize};
use sqlx::Row;

use super::{i64_to_u64, u64_to_i64, Storage};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthInviteCreate {
    pub invite_id: String,
    pub code_hash: String,
    pub max_uses: u64,
    pub expires_at: Option<String>,
    pub created_by: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthInviteCreated {
    pub invite_id: String,
    pub code: String,
    pub max_uses: u64,
    pub expires_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthInviteClaim {
    pub code_hash: String,
    pub user_id: String,
    pub login: String,
    pub login_normalized: String,
    pub password_hash: String,
    pub display_name: Option<String>,
    pub now: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthUserRecord {
    pub user_id: String,
    pub login: String,
    pub login_normalized: String,
    pub password_hash: String,
    pub display_name: Option<String>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub disabled_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthSessionCreate {
    pub session_id: String,
    pub user_id: String,
    pub token_hash: String,
    pub created_at: String,
    pub expires_at: String,
    pub user_agent: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthSessionRecord {
    pub session_id: String,
    pub user_id: String,
    pub login: String,
    pub display_name: Option<String>,
    pub expires_at: String,
}

impl Storage {
    pub async fn create_auth_invite(&self, invite: &AuthInviteCreate) -> anyhow::Result<()> {
        self.initialize().await?;
        sqlx::query(
            r#"
            INSERT INTO auth_invites (
                invite_id, code_hash, max_uses, uses, expires_at, created_at, created_by
            )
            VALUES (?, ?, ?, 0, ?, ?, ?)
            "#,
        )
        .bind(&invite.invite_id)
        .bind(&invite.code_hash)
        .bind(u64_to_i64(invite.max_uses.max(1))?)
        .bind(&invite.expires_at)
        .bind(&invite.created_at)
        .bind(&invite.created_by)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn create_user_auth_invite(
        &self,
        max_uses: u64,
        expires_days: Option<u64>,
        created_by: Option<&str>,
    ) -> anyhow::Result<AuthInviteCreated> {
        let now = crate::auth::now_iso();
        let code = crate::auth::new_invite_code();
        let expires_at = expires_days.map(|days| crate::auth::future_iso_days(days.max(1)));
        let invite = AuthInviteCreate {
            invite_id: format!("inv_{}", uuid::Uuid::new_v4().simple()),
            code_hash: crate::auth::hash_secret(&code),
            max_uses: max_uses.max(1),
            expires_at,
            created_by: created_by.map(str::to_string),
            created_at: now,
        };
        self.create_auth_invite(&invite).await?;
        Ok(AuthInviteCreated {
            invite_id: invite.invite_id,
            code,
            max_uses: invite.max_uses,
            expires_at: invite.expires_at,
            created_at: invite.created_at,
        })
    }

    pub async fn claim_auth_invite(
        &self,
        claim: &AuthInviteClaim,
    ) -> anyhow::Result<AuthUserRecord> {
        self.initialize().await?;
        let mut tx = self.pool.begin().await?;
        let invite = sqlx::query(
            r#"
            SELECT invite_id, max_uses, uses, expires_at
            FROM auth_invites
            WHERE code_hash = ? AND disabled_at IS NULL
            "#,
        )
        .bind(&claim.code_hash)
        .fetch_optional(&mut *tx)
        .await?;

        let Some(invite) = invite else {
            anyhow::bail!("invalid or expired invite code");
        };
        let invite_id = invite.get::<String, _>("invite_id");
        let max_uses = i64_to_u64(invite.get::<i64, _>("max_uses"))?;
        let uses = i64_to_u64(invite.get::<i64, _>("uses"))?;
        if uses >= max_uses {
            anyhow::bail!("invite code has already been used");
        }
        if let Some(expires_at) = invite.get::<Option<String>, _>("expires_at") {
            if expires_at.as_str() <= claim.now.as_str() {
                anyhow::bail!("invite code has expired");
            }
        }
        let existing_login =
            sqlx::query("SELECT user_id FROM auth_users WHERE login_normalized = ?")
                .bind(&claim.login_normalized)
                .fetch_optional(&mut *tx)
                .await?;
        if existing_login.is_some() {
            anyhow::bail!("login is already registered");
        }

        sqlx::query(
            r#"
            INSERT INTO auth_users (
                user_id, login, login_normalized, password_hash, display_name,
                status, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
            "#,
        )
        .bind(&claim.user_id)
        .bind(&claim.login)
        .bind(&claim.login_normalized)
        .bind(&claim.password_hash)
        .bind(&claim.display_name)
        .bind(&claim.now)
        .bind(&claim.now)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE auth_invites SET uses = uses + 1 WHERE invite_id = ?")
            .bind(&invite_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;

        Ok(AuthUserRecord {
            user_id: claim.user_id.clone(),
            login: claim.login.clone(),
            login_normalized: claim.login_normalized.clone(),
            password_hash: claim.password_hash.clone(),
            display_name: claim.display_name.clone(),
            status: "active".to_string(),
            created_at: claim.now.clone(),
            updated_at: claim.now.clone(),
            disabled_at: None,
        })
    }

    pub async fn auth_user_by_login(
        &self,
        login_normalized: &str,
    ) -> anyhow::Result<Option<AuthUserRecord>> {
        self.initialize().await?;
        let row = sqlx::query(
            r#"
            SELECT user_id, login, login_normalized, password_hash, display_name,
                   status, created_at, updated_at, disabled_at
            FROM auth_users
            WHERE login_normalized = ?
            "#,
        )
        .bind(login_normalized)
        .fetch_optional(&self.pool)
        .await?;
        row.map(auth_user_from_row).transpose()
    }

    pub async fn auth_user_by_id(&self, user_id: &str) -> anyhow::Result<Option<AuthUserRecord>> {
        self.initialize().await?;
        let row = sqlx::query(
            r#"
            SELECT user_id, login, login_normalized, password_hash, display_name,
                   status, created_at, updated_at, disabled_at
            FROM auth_users
            WHERE user_id = ?
            "#,
        )
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(auth_user_from_row).transpose()
    }

    pub async fn update_auth_user_password(
        &self,
        user_id: &str,
        password_hash: &str,
    ) -> anyhow::Result<bool> {
        self.initialize().await?;
        let now = crate::auth::now_iso();
        let result = sqlx::query(
            r#"
            UPDATE auth_users
            SET password_hash = ?, updated_at = ?
            WHERE user_id = ? AND status = 'active'
            "#,
        )
        .bind(password_hash)
        .bind(&now)
        .bind(user_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn update_auth_user_display_name(
        &self,
        user_id: &str,
        display_name: Option<&str>,
    ) -> anyhow::Result<bool> {
        self.initialize().await?;
        let now = crate::auth::now_iso();
        let result = sqlx::query(
            r#"
            UPDATE auth_users
            SET display_name = ?, updated_at = ?
            WHERE user_id = ? AND status = 'active'
            "#,
        )
        .bind(display_name)
        .bind(&now)
        .bind(user_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn auth_user_by_identifier(
        &self,
        identifier: &str,
    ) -> anyhow::Result<Option<AuthUserRecord>> {
        self.initialize().await?;
        let normalized = crate::auth::normalize_login(identifier);
        let row = sqlx::query(
            r#"
            SELECT user_id, login, login_normalized, password_hash, display_name,
                   status, created_at, updated_at, disabled_at
            FROM auth_users
            WHERE user_id = ? OR login_normalized = ?
            "#,
        )
        .bind(identifier)
        .bind(normalized)
        .fetch_optional(&self.pool)
        .await?;
        row.map(auth_user_from_row).transpose()
    }

    pub async fn create_auth_session(&self, session: &AuthSessionCreate) -> anyhow::Result<()> {
        self.initialize().await?;
        sqlx::query(
            r#"
            INSERT INTO auth_sessions (
                session_id, user_id, token_hash, created_at, expires_at, last_seen_at, user_agent
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&session.session_id)
        .bind(&session.user_id)
        .bind(&session.token_hash)
        .bind(&session.created_at)
        .bind(&session.expires_at)
        .bind(&session.created_at)
        .bind(&session.user_agent)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn authenticate_auth_session(
        &self,
        token_hash: &str,
        now: &str,
    ) -> anyhow::Result<Option<AuthSessionRecord>> {
        self.initialize().await?;
        let row = sqlx::query(
            r#"
            SELECT s.session_id, s.user_id, s.expires_at, u.login, u.display_name
            FROM auth_sessions s
            JOIN auth_users u ON u.user_id = s.user_id
            WHERE s.token_hash = ?
              AND s.revoked_at IS NULL
              AND s.expires_at > ?
              AND u.status = 'active'
            "#,
        )
        .bind(token_hash)
        .bind(now)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let session = AuthSessionRecord {
            session_id: row.get("session_id"),
            user_id: row.get("user_id"),
            login: row.get("login"),
            display_name: row.get("display_name"),
            expires_at: row.get("expires_at"),
        };
        sqlx::query("UPDATE auth_sessions SET last_seen_at = ? WHERE session_id = ?")
            .bind(now)
            .bind(&session.session_id)
            .execute(&self.pool)
            .await?;
        Ok(Some(session))
    }

    pub async fn revoke_auth_session(&self, token_hash: &str) -> anyhow::Result<bool> {
        self.initialize().await?;
        let now = crate::auth::now_iso();
        let result = sqlx::query(
            "UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
        )
        .bind(now)
        .bind(token_hash)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn list_auth_users(&self) -> anyhow::Result<Vec<AuthUserRecord>> {
        self.initialize().await?;
        let rows = sqlx::query(
            r#"
            SELECT user_id, login, login_normalized, password_hash, display_name,
                   status, created_at, updated_at, disabled_at
            FROM auth_users
            ORDER BY created_at DESC
            "#,
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(auth_user_from_row).collect()
    }

    pub async fn disable_auth_user(&self, identifier: &str) -> anyhow::Result<bool> {
        self.initialize().await?;
        let Some(user) = self.auth_user_by_identifier(identifier).await? else {
            return Ok(false);
        };
        let now = crate::auth::now_iso();
        let result = sqlx::query(
            r#"
            UPDATE auth_users
            SET status = 'disabled', disabled_at = ?, updated_at = ?
            WHERE user_id = ? AND status != 'disabled'
            "#,
        )
        .bind(&now)
        .bind(&now)
        .bind(&user.user_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn revoke_auth_sessions_for_user(&self, identifier: &str) -> anyhow::Result<u64> {
        self.initialize().await?;
        let Some(user) = self.auth_user_by_identifier(identifier).await? else {
            return Ok(0);
        };
        let now = crate::auth::now_iso();
        let result = sqlx::query(
            "UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
        )
        .bind(now)
        .bind(&user.user_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }
}

fn auth_user_from_row(row: sqlx::sqlite::SqliteRow) -> anyhow::Result<AuthUserRecord> {
    Ok(AuthUserRecord {
        user_id: row.get("user_id"),
        login: row.get("login"),
        login_normalized: row.get("login_normalized"),
        password_hash: row.get("password_hash"),
        display_name: row.get("display_name"),
        status: row.get("status"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        disabled_at: row.get("disabled_at"),
    })
}
