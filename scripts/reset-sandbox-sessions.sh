#!/usr/bin/env bash
# 清空所有 user sandbox 下的 session 状态数据。
#
# 场景：代码层改变了沙箱、connector 或 session metadata 约定时，
# 旧 session 可能带着不兼容的 pending state、Codex thread id 或 connector auth 状态，
# 需要一次性清理。该脚本不删除 workspace/credentials/nsjail.cfg。
#
# 用法：
#   bash scripts/reset-sandbox-sessions.sh           # 默认清空 $PROJECT/.ripple/sandboxes/*/sessions
#   bash scripts/reset-sandbox-sessions.sh --yes     # 跳过交互确认
#   SANDBOXES_ROOT=/custom/path bash scripts/reset-sandbox-sessions.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SANDBOXES_ROOT="${SANDBOXES_ROOT:-${PROJECT_ROOT}/.ripple/sandboxes}"

AUTO_YES="${1:-}"

if [[ ! -d "${SANDBOXES_ROOT}" ]]; then
  echo "sandboxes 目录不存在，无需清理：${SANDBOXES_ROOT}"
  exit 0
fi

shopt -s nullglob
SESSION_DIRS=("${SANDBOXES_ROOT}"/*/sessions)
shopt -u nullglob

if [[ ${#SESSION_DIRS[@]} -eq 0 ]]; then
  echo "未发现 user sessions 目录，无需清理：${SANDBOXES_ROOT}"
  exit 0
fi

SESSION_COUNT=0
for dir in "${SESSION_DIRS[@]}"; do
  shopt -s nullglob
  sessions=("${dir}"/*/)
  shopt -u nullglob
  SESSION_COUNT=$((SESSION_COUNT + ${#sessions[@]}))
done

if [[ "${SESSION_COUNT}" -eq 0 ]]; then
  echo "所有 user sessions 目录均为空，无需清理：${SANDBOXES_ROOT}"
  exit 0
fi

echo "将要清理 ${SESSION_COUNT} 个 session："
for dir in "${SESSION_DIRS[@]}"; do
  user_dir="$(dirname "${dir}")"
  user_id="$(basename "${user_dir}")"
  shopt -s nullglob
  sessions=("${dir}"/*/)
  shopt -u nullglob
  for s in "${sessions[@]}"; do
    echo "  - ${user_id}/$(basename "${s}")"
  done
done
echo
echo "目录：${SANDBOXES_ROOT}"

if [[ "${AUTO_YES}" != "--yes" && "${AUTO_YES}" != "-y" ]]; then
  read -r -p "确认删除？[y/N] " ans
  if [[ "${ans}" != "y" && "${ans}" != "Y" ]]; then
    echo "已取消。"
    exit 0
  fi
fi

for dir in "${SESSION_DIRS[@]}"; do
  shopt -s nullglob
  sessions=("${dir}"/*/)
  shopt -u nullglob
  for s in "${sessions[@]}"; do
    rm -rf "${s}"
  done
done

echo "✓ 已清空 ${SESSION_COUNT} 个 session"
echo "提示：服务端内存中的 session 引用仍存在，建议重启 server 进程以完全释放。"
