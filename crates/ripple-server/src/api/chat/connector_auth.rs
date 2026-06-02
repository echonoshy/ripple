use serde::Deserialize;
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::api::connectors::{
    connector_auth_complete_action, connector_auth_start_action, connector_status_value,
};
use crate::api::ApiError;
use crate::sessions::SessionRecord;
use crate::state::AppState;

const DONE_SIGNALS: &[&str] = &[
    "好了",
    "扫好了",
    "授权好了",
    "完成了",
    "已完成",
    "done",
    "ok",
    "confirmed",
];
const MODEL_CONNECTOR_AUTH_REQUEST_OPEN: &str = "<ripple_connector_auth_request>";
const MODEL_CONNECTOR_AUTH_REQUEST_CLOSE: &str = "</ripple_connector_auth_request>";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ModelConnectorAuthRequest {
    pub(crate) connector: String,
    pub(crate) force_reauth: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawModelConnectorAuthRequest {
    connector: String,
    #[serde(default)]
    force_reauth: bool,
    reason: Option<String>,
}

pub(crate) struct ConnectorAuthDecision {
    pub(crate) event: Value,
    pub(crate) resume_user_input: Option<String>,
}

pub(crate) async fn maybe_handle_connector_auth(
    state: &AppState,
    user_id: &str,
    session: &mut SessionRecord,
    user_input: &str,
    _request_base_url: Option<&str>,
) -> Result<Option<ConnectorAuthDecision>, ApiError> {
    if session.pending_connector_auth.is_some() {
        return continue_pending_connector_auth(state, user_id, session, user_input).await;
    }
    Ok(None)
}

pub(crate) fn model_connector_auth_request_might_be_start(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.is_empty()
        || MODEL_CONNECTOR_AUTH_REQUEST_OPEN.starts_with(trimmed)
        || trimmed.starts_with(MODEL_CONNECTOR_AUTH_REQUEST_OPEN)
}

pub(crate) fn parse_model_connector_auth_request(text: &str) -> Option<ModelConnectorAuthRequest> {
    let trimmed = text.trim();
    let json_text = trimmed
        .strip_prefix(MODEL_CONNECTOR_AUTH_REQUEST_OPEN)?
        .strip_suffix(MODEL_CONNECTOR_AUTH_REQUEST_CLOSE)?
        .trim();
    let request: RawModelConnectorAuthRequest = serde_json::from_str(json_text).ok()?;
    let connector = request.connector.trim();
    if !matches!(connector, "google_workspace" | "notion" | "feishu") {
        return None;
    }
    let _reason = request.reason.as_deref().unwrap_or("").trim();
    Some(ModelConnectorAuthRequest {
        connector: connector.to_string(),
        force_reauth: request.force_reauth,
    })
}

pub(crate) async fn start_model_connector_auth_for_chat(
    state: &AppState,
    user_id: &str,
    session: &mut SessionRecord,
    request: &ModelConnectorAuthRequest,
    user_input: &str,
    request_base_url: Option<&str>,
) -> Result<ConnectorAuthDecision, ApiError> {
    start_connector_auth_for_chat(
        state,
        user_id,
        session,
        &request.connector,
        user_input,
        request_base_url,
        request.force_reauth,
    )
    .await
}

pub(crate) async fn continue_pending_connector_auth(
    state: &AppState,
    user_id: &str,
    session: &mut SessionRecord,
    user_input: &str,
) -> Result<Option<ConnectorAuthDecision>, ApiError> {
    let Some(pending) = session.pending_connector_auth.clone() else {
        return Ok(None);
    };
    let connector = pending
        .get("connector")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if connector.is_empty() {
        return Ok(None);
    }
    if connector_is_connected(state, user_id, &connector).await? {
        let event = connector_auth_event(
            &connector,
            "connector_auth_updated",
            "authorized",
            connector_authorized_message(&connector),
            None,
        );
        return Ok(Some(ConnectorAuthDecision {
            event,
            resume_user_input: pending_resume_user_input(&pending),
        }));
    }

    match connector.as_str() {
        "google_workspace" => {
            let event = connector_auth_event(
                "google_workspace",
                "connector_auth_required",
                pending_stage(&pending, "awaiting_browser_callback"),
                "Google 授权还没有完成。请在刚才打开的 Google 页面点击允许，Ripple 会自动继续。",
                pending.get("action").cloned(),
            );
            Ok(Some(ConnectorAuthDecision {
                event,
                resume_user_input: None,
            }))
        }
        "feishu" => continue_feishu_auth(state, user_id, session, &pending, user_input).await,
        "bilibili" => continue_bilibili_auth(state, user_id, session, &pending, user_input).await,
        "notion" => continue_notion_auth(state, user_id, session, &pending, user_input).await,
        _ => Ok(None),
    }
}

async fn start_connector_auth_for_chat(
    state: &AppState,
    user_id: &str,
    session: &mut SessionRecord,
    connector: &str,
    user_input: &str,
    request_base_url: Option<&str>,
    force_reauth: bool,
) -> Result<ConnectorAuthDecision, ApiError> {
    let payload = match connector {
        "notion" => extract_notion_token(user_input)
            .map(|token| json!({"api_token": token}))
            .unwrap_or_else(|| json!({})),
        "feishu" if force_reauth => json!({"force_new_user_auth": true}),
        _ => json!({}),
    };
    let is_empty_payload = payload
        .as_object()
        .map(serde_json::Map::is_empty)
        .unwrap_or(true);
    if connector == "notion" && is_empty_payload {
        let event = connector_auth_event(
            "notion",
            "connector_auth_required",
            "awaiting_token",
            notion_token_guidance_message(),
            Some(
                json!({"name": "notion", "ok": true, "stage": "awaiting_token", "detail": "api_token is required.", "data": {}}),
            ),
        );
        session.pending_connector_auth = Some(pending_from_event(
            connector,
            &event,
            user_input.to_string(),
        ));
        return Ok(ConnectorAuthDecision {
            event,
            resume_user_input: None,
        });
    }

    let action = connector_auth_start_action(state, user_id, connector, &payload, request_base_url)
        .await?
        .0;
    let resume_user_input = if connector == "notion" {
        String::new()
    } else {
        user_input.to_string()
    };
    decision_from_action(session, connector, action, resume_user_input)
}

async fn continue_notion_auth(
    state: &AppState,
    user_id: &str,
    session: &mut SessionRecord,
    pending: &Value,
    user_input: &str,
) -> Result<Option<ConnectorAuthDecision>, ApiError> {
    let Some(token) = extract_notion_token(user_input) else {
        let event = connector_auth_event(
            "notion",
            "connector_auth_required",
            "awaiting_token",
            notion_token_guidance_message(),
            pending.get("action").cloned(),
        );
        return Ok(Some(ConnectorAuthDecision {
            event,
            resume_user_input: None,
        }));
    };
    let action =
        connector_auth_start_action(state, user_id, "notion", &json!({"api_token": token}), None)
            .await?
            .0;
    Ok(Some(decision_from_action(
        session,
        "notion",
        action,
        pending_resume_user_input(pending).unwrap_or_default(),
    )?))
}

async fn continue_feishu_auth(
    state: &AppState,
    user_id: &str,
    session: &mut SessionRecord,
    pending: &Value,
    user_input: &str,
) -> Result<Option<ConnectorAuthDecision>, ApiError> {
    if pending
        .get("device_code_finalized")
        .and_then(Value::as_bool)
        == Some(true)
        && !is_reauth_intent(user_input)
    {
        let event = connector_auth_event(
            "feishu",
            "connector_auth_required",
            pending_stage(pending, "pending"),
            "飞书还没有确认到用户授权完成。请确认飞书页面已经点击允许/确认；如果页面已经关闭，请回复「重新授权」。",
            pending.get("action").cloned(),
        );
        return Ok(Some(ConnectorAuthDecision {
            event,
            resume_user_input: None,
        }));
    }
    if is_reauth_intent(user_input) {
        let action = connector_auth_start_action(
            state,
            user_id,
            "feishu",
            &json!({"force_new_user_auth": true}),
            None,
        )
        .await?
        .0;
        return Ok(Some(decision_from_action(
            session,
            "feishu",
            action,
            pending_resume_user_input(pending).unwrap_or_else(|| user_input.to_string()),
        )?));
    }
    let device_code = pending
        .get("device_code")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let action = if device_code.is_empty() {
        connector_auth_start_action(state, user_id, "feishu", &json!({}), None)
            .await?
            .0
    } else {
        connector_auth_complete_action(
            state,
            user_id,
            "feishu",
            &json!({"device_code": device_code}),
        )
        .await?
        .0
    };
    Ok(Some(decision_from_action(
        session,
        "feishu",
        action,
        pending_resume_user_input(pending).unwrap_or_else(|| user_input.to_string()),
    )?))
}

async fn continue_bilibili_auth(
    state: &AppState,
    user_id: &str,
    session: &mut SessionRecord,
    pending: &Value,
    user_input: &str,
) -> Result<Option<ConnectorAuthDecision>, ApiError> {
    if !is_done_signal(user_input) {
        let event = connector_auth_event(
            "bilibili",
            "connector_auth_required",
            pending_stage(pending, "awaiting_user"),
            "Bilibili 扫码登录还在等待完成。请用 B 站 App 扫码并确认登录，扫完后回我「好了」。",
            pending.get("action").cloned(),
        );
        return Ok(Some(ConnectorAuthDecision {
            event,
            resume_user_input: None,
        }));
    }
    let qrcode_key = pending
        .get("qrcode_key")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if qrcode_key.is_empty() {
        let event = connector_auth_event(
            "bilibili",
            "connector_auth_required",
            "invalid_request",
            "Bilibili 授权状态缺少 qrcode_key，请重新发起扫码登录。",
            pending.get("action").cloned(),
        );
        return Ok(Some(ConnectorAuthDecision {
            event,
            resume_user_input: None,
        }));
    }
    let action = connector_auth_complete_action(
        state,
        user_id,
        "bilibili",
        &json!({"qrcode_key": qrcode_key, "max_wait_seconds": 30}),
    )
    .await?
    .0;
    Ok(Some(decision_from_action(
        session,
        "bilibili",
        action,
        pending_resume_user_input(pending).unwrap_or_else(|| user_input.to_string()),
    )?))
}

pub(crate) fn decision_from_action(
    session: &mut SessionRecord,
    connector: &str,
    action: Value,
    resume_user_input: String,
) -> Result<ConnectorAuthDecision, ApiError> {
    let stage = action
        .get("stage")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let event_type = if stage == "authorized" {
        "connector_auth_updated"
    } else {
        "connector_auth_required"
    };
    let message = connector_auth_message(connector, &action);
    let mut event = connector_auth_event(connector, event_type, &stage, &message, Some(action));
    if connector == "notion" {
        event["user_content"] = json!([{"type": "text", "text": "[Notion token redacted]"}]);
    }
    if stage == "authorized" {
        session.pending_connector_auth = None;
        Ok(ConnectorAuthDecision {
            event,
            resume_user_input: if resume_user_input.trim().is_empty() {
                None
            } else {
                Some(resume_user_input)
            },
        })
    } else if is_terminal_connector_auth_stage(&stage) {
        session.pending_connector_auth = None;
        Ok(ConnectorAuthDecision {
            event,
            resume_user_input: None,
        })
    } else {
        session.pending_connector_auth =
            Some(pending_from_event(connector, &event, resume_user_input));
        Ok(ConnectorAuthDecision {
            event,
            resume_user_input: None,
        })
    }
}

pub(crate) async fn persist_connector_auth_event(
    state: &AppState,
    session: &mut SessionRecord,
    user_content: &Value,
    user_input: &str,
    event: &Value,
) -> Result<(), ApiError> {
    if !user_input.trim().is_empty() {
        let persisted_user_content = event
            .get("user_content")
            .filter(|value| value.is_array())
            .cloned()
            .unwrap_or_else(|| {
                if user_content.is_null() {
                    json!(user_input)
                } else {
                    user_content.clone()
                }
            });
        session.messages.push(json!({
            "role": "user",
            "content": persisted_user_content,
            "created_at": now_iso()
        }));
    }
    if let Some(message) = event.get("message").and_then(Value::as_str) {
        if !message.trim().is_empty() {
            session.messages.push(json!({
                "role": "assistant",
                "content": [{"type": "text", "text": message}],
                "created_at": now_iso()
            }));
        }
    }
    if connector_auth_status(event) == "idle" {
        session.pending_connector_auth = None;
    }
    session.status = connector_auth_status(event).to_string();
    state.sessions.save_record(session.clone()).await?;
    Ok(())
}

pub(crate) fn connector_auth_status(event: &Value) -> &'static str {
    let stage = event.get("stage").and_then(Value::as_str).unwrap_or("");
    if event.get("type").and_then(Value::as_str) == Some("connector_auth_required")
        && !is_terminal_connector_auth_stage(stage)
    {
        "awaiting_user_input"
    } else {
        "idle"
    }
}

