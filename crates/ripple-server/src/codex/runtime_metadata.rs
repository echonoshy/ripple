use serde_json::{json, Value};

use crate::codex::permissions::RIPPLE_CODEX_PERMISSION_PROFILE;
use crate::config::AppConfig;

pub const CODEX_APP_SERVER_PROTOCOL_METHODS: &[&str] = &[
    "initialize",
    "thread/start",
    "thread/resume",
    "thread/fork",
    "turn/start",
    "turn/steer",
    "turn/interrupt",
    "item/tool/requestUserInput",
    "permissionProfile/list",
    "account/workspaceMessages/read",
];

pub fn app_server_protocol_metadata() -> Value {
    json!({
        "transport": "stdio",
        "methods": CODEX_APP_SERVER_PROTOCOL_METHODS,
        "capabilities": {
            "permission_profiles": true,
            "workspace_messages": true
        }
    })
}

pub fn permission_profile_metadata(config: &AppConfig) -> Value {
    json!({
        "id": RIPPLE_CODEX_PERMISSION_PROFILE,
        "managed": true,
        "network_access": config.codex.network_access,
        "shell_environment_policy": {
            "exclude": ["CODEX_HOME"]
        },
        "service_codex_auth": "deny-read"
    })
}

pub fn runtime_capability_metadata(name: &str, config: &AppConfig) -> Value {
    match name {
        "openai_codex" => json!({
            "protocol": app_server_protocol_metadata(),
            "permission_profile": permission_profile_metadata(config),
            "workspace_messages": {
                "method": "account/workspaceMessages/read",
                "status": "codex_runtime_owned"
            },
            "usage_awareness": {
                "workspace_messages": true,
                "quota_and_rate_limits": "reported_by_codex_runtime_when_available"
            }
        }),
        "codex_image_input" => json!({
            "accepted_sources": [
                "uploaded_workspace_file",
                "localImage",
                "inline_data_url"
            ],
            "remote_image_urls": "rejected",
            "rejection_reason": "Remote image URLs are not fetched by Ripple before Codex app-server input."
        }),
        "codex_image_generation" => json!({
            "provider": "codex_runtime",
            "output": "workspace_file"
        }),
        "codex_web_search" => json!({
            "provider": "codex_runtime",
            "network_access": config.codex.network_access
        }),
        _ => json!({}),
    }
}
