use std::collections::{BTreeMap, HashMap};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::codex::app_server::{
    AgentRunnerRequest, AgentRunnerResult, AgentRunnerStatus, CodexAppServerProvider,
};
use crate::codex::events::extract_usage_event;
use crate::config::AppConfig;
use crate::redaction::redact_text;
use crate::storage::{Storage, TokenUsageEventRecord};

#[derive(Clone)]
pub struct JobManager {
    provider: Arc<CodexAppServerProvider>,
    storage: Storage,
    jobs: Arc<RwLock<HashMap<String, Arc<RwLock<ExternalAgentJob>>>>>,
    replays: Arc<RwLock<HashMap<String, StoredJobReplay>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct AgentRunCreateRequest {
    pub prompt: String,
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default)]
    pub base_instructions: Option<String>,
    #[serde(default)]
    pub turn_context: Option<String>,
    #[serde(default, skip)]
    #[schema(ignore)]
    pub client_context: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub input_items: Vec<Value>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default, alias = "think_level")]
    pub effort: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default, rename = "outputSchema")]
    pub output_schema: Option<Value>,
    #[serde(default = "default_max_runtime")]
    pub max_runtime_seconds: u64,
    #[serde(default)]
    pub task_trigger_id: Option<String>,
    #[serde(default)]
    pub task_trigger_title: Option<String>,
    #[serde(default)]
    pub task_trigger_reason: Option<String>,
    #[serde(default)]
    pub codex_thread_id: Option<String>,
    #[serde(default)]
    pub codex_persistent_thread: bool,
    #[serde(default)]
    pub client_request_id: Option<String>,
    #[serde(default, skip_deserializing)]
    pub chat_user_input: Option<String>,
    #[serde(default, skip_deserializing)]
    pub chat_user_content: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct AgentRunInfo {
    pub job_id: String,
    pub provider: String,
    pub status: String,
    pub output_file: Option<String>,
    pub events_file: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub exit_code: Option<i32>,
    pub prompt_preview: Option<String>,
    pub sandbox_cwd: Option<String>,
    pub stdout_tail: String,
    pub stderr_tail: String,
    pub error: Option<String>,
    #[serde(default)]
    pub req_id: Option<String>,
    #[serde(default)]
    pub client_req_id: Option<String>,
    #[serde(default)]
    pub pending_approval: Option<Value>,
    #[serde(default)]
    pub pending_user_input: Option<Value>,
    #[serde(default, skip_serializing)]
    pub metadata: Value,
}

#[derive(Debug)]
pub struct ExternalAgentJob {
    pub job_id: String,
    pub provider: String,
    pub prompt: String,
    pub cwd: PathBuf,
    pub user_id: Option<String>,
    pub session_id: Option<String>,
    pub metadata: Value,
    pub status: AgentRunnerStatus,
    pub created_at: String,
    pub updated_at: String,
    pub events_file: Option<PathBuf>,
    pub output_file: Option<PathBuf>,
    pub exit_code: Option<i32>,
    pub stdout_tail: String,
    pub stderr_tail: String,
    pub error: Option<String>,
}

impl JobManager {
    pub fn new(config: Arc<AppConfig>) -> Self {
        let storage = Storage::new(config.clone()).expect("failed to initialize Ripple storage");
        Self::new_with_storage(config, storage)
    }

