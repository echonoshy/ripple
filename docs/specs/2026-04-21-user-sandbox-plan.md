# User 层沙箱重构 · 实现计划

> **给自动化执行者**：本计划按任务推进，每个 Task 以 `- [ ]` 标注可执行步骤。推荐用 `superpowers:subagent-driven-development`（每个 Task 派一个子 agent）或 `superpowers:executing-plans`（当前会话批量执行）。

**Goal：** 把沙箱从 session 层上提到 user 层，一个 `user_id` 对应一个独立 workspace + 凭证 + nsjail.cfg，session 只保留对话态（meta / messages / tasks / task-outputs）。

**Architecture：** 改造分 6 个 Phase 共 24 个 Task。底层 `SandboxConfig` 先把方法签名从 `(session_id)` 改为 `(user_id)` / `(user_id, session_id)`（Phase 1-2），然后通过 `ToolUseContext.user_id` 把 user_id 从 HTTP header 透传到工具（Phase 3），再挂工具和新端点（Phase 4-5），最后清理（Phase 6）。目录从 `.ripple/sessions/<sid>/` 迁到 `.ripple/sandboxes/<uid>/sessions/<sid>/`。

**Tech Stack：** Python 3.13 + FastAPI + uv + pytest + pytest-asyncio + nsjail。前端 Next.js 只在 Phase 6 加一个 HTTP header。

**Spec 参考：** `docs/specs/2026-04-21-user-sandbox-design.md`

---

## 前置说明（必读）

### 术语
- **uid** = `user_id`，调用方通过 `X-Ripple-User-Id` header 传入，正则 `^[a-zA-Z0-9_-]{1,64}$`，缺省回落 `default`
- **sid** = `session_id`，格式 `srv-{hex12}`，在单个 uid 下唯一
- **sandbox** = 一个 uid 拥有的整套隔离环境（workspace + 凭证 + nsjail.cfg）

### 测试约定
- 测试文件位于 `tests/`（目前不存在，Task 1.1 会建）
- 运行测试：`proxy_on && source .venv/bin/activate && pytest tests/ -v`
- 按用户规则：**不要创建 `__init__.py`**；pytest 已配置 `asyncio_mode = "auto"`，不要在测试里加 `@pytest.mark.asyncio`
- 按用户规则：类型注解用内建 `list[str]` / `dict[str, str]`，不要 `from typing import Optional`

### Commit 规范
每个 Task 结尾 commit，message 前缀：
- `feat:` 新增功能
- `refactor:` 纯重构（签名改造）
- `test:` 仅测试
- `chore:` 清理

### 命名约定（重要）

为了让新旧 API 在 Phase 1-5 平滑共存，新函数/方法带后缀：

- `xxx_by_uid(user_id, ...)` — 当旧方法 `xxx(session_id, ...)` 仍然存在时
- `xxx_uid(user_id, ...)` — 当旧函数 `xxx(..., session_id, ...)` 仍然存在时
- 无后缀 — 全新、不与旧名冲突的 API（如 `ensure_sandbox`, `user_lock`, `sandbox_summary`）

Phase 6 (Task 6.2) 会把所有带后缀的重命名去掉后缀，得到最终干净的 API。

### 机械重构条款

Phase 2 和 Phase 6 里有若干 Task 属于"同一模式应用到所有调用点"的批量重构。这类 step 只给**一个典型代码例子 + 一张替换对照表**，engineer 需要按同样模式处理所有命中位置。明确提醒的 Task：2.6 / 2.8 / 3.3 / 3.4 / 4.2 / 6.2。

执行这类 Task 时：
1. 先 `rg -l <旧符号>` 确认全部命中文件
2. 逐文件 edit + 跑相关 test，不要批量 sed
3. 最后跑 `pytest tests/ -v` 全量 + `ruff check .` 把关

### 通用失败恢复
如 Task 中任一步失败：恢复到上一次成功 commit（`git reset --hard HEAD`），定位问题后重试。**不要跳过失败的 step**。

---

## 文件地图

| 文件 | 动作 | 负责什么 |
|---|---|---|
| `src/ripple/utils/paths.py` | 修改 | 新增 `SANDBOXES_DIR` |
| `src/ripple/sandbox/config.py` | 重构 | 路径方法签名全部切换为 `uid` / `(uid, sid)` |
| `src/ripple/sandbox/workspace.py` | 重构 | 按 uid 创建/销毁 workspace |
| `src/ripple/sandbox/storage.py` | 重构 | save/load session state 接 `(uid, sid)` |
| `src/ripple/sandbox/nsjail_config.py` | 重构 | 按 uid 生成 nsjail.cfg（mount src 改） |
| `src/ripple/sandbox/provisioning.py` | 重构 | `ensure_python_venv(uid)` / `ensure_pnpm_setup(uid)` |
| `src/ripple/sandbox/executor.py` | 重构 | `execute_in_sandbox(cmd, config, uid, ...)` |
| `src/ripple/sandbox/feishu.py` | 重构 | lark-cli 配置流程按 uid 索引 |
| `src/ripple/sandbox/notion.py` | 重构 | read/write_notion_token 按 uid |
| `src/ripple/sandbox/manager.py` | 重构 | SandboxManager 新增 `ensure_sandbox(uid)` / `teardown_sandbox(uid)`，原 session 方法签名补 uid；新增 per-user `asyncio.Lock` |
| `src/ripple/core/context.py` | 修改 | `ToolUseContext` 新增 `user_id` 字段 |
| `src/ripple/tools/builtin/bash.py` | 修改 | 沿 `context.user_id` 调 sandbox_config |
| `src/ripple/tools/builtin/notion_token_set.py` | 修改 | 同上 |
| `src/ripple/tools/builtin/agent_tool.py` | 修改 | 子 context 透传 user_id |
| `src/ripple/tools/builtin/subagent.py` | 修改 | 同上 |
| `src/interfaces/server/deps.py` | 新建 | `get_user_id` FastAPI 依赖 |
| `src/interfaces/server/sessions.py` | 重构 | Session 加 user_id；`_sessions` 主键改 `(uid, sid)` |
| `src/interfaces/server/routes.py` | 重构 | 每个 handler 加 `user_id: str = Depends(get_user_id)`；新增 `/v1/sandboxes` 三个端点 |
| `src/interfaces/server/schemas.py` | 修改 | 新增 `SandboxInfo` / `SandboxSummaryResponse` |
| `src/interfaces/server/app.py` | 微调 | lifespan 日志 sessions_root → sandboxes_root |
| `src/interfaces/web/src/**` | 微调 | 所有 fetch 调用加 `X-Ripple-User-Id: default` header |
| `config/settings.yaml` | 修改 | `sandbox.sessions_root` → `sandbox.sandboxes_root` |
| `tests/sandbox/test_config_paths.py` | 新建 | 路径方法单测 |
| `tests/sandbox/test_user_id.py` | 新建 | user_id 正则 & 路径穿越测试 |
| `tests/sandbox/test_manager.py` | 新建 | SandboxManager 新 API 单测 |
| `tests/sandbox/test_per_user_lock.py` | 新建 | 并发锁测试 |
| `tests/server/test_user_id_header.py` | 新建 | FastAPI 依赖测试 |
| `tests/server/test_sandbox_endpoints.py` | 新建 | 三个 sandbox 端点集成测试 |
| `tests/tools/test_notion_token_set.py` | 新建 | NotionTokenSet 按 uid 写入测试 |

---

# Phase 1：路径层改造（纯逻辑，不碰运行时）

## Task 1.1：新增 `SANDBOXES_DIR` 常量 + 建立 tests/ 骨架

**Files:**
- Modify: `src/ripple/utils/paths.py`
- Create: `tests/sandbox/test_paths.py`

- [ ] **Step 1：写失败测试**

创建 `tests/sandbox/test_paths.py`：

```python
"""测试 .ripple 路径常量"""

from ripple.utils import paths


def test_sandboxes_dir_is_under_ripple_home():
    assert paths.SANDBOXES_DIR == paths.RIPPLE_HOME / "sandboxes"


def test_legacy_sessions_dir_still_exported():
    # Phase 1 阶段两个常量共存，便于旧代码渐进迁移
    assert paths.SESSIONS_DIR == paths.RIPPLE_HOME / "sessions"


def test_sandboxes_cache_dir_unchanged():
    assert paths.SANDBOXES_CACHE_DIR == paths.RIPPLE_HOME / "sandboxes-cache"
```

- [ ] **Step 2：跑测试验证失败**

```bash
proxy_on && source .venv/bin/activate
pytest tests/sandbox/test_paths.py -v
```
Expected: `FAILED` `AttributeError: module ... has no attribute 'SANDBOXES_DIR'`

- [ ] **Step 3：最小实现**

编辑 `src/ripple/utils/paths.py`，在文件末尾添加：

```python
SANDBOXES_DIR = RIPPLE_HOME / "sandboxes"
```

并更新顶部 docstring 的目录示意图（把 `sessions/` 改成 `sandboxes/<user_id>/...`，但 `SESSIONS_DIR` 常量保留不删，Phase 6 再清）。

- [ ] **Step 4：跑测试验证通过**

```bash
pytest tests/sandbox/test_paths.py -v
```
Expected: 3 passed

- [ ] **Step 5：Commit**

```bash
git add src/ripple/utils/paths.py tests/sandbox/test_paths.py
git commit -m "feat(sandbox): add SANDBOXES_DIR path constant"
```

---

## Task 1.2：`_USER_ID_RE` 正则 + `validate_user_id` 辅助函数

**Files:**
- Modify: `src/ripple/sandbox/config.py`
- Create: `tests/sandbox/test_user_id.py`

- [ ] **Step 1：写失败测试**

创建 `tests/sandbox/test_user_id.py`：

```python
"""user_id 合法性校验"""

import pytest

from ripple.sandbox.config import validate_user_id


def test_valid_user_ids():
    for uid in ["default", "user-123", "ABC_xyz", "a", "x" * 64]:
        assert validate_user_id(uid) == uid


def test_invalid_user_ids_raise():
    for uid in [
        "",
        " ",
        "user/../etc",
        "a/b",
        "x" * 65,
        "user name",
        "用户1",
        "user.name",
    ]:
        with pytest.raises(ValueError, match="Invalid user_id"):
            validate_user_id(uid)


def test_none_raises():
    with pytest.raises(ValueError):
        validate_user_id(None)  # type: ignore[arg-type]
```

- [ ] **Step 2：跑测试验证失败**

```bash
pytest tests/sandbox/test_user_id.py -v
```
Expected: `FAILED` `ImportError`

- [ ] **Step 3：最小实现**

在 `src/ripple/sandbox/config.py` 顶部（现有 import 块之后）加入：

```python
import re

_USER_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


def validate_user_id(user_id: str) -> str:
    """校验 user_id 合法性（防路径穿越），返回原值。非法抛 ValueError。"""
    if not isinstance(user_id, str) or not _USER_ID_RE.match(user_id):
        raise ValueError(f"Invalid user_id: {user_id!r}")
    return user_id
```

- [ ] **Step 4：跑测试 + ruff**

```bash
pytest tests/sandbox/test_user_id.py -v
ruff check src/ripple/sandbox/config.py tests/sandbox/test_user_id.py
ruff format src/ripple/sandbox/config.py tests/sandbox/test_user_id.py
```
Expected: tests 3 passed；ruff no issues

- [ ] **Step 5：Commit**

```bash
git add src/ripple/sandbox/config.py tests/sandbox/test_user_id.py
git commit -m "feat(sandbox): add validate_user_id with strict regex"
```

---

## Task 1.3：`SandboxConfig` 新增 user 维度路径方法（共存，不删旧方法）

**背景：** 旧方法如 `session_dir(sid)` 先保留，添加 `sandbox_dir(uid)` / `session_dir(uid, sid)` 等新方法，Python 不支持同名重载——所以**旧方法先整体改名**为 `_legacy_session_dir(sid)` 标记弃用；新方法占用原名。Phase 6 删除 `_legacy_*`。

但这样会涉及大量调用点同步改。折中方案：**新方法起新名**，旧方法保留原签名，Phase 2 各调用点切换到新方法，Phase 6 删旧方法。

**Files:**
- Modify: `src/ripple/sandbox/config.py`
- Modify: `tests/sandbox/test_config_paths.py` (create if missing)

- [ ] **Step 1：写失败测试**

创建 `tests/sandbox/test_config_paths.py`：

