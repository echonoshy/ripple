# gogcli 扩展接入实施计划（v2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在首期 gogcli 鉴权三件套（`ClientConfigSet` / `LoginStart` / `LoginComplete`）基础上，补齐**账号可观测性**、**解绑能力**、**三个高价值 service skill（Tasks/Slides/People）**和**前端绑定状态渲染**。明确保持"破坏性操作纯 skill 纪律"的设计不动。

**In Scope:**
1. `GoogleWorkspaceAuthStatus` 工具 —— 封装 `gog auth list --json [--check]`
2. `GoogleWorkspaceLogout` 工具 —— 封装 `gog auth remove <email>`
3. `skills/gog/gog-tasks/SKILL.md`
4. `GET /v1/sandboxes/gogcli-accounts` 轻量端点 + SettingsModal 补齐已绑账号列表（同时补上遗留的两个布尔 badge）
5. `skills/gog/gog-slides/SKILL.md` + `skills/gog/gog-people/SKILL.md`
6. `gog-shared/SKILL.md` / `CLAUDE.md` 文档更新

**Out of Scope（明确不做）:**
- Bash 工具层对 gog 破坏性子命令的硬拦截 —— 继续信任 skill 纪律
- `gog chat / keep / forms / classroom / groups / appscript / admin` 的 skill
- `gog schema` 动态注入 agent 上下文
- `gog auth alias` 工具化
- `gog auth tokens export/import` 工具化（灾备向，小众）
- `gog auth service-account`（Workspace 域委派，企业管理员向）

**Architecture:**
- **复用**既有 per-user 隔离（`sandboxes/<uid>/credentials/`）、nsjail.cfg env 注入、`execute_in_sandbox` 运行器。本期**不改**沙箱层。
- **共享帮手**：`sandbox/gogcli.py` 新增一个纯函数 `parse_auth_list_output(stdout) -> list[dict]`，同时被 `GoogleWorkspaceAuthStatus` 工具与 `/v1/sandboxes/gogcli-accounts` 端点消费。`execute_in_sandbox` 的调用放在调用方，避免 sandbox 模块依赖 executor（保持可单测）。
- **AuthStatus 默认不 `--check`**：`--check` 会为每个账号去 exchange 一次 access token（网络调用、耗时、吃配额），默认只列已绑条目；显式 `check=True` 才去验活。
- **Logout 仍走 skill 纪律**：工具本身 `risk_level=SAFE`，不强制 AskUser；但在 `gog-shared` skill 的"破坏性操作清单"里加一行 `Logout`，由 agent 自己调 AskUser。

**Tech Stack:**
- Python 3.13 + uv + ruff + pytest（后端）
- Next.js 16 + React 19 + bun + Prettier（前端）
- `gog` v0.13.0

---

## File Structure

**新建:**
- `src/ripple/tools/builtin/gogcli_auth_status.py` —— `GoogleWorkspaceAuthStatus` 工具
- `src/ripple/tools/builtin/gogcli_logout.py` —— `GoogleWorkspaceLogout` 工具
- `tests/tools/test_gogcli_auth_status.py`
- `tests/tools/test_gogcli_logout.py`
- `tests/sandbox/test_gogcli_parse.py`（补 `parse_auth_list_output` 单测）
- `skills/gog/gog-tasks/SKILL.md`
- `skills/gog/gog-slides/SKILL.md`
- `skills/gog/gog-people/SKILL.md`

**修改:**
- `src/ripple/sandbox/gogcli.py` —— 加 `parse_auth_list_output` 纯函数
- `src/interfaces/server/sessions.py` —— 注册两个新工具
- `src/interfaces/server/schemas.py` —— 加 `GogcliAccountInfo` / `GogcliAccountsResponse`
- `src/interfaces/server/routes.py` —— 加 `GET /v1/sandboxes/gogcli-accounts`
- `src/interfaces/web/src/types/index.ts` —— 前端类型（若需要）
- `src/interfaces/web/src/components/SettingsModal.tsx` —— 补 gogcli 两个布尔 badge + 新账号列表区块
- `skills/gog/gog-shared/SKILL.md` —— 提及 `AuthStatus` / `Logout` 新工具
- `CLAUDE.md` —— "外部 CLI 依赖"段落微调

**删除:** 无

---

## Phase 1: `GoogleWorkspaceAuthStatus` 工具

### Task 1.1: `parse_auth_list_output` 纯函数 + 单测

**Files:**
- Modify: `src/ripple/sandbox/gogcli.py`
- Create: `tests/sandbox/test_gogcli_parse.py`

**动机：** 把 `gog auth list --json` 的输出解析从 I/O 抽离成纯函数，tool 和后续 endpoint 复用同一份解析逻辑；解析器要对 gog 输出格式抖动（字段名大小写、缺字段）有容忍度。

- [ ] **Step 1: 先写失败测试**

Create `tests/sandbox/test_gogcli_parse.py`:

```python
"""Tests for parsing `gog auth list --json` output."""

import json

import pytest

from ripple.sandbox.gogcli import parse_auth_list_output


def test_parse_empty_list():
    assert parse_auth_list_output('{"accounts":[]}') == []


def test_parse_single_account_without_check():
    raw = json.dumps({"accounts": [{"email": "alice@gmail.com"}]})
    got = parse_auth_list_output(raw)
    assert got == [{"email": "alice@gmail.com", "alias": None, "valid": None}]


def test_parse_with_alias_and_check():
    raw = json.dumps(
        {
            "accounts": [
                {"email": "alice@x.com", "alias": "work", "valid": True},
                {"email": "bob@y.com", "alias": None, "valid": False},
            ]
        }
    )
    got = parse_auth_list_output(raw)
    assert got == [
        {"email": "alice@x.com", "alias": "work", "valid": True},
        {"email": "bob@y.com", "alias": None, "valid": False},
    ]


def test_parse_top_level_list_variant():
    """某些 gog 版本可能直接返回一个数组，不是 {accounts:[...]} 包裹。"""
    raw = json.dumps([{"email": "a@b.com"}])
    got = parse_auth_list_output(raw)
    assert got == [{"email": "a@b.com", "alias": None, "valid": None}]


def test_parse_ignores_entries_without_email():
    raw = json.dumps({"accounts": [{"foo": "bar"}, {"email": "ok@x.com"}]})
    got = parse_auth_list_output(raw)
    assert got == [{"email": "ok@x.com", "alias": None, "valid": None}]


def test_parse_invalid_json_raises():
    with pytest.raises(ValueError):
        parse_auth_list_output("not-json")


def test_parse_bool_coercion():
    """valid 字段可能是 'true'/'false' 字符串（gog 版本差异兜底）。"""
    raw = json.dumps({"accounts": [{"email": "a@b.com", "valid": "true"}]})
    got = parse_auth_list_output(raw)
    assert got[0]["valid"] is True
```

- [ ] **Step 2: 跑测试确认失败**

```bash
source .venv/bin/activate
pytest tests/sandbox/test_gogcli_parse.py -v
```

Expected: `ImportError: cannot import name 'parse_auth_list_output'`。

- [ ] **Step 3: 在 `src/ripple/sandbox/gogcli.py` 末尾追加实现**

