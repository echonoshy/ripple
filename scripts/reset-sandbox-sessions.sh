#!/usr/bin/env bash
# 清空所有 per-session 沙箱数据（workspace、meta、feishu 凭证、nsjail 配置等）。
#
# 场景：代码层改变了沙箱约定（lark-cli 不再沙箱内安装、config 布局变更等），
# 旧 session 可能带着过期的 `/workspace/.local/bin/lark-cli` 或不兼容配置，
# 需要一次性清理。
#
# 用法：
#   bash scripts/reset-sandbox-sessions.sh           # 默认清空 $PROJECT/.ripple/server/sandboxes/sessions
#   bash scripts/reset-sandbox-sessions.sh --yes     # 跳过交互确认
#   SANDBOXES_ROOT=/custom/path bash scripts/reset-sandbox-sessions.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SANDBOXES_ROOT="${SANDBOXES_ROOT:-${PROJECT_ROOT}/.ripple/server/sandboxes}"
SESSIONS_DIR="${SANDBOXES_ROOT}/sessions"

AUTO_YES="${1:-}"

if [[ ! -d "${SESSIONS_DIR}" ]]; then
  echo "sessions 目录不存在，无需清理：${SESSIONS_DIR}"
  exit 0
fi

shopt -s nullglob
SESSIONS=("${SESSIONS_DIR}"/*/)
shopt -u nullglob

if [[ ${#SESSIONS[@]} -eq 0 ]]; then
  echo "sessions 目录为空，无需清理：${SESSIONS_DIR}"
  exit 0
fi

echo "将要清理 ${#SESSIONS[@]} 个 session："
for s in "${SESSIONS[@]}"; do
  echo "  - $(basename "${s}")"
done
echo
echo "目录：${SESSIONS_DIR}"

if [[ "${AUTO_YES}" != "--yes" && "${AUTO_YES}" != "-y" ]]; then
  read -r -p "确认删除？[y/N] " ans
  if [[ "${ans}" != "y" && "${ans}" != "Y" ]]; then
    echo "已取消。"
    exit 0
  fi
fi

for s in "${SESSIONS[@]}"; do
  rm -rf "${s}"
done

echo "✓ 已清空 ${#SESSIONS[@]} 个 session"
echo "提示：服务端内存中的 session 引用仍存在，建议重启 server 进程以完全释放。"