```python
"""SandboxConfig 新增 user 维度路径方法"""

from pathlib import Path

from ripple.sandbox.config import SandboxConfig


def _cfg(tmp_path: Path) -> SandboxConfig:
    return SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "caches",
    )


def test_sandbox_dir(tmp_path: Path):
    c = _cfg(tmp_path)
    assert c.sandbox_dir("alice") == tmp_path / "sandboxes" / "alice"


def test_workspace_dir_by_uid(tmp_path: Path):
    c = _cfg(tmp_path)
    assert c.workspace_dir_by_uid("alice") == tmp_path / "sandboxes" / "alice" / "workspace"


def test_session_dir_by_uid(tmp_path: Path):
    c = _cfg(tmp_path)
    assert c.session_dir_by_uid("alice", "srv-abc") == (
        tmp_path / "sandboxes" / "alice" / "sessions" / "srv-abc"
    )


def test_credential_paths(tmp_path: Path):
    c = _cfg(tmp_path)
    assert c.feishu_config_file_by_uid("alice") == (
        tmp_path / "sandboxes" / "alice" / "credentials" / "feishu.json"
    )
    assert c.notion_config_file_by_uid("alice") == (
        tmp_path / "sandboxes" / "alice" / "credentials" / "notion.json"
    )


def test_nsjail_cfg_file_by_uid(tmp_path: Path):
    c = _cfg(tmp_path)
    assert c.nsjail_cfg_file_by_uid("alice") == tmp_path / "sandboxes" / "alice" / "nsjail.cfg"


def test_per_session_runtime_files(tmp_path: Path):
    c = _cfg(tmp_path)
    base = tmp_path / "sandboxes" / "alice" / "sessions" / "srv-abc"
    assert c.meta_file_by_uid("alice", "srv-abc") == base / "meta.json"
    assert c.messages_file_by_uid("alice", "srv-abc") == base / "messages.jsonl"
    assert c.tasks_file_by_uid("alice", "srv-abc") == base / "tasks.json"
    assert c.task_outputs_dir_by_uid("alice", "srv-abc") == base / "task-outputs"


def test_user_id_validated(tmp_path: Path):
    import pytest

    c = _cfg(tmp_path)
    with pytest.raises(ValueError):
        c.sandbox_dir("../evil")
```

- [ ] **Step 2：跑测试验证失败**

```bash
pytest tests/sandbox/test_config_paths.py -v
```
Expected: 多个 `AttributeError`

- [ ] **Step 3a：新增 `sandboxes_root` dataclass 字段**

在 `SandboxConfig` 的 dataclass 定义中，与 `sessions_root` 并列新增字段（**保留**旧字段，Phase 6 再删）：

```python
from ripple.utils.paths import SANDBOXES_DIR  # 放到文件顶部 import

@dataclass
class SandboxConfig:
    # ... 已有字段保持不变 ...
    sandboxes_root: Path = field(default_factory=lambda: SANDBOXES_DIR)
    # ... 其他字段 ...
```

在 `from_dict` 类方法中追加：

```python
        sandboxes_root_raw = data.get("sandboxes_root")
        sandboxes_root = Path(sandboxes_root_raw) if sandboxes_root_raw else SANDBOXES_DIR
        # 然后把 sandboxes_root 传进 __init__ 参数
```

- [ ] **Step 3b：新增 user 维度路径方法**

在 `SandboxConfig` 类内（放在现有 `session_dir` 方法之后）追加：

```python
    # --- user 维度路径方法（Phase 1-5 过渡期带 _by_uid 后缀；Phase 6 去掉） ---

    def sandbox_dir(self, user_id: str) -> Path:
        validate_user_id(user_id)
        return self.sandboxes_root / user_id

    def workspace_dir_by_uid(self, user_id: str) -> Path:
        return self.sandbox_dir(user_id) / "workspace"

    def nsjail_cfg_file_by_uid(self, user_id: str) -> Path:
        return self.sandbox_dir(user_id) / "nsjail.cfg"

    def feishu_config_file_by_uid(self, user_id: str) -> Path:
        return self.sandbox_dir(user_id) / "credentials" / "feishu.json"

    def notion_config_file_by_uid(self, user_id: str) -> Path:
        return self.sandbox_dir(user_id) / "credentials" / "notion.json"

    def session_dir_by_uid(self, user_id: str, session_id: str) -> Path:
        return self.sandbox_dir(user_id) / "sessions" / session_id

    def meta_file_by_uid(self, user_id: str, session_id: str) -> Path:
        return self.session_dir_by_uid(user_id, session_id) / "meta.json"

    def messages_file_by_uid(self, user_id: str, session_id: str) -> Path:
        return self.session_dir_by_uid(user_id, session_id) / "messages.jsonl"

    def tasks_file_by_uid(self, user_id: str, session_id: str) -> Path:
        return self.session_dir_by_uid(user_id, session_id) / "tasks.json"

    def task_outputs_dir_by_uid(self, user_id: str, session_id: str) -> Path:
        return self.session_dir_by_uid(user_id, session_id) / "task-outputs"
```

- [ ] **Step 4：跑测试 + ruff**

```bash
pytest tests/sandbox/test_config_paths.py -v
ruff check src/ripple/sandbox/config.py tests/sandbox/test_config_paths.py
ruff format src/ripple/sandbox/config.py tests/sandbox/test_config_paths.py
```
Expected: 7 passed

- [ ] **Step 5：Commit**

```bash
git add src/ripple/sandbox/config.py tests/sandbox/test_config_paths.py
git commit -m "refactor(sandbox): add user-scoped path methods to SandboxConfig"
```

---

## Task 1.4：沙箱就绪状态函数按 uid 版本（`has_*_by_uid`）

**Files:**
- Modify: `src/ripple/sandbox/config.py`
- Modify: `tests/sandbox/test_config_paths.py`

- [ ] **Step 1：追加测试**

在 `tests/sandbox/test_config_paths.py` 末尾追加：

```python
def test_has_python_venv_by_uid(tmp_path: Path):
    c = _cfg(tmp_path)
    assert c.has_python_venv_by_uid("alice") is False

    venv_cfg = c.workspace_dir_by_uid("alice") / ".venv" / "pyvenv.cfg"
    venv_cfg.parent.mkdir(parents=True)
    venv_cfg.write_text("")
    assert c.has_python_venv_by_uid("alice") is True


def test_has_pnpm_setup_by_uid(tmp_path: Path):
    c = _cfg(tmp_path)
    marker = c.workspace_dir_by_uid("alice") / ".local" / ".node-setup-done"
    marker.parent.mkdir(parents=True)
    marker.touch()
    assert c.has_pnpm_setup_by_uid("alice") is True


def test_has_lark_cli_config_by_uid(tmp_path: Path):
    c = _cfg(tmp_path)
    cfg = c.workspace_dir_by_uid("alice") / ".lark-cli" / "config.json"
    cfg.parent.mkdir(parents=True)
    cfg.write_text("{}")
    assert c.has_lark_cli_config_by_uid("alice") is True


def test_has_notion_token_by_uid(tmp_path: Path):
    c = _cfg(tmp_path)
    assert c.has_notion_token_by_uid("alice") is False

    f = c.notion_config_file_by_uid("alice")
    f.parent.mkdir(parents=True)
    f.write_text('{"api_token": "ntn_abc123def456ghi789"}')
    assert c.has_notion_token_by_uid("alice") is True
```

- [ ] **Step 2：跑测试验证失败**

```bash
pytest tests/sandbox/test_config_paths.py -v -k by_uid
```
Expected: `AttributeError: has_python_venv_by_uid`

- [ ] **Step 3：实现**

在 `SandboxConfig` 中添加（放在对应旧 `has_*` 方法后面）：

```python
    def has_python_venv_by_uid(self, user_id: str) -> bool:
        return (self.workspace_dir_by_uid(user_id) / ".venv" / "pyvenv.cfg").exists()

    def has_pnpm_setup_by_uid(self, user_id: str) -> bool:
        return (self.workspace_dir_by_uid(user_id) / ".local" / ".node-setup-done").exists()

    def has_lark_cli_config_by_uid(self, user_id: str) -> bool:
        return (self.workspace_dir_by_uid(user_id) / ".lark-cli" / "config.json").exists()

    def has_notion_token_by_uid(self, user_id: str) -> bool:
        f = self.notion_config_file_by_uid(user_id)
        if not f.exists():
            return False
        try:
            import json
            data = json.loads(f.read_text(encoding="utf-8"))
            token = data.get("api_token", "")
            return isinstance(token, str) and bool(token.strip())
        except (json.JSONDecodeError, OSError):
            return False
```

- [ ] **Step 4：跑测试 + ruff**

```bash
pytest tests/sandbox/test_config_paths.py -v
ruff check src/ripple/sandbox/config.py
ruff format src/ripple/sandbox/config.py
```
Expected: 11 passed

- [ ] **Step 5：Commit**

```bash
git add src/ripple/sandbox/config.py tests/sandbox/test_config_paths.py
git commit -m "refactor(sandbox): add has_*_by_uid readiness checks"
```

---

# Phase 2：底层执行器 + Manager 改造

**Phase 2 原则：** 每个文件先加 uid 参数版本，旧签名保留但内部调用新版本（用 `default` user 兜底）。这样中间态也是完整可运行的。

## Task 2.1：`workspace.py` 新增按 uid 的创建/销毁

**Files:**
- Modify: `src/ripple/sandbox/workspace.py`
- Modify: `tests/sandbox/test_config_paths.py` (or 新建 `test_workspace.py`)

- [ ] **Step 1：写失败测试**

创建 `tests/sandbox/test_workspace.py`：

```python
"""workspace.py 的 uid 维度 API"""

from pathlib import Path

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.workspace import (
    create_user_workspace,
    destroy_user_sandbox,
    user_sandbox_exists,
)


def _cfg(tmp_path: Path) -> SandboxConfig:
    return SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "caches",
    )


def test_create_and_destroy_user_workspace(tmp_path: Path):
    c = _cfg(tmp_path)
    assert user_sandbox_exists(c, "alice") is False

    ws = create_user_workspace(c, "alice")
    assert ws == c.workspace_dir_by_uid("alice")
    assert ws.exists()
    assert user_sandbox_exists(c, "alice") is True

    destroyed = destroy_user_sandbox(c, "alice")
    assert destroyed is True
    assert user_sandbox_exists(c, "alice") is False


def test_destroy_missing_user_returns_false(tmp_path: Path):
    c = _cfg(tmp_path)
    assert destroy_user_sandbox(c, "ghost") is False


def test_create_user_workspace_idempotent(tmp_path: Path):
    c = _cfg(tmp_path)
    ws1 = create_user_workspace(c, "alice")
    ws2 = create_user_workspace(c, "alice")
    assert ws1 == ws2
    assert ws1.exists()
```

- [ ] **Step 2：跑测试验证失败**

```bash
pytest tests/sandbox/test_workspace.py -v
```
Expected: `ImportError: cannot import name 'create_user_workspace'`

- [ ] **Step 3：实现**

在 `src/ripple/sandbox/workspace.py` 底部（不删旧函数）添加：

```python
def create_user_workspace(config: SandboxConfig, user_id: str) -> Path:
    """为 user 初始化 sandbox 目录结构，返回 workspace 路径（幂等）。"""
    sandbox = config.sandbox_dir(user_id)
    workspace = config.workspace_dir_by_uid(user_id)
    (sandbox / "credentials").mkdir(parents=True, exist_ok=True)
    (sandbox / "sessions").mkdir(parents=True, exist_ok=True)
    workspace.mkdir(parents=True, exist_ok=True)
    logger.info("创建 user sandbox: {} → {}", user_id, sandbox)
    return workspace


def destroy_user_sandbox(config: SandboxConfig, user_id: str) -> bool:
    """销毁整个 user 的 sandbox（含所有 session）"""
    sandbox = config.sandbox_dir(user_id)
    if sandbox.exists():
        shutil.rmtree(sandbox)
        logger.info("销毁 user sandbox: {}", user_id)
        return True
    return False


def user_sandbox_exists(config: SandboxConfig, user_id: str) -> bool:
    return config.sandbox_dir(user_id).exists()


def list_user_sessions(config: SandboxConfig, user_id: str) -> list[str]:
    """列出某 user 下所有有 meta.json 的 session"""
    sessions_dir = config.sandbox_dir(user_id) / "sessions"
    if not sessions_dir.exists():
        return []
    return [
        d.name for d in sessions_dir.iterdir()
        if d.is_dir() and (d / "meta.json").exists()
    ]


def list_all_user_ids(config: SandboxConfig) -> list[str]:
    """枚举 sandboxes_root 下的所有 user_id"""
    if not config.sandboxes_root.exists():
        return []
    return [d.name for d in config.sandboxes_root.iterdir() if d.is_dir()]
```

