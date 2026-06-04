#!/usr/bin/env bash
# Build and install the repo-local Podcast CLI into vendor/, matching the
# skill + bin layout used by bilibili/gog/ntn-style tools.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

INSTALL_ROOT="${REPO_ROOT}/vendor/podcast-cli"
VERSION_DIR="${INSTALL_ROOT}/v0.1.0"
CURRENT_LINK="${INSTALL_ROOT}/current"

cd "${REPO_ROOT}"
cargo build -p podcast-cli --release

mkdir -p "${VERSION_DIR}/bin"
install -m 0755 "${REPO_ROOT}/target/release/podcast" "${VERSION_DIR}/bin/podcast"
ln -sfn "v0.1.0" "${CURRENT_LINK}"

"${CURRENT_LINK}/bin/podcast" --help
echo "podcast CLI installed at ${CURRENT_LINK}/bin/podcast"
