use serde_json::{json, Value};

use crate::skills::SkillManifestEntry;

#[derive(Clone, Copy)]
pub struct ConnectorDefinition {
    pub name: &'static str,
    pub display_name: &'static str,
    pub description: &'static str,
    pub auth_type: &'static str,
    pub kind: &'static str,
    pub auth_flow: &'static str,
    pub web_auth: bool,
    pub chat_auth: bool,
    pub auth_start: bool,
    pub auth_complete: bool,
    pub auth_cancel: bool,
    pub disconnect: bool,
    pub accounts: bool,
    pub account_disconnect: bool,
    pub related_skill_prefixes: &'static [&'static str],
}

pub fn connector_definitions() -> &'static [ConnectorDefinition] {
    &[
        ConnectorDefinition {
            name: "google_workspace",
            display_name: "Google Workspace",
            description: "Gmail, Drive, Docs, Sheets, Slides, and Calendar.",
            auth_type: "oauth",
            kind: "user_connector",
            auth_flow: "oauth_assisted",
            web_auth: true,
            chat_auth: true,
            auth_start: true,
            auth_complete: true,
            auth_cancel: true,
            disconnect: true,
            accounts: true,
            account_disconnect: true,
            related_skill_prefixes: &["gog-"],
        },
        ConnectorDefinition {
            name: "notion",
            display_name: "Notion",
            description: "Notion API access through a per-user integration token.",
            auth_type: "token",
            kind: "user_connector",
            auth_flow: "token",
            web_auth: true,
            chat_auth: true,
            auth_start: true,
            auth_complete: false,
            auth_cancel: true,
            disconnect: true,
            accounts: false,
            account_disconnect: false,
            related_skill_prefixes: &["notion-"],
        },
        ConnectorDefinition {
            name: "feishu",
            display_name: "Feishu",
            description: "Feishu/Lark access through browser authorization.",
            auth_type: "oauth",
            kind: "user_connector",
            auth_flow: "oauth_device",
            web_auth: true,
            chat_auth: true,
            auth_start: true,
            auth_complete: true,
            auth_cancel: true,
            disconnect: true,
            accounts: false,
            account_disconnect: false,
            related_skill_prefixes: &["lark-"],
        },
        ConnectorDefinition {
            name: "bilibili",
            display_name: "Bilibili",
            description: "Bilibili session access through QR login credentials.",
            auth_type: "qr",
            kind: "user_connector",
            auth_flow: "qr",
            web_auth: true,
            chat_auth: true,
            auth_start: true,
            auth_complete: true,
            auth_cancel: true,
            disconnect: true,
            accounts: false,
            account_disconnect: false,
            related_skill_prefixes: &["bilibili-"],
        },
        ConnectorDefinition {
            name: "openai_codex",
            display_name: "OpenAI Codex",
            description: "Server-side Codex CLI login used by the app-server executor.",
            auth_type: "cli",
            kind: "runtime_capability",
            auth_flow: "none",
            web_auth: false,
            chat_auth: false,
            auth_start: false,
            auth_complete: false,
            auth_cancel: false,
            disconnect: false,
            accounts: false,
            account_disconnect: false,
            related_skill_prefixes: &[],
        },
        ConnectorDefinition {
            name: "codex_image_generation",
            display_name: "Image Generation",
            description: "Generate images through the server-side Codex runtime.",
            auth_type: "runtime",
            kind: "runtime_capability",
            auth_flow: "none",
            web_auth: false,
            chat_auth: false,
            auth_start: false,
            auth_complete: false,
            auth_cancel: false,
            disconnect: false,
            accounts: false,
            account_disconnect: false,
            related_skill_prefixes: &[],
        },
        ConnectorDefinition {
            name: "codex_image_input",
            display_name: "Image Input",
            description: "Accept uploaded workspace images and inline image data through Codex native input items.",
            auth_type: "runtime",
            kind: "runtime_capability",
            auth_flow: "none",
            web_auth: false,
            chat_auth: false,
            auth_start: false,
            auth_complete: false,
            auth_cancel: false,
            disconnect: false,
            accounts: false,
            account_disconnect: false,
            related_skill_prefixes: &[],
        },
        ConnectorDefinition {
            name: "codex_web_search",
            display_name: "Web Search",
            description: "Use Codex runtime web/search capabilities.",
            auth_type: "runtime",
            kind: "runtime_capability",
            auth_flow: "none",
            web_auth: false,
            chat_auth: false,
            auth_start: false,
            auth_complete: false,
            auth_cancel: false,
            disconnect: false,
            accounts: false,
            account_disconnect: false,
            related_skill_prefixes: &[],
        },
    ]
}

pub fn connector_definition(name: &str) -> Option<&'static ConnectorDefinition> {
    connector_definitions()
        .iter()
        .find(|connector| connector.name == name)
}

pub fn connector_path(name: &str, suffix: &str) -> Value {
    json!(format!("/v1/connectors/{name}/{suffix}"))
}

pub fn connector_info(connector: &ConnectorDefinition) -> Value {
    let name = connector.name;
    json!({
        "name": name,
        "display_name": connector.display_name,
        "description": connector.description,
        "auth_type": connector.auth_type,
        "kind": connector.kind,
        "auth_flow": connector.auth_flow,
        "auth_surfaces": {"web": connector.web_auth, "chat": connector.chat_auth},
        "auth_start_path": if connector.auth_start { connector_path(name, "auth/start") } else { Value::Null },
        "auth_complete_path": if connector.auth_complete { connector_path(name, "auth/complete") } else { Value::Null },
        "auth_cancel_path": if connector.auth_cancel { connector_path(name, "auth/cancel") } else { Value::Null },
        "disconnect_path": if connector.disconnect { connector_path(name, "disconnect") } else { Value::Null },
        "accounts_path": if connector.accounts { connector_path(name, "accounts") } else { Value::Null },
        "supports_account_disconnect": connector.account_disconnect,
        "related_skill_prefixes": connector.related_skill_prefixes
    })
}

pub fn related_skills_for_connector(
    connector: &ConnectorDefinition,
    skills: &[SkillManifestEntry],
) -> Vec<String> {
    let mut related = skills
        .iter()
        .filter(|skill| {
            connector
                .related_skill_prefixes
                .iter()
                .any(|prefix| skill.name.starts_with(prefix))
                || skill
                    .requires_connectors
                    .iter()
                    .any(|required| required == connector.name)
        })
        .map(|skill| skill.id.clone())
        .collect::<Vec<_>>();
    related.sort();
    related.dedup();
    related
}

pub fn related_connector_for_skill(skill: &SkillManifestEntry) -> Option<String> {
    if let Some(connector) = skill.requires_connectors.first() {
        return Some(connector.clone());
    }
    connector_definitions()
        .iter()
        .find(|connector| {
            connector.kind == "user_connector"
                && connector
                    .related_skill_prefixes
                    .iter()
                    .any(|prefix| skill.name.starts_with(prefix))
        })
        .map(|connector| connector.name.to_string())
}