fn is_terminal_connector_auth_stage(stage: &str) -> bool {
    matches!(stage, "auth_failed" | "invalid_request")
}

pub(crate) fn connector_auth_poll_should_persist_message(
    event: &Value,
    previous_pending: &Value,
) -> bool {
    let stage = event.get("stage").and_then(Value::as_str).unwrap_or("");
    if event.get("type").and_then(Value::as_str) == Some("connector_auth_updated") {
        return true;
    }
    if stage == "auth_failed" || stage == "invalid_request" {
        return true;
    }

    let Some(data) = event.pointer("/action/data").and_then(Value::as_object) else {
        return false;
    };
    if data.get("device_code_finalized").and_then(Value::as_bool) == Some(true) {
        return true;
    }

    for key in ["setup_url", "oauth_url"] {
        let value = data.get(key).and_then(Value::as_str).unwrap_or("");
        if !value.is_empty()
            && previous_pending
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                != value
        {
            return true;
        }
    }
    false
}

pub(crate) fn connector_auth_poll_should_emit_message(
    event: &Value,
    previous_pending: &Value,
) -> bool {
    connector_auth_poll_should_persist_message(event, previous_pending)
}

pub(crate) fn public_connector_auth_event(event: &Value) -> Value {
    let Some(object) = event.as_object() else {
        return event.clone();
    };
    let mut object = object.clone();
    object.remove("user_content");
    object.retain(|_, value| !value.is_null());
    Value::Object(object)
}

