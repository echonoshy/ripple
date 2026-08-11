#!/usr/bin/env bash
# 把 gogcli (gog) 安装到项目内的 vendor/，不修改宿主机 /opt 或 /usr/local/bin。
#
# 用法:
#   bash scripts/install-gogcli-cli.sh                 # 安装默认版本
#   bash scripts/install-gogcli-cli.sh 0.35.0          # 安装指定版本
#   bash scripts/install-gogcli-cli.sh 0.35.0 arm64    # 指定架构
#
# 离线安装必须提供归档；非内置版本还必须显式提供审核过的 SHA-256：
#   GOGCLI_ARCHIVE=/path/to/gogcli_0.35.0_linux_amd64.tar.gz \
#     bash scripts/install-gogcli-cli.sh 0.35.0 amd64
#   GOGCLI_ARCHIVE=/path/to/archive.tar.gz GOGCLI_SHA256=<sha256> \
#     bash scripts/install-gogcli-cli.sh <version> <arch>
set -euo pipefail

VERSION="${1:-0.35.0}"
RAW_ARCH="${2:-$(uname -m)}"
if [[ ! "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "✗ 无效的版本号: ${VERSION}" >&2
  exit 1
fi
case "${RAW_ARCH}" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo "✗ 未识别的架构: ${RAW_ARCH}，请显式传入 (amd64 / arm64)" >&2
    exit 1
    ;;
esac

ARCHIVE_NAME="gogcli_${VERSION}_linux_${ARCH}.tar.gz"
BASE_URL="https://github.com/openclaw/gogcli/releases/download"
RELEASE_URL="${BASE_URL}/v${VERSION}"
ARCHIVE_URL="${RELEASE_URL}/${ARCHIVE_NAME}"
CHECKSUM_URL="${RELEASE_URL}/checksums.txt"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALL_ROOT="${REPO_ROOT}/vendor/gogcli-cli"
VERSION_DIR="${INSTALL_ROOT}/v${VERSION}"
CURRENT_LINK="${INSTALL_ROOT}/current"

mkdir -p "${INSTALL_ROOT}"
TMP="$(mktemp -d "${INSTALL_ROOT}/.install-v${VERSION}-${ARCH}.XXXXXX")"
CURRENT_TMP="${INSTALL_ROOT}/.current.$$.tmp"
trap 'rm -rf "${TMP}"; rm -f "${CURRENT_TMP}"' EXIT
ARCHIVE_PATH="${TMP}/${ARCHIVE_NAME}"

pinned_checksum() {
  case "${VERSION}/${ARCH}" in
    0.35.0/amd64) printf '%s\n' 'c4e7e349c53d3e69e36729d4315a0e080a85a4b4767a84943f075067931bcbdf' ;;
    0.35.0/arm64) printf '%s\n' '6db242904741e280e5e62ff9249fe76c075bad5cc6c06d841e011622803dce34' ;;
    *) return 1 ;;
  esac
}

download() {
  local url="$1"
  local destination="$2"
  curl --fail --location --silent --show-error \
    --proto '=https' --tlsv1.2 --retry 3 --retry-all-errors \
    --connect-timeout 15 --max-time 300 \
    --output "${destination}" "${url}"
}

resolve_checksum() {
  local checksum
  if checksum="$(pinned_checksum)"; then
    printf '%s\n' "${checksum}"
    return
  fi
  if [[ -n "${GOGCLI_SHA256:-}" ]]; then
    printf '%s\n' "${GOGCLI_SHA256,,}"
    return
  fi
  if [[ -n "${GOGCLI_ARCHIVE:-}" ]]; then
    echo "✗ 离线安装非内置版本必须设置 GOGCLI_SHA256" >&2
    return 1
  fi
  local checksums="${TMP}/checksums.txt"
  echo "==> 下载官方 checksum: ${CHECKSUM_URL}" >&2
  download "${CHECKSUM_URL}" "${checksums}"
  checksum="$(awk -v name="${ARCHIVE_NAME}" '$2 == name { print $1; exit }' "${checksums}")"
  if [[ -z "${checksum}" ]]; then
    echo "✗ 官方 checksums.txt 中找不到 ${ARCHIVE_NAME}" >&2
    return 1
  fi
  printf '%s\n' "${checksum,,}"
}

