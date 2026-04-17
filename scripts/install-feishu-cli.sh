#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-1.0.13}"
ARCH="${2:-$(case $(uname -m) in x86_64) echo amd64;; aarch64|arm64) echo arm64;; esac)}"
PLATFORM="linux"

INSTALL_ROOT="/opt/lark-cli"
VERSION_DIR="${INSTALL_ROOT}/v${VERSION}"
CURRENT_LINK="${INSTALL_ROOT}/current"
GLOBAL_BIN="/usr/local/bin/lark-cli"

# 1. 下载 + 解压到 /opt/lark-cli/v<VERSION>/bin/
sudo mkdir -p "${VERSION_DIR}/bin"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
curl -fL -o "${TMP}/lark-cli.tar.gz" \
  "https://registry.npmmirror.com/-/binary/lark-cli/v${VERSION}/lark-cli-${VERSION}-${PLATFORM}-${ARCH}.tar.gz"
tar -xzf "${TMP}/lark-cli.tar.gz" -C "${TMP}"
sudo install -m 0755 "${TMP}/lark-cli" "${VERSION_DIR}/bin/lark-cli"

# 2. 切 current symlink
sudo ln -sfn "${VERSION_DIR}" "${CURRENT_LINK}"

# 3. 切 /usr/local/bin symlink
sudo ln -sfn "${CURRENT_LINK}/bin/lark-cli" "${GLOBAL_BIN}"

# 4. 验证
"${GLOBAL_BIN}" --version
echo "✓ lark-cli v${VERSION} 安装完成，current -> v${VERSION}"