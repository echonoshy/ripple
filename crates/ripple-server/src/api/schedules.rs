use std::collections::BTreeMap;
use std::path::Path as FsPath;

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::de::Error as DeError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::{Duration as TimeDuration, OffsetDateTime, PrimitiveDateTime};
use uuid::Uuid;

use crate::api::run_public::{public_run_value, sanitize_user_visible_value};
use crate::api::users::assert_can_create_run;
use crate::api::{audit_event, paginate, require_confirm, ApiError, ListQuery};
use crate::jobs::{resolve_workspace_cwd, AgentRunCreateRequest, AgentRunInfo};
use crate::state::AppState;
use crate::user::user_id_from_headers;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ScheduleState {
    version: u32,
    schedules: BTreeMap<String, ScheduleRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct ScheduleRecord {
    schedule_id: String,
    user_id: String,
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
    run_count: u64,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct ScheduleCreateInput {
    pub(crate) title: String,
    pub(crate) prompt: String,
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
    #[serde(default = "default_missed_run_policy")]
    pub(crate) missed_run_policy: String,
    #[serde(default = "default_overlap_policy")]
    pub(crate) overlap_policy: String,
    #[serde(default = "default_failure_policy")]
    pub(crate) failure_policy: String,
}

#[derive(Debug, Deserialize, Default)]
pub struct ScheduleUpdateInput {
    title: Option<String>,
    prompt: Option<String>,
    kind: Option<String>,
    timezone: Option<String>,
    #[serde(default, deserialize_with = "nullable_field")]
    run_at: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable_field")]
    interval_seconds: Option<Option<u64>>,
    enabled: Option<bool>,
    #[serde(default, deserialize_with = "nullable_field")]
    cwd: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable_field")]
    model: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable_field")]
    effort: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable_field")]
    summary: Option<Option<String>>,
    #[serde(
        default,
        rename = "outputSchema",
        alias = "output_schema",
        deserialize_with = "nullable_field"
    )]
    output_schema: Option<Option<Value>>,
    max_runtime_seconds: Option<u64>,
    #[serde(default, deserialize_with = "nullable_field")]
    max_runs: Option<Option<u64>>,
    missed_run_policy: Option<String>,
    overlap_policy: Option<String>,
    failure_policy: Option<String>,
}

pub async fn list_schedules(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    let schedules = load_schedule_state(&state, &user_id).await?.schedules;
    let mut records = schedules.values().cloned().collect::<Vec<_>>();
    for record in &mut records {
        reconcile_schedule_record(&state, &user_id, record).await?;
    }
    records.sort_by(|a, b| {
        a.next_run_at
            .clone()
            .unwrap_or_else(|| "9999".to_string())
            .cmp(&b.next_run_at.clone().unwrap_or_else(|| "9999".to_string()))
    });
    let total = records.len();
    let (records, next_cursor) = paginate(records, &query);
    let records = records
        .iter()
        .map(|record| public_schedule_value(&state, &user_id, record))
        .collect::<Vec<_>>();
    Ok(Json(json!({
        "schedules": records,
        "count": records.len(),
        "total": total,
        "next_cursor": next_cursor
    })))
}

pub async fn create_schedule(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<ScheduleCreateInput>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    Ok(Json(
        create_schedule_for_user(&state, &user_id, input).await?,
    ))
}

