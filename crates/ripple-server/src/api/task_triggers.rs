use std::collections::BTreeMap;
use std::path::Path as FsPath;

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::{Duration as TimeDuration, OffsetDateTime, PrimitiveDateTime};
use uuid::Uuid;

use crate::api::run_public::{
    public_run_value, sanitize_user_visible_text, sanitize_user_visible_value,
};
use crate::api::tasks::{
    append_task_event, execute_task_action_for_trigger, task_action_dependency_wait_reason,
    TaskRunTriggerContext,
};
use crate::api::{paginate, ApiError, ListQuery};
use crate::jobs::{resolve_workspace_cwd, AgentRunInfo};
use crate::state::AppState;
use crate::user::user_id_from_headers;

const TIME_TRIGGER_TYPE: &str = "time";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TaskTriggerState {
    version: u32,
    triggers: BTreeMap<String, TaskTriggerRecord>,
}

#[derive(Debug, Clone, PartialEq)]
enum TaskTriggerDriverDecision {
    Pending,
    Fire,
    SkipMissed { next_run_at: Option<String> },
}

struct NormalizedTaskTriggerTiming {
    kind: String,
    run_at: Option<String>,
    interval_seconds: Option<u64>,
    max_runs: Option<u64>,
    next_run_at: Option<String>,
}

trait TaskTriggerDriver: Sync {
    fn trigger_type(&self) -> &'static str;

    fn normalize_create_timing(
        &self,
        input: &TaskTriggerCreateInput,
        now: OffsetDateTime,
    ) -> Result<NormalizedTaskTriggerTiming, ApiError>;

    fn scheduled_decision(
        &self,
        record: &TaskTriggerRecord,
        now: OffsetDateTime,
        poll_interval_seconds: u64,
    ) -> Result<TaskTriggerDriverDecision, ApiError>;

    fn next_after_run(
        &self,
        record: &TaskTriggerRecord,
        now: OffsetDateTime,
    ) -> Result<Option<String>, ApiError>;

    fn limit_reached(&self, record: &TaskTriggerRecord) -> bool;

    fn complete_after_success(&self, record: &TaskTriggerRecord) -> bool;

    fn should_complete_action_on_scheduled_run(&self, record: &TaskTriggerRecord) -> bool;

    fn keep_active_after_failure(&self, record: &TaskTriggerRecord) -> bool;
}

struct TimeTaskTriggerDriver;

static TIME_TASK_TRIGGER_DRIVER: TimeTaskTriggerDriver = TimeTaskTriggerDriver;