```python
def parse_auth_list_output(stdout: str) -> list[dict]:
    """把 `gog auth list --json` 的输出解析成 [{email, alias, valid}] 列表。

    对格式抖动宽容：
      * 顶层可能是 `{"accounts": [...]}` 或裸数组 `[...]`
      * 每个 entry 可能缺 `alias` / `valid`，补 None
      * `valid` 可能是 bool 或 "true"/"false" 字符串

    缺 `email` 字段的 entry 会被静默丢弃（那是 gog 内部状态项，非账号）。

    Raises:
        ValueError: stdout 不是合法 JSON。调用方自己决定是报错还是降级。
    """
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError as e:
        raise ValueError(f"gog auth list 输出不是合法 JSON: {e.msg}") from e

    if isinstance(data, dict):
        raw_list = data.get("accounts", [])
    elif isinstance(data, list):
        raw_list = data
    else:
        return []

    out: list[dict] = []
    for entry in raw_list:
        if not isinstance(entry, dict):
            continue
        email = entry.get("email")
        if not isinstance(email, str) or not email.strip():
            continue

        alias = entry.get("alias")
        if alias is not None and not isinstance(alias, str):
            alias = None

        valid_raw = entry.get("valid")
        valid: bool | None
        if isinstance(valid_raw, bool):
            valid = valid_raw
        elif isinstance(valid_raw, str):
            low = valid_raw.strip().lower()
            if low == "true":
                valid = True
            elif low == "false":
                valid = False
            else:
                valid = None
        else:
            valid = None

        out.append({"email": email.strip(), "alias": alias, "valid": valid})
    return out
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pytest tests/sandbox/test_gogcli_parse.py -v
```

Expected: 7 passed。

- [ ] **Step 5: Lint**

```bash
ruff format src/ripple/sandbox/gogcli.py tests/sandbox/test_gogcli_parse.py
ruff check src/ripple/sandbox/gogcli.py tests/sandbox/test_gogcli_parse.py
```

- [ ] **Step 6: Commit**

```bash
git add src/ripple/sandbox/gogcli.py tests/sandbox/test_gogcli_parse.py
git commit -m "feat(sandbox): add parse_auth_list_output helper for gogcli auth status"
```

---

### Task 1.2: `GoogleWorkspaceAuthStatus` 工具

**Files:**
- Create: `src/ripple/tools/builtin/gogcli_auth_status.py`
- Create: `tests/tools/test_gogcli_auth_status.py`

**接口约定：**

入参：
- `check` (bool, optional, default=False) —— `true` 时在沙箱里跑 `gog auth list --json --check`，每个账号会去 exchange 一次 access token 验活（网络调用、可能慢）；默认只列已绑条目不验活。

出参（`ToolResult.data`）：
```python
{
    "ok": True,
    "has_client_config": bool,      # 从 sandbox_config.has_gogcli_client_config 读
    "accounts": [
        {"email": str, "alias": str | None, "valid": bool | None},
        ...
    ],
    "count": int,
    "checked": bool,                # 用户传的 check 原值
}
```

失败时 `{"ok": False, "error": "..."}`。

- [ ] **Step 1: 写失败测试**

Create `tests/tools/test_gogcli_auth_status.py`:

```python
"""Tests for GoogleWorkspaceAuthStatus tool."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from ripple.core.context import ToolUseContext
from ripple.tools.builtin.gogcli_auth_status import GoogleWorkspaceAuthStatusTool


def _ctx(user_id: str = "alice") -> ToolUseContext:
    ctx = MagicMock(spec=ToolUseContext)
    ctx.user_id = user_id
    return ctx


@pytest.mark.asyncio
async def test_returns_error_when_sandbox_disabled():
    tool = GoogleWorkspaceAuthStatusTool()
    with patch("ripple.tools.builtin.gogcli_auth_status._sandbox_config", None):
        res = await tool.call({}, _ctx(), None)
    assert res.data["ok"] is False
    assert "Sandbox" in res.data["error"]


@pytest.mark.asyncio
async def test_returns_error_when_no_user_id():
    tool = GoogleWorkspaceAuthStatusTool()
    mock_cfg = MagicMock()
    with patch("ripple.tools.builtin.gogcli_auth_status._sandbox_config", mock_cfg):
        res = await tool.call({}, _ctx(user_id=""), None)
    assert res.data["ok"] is False
    assert "user_id" in res.data["error"]


@pytest.mark.asyncio
async def test_returns_empty_list_when_no_accounts_bound():
    tool = GoogleWorkspaceAuthStatusTool()
    mock_cfg = MagicMock()
    mock_cfg.gogcli_cli_install_root = "/vendor/gogcli-cli"
    mock_cfg.has_gogcli_client_config.return_value = True

    with (
        patch("ripple.tools.builtin.gogcli_auth_status._sandbox_config", mock_cfg),
        patch(
            "ripple.tools.builtin.gogcli_auth_status.execute_in_sandbox",
            new=AsyncMock(return_value=('{"accounts":[]}', "", 0)),
        ),
    ):
        res = await tool.call({}, _ctx(), None)

    assert res.data["ok"] is True
    assert res.data["accounts"] == []
    assert res.data["count"] == 0
    assert res.data["has_client_config"] is True
    assert res.data["checked"] is False


@pytest.mark.asyncio
async def test_returns_accounts_when_bound():
    tool = GoogleWorkspaceAuthStatusTool()
    mock_cfg = MagicMock()
    mock_cfg.gogcli_cli_install_root = "/vendor/gogcli-cli"
    mock_cfg.has_gogcli_client_config.return_value = True

    stdout = (
        '{"accounts":['
        '{"email":"a@x.com","alias":"work","valid":true},'
        '{"email":"b@y.com","alias":null,"valid":false}'
        "]}"
    )
    with (
        patch("ripple.tools.builtin.gogcli_auth_status._sandbox_config", mock_cfg),
        patch(
            "ripple.tools.builtin.gogcli_auth_status.execute_in_sandbox",
            new=AsyncMock(return_value=(stdout, "", 0)),
        ),
    ):
        res = await tool.call({"check": True}, _ctx(), None)

    assert res.data["ok"] is True
    assert res.data["count"] == 2
    assert res.data["accounts"][0]["email"] == "a@x.com"
    assert res.data["accounts"][0]["valid"] is True
    assert res.data["accounts"][1]["valid"] is False
    assert res.data["checked"] is True


@pytest.mark.asyncio
async def test_passes_check_flag_to_gog():
    tool = GoogleWorkspaceAuthStatusTool()
    mock_cfg = MagicMock()
    mock_cfg.gogcli_cli_install_root = "/vendor/gogcli-cli"
    mock_cfg.has_gogcli_client_config.return_value = True

    captured: dict = {}

    async def fake_exec(cmd, *a, **kw):
        captured["cmd"] = cmd
        return ('{"accounts":[]}', "", 0)

    with (
        patch("ripple.tools.builtin.gogcli_auth_status._sandbox_config", mock_cfg),
        patch(
            "ripple.tools.builtin.gogcli_auth_status.execute_in_sandbox", new=fake_exec
        ),
    ):
        await tool.call({"check": True}, _ctx(), None)
    assert "--check" in captured["cmd"]

    captured.clear()
    with (
        patch("ripple.tools.builtin.gogcli_auth_status._sandbox_config", mock_cfg),
        patch(
            "ripple.tools.builtin.gogcli_auth_status.execute_in_sandbox", new=fake_exec
        ),
    ):
        await tool.call({}, _ctx(), None)
    assert "--check" not in captured["cmd"]


@pytest.mark.asyncio
async def test_returns_error_when_gog_fails():
    tool = GoogleWorkspaceAuthStatusTool()
    mock_cfg = MagicMock()
    mock_cfg.gogcli_cli_install_root = "/vendor/gogcli-cli"
    mock_cfg.has_gogcli_client_config.return_value = True

    with (
        patch("ripple.tools.builtin.gogcli_auth_status._sandbox_config", mock_cfg),
        patch(
            "ripple.tools.builtin.gogcli_auth_status.execute_in_sandbox",
            new=AsyncMock(return_value=("", "keyring locked", 1)),
        ),
    ):
        res = await tool.call({}, _ctx(), None)
    assert res.data["ok"] is False
    assert "keyring locked" in res.data["error"]


@pytest.mark.asyncio
async def test_reports_no_client_config_warning():
    tool = GoogleWorkspaceAuthStatusTool()
    mock_cfg = MagicMock()
    mock_cfg.gogcli_cli_install_root = "/vendor/gogcli-cli"
    mock_cfg.has_gogcli_client_config.return_value = False

    with (
        patch("ripple.tools.builtin.gogcli_auth_status._sandbox_config", mock_cfg),
        patch(
            "ripple.tools.builtin.gogcli_auth_status.execute_in_sandbox",
            new=AsyncMock(return_value=('{"accounts":[]}', "", 0)),
        ),
    ):
        res = await tool.call({}, _ctx(), None)
    assert res.data["ok"] is True
    assert res.data["has_client_config"] is False
```