fn pending_from_event(connector: &str, event: &Value, resume_user_input: String) -> Value {
    let data = event
        .pointer("/action/data")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut pending = serde_json::Map::new();
    pending.insert("connector".to_string(), json!(connector));
    pending.insert(
        "stage".to_string(),
        event
            .get("stage")
            .cloned()
            .unwrap_or_else(|| json!("pending")),
    );
    pending.insert("resume_user_input".to_string(), json!(resume_user_input));
    pending.insert(
        "action".to_string(),
        event.get("action").cloned().unwrap_or(Value::Null),
    );
    for key in [
        "device_code",
        "oauth_url",
        "setup_url",
        "qrcode_key",
        "callback_mode",
        "assisted_callback_url",
        "device_code_finalized",
    ] {
        if let Some(value) = data.get(key) {
            pending.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(pending)
}

fn connector_auth_event(
    connector: &str,
    event_type: &str,
    stage: &str,
    message: &str,
    action: Option<Value>,
) -> Value {
    json!({
        "type": event_type,
        "connector": connector,
        "display_name": connector_display_name(connector),
        "auth_flow": connector_auth_flow(connector),
        "stage": stage,
        "message": message,
        "action": action
    })
}

pub(crate) fn connector_auth_message(connector: &str, action: &Value) -> String {
    let stage = action
        .get("stage")
        .and_then(Value::as_str)
        .unwrap_or("pending");
    let detail = action.get("detail").and_then(Value::as_str).unwrap_or("");
    let data = action.get("data").and_then(Value::as_object);
    match connector {
        "google_workspace" => data
            .and_then(|data| data.get("oauth_url"))
            .and_then(Value::as_str)
            .map(|url| {
                format!(
                    "[GOOGLE_AUTH]\nGoogle Workspace 授权\n\n请打开下面的授权链接并点击允许：\n\n{url}\n\n授权完成后 Ripple 会自动继续。"
                )
            })
            .unwrap_or_else(|| {
                if stage == "authorized" {
                    connector_authorized_message(connector).to_string()
                } else {
                    detail.to_string()
                }
            }),
        "feishu" => {
            if let Some(setup_url) = data
                .and_then(|data| data.get("setup_url"))
                .and_then(Value::as_str)
            {
                format!(
                    "[FEISHU_SETUP]\n第 1/2 步：准备飞书连接。\n\n首次使用需要在飞书页面完成一次性准备。完成后 Ripple 会自动进入账号授权。\n\n{setup_url}\n\n请保持当前页面打开；Ripple 会自动检查并继续第 2 步。"
                )
            } else if let Some(oauth_url) = data
                .and_then(|data| data.get("oauth_url"))
                .and_then(Value::as_str)
            {
                format!(
                    "[FEISHU_AUTH]\n第 2/2 步：授权你的飞书账号。\n\n授权后 Ripple 会以你的飞书账号继续执行刚才的请求；发送消息会显示为你本人。\n\n{oauth_url}\n\n请保持当前页面打开；授权完成后 Ripple 会自动继续。"
                )
            } else if stage == "authorized" {
                connector_authorized_message(connector).to_string()
            } else {
                detail.to_string()
            }
        }
        "bilibili" => {
            if let Some(data) = data {
                let qrcode_image_url = data.get("qrcode_image_url").and_then(Value::as_str);
                let qrcode_content = data.get("qrcode_content").and_then(Value::as_str);
                if let (Some(qrcode_image_url), Some(qrcode_content)) =
                    (qrcode_image_url, qrcode_content)
                {
                    let app_url = data
                        .get("app_url")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let app_url_section = if app_url.trim().is_empty() {
                        String::new()
                    } else {
                        format!("\n\n{app_url}")
                    };
                    format!(
                        "[BILIBILI_AUTH]\nB 站扫码登录\n\n{qrcode_image_url}\n\n{qrcode_content}{app_url_section}\n\n扫码或点链接确认后，回到这里发送「好了」。"
                    )
                } else if stage == "authorized" {
                    connector_authorized_message(connector).to_string()
                } else {
                    detail.to_string()
                }
            } else if stage == "authorized" {
                connector_authorized_message(connector).to_string()
            } else {
                detail.to_string()
            }
        }
        "notion" => {
            if stage == "authorized" {
                connector_authorized_message(connector).to_string()
            } else {
                detail.to_string()
            }
        }
        _ => detail.to_string(),
    }
}

async fn connector_is_connected(
    state: &AppState,
    user_id: &str,
    connector: &str,
) -> Result<bool, ApiError> {
    Ok(connector_status_value(state, user_id, connector)
        .await?
        .get("connected")
        .and_then(Value::as_bool)
        .unwrap_or(false))
}

fn connector_display_name(connector: &str) -> &'static str {
    match connector {
        "google_workspace" => "Google Workspace",
        "notion" => "Notion",
        "feishu" => "Feishu",
        "bilibili" => "Bilibili",
        _ => "Connector",
    }
}

fn connector_auth_flow(connector: &str) -> &'static str {
    match connector {
        "google_workspace" => "oauth_assisted",
        "notion" => "token",
        "feishu" => "oauth_device",
        "bilibili" => "qr",
        _ => "unknown",
    }
}

