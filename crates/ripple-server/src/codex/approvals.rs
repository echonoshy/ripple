use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexApproval {
    pub source: String,
    pub job_id: String,
    pub user_id: Option<String>,
    pub session_id: Option<String>,
    pub request_id: Value,
    pub method: String,
    pub action: String,
    pub description: String,
    pub metadata: Value,
}

pub fn approval_response_for_action(approval: &CodexApproval, action: &str) -> Value {
    match approval.action.as_str() {
        "command_execution" | "exec_command" => {
            if action == "deny" {
                if approval.action == "exec_command" {
                    serde_json::json!({"decision": "denied"})
                } else {
                    serde_json::json!({"decision": "decline"})
                }
            } else if action == "always" {
                if approval.action == "exec_command" {
                    serde_json::json!({"decision": "approved_for_session"})
                } else {
                    serde_json::json!({"decision": "acceptForSession"})
                }
            } else if approval.action == "exec_command" {
                serde_json::json!({"decision": "approved"})
            } else {
                serde_json::json!({"decision": "accept"})
            }
        }
        "file_change" | "apply_patch" => {
            if action == "deny" {
                if approval.action == "apply_patch" {
                    serde_json::json!({"decision": "denied"})
                } else {
                    serde_json::json!({"decision": "decline"})
                }
            } else if action == "always" && approval.action == "file_change" {
                serde_json::json!({"decision": "acceptForSession"})
            } else if approval.action == "apply_patch" {
                serde_json::json!({"decision": "approved"})
            } else {
                serde_json::json!({"decision": "accept"})
            }
        }
        "permissions" => {
            if action == "deny" {
                serde_json::json!({"permissions": {}, "scope": "turn", "strictAutoReview": true})
            } else {
                let permissions = approval
                    .metadata
                    .get("permissions")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                serde_json::json!({
                    "permissions": permissions,
                    "scope": if action == "always" { "session" } else { "turn" },
                    "strictAutoReview": false
                })
            }
        }
        _ => {
            if action == "deny" {
                serde_json::json!({"decision": "decline"})
            } else {
                serde_json::json!({"decision": if action == "always" { "acceptForSession" } else { "accept" }})
            }
        }
    }
}
