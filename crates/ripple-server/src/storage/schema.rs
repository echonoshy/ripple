use serde_json::Value;
use sqlx::{Row, SqlitePool};

pub const CURRENT_SCHEMA_VERSION: i64 = 10;

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS sessions (
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    title TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL,
    max_turns INTEGER NOT NULL,
    caller_system_prompt TEXT,
    project_id TEXT,
    project_name TEXT,
    project_root TEXT,
    context_folder_path TEXT,
    total_input_tokens INTEGER NOT NULL DEFAULT 0,
    total_output_tokens INTEGER NOT NULL DEFAULT 0,
    last_input_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_active TEXT NOT NULL,
    status TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    pending_question TEXT,
    pending_options_json TEXT,
    pending_permission_request_json TEXT,
    pending_connector_auth_json TEXT,
    pending_control_request_json TEXT,
    codex_thread_id TEXT,
    memory_disabled INTEGER NOT NULL DEFAULT 0,
    plan_steps_json TEXT NOT NULL DEFAULT '[]',
    plan_progress_json TEXT,
    PRIMARY KEY (user_id, session_id)
);

CREATE TABLE IF NOT EXISTS session_messages (
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    message_json TEXT NOT NULL,
    PRIMARY KEY (user_id, session_id, seq),
    FOREIGN KEY (user_id, session_id)
        REFERENCES sessions(user_id, session_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    session_id TEXT,
    provider TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    task_trigger_id TEXT,
    events_file TEXT,
    output_file TEXT,
    record_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_triggers (
    user_id TEXT NOT NULL,
    trigger_id TEXT NOT NULL,
    status TEXT NOT NULL,
    next_run_at TEXT,
    updated_at TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (user_id, trigger_id)
);

CREATE TABLE IF NOT EXISTS tasks (
    user_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    status TEXT NOT NULL,
    priority TEXT NOT NULL,
    due_at TEXT,
    source_session_id TEXT,
    updated_at TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (user_id, task_id)
);

CREATE TABLE IF NOT EXISTS task_actions (
    user_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    next_wakeup_at TEXT,
    updated_at TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (user_id, task_id, action_id)
);

CREATE TABLE IF NOT EXISTS task_events (
    user_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (user_id, task_id, event_id)
);

CREATE TABLE IF NOT EXISTS documents (
    user_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (user_id, document_id)
);

CREATE TABLE IF NOT EXISTS file_refs (
    file_id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    storage_backend TEXT NOT NULL,
    storage_uri TEXT NOT NULL,
    workspace_path TEXT,
    mime_type TEXT,
    size_bytes INTEGER,
    sha256 TEXT,
    created_at TEXT NOT NULL,
    linked_session_id TEXT
);

CREATE TABLE IF NOT EXISTS token_usage_events (
    event_id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    session_id TEXT,
    job_id TEXT,
    task_trigger_id TEXT,
    turn_id TEXT,
    source TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
    model_context_window INTEGER,
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    record_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_profiles (
    user_id TEXT PRIMARY KEY NOT NULL,
    avatar_uri TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_users (
    user_id TEXT PRIMARY KEY NOT NULL,
    login TEXT NOT NULL,
    login_normalized TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    disabled_at TEXT
);

CREATE TABLE IF NOT EXISTS auth_invites (
    invite_id TEXT PRIMARY KEY NOT NULL,
    code_hash TEXT NOT NULL UNIQUE,
    max_uses INTEGER NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT,
    disabled_at TEXT
);

CREATE TABLE IF NOT EXISTS auth_sessions (
    session_id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    revoked_at TEXT,
    user_agent TEXT,
    FOREIGN KEY (user_id)
        REFERENCES auth_users(user_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_last_active
    ON sessions(user_id, last_active);
CREATE INDEX IF NOT EXISTS idx_sessions_user_status
    ON sessions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_session_messages_user_session_seq
    ON session_messages(user_id, session_id, seq);
CREATE INDEX IF NOT EXISTS idx_jobs_user_updated
    ON jobs(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_jobs_user_session
    ON jobs(user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_jobs_user_status
    ON jobs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_task_triggers_user_status_next
    ON task_triggers(user_id, status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_tasks_user_status_due
    ON tasks(user_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_user_session_status
    ON tasks(user_id, source_session_id, status);
CREATE INDEX IF NOT EXISTS idx_task_actions_user_task_status_next
    ON task_actions(user_id, task_id, status, next_wakeup_at);
CREATE INDEX IF NOT EXISTS idx_documents_user_updated
    ON documents(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_file_refs_user_workspace_path
    ON file_refs(user_id, workspace_path);
CREATE INDEX IF NOT EXISTS idx_token_usage_events_user_occurred
    ON token_usage_events(user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_events_user_session
    ON token_usage_events(user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_events_user_job
    ON token_usage_events(user_id, job_id);
CREATE INDEX IF NOT EXISTS idx_auth_users_status
    ON auth_users(status);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user
    ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_token
    ON auth_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_auth_invites_code
    ON auth_invites(code_hash);
"#;

pub(super) async fn initialize_schema(pool: &SqlitePool) -> anyhow::Result<()> {
    for statement in SCHEMA_SQL.split(';') {
        let statement = statement.trim();
        if statement.is_empty() {
            continue;
        }
        sqlx::query(statement).execute(pool).await?;
    }
    ensure_schema_columns(pool).await?;
    ensure_legacy_schedule_schema_removed(pool).await?;
    ensure_schema_migrations(pool).await?;
    Ok(())
}

async fn ensure_schema_columns(pool: &SqlitePool) -> anyhow::Result<()> {
    let mut rows = sqlx::query("PRAGMA table_info(sessions)")
        .fetch_all(pool)
        .await?;
    let has_pending_schedule_request = rows
        .iter()
        .any(|row| row.get::<String, _>("name") == "pending_schedule_request_json");
    let has_pending_control_request = rows
        .iter()
        .any(|row| row.get::<String, _>("name") == "pending_control_request_json");
    if has_pending_schedule_request && !has_pending_control_request {
        sqlx::query(
            "ALTER TABLE sessions RENAME COLUMN pending_schedule_request_json TO pending_control_request_json",
        )
        .execute(pool)
        .await?;
        rows = sqlx::query("PRAGMA table_info(sessions)")
            .fetch_all(pool)
            .await?;
    }
    for (column, ddl) in [
        (
            "pinned",
            "ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "project_id",
            "ALTER TABLE sessions ADD COLUMN project_id TEXT",
        ),
        (
            "project_name",
            "ALTER TABLE sessions ADD COLUMN project_name TEXT",
        ),
        (
            "project_root",
            "ALTER TABLE sessions ADD COLUMN project_root TEXT",
        ),
        (
            "context_folder_path",
            "ALTER TABLE sessions ADD COLUMN context_folder_path TEXT",
        ),
        (
            "memory_disabled",
            "ALTER TABLE sessions ADD COLUMN memory_disabled INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "pending_control_request_json",
            "ALTER TABLE sessions ADD COLUMN pending_control_request_json TEXT",
        ),
    ] {
        let exists = rows
            .iter()
            .any(|row| row.get::<String, _>("name") == column);
        if !exists {
            sqlx::query(ddl).execute(pool).await?;
        }
    }
    sqlx::query("UPDATE sessions SET project_id = NULL, project_name = NULL, project_root = NULL")
        .execute(pool)
        .await?;
    sqlx::query("DROP INDEX IF EXISTS idx_projects_user_last_active")
        .execute(pool)
        .await?;
    sqlx::query("DROP TABLE IF EXISTS projects")
        .execute(pool)
        .await?;
    for statement in [
        "DROP INDEX IF EXISTS idx_follow_ups_user_session_status_next",
        "DROP INDEX IF EXISTS idx_follow_ups_status_next",
        "DROP INDEX IF EXISTS idx_session_objects_user_session_status",
        "DROP INDEX IF EXISTS idx_session_actions_user_session_status_next",
        "DROP INDEX IF EXISTS idx_session_actions_object",
        "DROP TABLE IF EXISTS follow_ups",
        "DROP TABLE IF EXISTS session_objects",
        "DROP TABLE IF EXISTS session_actions",
    ] {
        sqlx::query(statement).execute(pool).await?;
    }
    Ok(())
}

async fn ensure_legacy_schedule_schema_removed(pool: &SqlitePool) -> anyhow::Result<()> {
    rebuild_jobs_without_schedule_columns(pool).await?;
    for statement in [
        "DROP INDEX IF EXISTS idx_jobs_user_schedule",
        "DROP INDEX IF EXISTS idx_jobs_user_schedule_id",
        "DROP INDEX IF EXISTS idx_schedules_user_status_next",
        "DROP TABLE IF EXISTS schedules",
    ] {
        sqlx::query(statement).execute(pool).await?;
    }
    ensure_current_job_indexes(pool).await?;
    Ok(())
}

async fn rebuild_jobs_without_schedule_columns(pool: &SqlitePool) -> anyhow::Result<()> {
    let rows = sqlx::query("PRAGMA table_info(jobs)")
        .fetch_all(pool)
        .await?;
    let columns = rows
        .iter()
        .map(|row| row.get::<String, _>("name"))
        .collect::<Vec<_>>();
    let has_schedule_id = columns.iter().any(|column| column == "schedule_id");
    let has_task_trigger_id = columns.iter().any(|column| column == "task_trigger_id");
    if !has_schedule_id && has_task_trigger_id {
        return Ok(());
    }

    let job_rows = sqlx::query(
        r#"
        SELECT job_id, user_id, session_id, provider, status, created_at, updated_at,
               events_file, output_file, record_json
        FROM jobs
        "#,
    )
    .fetch_all(pool)
    .await?;

    sqlx::query("DROP TABLE IF EXISTS jobs_legacy_schedule_rebuild")
        .execute(pool)
        .await?;
    sqlx::query("ALTER TABLE jobs RENAME TO jobs_legacy_schedule_rebuild")
        .execute(pool)
        .await?;
    sqlx::query(
        r#"
        CREATE TABLE jobs (
            job_id TEXT PRIMARY KEY NOT NULL,
            user_id TEXT NOT NULL,
            session_id TEXT,
            provider TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            task_trigger_id TEXT,
            events_file TEXT,
            output_file TEXT,
            record_json TEXT NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;

    for row in job_rows {
        let record_json = strip_legacy_schedule_metadata(&row.get::<String, _>("record_json"));
        sqlx::query(
            r#"
            INSERT INTO jobs (
                job_id, user_id, session_id, provider, status, created_at, updated_at,
                task_trigger_id, events_file, output_file, record_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
            "#,
        )
        .bind(row.get::<String, _>("job_id"))
        .bind(row.get::<String, _>("user_id"))
        .bind(row.get::<Option<String>, _>("session_id"))
        .bind(row.get::<String, _>("provider"))
        .bind(row.get::<String, _>("status"))
        .bind(row.get::<String, _>("created_at"))
        .bind(row.get::<String, _>("updated_at"))
        .bind(row.get::<Option<String>, _>("events_file"))
        .bind(row.get::<Option<String>, _>("output_file"))
        .bind(record_json)
        .execute(pool)
        .await?;
    }

    sqlx::query("DROP TABLE IF EXISTS jobs_legacy_schedule_rebuild")
        .execute(pool)
        .await?;
    Ok(())
}

async fn ensure_current_job_indexes(pool: &SqlitePool) -> anyhow::Result<()> {
    for statement in [
        "CREATE INDEX IF NOT EXISTS idx_jobs_user_updated ON jobs(user_id, updated_at)",
        "CREATE INDEX IF NOT EXISTS idx_jobs_user_session ON jobs(user_id, session_id)",
        "CREATE INDEX IF NOT EXISTS idx_jobs_user_status ON jobs(user_id, status)",
        "CREATE INDEX IF NOT EXISTS idx_jobs_user_task_trigger ON jobs(user_id, task_trigger_id)",
    ] {
        sqlx::query(statement).execute(pool).await?;
    }
    Ok(())
}

fn strip_legacy_schedule_metadata(record_json: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(record_json) else {
        return record_json.to_string();
    };
    let Some(object) = value.as_object_mut() else {
        return record_json.to_string();
    };
    for key in ["schedule_id", "schedule_title", "schedule_trigger"] {
        object.remove(key);
    }
    serde_json::to_string(&value).unwrap_or_else(|_| record_json.to_string())
}

async fn ensure_schema_migrations(pool: &SqlitePool) -> anyhow::Result<()> {
    for (version, name) in [
        (1_i64, "initial_sqlite_control_plane"),
        (2_i64, "lightweight_user_auth_shell"),
        (3_i64, "project_context_v1"),
        (4_i64, "user_profile_avatar_uri"),
        (5_i64, "session_context_folder_scope"),
        (8_i64, "task_system_v1"),
        (9_i64, "task_triggers_replace_schedules"),
        (10_i64, "token_usage_events_v1"),
    ] {
        sqlx::query("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)")
            .bind(version)
            .bind(name)
            .execute(pool)
            .await?;
    }
    Ok(())
}
