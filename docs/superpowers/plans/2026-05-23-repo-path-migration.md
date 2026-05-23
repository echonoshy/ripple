# Repo Path Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Move Ripple to a clean Rust server + Tauri app + shared skills layout by replacing historical `src/interfaces/app` and `src/skills` paths with top-level `app` and `skills`.

**Architecture:** The Rust backend remains under `crates/ripple-server`; the unified Vite/React/Tauri client becomes a top-level `app` package; shared skills become a top-level `skills` tree loaded by the server default config. Tauri internal paths stay relative inside `app`, so `app/src` and `app/src-tauri` keep their existing relationship.

**Tech Stack:** Rust workspace with Cargo, Vite + React + Bun, Tauri v2, Markdown/YAML skills with optional Python helpers.

---

### Task 1: Add Path Expectations Before Moving

**Files:**
- Modify: `crates/ripple-server/src/config.rs`
- Modify: `src/interfaces/app/src/lib/workbench.test.ts`

- [x] **Step 1: Add a Rust default-config assertion**

Add a unit test in `crates/ripple-server/src/config.rs` that loads an empty config in a temp repo root and asserts `config.skills.shared_dirs == ["skills/*"]`.

- [x] **Step 2: Update frontend path-sensitive fixture**

Change `src/interfaces/app/src/lib/workbench.test.ts` fixture paths from `/workspace/src/interfaces/app` and `src/interfaces/app/...` to `/workspace/app` and `app/...`.

- [x] **Step 3: Verify expected failures**

Run:

```bash
cargo test -p ripple-server default_skills_shared_dirs_use_top_level_skills
cd src/interfaces/app && bun src/lib/workbench.test.ts
```

Expected before migration: Rust default config test fails because production code still returns `src/skills/*`; frontend test should pass after fixture-only update because it validates formatter behavior, not filesystem existence.

### Task 2: Move Directories

**Files:**
- Move: `src/interfaces/app` -> `app`
- Move: `src/skills` -> `skills`
- Delete ignored local artifact: `src/ripple.egg-info`

- [x] **Step 1: Move tracked directories**

Run:

```bash
git mv src/interfaces/app app
git mv src/skills skills
```

- [x] **Step 2: Remove ignored legacy packaging artifact**

Run:

```bash
rm -rf src/ripple.egg-info
```

- [x] **Step 3: Remove empty historical directories**

Run:

```bash
rmdir src/interfaces src
```

Expected: `src` no longer exists.

### Task 3: Update Runtime Config And Ignore Rules

**Files:**
- Modify: `crates/ripple-server/src/config.rs`
- Modify: `config/settings.yaml.sample`
- Modify: `.gitignore`

- [x] **Step 1: Change Rust default skill glob**

Change `unwrap_or_else(|| vec!["src/skills/*".to_string()])` to `unwrap_or_else(|| vec!["skills/*".to_string()])`.

- [x] **Step 2: Change sample config comments and default**

Replace `src/skills/*` examples with `skills/*` and `src/skills/lark` with `skills/lark`.

- [x] **Step 3: Change Tauri schema ignore path**

Replace `src/interfaces/*/src-tauri/gen/schemas/` with `app/src-tauri/gen/schemas/`.

### Task 4: Update Documentation And Agent Instructions

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/SKILLS.md`
- Modify: `docs/TAURI_MOBILE.md`
- Modify: `docs/rust-backend-migration.md`
- Modify: `sites/index.html`
- Modify: skill docs under `skills/lark/` if they reference old repo-local skill paths

- [x] **Step 1: Replace client path references**

Replace `src/interfaces/app` with `app`.

- [x] **Step 2: Replace shared skill path references**

Replace `src/skills` with `skills`.

- [x] **Step 3: Keep frontend-internal `src/` references intact**

Do not replace paths like `app/src/App.tsx`, `src/lib/platform/`, or `src-tauri/...` when they are relative to the app package.

### Task 5: Update App-Local Tests And Generated Project References

**Files:**
- Modify: `app/src/lib/workbench.test.ts`
- Inspect: `app/src-tauri/gen/apple/project.yml`
- Inspect: `app/src-tauri/gen/apple/ripple-desktop.xcodeproj/project.pbxproj`

- [x] **Step 1: Confirm app-local relative paths still work**

Verify `app/src-tauri/tauri.conf.json` still uses `frontendDist: "../dist"` and generated Apple project references still point to `../../src` relative to `app/src-tauri/gen/apple`.

- [x] **Step 2: Update any remaining app test fixtures that use old repo paths**

Run:

```bash
rg "src/interfaces/app|src/skills|interfaces/app" app
```

Expected: no stale historical paths.

### Task 6: Verify Migration

**Files:**
- Whole repo

- [x] **Step 1: Search for stale paths**

Run:

```bash
rg "src/interfaces|src/skills|src/ripple|interfaces/app" .
```

Expected: no stale path references except generated historical text only if explicitly justified.

- [x] **Step 2: Run Rust formatting and checks**

Run:

```bash
cargo fmt -p ripple-server
cargo check -p ripple-server
cargo test -p ripple-server
```

Expected: all commands exit 0.

- [x] **Step 3: Run App checks**

Run:

```bash
cd app
bun run lint
bun run build
```

Expected: both commands exit 0.

- [x] **Step 4: Inspect git status**

Run:

```bash
git status --short
```

Expected: moved paths show as renames, `src/` is gone, and no ignored build artifacts are staged.