impl TaskTriggerDriver for TimeTaskTriggerDriver {
    fn trigger_type(&self) -> &'static str {
        TIME_TRIGGER_TYPE
    }

    fn normalize_create_timing(
        &self,
        input: &TaskTriggerCreateInput,
        now: OffsetDateTime,
    ) -> Result<NormalizedTaskTriggerTiming, ApiError> {
        let kind = normalize_kind(&input.kind)?;
        let max_runs = normalize_max_runs(kind, input.max_runs)?;
        let interval_seconds = normalize_interval(kind, input.interval_seconds)?;
        let run_at = normalize_run_at(input.run_at.as_deref(), &input.timezone)?;
        let next_run_at = compute_time_trigger_initial_next_run_at(
            kind,
            run_at.as_deref(),
            interval_seconds,
            now,
        )?;
        Ok(NormalizedTaskTriggerTiming {
            kind: kind.to_string(),
            run_at,
            interval_seconds,
            max_runs,
            next_run_at,
        })
    }

    fn scheduled_decision(
        &self,
        record: &TaskTriggerRecord,
        now: OffsetDateTime,
        poll_interval_seconds: u64,
    ) -> Result<TaskTriggerDriverDecision, ApiError> {
        let Some(next_run_at) = record.next_run_at.as_deref() else {
            return Ok(TaskTriggerDriverDecision::Pending);
        };
        let next_run_at = parse_datetime(next_run_at)?;
        if next_run_at > now {
            return Ok(TaskTriggerDriverDecision::Pending);
        }
        if should_skip_missed_time_run(record, next_run_at, now, poll_interval_seconds) {
            return Ok(TaskTriggerDriverDecision::SkipMissed {
                next_run_at: self.next_after_run(record, now)?,
            });
        }
        Ok(TaskTriggerDriverDecision::Fire)
    }

    fn next_after_run(
        &self,
        record: &TaskTriggerRecord,
        now: OffsetDateTime,
    ) -> Result<Option<String>, ApiError> {
        advance_time_trigger_next_run_at(record, now)
    }

    fn limit_reached(&self, record: &TaskTriggerRecord) -> bool {
        record.kind == "interval"
            && record
                .max_runs
                .is_some_and(|max_runs| record.run_count >= max_runs)
    }

    fn complete_after_success(&self, record: &TaskTriggerRecord) -> bool {
        record.kind == "once" || self.limit_reached(record)
    }

    fn should_complete_action_on_scheduled_run(&self, record: &TaskTriggerRecord) -> bool {
        record.kind == "once"
            || (record.kind == "interval"
                && record
                    .max_runs
                    .is_some_and(|max_runs| record.run_count.saturating_add(1) >= max_runs))
    }

    fn keep_active_after_failure(&self, record: &TaskTriggerRecord) -> bool {
        record.kind == "interval" && record.failure_policy == "keep_active" && record.enabled
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct TaskTriggerRecord {
    trigger_id: String,
    user_id: String,
    #[serde(default = "default_trigger_type")]
    trigger_type: String,
    title: String,
    prompt: String,
    kind: String,
    timezone: String,
    run_at: Option<String>,
    interval_seconds: Option<u64>,
    enabled: bool,
    status: String,
    next_run_at: Option<String>,
    last_run_at: Option<String>,
    last_run_id: Option<String>,
    last_error: Option<String>,
    #[serde(default)]
    failure_reason: Option<String>,
    #[serde(default)]
    last_run_status: Option<String>,
    #[serde(default = "default_missed_run_policy")]
    missed_run_policy: String,
    #[serde(default = "default_overlap_policy")]
    overlap_policy: String,
    #[serde(default = "default_failure_policy")]
    failure_policy: String,
    cwd: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    summary: Option<String>,
    output_schema: Option<Value>,
    max_runtime_seconds: u64,
    max_runs: Option<u64>,
    #[serde(default)]
    task_id: Option<String>,
    #[serde(default)]
    task_action_id: Option<String>,
    run_count: u64,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct TaskTriggerPhaseInput {
    pub(crate) title: String,
    pub(crate) prompt: String,
    #[serde(default)]
    pub(crate) max_runs: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct TaskTriggerCreateInput {
    pub(crate) title: String,
    pub(crate) prompt: String,
    #[serde(default = "default_trigger_type", alias = "triggerType")]
    pub(crate) trigger_type: String,
    #[serde(default = "default_kind")]
    pub(crate) kind: String,
    #[serde(default = "default_timezone")]
    pub(crate) timezone: String,
    #[serde(default)]
    pub(crate) run_at: Option<String>,
    #[serde(default)]
    pub(crate) interval_seconds: Option<u64>,
    #[serde(default = "default_true")]
    pub(crate) enabled: bool,
    #[serde(default)]
    pub(crate) cwd: Option<String>,
    #[serde(default)]
    pub(crate) model: Option<String>,
    #[serde(default)]
    pub(crate) effort: Option<String>,
    #[serde(default)]
    pub(crate) summary: Option<String>,
    #[serde(default, rename = "outputSchema", alias = "output_schema")]
    pub(crate) output_schema: Option<Value>,
    #[serde(default = "default_max_runtime")]
    pub(crate) max_runtime_seconds: u64,
    #[serde(default)]
    pub(crate) max_runs: Option<u64>,
    #[serde(default)]
    pub(crate) phases: Vec<TaskTriggerPhaseInput>,
    #[serde(default)]
    pub(crate) task_id: Option<String>,
    #[serde(default)]
    pub(crate) task_action_id: Option<String>,
    #[serde(default = "default_missed_run_policy")]
    pub(crate) missed_run_policy: String,
    #[serde(default = "default_overlap_policy")]
    pub(crate) overlap_policy: String,
    #[serde(default = "default_failure_policy")]
    pub(crate) failure_policy: String,
}

pub async fn list_task_triggers(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    if state.storage.get_task(&user_id, &task_id).await?.is_none() {
        return Err(ApiError::not_found("Task not found"));
    }
    let triggers = load_task_trigger_state(&state, &user_id).await?.triggers;
    let mut records = triggers
        .values()
        .filter(|record| record.task_id.as_deref() == Some(task_id.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    for record in &mut records {
        reconcile_task_trigger_record(&state, &user_id, record).await?;
    }
    records.sort_by(|a, b| {
        a.next_run_at
            .clone()
            .unwrap_or_else(|| "9999".to_string())
            .cmp(&b.next_run_at.clone().unwrap_or_else(|| "9999".to_string()))
    });
    let total = records.len();
    let (records, next_cursor) = paginate(records, &query)?;
    let triggers = records
        .iter()
        .map(|record| public_task_trigger_value(&state, &user_id, record))
        .collect::<Vec<_>>();
    Ok(Json(json!({
        "triggers": triggers,
        "count": triggers.len(),
        "total": total,
        "next_cursor": next_cursor
    })))
}

pub async fn list_all_task_triggers(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    let mut records = state
        .storage
        .list_task_triggers(&user_id)
        .await?
        .into_iter()
        .filter_map(|value| serde_json::from_value::<TaskTriggerRecord>(value).ok())
        .collect::<Vec<_>>();
    for record in &mut records {
        reconcile_task_trigger_record(&state, &user_id, record).await?;
    }
    records.sort_by(|a, b| {
        a.task_id
            .clone()
            .unwrap_or_default()
            .cmp(&b.task_id.clone().unwrap_or_default())
            .then_with(|| {
                a.next_run_at
                    .clone()
                    .unwrap_or_else(|| "9999".to_string())
                    .cmp(&b.next_run_at.clone().unwrap_or_else(|| "9999".to_string()))
            })
    });
    let total = records.len();
    let (records, next_cursor) = paginate(records, &query)?;
    let triggers = records
        .iter()
        .map(|record| public_task_trigger_value(&state, &user_id, record))
        .collect::<Vec<_>>();
    Ok(Json(json!({
        "triggers": triggers,
        "count": triggers.len(),
        "total": total,
        "next_cursor": next_cursor
    })))
}

pub async fn create_task_action_trigger(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((task_id, action_id)): Path<(String, String)>,
    Json(mut input): Json<TaskTriggerCreateInput>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    let task = state
        .storage
        .get_task(&user_id, &task_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Task not found"))?;
    let actions = state.storage.list_task_actions(&user_id, &task_id).await?;
    let action = actions
        .iter()
        .find(|action| action.get("action_id").and_then(Value::as_str) == Some(action_id.as_str()))
        .ok_or_else(|| ApiError::not_found("Task action not found"))?;
    if input.enabled && !task_has_source_session(&task) {
        return Err(ApiError::bad_request(
            "Enabled task trigger requires source_session_id",
        ));
    }
    let enable_on_confirm = input.enabled;
    let needs_confirmation = task.get("status").and_then(Value::as_str) == Some("candidate")
        || task
            .get("requires_confirmation")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || action.get("status").and_then(Value::as_str) == Some("candidate")
        || action
            .get("requires_confirmation")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    if needs_confirmation {
        input.enabled = false;
    }
    input.task_id = Some(task_id);
    input.task_action_id = Some(action_id);
    let mut trigger = create_task_trigger_for_user(&state, &user_id, input).await?;
    if needs_confirmation {
        if let Some(object) = trigger.as_object_mut() {
            object.insert("enabled".to_string(), json!(false));
            object.insert("status".to_string(), json!("pending_confirmation"));
            object.insert("next_run_at".to_string(), Value::Null);
            object.insert("enable_on_confirm".to_string(), json!(enable_on_confirm));
            object.insert(
                "updated_at".to_string(),
                json!(iso(OffsetDateTime::now_utc())),
            );
        }
        state
            .storage
            .upsert_task_trigger(&user_id, &trigger)
            .await?;
    }
    Ok(Json(public_task_trigger_from_record_value(trigger)))
}

pub async fn create_task_trigger(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    Json(mut input): Json<TaskTriggerCreateInput>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    let task = state
        .storage
        .get_task(&user_id, &task_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Task not found"))?;
    if input.enabled && !task_has_source_session(&task) {
        return Err(ApiError::bad_request(
            "Enabled task trigger requires source_session_id",
        ));
    }
    let enable_on_confirm = input.enabled;
    let needs_confirmation = task.get("status").and_then(Value::as_str) == Some("candidate")
        || task
            .get("requires_confirmation")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    if needs_confirmation {
        input.enabled = false;
    }
    input.task_id = Some(task_id);
    input.task_action_id = None;
    let mut trigger = create_task_trigger_for_user(&state, &user_id, input).await?;
    if needs_confirmation {
        if let Some(object) = trigger.as_object_mut() {
            object.insert("enabled".to_string(), json!(false));
            object.insert("status".to_string(), json!("pending_confirmation"));
            object.insert("next_run_at".to_string(), Value::Null);
            object.insert("enable_on_confirm".to_string(), json!(enable_on_confirm));
            object.insert(
                "updated_at".to_string(),
                json!(iso(OffsetDateTime::now_utc())),
            );
        }
        state
            .storage
            .upsert_task_trigger(&user_id, &trigger)
            .await?;
    }
    Ok(Json(public_task_trigger_from_record_value(trigger)))
}

pub(crate) async fn create_task_trigger_for_user(
    state: &AppState,
    user_id: &str,
    input: TaskTriggerCreateInput,
) -> Result<Value, ApiError> {
    let workspace_root = state.sandboxes.ensure_sandbox(user_id)?;
    let now = OffsetDateTime::now_utc();
    let driver = task_trigger_driver_for_type(&input.trigger_type)?;
    let timing = driver.normalize_create_timing(&input, now)?;
    let title = clean_required(&input.title, "title")?;
    let prompt = clean_required(&input.prompt, "prompt")?;
    validate_task_trigger_cwd(&workspace_root, input.cwd.as_deref())?;
    let record = TaskTriggerRecord {
        trigger_id: format!("trg-{}", &Uuid::new_v4().simple().to_string()[..10]),
        user_id: user_id.to_string(),
        trigger_type: driver.trigger_type().to_string(),
        title,
        prompt,
        kind: timing.kind,
        timezone: input.timezone.trim().to_string(),
        run_at: timing.run_at,
        interval_seconds: timing.interval_seconds,
        enabled: input.enabled,
        status: if input.enabled { "active" } else { "paused" }.to_string(),
        next_run_at: if input.enabled {
            timing.next_run_at
        } else {
            None
        },
        last_run_at: None,
        last_run_id: None,
        last_error: None,
        failure_reason: None,
        last_run_status: None,
        missed_run_policy: normalize_missed_run_policy(&input.missed_run_policy)?.to_string(),
        overlap_policy: normalize_overlap_policy(&input.overlap_policy)?.to_string(),
        failure_policy: normalize_failure_policy(&input.failure_policy)?.to_string(),
        cwd: input.cwd,
        model: input.model,
        effort: input.effort,
        summary: input.summary,
        output_schema: input.output_schema,
        max_runtime_seconds: input.max_runtime_seconds.clamp(1, 86_400),
        max_runs: timing.max_runs,
        task_id: clean_optional_link_id(input.task_id),
        task_action_id: clean_optional_link_id(input.task_action_id),
        run_count: 0,
        created_at: iso(now),
        updated_at: iso(now),
    };
    persist_task_trigger_record(state, user_id, &record).await?;
    Ok(public_task_trigger_record_value(state, user_id, &record))
}

pub async fn run_task_trigger_now(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((task_id, trigger_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let trigger_state = load_task_trigger_state(&state, &user_id).await?;
    let Some(mut record) = trigger_state.triggers.get(&trigger_id).cloned() else {
        return Err(ApiError::not_found("Task trigger not found"));
    };
    if record.task_id.as_deref() != Some(task_id.as_str()) {
        return Err(ApiError::not_found("Task trigger not found"));
    }
    reconcile_task_trigger_record(&state, &user_id, &mut record).await?;
    if record.status == "pending_confirmation" {
        return Err(ApiError::bad_request(
            "Task trigger must be confirmed before it can run.",
        ));
    }
    let now = OffsetDateTime::now_utc();
    if let Some(reason) = task_trigger_dependency_wait_reason(&state, &user_id, &record).await? {
        apply_waiting_dependencies_to_task_trigger(&mut record, &reason, None, now);
        persist_task_trigger_record(&state, &user_id, &record).await?;
        return Err(ApiError::conflict(reason));
    }
    let info = match start_task_trigger_run(&state, &user_id, &record, "manual").await {
        Ok(info) => info,
        Err(err) => {
            record.status = "error".to_string();
            record.last_error = Some(format!("{err:?}"));
            record.failure_reason = record.last_error.clone();
            record.last_run_status = Some("failed".to_string());
            record.updated_at = iso(now);
            persist_task_trigger_record(&state, &user_id, &record).await?;
            return Err(err);
        }
    };
    apply_latest_run_to_task_trigger(&mut record, Some(&info));
    if info.status != "completed" {
        apply_failed_task_trigger_run(&mut record, &info, now)?;
    } else if task_trigger_target_completed(&state, &user_id, &record).await? {
        record.enabled = false;
        record.status = "completed".to_string();
        record.next_run_at = None;
    } else if record.enabled && record.status != "completed" {
        record.status = "active".to_string();
    }
    record.updated_at = iso(now);
    persist_task_trigger_record(&state, &user_id, &record).await?;
    Ok(Json(public_run_value(&state, &user_id, &info)))
}

pub async fn trigger_due_task_triggers(
    state: &AppState,
) -> Result<BTreeMap<String, Vec<String>>, ApiError> {
    let now = OffsetDateTime::now_utc();
    let mut triggered = BTreeMap::<String, Vec<String>>::new();
    let mut pending_runs = Vec::new();
    for user_id in state.storage.list_task_trigger_user_ids().await? {
        let trigger_state = load_task_trigger_state(state, &user_id).await?;
        let trigger_ids = trigger_state.triggers.keys().cloned().collect::<Vec<_>>();
        for trigger_id in trigger_ids {
            let Some(mut record) = trigger_state.triggers.get(&trigger_id).cloned() else {
                continue;
            };
            reconcile_task_trigger_record(state, &user_id, &mut record).await?;
            if !record.enabled || record.status != "active" {
                continue;
            }
            let driver = task_trigger_driver_for_record(&record)?;
            if driver.limit_reached(&record) {
                record.enabled = false;
                record.status = "completed".to_string();
                record.next_run_at = None;
                record.updated_at = iso(now);
                persist_task_trigger_record(state, &user_id, &record).await?;
                continue;
            }
            if task_trigger_target_completed(state, &user_id, &record).await? {
                record.enabled = false;
                record.status = "completed".to_string();
                record.next_run_at = None;
                record.updated_at = iso(now);
                persist_task_trigger_record(state, &user_id, &record).await?;
                continue;
            }
            match driver.scheduled_decision(
                &record,
                now,
                state.config.schedule_poll_interval_seconds,
            )? {
                TaskTriggerDriverDecision::Pending => continue,
                TaskTriggerDriverDecision::SkipMissed { next_run_at } => {
                    record.last_error = None;
                    record.failure_reason = None;
                    record.last_run_status = Some("skipped_missed".to_string());
                    record.status = "active".to_string();
                    record.next_run_at = next_run_at;
                    record.updated_at = iso(now);
                    persist_task_trigger_record(state, &user_id, &record).await?;
                    continue;
                }
                TaskTriggerDriverDecision::Fire => {}
            }
            if let Some(reason) =
                task_trigger_dependency_wait_reason(state, &user_id, &record).await?
            {
                let retry_at = dependency_retry_at(state, now);
                apply_waiting_dependencies_to_task_trigger(&mut record, &reason, retry_at, now);
                persist_task_trigger_record(state, &user_id, &record).await?;
                continue;
            }
            if record.overlap_policy == "skip"
                && state
                    .jobs
                    .has_active_task_trigger_run(&user_id, &record.trigger_id)
                    .await
            {
                record.last_error =
                    Some("Skipped because previous run is still active".to_string());
                record.last_run_status = Some("skipped_overlap".to_string());
                record.next_run_at = driver.next_after_run(&record, now)?;
                record.updated_at = iso(now);
                persist_task_trigger_record(state, &user_id, &record).await?;
                continue;
            }
            let run_state = state.clone();
            let run_user_id = user_id.clone();
            pending_runs.push(tokio::spawn(async move {
                let info =
                    start_task_trigger_run(&run_state, &run_user_id, &record, "scheduled").await;
                (run_user_id, trigger_id, record, info)
            }));
        }
    }
    for pending_run in pending_runs {
        let (user_id, trigger_id, mut record, info) = pending_run
            .await
            .map_err(|err| ApiError::bad_request(format!("Task trigger task failed: {err}")))?;
        let now = OffsetDateTime::now_utc();
        match info {
            Ok(info) => {
                apply_latest_run_to_task_trigger(&mut record, Some(&info));
                if info.status != "completed" {
                    apply_failed_task_trigger_run(&mut record, &info, now)?;
                    record.updated_at = iso(now);
                    persist_task_trigger_record(state, &user_id, &record).await?;
                    continue;
                }
                record.run_count += 1;
                let driver = task_trigger_driver_for_record(&record)?;
                if driver.complete_after_success(&record)
                    || task_trigger_target_completed(state, &user_id, &record).await?
                {
                    record.enabled = false;
                    record.status = "completed".to_string();
                    record.next_run_at = None;
                } else {
                    record.status = "active".to_string();
                    record.next_run_at = driver.next_after_run(&record, now)?;
                }
                record.updated_at = iso(now);
                persist_task_trigger_record(state, &user_id, &record).await?;
                triggered.entry(user_id).or_default().push(trigger_id);
            }
            Err(err) => {
                let summary = format!("{err:?}");
                record.last_error = Some(summary.clone());
                record.failure_reason = Some(summary);
                record.last_run_status = Some("failed".to_string());
                let driver = task_trigger_driver_for_record(&record)?;
                if driver.keep_active_after_failure(&record) {
                    record.status = "active".to_string();
                    record.next_run_at = driver.next_after_run(&record, now)?;
                } else {
                    if record.failure_policy == "pause" {
                        record.enabled = false;
                    }
                    record.status = "error".to_string();
                    record.next_run_at = None;
                }
                record.updated_at = iso(now);
                persist_task_trigger_record(state, &user_id, &record).await?;
            }
        }
    }
    Ok(triggered)
}

async fn start_task_trigger_run(
    state: &AppState,
    user_id: &str,
    record: &TaskTriggerRecord,
    trigger: &str,
) -> Result<AgentRunInfo, ApiError> {
    let task_id = record
        .task_id
        .as_deref()
        .ok_or_else(|| ApiError::bad_request("Task trigger missing task_id"))?;
    let info = execute_task_action_for_trigger(
        state,
        user_id,
        task_id,
        record.task_action_id.as_deref(),
        TaskRunTriggerContext {
            trigger_id: record.trigger_id.clone(),
            task_trigger_title: record.title.clone(),
            task_trigger_reason: trigger.to_string(),
            complete_action_on_success: record
                .task_action_id
                .as_ref()
                .map(|_| should_complete_task_trigger_action(record, trigger)),
            prompt: Some(record.prompt.clone()),
            cwd: record.cwd.clone(),
            model: record.model.clone(),
            effort: record.effort.clone(),
            summary: record.summary.clone(),
            output_schema: record.output_schema.clone(),
            max_runtime_seconds: Some(record.max_runtime_seconds),
        },
    )
    .await?;
    append_task_trigger_run_event(
        state,
        user_id,
        record,
        "task_trigger_run_started",
        &info,
        trigger,
    )
    .await?;
    if let Some(event_type) = task_trigger_terminal_event_type(&info.status) {
        append_task_trigger_run_event(state, user_id, record, event_type, &info, trigger).await?;
    }
    Ok(info)
}

async fn task_trigger_dependency_wait_reason(
    state: &AppState,
    user_id: &str,
    record: &TaskTriggerRecord,
) -> Result<Option<String>, ApiError> {
    let (Some(task_id), Some(action_id)) =
        (record.task_id.as_deref(), record.task_action_id.as_deref())
    else {
        return Ok(None);
    };
    task_action_dependency_wait_reason(&state.storage, user_id, task_id, action_id).await
}

fn dependency_retry_at(state: &AppState, now: OffsetDateTime) -> Option<String> {
    let delay_seconds = state.config.schedule_poll_interval_seconds.max(1) as i64;
    Some(iso(now + TimeDuration::seconds(delay_seconds)))
}

fn apply_waiting_dependencies_to_task_trigger(
    record: &mut TaskTriggerRecord,
    reason: &str,
    retry_at: Option<String>,
    now: OffsetDateTime,
) {
    record.last_error = Some(reason.to_string());
    record.failure_reason = None;
    record.last_run_status = Some("waiting_dependencies".to_string());
    if record.enabled {
        record.status = "active".to_string();
    }
    if let Some(retry_at) = retry_at {
        record.next_run_at = Some(retry_at);
    }
    record.updated_at = iso(now);
}

async fn load_task_trigger_state(
    state: &AppState,
    user_id: &str,
) -> Result<TaskTriggerState, ApiError> {
    let mut triggers = BTreeMap::new();
    for value in state.storage.list_task_triggers(user_id).await? {
        if let Ok(record) = serde_json::from_value::<TaskTriggerRecord>(value) {
            triggers.insert(record.trigger_id.clone(), record);
        }
    }
    Ok(TaskTriggerState {
        version: 1,
        triggers,
    })
}

async fn persist_task_trigger_record(
    state: &AppState,
    user_id: &str,
    record: &TaskTriggerRecord,
) -> Result<(), ApiError> {
    let value = serde_json::to_value(record).map_err(anyhow::Error::from)?;
    state.storage.upsert_task_trigger(user_id, &value).await?;
    Ok(())
}

fn public_task_trigger_record_value(
    state: &AppState,
    user_id: &str,
    record: &TaskTriggerRecord,
) -> Value {
    let value = serde_json::to_value(record).unwrap_or_else(|_| json!({}));
    sanitize_user_visible_value(state, user_id, &value)
}

fn public_task_trigger_value(state: &AppState, user_id: &str, record: &TaskTriggerRecord) -> Value {
    public_task_trigger_from_record_value(public_task_trigger_record_value(state, user_id, record))
}

fn public_task_trigger_from_record_value(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.remove("enable_on_confirm");
        let trigger_type = object
            .get("trigger_type")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(TIME_TRIGGER_TYPE)
            .to_string();
        object.insert("trigger_type".to_string(), json!(trigger_type));
    }
    value
}

async fn reconcile_task_trigger_record(
    state: &AppState,
    user_id: &str,
    record: &mut TaskTriggerRecord,
) -> Result<(), ApiError> {
    let records = list_task_trigger_job_records(state, user_id, &record.trigger_id).await?;
    let previous_run_id = record.last_run_id.clone();
    let previous_run_status = record.last_run_status.clone();
    let latest = records.first();
    if apply_latest_run_to_task_trigger(record, latest) {
        if let Some(run) = latest {
            append_task_trigger_terminal_event_if_needed(
                state,
                user_id,
                record,
                run,
                previous_run_id.as_deref(),
                previous_run_status.as_deref(),
            )
            .await?;
        }
        record.updated_at = iso(OffsetDateTime::now_utc());
        persist_task_trigger_record(state, user_id, record).await?;
    }
    Ok(())
}

async fn append_task_trigger_run_event(
    state: &AppState,
    user_id: &str,
    record: &TaskTriggerRecord,
    event_type: &str,
    run: &AgentRunInfo,
    trigger: &str,
) -> Result<(), ApiError> {
    let Some(task_id) = record.task_id.as_deref() else {
        return Ok(());
    };
    append_task_event(
        &state.storage,
        user_id,
        task_id,
        event_type,
        json!({
            "trigger_id": record.trigger_id,
            "task_action_id": record.task_action_id,
            "run_id": run.job_id,
            "status": run.status,
            "trigger": trigger,
        }),
    )
    .await
}

async fn append_task_trigger_terminal_event_if_needed(
    state: &AppState,
    user_id: &str,
    record: &TaskTriggerRecord,
    run: &AgentRunInfo,
    previous_run_id: Option<&str>,
    previous_run_status: Option<&str>,
) -> Result<(), ApiError> {
    let Some(event_type) = task_trigger_terminal_event_type(&run.status) else {
        return Ok(());
    };
    if previous_run_id == Some(run.job_id.as_str())
        && previous_run_status == Some(run.status.as_str())
    {
        return Ok(());
    }
    let trigger = run
        .metadata
        .get("task_trigger_reason")
        .and_then(Value::as_str)
        .unwrap_or("scheduled");
    append_task_trigger_run_event(state, user_id, record, event_type, run, trigger).await?;
    append_task_trigger_session_update_if_needed(state, user_id, record, run).await
}

fn task_trigger_terminal_event_type(status: &str) -> Option<&'static str> {
    match status {
        "completed" => Some("task_trigger_run_completed"),
        "failed" | "cancelled" => Some("task_trigger_run_failed"),
        _ => None,
    }
}

async fn append_task_trigger_session_update_if_needed(
    state: &AppState,
    user_id: &str,
    record: &TaskTriggerRecord,
    run: &AgentRunInfo,
) -> Result<(), ApiError> {
    if run.status != "completed" {
        return Ok(());
    }
    if run
        .metadata
        .get("session_id")
        .and_then(Value::as_str)
        .is_some()
    {
        return Ok(());
    }
    let Some(task_id) = record.task_id.as_deref() else {
        return Ok(());
    };
    let Some(task) = state.storage.get_task(user_id, task_id).await? else {
        return Ok(());
    };
    let Some(session_id) = task
        .get("source_session_id")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return Ok(());
    };
    let Some(mut session) = state.sessions.load(user_id, &session_id).await? else {
        return Ok(());
    };
    let output_text = read_task_trigger_run_output(run).await;
    let result_summary = sanitize_user_visible_text(state, user_id, &output_text);
    if result_summary.trim().is_empty() {
        return Ok(());
    }
    session.messages.push(json!({
        "role": "assistant",
        "content": [{"type": "text", "text": result_summary}],
        "created_at": iso(OffsetDateTime::now_utc())
    }));
    session.message_count = session.messages.len();
    session.last_active = iso(OffsetDateTime::now_utc());
    state.sessions.save_record_if_exists(session).await?;
    Ok(())
}

async fn read_task_trigger_run_output(run: &AgentRunInfo) -> String {
    if let Some(output_file) = run.output_file.as_deref() {
        if let Ok(text) = tokio::fs::read_to_string(output_file).await {
            return text;
        }
    }
    run.stdout_tail.clone()
}

async fn list_task_trigger_job_records(
    state: &AppState,
    user_id: &str,
    trigger_id: &str,
) -> Result<Vec<AgentRunInfo>, ApiError> {
    let mut out = state
        .storage
        .list_jobs_for_task_trigger(user_id, trigger_id)
        .await?
        .into_iter()
        .filter_map(|value| agent_run_info_from_record(&value))
        .collect::<Vec<_>>();
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

fn agent_run_info_from_record(record: &Value) -> Option<AgentRunInfo> {
    Some(AgentRunInfo {
        job_id: record.get("job_id")?.as_str()?.to_string(),
        provider: record_string(record, "provider"),
        status: record_string(record, "status"),
        output_file: record
            .get("output_file")
            .and_then(Value::as_str)
            .map(str::to_string),
        events_file: record
            .get("events_file")
            .and_then(Value::as_str)
            .map(str::to_string),
        created_at: record_string(record, "created_at"),
        updated_at: record_string(record, "updated_at"),
        exit_code: record
            .get("exit_code")
            .and_then(Value::as_i64)
            .and_then(|value| i32::try_from(value).ok()),
        prompt_preview: record
            .get("prompt_preview")
            .and_then(Value::as_str)
            .map(str::to_string),
        sandbox_cwd: record
            .get("sandbox_cwd")
            .and_then(Value::as_str)
            .map(str::to_string),
        stdout_tail: record_string(record, "stdout_tail"),
        stderr_tail: record_string(record, "stderr_tail"),
        error: record
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string),
        pending_approval: None,
        metadata: record.clone(),
    })
}

fn record_string(record: &Value, key: &str) -> String {
    record
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn apply_latest_run_to_task_trigger(
    record: &mut TaskTriggerRecord,
    latest: Option<&AgentRunInfo>,
) -> bool {
    let before = record.clone();
    let Some(run) = latest else {
        if record.last_run_id.is_some() || record.last_run_at.is_some() {
            record.last_run_id = None;
            record.last_run_at = None;
            record.last_run_status = None;
        }
        return *record != before;
    };

    record.last_run_id = Some(run.job_id.clone());
    record.last_run_at = Some(run_timestamp(run));
    record.last_run_status = Some(run.status.clone());

    match run.status.as_str() {
        "completed" => {
            record.last_error = None;
            record.failure_reason = None;
        }
        "queued" | "running" => {
            record.last_error = None;
            record.failure_reason = None;
        }
        "failed" | "cancelled" => {
            let summary = run_failure_summary(run);
            record.last_error = Some(summary.clone());
            record.failure_reason = Some(summary);
            if run
                .metadata
                .get("task_trigger_reason")
                .and_then(Value::as_str)
                == Some("scheduled")
                && record.failure_policy == "pause"
            {
                record.enabled = false;
                record.status = "error".to_string();
                record.next_run_at = None;
            }
        }
        _ => {}
    }

    *record != before
}

fn apply_failed_task_trigger_run(
    record: &mut TaskTriggerRecord,
    info: &AgentRunInfo,
    now: OffsetDateTime,
) -> Result<(), ApiError> {
    let summary = run_failure_summary(info);
    record.last_error = Some(summary.clone());
    record.failure_reason = Some(summary);
    record.last_run_status = Some(info.status.clone());
    let driver = task_trigger_driver_for_record(record)?;
    if driver.keep_active_after_failure(record) {
        record.status = "active".to_string();
        record.next_run_at = driver.next_after_run(record, now)?;
    } else {
        if record.failure_policy == "pause" {
            record.enabled = false;
        }
        record.status = "error".to_string();
        record.next_run_at = None;
    }
    Ok(())
}

fn run_timestamp(run: &AgentRunInfo) -> String {
    if !run.updated_at.trim().is_empty() {
        return run.updated_at.clone();
    }
    run.created_at.clone()
}

fn run_failure_summary(run: &AgentRunInfo) -> String {
    run.error
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            let value = run.stderr_tail.trim();
            (!value.is_empty()).then_some(value)
        })
        .or_else(|| {
            let value = run.stdout_tail.trim();
            (!value.is_empty()).then_some(value)
        })
        .map(str::to_string)
        .unwrap_or_else(|| format!("Run {}", run.status))
}

fn clean_required(value: &str, field: &str) -> Result<String, ApiError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(ApiError::bad_request(format!("{field} is required")))
    } else {
        Ok(trimmed.to_string())
    }
}

fn clean_optional_link_id(value: Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn task_trigger_driver_for_type(value: &str) -> Result<&'static dyn TaskTriggerDriver, ApiError> {
    match value.trim() {
        "" | TIME_TRIGGER_TYPE => Ok(&TIME_TASK_TRIGGER_DRIVER),
        _ => Err(ApiError::bad_request("trigger_type must be one of: time")),
    }
}

fn task_trigger_driver_for_record(
    record: &TaskTriggerRecord,
) -> Result<&'static dyn TaskTriggerDriver, ApiError> {
    task_trigger_driver_for_type(&record.trigger_type)
}

fn normalize_kind(value: &str) -> Result<&'static str, ApiError> {
    match value.trim() {
        "once" => Ok("once"),
        "interval" => Ok("interval"),
        _ => Err(ApiError::bad_request("kind must be one of: once, interval")),
    }
}

fn normalize_interval(kind: &str, value: Option<u64>) -> Result<Option<u64>, ApiError> {
    if kind == "interval" {
        let Some(value) = value else {
            return Err(ApiError::bad_request(
                "interval_seconds is required for interval task triggers",
            ));
        };
        Ok(Some(value.max(1)))
    } else {
        Ok(None)
    }
}

fn normalize_max_runs(kind: &str, value: Option<u64>) -> Result<Option<u64>, ApiError> {
    if kind != "interval" && value.is_some() {
        return Err(ApiError::bad_request(
            "max_runs is only supported for interval task triggers",
        ));
    }
    Ok(value.map(|value| value.max(1)))
}

fn normalize_missed_run_policy(value: &str) -> Result<&'static str, ApiError> {
    match value.trim() {
        "" | "run_once" => Ok("run_once"),
        "skip" => Ok("skip"),
        _ => Err(ApiError::bad_request(
            "missed_run_policy must be one of: run_once, skip",
        )),
    }
}

