use std::sync::Arc;

use crate::config::AppConfig;
use crate::jobs::JobManager;
use crate::sandbox::SandboxManager;
use crate::sessions::SessionManager;
use crate::storage::Storage;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<AppConfig>,
    pub sandboxes: SandboxManager,
    pub sessions: SessionManager,
    pub jobs: JobManager,
    pub storage: Storage,
}

impl AppState {
    pub fn new(config: AppConfig) -> Self {
        let config = Arc::new(config);
        let sandboxes = SandboxManager::new(config.clone());
        let storage = Storage::new(config.clone()).expect("failed to initialize Ripple storage");
        let jobs = JobManager::new_with_storage(config.clone(), storage.clone());
        let sessions =
            SessionManager::new_with_storage(config.clone(), sandboxes.clone(), storage.clone());
        Self {
            config,
            sandboxes,
            sessions,
            jobs,
            storage,
        }
    }
}
