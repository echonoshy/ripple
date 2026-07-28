#!/usr/bin/env bash
set -euo pipefail

# Exercise the one-time Feishu user-authorization bundle used by Ripple.
# Authorization itself remains in the Ripple control plane; this script never
# calls `lark-cli auth login` and never reads or prints access tokens.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LARK_CLI="${RIPPLE_FEISHU_LARK_CLI:-$ROOT/vendor/lark-cli/current/bin/lark-cli}"
USER_ID="${RIPPLE_USER_ID:-default}"
RUNTIME_ROOT="${RIPPLE_RUNTIME_ROOT:-$ROOT/.ripple}"
MODE="plan"
TEST_ID="$(date -u +%Y%m%dT%H%M%SZ)"
SCENARIO="${1:-}"

REQUIRED_SCOPES=()

usage() {
  cat <<'EOF'
用法：
  RIPPLE_USER_ID=<user> \
  RIPPLE_FEISHU_TEST_CHAT_ID=<oc_...> \
  RIPPLE_FEISHU_TEST_EMAIL=<mailbox@example.com> \
  scripts/test-feishu-core-workflows.sh <im|task|mail|docs|all> [--execute]

默认是 --plan：验证当前 user token 是否已获所选场景的完整授权，并做 CLI dry-run。
--execute 会实际执行以下外部写入：向指定会话发一条消息、创建任务和任务清单、
创建并追加一篇文档、向指定邮箱发送一封邮件。所有产物均以 [Ripple auth test] 标记，
脚本不会自动删除它们，便于审计。

可选环境变量：
  RIPPLE_RUNTIME_ROOT       运行时根目录（默认 <repo>/.ripple）
  RIPPLE_FEISHU_LARK_CLI    lark-cli 二进制路径
  RIPPLE_FEISHU_TEST_USER_ID 用于私聊的 ou_...；与 CHAT_ID 二选一
EOF
}

case "$SCENARIO" in
  im)
    REQUIRED_SCOPES=(
      "contact:user:search"
      "im:message"
      "im:message.send_as_user"
      "im:chat:read"
    )
    ;;
  task)
    REQUIRED_SCOPES=(
      "contact:user.basic_profile:readonly"
      "contact:user:search"
      "task:task:write"
      "task:tasklist:write"
    )
    ;;
  mail)
    REQUIRED_SCOPES=(
      "mail:user_mailbox:readonly"
      "mail:user_mailbox.message:send"
      "mail:user_mailbox.message:modify"
    )
    ;;
  docs)
    REQUIRED_SCOPES=(
      "docx:document:create"
      "docx:document:readonly"
      "docx:document:write_only"
    )
    ;;
  all)
    REQUIRED_SCOPES=(
      "contact:user.basic_profile:readonly"
      "contact:user:search"
      "im:message"
      "im:message.send_as_user"
      "im:chat:read"
      "mail:user_mailbox:readonly"
      "mail:user_mailbox.message:send"
      "mail:user_mailbox.message:modify"
      "task:task:write"
      "task:tasklist:write"
      "docx:document:create"
      "docx:document:readonly"
      "docx:document:write_only"
    )
    ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
case "${2:-}" in
  "") ;;
  --execute) MODE="execute" ;;
  *) usage >&2; exit 2 ;;
esac

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少命令：$1" >&2
    exit 1
  fi
}

if [[ ! -x "$LARK_CLI" ]]; then
  echo "找不到可执行的 lark-cli：$LARK_CLI" >&2
  exit 1
fi
require_command uv

# Reuse the exact per-user CLI state that Ripple mounts into its sandbox. A
# caller may explicitly set these paths when the service keeps .ripple elsewhere.
if [[ -z "${LARKSUITE_CLI_CONFIG_DIR:-}" ]]; then
  CREDENTIALS_ROOT="$RUNTIME_ROOT/sandboxes/$USER_ID/credentials/lark-cli"
  export LARKSUITE_CLI_CONFIG_DIR="$CREDENTIALS_ROOT/config"
  export LARKSUITE_CLI_DATA_DIR="$CREDENTIALS_ROOT/data"
  export LARKSUITE_CLI_LOG_DIR="$CREDENTIALS_ROOT/logs"
fi

if [[ ! -f "$LARKSUITE_CLI_CONFIG_DIR/config.json" ]]; then
  echo "当前 Ripple user 尚未配置飞书应用：$USER_ID" >&2
  echo "请先通过 Ripple 对话完成一次飞书授权，再运行本脚本。" >&2
  exit 1
fi

STATUS_JSON="$("$LARK_CLI" auth status --verify)"
REQUIRED_SCOPES_CSV="$(IFS=,; echo "${REQUIRED_SCOPES[*]}")"
if ! printf '%s' "$STATUS_JSON" | REQUIRED_SCOPES_CSV="$REQUIRED_SCOPES_CSV" uv run --no-project python -c '
import json
import os
import sys

text = sys.stdin.read()
start = text.find("{")
if start < 0:
    raise SystemExit("lark-cli auth status 没有返回 JSON")
status = json.JSONDecoder().raw_decode(text[start:])[0]
scope = status.get("scope") or status.get("identities", {}).get("user", {}).get("scope", "")
granted = set(scope.split())
missing = [item for item in os.environ["REQUIRED_SCOPES_CSV"].split(",") if item not in granted]
if missing:
    print("当前 user token 缺少以下 scope：", ", ".join(missing), file=sys.stderr)
    raise SystemExit(1)
'; then
  echo "请在 Ripple 对话中发起 $SCENARIO 场景操作并完成重新授权；对应 profile 会一次申请该流程的全部所需权限。" >&2
  exit 1
fi

