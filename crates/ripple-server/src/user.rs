use axum::http::HeaderMap;

pub const DEFAULT_USER_ID: &str = "default";

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