pub(crate) async fn create_schedule_for_user(
    state: &AppState,
    user_id: &str,
    input: ScheduleCreateInput,
) -> Result<Value, ApiError> {
    let workspace_root = state.sandboxes.ensure_sandbox(user_id)?;
    let now = OffsetDateTime::now_utc();
    let kind = normalize_kind(&input.kind)?;
    let max_runs = normalize_max_runs(kind, input.max_runs)?;
    let interval_seconds = normalize_interval(kind, input.interval_seconds)?;
    let run_at = normalize_run_at(input.run_at.as_deref(), &input.timezone)?;
    let next_run_at = compute_initial_next_run_at(kind, run_at.as_deref(), interval_seconds, now)?;
    let title = clean_required(&input.title, "title")?;
    let prompt = clean_required(&input.prompt, "prompt")?;
    validate_schedule_cwd(&workspace_root, input.cwd.as_deref())?;
    let record = ScheduleRecord {
        schedule_id: format!("sch-{}", &Uuid::new_v4().simple().to_string()[..10]),
        user_id: user_id.to_string(),
        title,
        prompt,
        kind: kind.to_string(),
        timezone: input.timezone.trim().to_string(),
        run_at,
        interval_seconds,
        enabled: input.enabled,
        status: if input.enabled { "active" } else { "paused" }.to_string(),
        next_run_at: if input.enabled { next_run_at } else { None },
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
        max_runs,
        run_count: 0,
        created_at: iso(now),
        updated_at: iso(now),
    };
    persist_schedule_record(state, user_id, &record).await?;
    Ok(public_schedule_value(state, user_id, &record))
}

