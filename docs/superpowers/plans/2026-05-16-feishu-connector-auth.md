# Feishu Connector Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Upgrade bundled `lark-cli` and make Feishu authorization work from both the Connectors page and chat authorization cards without asking normal users for app credentials.

**Architecture:** Keep `lark-cli` as the source of truth for Feishu app configuration and user tokens. The backend connector owns setup/login start/complete actions, while the web UI opens returned URLs and reuses the same complete endpoint for connector and chat flows.

**Tech Stack:** Python FastAPI connector registry, user sandbox `lark-cli`, React/TypeScript connector UI, existing Markdown Feishu cards.

---

### Task 1: Backend Feishu Device Flow

**Files:**
- Modify: `src/ripple/sandbox/feishu.py`
- Modify: `src/ripple/connectors/registry.py`
- Test: `tests/test_connector_routes.py`

- [x] **Step 1: Write failing backend tests**

Add tests that verify Feishu auth start returns `oauth_url` and `device_code`, exposes `auth_complete_path`, and auth complete passes the device code to the sandbox command runner.

- [x] **Step 2: Run backend tests to verify failure**

Run: `uv run pytest tests/test_connector_routes.py -k feishu -v`

- [x] **Step 3: Implement backend helpers**

Add Feishu helpers for server app credential lookup, `auth login --no-wait --json --domain all`, device-code completion, and auth status checks.

- [x] **Step 4: Run backend tests to verify pass**

Run: `uv run pytest tests/test_connector_routes.py -k feishu -v`

### Task 2: Web Connector and Chat UX

**Files:**
- Modify: `src/interfaces/web/src/lib/connectors.ts`
- Modify: `src/interfaces/web/src/components/workbench/ConnectorsPage.tsx`
- Modify: `src/interfaces/web/src/components/MarkdownRenderer.tsx`
- Test: `src/interfaces/web/src/lib/connectors.test.ts`

- [x] **Step 1: Write failing frontend helper tests**

Add tests for device-flow completion detection and Feishu URL extraction with device codes.

- [x] **Step 2: Run frontend helper tests to verify failure**

Run: `cd src/interfaces/web && bun run src/lib/connectors.test.ts`

- [x] **Step 3: Implement web flow**

Remove Feishu app credential fields, auto-open returned auth/setup URLs, add Complete handling for `device_code`, and allow chat Feishu cards to call `/auth/complete`.

- [x] **Step 4: Run frontend helper tests to verify pass**

Run: `cd src/interfaces/web && bun run src/lib/connectors.test.ts`

### Task 3: CLI Upgrade and Skill Text

**Files:**
- Modify: `scripts/install-feishu-cli.sh`
- Modify: `scripts/use-feishu-cli.sh`
- Modify: `skills/lark/lark-shared/SKILL.md`
- Update: `vendor/lark-cli/current`
- Create: `vendor/lark-cli/v1.0.32/bin/lark-cli`

- [x] **Step 1: Upgrade default CLI version**

Set the default installer version to `1.0.32` and install/switch the vendored binary.

- [x] **Step 2: Update skill guidance**

Document the current device-flow command shape, `--exclude`, `config bind`/`--force-init` caveat, and chat card device code handoff.

- [x] **Step 3: Verify CLI**

Run: `vendor/lark-cli/current/bin/lark-cli --version`

### Task 4: Full Verification

**Files:**
- All changed files

- [x] **Step 1: Format and lint Python**

Run: `uv run ruff format .` and `uv run ruff check .`

- [x] **Step 2: Run targeted backend tests**

Run: `uv run pytest tests/test_connector_routes.py`

- [x] **Step 3: Run frontend checks**

Run: `cd src/interfaces/web && bun run src/lib/connectors.test.ts`

- [x] **Step 4: Summarize remaining risks**

Call out whether real Feishu browser auth was manually exercised or only mocked.
