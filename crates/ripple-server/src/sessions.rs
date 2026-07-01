use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::sync::{Mutex, RwLock};
use tokio::time::{interval, sleep, Duration};
use uuid::Uuid;

use crate::config::AppConfig;
use crate::sandbox::SandboxManager;
use crate::storage::Storage;
use crate::workspace as ws;

#[derive(Clone)]
pub struct SessionManager {
    config: Arc<AppConfig>,
    sandboxes: SandboxManager,
    storage: Storage,
    active: Arc<RwLock<HashMap<(String, String), SessionRecord>>>,
    deleted: Arc<RwLock<HashSet<(String, String)>>>,
    run_locks: Arc<std::sync::Mutex<HashMap<(String, String), Arc<Mutex<()>>>>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionRecord {
    pub session_id: String,
    pub user_id: String,
    pub title: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub context_folder_path: Option<String>,
    pub model: String,
    pub max_turns: u32,
    #[serde(default)]
    pub caller_system_prompt: Option<String>,
    #[serde(default)]
    pub total_input_tokens: u64,
    #[serde(default)]
    pub total_output_tokens: u64,
    #[serde(default)]
    pub last_input_tokens: u64,
    pub created_at: String,
    pub last_active: String,
    pub status: String,
    pub message_count: usize,
    pub messages: Vec<Value>,
    pub pending_question: Option<String>,
    pub pending_options: Option<Vec<String>>,
    pub pending_permission_request: Option<Value>,
    pub pending_connector_auth: Option<Value>,
    pub pending_control_request: Option<Value>,
    pub codex_thread_id: Option<String>,
    #[serde(default)]
    pub forked_from_session_id: Option<String>,
    #[serde(default)]
    pub forked_from_codex_thread_id: Option<String>,
    #[serde(default)]
    pub memory_disabled: bool,
    pub plan_steps: Vec<Value>,
    pub plan_progress: Option<Value>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SessionStatus {
    Idle,
    Queued,
    Running,
    Compacting,
    AwaitingUserInput,
    WaitingForUser,
    AwaitingPermission,
    WaitingForApproval,
    Suspended,
    Cancelled,
    Failed,
    Other,
}

impl SessionStatus {
    pub(crate) fn parse(status: &str) -> Self {
        match status {
            "idle" => Self::Idle,
            "queued" => Self::Queued,
            "running" => Self::Running,
            "compacting" => Self::Compacting,
            "awaiting_user_input" => Self::AwaitingUserInput,
            "waiting_for_user" => Self::WaitingForUser,
            "awaiting_permission" => Self::AwaitingPermission,
            "waiting_for_approval" => Self::WaitingForApproval,
            "suspended" => Self::Suspended,
            "cancelled" => Self::Cancelled,
            "failed" => Self::Failed,
            _ => Self::Other,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Compacting => "compacting",
            Self::AwaitingUserInput => "awaiting_user_input",
            Self::WaitingForUser => "waiting_for_user",
            Self::AwaitingPermission => "awaiting_permission",
            Self::WaitingForApproval => "waiting_for_approval",
            Self::Suspended => "suspended",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
            Self::Other => "idle",
        }
    }

    pub(crate) fn is_active_run(self) -> bool {
        matches!(self, Self::Queued | Self::Running)
    }

    pub(crate) fn is_busy(self) -> bool {
        matches!(self, Self::Queued | Self::Running | Self::Compacting)
    }

    pub(crate) fn is_waiting_for_user(self) -> bool {
        matches!(self, Self::AwaitingUserInput | Self::WaitingForUser)
    }

    pub(crate) fn is_awaiting_approval(self) -> bool {
        matches!(self, Self::AwaitingPermission | Self::WaitingForApproval)
    }
}

impl SessionRecord {
    pub(crate) fn status_kind(&self) -> SessionStatus {
        SessionStatus::parse(&self.status)
    }

    pub(crate) fn set_status(&mut self, status: SessionStatus) {
        self.status = status.as_str().to_string();
    }
}

#[derive(Debug, Serialize)]
pub struct SessionInfo {
    pub session_id: String,
    pub title: String,
    pub pinned: bool,
    pub context_folder_path: Option<String>,
    pub model: String,
    pub created_at: String,
    pub last_active: String,
    pub message_count: usize,
    pub status: String,
    pub changed_file_count: u32,
    pub pending_approval_count: u32,
    pub workspace_size_bytes: Option<u64>,
    pub forked_from_session_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SessionDetail {
    #[serde(flatten)]
    pub info: SessionInfo,
    pub messages: Vec<Value>,
    pub pending_question: Option<String>,
    pub pending_options: Option<Vec<String>>,
    pub pending_permission_request: Option<Value>,
    pub pending_control_request: Option<Value>,
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
    pub context_folder_path: Option<String>,
}

pub fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.is_empty() || session_id.len() > 64 {
        return Err("session_id must be 1-64 characters".to_string());
    }
    if session_id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        Ok(())
    } else {
        Err("session_id must match ^[a-zA-Z0-9_-]{1,64}$".to_string())
    }
}

impl SessionManager {
    pub fn new(config: Arc<AppConfig>, sandboxes: SandboxManager) -> Self {
        let storage = Storage::new(config.clone()).expect("failed to initialize Ripple storage");
        Self::new_with_storage(config, sandboxes, storage)
    }