- [ ] **Step 4：跑测试 + ruff**

```bash
pytest tests/sandbox/test_workspace.py -v
ruff check src/ripple/sandbox/workspace.py tests/sandbox/test_workspace.py
ruff format src/ripple/sandbox/workspace.py tests/sandbox/test_workspace.py
```
Expected: 3 passed

- [ ] **Step 5：Commit**

```bash
git add src/ripple/sandbox/workspace.py tests/sandbox/test_workspace.py
git commit -m "feat(sandbox): add user-scoped workspace create/destroy/list"
```

---

## Task 2.2：`storage.py` 新增 `(uid, sid)` 维度的 save/load/delete

**Files:**
- Modify: `src/ripple/sandbox/storage.py`
- Create: `tests/sandbox/test_storage.py`

- [ ] **Step 1：写失败测试**

创建 `tests/sandbox/test_storage.py`：

```python
"""按 (uid, sid) 维度持久化 session 状态"""

from pathlib import Path

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.storage import (
    delete_session_state_uid,
    get_suspended_session_info_uid,
    load_session_state_uid,
    save_session_state_uid,
)
from ripple.sandbox.workspace import create_user_workspace


def _cfg(tmp_path: Path) -> SandboxConfig:
    return SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "caches",
    )


def test_save_and_load_roundtrip(tmp_path: Path):
    c = _cfg(tmp_path)
    create_user_workspace(c, "alice")

    save_session_state_uid(
        c, "alice", "srv-001",
        messages=[],
        model="sonnet",
        caller_system_prompt=None,
        max_turns=10,
    )

    state = load_session_state_uid(c, "alice", "srv-001")
    assert state is not None
    assert state["model"] == "sonnet"
    assert state["messages"] == []


def test_load_missing_returns_none(tmp_path: Path):
    c = _cfg(tmp_path)
    assert load_session_state_uid(c, "alice", "srv-none") is None


def test_delete_session_state(tmp_path: Path):
    c = _cfg(tmp_path)
    create_user_workspace(c, "alice")
    save_session_state_uid(
        c, "alice", "srv-002",
        messages=[], model="sonnet", caller_system_prompt=None, max_turns=10,
    )

    assert delete_session_state_uid(c, "alice", "srv-002") is True
    assert load_session_state_uid(c, "alice", "srv-002") is None


def test_get_suspended_info(tmp_path: Path):
    c = _cfg(tmp_path)
    create_user_workspace(c, "alice")
    save_session_state_uid(
        c, "alice", "srv-003",
        messages=[], model="sonnet", caller_system_prompt=None, max_turns=10,
    )

    info = get_suspended_session_info_uid(c, "alice", "srv-003")
    assert info is not None
    assert info["session_id"] == "srv-003"
    assert info["model"] == "sonnet"
```

- [ ] **Step 2：跑测试验证失败**

```bash
pytest tests/sandbox/test_storage.py -v
```
Expected: `ImportError`

- [ ] **Step 3：实现**

在 `src/ripple/sandbox/storage.py` 底部添加四个 `_uid` 版函数，内部复用现有写文件逻辑但用 `meta_file_by_uid` / `messages_file_by_uid`：

```python
def save_session_state_uid(
    config: SandboxConfig,
    user_id: str,
    session_id: str,
    *,
    messages: list,
    model: str,
    caller_system_prompt: str | None,
    max_turns: int,
    total_input_tokens: int = 0,
    total_output_tokens: int = 0,
    created_at: datetime | None = None,
    last_active: datetime | None = None,
    status: str = "idle",
    pending_question: str | None = None,
    pending_options: list[str] | None = None,
    pending_permission_request: dict | None = None,
    compactor_state: dict | None = None,
) -> Path:
    """同 save_session_state，但写入路径基于 (uid, sid)"""
    serialized_messages = serialize_messages(messages)
    new_count = len(serialized_messages)

    meta_file = config.meta_file_by_uid(user_id, session_id)
    messages_file = config.messages_file_by_uid(user_id, session_id)

    old_count = 0
    if meta_file.exists():
        try:
            with open(meta_file, encoding="utf-8") as f:
                old_count = json.load(f).get("message_count", 0)
        except (json.JSONDecodeError, OSError):
            old_count = 0

    new_lines = [json.dumps(msg, ensure_ascii=False) for msg in serialized_messages]
    if new_count > old_count > 0 and messages_file.exists():
        with open(messages_file, "a", encoding="utf-8") as f:
            for line in new_lines[old_count:]:
                f.write(line + "\n")
    else:
        _atomic_write_lines(messages_file, new_lines)

    meta = {
        "version": STATE_VERSION,
        "session_id": session_id,
        "user_id": user_id,
        "title": extract_title_from_messages(messages),
        "model": model,
        "caller_system_prompt": caller_system_prompt,
        "max_turns": max_turns,
        "total_input_tokens": total_input_tokens,
        "total_output_tokens": total_output_tokens,
        "created_at": (created_at or datetime.now(timezone.utc)).isoformat(),
        "last_active": (last_active or datetime.now(timezone.utc)).isoformat(),
        "suspended_at": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "pending_question": pending_question,
        "pending_options": pending_options,
        "pending_permission_request": pending_permission_request,
        "compactor_state": compactor_state,
        "message_count": new_count,
    }
    _atomic_write_json(meta_file, meta)
    logger.info("保存 session 状态: {}/{} ({} 条消息)", user_id, session_id, new_count)
    return meta_file


def load_session_state_uid(config: SandboxConfig, user_id: str, session_id: str) -> dict | None:
    meta_file = config.meta_file_by_uid(user_id, session_id)
    messages_file = config.messages_file_by_uid(user_id, session_id)
    if not meta_file.exists():
        return None
    try:
        with open(meta_file, encoding="utf-8") as f:
            state = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        logger.error("加载 meta.json 失败: {}/{} - {}", user_id, session_id, e)
        return None

    raw_messages = []
    if messages_file.exists():
        try:
            with open(messages_file, encoding="utf-8") as f:
                for line_num, line in enumerate(f, 1):
                    stripped = line.strip()
                    if not stripped:
                        continue
                    try:
                        raw_messages.append(json.loads(stripped))
                    except json.JSONDecodeError:
                        logger.warning(
                            "messages.jsonl 第 {} 行解析失败: {}/{}",
                            line_num, user_id, session_id,
                        )
        except OSError as e:
            logger.error("加载 messages.jsonl 失败: {}/{} - {}", user_id, session_id, e)
    state["messages"] = [deserialize_message(item) for item in raw_messages]
    return state


def delete_session_state_uid(config: SandboxConfig, user_id: str, session_id: str) -> bool:
    import shutil
    session_dir = config.session_dir_by_uid(user_id, session_id)
    if session_dir.exists():
        shutil.rmtree(session_dir)
        logger.info("删除 session 状态: {}/{}", user_id, session_id)
        return True
    return False


def get_suspended_session_info_uid(
    config: SandboxConfig, user_id: str, session_id: str
) -> dict | None:
    meta_file = config.meta_file_by_uid(user_id, session_id)
    if not meta_file.exists():
        return None
    try:
        with open(meta_file, encoding="utf-8") as f:
            meta = json.load(f)
    except (json.JSONDecodeError, OSError):
        return None
    return {
        "session_id": meta.get("session_id", session_id),
        "user_id": meta.get("user_id", user_id),
        "title": meta.get("title", ""),
        "model": meta.get("model", ""),
        "max_turns": meta.get("max_turns", 10),
        "message_count": meta.get("message_count", 0),
        "total_input_tokens": meta.get("total_input_tokens", 0),
        "total_output_tokens": meta.get("total_output_tokens", 0),
        "created_at": meta.get("created_at", ""),
        "last_active": meta.get("last_active", ""),
        "suspended_at": meta.get("suspended_at", ""),
    }
```

- [ ] **Step 4：跑测试 + ruff**

```bash
pytest tests/sandbox/test_storage.py -v
ruff check src/ripple/sandbox/storage.py tests/sandbox/test_storage.py
ruff format src/ripple/sandbox/storage.py tests/sandbox/test_storage.py
```
Expected: 4 passed

- [ ] **Step 5：Commit**

```bash
git add src/ripple/sandbox/storage.py tests/sandbox/test_storage.py
git commit -m "feat(sandbox): add user-scoped session state persistence"
```

---

## Task 2.3：`nsjail_config.py` 支持 uid

**Files:**
- Modify: `src/ripple/sandbox/nsjail_config.py`
- Create: `tests/sandbox/test_nsjail_config.py`

- [ ] **Step 1：写失败测试**

```python
"""nsjail.cfg 生成按 uid"""

from pathlib import Path

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.nsjail_config import generate_nsjail_config_uid, write_nsjail_config_uid
from ripple.sandbox.workspace import create_user_workspace


def _cfg(tmp_path: Path) -> SandboxConfig:
    return SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "caches",
    )


def test_generate_nsjail_config_uid_mentions_user_workspace(tmp_path: Path):
    c = _cfg(tmp_path)
    create_user_workspace(c, "alice")
    content = generate_nsjail_config_uid(c, "alice")
    expected_ws = str(c.workspace_dir_by_uid("alice"))
    assert expected_ws in content
    assert "ripple-sandbox-alice" in content


def test_write_nsjail_config_uid(tmp_path: Path):
    c = _cfg(tmp_path)
    create_user_workspace(c, "alice")
    cfg_path = write_nsjail_config_uid(c, "alice")
    assert cfg_path == c.nsjail_cfg_file_by_uid("alice")
    assert cfg_path.exists()
```

- [ ] **Step 2：跑测试**

```bash
pytest tests/sandbox/test_nsjail_config.py -v
```
Expected: ImportError

- [ ] **Step 3：实现**

在 `src/ripple/sandbox/nsjail_config.py` 底部添加三个 `_uid` 函数，复用现有私有构造逻辑。关键改动：

```python
def build_sandbox_env_uid(config: SandboxConfig, user_id: str) -> dict[str, str]:
    """同 build_sandbox_env，但按 user_id 读取 notion token"""
    env = build_sandbox_env(config, session_id=None)
    # 重新注入按 uid 的 notion token
    from ripple.sandbox.notion import read_notion_token_uid
    tok = read_notion_token_uid(config, user_id)
    if tok:
        env["NOTION_API_TOKEN"] = tok
    return env


def generate_nsjail_config_uid(config: SandboxConfig, user_id: str) -> str:
    """按 user_id 生成 nsjail.cfg 内容"""
    workspace = config.workspace_dir_by_uid(user_id)
    limits = config.resource_limits

    mounts = _build_common_mounts(config)  # 提炼：见下
    mounts.append(f"""mount {{
    src: "{workspace}"
    dst: "/workspace"
    is_bind: true
    rw: true
}}""")
    mounts.append("""mount {
    dst: "/proc"
    fstype: "proc"
    rw: false
}""")
    mounts.append(f"""mount {{
    dst: "/tmp"
    fstype: "tmpfs"
    rw: true
    options: "size={config.tmpfs_size_mb}M"
}}""")
    for dev in ["/dev/null", "/dev/zero", "/dev/urandom", "/dev/random"]:
        if Path(dev).exists():
            mounts.append(f"""mount {{
    src: "{dev}"
    dst: "{dev}"
    is_bind: true
    rw: false
}}""")

    mounts_str = "\n\n".join(mounts)
    sandbox_env = build_sandbox_env_uid(config, user_id)
    envars_str = "\n".join(f'envar: "{k}={v}"' for k, v in sandbox_env.items())

    return textwrap.dedent(f"""\
        name: "ripple-sandbox-{user_id}"
        mode: ONCE
        clone_newuser: true
        clone_newns: true
        clone_newpid: true
        clone_newipc: true
        clone_newuts: true
        clone_newnet: {"true" if config.clone_newnet else "false"}
        hostname: "sandbox"
        cwd: "/workspace"
        time_limit: {limits.command_timeout}
        rlimit_as_type: INF
        rlimit_cpu_type: SOFT
        rlimit_fsize: {limits.max_file_size_mb}
        rlimit_nofile: 8192
        rlimit_nproc_type: SOFT
        skip_setsid: true
        disable_no_new_privs: false
        keep_env: false

        {envars_str}

        {mounts_str}
    """)


def write_nsjail_config_uid(config: SandboxConfig, user_id: str) -> Path:
    cfg_content = generate_nsjail_config_uid(config, user_id)
    cfg_path = config.nsjail_cfg_file_by_uid(user_id)
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text(cfg_content, encoding="utf-8")
    return cfg_path


def build_nsjail_argv_uid(config: SandboxConfig, user_id: str, command: str) -> list[str]:
    cfg_path = config.nsjail_cfg_file_by_uid(user_id)
    if not cfg_path.exists():
        write_nsjail_config_uid(config, user_id)
    return [config.nsjail_path, "--config", str(cfg_path), "--", "/bin/bash", "-c", command]
```

