use std::collections::BTreeMap;

use crate::api::{self, ApiError};
use crate::state::AppState;

pub async fn schedule_trigger_loop(state: AppState) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(
        state.config.schedule_poll_interval_seconds,
    ));
    loop {
        interval.tick().await;
        let _ = trigger_due_schedules(&state).await;
    }
}

pub async fn trigger_due_schedules(
    state: &AppState,
) -> Result<BTreeMap<String, Vec<String>>, ApiError> {
    api::schedules::trigger_due_schedules(state).await
}