确保测试依赖的 `pytest-asyncio` 已在 `pyproject.toml` 或 `tests/conftest.py` 设置 —— 参考现有 tests 目录其他异步 tool 的测试写法（如 `tests/tools/test_gogcli_login_start.py` 若已存在的风格）。如果项目里没有现成的 async tool 测试示例，先检查 conftest 配置。

- [ ] **Step 2: 跑测试确认失败**

```bash
pytest tests/tools/test_gogcli_auth_status.py -v
```

Expected: `ModuleNotFoundError: ripple.tools.builtin.gogcli_auth_status`。

- [ ] **Step 3: 写实现**

Create `src/ripple/tools/builtin/gogcli_auth_status.py`:

```python
"""GoogleWorkspaceAuthStatus — 列出当前 user 已绑的 Google 账号 + 可选验活

典型调用场景：
  * agent 开局不确定当前 user 绑了哪个 Google 账号，先调一次本工具再决定 --account=
  * 业务命令报 `invalid_grant` / `unauthorized_client` 之类可疑 token 问题时，
    调 `check=True` 真验一下，确认是 refresh_token 失效再引导用户重走 LoginStart
  * 前端通过 `GET /v1/sandboxes/gogcli-accounts` 展示账号列表（共享同一 helper）

默认 `check=False`——只列本地 keyring 里已绑条目，不打 Google 的 token endpoint；
`check=True` 会为每个账号调一次 refresh token exchange（有网络成本和 quota 消耗），
仅在确需验活时用。

风险等级：SAFE（只读 + 最多一次 token refresh）。
"""

from typing import Any

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.permissions.levels import ToolRiskLevel
from ripple.sandbox.config import GOGCLI_CLI_SANDBOX_BIN
from ripple.sandbox.executor import execute_in_sandbox
from ripple.sandbox.gogcli import parse_auth_list_output
from ripple.tools.base import Tool, ToolResult
from ripple.utils.logger import get_logger

logger = get_logger("tools.gogcli_auth_status")

# 懒引用 BashTool 里的共享 SandboxConfig（保持与其他 gogcli 工具一致的风格）。
from ripple.tools.builtin.bash import _sandbox_config  # noqa: E402


class GoogleWorkspaceAuthStatusTool(Tool):
    """列出当前 user 在 gogcli 里已绑的 Google 账号"""

    def __init__(self):
        self.name = "GoogleWorkspaceAuthStatus"
        self.description = (
            "List Google Workspace accounts bound to the current user in gogcli's keyring. "
            "Use this at the start of a session when you're not sure which account to target, "
            "or when an earlier gog command returned `invalid_grant`/`unauthorized_client` "
            "to confirm whether the refresh token is still valid.\n\n"
            "Parameters:\n"
            "- check (bool, optional, default=False): When true, verifies each account by "
            "  exchanging its refresh token for an access token. This costs one network "
            "  roundtrip and a tiny bit of quota per account. Default false just lists "
            "  what's stored locally.\n\n"
            "Returns:\n"
            "  {\n"
            "    ok: true,\n"
            "    has_client_config: bool,  // whether GoogleWorkspaceClientConfigSet was called\n"
            "    accounts: [{email, alias, valid}],  // valid only meaningful when check=true\n"
            "    count: int,\n"
            "    checked: bool,  // echoes the check input\n"
            "  }\n\n"
            "If `has_client_config=false`, the user hasn't bound a Desktop OAuth client yet — "
            "guide them through `GoogleWorkspaceClientConfigSet`. If `accounts=[]` but "
            "`has_client_config=true`, they need to call `GoogleWorkspaceLoginStart` for the "
            "account they want.\n"
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
                        "check": {
                            "type": "boolean",
                            "description": (
                                "If true, verify each refresh token by exchanging it for an "
                                "access token. Costs one network roundtrip per account. Default false."
                            ),
                            "default": False,
                        }
                    },
                },
            },
        }

    async def call(
        self,
        args: dict[str, Any],
        context: ToolUseContext,
        parent_message: AssistantMessage | None,
    ) -> ToolResult[dict]:
        if _sandbox_config is None:
            return ToolResult(data={"ok": False, "error": "Sandbox 未启用"})

        user_id = context.user_id
        if not user_id:
            return ToolResult(data={"ok": False, "error": "当前上下文没有 user_id"})

        if not _sandbox_config.gogcli_cli_install_root:
            return ToolResult(
                data={"ok": False, "error": "gogcli 未预装。请联系管理员执行: bash scripts/install-gogcli-cli.sh"}
            )

        check = bool(args.get("check", False))
        cmd = f"{GOGCLI_CLI_SANDBOX_BIN} auth list --json"
        if check:
            cmd += " --check"

        stdout, stderr, code = await execute_in_sandbox(
            cmd, _sandbox_config, user_id, timeout=30 if check else 10
        )

        if code != 0:
            logger.warning("user {} gog auth list 失败 (code={}): {}", user_id, code, stderr[:500])
            return ToolResult(
                data={
                    "ok": False,
                    "error": f"gog auth list 失败 (exit {code}): {stderr[-500:] or stdout[-500:]}",
                }
            )

        try:
            accounts = parse_auth_list_output(stdout)
        except ValueError as e:
            return ToolResult(
                data={
                    "ok": False,
                    "error": f"无法解析 gog auth list 输出: {e}。stdout 片段: {stdout[:200]}",
                }
            )

        return ToolResult(
            data={
                "ok": True,
                "has_client_config": _sandbox_config.has_gogcli_client_config(user_id),
                "accounts": accounts,
                "count": len(accounts),
                "checked": check,
            }
        )

    def is_concurrency_safe(self, input: dict[str, Any]) -> bool:
        return True
```

**注意**：顶层的 `from ripple.tools.builtin.bash import _sandbox_config` 会在 import 时绑定到那一刻的值；但其他 gogcli 工具（`gogcli_login_start.py`）是在 `call()` 里再 `from ... import _sandbox_config`。**用 `call` 里局部 import 的那种模式**（参考 `gogcli_login_start.py` 的写法），不要顶层 import，否则测试里 patch 不到。把上面的顶层 import 删掉，`call` 里改成：

```python
from ripple.tools.builtin.bash import _sandbox_config  # noqa: PLC0415
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pytest tests/tools/test_gogcli_auth_status.py -v
```

Expected: 7 passed。若 patch 路径不对，调整成 `ripple.tools.builtin.bash._sandbox_config`（和其他测试一致）。

- [ ] **Step 5: Lint**

