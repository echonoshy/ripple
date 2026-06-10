use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Context;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::fs::OpenOptions;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex, Notify};
use tokio::time::timeout;

use crate::codex::approvals::{approval_response_for_action, CodexApproval};
use crate::codex::permissions::{thread_permission_config, RIPPLE_CODEX_PERMISSION_PROFILE};
use crate::config::AppConfig;
use crate::python_env::{ensure_ripple_py_wrapper, ripple_py_bin_dir};
use crate::redaction::{redact_text, redact_value};
use crate::sandbox::SandboxManager;
use crate::user::validate_user_id;

const TAIL_CHARS: usize = 64_000;
const MAX_WORKERS_PER_POOL: usize = 4;
const MAX_TOTAL_POOL_WORKERS: usize = 64;
const IDLE_REAPER_INTERVAL_SECONDS: u64 = 5;
const CODEX_NATIVE_INPUT_TYPES: &[&str] = &["text", "image", "localImage"];
const CODEX_NATIVE_HARDENING_CONFIG_OVERRIDES: &[&str] = &[
    "include_apps_instructions=false",
    "features.apps=false",
    "features.plugins=false",
    "skills.include_instructions=false",
    "skills.bundled.enabled=false",
];
const THREAD_NOTIFICATION_QUEUE: &str = "__thread__";
const INHERITED_NETWORK_ENV: &[&str] = &[
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "CURL_CA_BUNDLE",
    "REQUESTS_CA_BUNDLE",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRunnerRequest {
    pub provider: String,
    pub prompt: String,
    pub base_instructions: Option<String>,
    pub turn_context: Option<String>,
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

#[derive(Clone)]
struct ActiveTurn {
    session: Arc<CodexAppServerSession>,
    thread_id: String,
    turn_id: String,
}

#[derive(Default)]
struct NotificationRoutes {
    queues: HashMap<(String, String), mpsc::UnboundedSender<Value>>,
    pending_turn: HashMap<(String, String), Vec<Value>>,
    pending_thread: HashMap<String, Vec<Value>>,
}

pub struct CodexAppServerSession {
    user_key: String,
    config: Arc<AppConfig>,
    cwd: PathBuf,
    process: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    routes: Mutex<NotificationRoutes>,
    stderr_tail: Mutex<String>,
    initialized: Mutex<bool>,
    loaded_thread_ids: Mutex<HashSet<String>>,
    start_lock: Mutex<()>,
    initialize_lock: Mutex<()>,
}

impl CodexAppServerSession {
    fn new(user_key: String, config: Arc<AppConfig>, cwd: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            user_key,
            config,
            cwd,
            process: Mutex::new(None),
            stdin: Mutex::new(None),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            routes: Mutex::new(NotificationRoutes::default()),
            stderr_tail: Mutex::new(String::new()),
            initialized: Mutex::new(false),
            loaded_thread_ids: Mutex::new(HashSet::new()),
            start_lock: Mutex::new(()),
            initialize_lock: Mutex::new(()),
        })
    }

    async fn ensure_started(self: &Arc<Self>) -> anyhow::Result<()> {
        let _guard = self.start_lock.lock().await;
        {
            let mut process = self.process.lock().await;
            if let Some(child) = process.as_mut() {
                if child.try_wait()?.is_none() {
                    return Ok(());
                }
            }
            *process = None;
        }

        tokio::fs::create_dir_all(&self.cwd).await?;
        ensure_ripple_py_wrapper(&self.config)?;
        crate::runtime_checks::ensure_codex_linux_sandbox_prerequisites(&self.config).await?;
        let sandbox_manager = SandboxManager::new(self.config.clone());
        if sandbox_manager.service_codex_auth_file().exists()
            || requires_service_codex_auth(&self.config)
        {
            sandbox_manager.ensure_user_codex_home_auth_link(&self.user_key)?;
        }
        let codex_home = codex_home_for_user(&self.config, &self.user_key)?;
        tokio::fs::create_dir_all(&codex_home).await?;

        let mut command = Command::new(&self.config.codex.codex_executable);
        command.env_clear();
        inherit_env_allowlist(&mut command, INHERITED_NETWORK_ENV);
        let app_server_args = hardened_app_server_args(&self.config.codex.app_server_args);
        command
            .args(&app_server_args)
            .current_dir(&self.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        tokio::fs::create_dir_all(self.cwd.join(".tmp")).await?;
        command.env("HOME", &self.cwd);
        command.env("USER", "sandbox");
        command.env(
            "SHELL",
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string()),
        );
        command.env(
            "TERM",
            std::env::var("TERM").unwrap_or_else(|_| "xterm-256color".to_string()),
        );
        command.env(
            "LANG",
            std::env::var("LANG").unwrap_or_else(|_| "C.UTF-8".to_string()),
        );
        command.env("XDG_CONFIG_HOME", self.cwd.join(".config"));
        command.env("TMPDIR", self.cwd.join(".tmp"));
        command.env("PYTHONDONTWRITEBYTECODE", "1");
        if let Some(path) = runtime_path(&self.config) {
            command.env("PATH", path);
        }
        command.env("CODEX_HOME", &codex_home);
        let uv_cache_dir = self.cwd.join(".cache/uv");
        tokio::fs::create_dir_all(&uv_cache_dir).await?;
        command.env("UV_CACHE_DIR", uv_cache_dir);
        command.env("UV_LINK_MODE", "copy");
        if let Some(url) = &self.config.sandbox.pypi_mirror_url {
            command.env("UV_INDEX_URL", url);
            command.env("PIP_INDEX_URL", url);
        }
        if self.config.sandbox.node_dir.is_some() {
            let pnpm_store = self.config.sandbox.caches_root.join("pnpm-store");
            let corepack_home = self.config.sandbox.caches_root.join("corepack-cache");
            tokio::fs::create_dir_all(&pnpm_store).await?;
            tokio::fs::create_dir_all(&corepack_home).await?;
            command.env("PNPM_HOME", self.cwd.join(".local/bin"));
            command.env("NPM_CONFIG_PREFIX", self.cwd.join(".local"));
            command.env("PNPM_STORE_DIR", pnpm_store);
            command.env("COREPACK_HOME", corepack_home);
            command.env("COREPACK_ENABLE_AUTO_PIN", "0");
            command.env("COREPACK_ENABLE_DOWNLOAD_PROMPT", "0");
            if let Some(url) = &self.config.sandbox.npm_registry_url {
                command.env("NPM_CONFIG_REGISTRY", url);
                command.env("COREPACK_NPM_REGISTRY", url);
            }
        }
        let credentials_dir = self
            .config
            .sandbox
            .sandboxes_root
            .join(&self.user_key)
            .join("credentials");
        if let Some(token) =
            read_json_string_field(&credentials_dir.join("notion.json"), "api_token").await
        {
            command.env("NOTION_API_TOKEN", token);
        }
        for (key, value) in connector_credential_env(&credentials_dir) {
            command.env(key, value);
        }
        if self.config.sandbox.gogcli_cli_install_root.is_some() {
            command.env("GOG_KEYRING_BACKEND", "file");
            let pass_file = credentials_dir.join("gogcli-keyring.pass");
            if let Ok(password) = tokio::fs::read_to_string(pass_file).await {
                let password = password.trim();
                if !password.is_empty() {
                    command.env("GOG_KEYRING_PASSWORD", password);
                }
            }
        }

        let mut child = command.spawn().with_context(|| {
            format!(
                "failed to start Codex app-server for user {} using executable {:?}",
                self.user_key, self.config.codex.codex_executable
            )
        })?;
        let stdout = child
            .stdout
            .take()
            .context("codex app-server stdout unavailable")?;
        let stderr = child
            .stderr
            .take()
            .context("codex app-server stderr unavailable")?;
        let stdin = child
            .stdin
            .take()
            .context("codex app-server stdin unavailable")?;
        *self.stdin.lock().await = Some(stdin);
        *self.process.lock().await = Some(child);
        *self.initialized.lock().await = false;
        self.loaded_thread_ids.lock().await.clear();

        let session = self.clone();
        tokio::spawn(async move {
            session.read_stdout(stdout).await;
        });
        let session = self.clone();
        tokio::spawn(async move {
            session.read_stderr(stderr).await;
        });
        Ok(())
    }

    async fn ensure_initialized(self: &Arc<Self>) -> anyhow::Result<()> {
        self.ensure_started().await?;
        let _guard = self.initialize_lock.lock().await;
        if *self.initialized.lock().await {
            return Ok(());
        }
        self.request(
            "initialize",
            json!({
                "clientInfo": {"name": "ripple", "version": "0.1.0-rust"},
                "capabilities": {"experimentalApi": true}
            }),
        )
        .await?;
        self.notify("initialized", json!({})).await?;
        *self.initialized.lock().await = true;
        Ok(())
    }

    async fn request(self: &Arc<Self>, method: &str, params: Value) -> anyhow::Result<Value> {
        self.ensure_started().await?;
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        self.write(json!({"id": id, "method": method, "params": params}))
            .await?;
        let response = timeout(Duration::from_secs(30), rx)
            .await
            .with_context(|| {
                format!("timed out waiting for Codex app-server response to {method}")
            })??;
        if let Some(error) = response.get("error") {
            anyhow::bail!("Codex app-server JSON-RPC error for {method}: {error}");
        }
        Ok(response.get("result").cloned().unwrap_or_else(|| json!({})))
    }

    async fn notify(self: &Arc<Self>, method: &str, params: Value) -> anyhow::Result<()> {
        self.ensure_started().await?;
        self.write(json!({"method": method, "params": params}))
            .await
    }

    async fn respond(self: &Arc<Self>, request_id: Value, result: Value) -> anyhow::Result<()> {
        self.ensure_started().await?;
        self.write(json!({"id": request_id, "result": result}))
            .await
    }

    async fn respond_error(
        self: &Arc<Self>,
        request_id: Value,
        code: i64,
        message: &str,
        data: Value,
    ) -> anyhow::Result<()> {
        self.ensure_started().await?;
        self.write(json!({
            "id": request_id,
            "error": {"code": code, "message": message, "data": data}
        }))
        .await
    }

    async fn write(&self, payload: Value) -> anyhow::Result<()> {
        let mut stdin = self.stdin.lock().await;
        let Some(stdin) = stdin.as_mut() else {
            anyhow::bail!("codex app-server process is not writable");
        };
        let mut line = serde_json::to_vec(&payload)?;
        line.push(b'\n');
        stdin.write_all(&line).await?;
        stdin.flush().await?;
        Ok(())
    }

    async fn register_turn(
        &self,
        thread_id: String,
        turn_id: String,
    ) -> mpsc::UnboundedReceiver<Value> {
        let (tx, rx) = mpsc::unbounded_channel();
        let key = (thread_id.clone(), turn_id.clone());
        let mut routes = self.routes.lock().await;
        if let Some(messages) = routes.pending_thread.remove(&thread_id) {
            for message in messages {
                let _ = tx.send(message);
            }
        }
        if let Some(messages) = routes.pending_turn.remove(&key) {
            for message in messages {
                let _ = tx.send(message);
            }
        }
        routes.queues.insert(key, tx);
        rx
    }

    async fn register_thread(&self, thread_id: String) -> mpsc::UnboundedReceiver<Value> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut routes = self.routes.lock().await;
        if let Some(messages) = routes.pending_thread.remove(&thread_id) {
            for message in messages {
                let _ = tx.send(message);
            }
        }
        let pending_turn_keys = routes
            .pending_turn
            .keys()
            .filter(|(pending_thread_id, _)| pending_thread_id == &thread_id)
            .cloned()
            .collect::<Vec<_>>();
        for key in pending_turn_keys {
            if let Some(messages) = routes.pending_turn.remove(&key) {
                for message in messages {
                    let _ = tx.send(message);
                }
            }
        }
        routes
            .queues
            .insert((thread_id, THREAD_NOTIFICATION_QUEUE.to_string()), tx);
        rx
    }

    async fn unregister_turn(&self, thread_id: &str, turn_id: &str) {
        self.routes
            .lock()
            .await
            .queues
            .remove(&(thread_id.to_string(), turn_id.to_string()));
    }

    async fn unregister_thread(&self, thread_id: &str) {
        self.routes
            .lock()
            .await
            .queues
            .remove(&(thread_id.to_string(), THREAD_NOTIFICATION_QUEUE.to_string()));
    }

    async fn dispatch_notification(&self, message: Value) {
        let thread_id = notification_thread_id(&message);
        let turn_id = notification_turn_id(&message);
        let mut routes = self.routes.lock().await;
        if let (Some(thread_id), Some(turn_id)) = (thread_id.clone(), turn_id) {
            let key = (thread_id.clone(), turn_id);
            if let Some(queue) = routes.queues.get(&key) {
                let _ = queue.send(message);
            } else if let Some(queue) = routes
                .queues
                .get(&(thread_id.clone(), THREAD_NOTIFICATION_QUEUE.to_string()))
            {
                let _ = queue.send(message);
            } else {
                routes.pending_turn.entry(key).or_default().push(message);
            }
            return;
        }
        if let Some(thread_id) = thread_id {
            let queues = routes
                .queues
                .iter()
                .filter(|((active_thread_id, _), _)| active_thread_id == &thread_id)
                .map(|(_, queue)| queue.clone())
                .collect::<Vec<_>>();
            if queues.is_empty() {
                routes
                    .pending_thread
                    .entry(thread_id)
                    .or_default()
                    .push(message);
            } else {
                for queue in queues {
                    let _ = queue.send(message.clone());
                }
            }
            return;
        }
        for queue in routes.queues.values() {
            let _ = queue.send(message.clone());
        }
    }

    async fn read_stdout(self: Arc<Self>, stdout: tokio::process::ChildStdout) {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                self.dispatch_notification(
                    json!({"method": "codex/stdout", "params": {"text": line}}),
                )
                .await;
                continue;
            };
            if let Some(id) = message.get("id").and_then(Value::as_u64) {
                if message.get("result").is_some() || message.get("error").is_some() {
                    if let Some(tx) = self.pending.lock().await.remove(&id) {
                        let _ = tx.send(message);
                    }
                    continue;
                }
            }
            if message.get("method").is_some() {
                self.dispatch_notification(message).await;
            }
        }
    }

    async fn read_stderr(self: Arc<Self>, stderr: tokio::process::ChildStderr) {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let mut tail = self.stderr_tail.lock().await;
            tail.push_str(&redact_text(&line));
            tail.push('\n');
            if tail.len() > TAIL_CHARS {
                let keep_from = tail.len() - TAIL_CHARS;
                *tail = tail[keep_from..].to_string();
            }
        }
    }

    async fn stderr_tail_len(&self) -> usize {
        self.stderr_tail.lock().await.len()
    }

    async fn stderr_tail_since(&self, offset: usize) -> String {
        let tail = self.stderr_tail.lock().await;
        if offset <= tail.len() {
            tail[offset..].to_string()
        } else {
            tail.clone()
        }
    }

    async fn shutdown(&self) {
        *self.stdin.lock().await = None;
        *self.initialized.lock().await = false;
        self.loaded_thread_ids.lock().await.clear();
        self.routes.lock().await.queues.clear();

        let child = self.process.lock().await.take();
        if let Some(mut child) = child {
            let _ = child.start_kill();
            let _ = timeout(Duration::from_secs(2), child.wait()).await;
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PoolKey {
    user_key: String,
    workspace_root: PathBuf,
    generation: String,
}

struct PoolWorker {
    worker_id: u64,
    session: Arc<CodexAppServerSession>,
    active_job_id: Option<String>,
    last_used_at: Instant,
}

#[derive(Default)]
struct PoolState {
    pools: HashMap<PoolKey, Vec<PoolWorker>>,
    job_to_worker: HashMap<String, (PoolKey, u64)>,
}

#[derive(Clone)]
pub struct CodexAppServerProvider {
    config: Arc<AppConfig>,
    pools: Arc<Mutex<PoolState>>,
    pool_notify: Arc<Notify>,
    next_worker_id: Arc<AtomicU64>,
    reaper_started: Arc<AtomicBool>,
    active_turns: Arc<Mutex<HashMap<String, ActiveTurn>>>,
    pending_approvals: Arc<Mutex<HashMap<String, Value>>>,
}

impl CodexAppServerProvider {
    pub fn new(config: Arc<AppConfig>) -> Self {
        Self {
            config,
            pools: Arc::new(Mutex::new(PoolState::default())),
            pool_notify: Arc::new(Notify::new()),
            next_worker_id: Arc::new(AtomicU64::new(1)),
            reaper_started: Arc::new(AtomicBool::new(false)),
            active_turns: Arc::new(Mutex::new(HashMap::new())),
            pending_approvals: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn run(
        &self,
        request: AgentRunnerRequest,
        job_dir: PathBuf,
    ) -> anyhow::Result<AgentRunnerResult> {
        let job_id = request
            .metadata
            .get("job_id")
            .and_then(Value::as_str)
            .unwrap_or("agent-job")
            .to_string();
        tokio::fs::create_dir_all(&job_dir).await?;
        let events_file = job_dir.join("events.jsonl");
        let output_file = job_dir.join("output.txt");
        let mut sequence = 0_u64;
        let mut output_text = String::new();
        let mut thread_id = None;
        let mut turn_id = None;
        let mut thread_resumed = false;

        append_event(
            &events_file,
            &mut sequence,
            &job_id,
            &request.provider,
            "runner.started",
            None,
            json!({
                "cwd": request.cwd,
                "runner": "codex-app-server",
                "user_id": request.user_id,
                "trusted_app_server": true
            }),
        )
        .await?;

        let session = self.session_for_request(&request).await?;
        let stderr_start = session.stderr_tail_len().await;
        let mut turn_rx = None;
        let (status, error) = match self
            .run_turn(&request, &job_id, &events_file, &mut sequence, &session)
            .await
        {
            Ok((ids, rx, text, resumed)) => {
                thread_id = Some(ids.0);
                turn_id = Some(ids.1);
                turn_rx = Some(rx);
                output_text = text;
                thread_resumed = resumed;
                (AgentRunnerStatus::Completed, None)
            }
            Err(err) => (AgentRunnerStatus::Failed, Some(err.to_string())),
        };

        if let (Some(thread_id), Some(turn_id)) = (thread_id.as_deref(), turn_id.as_deref()) {
            session.unregister_turn(thread_id, turn_id).await;
        }
        self.active_turns.lock().await.remove(&job_id);
        self.pending_approvals.lock().await.remove(&job_id);
        drop(turn_rx);

        let final_type = match status {
            AgentRunnerStatus::Completed => "runner.completed",
            AgentRunnerStatus::Cancelled => "runner.cancelled",
            _ => "runner.failed",
        };
        append_event(
            &events_file,
            &mut sequence,
            &job_id,
            &request.provider,
            final_type,
            error.clone(),
            json!({ "exit_code": Value::Null }),
        )
        .await?;
        tokio::fs::write(&output_file, &output_text).await?;

        let mut metadata = serde_json::Map::new();
        if persistent_thread(&request) {
            if let Some(thread_id) = thread_id {
                metadata.insert("codex_thread_id".to_string(), json!(thread_id));
                metadata.insert("codex_persistent_thread".to_string(), json!(true));
                metadata.insert("codex_thread_resumed".to_string(), json!(thread_resumed));
            }
        }
        let stderr_tail = redact_text(&session.stderr_tail_since(stderr_start).await);
        self.release_job_session(&job_id).await;
        Ok(AgentRunnerResult {
            job_id,
            provider: request.provider,
            status,
            events_file,
            output_file: Some(output_file),
            exit_code: None,
            stdout_tail: redact_text(&tail(&output_text)),
            stderr_tail,
            error,
            metadata: Value::Object(metadata),
        })
    }

    async fn run_turn(
        &self,
        request: &AgentRunnerRequest,
        job_id: &str,
        events_file: &Path,
        sequence: &mut u64,
        session: &Arc<CodexAppServerSession>,
    ) -> anyhow::Result<(
        (String, String),
        mpsc::UnboundedReceiver<Value>,
        String,
        bool,
    )> {
        session.ensure_initialized().await?;
        let workspace_root = request
            .metadata
            .get("workspace_root")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .unwrap_or_else(|| request.cwd.clone());
        let permission_config = thread_config_for_request(&workspace_root, &self.config, request);
        let (thread_id, thread_resumed) = self
            .ensure_thread(request, session, &permission_config)
            .await?;

        let turn_result = session
            .request(
                "turn/start",
                turn_start_params(&thread_id, request, &self.config.codex.approval_policy),
            )
            .await?;
        let turn_id = turn_result
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .context("codex app-server did not return a turn id")?
            .to_string();
        let mut rx = session
            .register_turn(thread_id.clone(), turn_id.clone())
            .await;
        self.active_turns.lock().await.insert(
            job_id.to_string(),
            ActiveTurn {
                session: session.clone(),
                thread_id: thread_id.clone(),
                turn_id: turn_id.clone(),
            },
        );
        let output = self
            .collect_turn(
                request,
                job_id,
                &thread_id,
                &turn_id,
                events_file,
                sequence,
                session,
                &mut rx,
            )
            .await?;
        Ok(((thread_id, turn_id), rx, output, thread_resumed))
    }

    async fn collect_turn(
        &self,
        request: &AgentRunnerRequest,
        job_id: &str,
        thread_id: &str,
        turn_id: &str,
        events_file: &Path,
        sequence: &mut u64,
        session: &Arc<CodexAppServerSession>,
        rx: &mut mpsc::UnboundedReceiver<Value>,
    ) -> anyhow::Result<String> {
        let mut legacy_output_parts = Vec::new();
        let mut final_output_text = String::new();
        let mut phases: HashMap<String, Option<String>> = HashMap::new();
        let deadline = Duration::from_secs(request.max_runtime_seconds.max(1));
        let collect = async {
            while let Some(message) = rx.recv().await {
                append_event(
                    events_file,
                    sequence,
                    job_id,
                    &request.provider,
                    "codex.notification",
                    None,
                    json!({ "message": message }),
                )
                .await?;
                if let Some(approval) = parse_approval_request(&message, job_id, request) {
                    self.pending_approvals
                        .lock()
                        .await
                        .insert(job_id.to_string(), approval.clone());
                    append_event(
                        events_file,
                        sequence,
                        job_id,
                        &request.provider,
                        "codex.approval_request",
                        approval
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        json!({ "approval": approval }),
                    )
                    .await?;
                    continue;
                }
                if is_unsupported_server_request(&message) {
                    let request_id = message.get("id").cloned().unwrap_or(Value::Null);
                    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
                    let _ = session
                        .respond_error(
                            request_id,
                            -32601,
                            &format!("unsupported Codex server request: {method}"),
                            json!({"method": method}),
                        )
                        .await;
                    continue;
                }
                record_agent_message_phase(&message, &mut phases);
                if let Some(text) = completed_final_agent_message(&message) {
                    final_output_text = text;
                } else if let Some(delta) = streamable_final_delta(&message, &phases) {
                    legacy_output_parts.push(delta);
                }
                if is_turn_completed(&message, thread_id, turn_id) {
                    let turn_status = message
                        .pointer("/params/turn/status")
                        .and_then(Value::as_str);
                    if turn_status == Some("interrupted") {
                        return Ok::<_, anyhow::Error>(legacy_output_parts.join(""));
                    }
                    if turn_status == Some("failed") {
                        anyhow::bail!("codex turn failed");
                    }
                    return Ok(final_output_text
                        .clone()
                        .if_empty_then(|| legacy_output_parts.join("")));
                }
            }
            anyhow::bail!("codex app-server notification stream ended before turn completion")
        };
        timeout(deadline, collect)
            .await
            .with_context(|| format!("runner timed out after {}s", request.max_runtime_seconds))?
    }

    async fn ensure_thread(
        &self,
        request: &AgentRunnerRequest,
        session: &Arc<CodexAppServerSession>,
        permission_config: &Value,
    ) -> anyhow::Result<(String, bool)> {
        let persistent_thread = persistent_thread(request);
        let requested_thread_id = request
            .metadata
            .get("codex_thread_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if persistent_thread {
            if let Some(thread_id) = requested_thread_id {
                let mut resume_params = json!({
                    "threadId": thread_id,
                    "cwd": request.cwd,
                    "approvalPolicy": self.config.codex.approval_policy,
                    "config": permission_config,
                    "permissions": RIPPLE_CODEX_PERMISSION_PROFILE,
                    "excludeTurns": true
                });
                add_base_instructions(&mut resume_params, request);
                let thread_result = session.request("thread/resume", resume_params).await?;
                let thread_id = thread_result
                    .pointer("/thread/id")
                    .and_then(Value::as_str)
                    .unwrap_or(&thread_id)
                    .to_string();
                session
                    .loaded_thread_ids
                    .lock()
                    .await
                    .insert(thread_id.clone());
                return Ok((thread_id, true));
            }
        }

        let mut start_params = json!({
            "cwd": request.cwd,
            "approvalPolicy": self.config.codex.approval_policy,
            "ephemeral": !persistent_thread,
            "serviceName": "ripple",
            "config": permission_config,
            "permissions": RIPPLE_CODEX_PERMISSION_PROFILE
        });
        add_base_instructions(&mut start_params, request);
        let thread_result = session.request("thread/start", start_params).await?;
        let thread_id = thread_result
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .context("codex app-server did not return a thread id")?
            .to_string();
        session
            .loaded_thread_ids
            .lock()
            .await
            .insert(thread_id.clone());
        Ok((thread_id, false))
    }

    async fn session_for_request(
        &self,
        request: &AgentRunnerRequest,
    ) -> anyhow::Result<Arc<CodexAppServerSession>> {
        let job_key = request
            .metadata
            .get("job_id")
            .and_then(Value::as_str)
            .unwrap_or("agent-job")
            .to_string();
        let user_key = request
            .user_id
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let workspace_root = request
            .metadata
            .get("workspace_root")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .unwrap_or_else(|| request.cwd.clone());
        let pool_key = PoolKey {
            user_key: user_key.clone(),
            workspace_root: workspace_root.clone(),
            generation: pool_generation(&self.config),
        };

        loop {
            let notified = self.pool_notify.notified();
            let session = {
                let mut state = self.pools.lock().await;
                let mut claimed_idle = None;
                if let Some(workers) = state.pools.get_mut(&pool_key) {
                    if let Some(worker) = workers
                        .iter_mut()
                        .find(|worker| worker.active_job_id.is_none())
                    {
                        worker.active_job_id = Some(job_key.clone());
                        worker.last_used_at = Instant::now();
                        claimed_idle = Some((worker.worker_id, worker.session.clone()));
                    }
                }
                if let Some((worker_id, session)) = claimed_idle {
                    state
                        .job_to_worker
                        .insert(job_key.clone(), (pool_key.clone(), worker_id));
                    Some(session)
                } else {
                    let pool_size = state.pools.get(&pool_key).map_or(0, Vec::len);
                    let total_workers = state.pools.values().map(Vec::len).sum::<usize>();
                    if pool_size >= MAX_WORKERS_PER_POOL || total_workers >= MAX_TOTAL_POOL_WORKERS
                    {
                        None
                    } else {
                        let worker_id = self.next_worker_id.fetch_add(1, Ordering::SeqCst);
                        let session = CodexAppServerSession::new(
                            user_key.clone(),
                            self.config.clone(),
                            workspace_root.clone(),
                        );
                        state
                            .pools
                            .entry(pool_key.clone())
                            .or_default()
                            .push(PoolWorker {
                                worker_id,
                                session: session.clone(),
                                active_job_id: Some(job_key.clone()),
                                last_used_at: Instant::now(),
                            });
                        state
                            .job_to_worker
                            .insert(job_key.clone(), (pool_key.clone(), worker_id));
                        Some(session)
                    }
                }
            };

            if let Some(session) = session {
                if let Err(err) = session.ensure_started().await {
                    self.discard_job_worker(&job_key).await;
                    return Err(err);
                }
                return Ok(session);
            }

            notified.await;
        }
    }

    async fn discard_job_worker(&self, job_id: &str) -> bool {
        let session = {
            let mut state = self.pools.lock().await;
            let Some((pool_key, worker_id)) = state.job_to_worker.remove(job_id) else {
                return false;
            };
            let session = state.pools.get_mut(&pool_key).and_then(|workers| {
                workers
                    .iter()
                    .position(|worker| worker.worker_id == worker_id)
                    .map(|index| workers.remove(index).session)
            });
            if state
                .pools
                .get(&pool_key)
                .is_some_and(|workers| workers.is_empty())
            {
                state.pools.remove(&pool_key);
            }
            session
        };
        if let Some(session) = session {
            session.shutdown().await;
            self.pool_notify.notify_waiters();
            return true;
        }
        false
    }

    fn ensure_idle_reaper_started(&self) {
        if self.reaper_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let pools = Arc::downgrade(&self.pools);
        let notify = Arc::downgrade(&self.pool_notify);
        let idle_timeout = Duration::from_secs(self.config.codex.idle_timeout_seconds.max(1));
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(IDLE_REAPER_INTERVAL_SECONDS)).await;
                let Some(pools) = pools.upgrade() else {
                    break;
                };
                let Some(notify) = notify.upgrade() else {
                    break;
                };
                let mut expired_sessions = Vec::new();
                {
                    let mut state = pools.lock().await;
                    let now = Instant::now();
                    let keys = state.pools.keys().cloned().collect::<Vec<_>>();
                    for key in keys {
                        if let Some(workers) = state.pools.get_mut(&key) {
                            let mut index = 0;
                            while index < workers.len() {
                                let expired = workers[index].active_job_id.is_none()
                                    && now.duration_since(workers[index].last_used_at)
                                        >= idle_timeout;
                                if expired {
                                    expired_sessions.push(workers.remove(index).session);
                                } else {
                                    index += 1;
                                }
                            }
                        }
                        if state
                            .pools
                            .get(&key)
                            .is_some_and(|workers| workers.is_empty())
                        {
                            state.pools.remove(&key);
                        }
                    }
                }
                if !expired_sessions.is_empty() {
                    for session in expired_sessions {
                        session.shutdown().await;
                    }
                    notify.notify_waiters();
                }
            }
        });
    }

    pub async fn pending_approval(&self, job_id: &str) -> Option<Value> {
        self.pending_approvals.lock().await.get(job_id).cloned()
    }

    pub async fn resolve_approval(&self, job_id: &str, request_id: &Value, action: &str) -> bool {
        let active = self.active_turns.lock().await.get(job_id).cloned();
        let Some(active) = active else {
            return false;
        };
        let approval_value = self.pending_approvals.lock().await.get(job_id).cloned();
        let Some(approval_value) = approval_value else {
            return false;
        };
        if approval_value.get("request_id") != Some(request_id) {
            return false;
        }
        let Ok(approval) = serde_json::from_value::<CodexApproval>(approval_value) else {
            return false;
        };
        let response = approval_response_for_action(&approval, action);
        if active
            .session
            .respond(request_id.clone(), response)
            .await
            .is_err()
        {
            return false;
        }
        self.pending_approvals.lock().await.remove(job_id);
        true
    }

    pub async fn steer(&self, job_id: &str, text: String) -> bool {
        let active = self.active_turns.lock().await.get(job_id).cloned();
        let Some(active) = active else {
            return false;
        };
        active
            .session
            .request(
                "turn/steer",
                json!({
                    "threadId": active.thread_id,
                    "expectedTurnId": active.turn_id,
                    "input": [{"type": "text", "text": text}]
                }),
            )
            .await
            .is_ok()
    }

    pub async fn cancel(&self, job_id: &str) -> bool {
        let active = self.active_turns.lock().await.get(job_id).cloned();
        self.pending_approvals.lock().await.remove(job_id);
        let Some(active) = active else {
            return false;
        };
        active
            .session
            .request(
                "turn/interrupt",
                json!({"threadId": active.thread_id, "turnId": active.turn_id}),
            )
            .await
            .is_ok()
    }

    pub async fn compact_thread(
        &self,
        user_id: String,
        workspace_root: PathBuf,
        cwd: PathBuf,
        thread_id: String,
        max_runtime_seconds: u64,
    ) -> anyhow::Result<()> {
        let session = CodexAppServerSession::new(user_id, self.config.clone(), workspace_root);
        let result = self
            .compact_thread_with_session(&session, cwd, thread_id, max_runtime_seconds)
            .await;
        session.shutdown().await;
        result
    }

    pub async fn read_thread(
        &self,
        user_id: String,
        workspace_root: PathBuf,
        thread_id: String,
    ) -> anyhow::Result<Value> {
        let session = CodexAppServerSession::new(user_id, self.config.clone(), workspace_root);
        let result = async {
            session.ensure_started().await?;
            session.ensure_initialized().await?;
            session
                .request(
                    "thread/read",
                    json!({
                        "threadId": thread_id,
                        "includeTurns": false
                    }),
                )
                .await
        }
        .await;
        session.shutdown().await;
        result
    }

    pub async fn reset_memory(
        &self,
        user_id: String,
        workspace_root: PathBuf,
    ) -> anyhow::Result<()> {
        let session = CodexAppServerSession::new(user_id, self.config.clone(), workspace_root);
        let result = async {
            session.ensure_started().await?;
            session.ensure_initialized().await?;
            session.request("memory/reset", json!({})).await?;
            Ok(())
        }
        .await;
        session.shutdown().await;
        result
    }

    pub async fn set_thread_memory_mode(
        &self,
        user_id: String,
        workspace_root: PathBuf,
        thread_id: String,
        mode: &str,
    ) -> anyhow::Result<()> {
        let session = CodexAppServerSession::new(user_id, self.config.clone(), workspace_root);
        let result = async {
            session.ensure_started().await?;
            session.ensure_initialized().await?;
            session
                .request(
                    "thread/memoryMode/set",
                    json!({
                        "threadId": thread_id,
                        "mode": mode
                    }),
                )
                .await?;
            Ok(())
        }
        .await;
        session.shutdown().await;
        result
    }

    async fn compact_thread_with_session(
        &self,
        session: &Arc<CodexAppServerSession>,
        cwd: PathBuf,
        thread_id: String,
        max_runtime_seconds: u64,
    ) -> anyhow::Result<()> {
        session.ensure_started().await?;
        session.ensure_initialized().await?;
        let permission_config = thread_permission_config(&session.cwd, &self.config);
        let thread_result = session
            .request(
                "thread/resume",
                json!({
                    "threadId": thread_id.clone(),
                    "cwd": cwd,
                    "approvalPolicy": self.config.codex.approval_policy,
                    "config": permission_config,
                    "permissions": RIPPLE_CODEX_PERMISSION_PROFILE,
                    "excludeTurns": true
                }),
            )
            .await?;
        let thread_id = thread_result
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .unwrap_or(thread_id.as_str())
            .to_string();
        session
            .loaded_thread_ids
            .lock()
            .await
            .insert(thread_id.clone());
        let mut rx = session.register_thread(thread_id.clone()).await;
        let result = async {
            session
                .request(
                    "thread/compact/start",
                    json!({ "threadId": thread_id.clone() }),
                )
                .await?;
            collect_context_compaction(&thread_id, max_runtime_seconds, &mut rx).await
        }
        .await;
        session.unregister_thread(&thread_id).await;
        result
    }

    pub async fn stop_user(&self, user_id: &str) -> usize {
        let (sessions, active_job_ids) = {
            let mut state = self.pools.lock().await;
            let keys = state
                .pools
                .keys()
                .filter(|key| key.user_key == user_id)
                .cloned()
                .collect::<Vec<_>>();
            let mut sessions = Vec::new();
            let mut active_job_ids = Vec::new();
            for key in keys {
                if let Some(workers) = state.pools.remove(&key) {
                    for worker in workers {
                        if let Some(job_id) = worker.active_job_id.clone() {
                            state.job_to_worker.remove(&job_id);
                            active_job_ids.push(job_id);
                        }
                        sessions.push(worker.session);
                    }
                }
            }
            (sessions, active_job_ids)
        };
        if sessions.is_empty() {
            return 0;
        }
        let mut removed = 0_usize;
        {
            let mut active_turns = self.active_turns.lock().await;
            for job_id in &active_job_ids {
                if active_turns.remove(job_id).is_some() {
                    removed += 1;
                }
            }
            let remaining_job_ids = active_turns
                .iter()
                .filter_map(|(job_id, active)| {
                    sessions
                        .iter()
                        .any(|session| Arc::ptr_eq(&active.session, session))
                        .then(|| job_id.clone())
                })
                .collect::<Vec<_>>();
            for job_id in remaining_job_ids {
                active_turns.remove(&job_id);
                removed += 1;
            }
        }
        if !active_job_ids.is_empty() {
            let mut approvals = self.pending_approvals.lock().await;
            for job_id in active_job_ids {
                approvals.remove(&job_id);
            }
        }
        for session in sessions {
            session.shutdown().await;
        }
        self.pool_notify.notify_waiters();
        removed
    }

    async fn release_job_session(&self, job_id: &str) -> bool {
        self.pending_approvals.lock().await.remove(job_id);
        let released = {
            let mut state = self.pools.lock().await;
            let Some((pool_key, worker_id)) = state.job_to_worker.remove(job_id) else {
                return false;
            };
            let mut released = false;
            if let Some(workers) = state.pools.get_mut(&pool_key) {
                if let Some(worker) = workers
                    .iter_mut()
                    .find(|worker| worker.worker_id == worker_id)
                {
                    worker.active_job_id = None;
                    worker.last_used_at = Instant::now();
                    released = true;
                }
            }
            released
        };
        if released {
            self.ensure_idle_reaper_started();
            self.pool_notify.notify_waiters();
        };
        released
    }
}

