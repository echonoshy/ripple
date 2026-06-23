use std::collections::BTreeMap;

use tokio::time::Duration;

use crate::api::{self, ApiError};
use crate::state::AppState;

pub async fn task_action_trigger_loop(state: AppState) {
    let mut interval = tokio::time::interval(Duration::from_secs(
        state.config.task_trigger_poll_interval_seconds,
    ));
    loop {
        interval.tick().await;
        let _ = trigger_due_task_actions(&state).await;
    }
}

pub async fn trigger_due_task_actions(
    state: &AppState,
) -> Result<BTreeMap<String, Vec<String>>, ApiError> {
    api::tasks::trigger_due_task_actions(state).await
}