    pub fn new_with_storage(
        config: Arc<AppConfig>,
        sandboxes: SandboxManager,
        storage: Storage,
    ) -> Self {
        Self {
            config,
            sandboxes,
            storage,
            active: Arc::new(RwLock::new(HashMap::new())),
            deleted: Arc::new(RwLock::new(HashSet::new())),
            run_locks: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    pub fn session_lock(&self, user_id: &str, session_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.run_locks.lock().expect("session run locks poisoned");
        locks
            .entry((user_id.to_string(), session_id.to_string()))
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub async fn create_session(
        &self,
        user_id: &str,
        input: CreateSessionInput,
    ) -> anyhow::Result<SessionRecord> {
        self.create_session_with_id(user_id, input, None).await
    }

    pub async fn create_session_with_id(
        &self,
        user_id: &str,
        input: CreateSessionInput,
        session_id: Option<&str>,
    ) -> anyhow::Result<SessionRecord> {
        self.sandboxes.ensure_sandbox(user_id)?;
        let session_id = match session_id {
            Some(session_id) => {
                validate_session_id(session_id).map_err(anyhow::Error::msg)?;
                if self.load(user_id, session_id).await?.is_some() {
                    anyhow::bail!("session_id already exists");
                }
                session_id.to_string()
            }
            None => self.next_generated_session_id(user_id).await?,
        };
        let context_folder_path =
            self.normalize_context_folder_path(user_id, input.context_folder_path.as_deref())?;
        self.deleted
            .write()
            .await
            .remove(&(user_id.to_string(), session_id.clone()));
        let now = now_iso();
        let session = SessionRecord {
            session_id: session_id.clone(),
            user_id: user_id.to_string(),
            title: String::new(),
            pinned: false,
            context_folder_path,
            model: input
                .model
                .unwrap_or_else(|| self.config.default_model.clone()),
            max_turns: input.max_turns.unwrap_or(200),
            caller_system_prompt: input.system_prompt,
            total_input_tokens: 0,
            total_output_tokens: 0,
            last_input_tokens: 0,
            created_at: now.clone(),
            last_active: now,
            status: "idle".to_string(),
            message_count: 0,
            messages: Vec::new(),
            pending_question: None,
            pending_options: None,
            pending_permission_request: None,
            pending_connector_auth: None,
            pending_control_request: None,
            codex_thread_id: None,
            forked_from_session_id: None,
            forked_from_codex_thread_id: None,
            memory_disabled: false,
            plan_steps: Vec::new(),
            plan_progress: None,
        };
        self.persist(&session).await?;
        self.active
            .write()
            .await
            .insert((user_id.to_string(), session_id), session.clone());
        Ok(session)
    }

    pub async fn fork_session_from_record(
        &self,
        user_id: &str,
        source_session_id: &str,
        forked_codex_thread_id: String,
    ) -> anyhow::Result<Option<SessionRecord>> {
        self.sandboxes.ensure_sandbox(user_id)?;
        let Some(source) = self.load(user_id, source_session_id).await? else {
            return Ok(None);
        };
        let source_codex_thread_id = source
            .codex_thread_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow::anyhow!("Source session has no Codex thread"))?
            .to_string();
        let forked_codex_thread_id = forked_codex_thread_id.trim();
        if forked_codex_thread_id.is_empty() {
            anyhow::bail!("Forked Codex thread id cannot be empty");
        }
        let session_id = self.next_generated_session_id(user_id).await?;
        self.deleted
            .write()
            .await
            .remove(&(user_id.to_string(), session_id.clone()));
        let now = now_iso();
        let mut forked = source.clone();
        forked.session_id = session_id.clone();
        forked.user_id = user_id.to_string();
        forked.pinned = false;
        forked.created_at = now.clone();
        forked.last_active = now;
        forked.set_status(SessionStatus::Idle);
        forked.message_count = forked.messages.len();
        forked.pending_question = None;
        forked.pending_options = None;
        forked.pending_permission_request = None;
        forked.pending_connector_auth = None;
        forked.pending_control_request = None;
        forked.codex_thread_id = Some(forked_codex_thread_id.to_string());
        forked.forked_from_session_id = Some(source.session_id.clone());
        forked.forked_from_codex_thread_id = Some(source_codex_thread_id);
        forked.total_input_tokens = 0;
        forked.total_output_tokens = 0;
        forked.last_input_tokens = 0;
        forked.plan_steps.clear();
        forked.plan_progress = None;
        self.persist(&forked).await?;
        self.active
            .write()
            .await
            .insert((user_id.to_string(), session_id), forked.clone());
        Ok(Some(forked))
    }

    async fn next_generated_session_id(&self, user_id: &str) -> anyhow::Result<String> {
        loop {
            let session_id = format!("srv-{}", &Uuid::new_v4().simple().to_string()[..12]);
            if !self.storage.session_exists(user_id, &session_id).await? {
                return Ok(session_id);
            }
        }
    }

    pub async fn list_sessions(&self, user_id: &str) -> anyhow::Result<Vec<SessionInfo>> {
        let mut records = self
            .storage
            .list_sessions(user_id)
            .await?
            .into_iter()
            .filter(session_should_appear_in_list)
            .map(|record| self.info_from_record(&record))
            .collect::<anyhow::Result<Vec<_>>>()?;
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
            .load(user_id, session_id)
            .await?
            .map(|record| self.detail_from_record(&record))
            .transpose()?)
    }

    pub async fn delete_session(&self, user_id: &str, session_id: &str) -> anyhow::Result<bool> {
        let key = (user_id.to_string(), session_id.to_string());
        self.deleted.write().await.insert(key.clone());
        let had_active = self.active.write().await.remove(&key).is_some();
        let existed = self.storage.delete_session(user_id, session_id).await?;
        let dir = self.sandboxes.session_dir(user_id, session_id)?;
        if dir.exists() {
            remove_dir_all_with_retry(&dir).await?;
        }
        self.run_locks
            .lock()
            .expect("session run locks poisoned")
            .remove(&key);
        if had_active || existed {
            Ok(true)
        } else {
            self.deleted.write().await.remove(&key);
            Ok(false)
        }
    }

    pub async fn clear_user_cache(&self, user_id: &str) {
        self.active
            .write()
            .await
            .retain(|(cached_user_id, _), _| cached_user_id != user_id);
        self.deleted
            .write()
            .await
            .retain(|(cached_user_id, _)| cached_user_id != user_id);
        self.run_locks
            .lock()
            .expect("session run locks poisoned")
            .retain(|(cached_user_id, _), _| cached_user_id != user_id);
    }

    pub async fn save_record_if_exists(&self, record: SessionRecord) -> anyhow::Result<bool> {
        self.save_record_inner(record, true, true).await
    }

    pub async fn save_record_if_exists_preserving_activity(
        &self,
        record: SessionRecord,
    ) -> anyhow::Result<bool> {
        self.save_record_inner(record, true, false).await
    }

    pub async fn save_record(&self, record: SessionRecord) -> anyhow::Result<()> {
        self.save_record_inner(record, false, true).await?;
        Ok(())
    }

    pub async fn save_record_preserving_activity(
        &self,
        record: SessionRecord,
    ) -> anyhow::Result<()> {
        self.save_record_inner(record, false, false).await?;
        Ok(())
    }

    pub async fn update_session_metadata(
        &self,
        user_id: &str,
        session_id: &str,
        title: Option<String>,
        pinned: Option<bool>,
        context_folder_path: Option<Option<String>>,
        model: Option<String>,
    ) -> anyhow::Result<Option<SessionInfo>> {
        let key = (user_id.to_string(), session_id.to_string());
        if self.deleted.read().await.contains(&key) {
            self.active.write().await.remove(&key);
            return Ok(None);
        }

        let record = if let Some(record) = self.active.read().await.get(&key).cloned() {
            Some(record)
        } else {
            self.load(user_id, session_id).await?
        };
        let Some(mut record) = record else {
            return Ok(None);
        };

        if let Some(title) = title {
            record.title = title;
        }
        if let Some(pinned) = pinned {
            record.pinned = pinned;
        }
        if let Some(model) = model {
            record.model = model;
        }
        if let Some(context_folder_path) = context_folder_path {
            record.context_folder_path =
                self.normalize_context_folder_path(user_id, context_folder_path.as_deref())?;
        }

        self.persist(&record).await?;
        self.active.write().await.insert(key, record.clone());
        Ok(Some(self.info_from_record(&record)?))
    }

    pub async fn update_generated_title_if_unchanged(
        &self,
        user_id: &str,
        session_id: &str,
        fallback_title: &str,
        generated_title: &str,
    ) -> anyhow::Result<bool> {
        let key = (user_id.to_string(), session_id.to_string());
        if self.deleted.read().await.contains(&key) {
            self.active.write().await.remove(&key);
            return Ok(false);
        }
        let Some(mut record) = self.load(user_id, session_id).await? else {
            return Ok(false);
        };
        let generated_title = generated_title.trim();
        if generated_title.is_empty() || record.title.trim() != fallback_title.trim() {
            return Ok(false);
        }
        record.title = generated_title.to_string();
        self.persist(&record).await?;
        self.active.write().await.insert(key, record);
        Ok(true)
    }

    async fn save_record_inner(
        &self,
        mut record: SessionRecord,
        require_existing: bool,
        touch_activity: bool,
    ) -> anyhow::Result<bool> {
        let key = (record.user_id.clone(), record.session_id.clone());
        let deleted = self.deleted.read().await;
        if deleted.contains(&key) {
            drop(deleted);
            self.active.write().await.remove(&key);
            if require_existing {
                return Ok(false);
            }
            anyhow::bail!("Session was deleted");
        }

        if require_existing {
            let Some(existing) = self
                .storage
                .load_session(&record.user_id, &record.session_id)
                .await?
            else {
                drop(deleted);
                self.active.write().await.remove(&key);
                return Ok(false);
            };
            if !existing.title.trim().is_empty() && existing.title != record.title {
                record.title = existing.title;
            }
        }

        record.message_count = record.messages.len();
        if touch_activity {
            record.last_active = now_iso();
        }
        self.persist(&record).await?;
        self.active
            .write()
            .await
            .insert((record.user_id.clone(), record.session_id.clone()), record);
        drop(deleted);
        Ok(true)
    }

    pub async fn suspend_session(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> anyhow::Result<Option<SessionRecord>> {
        let key = (user_id.to_string(), session_id.to_string());
        let record = self.active.write().await.remove(&key);
        let record = match record {
            Some(record) => Some(record),
            None => self.load(user_id, session_id).await?,
        };
        let Some(mut record) = record else {
            return Ok(None);
        };
        if record.status_kind() == SessionStatus::Suspended {
            return Ok(None);
        }
        record.set_status(SessionStatus::Suspended);
        record.last_active = now_iso();
        self.persist(&record).await?;
        Ok(Some(record))
    }

    pub async fn resume_session(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> anyhow::Result<Option<SessionRecord>> {
        let Some(mut record) = self.load(user_id, session_id).await? else {
            return Ok(None);
        };
        if record.status_kind() == SessionStatus::Suspended {
            record.set_status(SessionStatus::Idle);
        }
        self.save_record_preserving_activity(record.clone()).await?;
        Ok(Some(record))
    }

    pub async fn list_suspended_sessions(&self, user_id: &str) -> anyhow::Result<Vec<Value>> {
        let mut records = Vec::new();
        for record in self.storage.list_sessions(user_id).await? {
            if record.status_kind() != SessionStatus::Suspended {
                continue;
            }
            records.push(serde_json::json!({
                "session_id": record.session_id,
                "model": record.model,
                "message_count": record.message_count,
                "total_input_tokens": record.total_input_tokens,
                "total_output_tokens": record.total_output_tokens,
                "created_at": record.created_at,
                "last_active": record.last_active,
                "suspended_at": record.last_active
            }));
        }
        records.sort_by(|a, b| {
            b.get("last_active")
                .and_then(Value::as_str)
                .unwrap_or("")
                .cmp(a.get("last_active").and_then(Value::as_str).unwrap_or(""))
        });
        Ok(records)
    }

    pub async fn clear_pending_connector_auth(
        &self,
        user_id: &str,
        connector_name: &str,
    ) -> anyhow::Result<usize> {
        let mut cleared = 0_usize;
        for mut record in self.storage.list_sessions(user_id).await? {
            let Some(mut pending) = record.pending_connector_auth.clone() else {
                continue;
            };
            if pending.get("connector").and_then(Value::as_str) != Some(connector_name) {
                continue;
            }
            let has_resume_input = pending
                .get("resume_user_input")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty());
            if has_resume_input {
                if let Some(object) = pending.as_object_mut() {
                    object.insert("stage".to_string(), serde_json::json!("authorized"));
                }
                record.pending_connector_auth = Some(pending);
            } else {
                record.pending_connector_auth = None;
            }
            if record.status_kind().is_waiting_for_user() {
                record.set_status(SessionStatus::Idle);
            }
            record.last_active = now_iso();
            self.persist(&record).await?;
            let key = (user_id.to_string(), record.session_id.clone());
            if self.active.read().await.contains_key(&key) {
                self.active.write().await.insert(key, record);
            }
            cleared += 1;
        }
        Ok(cleared)
    }

    pub async fn cancel_pending_connector_auth(
        &self,
        user_id: &str,
        connector_name: &str,
    ) -> anyhow::Result<usize> {
        let mut cancelled = 0_usize;
        for mut record in self.storage.list_sessions(user_id).await? {
            let Some(pending) = record.pending_connector_auth.clone() else {
                continue;
            };
            if pending.get("connector").and_then(Value::as_str) != Some(connector_name) {
                continue;
            }
            record.pending_connector_auth = None;
            if record.status_kind().is_waiting_for_user() {
                record.set_status(SessionStatus::Idle);
            }
            record.last_active = now_iso();
            self.persist(&record).await?;
            let key = (user_id.to_string(), record.session_id.clone());
            if self.active.read().await.contains_key(&key) {
                self.active.write().await.insert(key, record);
            }
            cancelled += 1;
        }
        Ok(cancelled)
    }

    pub async fn pending_connector_auth_count(
        &self,
        user_id: &str,
        connector_name: &str,
    ) -> anyhow::Result<usize> {
        let mut count = 0_usize;
        for record in self.storage.list_sessions(user_id).await? {
            if record
                .pending_connector_auth
                .as_ref()
                .and_then(|pending| pending.get("connector"))
                .and_then(Value::as_str)
                == Some(connector_name)
            {
                count += 1;
            }
        }
        Ok(count)
    }

    pub async fn maintenance_loop(self) {
        let mut interval = interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            let _ = self.suspend_idle_and_cleanup().await;
        }
    }

    pub async fn suspend_idle_and_cleanup(&self) -> anyhow::Result<(usize, usize)> {
        let now = OffsetDateTime::now_utc();
        let idle_suspend_seconds = self.config.sandbox.idle_suspend_seconds;
        let retention_seconds = self.config.sandbox.retention_seconds;
        let mut suspended = 0_usize;
        let mut removed = 0_usize;

        let mut active = self.active.write().await;
        let keys = active.keys().cloned().collect::<Vec<_>>();
        for key in keys {
            let Some(record) = active.get_mut(&key) else {
                continue;
            };
            if should_auto_suspend(record, now, idle_suspend_seconds) {
                record.set_status(SessionStatus::Suspended);
                record.last_active = now_iso();
                self.persist(record).await?;
                suspended += 1;
            }
        }
        active.retain(|_, record| record.status_kind() != SessionStatus::Suspended);
        drop(active);

        if retention_seconds > 0 {
            for user_id in self.sandboxes.list_user_sandboxes()? {
                for record in self.storage.list_sessions(&user_id).await? {
                    if record.status_kind() != SessionStatus::Suspended {
                        continue;
                    }
                    if session_age_seconds(&record, now).is_some_and(|age| age > retention_seconds)
                    {
                        let _ = self
                            .storage
                            .delete_session(&user_id, &record.session_id)
                            .await?;
                        let dir = self.sandboxes.session_dir(&user_id, &record.session_id)?;
                        if dir.exists() {
                            tokio::fs::remove_dir_all(dir).await?;
                        }
                        removed += 1;
                    }
                }
            }
        }
        Ok((suspended, removed))
    }

    pub async fn clear_context(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> anyhow::Result<Option<usize>> {
        let Some(mut record) = self.load(user_id, session_id).await? else {
            return Ok(None);
        };
        record.messages.clear();
        record.message_count = 0;
        record.title.clear();
        record.set_status(SessionStatus::Idle);
        record.total_input_tokens = 0;
        record.total_output_tokens = 0;
        record.last_input_tokens = 0;
        record.pending_question = None;
        record.pending_options = None;
        record.pending_permission_request = None;
        record.pending_connector_auth = None;
        record.pending_control_request = None;
        record.codex_thread_id = None;
        record.plan_steps.clear();
        record.plan_progress = None;
        record.last_active = now_iso();
        self.persist(&record).await?;
        self.active
            .write()
            .await
            .insert((user_id.to_string(), session_id.to_string()), record);
        Ok(Some(0))
    }

    pub async fn begin_context_compaction(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> anyhow::Result<Option<String>> {
        let Some(mut record) = self.load(user_id, session_id).await? else {
            return Ok(None);
        };
        let thread_id = record
            .codex_thread_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| anyhow::anyhow!("Session has no Codex thread to compact"))?;
        record.set_status(SessionStatus::Compacting);
        record.pending_question = None;
        record.pending_options = None;
        record.pending_permission_request = None;
        record.pending_control_request = None;
        record.plan_steps.clear();
        record.plan_progress = None;
        self.save_record(record).await?;
        Ok(Some(thread_id))
    }

    pub async fn finish_context_compaction(
        &self,
        user_id: &str,
        session_id: &str,
        succeeded: bool,
    ) -> anyhow::Result<bool> {
        let Some(mut record) = self.load(user_id, session_id).await? else {
            return Ok(false);
        };
        if record.status_kind() != SessionStatus::Compacting {
            return Ok(false);
        }
        record.set_status(if succeeded {
            SessionStatus::Idle
        } else {
            SessionStatus::Failed
        });
        record.pending_permission_request = None;
        record.plan_steps.clear();
        record.plan_progress = None;
        self.save_record_if_exists_preserving_activity(record).await
    }

    pub async fn recover_stale_context_compaction(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> anyhow::Result<bool> {
        let lock = self.session_lock(user_id, session_id);
        let Ok(_guard) = lock.try_lock() else {
            return Ok(false);
        };
        self.recover_context_compaction_after_lock(user_id, session_id)
            .await
    }

    pub async fn recover_context_compaction_after_lock(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> anyhow::Result<bool> {
        let Some(mut record) = self.load(user_id, session_id).await? else {
            return Ok(false);
        };
        if record.status_kind() != SessionStatus::Compacting {
            return Ok(false);
        }
        record.set_status(SessionStatus::Idle);
        record.pending_permission_request = None;
        record.plan_steps.clear();
        record.plan_progress = None;
        self.save_record_if_exists_preserving_activity(record).await
    }

    pub async fn load(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> anyhow::Result<Option<SessionRecord>> {
        self.storage.load_session(user_id, session_id).await
    }

    pub async fn persist(&self, record: &SessionRecord) -> anyhow::Result<()> {
        self.storage.save_session(record).await?;
        Ok(())
    }

    fn info_from_record(&self, record: &SessionRecord) -> anyhow::Result<SessionInfo> {
        Ok(SessionInfo {
            session_id: record.session_id.clone(),
            title: if record.title.trim().is_empty() {
                extract_title_from_messages(&record.messages)
            } else {
                record.title.clone()
            },
            pinned: record.pinned,
            context_folder_path: record.context_folder_path.clone(),
            model: record.model.clone(),
            created_at: record.created_at.clone(),
            last_active: record.last_active.clone(),
            message_count: record.message_count,
            status: public_status(record),
            changed_file_count: changed_file_count_from_messages(&record.messages),
            pending_approval_count: u32::from(record.pending_permission_request.is_some()),
            workspace_size_bytes: None,
            forked_from_session_id: record.forked_from_session_id.clone(),
        })
    }

    fn detail_from_record(&self, record: &SessionRecord) -> anyhow::Result<SessionDetail> {
        Ok(SessionDetail {
            info: self.info_from_record(record)?,
            messages: record.messages.clone(),
            pending_question: record.pending_question.clone(),
            pending_options: record.pending_options.clone(),
            pending_permission_request: record.pending_permission_request.clone(),
            pending_control_request: record.pending_control_request.clone(),
            plan_steps: record.plan_steps.clone(),
            plan_progress: record.plan_progress.clone(),
            task_steps: record.plan_steps.clone(),
            task_progress: record.plan_progress.clone(),
        })
    }

    fn normalize_context_folder_path(
        &self,
        user_id: &str,
        raw_path: Option<&str>,
    ) -> anyhow::Result<Option<String>> {
        let Some(raw_path) = raw_path.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(None);
        };
        let workspace = self.sandboxes.ensure_sandbox(user_id)?;
        let target = ws::validate_existing_path(raw_path, &workspace)?;
        if !target.is_dir() {
            anyhow::bail!("Context folder path must be an existing directory");
        }
        let workspace_path = ws::workspace_path(&workspace, &target)?;
        if workspace_path == "/workspace" {
            Ok(None)
        } else {
            Ok(Some(workspace_path))
        }
    }
}

async fn remove_dir_all_with_retry(path: &Path) -> std::io::Result<()> {
    const ATTEMPTS: usize = 5;
    for attempt in 1..=ATTEMPTS {
        match tokio::fs::remove_dir_all(path).await {
            Ok(()) => return Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(err) if attempt == ATTEMPTS => return Err(err),
            Err(_) => sleep(Duration::from_millis(10)).await,
        }
    }
    Ok(())
}

pub fn record_usage(record: &mut SessionRecord, usage: &Value) {
    let input_tokens = usage_u64(usage, "prompt_tokens");
    let output_tokens = usage_u64(usage, "completion_tokens");
    record.total_input_tokens = record.total_input_tokens.saturating_add(input_tokens);
    record.total_output_tokens = record.total_output_tokens.saturating_add(output_tokens);
    record.last_input_tokens = input_tokens;
}

pub fn extract_title_from_messages(messages: &[Value]) -> String {
    for message in messages {
        if message
            .get("role")
            .and_then(Value::as_str)
            .is_some_and(|role| role != "user")
            || message
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind != "user")
        {
            continue;
        }
        let Some(content) = message.get("content") else {
            continue;
        };
        if let Some(text) = content
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            return text.chars().take(50).collect();
        }
        if let Some(blocks) = content.as_array() {
            for block in blocks {
                if block.get("type").and_then(Value::as_str) != Some("text") {
                    continue;
                }
                if let Some(text) = block
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                {
                    return text.chars().take(50).collect();
                }
            }
        }
    }
    String::new()
}

fn changed_file_count_from_messages(messages: &[Value]) -> u32 {
    let mut paths = HashSet::<String>::new();
    for message in messages {
        collect_changed_file_paths(message.get("content"), &mut paths);
        collect_changed_file_paths(message.pointer("/message/content"), &mut paths);
    }
    paths.len().try_into().unwrap_or(u32::MAX)
}

fn collect_changed_file_paths(content: Option<&Value>, paths: &mut HashSet<String>) {
    let Some(blocks) = content.and_then(Value::as_array) else {
        return;
    };
    for block in blocks {
        if block.get("type").and_then(Value::as_str) != Some("changed_files") {
            continue;
        }
        let Some(files) = block.get("files").and_then(Value::as_array) else {
            continue;
        };
        for file in files {
            if let Some(path) = file
                .get("path")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|path| !path.is_empty())
            {
                paths.insert(path.to_string());
            }
        }
    }
}

fn usage_u64(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn should_auto_suspend(record: &SessionRecord, now: OffsetDateTime, limit_seconds: u64) -> bool {
    if limit_seconds == 0 {
        return false;
    }
    let status = record.status_kind();
    if status.is_busy() || status.is_awaiting_approval() {
        return false;
    }
    session_age_seconds(record, now).is_some_and(|age| age > limit_seconds)
}

fn session_age_seconds(record: &SessionRecord, now: OffsetDateTime) -> Option<u64> {
    let last_active = OffsetDateTime::parse(&record.last_active, &Rfc3339).ok()?;
    let seconds = (now - last_active).whole_seconds();
    if seconds < 0 {
        None
    } else {
        Some(seconds as u64)
    }
}

fn public_status(record: &SessionRecord) -> String {
    if record.pending_permission_request.is_some() {
        return "waiting_for_approval".to_string();
    }
    if record.status_kind().is_waiting_for_user() && !has_pending_user_work(record) {
        return "idle".to_string();
    }
    match record.status.as_str() {
        "running" => "running",
        "compacting" => "compacting",
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

fn has_pending_user_work(record: &SessionRecord) -> bool {
    record.pending_question.is_some()
        || record
            .pending_options
            .as_ref()
            .is_some_and(|options| !options.is_empty())
        || record.pending_permission_request.is_some()
        || record.pending_connector_auth.is_some()
        || record.pending_control_request.is_some()
}

fn session_should_appear_in_list(record: &SessionRecord) -> bool {
    if record.message_count > 0 || !record.messages.is_empty() {
        return true;
    }
    if record.pinned || !record.title.trim().is_empty() {
        return true;
    }
    if record.total_input_tokens > 0
        || record.total_output_tokens > 0
        || record.last_input_tokens > 0
        || record
            .codex_thread_id
            .as_deref()
            .is_some_and(|thread_id| !thread_id.trim().is_empty())
    {
        return true;
    }
    if record.pending_question.is_some()
        || record
            .pending_options
            .as_ref()
            .is_some_and(|options| !options.is_empty())
        || record.pending_permission_request.is_some()
        || record.pending_connector_auth.is_some()
        || record.pending_control_request.is_some()
        || !record.plan_steps.is_empty()
        || record.plan_progress.is_some()
    {
        return true;
    }
    matches!(
        record.status_kind(),
        SessionStatus::Queued
            | SessionStatus::Running
            | SessionStatus::Compacting
            | SessionStatus::AwaitingUserInput
            | SessionStatus::WaitingForUser
            | SessionStatus::AwaitingPermission
            | SessionStatus::WaitingForApproval
            | SessionStatus::Cancelled
            | SessionStatus::Failed
            | SessionStatus::Other
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    use crate::config::{
        AppConfig, CodexConfig, CorsConfig, FeishuConfig, GogcliOAuthConfig, LoggingConfig,
        SandboxConfig, SecurityConfig, SkillsConfig, UserAuthConfig,
    };
    use time::Duration as TimeDuration;

    fn test_config(root: &Path) -> Arc<AppConfig> {
        Arc::new(AppConfig {
            repo_root: root.to_path_buf(),
            host: "127.0.0.1".to_string(),
            port: 0,
            api_keys: Vec::new(),
            security: SecurityConfig::default(),
            user_auth: UserAuthConfig::default(),
            api_docs: crate::config::ApiDocsConfig::default(),
            cors: CorsConfig::default(),
            default_model: "codex-test".to_string(),
            model_presets: Default::default(),
            logging: LoggingConfig {
                level: "debug".to_string(),
            },
            sandbox: SandboxConfig {
                sandboxes_root: root.join("sandboxes"),
                workspaces_root: None,
                caches_root: root.join("cache"),
                idle_suspend_seconds: 1,
                retention_seconds: 1,
                max_workspace_mb: 2048,
                tmpfs_size_mb: 64,
                nsjail_path: "nsjail".to_string(),
                python_envs_root: root.join("cache/python-envs"),
                python_env_uv_cache: root.join("cache/uv-cache"),
                python_env_max_packages: 20,
                uv_bin_dir: None,
                node_dir: None,
                lark_cli_install_root: None,
                notion_cli_install_root: None,
                gogcli_cli_install_root: None,
                cli_tools: Vec::new(),
                pypi_mirror_url: None,
                npm_registry_url: None,
            },
            codex: CodexConfig {
                enabled: true,
                codex_executable: "codex".to_string(),
                app_server_args: Vec::new(),
                codex_home: None,
                approval_policy: "never".to_string(),
                sandbox_type: "workspace-write".to_string(),
                network_access: true,
                idle_timeout_seconds: 1800,
                max_workers_per_pool: 8,
                max_total_pool_workers: 256,
                max_runtime_seconds: 3600,
                runtime_log_retention_seconds: 86_400,
                runtime_log_max_mb: 64,
                runtime_log_cleanup_interval_seconds: 3600,
            },
            task_trigger_extraction_max_runtime_seconds: 120,
            task_trigger_poll_interval_seconds: 15,
            document_preview: crate::config::DocumentPreviewConfig {
                cache_root: root.join("cache/previews"),
                libreoffice_path: "soffice".to_string(),
                max_source_bytes: 64 * 1024 * 1024,
                conversion_timeout_seconds: 120,
            },
            skills: SkillsConfig {
                shared_dirs: Vec::new(),
            },
            public_base_url: None,
            feishu: FeishuConfig::default(),
            gogcli_oauth: GogcliOAuthConfig {
                auto_register_client: true,
                auto_from_request: true,
                callback_url: None,
                client_secret_json: None,
                client: None,
            },
        })
    }

    #[tokio::test]
    async fn list_sessions_omits_empty_drafts_until_user_activity() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("ripple-session-test-{}", Uuid::new_v4()));
        let config = test_config(&root);
        let manager = SessionManager::new(config.clone(), SandboxManager::new(config));
        let user_id = "alice";

        let draft = manager
            .create_session(
                user_id,
                CreateSessionInput {
                    model: None,
                    max_turns: None,
                    system_prompt: None,
                    context_folder_path: None,
                },
            )
            .await?;

        let visible_ids = manager
            .list_sessions(user_id)
            .await?
            .into_iter()
            .map(|session| session.session_id)
            .collect::<Vec<_>>();
        assert!(!visible_ids.contains(&draft.session_id));

        let mut active = manager
            .create_session(
                user_id,
                CreateSessionInput {
                    model: None,
                    max_turns: None,
                    system_prompt: None,
                    context_folder_path: None,
                },
            )
            .await?;
        active.messages.push(serde_json::json!({
            "role": "user",
            "content": "hello"
        }));
        manager.save_record(active.clone()).await?;

        let mut awaiting_auth = manager
            .create_session(
                user_id,
                CreateSessionInput {
                    model: None,
                    max_turns: None,
                    system_prompt: None,
                    context_folder_path: None,
                },
            )
            .await?;
        awaiting_auth.set_status(SessionStatus::AwaitingUserInput);
        awaiting_auth.pending_connector_auth = Some(serde_json::json!({
            "connector": "notion",
            "stage": "awaiting_user_auth"
        }));
        manager.save_record(awaiting_auth.clone()).await?;

        let mut suspended_draft = manager
            .create_session(
                user_id,
                CreateSessionInput {
                    model: None,
                    max_turns: None,
                    system_prompt: None,
                    context_folder_path: None,
                },
            )
            .await?;
        suspended_draft.set_status(SessionStatus::Suspended);
        manager.save_record(suspended_draft.clone()).await?;

        let visible_ids = manager
            .list_sessions(user_id)
            .await?
            .into_iter()
            .map(|session| session.session_id)
            .collect::<Vec<_>>();
        assert!(!visible_ids.contains(&draft.session_id));
        assert!(visible_ids.contains(&active.session_id));
        assert!(visible_ids.contains(&awaiting_auth.session_id));
        assert!(!visible_ids.contains(&suspended_draft.session_id));

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn update_session_metadata_persists_selected_model() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("ripple-session-test-{}", Uuid::new_v4()));
        let config = test_config(&root);
        let manager = SessionManager::new(config.clone(), SandboxManager::new(config));
        let user_id = "alice";

        let session = manager
            .create_session(
                user_id,
                CreateSessionInput {
                    model: Some("codex-low".to_string()),
                    max_turns: None,
                    system_prompt: None,
                    context_folder_path: None,
                },
            )
            .await?;

        let updated = manager
            .update_session_metadata(
                user_id,
                &session.session_id,
                None,
                None,
                None,
                Some("codex-high".to_string()),
            )
            .await?
            .expect("session should be updated");

        assert_eq!(updated.model, "codex-high");
        assert_eq!(
            manager
                .load(user_id, &session.session_id)
                .await?
                .expect("session should reload")
                .model,
            "codex-high"
        );

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn create_session_with_id_uses_valid_caller_supplied_id() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("ripple-session-test-{}", Uuid::new_v4()));
        let config = test_config(&root);
        let manager = SessionManager::new(config.clone(), SandboxManager::new(config));
        let user_id = "alice";

        let session = manager
            .create_session_with_id(
                user_id,
                CreateSessionInput {
                    model: None,
                    max_turns: None,
                    system_prompt: None,
                    context_folder_path: None,
                },
                Some("CallerSession123"),
            )
            .await?;

        assert_eq!(session.session_id, "CallerSession123");
        assert!(manager.load(user_id, "CallerSession123").await?.is_some());

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn create_session_with_id_rejects_unsafe_caller_supplied_id() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("ripple-session-test-{}", Uuid::new_v4()));
        let config = test_config(&root);
        let manager = SessionManager::new(config.clone(), SandboxManager::new(config));

        let err = manager
            .create_session_with_id(
                "alice",
                CreateSessionInput {
                    model: None,
                    max_turns: None,
                    system_prompt: None,
                    context_folder_path: None,
                },
                Some("../outside"),
            )
            .await
            .expect_err("unsafe session id should be rejected");

        assert!(err
            .to_string()
            .contains("session_id must match ^[a-zA-Z0-9_-]{1,64}$"));

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn maintenance_suspends_idle_active_and_removes_expired_suspended() -> anyhow::Result<()>
    {
        let root = std::env::temp_dir().join(format!("ripple-session-test-{}", Uuid::new_v4()));
        let config = test_config(&root);
        let manager = SessionManager::new(config.clone(), SandboxManager::new(config));
        let user_id = "alice";
        let old_time = (OffsetDateTime::now_utc() - TimeDuration::seconds(10)).format(&Rfc3339)?;

        let mut idle = manager
            .create_session(
                user_id,
                CreateSessionInput {
                    model: None,
                    max_turns: None,
                    system_prompt: None,
                    context_folder_path: None,
                },
            )
            .await?;
        idle.last_active = old_time.clone();
        manager.persist(&idle).await?;
        manager
            .active
            .write()
            .await
            .insert((user_id.to_string(), idle.session_id.clone()), idle.clone());

        let mut expired = manager
            .create_session(
                user_id,
                CreateSessionInput {
                    model: None,
                    max_turns: None,
                    system_prompt: None,
                    context_folder_path: None,
                },
            )
            .await?;
        expired.status = "suspended".to_string();
        expired.last_active = old_time;
        manager.persist(&expired).await?;
        manager
            .active
            .write()
            .await
            .remove(&(user_id.to_string(), expired.session_id.clone()));

        let (suspended, removed) = manager.suspend_idle_and_cleanup().await?;
        assert_eq!(suspended, 1);
        assert_eq!(removed, 1);
        assert_eq!(
            manager
                .load(user_id, &idle.session_id)
                .await?
                .expect("idle session should exist")
                .status,
            "suspended"
        );
        assert!(manager.load(user_id, &expired.session_id).await?.is_none());

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn clear_context_resets_runtime_state() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("ripple-session-test-{}", Uuid::new_v4()));
        let config = test_config(&root);
        let manager = SessionManager::new(config.clone(), SandboxManager::new(config));
        let user_id = "alice";
        let mut session = manager
            .create_session(
                user_id,
                CreateSessionInput {
                    model: None,
                    max_turns: None,
                    system_prompt: None,
                    context_folder_path: None,
                },
            )
            .await?;
        session.status = "awaiting_permission".to_string();
        session
            .messages
            .push(serde_json::json!({"role": "user", "content": "old"}));
        session.pending_question = Some("question".to_string());
        session.pending_options = Some(vec!["yes".to_string()]);
        session.pending_permission_request = Some(serde_json::json!({"id": "approval"}));
        session.pending_connector_auth = Some(serde_json::json!({"connector": "notion"}));
        session.pending_control_request = Some(serde_json::json!({"title": "task trigger"}));
        session.codex_thread_id = Some("thread".to_string());
        session.plan_steps = vec![serde_json::json!({"step": "old"})];
        session.plan_progress = Some(serde_json::json!({"total": 1}));
        manager.save_record(session.clone()).await?;

        assert_eq!(
            manager.clear_context(user_id, &session.session_id).await?,
            Some(0)
        );
        let cleared = manager
            .load(user_id, &session.session_id)
            .await?
            .expect("session should exist");
        assert!(cleared.messages.is_empty());
        assert_eq!(cleared.message_count, 0);
        assert_eq!(cleared.status, "idle");
        assert!(cleared.pending_question.is_none());
        assert!(cleared.pending_options.is_none());
        assert!(cleared.pending_permission_request.is_none());
        assert!(cleared.pending_connector_auth.is_none());
        assert!(cleared.pending_control_request.is_none());
        assert!(cleared.codex_thread_id.is_none());
        assert!(cleared.plan_steps.is_empty());
        assert!(cleared.plan_progress.is_none());

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn fork_session_copies_messages_and_resets_runtime_state() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("ripple-session-test-{}", Uuid::new_v4()));
        let config = test_config(&root);
        let manager = SessionManager::new(config.clone(), SandboxManager::new(config));
        let user_id = "alice";

