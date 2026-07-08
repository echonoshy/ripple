use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::sync::{oneshot, Mutex};
use tokio::time::timeout;
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize, utoipa::ToSchema)]
pub struct BrowserCommandRequest {
    #[serde(rename = "type")]
    pub event_type: String,
    pub command_id: String,
    pub namespace: String,
    pub tool: String,
    pub arguments: Value,
    pub job_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug)]
pub struct BrowserCommandWaiter {
    command_id: String,
    receiver: oneshot::Receiver<Value>,
}

#[derive(Debug)]
struct PendingBrowserCommand {
    user_id: String,
    sender: oneshot::Sender<Value>,
}

#[derive(Clone, Default)]
pub struct BrowserCommandBroker {
    pending: std::sync::Arc<Mutex<HashMap<String, PendingBrowserCommand>>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum BrowserCommandCompleteError {
    NotFound,
    UserMismatch,
}

impl BrowserCommandBroker {
    pub fn new_command(
        &self,
        _user_id: &str,
        job_id: &str,
        session_id: Option<&str>,
        namespace: &str,
        tool: &str,
        arguments: Value,
    ) -> BrowserCommandRequest {
        BrowserCommandRequest {
            event_type: "browser_command_request".to_string(),
            command_id: format!("browser-command-{}", Uuid::new_v4().simple()),
            namespace: namespace.to_string(),
            tool: tool.to_string(),
            arguments,
            job_id: job_id.to_string(),
            session_id: session_id.map(str::to_string),
            created_at: now_iso(),
        }
    }

    pub async fn register(
        &self,
        user_id: &str,
        request: &BrowserCommandRequest,
    ) -> BrowserCommandWaiter {
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(
            request.command_id.clone(),
            PendingBrowserCommand {
                user_id: user_id.to_string(),
                sender,
            },
        );
        BrowserCommandWaiter {
            command_id: request.command_id.clone(),
            receiver,
        }
    }

    pub async fn wait(
        &self,
        waiter: BrowserCommandWaiter,
        duration: Duration,
    ) -> anyhow::Result<Value> {
        let command_id = waiter.command_id.clone();
        match timeout(duration, waiter.receiver).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(_)) => {
                self.pending.lock().await.remove(&command_id);
                anyhow::bail!("browser command was cancelled")
            }
            Err(_) => {
                self.pending.lock().await.remove(&command_id);
                anyhow::bail!("browser command timed out")
            }
        }
    }

    pub async fn cancel(&self, command_id: &str) {
        self.pending.lock().await.remove(command_id);
    }

    pub async fn complete(
        &self,
        user_id: &str,
        command_id: &str,
        result: Value,
    ) -> Result<(), BrowserCommandCompleteError> {
        let mut pending = self.pending.lock().await;
        let Some(command) = pending.get(command_id) else {
            return Err(BrowserCommandCompleteError::NotFound);
        };
        if command.user_id != user_id {
            return Err(BrowserCommandCompleteError::UserMismatch);
        }
        let Some(command) = pending.remove(command_id) else {
            return Err(BrowserCommandCompleteError::NotFound);
        };
        let _ = command.sender.send(result);
        Ok(())
    }
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn browser_command_broker_completes_pending_command_for_user() {
        let broker = BrowserCommandBroker::default();
        let request = broker.new_command(
            "alice",
            "agent-1",
            Some("session-1"),
            "codex_app",
            "browser_snapshot",
            json!({}),
        );
        let waiter = broker.register("alice", &request).await;

        broker
            .complete(
                "alice",
                &request.command_id,
                json!({"ok": true, "observation": "captured"}),
            )
            .await
            .expect("complete command");

        let result = broker
            .wait(waiter, Duration::from_millis(10))
            .await
            .expect("wait result");
        assert_eq!(result.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            result.get("observation").and_then(Value::as_str),
            Some("captured")
        );
    }

    #[tokio::test]
    async fn browser_command_broker_rejects_cross_user_result() {
        let broker = BrowserCommandBroker::default();
        let request = broker.new_command(
            "alice",
            "agent-1",
            Some("session-1"),
            "codex_app",
            "browser_snapshot",
            json!({}),
        );
        let _waiter = broker.register("alice", &request).await;

        let error = broker
            .complete("bob", &request.command_id, json!({"ok": true}))
            .await
            .expect_err("cross-user result should fail");

        assert_eq!(error, BrowserCommandCompleteError::UserMismatch);
    }
}