```bash
ruff format src/ripple/tools/builtin/gogcli_auth_status.py tests/tools/test_gogcli_auth_status.py
ruff check src/ripple/tools/builtin/gogcli_auth_status.py tests/tools/test_gogcli_auth_status.py
```

- [ ] **Step 6: Commit**

```bash
git add src/ripple/tools/builtin/gogcli_auth_status.py tests/tools/test_gogcli_auth_status.py
git commit -m "feat(tools): add GoogleWorkspaceAuthStatus for listing bound accounts"
```

---

### Task 1.3: 在 `sessions.py` 注册

**Files:**
- Modify: `src/interfaces/server/sessions.py`

- [ ] **Step 1: 加 import 和实例化**

在 import 段（和其他 `gogcli_*` import 一组，约 24-26 行附近）加：

```python
from ripple.tools.builtin.gogcli_auth_status import GoogleWorkspaceAuthStatusTool
```

在 `_get_server_tools()`（约 241 行，`GoogleWorkspaceLoginCompleteTool()` 之后）追加：

```python
        GoogleWorkspaceLoginCompleteTool(),
        GoogleWorkspaceAuthStatusTool(),
```

- [ ] **Step 2: 启动一次 server 冒烟**

```bash
source .venv/bin/activate
uv run ripple --reload &
sleep 3
curl -s http://localhost:<port>/v1/system/info | jq '.tools' | grep -i GoogleWorkspaceAuthStatus
# 应能看到这个工具名
kill %1
```

- [ ] **Step 3: Lint + commit**

```bash
ruff format src/interfaces/server/sessions.py
ruff check src/interfaces/server/sessions.py
git add src/interfaces/server/sessions.py
git commit -m "feat(server): register GoogleWorkspaceAuthStatus tool"
```

---

## Phase 2: `GoogleWorkspaceLogout` 工具

### Task 2.1: 实现 + 测试

**Files:**
- Create: `src/ripple/tools/builtin/gogcli_logout.py`
- Create: `tests/tools/test_gogcli_logout.py`

**接口约定：**

入参：
- `email` (str, required) —— 要解绑的 Google 邮箱，必须含 `@`。

出参：
- 成功：`{ok: True, email, remaining_accounts: int}`
- 失败：`{ok: False, error: str}`

**行为：**
1. 参数校验（email 含 `@`、非空）
2. 沙箱里跑 `gog auth remove <email> --force`（加 `--force` 跳过 CLI 的交互确认；AskUser 由 skill 层上游负责）
3. 跑一次 `gog auth list --json` 汇报剩余账号数（便于 agent 给用户确认"还剩 X 个账号绑着"）
4. 不动 `gogcli-client.json`（client config 是跨账号共享的，不随 logout 清）

**注意**：因为选了 (a) 纯 skill 纪律，工具本身 `risk_level=SAFE`，不强制 AskUser。但 `gog-shared/SKILL.md` 里要把 Logout 列入"操作前必须 AskUser"清单。

- [ ] **Step 1: 写失败测试**

Create `tests/tools/test_gogcli_logout.py`:

```python
"""Tests for GoogleWorkspaceLogout tool."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from ripple.core.context import ToolUseContext
from ripple.tools.builtin.gogcli_logout import GoogleWorkspaceLogoutTool


def _ctx(user_id: str = "alice") -> ToolUseContext:
    ctx = MagicMock(spec=ToolUseContext)
    ctx.user_id = user_id
    return ctx


@pytest.mark.asyncio
async def test_rejects_missing_email():
    tool = GoogleWorkspaceLogoutTool()
    mock_cfg = MagicMock()
    mock_cfg.gogcli_cli_install_root = "/vendor/gogcli-cli"
    with patch("ripple.tools.builtin.bash._sandbox_config", mock_cfg):
        res = await tool.call({"email": ""}, _ctx(), None)
    assert res.data["ok"] is False
    assert "email" in res.data["error"]


@pytest.mark.asyncio
async def test_rejects_invalid_email():
    tool = GoogleWorkspaceLogoutTool()
    mock_cfg = MagicMock()
    mock_cfg.gogcli_cli_install_root = "/vendor/gogcli-cli"
    with patch("ripple.tools.builtin.bash._sandbox_config", mock_cfg):
        res = await tool.call({"email": "not-an-email"}, _ctx(), None)
    assert res.data["ok"] is False


@pytest.mark.asyncio
async def test_success_path():
    tool = GoogleWorkspaceLogoutTool()
    mock_cfg = MagicMock()
    mock_cfg.gogcli_cli_install_root = "/vendor/gogcli-cli"

    call_count = {"n": 0}

    async def fake_exec(cmd, *a, **kw):
        call_count["n"] += 1
        if "auth remove" in cmd:
            assert "'alice@gmail.com'" in cmd
            assert "--force" in cmd
            return ("removed", "", 0)
        if "auth list" in cmd:
            return ('{"accounts":[{"email":"bob@x.com"}]}', "", 0)
        raise AssertionError(f"unexpected cmd: {cmd}")

    with (
        patch("ripple.tools.builtin.bash._sandbox_config", mock_cfg),
        patch("ripple.tools.builtin.gogcli_logout.execute_in_sandbox", new=fake_exec),
    ):
        res = await tool.call({"email": "alice@gmail.com"}, _ctx(), None)

    assert res.data["ok"] is True
    assert res.data["email"] == "alice@gmail.com"
    assert res.data["remaining_accounts"] == 1
    assert call_count["n"] == 2


@pytest.mark.asyncio
async def test_remove_fails_when_email_not_bound():
    tool = GoogleWorkspaceLogoutTool()
    mock_cfg = MagicMock()
    mock_cfg.gogcli_cli_install_root = "/vendor/gogcli-cli"

    with (
        patch("ripple.tools.builtin.bash._sandbox_config", mock_cfg),
        patch(
            "ripple.tools.builtin.gogcli_logout.execute_in_sandbox",
            new=AsyncMock(return_value=("", "account not found", 2)),
        ),
    ):
        res = await tool.call({"email": "nobody@x.com"}, _ctx(), None)

    assert res.data["ok"] is False
    assert "not found" in res.data["error"]


@pytest.mark.asyncio
async def test_success_even_if_list_fails_after():
    """auth remove 成功，但 auth list 验证失败时仍算整体成功（主操作已完成）。"""
    tool = GoogleWorkspaceLogoutTool()
    mock_cfg = MagicMock()
    mock_cfg.gogcli_cli_install_root = "/vendor/gogcli-cli"

    async def fake_exec(cmd, *a, **kw):
        if "auth remove" in cmd:
            return ("removed", "", 0)
        return ("", "keyring lock contention", 1)

    with (
        patch("ripple.tools.builtin.bash._sandbox_config", mock_cfg),
        patch("ripple.tools.builtin.gogcli_logout.execute_in_sandbox", new=fake_exec),
    ):
        res = await tool.call({"email": "alice@gmail.com"}, _ctx(), None)

    assert res.data["ok"] is True
    assert res.data["remaining_accounts"] is None  # 验证失败用 None 表示未知
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pytest tests/tools/test_gogcli_logout.py -v
```

- [ ] **Step 3: 写实现**

Create `src/ripple/tools/builtin/gogcli_logout.py`:

```python
"""GoogleWorkspaceLogout — 解绑当前 user 的某个 Google 账号

调用场景：
  * 用户说"解绑 alice@ 换成 bob@"
  * refresh_token 被 Google 侧 revoke（用户在 Google 账户里撤销了权限），
    本地 keyring 里的条目变成僵尸，要清一下再重走 LoginStart
  * 用户不再使用 ripple 的 gogcli 能力，想清理授权

行为：
  * 跑 `gog auth remove <email> --force`
  * 不删 Desktop OAuth client config（那是跨账号共享的）
  * 跑 `gog auth list --json` 把剩余账号数报给 agent

风险等级：SAFE（只影响本地 keyring 一个条目；Google 侧 refresh_token 仍在，
  除非用户主动 revoke；要彻底清理 agent 可引导用户去 Google 账户设置里 revoke）。
  写操作前的 AskUser 由 skill 层负责（见 gog-shared/SKILL.md 破坏性清单）。
"""

import re
from typing import Any

from ripple.core.context import ToolUseContext
from ripple.messages.types import AssistantMessage
from ripple.permissions.levels import ToolRiskLevel
from ripple.sandbox.config import GOGCLI_CLI_SANDBOX_BIN
from ripple.sandbox.executor import execute_in_sandbox
from ripple.sandbox.gogcli import parse_auth_list_output
from ripple.tools.base import Tool, ToolResult
from ripple.utils.logger import get_logger

logger = get_logger("tools.gogcli_logout")

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _shq(s: str) -> str:
    return "'" + s.replace("'", "'\\''") + "'"


class GoogleWorkspaceLogoutTool(Tool):
    """解绑当前 user 的某个 Google 账号（从本地 keyring 移除 refresh_token）"""

    def __init__(self):
        self.name = "GoogleWorkspaceLogout"
        self.description = (
            "Unbind a Google account from the current user's gogcli keyring (removes the "
            "refresh token locally; does NOT revoke on Google's side).\n\n"
            "Parameters:\n"
            "- email (required): The Google account to remove, e.g. alice@gmail.com.\n\n"
            "Before calling this tool:\n"
            "- **You MUST call AskUser first** to confirm with the user which account and why. "
            "  This is a destructive action on local state (covered in gog-shared/SKILL.md).\n"
            "- If the user wants to revoke Google-side access too, guide them to "
            "  https://myaccount.google.com/permissions — this tool does not revoke server-side.\n\n"
            "Returns:\n"
            "  {ok: true, email, remaining_accounts: int | null}\n"
            "  remaining_accounts is null if the post-op `gog auth list` failed "
            "  (the logout itself still succeeded).\n\n"
            "Does NOT touch the Desktop OAuth client config "
            "(`GoogleWorkspaceClientConfigSet`'s state); that stays bound for future accounts."
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
                            "description": "The Google account email to unbind, e.g. alice@gmail.com.",
                        }
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

        if not _sandbox_config.gogcli_cli_install_root:
            return ToolResult(
                data={"ok": False, "error": "gogcli 未预装。请联系管理员执行: bash scripts/install-gogcli-cli.sh"}
            )

        email = (args.get("email") or "").strip()
        if not email:
            return ToolResult(data={"ok": False, "error": "email 参数为空"})
        if not _EMAIL_RE.match(email):
            return ToolResult(data={"ok": False, "error": f"email 格式不合法: {email}"})

        remove_cmd = f"{GOGCLI_CLI_SANDBOX_BIN} auth remove {_shq(email)} --force"
        stdout, stderr, code = await execute_in_sandbox(
            remove_cmd, _sandbox_config, user_id, timeout=15
        )
        if code != 0:
            logger.warning("user {} gog auth remove {} 失败 (code={}): {}", user_id, email, code, stderr[:500])
            return ToolResult(
                data={
                    "ok": False,
                    "error": (
                        f"gog auth remove 失败 (exit {code}): {stderr[-500:] or stdout[-500:]}。"
                        "常见原因：1) 该 email 并未绑定；2) keyring 锁竞争；3) gog 版本不兼容。"
                    ),
                }
            )

        remaining: int | None
        list_cmd = f"{GOGCLI_CLI_SANDBOX_BIN} auth list --json"
        lout, lerr, lcode = await execute_in_sandbox(
            list_cmd, _sandbox_config, user_id, timeout=10
        )
        if lcode == 0:
            try:
                remaining = len(parse_auth_list_output(lout))
            except ValueError:
                remaining = None
        else:
            remaining = None

        logger.info("user {} 已解绑 gogcli 账号 {} (剩余 {})", user_id, email, remaining)
        return ToolResult(
            data={
                "ok": True,
                "email": email,
                "remaining_accounts": remaining,
                "next": (
                    f"账号 {email} 已从本地 keyring 移除。**Google 侧的授权本身并未撤销**——"
                    "如用户想彻底清理，引导他去 https://myaccount.google.com/permissions 手动 revoke。"
                ),
            }
        )

    def is_concurrency_safe(self, input: dict[str, Any]) -> bool:
        return False
```

- [ ] **Step 4: 跑测试 + lint**

```bash
pytest tests/tools/test_gogcli_logout.py -v
ruff format src/ripple/tools/builtin/gogcli_logout.py tests/tools/test_gogcli_logout.py
ruff check src/ripple/tools/builtin/gogcli_logout.py tests/tools/test_gogcli_logout.py
```

- [ ] **Step 5: Commit**

```bash
git add src/ripple/tools/builtin/gogcli_logout.py tests/tools/test_gogcli_logout.py
git commit -m "feat(tools): add GoogleWorkspaceLogout for unbinding Google accounts"
```

---

### Task 2.2: 在 `sessions.py` 注册

- [ ] **Step 1: 加 import 和实例化**

```python
from ripple.tools.builtin.gogcli_logout import GoogleWorkspaceLogoutTool
```

在 `_get_server_tools()` 的 `GoogleWorkspaceAuthStatusTool()` 之后追加 `GoogleWorkspaceLogoutTool()`。

- [ ] **Step 2: Lint + commit**

```bash
ruff format src/interfaces/server/sessions.py
ruff check src/interfaces/server/sessions.py
git add src/interfaces/server/sessions.py
git commit -m "feat(server): register GoogleWorkspaceLogout tool"
```

---

## Phase 3: 前端已绑账号列表

补齐之前 Phase 5 Optional 没做的两个 boolean badge，同时新增账号列表区块。

### Task 3.1: 新增 `GET /v1/sandboxes/gogcli-accounts` 端点

**Files:**
- Modify: `src/interfaces/server/schemas.py`
- Modify: `src/interfaces/server/routes.py`

**端点设计：**
- `GET /v1/sandboxes/gogcli-accounts?check=false`
- 要求 `X-Ripple-User-Id`（和其他 `/v1/sandboxes/*` 一致，走 `get_user_id`）
- 返回 `GogcliAccountsResponse`：
  ```python
  {
      "has_client_config": bool,
      "accounts": [{"email": "...", "alias": null, "valid": null}, ...],
      "count": int,
      "checked": bool
  }
  ```
- 沙箱未启用或没装 gogcli 时：返回 `{has_client_config: false, accounts: [], count: 0, checked: false}`（不用 500）

- [ ] **Step 1: `schemas.py` 加两个模型**

在 `SandboxListResponse` 后追加：

```python
class GogcliAccountInfo(BaseModel):
    email: str
    alias: str | None = None
    valid: bool | None = None


class GogcliAccountsResponse(BaseModel):
    has_client_config: bool = False
    accounts: list[GogcliAccountInfo] = []
    count: int = 0
    checked: bool = False
```

- [ ] **Step 2: `routes.py` 加端点**

在 `DELETE /v1/sandboxes` 之后（大约 654 行后）加：