pub async fn get_schedule(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(schedule_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let Some(mut record) = load_schedule_state(&state, &user_id)
        .await?
        .schedules
        .get(&schedule_id)
        .cloned()
    else {
        return Err(ApiError::not_found("Schedule not found"));
    };
    reconcile_schedule_record(&state, &user_id, &mut record).await?;
    Ok(Json(public_schedule_value(&state, &user_id, &record)))
}

pub async fn update_schedule(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(schedule_id): Path<String>,
    Json(input): Json<ScheduleUpdateInput>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let schedule_state = load_schedule_state(&state, &user_id).await?;
    let Some(mut record) = schedule_state.schedules.get(&schedule_id).cloned() else {
        return Err(ApiError::not_found("Schedule not found"));
    };
    let now = OffsetDateTime::now_utc();
    let timing_changed = input.kind.is_some()
        || input.timezone.is_some()
        || input.run_at.is_some()
        || input.interval_seconds.is_some();

    if let Some(title) = input.title {
        record.title = clean_required(&title, "title")?;
    }
    if let Some(prompt) = input.prompt {
        record.prompt = clean_required(&prompt, "prompt")?;
    }
    if let Some(kind) = input.kind {
        record.kind = normalize_kind(&kind)?.to_string();
    }
    if let Some(timezone) = input.timezone {
        record.timezone = timezone.trim().to_string();
    }
    if let Some(interval_seconds) = input.interval_seconds {
        record.interval_seconds = interval_seconds.map(|value| value.max(1));
    }
    if let Some(run_at) = input.run_at {
        record.run_at = normalize_run_at(run_at.as_deref(), &record.timezone)?;
    }
    if let Some(enabled) = input.enabled {
        record.enabled = enabled;
    }
    if let Some(cwd) = input.cwd {
        record.cwd = cwd;
    }
    if let Some(model) = input.model {
        record.model = model;
    }
    if let Some(effort) = input.effort {
        record.effort = effort;
    }
    if let Some(summary) = input.summary {
        record.summary = summary;
    }
    if let Some(output_schema) = input.output_schema {
        record.output_schema = output_schema;
    }
    if let Some(max_runtime_seconds) = input.max_runtime_seconds {
        record.max_runtime_seconds = max_runtime_seconds.clamp(1, 86_400);
    }
    if let Some(max_runs) = input.max_runs {
        record.max_runs = normalize_max_runs(&record.kind, max_runs)?;
    }
    if let Some(policy) = input.missed_run_policy {
        record.missed_run_policy = normalize_missed_run_policy(&policy)?.to_string();
    }
    if let Some(policy) = input.overlap_policy {
        record.overlap_policy = normalize_overlap_policy(&policy)?.to_string();
    }
    if let Some(policy) = input.failure_policy {
        record.failure_policy = normalize_failure_policy(&policy)?.to_string();
    }
    if record.kind != "interval" {
        record.max_runs = None;
    }
    record.interval_seconds = normalize_interval(&record.kind, record.interval_seconds)?;
    let workspace_root = state.sandboxes.ensure_sandbox(&user_id)?;
    validate_schedule_cwd(&workspace_root, record.cwd.as_deref())?;
    if timing_changed || (record.enabled && record.next_run_at.is_none()) {
        record.next_run_at = compute_initial_next_run_at(
            &record.kind,
            record.run_at.as_deref(),
            record.interval_seconds,
            now,
        )?;
    }
    if schedule_limit_reached(&record) {
        record.enabled = false;
        record.status = "completed".to_string();
        record.next_run_at = None;
    } else if record.enabled {
        record.status = "active".to_string();
    } else if record.status != "completed" {
        record.status = "paused".to_string();
        record.next_run_at = None;
    }
    record.updated_at = iso(now);
    persist_schedule_record(&state, &user_id, &record).await?;
    Ok(Json(public_schedule_value(&state, &user_id, &record)))
}

pub async fn delete_schedule(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(schedule_id): Path<String>,
    body: Option<Json<Value>>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let payload = body.map(|Json(value)| value).unwrap_or_else(|| json!({}));
    if state.config.security.require_confirm_for_risky_api {
        require_confirm(Some(&payload), "schedule.delete")?;
    }
    if !state
        .storage
        .delete_schedule(&user_id, &schedule_id)
        .await?
    {
        return Err(ApiError::not_found("Schedule not found"));
    }
    audit_event(
        &state,
        &user_id,
        "schedule.delete",
        true,
        json!({"schedule_id": schedule_id}),
    )
    .await?;
    Ok(Json(json!({ "ok": true, "schedule_id": schedule_id })))
}

pub async fn schedule_runs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(schedule_id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let Some(mut record) = load_schedule_state(&state, &user_id)
        .await?
        .schedules
        .get(&schedule_id)
        .cloned()
    else {
        return Err(ApiError::not_found("Schedule not found"));
    };
    reconcile_schedule_record(&state, &user_id, &mut record).await?;
    let records = list_schedule_job_records(&state, &user_id, &schedule_id).await?;
    let total = records.len();
    let (records, next_cursor) = paginate(records, &query);
    let records = records
        .iter()
        .map(|run| public_run_value(&state, &user_id, run))
        .collect::<Vec<_>>();
    Ok(Json(json!({
        "runs": records,
        "count": records.len(),
        "total": total,
        "next_cursor": next_cursor
    })))
}

pub async fn delete_schedule_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((schedule_id, job_id)): Path<(String, String)>,
    body: Option<Json<Value>>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let payload = body.map(|Json(value)| value).unwrap_or_else(|| json!({}));
    if state.config.security.require_confirm_for_risky_api {
        require_confirm(Some(&payload), "schedule.run.delete")?;
    }
    let Some(mut record) = load_schedule_state(&state, &user_id)
        .await?
        .schedules
        .get(&schedule_id)
        .cloned()
    else {
        return Err(ApiError::not_found("Schedule not found"));
    };
    let Some(info) = state.jobs.info_for_user(&job_id, &user_id).await? else {
        return Err(ApiError::not_found("Agent run not found"));
    };
    if info.metadata.get("schedule_id").and_then(Value::as_str) != Some(schedule_id.as_str()) {
        return Err(ApiError::not_found("Agent run not found"));
    }
    if state.jobs.is_live_for_user(&job_id, &user_id).await {
        return Err(ApiError::conflict(
            "Active runs must be cancelled before deletion",
        ));
    }
    let Some(info) = state.jobs.delete_for_user(&job_id, &user_id).await? else {
        return Err(ApiError::not_found("Agent run not found"));
    };
    remove_run_files(&state, &user_id, &info).await?;
    reconcile_schedule_record(&state, &user_id, &mut record).await?;
    Ok(Json(json!({
        "ok": true,
        "deleted": true,
        "schedule_id": schedule_id,
        "job_id": job_id
    })))
}