async fn collect_context_compaction(
    thread_id: &str,
    max_runtime_seconds: u64,
    rx: &mut mpsc::UnboundedReceiver<Value>,
) -> anyhow::Result<()> {
    let deadline = Duration::from_secs(max_runtime_seconds.max(1));
    let collect = async {
        while let Some(message) = rx.recv().await {
            if is_context_compaction_completed(&message, thread_id) {
                return Ok::<_, anyhow::Error>(());
            }
            if is_compaction_turn_failed(&message, thread_id) {
                anyhow::bail!("codex context compaction failed");
            }
            if message.get("method").and_then(Value::as_str) == Some("error") {
                let detail = message
                    .pointer("/params/message")
                    .or_else(|| message.pointer("/params/error/message"))
                    .and_then(Value::as_str)
                    .unwrap_or("codex context compaction failed");
                anyhow::bail!(detail.to_string());
            }
        }
        anyhow::bail!(
            "codex app-server notification stream ended before context compaction completed"
        )
    };
    timeout(deadline, collect).await.with_context(|| {
        format!(
            "context compaction timed out after {}s",
            max_runtime_seconds.max(1)
        )
    })?
}

fn turn_start_params(
    thread_id: &str,
    request: &AgentRunnerRequest,
    approval_policy: &str,
) -> Value {
    let mut params = serde_json::Map::new();
    params.insert("threadId".to_string(), json!(thread_id));
    params.insert(
        "input".to_string(),
        Value::Array(codex_input_items(request)),
    );
    if let Some(turn_context) = request
        .turn_context
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        params.insert(
            "additionalContext".to_string(),
            json!({
                "ripple_turn_context": {
                    "value": turn_context,
                    "kind": "application"
                }
            }),
        );
    }
    params.insert("cwd".to_string(), json!(request.cwd));
    params.insert("approvalPolicy".to_string(), json!(approval_policy));
    if let Some(model) = &request.model {
        params.insert("model".to_string(), json!(model));
    }
    if let Some(effort) = &request.effort {
        params.insert("effort".to_string(), json!(effort));
    }
    if let Some(summary) = &request.summary {
        params.insert("summary".to_string(), json!(summary));
    }
    if let Some(output_schema) = &request.output_schema {
        params.insert("outputSchema".to_string(), output_schema.clone());
    }
    Value::Object(params)
}