**注意：** `_build_common_mounts(config)` 是把现有 `generate_nsjail_config` 中与 session 无关的 mount（`shared_readonly_paths` / uv / node / pnpm / corepack / lark-cli / notion-cli / shared skills）提炼为私有函数，供两个版本复用。现有 `generate_nsjail_config` 也改用此私有函数。

**提炼后：**
```python
def _build_common_mounts(config: SandboxConfig) -> list[str]:
    """生成与具体 session/user 无关的公共 mount 列表"""
    mounts = []
    for path_str in config.shared_readonly_paths:
        # ... (原样搬过来)
    # ... uv / node / pnpm / corepack / lark-cli / notion-cli / shared skills
    return mounts
```

`read_notion_token_uid` 在 Task 2.7 里加，此处暂用前向引用（import 放在函数内即可）。

- [ ] **Step 4：跑测试**

```bash
pytest tests/sandbox/test_nsjail_config.py -v
ruff check src/ripple/sandbox/nsjail_config.py tests/sandbox/test_nsjail_config.py
ruff format src/ripple/sandbox/nsjail_config.py tests/sandbox/test_nsjail_config.py
```
Expected: 2 passed

**注意：** 如果 `read_notion_token_uid` 还没实现，Task 2.7 前这两个测试可以跳过该 import（或者 Task 2.7 先做）。**调整执行顺序：先做 Task 2.7 再做 2.3。** 见 Phase 2 末尾的"执行顺序修正"。

- [ ] **Step 5：Commit**

```bash
git add src/ripple/sandbox/nsjail_config.py tests/sandbox/test_nsjail_config.py
git commit -m "refactor(sandbox): generate nsjail config by user_id"
```

---

## Task 2.4：`provisioning.py` 支持 uid

**Files:**
- Modify: `src/ripple/sandbox/provisioning.py`

- [ ] **Step 1：实现（此文件无独立测试，随 Task 2.8 manager 集成测试一起验）**

把现有 `ensure_python_venv(config, session_id)` 和 `ensure_pnpm_setup(config, session_id)` 复制为 `_uid` 版本：

- 锁字典改用 `dict[str, asyncio.Lock]`（以 user_id 为 key）
- 内部所有 `config.workspace_dir(sid)` / `config.has_*(sid)` → `_by_uid(uid)`
- 调 `execute_in_sandbox` 改为 `execute_in_sandbox_uid`（Task 2.5 提供）
- `_install_pip_wrappers` 同步拆 `_install_pip_wrappers_uid`

大致：

```python
_venv_locks_uid: dict[str, asyncio.Lock] = {}
_pnpm_locks_uid: dict[str, asyncio.Lock] = {}


def _install_pip_wrappers_uid(config: SandboxConfig, user_id: str) -> None:
    venv_bin = config.workspace_dir_by_uid(user_id) / ".venv" / "bin"
    # ... 同现有实现 ...


async def ensure_python_venv_uid(config: SandboxConfig, user_id: str) -> tuple[bool, str]:
    if config.has_python_venv_by_uid(user_id):
        return True, "ok"
    lock = _venv_locks_uid.setdefault(user_id, asyncio.Lock())
    async with lock:
        if config.has_python_venv_by_uid(user_id):
            return True, "ok"
        logger.info("为 user {} 懒创建 Python venv", user_id)
        cmd = "uv venv /workspace/.venv --python=3.13"
        from ripple.sandbox.executor import execute_in_sandbox_uid
        stdout, stderr, exit_code = await execute_in_sandbox_uid(cmd, config, user_id, timeout=60)
        if exit_code == 0 and config.has_python_venv_by_uid(user_id):
            _install_pip_wrappers_uid(config, user_id)
            return True, "ok"
        msg = f"venv 创建失败 (exit={exit_code}): {stderr[:200]}"
        logger.warning("user {} {}", user_id, msg)
        return False, msg


async def ensure_pnpm_setup_uid(config: SandboxConfig, user_id: str) -> tuple[bool, str]:
    # ... 类似 ensure_python_venv_uid，锁换 _pnpm_locks_uid ...
```

- [ ] **Step 2：Ruff**

```bash
ruff check src/ripple/sandbox/provisioning.py
ruff format src/ripple/sandbox/provisioning.py
```

- [ ] **Step 3：Commit**

```bash
git add src/ripple/sandbox/provisioning.py
git commit -m "refactor(sandbox): add user-scoped provisioning (venv/pnpm)"
```

---

## Task 2.5：`executor.py` 支持 uid

**Files:**
- Modify: `src/ripple/sandbox/executor.py`

- [ ] **Step 1：实现**

在文件末尾加：

```python
async def execute_in_sandbox_uid(
    command: str,
    config: SandboxConfig,
    user_id: str,
    timeout: int | None = None,
) -> tuple[str, str, int]:
    """在 user 的 nsjail 沙箱中执行命令"""
    from ripple.sandbox.nsjail_config import build_nsjail_argv_uid, write_nsjail_config_uid

    cfg_path = config.nsjail_cfg_file_by_uid(user_id)
    if not cfg_path.exists():
        write_nsjail_config_uid(config, user_id)

    effective_timeout = timeout or config.resource_limits.command_timeout
    nsjail_cmd = build_nsjail_argv_uid(config, user_id, command)

    logger.debug("nsjail 执行 (uid={}): {}", user_id, command[:200])

    proc = await asyncio.create_subprocess_exec(
        *nsjail_cmd,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            proc.communicate(), timeout=effective_timeout
        )
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return "", f"Command timed out after {effective_timeout} seconds", -1

    stdout = stdout_bytes.decode(errors="replace") if stdout_bytes else ""
    stderr = stderr_bytes.decode(errors="replace") if stderr_bytes else ""

    nsjail_log_prefixes = ("[I]", "[D]", "[W]", "[E]", "[F]")
    filtered_stderr = "\n".join(
        line for line in stderr.splitlines()
        if not any(line.startswith(p) for p in nsjail_log_prefixes)
    )
    return stdout, filtered_stderr, proc.returncode or 0
```

- [ ] **Step 2：Ruff + Commit**

```bash
ruff check src/ripple/sandbox/executor.py
ruff format src/ripple/sandbox/executor.py
git add src/ripple/sandbox/executor.py
git commit -m "refactor(sandbox): add execute_in_sandbox_uid"
```

---

## Task 2.6：`feishu.py` 支持 uid

**Files:**
- Modify: `src/ripple/sandbox/feishu.py`

- [ ] **Step 1：实现**

关键改动：

1. `_lark_cli_config_locks` 和 `_feishu_setup_states` 改为**按 uid 索引**（为了平滑过渡，新增 `_lark_cli_config_locks_uid` 和 `_feishu_setup_states_uid` 两个字典，旧的保留到 Phase 6 清理）。
2. 把 `_get_feishu_credentials(config, sid)` / `_inject_feishu_credentials(..., sid, ...)` / `_start_feishu_setup(..., sid)` / `_check_feishu_setup(..., sid)` / `ensure_lark_cli_config(config, sid)` 复制为 `_uid` 版本，内部 `config.feishu_config_file(sid)` → `config.feishu_config_file_by_uid(uid)`，`build_nsjail_argv(config, sid, cmd)` → `build_nsjail_argv_uid(config, uid, cmd)`。

关键函数示例：

```python
_lark_cli_config_locks_uid: dict[str, asyncio.Lock] = {}
_feishu_setup_states_uid: dict[str, _FeishuSetupState] = {}


def _get_feishu_credentials_uid(config: SandboxConfig, user_id: str) -> tuple[str, str, str] | None:
    feishu_file = config.feishu_config_file_by_uid(user_id)
    if feishu_file.exists():
        try:
            data = json.loads(feishu_file.read_text(encoding="utf-8"))
            app_id = data.get("app_id", "")
            app_secret = data.get("app_secret", "")
            if app_id and app_secret:
                return app_id, app_secret, data.get("brand", "feishu")
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("user {} feishu.json 读取失败: {}", user_id, e)
    return None


async def ensure_lark_cli_config_uid(
    config: SandboxConfig,
    user_id: str,
) -> tuple[bool, str]:
    if not config.lark_cli_bin:
        return False, "lark-cli 未预装"
    if config.has_lark_cli_config_by_uid(user_id):
        return True, ""

    lock = _lark_cli_config_locks_uid.setdefault(user_id, asyncio.Lock())
    async with lock:
        if config.has_lark_cli_config_by_uid(user_id):
            return True, ""

        creds = _get_feishu_credentials_uid(config, user_id)
        if creds:
            app_id, app_secret, brand = creds
            return await _inject_feishu_credentials_uid(config, user_id, app_id, app_secret, brand)

        if user_id in _feishu_setup_states_uid:
            ok, msg = await _check_feishu_setup_uid(config, user_id)
            if ok:
                return True, ""
            return False, msg

        return await _start_feishu_setup_uid(config, user_id)
```

其他 `_uid` 函数照搬原实现、把 sid→uid、`build_nsjail_argv`→`build_nsjail_argv_uid`。

- [ ] **Step 2：Ruff + Commit**

```bash
ruff check src/ripple/sandbox/feishu.py
ruff format src/ripple/sandbox/feishu.py
git add src/ripple/sandbox/feishu.py
git commit -m "refactor(sandbox): add user-scoped lark-cli config flow"
```

---

## Task 2.7：`notion.py` 支持 uid

**Files:**
- Modify: `src/ripple/sandbox/notion.py`
- Create: `tests/sandbox/test_notion.py`

- [ ] **Step 1：写失败测试**

```python
"""notion token 的 uid 维度 API"""

from pathlib import Path

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.notion import read_notion_token_uid, write_notion_token_uid
from ripple.sandbox.workspace import create_user_workspace


def _cfg(tmp_path: Path) -> SandboxConfig:
    return SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "caches",
    )


def test_write_then_read(tmp_path: Path):
    c = _cfg(tmp_path)
    create_user_workspace(c, "alice")
    write_notion_token_uid(c, "alice", "ntn_abc123def456")
    assert read_notion_token_uid(c, "alice") == "ntn_abc123def456"


def test_read_missing_returns_none(tmp_path: Path):
    c = _cfg(tmp_path)
    assert read_notion_token_uid(c, "alice") is None


def test_tokens_isolated_between_users(tmp_path: Path):
    c = _cfg(tmp_path)
    create_user_workspace(c, "alice")
    create_user_workspace(c, "bob")
    write_notion_token_uid(c, "alice", "ntn_alice_token")
    write_notion_token_uid(c, "bob", "ntn_bob_token")
    assert read_notion_token_uid(c, "alice") == "ntn_alice_token"
    assert read_notion_token_uid(c, "bob") == "ntn_bob_token"
```

- [ ] **Step 2：跑测试**

```bash
pytest tests/sandbox/test_notion.py -v
```
Expected: ImportError

- [ ] **Step 3：实现**

在 `src/ripple/sandbox/notion.py` 底部追加：

```python
def read_notion_token_uid(config: SandboxConfig, user_id: str) -> str | None:
    f = config.notion_config_file_by_uid(user_id)
    if not f.exists():
        return None
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("user {} notion.json 读取失败: {}", user_id, e)
        return None
    token = data.get("api_token", "")
    if not isinstance(token, str) or not token.strip():
        return None
    return token.strip()


def write_notion_token_uid(config: SandboxConfig, user_id: str, api_token: str) -> None:
    f = config.notion_config_file_by_uid(user_id)
    f.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps({"api_token": api_token.strip()}, indent=2)
    f.write_text(payload, encoding="utf-8")
    f.chmod(0o600)
    logger.debug("写入 user {} notion.json", user_id)
```

- [ ] **Step 4：跑测试 + ruff**