        let mut source = manager
            .create_session(
                user_id,
                CreateSessionInput {
                    model: Some("gpt-5".to_string()),
                    max_turns: Some(99),
                    system_prompt: Some("caller prompt".to_string()),
                    context_folder_path: None,
                },
            )
            .await?;
        source.title = "Investigate fork".to_string();
        source.status = "waiting_for_approval".to_string();
        source.messages = vec![
            serde_json::json!({"role": "user", "content": "start"}),
            serde_json::json!({"role": "assistant", "content": "done"}),
        ];
        source.message_count = source.messages.len();
        source.total_input_tokens = 123;
        source.total_output_tokens = 456;
        source.last_input_tokens = 78;
        source.pending_question = Some("continue?".to_string());
        source.pending_options = Some(vec!["yes".to_string()]);
        source.pending_permission_request = Some(serde_json::json!({"id": "approval"}));
        source.pending_connector_auth = Some(serde_json::json!({"connector": "notion"}));
        source.pending_control_request = Some(serde_json::json!({"title": "schedule"}));
        source.codex_thread_id = Some("thr_parent".to_string());
        source.memory_disabled = true;
        source.plan_steps = vec![serde_json::json!({"step": "old"})];
        source.plan_progress = Some(serde_json::json!({"total": 1}));
        manager.save_record(source.clone()).await?;

