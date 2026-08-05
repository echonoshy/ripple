# release-cn Release Sync and Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge `release@039fed4` into `release-cn`, configure a domestic GLM-to-Flash-to-Doubao fallback chain, and deploy it safely on port 8810.

**Architecture:** Preserve the upstream fallback runner unchanged and merge the shared release history with a merge commit. Keep client-supplied actual model names as the first attempt; use the existing `codex-*` presets only as compatibility defaults mapped to `glm-latest`. Store the fallback chain in the domestic runtime YAML and validate it through Rust tests plus live Coding Plan requests.

**Tech Stack:** Rust 1.77.2, Tokio, Codex app-server, YAML, POSIX shell, Python 3.8, Git, tmux.

## Global Constraints

- Preserve commit `aa666c45` and the domestic Coding Plan provider/sandbox behavior.
- Preserve client-supplied actual model names without rewriting them.
- Use fallback order `deepseek-v4-flash-260425` then `doubao-seed-2-0-code-preview-260215`, both at low reasoning effort.
- Never retry after visible output, tool activity, file changes, approvals, user input, timeout, cancellation, authentication, sandbox, or permission failures.
- Do not expose API keys or commit `config/settings.yaml`.
- Preserve `.ripple.nas-link-20260730-021451` and `config/settings.yaml.bak-2026072311-bwrap-codex-path`.
- Run exactly one server process against the live SQLite database.

---

### Task 1: Merge the Shared Release History

**Files:**
- Merge: `origin/release` at `039fed4e6afe8ad670464b4e92a932b9f9aa0fd4`
- Preserve: `crates/ripple-server/src/sandbox.rs`

**Interfaces:**
- Consumes: `release-cn` at the current design commits and the fetched release commit.
- Produces: one merge commit containing upstream fallback and Record synthesis behavior.

- [ ] **Step 1: Verify the merge inputs and clean tracked state**

Run:

```bash
git status --short --branch
git rev-parse release-cn origin/release
git merge-base --is-ancestor aa666c45 release-cn
```

Expected: only the two known untracked backup paths, `origin/release` at `039fed4`, and the domestic commit reachable.

- [ ] **Step 2: Merge release with history preserved**

Run:

```bash
git merge --no-ff 039fed4e6afe8ad670464b4e92a932b9f9aa0fd4 \
  -m "merge(release): sync fallback and Record synthesis"
```

Expected: automatic merge of `sandbox.rs`, no unmerged paths.

- [ ] **Step 3: Verify merge ancestry**

Run:

```bash
git merge-base --is-ancestor 039fed4e release-cn
git merge-base --is-ancestor aa666c45 release-cn
git diff --check HEAD^1..HEAD
```

Expected: both ancestry checks and whitespace validation succeed.

---

### Task 2: Restore Python 3.8 Test Compatibility

**Files:**
- Modify: `skills/record-artifact-synthesis/tests/test_record_artifact.py`

**Interfaces:**
- Consumes: upstream Record helper tests using `str | None`.
- Produces: the same tests importable under the host Python 3.8 runtime.

- [ ] **Step 1: Run the helper tests and observe the compatibility failure**

Run:

```bash
python3 -m unittest discover \
  -s skills/record-artifact-synthesis/tests -p 'test_*.py' -v
```

Expected: RED with `TypeError: unsupported operand type(s) for |` while importing the test module.

- [ ] **Step 2: Apply the minimal compatibility change**

Change the test helper signature from:

```python
def run_helper(
    self, *arguments: str, input_text: str | None = None
) -> subprocess.CompletedProcess[str]:
```

to:

```python
from typing import Optional

def run_helper(
    self, *arguments: str, input_text: Optional[str] = None
) -> subprocess.CompletedProcess:
```

Python 3.8 supports neither `str | None` nor subscripting
`subprocess.CompletedProcess`. Do not add `from __future__ import annotations`
and do not change the production shell helper.

- [ ] **Step 3: Re-run the helper tests**

Run the Step 1 command again.

Expected: GREEN with all Record helper tests passing.

- [ ] **Step 4: Commit the compatibility fix**

Run:

```bash
git add skills/record-artifact-synthesis/tests/test_record_artifact.py
git commit -m "test(record): support Python 3.8 helper tests"
```

---

### Task 3: Configure Domestic Models and Skills

**Files:**
- Modify: `config/settings.yaml.sample`
- Modify without committing: `config/settings.yaml`

**Interfaces:**
- Consumes: upstream `model.fallback_chain`, existing `codex-*` presets, and the Record skill directory.
- Produces: actual client model passthrough, GLM compatibility defaults, and the speed-first domestic fallback chain.

- [ ] **Step 1: Create a recoverable runtime-config backup**

Run:

```bash
cp -p config/settings.yaml \
  config/settings.yaml.pre-fallback-20260805
chmod 600 config/settings.yaml.pre-fallback-20260805
```

