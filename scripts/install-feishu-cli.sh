#!/usr/bin/env bash
# 把 lark-cli 下载并安装到项目内的 vendor/ 目录，不动宿主机的 /opt、/usr/local/bin。
# 迁移项目时只需整个仓库带走即可。
#
# 用法:
#   ./scripts/install-feishu-cli.sh                 # 安装默认版本
#   ./scripts/install-feishu-cli.sh 1.0.14          # 安装指定版本
#   ./scripts/install-feishu-cli.sh 1.0.14 amd64    # 指定架构
set -euo pipefail

VERSION="${1:-1.0.13}"
ARCH="${2:-$(case $(uname -m) in x86_64) echo amd64;; aarch64|arm64) echo arm64;; esac)}"
PLATFORM="linux"

# 定位到仓库根目录（本脚本所在目录的上一层）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

INSTALL_ROOT="${REPO_ROOT}/vendor/lark-cli"
VERSION_DIR="${INSTALL_ROOT}/v${VERSION}"
CURRENT_LINK="${INSTALL_ROOT}/current"

# 1. 下载 + 解压到 vendor/lark-cli/v<VERSION>/bin/
mkdir -p "${VERSION_DIR}/bin"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
curl -fL -o "${TMP}/lark-cli.tar.gz" \
  "https://registry.npmmirror.com/-/binary/lark-cli/v${VERSION}/lark-cli-${VERSION}-${PLATFORM}-${ARCH}.tar.gz"
tar -xzf "${TMP}/lark-cli.tar.gz" -C "${TMP}"
install -m 0755 "${TMP}/lark-cli" "${VERSION_DIR}/bin/lark-cli"

# 2. 切 current 软链到新版本
ln -sfn "v${VERSION}" "${CURRENT_LINK}"

# 3. 验证
"${CURRENT_LINK}/bin/lark-cli" --version
echo "✓ lark-cli v${VERSION} 已安装到 ${VERSION_DIR}"
echo "  current -> v${VERSION}"
echo "  调用方式: ${CURRENT_LINK}/bin/lark-cli"
