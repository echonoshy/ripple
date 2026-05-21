use std::collections::BTreeMap;
use std::path::PathBuf;

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::{Duration as TimeDuration, OffsetDateTime, PrimitiveDateTime};
use uuid::Uuid;

use crate::api::ApiError;
use crate::jobs::{AgentRunCreateRequest, AgentRunInfo};
use crate::state::AppState;
use crate::user::user_id_from_headers;

const SCHEDULE_POLL_SECONDS: u64 = 15;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ScheduleState {
    version: u32,
    schedules: BTreeMap<String, ScheduleRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    title: String,
    prompt: String,
    #[serde(default = "default_kind")]
    kind: String,
    #[serde(default = "default_timezone")]
    timezone: String,
    #[serde(default)]
    run_at: Option<String>,
    #[serde(default)]
    interval_seconds: Option<u64>,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    effort: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default, rename = "outputSchema")]
    output_schema: Option<Value>,
    #[serde(default = "default_max_runtime")]
    max_runtime_seconds: u64,
    #[serde(default)]
    max_runs: Option<u64>,
}

#[derive(Debug, Deserialize, Default)]
pub struct ScheduleUpdateInput {
    title: Option<String>,
    prompt: Option<String>,
    kind: Option<String>,
    timezone: Option<String>,
    run_at: Option<String>,
    interval_seconds: Option<u64>,
    enabled: Option<bool>,
    cwd: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    summary: Option<String>,
    #[serde(default, rename = "outputSchema")]
    output_schema: Option<Value>,
    max_runtime_seconds: Option<u64>,
    max_runs: Option<u64>,
}

pub async fn list_schedules(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    let schedules = read_schedule_state(&state, &user_id).await?.schedules;
    let mut records = schedules.values().cloned().collect::<Vec<_>>();
    records.sort_by(|a, b| {
        a.next_run_at
            .clone()
            .unwrap_or_else(|| "9999".to_string())
            .cmp(&b.next_run_at.clone().unwrap_or_else(|| "9999".to_string()))
    });
    Ok(Json(
        json!({ "schedules": records, "count": records.len() }),
    ))
}

