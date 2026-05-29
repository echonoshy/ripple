use serde_json::{Map, Value};

const REDACTED: &str = "[REDACTED]";
const TOKEN_PREFIXES: &[&str] = &["ntn_", "secret_", "xoxb-", "xoxp-"];
const ASSIGNMENT_MARKERS: &[&str] = &[
    "NOTION_API_TOKEN=",
    "GOG_KEYRING_PASSWORD=",
    "Authorization: Bearer ",
    "authorization: Bearer ",
    "SESSDATA=",
    "bili_jct=",
];
const SENSITIVE_KEY_PARTS: &[&str] = &[
    "token",
    "secret",
    "password",
    "cookie",
    "authorization",
    "api_key",
    "apikey",
];

pub fn redact_text(input: &str) -> String {
    let mut out = input.to_string();
    for prefix in TOKEN_PREFIXES {
        out = redact_prefixed_tokens(&out, prefix);
    }
    for marker in ASSIGNMENT_MARKERS {
        out = redact_assignment_values(&out, marker);
    }
    out
}

pub fn redact_value(value: &Value) -> Value {
    redact_value_with_key(value, None)
}

fn redact_value_with_key(value: &Value, key: Option<&str>) -> Value {
    if key.is_some_and(is_sensitive_key) {
        return Value::String(REDACTED.to_string());
    }
    match value {
        Value::String(text) => Value::String(redact_text(text)),
        Value::Array(values) => Value::Array(values.iter().map(redact_value).collect()),
        Value::Object(object) => {
            let mut redacted = Map::new();
            for (key, value) in object {
                redacted.insert(key.clone(), redact_value_with_key(value, Some(key)));
            }
            Value::Object(redacted)
        }
        _ => value.clone(),
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    if is_usage_metric_key(&key) {
        return false;
    }
    SENSITIVE_KEY_PARTS.iter().any(|part| key.contains(part))
}

fn is_usage_metric_key(key: &str) -> bool {
    matches!(
        key,
        "tokenusage"
            | "inputtokens"
            | "outputtokens"
            | "totaltokens"
            | "cachedinputtokens"
            | "reasoningoutputtokens"
    )
}

fn redact_prefixed_tokens(input: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(index) = rest.find(prefix) {
        out.push_str(&rest[..index]);
        out.push_str(prefix);
        out.push_str(REDACTED);
        let token = &rest[index + prefix.len()..];
        let skip = token
            .char_indices()
            .take_while(|(_, ch)| is_token_char(*ch))
            .map(|(idx, ch)| idx + ch.len_utf8())
            .last()
            .unwrap_or(0);
        rest = &token[skip..];
    }
    out.push_str(rest);
    out
}

fn redact_assignment_values(input: &str, marker: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(index) = rest.find(marker) {
        out.push_str(&rest[..index + marker.len()]);
        out.push_str(REDACTED);
        let value = &rest[index + marker.len()..];
        let skip = value
            .char_indices()
            .take_while(|(_, ch)| !is_assignment_delimiter(*ch))
            .map(|(idx, ch)| idx + ch.len_utf8())
            .last()
            .unwrap_or(0);
        rest = &value[skip..];
    }
    out.push_str(rest);
    out
}

fn is_token_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | ':')
}

fn is_assignment_delimiter(ch: char) -> bool {
    ch.is_ascii_whitespace() || matches!(ch, '"' | '\'' | '&' | ';')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_known_token_text_patterns() {
        let text =
            "NOTION_API_TOKEN=secret_abc123 and token secret_other and SESSDATA=session-cookie";

        let redacted = redact_text(text);

        assert!(redacted.contains("NOTION_API_TOKEN=[REDACTED]"));
        assert!(redacted.contains("secret_[REDACTED]"));
        assert!(redacted.contains("SESSDATA=[REDACTED]"));
        assert!(!redacted.contains("abc123"));
        assert!(!redacted.contains("session-cookie"));
    }

    #[test]
    fn redacts_sensitive_json_keys_recursively() {
        let value = json!({
            "api_token": "ntn_real_secret",
            "nested": {
                "client_secret": "google-secret",
                "message": "Authorization: Bearer abc.def"
            }
        });

        let redacted = redact_value(&value);

        assert_eq!(redacted["api_token"], json!("[REDACTED]"));
        assert_eq!(redacted["nested"]["client_secret"], json!("[REDACTED]"));
        assert_eq!(
            redacted["nested"]["message"],
            json!("Authorization: Bearer [REDACTED]")
        );
    }
}