CHAT_ID="${RIPPLE_FEISHU_TEST_CHAT_ID:-}"
TARGET_USER_ID="${RIPPLE_FEISHU_TEST_USER_ID:-}"
MAIL_TO="${RIPPLE_FEISHU_TEST_EMAIL:-}"
if [[ "$SCENARIO" =~ ^(im|all)$ && -n "$CHAT_ID" && -n "$TARGET_USER_ID" ]]; then
  echo "RIPPLE_FEISHU_TEST_CHAT_ID 与 RIPPLE_FEISHU_TEST_USER_ID 只能设置一个。" >&2
  exit 2
fi
if [[ "$SCENARIO" =~ ^(im|all)$ && -z "$CHAT_ID" && -z "$TARGET_USER_ID" ]]; then
  echo "请设置 RIPPLE_FEISHU_TEST_CHAT_ID 或 RIPPLE_FEISHU_TEST_USER_ID。" >&2
  exit 2
fi
if [[ "$SCENARIO" =~ ^(mail|all)$ && -z "$MAIL_TO" ]]; then
  echo "请设置 RIPPLE_FEISHU_TEST_EMAIL。" >&2
  exit 2
fi

DRY_RUN=()
if [[ "$MODE" == "plan" ]]; then
  DRY_RUN=(--dry-run)
fi
MAIL_SEND=()
if [[ "$MODE" == "execute" ]]; then
  MAIL_SEND=(--confirm-send)
fi

run_step() {
  local label="$1"
  shift
  echo
  echo "==> $label"
  "$@"
}

echo "Feishu core workflow authorization is ready for Ripple user: $USER_ID"
echo "scenario: $SCENARIO; mode: $MODE; test id: $TEST_ID"

# This verifies the contact helper that resolves a named colleague in ordinary
# message/task flows without enumerating the organization.
if [[ "$SCENARIO" =~ ^(im|task|all)$ ]]; then
  run_step "搜索当前用户（联系人权限）" \
    "$LARK_CLI" contact +search-user --user-ids me --as user "${DRY_RUN[@]}"
fi

if [[ "$SCENARIO" =~ ^(task|all)$ ]]; then
  run_step "读取当前用户（任务创建依赖）" \
    "$LARK_CLI" contact +get-user --as user "${DRY_RUN[@]}"
fi

if [[ "$SCENARIO" =~ ^(im|all)$ ]]; then
  MESSAGE_TARGET=(--chat-id "$CHAT_ID")
  if [[ -n "$TARGET_USER_ID" ]]; then
    MESSAGE_TARGET=(--user-id "$TARGET_USER_ID")
  fi
  run_step "发送飞书消息" \
    "$LARK_CLI" im +messages-send "${MESSAGE_TARGET[@]}" \
    --text "[Ripple auth test][$TEST_ID] message" --as user "${DRY_RUN[@]}"
fi

if [[ "$SCENARIO" =~ ^(task|all)$ ]]; then
  run_step "创建飞书任务" \
    "$LARK_CLI" task +create \
    --summary "[Ripple auth test][$TEST_ID] task" \
    --description "Created by scripts/test-feishu-core-workflows.sh" \
    --as user "${DRY_RUN[@]}"

  run_step "创建飞书任务清单" \
    "$LARK_CLI" task +tasklist-create \
    --name "[Ripple auth test][$TEST_ID] tasklist" \
    --as user "${DRY_RUN[@]}"
fi

if [[ "$SCENARIO" =~ ^(docs|all)$ ]]; then
  DOCUMENT_TITLE="[Ripple auth test][$TEST_ID] document"
  DOCUMENT_MARKDOWN="# $DOCUMENT_TITLE\n\nCreated by Ripple authorization test."
  if [[ "$MODE" == "plan" ]]; then
    run_step "创建飞书文档" \
      "$LARK_CLI" docs +create --api-version v1 --title "$DOCUMENT_TITLE" \
      --markdown "$DOCUMENT_MARKDOWN" --as user --dry-run
    run_step "追加飞书文档内容" \
      "$LARK_CLI" docs +update --api-version v1 --doc "doxcnRIPPLEAUTHTEST" \
      --mode append --markdown "Authorization test write succeeded." --as user --dry-run
  else
    CREATE_OUTPUT="$("$LARK_CLI" docs +create --api-version v1 --title "$DOCUMENT_TITLE" \
      --markdown "$DOCUMENT_MARKDOWN" --as user)"
    printf '%s\n' "$CREATE_OUTPUT"
    DOCUMENT_URL="$(printf '%s' "$CREATE_OUTPUT" | uv run --no-project python -c '
import json
import sys

text = sys.stdin.read()
start = text.find("{")
if start < 0:
    raise SystemExit("创建文档的响应不是 JSON")
data = json.JSONDecoder().raw_decode(text[start:])[0]
document = data.get("data", {}).get("document", {})
url = document.get("url")
if not isinstance(url, str) or not url:
    raise SystemExit("创建文档响应中没有 data.document.url")
print(url)
')"
    run_step "追加飞书文档内容" \
      "$LARK_CLI" docs +update --api-version v1 --doc "$DOCUMENT_URL" \
      --mode append --markdown "Authorization test write succeeded." --as user
  fi
fi

if [[ "$SCENARIO" =~ ^(mail|all)$ ]]; then
  run_step "发送飞书邮件" \
    "$LARK_CLI" mail +send --to "$MAIL_TO" \
    --subject "[Ripple auth test][$TEST_ID] email" \
    --body "Ripple authorization test message." --plain-text --as user \
    "${DRY_RUN[@]}" "${MAIL_SEND[@]}"
fi

echo
echo "Feishu core workflow test completed: $SCENARIO/$MODE"