    pub fn new_with_storage(config: Arc<AppConfig>, storage: Storage) -> Self {
        Self {
            provider: Arc::new(CodexAppServerProvider::new(config, storage.clone())),
            storage,
            jobs: Arc::new(RwLock::new(HashMap::new())),
            replays: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn codex_runtime_info(
        &self,
        user_id: String,
        workspace_root: PathBuf,
    ) -> anyhow::Result<Value> {
        self.provider.runtime_info(user_id, workspace_root).await
    }

    pub async fn start(
        &self,
        create: AgentRunCreateRequest,
        user_id: String,
        session_id: Option<String>,
        workspace_root: PathBuf,
        runtime_dir: PathBuf,
    ) -> anyhow::Result<AgentRunInfo> {
        self.start_with_additional_context(
            create,
            user_id,
            session_id,
            workspace_root,
            runtime_dir,
            BTreeMap::new(),
        )
        .await
    }

    pub(crate) async fn start_with_additional_context(
        &self,
        create: AgentRunCreateRequest,
        user_id: String,
        session_id: Option<String>,
        workspace_root: PathBuf,
        runtime_dir: PathBuf,
        additional_context: BTreeMap<String, String>,
    ) -> anyhow::Result<AgentRunInfo> {
        if create.provider != "codex" && create.provider != "auto" {
            anyhow::bail!("Only the codex provider is supported");
        }
        let prompt = create.prompt.trim().to_string();
        if prompt.is_empty() {
            anyhow::bail!("prompt is required");
        }
        let image_generation_enabled = user_requested_image_generation(
            create.chat_user_input.as_deref().unwrap_or(prompt.as_str()),
        );
        let cwd = resolve_workspace_cwd(create.cwd.as_deref(), &workspace_root)?;
        let job_id = format!("agent-{}", &Uuid::new_v4().simple().to_string()[..8]);
        let job_dir = runtime_dir.join("external-agents").join(&job_id);
        let events_file = job_dir.join("events.jsonl");
        let replay = StoredJobReplay::new(
            &create,
            workspace_root.clone(),
            runtime_dir.clone(),
        )?;
        let now = now_iso();
        let mut metadata = json!({
            "job_id": job_id,
            "route": "agent_runner",
            "signals": [],
            "sandbox_cwd": sandbox_cwd_for_host_path(&cwd, &workspace_root),
            "workspace_root": workspace_root,
            "permission_root": cwd,
            "image_generation_enabled": image_generation_enabled
        });
        if let Some(object) = metadata.as_object_mut() {
            if let Some(session_id) = &session_id {
                object.insert("session_id".to_string(), json!(session_id));
            }
            if let Some(task_trigger_id) = &create.task_trigger_id {
                object.insert("task_trigger_id".to_string(), json!(task_trigger_id));
            }
            if let Some(task_trigger_title) = &create.task_trigger_title {
                object.insert("task_trigger_title".to_string(), json!(task_trigger_title));
            }
            if let Some(task_trigger_reason) = &create.task_trigger_reason {
                object.insert(
                    "task_trigger_reason".to_string(),
                    json!(task_trigger_reason),
                );
            }
            if let Some(codex_thread_id) = &create.codex_thread_id {
                object.insert("codex_thread_id".to_string(), json!(codex_thread_id));
            }
            if create.codex_persistent_thread {
                object.insert("codex_persistent_thread".to_string(), json!(true));
            }
            if let Some(client_request_id) = &create.client_request_id {
                object.insert("req_id".to_string(), json!(client_request_id));
                object.insert("client_req_id".to_string(), json!(client_request_id));
            }
            if let Some(chat_user_input) = &create.chat_user_input {
                object.insert("chat_user_input".to_string(), json!(chat_user_input));
            }
            if let Some(chat_user_content) = &create.chat_user_content {
                object.insert("chat_user_content".to_string(), chat_user_content.clone());
            }
        }
        let job = Arc::new(RwLock::new(ExternalAgentJob {
            job_id: job_id.clone(),
            provider: "codex".to_string(),
            prompt: prompt.clone(),
            cwd: cwd.clone(),
            user_id: Some(user_id.clone()),
            session_id: session_id.clone(),
            metadata: metadata.clone(),
            status: AgentRunnerStatus::Queued,
            created_at: now.clone(),
            updated_at: now,
            events_file: Some(events_file.clone()),
            output_file: None,
            exit_code: None,
            stdout_tail: String::new(),
            stderr_tail: String::new(),
            error: None,
        }));
        self.jobs.write().await.insert(job_id.clone(), job.clone());
        self.replays
            .write()
            .await
            .insert(job_id.clone(), replay.clone());
        self.save_job_record(&*job.read().await).await?;

        let provider = self.provider.clone();
        let storage = self.storage.clone();
        let replays = self.replays.clone();
        let spawned_job_id = job_id.clone();
        let max_runtime_seconds = create.max_runtime_seconds.clamp(1, 86_400);
        let request = AgentRunnerRequest {
            provider: "codex".to_string(),
            prompt,
            base_instructions: create.base_instructions,
            turn_context: create.turn_context,
            client_context: create.client_context,
            additional_context,
            cwd,
            input_items: create.input_items,
            model: create.model,
            effort: create.effort,
            summary: create.summary,
            output_schema: create.output_schema,
            max_runtime_seconds,
            user_id: Some(user_id),
            session_id,
            metadata,
        };
        tokio::spawn(async move {
            let mut replay = replay;
            replay.attempt = replay.attempt.saturating_add(1);
            replays
                .write()
                .await
                .insert(spawned_job_id, replay.clone());
            {
                let mut job = job.write().await;
                if job.status == AgentRunnerStatus::Cancelled {
                    job.updated_at = now_iso();
                    let _ = save_job_record_to_storage(&storage, &job, Some(&replay)).await;
                    return;
                }
                job.status = AgentRunnerStatus::Running;
                job.updated_at = now_iso();
                let _ = save_job_record_to_storage(&storage, &job, Some(&replay)).await;
            }
            let result = provider.run(request, job_dir).await;
            let mut job = job.write().await;
            if job.status == AgentRunnerStatus::Cancelled {
                job.updated_at = now_iso();
                let _ = save_job_record_to_storage(&storage, &job, Some(&replay)).await;
                return;
            }
            match result {
                Ok(result) => {
                    job.status = result.status;
                    job.events_file = Some(result.events_file);
                    job.output_file = result.output_file;
                    job.exit_code = result.exit_code;
                    job.stdout_tail = result.stdout_tail;
                    job.stderr_tail = result.stderr_tail;
                    job.error = result.error;
                    job.metadata = merge_metadata(job.metadata.clone(), result.metadata);
                }
                Err(err) => {
                    job.status = AgentRunnerStatus::Failed;
                    job.error = Some(err.to_string());
                }
            }
            job.updated_at = now_iso();
            let usage_snapshot = JobTokenUsageSnapshot::from_job(&job);
            let _ = record_job_token_usage_events(&storage, usage_snapshot).await;
            let _ = save_job_record_to_storage(&storage, &job, Some(&replay)).await;
        });

        self.info(&job_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("job disappeared after start"))
    }

    pub async fn compact_thread(
        &self,
        user_id: String,
        workspace_root: PathBuf,
        cwd: PathBuf,
        thread_id: String,
        max_runtime_seconds: u64,
    ) -> anyhow::Result<()> {
        self.provider
            .compact_thread(user_id, workspace_root, cwd, thread_id, max_runtime_seconds)
            .await
    }

    pub(crate) async fn run_internal(
        &self,
        create: AgentRunCreateRequest,
        user_id: String,
        session_id: Option<String>,
        workspace_root: PathBuf,
        runtime_dir: PathBuf,
    ) -> anyhow::Result<AgentRunInfo> {
        if create.provider != "codex" && create.provider != "auto" {
            anyhow::bail!("Only the codex provider is supported");
        }
        let prompt = create.prompt.trim().to_string();
        if prompt.is_empty() {
            anyhow::bail!("prompt is required");
        }
        let image_generation_enabled = user_requested_image_generation(
            create.chat_user_input.as_deref().unwrap_or(prompt.as_str()),
        );
        let cwd = resolve_workspace_cwd(create.cwd.as_deref(), &workspace_root)?;
        let job_id = format!("internal-{}", &Uuid::new_v4().simple().to_string()[..8]);
        let job_dir = runtime_dir.join("internal-agents").join(&job_id);
        let mut metadata = json!({
            "job_id": job_id,
            "route": "internal_agent_runner",
            "internal": true,
            "signals": [],
            "sandbox_cwd": sandbox_cwd_for_host_path(&cwd, &workspace_root),
            "workspace_root": workspace_root,
            "permission_root": cwd,
            "image_generation_enabled": image_generation_enabled
        });
        if let Some(object) = metadata.as_object_mut() {
            if let Some(session_id) = &session_id {
                object.insert("session_id".to_string(), json!(session_id));
            }
            if let Some(client_request_id) = &create.client_request_id {
                object.insert("req_id".to_string(), json!(client_request_id));
                object.insert("client_req_id".to_string(), json!(client_request_id));
            }
        }
        let request = AgentRunnerRequest {
            provider: "codex".to_string(),
            prompt: prompt.clone(),
            base_instructions: create.base_instructions,
            turn_context: create.turn_context,
            client_context: create.client_context,
            additional_context: BTreeMap::new(),
            cwd: cwd.clone(),
            input_items: create.input_items,
            model: create.model,
            effort: create.effort,
            summary: create.summary,
            output_schema: create.output_schema,
            max_runtime_seconds: create.max_runtime_seconds.clamp(1, 86_400),
            user_id: Some(user_id.clone()),
            session_id: session_id.clone(),
            metadata: metadata.clone(),
        };
        let result = self.provider.run(request, job_dir).await?;
        let usage_snapshot = JobTokenUsageSnapshot {
            job_id: result.job_id.clone(),
            user_id: Some(user_id),
            session_id,
            task_trigger_id: metadata
                .get("task_trigger_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            events_file: Some(result.events_file.clone()),
            updated_at: now_iso(),
            metadata: metadata.clone(),
        };
        let _ = record_job_token_usage_events(&self.storage, usage_snapshot).await;
        Ok(info_from_internal_result(prompt, cwd, metadata, result))
    }

    pub async fn read_thread(
        &self,
        user_id: String,
        workspace_root: PathBuf,
        thread_id: String,
    ) -> anyhow::Result<Value> {
        self.provider
            .read_thread(user_id, workspace_root, thread_id)
            .await
    }

    pub async fn archive_codex_thread(
        &self,
        user_id: String,
        workspace_root: PathBuf,
        thread_id: String,
    ) -> anyhow::Result<Value> {
        self.provider
            .archive_thread(user_id, workspace_root, thread_id)
            .await
    }

    pub async fn list_user(&self, user_id: &str) -> anyhow::Result<Vec<AgentRunInfo>> {
        let mut merged = HashMap::<String, AgentRunInfo>::new();
        for record in self.storage.list_jobs_for_user(user_id).await? {
            if let Some(info) = info_from_record(&record) {
                merged.insert(info.job_id.clone(), info);
            }
        }
        let jobs = self.jobs.read().await;
        for job in jobs.values() {
            let job = job.read().await;
            if job.user_id.as_deref() == Some(user_id) {
                let info = info_from_job(
                    &job,
                    self.provider.pending_approval(&job.job_id).await,
                    self.provider.pending_user_input(&job.job_id).await,
                );
                merged.insert(info.job_id.clone(), info);
            }
        }
        let mut infos = merged.into_values().collect::<Vec<_>>();
        infos.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(infos)
    }

    pub async fn backfill_token_usage_for_user(&self, user_id: &str) -> anyhow::Result<()> {
        for record in self.storage.list_jobs_for_user(user_id).await? {
            let Some(info) = info_from_record(&record) else {
                continue;
            };
            if !is_terminal_run_status(&info.status) {
                continue;
            }
            if let Some(snapshot) = JobTokenUsageSnapshot::from_info(user_id, &info) {
                record_job_token_usage_events(&self.storage, snapshot).await?;
            }
        }

        let snapshots = {
            let jobs = self.jobs.read().await;
            let mut snapshots = Vec::new();
            for job in jobs.values() {
                let job = job.read().await;
                if job.user_id.as_deref() == Some(user_id)
                    && is_terminal_run_status(job.status.as_str())
                {
                    snapshots.push(JobTokenUsageSnapshot::from_job(&job));
                }
            }
            snapshots
        };
        for snapshot in snapshots {
            record_job_token_usage_events(&self.storage, snapshot).await?;
        }
        Ok(())
    }

    pub async fn recover_interrupted_stored_runs(&self) -> anyhow::Result<usize> {
        let mut recovered = 0;
        for mut record in self.storage.list_active_jobs().await? {
            StoredJobRecord::mark_interrupted(&mut record);
            self.storage.upsert_job(&record).await?;
            recovered += 1;
        }
        Ok(recovered)
    }

    pub async fn info(&self, job_id: &str) -> anyhow::Result<Option<AgentRunInfo>> {
        let jobs = self.jobs.read().await;
        let Some(job) = jobs.get(job_id) else {
            return Ok(None);
        };
        let job = job.read().await;
        Ok(Some(info_from_job(
            &job,
            self.provider.pending_approval(job_id).await,
            self.provider.pending_user_input(job_id).await,
        )))
    }

    pub async fn info_for_user(
        &self,
        job_id: &str,
        user_id: &str,
    ) -> anyhow::Result<Option<AgentRunInfo>> {
        let jobs = self.jobs.read().await;
        if let Some(job) = jobs.get(job_id) {
            let job = job.read().await;
            if job.user_id.as_deref() == Some(user_id) {
                return Ok(Some(info_from_job(
                    &job,
                    self.provider.pending_approval(job_id).await,
                    self.provider.pending_user_input(job_id).await,
                )));
            }
            return Ok(None);
        }
        Ok(self
            .storage
            .get_job_for_user(user_id, job_id)
            .await?
            .as_ref()
            .and_then(info_from_record))
    }

    pub async fn status_for_user(
        &self,
        job_id: &str,
        user_id: &str,
    ) -> anyhow::Result<Option<String>> {
        Ok(self
            .info_for_user(job_id, user_id)
            .await?
            .map(|info| info.status))
    }

    pub async fn has_active_session_run(&self, user_id: &str, session_id: &str) -> bool {
        let jobs = self.jobs.read().await;
        for job in jobs.values() {
            let job = job.read().await;
            if job.user_id.as_deref() == Some(user_id)
                && job.session_id.as_deref() == Some(session_id)
                && matches!(
                    job.status,
                    AgentRunnerStatus::Queued | AgentRunnerStatus::Running
                )
            {
                return true;
            }
        }
        false
    }

    pub async fn pending_user_input_for_session(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> anyhow::Result<Option<(String, Value)>> {
        let candidate_job_ids = {
            let jobs = self.jobs.read().await;
            let mut candidate_job_ids = Vec::new();
            for (job_id, job) in jobs.iter() {
                let job = job.read().await;
                if job.user_id.as_deref() == Some(user_id)
                    && job.session_id.as_deref() == Some(session_id)
                    && matches!(
                        job.status,
                        AgentRunnerStatus::Queued | AgentRunnerStatus::Running
                    )
                {
                    candidate_job_ids.push(job_id.clone());
                }
            }
            candidate_job_ids
        };
        for job_id in candidate_job_ids {
            if let Some(pending) = self.provider.pending_user_input(&job_id).await {
                return Ok(Some((job_id, pending)));
            }
        }
        Ok(None)
    }

    pub async fn has_active_task_trigger_run(&self, user_id: &str, task_trigger_id: &str) -> bool {
        let jobs = self.jobs.read().await;
        for job in jobs.values() {
            let job = job.read().await;
            if job.user_id.as_deref() == Some(user_id)
                && job.metadata.get("task_trigger_id").and_then(Value::as_str)
                    == Some(task_trigger_id)
                && matches!(
                    job.status,
                    AgentRunnerStatus::Queued | AgentRunnerStatus::Running
                )
            {
                return true;
            }
        }
        false
    }

    pub async fn recover_stale_stored_session_run(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> anyhow::Result<Option<AgentRunInfo>> {
        for mut record in self.storage.list_jobs_for_user(user_id).await? {
            if StoredJobRecord::session_id(&record) != Some(session_id) {
                continue;
            }
            let status = StoredJobRecord::status(&record);
            if status != "queued" && status != "running" {
                return Ok(info_from_record(&record));
            }
            StoredJobRecord::mark_interrupted(&mut record);
            self.storage.upsert_job(&record).await?;
            return Ok(info_from_record(&record));
        }
        Ok(None)
    }

    pub async fn events_file_for_user(
        &self,
        job_id: &str,
        user_id: &str,
    ) -> anyhow::Result<Option<PathBuf>> {
        if let Some(info) = self.info_for_user(job_id, user_id).await? {
            if let Some(events_file) = info.events_file {
                return Ok(Some(PathBuf::from(events_file)));
            }
        }
        Ok(None)
    }

    pub async fn is_live_for_user(&self, job_id: &str, user_id: &str) -> bool {
        let jobs = self.jobs.read().await;
        let Some(job) = jobs.get(job_id) else {
            return false;
        };
        let job = job.read().await;
        job.user_id.as_deref() == Some(user_id)
            && matches!(
                job.status,
                AgentRunnerStatus::Queued | AgentRunnerStatus::Running
            )
    }

    pub async fn steer(&self, job_id: &str, text: String) -> bool {
        self.provider.steer(job_id, text).await
    }

    pub async fn resolve_approval_for_user(
        &self,
        job_id: &str,
        user_id: &str,
        request_id: &Value,
        action: &str,
    ) -> anyhow::Result<bool> {
        if !matches!(action, "allow" | "always" | "deny") {
            anyhow::bail!("action must be one of: allow, always, deny");
        }
        {
            let jobs = self.jobs.read().await;
            let Some(job) = jobs.get(job_id) else {
                return Ok(false);
            };
            let job = job.read().await;
            if job.user_id.as_deref() != Some(user_id) {
                return Ok(false);
            }
        }
        Ok(self
            .provider
            .resolve_approval(job_id, request_id, action)
            .await)
    }

    pub async fn resolve_user_input_for_user(
        &self,
        job_id: &str,
        user_id: &str,
        request_id: &Value,
        answers: Value,
    ) -> anyhow::Result<bool> {
        {
            let jobs = self.jobs.read().await;
            let Some(job) = jobs.get(job_id) else {
                return Ok(false);
            };
            let job = job.read().await;
            if job.user_id.as_deref() != Some(user_id)
                || !matches!(
                    job.status,
                    AgentRunnerStatus::Queued | AgentRunnerStatus::Running
                )
            {
                return Ok(false);
            }
        }
        Ok(self
            .provider
            .resolve_user_input(job_id, request_id, answers)
            .await)
    }

    pub async fn cancel_for_user(
        &self,
        job_id: &str,
        user_id: &str,
    ) -> anyhow::Result<Option<AgentRunInfo>> {
        {
            let jobs = self.jobs.read().await;
            let Some(job) = jobs.get(job_id) else {
                return Ok(None);
            };
            let job = job.read().await;
            if job.user_id.as_deref() != Some(user_id) {
                return Ok(None);
            }
        }
        let _ = self.provider.cancel(job_id).await;
        let jobs = self.jobs.read().await;
        let Some(job) = jobs.get(job_id) else {
            return Ok(None);
        };
        let mut job = job.write().await;
        job.status = AgentRunnerStatus::Cancelled;
        job.updated_at = now_iso();
        self.save_job_record(&job).await?;
        Ok(Some(info_from_job(
            &job,
            self.provider.pending_approval(job_id).await,
            self.provider.pending_user_input(job_id).await,
        )))
    }

    pub async fn delete_for_user(
        &self,
        job_id: &str,
        user_id: &str,
    ) -> anyhow::Result<Option<AgentRunInfo>> {
        if self.is_live_for_user(job_id, user_id).await {
            anyhow::bail!("active agent runs must be cancelled before deletion");
        }
        let Some(info) = self.info_for_user(job_id, user_id).await? else {
            return Ok(None);
        };
        if !self.storage.delete_job_for_user(user_id, job_id).await? {
            return Ok(None);
        }
        self.jobs.write().await.remove(job_id);
        Ok(Some(info))
    }

    pub async fn cancel_session_run(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> anyhow::Result<Option<AgentRunInfo>> {
        let job_id = {
            let jobs = self.jobs.read().await;
            let mut found = None;
            for (job_id, job) in jobs.iter() {
                let job = job.read().await;
                if job.user_id.as_deref() == Some(user_id)
                    && job.session_id.as_deref() == Some(session_id)
                    && matches!(
                        job.status,
                        AgentRunnerStatus::Queued | AgentRunnerStatus::Running
                    )
                {
                    found = Some(job_id.clone());
                    break;
                }
            }
            found
        };
        let Some(job_id) = job_id else {
            return Ok(None);
        };
        self.cancel_for_user(&job_id, user_id).await
    }

    pub async fn cancel_user_runs(&self, user_id: &str) -> anyhow::Result<Vec<AgentRunInfo>> {
        let job_ids = {
            let jobs = self.jobs.read().await;
            let mut found = Vec::new();
            for (job_id, job) in jobs.iter() {
                let job = job.read().await;
                if job.user_id.as_deref() == Some(user_id)
                    && matches!(
                        job.status,
                        AgentRunnerStatus::Queued | AgentRunnerStatus::Running
                    )
                {
                    found.push(job_id.clone());
                }
            }
            found
        };
        let mut cancelled = Vec::new();
        for job_id in job_ids {
            if let Some(info) = self.cancel_for_user(&job_id, user_id).await? {
                cancelled.push(info);
            }
        }
        Ok(cancelled)
    }

    pub async fn stop_user(&self, user_id: &str) -> anyhow::Result<Vec<AgentRunInfo>> {
        let cancelled = self.cancel_user_runs(user_id).await?;
        let _ = self.provider.stop_user(user_id).await;
        Ok(cancelled)
    }

    pub async fn clear_user_cache(&self, user_id: &str) {
        let jobs = self.jobs.read().await;
        let mut remove_ids = Vec::new();
        for (job_id, job) in jobs.iter() {
            let job = job.read().await;
            if job.user_id.as_deref() == Some(user_id) {
                remove_ids.push(job_id.clone());
            }
        }
        drop(jobs);
        let mut jobs = self.jobs.write().await;
        for job_id in remove_ids {
            jobs.remove(&job_id);
        }
    }

    async fn save_job_record(&self, job: &ExternalAgentJob) -> anyhow::Result<()> {
        let replay = self.replays.read().await.get(&job.job_id).cloned();
        save_job_record_to_storage(&self.storage, job, replay.as_ref()).await
    }
}

fn info_from_job(
    job: &ExternalAgentJob,
    pending_approval: Option<Value>,
    pending_user_input: Option<Value>,
) -> AgentRunInfo {
    AgentRunInfo {
        job_id: job.job_id.clone(),
        provider: job.provider.clone(),
        status: job.status.as_str().to_string(),
        output_file: job
            .output_file
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        events_file: job
            .events_file
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        created_at: job.created_at.clone(),
        updated_at: job.updated_at.clone(),
        exit_code: job.exit_code,
        prompt_preview: Some(job.prompt.chars().take(240).collect()),
        sandbox_cwd: job
            .metadata
            .get("sandbox_cwd")
            .and_then(Value::as_str)
            .map(str::to_string),
        stdout_tail: redact_text(&job.stdout_tail),
        stderr_tail: redact_text(&job.stderr_tail),
        error: job.error.as_deref().map(redact_text),
        req_id: metadata_string(&job.metadata, "req_id"),
        client_req_id: metadata_string(&job.metadata, "client_req_id"),
        pending_approval,
        pending_user_input,
        metadata: job.metadata.clone(),
    }
}

fn info_from_internal_result(
    prompt: String,
    cwd: PathBuf,
    metadata: Value,
    result: AgentRunnerResult,
) -> AgentRunInfo {
    let metadata = merge_metadata(metadata, result.metadata);
    AgentRunInfo {
        job_id: result.job_id,
        provider: result.provider,
        status: result.status.as_str().to_string(),
        output_file: result
            .output_file
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        events_file: Some(result.events_file.to_string_lossy().to_string()),
        created_at: now_iso(),
        updated_at: now_iso(),
        exit_code: result.exit_code,
        prompt_preview: Some(prompt.chars().take(240).collect()),
        sandbox_cwd: metadata
            .get("sandbox_cwd")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| Some(cwd.to_string_lossy().to_string())),
        stdout_tail: redact_text(&result.stdout_tail),
        stderr_tail: redact_text(&result.stderr_tail),
        error: result.error.as_deref().map(redact_text),
        req_id: metadata_string(&metadata, "req_id"),
        client_req_id: metadata_string(&metadata, "client_req_id"),
        pending_approval: None,
        pending_user_input: None,
        metadata,
    }
}

fn merge_metadata(left: Value, right: Value) -> Value {
    let mut base = left.as_object().cloned().unwrap_or_default();
    if let Some(extra) = right.as_object() {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }
    Value::Object(base)
}

fn metadata_string(metadata: &Value, key: &str) -> Option<String> {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
}

#[derive(Clone)]
struct JobTokenUsageSnapshot {
    job_id: String,
    user_id: Option<String>,
    session_id: Option<String>,
    task_trigger_id: Option<String>,
    events_file: Option<PathBuf>,
    updated_at: String,
    metadata: Value,
}

impl JobTokenUsageSnapshot {
    fn from_job(job: &ExternalAgentJob) -> Self {
        Self {
            job_id: job.job_id.clone(),
            user_id: job.user_id.clone(),
            session_id: job.session_id.clone(),
            task_trigger_id: job
                .metadata
                .get("task_trigger_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            events_file: job.events_file.clone(),
            updated_at: job.updated_at.clone(),
            metadata: job.metadata.clone(),
        }
    }

    fn from_info(user_id: &str, info: &AgentRunInfo) -> Option<Self> {
        Some(Self {
            job_id: info.job_id.clone(),
            user_id: Some(user_id.to_string()),
            session_id: info
                .metadata
                .get("session_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            task_trigger_id: info
                .metadata
                .get("task_trigger_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            events_file: info.events_file.as_deref().map(PathBuf::from),
            updated_at: info.updated_at.clone(),
            metadata: info.metadata.clone(),
        })
    }
}

struct JobUsageUpdate {
    key: String,
    turn_id: Option<String>,
    occurred_at: String,
    usage: Value,
    event: Value,
}

async fn record_job_token_usage_events(
    storage: &Storage,
    snapshot: JobTokenUsageSnapshot,
) -> anyhow::Result<()> {
    let Some(user_id) = snapshot.user_id.clone() else {
        return Ok(());
    };
    let Some(events_file) = snapshot.events_file.as_deref() else {
        return Ok(());
    };
    let updates = latest_usage_updates(events_file).await?;
    for update in updates {
        let input_tokens = usage_u64(&update.usage, "prompt_tokens");
        let output_tokens = usage_u64(&update.usage, "completion_tokens");
        let total_tokens = usage_u64(&update.usage, "total_tokens")
            .max(input_tokens.saturating_add(output_tokens));
        if total_tokens == 0 {
            continue;
        }
        storage
            .upsert_token_usage_event(&TokenUsageEventRecord {
                event_id: format!("codex-job:{}:{}", snapshot.job_id, update.key),
                user_id: user_id.clone(),
                session_id: snapshot.session_id.clone(),
                job_id: Some(snapshot.job_id.clone()),
                task_trigger_id: snapshot.task_trigger_id.clone(),
                turn_id: update.turn_id.clone(),
                source: "codex_job".to_string(),
                input_tokens,
                output_tokens,
                total_tokens,
                cached_input_tokens: usage_u64(&update.usage, "cached_input_tokens"),
                reasoning_output_tokens: usage_u64(&update.usage, "reasoning_output_tokens"),
                model_context_window: update
                    .usage
                    .get("model_context_window")
                    .and_then(Value::as_u64),
                occurred_at: update.occurred_at,
                record_json: json!({
                    "usage": update.usage,
                    "event": update.event,
                    "job": {
                        "job_id": snapshot.job_id.clone(),
                        "session_id": snapshot.session_id.clone(),
                        "task_trigger_id": snapshot.task_trigger_id.clone(),
                        "updated_at": snapshot.updated_at.clone(),
                        "metadata": snapshot.metadata.clone()
                    }
                }),
            })
            .await?;
    }
    Ok(())
}

async fn latest_usage_updates(events_file: &Path) -> anyhow::Result<Vec<JobUsageUpdate>> {
    let contents = match tokio::fs::read_to_string(events_file).await {
        Ok(contents) => contents,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err.into()),
    };
    let mut latest = BTreeMap::<String, JobUsageUpdate>::new();
    for line in contents
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(update) = usage_update_from_event(event) else {
            continue;
        };
        latest.insert(update.key.clone(), update);
    }
    Ok(latest.into_values().collect())
}

fn usage_update_from_event(event: Value) -> Option<JobUsageUpdate> {
    let usage = extract_usage_event(&event)?;
    let message = event.pointer("/data/message")?;
    let turn_id = message
        .pointer("/params/turnId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let sequence = event
        .get("sequence")
        .and_then(Value::as_u64)
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let key = turn_id
        .as_deref()
        .map(|turn_id| format!("turn:{turn_id}"))
        .unwrap_or_else(|| format!("event:{sequence}"));
    let occurred_at = event
        .get("created_at")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(now_iso);
    Some(JobUsageUpdate {
        key,
        turn_id,
        occurred_at,
        usage,
        event,
    })
}

fn usage_u64(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn is_terminal_run_status(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled")
}

async fn save_job_record_to_storage(
    storage: &Storage,
    job: &ExternalAgentJob,
    replay: Option<&StoredJobReplay>,
) -> anyhow::Result<()> {
    storage
        .upsert_job(&StoredJobRecord::from_job_with_replay(job, replay))
        .await
}

fn info_from_record(record: &Value) -> Option<AgentRunInfo> {
    StoredJobRecord::to_info(record)
}

#[derive(Debug, Clone)]
struct StoredJobReplay {
    request_json: Value,
    workspace_root: PathBuf,
    runtime_dir: PathBuf,
    attempt: u64,
    max_attempts: u64,
}

impl StoredJobReplay {
    fn new(
        request: &AgentRunCreateRequest,
        workspace_root: PathBuf,
        runtime_dir: PathBuf,
    ) -> anyhow::Result<Self> {
        let mut request_json = serde_json::to_value(request)?;
        if let Some(client_context) = &request.client_context {
            if let Some(object) = request_json.as_object_mut() {
                object.insert("client_context".to_string(), json!(client_context));
            }
        }
        Ok(Self {
            request_json,
            workspace_root,
            runtime_dir,
            attempt: 0,
            max_attempts: 2,
        })
    }

    fn request(&self) -> anyhow::Result<AgentRunCreateRequest> {
        let client_context = self
            .request_json
            .get("client_context")
            .and_then(Value::as_str)
            .map(str::to_string);
        let mut request = serde_json::from_value::<AgentRunCreateRequest>(
            self.request_json.clone(),
        )?;
        request.client_context = client_context;
        Ok(request)
    }

    fn record_fields(&self) -> Value {
        json!({
            "request": self.request_json,
            "workspace_root": self.workspace_root,
            "runtime_dir": self.runtime_dir,
            "attempt": self.attempt,
            "max_attempts": self.max_attempts,
        })
    }

    fn from_record(record: &Value) -> anyhow::Result<Self> {
        let request_json = record
            .get("request")
            .filter(|value| value.is_object())
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("stored job missing replay request"))?;
        let workspace_root = record
            .get("workspace_root")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .ok_or_else(|| anyhow::anyhow!("stored job missing workspace_root"))?;
        let runtime_dir = record
            .get("runtime_dir")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .ok_or_else(|| anyhow::anyhow!("stored job missing runtime_dir"))?;
        Ok(Self {
            request_json,
            workspace_root,
            runtime_dir,
            attempt: record.get("attempt").and_then(Value::as_u64).unwrap_or(0),
            max_attempts: record
                .get("max_attempts")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .max(1),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReplayDecision {
    Queued,
    Failed,
}

struct StoredJobRecord;

impl StoredJobRecord {
    fn from_job(job: &ExternalAgentJob) -> Value {
        let mut record = json!({
            "version": 1,
            "job_id": job.job_id,
            "provider": job.provider,
            "user_id": job.user_id,
            "session_id": job.session_id,
            "prompt_preview": job.prompt.chars().take(240).collect::<String>(),
            "cwd": job.cwd,
            "sandbox_cwd": job.metadata.get("sandbox_cwd").cloned().unwrap_or(Value::Null),
            "status": job.status.as_str(),
            "created_at": job.created_at,
            "updated_at": job.updated_at,
            "events_file": job.events_file,
            "output_file": job.output_file,
            "exit_code": job.exit_code,
            "stdout_tail": redact_text(&job.stdout_tail),
            "stderr_tail": redact_text(&job.stderr_tail),
            "error": job.error.as_deref().map(redact_text),
        });
        if let Some(object) = record.as_object_mut() {
            for key in [
                "task_trigger_id",
                "task_trigger_title",
                "task_trigger_reason",
                "req_id",
                "client_req_id",
            ] {
                if let Some(value) = job.metadata.get(key).and_then(Value::as_str) {
                    object.insert(key.to_string(), json!(value));
                }
            }
            if let Some(value) = job.metadata.get("codex_thread_id").and_then(Value::as_str) {
                object.insert("codex_thread_id".to_string(), json!(value));
            }
            if job
                .metadata
                .get("codex_persistent_thread")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                object.insert("codex_persistent_thread".to_string(), json!(true));
            }
            if let Some(value) = job.metadata.get("chat_user_input").and_then(Value::as_str) {
                object.insert("chat_user_input".to_string(), json!(value));
            }
            if let Some(value) = job.metadata.get("chat_user_content") {
                object.insert("chat_user_content".to_string(), value.clone());
            }
        }
        record
    }

    fn from_job_with_replay(job: &ExternalAgentJob, replay: Option<&StoredJobReplay>) -> Value {
        let mut record = Self::from_job(job);
        let Some(replay) = replay else {
            return record;
        };
        if let (Some(record_object), Some(replay_object)) =
            (record.as_object_mut(), replay.record_fields().as_object())
        {
            record_object.insert("version".to_string(), json!(2));
            for (key, value) in replay_object {
                record_object.insert(key.clone(), value.clone());
            }
        }
        record
    }

    fn to_info(record: &Value) -> Option<AgentRunInfo> {
        let job_id = record.get("job_id")?.as_str()?.to_string();
        Some(AgentRunInfo {
            job_id,
            provider: Self::str(record, "provider"),
            status: Self::str(record, "status"),
            output_file: Self::opt_str(record, "output_file"),
            events_file: Self::opt_str(record, "events_file"),
            created_at: Self::str(record, "created_at"),
            updated_at: Self::str(record, "updated_at"),
            exit_code: record
                .get("exit_code")
                .and_then(Value::as_i64)
                .and_then(|value| i32::try_from(value).ok()),
            prompt_preview: Self::opt_str(record, "prompt_preview"),
            sandbox_cwd: Self::opt_str(record, "sandbox_cwd"),
            stdout_tail: redact_text(&Self::str(record, "stdout_tail")),
            stderr_tail: redact_text(&Self::str(record, "stderr_tail")),
            error: record.get("error").and_then(Value::as_str).map(redact_text),
            req_id: Self::opt_str(record, "req_id"),
            client_req_id: Self::opt_str(record, "client_req_id"),
            pending_approval: None,
            pending_user_input: None,
            metadata: record.clone(),
        })
    }

    fn session_id(record: &Value) -> Option<&str> {
        record.get("session_id").and_then(Value::as_str)
    }

    fn status(record: &Value) -> String {
        Self::str(record, "status")
    }

    fn mark_interrupted(record: &mut Value) {
        if let Some(object) = record.as_object_mut() {
            object.insert("status".to_string(), json!("failed"));
            object.insert("updated_at".to_string(), json!(now_iso()));
            object.insert(
                "error".to_string(),
                json!("interrupted_by_restart: server restarted before run completed"),
            );
            object.insert(
                "failure_reason".to_string(),
                json!("interrupted_by_restart"),
            );
        }
    }

    fn requeue_after_restart(record: &mut Value) -> ReplayDecision {
        let replayable = record.get("request").is_some_and(Value::is_object)
            && record.get("workspace_root").and_then(Value::as_str).is_some()
            && record.get("runtime_dir").and_then(Value::as_str).is_some();
        if !replayable {
            Self::mark_interrupted(record);
            return ReplayDecision::Failed;
        }

        let attempt = record.get("attempt").and_then(Value::as_u64).unwrap_or(0);
        let max_attempts = record
            .get("max_attempts")
            .and_then(Value::as_u64)
            .unwrap_or(1)
            .max(1);
        if attempt >= max_attempts {
            if let Some(object) = record.as_object_mut() {
                object.insert("status".to_string(), json!("failed"));
                object.insert("updated_at".to_string(), json!(now_iso()));
                object.insert(
                    "error".to_string(),
                    json!("retry_limit_exhausted: automatic restart retry limit reached"),
                );
                object.insert(
                    "failure_reason".to_string(),
                    json!("retry_limit_exhausted"),
                );
            }
            return ReplayDecision::Failed;
        }

        if let Some(object) = record.as_object_mut() {
            object.insert("status".to_string(), json!("queued"));
            object.insert("updated_at".to_string(), json!(now_iso()));
            object.insert(
                "recovery_reason".to_string(),
                json!("interrupted_by_restart"),
            );
            object.remove("error");
            object.remove("failure_reason");
        }
        ReplayDecision::Queued
    }

    fn str(record: &Value, key: &str) -> String {
        record
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    }

    fn opt_str(record: &Value, key: &str) -> Option<String> {
        record.get(key).and_then(Value::as_str).map(str::to_string)
    }
}

pub(crate) fn resolve_workspace_cwd(
    raw_cwd: Option<&str>,
    workspace_root: &Path,
) -> anyhow::Result<PathBuf> {
    let root = workspace_root.canonicalize()?;
    let candidate = match raw_cwd.filter(|value| !value.trim().is_empty()) {
        Some(raw) if raw.starts_with("/workspace") => {
            root.join(raw.trim_start_matches("/workspace").trim_start_matches('/'))
        }
        Some(raw) => {
            let path = PathBuf::from(raw);
            if path.is_absolute() {
                path
            } else {
                root.join(path)
            }
        }
        None => root.clone(),
    };
    let resolved = if candidate.exists() {
        candidate.canonicalize()?
    } else {
        normalize_path(&candidate)
    };
    if !resolved.starts_with(&root) {
        anyhow::bail!("cwd must stay inside the user workspace");
    }
    Ok(resolved)
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn sandbox_cwd_for_host_path(cwd: &Path, workspace_root: &Path) -> String {
    let relative = cwd.strip_prefix(workspace_root).unwrap_or(Path::new(""));
    if relative.as_os_str().is_empty() {
        "/workspace".to_string()
    } else {
        format!(
            "/workspace/{}",
            relative.to_string_lossy().replace('\\', "/")
        )
    }
}

fn user_requested_image_generation(text: &str) -> bool {
    let normalized = text.to_ascii_lowercase();
    if [
        "image generation",
        "text-to-image",
        "generate image",
        "generate an image",
        "generate a picture",
        "generate a photo",
        "create an image",
        "create a picture",
        "create a photo",
        "draw an image",
        "draw a picture",
        "render an image",
        "paint an image",
        "make an image",
        "make a picture",
        "design a poster",
        "generate a poster",
        "create a poster",
        "generate a logo",
        "create a logo",
    ]
    .into_iter()
    .any(|marker| normalized.contains(marker))
    {
        return true;
    }
    let chinese_verbs = ["生成", "创建", "画", "绘制", "出图", "设计"];
    let chinese_nouns = ["图片", "图像", "一张图", "海报", "头像", "图标"];
    if chinese_verbs.into_iter().any(|verb| text.contains(verb))
        && chinese_nouns.into_iter().any(|noun| text.contains(noun))
    {
        return true;
    }
    [
        "生成图片",
        "生成一张图",
        "生成一张图片",
        "创建图片",
        "画一张",
        "画个",
        "画图",
        "出图",
        "做张图",
        "做一张图",
        "设计海报",
        "生成海报",
    ]
    .into_iter()
    .any(|marker| text.contains(marker))
}

fn default_provider() -> String {
    "codex".to_string()
}

fn default_max_runtime() -> u64 {
    1800
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::codex::app_server::AgentRunnerStatus;

    use super::{
        resolve_workspace_cwd, user_requested_image_generation, AgentRunCreateRequest,
        ExternalAgentJob, ReplayDecision, StoredJobRecord, StoredJobReplay,
    };

    #[test]
    fn image_generation_intent_requires_explicit_creation_request() {
        assert!(!user_requested_image_generation(
            "/workspace/动效plan.pdf\n\n这个讲了什么内容"
        ));
        assert!(!user_requested_image_generation(
            "read this image and tell me what it says"
        ));
        assert!(user_requested_image_generation("帮我生成一张猫的图片"));
        assert!(user_requested_image_generation(
            "create an image of a neon robot"
        ));
    }

    #[test]
    fn resolve_workspace_cwd_rejects_nonexistent_parent_traversal() {
        let root = std::env::temp_dir().join(format!("ripple-cwd-test-{}", uuid::Uuid::new_v4()));
        let workspace = root.join("workspace");
        std::fs::create_dir_all(&workspace).expect("create workspace");

        assert!(resolve_workspace_cwd(Some("/workspace/../outside"), &workspace).is_err());
        assert!(resolve_workspace_cwd(Some("nested/../../outside"), &workspace).is_err());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn resolve_workspace_cwd_allows_nonexistent_workspace_child() {
        let root = std::env::temp_dir().join(format!("ripple-cwd-test-{}", uuid::Uuid::new_v4()));
        let workspace = root.join("workspace");
        std::fs::create_dir_all(&workspace).expect("create workspace");

        let resolved =
            resolve_workspace_cwd(Some("/workspace/new-dir"), &workspace).expect("resolve cwd");
        assert_eq!(resolved, workspace.canonicalize().unwrap().join("new-dir"));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stored_job_record_preserves_client_req_id() {
        let workspace = std::path::PathBuf::from("/tmp/ripple-workspace");
        let job = ExternalAgentJob {
            job_id: "agent-test".to_string(),
            provider: "codex".to_string(),
            prompt: "test prompt".to_string(),
            cwd: workspace.clone(),
            user_id: Some("user-1".to_string()),
            session_id: Some("session-1".to_string()),
            metadata: json!({
                "sandbox_cwd": "/workspace",
                "req_id": "6a4b7ac03606b62950699ae6",
                "client_req_id": "6a4b7ac03606b62950699ae6"
            }),
            status: AgentRunnerStatus::Completed,
            created_at: "2026-07-06T09:52:03Z".to_string(),
            updated_at: "2026-07-06T09:52:45Z".to_string(),
            events_file: Some(workspace.join("events.jsonl")),
            output_file: None,
            exit_code: None,
            stdout_tail: String::new(),
            stderr_tail: String::new(),
            error: None,
        };

        let record = StoredJobRecord::from_job(&job);

        assert_eq!(
            record.get("req_id").and_then(serde_json::Value::as_str),
            Some("6a4b7ac03606b62950699ae6")
        );
        assert_eq!(
            record
                .get("client_req_id")
                .and_then(serde_json::Value::as_str),
            Some("6a4b7ac03606b62950699ae6")
        );
    }

    fn replayable_record(status: &str, attempt: u64, max_attempts: u64) -> serde_json::Value {
        json!({
            "version": 2,
            "job_id": "agent-replay",
            "provider": "codex",
            "user_id": "user-1",
            "session_id": "session-1",
            "status": status,
            "created_at": "2026-07-16T00:00:00Z",
            "updated_at": "2026-07-16T00:00:01Z",
            "attempt": attempt,
            "max_attempts": max_attempts,
            "request": {
                "prompt": "resume this task",
                "provider": "codex"
            },
            "workspace_root": "/tmp/ripple-workspace",
            "runtime_dir": "/tmp/ripple-runtime"
        })
    }

    #[test]
    fn restart_requeues_replayable_running_job() {
        let mut record = replayable_record("running", 1, 2);

        assert_eq!(
            StoredJobRecord::requeue_after_restart(&mut record),
            ReplayDecision::Queued
        );
        assert_eq!(record.get("status").and_then(serde_json::Value::as_str), Some("queued"));
        assert_eq!(record.get("attempt").and_then(serde_json::Value::as_u64), Some(1));
        assert_eq!(
            record
                .get("recovery_reason")
                .and_then(serde_json::Value::as_str),
            Some("interrupted_by_restart")
        );
    }

    #[test]
    fn restart_rejects_legacy_job_without_replay_request() {
        let mut record = replayable_record("running", 1, 2);
        record.as_object_mut().unwrap().remove("request");

        assert_eq!(
            StoredJobRecord::requeue_after_restart(&mut record),
            ReplayDecision::Failed
        );
        assert_eq!(record.get("status").and_then(serde_json::Value::as_str), Some("failed"));
        assert_eq!(
            record.get("failure_reason").and_then(serde_json::Value::as_str),
            Some("interrupted_by_restart")
        );
    }

    #[test]
    fn restart_rejects_job_after_retry_limit() {
        let mut record = replayable_record("running", 2, 2);

        assert_eq!(
            StoredJobRecord::requeue_after_restart(&mut record),
            ReplayDecision::Failed
        );
        assert_eq!(record.get("status").and_then(serde_json::Value::as_str), Some("failed"));
        assert_eq!(
            record.get("failure_reason").and_then(serde_json::Value::as_str),
            Some("retry_limit_exhausted")
        );
    }

    #[test]
    fn stored_job_replay_round_trips_internal_client_context() {
        let request = AgentRunCreateRequest {
            prompt: "resume this task".to_string(),
            provider: "codex".to_string(),
            base_instructions: Some("base".to_string()),
            turn_context: Some("turn".to_string()),
            client_context: Some("screen context".to_string()),
            input_items: Vec::new(),
            cwd: Some("/workspace".to_string()),
            model: None,
            effort: None,
            summary: None,
            output_schema: None,
            max_runtime_seconds: 30,
            task_trigger_id: None,
            task_trigger_title: None,
            task_trigger_reason: None,
            codex_thread_id: None,
            codex_persistent_thread: false,
            client_request_id: Some("request-1".to_string()),
            chat_user_input: None,
            chat_user_content: None,
        };
        let replay = StoredJobReplay::new(
            &request,
            "/tmp/ripple-workspace".into(),
            "/tmp/ripple-runtime".into(),
        )
        .expect("serialize replay");
        let record = replay.record_fields();
        let restored = StoredJobReplay::from_record(&record).expect("restore replay");
        let restored_request = restored.request().expect("restore request");

        assert_eq!(restored_request.prompt, "resume this task");
        assert_eq!(
            restored_request.client_context.as_deref(),
            Some("screen context")
        );
        assert_eq!(restored.attempt, 0);
        assert_eq!(restored.max_attempts, 2);
    }

    #[test]
    fn stored_job_record_includes_replay_fields() {
        let workspace = std::path::PathBuf::from("/tmp/ripple-workspace");
        let request = AgentRunCreateRequest {
            prompt: "persist me".to_string(),
            provider: "codex".to_string(),
            base_instructions: None,
            turn_context: None,
            client_context: None,
            input_items: Vec::new(),
            cwd: Some("/workspace".to_string()),
            model: None,
            effort: None,
            summary: None,
            output_schema: None,
            max_runtime_seconds: 30,
            task_trigger_id: None,
            task_trigger_title: None,
            task_trigger_reason: None,
            codex_thread_id: None,
            codex_persistent_thread: false,
            client_request_id: None,
            chat_user_input: None,
            chat_user_content: None,
        };
        let replay = StoredJobReplay::new(
            &request,
            workspace.clone(),
            "/tmp/ripple-runtime".into(),
        )
        .expect("serialize replay");
        let job = ExternalAgentJob {
            job_id: "agent-replay".to_string(),
            provider: "codex".to_string(),
            prompt: request.prompt.clone(),
            cwd: workspace.clone(),
            user_id: Some("user-1".to_string()),
            session_id: Some("session-1".to_string()),
            metadata: json!({"sandbox_cwd": "/workspace"}),
            status: AgentRunnerStatus::Queued,
            created_at: "2026-07-16T00:00:00Z".to_string(),
            updated_at: "2026-07-16T00:00:01Z".to_string(),
            events_file: Some(workspace.join("events.jsonl")),
            output_file: None,
            exit_code: None,
            stdout_tail: String::new(),
            stderr_tail: String::new(),
            error: None,
        };

        let record = StoredJobRecord::from_job_with_replay(&job, Some(&replay));

        assert_eq!(record.pointer("/request/prompt").and_then(serde_json::Value::as_str), Some("persist me"));
        assert_eq!(record.get("attempt").and_then(serde_json::Value::as_u64), Some(0));
        assert_eq!(record.get("max_attempts").and_then(serde_json::Value::as_u64), Some(2));
    }
}
