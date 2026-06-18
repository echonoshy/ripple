use std::path::Path;

use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;

use crate::redaction::redact_value;

pub(super) async fn append_event(
    events_file: &Path,
    sequence: &mut u64,
    job_id: &str,
    provider: &str,
    event_type: &str,
    message: Option<String>,
    data: Value,
) -> anyhow::Result<()> {
    *sequence += 1;
    if let Some(parent) = events_file.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let event = redact_value(&json!({
        "type": event_type,
        "job_id": job_id,
        "provider": provider,
        "sequence": *sequence,
        "message": message,
        "data": data,
        "created_at": now_iso()
    }));
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(events_file)
        .await?;
    file.write_all(serde_json::to_string(&event)?.as_bytes())
        .await?;
    file.write_all(b"\n").await?;
    Ok(())
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}
