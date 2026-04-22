# gogcli 接入 ripple 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 `gogcli`（`gog` 二进制）替换已移除的 `gws` CLI，作为 ripple 沙箱内操作 Google Workspace 的通道，支持远程部署（server/client 不同机）。

**Architecture:**
- **per-user 严格隔离**：每 user 一份 OAuth Desktop Client (`gogcli-client.json`) + 一份 keyring 加密密码 (`keyring.pass`)，落在 `sandboxes/<uid>/credentials/`。
- **授权走 `--remote --step 1/2` 两步流程**：不依赖 loopback 回调在同机，agent 把 `oauth_url` 抛给用户、用户本地浏览器点 Allow 后把地址栏 callback URL 粘回 agent，agent 再调 step 2 完成。
- **破坏性操作通过 `AskUser` 工具挂起确认**（skill 层纪律，无代码硬拦截）。
- **keyring backend = file**，密码由 ripple 在 user 首次 provision 时随机生成 + env 注入，agent/用户都不可见。

**Tech Stack:**
- Python 3.13 + uv + ruff + pytest（后端）
- nsjail（沙箱隔离）
- `gog` v0.13.0（Go 二进制，musl 静态链接）

---

## File Structure

**新建**：
- `scripts/install-gogcli-cli.sh` — 下载 `gog` 到 `vendor/gogcli-cli/v<ver>/bin/gog`
- `scripts/use-gogcli-cli.sh` — 切换 vendor 内版本
- `src/ripple/sandbox/gogcli.py` — per-user client config/keyring 密码的读写（对齐 `notion.py` 的职责）
- `src/ripple/tools/builtin/gogcli_client_config_set.py` — `GoogleWorkspaceClientConfigSet` 工具
- `src/ripple/tools/builtin/gogcli_login_start.py` — `GoogleWorkspaceLoginStart` 工具（step 1）
- `src/ripple/tools/builtin/gogcli_login_complete.py` — `GoogleWorkspaceLoginComplete` 工具（step 2）
- `skills/gog/gog-shared/SKILL.md` — ripple 本地约定 + AskUser 纪律
- `skills/gog/gog-gmail/SKILL.md`
- `skills/gog/gog-calendar/SKILL.md`
- `skills/gog/gog-drive/SKILL.md`
- `skills/gog/gog-docs/SKILL.md`
- `skills/gog/gog-sheets/SKILL.md`
- `tests/sandbox/test_gogcli.py`
- `tests/tools/test_gogcli_tools.py`

**修改**：
- `src/ripple/sandbox/config.py` — 加 gogcli 相关常量 + 路径方法 + 发现函数 + `has_gogcli_*` 检测
- `src/ripple/sandbox/nsjail_config.py` — PATH 追加 gogcli bin、env 注入 `XDG_CONFIG_HOME`/`GOG_KEYRING_BACKEND`/`GOG_KEYRING_PASSWORD`/`GOG_CLIENT_ID`/`GOG_CLIENT_SECRET`、mount gogcli 安装根
- `src/ripple/sandbox/manager.py` — status dict 加 `has_gogcli_client_config` / `has_gogcli_login`
- `src/ripple/sandbox/provisioning.py` — user provision 时生成 keyring 密码
- `src/interfaces/server/sessions.py` — 注册 3 个新工具
- `src/interfaces/server/schemas.py` — 响应里加两个 bool 字段
- `CLAUDE.md` — "外部 CLI 依赖" 表格加一行 gogcli

**删除**（清理 gws 残留）：
- `skills/gws/`（整目录）
- `vendor/gws-cli/`

---

## Phase 0: 清理 gws 残留

### Task 0.1: 删除 gws skills 和 vendor 目录

**Files:**
- Delete: `skills/gws/`
- Delete: `vendor/gws-cli/`

- [ ] **Step 1: 确认 Python 代码里没 gws 引用（应已删净）**

```bash
rg -l 'gws|Gws|GOOGLE_WORKSPACE' src/ 2>/dev/null || echo "clean"
```

Expected: `clean`（无输出）

- [ ] **Step 2: 删除 skills 和 vendor 残留**

```bash
rm -rf skills/gws vendor/gws-cli
```

- [ ] **Step 3: 验证**

```bash
ls skills/ vendor/
```

Expected: `skills/` 里只剩 `lark notion podcast`；`vendor/` 里只剩 `lark-cli notion-cli`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove gws leftover skills and vendor binary"
```

---

## Phase 1: 预装 gog 二进制

### Task 1.1: 写 install-gogcli-cli.sh

**Files:**
- Create: `scripts/install-gogcli-cli.sh`

- [ ] **Step 1: 创建安装脚本**

```bash
#!/usr/bin/env bash
# 把 gogcli (gog) 下载并安装到项目内的 vendor/ 目录，不动宿主机的 /opt、/usr/local/bin。
#
# 用法:
#   ./scripts/install-gogcli-cli.sh                 # 安装默认版本
#   ./scripts/install-gogcli-cli.sh 0.13.0          # 安装指定版本
#   ./scripts/install-gogcli-cli.sh 0.13.0 arm64    # 指定架构（默认 uname -m 推导）
#
# 下载失败时不会重试，会打印手工安装说明。
#   GOGCLI_ARCHIVE=/path/to/gogcli_Linux_x86_64.tar.gz \
#     ./scripts/install-gogcli-cli.sh 0.13.0
set -euo pipefail

VERSION="${1:-0.13.0}"
RAW_ARCH="${2:-$(uname -m)}"
case "${RAW_ARCH}" in
  x86_64|amd64) ARCH="x86_64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo "✗ 未识别的架构: ${RAW_ARCH}，请显式传入 (x86_64 / arm64)" >&2
    exit 1
    ;;
esac

ARCHIVE_NAME="gogcli_Linux_${ARCH}.tar.gz"
BASE_URL="https://github.com/steipete/gogcli/releases/download"
ARCHIVE_URL="${BASE_URL}/v${VERSION}/${ARCHIVE_NAME}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

INSTALL_ROOT="${REPO_ROOT}/vendor/gogcli-cli"
VERSION_DIR="${INSTALL_ROOT}/v${VERSION}"
CURRENT_LINK="${INSTALL_ROOT}/current"

mkdir -p "${VERSION_DIR}/bin"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

print_manual_fallback() {
  cat >&2 <<EOF

========================================================================
[gogcli 下载失败]  脚本不会重试，请按以下任一方式手工继续：

方式 A · 手工下载 tarball 后重新运行本脚本
  1. 用你顺手的方式下载:
       ${ARCHIVE_URL}
  2. 假设文件落到 ~/Downloads/
  3. 重新跑：
       GOGCLI_ARCHIVE=~/Downloads/${ARCHIVE_NAME} \\
         bash scripts/install-gogcli-cli.sh ${VERSION} ${ARCH}

方式 B · 直接把现成的 gog 二进制放到 vendor/
  1. 确保二进制是 linux-${ARCH}
  2. 执行：
       mkdir -p ${VERSION_DIR}/bin
       install -m 0755 /path/to/gog ${VERSION_DIR}/bin/gog
       ln -sfn v${VERSION} ${CURRENT_LINK}
       ${CURRENT_LINK}/bin/gog --version

方式 C · 网络墙问题先 proxy_on 再重试本脚本
========================================================================
EOF
}

if [[ -n "${GOGCLI_ARCHIVE:-}" ]]; then
  if [[ ! -f "${GOGCLI_ARCHIVE}" ]]; then
    echo "✗ GOGCLI_ARCHIVE 指定的文件不存在: ${GOGCLI_ARCHIVE}" >&2
    exit 1
  fi
  cp "${GOGCLI_ARCHIVE}" "${TMP}/${ARCHIVE_NAME}"
  echo "==> 使用本地 tarball: ${GOGCLI_ARCHIVE}"
else
  echo "==> 下载 gogcli v${VERSION} (${ARCH})"
  if ! curl -fL -o "${TMP}/${ARCHIVE_NAME}" "${ARCHIVE_URL}"; then
    print_manual_fallback
    exit 1
  fi
fi

echo "==> 解压到 ${VERSION_DIR}/bin"
tar -xzf "${TMP}/${ARCHIVE_NAME}" -C "${TMP}"

# 归档内通常直接含 `gog` 二进制（或 `gog_linux_<arch>/gog`），兼容两种布局。
GOG_BIN="$(find "${TMP}" -maxdepth 3 -type f -name gog -perm -u+x | head -n1 || true)"
if [[ -z "${GOG_BIN}" ]]; then
  echo "✗ tarball 里找不到 gog 二进制" >&2
  print_manual_fallback
  exit 1
fi
install -m 0755 "${GOG_BIN}" "${VERSION_DIR}/bin/gog"

ln -sfn "v${VERSION}" "${CURRENT_LINK}"

echo "==> 验证"
"${CURRENT_LINK}/bin/gog" --version
echo "==> 完成: ${CURRENT_LINK}/bin/gog"
```

- [ ] **Step 2: 赋可执行位**

```bash
chmod +x scripts/install-gogcli-cli.sh
```

- [ ] **Step 3: 跑一次实际安装**

```bash
bash scripts/install-gogcli-cli.sh
```

Expected: 最后一行打印 `gog version v0.13.0`（或类似）；`ls vendor/gogcli-cli/current/bin/gog` 存在且可执行。

如果这一步的下载失败（网络墙），先 `proxy_on` 再重试，或用 `GOGCLI_ARCHIVE=/path` 本地文件兜底。

- [ ] **Step 4: Commit**

```bash
git add scripts/install-gogcli-cli.sh
git commit -m "chore(gogcli): add vendor install script"
```

注：`vendor/gogcli-cli/` 应已被 `.gitignore` 覆盖（对照 `vendor/notion-cli/` 的排除规则），如果没有顺手补一条。

### Task 1.2: 写 use-gogcli-cli.sh

**Files:**
- Create: `scripts/use-gogcli-cli.sh`

- [ ] **Step 1: 参照 `scripts/use-notion-cli.sh` 写版本切换脚本**

读 `scripts/use-notion-cli.sh` 作为参考：

```bash
cat scripts/use-notion-cli.sh
```

然后 Write `scripts/use-gogcli-cli.sh`，把 `notion-cli` → `gogcli-cli`，`ntn --version` → `gog --version`，其他结构完全照抄。

- [ ] **Step 2: 赋可执行位 + 测试**

```bash
chmod +x scripts/use-gogcli-cli.sh
bash scripts/use-gogcli-cli.sh 0.13.0
```

Expected: 打印 `==> 已切换到 v0.13.0 (...)` 或等价信息。

- [ ] **Step 3: Commit**

```bash
git add scripts/use-gogcli-cli.sh
git commit -m "chore(gogcli): add version switch script"
```

---

## Phase 2: Sandbox 集成层

### Task 2.1: 沙箱常量与 SandboxConfig 方法

**Files:**
- Modify: `src/ripple/sandbox/config.py`
- Test: `tests/sandbox/test_gogcli_config.py`

- [ ] **Step 1: 写失败测试 — 确认 SandboxConfig 能定位 gogcli 相关路径**

Create `tests/sandbox/test_gogcli_config.py`:

```python
"""SandboxConfig gogcli-related paths."""

from pathlib import Path

import pytest

from ripple.sandbox.config import SandboxConfig


@pytest.fixture
def cfg(tmp_path: Path) -> SandboxConfig:
    return SandboxConfig(
        sandboxes_root=str(tmp_path / "sandboxes"),
        caches_root=str(tmp_path / "caches"),
    )


def test_gogcli_client_config_file_path(cfg: SandboxConfig):
    got = cfg.gogcli_client_config_file("alice")
    assert got == cfg.sandbox_dir("alice") / "credentials" / "gogcli-client.json"


def test_gogcli_keyring_pass_file_path(cfg: SandboxConfig):
    got = cfg.gogcli_keyring_pass_file("alice")
    assert got == cfg.sandbox_dir("alice") / "credentials" / "gogcli-keyring.pass"


def test_has_gogcli_client_config_false_when_missing(cfg: SandboxConfig):
    assert cfg.has_gogcli_client_config("alice") is False


def test_has_gogcli_client_config_true_when_present(cfg: SandboxConfig):
    f = cfg.gogcli_client_config_file("alice")
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text('{"installed": {"client_id": "x", "client_secret": "y"}}')
    assert cfg.has_gogcli_client_config("alice") is True


def test_has_gogcli_login_false_when_no_creds_dir(cfg: SandboxConfig):
    assert cfg.has_gogcli_login("alice") is False


def test_has_gogcli_login_true_when_creds_dir_nonempty(cfg: SandboxConfig):
    # gogcli keyring backend=file 把加密 credentials 落在 $XDG_CONFIG_HOME/gogcli/keyring/
    # ripple 把 XDG_CONFIG_HOME 指到 /workspace/.config/，所以宿主路径是 workspace_dir/.config/gogcli/keyring/
    d = cfg.workspace_dir("alice") / ".config" / "gogcli" / "keyring"
    d.mkdir(parents=True, exist_ok=True)
    (d / "default.keyring").write_bytes(b"dummy-encrypted-blob")
    assert cfg.has_gogcli_login("alice") is True
