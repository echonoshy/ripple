use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use anyhow::Context;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex, Notify};
use tokio::time::timeout;

mod event_log;
mod pool;
mod protocol;
mod runtime_env;
mod types;

use crate::api::tasks::persist_task_update;
use crate::codex::approvals::{approval_response_for_action, CodexApproval};
use crate::codex::permissions::{
    thread_permission_config_for_user, RIPPLE_CODEX_PERMISSION_PROFILE,
};
use crate::config::AppConfig;
use crate::python_env::ensure_ripple_py_wrapper;
use crate::redaction::redact_text;
use crate::sandbox::SandboxManager;
use crate::storage::Storage;
use event_log::append_event;
use pool::{pool_generation, PoolKey, PoolState, PoolWorker, IDLE_REAPER_INTERVAL_SECONDS};
use protocol::{
    completed_final_agent_message, is_compaction_turn_failed, is_context_compaction_completed,
    is_turn_completed, is_unsupported_server_request, notification_thread_id, notification_turn_id,
    parse_approval_request, record_agent_message_phase, streamable_final_delta,
};
use runtime_env::{
    codex_home_for_user, codex_runtime_home_for_user, codex_sqlite_home_for_user,
    connector_credential_env, hardened_app_server_args, inherit_env_allowlist, node_runtime_paths,
    read_json_string_field, requires_service_codex_auth, runtime_path, INHERITED_NETWORK_ENV,
};
pub use types::{AgentRunnerRequest, AgentRunnerResult, AgentRunnerStatus};

const TAIL_CHARS: usize = 64_000;
const CODEX_NATIVE_INPUT_TYPES: &[&str] = &["text", "image", "localImage"];
const THREAD_NOTIFICATION_QUEUE: &str = "__thread__";

