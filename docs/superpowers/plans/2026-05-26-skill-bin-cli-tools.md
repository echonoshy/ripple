# Skill Bin CLI Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic configured `skill + bin` integration path and migrate Bilibili skills from Python helper scripts to a single `bilibili` Rust binary.

**Architecture:** Ripple server reads configured CLI tools, mounts each tool root into nsjail, and injects each configured bin dir into both sandbox and Codex app-server PATH. Bilibili business logic lives in a standalone Rust CLI under `crates/bilibili-cli`, with skill Markdown calling `bilibili ... --json` instead of Python pipeline scripts.

**Tech Stack:** Rust 1.77.2, Axum server config, nsjail mount generation, reqwest/rustls, serde JSON, Markdown skills.

---

### Task 1: Generic CLI Tool Configuration

**Files:**
- Modify: `crates/ripple-server/src/config.rs`
- Modify: `crates/ripple-server/src/sandbox.rs`
- Modify: `crates/ripple-server/src/codex/app_server.rs`
- Test: existing unit tests in `crates/ripple-server/src/config.rs` and `crates/ripple-server/src/sandbox.rs`

- [x] Add `CliToolConfig { name, install_root, sandbox_root, bin_dirs }` and `RawCliTool`.
- [x] Write failing config test that parses `server.sandbox.cli_tools`.
- [x] Implement parsing with repo-relative path resolution.
- [x] Write failing sandbox test that checks mount + PATH for `/opt/bilibili-cli/current/bin`.
- [x] Implement generic mount and PATH injection.
- [x] Share PATH injection with Codex app-server startup.

### Task 2: Bilibili CLI Crate

**Files:**
- Modify: `Cargo.toml`
- Create: `crates/bilibili-cli/Cargo.toml`
- Create: `crates/bilibili-cli/src/main.rs`
- Create: `crates/bilibili-cli/src/bilibili.rs`
- Create: `crates/bilibili-cli/src/output.rs`

- [x] Add CLI tests for URL/BV parsing, slug generation, SESSDATA file reading, QR poll URL cookie parsing, and WBI signing.
- [x] Implement `bilibili extract --url ... --json` matching the current Python output shape.
- [x] Implement `bilibili prepare-md --url ... --json` matching the current Python prepare output shape.
- [x] Implement `bilibili auth start/poll/status/logout --json`, storing credentials under `/workspace/.bilibili/sessdata.json` by default.
- [x] Keep stdout as machine JSON and stderr as diagnostics only.

### Task 3: Skills and Server Behavior

**Files:**
- Modify: `skills/bilibili/bilibili-shared/SKILL.md`
- Modify: `skills/bilibili/bilibili-episode-extract/SKILL.md`
- Modify: `skills/bilibili/bilibili-auto-md/SKILL.md`
- Modify: `config/settings.yaml.sample`
- Modify: `config/settings.yaml` only if the local sample-compatible config already carries non-secret tool paths.
- Modify: `crates/ripple-server/src/api/chat.rs`

- [x] Update skill docs to call `bilibili` binary instead of Python scripts.
- [x] Add `metadata.requires.bins: ["bilibili"]` where missing.
- [x] Keep the Markdown generation contract unchanged.
- [x] Add sample `sandbox.cli_tools` entry for Bilibili.
- [x] Relax Bilibili chat auth preflight so ordinary BV/video requests enter Codex and let the skill drive `bilibili auth`.

### Task 4: Verification

**Commands:**
- `cargo fmt`
- `cargo test -p ripple-server`
- `cargo check -p ripple-server`
- `cargo test -p bilibili-cli`
- `cargo check -p bilibili-cli`
- Local smoke: `cargo run -p bilibili-cli -- extract --url BV... --json` with a non-auth path where network permits.
