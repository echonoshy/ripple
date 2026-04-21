#!/usr/bin/env bash
# 在项目内已安装的 notion-cli (ntn) 版本之间切换，或列出全部可用版本。
#
# 用法:
#   ./scripts/use-notion-cli.sh --list       # 列出所有版本，标记当前
#   ./scripts/use-notion-cli.sh 0.10.0       # 切换 current -> v0.10.0
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALL_ROOT="${REPO_ROOT}/vendor/notion-cli"
CURRENT_LINK="${INSTALL_ROOT}/current"

if [[ ! -d "${INSTALL_ROOT}" ]]; then
  echo "✗ 还没有安装过任何版本: ${INSTALL_ROOT} 不存在" >&2
  echo "  先运行: ./scripts/install-notion-cli.sh <version>" >&2
  exit 1
fi

current_target=""
if [[ -L "${CURRENT_LINK}" ]]; then
  current_target="$(readlink "${CURRENT_LINK}")"
fi

if [[ "${1:-}" == "--list" || "${1:-}" == "-l" || $# -eq 0 ]]; then
  echo "已安装版本 (在 ${INSTALL_ROOT}):"
  found=0
  for d in "${INSTALL_ROOT}"/v*/; do
    [[ -d "$d" ]] || continue
    found=1
    name="$(basename "$d")"
    if [[ "${name}" == "${current_target}" ]]; then
      echo "  * ${name}  (current)"
    else
      echo "    ${name}"
    fi
  done
  [[ "${found}" -eq 0 ]] && echo "  (无)"
  exit 0
fi

VERSION="${1#v}"  # 允许传 "0.10.0" 或 "v0.10.0"
VERSION_DIR="${INSTALL_ROOT}/v${VERSION}"

if [[ ! -x "${VERSION_DIR}/bin/ntn" ]]; then
  echo "✗ 未找到 v${VERSION}: ${VERSION_DIR}/bin/ntn 不存在或不可执行" >&2
  echo "  先运行: ./scripts/install-notion-cli.sh ${VERSION}" >&2
  exit 1
fi

ln -sfn "v${VERSION}" "${CURRENT_LINK}"
"${CURRENT_LINK}/bin/ntn" --version
echo "✓ 已切换 current -> v${VERSION}"