fn normalize_overlap_policy(value: &str) -> Result<&'static str, ApiError> {
    match value.trim() {
        "" | "skip" => Ok("skip"),
        "allow" => Ok("allow"),
        _ => Err(ApiError::bad_request(
            "overlap_policy must be one of: skip, allow",
        )),
    }
}

fn normalize_failure_policy(value: &str) -> Result<&'static str, ApiError> {
    match value.trim() {
        "" | "pause" => Ok("pause"),
        "keep_active" => Ok("keep_active"),
        _ => Err(ApiError::bad_request(
            "failure_policy must be one of: pause, keep_active",
        )),
    }
}

fn validate_task_trigger_cwd(workspace_root: &FsPath, cwd: Option<&str>) -> Result<(), ApiError> {
    resolve_workspace_cwd(cwd, workspace_root)
        .map(|_| ())
        .map_err(|err| ApiError::bad_request(err.to_string()))
}

fn normalize_run_at(value: Option<&str>, timezone: &str) -> Result<Option<String>, ApiError> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if !is_utc_timezone(timezone) && !has_datetime_offset(value) {
        return Err(ApiError::bad_request(
            "run_at must include a timezone offset when timezone is not UTC",
        ));
    }
    Ok(Some(iso(parse_datetime(value)?)))
}

