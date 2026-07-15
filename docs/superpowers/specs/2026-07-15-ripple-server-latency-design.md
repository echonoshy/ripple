# Ripple Server Latency Remediation Design

Date: 2026-07-15
Status: Ready for final user review

## 1. Problem statement

`ripple-server` has intermittent multi-second server-side latency while its SQLite database and user workspaces remain on NAS. The observed slow path is amplified by application behavior rather than by a single expensive SQL statement:

- chat preflight checks connector status for every request;
- each connector independently counts pending authentication by loading every session and every session message;
- skill manifests are rebuilt from filesystem state during chat preflight;
- session list endpoints load full message histories before paginating;
- maintenance can hold the global active-session write lock while awaiting NAS-backed persistence;
- two background task pollers start together and share the same five-connection SQLite pool;
- NAS stalls therefore spread into pool waits and request-level tail latency.

SQLite will remain on NAS for this change. The design reduces NAS operations on interactive paths and limits internal amplification without changing the public API.

## 2. Goals

1. Remove repeated full-session and full-message reads from chat connector preflight.
2. Avoid external connector CLI checks and filesystem skill scans on every hot chat request.
3. Make session listing proportional to the requested page size rather than total message history.
4. Prevent one slow SQLite write from holding the global active-session lock.
5. Stop background pollers from creating synchronized bursts against the interactive SQLite pool.
6. Add phase-level latency evidence so later SQLite pool tuning is based on measurements.
7. Preserve current API contracts and current `context_folder` behavior.

## 3. Non-goals

This change will not:

- move SQLite away from NAS;
- change SQLite journal mode, synchronous mode, busy timeout, or pool size;
- add or alter database tables or columns;
- change endpoint paths, methods, authentication, status codes, JSON shapes, or SSE event order;
- move `changed_files` out of the existing response or `assistant_done` payload;
- cache or delay changes to a session's selected `context_folder`;
- change context-folder permission, symlink, thread-rotation, or plan-reset semantics;
- switch the live service from its current debug-binary launch mode in the same rollout.

Filesystem context indexing and changed-file scan redesign are deferred to a separately reviewed second phase.

## 4. Compatibility invariants

### 4.1 Public API

All existing public requests and responses must remain contract-compatible. In particular:

- `/sessions` keeps its current ordering, totals, pagination semantics, and response fields;
- connector status endpoints continue to perform an explicit live status check;
- chat responses expose the same skill and connector-derived behavior;
- SSE event names, order, and payload fields remain unchanged;
- Task APIs and trigger behavior remain unchanged.

### 4.2 `context_folder`

The first implementation phase does not change folder-context collection or caching. The existing update flow remains authoritative:

1. acquire the per-session run lock;
2. reject a folder change while work is active or awaiting user action;
3. validate and normalize the new path;
4. persist the new `context_folder_path`;
5. detach and asynchronously archive the previous Codex thread;
6. reset Codex sync progress and plan state;
7. use only the new folder and permission scope on the next chat turn.

Connector and skill caches must never cache `context_folder_path`, `permission_root`, `ContextScope`, or folder search results. Session summary optimization must continue returning the current `context_folder_path` unchanged.

Regression coverage must include `folder A -> folder B -> next chat uses only folder B`, unchanged-folder updates preserving the Codex thread, busy-session rejection, and clearing back to workspace root.

## 5. First-phase design

### 5.1 Batch pending connector-auth counts

Add a storage operation that reads only non-null pending connector-auth JSON for one user:

```sql
SELECT pending_connector_auth_json
FROM sessions
WHERE user_id = ?
  AND pending_connector_auth_json IS NOT NULL
```

Parse this result once into `BTreeMap<String, usize>`. `catalog_connector_statuses` obtains the map once and passes counts into individual connector checks. It must not call `list_sessions`, construct `SessionRecord`, or query `session_messages`.

The explicit single-connector status endpoint may use the same lightweight query for its connector count, but it retains a live health check.

### 5.2 Chat-only connector health cache

Introduce an application-state cache for the connector health values consumed by chat skill-catalog preparation.

- key: user id;
- value: connector connected-state map plus refresh timestamp;
- freshness TTL: 60 seconds;
- hot entry: return immediately;
- expired entry: return the stale value and start one background refresh;
- cold entry: perform one real refresh and let concurrent callers await the same singleflight result;
- refresh failure with a prior value: retain the prior value and log the error;
- refresh failure without a prior value: preserve the current error behavior.

Connector mutation flows must invalidate or update the affected user's cache. Explicit connector status endpoints bypass stale-while-revalidate so their existing live semantics remain intact.

Pending authentication counts are not part of this cache; they remain one lightweight database read per catalog preparation so cancellation and user-action state remain prompt.

### 5.3 Skill manifest cache

Cache the final user skill manifest used by chat preflight.

- key: user id plus connector-status signature;
- TTL: 60 seconds;
- concurrent cold builds use singleflight;
- cold filesystem construction runs on Tokio's blocking pool;
- skill-setting mutations and connector-cache invalidation evict the manifest entry;
- server restart naturally clears all entries;
- external filesystem changes become visible no later than the TTL.

The existing settings reconciliation behavior must still run on cache miss. Cache hits return the same manifest entries and required-skill prompt content as an equivalent current build.

### 5.4 SQL-paginated session summaries