```python
@router.get("/v1/sandboxes/gogcli-accounts")
async def get_gogcli_accounts(
    check: bool = False,
    user_id: str = Depends(get_user_id),
    _api_key: str = Depends(verify_api_key),
) -> GogcliAccountsResponse:
    """列出当前 user 已绑的 Google 账号（共享 GoogleWorkspaceAuthStatus 工具的解析逻辑）。"""
    from ripple.sandbox.config import GOGCLI_CLI_SANDBOX_BIN
    from ripple.sandbox.executor import execute_in_sandbox
    from ripple.sandbox.gogcli import parse_auth_list_output
    from ripple.tools.builtin.bash import _sandbox_config

    if _sandbox_config is None or not _sandbox_config.gogcli_cli_install_root:
        return GogcliAccountsResponse()

    has_client = _sandbox_config.has_gogcli_client_config(user_id)
    cmd = f"{GOGCLI_CLI_SANDBOX_BIN} auth list --json"
    if check:
        cmd += " --check"

    stdout, _stderr, code = await execute_in_sandbox(
        cmd, _sandbox_config, user_id, timeout=30 if check else 10
    )
    if code != 0:
        return GogcliAccountsResponse(has_client_config=has_client, checked=check)

    try:
        raw = parse_auth_list_output(stdout)
    except ValueError:
        return GogcliAccountsResponse(has_client_config=has_client, checked=check)

    accounts = [GogcliAccountInfo(**a) for a in raw]
    return GogcliAccountsResponse(
        has_client_config=has_client,
        accounts=accounts,
        count=len(accounts),
        checked=check,
    )
```

别忘了在 `routes.py` 顶部的 schemas import 里加 `GogcliAccountInfo, GogcliAccountsResponse`。

- [ ] **Step 3: 冒烟测**

```bash
source .venv/bin/activate
uv run ripple --reload &
sleep 3
curl -s -H 'X-Ripple-User-Id: default' -H 'Authorization: Bearer <key>' \
    http://localhost:<port>/v1/sandboxes/gogcli-accounts
# 预期: {"has_client_config":false,"accounts":[],"count":0,"checked":false}
# （如果没绑过）
kill %1
```

- [ ] **Step 4: Lint + commit**

```bash
ruff format src/interfaces/server/schemas.py src/interfaces/server/routes.py
ruff check src/interfaces/server/schemas.py src/interfaces/server/routes.py
git add src/interfaces/server/schemas.py src/interfaces/server/routes.py
git commit -m "feat(server): add GET /v1/sandboxes/gogcli-accounts endpoint"
```

---

### Task 3.2: 前端类型 + 调用 + 渲染

**Files:**
- Modify: `src/interfaces/web/src/types/index.ts`
- Modify: `src/interfaces/web/src/components/SettingsModal.tsx`

- [ ] **Step 1: 加 TypeScript 类型**

在 `types/index.ts` 里相应位置（和 `SandboxInfo` 同段）加：

```typescript
export interface GogcliAccountInfo {
  email: string;
  alias: string | null;
  valid: boolean | null;
}

export interface GogcliAccountsResponse {
  has_client_config: boolean;
  accounts: GogcliAccountInfo[];
  count: number;
  checked: boolean;
}
```

同时检查 `SandboxInfo` interface 是否已经带 `has_gogcli_client_config` / `has_gogcli_login`，没有就加上（后端 `schemas.py` 已经有，是前端 type 漂了）。

- [ ] **Step 2: `SettingsModal.tsx` 补两个已有 boolean badge**

找到 `<ReadyBadge label="notion token" ready={sandbox.has_notion_token} />` 那行（约 366 行），在后面追加：

```tsx
<ReadyBadge label="gog client" ready={sandbox.has_gogcli_client_config} />
<ReadyBadge label="gog login" ready={sandbox.has_gogcli_login} />
```

- [ ] **Step 3: 在同一个 Sandbox 状态块下新增账号列表区块**

当 `sandbox.has_gogcli_client_config === true` 时，fetch `/v1/sandboxes/gogcli-accounts` 展示：

```tsx
const [gogAccounts, setGogAccounts] = useState<GogcliAccountsResponse | null>(null);

useEffect(() => {
  if (!sandbox?.has_gogcli_client_config) {
    setGogAccounts(null);
    return;
  }
  let cancelled = false;
  (async () => {
    try {
      const r = await fetch("/v1/sandboxes/gogcli-accounts", {
        headers: { "X-Ripple-User-Id": userId, Authorization: `Bearer ${apiKey}` },
      });
      if (!r.ok) return;
      const data: GogcliAccountsResponse = await r.json();
      if (!cancelled) setGogAccounts(data);
    } catch {
      // 静默 —— 账号列表拿不到不影响其他 badge
    }
  })();
  return () => {
    cancelled = true;
  };
}, [sandbox?.has_gogcli_client_config, userId, apiKey]);
```

渲染（放在 badges 下面）：

```tsx
{gogAccounts && gogAccounts.accounts.length > 0 && (
  <div className="mt-2">
    <p className="text-xs text-[#888888] mb-1">Google 已绑账号</p>
    <ul className="space-y-1">
      {gogAccounts.accounts.map((a) => (
        <li
          key={a.email}
          className="text-xs font-[family-name:var(--font-mono)] text-[#ededed]"
        >
          {a.email}
          {a.alias && <span className="ml-2 text-[#888]">({a.alias})</span>}
        </li>
      ))}
    </ul>
  </div>
)}
```

注意：具体的 `userId` / `apiKey` 来源、fetch 包装器（项目可能有统一的 `apiClient.ts` / `fetchApi` helper）请**对照现有对 `/v1/sandboxes` 的调用方式写**，不要自己发明。现在的 fetch 只是示意。

- [ ] **Step 4: 前端 lint + format**

```bash
cd src/interfaces/web
bun run lint
bun run format
bun run lint:fix  # 如有 autofix
```

- [ ] **Step 5: Commit**

```bash
git add src/interfaces/web/
git commit -m "feat(web): show gogcli client/login badges and bound accounts in settings"
```

---

## Phase 4: Skills（Tasks / Slides / People）

三个 skill 都走 `gog-shared` 已确立的模板：frontmatter + 只读章节 + 写操作章节（标 ⚠️ 必须先 AskUser）+ 典型场景 + 注意。

### Task 4.1: `gog-tasks/SKILL.md`

- [ ] **Step 1: 写 skill**

`gog tasks --help` / `gog tasks list --help` / `gog tasks add --help` 先跑一次校准命令面，然后 create `skills/gog/gog-tasks/SKILL.md`：

```markdown
---
name: gog-tasks
version: 1.0.0
description: "用 gog 读/写 Google Tasks（个人待办）。**先读 gog-shared**。对 add/update/done/delete/clear **必须先 AskUser 确认**。典型：今日 / 本周待办、从邮件/日程批量导入 task、完成/归档。"
metadata:
  requires:
    bins: ["gog"]
---

# gog-tasks

> **PREREQUISITE:** 先读 `gog-shared/SKILL.md`（鉴权 + 写操作 AskUser 纪律）。

## 只读（无需确认）

```bash
# 列所有 task list
gog --account <email> --json tasks lists

# 列 default list 下的 tasks
gog --account <email> --json tasks list

# 列指定 list
gog --account <email> --json tasks list --list <listId> --max 50

# 只看未完成
gog --account <email> --json tasks list --show-completed=false

# 单个 task 详情
gog --account <email> --json tasks get <listId> <taskId>
```

## 写操作（⚠️ 必须先 AskUser）

```bash
# 新建 task
gog --account <email> tasks add "Write Q2 report" --list <listId> --due 2026-05-01
gog --account <email> tasks add "Call Alice" --notes "re: project kickoff" --due 2026-04-25

# 更新
gog --account <email> tasks update <listId> <taskId> --title "new title" --due 2026-05-02