EXPECTED_SHA256="$(resolve_checksum)"
if [[ ! "${EXPECTED_SHA256}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "✗ 无效的 SHA-256: ${EXPECTED_SHA256}" >&2
  exit 1
fi

if [[ -n "${GOGCLI_ARCHIVE:-}" ]]; then
  if [[ ! -f "${GOGCLI_ARCHIVE}" ]]; then
    echo "✗ GOGCLI_ARCHIVE 指定的文件不存在: ${GOGCLI_ARCHIVE}" >&2
    exit 1
  fi
  cp "${GOGCLI_ARCHIVE}" "${ARCHIVE_PATH}"
  echo "==> 使用本地归档: ${GOGCLI_ARCHIVE}"
else
  echo "==> 下载 gogcli v${VERSION} (linux/${ARCH})"
  if ! download "${ARCHIVE_URL}" "${ARCHIVE_PATH}"; then
    echo "✗ 下载失败: ${ARCHIVE_URL}" >&2
    echo "  可手工下载后通过 GOGCLI_ARCHIVE 重试；checksum 验证不会跳过。" >&2
    exit 1
  fi
fi

ACTUAL_SHA256="$(sha256sum "${ARCHIVE_PATH}" | awk '{print $1}')"
if [[ "${ACTUAL_SHA256}" != "${EXPECTED_SHA256}" ]]; then
  echo "✗ checksum 不匹配" >&2
  echo "  expected: ${EXPECTED_SHA256}" >&2
  echo "  actual:   ${ACTUAL_SHA256}" >&2
  exit 1
fi
echo "==> checksum 验证通过"

STAGE_VERSION_DIR="${TMP}/v${VERSION}"
mkdir -p "${STAGE_VERSION_DIR}/bin" "${TMP}/extract"
tar -xzf "${ARCHIVE_PATH}" --no-same-owner --no-same-permissions -C "${TMP}/extract" ./gog
GOG_BIN="${TMP}/extract/gog"
if [[ ! -f "${GOG_BIN}" || -L "${GOG_BIN}" ]]; then
  echo "✗ 归档中的 ./gog 不是普通文件" >&2
  exit 1
fi
install -m 0755 "${GOG_BIN}" "${STAGE_VERSION_DIR}/bin/gog"

VERSION_OUTPUT="$("${STAGE_VERSION_DIR}/bin/gog" --version)"
if [[ "${VERSION_OUTPUT}" != v"${VERSION}"* ]]; then
  echo "✗ 二进制版本不匹配: ${VERSION_OUTPUT}" >&2
  exit 1
fi

if [[ -e "${VERSION_DIR}" || -L "${VERSION_DIR}" ]]; then
  if [[ ! -x "${VERSION_DIR}/bin/gog" ]] \
    || [[ "$("${VERSION_DIR}/bin/gog" --version)" != v"${VERSION}"* ]] \
    || ! cmp --silent "${STAGE_VERSION_DIR}/bin/gog" "${VERSION_DIR}/bin/gog"; then
    echo "✗ 已存在但无效的版本目录: ${VERSION_DIR}" >&2
    exit 1
  fi
  echo "==> 已存在有效版本目录: ${VERSION_DIR}"
else
  mv "${STAGE_VERSION_DIR}" "${VERSION_DIR}"
fi

ln -s "v${VERSION}" "${CURRENT_TMP}"
mv -Tf "${CURRENT_TMP}" "${CURRENT_LINK}"

echo "==> 完成: ${CURRENT_LINK}/bin/gog"
"${CURRENT_LINK}/bin/gog" --version
