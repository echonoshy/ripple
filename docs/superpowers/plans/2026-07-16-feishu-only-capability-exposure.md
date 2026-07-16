# Feishu-only Capability Exposure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make Feishu the only user-authorizable business capability visible or callable in Ripple chat while keeping Codex runtime capabilities available.

**Architecture:** Add a backward-compatible server.enabled_connectors allowlist to AppConfig and make connector discovery, authorization APIs, Skill manifests, chat prompts, and auto-discovered CLI roots consume it. The live config explicitly enables only feishu, loads only skills/lark, and mounts no generic business CLIs.

**Tech Stack:** Rust, Axum, Serde YAML, Tokio, Cargo tests, nsjail configuration, YAML deployment configuration, tmux-managed Ripple process.

## Global Constraints

- Only Feishu is visible, authorizable, and callable as a user business connector.
- Google Workspace, Notion, Bilibili, Podcast, and future user connectors do not enter chat context unless explicitly enabled.
- Server-side Codex runtime capabilities remain available.
- Existing connector binaries and per-user credentials remain on disk.
- Omitting server.enabled_connectors preserves the current all-connectors behavior.
- Unknown connector names fail configuration loading.
- Disabled connector APIs return the same not-found response as unknown connectors.

## File Map

- crates/ripple-server/src/config.rs: parse, validate, and expose the connector allowlist; gate automatic CLI discovery.
- crates/ripple-server/src/capabilities.rs: return connector definitions allowed by the active config.
- crates/ripple-server/src/api/connectors.rs: filter discovery and reject disabled connector operations.
- crates/ripple-server/src/api/connectors/google_workspace.rs: reject disabled legacy Google aliases and callbacks.
- crates/ripple-server/src/api/bilibili.rs: reject disabled Bilibili QR rendering.
- crates/ripple-server/src/api/capabilities.rs: omit disabled connectors from capability and status catalogs.
- crates/ripple-server/src/skills.rs: exclude skills that require disabled connectors.
- crates/ripple-server/src/api/chat/prompt.rs: render only enabled user connectors in base instructions and turn context.
- crates/ripple-server/src/api/chat.rs: pass connector policy into base-instruction generation.
- config/settings.yaml: activate Feishu-only policy for the live server.
- config/settings.yaml.sample: document the new allowlist and Feishu-only example.

---

### Task 1: Parse and enforce connector policy in runtime configuration

**Files:**
- Modify and test: crates/ripple-server/src/config.rs

**Interfaces:**
- Produces: AppConfig::connector_enabled(&self, name: &str) -> bool
- Produces: AppConfig::enabled_connectors: BTreeSet<String>
- Produces: USER_CONNECTOR_NAMES: &[&str]

- [ ] **Step 1: Write failing config tests**

Add tests that load enabled_connectors: [feishu], assert only Feishu is enabled, assert omitted configuration enables all four registered user connectors, and assert enabled_connectors: [unknown] fails.

~~~rust
#[test]
fn parses_enabled_connectors_allowlist() {
    let config = with_temp_config(
        "enabled-connectors",
        "server:\n  api_keys: [test-key]\n  enabled_connectors: [feishu]\n",
        AppConfig::load,
    )
    .expect("load config");
    assert!(config.connector_enabled("feishu"));
    assert!(!config.connector_enabled("google_workspace"));
    assert!(!config.connector_enabled("notion"));
    assert!(!config.connector_enabled("bilibili"));
}

#[test]
fn rejects_unknown_enabled_connector() {
    let error = with_temp_config(
        "unknown-enabled-connector",
        "server:\n  api_keys: [test-key]\n  enabled_connectors: [unknown]\n",
        AppConfig::load,
    )
    .expect_err("unknown connector must fail");
    assert!(error.to_string().contains(
        "server.enabled_connectors contains unknown connector"
    ));
}
~~~

- [ ] **Step 2: Run tests and verify RED**

Run: cargo test -p ripple-server config::tests::parses_enabled_connectors_allowlist -- --nocapture

Expected: compilation fails because enabled_connectors and connector_enabled do not exist.

- [ ] **Step 3: Implement minimal config policy**

Add BTreeSet, the canonical user connector names, RawServer.enabled_connectors, normalized validation, and:

~~~rust
pub const USER_CONNECTOR_NAMES: &[&str] =
    &["google_workspace", "notion", "feishu", "bilibili"];

impl AppConfig {
    pub fn connector_enabled(&self, name: &str) -> bool {
        self.enabled_connectors.contains(name)
    }
}
~~~

