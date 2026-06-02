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
    context_folder_path: Option<&str>,
    folder_context_evidence: Option<&str>,
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
    let context_folder = context_folder_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("/workspace");
    let context_section = if context_folder == "/workspace" {
        "- Context folder: /workspace (full workspace)\n- Use the full workspace as the default reading and search scope.\n- If the user does not specify an output path, choose the workspace path that best fits the task."
            .to_string()
    } else {
        format!(
            "- Context folder: {context_folder}\n- Treat this folder as the default reading and search scope for this session.\n- Prefer files under this folder when answering questions or inspecting local context.\n- If the task clearly belongs to this folder and the user does not specify an output path, write new files under this folder.\n- If the user specifies a path, follow the user's path exactly when it is valid.\n- Use web_search as a supplement when the user explicitly asks for online/latest information or when local folder evidence is insufficient. When using web_search, distinguish local evidence from web-sourced additions."
        )
    };
    let folder_context_evidence_section = match folder_context_evidence {
        Some(section) if !section.trim().is_empty() => section.trim().to_string(),
        _ if context_folder_path.is_some() => "No automatic folder context evidence was collected. Search or read files under the context folder before using web_search unless the user explicitly asked for online/latest information.".to_string(),
        _ => "(none)".to_string(),
    };
    format!(
        "You are Codex, running as Ripple's trusted execution plane.\n\
Ripple is the control plane: it owns user identity, sandbox isolation, connector state, permissions, and API/session lifecycle. Do the real work inside the current user's workspace.\n\n\
## Ripple Session\n\
- user_id: {user_id}\n\
- session_id: {session_id}\n\
- workspace: current working directory\n\n\
## Context Folder\n\
{}\n\n\
## Folder Context Evidence\n\
{}\n\n\
## Connector Status\n\
{}\n\n\
## Execution Environment Guardrails\n\
- Connector authorization, token capture, account disconnect, and QR login are Ripple control-plane flows. Do not invent ad-hoc auth tool calls.\n\
- Use Available Skills and Connector Status to decide whether a connector-backed skill is needed. Do not infer connector use from keywords alone.\n\
- Do not collect connector credentials inside Codex. If Google Workspace, Notion, or Feishu is required and the connector status is not_connected, your final answer must contain only this internal control-plane request, with the connector set to one of google_workspace, notion, or feishu:\n\
  <ripple_connector_auth_request>{{\"connector\":\"google_workspace\",\"force_reauth\":false,\"reason\":\"needs Gmail access\"}}</ripple_connector_auth_request>\n\
- For Bilibili tasks, follow the `bilibili` CLI workflow documented by the Bilibili skills.\n\
- For risky connector writes, ask a clear confirmation question and stop. Continue only after the user's next message explicitly approves the specific action.\n\n\
- Do not generate images unless the current user explicitly asks to create, generate, draw, or render an image. Reading PDFs, documents, or image inputs must not use image generation.\n\n\
- Always write temporary analysis, render, OCR, conversion, and inspection artifacts to $TMPDIR or /workspace/.tmp. Do not write derived inspection files into /workspace root unless the user explicitly asks for those files as deliverables; keep final or user-requested outputs under the selected context folder or another appropriate workspace path.\n\n\
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
        context_section,
        folder_context_evidence_section,
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
    let connected = |value| {
        if value {
            "connected"
        } else {
            "not_connected"
        }
    };
    [
        ("google_workspace", connected(has(google.as_deref()))),
        ("notion", connected(has(notion.as_deref()))),
        ("feishu", connected(has(feishu.as_deref()))),
        ("bilibili", connected(bilibili_connected)),
        ("openai_codex", "connected"),
        ("codex_image_generation", "disabled_by_default"),
        ("codex_image_input", "connected"),
        ("codex_web_search", "connected"),
    ]
    .into_iter()
    .map(|(name, status)| format!("- {name}: {status}"))
    .collect::<Vec<_>>()
    .join("\n")
}
