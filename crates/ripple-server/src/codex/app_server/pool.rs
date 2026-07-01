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
        if config.codex.memory.enabled {
            "memory-enabled"
        } else {
            "memory-disabled"
        },
        if config.codex.memory.use_memories {
            "memory-use"
        } else {
            "memory-no-use"
        },
        if config.codex.memory.generate_memories {
            "memory-generate"
        } else {
            "memory-no-generate"
        },
        if config.codex.memory.dedicated_tools {
            "memory-tools"
        } else {
            "memory-no-tools"
        },
        if config.codex.memory.disable_on_external_context {
            "memory-disable-on-external"
        } else {
            "memory-allow-external"
        },
    ]
    .join("\u{1e}")
}