pub async fn create_schedule(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<ScheduleCreateInput>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    let mut schedule_state = read_schedule_state(&state, &user_id).await?;
    let now = OffsetDateTime::now_utc();
    let kind = normalize_kind(&input.kind)?;
    let max_runs = normalize_max_runs(kind, input.max_runs)?;
    let interval_seconds = normalize_interval(kind, input.interval_seconds)?;
    let run_at = normalize_run_at(input.run_at.as_deref(), &input.timezone)?;
    let next_run_at = compute_initial_next_run_at(kind, run_at.as_deref(), interval_seconds, now)?;
    let title = clean_required(&input.title, "title")?;
    let prompt = clean_required(&input.prompt, "prompt")?;
    let record = ScheduleRecord {
        schedule_id: format!("sch-{}", &Uuid::new_v4().simple().to_string()[..10]),
        user_id: user_id.clone(),
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
    schedule_state
        .schedules
        .insert(record.schedule_id.clone(), record.clone());
    write_schedule_state(&state, &user_id, &schedule_state).await?;
    Ok(Json(
        serde_json::to_value(record).unwrap_or_else(|_| json!({})),
    ))
}

pub async fn get_schedule(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(schedule_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let Some(record) = read_schedule_state(&state, &user_id)
        .await?
        .schedules
        .get(&schedule_id)
        .cloned()
    else {
        return Err(ApiError::not_found("Schedule not found"));
    };
    Ok(Json(
        serde_json::to_value(record).unwrap_or_else(|_| json!({})),
    ))
}

pub async fn update_schedule(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(schedule_id): Path<String>,
    Json(input): Json<ScheduleUpdateInput>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let mut schedule_state = read_schedule_state(&state, &user_id).await?;
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
        record.interval_seconds = Some(interval_seconds.max(1));
    }
    if let Some(run_at) = input.run_at {
        record.run_at = normalize_run_at(Some(&run_at), &record.timezone)?;
    }
    if let Some(enabled) = input.enabled {
        record.enabled = enabled;
    }
    if let Some(cwd) = input.cwd {
        record.cwd = Some(cwd);
    }
    if let Some(model) = input.model {
        record.model = Some(model);
    }
    if let Some(effort) = input.effort {
        record.effort = Some(effort);
    }
    if let Some(summary) = input.summary {
        record.summary = Some(summary);
    }
    if let Some(output_schema) = input.output_schema {
        record.output_schema = Some(output_schema);
    }
    if let Some(max_runtime_seconds) = input.max_runtime_seconds {
        record.max_runtime_seconds = max_runtime_seconds.clamp(1, 86_400);
    }
    if input.max_runs.is_some() {
        record.max_runs = normalize_max_runs(&record.kind, input.max_runs)?;
    }
    if record.kind != "interval" {
        record.max_runs = None;
    }
    record.interval_seconds = normalize_interval(&record.kind, record.interval_seconds)?;
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
    schedule_state.schedules.insert(schedule_id, record.clone());
    write_schedule_state(&state, &user_id, &schedule_state).await?;
    Ok(Json(
        serde_json::to_value(record).unwrap_or_else(|_| json!({})),
    ))
}

pub async fn delete_schedule(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(schedule_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let mut schedule_state = read_schedule_state(&state, &user_id).await?;
    if schedule_state.schedules.remove(&schedule_id).is_none() {
        return Err(ApiError::not_found("Schedule not found"));
    }
    write_schedule_state(&state, &user_id, &schedule_state).await?;
    Ok(Json(json!({ "ok": true, "schedule_id": schedule_id })))
}

pub async fn schedule_runs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(schedule_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    if !read_schedule_state(&state, &user_id)
        .await?
        .schedules
        .contains_key(&schedule_id)
    {
        return Err(ApiError::not_found("Schedule not found"));
    }
    let records = list_schedule_job_records(&state, &user_id, &schedule_id).await?;
    Ok(Json(json!({ "runs": records, "count": records.len() })))
}

pub async fn run_schedule_now(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(schedule_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    let mut schedule_state = read_schedule_state(&state, &user_id).await?;
    let Some(mut record) = schedule_state.schedules.get(&schedule_id).cloned() else {
        return Err(ApiError::not_found("Schedule not found"));
    };
    let info = start_schedule_run(&state, &user_id, &record, "manual").await?;
    let now = OffsetDateTime::now_utc();
    record.last_run_at = Some(iso(now));
    record.last_run_id = Some(info.job_id.clone());
    record.last_error = None;
    if record.enabled && record.status != "completed" {
        record.status = "active".to_string();
    }
    record.updated_at = iso(now);
    schedule_state.schedules.insert(schedule_id, record);
    write_schedule_state(&state, &user_id, &schedule_state).await?;
    Ok(Json(
        serde_json::to_value(info).unwrap_or_else(|_| json!({})),
    ))
}

pub async fn schedule_trigger_loop(state: AppState) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(SCHEDULE_POLL_SECONDS));
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
    for user_id in state.sandboxes.list_user_sandboxes()? {
        let mut schedule_state = read_schedule_state(state, &user_id).await?;
        let mut changed = false;
        let schedule_ids = schedule_state.schedules.keys().cloned().collect::<Vec<_>>();
        for schedule_id in schedule_ids {
            let Some(mut record) = schedule_state.schedules.get(&schedule_id).cloned() else {
                continue;
            };
            if !record.enabled || record.status != "active" {
                continue;
            }
            if schedule_limit_reached(&record) {
                record.enabled = false;
                record.status = "completed".to_string();
                record.next_run_at = None;
                record.updated_at = iso(now);
                schedule_state.schedules.insert(schedule_id, record);
                changed = true;
                continue;
            }
            let Some(next_run_at) = record.next_run_at.as_deref() else {
                continue;
            };
            let next_run_at = parse_datetime(next_run_at)?;
            if next_run_at > now {
                continue;
            }
            match start_schedule_run(state, &user_id, &record, "scheduled").await {
                Ok(info) => {
                    record.last_run_at = Some(iso(now));
                    record.last_run_id = Some(info.job_id);
                    record.last_error = None;
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
                    schedule_state.schedules.insert(schedule_id.clone(), record);
                    triggered
                        .entry(user_id.clone())
                        .or_default()
                        .push(schedule_id);
                    changed = true;
                }
                Err(err) => {
                    record.enabled = false;
                    record.status = "error".to_string();
                    record.next_run_at = None;
                    record.last_error = Some(format!("{err:?}"));
                    record.updated_at = iso(now);
                    schedule_state.schedules.insert(schedule_id, record);
                    changed = true;
                }
            }
        }
        if changed {
            write_schedule_state(state, &user_id, &schedule_state).await?;
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
    let (model, preset_effort) = match record.model.as_deref() {
        Some(model) => state.config.resolve_model(Some(model)),
        None => (state.config.default_model.clone(), None),
    };
    let create = AgentRunCreateRequest {
        prompt: record.prompt.clone(),
        provider: "codex".to_string(),
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
    };
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

async fn read_schedule_state(state: &AppState, user_id: &str) -> Result<ScheduleState, ApiError> {
    let path = schedule_state_path(state, user_id)?;
    if !path.is_file() {
        return Ok(ScheduleState {
            version: 1,
            schedules: BTreeMap::new(),
        });
    }
    let value = serde_json::from_slice::<ScheduleState>(&tokio::fs::read(path).await?).unwrap_or(
        ScheduleState {
            version: 1,
            schedules: BTreeMap::new(),
        },
    );
    Ok(value)
}

async fn write_schedule_state(
    state: &AppState,
    user_id: &str,
    schedule_state: &ScheduleState,
) -> Result<(), ApiError> {
    let path = schedule_state_path(state, user_id)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(
        path,
        serde_json::to_vec_pretty(schedule_state).map_err(anyhow::Error::from)?,
    )
    .await?;
    Ok(())
}

fn schedule_state_path(state: &AppState, user_id: &str) -> Result<PathBuf, ApiError> {
    Ok(state
        .sandboxes
        .sandbox_dir(user_id)?
        .join("schedules/schedules.json"))
}

async fn list_schedule_job_records(
    state: &AppState,
    user_id: &str,
    schedule_id: &str,
) -> Result<Vec<AgentRunInfo>, ApiError> {
    let root = state
        .sandboxes
        .sandbox_dir(user_id)?
        .join("agent-runs/external-agents");
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let mut entries = tokio::fs::read_dir(root).await?;
    while let Some(entry) = entries.next_entry().await? {
        if !entry.file_type().await?.is_dir() {
            continue;
        }
        let meta_file = entry.path().join("meta.json");
        if !meta_file.is_file() {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&tokio::fs::read(meta_file).await?) else {
            continue;
        };
        if value.get("schedule_id").and_then(Value::as_str) != Some(schedule_id) {
            continue;
        }
        if let Some(info) = agent_run_info_from_record(&value) {
            out.push(info);
        }
    }
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
    })
}

fn record_string(record: &Value, key: &str) -> String {
    record
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
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

fn normalize_run_at(value: Option<&str>, _timezone: &str) -> Result<Option<String>, ApiError> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
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
