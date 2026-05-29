use std::path::Path as FsPath;

use serde_json::Value;

use crate::api::connectors::read_valid_bilibili_credential_file;
use crate::skills::render_skill_manifest;
use crate::state::AppState;

pub(crate) fn build_codex_chat_prompt(
    state: &AppState,
    user_id: &str,
    session_id: &str,
    workspace_root: &FsPath,
    user_input: &str,
    attachment_items: &[Value],
    system_prompt: Option<&str>,
) -> String {
    let attachment_lines = attachment_items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("attachment"))
        .map(|item| {
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("attachment");
            let path = item
                .get("workspace_path")
                .and_then(Value::as_str)
                .unwrap_or("");
            let mime_type = item
                .get("mime_type")
                .and_then(Value::as_str)
                .unwrap_or("application/octet-stream");
            format!("- {name}: {path} ({mime_type})")
        })
        .collect::<Vec<_>>();
    let attachment_section = if attachment_lines.is_empty() {
        "(none)".to_string()
    } else {
        attachment_lines.join("\n")
    };
    format!(
        "You are Codex, running as Ripple's trusted execution plane.\n\
Ripple is the control plane: it owns user identity, sandbox isolation, connector state, permissions, and API/session lifecycle. Do the real work inside the current user's workspace.\n\n\
## Ripple Session\n\
- user_id: {user_id}\n\
- session_id: {session_id}\n\
- workspace: current working directory\n\n\
## Connector Status\n\
{}\n\n\
## Execution Environment Guardrails\n\
- Connector authorization, token capture, account disconnect, and QR login are Ripple control-plane flows. Do not invent ad-hoc auth tool calls.\n\
- Google Workspace, Notion, and Feishu authorization is handled by Ripple before the Codex turn starts. For Bilibili tasks, follow the `bilibili` CLI workflow documented by the Bilibili skills.\n\
- Do not collect connector credentials inside Codex; if Google Workspace, Notion, or Feishu is required and not connected, ask the user to authorize it through Ripple.\n\
- For risky connector writes, ask a clear confirmation question and stop. Continue only after the user's next message explicitly approves the specific action.\n\n\
- For temporary Python dependencies, use `ripple-py python --with <package> -- ...` so Ripple can reuse shared read-only package environments. Do not install temporary Python packages with pip install --target or workspace-local tool directories.\n\n\
## Available Skills\n\
{}\n\n\
## System Instructions\n\
{}\n\n\
## Conversation State\n\
- The Codex persistent thread is the authoritative execution context and conversation history. Ripple may store display messages, but it does not replay prior turns into this prompt.\n\n\
## Attachments\n\
{}\n\n\
## Current User Request\n\
{}\n",
        connector_manifest(state, user_id),
        render_skill_manifest(&state.config, Some(workspace_root)),
        system_prompt.unwrap_or("(none)"),
        attachment_section,
        if user_input.trim().is_empty() {
            "(The user provided image input without additional text.)"
        } else {
            user_input
        }
    )
}

fn connector_manifest(state: &AppState, user_id: &str) -> String {
    let workspace = state.sandboxes.workspace_dir(user_id).ok();
    let credentials = state.sandboxes.credentials_dir(user_id).ok();
    let has = |path: Option<&FsPath>| path.is_some_and(FsPath::exists);
    let google = workspace
        .as_ref()
        .map(|path| path.join(".config/gogcli/keyring"));
    let feishu = workspace
        .as_ref()
        .map(|path| path.join(".lark-cli/config.json"));
    let notion = credentials.as_ref().map(|path| path.join("notion.json"));
    let bilibili = credentials.as_ref().map(|path| path.join("bilibili.json"));
    let bilibili_connected = bilibili
        .as_deref()
        .is_some_and(|path| read_valid_bilibili_credential_file(path).is_some());
    [
        ("google_workspace", has(google.as_deref())),
        ("notion", has(notion.as_deref())),
        ("feishu", has(feishu.as_deref())),
        ("bilibili", bilibili_connected),
        ("openai_codex", true),
        ("codex_image_generation", true),
        ("codex_image_input", true),
        ("codex_web_search", true),
    ]
    .into_iter()
    .map(|(name, connected)| {
        format!(
            "- {name}: {}",
            if connected {
                "connected"
            } else {
                "not_connected"
            }
        )
    })
    .collect::<Vec<_>>()
    .join("\n")
}