pub async fn run_schedule_now(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(schedule_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let schedule_state = load_schedule_state(&state, &user_id).await?;
    let Some(mut record) = schedule_state.schedules.get(&schedule_id).cloned() else {
        return Err(ApiError::not_found("Schedule not found"));
    };
    reconcile_schedule_record(&state, &user_id, &mut record).await?;
    let now = OffsetDateTime::now_utc();
    let info = match start_schedule_run(&state, &user_id, &record, "manual").await {
        Ok(info) => info,
        Err(err) => {
            record.status = "error".to_string();
            record.last_error = Some(format!("{err:?}"));
            record.failure_reason = record.last_error.clone();
            record.last_run_status = Some("failed".to_string());
            record.updated_at = iso(now);
            persist_schedule_record(&state, &user_id, &record).await?;
            return Err(err);
        }
    };
    apply_latest_run_to_schedule(&mut record, Some(&info));
    if record.enabled && record.status != "completed" {
        record.status = "active".to_string();
    }
    record.updated_at = iso(now);
    persist_schedule_record(&state, &user_id, &record).await?;
    Ok(Json(public_run_value(&state, &user_id, &info)))
}

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
    let now = OffsetDateTime::now_utc();
    let mut triggered = BTreeMap::<String, Vec<String>>::new();
    for user_id in state.storage.list_schedule_user_ids().await? {
        let schedule_state = load_schedule_state(state, &user_id).await?;
        let schedule_ids = schedule_state.schedules.keys().cloned().collect::<Vec<_>>();
        for schedule_id in schedule_ids {
            let Some(mut record) = schedule_state.schedules.get(&schedule_id).cloned() else {
                continue;
            };
            reconcile_schedule_record(state, &user_id, &mut record).await?;
            if !record.enabled || record.status != "active" {
                continue;
            }
            if schedule_limit_reached(&record) {
                record.enabled = false;
                record.status = "completed".to_string();
                record.next_run_at = None;
                record.updated_at = iso(now);
                persist_schedule_record(state, &user_id, &record).await?;
                continue;
            }
            let Some(next_run_at) = record.next_run_at.as_deref() else {
                continue;
            };
            let next_run_at = parse_datetime(next_run_at)?;
            if next_run_at > now {
                continue;
            }
            if should_skip_missed_run(
                &record,
                next_run_at,
                now,
                state.config.schedule_poll_interval_seconds,
            ) {
                record.last_error = None;
                record.failure_reason = None;
                record.last_run_status = Some("skipped_missed".to_string());
                record.status = "active".to_string();
                record.next_run_at = advance_next_run_at(&record, now)?;
                record.updated_at = iso(now);
                persist_schedule_record(state, &user_id, &record).await?;
                continue;
            }
            if record.overlap_policy == "skip"
                && state
                    .jobs
                    .has_active_schedule_run(&user_id, &record.schedule_id)
                    .await
            {
                record.last_error =
                    Some("Skipped because previous run is still active".to_string());
                record.last_run_status = Some("skipped_overlap".to_string());
                record.next_run_at = advance_next_run_at(&record, now)?;
                record.updated_at = iso(now);
                persist_schedule_record(state, &user_id, &record).await?;
                continue;
            }
            match start_schedule_run(state, &user_id, &record, "scheduled").await {
                Ok(info) => {
                    record.last_run_at = Some(iso(now));
                    record.last_run_id = Some(info.job_id);
                    record.last_error = None;
                    record.failure_reason = None;
                    record.last_run_status = Some("started".to_string());
                    record.run_count += 1;
                    if record.kind == "once" || schedule_limit_reached(&record) {
                        record.enabled = false;
                        record.status = "completed".to_string();
                        record.next_run_at = None;
                    } else {
                        record.status = "active".to_string();
                        record.next_run_at = advance_next_run_at(&record, now)?;
                    }
                    record.updated_at = iso(now);
                    persist_schedule_record(state, &user_id, &record).await?;
                    triggered
                        .entry(user_id.clone())
                        .or_default()
                        .push(schedule_id);
                }
                Err(err) => {
                    let summary = format!("{err:?}");
                    record.last_error = Some(summary.clone());
                    record.failure_reason = Some(summary);
                    record.last_run_status = Some("failed".to_string());
                    if record.kind == "interval"
                        && record.failure_policy == "keep_active"
                        && record.enabled
                    {
                        record.status = "active".to_string();
                        record.next_run_at = advance_next_run_at(&record, now)?;
                    } else {
                        if record.failure_policy == "pause" {
                            record.enabled = false;
                        }
                        record.status = "error".to_string();
                        record.next_run_at = None;
                    }
                    record.updated_at = iso(now);
                    persist_schedule_record(state, &user_id, &record).await?;
                }
            }
        }
    }
    Ok(triggered)
}

