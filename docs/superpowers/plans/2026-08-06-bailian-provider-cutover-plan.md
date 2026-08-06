# 百炼 Coding Plan Provider 切换实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `14.103.193.229` 的活动 Provider 和模型链从火山切换到百炼，同时保留现有 tmux/debug、NAS、数据和 Finance Skills。

**Architecture:** 只修改目标机的模型映射、有效 Codex Provider 配置和 tmux 加载的环境文件。百炼凭证从 `81.70.18.173` 经 SSH 管道直接传到目标机，不在本地落盘；切换前先完成离线直连验证，切换时排空任务并原子安装配置。

**Tech Stack:** Ripple Rust server、Codex app-server 0.145.0、YAML、TOML、tmux、Responses SSE、SSH。

## Global Constraints

- 不修改 tmux/debug 运行方式，不引入 systemd/release 切换。
- 不覆盖 `/nas/ripple/runtime`、`/nas/ripple-data`、SQLite、Sandbox、Finance Skills 或其他未跟踪文件。
- 不在终端、日志、Git、本地文件或计划文档中输出百炼/火山凭证。
- 活动模型必须为 `qwen3.7-plus`，fallback 必须依次为 `qwen3.6-flash`、`qwen3.7-max`。
- Provider 必须使用 `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` 和 Responses API。
- 任一切换前验证失败都必须停止，不得重启线上进程。

---

### Task 1: 建立切换基线和回滚包

**Files:**
- Inspect: `/root/ripple/config/settings.yaml`
- Inspect: `/nas/ripple/runtime/codex-service-home/config.toml`
- Inspect: `/root/.config/ripple/ark-coding-plan.env`
- Create: `/root/ripple/.ripple/provider-cutover-backup-$cutover_stamp/`

**Interfaces:**
- Consumes: 当前 tmux 会话 `ripple-server-root` 和 PID 3867402 的实时状态。
- Produces: 包含原配置、环境文件、文件哈希和启动命令的 root-only 回滚目录。

- [ ] **Step 1: 重新确认身份、分支、进程和监听器**

Run on `14.103.193.229`:

```bash
id
hostname
cd /root/ripple
git branch --show-current
git rev-parse HEAD
git status --short
ss -ltnp | grep ':8810 '
tmux list-sessions
pgrep -af 'ripple-server|cargo run -p ripple-server'
```

Expected: root、`L20-SH-2`、`release-cn`，8810 由 tmux 启动的 `target/debug/ripple-server` 监听；已有未跟踪 Finance Skill/备份文件保持原样。

- [ ] **Step 2: 创建权限为 0700 的回滚目录并复制活动文件**

```bash
cutover_stamp=$(date -u +%Y%m%dT%H%M%SZ)
cutover_backup=/root/ripple/.ripple/provider-cutover-backup-$cutover_stamp
install -d -m 0700 "$cutover_backup"
install -m 0600 /root/ripple/config/settings.yaml "$cutover_backup/settings.yaml"
install -m 0600 /nas/ripple/runtime/codex-service-home/config.toml "$cutover_backup/codex-config.toml"
install -m 0600 /root/.config/ripple/ark-coding-plan.env "$cutover_backup/ark-coding-plan.env"
tmux list-panes -t ripple-server-root -F '#{pane_start_command}' >"$cutover_backup/tmux-start-command.txt"
chmod 0600 "$cutover_backup/tmux-start-command.txt"
sha256sum "$cutover_backup"/* >"$cutover_backup/SHA256SUMS"
chmod 0600 "$cutover_backup/SHA256SUMS"
```

Expected: 目录 `0700`、文件 `0600`，`sha256sum -c SHA256SUMS` 全部 OK。

### Task 2: 安全传递凭证并完成百炼离线直连验证

**Files:**
- Read: `81.70.18.173:/etc/ripple/provider.env`
- Create: `14.103.193.229:/root/.config/ripple/bailian-token-plan.env`

**Interfaces:**
- Consumes: 81 号机现有 root-only 百炼环境文件。
- Produces: 14 号机 root-only、尚未被线上进程加载的百炼环境文件和三模型直连证据。

- [ ] **Step 1: 经 SSH 管道直接安装凭证，不输出内容**

Run from the operator machine with `set -o pipefail`:

```bash
ssh -o BatchMode=yes -o IdentitiesOnly=yes -i /Users/lake/.ssh/id_ed25519 root@81.70.18.173 'test "$(stat -c %a /etc/ripple/provider.env)" = 600 && exec cat /etc/ripple/provider.env' |
ssh -o BatchMode=yes -o IdentitiesOnly=yes -i /Users/lake/.ssh/id_ed25519 root@14.103.193.229 'umask 077; install -m 0600 /dev/stdin /root/.config/ripple/bailian-token-plan.env'
```

Expected: 管道退出码 0；目标文件 owner 为 root、mode 为 600，包含非空 `ARK_API_KEY`，但任何输出不包含值。

- [ ] **Step 2: 在目标机直接请求三个百炼模型并检查 SSE 骨架**

Run a Python probe that loads `ARK_API_KEY` from the new file and requests:

```text
qwen3.7-plus
qwen3.6-flash
qwen3.7-max
```

For each model assert:

```text
HTTP 200
response.reasoning_summary_text.delta count > 0
response.output_text.delta count > 0
response.completed count = 1
reasoning output_item.added has summary
message output_item.added has content
```

Expected: 三个模型全部通过；失败则停止切换并保留现有线上进程。

### Task 3: 生成并校验目标配置

**Files:**
- Modify: `/root/ripple/config/settings.yaml:3-29`
- Modify: `/nas/ripple/runtime/codex-service-home/config.toml:1-12`
- Preserve: `/nas/ripple/runtime/codex-service-home/config.toml` 中全部项目 trust 配置

**Interfaces:**
- Consumes: 已验证的百炼 endpoint、凭证和模型名。
- Produces: 可被 YAML/TOML 解析、尚未重启加载的活动配置。

- [ ] **Step 1: 将活动配置复制到本地临时目录并记录原始哈希**

```bash
scp root@14.103.193.229:/root/ripple/config/settings.yaml ./settings.yaml
scp root@14.103.193.229:/nas/ripple/runtime/codex-service-home/config.toml ./config.toml
cp settings.yaml settings.yaml.before
cp config.toml config.toml.before
sha256sum settings.yaml config.toml
```

- [ ] **Step 2: 使用 apply_patch 修改模型映射**

`settings.yaml` 的目标片段必须为：

```yaml
model:
  default: "codex-medium"
  fallback_chain:
    - model: "qwen3.6-flash"
      reasoning_effort: "low"
    - model: "qwen3.7-max"
      reasoning_effort: "low"
  presets:
    codex-low:
      openai-codex: "qwen3.7-plus"
      reasoning_effort: "low"
    codex-medium:
      openai-codex: "qwen3.7-plus"
      reasoning_effort: "medium"
    codex-high:
      openai-codex: "qwen3.7-plus"
      reasoning_effort: "high"
    codex-xhigh:
      openai-codex: "qwen3.7-plus"
      reasoning_effort: "xhigh"
```

`config.toml` 的活动 Provider 必须为：

```toml
model_provider = "Model_Studio_Token_Plan"
model = "qwen3.7-plus"
model_reasoning_effort = "medium"

[model_providers.Model_Studio_Token_Plan]
name = "Model_Studio_Token_Plan"
base_url = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
env_key = "ARK_API_KEY"
wire_api = "responses"
```

移除活动 `volcengine-coding-plan` Provider 块，但不改变后续 trust 配置。

- [ ] **Step 3: 校验配置和范围**

```bash
python3 -c 'import yaml; yaml.safe_load(open("settings.yaml"))'
python3 -c 'import tomllib; tomllib.load(open("config.toml", "rb"))'
git diff --no-index -- settings.yaml.before settings.yaml
git diff --no-index -- config.toml.before config.toml
```

Expected: 仅 Provider/模型链发生变化；没有 NAS、权限、Skill、Connector 或 trust 配置差异。

- [ ] **Step 4: 上传为临时文件并原子安装**

```bash
scp settings.yaml root@14.103.193.229:/root/ripple/config/settings.yaml.bailian.new
scp config.toml root@14.103.193.229:/nas/ripple/runtime/codex-service-home/config.toml.bailian.new
ssh root@14.103.193.229 'install -m 0600 /root/ripple/config/settings.yaml.bailian.new /root/ripple/config/settings.yaml && install -m 0600 /nas/ripple/runtime/codex-service-home/config.toml.bailian.new /nas/ripple/runtime/codex-service-home/config.toml'
```