- [ ] **Step 2: Update the sample and runtime model configuration**

Under `model`, keep `default: "codex-medium"`, add:

```yaml
fallback_chain:
  - model: "deepseek-v4-flash-260425"
    reasoning_effort: "low"
  - model: "doubao-seed-2-0-code-preview-260215"
    reasoning_effort: "low"
```

For each `codex-low`, `codex-medium`, `codex-high`, and `codex-xhigh` preset, set:

```yaml
openai-codex: "glm-latest"
```

Preserve each preset's existing reasoning effort.

- [ ] **Step 3: Enable the Record synthesis skill in the runtime config**

Under `skills.shared_dirs`, preserve `skills/lark` and add:

```yaml
- "skills/record-artifact-synthesis"
```

- [ ] **Step 4: Validate runtime configuration without exposing secrets**

Run:

```bash
RIPPLE_CONFIG=config/settings.yaml \
  /root/.cargo/bin/cargo test -p ripple-server \
  config::tests::parses_model_fallback_chain_in_order -- --nocapture
```

Then inspect only the `model` and `skills` YAML blocks and verify no GPT fallback entry remains.

- [ ] **Step 5: Commit only the tracked sample change**

Run:

```bash
git add config/settings.yaml.sample
git commit -m "config(model): add China fallback defaults"
```

Do not add the live `config/settings.yaml` or its backup.

---

### Task 4: Run Repository Verification and Build

**Files:**
- Verify: all merged Rust and Record files.
- Build: `target/debug/ripple-server`.

**Interfaces:**
- Consumes: merged source and domestic tracked configuration sample.
- Produces: a tested server binary ready for controlled replacement.

- [ ] **Step 1: Check formatting and whitespace**

Run:

```bash
/root/.cargo/bin/cargo fmt -p ripple-server -- --check
git diff --check
```

- [ ] **Step 2: Compile production code**

Run:

```bash
/root/.cargo/bin/cargo check -p ripple-server
```

- [ ] **Step 3: Run the full Rust test suite**

Run:

```bash
/root/.cargo/bin/cargo test -p ripple-server
```

- [ ] **Step 4: Re-run Python helper tests**

Run the Task 2 Step 1 command and require zero failures.

- [ ] **Step 5: Build the debug server used by the existing tmux manager**

Run:

```bash
/root/.cargo/bin/cargo build -p ripple-server
```

Record the resulting binary SHA-256 before restart.

---

### Task 5: Deploy and Prove Live Fallback

**Files:**
- Runtime manager: tmux session `ripple-server-root`
- Runtime log: `.ripple/ripple-server-root.log`
- Runtime config: `config/settings.yaml`

**Interfaces:**
- Consumes: the verified binary and runtime configuration.
- Produces: one healthy listener using the merged `release-cn` code and the domestic fallback chain.

- [ ] **Step 1: Check active work and request drain**

Resolve the API key internally from `config/settings.yaml`, query the internal drain status, and call `POST /v1/internal/drain` only when supported. Wait until active work reaches zero; do not print the key.

- [ ] **Step 2: Restart the existing tmux-managed process**

Send `Ctrl-C` to `ripple-server-root`, wait for port 8810 to close, then start exactly:

```bash
set -euo pipefail
export PATH=/root/.cargo/bin:/root/.local/bin:$PATH
set -a
. /root/.config/ripple/ark-coding-plan.env
set +a
cd /root/ripple
mkdir -p .ripple
exec cargo run -p ripple-server 2>&1 | tee -a /root/ripple/.ripple/ripple-server-root.log
```

Use the existing tmux window; do not start a second session against the live database.

- [ ] **Step 3: Prove process identity and health**

Run listener-to-PID checks and verify:

```text
/proc/<pid>/exe -> /root/ripple/target/debug/ripple-server
/proc/<pid>/cwd -> /root/ripple
GET /health -> success
GET /v1/health/ready with API key -> ready
```

- [ ] **Step 4: Verify actual model and compatibility preset behavior**

Send minimal authenticated `/v1/responses` requests using:

```text
model = glm-5-2-260617
model = codex-medium
```

Expected: both complete; the actual model is preserved and the preset resolves to `glm-latest`.

- [ ] **Step 5: Verify controlled fallback behavior**

Send a minimal streaming request using an intentionally unsupported model and no tools. Expected: the request completes through `deepseek-v4-flash-260425`, no intermediate failure leaks into SSE, and the server log records `Codex model fallback started` with the Flash model as `to_model`.

- [ ] **Step 6: Commit final tracked corrections and push**

Run:

```bash
git status --short --branch
git push origin release-cn
```

Verify `release-cn` and `origin/release-cn` resolve to the same commit. Leave the live runtime config and its root-only backup untracked.