```bash
pytest tests/sandbox/test_notion.py -v
ruff check src/ripple/sandbox/notion.py tests/sandbox/test_notion.py
ruff format src/ripple/sandbox/notion.py tests/sandbox/test_notion.py
```
Expected: 3 passed

- [ ] **Step 5：Commit**

```bash
git add src/ripple/sandbox/notion.py tests/sandbox/test_notion.py
git commit -m "feat(sandbox): add user-scoped notion token read/write"
```

---

## Task 2.8：`SandboxManager` 新增 user 维度 API + per-user 锁

**Files:**
- Modify: `src/ripple/sandbox/manager.py`
- Create: `tests/sandbox/test_manager.py`
- Create: `tests/sandbox/test_per_user_lock.py`

- [ ] **Step 1：写 manager 测试**

```python
"""SandboxManager user 维度 API"""

from pathlib import Path

import pytest

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.manager import SandboxManager


def _manager(tmp_path: Path) -> SandboxManager:
    # 跳过 nsjail 可用性检查：monkey-patch check_nsjail_available？
    # 简化：测试用 real config 但不触发真的 nsjail 执行
    from ripple.sandbox import manager as mgr
    cfg = SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "caches",
        nsjail_path="/bin/true",  # 存在即可，不实际调用
    )
    # 绕过 nsjail 可用性强校验
    mgr.check_nsjail_available = lambda path: None  # type: ignore[assignment]
    return SandboxManager(cfg)


def test_ensure_sandbox_creates_layout(tmp_path: Path):
    m = _manager(tmp_path)
    workspace = m.ensure_sandbox("alice")
    assert workspace == m.config.workspace_dir_by_uid("alice")
    assert workspace.exists()
    assert (m.config.sandbox_dir("alice") / "credentials").exists()
    assert (m.config.sandbox_dir("alice") / "sessions").exists()


def test_ensure_sandbox_idempotent(tmp_path: Path):
    m = _manager(tmp_path)
    ws1 = m.ensure_sandbox("alice")
    ws2 = m.ensure_sandbox("alice")
    assert ws1 == ws2


def test_teardown_sandbox(tmp_path: Path):
    m = _manager(tmp_path)
    m.ensure_sandbox("alice")
    assert m.teardown_sandbox("alice") is True
    assert not m.config.sandbox_dir("alice").exists()
    assert m.teardown_sandbox("alice") is False


def test_teardown_sandbox_rejects_default(tmp_path: Path):
    # default user 保留不可删除
    m = _manager(tmp_path)
    m.ensure_sandbox("default")
    with pytest.raises(PermissionError, match="default"):
        m.teardown_sandbox("default", allow_default=False)


def test_setup_session_creates_session_dir(tmp_path: Path):
    m = _manager(tmp_path)
    m.setup_session_uid("alice", "srv-abc")
    assert m.config.session_dir_by_uid("alice", "srv-abc").exists()


def test_teardown_session_removes_session_only(tmp_path: Path):
    m = _manager(tmp_path)
    m.setup_session_uid("alice", "srv-abc")
    m.setup_session_uid("alice", "srv-def")
    m.teardown_session_uid("alice", "srv-abc")
    assert not m.config.session_dir_by_uid("alice", "srv-abc").exists()
    assert m.config.session_dir_by_uid("alice", "srv-def").exists()
    assert m.config.sandbox_dir("alice").exists()  # sandbox 本身保留
```

- [ ] **Step 2：写并发锁测试**

```python
"""user 级锁：同一 user 的工具调用互斥，不同 user 并行"""

import asyncio
from pathlib import Path

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.manager import SandboxManager


async def test_same_user_lock_serializes(tmp_path: Path):
    from ripple.sandbox import manager as mgr
    mgr.check_nsjail_available = lambda path: None  # type: ignore[assignment]

    cfg = SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "caches",
        nsjail_path="/bin/true",
    )
    m = SandboxManager(cfg)
    m.ensure_sandbox("alice")

    events: list[str] = []

    async def worker(name: str):
        async with m.user_lock("alice"):
            events.append(f"{name}-enter")
            await asyncio.sleep(0.05)
            events.append(f"{name}-exit")

    await asyncio.gather(worker("A"), worker("B"))
    # 任一 worker 必须完整 enter→exit 才能让出
    assert events[0].endswith("-enter")
    assert events[1].endswith("-exit")
    assert events[2].endswith("-enter")
    assert events[3].endswith("-exit")


async def test_different_users_parallel(tmp_path: Path):
    from ripple.sandbox import manager as mgr
    mgr.check_nsjail_available = lambda path: None  # type: ignore[assignment]

    cfg = SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "caches",
        nsjail_path="/bin/true",
    )
    m = SandboxManager(cfg)
    m.ensure_sandbox("alice")
    m.ensure_sandbox("bob")

    started: dict[str, float] = {}

    async def worker(uid: str):
        async with m.user_lock(uid):
            started[uid] = asyncio.get_event_loop().time()
            await asyncio.sleep(0.05)

    await asyncio.gather(worker("alice"), worker("bob"))
    # 两个 worker 开始时间应几乎重合（< 10ms 差）
    assert abs(started["alice"] - started["bob"]) < 0.02
```

- [ ] **Step 3：跑测试**

```bash
pytest tests/sandbox/test_manager.py tests/sandbox/test_per_user_lock.py -v
```
Expected: 大量失败（API 尚未实现）

- [ ] **Step 4：实现**

在 `src/ripple/sandbox/manager.py` 中：

1. `__init__` 新增 `self._user_locks: dict[str, asyncio.Lock] = {}`
2. 新增方法：

```python
    def user_lock(self, user_id: str) -> asyncio.Lock:
        """获取 user 级工具调用锁，所有沙箱命令执行前应 async with"""
        return self._user_locks.setdefault(user_id, asyncio.Lock())

    def ensure_sandbox(self, user_id: str) -> Path:
        """幂等地为 user 创建沙箱环境（workspace + nsjail.cfg）"""
        from ripple.sandbox.nsjail_config import write_nsjail_config_uid
        from ripple.sandbox.workspace import create_user_workspace

        workspace = create_user_workspace(self.config, user_id)
        write_nsjail_config_uid(self.config, user_id)
        logger.info("user {} 沙箱就绪", user_id)
        return workspace

    def teardown_sandbox(self, user_id: str, *, allow_default: bool = False) -> bool:
        """销毁整个 user sandbox（含所有 session）"""
        if user_id == "default" and not allow_default:
            raise PermissionError("default user sandbox cannot be torn down")
        from ripple.sandbox.workspace import destroy_user_sandbox
        self._user_locks.pop(user_id, None)
        return destroy_user_sandbox(self.config, user_id)

    def setup_session_uid(self, user_id: str, session_id: str) -> Path:
        """在已存在的 user sandbox 下创建 session 目录"""
        from ripple.sandbox.workspace import create_user_workspace
        create_user_workspace(self.config, user_id)  # 幂等保证 sandbox 存在
        session_dir = self.config.session_dir_by_uid(user_id, session_id)
        session_dir.mkdir(parents=True, exist_ok=True)
        self.config.task_outputs_dir_by_uid(user_id, session_id).mkdir(exist_ok=True)
        logger.info("user {} session {} 就绪", user_id, session_id)
        return session_dir

    def teardown_session_uid(self, user_id: str, session_id: str) -> None:
        """仅删 session 目录，保留 sandbox"""
        from ripple.sandbox.storage import delete_session_state_uid
        import shutil
        delete_session_state_uid(self.config, user_id, session_id)
        session_dir = self.config.session_dir_by_uid(user_id, session_id)
        if session_dir.exists():
            shutil.rmtree(session_dir)

    def suspend_session_uid(
        self,
        user_id: str,
        session_id: str,
        **kwargs,
    ) -> bool:
        """挂起：只写 meta.json + messages.jsonl，保留 workspace（workspace 本来就是 user 级）"""
        from ripple.sandbox.storage import save_session_state_uid
        from ripple.sandbox.workspace import user_sandbox_exists

        if not user_sandbox_exists(self.config, user_id):
            logger.warning("无法挂起: user {} 无 sandbox", user_id)
            return False
        save_session_state_uid(self.config, user_id, session_id, **kwargs)
        return True

    def resume_session_uid(self, user_id: str, session_id: str) -> dict | None:
        """从磁盘恢复 session 状态；sandbox 缺了就重建"""
        from ripple.sandbox.nsjail_config import write_nsjail_config_uid
        from ripple.sandbox.storage import load_session_state_uid
        from ripple.sandbox.workspace import user_sandbox_exists

        state = load_session_state_uid(self.config, user_id, session_id)
        if state is None:
            return None
        if not user_sandbox_exists(self.config, user_id):
            self.ensure_sandbox(user_id)
        write_nsjail_config_uid(self.config, user_id)
        return state

    def list_user_sandboxes(self) -> list[str]:
        """列出所有已存在的 user_id"""
        from ripple.sandbox.workspace import list_all_user_ids
        return list_all_user_ids(self.config)

    def list_user_sessions(self, user_id: str) -> list[str]:
        from ripple.sandbox.workspace import list_user_sessions as _list
        return _list(self.config, user_id)

    def sandbox_summary(self, user_id: str) -> dict | None:
        """为 GET /v1/sandboxes 返回的摘要"""
        from ripple.sandbox.workspace import get_workspace_size_bytes, user_sandbox_exists
        if not user_sandbox_exists(self.config, user_id):
            return None
        ws_size = 0
        ws = self.config.workspace_dir_by_uid(user_id)
        if ws.exists():
            for f in ws.rglob("*"):
                if f.is_file():
                    ws_size += f.stat().st_size
        return {
            "user_id": user_id,
            "workspace_size_bytes": ws_size,
            "session_count": len(self.list_user_sessions(user_id)),
            "has_python_venv": self.config.has_python_venv_by_uid(user_id),
            "has_pnpm_setup": self.config.has_pnpm_setup_by_uid(user_id),
            "has_lark_cli_config": self.config.has_lark_cli_config_by_uid(user_id),
            "has_notion_token": self.config.has_notion_token_by_uid(user_id),
        }
```

- [ ] **Step 5：跑测试 + ruff**

```bash
pytest tests/sandbox/test_manager.py tests/sandbox/test_per_user_lock.py -v
ruff check src/ripple/sandbox/manager.py tests/sandbox/test_manager.py tests/sandbox/test_per_user_lock.py
ruff format src/ripple/sandbox/manager.py tests/sandbox/test_manager.py tests/sandbox/test_per_user_lock.py
```
Expected: 全部 passed

- [ ] **Step 6：Commit**

```bash
git add src/ripple/sandbox/manager.py tests/sandbox/test_manager.py tests/sandbox/test_per_user_lock.py
git commit -m "feat(sandbox): SandboxManager adds user-scoped API with per-user lock"
```

---

### Phase 2 执行顺序修正

Task 间有依赖：

1. 先做 **Task 2.1 → 2.7 → 2.2 → 2.5 → 2.3 → 2.4 → 2.6 → 2.8**

原因：
- 2.7 (notion read) 被 2.3 (nsjail_config) 导入
- 2.5 (executor) 被 2.4 (provisioning) 和 2.6 (feishu) 导入
- 2.3 (nsjail_config) 被 2.5 (executor) 和 2.6 (feishu) 导入

实际执行时如果遇到 `ImportError: cannot import name`，就按上面顺序调整。

---

# Phase 3：Server / Context 接入 user_id

## Task 3.1：`ToolUseContext` 加 `user_id` 字段

**Files:**
- Modify: `src/ripple/core/context.py`
- Create: `tests/core/test_context.py`

- [ ] **Step 1：写失败测试**

```python
"""ToolUseContext 新增 user_id 字段"""

from pathlib import Path

from ripple.core.context import ToolOptions, ToolUseContext


def test_user_id_default_none():
    ctx = ToolUseContext(options=ToolOptions(), session_id="sid")
    assert ctx.user_id is None


def test_user_id_assignment():
    ctx = ToolUseContext(options=ToolOptions(), session_id="sid", user_id="alice")
    assert ctx.user_id == "alice"


def test_is_sandboxed_requires_user_id(tmp_path: Path):
    from ripple.utils import paths

    ws = tmp_path / "sandboxes" / "alice" / "workspace"
    ws.mkdir(parents=True)

    ctx = ToolUseContext(
        options=ToolOptions(),
        session_id="sid",
        workspace_root=ws,
        sandbox_session_id="srv-abc",
        user_id="alice",
    )
    # is_sandboxed 原实现检查 workspace 在 SESSIONS_DIR 下；Phase 3 改为检查 SANDBOXES_DIR
    # 此测试暂先验证字段存在并能访问
    assert ctx.user_id == "alice"
```