# 完成
gog --account <email> tasks done <listId> <taskId>  # ⚠️ 建议 AskUser

# 撤销完成
gog --account <email> tasks undo <listId> <taskId>  # ⚠️

# 删除
gog --account <email> tasks delete <listId> <taskId>  # ⚠️

# 清空某 list 的已完成项
gog --account <email> tasks clear <listId>  # ⚠️⚠️

# 新建 list
gog --account <email> tasks lists create "Work"
```

## 典型场景

**场景：把近 7 天 inbox 里的 action item 全部扔进 Tasks**
1. `gog gmail search 'in:inbox newer_than:7d "action required"'` → 拿 thread 列表
2. 给用户看列表（subject + from）
3. AskUser 批确认要创建 N 条 task
4. 循环 `tasks add "..." --notes "<mail link>"` —— 每次对新 task 一条，整批跑前先把完整计划列给用户过目

**场景：今日 todo**
```bash
gog --account <email> --json tasks list --show-completed=false \
  | jq '.tasks[] | select(.due < "tomorrow")'
```

## 注意

- Google Tasks 原生支持 subtask（parent/child）但 CLI 的支持度看 `gog tasks add --help` 的 `--parent` 参数。
- `--due` 用 `YYYY-MM-DD`（Google Tasks 不支持小时级 due），相对时间先用 `gog time now` 对齐。
- Tasks list 数量通常很少（< 10），不用操心分页。
```

- [ ] **Step 2: Commit**

```bash
git add skills/gog/gog-tasks/
git commit -m "docs(skills): add gog-tasks skill"
```

---

### Task 4.2: `gog-slides/SKILL.md`

- [ ] **Step 1: 写 skill**

先 `gog slides --help` 校准，然后 create `skills/gog/gog-slides/SKILL.md`：

```markdown
---
name: gog-slides
version: 1.0.0
description: "用 gog 读/创建/改 Google Slides。**先读 gog-shared**。create/update/delete/find-replace/batch-update **必须先 AskUser 确认 + 优先 --dry-run**。典型：从 markdown 生成演示文稿骨架、按 template 替换占位符、导出 PDF。"
metadata:
  requires:
    bins: ["gog"]
---

# gog-slides

> **PREREQUISITE:** 先读 `gog-shared/SKILL.md`。

## 只读

```bash
# 元数据（slides 列表、speaker notes 快览）
gog --account <email> --json slides info <presentationId>

# 某张 slide
gog --account <email> --json slides slide <presentationId> <slideId>

# 导出
gog --account <email> slides export <presentationId> --format pdf --out ./deck.pdf
gog --account <email> slides export <presentationId> --format pptx --out ./deck.pptx
```

## 写操作（⚠️ 必须先 AskUser）

```bash
# 新建 presentation
gog --account <email> slides create "Q2 Review"

# 复制 template
gog --account <email> slides copy <templateId> "Q2 Review from template"

# Find/Replace（整份文稿替换，先 --dry-run）
gog --account <email> slides find-replace <presentationId> "{{quarter}}" "Q2 2026"
gog --account <email> slides find-replace <presentationId> "{{quarter}}" "Q2 2026" --dry-run

# 批量修改（gog 透传 Slides API 的 batchUpdate request list）
gog --account <email> slides batch-update <presentationId> --file ./requests.json  # ⚠️⚠️

# 删除 slide
gog --account <email> slides delete-slide <presentationId> <slideId>  # ⚠️
```

## 典型场景

**场景：从 template 批量生成演示文稿**
1. `slides info <templateId>` → 看 template 里有哪些占位符（如 `{{client}}`、`{{quarter}}`）
2. `slides copy <templateId> "Client ABC Q2"` → 新 presentationId
3. AskUser 把替换计划列出来：`{{client}} → ABC`, `{{quarter}} → Q2 2026`
4. `slides find-replace` 逐个替换

**场景：把 markdown 大纲变成演示文稿**（**依赖模型的 batchUpdate JSON 能力，难度高，先试 --dry-run**）
1. 让用户把大纲 paste 进来
2. 在 `/workspace/slides-requests.json` 里生成 `createSlide` + `insertText` request 数组
3. `slides batch-update --file ... --dry-run` 先 preview
4. AskUser 确认结构
5. 去掉 `--dry-run` 真跑

## 注意

- Slides API 的 batchUpdate 很强但也很容易写错；**优先 find-replace 改 template** 而不是从零 batchUpdate。
- 图片/形状坐标用 EMU（1 inch = 914400 EMU），容易算错，先 `--dry-run`。
```

- [ ] **Step 2: Commit**

```bash
git add skills/gog/gog-slides/
git commit -m "docs(skills): add gog-slides skill"
```

---

### Task 4.3: `gog-people/SKILL.md`

**说明：** `gog people` 和 `gog contacts` CLI 功能高度重叠。本 skill 以 `people` 为主（Google 官方 People API 是未来方向，Contacts API 已被标为 deprecated 但仍可用）。

- [ ] **Step 1: 写 skill**

```markdown
---
name: gog-people
version: 1.0.0
description: "用 gog 读/搜 Google 联系人（People API）。**先读 gog-shared**。对 create/update/delete **必须先 AskUser 确认**。典型：按姓名/邮箱搜联系人、按 label 批量列出、从对话导入新联系人。"
metadata:
  requires:
    bins: ["gog"]
---

# gog-people

> **PREREQUISITE:** 先读 `gog-shared/SKILL.md`。

## 只读

```bash
# 当前登录账号的 profile
gog --account <email> --json people me

# 列所有联系人（分页）
gog --account <email> --json people list --max 100

# 按姓名/邮箱搜
gog --account <email> --json people search "Alice"
gog --account <email> --json people search "alice@x.com"

# 按 label 筛选
gog --account <email> --json people list --label <labelResourceName>

# 列 labels（contact group）
gog --account <email> --json people labels
```

## 写操作（⚠️ 必须先 AskUser）

```bash
# 新建联系人
gog --account <email> people create \
  --given-name "Alice" --family-name "Smith" \
  --email alice@x.com --phone "+1 555-0101"  # ⚠️

# 更新
gog --account <email> people update <personResourceName> --phone "+1 555-0202"  # ⚠️

# 删除（整个联系人）
gog --account <email> people delete <personResourceName>  # ⚠️⚠️

# Label 管理
gog --account <email> people labels create "Vendors"
gog --account <email> people labels add-member <labelResourceName> <personResourceName>
gog --account <email> people labels remove-member ... # ⚠️
```

## 典型场景

**场景：给某个邮箱找联系人条目**
```bash
gog --account <email> --json people search "bob@x.com" \
  | jq '.people[] | {resourceName, names, emailAddresses}'
```

**场景：把本次对话里提到的 3 个新联系人批量入库**
1. 解析得到 3 组 (name, email, phone)
2. AskUser 把完整列表和每条的字段展示给用户过目
3. 逐条 `people create`，每条单独 log（便于回滚）

## 注意

- `personResourceName` 形如 `people/c12345678`，不是 email；create 后从返回里拿一次留着。
- 与 `gog contacts` 子命令**不要混用**——`people` 是 People API（新），`contacts` 是 Contacts API（老，被 deprecate）。本 skill 聚焦 people。
- Label 操作对"共享联系人列表"（Workspace 下）可能受管理员限制。
```

- [ ] **Step 2: Commit**

```bash
git add skills/gog/gog-people/
git commit -m "docs(skills): add gog-people skill"
```

---

## Phase 5: 文档

### Task 5.1: `gog-shared/SKILL.md` 更新