fn compute_time_trigger_initial_next_run_at(
    kind: &str,
    run_at: Option<&str>,
    interval_seconds: Option<u64>,
    now: OffsetDateTime,
) -> Result<Option<String>, ApiError> {
    if kind == "once" {
        let Some(run_at) = run_at else {
            return Err(ApiError::bad_request(
                "run_at is required for one-shot task triggers",
            ));
        };
        return Ok(Some(iso(parse_datetime(run_at)?)));
    }
    let interval_seconds = interval_seconds.ok_or_else(|| {
        ApiError::bad_request("interval_seconds is required for interval task triggers")
    })?;
    let mut next = match run_at {
        Some(run_at) => parse_datetime(run_at)?,
        None => now + TimeDuration::seconds(interval_seconds as i64),
    };
    while next <= now {
        next += TimeDuration::seconds(interval_seconds as i64);
    }
    Ok(Some(iso(next)))
}

fn advance_time_trigger_next_run_at(
    record: &TaskTriggerRecord,
    now: OffsetDateTime,
) -> Result<Option<String>, ApiError> {
    if record.kind != "interval" {
        return Ok(None);
    }
    let Some(interval_seconds) = record.interval_seconds else {
        return Ok(None);
    };
    let mut next = record
        .next_run_at
        .as_deref()
        .map(parse_datetime)
        .transpose()?
        .unwrap_or(now);
    while next <= now {
        next += TimeDuration::seconds(interval_seconds as i64);
    }
    Ok(Some(iso(next)))
}

