use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::fs::OpenOptions;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::timeout;

use crate::codex::approvals::{approval_response_for_action, CodexApproval};
use crate::codex::permissions::{thread_permission_config, RIPPLE_CODEX_PERMISSION_PROFILE};
use crate::config::AppConfig;

const TAIL_CHARS: usize = 64_000;
const CODEX_NATIVE_INPUT_TYPES: &[&str] = &["text", "image", "localImage", "skill", "mention"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRunnerRequest {
    pub provider: String,
    pub prompt: String,
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
        if let Some(codex_home) = &self.config.codex.codex_home {
            tokio::fs::create_dir_all(codex_home).await?;
        }

        let mut command = Command::new(&self.config.codex.codex_executable);
        command
            .args(&self.config.codex.app_server_args)
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
        if let Some(codex_home) = &self.config.codex.codex_home {
            command.env("CODEX_HOME", codex_home);
        }
        if let Some(uv_bin_dir) = &self.config.sandbox.uv_bin_dir {
            prepend_path(&mut command, uv_bin_dir);
        }
        if let Some(node_dir) = &self.config.sandbox.node_dir {
            prepend_path(&mut command, node_dir.join("bin"));
        }
        if let Some(root) = &self.config.sandbox.lark_cli_install_root {
            prepend_path(&mut command, root.join("current/bin"));
        }
        if let Some(root) = &self.config.sandbox.notion_cli_install_root {
            prepend_path(&mut command, root.join("current/bin"));
        }
        if let Some(root) = &self.config.sandbox.gogcli_cli_install_root {
            prepend_path(&mut command, root.join("current/bin"));
        }
        let uv_cache_dir = self.config.sandbox.caches_root.join("uv-cache");
        tokio::fs::create_dir_all(&uv_cache_dir).await?;
        command.env("UV_CACHE_DIR", uv_cache_dir);
        command.env("UV_LINK_MODE", "hardlink");
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

    async fn unregister_turn(&self, thread_id: &str, turn_id: &str) {
        self.routes
            .lock()
            .await
            .queues
            .remove(&(thread_id.to_string(), turn_id.to_string()));
    }

    async fn dispatch_notification(&self, message: Value) {
        let thread_id = notification_thread_id(&message);
        let turn_id = notification_turn_id(&message);
        let mut routes = self.routes.lock().await;
        if let (Some(thread_id), Some(turn_id)) = (thread_id.clone(), turn_id) {
            let key = (thread_id, turn_id);
            if let Some(queue) = routes.queues.get(&key) {
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
            tail.push_str(&line);
            tail.push('\n');
            if tail.len() > TAIL_CHARS {
                let keep_from = tail.len() - TAIL_CHARS;
                *tail = tail[keep_from..].to_string();
            }
        }
    }

    async fn stderr_tail(&self) -> String {
        self.stderr_tail.lock().await.clone()
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

#[derive(Clone)]
pub struct CodexAppServerProvider {
    config: Arc<AppConfig>,
    sessions: Arc<Mutex<HashMap<String, Arc<CodexAppServerSession>>>>,
    active_turns: Arc<Mutex<HashMap<String, ActiveTurn>>>,
    pending_approvals: Arc<Mutex<HashMap<String, Value>>>,
}

impl CodexAppServerProvider {
    pub fn new(config: Arc<AppConfig>) -> Self {
        Self {
            config,
            sessions: Arc::new(Mutex::new(HashMap::new())),
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
            self.active_turns.lock().await.remove(&job_id);
        }
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
        Ok(AgentRunnerResult {
            job_id,
            provider: request.provider,
            status,
            events_file,
            output_file: Some(output_file),
            exit_code: None,
            stdout_tail: tail(&output_text),
            stderr_tail: session.stderr_tail().await,
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
        let permission_config = thread_permission_config(&workspace_root, &self.config);
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
                if session.loaded_thread_ids.lock().await.contains(&thread_id) {
                    return Ok((thread_id, false));
                }
                let thread_result = session
                    .request(
                        "thread/resume",
                        json!({
                            "threadId": thread_id,
                            "cwd": request.cwd,
                            "approvalPolicy": self.config.codex.approval_policy,
                            "config": permission_config,
                            "permissions": RIPPLE_CODEX_PERMISSION_PROFILE
                        }),
                    )
                    .await?;
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

        let thread_result = session
            .request(
                "thread/start",
                json!({
                    "cwd": request.cwd,
                    "approvalPolicy": self.config.codex.approval_policy,
                    "ephemeral": !persistent_thread,
                    "serviceName": "ripple",
                    "config": permission_config,
                    "permissions": RIPPLE_CODEX_PERMISSION_PROFILE
                }),
            )
            .await?;
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
        let mut sessions = self.sessions.lock().await;
        let session = sessions
            .entry(user_key.clone())
            .or_insert_with(|| {
                CodexAppServerSession::new(user_key, self.config.clone(), workspace_root)
            })
            .clone();
        session.ensure_started().await?;
        Ok(session)
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

    pub async fn stop_user(&self, user_id: &str) -> usize {
        let session = self.sessions.lock().await.remove(user_id);
        let Some(session) = session else {
            return 0;
        };
        let mut removed = 0_usize;
        let removed_job_ids = {
            let mut active_turns = self.active_turns.lock().await;
            let job_ids = active_turns
                .iter()
                .filter_map(|(job_id, active)| {
                    Arc::ptr_eq(&active.session, &session).then(|| job_id.clone())
                })
                .collect::<Vec<_>>();
            for job_id in &job_ids {
                if active_turns.remove(job_id).is_some() {
                    removed += 1;
                }
            }
            job_ids
        };
        if !removed_job_ids.is_empty() {
            let mut approvals = self.pending_approvals.lock().await;
            for job_id in removed_job_ids {
                approvals.remove(&job_id);
            }
        }
        session.shutdown().await;
        removed
    }
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
    let event = json!({
        "type": event_type,
        "job_id": job_id,
        "provider": provider,
        "sequence": *sequence,
        "message": message,
        "data": data,
        "created_at": now_iso()
    });
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

fn prepend_path(command: &mut Command, entry: impl AsRef<Path>) {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let mut entries = vec![entry.as_ref().to_path_buf()];
    entries.extend(std::env::split_paths(&existing));
    if let Ok(joined) = std::env::join_paths(entries) {
        command.env("PATH", joined);
    }
}