Build lark_cli_install_root only when feishu is enabled, notion_cli_install_root only when notion is enabled, and gogcli_cli_install_root only when google_workspace is enabled. Update every AppConfig test fixture with:

~~~rust
enabled_connectors: USER_CONNECTOR_NAMES
    .iter()
    .map(|name| (*name).to_string())
    .collect(),
~~~

- [ ] **Step 4: Run tests and verify GREEN**

Run: cargo test -p ripple-server config::tests -- --nocapture

Expected: all config tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add crates/ripple-server/src/config.rs
git commit -m "feat(config): add connector exposure allowlist"
~~~

### Task 2: Filter connector catalogs and reject disabled connector APIs

**Files:**
- Modify: crates/ripple-server/src/capabilities.rs
- Modify: crates/ripple-server/src/api/connectors.rs
- Modify: crates/ripple-server/src/api/connectors/google_workspace.rs
- Modify: crates/ripple-server/src/api/bilibili.rs
- Modify: crates/ripple-server/src/api/capabilities.rs
- Test: crates/ripple-server/src/api/mod.rs

**Interfaces:**
- Consumes: AppConfig::connector_enabled
- Produces: enabled_connector_definitions(config: &AppConfig) -> Vec<&'static ConnectorDefinition>
- Produces: ensure_connector_enabled(config: &AppConfig, name: &str) -> Result<&'static ConnectorDefinition, ApiError>

- [ ] **Step 1: Write failing API tests**

Create a test state with enabled_connectors containing only feishu. Assert /v1/connectors contains feishu and runtime capabilities but not google_workspace, notion, or bilibili. Assert status and auth-start requests for notion return 404.

~~~rust
assert_eq!(response.status(), StatusCode::OK);
assert!(connector_names.contains(&"feishu"));
assert!(!connector_names.contains(&"google_workspace"));
assert!(!connector_names.contains(&"notion"));
assert!(!connector_names.contains(&"bilibili"));
assert_eq!(disabled_status.status(), StatusCode::NOT_FOUND);
assert_eq!(disabled_auth.status(), StatusCode::NOT_FOUND);
~~~

- [ ] **Step 2: Run tests and verify RED**

Run: cargo test -p ripple-server api::tests::connector_allowlist -- --nocapture

Expected: the catalog still contains all connectors or disabled endpoints do not return 404.

- [ ] **Step 3: Implement filtering and guards**

Add:

~~~rust
pub fn enabled_connector_definitions(
    config: &AppConfig,
) -> Vec<&'static ConnectorDefinition> {
    connector_definitions()
        .iter()
        .filter(|connector| {
            connector.kind == "runtime_capability"
                || config.connector_enabled(connector.name)
        })
        .collect()
}
~~~

Make list_connectors extract State<AppState>. Use the filtered definitions in connector and capability catalogs. Call a shared ensure_connector_enabled before status, start, complete, cancel, disconnect, and accounts logic. Apply the same check to the Google account alias, Google OAuth callback, and Bilibili QR endpoint.

- [ ] **Step 4: Run tests and verify GREEN**

Run: cargo test -p ripple-server api::tests::connector_allowlist -- --nocapture

Expected: allowlist tests pass and disabled operations return 404.

- [ ] **Step 5: Commit**

~~~bash
git add crates/ripple-server/src/capabilities.rs crates/ripple-server/src/api/connectors.rs crates/ripple-server/src/api/connectors/google_workspace.rs crates/ripple-server/src/api/bilibili.rs crates/ripple-server/src/api/capabilities.rs crates/ripple-server/src/api/mod.rs
git commit -m "feat(connectors): enforce exposure allowlist"
~~~

### Task 3: Remove disabled capabilities from Skill and chat context

**Files:**
- Modify and test: crates/ripple-server/src/skills.rs
- Modify and test: crates/ripple-server/src/api/chat/prompt.rs
- Modify: crates/ripple-server/src/api/chat.rs

**Interfaces:**
- Consumes: AppConfig::connector_enabled
- Consumes: filtered SkillManifestOptions.connector_statuses
- Produces: build_codex_chat_base_instructions(config: &AppConfig) -> String

- [ ] **Step 1: Write failing Skill and prompt tests**

Add a workspace Skill requiring notion, enable only Feishu in the test config, and assert it is absent from build_skill_manifest_with_options. Build base instructions and connector manifest for Feishu-only options and assert they contain feishu but not disabled connector names.

~~~rust
assert!(entries.iter().all(|entry| entry.name != "notion-private-skill"));
assert!(instructions.contains("feishu"));
assert!(!instructions.contains("google_workspace"));
assert!(!instructions.contains("notion"));
assert!(!instructions.contains("bilibili"));
~~~