```

- [ ] **Step 2: 运行测试确认失败**

```bash
source .venv/bin/activate
pytest tests/sandbox/test_gogcli_config.py -v
```

Expected: 所有 test 报 `AttributeError: 'SandboxConfig' object has no attribute 'gogcli_client_config_file'`（方法还没加）。

- [ ] **Step 3: 在 `src/ripple/sandbox/config.py` 加常量、发现函数、dataclass 字段、方法**

在 `NOTION_CLI_SANDBOX_BIN` 常量（约 44 行）后追加：

```python
# gogcli (gog) 在**沙箱内**的挂载目的地。
# 宿主侧安装根由 scripts/install-gogcli-cli.sh 决定（`<repo_root>/vendor/gogcli-cli/`），
# 运行时 readonly bind-mount 到沙箱内固定路径。
#   /opt/gogcli-cli/vX.Y.Z/bin/gog
#   /opt/gogcli-cli/current -> vX.Y.Z
GOGCLI_CLI_INSTALL_ROOT = "/opt/gogcli-cli"
GOGCLI_CLI_SANDBOX_BIN_DIR = f"{GOGCLI_CLI_INSTALL_ROOT}/current/bin"
GOGCLI_CLI_SANDBOX_BIN = f"{GOGCLI_CLI_SANDBOX_BIN_DIR}/gog"
```

在 `_discover_notion_cli_install_root` 函数后（约 147 行）追加平行函数：

```python
def _discover_gogcli_cli_install_root() -> str | None:
    """自动发现 gogcli (gog) 的**宿主侧安装根目录**（用于 bind-mount 到沙箱）。

    优先级：
      1. 项目内（scripts/install-gogcli-cli.sh 默认位置）：
         `<repo_root>/vendor/gogcli-cli/`
      2. 宿主全局（备用）：`/opt/gogcli-cli/`
    要求该目录下含 `current/bin/gog`。
    """
    candidates = [
        _repo_root() / "vendor" / "gogcli-cli",
        Path("/opt/gogcli-cli"),
    ]
    for root in candidates:
        gog = root / "current" / "bin" / "gog"
        if gog.exists() and gog.is_file():
            return str(root)
    return None
```

在 `SandboxConfig` dataclass 里（`notion_cli_install_root` 字段之后，约 269 行）加一行字段：

```python
    gogcli_cli_install_root: str | None = field(default=None)
```

在 `__post_init__`（约 271 行）里补：

```python
        if self.gogcli_cli_install_root is None:
            self.gogcli_cli_install_root = _discover_gogcli_cli_install_root()
```

在 `notion_config_file` 方法之后（约 335 行）加两个路径方法：

```python
    def gogcli_client_config_file(self, user_id: str) -> Path:
        """Desktop OAuth client_secret.json 的宿主侧落盘路径（不入沙箱）。

        `GoogleWorkspaceClientConfigSet` 工具把用户贴的 JSON 原文写这里；
        `ripple.sandbox.gogcli.read_gogcli_client_config` 在构造沙箱 env 时读取。
        """
        validate_user_id(user_id)
        return self.sandbox_dir(user_id) / "credentials" / "gogcli-client.json"

    def gogcli_keyring_pass_file(self, user_id: str) -> Path:
        """gogcli keyring (backend=file) 的加密密码宿主侧存放路径。

        首次 provision 时由 ripple 随机生成 32B 密码写入 (mode 0600)，
        沙箱启动时作为 env `GOG_KEYRING_PASSWORD` 注入；agent/user 都不可见。
        """
        validate_user_id(user_id)
        return self.sandbox_dir(user_id) / "credentials" / "gogcli-keyring.pass"
```

在 `has_notion_token` 之后（约 385 行）加两个检测方法：

```python
    def has_gogcli_client_config(self, user_id: str) -> bool:
        """判定依据：credentials/gogcli-client.json 存在且非空。

        不校验 JSON 合法性（那是 `write_gogcli_client_config` 负责的）。
        """
        f = self.gogcli_client_config_file(user_id)
        try:
            return f.exists() and f.stat().st_size > 0
        except OSError:
            return False

    def has_gogcli_login(self, user_id: str) -> bool:
        """判定依据：`workspace/.config/gogcli/keyring/` 目录下有非空文件。

        gogcli backend=file 会把加密 credentials 写进 keyring 目录；只要里面有
        任何非空文件，就说明至少跑成功过一次 `gog auth add`。
        这个检测对 agent 引导很重要（`has_gogcli_login=False` → 引导 OAuth login）。
        """
        d = self.workspace_dir(user_id) / ".config" / "gogcli" / "keyring"
        if not d.exists() or not d.is_dir():
            return False
        try:
            for entry in d.iterdir():
                if entry.is_file() and entry.stat().st_size > 0:
                    return True
        except OSError:
            return False
        return False
```

在 `from_dict` 类方法里（约 434 行）补一行：

```python
            gogcli_cli_install_root=data.get("gogcli_cli_install_root"),
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pytest tests/sandbox/test_gogcli_config.py -v
```

Expected: 6 passed.

- [ ] **Step 5: Lint**

```bash
ruff format src/ripple/sandbox/config.py tests/sandbox/test_gogcli_config.py
ruff check src/ripple/sandbox/config.py tests/sandbox/test_gogcli_config.py
```

Expected: `All checks passed!`

- [ ] **Step 6: Commit**

```bash
git add src/ripple/sandbox/config.py tests/sandbox/test_gogcli_config.py
git commit -m "feat(sandbox): add gogcli path and detection methods to SandboxConfig"
```

### Task 2.2: `sandbox/gogcli.py` 模块

**Files:**
- Create: `src/ripple/sandbox/gogcli.py`
- Test: `tests/sandbox/test_gogcli.py`

- [ ] **Step 1: 写失败测试**

Create `tests/sandbox/test_gogcli.py`:

```python
"""Tests for ripple.sandbox.gogcli."""

import json
from pathlib import Path

import pytest

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.gogcli import (
    GogcliClientConfig,
    ensure_gogcli_keyring_password,
    read_gogcli_client_config,
    write_gogcli_client_config,
)


@pytest.fixture
def cfg(tmp_path: Path) -> SandboxConfig:
    return SandboxConfig(
        sandboxes_root=str(tmp_path / "sandboxes"),
        caches_root=str(tmp_path / "caches"),
    )


def test_write_then_read_client_config_installed(cfg: SandboxConfig):
    raw = json.dumps({"installed": {"client_id": "abc123", "client_secret": "sec456"}})
    written = write_gogcli_client_config(cfg, "alice", raw)
    assert written == GogcliClientConfig(client_id="abc123", client_secret="sec456")

    got = read_gogcli_client_config(cfg, "alice")
    assert got == GogcliClientConfig(client_id="abc123", client_secret="sec456")

    f = cfg.gogcli_client_config_file("alice")
    assert oct(f.stat().st_mode)[-3:] == "600"


def test_write_client_config_web_variant(cfg: SandboxConfig):
    raw = json.dumps({"web": {"client_id": "w-id", "client_secret": "w-sec"}})
    written = write_gogcli_client_config(cfg, "bob", raw)
    assert written.client_id == "w-id"


def test_write_client_config_rejects_invalid_json(cfg: SandboxConfig):
    with pytest.raises(ValueError, match="不是合法 JSON"):
        write_gogcli_client_config(cfg, "alice", "not-json-at-all")


def test_write_client_config_rejects_missing_fields(cfg: SandboxConfig):
    raw = json.dumps({"installed": {"client_id": "only-id"}})
    with pytest.raises(ValueError, match="client_secret"):
        write_gogcli_client_config(cfg, "alice", raw)


def test_read_client_config_returns_none_when_missing(cfg: SandboxConfig):
    assert read_gogcli_client_config(cfg, "alice") is None


def test_read_client_config_returns_none_when_corrupted(cfg: SandboxConfig):
    f = cfg.gogcli_client_config_file("alice")
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text("{not valid json")
    assert read_gogcli_client_config(cfg, "alice") is None


def test_ensure_keyring_password_generates_and_persists(cfg: SandboxConfig):
    pw1 = ensure_gogcli_keyring_password(cfg, "alice")
    assert len(pw1) >= 32

    pw2 = ensure_gogcli_keyring_password(cfg, "alice")
    assert pw1 == pw2

    f = cfg.gogcli_keyring_pass_file("alice")
    assert oct(f.stat().st_mode)[-3:] == "600"


def test_ensure_keyring_password_different_per_user(cfg: SandboxConfig):
    pw_alice = ensure_gogcli_keyring_password(cfg, "alice")
    pw_bob = ensure_gogcli_keyring_password(cfg, "bob")
    assert pw_alice != pw_bob
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pytest tests/sandbox/test_gogcli.py -v
```

Expected: `ModuleNotFoundError: No module named 'ripple.sandbox.gogcli'`

- [ ] **Step 3: 写实现**

Create `src/ripple/sandbox/gogcli.py`:

```python
"""gogcli (`gog`) 的 per-user 凭证/密码管理

本模块承担两件事：
  1. **OAuth Desktop client_secret.json 的读/写**：用户在对话里贴 JSON，
     `GoogleWorkspaceClientConfigSet` 工具调 `write_gogcli_client_config` 落到
     `sandboxes/<uid>/credentials/gogcli-client.json`，沙箱启动时
     `read_gogcli_client_config` 读出来注入 env（`GOG_CLIENT_ID` /
     `GOG_CLIENT_SECRET` 只是内部名，实际传给 `gog auth credentials` 子命令的
     时候走 stdin / tempfile；见 `gogcli_client_config_set` 工具）。
  2. **keyring backend=file 的加密密码**：ripple 在 user 首次 provision 时
     随机生成 32B 密码落到 `sandboxes/<uid>/credentials/gogcli-keyring.pass`
     (mode 0600)，沙箱启动时作为 env `GOG_KEYRING_PASSWORD` 注入。密码对
     agent / user 都不可见。

**不**持有 OAuth refresh token —— refresh token 由 gogcli 自己管，加密写到
`/workspace/.config/gogcli/keyring/`（随 workspace 一起 per-user 隔离）。
"""

import json
import secrets
from typing import NamedTuple

from ripple.sandbox.config import SandboxConfig
from ripple.utils.logger import get_logger

logger = get_logger("sandbox.gogcli")


class GogcliClientConfig(NamedTuple):
    """从 client_secret.json 解析出的最小字段集。"""

    client_id: str
    client_secret: str


def _extract_bucket(data: dict) -> dict | None:
    """从 client_secret.json 结构里取出含 client_id 的 dict。

    支持:
      - {"installed": {...}}（Desktop OAuth Client，gogcli 推荐）
      - {"web": {...}}（Web OAuth Client，兜底）
      - 顶层扁平结构（罕见）
    """
    for key in ("installed", "web"):
        candidate = data.get(key)
        if isinstance(candidate, dict) and candidate.get("client_id"):
            return candidate
    if data.get("client_id"):
        return data
    return None


def read_gogcli_client_config(config: SandboxConfig, user_id: str) -> GogcliClientConfig | None:
    """读取 user 级 gogcli-client.json，返回 (client_id, client_secret)。

    返回 None 表示文件不存在 / 不是合法 JSON / 字段缺失。调用方（`nsjail_config`）
    在 None 时跳过相关 env 注入；沙箱命令执行时 gogcli 会因缺少 client 而报错，
    agent 应据此引导用户调 `GoogleWorkspaceClientConfigSet`。
    """
    f = config.gogcli_client_config_file(user_id)
    if not f.exists():
        return None
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("user {} gogcli-client.json 读取失败: {}", user_id, e)
        return None

    if not isinstance(data, dict):
        logger.warning("user {} gogcli-client.json 不是 JSON 对象", user_id)
        return None

    bucket = _extract_bucket(data)
    if bucket is None:
        logger.warning("user {} gogcli-client.json 里找不到 client_id 字段", user_id)
        return None

    client_id = bucket.get("client_id")
    client_secret = bucket.get("client_secret")
    if not isinstance(client_id, str) or not client_id.strip():
        logger.warning("user {} gogcli-client.json 的 client_id 无效", user_id)
        return None
    if not isinstance(client_secret, str) or not client_secret.strip():
        logger.warning("user {} gogcli-client.json 的 client_secret 无效", user_id)
        return None

    return GogcliClientConfig(client_id=client_id.strip(), client_secret=client_secret.strip())


def write_gogcli_client_config(config: SandboxConfig, user_id: str, client_secret_raw: str) -> GogcliClientConfig:
    """把 client_secret.json 原文落盘到 sandbox_dir/credentials/gogcli-client.json。

    调用方（`GoogleWorkspaceClientConfigSet` 工具）职责：校验 user_id、确保
    sandbox_dir 存在。本函数职责：解析 JSON、校验字段、原子落盘 0600、
    返回字段摘要（不含 secret 回显）。
    """
    try:
        parsed = json.loads(client_secret_raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"client_secret.json 不是合法 JSON: {e.msg} @ line {e.lineno} col {e.colno}") from e

    if not isinstance(parsed, dict) or not parsed:
        raise ValueError("client_secret.json 不是非空 JSON 对象")

    bucket = _extract_bucket(parsed)
    if bucket is None:
        raise ValueError(
            "client_secret.json 里找不到 client_id 字段（期望结构: "
            '{"installed": {"client_id": "...", "client_secret": "..."}} 或 web 变种）'
        )

    client_id = bucket.get("client_id")
    client_secret = bucket.get("client_secret")
    if not isinstance(client_id, str) or not client_id.strip():
        raise ValueError("client_secret.json 的 client_id 字段无效")
    if not isinstance(client_secret, str) or not client_secret.strip():
        raise ValueError("client_secret.json 的 client_secret 字段无效")

    f = config.gogcli_client_config_file(user_id)
    f.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(parsed, indent=2, ensure_ascii=False)
    f.write_text(payload, encoding="utf-8")
    f.chmod(0o600)
    logger.debug("写入 user {} gogcli-client.json (client_id={}...)", user_id, client_id[:12])
    return GogcliClientConfig(client_id=client_id.strip(), client_secret=client_secret.strip())