fn parse_datetime(value: &str) -> Result<OffsetDateTime, ApiError> {
    if let Ok(parsed) = OffsetDateTime::parse(value, &Rfc3339) {
        return Ok(parsed.to_offset(time::UtcOffset::UTC));
    }
    let value = value.strip_suffix('Z').unwrap_or(value);
    let formats = [
        time::macros::format_description!("[year]-[month]-[day]T[hour]:[minute]:[second]"),
        time::macros::format_description!("[year]-[month]-[day]T[hour]:[minute]"),
    ];
    for format in formats {
        if let Ok(parsed) = PrimitiveDateTime::parse(value, format) {
            return Ok(parsed.assume_utc());
        }
    }
    Err(ApiError::bad_request("invalid datetime"))
}

fn is_utc_timezone(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "" | "utc" | "z" | "etc/utc" | "etc/gmt"
    )
}

fn has_datetime_offset(value: &str) -> bool {
    let value = value.trim();
    if value.ends_with('Z') || value.ends_with('z') {
        return true;
    }
    let time_start = value
        .find('T')
        .or_else(|| value.find('t'))
        .map(|index| index + 1)
        .unwrap_or(value.len());
    value[time_start..].contains('+') || value[time_start..].contains('-')
}

fn should_skip_missed_time_run(
    record: &TaskTriggerRecord,
    next_run_at: OffsetDateTime,
    now: OffsetDateTime,
    poll_interval_seconds: u64,
) -> bool {
    if record.kind != "interval" || record.missed_run_policy != "skip" {
        return false;
    }
    let tolerance = TimeDuration::seconds(poll_interval_seconds.max(1) as i64);
    next_run_at + tolerance < now
}