- [ ] **Step 2: Run tests and verify RED**

Run: cargo test -p ripple-server disabled_connector -- --nocapture

Expected: the disabled Skill or hard-coded connector instructions are still present.

- [ ] **Step 3: Implement Skill and prompt filtering**

Filter loaded entries using:

~~~rust
fn connector_requirements_enabled(
    config: &AppConfig,
    skill: &SkillManifestEntry,
) -> bool {
    skill
        .requires_connectors
        .iter()
        .all(|connector| config.connector_enabled(connector))
}
~~~

Change base-instruction generation to accept &AppConfig and construct the authorization rule from enabled user connectors. Remove the unconditional Bilibili instruction. Render turn connector status from keys present in SkillManifestOptions.connector_statuses, followed by unchanged Codex runtime capabilities. Pass &args.state.config at chat call sites.

- [ ] **Step 4: Run tests and verify GREEN**

Run: cargo test -p ripple-server skills::tests -- --nocapture

Run: cargo test -p ripple-server api::chat::prompt::tests -- --nocapture

Expected: all Skill and prompt tests pass and only Feishu appears in Feishu-only contexts.

- [ ] **Step 5: Commit**

~~~bash
git add crates/ripple-server/src/skills.rs crates/ripple-server/src/api/chat/prompt.rs crates/ripple-server/src/api/chat.rs
git commit -m "feat(chat): expose enabled connectors only"
~~~

### Task 4: Activate Feishu-only deployment settings

**Files:**
- Modify: config/settings.yaml
- Modify: config/settings.yaml.sample

**Interfaces:**
- Consumes: server.enabled_connectors
- Produces: live configuration with only feishu, skills/lark, and lark-cli

- [ ] **Step 1: Apply live settings**

~~~yaml
server:
  enabled_connectors:
    - feishu
  sandbox:
    lark_cli_install_root: "vendor/lark-cli"
    cli_tools: []

skills:
  shared_dirs:
    - "skills/lark"
~~~

Keep existing Google OAuth configuration and user credentials on disk. Document omitted-list compatibility and the Feishu-only example in config/settings.yaml.sample.

- [ ] **Step 2: Validate active config**

Run: cargo test -p ripple-server config::tests -- --nocapture

Expected: configuration parsing succeeds without unknown-connector or YAML errors.

- [ ] **Step 3: Commit**

~~~bash
git add config/settings.yaml config/settings.yaml.sample
git commit -m "chore(config): expose Feishu only"
~~~

### Task 5: Full verification and live rollout

**Files:**
- Verify: all modified files
- Runtime: /root/ripple/target/debug/ripple-server
- Log: /tmp/ripple-server-debug.log

**Interfaces:**
- Produces: live Ripple process on port 8810 with Feishu-only business capabilities

- [ ] **Step 1: Run repository verification**

~~~bash
cargo fmt --check
cargo test -p ripple-server
cargo check -p ripple-server
git diff --check
~~~

Expected: every command exits 0 with no failed tests or whitespace errors.

- [ ] **Step 2: Build live binary**

Run: cargo build -p ripple-server

Expected: exit 0 and a fresh target/debug/ripple-server.

- [ ] **Step 3: Restart tmux-managed service**

~~~bash
tmux kill-session -t ripple-server-root
tmux new-session -d -s ripple-server-root -c /root/ripple 'RUST_LOG=info target/debug/ripple-server > /tmp/ripple-server-debug.log 2>&1'
~~~

Expected: one target/debug/ripple-server process listens on 0.0.0.0:8810.

- [ ] **Step 4: Verify health and connector policy live**

Read the API key from config without printing it. Call /health, /v1/connectors, /v1/capabilities, /v1/connectors/notion/status, and /v1/connectors/feishu/status for a real user sandbox. Verify the catalog contains Feishu and runtime capabilities only, disabled status returns 404, and Feishu reaches its normal status response.

- [ ] **Step 5: Verify a fresh sandbox and chat context**

Use a fresh test user sandbox. Assert lark-cli exists inside nsjail and gog, ntn, Bilibili, and Podcast commands are absent. Start a new chat and inspect the saved runtime prompt context to confirm Lark Skills are present and disabled connector names are absent.

- [ ] **Step 6: Confirm final repository state**

~~~bash
git status --short
git log -5 --oneline
~~~

Expected: only the pre-existing config/settings.yaml.bak.20260629161440 remains untracked, and implementation commits appear above design commit b3427a5.