fn connector_authorized_message(connector: &str) -> &'static str {
    match connector {
        "google_workspace" => "Google Workspace 授权已完成。继续执行刚才的请求。",
        "notion" => "Notion token 已保存。继续执行刚才的请求。",
        "feishu" => "飞书授权已完成。继续执行刚才的请求。",
        "bilibili" => "Bilibili 已授权。继续执行刚才的请求。",
        _ => "Connector authorization completed. Continuing.",
    }
}

fn notion_token_guidance_message() -> &'static str {
    "我需要先绑定 Notion integration token，才能读取你的 Notion 内容。\n\n\
获取方式：\n\
1. 打开 https://www.notion.so/profile/integrations\n\
2. 创建或选择一个 Internal Integration。\n\
3. 复制 Token，格式通常以 ntn_ 或 secret_ 开头。\n\
4. 回到这里，把 Token 直接粘贴发送给我。\n\n\
另外，请在 Notion 里把要读取的 page 或 database Share 给这个 Integration；否则 token 正确也可能读不到内容。"
}

fn pending_resume_user_input(pending: &Value) -> Option<String> {
    pending
        .get("resume_user_input")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn pending_stage<'a>(pending: &'a Value, fallback: &'a str) -> &'a str {
    pending
        .get("stage")
        .and_then(Value::as_str)
        .unwrap_or(fallback)
}

fn is_done_signal(text: &str) -> bool {
    let normalized = text.trim().to_ascii_lowercase();
    DONE_SIGNALS
        .iter()
        .any(|signal| normalized.contains(&signal.to_ascii_lowercase()))
}

fn is_reauth_intent(text: &str) -> bool {
    let normalized = text.to_ascii_lowercase();
    normalized.contains("reauth")
        || normalized.contains("restart")
        || text.contains("重新授权")
        || text.contains("重新登录")
}

pub(crate) fn extract_notion_token(text: &str) -> Option<String> {
    text.split(|ch: char| ch.is_whitespace() || ch == '"' || ch == '\'' || ch == '`')
        .map(|part| {
            part.trim_matches(|ch: char| ch == ',' || ch == ';' || ch == '，' || ch == '。')
        })
        .find(|part| {
            (part.starts_with("ntn_") || part.starts_with("secret_"))
                && part.len() >= 20
                && part.len() <= 200
        })
        .map(str::to_string)
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

#[cfg(test)]
mod tests {
    use super::{model_connector_auth_request_might_be_start, parse_model_connector_auth_request};

    #[test]
    fn parses_model_connector_auth_request_protocol() {
        let request = parse_model_connector_auth_request(
            "<ripple_connector_auth_request>{\"connector\":\"google_workspace\",\"force_reauth\":false,\"reason\":\"needs Gmail access\"}</ripple_connector_auth_request>",
        )
        .expect("request");

        assert_eq!(request.connector, "google_workspace");
        assert!(!request.force_reauth);
        assert!(parse_model_connector_auth_request("hello").is_none());
        assert!(parse_model_connector_auth_request(
            "<ripple_connector_auth_request>{\"connector\":\"bilibili\"}</ripple_connector_auth_request>"
        )
        .is_none());
    }

    #[test]
    fn detects_possible_streaming_connector_auth_prefix() {
        assert!(model_connector_auth_request_might_be_start("<ripple"));
        assert!(model_connector_auth_request_might_be_start(
            "  <ripple_connector_auth_request>{}"
        ));
        assert!(!model_connector_auth_request_might_be_start("hello"));
    }
}