async fn task_trigger_target_completed(
    state: &AppState,
    user_id: &str,
    record: &TaskTriggerRecord,
) -> Result<bool, ApiError> {
    let Some(task_id) = record.task_id.as_deref() else {
        return Ok(false);
    };
    let Some(task) = state.storage.get_task(user_id, task_id).await? else {
        return Ok(false);
    };
    Ok(matches!(
        task.get("status").and_then(Value::as_str),
        Some("completed" | "cancelled" | "archived")
    ))
}

fn should_complete_task_trigger_action(record: &TaskTriggerRecord, trigger: &str) -> bool {
    if trigger != "scheduled" {
        return false;
    }
    task_trigger_driver_for_record(record)
        .map(|driver| driver.should_complete_action_on_scheduled_run(record))
        .unwrap_or(false)
}

fn iso(value: OffsetDateTime) -> String {
    value
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn default_kind() -> String {
    "once".to_string()
}

fn default_trigger_type() -> String {
    TIME_TRIGGER_TYPE.to_string()
}

fn default_timezone() -> String {
    "UTC".to_string()
}

fn default_true() -> bool {
    true
}

fn default_max_runtime() -> u64 {
    1800
}

fn default_missed_run_policy() -> String {
    "run_once".to_string()
}

fn default_overlap_policy() -> String {
    "skip".to_string()
}

fn default_failure_policy() -> String {
    "pause".to_string()
}

fn task_has_source_session(task: &Value) -> bool {
    task.get("source_session_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task_trigger_record() -> TaskTriggerRecord {
        TaskTriggerRecord {
            trigger_id: "trg-test".to_string(),
            user_id: "alice".to_string(),
            trigger_type: "time".to_string(),
            title: "Daily report".to_string(),
            prompt: "Write a report".to_string(),
            kind: "interval".to_string(),
            timezone: "UTC".to_string(),
            run_at: None,
            interval_seconds: Some(86_400),
            enabled: true,
            status: "active".to_string(),
            next_run_at: Some("2026-06-01T00:00:00Z".to_string()),
            last_run_at: Some("2026-05-30T00:00:00Z".to_string()),
            last_run_id: Some("agent-old".to_string()),
            last_error: Some("old error".to_string()),
            failure_reason: Some("old failure".to_string()),
            last_run_status: Some("failed".to_string()),
            missed_run_policy: "run_once".to_string(),
            overlap_policy: "skip".to_string(),
            failure_policy: "pause".to_string(),
            cwd: None,
            model: None,
            effort: None,
            summary: None,
            output_schema: None,
            max_runtime_seconds: 1800,
            max_runs: None,
            task_id: None,
            task_action_id: None,
            run_count: 1,
            created_at: "2026-05-30T00:00:00Z".to_string(),
            updated_at: "2026-05-30T00:00:00Z".to_string(),
        }
    }

    fn run_info(status: &str, trigger: &str) -> AgentRunInfo {
        AgentRunInfo {
            job_id: format!("agent-{status}-{trigger}"),
            provider: "codex".to_string(),
            status: status.to_string(),
            output_file: Some("/tmp/output.txt".to_string()),
            events_file: Some("/tmp/events.jsonl".to_string()),
            created_at: "2026-05-30T01:00:00Z".to_string(),
            updated_at: "2026-05-30T01:02:00Z".to_string(),
            exit_code: if status == "completed" {
                Some(0)
            } else {
                Some(1)
            },
            prompt_preview: Some("Write a report".to_string()),
            sandbox_cwd: Some("/workspace".to_string()),
            stdout_tail: "stdout summary".to_string(),
            stderr_tail: "stderr failure".to_string(),
            error: None,
            pending_approval: None,
            metadata: json!({
                "trigger_id": "trg-test",
                "task_trigger_reason": trigger
            }),
        }
    }

    #[test]
    fn apply_latest_completed_run_clears_task_trigger_error() {
        let mut record = task_trigger_record();
        let run = run_info("completed", "scheduled");

        assert!(apply_latest_run_to_task_trigger(&mut record, Some(&run)));

        assert_eq!(
            record.last_run_id.as_deref(),
            Some("agent-completed-scheduled")
        );
        assert_eq!(record.last_run_at.as_deref(), Some("2026-05-30T01:02:00Z"));
        assert_eq!(record.last_run_status.as_deref(), Some("completed"));
        assert_eq!(record.last_error, None);
        assert_eq!(record.failure_reason, None);
        assert_eq!(record.status, "active");
        assert!(record.enabled);
    }

    #[test]
    fn apply_latest_failed_scheduled_run_pauses_task_trigger() {
        let mut record = task_trigger_record();
        let run = run_info("failed", "scheduled");

        assert!(apply_latest_run_to_task_trigger(&mut record, Some(&run)));

        assert_eq!(record.last_run_status.as_deref(), Some("failed"));
        assert_eq!(record.last_error.as_deref(), Some("stderr failure"));
        assert_eq!(record.failure_reason.as_deref(), Some("stderr failure"));
        assert_eq!(record.status, "error");
        assert!(!record.enabled);
        assert_eq!(record.next_run_at, None);
    }

    #[test]
    fn apply_latest_failed_manual_run_does_not_pause_task_trigger() {
        let mut record = task_trigger_record();
        let run = run_info("failed", "manual");

        assert!(apply_latest_run_to_task_trigger(&mut record, Some(&run)));

        assert_eq!(record.last_run_status.as_deref(), Some("failed"));
        assert_eq!(record.last_error.as_deref(), Some("stderr failure"));
        assert_eq!(record.status, "active");
        assert!(record.enabled);
        assert_eq!(record.next_run_at.as_deref(), Some("2026-06-01T00:00:00Z"));
    }

    #[test]
    fn apply_latest_running_run_updates_status_without_erroring_task_trigger() {
        let mut record = task_trigger_record();
        let run = run_info("running", "scheduled");

        assert!(apply_latest_run_to_task_trigger(&mut record, Some(&run)));

        assert_eq!(record.last_run_status.as_deref(), Some("running"));
        assert_eq!(record.last_error, None);
        assert_eq!(record.failure_reason, None);
        assert_eq!(record.status, "active");
        assert!(record.enabled);
    }

    #[test]
    fn time_task_trigger_driver_controls_schedule_calculation() -> Result<(), ApiError> {
        let driver = task_trigger_driver_for_type("time")?;
        assert_eq!(driver.trigger_type(), "time");

        let now = parse_datetime("2026-06-01T00:00:00Z")?;
        let mut record = task_trigger_record();
        record.kind = "interval".to_string();
        record.interval_seconds = Some(60);
        record.next_run_at = Some("2026-06-01T00:00:00Z".to_string());
        record.missed_run_policy = "skip".to_string();

        assert!(matches!(
            driver.scheduled_decision(&record, now, 15)?,
            TaskTriggerDriverDecision::Fire
        ));

        let later = parse_datetime("2026-06-01T00:01:01Z")?;
        assert_eq!(
            driver.next_after_run(&record, later)?.as_deref(),
            Some("2026-06-01T00:02:00Z")
        );

        let very_late = parse_datetime("2026-06-01T00:02:00Z")?;
        assert!(matches!(
            driver.scheduled_decision(&record, very_late, 15)?,
            TaskTriggerDriverDecision::SkipMissed { .. }
        ));
        Ok(())
    }

    #[test]
    fn waiting_dependencies_keeps_task_trigger_active_for_retry() -> Result<(), ApiError> {
        let mut record = task_trigger_record();
        record.kind = "once".to_string();
        record.next_run_at = Some("2026-06-01T00:00:00Z".to_string());
        let now = parse_datetime("2026-06-01T00:00:00Z")?;
        let retry_at = Some("2026-06-01T00:00:30Z".to_string());

        apply_waiting_dependencies_to_task_trigger(
            &mut record,
            "Waiting for dependencies: act-research",
            retry_at.clone(),
            now,
        );

        assert_eq!(record.status, "active");
        assert!(record.enabled);
        assert_eq!(
            record.last_run_status.as_deref(),
            Some("waiting_dependencies")
        );
        assert_eq!(
            record.last_error.as_deref(),
            Some("Waiting for dependencies: act-research")
        );
        assert_eq!(record.failure_reason, None);
        assert_eq!(record.next_run_at, retry_at);
        assert_eq!(record.updated_at, "2026-06-01T00:00:00Z");
        Ok(())
    }

    #[test]
    fn apply_latest_without_run_preserves_task_trigger_level_error() {
        let mut record = task_trigger_record();
        record.status = "error".to_string();
        record.last_run_id = None;
        record.last_run_at = None;
        record.last_run_status = None;
        record.last_error = Some("cwd must stay inside the user workspace".to_string());
        record.failure_reason = record.last_error.clone();

        assert!(!apply_latest_run_to_task_trigger(&mut record, None));

        assert_eq!(record.status, "error");
        assert_eq!(
            record.last_error.as_deref(),
            Some("cwd must stay inside the user workspace")
        );
        assert_eq!(
            record.failure_reason.as_deref(),
            Some("cwd must stay inside the user workspace")
        );
    }

    #[test]
    fn normalize_run_at_rejects_naive_datetime_for_non_utc_timezone() {
        let result = normalize_run_at(Some("2026-05-28T10:00:00"), "Asia/Shanghai");

        let err = result.expect_err("non-UTC naive datetime should be rejected");
        assert!(format!("{err:?}").contains("timezone offset"));
    }

    #[test]
    fn normalize_run_at_accepts_offset_datetime_for_non_utc_timezone() -> Result<(), ApiError> {
        let run_at = normalize_run_at(Some("2026-05-28T10:00:00+08:00"), "Asia/Shanghai")?;

        assert_eq!(run_at.as_deref(), Some("2026-05-28T02:00:00Z"));
        Ok(())
    }

    #[test]
    fn recurring_task_trigger_completes_action_only_on_final_scheduled_run() {
        let mut record = task_trigger_record();
        record.max_runs = Some(5);
        record.run_count = 3;

        assert!(!should_complete_task_trigger_action(&record, "scheduled"));

        record.run_count = 4;
        assert!(should_complete_task_trigger_action(&record, "scheduled"));
        assert!(!should_complete_task_trigger_action(&record, "manual"));
    }

    #[test]
    fn one_shot_task_trigger_completes_action_on_scheduled_run() {
        let mut record = task_trigger_record();
        record.kind = "once".to_string();
        record.max_runs = None;

        assert!(should_complete_task_trigger_action(&record, "scheduled"));
    }
}