        let forked = manager
            .fork_session_from_record(user_id, &source.session_id, "thr_child".to_string())
            .await?
            .expect("source session should fork");

        assert_ne!(forked.session_id, source.session_id);
        assert_eq!(forked.user_id, user_id);
        assert_eq!(forked.title, source.title);
        assert_eq!(forked.model, "gpt-5");
        assert_eq!(forked.max_turns, 99);
        assert_eq!(
            forked.caller_system_prompt.as_deref(),
            Some("caller prompt")
        );
        assert_eq!(forked.messages, source.messages);
        assert_eq!(forked.message_count, source.messages.len());
        assert_eq!(forked.status, "idle");
        assert_eq!(forked.codex_thread_id.as_deref(), Some("thr_child"));
        assert_eq!(
            forked.forked_from_session_id.as_deref(),
            Some(source.session_id.as_str())
        );
        assert_eq!(
            forked.forked_from_codex_thread_id.as_deref(),
            Some("thr_parent")
        );
        assert_eq!(forked.total_input_tokens, 0);
        assert_eq!(forked.total_output_tokens, 0);
        assert_eq!(forked.last_input_tokens, 0);
        assert!(forked.pending_question.is_none());
        assert!(forked.pending_options.is_none());
        assert!(forked.pending_permission_request.is_none());
        assert!(forked.pending_connector_auth.is_none());
        assert!(forked.pending_control_request.is_none());
        assert!(forked.plan_steps.is_empty());
        assert!(forked.plan_progress.is_none());
        assert!(forked.memory_disabled);

