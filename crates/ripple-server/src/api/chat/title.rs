use std::path::PathBuf;

use serde_json::{json, Value};

use crate::jobs::AgentRunCreateRequest;
use crate::state::AppState;

const MAX_GENERATED_TITLE_CHARS: usize = 60;
const TITLE_GENERATION_MAX_RUNTIME_SECONDS: u64 = 30;
const TITLE_INPUT_CHARS: usize = 2_000;
const TITLE_ASSISTANT_CHARS: usize = 2_000;

pub(super) fn spawn_session_title_generation(
    state: AppState,
    user_id: String,
    workspace_root: PathBuf,
    session_id: String,
    fallback_title: String,
    user_input: String,
    assistant_text: String,
    model: String,
    effort: Option<String>,
) {
    tokio::spawn(async move {
        let _ = generate_and_apply_session_title(
            state,
            user_id,
            workspace_root,
            session_id,
            fallback_title,
            user_input,
            assistant_text,
            model,
            effort,
        )
        .await;
    });
}

async fn generate_and_apply_session_title(
    state: AppState,
    user_id: String,
    workspace_root: PathBuf,
    session_id: String,
    fallback_title: String,
    user_input: String,
    assistant_text: String,
    model: String,
    effort: Option<String>,
) -> anyhow::Result<()> {
    if !state.config.codex.enabled {
        return Ok(());
    }
    let prompt = build_title_generation_prompt(&user_input, &assistant_text);
    let max_runtime_seconds = state
        .config
        .codex
        .max_runtime_seconds
        .clamp(1, TITLE_GENERATION_MAX_RUNTIME_SECONDS);
    let runtime_dir = state.sandboxes.session_dir(&user_id, &session_id)?;
    let create = AgentRunCreateRequest {
        prompt: prompt.clone(),
        provider: "codex".to_string(),
        base_instructions: None,
        turn_context: None,
        client_context: None,
        browser_context: None,
        cwd: Some("/workspace".to_string()),
        input_items: vec![json!({"type": "text", "text": prompt})],
        model: Some(model),
        effort,
        summary: None,
        output_schema: Some(title_generation_output_schema()),
        max_runtime_seconds,
        task_trigger_id: None,
        task_trigger_title: None,
        task_trigger_reason: None,
        codex_thread_id: None,
        codex_persistent_thread: false,
        memory_disabled: true,
        chat_user_input: None,
        chat_user_content: None,
    };
    let info = state
        .jobs
        .run_internal(
            create,
            user_id.clone(),
            Some(session_id.clone()),
            workspace_root,
            runtime_dir,
        )
        .await?;
    if info.status != "completed" {
        return Ok(());
    }
    let Some(output_file) = info.output_file else {
        return Ok(());
    };
    let output = tokio::fs::read_to_string(output_file)
        .await
        .unwrap_or_default();
    let Some(title) = parse_title_generation_output(&output) else {
        return Ok(());
    };
    let _ = state
        .sessions
        .update_generated_title_if_unchanged(&user_id, &session_id, &fallback_title, &title)
        .await?;
    Ok(())
}

pub(super) fn build_title_generation_prompt(user_input: &str, assistant_text: &str) -> String {
    format!(
        "You are a strict chat-title generator for Ripple.\n\
Generate one concise chat title in the same language as the user's request.\n\
Rules:\n\
- Return JSON only, matching the provided schema.\n\
- Title should be 3-6 English words or 6-18 CJK characters when natural.\n\
- Maximum length is 60 characters.\n\
- Do not use emoji, wrapping quotes, trailing punctuation, or a 'Title:' prefix.\n\
- Do not include secrets, full emails, exact API keys, tokens, or long file paths.\n\
- Summarize the task intent, not the assistant's wording.\n\n\
User request:\n{}\n\n\
Assistant response:\n{}\n",
        clipped(user_input, TITLE_INPUT_CHARS),
        clipped(assistant_text, TITLE_ASSISTANT_CHARS)
    )
}

pub(super) fn title_generation_output_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["title"],
        "properties": {
            "title": {
                "type": "string",
                "minLength": 1,
                "maxLength": MAX_GENERATED_TITLE_CHARS
            }
        }
    })
}

pub(super) fn parse_title_generation_output(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return match value {
            Value::Object(object) => object
                .get("title")
                .and_then(Value::as_str)
                .and_then(sanitize_generated_title),
            Value::String(title) => sanitize_generated_title(&title),
            _ => None,
        };
    }
    sanitize_generated_title(trimmed)
}

pub(super) fn sanitize_generated_title(raw: &str) -> Option<String> {
    let mut title = strip_wrapping_noise(raw);
    title = strip_title_prefix(&title);
    title = remove_disallowed_chars(&title);
    title = collapse_whitespace(&title);
    title = trim_title_punctuation(&title);
    title = strip_wrapping_noise(&title);
    title = trim_title_punctuation(&title);
    title = collapse_whitespace(&title);
    if title.is_empty() || looks_sensitive(&title) {
        return None;
    }
    let truncated = title
        .chars()
        .take(MAX_GENERATED_TITLE_CHARS)
        .collect::<String>();
    let title = trim_title_punctuation(&truncated);
    if title.is_empty() || looks_sensitive(&title) {
        None
    } else {
        Some(title)
    }
}