Add a summary-row decoder that does not query `session_messages`. The `/sessions` list implementation performs:

1. a `COUNT(*)` for the user's total;
2. the existing summary-column projection with the same ordering;
3. SQL `LIMIT` and `OFFSET` using the normalized existing pagination inputs.

The API response is assembled with the same fields and values as today. Session detail and chat paths continue using the full record loader where messages are required.

Any other list endpoint migrated in this phase must use a dedicated summary query and contract-equivalence tests; otherwise it remains unchanged rather than sharing a partial record type unsafely.

### 5.5 Session maintenance without a global lock across I/O

Replace the global active-map write-lock/persist sequence with per-session work:

1. collect candidate keys without holding the map lock across I/O;
2. acquire the existing per-session lock for each candidate;
3. re-read and re-check idle eligibility;
4. persist suspension without holding the global active-map lock;
5. briefly reacquire the map lock to reconcile or remove that exact record.

The implementation must not persist a stale snapshot over newly active session state. Existing retention behavior and status transitions remain unchanged. Maintenance failures must be logged instead of silently discarded.

### 5.6 Background poller smoothing

Keep both existing task mechanisms and their public semantics, but prevent synchronized SQLite bursts:

- use `MissedTickBehavior::Skip` for both intervals;
- stagger their initial deadlines by half of the configured poll interval;
- record elapsed time and warn on failures instead of ignoring errors;
- never run catch-up iterations after an NAS stall;
- keep current task selection and execution behavior in this first phase.

Set-based due-only task queries are deferred until the first-phase timings show that scheduler query volume remains material. This avoids combining task-selection semantic changes with the chat-latency fix.

### 5.7 Latency instrumentation

Add structured timings without changing API payloads:

- chat skill preflight total;
- connector cache hit, stale hit, cold refresh, and refresh duration;
- pending-auth batch-query duration;
- skill manifest cache/build duration;
- session summary count/query duration;
- SQLite pool-acquire duration where practical;
- maintenance and task-poller duration and errors;
- existing folder-context and Codex enqueue timings promoted or sampled at an operationally visible level.

Logs must include user/session identifiers only where current privacy conventions allow them and must not include prompts, credentials, tokens, or connector secrets.

## 6. Error handling and cache safety

- Cache state is process-local and disposable; SQLite remains authoritative.
- A failed background refresh never replaces a valid cached value with an error or empty map.
- Singleflight ownership must be released on success, error, cancellation, and panic paths.
- Cache invalidation happens after successful connector or skill mutation persistence.
- Cache code must not hold a cache lock while awaiting CLI, filesystem, or SQLite work.
- Explicit status APIs retain current errors and live checks.
- No cache entry may contain session messages, context-folder contents, or credentials.

## 7. Verification plan

### 7.1 Unit and integration tests

- pending-auth batch counts match the previous per-connector result;
- pending-auth counting executes without loading messages;
- connector cache hot, stale, cold, invalidation, failure, and concurrent singleflight cases;
- skill manifest cache hit, TTL expiry, settings invalidation, and connector-signature separation;
- summary pagination matches current ordering, totals, boundary normalization, and JSON fields;
- maintenance does not hold the global map lock during a blocked persistence operation;
- maintenance does not suspend a session that becomes active;
- poller intervals skip missed ticks and do not start together;
- all current context-folder switching tests remain green;
- add explicit context-folder A-to-B isolation regression coverage.

### 7.2 Contract and build checks

- `cargo fmt --check`;
- `cargo check -p ripple-server`;
- ripple-server test suite;
- existing API smoke tests;
- snapshot or semantic comparison of `/sessions`, connector status, non-stream chat, and SSE event ordering before and after the patch;
- `git diff --check`.

### 7.3 Remote verification

Before restart, preserve the current binary and record the live PID, command, commit, and health result. Build and restart the same `ripple-server-root` service shape without changing SQLite configuration or launch mode. Verify:

- `/health` remains healthy;
- readiness retains its existing authentication behavior;
- context-folder switching and next-turn scope work on a disposable test session;
- connector and session APIs retain their contract;
- hot chat preflight no longer runs repeated full-session queries or external connector checks;
- logs show no repeated four-way session-list cluster from pending-auth counting;
- rollback restores the prior binary without a database migration.

## 8. Rollout and rollback

The first-phase code is one compatibility-focused rollout. It contains no schema migration, so rollback is binary-only.

1. run all local/remote checks;
2. save the previous executable with a timestamped name;
3. restart the exact live tmux service;
4. run health, API-contract, context-folder, and latency smoke checks;
5. watch slow-SQL and chat-preflight timings;
6. restore the prior executable and restart if contract or context isolation fails.

Changing journal mode, pool size, binary profile, folder-context caching, or SSE timing requires a separate measurement and approval cycle.

## 9. Success criteria

- One chat catalog preparation performs at most one lightweight pending-auth query and zero session-message queries for pending-auth counts.
- A hot connector/skill cache path performs no connector CLI probe and no recursive skill filesystem build.
- `/sessions` database work does not grow with the number of session messages outside the requested page.
- No global active-session map lock is held across SQLite I/O.
- Background task pollers do not issue synchronized first-tick queries or catch-up bursts.
- Existing API contract tests and all context-folder regression tests pass unchanged.
- The deployed service remains on the current NAS SQLite path and can be rolled back without data transformation.