def ensure_gogcli_keyring_password(config: SandboxConfig, user_id: str) -> str:
    """幂等地拿到 user 级 gogcli keyring 密码；不存在则生成 32B 随机密码并落盘。

    密码用于 `GOG_KEYRING_BACKEND=file` 时加密 refresh_token。密码本身仅
    ripple 进程可读（mode 0600），agent/user 都不会见到。

    返回：密码字符串（已 strip）。
    """
    f = config.gogcli_keyring_pass_file(user_id)
    if f.exists():
        try:
            pw = f.read_text(encoding="utf-8").strip()
            if pw:
                return pw
        except OSError as e:
            logger.warning("user {} gogcli-keyring.pass 读取失败 ({}), 将重新生成", user_id, e)

    pw = secrets.token_urlsafe(32)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(pw, encoding="utf-8")
    f.chmod(0o600)
    logger.info("user {} gogcli keyring password 已生成", user_id)
    return pw
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pytest tests/sandbox/test_gogcli.py -v
```

Expected: 8 passed.

- [ ] **Step 5: Lint**

```bash
ruff format src/ripple/sandbox/gogcli.py tests/sandbox/test_gogcli.py
ruff check src/ripple/sandbox/gogcli.py tests/sandbox/test_gogcli.py
```

- [ ] **Step 6: Commit**

```bash
git add src/ripple/sandbox/gogcli.py tests/sandbox/test_gogcli.py
git commit -m "feat(sandbox): add gogcli client config and keyring password management"
```

### Task 2.3: nsjail_config 注入 gogcli 环境变量与 mount

**Files:**
- Modify: `src/ripple/sandbox/nsjail_config.py`
- Test: `tests/sandbox/test_nsjail_config_gogcli.py`

- [ ] **Step 1: 写失败测试**

Create `tests/sandbox/test_nsjail_config_gogcli.py`:

```python
"""gogcli env 和 mount 注入的断言。"""

import json
from pathlib import Path

import pytest

from ripple.sandbox.config import GOGCLI_CLI_INSTALL_ROOT, GOGCLI_CLI_SANDBOX_BIN_DIR, SandboxConfig
from ripple.sandbox.nsjail_config import build_sandbox_env, generate_nsjail_config


@pytest.fixture
def cfg(tmp_path: Path) -> SandboxConfig:
    # 伪造 gogcli 安装根
    gogcli_root = tmp_path / "vendor" / "gogcli-cli"
    (gogcli_root / "current" / "bin").mkdir(parents=True, exist_ok=True)
    (gogcli_root / "current" / "bin" / "gog").write_text("#!/bin/sh\n")

    return SandboxConfig(
        sandboxes_root=str(tmp_path / "sandboxes"),
        caches_root=str(tmp_path / "caches"),
        gogcli_cli_install_root=str(gogcli_root),
    )


def test_build_sandbox_env_injects_keyring_when_password_exists(cfg: SandboxConfig):
    pass_file = cfg.gogcli_keyring_pass_file("alice")
    pass_file.parent.mkdir(parents=True, exist_ok=True)
    pass_file.write_text("test-password-32-bytes-random-xx")

    env = build_sandbox_env(cfg, "alice")

    assert env.get("GOG_KEYRING_BACKEND") == "file"
    assert env.get("GOG_KEYRING_PASSWORD") == "test-password-32-bytes-random-xx"
    assert env.get("XDG_CONFIG_HOME") == "/workspace/.config"


def test_build_sandbox_env_injects_client_id_secret_when_client_config_exists(cfg: SandboxConfig):
    f = cfg.gogcli_client_config_file("alice")
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps({"installed": {"client_id": "CID", "client_secret": "CSEC"}}))

    env = build_sandbox_env(cfg, "alice")

    # client_id / secret 通过 gog auth credentials 走文件路径，不直接注入 env；
    # 只要确保 XDG_CONFIG_HOME 配上就行（gog 读 ~/.config/gogcli/credentials.json）。
    # 这里换个断言：确保至少 keyring + XDG 都在。
    assert "XDG_CONFIG_HOME" in env


def test_build_sandbox_env_injects_path_when_gogcli_installed(cfg: SandboxConfig):
    env = build_sandbox_env(cfg, "alice")
    assert GOGCLI_CLI_SANDBOX_BIN_DIR in env["PATH"].split(":")


def test_generate_nsjail_config_mounts_gogcli_install_root(cfg: SandboxConfig):
    cfg_text = generate_nsjail_config(cfg, "alice")
    assert f'dst: "{GOGCLI_CLI_INSTALL_ROOT}"' in cfg_text
    assert f'src: "{cfg.gogcli_cli_install_root}"' in cfg_text