        let reloaded = manager
            .load(user_id, &forked.session_id)
            .await?
            .expect("forked session should persist");
        assert_eq!(reloaded.codex_thread_id.as_deref(), Some("thr_child"));
        assert_eq!(
            reloaded.forked_from_session_id.as_deref(),
            Some(source.session_id.as_str())
        );

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn changed_file_count_counts_unique_message_blocks() {
        let messages = vec![
            serde_json::json!({
                "role": "assistant",
                "content": [
                    {
                        "type": "changed_files",
                        "files": [
                            {"path": "app/src/App.tsx", "status": "modified"},
                            {"path": "docs/new.md", "status": "added"},
                            {"path": "app/src/App.tsx", "status": "modified"}
                        ]
                    }
                ]
            }),
            serde_json::json!({
                "type": "assistant",
                "message": {
                    "content": [
                        {
                            "type": "changed_files",
                            "files": [
                                {"path": "crates/ripple-server/src/api/chat.rs", "status": "modified"}
                            ]
                        }
                    ]
                }
            }),
        ];

        assert_eq!(changed_file_count_from_messages(&messages), 3);
    }

    #[tokio::test]
    async fn list_sessions_treats_waiting_without_pending_work_as_idle() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("ripple-session-test-{}", Uuid::new_v4()));
        let config = test_config(&root);
        let manager = SessionManager::new(config.clone(), SandboxManager::new(config));
        let user_id = "alice";

