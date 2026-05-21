use std::sync::Arc;

use crate::config::AppConfig;
use crate::jobs::JobManager;
use crate::sandbox::SandboxManager;
use crate::sessions::SessionManager;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<AppConfig>,
    pub sandboxes: SandboxManager,
    pub sessions: SessionManager,
    pub jobs: JobManager,
}

impl AppState {
    pub fn new(config: AppConfig) -> Self {
        let config = Arc::new(config);
        let sandboxes = SandboxManager::new(config.clone());
        let jobs = JobManager::new(config.clone());
        let sessions = SessionManager::new(config.clone(), sandboxes.clone());
        Self {
            config,
            sandboxes,
            sessions,
            jobs,
        }
    }
}