**Files:**
- Modify: `skills/gog/gog-shared/SKILL.md`

- [ ] **Step 1: 在"首次使用 gog 的标准流程"章节**后面、**破坏性操作清单**前面，加一个新章节 **`## 🔍 运行时检查 & 账号管理`**：

```markdown
## 🔍 运行时检查 & 账号管理

首期只做鉴权的三个工具没暴露"当前绑了谁"的视图。新增两个工具弥补：

- **`GoogleWorkspaceAuthStatus`**（只读，SAFE）
  - 用它查当前 user 绑了哪些邮箱、alias 是什么；可选 `check=true` 真跑一次 token exchange 验活。
  - 开局不知道该用哪个 `--account` 的时候先调一下。
  - 业务命令报 `invalid_grant` / `unauthorized_client` 时调 `check=true`：如果 `valid=false`，就是 refresh_token 失效，走 `GoogleWorkspaceLoginStart` 重新授权。

- **`GoogleWorkspaceLogout`**（⚠️ 破坏性）
  - 解绑某个账号（从本地 keyring 删 refresh_token）。
  - **不**撤销 Google 侧的授权；如果用户要彻底 revoke，引导去 <https://myaccount.google.com/permissions>。
  - 不动 Desktop OAuth client config（跨账号共享）。
```

然后在下面的**破坏性清单表格**里追加一行：

```markdown
| gogcli | `GoogleWorkspaceLogout`（工具）—— 解绑本地 keyring 的某账号 |
```

- [ ] **Step 2: 在"常用工作入口"表格里追加三行**

```markdown
| 列 / 改 Tasks | `gog tasks` | `list` / `add` / `done` / `delete` |
| Slides 读写 | `gog slides` | `info` / `find-replace` / `batch-update`（写⚠️） |
| Contacts / People | `gog people` | `list` / `search` / `create`（⚠️） |
```

（原表已有 tasks 一条，如有重复清理一下即可。）

- [ ] **Step 3: Commit**

```bash
git add skills/gog/gog-shared/SKILL.md
git commit -m "docs(skills): document AuthStatus/Logout tools and new service skills in gog-shared"
```

---

### Task 5.2: `CLAUDE.md` 微调

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1:** 在 `gog` 那一行下面、"相关 skill 分别在 ..." 那段之后，加一句：

```markdown
- gogcli 工具总共 5 个（按使用顺序）：`GoogleWorkspaceClientConfigSet` → `GoogleWorkspaceLoginStart` → `GoogleWorkspaceLoginComplete`（首次绑定）、`GoogleWorkspaceAuthStatus`（运行时查账号）、`GoogleWorkspaceLogout`（解绑）
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): list all five gogcli tools in external deps section"
```

---

## Phase 6: 端到端手测

### Task 6.1: AuthStatus 路径

- [ ] **Step 1:** 先在一个测试 user 上完整走一遍已有的 `ClientConfigSet` + `LoginStart` + `LoginComplete` 绑 alice@gmail.com。
- [ ] **Step 2:** 新 session 里对 agent 说"列出当前我绑的 Google 账号"，观察：
  - agent 应当调 `GoogleWorkspaceAuthStatus`（无参数）
  - 返回 `{ok: true, accounts: [{email: "alice@gmail.com", ...}], count: 1, checked: false}`
- [ ] **Step 3:** 说"验证一下这些账号还能用"，观察：
  - agent 调 `GoogleWorkspaceAuthStatus({check: true})`
  - 返回里每个账号带 `valid: true/false`
- [ ] **Step 4:** 去 Google 账户页面手动 revoke ripple 项目的授权，再说"再查一下"：
  - 期望 `valid: false`
  - agent 主动建议走 `GoogleWorkspaceLoginStart` 重绑

### Task 6.2: Logout 路径

- [ ] **Step 1:** 说"解绑 alice@gmail.com"
  - agent **必须**先调 `AskUser`（复述 email + 后果）
  - 用户点 yes 后才调 `GoogleWorkspaceLogout`
- [ ] **Step 2:** 调完后：
  - `remaining_accounts` 正确
  - 再调 `GoogleWorkspaceAuthStatus` 看 alice@ 确实没了
- [ ] **Step 3:** agent 跳过 AskUser 直接 Logout 的话 → 回去加强 `gog-shared` 的措辞。

### Task 6.3: 前端账号列表

- [ ] **Step 1:** 打开 SettingsModal
  - "gog client" / "gog login" 两个 badge 状态正确
  - 有账号时下面列出 email 列表
- [ ] **Step 2:** 调 `GoogleWorkspaceLogout` 后刷新 SettingsModal，账号列表同步更新。

### Task 6.4: Skill 覆盖

跑几条抽样：

- "列出我的 Google Tasks 今日待办" → 应当用 `gog tasks list --show-completed=false`
- "帮我看一下 Alice 的联系方式" → `gog people search "Alice"`
- "从这个 template 复制一份 Q2 Review 演示文稿，把占位符替换了" → `gog slides copy` + `slides find-replace`（批量替换前 AskUser）

---

## Self-Review

**1. Spec coverage:**
- ✅ AuthStatus 工具 + 单测 + 注册：Phase 1
- ✅ Logout 工具 + 单测 + 注册：Phase 2
- ✅ `/v1/sandboxes/gogcli-accounts` 端点：Phase 3.1
- ✅ SettingsModal 补 gog badge + 账号列表：Phase 3.2
- ✅ Tasks / Slides / People skill：Phase 4
- ✅ gog-shared 同步新工具 + 破坏性清单增 Logout：Phase 5.1
- ✅ CLAUDE.md 工具总览：Phase 5.2
- ✅ 端到端手测：Phase 6

**2. 明确不做清单已在 Out of Scope 列出：**
- chat / keep / forms / classroom / groups / appscript / admin skill
- Bash 工具破坏性子命令硬拦截
- `gog schema` / alias / tokens export/import

**3. Type/name consistency:**
- `parse_auth_list_output` 在 `sandbox/gogcli.py` 定义，被 `GoogleWorkspaceAuthStatus` 工具 + `GoogleWorkspaceLogout` 工具 + `/v1/sandboxes/gogcli-accounts` endpoint 三处共享 ✅
- `GogcliAccountInfo` / `GogcliAccountsResponse` 在 `schemas.py` 定义，routes.py 和前端类型都引用 ✅
- 工具类名 `GoogleWorkspaceAuthStatusTool` / `GoogleWorkspaceLogoutTool` 在文件里定义，在 sessions.py 注册，在 skill/文档里用无 `Tool` 后缀的工具名称 `GoogleWorkspaceAuthStatus` / `GoogleWorkspaceLogout` ✅

**4. 风险/副作用：**
- `AuthStatus(check=true)` 会对每个绑定账号触发一次 refresh token exchange。对多账号用户有可感知延迟和微量配额消耗，默认值设为 false 规避。
- `Logout` 只清本地 keyring，不撤销 Google 侧授权 —— 文档里明确告诉用户。
- 前端账号列表每次打开 SettingsModal 都会 fetch 一次；不在 has_gogcli_client_config=false 时跳过，避免沙箱未就绪时白跑。

---

## Execution Handoff

Plan 保存到 `docs/plans/2026-04-23-gogcli-expansion.md`。两种执行方式（同首期 plan）：

**1. Subagent-Driven（推荐）** —— 每个 Task 派一个 fresh subagent 跑，task 之间做 review。共 ~12 个 task，按 Phase 分批。

**2. Inline Execution** —— 当前 session 顺序跑完，重大 phase 切换时做 checkpoint（Phase 1→2→3→4→5→6）。

哪种？
