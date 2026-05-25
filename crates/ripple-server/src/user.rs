use axum::http::HeaderMap;
use serde::Serialize;
use serde_json::{json, Value};

pub const DEFAULT_USER_ID: &str = "default";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum AuthKind {
    Open,
    Service,
}

impl AuthKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Service => "service",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthContext {
    pub kind: AuthKind,
    pub effective_user_id: String,
}

impl AuthContext {
    pub fn open(effective_user_id: String) -> Self {
        Self {
            kind: AuthKind::Open,
            effective_user_id,
        }
    }

    pub fn service(effective_user_id: String) -> Self {
        Self {
            kind: AuthKind::Service,
            effective_user_id,
        }
    }

    pub fn public_json(&self) -> Value {
        json!({
            "kind": self.kind.as_str(),
            "effective_user_id": self.effective_user_id.clone(),
        })
    }
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
