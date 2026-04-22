#!/usr/bin/env bash
# 把 gogcli (gog) 下载并安装到项目内的 vendor/ 目录，不动宿主机的 /opt、/usr/local/bin。
#
# 用法:
#   ./scripts/install-gogcli-cli.sh                 # 安装默认版本
#   ./scripts/install-gogcli-cli.sh 0.13.0          # 安装指定版本
#   ./scripts/install-gogcli-cli.sh 0.13.0 arm64    # 指定架构（默认 uname -m 推导）
#
# 下载失败时不会重试，会打印手工安装说明。用已下好的 tarball 兜底：
#   GOGCLI_ARCHIVE=/path/to/gogcli_0.13.0_linux_amd64.tar.gz \
#     ./scripts/install-gogcli-cli.sh 0.13.0
set -euo pipefail

VERSION="${1:-0.13.0}"
RAW_ARCH="${2:-$(uname -m)}"
case "${RAW_ARCH}" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo "✗ 未识别的架构: ${RAW_ARCH}，请显式传入 (amd64 / arm64)" >&2
    exit 1
    ;;
esac

# 官方 release 资产命名：gogcli_<version>_linux_<amd64|arm64>.tar.gz
ARCHIVE_NAME="gogcli_${VERSION}_linux_${ARCH}.tar.gz"
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
  1. 用你顺手的方式下载（可走 github 镜像 ghproxy / ghfast / kkgithub）:
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
  echo "==> 下载 gogcli v${VERSION} (linux/${ARCH})"
  if ! curl -fL -o "${TMP}/${ARCHIVE_NAME}" "${ARCHIVE_URL}"; then
    print_manual_fallback
    exit 1
  fi
fi

echo "==> 解压到 ${VERSION_DIR}/bin"
tar -xzf "${TMP}/${ARCHIVE_NAME}" -C "${TMP}"

# 归档内通常直接在根下含 `gog` 二进制（实测 v0.13.0 是 CHANGELOG/LICENSE/README/gog
# 这种扁平结构），也兼容老版本可能的 gog_linux_<arch>/gog 嵌套布局。
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
