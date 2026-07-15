# Ripple Server NAS Latency Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove application-amplified NAS/SQLite latency from `ripple-server` chat preflight and session listing while preserving every existing public API and `context_folder` behavior.

**Architecture:** Introduce process-local, generation-fenced TTL caches for connector health and skill manifests, split connector health from pending-auth presentation, and replace full session/message loads with focused SQLite projections. Keep SQLite configuration and all public contracts unchanged; independently remove global-lock I/O and smooth background pollers.

**Tech Stack:** Rust 1.77.2, Tokio, Axum 0.7, SQLx 0.7.4 with SQLite, Serde/serde_json, tracing.

## Global Constraints

- SQLite remains at the current NAS-backed `.ripple/ripple.sqlite` path.
- Do not change SQLite journal mode, synchronous mode, busy timeout, pool size, schema, or migration version.
- Do not change endpoint paths, HTTP methods, authentication, status codes, request fields, response JSON fields, or SSE event ordering.
- Do not move `changed_files` out of its current response or `assistant_done` payload.
- Do not cache `context_folder_path`, `permission_root`, `ContextScope`, or folder search results.
- Preserve context-folder run locking, busy-session rejection, path validation, Codex-thread rotation, sync reset, plan reset, and next-turn permission scope.
- Direct connector status endpoints remain live checks; chat/capability catalog preparation uses a 60-second connector-health freshness TTL.
- Do not change the live debug-binary launch mode in this rollout.
- Use TDD for every behavior change and commit each independently reviewable task.

## File Structure

- Create `crates/ripple-server/src/catalog_cache.rs`: process-local connector/skill TTL entries, per-user refresh locks, generation fencing, and cache unit tests.
- Modify `crates/ripple-server/src/lib.rs`: register `catalog_cache`; leave router and public surface unchanged.
- Modify `crates/ripple-server/src/state.rs`: add the cloneable `CatalogCache` to `AppState`.
- Modify `crates/ripple-server/src/storage.rs`: add lightweight pending-auth and session-summary queries; retain full-record loaders for detail/chat paths.
- Modify `crates/ripple-server/src/sessions.rs`: map summary rows to `SessionInfo`, expose a paged list method, and remove global active-map I/O from maintenance.
- Modify `crates/ripple-server/src/api/connectors.rs`: split live connector health from pending-auth decoration and invalidate cache after connector mutations.
- Modify `crates/ripple-server/src/api/capabilities.rs`: use cached health/manifest paths and retain capability response construction.
- Modify `crates/ripple-server/src/api/skills.rs`: invalidate only the user's skill-manifest cache after successful settings/content writes.
- Modify `crates/ripple-server/src/api/sessions.rs`: use the paged summary method while returning the identical `/sessions` envelope.
- Modify `crates/ripple-server/src/api/chat.rs`: add server-side preflight timing only; do not alter response or SSE data.
- Modify `crates/ripple-server/src/services/task_triggers.rs` and `crates/ripple-server/src/services/tasks.rs`: skip missed ticks, stagger initial work, and log timings/errors.
- Modify `docs/superpowers/specs/2026-07-15-ripple-server-latency-design.md`: record the health-only catalog refinement discovered during implementation planning.

---

### Task 1: Remove Session and Message Loads from Connector Health

**Files:**
- Modify: `crates/ripple-server/src/storage.rs:1-12,310-335,952-end`
- Modify: `crates/ripple-server/src/api/connectors.rs:69-165`
- Modify: `crates/ripple-server/src/api/capabilities.rs:177-233`
- Test: inline tests in `crates/ripple-server/src/storage.rs`

**Interfaces:**
- Produces: `Storage::pending_connector_auth_counts(&self, user_id: &str) -> anyhow::Result<BTreeMap<String, usize>>`.
- Produces: `connectors::connector_health_value(state, user_id, connector_name) -> Result<Value, ApiError>` with no pending-auth query.
- Preserves: `connectors::connector_status_value(...) -> Result<Value, ApiError>` with the existing response JSON.
- Consumed by Task 2: the health-only connector function is the uncached refresh source.

- [ ] **Step 1: Write a failing storage test proving pending counts do not decode messages**

Add this test inside `storage.rs`'s existing `mod tests`, reusing that module's `Storage::open` setup and `SessionRecord` fixture style:

```rust
#[tokio::test]
async fn pending_connector_auth_counts_ignore_session_messages() -> anyhow::Result<()> {
    let root = std::env::temp_dir().join(format!(
        "ripple-pending-auth-counts-{}",
        uuid::Uuid::new_v4()
    ));
    let storage = Storage::open(root.join("ripple.sqlite"))?;
    let mut notion = test_session_record("alice", "notion-session");
    notion.pending_connector_auth = Some(serde_json::json!({"connector": "notion"}));
    notion.messages = vec![serde_json::json!({"role": "user", "content": "hello"})];
    notion.message_count = 1;
    storage.save_session(&notion).await?;

    let mut feishu = test_session_record("alice", "feishu-session");
    feishu.pending_connector_auth = Some(serde_json::json!({"connector": "feishu"}));
    storage.save_session(&feishu).await?;

    sqlx::query(
        "UPDATE session_messages SET message_json = 'not-json' \
         WHERE user_id = 'alice' AND session_id = 'notion-session'",
    )
    .execute(&storage.pool)
    .await?;

    let counts = storage.pending_connector_auth_counts("alice").await?;
    assert_eq!(counts.get("notion"), Some(&1));
    assert_eq!(counts.get("feishu"), Some(&1));
    assert!(storage.list_sessions("alice").await.is_err());

    let _ = std::fs::remove_dir_all(root);
    Ok(())
}
```

Add this complete fixture beside the test:

```rust
fn test_session_record(user_id: &str, session_id: &str) -> SessionRecord {
    SessionRecord {
        session_id: session_id.to_string(),
        user_id: user_id.to_string(),
        title: String::new(),
        pinned: false,
        context_folder_path: None,
        model: "codex-test".to_string(),
        max_turns: 20,
        caller_system_prompt: None,
        total_input_tokens: 0,
        total_output_tokens: 0,
        last_input_tokens: 0,
        created_at: "2026-07-15T00:00:00Z".to_string(),
        last_active: "2026-07-15T00:00:00Z".to_string(),
        status: "idle".to_string(),
        message_count: 0,
        messages: Vec::new(),
        pending_question: None,
        pending_options: None,
        pending_permission_request: None,
        pending_connector_auth: None,
        pending_control_request: None,
        codex_thread_id: None,
        codex_synced_message_count: 0,
        memory_disabled: false,
        plan_steps: Vec::new(),
        plan_progress: None,
    }
}
```

- [ ] **Step 2: Run the focused test and verify the missing method failure**

Run:

```bash
cargo test -p ripple-server pending_connector_auth_counts_ignore_session_messages -- --nocapture
```

Expected: compilation fails because `pending_connector_auth_counts` does not exist.

- [ ] **Step 3: Implement the lightweight pending-auth projection**

Add `BTreeMap` to the storage imports and implement:

```rust
pub async fn pending_connector_auth_counts(
    &self,
    user_id: &str,
) -> anyhow::Result<BTreeMap<String, usize>> {
    self.initialize().await?;
    let rows = sqlx::query(
        r#"
        SELECT pending_connector_auth_json
        FROM sessions
        WHERE user_id = ? AND pending_connector_auth_json IS NOT NULL
        "#,
    )
    .bind(user_id)
    .fetch_all(&self.pool)
    .await?;

    let mut counts = BTreeMap::new();
    for row in rows {
        let raw = row.get::<String, _>("pending_connector_auth_json");
        let pending = serde_json::from_str::<Value>(&raw)?;
        if let Some(connector) = pending
            .get("connector")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            *counts.entry(connector.to_string()).or_insert(0) += 1;
        }
    }
    Ok(counts)
}
```

- [ ] **Step 4: Split connector health from status decoration**

Move the existing connector-specific `match` into `connector_health_value`. Keep the public/internal status function as a wrapper:

```rust
pub(crate) async fn connector_status_value(
    state: &AppState,
    user_id: &str,
    connector_name: &str,
) -> Result<Value, ApiError> {
    let mut status = connector_health_value(state, user_id, connector_name).await?;
    let counts = state
        .storage
        .pending_connector_auth_counts(user_id)
        .await
        .unwrap_or_default();
    if let Some(count) = counts.get(connector_name).copied().filter(|count| *count > 0) {
        if let Some(object) = status.as_object_mut() {
            object.insert(
                "pending_auth".to_string(),
                json!({"count": count, "cancel_path": format!("/v1/connectors/{connector_name}/auth/cancel")}),
            );
        }
    }
    Ok(status)
}
```

Change `catalog_connector_statuses` to call `connector_health_value` and extract only `connected`. It must perform zero pending-auth reads.

- [ ] **Step 5: Run connector/storage tests**

Run:

```bash
cargo test -p ripple-server pending_connector_auth_counts_ignore_session_messages -- --nocapture
cargo test -p ripple-server connectors -- --nocapture
```

Expected: both commands pass; the malformed message does not affect the count method.

- [ ] **Step 6: Commit Task 1**

```bash
git add crates/ripple-server/src/storage.rs \
  crates/ripple-server/src/api/connectors.rs \
  crates/ripple-server/src/api/capabilities.rs
git commit -m "perf(connectors): remove session loads from status checks"
```

---

### Task 2: Add Generation-Fenced Connector and Skill Catalog Caches

**Files:**
- Create: `crates/ripple-server/src/catalog_cache.rs`
- Modify: `crates/ripple-server/src/lib.rs:1-30`
- Modify: `crates/ripple-server/src/state.rs:1-44`
- Modify: `crates/ripple-server/src/api/capabilities.rs:66-100,177-233`
- Modify: `crates/ripple-server/src/api/connectors.rs:69-390`
- Modify: `crates/ripple-server/src/api/skills.rs:135-395,405-531`
- Modify: `crates/ripple-server/src/api/chat.rs:494-520`
- Test: inline tests in `crates/ripple-server/src/catalog_cache.rs`

**Interfaces:**
- Produces: cloneable `CatalogCache` stored as `AppState::catalog_cache`.
- Produces: `CacheLookup<T> { Fresh(T), Stale(T), Missing }`.
- Produces: connector/skill lookup, generation, conditional-store, invalidation, and per-user refresh-lock methods.
- Consumes: Task 1's `connector_health_value` as the only connector refresh source.
- Preserves: direct `/connectors/{name}/status` live checks.

- [ ] **Step 1: Write failing cache behavior tests**

Create `catalog_cache.rs` with the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn statuses(connected: bool) -> BTreeMap<String, bool> {
        BTreeMap::from([("notion".to_string(), connected)])
    }

    #[test]
    fn invalidation_prevents_stale_refresh_from_repopulating_cache() {
        let cache = CatalogCache::default();
        let generation = cache.connector_generation("alice");
        cache.invalidate_connectors_and_skills("alice");
        assert!(!cache.store_connectors_if_generation(
            "alice",
            generation,
            statuses(true),
        ));
        assert!(matches!(
            cache.lookup_connectors("alice", Duration::from_secs(60)),
            CacheLookup::Missing
        ));
    }

    #[tokio::test]
    async fn concurrent_refreshes_share_one_user_lock() {
        let cache = CatalogCache::default();
        let first = cache.connector_refresh_lock("alice");
        let second = cache.connector_refresh_lock("alice");
        let guard = first.lock().await;
        assert!(second.try_lock().is_err());
        drop(guard);
        assert!(second.try_lock().is_ok());
    }

    #[test]
    fn failed_refresh_leaves_the_stale_value_available() {
        let cache = CatalogCache::default();
        let generation = cache.connector_generation("alice");
        assert!(cache.store_connectors_if_generation(
            "alice",
            generation,
            statuses(true),
        ));
        std::thread::sleep(Duration::from_millis(1));
        assert!(matches!(
            cache.lookup_connectors("alice", Duration::ZERO),
            CacheLookup::Stale(value) if value == statuses(true)
        ));
        assert!(matches!(
            cache.lookup_connectors("alice", Duration::ZERO),
            CacheLookup::Stale(value) if value == statuses(true)
        ));
    }

    #[test]
    fn skill_cache_is_separated_by_connector_signature() {
        let cache = CatalogCache::default();
        let generation = cache.skill_generation("alice");
        let value = SkillCatalogValue {
            options: SkillManifestOptions {
                connector_statuses: statuses(true),
                ..SkillManifestOptions::default()
            },
            entries: Vec::new(),
        };
        assert!(cache.store_skills_if_generation("alice", generation, value));
        assert!(matches!(
            cache.lookup_skills("alice", &statuses(false), Duration::from_secs(60)),
            CacheLookup::Missing
        ));
    }
}
```

- [ ] **Step 2: Run the cache tests and verify they fail**

```bash
cargo test -p ripple-server catalog_cache::tests -- --nocapture
```

Expected: compilation fails because the cache types and methods are not implemented or registered.

- [ ] **Step 3: Implement the cache state without new dependencies**

Use `std::sync::Mutex` only for short map operations and `tokio::sync::Mutex` only for per-user refresh singleflight:

```rust
#[derive(Clone, Debug)]
struct Timed<T> {
    value: T,
    stored_at: Instant,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CacheLookup<T> {
    Fresh(T),
    Stale(T),
    Missing,
}

#[derive(Clone, Debug)]
pub struct SkillCatalogValue {
    pub options: SkillManifestOptions,
    pub entries: Vec<SkillManifestEntry>,
}

#[derive(Default)]
struct CacheState {
    connector_generation: HashMap<String, u64>,
    skill_generation: HashMap<String, u64>,
    connectors: HashMap<String, Timed<BTreeMap<String, bool>>>,
    skills: HashMap<String, Timed<SkillCatalogValue>>,
}

#[derive(Clone, Default)]
pub struct CatalogCache {
    state: Arc<StdMutex<CacheState>>,
    connector_locks: Arc<StdMutex<HashMap<String, Arc<AsyncMutex<()>>>>>,
    skill_locks: Arc<StdMutex<HashMap<String, Arc<AsyncMutex<()>>>>>,
}
```

Implement lookups so `stored_at.elapsed() <= ttl` is fresh and older entries are stale. Implement `store_*_if_generation` so an auth/skill mutation that increments the generation fences out an older in-flight refresh. No cache lock may be held across an `await`.

Use these concrete methods:

```rust
impl CatalogCache {
    pub fn connector_generation(&self, user_id: &str) -> u64 {
        *self
            .state
            .lock()
            .expect("catalog cache poisoned")
            .connector_generation
            .get(user_id)
            .unwrap_or(&0)
    }