async fn start_schedule_run(
    state: &AppState,
    user_id: &str,
    record: &ScheduleRecord,
    trigger: &str,
) -> Result<AgentRunInfo, ApiError> {
    let workspace_root = state.sandboxes.ensure_sandbox(user_id)?;
    let runtime_dir = state.sandboxes.sandbox_dir(user_id)?.join("agent-runs");
    let (model, preset_effort) = resolve_schedule_run_model(&state.config, record);
    let create = AgentRunCreateRequest {
        prompt: record.prompt.clone(),
        provider: "codex".to_string(),
        base_instructions: None,
        turn_context: None,
        cwd: record.cwd.clone(),
        input_items: Vec::new(),
        model: Some(model),
        effort: record.effort.clone().or(preset_effort),
        summary: record.summary.clone(),
        output_schema: record.output_schema.clone(),
        max_runtime_seconds: record.max_runtime_seconds,
        schedule_id: Some(record.schedule_id.clone()),
        schedule_title: Some(record.title.clone()),
        schedule_trigger: Some(trigger.to_string()),
        codex_thread_id: None,
        codex_persistent_thread: false,
        chat_user_input: None,
        chat_user_content: None,
    };
    assert_can_create_run(state, user_id, create.max_runtime_seconds).await?;
    state
        .jobs
        .start(
            create,
            user_id.to_string(),
            None,
            workspace_root,
            runtime_dir,
        )
        .await
        .map_err(|err| ApiError::bad_request(err.to_string()))
}

async fn load_schedule_state(state: &AppState, user_id: &str) -> Result<ScheduleState, ApiError> {
    let mut schedules = BTreeMap::new();
    for value in state.storage.list_schedules(user_id).await? {
        if let Ok(record) = serde_json::from_value::<ScheduleRecord>(value) {
            schedules.insert(record.schedule_id.clone(), record);
        }
    }
    Ok(ScheduleState {
        version: 1,
        schedules,
    })
}

async fn persist_schedule_record(
    state: &AppState,
    user_id: &str,
    record: &ScheduleRecord,
) -> Result<(), ApiError> {
    let value = serde_json::to_value(record).map_err(anyhow::Error::from)?;
    state.storage.upsert_schedule(user_id, &value).await?;
    Ok(())
}

fn public_schedule_value(state: &AppState, user_id: &str, record: &ScheduleRecord) -> Value {
    let value = serde_json::to_value(record).unwrap_or_else(|_| json!({}));
    sanitize_user_visible_value(state, user_id, &value)
}

async fn reconcile_schedule_record(
    state: &AppState,
    user_id: &str,
    record: &mut ScheduleRecord,
) -> Result<(), ApiError> {
    let records = list_schedule_job_records(state, user_id, &record.schedule_id).await?;
    if apply_latest_run_to_schedule(record, records.first()) {
        record.updated_at = iso(OffsetDateTime::now_utc());
        persist_schedule_record(state, user_id, record).await?;
    }
    Ok(())
}