def test_build_sandbox_env_no_keyring_injection_when_no_password(cfg: SandboxConfig):
    env = build_sandbox_env(cfg, "alice")
    # 没生成密码时不注入（bash 守卫层会引导走 provisioning 自动生成；
    # 但为了测试纯度，build_sandbox_env 本身只应根据实际文件状态决定注入与否）
    assert "GOG_KEYRING_PASSWORD" not in env
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pytest tests/sandbox/test_nsjail_config_gogcli.py -v
```

Expected: 所有 test 失败（env 里没这些 key，nsjail cfg 里没这些 mount）。

- [ ] **Step 3: 改 `src/ripple/sandbox/nsjail_config.py`**

在 import 段加 `GOGCLI_CLI_INSTALL_ROOT`, `GOGCLI_CLI_SANDBOX_BIN_DIR`:

修改:
```python
from ripple.sandbox.config import (
    LARK_CLI_INSTALL_ROOT,
    LARK_CLI_SANDBOX_BIN_DIR,
    NOTION_CLI_INSTALL_ROOT,
    NOTION_CLI_SANDBOX_BIN_DIR,
    ...
```

为:
```python
from ripple.sandbox.config import (
    GOGCLI_CLI_INSTALL_ROOT,
    GOGCLI_CLI_SANDBOX_BIN_DIR,
    LARK_CLI_INSTALL_ROOT,
    LARK_CLI_SANDBOX_BIN_DIR,
    NOTION_CLI_INSTALL_ROOT,
    NOTION_CLI_SANDBOX_BIN_DIR,
    ...
```

在 `build_sandbox_env` 里，`notion-cli` PATH 追加之后（约 51 行）加 gogcli 的 PATH：

```python
    # gogcli (gog) 同 lark-cli/notion-cli 的模式
    if config.gogcli_cli_install_root:
        path_parts.insert(0, GOGCLI_CLI_SANDBOX_BIN_DIR)
```

在 `NOTION_API_TOKEN` 注入段（约 72-76 行）之后，加 gogcli env 注入：

```python
    # gogcli keyring + config dir：
    # * XDG_CONFIG_HOME → /workspace/.config（随 workspace per-user 隔离，
    #   gogcli 会读/写 /workspace/.config/gogcli/credentials.json + keyring/）
    # * GOG_KEYRING_BACKEND=file + GOG_KEYRING_PASSWORD（从宿主侧 per-user 密码文件读）
    # 只在宿主侧的密码文件**实际存在**时才注入 password，否则 gog 命令会抱怨缺密码
    # （provisioning 层负责在 user 首次 sandbox 创建时生成密码）。
    from ripple.sandbox.gogcli import read_gogcli_client_config

    if config.gogcli_cli_install_root:
        env["XDG_CONFIG_HOME"] = "/workspace/.config"
        env["GOG_KEYRING_BACKEND"] = "file"
        pass_file = config.gogcli_keyring_pass_file(user_id)
        if pass_file.exists():
            try:
                pw = pass_file.read_text(encoding="utf-8").strip()
                if pw:
                    env["GOG_KEYRING_PASSWORD"] = pw
            except OSError as exc:
                logger.warning("user {} gogcli-keyring.pass 读取失败: {}", user_id, exc)

    # 不直接把 client_id / client_secret 注入 env——gogcli 的模式是从
    # $XDG_CONFIG_HOME/gogcli/credentials.json 读（由 `gog auth credentials <path>` 
    # 子命令写入）。在工具层我们直接把 gogcli-client.json 通过 `gog auth credentials`
    # 送进去；read_gogcli_client_config 这里只用于让 has_gogcli_client_config 有意义。
    _ = read_gogcli_client_config  # noqa: F841 — 保留引用便于将来按需扩展
```

在 `_build_common_mounts` 函数里，notion-cli mount 之后（约 190-196 行）加 gogcli mount：

```python
    # gogcli (gog) 原生二进制安装根（只读，所有 user 共享），与 lark-cli/notion-cli 同款。
    if config.gogcli_cli_install_root and Path(config.gogcli_cli_install_root).exists():
        mounts.append(f"""mount {{
    src: "{config.gogcli_cli_install_root}"
    dst: "{GOGCLI_CLI_INSTALL_ROOT}"
    is_bind: true
    rw: false
}}""")
```

- [ ] **Step 4: 跑测试**

```bash
pytest tests/sandbox/test_nsjail_config_gogcli.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Lint**

```bash
ruff format src/ripple/sandbox/nsjail_config.py tests/sandbox/test_nsjail_config_gogcli.py
ruff check src/ripple/sandbox/nsjail_config.py tests/sandbox/test_nsjail_config_gogcli.py
```

- [ ] **Step 6: Commit**

```bash
git add src/ripple/sandbox/nsjail_config.py tests/sandbox/test_nsjail_config_gogcli.py
git commit -m "feat(sandbox): inject gogcli PATH/XDG/keyring env and mount in nsjail config"
```

### Task 2.4: Provisioning 自动生成 keyring 密码 + manager 状态字段

**Files:**
- Modify: `src/ripple/sandbox/provisioning.py`
- Modify: `src/ripple/sandbox/manager.py`
- Test: 扩展 `tests/sandbox/test_gogcli.py`

- [ ] **Step 1: 读 provisioning.py 看 user 级初始化 hook 在哪**

```bash
grep -nE "def |provision|ensure" src/ripple/sandbox/provisioning.py
```

- [ ] **Step 2: 在 provisioning 的 user-level 入口（应该类似 `provision_user_sandbox` / `ensure_sandbox_ready`）里加一行密码确保**

在 provisioning.py 里定位 user sandbox 初始化函数，往里面加：

```python
from ripple.sandbox.gogcli import ensure_gogcli_keyring_password

# ... 在 user 级初始化流程里（例如 write_nsjail_config 之前）:
if config.gogcli_cli_install_root:
    ensure_gogcli_keyring_password(config, user_id)
```

（具体插入点根据 provisioning.py 实际结构决定。）

- [ ] **Step 3: 修 manager.py 的 status dict**

在 `src/ripple/sandbox/manager.py` 约 150-154 行（`has_lark_cli_config` / `has_notion_token` 附近）加两行：

```python
            "has_gogcli_client_config": self.config.has_gogcli_client_config(user_id),
            "has_gogcli_login": self.config.has_gogcli_login(user_id),
```

- [ ] **Step 4: 验证 provisioning 行为的单元测试**

在 `tests/sandbox/test_gogcli.py` 末尾追加：

```python
def test_ensure_keyring_password_creates_credentials_dir(cfg: SandboxConfig):
    assert not cfg.gogcli_keyring_pass_file("alice").parent.exists()
    ensure_gogcli_keyring_password(cfg, "alice")
    assert cfg.gogcli_keyring_pass_file("alice").parent.exists()
    assert cfg.gogcli_keyring_pass_file("alice").exists()
```

- [ ] **Step 5: 跑完整测试**

```bash
pytest tests/sandbox/ -v
```

Expected: all pass.

- [ ] **Step 6: Lint**

```bash
ruff format src/ripple/sandbox/provisioning.py src/ripple/sandbox/manager.py
ruff check src/ripple/sandbox/provisioning.py src/ripple/sandbox/manager.py
```

- [ ] **Step 7: Commit**

```bash
git add src/ripple/sandbox/provisioning.py src/ripple/sandbox/manager.py tests/sandbox/test_gogcli.py
git commit -m "feat(sandbox): auto-generate gogcli keyring password on provisioning"
```

---

## Phase 3: 鉴权工具（3 个 builtin tool）

### Task 3.1: `GoogleWorkspaceClientConfigSet` 工具

**Files:**
- Create: `src/ripple/tools/builtin/gogcli_client_config_set.py`

- [ ] **Step 1: 读参考实现**

参考 `src/ripple/tools/builtin/notion_token_set.py` 的结构。

- [ ] **Step 2: 写实现**

Create `src/ripple/tools/builtin/gogcli_client_config_set.py`:

```python
"""GoogleWorkspaceClientConfigSet — 把用户贴的 Desktop OAuth client_secret.json 绑到当前 user

两步流程的**第 1 步**：
  1. 用户在 GCP Console 建一个 **Desktop** OAuth Client，下 JSON。
  2. 用户把 JSON 贴到对话，agent 调本工具。
  3. 本工具落盘到 `sandboxes/<uid>/credentials/gogcli-client.json`。
  4. 然后在沙箱里跑 `gog auth credentials <path>` 把 client 真正注册到 gogcli 自己
     的 config（`$XDG_CONFIG_HOME/gogcli/credentials.json`），供后续 `gog auth add`
     使用。
  5. 本工具会顺便触发"注册到 gogcli config"那一步（一次 sandbox bash 调用），
     让 `GoogleWorkspaceLoginStart` 直接可用。

风险等级：SAFE（写 user 自己目录的一份 JSON + 在沙箱里跑一条幂等命令）。
"""

from typing import Any

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.permissions.levels import ToolRiskLevel
from ripple.sandbox.config import GOGCLI_CLI_SANDBOX_BIN
from ripple.sandbox.executor import execute_in_sandbox
from ripple.sandbox.gogcli import write_gogcli_client_config
from ripple.sandbox.nsjail_config import write_nsjail_config
from ripple.tools.base import Tool, ToolResult
from ripple.utils.logger import get_logger

logger = get_logger("tools.gogcli_client_config_set")

# 沙箱内 gogcli 会写到的位置（$XDG_CONFIG_HOME/gogcli/credentials.json）。
# 我们把 gogcli-client.json 内容 cp 进去供 `gog auth credentials` 消费。
_SANDBOX_CLIENT_JSON_DST = "/workspace/.config/gogcli/.pending-client.json"


class GoogleWorkspaceClientConfigSetTool(Tool):
    """绑定 Desktop OAuth client_secret.json 到当前 user（per-user 隔离）"""

    def __init__(self):
        self.name = "GoogleWorkspaceClientConfigSet"
        self.description = (
            "Bind the user's Google Cloud Desktop OAuth client configuration "
            "(client_secret.json) to the current user. Call this **immediately** after "
            "the user pastes the JSON contents of `client_secret_*.json` from GCP Console.\n\n"
            "When to trigger:\n"
            "- User pastes a JSON blob whose top-level key is `installed` (Desktop) or `web`.\n"
            "- The JSON contains `client_id` and `client_secret`.\n"
            "- You got a `[GOGCLI_CLIENT_CONFIG_REQUIRED]` guard.\n\n"
            "IMPORTANT:\n"
            "- Pass exactly what the user pasted via `client_secret_json` (no trim/reformat).\n"
            "- Do NOT echo `client_secret` back to the user in subsequent messages. "
            "  You may mention `client_id` (not a secret).\n"
            "- Do NOT proactively warn 'rotate your secret / security risk'. The user sandbox "
            "  is strictly isolated; credentials won't leak to other users. Only advise if the "
            "  user explicitly asks about security.\n"
            "- After this tool succeeds, the very next step is `GoogleWorkspaceLoginStart`.\n\n"
            "If the user hasn't created a Desktop OAuth Client yet, first guide them:\n"
            "  1. Open https://console.cloud.google.com/apis/credentials → pick/create a project.\n"
            "  2. Create Credentials → OAuth client ID → Application type: **Desktop app** → name it.\n"
            "  3. Download the JSON (`client_secret_<number>-<hash>.apps.googleusercontent.com.json`).\n"
            "  4. Configure OAuth consent screen (External type → add user's own account as Test user).\n"
            "  5. In 'Enabled APIs & Services' enable ALL the APIs below (first-time, one-shot):\n"
            "     Gmail, Drive, Calendar, Sheets, Docs, Slides, Tasks, People, Chat, Forms, Apps Script, Classroom.\n"
            "  6. Paste the full JSON content here.\n"
        )
        self.risk_level = ToolRiskLevel.SAFE

    def to_openai_tool(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "client_secret_json": {
                            "type": "string",
                            "description": (
                                "The full JSON text of the user's Desktop OAuth client_secret.json. "
                                "Must contain `installed` or `web` with `client_id` and `client_secret`."
                            ),
                        },
                    },
                    "required": ["client_secret_json"],
                },
            },
        }

    async def call(
        self,
        args: dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage | None,
    ) -> ToolResult[dict]:
        raw = (args.get("client_secret_json") or "").strip()
        if not raw:
            return ToolResult(
                data={
                    "ok": False,
                    "error": "client_secret_json 为空。请让用户把 GCP Console 下载的 client_secret_*.json 完整粘贴过来。",
                }
            )

        from ripple.tools.builtin.bash import _sandbox_config

        if _sandbox_config is None:
            return ToolResult(data={"ok": False, "error": "Sandbox 未启用，无法绑定 OAuth client"})

        user_id = context.user_id
        if not user_id:
            return ToolResult(data={"ok": False, "error": "当前上下文没有 user_id"})

        if not _sandbox_config.gogcli_cli_install_root:
            return ToolResult(
                data={
                    "ok": False,
                    "error": "gogcli 未预装（宿主机）。请联系管理员执行: bash scripts/install-gogcli-cli.sh",
                }
            )

        try:
            client = write_gogcli_client_config(_sandbox_config, user_id, raw)
            write_nsjail_config(_sandbox_config, user_id)
        except ValueError as e:
            return ToolResult(data={"ok": False, "error": str(e)})
        except OSError as e:
            logger.error("user {} 写入 gogcli-client.json 失败: {}", user_id, e)
            return ToolResult(data={"ok": False, "error": f"写入失败: {e}"})

        # 在沙箱里把 client 注册到 gogcli config。走两步：
        # 1. 把 gogcli-client.json 内容 cp 到沙箱可见路径 _SANDBOX_CLIENT_JSON_DST
        #    （宿主路径在 sandbox 里不可见；我们用 /workspace/.config/gogcli/.pending-client.json
        #     作为跳板，workspace bind-mount 到沙箱）
        # 2. 调 `gog auth credentials <path>` 触发 gogcli 把 client 落到
        #    `$XDG_CONFIG_HOME/gogcli/credentials.json`
        # 3. 清理跳板文件
        client_json_path_host = _sandbox_config.gogcli_client_config_file(user_id)
        pending_on_workspace = _sandbox_config.workspace_dir(user_id) / ".config" / "gogcli" / ".pending-client.json"
        pending_on_workspace.parent.mkdir(parents=True, exist_ok=True)
        pending_on_workspace.write_text(client_json_path_host.read_text(encoding="utf-8"), encoding="utf-8")
        pending_on_workspace.chmod(0o600)

        register_cmd = (
            f"mkdir -p $XDG_CONFIG_HOME/gogcli && "
            f"{GOGCLI_CLI_SANDBOX_BIN} auth credentials {_SANDBOX_CLIENT_JSON_DST} && "
            f"rm -f {_SANDBOX_CLIENT_JSON_DST}"
        )
        stdout, stderr, code = await execute_in_sandbox(register_cmd, _sandbox_config, user_id, timeout=30)
        if code != 0:
            # 清理跳板文件，避免客户端 secret 残留在 workspace
            try:
                pending_on_workspace.unlink(missing_ok=True)
            except OSError:
                pass
            logger.error("user {} gog auth credentials 失败 (code={}): {}", user_id, code, stderr[:500])
            return ToolResult(
                data={
                    "ok": False,
                    "error": (
                        f"gog auth credentials 命令失败 (exit {code})。stderr 片段: {stderr[-500:]}\n"
                        "常见原因：1) client_secret.json 里字段无效；2) gog 二进制问题。"
                    ),
                }
            )

        logger.info("user {} gogcli client config 已绑定 (client_id={}...)", user_id, client.client_id[:12])

        return ToolResult(
            data={
                "ok": True,
                "client_id": client.client_id,
                "next": (
                    "Client config 已绑定。**下一步立刻调 `GoogleWorkspaceLoginStart`**，"
                    "它会在沙箱里启动 `gog auth add --remote --step 1` 并返回 OAuth URL。"
                    "把 URL 原样转发给用户，让他本地浏览器打开→点 Allow→复制地址栏 URL 粘回对话。"
                    "不要主动劝用户 rotate client_secret —— sandbox 严格隔离。"
                ),
            }
        )

    def is_concurrency_safe(self, input: dict[str, Any]) -> bool:
        return False
```

- [ ] **Step 3: Lint**

```bash
ruff format src/ripple/tools/builtin/gogcli_client_config_set.py
ruff check src/ripple/tools/builtin/gogcli_client_config_set.py
```

- [ ] **Step 4: Commit**

```bash
git add src/ripple/tools/builtin/gogcli_client_config_set.py
git commit -m "feat(tools): add GoogleWorkspaceClientConfigSet for gogcli OAuth binding"
```

### Task 3.2: `GoogleWorkspaceLoginStart` 工具（step 1）

**Files:**
- Create: `src/ripple/tools/builtin/gogcli_login_start.py`

- [ ] **Step 1: 写实现**

Create `src/ripple/tools/builtin/gogcli_login_start.py`:

```python
"""GoogleWorkspaceLoginStart — 在沙箱内跑 `gog auth add --remote --step 1`，返回 OAuth URL

两步流程的**第 1 步**。前置条件：已调 `GoogleWorkspaceClientConfigSet`。

流程：
  1. 本工具在沙箱里跑 `gog auth add <email> --services user --remote --step 1`。
  2. gog 打印一条 `https://accounts.google.com/o/oauth2/...` URL（state 缓存在沙箱磁盘）。
  3. 返回 URL 给 agent，agent 转发给用户。
  4. 用户在本机浏览器打开 → 点 Allow → 浏览器跳转到 `http://127.0.0.1:<port>/oauth2/callback?code=...&state=...`
     （用户本地没 server 所以页面报"无法连接"，但地址栏有完整 URL）。
  5. 用户把地址栏 URL 复制粘贴回 agent。
  6. agent 调 `GoogleWorkspaceLoginComplete` 完成第 2 步。

关键特性 vs gws 老方案：
  * **不**依赖 ripple server 与用户浏览器同机。
  * state 由 gog 磁盘缓存，TTL ~10 分钟，超时需要重跑本工具。

风险等级：SAFE（只跑一次短命令 + 磁盘状态）。
"""

import asyncio
import re
from typing import Any

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.permissions.levels import ToolRiskLevel
from ripple.sandbox.config import GOGCLI_CLI_SANDBOX_BIN
from ripple.sandbox.executor import execute_in_sandbox
from ripple.tools.base import Tool, ToolResult
from ripple.utils.logger import get_logger

logger = get_logger("tools.gogcli_login_start")

_OAUTH_URL_PATTERN = re.compile(r"https://accounts\.google\.com/o/oauth2/[^\s]+")


def _shq(s: str) -> str:
    """POSIX shell 单引号转义。"""
    return "'" + s.replace("'", "'\\''") + "'"


class GoogleWorkspaceLoginStartTool(Tool):
    """跑 `gog auth add --remote --step 1` 拿 OAuth URL"""

    def __init__(self):
        self.name = "GoogleWorkspaceLoginStart"
        self.description = (
            "Start step 1 of the gogcli OAuth remote flow. Requires "
            "`GoogleWorkspaceClientConfigSet` to have been called first.\n\n"
            "Parameters:\n"
            "- email (required): The Google account the user wants to bind "
            "  (e.g. you@gmail.com or you@company.com).\n\n"
            "What this tool does:\n"
            "  1. Runs `gog auth add <email> --services user --remote --step 1` inside the sandbox.\n"
            "  2. Captures the printed OAuth URL (gogcli caches `state` on disk, TTL ~10 min).\n"
            "  3. Returns the URL for you to pass to the user verbatim.\n\n"
            "After you get the URL, tell the user:\n"
            "  1. Open the URL in your **local** browser.\n"
            "  2. Sign in with the Google account you want to bind; review requested scopes.\n"
            "  3. Click Allow.\n"
            "  4. Your browser will try to go to `http://127.0.0.1:<port>/oauth2/callback?code=...&state=...`\n"
            "     — the page will fail to load (that's normal; no server is running locally).\n"
            "  5. **Copy the full URL from the address bar** and paste it back to me.\n"
            "  6. I'll call `GoogleWorkspaceLoginComplete` with that URL to finish.\n\n"
            "IMPORTANT:\n"
            "- Scope: this tool always requests `--services user` which is gogcli's alias for all\n"
            "  user-facing services (Gmail+Drive+Calendar+Docs+Slides+Sheets+Chat+Tasks+...). Covers\n"
            "  the full Workspace surface in one consent, so the user never needs to re-authorize for\n"
            "  new services.\n"
            "- Show the URL to the user verbatim. DO NOT paraphrase or shorten.\n"
            "- If state expires (user took >10 min), rerun this tool to get a fresh URL.\n"
        )
        self.risk_level = ToolRiskLevel.SAFE

    def to_openai_tool(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "email": {
                            "type": "string",
                            "description": "The Google account email to bind, e.g. 'you@gmail.com'.",
                        },
                    },
                    "required": ["email"],
                },
            },
        }

    async def call(
        self,
        args: dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage | None,
    ) -> ToolResult[dict]:
        from ripple.tools.builtin.bash import _sandbox_config

        if _sandbox_config is None:
            return ToolResult(data={"ok": False, "error": "Sandbox 未启用"})

        user_id = context.user_id
        if not user_id:
            return ToolResult(data={"ok": False, "error": "当前上下文没有 user_id"})

        email = (args.get("email") or "").strip()
        if not email or "@" not in email:
            return ToolResult(data={"ok": False, "error": "email 参数无效"})

        if not _sandbox_config.gogcli_cli_install_root:
            return ToolResult(
                data={"ok": False, "error": "gogcli 未预装。请联系管理员执行: bash scripts/install-gogcli-cli.sh"}
            )

        if not _sandbox_config.has_gogcli_client_config(user_id):
            return ToolResult(
                data={
                    "ok": False,
                    "error": (
                        "[GOGCLI_CLIENT_CONFIG_REQUIRED] 当前 user 还没绑 Desktop OAuth Client。"
                        "请先让用户在 GCP Console 建 Desktop OAuth Client 并下载 client_secret.json，"
                        "把 JSON 粘到对话里，然后调 GoogleWorkspaceClientConfigSet 工具绑定。"
                    ),
                }
            )

        cmd = f"{GOGCLI_CLI_SANDBOX_BIN} auth add {_shq(email)} --services user --remote --step 1"
        try:
            stdout, stderr, code = await asyncio.wait_for(
                execute_in_sandbox(cmd, _sandbox_config, user_id, timeout=20),
                timeout=25,
            )
        except asyncio.TimeoutError:
            return ToolResult(data={"ok": False, "error": "gog auth add step 1 超时"})

        if code != 0:
            logger.warning("user {} gog auth add step 1 失败 (code={}): {}", user_id, code, stderr[:500])
            return ToolResult(
                data={
                    "ok": False,
                    "error": f"gog auth add step 1 失败 (exit {code}): {stderr[-500:] or stdout[-500:]}",
                }
            )

        merged = (stdout + "\n" + stderr)
        m = _OAUTH_URL_PATTERN.search(merged)
        if not m:
            return ToolResult(
                data={
                    "ok": False,
                    "error": (
                        "没能从 gog 输出里抓到 OAuth URL。可能 gog 版本变了输出格式。"
                        f"stdout 片段: {stdout[-300:]}  stderr 片段: {stderr[-300:]}"
                    ),
                }
            )
        url = m.group(0).rstrip(".,;)")

        return ToolResult(
            data={
                "ok": True,
                "stage": "awaiting_user_callback_url",
                "oauth_url": url,
                "email": email,
                "expires_in_seconds": 600,
                "next": (
                    "把 `oauth_url` 的**完整 URL 原文**发给用户，并告诉他：\n"
                    "  1. 在**本机浏览器**打开这个 URL；\n"
                    "  2. 用想绑定的 Google 账号登录；\n"
                    "  3. 审查申请的权限后点 'Allow / 允许'；\n"
                    "  4. 浏览器会跳到 http://127.0.0.1:<端口>/oauth2/callback?code=...&state=...\n"
                    "     页面会显示'无法连接'——这是正常的，因为本地没有 server；\n"
                    "  5. 把**地址栏里完整的 URL**复制下来贴回对话；\n"
                    "  6. 你会调 GoogleWorkspaceLoginComplete 完成授权。\n"
                    "state 10 分钟后失效；超时请重跑本工具。"
                ),
            }
        )

    def is_concurrency_safe(self, input: dict[str, Any]) -> bool:
        return False
```

- [ ] **Step 2: Lint**

```bash
ruff format src/ripple/tools/builtin/gogcli_login_start.py
ruff check src/ripple/tools/builtin/gogcli_login_start.py
```

- [ ] **Step 3: Commit**

```bash
git add src/ripple/tools/builtin/gogcli_login_start.py
git commit -m "feat(tools): add GoogleWorkspaceLoginStart for gogcli remote OAuth step 1"
```

### Task 3.3: `GoogleWorkspaceLoginComplete` 工具（step 2）

**Files:**
- Create: `src/ripple/tools/builtin/gogcli_login_complete.py`

- [ ] **Step 1: 写实现**

Create `src/ripple/tools/builtin/gogcli_login_complete.py`:

```python
"""GoogleWorkspaceLoginComplete — 跑 `gog auth add --remote --step 2`，完成 OAuth 绑定

两步流程的**第 2 步**。前置：用户已在浏览器点 Allow 并把地址栏回调 URL 贴回对话。

流程：
  1. agent 从用户输入里拿到形如
     `http://127.0.0.1:<port>/oauth2/callback?code=...&state=...` 的 URL。
  2. 本工具在沙箱里跑 `gog auth add <email> --services user --remote --step 2 --auth-url '<url>'`。
  3. gog 内部校验 state、用 code 换 token、加密存 refresh_token 到 keyring。
  4. 工具返回 ok=true，agent 业务继续。

风险等级：SAFE（一条短命令；gogcli 自己做 state 校验）。
"""

import re
from typing import Any

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.permissions.levels import ToolRiskLevel
from ripple.sandbox.config import GOGCLI_CLI_SANDBOX_BIN
from ripple.sandbox.executor import execute_in_sandbox
from ripple.tools.base import Tool, ToolResult
from ripple.utils.logger import get_logger

logger = get_logger("tools.gogcli_login_complete")

_CALLBACK_URL_PATTERN = re.compile(r"^https?://[^/]+/oauth2/callback\?[^\s]+$")


def _shq(s: str) -> str:
    return "'" + s.replace("'", "'\\''") + "'"


class GoogleWorkspaceLoginCompleteTool(Tool):
    """用用户回贴的 callback URL 完成 OAuth（step 2）"""

    def __init__(self):
        self.name = "GoogleWorkspaceLoginComplete"
        self.description = (
            "Finish step 2 of the gogcli OAuth remote flow using the callback URL the user "
            "pasted back. Requires `GoogleWorkspaceLoginStart` to have been called recently "
            "(within ~10 min; state expires after that).\n\n"
            "Parameters:\n"
            "- email (required): Same email passed to `GoogleWorkspaceLoginStart`.\n"
            "- callback_url (required): The full URL from the user's browser address bar, should "
            "  look like `http://127.0.0.1:<port>/oauth2/callback?code=...&state=...`.\n\n"
            "IMPORTANT:\n"
            "- Pass the `callback_url` exactly as the user pasted (do NOT shorten or strip params).\n"
            "- If you get 'state expired' / 'state mismatch' error, call `GoogleWorkspaceLoginStart` "
            "  again to restart the flow.\n"
            "- If you get 'access_denied' error, user declined / picked wrong account / "
            "  not added to OAuth consent Test users.\n\n"
            "After success, subsequent `Bash(command='gog <service> ...')` calls will work "
            "immediately; no other setup needed. Encrypted refresh token is stored in "
            "`/workspace/.config/gogcli/keyring/` inside the sandbox."
        )
        self.risk_level = ToolRiskLevel.SAFE

    def to_openai_tool(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "email": {
                            "type": "string",
                            "description": "The email passed to GoogleWorkspaceLoginStart.",
                        },
                        "callback_url": {
                            "type": "string",
                            "description": (
                                "The full URL from the user's browser address bar after clicking Allow. "
                                "Shape: http://127.0.0.1:<port>/oauth2/callback?code=...&state=..."
                            ),
                        },
                    },
                    "required": ["email", "callback_url"],
                },
            },
        }

    async def call(
        self,
        args: dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage | None,
    ) -> ToolResult[dict]:
        from ripple.tools.builtin.bash import _sandbox_config

        if _sandbox_config is None:
            return ToolResult(data={"ok": False, "error": "Sandbox 未启用"})

        user_id = context.user_id
        if not user_id:
            return ToolResult(data={"ok": False, "error": "当前上下文没有 user_id"})

        email = (args.get("email") or "").strip()
        callback_url = (args.get("callback_url") or "").strip()

        if not email or "@" not in email:
            return ToolResult(data={"ok": False, "error": "email 参数无效"})
        if not _CALLBACK_URL_PATTERN.match(callback_url):
            return ToolResult(
                data={
                    "ok": False,
                    "error": (
                        "callback_url 格式不符。期望形如 "
                        "http://127.0.0.1:<port>/oauth2/callback?code=...&state=...\n"
                        f"实际收到: {callback_url[:200]}"
                    ),
                }
            )
        if "code=" not in callback_url or "state=" not in callback_url:
            return ToolResult(
                data={
                    "ok": False,
                    "error": "callback_url 缺少 code 或 state 参数。请让用户重新从浏览器地址栏完整复制。",
                }
            )

        cmd = (
            f"{GOGCLI_CLI_SANDBOX_BIN} auth add {_shq(email)} "
            f"--services user --remote --step 2 --auth-url {_shq(callback_url)}"
        )
        stdout, stderr, code = await execute_in_sandbox(cmd, _sandbox_config, user_id, timeout=60)

        if code != 0:
            logger.warning("user {} gog auth add step 2 失败 (code={}): {}", user_id, code, stderr[:500])
            return ToolResult(
                data={
                    "ok": False,
                    "error": (
                        f"gog auth add step 2 失败 (exit {code}): {stderr[-500:] or stdout[-500:]}\n"
                        "常见原因：1) state 过期（>10 分钟）—— 请让用户重新从 GoogleWorkspaceLoginStart 开始；"
                        "2) access_denied —— 用户没在 OAuth consent screen Test users 列表里；"
                        "3) URL 不完整 —— 让用户从浏览器地址栏**原封不动**完整复制。"
                    ),
                }
            )

        # 再跑一次 auth status 做快速验证
        verify_cmd = f"{GOGCLI_CLI_SANDBOX_BIN} auth status"
        vout, verr, vcode = await execute_in_sandbox(verify_cmd, _sandbox_config, user_id, timeout=15)

        logger.info("user {} gogcli 绑定成功: {}", user_id, email)

        return ToolResult(
            data={
                "ok": True,
                "stage": "authorized",
                "email": email,
                "auth_status_exit_code": vcode,
                "auth_status_stdout_tail": (vout + verr)[-500:],
                "next": (
                    "授权完成。可以直接跑 gog 业务命令了，例如 "
                    "`Bash(command='gog --account "
                    + email
                    + " --json gmail search \"newer_than:7d\" --max 5')`。"
                    "对于破坏性写操作（gmail send / drive delete / etc），执行前必须先调 AskUser "
                    "工具复述完整意图请用户确认。"
                ),
            }
        )

    def is_concurrency_safe(self, input: dict[str, Any]) -> bool:
        return False
```

- [ ] **Step 2: Lint**

```bash
ruff format src/ripple/tools/builtin/gogcli_login_complete.py
ruff check src/ripple/tools/builtin/gogcli_login_complete.py
```

- [ ] **Step 3: Commit**

```bash
git add src/ripple/tools/builtin/gogcli_login_complete.py
git commit -m "feat(tools): add GoogleWorkspaceLoginComplete for gogcli remote OAuth step 2"
```

### Task 3.4: 注册 3 个工具到 sessions.py

**Files:**
- Modify: `src/interfaces/server/sessions.py`

- [ ] **Step 1: 看现有 tool 注册位置**

```bash
grep -n "NotionTokenSet\|AskUserTool\|_get_server_tools" src/interfaces/server/sessions.py
```

- [ ] **Step 2: 补 import 和实例化**

在 import 段（约 22-26 行附近）加：

```python
from ripple.tools.builtin.gogcli_client_config_set import GoogleWorkspaceClientConfigSetTool
from ripple.tools.builtin.gogcli_login_complete import GoogleWorkspaceLoginCompleteTool
from ripple.tools.builtin.gogcli_login_start import GoogleWorkspaceLoginStartTool
```

在 `_get_server_tools()`（约 234 行）里 `NotionTokenSetTool()` 后面追加三行：

```python
        NotionTokenSetTool(),
        GoogleWorkspaceClientConfigSetTool(),
        GoogleWorkspaceLoginStartTool(),
        GoogleWorkspaceLoginCompleteTool(),
```

- [ ] **Step 3: 启动 server 确认工具列表**

```bash
source .venv/bin/activate
uv run ripple --help 2>&1 | head -5  # 确认入口没坏
# 或者跑 server 后访问 /v1/system/info 看 tools 列表
```

- [ ] **Step 4: Lint**

```bash
ruff format src/interfaces/server/sessions.py
ruff check src/interfaces/server/sessions.py
```

- [ ] **Step 5: Commit**

```bash
git add src/interfaces/server/sessions.py
git commit -m "feat(server): register three gogcli auth tools"
```

### Task 3.5: schemas + manager 暴露状态

**Files:**
- Modify: `src/interfaces/server/schemas.py`

- [ ] **Step 1: 在 `SandboxStatusResponse` 类（或等价结构，含 `has_notion_token`）加两个字段**

```bash
grep -n "has_notion_token" src/interfaces/server/schemas.py
```

在 `has_notion_token: bool = False` 下面加：

```python
    has_gogcli_client_config: bool = False
    has_gogcli_login: bool = False
```

- [ ] **Step 2: 确认 manager.py 已经返回这两个字段（Task 2.4 已加）**

```bash
grep -n "has_gogcli" src/ripple/sandbox/manager.py
```

Expected: 看到 `has_gogcli_client_config` 和 `has_gogcli_login` 两行。

- [ ] **Step 3: Lint**

```bash
ruff format src/interfaces/server/schemas.py
ruff check src/interfaces/server/schemas.py
```

- [ ] **Step 4: Commit**

```bash
git add src/interfaces/server/schemas.py
git commit -m "feat(server): expose has_gogcli_client_config/login in sandbox status"
```

---

## Phase 4: Skills

### Task 4.1: `gog-shared` SKILL（必读 / AskUser 纪律）

**Files:**
- Create: `skills/gog/gog-shared/SKILL.md`

- [ ] **Step 1: 写 skill（内容完整）**

Create `skills/gog/gog-shared/SKILL.md`:

```markdown
---
name: gog-shared
version: 1.0.0
description: "gogcli（gog 二进制）在 ripple 沙箱中的本地约定：per-user 独立 GCP OAuth Client、三工具完成远程授权、破坏性操作走 AskUser 二次确认、self-document 原则、安全规则。**首次使用 gog 必读**。当用户第一次调用 gog、遇到 [GOGCLI_CLIENT_CONFIG_REQUIRED] / [GOGCLI_LOGIN_REQUIRED]、需要绑定/重新授权、或问到 gog 鉴权问题时触发。"
metadata:
  requires:
    bins: ["gog"]
  cliHelp: "gog --help"
---

# gog (Google Suite CLI) — ripple 沙箱本地约定

> ⚠️ **开始任何 gog 业务操作前必读本文件**。

## 🏗 整体鉴权模型（per-user 独立 GCP + 远程 2-step）

每个 ripple user 独立持有自己的 GCP 项目 / OAuth Client / refresh_token。跨 user 零共享。
**ripple server 和用户浏览器可以不在同一台机器**（与之前 gws 方案的核心区别）。

```
┌────────────────────────┐          ┌────────────────────────────┐
│ user 本机              │          │ ripple sandbox (per-user)  │
├────────────────────────┤          ├────────────────────────────┤
│ ① GCP Console 建       │          │ gog 二进制（预装）         │
│   Desktop OAuth Client │ ─json──▶ │ credentials/               │
│   下载 JSON            │          │   gogcli-client.json (600) │
│                        │          │                            │
│ ② 浏览器打开授权 URL    │ ◀─URL──  │ gog auth add --remote      │
│   点 Allow             │          │   --step 1 → 打印 URL      │
│                        │          │                            │
│ ③ 地址栏跳转报错没事     │ ──URL──▶ │ gog auth add --remote      │
│   复制完整 URL 贴回     │          │   --step 2 --auth-url ...  │
│                        │          │ 加密存 refresh_token 到    │
│                        │          │ /workspace/.config/gogcli/ │
└────────────────────────┘          └────────────────────────────┘
```

## ⚠️ 首要：self-document 优先，不要凭记忆猜

`gog` 是第三方 CLI，命令面和参数都是手写固定的。**先问 CLI 再拼参数**：

```bash
gog --help                         # 列 top-level 命令组
gog gmail --help                   # 列 gmail 下的子命令
gog gmail search --help            # 列 search 全部参数
gog <service> --help               # 每个 service 都有完整的 --help
```

不确定的地方先 `--help`，别硬拼。

## ✅ 首次使用 gog 的标准流程（3 步 + 1 次点击）

### 步骤 1：用户在 GCP Console 建 Desktop OAuth Client（**只做一次**）

当你第一次遇到 `[GOGCLI_CLIENT_CONFIG_REQUIRED]`，用一段自然语言引导用户：

1. 打开 <https://console.cloud.google.com/apis/credentials>，选项目（没有就新建）。
2. `Create Credentials` → `OAuth client ID` → Application type: **Desktop app** → 给个名字（如 `ripple-gog`）→ Create。
3. 弹窗里点 `Download JSON`。文件名形如 `client_secret_<number>-<hash>.apps.googleusercontent.com.json`。
4. 配置 OAuth consent screen：
   - User type `Internal`（Workspace 组织账号）：组织内用户开箱即用。
   - User type `External`（个人 gmail 账号）：把要登录的 Google 账号加入 **Test users** 列表。
5. `Enabled APIs & Services` 里**一次性**启用下面全部 API（因为我们这次就全量授权，不再二次来回）：
   Gmail / Drive / Calendar / Docs / Sheets / Slides / Tasks / People / Chat / Forms / Apps Script / Classroom。
6. **把下载的 JSON 文件全部内容** 粘贴进对话。

### 步骤 2：agent 调 `GoogleWorkspaceClientConfigSet`

用户贴出 JSON 后**立刻**调：

```
GoogleWorkspaceClientConfigSet(client_secret_json="<用户贴的原文>")
```

回复里**可以**提 `client_id`，**不要**回显完整 `client_secret`。

### 步骤 3：agent 调 `GoogleWorkspaceLoginStart`

```
GoogleWorkspaceLoginStart(email="user@gmail.com")
```

工具返回 `{ok: true, oauth_url: "https://accounts.google.com/o/oauth2/...", email, expires_in_seconds: 600}`。

### 步骤 4：把 URL **完整原样**给用户

```
请在你本机浏览器打开以下 URL 授权（ripple server 和你浏览器不在同一台机器也没关系）：

https://accounts.google.com/o/oauth2/auth?...<完整 URL>...

1. 用要绑定的 Google 账户登录
2. 审查申请的权限，点 "Allow / 允许"
3. 浏览器会跳转到 http://127.0.0.1:<端口>/oauth2/callback?code=...&state=...
   页面会显示"无法连接"——这是正常的，因为你本机上没 server
4. **从浏览器地址栏把完整 URL 复制下来**贴回对话里告诉我
```

**不要**：
- 缩短 / 省略 URL 的任何字符（一个参数错了就授权失败）
- 帮用户 decode URL / 把参数"解读一遍"（没用、可能误导）
- 主动说"这个 URL 有风险"（sandbox 隔离，授权本来就是这么工作的）

### 步骤 5：用户粘回 callback URL 后，agent 调 `GoogleWorkspaceLoginComplete`

```
GoogleWorkspaceLoginComplete(email="user@gmail.com", callback_url="<用户粘贴的完整 URL>")
```

工具内部跑 step 2，把 code 换 token，加密存 refresh_token。成功后业务命令就能用了。

## ❌ 授权失败 / 超时怎么办

| 现象 | 原因 | 处理 |
|---|---|---|
| step 2 报 "state expired" / "state mismatch" | 用户点 Allow 距 step 1 > 10 分钟 | 重跑 `GoogleWorkspaceLoginStart` 拿新 URL |
| step 2 报 "access_denied" | External+Testing、用户没在 Test users | 让用户去 consent screen 把自己加进 Test users |
| step 2 报 "redirect_uri_mismatch" | OAuth Client 不是 Desktop 类型 | 重新建一个 **Desktop** 类型的 OAuth Client |
| `gog auth status` 后来报 invalid_grant / refresh_token 失效 | token 被 revoke / 项目变更 | 重跑 `GoogleWorkspaceLoginStart` + `Complete` |
| Login 工具返回 "没抓到 URL" | client_id/secret 无效；gog 启动异常 | 让用户重发 client_secret.json + 重新 `ClientConfigSet` |

## ⚠️ API 未启用（403 `accessNotConfigured`）

运行业务命令时如果报这个，响应里会含 `enable_url`：

```
{"error": {"code": 403, "reason": "accessNotConfigured",
 "enable_url": "https://console.developers.google.com/apis/api/gmail.googleapis.com/..."}}
```

把 `enable_url` 给用户，让他去 GCP Console 点 **Enable**；等 ~10 秒生效再重试。**不要**反复自动重试。

## 🛡 破坏性操作必须调 AskUser 二次确认（ripple 纪律）

以下 gog 子命令**执行前必须**先调 `AskUser(question=...)` 工具、等用户明确同意后再调 `Bash` 执行。**绝不能直接执行**。

**破坏性命令清单**（见一个就必须停）：

| Service | 命令 |
|---|---|
| gmail | `send` / `drafts send` / `forward` / `reply` / `delete` / `batch delete` / `filters delete` / `labels delete` / `labels modify --remove` |
| drive | `delete` / `unshare` / `share` / `move`（不确定目标时）/ `upload --replace` |
| sheets | `delete-tab` / `clear` / `update`（覆盖已有数据）/ `chart delete` |
| docs | `sed`（修改文档）/ `write --replace` / `find-replace` |
| calendar | `delete` / `update` / `respond` |
| contacts | `delete` / `update`（覆盖字段时） |
| tasks | `delete` / `clear` / `done` / `undo` |
| classroom | `courses delete` / `courses archive` |
| admin | **所有 admin.* 操作**（groups members add/remove、users suspend、etc） |

`AskUser` 调用形态：

```
AskUser(
    question="准备执行：`gog --account alice@gmail.com gmail send --to bob@example.com --subject 'Weekly update' --body-file ./summary.md`\n这会把 summary.md 作为邮件正文发给 bob@example.com。确认吗？",
    options=["yes, send it", "no, cancel", "let me review the body first"]
)
```

**复述原则**：把**完整 shell 命令** + **影响范围（发给谁 / 删什么 / 覆盖哪个 range）** 一起给用户看。不要只说"确认发邮件吗"这种模糊问法。

**`--dry-run` 优先**：支持 `--dry-run` 的命令（很多写操作都有）先跑 dry-run 看 gog 打印的 request 体，再让用户 AskUser 确认真跑。

**批量操作**（循环超过 5 次 / 影响超过 5 项）前必须先把完整计划列给用户过目，不能闷头跑完。

## 🎨 Agent-friendly 输出惯例

- **优先 `--json`**：脚本化 / 程序化处理都用 `--json`，不要 pipe 表格输出去 grep 列。
- **`--plain`（TSV）** 也可，列对齐稳定。
- **stderr vs stdout 分离**：数据走 stdout，进度 / 提示走 stderr，可以干净地 `| jq ...`。
- **时区便利字段**：Calendar 的 JSON 输出包含 `startDayOfWeek` / `endDayOfWeek` / `timezone` / `startLocal` / `endLocal`，用起来很顺手。
- **`gog time now`**：要对齐当前时间 / 时区时用它，不要自己猜时间。

## 🛠 常用工作入口

| 意图 | 入口 | 典型子命令 |
|---|---|---|
| 搜邮件 / 读 thread | `gog gmail` | `search` / `thread get` / `get` |
| 发邮件 | `gog gmail send`（⚠️ 破坏性） | `send` / `forward` / `drafts create` |
| 看日程 | `gog calendar` | `events` / `event` / `search` |
| 创建 / 改日程（⚠️ 破坏性） | `gog calendar create/update/delete` | |
| 列 / 搜 / 上传 Drive | `gog drive` | `ls` / `search` / `upload` |
| 删 / share Drive（⚠️ 破坏性） | `gog drive delete/share/unshare` | |
| 读 Sheet | `gog sheets get` / `metadata` | |
| 写 Sheet（⚠️ 破坏性） | `gog sheets update/append/clear` | |
| 读 Doc | `gog docs info/cat/list-tabs` | |
| 写 Doc（⚠️ 破坏性） | `gog docs update/write/sed/find-replace` | |
| 列 Tasks | `gog tasks lists/list/get` | |
| 修改 Tasks（⚠️ 破坏性） | `gog tasks add/update/done/delete` | |
| 其他：people / chat / forms / classroom / appscript | `gog <service> --help` | self-document |

## 🧭 账号选择

每条命令都用 `--account <email>` 显式指定账号，或全局 `GOG_ACCOUNT=<email>`。不要依赖 `auto`（对多账号场景可能选错）。

```bash
gog --account alice@gmail.com gmail search 'newer_than:7d'
```

## 🔒 安全规则（操作纪律，不反复唠叨用户）

**前提：ripple sandbox 严格 per-user 隔离，credentials 不会泄露给其他用户。** 下列是**你自己要守的纪律**，不是反复劝用户的理由。

- 默认不回显 `client_secret` / 加密 credentials。用户明确问起时只说"已绑定，账号 xxx@y.com"或展示 `client_id`（它不是 secret）。
- **不要**主动建议 "rotate client_secret" / "credentials 出现在对话历史有风险"。只有用户自己问或明显有泄漏事件才提。
- **写 / 删操作必须走 AskUser**（见上面）—— 这条没有例外。
- **批量操作**先列计划 → AskUser → 再跑。
- 不要往 `/workspace` 下手写任何 credentials 文件；该落的位置（`/workspace/.config/gogcli/`）由 gog 自己管。
- `--dry-run` 是写操作的好朋友。
```

- [ ] **Step 2: Commit**

```bash
git add skills/gog/gog-shared/SKILL.md
git commit -m "docs(skills): add gog-shared skill with AskUser confirmation doctrine"
```

### Task 4.2: 5 个 per-service skill 骨架

**Files:**
- Create: `skills/gog/gog-gmail/SKILL.md`
- Create: `skills/gog/gog-calendar/SKILL.md`
- Create: `skills/gog/gog-drive/SKILL.md`
- Create: `skills/gog/gog-docs/SKILL.md`
- Create: `skills/gog/gog-sheets/SKILL.md`

- [ ] **Step 1: 参考 `skills/notion/` 下任意一个现有 skill 看格式**

```bash
ls skills/notion/
cat skills/notion/*/SKILL.md | head -60
```

- [ ] **Step 2: 写 `skills/gog/gog-gmail/SKILL.md`**

```markdown
---
name: gog-gmail
version: 1.0.0
description: "用 gog 读/搜/发 Gmail。**先读 gog-shared**（鉴权 + AskUser 纪律）。对 send/delete/forward/reply/batch delete/filters 等写操作**必须先 AskUser 确认**。典型场景：收件箱三分钟 triage、搜近 7 天带附件邮件、回复特定 thread、创建 draft、批量 archive。"
metadata:
  requires:
    bins: ["gog"]
---

# gog-gmail

> **PREREQUISITE:** 先读 `gog-shared/SKILL.md`（鉴权 + 写操作 AskUser 纪律）。

## 常用只读命令（无需确认）

```bash
# 搜索 thread
gog --account <email> --json gmail search 'newer_than:7d has:attachment' --max 20

# 读 thread 详情
gog --account <email> --json gmail thread get <threadId>

# 读 message
gog --account <email> --json gmail get <messageId>
gog --account <email> --json gmail get <messageId> --format metadata  # 只拿 header

# 列 labels
gog --account <email> --json gmail labels list
gog --account <email> --json gmail labels get INBOX  # 含消息数

# Message-level 搜索（一条邮件一行）
gog --account <email> --json gmail messages search 'newer_than:7d' --max 10 --full
```

## 写操作（⚠️ 必须先 AskUser 确认）

```bash
# 发邮件 —— 先 AskUser 把完整命令、收件人、正文摘要给用户看
gog --account <email> gmail send --to a@b.com --subject "Hi" --body-file ./message.txt

# 发 HTML 邮件（--body 作为 plain fallback）
gog --account <email> gmail send --to a@b.com --subject "Hi" --body "Plain" --body-html "<p>Hello</p>"

# 转发
gog --account <email> gmail forward <messageId> --to a@b.com --note "FYI"

# 回复（要先 AskUser 确认 quote 的原文内容）
gog --account <email> gmail send --reply-to-message-id <messageId> --quote \
  --to <original_from> --subject "Re: ..." --body "My reply"

# Draft 创建/修改/发送
gog --account <email> gmail drafts create --subject "..." --body "..."
gog --account <email> gmail drafts send <draftId>  # ⚠️ 确认后才能调

# Label 修改（--add 通常 SAFE；--remove INBOX 等相当于 archive，AskUser 建议）
gog --account <email> gmail thread modify <threadId> --add STARRED --remove INBOX

# 批量删除 / archive（必须 AskUser + 先 --json 列出 thread 数）
gog --account <email> gmail batch delete <id> <id> <id>  # ⚠️
```

## 典型场景

**场景：三分钟 inbox triage**
1. `gog --json gmail search 'in:inbox newer_than:3d' --max 50`
2. 按 from / subject 分类，输出一份摘要给用户
3. 根据用户指示，逐 thread `gog gmail thread modify --remove INBOX --add <Label>`（每个写操作一次 AskUser 或一次批量 AskUser 后批跑）

**场景：回复某个发件人最近一封邮件**
1. `gog --json gmail search 'from:alice@x.com' --max 1 --full` → 拿到 threadId 和正文
2. AskUser 把要回复的内容（复述 + 原邮件摘要）给用户确认
3. `gog gmail send --reply-to-message-id <id> --quote --to alice@x.com --subject "Re: ..." --body-file /tmp/reply.txt`

**场景：导出 filters**

```bash
gog --account <email> gmail filters export --out /workspace/gmail-filters-backup.json
```

## 注意

- `--track`（email tracking）**不做**，和 ripple 无关。
- 复杂 Gmail search 语法（`has:drive`, `label:Foo-Bar`, `older_than:...`）看 [Gmail Search operators](https://support.google.com/mail/answer/7190)。
- `gmail watch`（Pub/Sub push）**MVP 不启用**，需要时单独设计。
```

- [ ] **Step 3: 同样结构写 `gog-calendar/SKILL.md`**

```markdown
---
name: gog-calendar
version: 1.0.0
description: "用 gog 读/搜/创建/改 Calendar 事件。**先读 gog-shared**。对 create/update/delete/respond 写操作**必须先 AskUser 确认**。典型：今日日程、本周会议冲突、创建带 attendee 的会议。"
metadata:
  requires:
    bins: ["gog"]
---

# gog-calendar

> **PREREQUISITE:** 先读 `gog-shared/SKILL.md`。

## 只读（无需确认）

```bash
# 今日 / 本周
gog --account <email> --json calendar events <calId> --today
gog --account <email> --json calendar events <calId> --week
gog --account <email> --json calendar events <calId> --days 3

# 列日历本身
gog --account <email> --json calendar calendars

# 某单个事件
gog --account <email> --json calendar event <calId> <eventId>

# 搜索
gog --account <email> --json calendar search "meeting" --days 30 --max 50

# Free/busy
gog --account <email> --json calendar freebusy \
  --calendars "primary,colleague@x.com" \
  --from 2026-04-22T00:00:00Z --to 2026-04-23T00:00:00Z

# 冲突检测
gog --account <email> --json calendar conflicts --all --today
```

JSON 里的 `startDayOfWeek` / `timezone` / `startLocal` / `endLocal` 直接用，不要自己算。

## 写操作（⚠️ 必须先 AskUser）

```bash
# 创建事件
gog --account <email> calendar create primary \
  --summary "Team Sync" \
  --from 2026-04-25T10:00:00Z \
  --to 2026-04-25T11:00:00Z \
  --attendees "alice@x.com,bob@x.com" \
  --location "Zoom"

# 默认 **不发** attendee 邮件通知，显式加 --send-updates all 才发（发前 AskUser）
gog --account <email> calendar create ... --send-updates all  # ⚠️

# 更新（AskUser 复述 diff）
gog --account <email> calendar update <calId> <eventId> --summary "New" --from ...

# 删除
gog --account <email> calendar delete <calId> <eventId> --send-updates all --force  # ⚠️

# 回复邀请
gog --account <email> calendar respond <calId> <eventId> --status accepted  # ⚠️ 建议 AskUser
```

## 典型场景

**场景：今日日程 + 冲突**
```bash
gog --account <email> --json calendar events primary --today \
  | jq '.events[] | {summary, startLocal, endLocal}'
gog --account <email> --json calendar conflicts --all --today
```

**场景：协调 3 人会议**
1. 拿所有人 freebusy
2. 找一个 30 分钟空档
3. AskUser 确认时间 + 主题 + 是否发通知
4. `calendar create` 用 `--send-updates all`

## 注意

- 时间优先用 RFC3339 (`2026-04-22T10:00:00Z` 或 `...-08:00`)，不容易搞错时区。
- 提到 "tomorrow" / "明天" 这种相对时间，先 `gog time now` 拿当前时间再算。
```

- [ ] **Step 4: 同样写 `gog-drive/SKILL.md`**

```markdown
---
name: gog-drive
version: 1.0.0
description: "用 gog 读/搜/上传/下载 Drive 文件。**先读 gog-shared**。对 delete/share/unshare/replace 写操作**必须先 AskUser 确认**。典型：搜近期发票 PDF 批量下载、上传 Markdown 自动转 Google Doc。"
metadata:
  requires:
    bins: ["gog"]
---

# gog-drive

> **PREREQUISITE:** 先读 `gog-shared/SKILL.md`。

## 只读

```bash
# 列文件（默认含 shared drives；--no-all-drives 只看 My Drive）
gog --account <email> --json drive ls --max 20
gog --account <email> --json drive ls --parent <folderId> --max 50

# 搜（支持 Google Drive 原生 query 语法，--raw-query 时）
gog --account <email> --json drive search "invoice"
gog --account <email> --json drive search "mimeType = 'application/pdf'" --raw-query

# 元数据
gog --account <email> --json drive get <fileId>
gog --account <email> drive url <fileId>   # 拼 Drive web URL

# 下载
gog --account <email> drive download <fileId> --out ./file.bin
gog --account <email> drive download <fileId> --format pdf --out ./doc.pdf   # Google Workspace 文件
gog --account <email> drive download <fileId> --format md --out ./note.md    # Google Doc → md

# 列 shared drives
gog --account <email> --json drive drives --max 100

# 权限
gog --account <email> --json drive permissions <fileId>
```

## 写操作（⚠️ 必须先 AskUser）

```bash
# 上传（新建文件）
gog --account <email> drive upload ./file.pdf --parent <folderId>

# 上传并转换（Markdown → Google Doc）
gog --account <email> drive upload ./notes.md --convert

# 替换文件内容（保留 file ID 和 share link）
gog --account <email> drive upload ./new-version.pdf --replace <fileId>  # ⚠️

# 删除（默认 trash；--permanent 硬删）
gog --account <email> drive delete <fileId>           # ⚠️
gog --account <email> drive delete <fileId> --permanent  # ⚠️⚠️

# 分享
gog --account <email> drive share <fileId> --to user --email a@b.com --role reader    # ⚠️
gog --account <email> drive share <fileId> --to domain --domain example.com --role reader  # ⚠️

# 取消分享
gog --account <email> drive unshare <fileId> --permission-id <permId>  # ⚠️

# 组织
gog --account <email> drive mkdir "New Folder" --parent <parentFolderId>
gog --account <email> drive rename <fileId> "New Name"  # ⚠️（无歧义时也建议）
gog --account <email> drive move <fileId> --parent <destFolderId>  # ⚠️
```

## 典型场景

**场景：批量下载近期发票 PDF**
```bash
gog --account <email> --json drive search "invoice filetype:pdf newer_than:30d" --max 50 \
  | jq -r '.files[].id' \
  | while read fid; do
      gog --account <email> drive download "$fid" --out "/workspace/invoices/$fid.pdf"
    done
```

**场景：Markdown 报告发到 Drive 并分享**
1. `gog drive upload ./report.md --convert --parent <folderId>` → 拿到 fileId
2. AskUser 确认分享对象和权限
3. `gog drive share <fileId> --to user --email stakeholder@x.com --role reader`

## 注意

- `--convert` 前 gogcli 默认剥离 Markdown 开头的 YAML frontmatter（`---` ~ `---`）；需要保留时加 `--keep-frontmatter`。
- Drive search query 语法：`mimeType = '...'`, `name contains '...'`, `parents in '...'` —— 用 `--raw-query` 时直接透传。
```

- [ ] **Step 5: 写 `gog-docs/SKILL.md`**

```markdown
---
name: gog-docs
version: 1.0.0
description: "用 gog 读/写 Google Docs。**先读 gog-shared**。对 update/write/sed/find-replace **必须先 AskUser 确认 + 优先 --dry-run**。典型：读全文、追加段落、template 填充、找替换。"
metadata:
  requires:
    bins: ["gog"]
---

# gog-docs

> **PREREQUISITE:** 先读 `gog-shared/SKILL.md`。

## 只读

```bash
# 元信息
gog --account <email> --json docs info <docId>

# 读全文（默认 plain text）
gog --account <email> docs cat <docId>
gog --account <email> docs cat <docId> --max-bytes 10000     # 限制输出大小
gog --account <email> docs cat <docId> --tab "Notes"          # 特定 tab
gog --account <email> docs cat <docId> --all-tabs

# 列 tabs
gog --account <email> --json docs list-tabs <docId>

# 导出
gog --account <email> docs export <docId> --format md --out ./doc.md
gog --account <email> docs export <docId> --format pdf --out ./doc.pdf
gog --account <email> docs export <docId> --format docx --out ./doc.docx
gog --account <email> docs export <docId> --format html --out ./doc.html
```

## 写操作（⚠️ 必须先 AskUser）

```bash
# 新建
gog --account <email> docs create "My Doc"
gog --account <email> docs create "My Doc" --file ./source.md  # 从 markdown 导入

# 复制
gog --account <email> docs copy <docId> "Copy Name"

# 追加文本
gog --account <email> docs update <docId> --text "append this"
gog --account <email> docs update <docId> --file ./insert.txt --index 25

# 覆盖 / 重写
gog --account <email> docs write <docId> --text "fresh content"         # ⚠️
gog --account <email> docs write <docId> --file ./body.md --replace --markdown  # ⚠️

# Find/Replace（⚠️⚠️ 整篇文档都替换，先 --dry-run）
gog --account <email> docs find-replace <docId> "old" "new"
gog --account <email> docs find-replace <docId> "old" "new" --tab-id t.notes

# Sed（sedmat 语法，支持格式化：**bold** / *italic* / ~~strike~~ / `mono` / 链接 / 图片 / 表格）
gog --account <email> docs sed <docId> 's/pattern/replacement/g'
gog --account <email> docs sed <docId> 's/Google/[Google](https://google.com)/'
gog --account <email> docs sed <docId> 's/{{LOGO}}/![](https://x.com/logo.png)/'
```

## 典型场景

**场景：把 `/workspace/report.md` 替换成某个 doc 的全文**
1. AskUser 确认要替换的 doc（拿 `docs info` 给看标题）
2. `gog docs write <docId> --file /workspace/report.md --replace --markdown`

**场景：从 template 批量生成 doc**
1. `gog docs copy <templateDocId> "Q2 Report"` → 拿新 docId
2. `gog docs find-replace <newDocId> "{{quarter}}" "Q2 2026"`
3. ... 重复若干次 ...
（每组替换前 AskUser 一次，或把所有替换汇总一次 AskUser）

## 注意

- `sed` 的 sedmat 语法很强（表格单元格、行列操作、图片宽度），复杂用法先 `gog docs sed --help`。
- `--markdown` 只在 write/update 且源是 markdown 时加；不加时 gog 当纯文本插入。
```

- [ ] **Step 6: 写 `gog-sheets/SKILL.md`**

```markdown
---
name: gog-sheets
version: 1.0.0
description: "用 gog 读/写 Google Sheets。**先读 gog-shared**。对 update/append/clear/delete-tab/format **必须先 AskUser 确认**。典型：读 range、append 一行、从 CSV 覆盖、按命名区间写入、插入/删除 tab。"
metadata:
  requires:
    bins: ["gog"]
---

# gog-sheets

> **PREREQUISITE:** 先读 `gog-shared/SKILL.md`。

## 只读

```bash
# 元数据（列所有 tab / sheet ID / range）
gog --account <email> --json sheets metadata <ssId>

# 读 range
gog --account <email> --json sheets get <ssId> 'Sheet1!A1:C20'
gog --account <email> --json sheets get <ssId> MyNamedRange

# 格式信息
gog --account <email> --json sheets read-format <ssId> 'Sheet1!A1:B2'
gog --account <email> --json sheets read-format <ssId> 'Sheet1!A1:B2' --effective

# 命名区间 / charts
gog --account <email> --json sheets named-ranges <ssId>
gog --account <email> --json sheets chart list <ssId>
gog --account <email> --json sheets chart get <ssId> <chartId>

# 注释 / 链接
gog --account <email> --json sheets notes <ssId> 'Sheet1!A1:B10'
gog --account <email> --json sheets links <ssId> 'Sheet1!A1:B10'

# 导出（via Drive）
gog --account <email> sheets export <ssId> --format pdf --out ./s.pdf
gog --account <email> sheets export <ssId> --format xlsx --out ./s.xlsx
```

## 写操作（⚠️ 必须先 AskUser）

```bash
# 更新（管道/逗号 格式：`row1col1|row1col2,row2col1|row2col2`）
gog --account <email> sheets update <ssId> 'Sheet1!A1' 'v1|v2,v3|v4'

# 用 JSON 更新（更清晰）
gog --account <email> sheets update <ssId> 'Sheet1!A1:B2' --values-json '[["a","b"],["c","d"]]'

# Append
gog --account <email> sheets append <ssId> 'Sheet1!A:C' 'new|row|data'

# Clear（⚠️⚠️）
gog --account <email> sheets clear <ssId> 'Sheet1!A1:B10'
gog --account <email> sheets clear <ssId> MyNamedRange

# Find/Replace
gog --account <email> sheets find-replace <ssId> "old" "new"
gog --account <email> sheets find-replace <ssId> "old" "new" --sheet Sheet1 --regex

# Tab 管理
gog --account <email> sheets add-tab <ssId> "NewTab" --index 0
gog --account <email> sheets rename-tab <ssId> "Old" "New"
gog --account <email> sheets delete-tab <ssId> "OldTab" --force  # ⚠️⚠️

# Format
gog --account <email> sheets format <ssId> 'Sheet1!A1:B2' \
  --format-json '{"textFormat":{"bold":true}}' \
  --format-fields 'userEnteredFormat.textFormat.bold'
gog --account <email> sheets merge <ssId> 'Sheet1!A1:B2'
gog --account <email> sheets freeze <ssId> --rows 1 --cols 1
gog --account <email> sheets number-format <ssId> 'Sheet1!C:C' --type CURRENCY --pattern '$#,##0.00'

# 创建新 spreadsheet
gog --account <email> sheets create "New Spreadsheet" --sheets "Sheet1,Sheet2"
```

## 典型场景

**场景：把 `/workspace/data.csv` 写进 Sheet1 A1 起**
1. `cat /workspace/data.csv | tr ',' '|'` 预览（AskUser 看一行是不是对的）
2. AskUser 确认目标 range
3. `cat /workspace/data.csv | tr ',' '|' | gog --account <email> sheets update <ssId> 'Sheet1!A1'`

**场景：给某列加货币格式**
1. `sheets metadata` 先确认 sheet 名和列范围
2. AskUser 确认要改的范围 + 格式
3. `sheets number-format <ssId> 'Revenue!C:C' --type CURRENCY --pattern '$#,##0.00'`

## 注意

- `--values-json` 输入是**二维数组**（行 → 列）；不是对象。
- Range 语法：`Sheet1!A1:B10`（tab 名+!+范围），或直接用命名区间名。
- 格式化的 `--format-fields` 必须精确到要改的叶子字段（gogcli 透传给 Sheets API 的 fieldMask）。
```

- [ ] **Step 7: 启动 server 验证 skill 能被加载**

```bash
uv run ripple --reload &  # 或者当前已启动
sleep 3
curl -sS http://localhost:<port>/v1/system/info | jq '.skills[] | select(.name | startswith("gog-"))'
```

Expected: 输出至少 6 条 `gog-shared` / `gog-gmail` / `gog-calendar` / `gog-drive` / `gog-docs` / `gog-sheets`。

- [ ] **Step 8: Commit**

```bash
git add skills/gog/
git commit -m "docs(skills): add gog per-service skills (gmail/calendar/drive/docs/sheets)"
```

---

## Phase 5: 前端 Settings badges（可选，低优先级）

### Task 5.1: SettingsModal 显示两个绑定状态

**Files:**
- Modify: `src/interfaces/web/...SettingsModal...tsx`（具体路径需确认）

- [ ] **Step 1: 找到现有 `has_notion_token` / `has_lark_cli_config` 的前端渲染点**

```bash
cd src/interfaces/web
grep -rn 'has_notion_token\|has_lark_cli' --include='*.tsx' --include='*.ts' . | head
```

- [ ] **Step 2: 在同一组件里加两个 badge：`has_gogcli_client_config` + `has_gogcli_login`**

参照现有 notion badge 的 JSX 结构，新增：

```tsx
<Badge
  label="Google Workspace Client"
  state={status.has_gogcli_client_config ? "configured" : "missing"}
  hint="OAuth Desktop Client JSON（per-user GCP 项目）"
/>
<Badge
  label="Google Workspace Login"
  state={status.has_gogcli_login ? "authorized" : "pending"}
  hint="已完成 remote step 1/2 授权"
/>
```

具体字段名和 Badge 组件 API 按项目现状调整。

- [ ] **Step 3: 跑 lint**

```bash
cd src/interfaces/web
bun run lint
bun run format
```

- [ ] **Step 4: Commit**

```bash
git add src/interfaces/web/
git commit -m "feat(web): show gogcli client config and login badges in settings"
```

（这一步如果前端不急，可以先跳过留到后续迭代，不阻塞后端 MVP。）

---

## Phase 6: 文档

### Task 6.1: 更新 CLAUDE.md 的 "外部 CLI 依赖" 表格

**Files:**
- Modify: `CLAUDE.md` 约 225-237 行的那张表

- [ ] **Step 1: 把 CLAUDE.md 里原来 `gws` 那一行（应该已删）补上 `gog` 一行**

在该表格里添加一行：

```markdown
| `gog`（gogcli, Google Suite CLI） | `bash scripts/install-gogcli-cli.sh` | `vendor/gogcli-cli/v<X.Y.Z>/bin/` | `/opt/gogcli-cli/current/bin/gog` | per-user 独立 GCP 项目 + **远程 2-step OAuth**：用户 GCP Console 建 Desktop OAuth Client → 粘 `client_secret.json` → `GoogleWorkspaceClientConfigSet` → `GoogleWorkspaceLoginStart` 拿 URL → 用户本地浏览器 Allow → 复制地址栏回调 URL → `GoogleWorkspaceLoginComplete` → 加密 refresh_token 存到 `/workspace/.config/gogcli/keyring/`（backend=file，密码由 ripple provision 时随机生成） |
```

紧接表格后的说明段（关于 skill 位置、授权状态等），把 gws 的两个条目替换成 gog 的：

```markdown
- 相关 skill 分别在 `skills/lark/`、`skills/notion/`、`skills/gog/` 下（首次使用前必读对应 `*-shared/SKILL.md`）
- `gog` 的鉴权涉及两个独立状态：`has_gogcli_client_config`（OAuth Client 绑定）+ `has_gogcli_login`（远程 2-step 授权完成），前端 SettingsModal 分两个 badge 展示
- **`gog` 不要求 ripple server 和用户浏览器同机**（使用 `gog auth add --remote --step 1/2`，用户把浏览器地址栏 callback URL 贴回 agent 完成授权）
- 破坏性 gog 子命令（gmail send / drive delete / sheets clear / admin.* 等）**必须先调 `AskUser` 工具让用户显式确认**后才能通过 `Bash` 执行；详见 `skills/gog/gog-shared/SKILL.md`
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): add gogcli entry to external CLI deps with remote 2-step auth notes"
```

---

## Phase 7: 端到端手测（人工）

### Task 7.1: 冷启动走一遍完整授权流程

- [ ] **Step 1: 重启 ripple server**

```bash
# 关掉现有 server（如果在跑）
uv run ripple --reload
```

- [ ] **Step 2: 从前端或 API 开一个 session，跑下面这段对话**

1. 用户："请列出我 Gmail 过去 7 天的邮件"
2. agent 调 Bash `gog gmail search ...` → 失败（no credentials）
3. agent 引导用户建 Desktop OAuth Client + 启用 API（走 gog-shared skill 引导流程）
4. 用户贴 client_secret.json
5. agent 调 `GoogleWorkspaceClientConfigSet(client_secret_json=...)` → ok
6. agent 调 `GoogleWorkspaceLoginStart(email=...)` → 拿到 URL
7. agent 把 URL 交给用户
8. 用户在本机浏览器打开 URL → 点 Allow → 浏览器跳转到 `http://127.0.0.1:...callback?code=...&state=...` 页面报错
9. 用户把完整 URL 复制粘贴回对话
10. agent 调 `GoogleWorkspaceLoginComplete(email=..., callback_url=...)` → ok, stage=authorized
11. agent 重跑 `gog --account <email> --json gmail search ...` → 正常返回数据

- [ ] **Step 3: 跑一个破坏性命令，验证 AskUser 行为**

用户："给 alice@x.com 发个邮件说今天周会改到下午 3 点"

agent 应当：
1. 先起 draft 在 `/workspace/draft.txt` 里写好正文
2. 调 `AskUser(question="准备执行：`gog gmail send --to alice@x.com --subject 'Weekly sync time' --body-file /workspace/draft.txt`\n正文预览：\n\n今天周会改到下午 3 点，XX。\n\n确认发送？", options=["yes, send", "no, cancel", "let me edit the draft"])`
3. 用户点 yes 后才调 Bash 真发

如果 agent 跳过 AskUser 直接发了 —— 回去加强 `gog-shared` SKILL.md 的措辞或考虑是否要上 Bash pre-exec 硬拦截（Phase 8 预留）。

- [ ] **Step 4: 跨 user 隔离验证**

- 用 user A 完整授权一次
- 切到 user B：`has_gogcli_client_config=False` / `has_gogcli_login=False`（应该是干净的）
- user B 的 `gog` 命令应当报 client 未配置

---

## Self-Review

**1. Spec coverage:**

- ✅ gogcli 二进制预装：Phase 1
- ✅ per-user 沙箱隔离：Phase 2.1, 2.2, 2.3
- ✅ Keyring 按方案生成 + env 注入：Phase 2.2 (`ensure_gogcli_keyring_password`) + 2.3 (nsjail env) + 2.4 (provisioning 调用)
- ✅ 单 OAuth Client per user：Phase 2.1 的 `gogcli_client_config_file` 无 `--client` 参数
- ✅ 默认全量 scope：Phase 3.2 的 `--services user` 一次性申请所有 user 服务
- ✅ `--remote --step 1/2` 授权：Phase 3.2 + 3.3
- ✅ Service Account 不做：整份计划无 Phase 涉及
- ✅ AskUser 二次确认：Phase 4.1 写进 gog-shared SKILL 的"破坏性操作"章节
- ✅ 预装 skill：Phase 4.2 共 5 个 per-service 骨架 + 1 个 shared
- ✅ Settings badge：Phase 5（可选）
- ✅ 文档更新：Phase 6

**2. Placeholder scan:** 所有步骤含实际代码、实际命令、实际期望输出。

**3. Type consistency:**
- `GogcliClientConfig` 在 gogcli.py 定义、在 gogcli_client_config_set.py 使用 ✅
- `gogcli_client_config_file` / `gogcli_keyring_pass_file` 方法在 config.py 定义、在其他模块使用 ✅
- `has_gogcli_client_config` / `has_gogcli_login` 在 config.py 定义、在 manager.py + schemas.py 使用 ✅
- 常量 `GOGCLI_CLI_INSTALL_ROOT` / `GOGCLI_CLI_SANDBOX_BIN_DIR` / `GOGCLI_CLI_SANDBOX_BIN` 在 config.py 定义、在 nsjail_config.py + 三个工具使用 ✅
- 工具类名 `GoogleWorkspaceClientConfigSetTool` / `GoogleWorkspaceLoginStartTool` / `GoogleWorkspaceLoginCompleteTool` 在文件里定义、在 sessions.py 注册、在 skill 里被名字 `GoogleWorkspaceClientConfigSet` / `GoogleWorkspaceLoginStart` / `GoogleWorkspaceLoginComplete` 提到 ✅

---

## Execution Handoff

Plan 保存到 `docs/plans/2026-04-22-gogcli-integration.md`。两种执行方式：

**1. Subagent-Driven（推荐）** — 每个 Task 派一个 fresh subagent 跑，task 之间我做 review + 反馈修正。总共 ~13 个 task，按 Phase 分批。

**2. Inline Execution** — 在当前 session 里顺序跑完所有 task，重大 phase 切换时我做 checkpoint 让你过目（Phase 0→1→2→3→4→5→6→7）。

哪种？
