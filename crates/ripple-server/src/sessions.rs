use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::sync::RwLock;
use tokio::time::{interval, sleep, Duration};
use uuid::Uuid;

use crate::config::AppConfig;
use crate::sandbox::SandboxManager;
use crate::storage::Storage;

#[derive(Clone)]
pub struct SessionManager {
    config: Arc<AppConfig>,
    sandboxes: SandboxManager,
    storage: Storage,
    active: Arc<RwLock<HashMap<(String, String), SessionRecord>>>,
    deleted: Arc<RwLock<HashSet<(String, String)>>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionRecord {
    pub session_id: String,
    pub user_id: String,
    pub title: String,
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
        }
    }

    pub async fn create_session(
        &self,
        user_id: &str,
        input: CreateSessionInput,
    ) -> anyhow::Result<SessionRecord> {
        self.sandboxes.ensure_sandbox(user_id)?;
        let session_id = format!("srv-{}", &Uuid::new_v4().simple().to_string()[..12]);
        self.deleted
            .write()
            .await
            .remove(&(user_id.to_string(), session_id.clone()));
        let now = now_iso();
        let session = SessionRecord {
            session_id: session_id.clone(),
            user_id: user_id.to_string(),
            title: String::new(),
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
            pending_schedule_request: None,
            codex_thread_id: None,
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

    pub async fn list_sessions(&self, user_id: &str) -> anyhow::Result<Vec<SessionInfo>> {
        let mut records = self
            .storage
            .list_sessions(user_id)
            .await?
            .into_iter()
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
    }

    pub async fn save_record_if_exists(&self, record: SessionRecord) -> anyhow::Result<bool> {
        self.save_record_inner(record, true).await
    }

    pub async fn save_record(&self, record: SessionRecord) -> anyhow::Result<()> {
        self.save_record_inner(record, false).await?;
        Ok(())
    }

    async fn save_record_inner(
        &self,
        mut record: SessionRecord,
        require_existing: bool,
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

        if require_existing
            && !self
                .storage
                .session_exists(&record.user_id, &record.session_id)
                .await?
        {
            drop(deleted);
            self.active.write().await.remove(&key);
            return Ok(false);
        }

        record.message_count = record.messages.len();
        record.last_active = now_iso();
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
        if record.status == "suspended" {
            return Ok(None);
        }
        record.status = "suspended".to_string();
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
        if record.status == "suspended" {
            record.status = "idle".to_string();
        }
        self.save_record(record.clone()).await?;
        Ok(Some(record))
    }

    pub async fn list_suspended_sessions(&self, user_id: &str) -> anyhow::Result<Vec<Value>> {
        let mut records = Vec::new();
        for record in self.storage.list_sessions(user_id).await? {
            if record.status != "suspended" {
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
            if matches!(
                record.status.as_str(),
                "awaiting_user_input" | "waiting_for_user"
            ) {
                record.status = "idle".to_string();
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
                record.status = "suspended".to_string();
                record.last_active = now_iso();
                self.persist(record).await?;
                suspended += 1;
            }
        }
        active.retain(|_, record| record.status != "suspended");
        drop(active);

        if retention_seconds > 0 {
            for user_id in self.sandboxes.list_user_sandboxes()? {
                for record in self.storage.list_sessions(&user_id).await? {
                    if record.status != "suspended" {
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
        record.status = "idle".to_string();
        record.total_input_tokens = 0;
        record.total_output_tokens = 0;
        record.last_input_tokens = 0;
        record.pending_question = None;
        record.pending_options = None;
        record.pending_permission_request = None;
        record.pending_connector_auth = None;
        record.pending_schedule_request = None;
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
    if matches!(
        record.status.as_str(),
        "queued" | "running" | "awaiting_permission" | "waiting_for_approval"
    ) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    use crate::config::{
        AppConfig, CodexConfig, FeishuConfig, GogcliOAuthConfig, SandboxConfig, SkillsConfig,
    };
    use time::Duration as TimeDuration;

    fn test_config(root: &Path) -> Arc<AppConfig> {
        Arc::new(AppConfig {
            repo_root: root.to_path_buf(),
            host: "127.0.0.1".to_string(),
            port: 0,
            api_keys: Vec::new(),
            default_model: "codex-test".to_string(),
            model_presets: Default::default(),
            sandbox: SandboxConfig {
                sandboxes_root: root.join("sandboxes"),
                caches_root: root.join("cache"),
                idle_suspend_seconds: 1,
                retention_seconds: 1,
                max_workspace_mb: 2048,
                tmpfs_size_mb: 64,
                nsjail_path: "nsjail".to_string(),
                uv_bin_dir: None,
                node_dir: None,
                lark_cli_install_root: None,
                notion_cli_install_root: None,
                gogcli_cli_install_root: None,
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
                max_runtime_seconds: 3600,
            },
            schedule_extraction_max_runtime_seconds: 120,
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
        session.pending_schedule_request = Some(serde_json::json!({"title": "schedule"}));
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
        assert!(cleared.pending_schedule_request.is_none());
        assert!(cleared.codex_thread_id.is_none());
        assert!(cleared.plan_steps.is_empty());
        assert!(cleared.plan_progress.is_none());

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
