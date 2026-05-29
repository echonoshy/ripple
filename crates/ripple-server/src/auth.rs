use anyhow::Context;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use rand_core::OsRng;
use serde::Serialize;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::storage::{
    sha256_hex, AuthInviteClaim, AuthSessionCreate, AuthSessionRecord, AuthUserRecord, Storage,
};

const INVITE_PREFIX: &str = "rip_inv_";
const SESSION_PREFIX: &str = "rip_usr_";

#[derive(Debug, Clone, Serialize)]
pub struct AuthToken {
    pub token: String,
    pub token_type: String,
    pub user_id: String,
    pub login: String,
    pub display_name: Option<String>,
    pub expires_at: String,
}

pub fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

pub fn future_iso_seconds(seconds: u64) -> String {
    let seconds = i64::try_from(seconds).unwrap_or(i64::MAX);
    (OffsetDateTime::now_utc() + Duration::seconds(seconds))
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

pub fn future_iso_days(days: u64) -> String {
    let days = i64::try_from(days).unwrap_or(i64::MAX / 86_400);
    (OffsetDateTime::now_utc() + Duration::days(days))
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

pub fn new_invite_code() -> String {
    format!(
        "{}{}{}",
        INVITE_PREFIX,
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

pub fn new_session_token() -> String {
    format!(
        "{}{}{}",
        SESSION_PREFIX,
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

pub fn new_user_id() -> String {
    format!("usr_{}", Uuid::new_v4().simple())
}

pub fn hash_secret(secret: &str) -> String {
    sha256_hex(secret.as_bytes())
}

pub fn normalize_login(login: &str) -> String {
    login.trim().to_ascii_lowercase()
}

pub fn validate_login(login: &str) -> Result<String, String> {
    let trimmed = login.trim();
    if trimmed.len() < 3 || trimmed.len() > 120 {
        return Err("login must be 3-120 characters".to_string());
    }
    if !trimmed
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'+' | b'@'))
    {
        return Err(
            "login can only contain letters, numbers, dot, underscore, dash, plus, or @"
                .to_string(),
        );
    }
    Ok(trimmed.to_string())
}

pub fn validate_password(password: &str) -> Result<(), String> {
    if password.len() < 8 {
        return Err("password must be at least 8 characters".to_string());
    }
    if password.len() > 256 {
        return Err("password must be at most 256 characters".to_string());
    }
    Ok(())
}

pub fn hash_password(password: &str) -> anyhow::Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    Ok(Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|err| anyhow::anyhow!("failed to hash password: {err}"))?
        .to_string())
}

pub fn verify_password(password: &str, password_hash: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(password_hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

pub async fn claim_invite(
    storage: &Storage,
    invite_code: &str,
    login: &str,
    password: &str,
    display_name: Option<String>,
    session_ttl_seconds: u64,
    user_agent: Option<String>,
) -> anyhow::Result<AuthToken> {
    let login = validate_login(login).map_err(anyhow::Error::msg)?;
    validate_password(password).map_err(anyhow::Error::msg)?;
    let normalized = normalize_login(&login);
    let password_hash = hash_password(password)?;
    let now = now_iso();
    let user = storage
        .claim_auth_invite(&AuthInviteClaim {
            code_hash: hash_secret(invite_code.trim()),
            user_id: new_user_id(),
            login,
            login_normalized: normalized,
            password_hash,
            display_name,
            now,
        })
        .await?;
    create_session_for_user(storage, &user, session_ttl_seconds, user_agent).await
}

pub async fn login(
    storage: &Storage,
    login: &str,
    password: &str,
    session_ttl_seconds: u64,
    user_agent: Option<String>,
) -> anyhow::Result<Option<AuthToken>> {
    let login = validate_login(login).map_err(anyhow::Error::msg)?;
    let normalized = normalize_login(&login);
    let Some(user) = storage.auth_user_by_login(&normalized).await? else {
        return Ok(None);
    };
    if user.status != "active" || !verify_password(password, &user.password_hash) {
        return Ok(None);
    }
    Ok(Some(
        create_session_for_user(storage, &user, session_ttl_seconds, user_agent).await?,
    ))
}

pub async fn create_session_for_user(
    storage: &Storage,
    user: &AuthUserRecord,
    session_ttl_seconds: u64,
    user_agent: Option<String>,
) -> anyhow::Result<AuthToken> {
    let token = new_session_token();
    let expires_at = future_iso_seconds(session_ttl_seconds.max(60));
    storage
        .create_auth_session(&AuthSessionCreate {
            session_id: format!("aus_{}", Uuid::new_v4().simple()),
            user_id: user.user_id.clone(),
            token_hash: hash_secret(&token),
            created_at: now_iso(),
            expires_at: expires_at.clone(),
            user_agent,
        })
        .await
        .context("failed to create auth session")?;
    Ok(AuthToken {
        token,
        token_type: "bearer".to_string(),
        user_id: user.user_id.clone(),
        login: user.login.clone(),
        display_name: user.display_name.clone(),
        expires_at,
    })
}

pub async fn authenticate_session_token(
    storage: &Storage,
    token: &str,
) -> anyhow::Result<Option<AuthSessionRecord>> {
    storage
        .authenticate_auth_session(&hash_secret(token.trim()), &now_iso())
        .await
}