    pub fn skill_generation(&self, user_id: &str) -> u64 {
        *self
            .state
            .lock()
            .expect("catalog cache poisoned")
            .skill_generation
            .get(user_id)
            .unwrap_or(&0)
    }

    pub fn lookup_connectors(
        &self,
        user_id: &str,
        ttl: Duration,
    ) -> CacheLookup<BTreeMap<String, bool>> {
        let state = self.state.lock().expect("catalog cache poisoned");
        let Some(entry) = state.connectors.get(user_id) else {
            return CacheLookup::Missing;
        };
        if entry.stored_at.elapsed() <= ttl {
            CacheLookup::Fresh(entry.value.clone())
        } else {
            CacheLookup::Stale(entry.value.clone())
        }
    }

    pub fn store_connectors_if_generation(
        &self,
        user_id: &str,
        generation: u64,
        value: BTreeMap<String, bool>,
    ) -> bool {
        let mut state = self.state.lock().expect("catalog cache poisoned");
        if state.connector_generation.get(user_id).copied().unwrap_or(0) != generation {
            return false;
        }
        state.connectors.insert(
            user_id.to_string(),
            Timed { value, stored_at: Instant::now() },
        );
        true
    }

    pub fn lookup_skills(
        &self,
        user_id: &str,
        connector_statuses: &BTreeMap<String, bool>,
        ttl: Duration,
    ) -> CacheLookup<SkillCatalogValue> {
        let state = self.state.lock().expect("catalog cache poisoned");
        let Some(entry) = state.skills.get(user_id) else {
            return CacheLookup::Missing;
        };
        if &entry.value.options.connector_statuses != connector_statuses {
            return CacheLookup::Missing;
        }
        if entry.stored_at.elapsed() <= ttl {
            CacheLookup::Fresh(entry.value.clone())
        } else {
            CacheLookup::Stale(entry.value.clone())
        }
    }

    pub fn store_skills_if_generation(
        &self,
        user_id: &str,
        generation: u64,
        value: SkillCatalogValue,
    ) -> bool {
        let mut state = self.state.lock().expect("catalog cache poisoned");
        if state.skill_generation.get(user_id).copied().unwrap_or(0) != generation {
            return false;
        }
        state.skills.insert(
            user_id.to_string(),
            Timed { value, stored_at: Instant::now() },
        );
        true
    }

    pub fn invalidate_skills(&self, user_id: &str) {
        let mut state = self.state.lock().expect("catalog cache poisoned");
        *state.skill_generation.entry(user_id.to_string()).or_insert(0) += 1;
        state.skills.remove(user_id);
    }

    pub fn invalidate_connectors_and_skills(&self, user_id: &str) {
        let mut state = self.state.lock().expect("catalog cache poisoned");
        *state.connector_generation.entry(user_id.to_string()).or_insert(0) += 1;
        *state.skill_generation.entry(user_id.to_string()).or_insert(0) += 1;
        state.connectors.remove(user_id);
        state.skills.remove(user_id);
    }

    pub fn connector_refresh_lock(&self, user_id: &str) -> Arc<AsyncMutex<()>> {
        refresh_lock(&self.connector_locks, user_id)
    }

