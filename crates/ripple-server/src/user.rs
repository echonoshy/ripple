use axum::http::HeaderMap;
use serde::Serialize;
use serde_json::{json, Value};

use crate::storage::{ApiKeyKind, ApiKeyRecord};

pub const DEFAULT_USER_ID: &str = "default";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum AuthKind {
    Open,
    LocalUser,
    TrustedClient,
    Admin,
}

impl AuthKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::LocalUser => "local_user",
            Self::TrustedClient => "trusted_client",
            Self::Admin => "admin",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthContext {
    pub kind: AuthKind,
    pub key_id: Option<String>,
    pub user_id: Option<String>,
    pub effective_user_id: String,
    pub display_name: Option<String>,
    pub bootstrap: bool,
}

impl AuthContext {
    pub fn open(effective_user_id: String) -> Self {
        Self {
            kind: AuthKind::Open,
            key_id: None,
            user_id: None,
            effective_user_id,
            display_name: None,
            bootstrap: false,
        }
    }

    pub fn bootstrap_admin(effective_user_id: String) -> Self {
        Self {
            kind: AuthKind::Admin,
            key_id: None,
            user_id: None,
            effective_user_id,
            display_name: Some("bootstrap admin".to_string()),
            bootstrap: true,
        }
    }

    pub fn from_api_key_record(
        record: ApiKeyRecord,
        headers: &HeaderMap,
    ) -> Result<Self, AuthUserError> {
        if record.revoked_at.is_some() {
            return Err(AuthUserError::Revoked);
        }
        let kind = match record.kind {
            ApiKeyKind::LocalUser => AuthKind::LocalUser,
            ApiKeyKind::TrustedClient => AuthKind::TrustedClient,
            ApiKeyKind::Admin => AuthKind::Admin,
        };
        let effective_user_id = match kind {
            AuthKind::LocalUser => {
                let Some(bound_user_id) = record.user_id.as_deref() else {
                    return Err(AuthUserError::InvalidUser(
                        "local_user API key is missing user_id".to_string(),
                    ));
                };
                validate_user_id(bound_user_id).map_err(AuthUserError::InvalidUser)?;
                if let Some(header_user_id) = header_user_id(headers) {
                    let header_user_id = header_user_id.map_err(AuthUserError::InvalidUser)?;
                    if header_user_id != bound_user_id {
                        return Err(AuthUserError::UserMismatch {
                            expected: bound_user_id.to_string(),
                            supplied: header_user_id,
                        });
                    }
                }
                bound_user_id.to_string()
            }
            AuthKind::TrustedClient | AuthKind::Admin | AuthKind::Open => {
                user_id_from_headers(headers).map_err(AuthUserError::InvalidUser)?
            }
        };
        Ok(Self {
            kind,
            key_id: Some(record.key_id),
            user_id: record.user_id,
            effective_user_id,
            display_name: record.display_name,
            bootstrap: false,
        })
    }

    pub fn is_admin(&self) -> bool {
        self.kind == AuthKind::Admin
    }

    pub fn public_json(&self) -> Value {
        json!({
            "kind": self.kind.as_str(),
            "key_id": self.key_id.clone(),
            "user_id": self.user_id.clone(),
            "effective_user_id": self.effective_user_id.clone(),
            "display_name": self.display_name.clone(),
            "bootstrap": self.bootstrap
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthUserError {
    InvalidUser(String),
    UserMismatch { expected: String, supplied: String },
    Revoked,
}

pub fn user_id_from_headers(headers: &HeaderMap) -> Result<String, String> {
    let value = headers
        .get("x-ripple-user-id")
        .and_then(|raw| raw.to_str().ok())
        .unwrap_or(DEFAULT_USER_ID)
        .trim();
    validate_user_id(value).map(|_| value.to_string())
}

pub fn validate_user_id(user_id: &str) -> Result<(), String> {
    if user_id.is_empty() || user_id.len() > 64 {
        return Err("user_id must be 1-64 characters".to_string());
    }
    if user_id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        Ok(())
    } else {
        Err("user_id must match ^[a-zA-Z0-9_-]{1,64}$".to_string())
    }
}

pub fn header_user_id(headers: &HeaderMap) -> Option<Result<String, String>> {
    headers.get("x-ripple-user-id").map(|raw| {
        raw.to_str()
            .map(str::trim)
            .map(str::to_string)
            .map_err(|_| "user_id header must be valid UTF-8".to_string())
            .and_then(|value| validate_user_id(&value).map(|_| value))
    })
}