        let mut stale_waiting = manager
            .create_session(
                user_id,
                CreateSessionInput {
                    model: None,
                    max_turns: None,
                    system_prompt: None,
                    context_folder_path: None,
                },
            )
            .await?;
        stale_waiting.status = "awaiting_user_input".to_string();
        stale_waiting
            .messages
            .push(serde_json::json!({"role": "assistant", "content": "Open auth."}));
        manager.save_record(stale_waiting.clone()).await?;

        let mut pending_question = manager
            .create_session(
                user_id,
                CreateSessionInput {
                    model: None,
                    max_turns: None,
                    system_prompt: None,
                    context_folder_path: None,
                },
            )
            .await?;
        pending_question.status = "awaiting_user_input".to_string();
        pending_question.pending_question = Some("Continue?".to_string());
        manager.save_record(pending_question.clone()).await?;

        let sessions = manager.list_sessions(user_id).await?;
        let stale_info = sessions
            .iter()
            .find(|session| session.session_id == stale_waiting.session_id)
            .expect("stale waiting session should be listed");
        let pending_info = sessions
            .iter()
            .find(|session| session.session_id == pending_question.session_id)
            .expect("pending question session should be listed");

        assert_eq!(stale_info.status, "idle");
        assert_eq!(pending_info.status, "waiting_for_user");

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn generated_title_updates_only_unchanged_fallback_title() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("ripple-session-test-{}", Uuid::new_v4()));
        let config = test_config(&root);
        let manager = SessionManager::new(config.clone(), SandboxManager::new(config));
        let user_id = "alice";
        let mut session = manager
            .create_session(
                user_id,
                CreateSessionInput {
                    model: None,
                    max_turns: None,
                    system_prompt: None,
                    context_folder_path: None,
                },
            )
            .await?;
        session.title = "please debug this weird mobile login failure".to_string();
        manager.save_record(session.clone()).await?;

        assert!(
            manager
                .update_generated_title_if_unchanged(
                    user_id,
                    &session.session_id,
                    "please debug this weird mobile login failure",
                    "Mobile Login Debugging"
                )
                .await?
        );
        let updated = manager
            .load(user_id, &session.session_id)
            .await?
            .expect("session");
        assert_eq!(updated.title, "Mobile Login Debugging");

        assert!(
            !manager
                .update_generated_title_if_unchanged(
                    user_id,
                    &session.session_id,
                    "please debug this weird mobile login failure",
                    "Overwritten Title"
                )
                .await?
        );
        let reloaded = manager
            .load(user_id, &session.session_id)
            .await?
            .expect("session");
        assert_eq!(reloaded.title, "Mobile Login Debugging");

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn stale_runtime_save_preserves_newer_session_title() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("ripple-session-test-{}", Uuid::new_v4()));
        let config = test_config(&root);
        let manager = SessionManager::new(config.clone(), SandboxManager::new(config));
        let user_id = "alice";
        let mut session = manager
            .create_session(
                user_id,
                CreateSessionInput {
                    model: None,
                    max_turns: None,
                    system_prompt: None,
                    context_folder_path: None,
                },
            )
            .await?;
        session.title = "please debug this weird mobile login failure".to_string();
        manager.save_record(session.clone()).await?;

        let mut stale_runtime_record = session.clone();
        stale_runtime_record
            .messages
            .push(serde_json::json!({"role": "user", "content": "follow up"}));
        stale_runtime_record.message_count = stale_runtime_record.messages.len();
        assert!(
            manager
                .update_generated_title_if_unchanged(
                    user_id,
                    &session.session_id,
                    "please debug this weird mobile login failure",
                    "Mobile Login Debugging"
                )
                .await?
        );

        assert!(manager.save_record_if_exists(stale_runtime_record).await?);
        let reloaded = manager
            .load(user_id, &session.session_id)
            .await?
            .expect("session");
        assert_eq!(reloaded.title, "Mobile Login Debugging");
        assert_eq!(reloaded.message_count, 1);

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn context_compaction_preserves_thread_and_tracks_status() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("ripple-session-test-{}", Uuid::new_v4()));
        let config = test_config(&root);
        let manager = SessionManager::new(config.clone(), SandboxManager::new(config));
        let user_id = "alice";
        let mut session = manager
            .create_session(
                user_id,
                CreateSessionInput {
                    model: None,
                    max_turns: None,
                    system_prompt: None,
                    context_folder_path: None,
                },
            )
            .await?;
        session.codex_thread_id = Some("thr_123".to_string());
        manager.save_record(session.clone()).await?;

        let thread_id = manager
            .begin_context_compaction(user_id, &session.session_id)
            .await?
            .expect("session should exist");
        assert_eq!(thread_id, "thr_123");

        let compacting = manager
            .get_session(user_id, &session.session_id)
            .await?
            .expect("session should exist");
        assert_eq!(compacting.info.status, "compacting");

        assert!(
            manager
                .finish_context_compaction(user_id, &session.session_id, true)
                .await?
        );
        let finished = manager
            .load(user_id, &session.session_id)
            .await?
            .expect("session should exist");
        assert_eq!(finished.status, "idle");
        assert_eq!(finished.codex_thread_id.as_deref(), Some("thr_123"));

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn stale_context_compaction_recovers_when_no_lock_is_active() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("ripple-session-test-{}", Uuid::new_v4()));
        let config = test_config(&root);
        let manager = SessionManager::new(config.clone(), SandboxManager::new(config));
        let user_id = "alice";
        let old_time = (OffsetDateTime::now_utc() - TimeDuration::seconds(300)).format(&Rfc3339)?;
        let mut session = manager
            .create_session(
                user_id,
                CreateSessionInput {
                    model: None,
                    max_turns: None,
                    system_prompt: None,
                    context_folder_path: None,
                },
            )
            .await?;
        session.status = "compacting".to_string();
        session.codex_thread_id = Some("thr_123".to_string());
        manager.save_record(session.clone()).await?;
        session.last_active = old_time.clone();
        manager.persist(&session).await?;

        assert!(
            manager
                .recover_stale_context_compaction(user_id, &session.session_id)
                .await?
        );
        let recovered = manager
            .load(user_id, &session.session_id)
            .await?
            .expect("session should exist");
        assert_eq!(recovered.status, "idle");
        assert_eq!(recovered.codex_thread_id.as_deref(), Some("thr_123"));
        assert_eq!(recovered.last_active, old_time);

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn resume_session_preserves_last_active_for_view_only_restore() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("ripple-session-test-{}", Uuid::new_v4()));
        let config = test_config(&root);
        let manager = SessionManager::new(config.clone(), SandboxManager::new(config));
        let user_id = "alice";
        let old_time = (OffsetDateTime::now_utc() - TimeDuration::seconds(300)).format(&Rfc3339)?;
        let mut session = manager
            .create_session(
                user_id,
                CreateSessionInput {
                    model: None,
                    max_turns: None,
                    system_prompt: None,
                    context_folder_path: None,
                },
            )
            .await?;
        session.status = "suspended".to_string();
        session.last_active = old_time.clone();
        manager.persist(&session).await?;

        let resumed = manager
            .resume_session(user_id, &session.session_id)
            .await?
            .expect("session should resume");

        assert_eq!(resumed.status, "idle");
        assert_eq!(resumed.last_active, old_time);
        assert_eq!(
            manager
                .load(user_id, &session.session_id)
                .await?
                .expect("session should persist")
                .last_active,
            old_time
        );

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn active_context_compaction_is_not_recovered() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("ripple-session-test-{}", Uuid::new_v4()));
        let config = test_config(&root);
        let manager = SessionManager::new(config.clone(), SandboxManager::new(config));
        let user_id = "alice";
        let mut session = manager
            .create_session(
                user_id,
                CreateSessionInput {
                    model: None,
                    max_turns: None,
                    system_prompt: None,
                    context_folder_path: None,
                },
            )
            .await?;
        session.status = "compacting".to_string();
        session.codex_thread_id = Some("thr_123".to_string());
        manager.save_record(session.clone()).await?;
        let lock = manager.session_lock(user_id, &session.session_id);
        let _guard = lock.lock_owned().await;

        assert!(
            !manager
                .recover_stale_context_compaction(user_id, &session.session_id)
                .await?
        );
        let current = manager
            .load(user_id, &session.session_id)
            .await?
            .expect("session should exist");
        assert_eq!(current.status, "compacting");

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn session_records_persist_without_legacy_json_files() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("ripple-session-test-{}", Uuid::new_v4()));
        let config = test_config(&root);
        let manager = SessionManager::new(config.clone(), SandboxManager::new(config.clone()));
        let user_id = "alice";
        let mut session = manager
            .create_session(
                user_id,
                CreateSessionInput {
                    model: None,
                    max_turns: None,
                    system_prompt: None,
                    context_folder_path: None,
                },
            )
            .await?;
        session
            .messages
            .push(serde_json::json!({"role": "user", "content": "hello"}));
        manager.save_record(session.clone()).await?;

        let legacy_dir = config
            .sandbox
            .sandboxes_root
            .join(user_id)
            .join("sessions")
            .join(&session.session_id);
        assert!(!legacy_dir.join("meta.json").exists());
        assert!(!legacy_dir.join("messages.jsonl").exists());

        let reloaded = manager
            .load(user_id, &session.session_id)
            .await?
            .expect("session should reload from SQLite");
        assert_eq!(reloaded.messages, session.messages);

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }

    #[tokio::test]
    async fn clear_pending_connector_auth_updates_matching_sessions() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("ripple-session-test-{}", Uuid::new_v4()));
        let config = test_config(&root);
        let manager = SessionManager::new(config.clone(), SandboxManager::new(config));
        let user_id = "alice";

        let mut resumable = manager
            .create_session(
                user_id,
                CreateSessionInput {
                    model: None,
                    max_turns: None,
                    system_prompt: None,
                    context_folder_path: None,
                },
            )
            .await?;
        resumable.status = "awaiting_user_input".to_string();
        resumable.pending_connector_auth = Some(serde_json::json!({
            "connector": "notion",
            "stage": "awaiting_user_auth",
            "resume_user_input": "continue"
        }));
        manager.save_record(resumable.clone()).await?;

        let mut clearable = manager
            .create_session(
                user_id,
                CreateSessionInput {
                    model: None,
                    max_turns: None,
                    system_prompt: None,
                    context_folder_path: None,
                },
            )
            .await?;
        clearable.status = "awaiting_user_input".to_string();
        clearable.pending_connector_auth = Some(serde_json::json!({
            "connector": "notion",
            "stage": "awaiting_user_auth"
        }));
        manager.save_record(clearable.clone()).await?;

        assert_eq!(
            manager
                .clear_pending_connector_auth(user_id, "notion")
                .await?,
            2
        );
        let resumable = manager
            .load(user_id, &resumable.session_id)
            .await?
            .expect("resumable");
        assert_eq!(resumable.status, "idle");
        assert_eq!(
            resumable
                .pending_connector_auth
                .as_ref()
                .and_then(|value| value.get("stage"))
                .and_then(Value::as_str),
            Some("authorized")
        );
        let clearable = manager
            .load(user_id, &clearable.session_id)
            .await?
            .expect("clearable");
        assert_eq!(clearable.status, "idle");
        assert!(clearable.pending_connector_auth.is_none());

        let _ = std::fs::remove_dir_all(root);
        Ok(())
    }
}