    pub fn skill_refresh_lock(&self, user_id: &str) -> Arc<AsyncMutex<()>> {
        refresh_lock(&self.skill_locks, user_id)
    }
}

fn refresh_lock(
    locks: &StdMutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    user_id: &str,
) -> Arc<AsyncMutex<()>> {
    locks
        .lock()
        .expect("catalog refresh locks poisoned")
        .entry(user_id.to_string())
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}
```

- [ ] **Step 4: Register the cache in application state**

Add `mod catalog_cache;` in `lib.rs`. Add and initialize:

```rust
pub catalog_cache: crate::catalog_cache::CatalogCache,
```

```rust
catalog_cache: crate::catalog_cache::CatalogCache::default(),
```

Do not add router state or API fields.

- [ ] **Step 5: Add cached connector refresh orchestration**

Rename the Task 1 catalog function to `refresh_catalog_connector_statuses`. Add a cached wrapper with a 60-second TTL:

```rust
const CATALOG_CACHE_TTL: Duration = Duration::from_secs(60);

async fn catalog_connector_statuses(
    state: &AppState,
    user_id: &str,
) -> Result<BTreeMap<String, bool>, ApiError> {
    match state.catalog_cache.lookup_connectors(user_id, CATALOG_CACHE_TTL) {
        CacheLookup::Fresh(value) => return Ok(value),
        CacheLookup::Stale(value) => {
            let state = state.clone();
            let user_id = user_id.to_string();
            let lock = state.catalog_cache.connector_refresh_lock(&user_id);
            if let Ok(guard) = lock.try_lock_owned() {
                tokio::spawn(async move {
                    let generation = state.catalog_cache.connector_generation(&user_id);
                    match refresh_catalog_connector_statuses(&state, &user_id).await {
                        Ok(refreshed) => {
                            state.catalog_cache.store_connectors_if_generation(
                                &user_id,
                                generation,
                                refreshed,
                            );
                        }
                        Err(error) => tracing::warn!(
                            user_id = %user_id,
                            error = %error,
                            "connector cache refresh failed"
                        ),
                    }
                    drop(guard);
                });
            }
            return Ok(value);
        }
        CacheLookup::Missing => {}
    }

    let lock = state.catalog_cache.connector_refresh_lock(user_id);
    let _guard = lock.lock().await;
    if let CacheLookup::Fresh(value) =
        state.catalog_cache.lookup_connectors(user_id, CATALOG_CACHE_TTL)
    {
        return Ok(value);
    }
    let generation = state.catalog_cache.connector_generation(user_id);
    let refreshed = refresh_catalog_connector_statuses(state, user_id).await?;
    state.catalog_cache.store_connectors_if_generation(
        user_id,
        generation,
        refreshed.clone(),
    );
    Ok(refreshed)
}
```

Log `fresh`, `stale`, and `cold` paths and refresh duration without logging credentials.

- [ ] **Step 6: Cache skill manifest builds and move cold filesystem work off the async worker**

Extract the existing synchronous build body into this exact boundary:

```rust
fn build_skill_catalog_uncached(
    state: &AppState,
    user_id: &str,
    connector_statuses: BTreeMap<String, bool>,
) -> Result<SkillCatalogValue, ApiError> {
    let settings_file = state.sandboxes.skill_settings_file(user_id)?;
    let mut settings = read_user_skill_settings(&settings_file);
    let initial_options =
        skill_manifest_options_for_user_with_settings(&settings, connector_statuses.clone())?;
    let workspace = state.sandboxes.workspace_dir(user_id)?;
    let mut entries =
        build_skill_manifest_with_options(&state.config, Some(&workspace), &initial_options);
    if reconcile_user_skill_settings_from_entries(state, &mut settings, &entries)? {
        write_user_skill_settings(&settings_file, &settings)?;
    }
    let options = skill_manifest_options_for_user_with_settings(&settings, connector_statuses)?;
    if options != initial_options {
        entries = build_skill_manifest_with_options(&state.config, Some(&workspace), &options);
    }
    Ok(SkillCatalogValue { options, entries })
}
```

After obtaining connector statuses, check `lookup_skills(user_id, &connector_statuses, CATALOG_CACHE_TTL)`. A fresh entry returns immediately. A stale entry returns immediately and uses `skill_refresh_lock` plus generation fencing to spawn one rebuild. A missing entry acquires the same lock, double-checks, and awaits one cold build. Run the synchronous boundary on Tokio's blocking pool:

```rust
let built = tokio::task::spawn_blocking(move || {
    build_skill_catalog_uncached(&build_state, &build_user_id, connector_statuses)
})
.await
.map_err(|error| ApiError::bad_request(format!("skill catalog task failed: {error}")))??;
```

Store only if the captured skill generation is still current. Return cloned `SkillManifestOptions` and `Vec<SkillManifestEntry>` so callers and API JSON remain unchanged.

- [ ] **Step 7: Wire cache invalidation to successful mutations**

In `api/skills.rs`, make the existing synchronous `write_settings` invalidate the user after the file write succeeds:

```rust
write_user_skill_settings(&settings_file, settings)?;
state.catalog_cache.invalidate_skills(user_id);
Ok(())
```

Keep `create_user_skill_draft`, `update_skill`, `delete_skill`, and `validate_skill` on the existing `write_settings(state, user_id, settings)` persistence boundary so each successful mutation performs exactly one cache invalidation after its settings write.

In connector start/complete/cancel/disconnect handlers, restructure each top-level success path to call:

```rust
state
    .catalog_cache
    .invalidate_connectors_and_skills(&user_id);
```

Explicit connector status remains live and does not read from the cache.

- [ ] **Step 8: Add preflight timing without changing payloads**

Wrap `prepare_chat_skill_context` with an `Instant`. Keep normal timings at debug and emit a warning only when at least one second elapses:

```rust
let elapsed_ms = started.elapsed().as_millis() as u64;
if elapsed_ms >= 1_000 {
    tracing::warn!(elapsed_ms, "slow chat skill preflight");
} else {
    tracing::debug!(elapsed_ms, "chat skill preflight completed");
}
```

- [ ] **Step 9: Run cache, capability, connector, and chat tests**

```bash
cargo test -p ripple-server catalog_cache::tests -- --nocapture
cargo test -p ripple-server capabilities -- --nocapture
cargo test -p ripple-server connectors -- --nocapture
cargo test -p ripple-server chat -- --nocapture
```

Expected: all pass; no test observes a public JSON or SSE change.

- [ ] **Step 10: Commit Task 2**

```bash
git add crates/ripple-server/src/catalog_cache.rs \
  crates/ripple-server/src/lib.rs \
  crates/ripple-server/src/state.rs \
  crates/ripple-server/src/api/capabilities.rs \
  crates/ripple-server/src/api/connectors.rs \
  crates/ripple-server/src/api/skills.rs \
  crates/ripple-server/src/api/chat.rs
git commit -m "perf(chat): cache connector and skill preflight"
```

---

### Task 3: Replace `/sessions` Full Message Loads with SQL Pagination

**Files:**
- Modify: `crates/ripple-server/src/storage.rs:30-90,310-370,777-840,952-end`
- Modify: `crates/ripple-server/src/sessions.rs:130-175,310-321,850-900,940-1090`
- Modify: `crates/ripple-server/src/api/sessions.rs:100-119`
- Test: `crates/ripple-server/src/api/mod.rs` existing router-test module
- Test: inline tests in `crates/ripple-server/src/sessions.rs`

**Interfaces:**
- Produces: `StoredSessionSummary` and `StoredSessionSummaryPage` in `storage.rs`.
- Produces: `Storage::list_session_summaries(user_id, requested_offset, requested_limit)`.
- Produces: `SessionManager::list_sessions_page(user_id, requested_offset, requested_limit) -> anyhow::Result<SessionInfoPage>`.
- Preserves: existing `SessionManager::list_sessions` for overview/internal callers in this rollout.

- [ ] **Step 1: Write a failing equivalence and pagination test**

Add an inline `sessions.rs` test that creates: an omitted empty draft, a visible blank-title session whose first textual user message follows a non-text assistant message, a pending-auth session, a selected context folder, and a suspended empty draft.

```rust
#[tokio::test]
async fn paged_session_summaries_match_existing_public_list() -> anyhow::Result<()> {
    let root = std::env::temp_dir().join(format!("ripple-session-page-{}", Uuid::new_v4()));
    let config = test_config(&root);
    let manager = SessionManager::new(config.clone(), SandboxManager::new(config));
    let user_id = "alice";
    let workspace = manager.sandboxes.ensure_sandbox(user_id)?;
    std::fs::create_dir_all(workspace.join("records"))?;

    let _draft = manager.create_session(user_id, CreateSessionInput {
        model: None, max_turns: None, system_prompt: None, context_folder_path: None,
    }).await?;

    let mut visible = manager.create_session(user_id, CreateSessionInput {
        model: None,
        max_turns: None,
        system_prompt: None,
        context_folder_path: Some("/workspace/records".to_string()),
    }).await?;
    visible.messages = vec![
        json!({"role": "assistant", "content": [{"type": "image", "url": "x"}]}),
        json!({"role": "user", "content": [{"type": "text", "text": "derived title"}]}),
    ];
    visible.message_count = visible.messages.len();
    let visible_id = visible.session_id.clone();
    manager.save_record(visible).await?;

    let mut second = manager.create_session(user_id, CreateSessionInput {
        model: None, max_turns: None, system_prompt: None, context_folder_path: None,
    }).await?;
    second.title = "second visible session".to_string();
    second.pinned = true;
    manager.save_record(second).await?;

    let mut pending = manager.create_session(user_id, CreateSessionInput {
        model: None, max_turns: None, system_prompt: None, context_folder_path: None,
    }).await?;
    pending.set_status(SessionStatus::AwaitingUserInput);
    pending.pending_connector_auth = Some(json!({"connector": "notion"}));
    manager.save_record(pending).await?;

    let mut suspended = manager.create_session(user_id, CreateSessionInput {
        model: None, max_turns: None, system_prompt: None, context_folder_path: None,
    }).await?;
    suspended.set_status(SessionStatus::Suspended);
    manager.save_record(suspended).await?;

    let expected = serde_json::to_value(manager.list_sessions(user_id).await?)?;
    let page = manager.list_sessions_page(user_id, 0, None).await?;
    assert_eq!(serde_json::to_value(&page.sessions)?, expected);
    assert_eq!(page.total, page.sessions.len());
    assert_eq!(page.total, 3);
    let selected = page.sessions.iter().find(|item| item.session_id == visible_id).unwrap();
    assert_eq!(selected.context_folder_path.as_deref(), Some("/workspace/records"));
    assert_eq!(selected.title, "derived title");

    let first = manager.list_sessions_page(user_id, 0, Some(1)).await?;
    assert_eq!(first.sessions.len(), 1);
    assert_eq!(first.next_cursor.as_deref(), Some("1"));

    let beyond = manager.list_sessions_page(user_id, 99, Some(1)).await?;
    assert!(beyond.sessions.is_empty());
    assert_eq!(beyond.total, 3);
    assert!(beyond.next_cursor.is_none());

    let _ = std::fs::remove_dir_all(root);
    Ok(())
}
```

- [ ] **Step 2: Run the focused test and verify the missing page method failure**

```bash
cargo test -p ripple-server paged_session_summaries_match_existing_public_list -- --nocapture
```

Expected: compilation fails because `list_sessions_page` is missing.

- [ ] **Step 3: Add the visible-session summary projection**

Define these concrete storage types:

```rust
#[derive(Debug, Clone)]
pub struct StoredSessionSummary {
    pub session_id: String,
    pub title: String,
    pub pinned: bool,
    pub context_folder_path: Option<String>,
    pub model: String,
    pub created_at: String,
    pub last_active: String,
    pub status: String,
    pub message_count: usize,
    pub has_pending_question: bool,
    pub has_pending_options: bool,
    pub has_pending_permission_request: bool,
    pub has_pending_connector_auth: bool,
    pub has_pending_control_request: bool,
    pub title_message_json: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct StoredSessionSummaryPage {
    pub sessions: Vec<StoredSessionSummary>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
}
```

Expose the storage boundary with this signature:

```rust
pub async fn list_session_summaries(
    &self,
    user_id: &str,
    requested_offset: usize,
    requested_limit: Option<usize>,
) -> anyhow::Result<StoredSessionSummaryPage>
```

Define one constant SQL visibility predicate equivalent to `session_should_appear_in_list`:

```rust
const SESSION_LIST_VISIBLE_FILTER: &str = r#"
(
    s.message_count > 0 OR s.pinned != 0 OR TRIM(s.title) != '' OR
    s.total_input_tokens > 0 OR s.total_output_tokens > 0 OR s.last_input_tokens > 0 OR
    TRIM(COALESCE(s.codex_thread_id, '')) != '' OR
    s.pending_question IS NOT NULL OR
    COALESCE(json_array_length(s.pending_options_json), 0) > 0 OR
    s.pending_permission_request_json IS NOT NULL OR
    s.pending_connector_auth_json IS NOT NULL OR
    s.pending_control_request_json IS NOT NULL OR
    COALESCE(json_array_length(s.plan_steps_json), 0) > 0 OR
    s.plan_progress_json IS NOT NULL OR
    s.status NOT IN ('idle', 'suspended')
)
"#;
```

The page query must use `ORDER BY s.last_active DESC LIMIT ? OFFSET ?`. For blank stored titles, select one title-source message using the server's verified SQLite JSON1 support:

```sql
CASE WHEN TRIM(s.title) = '' THEN (
    SELECT sm.message_json
    FROM session_messages sm
    WHERE sm.user_id = s.user_id
      AND sm.session_id = s.session_id
      AND (json_extract(sm.message_json, '$.role') IS NULL
           OR json_extract(sm.message_json, '$.role') = 'user')
      AND (json_extract(sm.message_json, '$.type') IS NULL
           OR json_extract(sm.message_json, '$.type') = 'user')
      AND (
          (json_type(sm.message_json, '$.content') = 'text'
           AND TRIM(json_extract(sm.message_json, '$.content')) != '')
          OR (json_type(sm.message_json, '$.content') = 'array' AND EXISTS (
              SELECT 1 FROM json_each(sm.message_json, '$.content') block
              WHERE json_extract(block.value, '$.type') = 'text'
                AND TRIM(COALESCE(json_extract(block.value, '$.text'), '')) != ''
          ))
      )
    ORDER BY sm.seq ASC
    LIMIT 1
) END AS title_message_json
```

Use the same visibility constant for `COUNT(*)` and page selection so totals and items cannot drift.

- [ ] **Step 4: Map summaries to the exact existing `SessionInfo`**

Add:

```rust
pub struct SessionInfoPage {
    pub sessions: Vec<SessionInfo>,
    pub total: usize,
    pub next_cursor: Option<String>,
}
```

`SessionManager::list_sessions_page` must:

1. use `offset.min(total)`;
2. use `requested_limit.unwrap_or(total).clamp(1, 100)`;
3. derive a blank title by parsing only `title_message_json` and calling `extract_title_from_messages` on a one-element slice;
4. compute the same public status and pending-approval count as `info_from_record`;
5. return `changed_file_count = 0` and `workspace_size_bytes = None`, matching current list behavior;
6. compute `next_cursor` exactly as `paginate` does.

Use a dedicated mapper so the public-status rules remain explicit:

```rust
fn info_from_summary(summary: StoredSessionSummary) -> SessionInfo {
    let title = if summary.title.trim().is_empty() {
        summary
            .title_message_json
            .as_ref()
            .map(|message| extract_title_from_messages(std::slice::from_ref(message)))
            .unwrap_or_default()
    } else {
        summary.title.clone()
    };
    let has_pending_user_work = summary.has_pending_question
        || summary.has_pending_options
        || summary.has_pending_permission_request
        || summary.has_pending_connector_auth
        || summary.has_pending_control_request;
    let status = if summary.has_pending_permission_request {
        "waiting_for_approval"
    } else if matches!(summary.status.as_str(), "awaiting_user_input" | "waiting_for_user")
        && !has_pending_user_work
    {
        "idle"
    } else {
        match summary.status.as_str() {
            "running" => "running",
            "compacting" => "compacting",
            "awaiting_user_input" | "waiting_for_user" => "waiting_for_user",
            "awaiting_permission" | "waiting_for_approval" => "waiting_for_approval",
            "queued" => "queued",
            "completed" => "completed",
            "failed" | "error" => "failed",
            "cancelled" | "canceled" => "cancelled",
            _ => "idle",
        }
    };
    SessionInfo {
        session_id: summary.session_id,
        title,
        pinned: summary.pinned,
        context_folder_path: summary.context_folder_path,
        model: summary.model,
        created_at: summary.created_at,
        last_active: summary.last_active,
        message_count: summary.message_count,
        status: status.to_string(),
        changed_file_count: 0,
        pending_approval_count: u32::from(summary.has_pending_permission_request),
        workspace_size_bytes: None,
    }
}
```

- [ ] **Step 5: Switch only the `/sessions` endpoint**

Parse the cursor with the same error text, call `list_sessions_page`, and retain the envelope:

```rust
let requested_offset = query
    .cursor
    .as_deref()
    .map(|value| value.parse::<usize>())
    .transpose()
    .map_err(|_| ApiError::bad_request("cursor must be a non-negative integer"))?
    .unwrap_or(0);
let page = state
    .sessions
    .list_sessions_page(&user_id, requested_offset, query.limit)
    .await?;
let count = page.sessions.len();
Ok(Json(json!({
    "sessions": page.sessions,
    "count": count,
    "total": page.total,
    "next_cursor": page.next_cursor
})))
```

Do not change `/sessions/overview` in this task.

- [ ] **Step 6: Add an exact `/sessions` response-contract test**

In the existing `api/mod.rs` test module, create one visible session through `state.sessions`, request `GET /v1/sessions?limit=1`, and assert the envelope and item keys:

```rust
#[tokio::test]
async fn sessions_list_contract_is_stable() {
    let state = test_state(vec!["service-key".to_string()]);
    let mut session = state
        .sessions
        .create_session(
            "session-contract-user",
            CreateSessionInput {
                model: Some("codex-test".to_string()),
                max_turns: None,
                system_prompt: None,
                context_folder_path: None,
            },
        )
        .await
        .unwrap();
    session.title = "contract".to_string();
    session.pinned = true;
    state.sessions.save_record(session).await.unwrap();

    let (status, body) = request_json(
        state.clone(),
        Method::GET,
        "/v1/sessions?limit=1",
        "service-key",
        Some("session-contract-user"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["count"], 1);
    assert_eq!(body["total"], 1);
    assert!(body["next_cursor"].is_null());
    let item = body["sessions"][0].as_object().unwrap();
    let keys = item.keys().map(String::as_str).collect::<BTreeSet<_>>();
    assert_eq!(keys, BTreeSet::from([
        "changed_file_count", "context_folder_path", "created_at", "last_active",
        "message_count", "model", "pending_approval_count", "pinned", "session_id",
        "status", "title", "workspace_size_bytes",
    ]));

    let (bad_status, bad_body) = request_json(
        state,
        Method::GET,
        "/v1/sessions?cursor=bad",
        "service-key",
        Some("session-contract-user"),
        None,
    )
    .await;
    assert_eq!(bad_status, StatusCode::BAD_REQUEST);
    assert!(bad_body.to_string().contains("cursor must be a non-negative integer"));
}
```

Add `use std::collections::BTreeSet;` and `use crate::sessions::CreateSessionInput;` to the test module imports; merge them with an existing grouped import when present.

- [ ] **Step 7: Run list, context-folder, and storage tests**

```bash
cargo test -p ripple-server paged_session_summaries_match_existing_public_list -- --nocapture
cargo test -p ripple-server list_sessions_ -- --nocapture
cargo test -p ripple-server context_folder -- --nocapture
cargo test -p ripple-server storage::tests -- --nocapture
cargo test -p ripple-server sessions_list_contract_is_stable -- --nocapture
```

Expected: all pass; the new list and old list serialize identically for the test fixture.

- [ ] **Step 8: Commit Task 3**

```bash
git add crates/ripple-server/src/storage.rs \
  crates/ripple-server/src/sessions.rs \
  crates/ripple-server/src/api/sessions.rs \
  crates/ripple-server/src/api/mod.rs
git commit -m "perf(sessions): paginate summaries without loading messages"
```

---

### Task 4: Remove SQLite Await from the Global Active-Session Lock

**Files:**
- Modify: `crates/ripple-server/src/storage.rs:338-370,952-end`
- Modify: `crates/ripple-server/src/sessions.rs:680-735,1090-end`
- Test: inline tests in `crates/ripple-server/src/sessions.rs`

**Interfaces:**
- Preserves: `SessionManager::suspend_idle_and_cleanup() -> anyhow::Result<(usize, usize)>`.
- Consumes: existing `SessionManager::session_lock(user_id, session_id)`.
- Produces: `Storage::list_expired_suspended_session_ids(user_id, cutoff) -> anyhow::Result<Vec<String>>`.
- Produces no API or storage-schema changes.

- [ ] **Step 1: Write a failing per-session serialization test**

```rust
#[tokio::test]
async fn maintenance_waits_for_session_lock_without_holding_active_map_lock() -> anyhow::Result<()> {
    let root = std::env::temp_dir().join(format!("ripple-maintenance-{}", Uuid::new_v4()));
    let config = test_config(&root);
    let manager = SessionManager::new(config.clone(), SandboxManager::new(config));
    let user_id = "alice";
    let mut record = manager.create_session(user_id, CreateSessionInput {
        model: None, max_turns: None, system_prompt: None, context_folder_path: None,
    }).await?;
    record.last_active = format_time(OffsetDateTime::now_utc() - TimeDuration::seconds(30));
    manager.save_record(record.clone()).await?;

    let session_guard = manager.session_lock(user_id, &record.session_id).lock_owned().await;
    let task_manager = manager.clone();
    let task = tokio::spawn(async move { task_manager.suspend_idle_and_cleanup().await });
    tokio::task::yield_now().await;

    let map_guard = tokio::time::timeout(Duration::from_millis(100), manager.active.write()).await;
    assert!(map_guard.is_ok(), "maintenance held the global active map while waiting");
    drop(map_guard);
    assert!(!task.is_finished(), "maintenance ignored the per-session lock");

    drop(session_guard);
    let (suspended, _) = task.await??;
    assert_eq!(suspended, 1);
    let _ = std::fs::remove_dir_all(root);
    Ok(())
}
```

- [ ] **Step 2: Run the test and confirm current maintenance ignores the session lock**

```bash
cargo test -p ripple-server maintenance_waits_for_session_lock_without_holding_active_map_lock -- --nocapture
```

Expected: FAIL because current maintenance completes or removes the active entry while the per-session lock is held.

- [ ] **Step 3: Refactor maintenance into per-session critical sections**

Replace the global write-lock loop with:

```rust
let keys = self.active.read().await.keys().cloned().collect::<Vec<_>>();
for (user_id, session_id) in keys {
    let _session_guard = self.session_lock(&user_id, &session_id).lock_owned().await;
    let candidate = self
        .active
        .read()
        .await
        .get(&(user_id.clone(), session_id.clone()))
        .cloned();
    let Some(mut record) = candidate else { continue };
    if !should_auto_suspend(&record, now, idle_suspend_seconds) {
        continue;
    }
    record.set_status(SessionStatus::Suspended);
    record.last_active = now_iso();
    self.persist(&record).await?;
    self.active.write().await.remove(&(user_id, session_id));
    suspended += 1;
}
```

The per-session lock prevents a chat/update for the same session from racing the persisted snapshot. No `active` read/write guard may survive across `persist().await`.

- [ ] **Step 4: Log maintenance errors instead of discarding them**

Change the maintenance loop to warn with elapsed time on error and debug-log nonzero suspended/removed counts. Keep the 60-second cadence unchanged.

- [ ] **Step 5: Replace retention's full-record scan with an ID-only query**

Add this storage method:

```rust
pub async fn list_expired_suspended_session_ids(
    &self,
    user_id: &str,
    cutoff: &str,
) -> anyhow::Result<Vec<String>> {
    self.initialize().await?;
    let rows = sqlx::query(
        r#"
        SELECT session_id
        FROM sessions
        WHERE user_id = ? AND status = 'suspended' AND last_active < ?
        ORDER BY last_active ASC
        "#,
    )
    .bind(user_id)
    .bind(cutoff)
    .fetch_all(&self.pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| row.get::<String, _>("session_id"))
        .collect())
}
```

Compute `cutoff` once as `format_time(now - time::Duration::seconds(retention_seconds as i64))`. Iterate the returned IDs, call the existing `delete_session`, and remove the matching session directory. Do not call `storage.list_sessions` from retention maintenance.

Add this storage test, reusing Task 1's `test_session_record` helper:

```rust
#[tokio::test]
async fn expired_suspended_session_ids_do_not_load_messages() -> anyhow::Result<()> {
    let root = std::env::temp_dir().join(format!(
        "ripple-expired-sessions-{}",
        uuid::Uuid::new_v4()
    ));
    let storage = Storage::open(root.join("ripple.sqlite"))?;

    let mut expired = test_session_record("alice", "expired");
    expired.status = "suspended".to_string();
    expired.last_active = "2026-07-14T00:00:00Z".to_string();
    expired.messages = vec![serde_json::json!({"role": "user", "content": "old"})];
    expired.message_count = 1;
    storage.save_session(&expired).await?;

    let mut recent = test_session_record("alice", "recent");
    recent.status = "suspended".to_string();
    recent.last_active = "2026-07-16T00:00:00Z".to_string();
    storage.save_session(&recent).await?;

    let mut idle = test_session_record("alice", "idle");
    idle.status = "idle".to_string();
    idle.last_active = "2026-07-14T00:00:00Z".to_string();
    storage.save_session(&idle).await?;

    sqlx::query(
        "UPDATE session_messages SET message_json = 'not-json' \
         WHERE user_id = 'alice' AND session_id = 'expired'",
    )
    .execute(&storage.pool)
    .await?;

    let ids = storage
        .list_expired_suspended_session_ids("alice", "2026-07-15T12:00:00Z")
        .await?;
    assert_eq!(ids, vec!["expired".to_string()]);

    let _ = std::fs::remove_dir_all(root);
    Ok(())
}
```

- [ ] **Step 6: Run maintenance and context-folder concurrency tests**

```bash
cargo test -p ripple-server maintenance_waits_for_session_lock_without_holding_active_map_lock -- --nocapture
cargo test -p ripple-server context_folder -- --nocapture
cargo test -p ripple-server sessions::tests -- --nocapture
```

Expected: all pass.

- [ ] **Step 7: Commit Task 4**

```bash
git add crates/ripple-server/src/storage.rs crates/ripple-server/src/sessions.rs
git commit -m "fix(sessions): release global lock before persistence"
```

---

### Task 5: Smooth Background Pollers and Expose Slow Internal Phases

**Files:**
- Modify: `crates/ripple-server/src/services/task_triggers.rs`
- Modify: `crates/ripple-server/src/services/tasks.rs`
- Modify: `crates/ripple-server/src/api/capabilities.rs`
- Modify: `crates/ripple-server/src/api/chat.rs`
- Modify: `crates/ripple-server/src/storage.rs`
- Test: inline tests in both service modules

**Interfaces:**
- Preserves: `task_trigger_loop(state)` and `task_action_trigger_loop(state)` signatures.
- Produces: pure `task_action_initial_delay(period: Duration) -> Duration` for deterministic testing.
- Adds logs only; no response payload changes.

- [ ] **Step 1: Write a failing stagger calculation test**

In `services/tasks.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_poller_starts_half_an_interval_after_trigger_poller() {
        assert_eq!(
            task_action_initial_delay(Duration::from_secs(15)),
            Duration::from_millis(7_500)
        );
        assert_eq!(
            task_action_initial_delay(Duration::from_secs(1)),
            Duration::from_millis(500)
        );
    }
}
```

- [ ] **Step 2: Run the test and verify the missing helper failure**

```bash
cargo test -p ripple-server action_poller_starts_half_an_interval_after_trigger_poller
```

Expected: compilation fails because `task_action_initial_delay` is missing.

- [ ] **Step 3: Configure non-bursting intervals**

For trigger polling, preserve the immediate first tick but set skipped missed ticks:

```rust
let period = Duration::from_secs(state.config.task_trigger_poll_interval_seconds);
let mut interval = tokio::time::interval(period);
interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
```

For action polling:

```rust
fn task_action_initial_delay(period: Duration) -> Duration {
    period / 2
}

let period = Duration::from_secs(state.config.task_trigger_poll_interval_seconds);
let start = tokio::time::Instant::now() + task_action_initial_delay(period);
let mut interval = tokio::time::interval_at(start, period);
interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
```

- [ ] **Step 4: Replace ignored poller errors with timed logs**

For each tick:

```rust
let started = std::time::Instant::now();
match trigger_due_task_actions(&state).await {
    Ok(triggered) => tracing::debug!(
        elapsed_ms = started.elapsed().as_millis() as u64,
        user_count = triggered.len(),
        "task action poll completed"
    ),
    Err(error) => tracing::warn!(
        elapsed_ms = started.elapsed().as_millis() as u64,
        error = %error,
        "task action poll failed"
    ),
}
```

Use the corresponding event names for trigger polling. Do not log task payloads.

- [ ] **Step 5: Add slow-operation warnings to the new storage/cache paths**

Keep routine logs at debug. Emit warnings only at these thresholds:

- connector refresh: 1,000 ms;
- skill manifest cold build: 1,000 ms;
- pending-auth query: 500 ms;
- session summary count or page query: 500 ms;
- chat skill preflight total: 1,000 ms;
- maintenance or task poll: 1,000 ms.

Every warning includes `elapsed_ms` and operation name, but no prompt, credential, token, or file content.

- [ ] **Step 6: Run service and focused latency-path tests**

```bash
cargo test -p ripple-server services::tasks::tests -- --nocapture
cargo test -p ripple-server services::task_triggers -- --nocapture
cargo test -p ripple-server catalog_cache::tests -- --nocapture
cargo test -p ripple-server storage::tests -- --nocapture
```

Expected: all pass.

- [ ] **Step 7: Commit Task 5**

```bash
git add crates/ripple-server/src/services/task_triggers.rs \
  crates/ripple-server/src/services/tasks.rs \
  crates/ripple-server/src/api/capabilities.rs \
  crates/ripple-server/src/api/chat.rs \
  crates/ripple-server/src/storage.rs
git commit -m "perf(runtime): stagger background storage work"
```

---

### Task 6: Full Compatibility Verification and Remote Rollout

**Files:**
- Modify only if verification finds a defect in Task 1-5 files.
- Verify: `docs/superpowers/specs/2026-07-15-ripple-server-latency-design.md`
- Verify: `docs/superpowers/plans/2026-07-15-ripple-server-latency-remediation.md`

**Interfaces:**
- Consumes all prior task commits.
- Produces a verified live `ripple-server-root` process on the same endpoint, SQLite path, and launch mode.
- Produces no database migration.

- [ ] **Step 1: Run formatting and static checks**

```bash
cargo fmt --check
cargo check -p ripple-server
git diff --check
```

Expected: all exit 0.

- [ ] **Step 2: Run the complete server test suite**

```bash
cargo test -p ripple-server
```

Expected: every test passes, including all existing and newly added context-folder tests.

- [ ] **Step 3: Inspect public contract diffs before deployment**

```bash
git diff 948e9dc..HEAD -- crates/ripple-server/src/api
git diff 948e9dc..HEAD -- crates/ripple-server/src/api/chat.rs \
  crates/ripple-server/src/api/sessions.rs \
  crates/ripple-server/src/api/connectors.rs
```

Expected: endpoint annotations, paths, status codes, JSON field names, SSE event names/order, `context_folder` update flow, and `assistant_done` construction are unchanged.

- [ ] **Step 4: Record the live baseline and preserve rollback material**

On `root@101.47.179.200`:

```bash
cd /root/ripple
git status --short --branch
git rev-parse HEAD
ps -eo pid,etime,args | grep '[r]ipple-server'
curl -fsS http://127.0.0.1:8810/health
cp target/debug/ripple-server "/tmp/ripple-server.before-latency-fix.$(date +%Y%m%d%H%M%S)"
```

Expected: health succeeds; only the existing untracked settings backup is unrelated; the previous executable is saved outside the repository.

- [ ] **Step 5: Build without changing the binary profile**

```bash
cargo build -p ripple-server
```

Expected: exit 0 and produce `target/debug/ripple-server`.

- [ ] **Step 6: Restart only the verified live tmux service**

Run:

```bash
tmux kill-session -t ripple-server-root
tmux new-session -d -s ripple-server-root -c /root/ripple \
  'RUST_LOG=info target/debug/ripple-server > /tmp/ripple-server-debug.log 2>&1'
for _ in $(seq 1 40); do
  curl -fsS http://127.0.0.1:8810/health >/dev/null && break
  sleep 0.25
done
```

Do not touch the old Python process on port 8811 or any other tmux session.

Expected: the new PID runs `/root/ripple/target/debug/ripple-server` and listens on port 8810.

- [ ] **Step 7: Run health and API smoke verification**

```bash
cd /root/ripple
curl -fsS http://127.0.0.1:8810/health
scripts/smoke-rust-server.sh
RIPPLE_BASE_URL=http://127.0.0.1:8810 scripts/smoke-prod-ripple-request.sh
```

Expected: health succeeds, authenticated API smoke passes, and readiness retains its existing unauthenticated 401 behavior.

- [ ] **Step 8: Verify `context_folder` isolation on a disposable session**

Run this isolated live check from `/root/ripple`; it uses a unique user and cleans up only that user's disposable session/workspace:

```bash
BASE_URL=http://127.0.0.1:8810
USER_ID="latency-smoke-$(date +%s)"
API_KEY="$(awk '
  /^[[:space:]]*api_keys:[[:space:]]*$/ { in_keys=1; next }
  in_keys && /^[^[:space:]]/ { exit }
  in_keys && /^[[:space:]]*-[[:space:]]*/ {
    line=$0
    sub(/^[[:space:]]*-[[:space:]]*/, "", line)
    gsub(/^"|"$/, "", line)
    print line
    exit
  }
' config/settings.yaml)"
AUTH=(-H "Authorization: Bearer $API_KEY" -H "X-Ripple-User-Id: $USER_ID")
WORKSPACE="/nas/ripple-data/sandboxes/$USER_ID/workspace"
SESSION_ID=""

cleanup_latency_smoke() {
  if [[ -n "$SESSION_ID" ]]; then
    curl -fsS -X DELETE "${AUTH[@]}" \
      "$BASE_URL/v1/sessions/$SESSION_ID" >/dev/null 2>&1 || true
  fi
  rm -rf "/nas/ripple-data/sandboxes/$USER_ID"
}
trap cleanup_latency_smoke EXIT

mkdir -p "$WORKSPACE/a" "$WORKSPACE/b"
printf '%s\n' 'A_ONLY context evidence' >"$WORKSPACE/a/context.txt"
printf '%s\n' 'B_ONLY context evidence' >"$WORKSPACE/b/context.txt"

CREATE_RESPONSE="$(curl -fsS "${AUTH[@]}" \
  -H 'Content-Type: application/json' \
  -d '{"model":"codex-low","context_folder_path":"/workspace/a"}' \
  "$BASE_URL/v1/sessions")"
SESSION_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["session_id"])' \
  <<<"$CREATE_RESPONSE")"