#[derive(Debug, Clone, PartialEq, Eq)]
struct ServiceAuthFingerprint {
    len: u64,
    modified: Option<SystemTime>,
    content_hash: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ServiceAuthRefreshOutcome {
    Refreshed,
    SkippedAlreadyUpdated,
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
        let runtime_home = codex_runtime_home_for_user(&self.config, &self.user_key)?;
        let sqlite_home = codex_sqlite_home_for_user(&self.config, &self.user_key)?;
        tokio::fs::create_dir_all(&codex_home).await?;
        tokio::fs::create_dir_all(&runtime_home).await?;
        tokio::fs::create_dir_all(&sqlite_home).await?;
        let node_runtime = node_runtime_paths(&runtime_home);

        let mut command = Command::new(&self.config.codex.codex_executable);
        command.kill_on_drop(true);
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
        let extra_path_entries = if self.config.sandbox.node_dir.is_some() {
            vec![node_runtime.bin.clone()]
        } else {
            Vec::new()
        };
        if let Some(path) = runtime_path(&self.config, &extra_path_entries) {
            command.env("PATH", path);
        }
        command.env("CODEX_HOME", &codex_home);
        command.env("CODEX_SQLITE_HOME", &sqlite_home);
        tokio::fs::create_dir_all(&self.config.sandbox.python_env_uv_cache).await?;
        command.env("UV_CACHE_DIR", &self.config.sandbox.python_env_uv_cache);
        command.env("UV_LINK_MODE", "copy");
        if let Some(url) = &self.config.sandbox.pypi_mirror_url {
            command.env("UV_INDEX_URL", url);
            command.env("PIP_INDEX_URL", url);
        }
        if self.config.sandbox.node_dir.is_some() {
            let pnpm_store = self.config.sandbox.caches_root.join("pnpm-store");
            let corepack_home = self.config.sandbox.caches_root.join("corepack-cache");
            let npm_cache = self.config.sandbox.caches_root.join("npm-cache");
            let yarn_cache = self.config.sandbox.caches_root.join("yarn-cache");
            tokio::fs::create_dir_all(&pnpm_store).await?;
            tokio::fs::create_dir_all(&corepack_home).await?;
            tokio::fs::create_dir_all(&npm_cache).await?;
            tokio::fs::create_dir_all(&yarn_cache).await?;
            tokio::fs::create_dir_all(&node_runtime.bin).await?;
            tokio::fs::create_dir_all(&node_runtime.prefix).await?;
            tokio::fs::create_dir_all(&node_runtime.tmp).await?;
            tokio::fs::create_dir_all(&node_runtime.compile_cache).await?;
            command.env("PNPM_HOME", &node_runtime.bin);
            command.env("NPM_CONFIG_PREFIX", &node_runtime.prefix);
            command.env("NPM_CONFIG_CACHE", npm_cache);
            command.env(
                "npm_config_cache",
                self.config.sandbox.caches_root.join("npm-cache"),
            );
            command.env("NPM_CONFIG_TMP", &node_runtime.tmp);
            command.env("NODE_COMPILE_CACHE", &node_runtime.compile_cache);
            command.env("YARN_CACHE_FOLDER", yarn_cache);
            command.env("PNPM_STORE_DIR", &pnpm_store);
            command.env("COREPACK_HOME", &corepack_home);
            command.env("RIPPLE_NODE_PREFIX", &node_runtime.prefix);
            command.env(
                "RIPPLE_NODE_MODULES",
                node_runtime.prefix.join("node_modules"),
            );
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

#[derive(Clone)]
pub struct CodexAppServerProvider {
    config: Arc<AppConfig>,
    storage: Storage,
    pools: Arc<Mutex<PoolState>>,
    pool_notify: Arc<Notify>,
    next_worker_id: Arc<AtomicU64>,
    reaper_started: Arc<AtomicBool>,
    service_auth_refresh_lock: Arc<Mutex<()>>,
    active_turns: Arc<Mutex<HashMap<String, ActiveTurn>>>,
    pending_approvals: Arc<Mutex<HashMap<String, Value>>>,
    pending_user_inputs: Arc<Mutex<HashMap<String, Value>>>,
}

impl CodexAppServerProvider {
    pub fn new(config: Arc<AppConfig>, storage: Storage) -> Self {
        Self {
            config,
            storage,
            pools: Arc::new(Mutex::new(PoolState::default())),
            pool_notify: Arc::new(Notify::new()),
            next_worker_id: Arc::new(AtomicU64::new(1)),
            reaper_started: Arc::new(AtomicBool::new(false)),
            service_auth_refresh_lock: Arc::new(Mutex::new(())),
            active_turns: Arc::new(Mutex::new(HashMap::new())),
            pending_approvals: Arc::new(Mutex::new(HashMap::new())),
            pending_user_inputs: Arc::new(Mutex::new(HashMap::new())),
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

        let mut turn_rx = None;
        let mut session = self.session_for_request(&request).await?;
        let mut stderr_start = session.stderr_tail_len().await;
        let mut service_auth_refresh_attempted = false;
        let (status, mut error) = loop {
            match self
                .run_turn(&request, &job_id, &events_file, &mut sequence, &session)
                .await
            {
                Ok((ids, rx, text, resumed)) => {
                    thread_id = Some(ids.0);
                    turn_id = Some(ids.1);
                    turn_rx = Some(rx);
                    output_text = text;
                    thread_resumed = resumed;
                    break (AgentRunnerStatus::Completed, None);
                }
                Err(err) => {
                    let stderr_tail = session.stderr_tail_since(stderr_start).await;
                    let combined_error = format!("{err}\n{stderr_tail}");
                    if !service_auth_refresh_attempted
                        && codex_error_needs_service_auth_refresh(&combined_error)
                    {
                        service_auth_refresh_attempted = true;
                        let observed_auth = service_auth_fingerprint(&self.config).await;
                        append_event(
                            &events_file,
                            &mut sequence,
                            &job_id,
                            &request.provider,
                            "codex.service_auth_refresh.started",
                            Some("Codex auth failed; refreshing service auth".to_string()),
                            json!({}),
                        )
                        .await?;
                        self.clear_job_transient_state(&job_id).await;
                        self.discard_job_worker(&job_id).await;
                        match self
                            .refresh_service_codex_auth(&request, observed_auth)
                            .await
                        {
                            Ok(outcome) => {
                                let discarded_idle_workers =
                                    self.discard_idle_workers_after_service_auth_refresh().await;
                                append_event(
                                    &events_file,
                                    &mut sequence,
                                    &job_id,
                                    &request.provider,
                                    "codex.service_auth_refresh.completed",
                                    None,
                                    json!({
                                        "outcome": service_auth_refresh_outcome_name(outcome),
                                        "discarded_idle_workers": discarded_idle_workers
                                    }),
                                )
                                .await?;
                                session = self.session_for_request(&request).await?;
                                stderr_start = session.stderr_tail_len().await;
                                continue;
                            }
                            Err(refresh_err) => {
                                append_event(
                                    &events_file,
                                    &mut sequence,
                                    &job_id,
                                    &request.provider,
                                    "codex.service_auth_refresh.failed",
                                    Some("Codex service auth refresh failed".to_string()),
                                    json!({
                                        "error": refresh_err.to_string()
                                    }),
                                )
                                .await?;
                                break (
                                    AgentRunnerStatus::Failed,
                                    Some(format!(
                                        "Codex service auth refresh failed; re-login the service CODEX_HOME: {refresh_err}"
                                    )),
                                );
                            }
                        }
                    }
                    break (AgentRunnerStatus::Failed, Some(err.to_string()));
                }
            }
        };

        if let (Some(thread_id), Some(turn_id)) = (thread_id.as_deref(), turn_id.as_deref()) {
            session.unregister_turn(thread_id, turn_id).await;
        }
        self.active_turns.lock().await.remove(&job_id);
        self.pending_approvals.lock().await.remove(&job_id);
        self.pending_user_inputs.lock().await.remove(&job_id);
        drop(turn_rx);

        let stderr_tail = redact_text(&session.stderr_tail_since(stderr_start).await);
        let service_auth_failed = matches!(status, AgentRunnerStatus::Failed)
            && codex_error_needs_service_auth_refresh(&format!(
                "{}\n{}",
                error.as_deref().unwrap_or(""),
                stderr_tail
            ));
        if service_auth_failed {
            error = Some(service_codex_auth_relogin_message(&self.config));
        }

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
        if service_auth_failed {
            self.discard_job_worker(&job_id).await;
        } else {
            self.release_job_session(&job_id).await;
        }
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
                if self
                    .handle_dynamic_tool_call_request(request, session, &message)
                    .await?
                {
                    continue;
                }
                if self
                    .handle_user_input_request(request, job_id, session, &message)
                    .await?
                {
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

    async fn handle_dynamic_tool_call_request(
        &self,
        request: &AgentRunnerRequest,
        session: &Arc<CodexAppServerSession>,
        message: &Value,
    ) -> anyhow::Result<bool> {
        if message.get("method").and_then(Value::as_str) != Some("item/tool/call") {
            return Ok(false);
        }
        let request_id = message.get("id").cloned().unwrap_or(Value::Null);
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
        let namespace = params
            .get("namespace")
            .and_then(Value::as_str)
            .unwrap_or("");
        let tool = params.get("tool").and_then(Value::as_str).unwrap_or("");
        let arguments = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let (success, text) = if namespace == "codex_app" && tool == "task_update" {
            let user_id = request.user_id.as_deref().unwrap_or("default");
            if request.session_id.is_none() {
                (false, "task_update requires a Ripple session".to_string())
            } else {
                match persist_task_update(
                    &self.storage,
                    user_id,
                    request.session_id.as_deref(),
                    &arguments,
                )
                .await
                {
                    Ok(output) => (
                        true,
                        serde_json::to_string(&output)
                            .unwrap_or_else(|_| "{\"ok\":true}".to_string()),
                    ),
                    Err(err) => (false, format!("{err:?}")),
                }
            }
        } else {
            (
                false,
                format!("unsupported dynamic tool {namespace}.{tool}"),
            )
        };
        session
            .respond(
                request_id,
                json!({
                    "contentItems": [
                        {
                            "type": "inputText",
                            "text": text
                        }
                    ],
                    "success": success
                }),
            )
            .await?;
        Ok(true)
    }

    async fn handle_user_input_request(
        &self,
        request: &AgentRunnerRequest,
        job_id: &str,
        session: &Arc<CodexAppServerSession>,
        message: &Value,
    ) -> anyhow::Result<bool> {
        if message.get("method").and_then(Value::as_str) != Some("item/tool/requestUserInput") {
            return Ok(false);
        }
        let request_id = message.get("id").cloned().unwrap_or(Value::Null);
        if request.session_id.is_none() {
            session
                .respond(
                    request_id,
                    json!({
                        "answers": {}
                    }),
                )
                .await?;
            return Ok(true);
        }
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
        self.pending_user_inputs.lock().await.insert(
            job_id.to_string(),
            json!({
                "type": "codex_user_input",
                "job_id": job_id,
                "session_id": request.session_id,
                "request_id": request_id,
                "thread_id": params.get("threadId").or_else(|| params.get("thread_id")).cloned().unwrap_or(Value::Null),
                "turn_id": params.get("turnId").or_else(|| params.get("turn_id")).cloned().unwrap_or(Value::Null),
                "item_id": params.get("itemId").or_else(|| params.get("item_id")).cloned().unwrap_or(Value::Null),
                "questions": params.get("questions").cloned().unwrap_or_else(|| json!([])),
                "auto_resolution_ms": params.get("autoResolutionMs").cloned().unwrap_or(Value::Null)
            }),
        );
        Ok(true)
    }

    pub async fn pending_user_input(&self, job_id: &str) -> Option<Value> {
        self.pending_user_inputs.lock().await.get(job_id).cloned()
    }

    pub async fn resolve_user_input(
        &self,
        job_id: &str,
        request_id: &Value,
        answers: Value,
    ) -> bool {
        let active = self.active_turns.lock().await.get(job_id).cloned();
        let Some(active) = active else {
            return false;
        };
        let pending = self.pending_user_inputs.lock().await.get(job_id).cloned();
        let Some(pending) = pending else {
            return false;
        };
        if pending.get("request_id") != Some(request_id) {
            return false;
        }
        if active
            .session
            .respond(request_id.clone(), json!({ "answers": answers }))
            .await
            .is_err()
        {
            return false;
        }
        self.pending_user_inputs.lock().await.remove(job_id);
        true
    }

    pub async fn archive_thread(
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
                .request("thread/archive", json!({ "threadId": thread_id }))
                .await
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
    ) -> anyhow::Result<Value> {
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
                .await
        }
        .await;
        session.shutdown().await;
        result
    }

    pub async fn fork_thread(
        &self,
        user_id: String,
        workspace_root: PathBuf,
        cwd: PathBuf,
        thread_id: String,
        model: String,
        memory_disabled: bool,
    ) -> anyhow::Result<Value> {
        let request_user_id = user_id.clone();
        let session =
            CodexAppServerSession::new(user_id, self.config.clone(), workspace_root.clone());
        let result = async {
            session.ensure_started().await?;
            session.ensure_initialized().await?;
            let request = AgentRunnerRequest {
                provider: "codex".to_string(),
                prompt: "fork session".to_string(),
                base_instructions: None,
                turn_context: None,
                client_context: None,
                cwd,
                input_items: Vec::new(),
                model: Some(model.clone()),
                effort: None,
                summary: None,
                output_schema: None,
                max_runtime_seconds: self.config.codex.max_runtime_seconds,
                user_id: Some(request_user_id),
                session_id: None,
                metadata: json!({
                    "codex_persistent_thread": true,
                    "memory_disabled": memory_disabled
                }),
            };
            let permission_config =
                thread_config_for_request(&workspace_root, &self.config, &request);
            session
                .request(
                    "thread/fork",
                    thread_fork_params(
                        &thread_id,
                        &request,
                        &self.config.codex.approval_policy,
                        &permission_config,
                        &model,
                    ),
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
    ) -> anyhow::Result<Value> {
        let session = CodexAppServerSession::new(user_id, self.config.clone(), workspace_root);
        let result = async {
            session.ensure_started().await?;
            session.ensure_initialized().await?;
            session.request("memory/reset", json!({})).await
        }
        .await;
        session.shutdown().await;
        result
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
                add_task_dynamic_tools(&mut resume_params, request);
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
        add_task_dynamic_tools(&mut start_params, request);
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
                    if pool_size >= self.config.codex.max_workers_per_pool
                        || total_workers >= self.config.codex.max_total_pool_workers
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

    async fn clear_job_transient_state(&self, job_id: &str) {
        self.active_turns.lock().await.remove(job_id);
        self.pending_approvals.lock().await.remove(job_id);
        self.pending_user_inputs.lock().await.remove(job_id);
    }

    async fn refresh_service_codex_auth(
        &self,
        request: &AgentRunnerRequest,
        observed_auth: Option<ServiceAuthFingerprint>,
    ) -> anyhow::Result<ServiceAuthRefreshOutcome> {
        refresh_service_auth_if_still_current(
            &self.config,
            &self.service_auth_refresh_lock,
            observed_auth,
            || {
                let config = self.config.clone();
                let user_id = request
                    .user_id
                    .clone()
                    .unwrap_or_else(|| "default".to_string());
                let workspace_root = request
                    .metadata
                    .get("workspace_root")
                    .and_then(Value::as_str)
                    .map(PathBuf::from)
                    .unwrap_or_else(|| request.cwd.clone());
                async move {
                    let session = CodexAppServerSession::new(user_id, config, workspace_root);
                    let result = async {
                        session.ensure_initialized().await?;
                        session
                            .request("account/read", json!({ "refreshToken": true }))
                            .await?;
                        Ok(())
                    }
                    .await;
                    session.shutdown().await;
                    result
                }
            },
        )
        .await
    }

    async fn discard_idle_workers_after_service_auth_refresh(&self) -> usize {
        let sessions = {
            let mut state = self.pools.lock().await;
            let mut sessions = Vec::new();
            let keys = state.pools.keys().cloned().collect::<Vec<_>>();
            for key in keys {
                if let Some(workers) = state.pools.get_mut(&key) {
                    let mut index = 0;
                    while index < workers.len() {
                        if workers[index].active_job_id.is_none() {
                            sessions.push(workers.remove(index).session);
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
            sessions
        };
        let count = sessions.len();
        for session in sessions {
            session.shutdown().await;
        }
        if count > 0 {
            self.pool_notify.notify_waiters();
        }
        count
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
        self.pending_user_inputs.lock().await.remove(job_id);
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

    pub async fn runtime_info(
        &self,
        user_id: String,
        workspace_root: PathBuf,
    ) -> anyhow::Result<Value> {
        let session = CodexAppServerSession::new(user_id, self.config.clone(), workspace_root);
        let result = async {
            session.ensure_started().await?;
            session.ensure_initialized().await?;
            let models = session
                .request(
                    "model/list",
                    json!({
                        "limit": 100,
                        "includeHidden": true
                    }),
                )
                .await?;
            let model_provider_capabilities = session
                .request("modelProvider/capabilities/read", json!({}))
                .await
                .ok();
            let rate_limits = session
                .request("account/rateLimits/read", json!({}))
                .await
                .ok();
            let usage = session.request("account/usage/read", json!({})).await.ok();
            let config_requirements = session
                .request("configRequirements/read", json!({}))
                .await
                .ok();
            Ok(json!({
                "available": true,
                "models": models,
                "model_provider_capabilities": model_provider_capabilities,
                "rate_limits": rate_limits,
                "usage": usage,
                "config_requirements": config_requirements
            }))
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
        let permission_config =
            thread_permission_config_for_user(&session.user_key, &session.cwd, &self.config);
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
            let mut user_inputs = self.pending_user_inputs.lock().await;
            for job_id in active_job_ids {
                approvals.remove(&job_id);
                user_inputs.remove(&job_id);
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
        self.pending_user_inputs.lock().await.remove(job_id);
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

async fn service_auth_fingerprint(config: &AppConfig) -> Option<ServiceAuthFingerprint> {
    let auth_path = config.codex_home_path().join("auth.json");
    let bytes = tokio::fs::read(&auth_path).await.ok()?;
    let metadata = tokio::fs::metadata(&auth_path).await.ok();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    Some(ServiceAuthFingerprint {
        len: bytes.len() as u64,
        modified: metadata.and_then(|metadata| metadata.modified().ok()),
        content_hash: hasher.finish(),
    })
}

async fn refresh_service_auth_if_still_current<F, Fut>(
    config: &AppConfig,
    lock: &Mutex<()>,
    observed_auth: Option<ServiceAuthFingerprint>,
    refresh: F,
) -> anyhow::Result<ServiceAuthRefreshOutcome>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
{
    let _guard = lock.lock().await;
    if service_auth_fingerprint(config).await != observed_auth {
        return Ok(ServiceAuthRefreshOutcome::SkippedAlreadyUpdated);
    }
    refresh().await?;
    Ok(ServiceAuthRefreshOutcome::Refreshed)
}

fn service_auth_refresh_outcome_name(outcome: ServiceAuthRefreshOutcome) -> &'static str {
    match outcome {
        ServiceAuthRefreshOutcome::Refreshed => "refreshed",
        ServiceAuthRefreshOutcome::SkippedAlreadyUpdated => "skipped_already_updated",
    }
}

fn codex_error_needs_service_auth_refresh(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [
        "401 unauthorized",
        "token_expired",
        "provided authentication token is expired",
        "failed to refresh token",
        "access token could not be refreshed",
        "refresh token was already used",
        "refresh token was revoked",
        "refresh_token_reused",
        "refresh_token_invalidated",
        "auth_recovery_phase=\"refresh_token\"",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

fn service_codex_auth_relogin_message(config: &AppConfig) -> String {
    format!(
        "Service Codex auth has expired or was reused. Re-login the service CODEX_HOME with: CODEX_HOME={} codex login --device-auth",
        config.codex_home_path().display()
    )
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
    let mut additional_context = serde_json::Map::new();
    if let Some(turn_context) = request
        .turn_context
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        additional_context.insert(
            "ripple_turn_context".to_string(),
            json!({
                "value": turn_context,
                "kind": "application"
            }),
        );
    }
    if let Some(client_context) = request
        .client_context
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        additional_context.insert(
            "ripple_client_context".to_string(),
            json!({
                "value": client_context,
                "kind": "application"
            }),
        );
    }
    if !additional_context.is_empty() {
        params.insert(
            "additionalContext".to_string(),
            Value::Object(additional_context),
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

fn thread_fork_params(
    thread_id: &str,
    request: &AgentRunnerRequest,
    approval_policy: &str,
    permission_config: &Value,
    model: &str,
) -> Value {
    let mut params = json!({
        "threadId": thread_id,
        "cwd": request.cwd,
        "approvalPolicy": approval_policy,
        "config": permission_config,
        "permissions": RIPPLE_CODEX_PERMISSION_PROFILE,
        "excludeTurns": true,
        "ephemeral": false
    });
    if !model.trim().is_empty() {
        params["model"] = json!(model.trim());
    }
    add_base_instructions(&mut params, request);
    add_task_dynamic_tools(&mut params, request);
    params
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
    let user_id = request.user_id.as_deref().unwrap_or("default");
    let mut thread_config = thread_permission_config_for_user(user_id, workspace_root, config);
    if let Some(object) = thread_config.as_object_mut() {
        if image_generation_enabled_for_request(request) {
            object.insert("features.image_generation".to_string(), json!(true));
        }
        let use_memories = memory_use_enabled_for_request(config, request);
        let generate_memories = memory_generate_enabled_for_request(config, request);
        object.insert(
            "features.memories".to_string(),
            json!(use_memories || generate_memories),
        );
        object.insert("memories.use_memories".to_string(), json!(use_memories));
        object.insert(
            "memories.generate_memories".to_string(),
            json!(generate_memories),
        );
        object.insert(
            "memories.dedicated_tools".to_string(),
            json!(config.codex.memory.dedicated_tools),
        );
        object.insert(
            "memories.disable_on_external_context".to_string(),
            json!(config.codex.memory.disable_on_external_context),
        );
    }
    thread_config
}

fn request_disables_memory(request: &AgentRunnerRequest) -> bool {
    request
        .metadata
        .get("memory_disabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || request
            .metadata
            .get("temporary")
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

fn memory_use_enabled_for_request(config: &AppConfig, request: &AgentRunnerRequest) -> bool {
    config.codex.memory.enabled
        && config.codex.memory.use_memories
        && !request_disables_memory(request)
        && request
            .metadata
            .get("memory_use_memories")
            .and_then(Value::as_bool)
            .unwrap_or(true)
}

fn memory_generate_enabled_for_request(config: &AppConfig, request: &AgentRunnerRequest) -> bool {
    config.codex.memory.enabled
        && config.codex.memory.generate_memories
        && !request_disables_memory(request)
        && request
            .metadata
            .get("memory_generate_memories")
            .and_then(Value::as_bool)
            .unwrap_or(true)
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

fn add_task_dynamic_tools(params: &mut Value, request: &AgentRunnerRequest) {
    if request.session_id.is_none() || request.metadata.get("chat_user_input").is_none() {
        return;
    }
    if let Some(object) = params.as_object_mut() {
        object.insert(
            "dynamicTools".to_string(),
            json!([
                {
                    "namespace": "codex_app",
                    "name": "task_update",
                    "description": "Create or propose durable Ripple tasks and task actions from the current conversation.",
                    "inputSchema": task_update_input_schema(),
                    "deferLoading": true
                }
            ]),
        );
    }
}

fn task_update_input_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "mode": {
                "type": "string",
                "enum": [
                    "propose",
                    "create",
                    "update_task",
                    "create_action",
                    "update_action",
                    "start_action",
                    "complete_action",
                    "block_action",
                    "wait_user",
                    "complete_task"
                ]
            },
            "target": {
                "type": "string",
                "enum": ["task"]
            },
            "task": {
                "type": "object",
                "additionalProperties": true
            },
            "actions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": true
                }
            },
            "task_id": {
                "type": "string"
            },
            "action_id": {
                "type": "string"
            },
            "result_summary": {
                "type": "string"
            },
            "reason": {
                "type": "string"
            },
            "updates": {
                "type": "object",
                "additionalProperties": true
            },
            "missing_fields": {
                "type": "array",
                "items": {
                    "type": "string"
                }
            },
            "clarification_question": {
                "type": "string"
            }
        },
        "required": ["mode", "target"],
        "additionalProperties": true
    })
}

fn image_generation_enabled_for_request(request: &AgentRunnerRequest) -> bool {
    request
        .metadata
        .get("image_generation_enabled")
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
            client_context: None,
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
            turn_context: Some(
                "## Connector Status\n\
- google_workspace: connected\n\n\
## Available Skills\n\
(none)"
                    .to_string(),
            ),
            client_context: None,
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
        assert!(!params
            .pointer("/input/0/text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .contains("Connector Status"));
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
            Some(
                "## Connector Status\n\
- google_workspace: connected\n\n\
## Available Skills\n\
(none)"
            )
        );
    }

    #[test]
    fn turn_start_params_send_client_context_as_separate_additional_context() {
        let request = AgentRunnerRequest {
            provider: "codex".to_string(),
            prompt: "现在耳机电量是多少？".to_string(),
            base_instructions: None,
            turn_context: Some("## Required Skills\nlong skill manifest".to_string()),
            client_context: Some(
                "Client-provided state:\n- left_battery_percent: 80\n- right_battery_percent: 78\n- case_battery_percent: 55"
                    .to_string(),
            ),
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
            params
                .pointer("/additionalContext/ripple_turn_context/value")
                .and_then(Value::as_str),
            Some("## Required Skills\nlong skill manifest")
        );
        let client_context = params
            .pointer("/additionalContext/ripple_client_context/value")
            .and_then(Value::as_str)
            .expect("client context additionalContext");
        assert!(client_context.contains("left_battery_percent: 80"));
        assert!(client_context.contains("case_battery_percent: 55"));
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
            client_context: None,
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
    fn task_dynamic_tools_use_codex_legacy_flat_shape() {
        let request = AgentRunnerRequest {
            provider: "codex".to_string(),
            prompt: "5分钟后提醒我准备材料".to_string(),
            base_instructions: None,
            turn_context: None,
            client_context: None,
            cwd: PathBuf::from("/tmp/ripple-test"),
            input_items: Vec::new(),
            model: None,
            effort: None,
            summary: None,
            output_schema: None,
            max_runtime_seconds: 60,
            user_id: Some("alice".to_string()),
            session_id: Some("session-1".to_string()),
            metadata: json!({"chat_user_input": "5分钟后提醒我准备材料"}),
        };
        let mut params = json!({});

        add_task_dynamic_tools(&mut params, &request);

        let tools = params
            .get("dynamicTools")
            .and_then(Value::as_array)
            .expect("dynamic task tools");
        assert_eq!(tools.len(), 1);
        let tool = &tools[0];
        assert_eq!(
            tool.get("namespace").and_then(Value::as_str),
            Some("codex_app")
        );
        assert_eq!(
            tool.get("name").and_then(Value::as_str),
            Some("task_update")
        );
        assert!(tool.get("inputSchema").is_some());
        let schema = tool.get("inputSchema").expect("input schema");
        assert!(schema.pointer("/properties/missing_fields").is_some());
        assert!(schema
            .pointer("/properties/clarification_question")
            .is_some());
        assert!(tool.get("tools").is_none());
        assert!(tool.get("type").is_none());
    }

    #[test]
    fn thread_fork_params_use_ripple_permissions_and_exclude_turns() {
        let request = AgentRunnerRequest {
            provider: "codex".to_string(),
            prompt: "fork".to_string(),
            base_instructions: Some("base".to_string()),
            turn_context: None,
            client_context: None,
            cwd: PathBuf::from("/tmp/ripple-test/folder"),
            input_items: Vec::new(),
            model: Some("gpt-5".to_string()),
            effort: None,
            summary: None,
            output_schema: None,
            max_runtime_seconds: 60,
            user_id: Some("alice".to_string()),
            session_id: Some("session-1".to_string()),
            metadata: json!({}),
        };
        let permission_config = json!({"sandbox": {"permissions": "managed"}});

        let params =
            thread_fork_params("thr_parent", &request, "never", &permission_config, "gpt-5");

        assert_eq!(
            params.get("threadId").and_then(Value::as_str),
            Some("thr_parent")
        );
        assert_eq!(
            params.get("cwd").and_then(Value::as_str),
            Some("/tmp/ripple-test/folder")
        );
        assert_eq!(
            params.get("permissions").and_then(Value::as_str),
            Some(RIPPLE_CODEX_PERMISSION_PROFILE)
        );
        assert_eq!(
            params.get("approvalPolicy").and_then(Value::as_str),
            Some("never")
        );
        assert_eq!(
            params.get("excludeTurns").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            params.get("ephemeral").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(params.get("config"), Some(&permission_config));
        assert_eq!(params.get("model").and_then(Value::as_str), Some("gpt-5"));
        assert_eq!(
            params.get("baseInstructions").and_then(Value::as_str),
            Some("base")
        );
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
    fn codex_sqlite_home_for_user_uses_service_runtime_root() {
        let config = test_config();

        let sqlite_home = codex_sqlite_home_for_user(&config, "alice").expect("sqlite home");

        assert_eq!(
            sqlite_home,
            config
                .codex_home_path()
                .parent()
                .unwrap()
                .join("codex-runtime/users/alice/sqlite")
        );
        assert!(!sqlite_home.starts_with(&config.sandbox.sandboxes_root));
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
    fn codex_auth_failure_detection_matches_refresh_token_errors() {
        assert!(codex_error_needs_service_auth_refresh(
            r#"Turn error: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again."#
        ));
        assert!(codex_error_needs_service_auth_refresh(
            r#"failed to connect to websocket: HTTP error: 401 Unauthorized"#
        ));
        assert!(codex_error_needs_service_auth_refresh(
            r#"auth_recovery_phase="refresh_token" auth_recovery_outcome="recovery_failed_permanent""#
        ));
        assert!(!codex_error_needs_service_auth_refresh(
            "codex turn failed because context compaction timed out"
        ));
    }

    #[test]
    fn service_codex_auth_relogin_message_names_service_home() {
        let config = test_config();
        let message = service_codex_auth_relogin_message(&config);

        assert!(message.contains("Service Codex auth"));
        assert!(message.contains("codex login --device-auth"));
        assert!(message.contains(config.codex_home_path().to_string_lossy().as_ref()));
    }

    #[tokio::test]
    async fn service_auth_refresh_guard_skips_when_auth_file_changed() {
        let config = test_config();
        let auth_path = config.codex_home_path().join("auth.json");
        std::fs::create_dir_all(auth_path.parent().unwrap()).expect("create codex home");
        std::fs::write(&auth_path, r#"{"tokens":{"access_token":"old"}}"#).expect("write old auth");
        let observed = service_auth_fingerprint(&config).await;
        std::thread::sleep(std::time::Duration::from_millis(5));
        std::fs::write(&auth_path, r#"{"tokens":{"access_token":"new"}}"#).expect("write new auth");
        let refresh_count = Arc::new(AtomicU64::new(0));

        let outcome =
            refresh_service_auth_if_still_current(&config, &Mutex::new(()), observed, || {
                let refresh_count = refresh_count.clone();
                async move {
                    refresh_count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            })
            .await
            .expect("refresh guard");

        assert_eq!(outcome, ServiceAuthRefreshOutcome::SkippedAlreadyUpdated);
        assert_eq!(refresh_count.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn thread_config_enables_codex_memory_by_default() {
        let config = test_config();
        let workspace = config.sandbox.sandboxes_root.join("alice/workspace");
        let request = AgentRunnerRequest {
            provider: "codex".to_string(),
            prompt: "normal chat".to_string(),
            base_instructions: None,
            turn_context: None,
            client_context: None,
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
    fn thread_config_disables_codex_memory_when_session_disables_it() {
        let config = test_config();
        let workspace = config.sandbox.sandboxes_root.join("alice/workspace");
        let request = AgentRunnerRequest {
            provider: "codex".to_string(),
            prompt: "temporary chat".to_string(),
            base_instructions: None,
            turn_context: None,
            client_context: None,
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
                workspaces_root: None,
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
                max_workers_per_pool: 8,
                max_total_pool_workers: 256,
                memory: crate::config::CodexMemoryConfig::default(),
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
