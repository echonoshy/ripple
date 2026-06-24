use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRunnerRequest {
    pub provider: String,
    pub prompt: String,
    pub base_instructions: Option<String>,
    pub turn_context: Option<String>,
    pub client_context: Option<String>,
    pub cwd: PathBuf,
    pub input_items: Vec<Value>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub summary: Option<String>,
    pub output_schema: Option<Value>,
    pub max_runtime_seconds: u64,
    pub user_id: Option<String>,
    pub session_id: Option<String>,
    pub metadata: Value,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum AgentRunnerStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl AgentRunnerStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRunnerResult {
    pub job_id: String,
    pub provider: String,
    pub status: AgentRunnerStatus,
    pub events_file: PathBuf,
    pub output_file: Option<PathBuf>,
    pub exit_code: Option<i32>,
    pub stdout_tail: String,
    pub stderr_tail: String,
    pub error: Option<String>,
    pub metadata: Value,
}