FIRST_PAYLOAD="$(python3 -c '
import json,sys
print(json.dumps({
  "model": "codex-low",
  "stream": False,
  "metadata": {"ripple_session_id": sys.argv[1]},
  "input": "Read the selected context folder and reply with A_ONLY."
}))
' "$SESSION_ID")"
curl -fsS -m 240 "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d "$FIRST_PAYLOAD" "$BASE_URL/v1/responses" >/tmp/ripple-context-a-response.json

PATCH_RESPONSE="$(curl -fsS -X PATCH "${AUTH[@]}" \
  -H 'Content-Type: application/json' \
  -d '{"context_folder_path":"/workspace/b"}' \
  "$BASE_URL/v1/sessions/$SESSION_ID")"
python3 -c '
import json,sys
value=json.load(sys.stdin)
assert value["context_folder_path"] == "/workspace/b", value
' <<<"$PATCH_RESPONSE"

SECOND_PAYLOAD="$(python3 -c '
import json,sys
print(json.dumps({
  "model": "codex-low",
  "stream": False,
  "metadata": {"ripple_session_id": sys.argv[1]},
  "input": "Read the selected context folder and reply with B_ONLY."
}))
' "$SESSION_ID")"
curl -fsS -m 240 "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d "$SECOND_PAYLOAD" "$BASE_URL/v1/responses" >/tmp/ripple-context-b-response.json
python3 -c '
import json
value=json.load(open("/tmp/ripple-context-b-response.json"))
event=value.get("ripple_folder_context_search") or {}
assert event.get("context_folder_path") == "/workspace/b", event
assert "/workspace/a" not in json.dumps(event), event
'
```

Expected: current switch behavior is unchanged and no cached folder A state is reused.

- [ ] **Step 9: Verify latency-path evidence**

After at least two requests for the same test user:

```bash
grep -E "chat skill preflight|connector catalog|skill catalog|pending-auth|slow SQL" \
  /tmp/ripple-server-debug.log | tail -200
