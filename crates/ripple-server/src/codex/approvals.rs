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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{approval_response_for_action, CodexApproval};

    fn permissions_approval() -> CodexApproval {
        CodexApproval {
            source: "codex_app_server".to_string(),
            job_id: "job-1".to_string(),
            user_id: Some("alice".to_string()),
            session_id: Some("session-1".to_string()),
            request_id: json!("request-1"),
            method: "item/permissions/requestApproval".to_string(),
            action: "permissions".to_string(),
            description: "Needs folder access".to_string(),
            metadata: json!({
                "reason": "Read sibling folder",
                "cwd": "/workspace/spaces/a/records/r1",
                "permissions": {
                    "filesystem": {
                        "read": ["/workspace/spaces/a/records/r2"],
                        "write": ["/workspace/spaces/a/records/r2/out.md"]
                    }
                }
            }),
        }
    }

    #[test]
    fn permission_allow_returns_requested_permissions_only() {
        let approval = permissions_approval();
        let response = approval_response_for_action(&approval, "allow");

        assert_eq!(
            response.get("permissions"),
            approval.metadata.get("permissions")
        );
        assert_eq!(response.get("scope"), Some(&json!("turn")));
        assert_eq!(response.get("strictAutoReview"), Some(&json!(false)));
    }

    #[test]
    fn permission_always_maps_to_session_scope() {
        let approval = permissions_approval();
        let response = approval_response_for_action(&approval, "always");

        assert_eq!(
            response.get("permissions"),
            approval.metadata.get("permissions")
        );
        assert_eq!(response.get("scope"), Some(&json!("session")));
    }

    #[test]
    fn permission_deny_returns_empty_permissions() {
        let approval = permissions_approval();
        let response = approval_response_for_action(&approval, "deny");

        assert_eq!(response.get("permissions"), Some(&json!({})));
        assert_eq!(response.get("scope"), Some(&json!("turn")));
        assert_eq!(response.get("strictAutoReview"), Some(&json!(true)));
    }
}
