#!/usr/bin/env bash
# 把 Notion CLI (ntn) 下载并安装到项目内的 vendor/ 目录，不动宿主机的 /opt、/usr/local/bin。
# 迁移项目时只需整个仓库带走即可。
#
# 用法:
#   ./scripts/install-notion-cli.sh                 # 安装默认版本
#   ./scripts/install-notion-cli.sh 0.10.0          # 安装指定版本
#
# 下载失败时不会重试，会打印手工安装说明（包括如何复用已经下好的压缩包）。
#   NTN_ARCHIVE=/path/to/ntn-x86_64-unknown-linux-musl.tar.gz ./scripts/install-notion-cli.sh 0.10.0
set -euo pipefail

VERSION="${1:-0.10.0}"
# Linux 官方静态 musl 包（Mac 见 https://ntn.dev 原脚本的分支）。
TARGET="x86_64-unknown-linux-musl"
ARCHIVE_NAME="ntn-${TARGET}.tar.gz"
BASE_URL="https://ntn.dev"
ARCHIVE_URL="${BASE_URL}/releases/v${VERSION}/${ARCHIVE_NAME}"
CHECKSUM_URL="${ARCHIVE_URL}.sha256"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

INSTALL_ROOT="${REPO_ROOT}/vendor/notion-cli"
VERSION_DIR="${INSTALL_ROOT}/v${VERSION}"
CURRENT_LINK="${INSTALL_ROOT}/current"

mkdir -p "${VERSION_DIR}/bin"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

print_manual_fallback() {
  cat >&2 <<EOF

========================================================================
[ntn 下载失败]  脚本不会重试，请按以下任一方式手工继续：

方式 A · 手工下载 tarball 后重新运行本脚本
  1. 用你顺手的方式（浏览器 / 其他机器 / proxychains）下载：
       ${ARCHIVE_URL}
       ${CHECKSUM_URL}
  2. 假设两个文件都落到 ~/Downloads/
  3. 重新跑：
       NTN_ARCHIVE=~/Downloads/${ARCHIVE_NAME} \\
         bash scripts/install-notion-cli.sh ${VERSION}

方式 B · 直接把现成的 ntn 二进制放到 vendor/
  1. 确保你手里的 ntn 是 linux-x64 musl 静态链接的
  2. 执行：
       mkdir -p ${VERSION_DIR}/bin
       install -m 0755 /path/to/ntn ${VERSION_DIR}/bin/ntn
       ln -sfn v${VERSION} ${CURRENT_LINK}
       ${CURRENT_LINK}/bin/ntn --version

方式 C · 如果是网络墙的问题，先 proxy_on 再重试本脚本
========================================================================
EOF
}

if [[ -n "${NTN_ARCHIVE:-}" ]]; then
  # 已有手工下载好的 tarball，跳过下载。
  if [[ ! -f "${NTN_ARCHIVE}" ]]; then
    echo "✗ NTN_ARCHIVE 指定的文件不存在: ${NTN_ARCHIVE}" >&2
    exit 1
  fi
  cp "${NTN_ARCHIVE}" "${TMP}/${ARCHIVE_NAME}"
  echo "==> 使用本地 tarball: ${NTN_ARCHIVE}"
else
  echo "==> 下载 ntn v${VERSION} (${TARGET})"
  if ! curl -fL -o "${TMP}/${ARCHIVE_NAME}" "${ARCHIVE_URL}"; then
    print_manual_fallback
    exit 1
  fi
  # checksum 是可选的，下载失败只给 warning；tarball 自身内容校验交给 tar。
  if ! curl -fL -o "${TMP}/${ARCHIVE_NAME}.sha256" "${CHECKSUM_URL}" 2>/dev/null; then
    echo "⚠ 校验文件下载失败（忽略，继续安装）"
  else
    if command -v sha256sum >/dev/null 2>&1; then
      (cd "${TMP}" && sha256sum -c "${ARCHIVE_NAME}.sha256") || {
        echo "✗ 校验失败，压缩包已损坏" >&2
        exit 1
      }
    fi
  fi
fi

tar -xzf "${TMP}/${ARCHIVE_NAME}" -C "${TMP}"

BINARY_IN_ARCHIVE="${TMP}/ntn-${TARGET}/ntn"
if [[ ! -f "${BINARY_IN_ARCHIVE}" ]]; then
  echo "✗ 压缩包中未找到 ntn 二进制（期望路径 ntn-${TARGET}/ntn）" >&2
  echo "   压缩包实际内容：" >&2
  ls -la "${TMP}" >&2
  exit 1
fi

install -m 0755 "${BINARY_IN_ARCHIVE}" "${VERSION_DIR}/bin/ntn"

ln -sfn "v${VERSION}" "${CURRENT_LINK}"

"${CURRENT_LINK}/bin/ntn" --version || {
  echo "⚠ ntn --version 执行失败，请检查二进制兼容性" >&2
  exit 1
}

echo "✓ ntn v${VERSION} 已安装到 ${VERSION_DIR}"
echo "  current -> v${VERSION}"
echo "  调用方式: ${CURRENT_LINK}/bin/ntn"