async fn list_schedule_job_records(
    state: &AppState,
    user_id: &str,
    schedule_id: &str,
) -> Result<Vec<AgentRunInfo>, ApiError> {
    let mut out = state
        .storage
        .list_jobs_for_schedule(user_id, schedule_id)
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

fn apply_latest_run_to_schedule(
    record: &mut ScheduleRecord,
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
            if run.metadata.get("schedule_trigger").and_then(Value::as_str) == Some("scheduled")
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

async fn remove_run_files(
    state: &AppState,
    user_id: &str,
    run: &AgentRunInfo,
) -> Result<(), ApiError> {
    let sandbox_dir = state.sandboxes.sandbox_dir(user_id)?;
    let sandbox_dir = sandbox_dir.canonicalize().map_err(ApiError::from)?;
    for path in [run.output_file.as_deref(), run.events_file.as_deref()]
        .into_iter()
        .flatten()
    {
        remove_sandbox_file(&sandbox_dir, path).await?;
    }
    Ok(())
}

async fn remove_sandbox_file(sandbox_dir: &FsPath, path: &str) -> Result<(), ApiError> {
    let path = FsPath::new(path);
    let Ok(resolved) = path.canonicalize() else {
        return Ok(());
    };
    if !resolved.starts_with(sandbox_dir) || !resolved.is_file() {
        return Ok(());
    }
    match tokio::fs::remove_file(&resolved).await {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(ApiError::from(err)),
    }
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

fn resolve_schedule_run_model(
    config: &crate::config::AppConfig,
    record: &ScheduleRecord,
) -> (String, Option<String>) {
    config.resolve_model(record.model.as_deref())
}

fn nullable_field<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    let value = Value::deserialize(deserializer)?;
    if value.is_null() {
        return Ok(Some(None));
    }
    T::deserialize(value)
        .map(Some)
        .map(Some)
        .map_err(DeError::custom)
}

fn clean_required(value: &str, field: &str) -> Result<String, ApiError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(ApiError::bad_request(format!("{field} is required")))
    } else {
        Ok(trimmed.to_string())
    }
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
                "interval_seconds is required for interval schedules",
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
            "max_runs is only supported for interval schedules",
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

fn validate_schedule_cwd(workspace_root: &FsPath, cwd: Option<&str>) -> Result<(), ApiError> {
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

fn compute_initial_next_run_at(
    kind: &str,
    run_at: Option<&str>,
    interval_seconds: Option<u64>,
    now: OffsetDateTime,
) -> Result<Option<String>, ApiError> {
    if kind == "once" {
        let Some(run_at) = run_at else {
            return Err(ApiError::bad_request(
                "run_at is required for once schedules",
            ));
        };
        return Ok(Some(iso(parse_datetime(run_at)?)));
    }
    let interval_seconds = interval_seconds.ok_or_else(|| {
        ApiError::bad_request("interval_seconds is required for interval schedules")
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

fn advance_next_run_at(
    record: &ScheduleRecord,
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

fn should_skip_missed_run(
    record: &ScheduleRecord,
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

fn schedule_limit_reached(record: &ScheduleRecord) -> bool {
    record.kind == "interval"
        && record
            .max_runs
            .is_some_and(|max_runs| record.run_count >= max_runs)
}

fn iso(value: OffsetDateTime) -> String {
    value
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn default_kind() -> String {
    "once".to_string()
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        AppConfig, CodexConfig, CorsConfig, FeishuConfig, GogcliOAuthConfig, LoggingConfig,
        ModelPreset, SandboxConfig, SecurityConfig, SkillsConfig, UserAuthConfig,
    };

    fn schedule_record() -> ScheduleRecord {
        ScheduleRecord {
            schedule_id: "sch-test".to_string(),
            user_id: "alice".to_string(),
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
            run_count: 1,
            created_at: "2026-05-30T00:00:00Z".to_string(),
            updated_at: "2026-05-30T00:00:00Z".to_string(),
        }
    }

    fn test_config_with_model_preset() -> AppConfig {
        let root = std::env::temp_dir().join("ripple-schedule-model-test");
        let mut model_presets = BTreeMap::new();
        model_presets.insert(
            "codex-medium".to_string(),
            ModelPreset {
                model: "gpt-5.5".to_string(),
                reasoning_effort: Some("medium".to_string()),
            },
        );
        AppConfig {
            repo_root: root.clone(),
            host: "127.0.0.1".to_string(),
            port: 0,
            api_keys: vec!["test-key".to_string()],
            security: SecurityConfig::default(),
            user_auth: UserAuthConfig::default(),
            api_docs: crate::config::ApiDocsConfig::default(),
            cors: CorsConfig::default(),
            default_model: "codex-medium".to_string(),
            model_presets,
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
                tmpfs_size_mb: 64,
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
                app_server_args: Vec::new(),
                codex_home: None,
                approval_policy: "never".to_string(),
                sandbox_type: "workspace-write".to_string(),
                network_access: true,
                idle_timeout_seconds: 1800,
                max_workers_per_pool: 8,
                max_total_pool_workers: 256,
                max_runtime_seconds: 3600,
            },
            schedule_extraction_max_runtime_seconds: 120,
            schedule_poll_interval_seconds: 15,
            document_preview: crate::config::DocumentPreviewConfig {
                cache_root: root.join("cache/previews"),
                libreoffice_path: "soffice".to_string(),
                max_source_bytes: 64 * 1024 * 1024,
                conversion_timeout_seconds: 120,
            },
            skills: SkillsConfig {
                shared_dirs: Vec::new(),
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
                "schedule_id": "sch-test",
                "schedule_trigger": trigger
            }),
        }
    }

    #[test]
    fn schedule_without_explicit_model_uses_resolved_default_preset() {
        let record = schedule_record();
        let config = test_config_with_model_preset();

        let (model, effort) = resolve_schedule_run_model(&config, &record);

        assert_eq!(model, "gpt-5.5");
        assert_eq!(effort.as_deref(), Some("medium"));
    }

    #[test]
    fn apply_latest_completed_run_clears_schedule_error() {
        let mut record = schedule_record();
        let run = run_info("completed", "scheduled");

        assert!(apply_latest_run_to_schedule(&mut record, Some(&run)));

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
    fn apply_latest_failed_scheduled_run_pauses_schedule() {
        let mut record = schedule_record();
        let run = run_info("failed", "scheduled");

        assert!(apply_latest_run_to_schedule(&mut record, Some(&run)));

        assert_eq!(record.last_run_status.as_deref(), Some("failed"));
        assert_eq!(record.last_error.as_deref(), Some("stderr failure"));
        assert_eq!(record.failure_reason.as_deref(), Some("stderr failure"));
        assert_eq!(record.status, "error");
        assert!(!record.enabled);
        assert_eq!(record.next_run_at, None);
    }

    #[test]
    fn apply_latest_failed_manual_run_does_not_pause_schedule() {
        let mut record = schedule_record();
        let run = run_info("failed", "manual");

        assert!(apply_latest_run_to_schedule(&mut record, Some(&run)));

        assert_eq!(record.last_run_status.as_deref(), Some("failed"));
        assert_eq!(record.last_error.as_deref(), Some("stderr failure"));
        assert_eq!(record.status, "active");
        assert!(record.enabled);
        assert_eq!(record.next_run_at.as_deref(), Some("2026-06-01T00:00:00Z"));
    }

    #[test]
    fn apply_latest_running_run_updates_status_without_erroring_schedule() {
        let mut record = schedule_record();
        let run = run_info("running", "scheduled");

        assert!(apply_latest_run_to_schedule(&mut record, Some(&run)));

        assert_eq!(record.last_run_status.as_deref(), Some("running"));
        assert_eq!(record.last_error, None);
        assert_eq!(record.failure_reason, None);
        assert_eq!(record.status, "active");
        assert!(record.enabled);
    }

    #[test]
    fn apply_latest_without_run_preserves_schedule_level_error() {
        let mut record = schedule_record();
        record.status = "error".to_string();
        record.last_run_id = None;
        record.last_run_at = None;
        record.last_run_status = None;
        record.last_error = Some("cwd must stay inside the user workspace".to_string());
        record.failure_reason = record.last_error.clone();

        assert!(!apply_latest_run_to_schedule(&mut record, None));

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
}