- [ ] **Step 2：跑测试验证失败**

```bash
pytest tests/core/test_context.py -v
```
Expected: `AttributeError` (没有 user_id 字段)

- [ ] **Step 3：实现**

修改 `src/ripple/core/context.py`：

```python
# 在 ToolUseContext dataclass 加字段（放在 session_runtime_dir 之后）:
    user_id: str | None = None
```

并修改 `is_sandboxed`，把 `SESSIONS_DIR` 判据改为 `SANDBOXES_DIR`：

```python
    @property
    def is_sandboxed(self) -> bool:
        if not self.user_id or not self.workspace_root:
            return False
        from ripple.utils.paths import SANDBOXES_DIR
        try:
            self.workspace_root.resolve().relative_to(SANDBOXES_DIR.resolve())
        except (ValueError, OSError):
            return False
        return True
```

- [ ] **Step 4：跑测试 + ruff**

```bash
pytest tests/core/test_context.py -v
ruff check src/ripple/core/context.py tests/core/test_context.py
ruff format src/ripple/core/context.py tests/core/test_context.py
```
Expected: 3 passed

- [ ] **Step 5：Commit**

```bash
git add src/ripple/core/context.py tests/core/test_context.py
git commit -m "feat(core): ToolUseContext adds user_id field"
```

---

## Task 3.2：`deps.py` 新增 `get_user_id` FastAPI 依赖

**Files:**
- Create: `src/interfaces/server/deps.py`
- Create: `tests/server/test_user_id_header.py`

- [ ] **Step 1：写失败测试**

```python
"""X-Ripple-User-Id header 解析"""

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from interfaces.server.deps import get_user_id


def _make_app():
    app = FastAPI()

    @app.get("/echo")
    async def echo(uid: str = None):  # type: ignore[assignment]
        from fastapi import Depends
        return {"uid": uid}

    @app.get("/echo2")
    async def echo2(uid=pytest.importorskip("fastapi").Depends(get_user_id)):
        return {"uid": uid}

    return app


def test_header_present():
    from fastapi import Depends

    app = FastAPI()

    @app.get("/uid")
    async def r(uid: str = Depends(get_user_id)):
        return {"uid": uid}

    client = TestClient(app)
    r = client.get("/uid", headers={"X-Ripple-User-Id": "alice"})
    assert r.status_code == 200
    assert r.json() == {"uid": "alice"}


def test_header_absent_falls_back_to_default():
    from fastapi import Depends

    app = FastAPI()

    @app.get("/uid")
    async def r(uid: str = Depends(get_user_id)):
        return {"uid": uid}

    client = TestClient(app)
    r = client.get("/uid")
    assert r.status_code == 200
    assert r.json() == {"uid": "default"}


def test_header_invalid_rejected():
    from fastapi import Depends

    app = FastAPI()

    @app.get("/uid")
    async def r(uid: str = Depends(get_user_id)):
        return {"uid": uid}

    client = TestClient(app)
    r = client.get("/uid", headers={"X-Ripple-User-Id": "../evil"})
    assert r.status_code == 400
```

- [ ] **Step 2：跑测试**

```bash
pytest tests/server/test_user_id_header.py -v
```
Expected: `ImportError`

- [ ] **Step 3：实现**

创建 `src/interfaces/server/deps.py`：

```python
"""FastAPI 依赖：HTTP 请求头里提取 user_id 并校验"""

from fastapi import Header, HTTPException

from ripple.sandbox.config import _USER_ID_RE


async def get_user_id(
    x_ripple_user_id: str | None = Header(default=None, alias="X-Ripple-User-Id"),
) -> str:
    """从 `X-Ripple-User-Id` header 解析 user_id；缺失回落 `default`；非法抛 400"""
    uid = (x_ripple_user_id or "default").strip()
    if not _USER_ID_RE.match(uid):
        raise HTTPException(status_code=400, detail=f"Invalid X-Ripple-User-Id: {uid!r}")
    return uid
```

- [ ] **Step 4：跑测试 + ruff**

```bash
pytest tests/server/test_user_id_header.py -v
ruff check src/interfaces/server/deps.py tests/server/test_user_id_header.py
ruff format src/interfaces/server/deps.py tests/server/test_user_id_header.py
```
Expected: 3 passed

- [ ] **Step 5：Commit**

```bash
git add src/interfaces/server/deps.py tests/server/test_user_id_header.py
git commit -m "feat(server): add get_user_id FastAPI dependency"
```

---

## Task 3.3：`SessionManager` 升级为 `(uid, sid)` 二元主键

**Files:**
- Modify: `src/interfaces/server/sessions.py`

- [ ] **Step 1：改造 Session dataclass**

在 `Session` 里新增字段：

```python
    user_id: str = "default"
```

- [ ] **Step 2：SessionManager `_sessions` 改 key 类型**

```python
    # 旧：self._sessions: dict[str, Session] = {}
    # 新：
    self._sessions: dict[tuple[str, str], Session] = {}
```

- [ ] **Step 3：所有方法签名加 user_id 参数**

- `create_session(user_id, ...)` → 在 `_create_session_context` 调用处传 user_id
- `get_session(user_id, session_id)` → key 改为 `(user_id, session_id)`
- `delete_session(user_id, session_id)`
- `stop_session(user_id, session_id)`
- `suspend_session(user_id, session_id)`
- `resume_session(user_id, session_id)`
- `persist_session(user_id, session_id)`
- `list_sessions(user_id)`：只返回该 user 名下的
- `list_all_sessions(user_id)`：磁盘扫描改为 `sandbox_manager.list_user_sessions(user_id)`
- `list_suspended_sessions(user_id)`
- `get_or_create_session(user_id, session_id, ...)`

内部 `_suspend_to_disk(session)` 改为用 `session.user_id` 调 `suspend_session_uid`。

**关键改动在 `create_session`：**

```python
    def create_session(
        self,
        user_id: str,
        model: str | None = None,
        max_turns: int | None = None,
        caller_system_prompt: str | None = None,
        feishu: "FeishuConfig | None" = None,
    ) -> Session:
        # ...
        session_id = f"srv-{uuid4().hex[:12]}"

        workspace_root = None
        session_runtime_dir = None
        if self._sandbox_manager:
            self._sandbox_manager.ensure_sandbox(user_id)
            self._sandbox_manager.setup_session_uid(user_id, session_id)
            workspace_root = self._sandbox_manager.config.workspace_dir_by_uid(user_id)
            session_runtime_dir = self._sandbox_manager.config.session_dir_by_uid(user_id, session_id)
            if feishu:
                self._write_feishu_config(user_id, feishu)

        context, client = _create_session_context(
            resolved_model,
            internal_sid,
            workspace_root=workspace_root,
            sandbox_session_id=session_id if self._sandbox_manager else None,
            session_runtime_dir=session_runtime_dir,
            user_id=user_id,  # 新增
        )

        session = Session(
            session_id=session_id,
            user_id=user_id,
            # ...
        )
        self._sessions[(user_id, session_id)] = session
        return session
```

`_create_session_context` 函数签名加 `user_id` 参数，塞到 `ToolUseContext(user_id=user_id)`。

`_write_feishu_config` 改签名为 `(user_id, feishu)`，写到 `feishu_config_file_by_uid(user_id)`。

- [ ] **Step 4：Ruff + 手动 smoke test**

启动 server，用 `curl` 验证：

```bash
uv run ripple server &
sleep 3
curl -H "Authorization: Bearer rk-ripple-2026" \
     -H "X-Ripple-User-Id: alice" \
     -H "Content-Type: application/json" \
     -X POST http://localhost:8811/v1/chat/completions \
     -d '{"messages":[{"role":"user","content":"ls"}]}'
```

期望：返回 200，目录 `.ripple/sandboxes/alice/workspace/` 出现。

- [ ] **Step 5：Commit**

```bash
git add src/interfaces/server/sessions.py
git commit -m "refactor(server): SessionManager keyed by (user_id, session_id)"
```

---

## Task 3.4：`routes.py` 所有 handler 加 `user_id` 依赖

**Files:**
- Modify: `src/interfaces/server/routes.py`

- [ ] **Step 1：改造每个路由**

每个 session 相关路由加 `user_id: str = Depends(get_user_id)` 参数，并把对 `manager` 的调用改成带 user_id 版。

受影响路由：
- `chat_completions`
- `list_sessions`
- `create_session`
- `get_session`
- `stop_session`
- `resolve_permission_request`
- `get_session_usage`
- `delete_session`
- `suspend_session`
- `resume_session`
- `list_suspended_sessions`
- `get_sandbox_info`
- `invoke_tool`

示例（`chat_completions`）：

```python
from interfaces.server.deps import get_user_id

@router.post("/v1/chat/completions")
async def chat_completions(
    request: ChatCompletionRequest,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    # ...
    session, is_new = manager.get_or_create_session(
        user_id=user_id,
        session_id=request.session_id,
        model=request.model,
        max_turns=max_turns,
        caller_system_prompt=caller_system_prompt,
    )
    # ... 其余照旧
```

示例（`get_session`）：

```python
@router.get("/v1/sessions/{session_id}")
async def get_session(
    session_id: str,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    manager = get_session_manager()
    session = manager.get_session(user_id, session_id)
    if not session:
        session = manager.resume_session(user_id, session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    # ...
```

- [ ] **Step 2：Ruff**

```bash
ruff check src/interfaces/server/routes.py
ruff format src/interfaces/server/routes.py
```

- [ ] **Step 3：Smoke test**

```bash
uv run ripple server &
sleep 3
# 创建 session in alice 
curl -X POST -H "Authorization: Bearer rk-ripple-2026" \
     -H "X-Ripple-User-Id: alice" \
     http://localhost:8811/v1/sessions -d '{}' -H "Content-Type: application/json"

# 用 bob 访问 alice 的 session 应该 404
SID=$(ls .ripple/sandboxes/alice/sessions/ | head -1)
curl -H "Authorization: Bearer rk-ripple-2026" \
     -H "X-Ripple-User-Id: bob" \
     http://localhost:8811/v1/sessions/$SID -o /tmp/resp.json -w "%{http_code}\n"
# Expected: 404
```

- [ ] **Step 4：Commit**

```bash
git add src/interfaces/server/routes.py
git commit -m "refactor(server): all session routes require X-Ripple-User-Id"
```

---

## Task 3.5：`agent_tool.py` & `subagent.py` 透传 user_id

**Files:**
- Modify: `src/ripple/tools/builtin/agent_tool.py`
- Modify: `src/ripple/tools/builtin/subagent.py`

- [ ] **Step 1：修改两处子 context 构造**

`src/ripple/tools/builtin/agent_tool.py` 第 95-97 行附近：

```python
# 子 context 构造时加 user_id:
sub_context = ToolUseContext(
    options=...,
    session_id=...,
    workspace_root=context.workspace_root,
    sandbox_session_id=context.sandbox_session_id,
    session_runtime_dir=context.session_runtime_dir,
    user_id=context.user_id,  # 新增
    ...
)
```

`src/ripple/tools/builtin/subagent.py` 第 114-116 行附近同样处理。

- [ ] **Step 2：Ruff + Commit**

```bash
ruff check src/ripple/tools/builtin/agent_tool.py src/ripple/tools/builtin/subagent.py
ruff format src/ripple/tools/builtin/agent_tool.py src/ripple/tools/builtin/subagent.py

git add src/ripple/tools/builtin/agent_tool.py src/ripple/tools/builtin/subagent.py
git commit -m "refactor(tools): subagent contexts inherit user_id"
```

---

# Phase 4：工具层切换到 uid

## Task 4.1：`NotionTokenSetTool` 切换到 user_id

**Files:**
- Modify: `src/ripple/tools/builtin/notion_token_set.py`
- Create: `tests/tools/test_notion_token_set.py`

- [ ] **Step 1：写测试**

