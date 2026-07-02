use std::collections::HashMap;
use std::sync::Arc;

use crate::config::AppConfig;
use crate::connector_runtime::ConnectorRuntime;
use crate::jobs::JobManager;
use crate::sandbox::SandboxManager;
use crate::sessions::SessionManager;
use crate::storage::Storage;
use crate::workspace_changes::WorkspaceChangeTracker;
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<AppConfig>,
    pub sandboxes: SandboxManager,
    pub sessions: SessionManager,
    pub jobs: JobManager,
    pub storage: Storage,
    pub connector_runtime: ConnectorRuntime,
    pub workspace_changes: WorkspaceChangeTracker,
    workspace_write_locks: Arc<std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}

impl AppState {
    pub fn new(config: AppConfig) -> Self {
        let config = Arc::new(config);
        let sandboxes = SandboxManager::new(config.clone());
        let storage = Storage::new(config.clone()).expect("failed to initialize Ripple storage");
        let jobs = JobManager::new_with_storage(config.clone(), storage.clone());
        let sessions =
            SessionManager::new_with_storage(config.clone(), sandboxes.clone(), storage.clone());
        let connector_runtime = ConnectorRuntime::default();
        Self {
            config,
            sandboxes,
            sessions,
            jobs,
            storage,
            connector_runtime,
            workspace_changes: WorkspaceChangeTracker::default(),
            workspace_write_locks: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    pub fn workspace_write_lock(&self, user_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self
            .workspace_write_locks
            .lock()
            .expect("workspace write locks poisoned");
        locks
            .entry(user_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }
}