fn clipped(value: &str, max_chars: usize) -> String {
    value.trim().chars().take(max_chars).collect()
}

fn strip_wrapping_noise(value: &str) -> String {
    let mut title = value.trim();
    if let Some(stripped) = title.strip_prefix("```") {
        title = stripped;
    }
    if let Some(stripped) = title.strip_suffix("```") {
        title = stripped;
    }
    title
        .trim()
        .trim_matches(|ch| {
            matches!(
                ch,
                '"' | '\'' | '`' | '“' | '”' | '‘' | '’' | '「' | '」' | '『' | '』'
            )
        })
        .trim()
        .to_string()
}

fn strip_title_prefix(value: &str) -> String {
    let trimmed = value.trim();
    let lower = trimmed.to_ascii_lowercase();
    for prefix in ["title:", "title -", "title:", "标题:", "标题："] {
        if lower.starts_with(prefix) || trimmed.starts_with(prefix) {
            return trimmed[prefix.len()..].trim().to_string();
        }
    }
    trimmed.to_string()
}

fn remove_disallowed_chars(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_control() && !is_emoji_like(*ch))
        .collect()
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn trim_title_punctuation(value: &str) -> String {
    value
        .trim()
        .trim_matches(|ch| {
            matches!(
                ch,
                '.' | ','
                    | '!'
                    | '?'
                    | ':'
                    | ';'
                    | '。'
                    | '，'
                    | '！'
                    | '？'
                    | '：'
                    | '；'
                    | '、'
                    | '…'
            )
        })
        .trim()
        .to_string()
}

fn is_emoji_like(ch: char) -> bool {
    matches!(
        ch as u32,
        0x1F300..=0x1FAFF | 0x2600..=0x27BF | 0xFE00..=0xFE0F
    )
}

fn looks_sensitive(value: &str) -> bool {
    contains_email(value) || contains_token_like_segment(value) || contains_long_path(value)
}

fn contains_email(value: &str) -> bool {
    value.split_whitespace().any(|part| {
        let part =
            part.trim_matches(|ch: char| !ch.is_ascii_alphanumeric() && ch != '@' && ch != '.');
        let Some((name, domain)) = part.split_once('@') else {
            return false;
        };
        !name.is_empty() && domain.contains('.') && domain.len() >= 3
    })
}

fn contains_token_like_segment(value: &str) -> bool {
    value.split_whitespace().any(|part| {
        let part =
            part.trim_matches(|ch: char| !ch.is_ascii_alphanumeric() && ch != '-' && ch != '_');
        let lower = part.to_ascii_lowercase();
        if lower.starts_with("sk-") && part.len() >= 12 {
            return true;
        }
        part.len() >= 32
            && part.chars().any(|ch| ch.is_ascii_alphabetic())
            && part.chars().any(|ch| ch.is_ascii_digit())
    })
}

fn contains_long_path(value: &str) -> bool {
    value.split_whitespace().any(|part| {
        let part = part.trim_matches(|ch: char| matches!(ch, '"' | '\'' | ',' | '.' | ';'));
        part.starts_with("/home/")
            || part.starts_with("/Users/")
            || part.starts_with("/workspace/")
            || part.contains("\\")
            || (part.starts_with('/') && part.matches('/').count() >= 2)
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_title_generation_prompt, parse_title_generation_output, sanitize_generated_title,
        title_generation_output_schema,
    };

    #[test]
    fn parses_structured_title_output() {
        assert_eq!(
            parse_title_generation_output(r#"{"title":"Refactor Auth Flow"}"#).as_deref(),
            Some("Refactor Auth Flow")
        );
    }

    #[test]
    fn sanitizes_common_model_title_noise() {
        assert_eq!(
            sanitize_generated_title("\"Title: Fix login bug!\"").as_deref(),
            Some("Fix login bug")
        );
        assert_eq!(
            sanitize_generated_title("```生成周报摘要。```").as_deref(),
            Some("生成周报摘要")
        );
    }

    #[test]
    fn truncates_long_titles_without_splitting_unicode() {
        let title = sanitize_generated_title(
            "Summarize quarterly revenue projections and customer retention analysis",
        )
        .expect("title");
        assert!(title.chars().count() <= 60);
        assert_eq!(
            sanitize_generated_title("分析移动端登录授权流程优化方案与异常处理").as_deref(),
            Some("分析移动端登录授权流程优化方案与异常处理")
        );
    }

    #[test]
    fn rejects_empty_or_sensitive_titles() {
        assert!(sanitize_generated_title("!!!").is_none());
        assert!(sanitize_generated_title("alice@example.com reset").is_none());
        assert!(sanitize_generated_title("sk-1234567890abcdefghijklmnop").is_none());
        assert!(parse_title_generation_output(r#"{"name":"No title"}"#).is_none());
    }

    #[test]
    fn prompt_and_schema_are_title_specific() {
        let prompt = build_title_generation_prompt("帮我总结这份材料", "这是一份周报总结。");
        assert!(prompt.contains("concise chat title"));
        assert!(prompt.contains("same language"));
        let schema = title_generation_output_schema();
        assert_eq!(
            schema
                .pointer("/properties/title/type")
                .and_then(|value| value.as_str()),
            Some("string")
        );
    }
}
