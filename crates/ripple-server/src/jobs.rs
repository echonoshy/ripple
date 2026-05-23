use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::codex::app_server::{AgentRunnerRequest, AgentRunnerStatus, CodexAppServerProvider};
use crate::config::AppConfig;
use crate::storage::Storage;

#[derive(Clone)]
pub struct JobManager {
    provider: Arc<CodexAppServerProvider>,
    storage: Storage,
    jobs: Arc<RwLock<HashMap<String, Arc<RwLock<ExternalAgentJob>>>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRunCreateRequest {
    pub prompt: String,
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub input_items: Vec<Value>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default, rename = "outputSchema")]
    pub output_schema: Option<Value>,
    #[serde(default = "default_max_runtime")]
    pub max_runtime_seconds: u64,
    #[serde(default)]
    pub schedule_id: Option<String>,
    #[serde(default)]
    pub schedule_title: Option<String>,
    #[serde(default)]
    pub schedule_trigger: Option<String>,
    #[serde(default)]
    pub codex_thread_id: Option<String>,
    #[serde(default)]
    pub codex_persistent_thread: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub pending_approval: Option<Value>,
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
            provider: Arc::new(CodexAppServerProvider::new(config)),
            storage,
            jobs: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn start(
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
        let cwd = resolve_workspace_cwd(create.cwd.as_deref(), &workspace_root)?;
        let job_id = format!("agent-{}", &Uuid::new_v4().simple().to_string()[..8]);
        let job_dir = runtime_dir.join("external-agents").join(&job_id);
        let events_file = job_dir.join("events.jsonl");
        let output_file = job_dir.join("output.txt");
        let now = now_iso();
        let mut metadata = json!({
            "job_id": job_id,
            "route": "agent_runner",
            "signals": [],
            "sandbox_cwd": sandbox_cwd_for_host_path(&cwd, &workspace_root),
            "workspace_root": workspace_root
        });
        if let Some(object) = metadata.as_object_mut() {
            if let Some(schedule_id) = &create.schedule_id {
                object.insert("schedule_id".to_string(), json!(schedule_id));
            }
            if let Some(schedule_title) = &create.schedule_title {
                object.insert("schedule_title".to_string(), json!(schedule_title));
            }
            if let Some(schedule_trigger) = &create.schedule_trigger {
                object.insert("schedule_trigger".to_string(), json!(schedule_trigger));
            }
            if let Some(codex_thread_id) = &create.codex_thread_id {
                object.insert("codex_thread_id".to_string(), json!(codex_thread_id));
            }
            if create.codex_persistent_thread {
                object.insert("codex_persistent_thread".to_string(), json!(true));
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
            output_file: Some(output_file.clone()),
            exit_code: None,
            stdout_tail: String::new(),
            stderr_tail: String::new(),
            error: None,
        }));
        self.jobs.write().await.insert(job_id.clone(), job.clone());
        self.write_job_meta(&*job.read().await).await?;

        let provider = self.provider.clone();
        let storage = self.storage.clone();
        let max_runtime_seconds = create.max_runtime_seconds.clamp(1, 86_400);
        let request = AgentRunnerRequest {
            provider: "codex".to_string(),
            prompt,
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
            {
                let mut job = job.write().await;
                if job.status == AgentRunnerStatus::Cancelled {
                    job.updated_at = now_iso();
                    let _ = write_job_meta_to_storage(&storage, &job).await;
                    return;
                }
                job.status = AgentRunnerStatus::Running;
                job.updated_at = now_iso();
                let _ = write_job_meta_to_storage(&storage, &job).await;
            }
            let result = provider.run(request, job_dir).await;
            let mut job = job.write().await;
            if job.status == AgentRunnerStatus::Cancelled {
                job.updated_at = now_iso();
                let _ = write_job_meta_to_storage(&storage, &job).await;
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
            let _ = write_job_meta_to_storage(&storage, &job).await;
        });

        self.info(&job_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("job disappeared after start"))
    }

    pub async fn list_user(
        &self,
        user_id: &str,
        agent_runs_dir: &Path,
    ) -> anyhow::Result<Vec<AgentRunInfo>> {
        let mut merged = HashMap::<String, AgentRunInfo>::new();
        let _ = agent_runs_dir;
        for record in self.storage.list_jobs_for_user(user_id).await? {
            if let Some(info) = info_from_record(&record) {
                merged.insert(info.job_id.clone(), info);
            }
        }
        let jobs = self.jobs.read().await;
        for job in jobs.values() {
            let job = job.read().await;
            if job.user_id.as_deref() == Some(user_id) {
                let info = info_from_job(&job, self.provider.pending_approval(&job.job_id).await);
                merged.insert(info.job_id.clone(), info);
            }
        }
        let mut infos = merged.into_values().collect::<Vec<_>>();
        infos.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(infos)
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
        )))
    }

    pub async fn info_for_user(
        &self,
        job_id: &str,
        user_id: &str,
        agent_runs_dir: &Path,
    ) -> anyhow::Result<Option<AgentRunInfo>> {
        let jobs = self.jobs.read().await;
        if let Some(job) = jobs.get(job_id) {
            let job = job.read().await;
            if job.user_id.as_deref() == Some(user_id) {
                return Ok(Some(info_from_job(
                    &job,
                    self.provider.pending_approval(job_id).await,
                )));
            }
            return Ok(None);
        }
        let _ = agent_runs_dir;
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
        agent_runs_dir: &Path,
    ) -> anyhow::Result<Option<String>> {
        Ok(self
            .info_for_user(job_id, user_id, agent_runs_dir)
            .await?
            .map(|info| info.status))
    }

    pub async fn events_file_for_user(
        &self,
        job_id: &str,
        user_id: &str,
        agent_runs_dir: &Path,
    ) -> anyhow::Result<Option<PathBuf>> {
        if let Some(info) = self.info_for_user(job_id, user_id, agent_runs_dir).await? {
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
        self.write_job_meta(&job).await?;
        Ok(Some(info_from_job(
            &job,
            self.provider.pending_approval(job_id).await,
        )))
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

    async fn write_job_meta(&self, job: &ExternalAgentJob) -> anyhow::Result<()> {
        write_job_meta_to_storage(&self.storage, job).await
    }
}

fn info_from_job(job: &ExternalAgentJob, pending_approval: Option<Value>) -> AgentRunInfo {
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
        stdout_tail: job.stdout_tail.clone(),
        stderr_tail: job.stderr_tail.clone(),
        error: job.error.clone(),
        pending_approval,
        metadata: job.metadata.clone(),
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

async fn write_job_meta_to_storage(
    storage: &Storage,
    job: &ExternalAgentJob,
) -> anyhow::Result<()> {
    storage.upsert_job(&job_record_value(job)).await
}

fn job_record_value(job: &ExternalAgentJob) -> Value {
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
        "stdout_tail": job.stdout_tail,
        "stderr_tail": job.stderr_tail,
        "error": job.error,
    });
    if let Some(object) = record.as_object_mut() {
        for key in ["schedule_id", "schedule_title", "schedule_trigger"] {
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
    }
    record
}

fn info_from_record(record: &Value) -> Option<AgentRunInfo> {
    let job_id = record.get("job_id")?.as_str()?.to_string();
    Some(AgentRunInfo {
        job_id,
        provider: record_str(record, "provider"),
        status: record_str(record, "status"),
        output_file: record
            .get("output_file")
            .and_then(Value::as_str)
            .map(str::to_string),
        events_file: record
            .get("events_file")
            .and_then(Value::as_str)
            .map(str::to_string),
        created_at: record_str(record, "created_at"),
        updated_at: record_str(record, "updated_at"),
        exit_code: record
            .get("exit_code")
            .and_then(Value::as_i64)
            .and_then(|value| i32::try_from(value).ok()),
        prompt_preview: record
            .get("prompt_preview")
            .and_then(Value::as_str)
            .map(str::to_string),
        sandbox_cwd: record
            .get("sandbox_cwd")
            .and_then(Value::as_str)
            .map(str::to_string),
        stdout_tail: record_str(record, "stdout_tail"),
        stderr_tail: record_str(record, "stderr_tail"),
        error: record
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string),
        pending_approval: None,
        metadata: record.clone(),
    })
}

fn record_str(record: &Value, key: &str) -> String {
    record
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn resolve_workspace_cwd(raw_cwd: Option<&str>, workspace_root: &Path) -> anyhow::Result<PathBuf> {
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
        candidate
    };
    if !resolved.starts_with(&root) {
        anyhow::bail!("cwd must stay inside the user workspace");
    }
    Ok(resolved)
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