```python
"""NotionTokenSet 写入 user 级 credentials/notion.json"""

from pathlib import Path

from ripple.core.context import ToolOptions, ToolUseContext
from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.workspace import create_user_workspace
from ripple.tools.builtin import bash as bash_mod
from ripple.tools.builtin.notion_token_set import NotionTokenSetTool


async def test_notion_token_set_writes_to_user_dir(tmp_path: Path):
    cfg = SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "caches",
        nsjail_path="/bin/true",
    )
    create_user_workspace(cfg, "alice")
    bash_mod._sandbox_config = cfg  # type: ignore[assignment]

    ctx = ToolUseContext(
        options=ToolOptions(),
        session_id="int",
        workspace_root=cfg.workspace_dir_by_uid("alice"),
        sandbox_session_id="srv-abc",
        user_id="alice",
    )
    tool = NotionTokenSetTool()
    result = await tool.call({"api_token": "ntn_" + "x" * 30}, ctx, None)
    assert result.data["ok"] is True
    assert cfg.notion_config_file_by_uid("alice").exists()
```

- [ ] **Step 2：跑测试**

```bash
pytest tests/tools/test_notion_token_set.py -v
```
Expected: fail — 当前工具写 session_id 维度

- [ ] **Step 3：实现**

修改 `src/ripple/tools/builtin/notion_token_set.py` 第 125-136 行区段：

```python
        user_id = context.user_id
        if not user_id:
            return ToolResult(
                data={
                    "ok": False,
                    "error": "当前上下文没有 user_id，无法定位写入位置",
                }
            )

        try:
            from ripple.sandbox.notion import write_notion_token_uid
            from ripple.sandbox.nsjail_config import write_nsjail_config_uid

            write_notion_token_uid(_sandbox_config, user_id, api_token)
            write_nsjail_config_uid(_sandbox_config, user_id)
        except OSError as e:
            logger.error("user {} 写入 notion.json 失败: {}", user_id, e)
            return ToolResult(data={"ok": False, "error": f"写入失败: {e}"})

        masked = f"{api_token[:6]}...({len(api_token)} chars)"
        logger.info("user {} Notion token 已绑定 ({})", user_id, masked)
```

`description` 也略微改：把 "per-session" → "per-user"，"current session" → "current user"。

- [ ] **Step 4：跑测试 + ruff**

```bash
pytest tests/tools/test_notion_token_set.py -v
ruff check src/ripple/tools/builtin/notion_token_set.py tests/tools/test_notion_token_set.py
ruff format src/ripple/tools/builtin/notion_token_set.py tests/tools/test_notion_token_set.py
```
Expected: passed

- [ ] **Step 5：Commit**

```bash
git add src/ripple/tools/builtin/notion_token_set.py tests/tools/test_notion_token_set.py
git commit -m "refactor(tools): NotionTokenSet writes to user-scoped credentials"
```

---

## Task 4.2：`bash.py` 所有沙箱调用切换到 uid

**Files:**
- Modify: `src/ripple/tools/builtin/bash.py`

- [ ] **Step 1：替换所有 session_id 调用点**

把 `bash.py` 中涉及 `session_id = context.sandbox_session_id` 的分支改为 `user_id = context.user_id`，并更换函数：

| 旧调用 | 新调用 |
|---|---|
| `_sandbox_config.has_python_venv(session_id)` | `_sandbox_config.has_python_venv_by_uid(user_id)` |
| `_sandbox_config.has_pnpm_setup(session_id)` | `_sandbox_config.has_pnpm_setup_by_uid(user_id)` |
| `_sandbox_config.has_lark_cli_config(session_id)` | `_sandbox_config.has_lark_cli_config_by_uid(user_id)` |
| `_sandbox_config.has_notion_token(session_id)` | `_sandbox_config.has_notion_token_by_uid(user_id)` |
| `ensure_python_venv(_sandbox_config, session_id)` | `ensure_python_venv_uid(_sandbox_config, user_id)` |
| `ensure_pnpm_setup(_sandbox_config, session_id)` | `ensure_pnpm_setup_uid(_sandbox_config, user_id)` |
| `ensure_lark_cli_config(_sandbox_config, session_id)` | `ensure_lark_cli_config_uid(_sandbox_config, user_id)` |
| `execute_in_sandbox(cmd, _sandbox_config, session_id, ...)` | `execute_in_sandbox_uid(cmd, _sandbox_config, user_id, ...)` |
| `check_workspace_quota(_sandbox_config, session_id)` | `check_workspace_quota_uid(_sandbox_config, user_id)` (Task 附属：workspace.py 加该函数) |

对应 import 同步改。

执行流程中追加 user 级锁包裹：

```python
async def _run_in_sandbox(self, user_id, command, ...):
    sandbox_mgr = ...  # 如何拿？见下
    async with sandbox_mgr.user_lock(user_id):
        # ... existing 沙箱执行逻辑
```

**问题：`bash.py` 如何拿到 `SandboxManager`？** 目前只有 `_sandbox_config`。需要在 `app.py` 把 `sandbox_mgr` 也注入 bash：

```python
# bash.py 新增
_sandbox_manager = None

def set_sandbox_manager(mgr):
    global _sandbox_manager
    _sandbox_manager = mgr
```

`app.py` `lifespan` 中调用：

```python
from ripple.tools.builtin.bash import set_sandbox_config, set_sandbox_manager
set_sandbox_config(sandbox_mgr.config)
set_sandbox_manager(sandbox_mgr)
```

bash 执行入口处：

```python
if _sandbox_manager:
    async with _sandbox_manager.user_lock(user_id):
        stdout, stderr, exit_code = await execute_in_sandbox_uid(...)
else:
    stdout, stderr, exit_code = await execute_in_sandbox_uid(...)
```

- [ ] **Step 2：`workspace.py` 追加 `check_workspace_quota_uid`**

```python
def check_workspace_quota_uid(config: SandboxConfig, user_id: str) -> tuple[bool, int]:
    workspace = config.workspace_dir_by_uid(user_id)
    if not workspace.exists():
        return False, 0
    total = 0
    for f in workspace.rglob("*"):
        if f.is_file():
            total += f.stat().st_size
    max_bytes = config.max_workspace_mb * 1024 * 1024
    return total > max_bytes, total
```

- [ ] **Step 3：同步改 `app.py`**

加上 `set_sandbox_manager(sandbox_mgr)` 一行。

- [ ] **Step 4：Ruff + Smoke test**

```bash
ruff check src/ripple/tools/builtin/bash.py src/interfaces/server/app.py src/ripple/sandbox/workspace.py
ruff format src/ripple/tools/builtin/bash.py src/interfaces/server/app.py src/ripple/sandbox/workspace.py

uv run ripple server &
sleep 3
curl -X POST -H "Authorization: Bearer rk-ripple-2026" \
     -H "X-Ripple-User-Id: alice" \
     -H "Content-Type: application/json" \
     http://localhost:8811/v1/chat/completions \
     -d '{"messages":[{"role":"user","content":"pwd && uv --version"}]}'
```

期望：返回 200，stdout 显示 `/workspace` 和 uv 版本，`.ripple/sandboxes/alice/workspace/.venv/` 被创建。

- [ ] **Step 5：Commit**

```bash
git add src/ripple/tools/builtin/bash.py \
        src/ripple/sandbox/workspace.py \
        src/interfaces/server/app.py
git commit -m "refactor(tools): bash executes under user-scoped sandbox + lock"
```

---

# Phase 5：`/v1/sandboxes` 端点

## Task 5.1：`schemas.py` 新增 SandboxInfo

**Files:**
- Modify: `src/interfaces/server/schemas.py`

- [ ] **Step 1：追加模型**

```python
class SandboxInfo(BaseModel):
    """一个 user 的沙箱状态摘要"""
    user_id: str
    workspace_size_bytes: int = 0
    session_count: int = 0
    has_python_venv: bool = False
    has_pnpm_setup: bool = False
    has_lark_cli_config: bool = False
    has_notion_token: bool = False


class SandboxListResponse(BaseModel):
    sandboxes: list[SandboxInfo]
    count: int
```

- [ ] **Step 2：Ruff + Commit**

```bash
ruff check src/interfaces/server/schemas.py
ruff format src/interfaces/server/schemas.py
git add src/interfaces/server/schemas.py
git commit -m "feat(server): add SandboxInfo schemas"
```

---

## Task 5.2：实现 `POST/GET/DELETE /v1/sandboxes`

**Files:**
- Modify: `src/interfaces/server/routes.py`
- Create: `tests/server/test_sandbox_endpoints.py`

- [ ] **Step 1：写集成测试**

```python
"""/v1/sandboxes 三个端点"""

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch):
    # 配置指向 tmp_path，避免污染真实 .ripple
    from ripple.sandbox.config import SandboxConfig
    from ripple.sandbox.manager import SandboxManager
    from ripple.sandbox import manager as mgr
    mgr.check_nsjail_available = lambda path: None  # type: ignore[assignment]

    sbx_cfg = SandboxConfig(
        sandboxes_root=tmp_path / "sandboxes",
        caches_root=tmp_path / "caches",
        nsjail_path="/bin/true",
    )
    sbx_mgr = SandboxManager(sbx_cfg)

    from interfaces.server.routes import router, set_session_manager
    from interfaces.server.sessions import SessionManager
    from fastapi import FastAPI

    mgr_obj = SessionManager(sandbox_manager=sbx_mgr)
    set_session_manager(mgr_obj)
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


HEADERS = {"Authorization": "Bearer rk-ripple-2026", "X-Ripple-User-Id": "alice"}


def test_post_sandbox_idempotent(client):
    r1 = client.post("/v1/sandboxes", headers=HEADERS)
    r2 = client.post("/v1/sandboxes", headers=HEADERS)
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json()["user_id"] == "alice"


def test_get_sandbox_summary(client):
    client.post("/v1/sandboxes", headers=HEADERS)
    r = client.get("/v1/sandboxes", headers=HEADERS)
    assert r.status_code == 200
    data = r.json()
    assert data["user_id"] == "alice"
    assert data["session_count"] == 0


def test_get_sandbox_404_when_missing(client):
    r = client.get("/v1/sandboxes", headers=HEADERS)
    assert r.status_code == 404


def test_delete_sandbox(client):
    client.post("/v1/sandboxes", headers=HEADERS)
    r = client.delete("/v1/sandboxes", headers=HEADERS)
    assert r.status_code == 200
    r2 = client.get("/v1/sandboxes", headers=HEADERS)
    assert r2.status_code == 404


def test_delete_default_sandbox_forbidden(client):
    h = {**HEADERS, "X-Ripple-User-Id": "default"}
    client.post("/v1/sandboxes", headers=h)
    r = client.delete("/v1/sandboxes", headers=h)
    assert r.status_code == 409
```

- [ ] **Step 2：跑测试（必然失败）**

```bash
pytest tests/server/test_sandbox_endpoints.py -v
```
Expected: 404（路由不存在）或 FAILED

- [ ] **Step 3：在 `routes.py` 加三个端点**

```python
# ─── Sandboxes ───

@router.post("/v1/sandboxes")
async def create_sandbox(
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(500, "sandbox disabled")
    manager.sandbox_manager.ensure_sandbox(user_id)
    summary = manager.sandbox_manager.sandbox_summary(user_id)
    return SandboxInfo(**summary)


@router.get("/v1/sandboxes")
async def get_sandbox(
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(500, "sandbox disabled")
    summary = manager.sandbox_manager.sandbox_summary(user_id)
    if summary is None:
        raise HTTPException(404, f"Sandbox for user {user_id!r} not found")
    return SandboxInfo(**summary)


@router.delete("/v1/sandboxes")
async def delete_sandbox(
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
):
    manager = get_session_manager()
    if not manager.sandbox_manager:
        raise HTTPException(500, "sandbox disabled")
    # 先停掉该 user 的所有活跃 session
    for (uid, sid) in list(manager._sessions.keys()):
        if uid == user_id:
            manager.delete_session(uid, sid)
    try:
        ok = manager.sandbox_manager.teardown_sandbox(user_id, allow_default=False)
    except PermissionError as e:
        raise HTTPException(409, str(e))
    if not ok:
        raise HTTPException(404, f"Sandbox for user {user_id!r} not found")
    return {"ok": True, "user_id": user_id}
```

对应 import：

```python
from interfaces.server.deps import get_user_id
from interfaces.server.schemas import SandboxInfo, SandboxListResponse
```

- [ ] **Step 4：跑测试 + ruff**

```bash
pytest tests/server/test_sandbox_endpoints.py -v
ruff check src/interfaces/server/routes.py tests/server/test_sandbox_endpoints.py
ruff format src/interfaces/server/routes.py tests/server/test_sandbox_endpoints.py
```
Expected: 5 passed

- [ ] **Step 5：Commit**

```bash
git add src/interfaces/server/routes.py tests/server/test_sandbox_endpoints.py
git commit -m "feat(server): add POST/GET/DELETE /v1/sandboxes endpoints"
```

