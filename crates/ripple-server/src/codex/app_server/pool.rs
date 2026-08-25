use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use crate::config::AppConfig;

use super::CodexAppServerSession;

pub(super) const IDLE_REAPER_INTERVAL_SECONDS: u64 = 5;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(super) struct PoolKey {
    pub(super) user_key: String,
    pub(super) workspace_root: PathBuf,
    pub(super) generation: String,
}

pub(super) struct PoolWorker {
    pub(super) worker_id: u64,
    pub(super) session: Arc<CodexAppServerSession>,
    pub(super) active_job_id: Option<String>,
    pub(super) last_used_at: Instant,
}

#[derive(Default)]
pub(super) struct PoolState {
    pub(super) pools: HashMap<PoolKey, Vec<PoolWorker>>,
    pub(super) job_to_worker: HashMap<String, (PoolKey, u64)>,
}

pub(super) fn pool_generation(config: &AppConfig) -> String {
    let approval_policy = serde_json::to_string(&config.codex.approval_policy)
        .unwrap_or_else(|_| config.codex.approval_policy.to_string());
    [
        config.codex.codex_executable.as_str(),
        &config.codex.app_server_args.join("\u{1f}"),
        if config.codex.requires_service_auth {
            "service-auth"
        } else {
            "provider-auth"
        },
        &config.codex.provider_env_keys.join("\u{1f}"),
        approval_policy.as_str(),
        config.codex.sandbox_type.as_str(),
        if config.codex.network_access {
            "network"
        } else {
            "no-network"
        },
    ]
    .join("\u{1e}")
}