```

Expected:

- the first request may be a cold refresh;
- the second request records connector/skill cache hits;
- chat catalog preparation performs no `SELECT ... FROM sessions` cluster for connector pending-auth;
- no `session_messages` reads originate from `/sessions` list handling;
- task trigger/action polls are staggered rather than simultaneous.

- [ ] **Step 10: Roll back immediately on any contract or context regression**

If verification fails, run:

```bash
cd /root/ripple
PREVIOUS="$(ls -1t /tmp/ripple-server.before-latency-fix.* | head -n 1)"
tmux kill-session -t ripple-server-root || true
cp "$PREVIOUS" target/debug/ripple-server
tmux new-session -d -s ripple-server-root -c /root/ripple \
  'RUST_LOG=info target/debug/ripple-server > /tmp/ripple-server-debug.log 2>&1'
for _ in $(seq 1 40); do
  curl -fsS http://127.0.0.1:8810/health && break
  sleep 0.25
done
```

No database rollback is required because this plan has no migration.

- [ ] **Step 11: Record final state**

```bash
git status --short --branch
git log -6 --oneline
ps -eo pid,etime,args | grep '[r]ipple-server'
curl -fsS http://127.0.0.1:8810/health
```

Expected: the intended commits are present, only the pre-existing untracked settings backup remains, the new process is healthy, and no unrelated service changed.