fn persistent_thread(request: &AgentRunnerRequest) -> bool {
    request
        .metadata
        .get("codex_persistent_thread")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn thread_config_for_request(
    workspace_root: &Path,
    config: &AppConfig,
    request: &AgentRunnerRequest,
) -> Value {
    let mut thread_config = thread_permission_config(workspace_root, config);
    if let Some(object) = thread_config.as_object_mut() {
        if image_generation_enabled_for_request(request) {
            object.insert("features.image_generation".to_string(), json!(true));
        }
        let use_memories = memory_use_enabled_for_request(request);
        let generate_memories = memory_generate_enabled_for_request(request);
        object.insert(
            "features.memories".to_string(),
            json!(use_memories || generate_memories),
        );
        object.insert("memories.use_memories".to_string(), json!(use_memories));
        object.insert(
            "memories.generate_memories".to_string(),
            json!(generate_memories),
        );
        object.insert("memories.dedicated_tools".to_string(), json!(false));
        object.insert(
            "memories.disable_on_external_context".to_string(),
            json!(false),
        );
    }
    thread_config
}

fn add_base_instructions(params: &mut Value, request: &AgentRunnerRequest) {
    let Some(base_instructions) = request
        .base_instructions
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    if let Some(object) = params.as_object_mut() {
        object.insert(
            "baseInstructions".to_string(),
            json!(base_instructions.to_string()),
        );
    }
}

fn image_generation_enabled_for_request(request: &AgentRunnerRequest) -> bool {
    request
        .metadata
        .get("image_generation_enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn memory_use_enabled_for_request(request: &AgentRunnerRequest) -> bool {
    if memory_disabled_for_request(request) {
        return false;
    }
    request
        .metadata
        .get("memory_use_memories")
        .or_else(|| request.metadata.get("memory_use"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn memory_generate_enabled_for_request(request: &AgentRunnerRequest) -> bool {
    if memory_disabled_for_request(request) {
        return false;
    }
    request
        .metadata
        .get("memory_generate_memories")
        .or_else(|| request.metadata.get("memory_generate"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn memory_disabled_for_request(request: &AgentRunnerRequest) -> bool {
    request
        .metadata
        .get("memory_disabled")
        .or_else(|| request.metadata.get("temporary"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn pool_generation(config: &AppConfig) -> String {
    [
        config.codex.codex_executable.as_str(),
        &config.codex.app_server_args.join("\u{1f}"),
        config.codex.approval_policy.as_str(),
        config.codex.sandbox_type.as_str(),
        if config.codex.network_access {
            "network"
        } else {
            "no-network"
        },
    ]
    .join("\u{1e}")
}

fn codex_home_for_user(config: &AppConfig, user_id: &str) -> anyhow::Result<PathBuf> {
    validate_user_id(user_id).map_err(anyhow::Error::msg)?;
    Ok(config
        .sandbox
        .sandboxes_root
        .join(user_id)
        .join("codex-home"))
}

fn requires_service_codex_auth(config: &AppConfig) -> bool {
    let executable_name = Path::new(&config.codex.codex_executable)
        .file_name()
        .and_then(|name| name.to_str());
    executable_name == Some("codex")
        || config
            .codex
            .app_server_args
            .iter()
            .any(|arg| arg == "app-server")
}

fn inherit_env_allowlist(command: &mut Command, keys: &[&str]) {
    for key in keys {
        if let Some(value) = std::env::var_os(key) {
            if !value.is_empty() {
                command.env(*key, value);
            }
        }
    }
}

fn codex_input_items(request: &AgentRunnerRequest) -> Vec<Value> {
    let mut native = request
        .input_items
        .iter()
        .filter(|item| {
            item.get("type")
                .and_then(Value::as_str)
                .is_some_and(|item_type| CODEX_NATIVE_INPUT_TYPES.contains(&item_type))
        })
        .cloned()
        .collect::<Vec<_>>();
    let has_text = native
        .iter()
        .any(|item| item.get("type").and_then(Value::as_str) == Some("text"));
    if native.is_empty() || !has_text {
        native.push(json!({"type": "text", "text": request.prompt}));
    }
    native
}

fn notification_thread_id(message: &Value) -> Option<String> {
    let params = message.get("params")?;
    params
        .get("threadId")
        .or_else(|| params.get("thread_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            params
                .get("thread")
                .and_then(|thread| thread.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::config::{
        AppConfig, CodexConfig, CorsConfig, FeishuConfig, GogcliOAuthConfig, LoggingConfig,
        SandboxConfig, SecurityConfig, SkillsConfig,
    };

    #[test]
    fn codex_input_items_filters_native_skill_and_mention_items() {
        let request = AgentRunnerRequest {
            provider: "codex".to_string(),
            prompt: "fallback prompt".to_string(),
            base_instructions: None,
            turn_context: None,
            cwd: PathBuf::from("/tmp/ripple-test"),
            input_items: vec![
                json!({"type": "skill", "name": "google_workspace"}),
                json!({"type": "mention", "app": "canva"}),
                json!({"type": "text", "text": "hello"}),
                json!({"type": "image", "image": "data"}),
                json!({"type": "localImage", "path": "/tmp/a.png"}),
            ],
            model: None,
            effort: None,
            summary: None,
            output_schema: None,
            max_runtime_seconds: 60,
            user_id: Some("alice".to_string()),
            session_id: Some("session-1".to_string()),
            metadata: json!({}),
        };

        let items = codex_input_items(&request);
        let item_types = items
            .iter()
            .filter_map(|item| item.get("type").and_then(Value::as_str))
            .collect::<Vec<_>>();

        assert_eq!(item_types, vec!["text", "image", "localImage"]);
        assert!(!items
            .iter()
            .any(|item| item.get("type") == Some(&json!("skill"))));
        assert!(!items
            .iter()
            .any(|item| item.get("type") == Some(&json!("mention"))));
    }

    #[test]
    fn turn_start_params_keep_ripple_context_out_of_user_input() {
        let request = AgentRunnerRequest {
            provider: "codex".to_string(),
            prompt: "帮我检查 memory".to_string(),
            base_instructions: Some("Ripple guardrails".to_string()),
            turn_context: Some("## Connector Status\n- google_workspace: connected".to_string()),
            cwd: PathBuf::from("/tmp/ripple-test"),
            input_items: Vec::new(),
            model: None,
            effort: None,
            summary: None,
            output_schema: None,
            max_runtime_seconds: 60,
            user_id: Some("alice".to_string()),
            session_id: Some("session-1".to_string()),
            metadata: json!({}),
        };

        let params = turn_start_params("thread-1", &request, "never");

        assert_eq!(
            params.pointer("/input/0/text").and_then(Value::as_str),
            Some("帮我检查 memory")
        );
        assert_eq!(
            params
                .pointer("/additionalContext/ripple_turn_context/kind")
                .and_then(Value::as_str),
            Some("application")
        );
        assert_eq!(
            params
                .pointer("/additionalContext/ripple_turn_context/value")
                .and_then(Value::as_str),
            Some("## Connector Status\n- google_workspace: connected")
        );
    }

    #[test]
    fn app_server_args_append_native_hardening_overrides() {
        let args = hardened_app_server_args(&[
            "app-server".to_string(),
            "--listen".to_string(),
            "stdio://".to_string(),
            "-c".to_string(),
            "features.plugins=true".to_string(),
        ]);

        assert_eq!(
            &args[..5],
            [
                "app-server",
                "--listen",
                "stdio://",
                "-c",
                "features.plugins=true",
            ]
        );
        assert!(args.ends_with(&["-c".to_string(), "skills.bundled.enabled=false".to_string()]));
        assert!(args.contains(&"include_apps_instructions=false".to_string()));
        assert!(args.contains(&"features.apps=false".to_string()));
        assert!(args.contains(&"features.plugins=false".to_string()));
        assert!(args.contains(&"skills.include_instructions=false".to_string()));
    }

    #[test]
    fn image_generation_feature_follows_request_metadata() {
        let mut request = AgentRunnerRequest {
            provider: "codex".to_string(),
            prompt: "fallback prompt".to_string(),
            base_instructions: None,
            turn_context: None,
            cwd: PathBuf::from("/tmp/ripple-test"),
            input_items: Vec::new(),
            model: None,
            effort: None,
            summary: None,
            output_schema: None,
            max_runtime_seconds: 60,
            user_id: Some("alice".to_string()),
            session_id: Some("session-1".to_string()),
            metadata: json!({}),
        };

        assert!(!image_generation_enabled_for_request(&request));

        request.metadata = json!({"image_generation_enabled": true});

        assert!(image_generation_enabled_for_request(&request));
    }

    #[test]
    fn codex_home_for_user_uses_user_sandbox() {
        let config = test_config();

        let codex_home = codex_home_for_user(&config, "alice").expect("codex home");

        assert_eq!(
            codex_home,
            config.sandbox.sandboxes_root.join("alice/codex-home")
        );
        assert_ne!(codex_home, config.codex_home_path());
    }

    #[test]
    fn service_codex_auth_is_required_only_for_real_codex_launches() {
        let mut config = test_config();

        assert!(requires_service_codex_auth(&config));

        config.codex.codex_executable = "/tmp/fake-codex-app-server".to_string();
        config.codex.app_server_args.clear();

        assert!(!requires_service_codex_auth(&config));
    }

    #[test]
    fn thread_config_includes_conservative_memory_defaults() {
        let config = test_config();
        let workspace = config.sandbox.sandboxes_root.join("alice/workspace");
        let request = AgentRunnerRequest {
            provider: "codex".to_string(),
            prompt: "remember useful project context".to_string(),
            base_instructions: None,
            turn_context: None,
            cwd: workspace.clone(),
            input_items: Vec::new(),
            model: None,
            effort: None,
            summary: None,
            output_schema: None,
            max_runtime_seconds: 60,
            user_id: Some("alice".to_string()),
            session_id: Some("session-1".to_string()),
            metadata: json!({}),
        };

        let thread_config = thread_config_for_request(&workspace, &config, &request);

        assert_eq!(thread_config.get("features.memories"), Some(&json!(true)));
        assert_eq!(
            thread_config.get("memories.use_memories"),
            Some(&json!(true))
        );
        assert_eq!(
            thread_config.get("memories.generate_memories"),
            Some(&json!(true))
        );
        assert_eq!(
            thread_config.get("memories.dedicated_tools"),
            Some(&json!(false))
        );
        assert_eq!(
            thread_config.get("memories.disable_on_external_context"),
            Some(&json!(false))
        );
    }

    #[test]
    fn thread_config_can_disable_memory_from_request_metadata() {
        let config = test_config();
        let workspace = config.sandbox.sandboxes_root.join("alice/workspace");
        let request = AgentRunnerRequest {
            provider: "codex".to_string(),
            prompt: "temporary chat".to_string(),
            base_instructions: None,
            turn_context: None,
            cwd: workspace.clone(),
            input_items: Vec::new(),
            model: None,
            effort: None,
            summary: None,
            output_schema: None,
            max_runtime_seconds: 60,
            user_id: Some("alice".to_string()),
            session_id: Some("session-1".to_string()),
            metadata: json!({"memory_disabled": true}),
        };

        let thread_config = thread_config_for_request(&workspace, &config, &request);

        assert_eq!(thread_config.get("features.memories"), Some(&json!(false)));
        assert_eq!(
            thread_config.get("memories.use_memories"),
            Some(&json!(false))
        );
        assert_eq!(
            thread_config.get("memories.generate_memories"),
            Some(&json!(false))
        );
    }

    #[test]
    fn connector_credential_env_points_bilibili_cli_at_user_file() {
        let root =
            std::env::temp_dir().join(format!("ripple-app-server-env-{}", uuid::Uuid::new_v4()));
        let credentials_dir = root.join("credentials");
        std::fs::create_dir_all(&credentials_dir).expect("create credentials dir");
        let bilibili_file = credentials_dir.join("bilibili.json");
        std::fs::write(&bilibili_file, r#"{"sessdata":"secret"}"#)
            .expect("write bilibili credential");

        let env = connector_credential_env(&credentials_dir);

        assert_eq!(
            env,
            vec![(
                "BILIBILI_CREDENTIAL_FILE".to_string(),
                bilibili_file.into_os_string()
            )]
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn unsandboxed_process_server_requests_are_rejected() {
        assert!(is_unsupported_server_request(&json!({
            "id": 7,
            "method": "process/spawn",
            "params": {
                "command": ["bash", "-lc", "ps -ef"],
                "processHandle": "host-process",
                "cwd": "/"
            }
        })));
        assert!(is_unsupported_server_request(&json!({
            "id": 8,
            "method": "process/kill",
            "params": {"processHandle": "host-process"}
        })));
    }

    fn test_config() -> AppConfig {
        let root =
            std::env::temp_dir().join(format!("ripple-app-server-config-{}", uuid::Uuid::new_v4()));
        AppConfig {
            repo_root: root.clone(),
            host: "127.0.0.1".to_string(),
            port: 8810,
            api_keys: Vec::new(),
            security: SecurityConfig::default(),
            user_auth: crate::config::UserAuthConfig::default(),
            api_docs: crate::config::ApiDocsConfig::default(),
            cors: CorsConfig::default(),
            default_model: "codex-medium".to_string(),
            model_presets: BTreeMap::new(),
            logging: LoggingConfig {
                level: "debug".to_string(),
            },
            sandbox: SandboxConfig {
                sandboxes_root: root.join("sandboxes"),
                caches_root: root.join("cache"),
                idle_suspend_seconds: 1800,
                retention_seconds: 604_800,
                max_workspace_mb: 2048,
                tmpfs_size_mb: 512,
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
                app_server_args: vec![
                    "app-server".to_string(),
                    "--listen".to_string(),
                    "stdio://".to_string(),
                ],
                codex_home: Some(root.join(".ripple/codex-service-home")),
                approval_policy: "never".to_string(),
                sandbox_type: "workspace-write".to_string(),
                network_access: true,
                idle_timeout_seconds: 1800,
                max_runtime_seconds: 3600,
            },
            schedule_extraction_max_runtime_seconds: 120,
            schedule_poll_interval_seconds: 15,
            document_preview: crate::config::DocumentPreviewConfig {
                cache_root: root.join("cache/previews"),
                libreoffice_path: "soffice".to_string(),
                max_source_bytes: 64 * 1024 * 1024,
                conversion_timeout_seconds: 120,
            },
            skills: SkillsConfig {
                shared_dirs: vec!["skills/*".to_string()],
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
        }
    }
}

fn notification_turn_id(message: &Value) -> Option<String> {
    let params = message.get("params")?;
    params
        .get("turnId")
        .or_else(|| params.get("turn_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            params
                .get("turn")
                .and_then(|turn| turn.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

fn is_context_compaction_completed(message: &Value, thread_id: &str) -> bool {
    if !message_thread_matches(message, thread_id) {
        return false;
    }
    match message.get("method").and_then(Value::as_str) {
        Some("thread/compacted") => true,
        Some("item/completed") => {
            message.pointer("/params/item/type").and_then(Value::as_str)
                == Some("contextCompaction")
        }
        Some("turn/completed") => message
            .pointer("/params/turn/status")
            .and_then(Value::as_str)
            .map_or(true, |status| status == "completed"),
        _ => false,
    }
}

fn is_compaction_turn_failed(message: &Value, thread_id: &str) -> bool {
    message_thread_matches(message, thread_id)
        && message.get("method").and_then(Value::as_str) == Some("turn/completed")
        && message
            .pointer("/params/turn/status")
            .and_then(Value::as_str)
            == Some("failed")
}

fn message_thread_matches(message: &Value, thread_id: &str) -> bool {
    notification_thread_id(message).as_deref() == Some(thread_id)
}

fn parse_approval_request(
    message: &Value,
    job_id: &str,
    request: &AgentRunnerRequest,
) -> Option<Value> {
    let method = message.get("method")?.as_str()?;
    let action = match method {
        "item/commandExecution/requestApproval" => "command_execution",
        "item/fileChange/requestApproval" => "file_change",
        "item/permissions/requestApproval" => "permissions",
        "execCommandApproval" => "exec_command",
        "applyPatchApproval" => "apply_patch",
        _ => return None,
    };
    let request_id = message.get("id")?.clone();
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
    Some(json!({
        "source": "codex",
        "job_id": job_id,
        "user_id": request.user_id,
        "session_id": request.session_id,
        "thread_id": params.get("threadId").or_else(|| params.get("conversationId")).cloned().unwrap_or(Value::Null),
        "turn_id": params.get("turnId").cloned().unwrap_or(Value::Null),
        "request_id": request_id,
        "method": method,
        "action": action,
        "description": approval_description(action, &params),
        "metadata": params
    }))
}

fn approval_description(action: &str, params: &Value) -> String {
    if matches!(action, "command_execution" | "exec_command") {
        if let Some(command) = params.get("command") {
            if let Some(command) = command.as_str() {
                return command.to_string();
            }
            if let Some(parts) = command.as_array() {
                return parts
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ");
            }
        }
    }
    params
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or(action)
        .replace('_', " ")
}

fn is_unsupported_server_request(message: &Value) -> bool {
    message.get("id").is_some() && message.get("method").and_then(Value::as_str).is_some()
}

fn record_agent_message_phase(message: &Value, phases: &mut HashMap<String, Option<String>>) {
    let method = message.get("method").and_then(Value::as_str);
    if !matches!(method, Some("item/started") | Some("item/completed")) {
        return;
    }
    let Some(item) = message.pointer("/params/item") else {
        return;
    };
    if item.get("type").and_then(Value::as_str) != Some("agentMessage") {
        return;
    }
    if let Some(id) = item.get("id").and_then(Value::as_str) {
        phases.insert(
            id.to_string(),
            item.get("phase")
                .and_then(Value::as_str)
                .map(str::to_string),
        );
    }
}

fn completed_final_agent_message(message: &Value) -> Option<String> {
    if message.get("method").and_then(Value::as_str) != Some("item/completed") {
        return None;
    }
    let item = message.pointer("/params/item")?;
    if item.get("type").and_then(Value::as_str) != Some("agentMessage")
        || item.get("phase").and_then(Value::as_str) == Some("commentary")
    {
        return None;
    }
    item.get("text")
        .or_else(|| item.get("content"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn streamable_final_delta(
    message: &Value,
    phases: &HashMap<String, Option<String>>,
) -> Option<String> {
    if message.get("method").and_then(Value::as_str) != Some("item/agentMessage/delta") {
        return None;
    }
    let delta = message.pointer("/params/delta").and_then(Value::as_str)?;
    if let Some(item_id) = message
        .pointer("/params/itemId")
        .or_else(|| message.pointer("/params/item_id"))
        .and_then(Value::as_str)
    {
        if phases.get(item_id).and_then(|phase| phase.as_deref()) == Some("commentary") {
            return None;
        }
    }
    Some(delta.to_string())
}

fn is_turn_completed(message: &Value, thread_id: &str, turn_id: &str) -> bool {
    message.get("method").and_then(Value::as_str) == Some("turn/completed")
        && message.pointer("/params/threadId").and_then(Value::as_str) == Some(thread_id)
        && (message.pointer("/params/turnId").and_then(Value::as_str) == Some(turn_id)
            || message.pointer("/params/turn/id").and_then(Value::as_str) == Some(turn_id))
}

async fn append_event(
    events_file: &Path,
    sequence: &mut u64,
    job_id: &str,
    provider: &str,
    event_type: &str,
    message: Option<String>,
    data: Value,
) -> anyhow::Result<()> {
    *sequence += 1;
    if let Some(parent) = events_file.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let event = redact_value(&json!({
        "type": event_type,
        "job_id": job_id,
        "provider": provider,
        "sequence": *sequence,
        "message": message,
        "data": data,
        "created_at": now_iso()
    }));
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(events_file)
        .await?;
    file.write_all(serde_json::to_string(&event)?.as_bytes())
        .await?;
    file.write_all(b"\n").await?;
    Ok(())
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn tail(text: &str) -> String {
    if text.len() <= TAIL_CHARS {
        text.to_string()
    } else {
        text[text.len() - TAIL_CHARS..].to_string()
    }
}

trait IfEmptyThen {
    fn if_empty_then<F: FnOnce() -> String>(self, f: F) -> String;
}

impl IfEmptyThen for String {
    fn if_empty_then<F: FnOnce() -> String>(self, f: F) -> String {
        if self.is_empty() {
            f()
        } else {
            self
        }
    }
}

async fn read_json_string_field(path: &Path, field: &str) -> Option<String> {
    let value = serde_json::from_slice::<Value>(&tokio::fs::read(path).await.ok()?).ok()?;
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn connector_credential_env(credentials_dir: &Path) -> Vec<(String, std::ffi::OsString)> {
    let bilibili_file = credentials_dir.join("bilibili.json");
    if bilibili_file.is_file() {
        vec![(
            "BILIBILI_CREDENTIAL_FILE".to_string(),
            bilibili_file.into_os_string(),
        )]
    } else {
        Vec::new()
    }
}

fn hardened_app_server_args(configured: &[String]) -> Vec<String> {
    let mut args = configured.to_vec();
    for config_override in CODEX_NATIVE_HARDENING_CONFIG_OVERRIDES {
        args.push("-c".to_string());
        args.push((*config_override).to_string());
    }
    args
}

fn runtime_path(config: &AppConfig) -> Option<std::ffi::OsString> {
    let mut entries = Vec::new();
    entries.push(ripple_py_bin_dir(config));
    if let Some(uv_bin_dir) = &config.sandbox.uv_bin_dir {
        entries.push(uv_bin_dir.clone());
    }
    if let Some(node_dir) = &config.sandbox.node_dir {
        entries.push(node_dir.join("bin"));
    }
    if let Some(root) = &config.sandbox.lark_cli_install_root {
        entries.push(root.join("current/bin"));
    }
    if let Some(root) = &config.sandbox.notion_cli_install_root {
        entries.push(root.join("current/bin"));
    }
    if let Some(root) = &config.sandbox.gogcli_cli_install_root {
        entries.push(root.join("current/bin"));
    }
    for tool in &config.sandbox.cli_tools {
        for bin_dir in &tool.bin_dirs {
            entries.push(tool.install_root.join(bin_dir));
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        entries.extend(std::env::split_paths(&path));
    }
    if entries.is_empty() {
        return None;
    }
    std::env::join_paths(entries).ok()
}