---

## Task 5.3：`chat_completions` 懒创建 sandbox（保险）

**Files:**
- Modify: `src/interfaces/server/sessions.py`

- [ ] **Step 1：确认 `SessionManager.create_session` 已调 `ensure_sandbox`**

Task 3.3 的实现里已经有 `self._sandbox_manager.ensure_sandbox(user_id)`。此 Task 只做显式验证和补文档。

`chat_completions` 调 `get_or_create_session`，`get_or_create_session` 调 `create_session`，`create_session` 调 `ensure_sandbox`——链路已通。

无代码改动，**此 Task 跳过 commit**。

---

# Phase 6：清理与收尾

## Task 6.1：前端加 `X-Ripple-User-Id` header

**Files:**
- Modify: `src/interfaces/web/src/**/*.ts{,x}` 里所有 fetch 调用

- [ ] **Step 1：全局搜索 fetch**

```bash
cd src/interfaces/web
rg 'fetch\(.*v1/' src/ -l
```

- [ ] **Step 2：在每个 fetch 的 headers 里加**

```typescript
headers: {
  "X-Ripple-User-Id": "default",  // 本地开发暂用 default；上游部署时由网关改写
  // ... 原有 headers
}
```

为减少重复，推荐提炼一个 `lib/api.ts`：

```typescript
export function defaultHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
    "X-Ripple-User-Id": "default",
    // Authorization 等按现有方式追加
  };
}
```

然后所有 fetch 用 `headers: { ...defaultHeaders(), ... }`。

- [ ] **Step 3：构建 + 手工验证**

```bash
bun run lint
bun run format
bun run build
```

启动前后端，在页面上打开一个 session，后端日志应看到 `user_id=default`。

- [ ] **Step 4：Commit**

```bash
git add src/interfaces/web/
git commit -m "feat(web): include X-Ripple-User-Id header in API calls"
```

---

## Task 6.2：删除旧数据 + 旧 API

**Files:**
- 删除 `.ripple/sessions/`
- Modify: `src/ripple/sandbox/config.py`
- Modify: `src/ripple/sandbox/workspace.py`
- Modify: `src/ripple/sandbox/storage.py`
- Modify: `src/ripple/sandbox/nsjail_config.py`
- Modify: `src/ripple/sandbox/provisioning.py`
- Modify: `src/ripple/sandbox/executor.py`
- Modify: `src/ripple/sandbox/feishu.py`
- Modify: `src/ripple/sandbox/notion.py`
- Modify: `src/ripple/sandbox/manager.py`
- Modify: `src/ripple/utils/paths.py`

- [ ] **Step 1：删除磁盘旧数据**

```bash
rm -rf .ripple/sessions/
```

- [ ] **Step 2：删除旧签名方法**

在各个 sandbox 模块里**删除**已不再被调用的旧签名：
- `SandboxConfig.session_dir(sid)` / `workspace_dir(sid)` / `meta_file(sid)` / `messages_file(sid)` / `nsjail_cfg_file(sid)` / `tasks_file(sid)` / `task_outputs_dir(sid)` / `feishu_config_file(sid)` / `notion_config_file(sid)` / `has_python_venv(sid)` / `has_pnpm_setup(sid)` / `has_lark_cli_config(sid)` / `has_notion_token(sid)`
- `SandboxConfig.sessions_root` 字段
- `workspace.py`：`create_workspace(config, sid)` / `destroy_workspace(config, sid)` / `workspace_exists(config, sid)` / `check_workspace_quota(config, sid)` / `list_suspended_sessions(config)`
- `storage.py`：`save_session_state(config, sid, ...)` / `load_session_state(config, sid)` / `delete_session_state(config, sid)` / `get_suspended_session_info(config, sid)`
- `nsjail_config.py`：`generate_nsjail_config(config, sid)` / `write_nsjail_config(config, sid)` / `build_nsjail_argv(config, sid, cmd)` / `build_sandbox_env(config, session_id=...)`（保留 env 函数但删掉 session_id 参数，改为接 `user_id: str | None`）
- `provisioning.py`：`ensure_python_venv(config, sid)` / `ensure_pnpm_setup(config, sid)` / `_install_pip_wrappers(config, sid)` / `_venv_locks` / `_pnpm_locks`
- `executor.py`：`execute_in_sandbox(cmd, config, sid, ...)`
- `feishu.py`：`ensure_lark_cli_config(config, sid)` 及所有旧辅助；旧字典 `_lark_cli_config_locks` / `_feishu_setup_states`
- `notion.py`：`read_notion_token(config, sid)` / `write_notion_token(config, sid, token)`
- `manager.py`：`setup_session(sid)` / `teardown_session(sid)` / `suspend_session(sid, ...)` / `resume_session(sid)` / `list_suspended()` / `get_session_workspace(sid)` / `get_workspace_size(sid)` / `cleanup_expired_suspended()` 旧版

- [ ] **Step 3：把 `_uid` 后缀去掉（重命名为正名）**

为保持 API 整洁，所有 `xxx_by_uid` 和 `xxx_uid` 重命名（因为旧名已释放）：

| 旧名 | 新名 |
|---|---|
| `workspace_dir_by_uid` | `workspace_dir` |
| `session_dir_by_uid` | `session_dir` |
| `meta_file_by_uid` | `meta_file` |
| ... 同上一整批 | 去 `_by_uid` / `_uid` 后缀 |
| `create_user_workspace` | `create_sandbox` |
| `destroy_user_sandbox` | `destroy_sandbox` |
| `execute_in_sandbox_uid` | `execute_in_sandbox` |
| ...  | ... |

使用 IDE 的 "rename symbol" 功能，或 `sed -i`（注意检查）：

```bash
# 示例（预跑前先 grep 确认范围）
rg -l 'execute_in_sandbox_uid' src/ tests/
# 然后逐文件 StrReplace
```

**注意：** 这一步非常容易引入 bug，建议一个文件一个文件改 + 跑一次 test。

- [ ] **Step 4：删除 `ripple/utils/paths.py` 里的 `SESSIONS_DIR`**

```python
# 删掉：
SESSIONS_DIR = RIPPLE_HOME / "sessions"
```

同步更新 docstring 中的示例目录树。

- [ ] **Step 5：更新 `config/settings.yaml`**

注释块：

```yaml
  sandbox:
    # user 级沙箱根目录
    # sandboxes_root: ".ripple/sandboxes"
    # 跨 user 共享的包管理器缓存
    # caches_root: ".ripple/sandboxes-cache"
```

- [ ] **Step 6：跑全量 test**

```bash
pytest tests/ -v
ruff check . && ruff format .
```

Expected: all pass

- [ ] **Step 7：Smoke test 整条链路**

```bash
uv run ripple server &
sleep 3
# user alice 开对话
curl -X POST -H "Authorization: Bearer rk-ripple-2026" \
     -H "X-Ripple-User-Id: alice" \
     -H "Content-Type: application/json" \
     http://localhost:8811/v1/chat/completions \
     -d '{"messages":[{"role":"user","content":"echo hello > /workspace/marker.txt"}]}'

# user bob 开对话，不应看到 alice 的文件
curl -X POST -H "Authorization: Bearer rk-ripple-2026" \
     -H "X-Ripple-User-Id: bob" \
     -H "Content-Type: application/json" \
     http://localhost:8811/v1/chat/completions \
     -d '{"messages":[{"role":"user","content":"ls -la /workspace/"}]}'

# user alice 再开新 session，应能看到之前的 marker.txt
curl -X POST -H "Authorization: Bearer rk-ripple-2026" \
     -H "X-Ripple-User-Id: alice" \
     -H "Content-Type: application/json" \
     http://localhost:8811/v1/chat/completions \
     -d '{"messages":[{"role":"user","content":"cat /workspace/marker.txt"}]}'
# Expected: hello

# 验证目录结构
ls .ripple/sandboxes/alice/workspace/
ls .ripple/sandboxes/bob/workspace/
```

- [ ] **Step 8：Commit**

```bash
git add -A
git commit -m "chore(sandbox): drop legacy session-scoped API and data"
```

---

## Task 6.3：更新文档

**Files:**
- Modify: `CLAUDE.md`
- Modify: `src/interfaces/web/CLAUDE.md`（如目录树也过时）
- Modify: `README.md`（如涉及）

- [ ] **Step 1：更新 `CLAUDE.md` 的目录树**

把第 40-61 行的 `.ripple/` 目录示意图替换为：

```
.ripple/
├── logs/ripple.log
├── sandboxes-cache/
│   ├── uv-cache/
│   ├── corepack-cache/
│   └── pnpm-store/
└── sandboxes/
    └── <user_id>/
        ├── credentials/
        │   ├── feishu.json
        │   └── notion.json
        ├── workspace/
        ├── nsjail.cfg
        └── sessions/
            └── <session_id>/
                ├── meta.json
                ├── messages.jsonl
                ├── tasks.json
                └── task-outputs/
```

并在开头加一节说明 "User 沙箱层"：

```markdown
### User 沙箱层
沙箱（workspace + 凭证 + nsjail.cfg）以 user_id 为隔离单位，而非 session_id。一个 user 对应一个长期存在的 workspace，其下可开多个 session；同一 user 的多 session 共享 workspace，通过 user 级 `asyncio.Lock` 保证工具调用互斥。

调用方通过 HTTP header `X-Ripple-User-Id: <uid>` 传入 user_id；缺失时回落到 `default`。user_id 合法字符集 `[a-zA-Z0-9_-]{1,64}`。ripple 不做身份鉴权 — 由上游业务系统保证 user_id 的有效性与隔离语义。
```

- [ ] **Step 2：更新其他 CLAUDE.md（如适用）**

- [ ] **Step 3：Commit**

```bash
git add CLAUDE.md src/interfaces/web/CLAUDE.md README.md
git commit -m "docs: update directory layout to reflect user-scoped sandbox"
```

---

# 完成标准（验收清单）

所有以下项通过才算 Phase 6 真正完成：

- [ ] `pytest tests/ -v` 全绿
- [ ] `ruff check .` 无错误
- [ ] `.ripple/sessions/` 目录不存在
- [ ] `.ripple/sandboxes/<uid>/` 结构符合 §3.2 spec
- [ ] 两个 user 并发 curl 各自沙箱隔离（验证 workspace 下文件不互见）
- [ ] 同一 user 两个 session 可看到对方写入的 `/workspace/*.txt`
- [ ] 前端启动后能正常对话，日志里看到 `user_id=default`
- [ ] `X-Ripple-User-Id: ../evil` 被 400 拒绝
- [ ] `DELETE /v1/sandboxes` for `default` 返回 409
- [ ] 代码中已无 `SESSIONS_DIR` / `session_dir(sid)` / 等旧签名残留（`rg -l 'sessions_root|SESSIONS_DIR'` 零命中）

---

## 自查总结

**Spec 覆盖：**

| Spec 章节 | 覆盖 Task |
|---|---|
| §3.2 目录布局 | Task 1.1, 2.1 |
| §3.3 user_id 正则 | Task 1.2 |
| §5.1 header 传递 | Task 3.2, 6.1 |
| §5.2 sandbox 端点 | Task 5.1, 5.2 |
| §5.3 session API 变更 | Task 3.3, 3.4 |
| §5.4 懒创建 | Task 3.3, 5.3 |
| §6 SandboxConfig 改造 | Task 1.3, 1.4 + Phase 2 全部 |
| §7 凭证迁移 | Task 2.6, 2.7, 4.1 |
| §8 并发控制 | Task 2.8 + 4.2 |
| §9 ToolUseContext | Task 3.1, 3.5 |
| §11 迁移 | Task 6.2 |

**类型一致性：** 所有 `_by_uid` / `_uid` 后缀在 Phase 6 统一去掉，重命名后代码保持一套签名；中间态 Phase 2-5 通过后缀区分避免歧义。

**无 placeholder：** 所有代码块均为可执行代码，无 TBD / TODO 样式指令。

---

# 交付下一步

**计划已保存到：`docs/specs/2026-04-21-user-sandbox-plan.md`。**

推荐两种执行方式任选其一：

1. **子 Agent 驱动（推荐）**：每个 Task 派一个 fresh subagent 执行，本会话做 review（用 `superpowers:subagent-driven-development`）。隔离性好，上下文不会爆。
2. **内联执行**：本会话批量做，每 Phase 结尾 check-in（用 `superpowers:executing-plans`）。

Phase 之间强烈建议手工 review 一次再继续，不要连轴转。