Expected: 活动文件 mode 600，YAML/TOML 在目标机再次解析成功。

### Task 4: 排空任务并以原方式重启

**Files:**
- Load: `/root/.config/ripple/bailian-token-plan.env`
- Stop/start: tmux session `ripple-server-root`

**Interfaces:**
- Consumes: 校验通过的活动配置。
- Produces: 加载百炼凭证的全新 Ripple/Codex 进程池。

- [ ] **Step 1: 开始 drain 并等待 active_jobs 为 0**

```bash
curl -fsS -X POST http://127.0.0.1:8810/v1/internal/drain
curl -fsS http://127.0.0.1:8810/v1/internal/drain/status
```

Repeat status until `active_jobs` is 0. Do not stop the process while active jobs remain.

- [ ] **Step 2: 重启原 tmux/debug 服务，只替换环境文件**

```bash
tmux kill-session -t ripple-server-root
tmux new-session -d -s ripple-server-root "bash -lc 'set -euo pipefail; export PATH=/root/.cargo/bin:/root/.local/bin:\$PATH; set -a; . /root/.config/ripple/bailian-token-plan.env; set +a; cd /root/ripple; mkdir -p .ripple; exec cargo run -p ripple-server 2>&1 | tee -a /root/ripple/.ripple/ripple-server-root.log'"
```

Expected: 新 PID 监听 8810；进程环境包含 `ARK_API_KEY`，且其哈希匹配百炼环境文件、不匹配火山备份中的值。

### Task 5: 完整验证与回滚判定

**Files:**
- Inspect: `/root/ripple/.ripple/ripple-server-root.log`
- Inspect: per-user Codex `logs_2.sqlite`

**Interfaces:**
- Consumes: 新 Ripple 进程。
- Produces: 可交付的主模型、SSE、fallback 和数据边界证据。

- [ ] **Step 1: 验证服务与配置**

```bash
ss -ltnp | grep ':8810 '
curl -fsS http://127.0.0.1:8810/health
pgrep -af 'ripple-server|cargo run -p ripple-server'
```

Assert effective config reports百炼 endpoint、`qwen3.7-plus` and the two Qwen fallback models.

- [ ] **Step 2: 发送真实 Ripple SSE 请求**

Create a session and call `/v1/responses` with `model=qwen3.7-plus`, `think_level=low`, `stream=true`.

Assert:

```text
HTTP 200
first response.output_text.delta is emitted before response.completed
response.output_text.delta count > 0
response.completed count = 1
```

- [ ] **Step 3: 强制验证 fallback**

Request `nonexistent-model-fallback-probe`. Assert Codex logs show rollback from the invalid model followed by `qwen3.6-flash`, and the Ripple request completes with text deltas.

- [ ] **Step 4: 检查已知流式错误和数据边界**

Assert new logs contain zero occurrences of:

```text
OutputTextDelta without active item
ReasoningSummaryDelta without active item
failed to parse ResponseItem from output_item.added
```

Run `git status --short` and compare with the baseline. Expected: Finance Skills、NAS link 和原备份文件保持不变；只增加已经批准的设计/计划提交，不意外提交生产配置或凭证。

- [ ] **Step 5: 失败时回滚**

If any post-restart check fails:

```bash
tmux kill-session -t ripple-server-root
install -m 0600 "$cutover_backup/settings.yaml" /root/ripple/config/settings.yaml
install -m 0600 "$cutover_backup/codex-config.toml" /nas/ripple/runtime/codex-service-home/config.toml
tmux new-session -d -s ripple-server-root "bash -lc 'set -euo pipefail; export PATH=/root/.cargo/bin:/root/.local/bin:\$PATH; set -a; . /root/.config/ripple/ark-coding-plan.env; set +a; cd /root/ripple; mkdir -p .ripple; exec cargo run -p ripple-server 2>&1 | tee -a /root/ripple/.ripple/ripple-server-root.log'"
```

Then rerun listener, health and a real GLM request before reporting rollback complete.
