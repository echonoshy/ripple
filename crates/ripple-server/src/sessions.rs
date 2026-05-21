use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::config::AppConfig;
use crate::sandbox::SandboxManager;

#[derive(Clone)]
pub struct SessionManager {
    config: Arc<AppConfig>,
    sandboxes: SandboxManager,
    active: Arc<RwLock<HashMap<(String, String), SessionRecord>>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionRecord {
    pub session_id: String,
    pub user_id: String,
    pub title: String,
    pub model: String,
    pub max_turns: u32,
    pub created_at: String,
    pub last_active: String,
    pub status: String,
    pub message_count: usize,
    pub messages: Vec<Value>,
    pub pending_question: Option<String>,
    pub pending_options: Option<Vec<String>>,
    pub pending_permission_request: Option<Value>,
    pub pending_connector_auth: Option<Value>,
    pub pending_schedule_request: Option<Value>,
    pub codex_thread_id: Option<String>,
    pub plan_steps: Vec<Value>,
    pub plan_progress: Option<Value>,
}

#[derive(Debug, Serialize)]
pub struct SessionInfo {
    pub session_id: String,
    pub title: String,
    pub model: String,
    pub created_at: String,
    pub last_active: String,
    pub message_count: usize,
    pub status: String,
    pub changed_file_count: u32,
    pub pending_approval_count: u32,
    pub workspace_size_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct SessionDetail {
    #[serde(flatten)]
    pub info: SessionInfo,
    pub messages: Vec<Value>,
    pub pending_question: Option<String>,
    pub pending_options: Option<Vec<String>>,
    pub pending_permission_request: Option<Value>,
    pub pending_schedule_request: Option<Value>,
    pub plan_steps: Vec<Value>,
    pub plan_progress: Option<Value>,
    pub task_steps: Vec<Value>,
    pub task_progress: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct CreateSessionInput {
    pub model: Option<String>,
    pub max_turns: Option<u32>,
    pub system_prompt: Option<String>,
}

impl SessionManager {
    pub fn new(config: Arc<AppConfig>, sandboxes: SandboxManager) -> Self {
        Self {
            config,
            sandboxes,
            active: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn create_session(
        &self,
        user_id: &str,
        input: CreateSessionInput,
    ) -> anyhow::Result<SessionRecord> {
        let _ = input.system_prompt;
        self.sandboxes.ensure_sandbox(user_id)?;
        let session_id = format!("srv-{}", &Uuid::new_v4().simple().to_string()[..12]);
        let now = now_iso();
        let session = SessionRecord {
            session_id: session_id.clone(),
            user_id: user_id.to_string(),
            title: String::new(),
            model: input
                .model
                .unwrap_or_else(|| self.config.default_model.clone()),
            max_turns: input.max_turns.unwrap_or(200),
            created_at: now.clone(),
            last_active: now,
            status: "idle".to_string(),
            message_count: 0,
            messages: Vec::new(),
            pending_question: None,
            pending_options: None,
            pending_permission_request: None,
            pending_connector_auth: None,
            pending_schedule_request: None,
            codex_thread_id: None,
            plan_steps: Vec::new(),
            plan_progress: None,
        };
        self.persist(&session)?;
        self.active
            .write()
            .await
            .insert((user_id.to_string(), session_id), session.clone());
        Ok(session)
    }

    pub async fn list_sessions(&self, user_id: &str) -> anyhow::Result<Vec<SessionInfo>> {
        let mut records = Vec::new();
        for session_id in self.sandboxes.list_user_sessions(user_id)? {
            if let Some(record) = self.load(user_id, &session_id)? {
                records.push(self.info_from_record(&record)?);
            }
        }
        records.sort_by(|a, b| b.last_active.cmp(&a.last_active));
        Ok(records)
    }

    pub async fn get_session(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> anyhow::Result<Option<SessionDetail>> {
        if let Some(session) = self
            .active
            .read()
            .await
            .get(&(user_id.to_string(), session_id.to_string()))
            .cloned()
        {
            return Ok(Some(self.detail_from_record(&session)?));
        }
        Ok(self
            .load(user_id, session_id)?
            .map(|record| self.detail_from_record(&record))
            .transpose()?)
    }

    pub async fn delete_session(&self, user_id: &str, session_id: &str) -> anyhow::Result<bool> {
        self.active
            .write()
            .await
            .remove(&(user_id.to_string(), session_id.to_string()));
        let dir = self.sandboxes.session_dir(user_id, session_id)?;
        if dir.exists() {
            tokio::fs::remove_dir_all(dir).await?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub async fn clear_context(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> anyhow::Result<Option<usize>> {
        let Some(mut record) = self.load(user_id, session_id)? else {
            return Ok(None);
        };
        record.messages.clear();
        record.message_count = 0;
        record.title.clear();
        record.last_active = now_iso();
        self.persist(&record)?;
        self.active
            .write()
            .await
            .insert((user_id.to_string(), session_id.to_string()), record);
        Ok(Some(0))
    }

    pub fn load(&self, user_id: &str, session_id: &str) -> anyhow::Result<Option<SessionRecord>> {
        let meta_file = self
            .sandboxes
            .session_dir(user_id, session_id)?
            .join("meta.json");
        if !meta_file.is_file() {
            return Ok(None);
        }
        let mut record: SessionRecord = serde_json::from_slice(&std::fs::read(meta_file)?)?;
        record.messages = read_jsonl(
            self.sandboxes
                .session_dir(user_id, session_id)?
                .join("messages.jsonl"),
        )?;
        record.message_count = record.messages.len();
        Ok(Some(record))
    }

    pub fn persist(&self, record: &SessionRecord) -> anyhow::Result<()> {
        let dir = self
            .sandboxes
            .session_dir(&record.user_id, &record.session_id)?;
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("meta.json"), serde_json::to_vec_pretty(record)?)?;
        let messages = record
            .messages
            .iter()
            .map(|message| serde_json::to_string(message))
            .collect::<Result<Vec<_>, _>>()?
            .join("\n");
        std::fs::write(dir.join("messages.jsonl"), messages)?;
        Ok(())
    }

    pub async fn save_record(&self, mut record: SessionRecord) -> anyhow::Result<()> {
        record.message_count = record.messages.len();
        record.last_active = now_iso();
        self.persist(&record)?;
        self.active
            .write()
            .await
            .insert((record.user_id.clone(), record.session_id.clone()), record);
        Ok(())
    }

    fn info_from_record(&self, record: &SessionRecord) -> anyhow::Result<SessionInfo> {
        Ok(SessionInfo {
            session_id: record.session_id.clone(),
            title: record.title.clone(),
            model: record.model.clone(),
            created_at: record.created_at.clone(),
            last_active: record.last_active.clone(),
            message_count: record.message_count,
            status: public_status(&record.status, record.pending_permission_request.as_ref()),
            changed_file_count: 0,
            pending_approval_count: u32::from(record.pending_permission_request.is_some()),
            workspace_size_bytes: None,
        })
    }

    fn detail_from_record(&self, record: &SessionRecord) -> anyhow::Result<SessionDetail> {
        Ok(SessionDetail {
            info: self.info_from_record(record)?,
            messages: record.messages.clone(),
            pending_question: record.pending_question.clone(),
            pending_options: record.pending_options.clone(),
            pending_permission_request: record.pending_permission_request.clone(),
            pending_schedule_request: record.pending_schedule_request.clone(),
            plan_steps: record.plan_steps.clone(),
            plan_progress: record.plan_progress.clone(),
            task_steps: record.plan_steps.clone(),
            task_progress: record.plan_progress.clone(),
        })
    }
}

fn read_jsonl(path: std::path::PathBuf) -> anyhow::Result<Vec<Value>> {
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(path)?;
    Ok(text
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                None
            } else {
                serde_json::from_str::<Value>(line).ok()
            }
        })
        .collect())
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn public_status(status: &str, pending_permission: Option<&Value>) -> String {
    if pending_permission.is_some() {
        return "waiting_for_approval".to_string();
    }
    match status {
        "running" => "running",
        "awaiting_user_input" | "waiting_for_user" => "waiting_for_user",
        "awaiting_permission" | "waiting_for_approval" => "waiting_for_approval",
        "queued" => "queued",
        "completed" => "completed",
        "failed" | "error" => "failed",
        "cancelled" | "canceled" => "cancelled",
        _ => "idle",
    }
    .to_string()
}
