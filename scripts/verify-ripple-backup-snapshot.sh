#!/usr/bin/env bash
set -Eeuo pipefail

SNAPSHOT_DIR="${1:?usage: verify-ripple-backup-snapshot.sh <snapshot-directory>}"
STAGING_ROOT="${RIPPLE_BACKUP_VERIFY_STAGING_ROOT:-/var/tmp}"
stage=""

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$stage" && -d "$stage" ]]; then
    rm -rf -- "$stage"
  fi
}

verify_sqlite() {
  local database="$1"
  local integrity_result
  local foreign_key_result

  integrity_result="$(sqlite3 -readonly "$database" 'PRAGMA integrity_check;')"
  [[ "$integrity_result" == "ok" ]] || fail "SQLite integrity check failed: ${database}"

  foreign_key_result="$(sqlite3 -readonly "$database" 'PRAGMA foreign_key_check;')"
  [[ -z "$foreign_key_result" ]] || fail "SQLite foreign key check failed: ${database}"
}

main() {
  local archive
  local relative_path
  local database
  local count=0

  command -v sha256sum >/dev/null 2>&1 || fail "required command is missing: sha256sum"
  command -v sqlite3 >/dev/null 2>&1 || fail "required command is missing: sqlite3"
  command -v zstd >/dev/null 2>&1 || fail "required command is missing: zstd"
  [[ -d "$SNAPSHOT_DIR" ]] || fail "snapshot directory does not exist: ${SNAPSHOT_DIR}"
  [[ -f "$SNAPSHOT_DIR/COMPLETE" ]] || fail "snapshot is not marked complete: ${SNAPSHOT_DIR}"
  [[ -f "$SNAPSHOT_DIR/SHA256SUMS" ]] || fail "snapshot checksums are missing: ${SNAPSHOT_DIR}"

  (
    cd "$SNAPSHOT_DIR"
    sha256sum -c SHA256SUMS >/dev/null
  ) || fail "snapshot checksum verification failed"

  stage="$(mktemp -d "${STAGING_ROOT%/}/ripple-backup-verify.XXXXXX")"
  trap cleanup EXIT

  while IFS= read -r -d '' archive; do
    relative_path="${archive#"${SNAPSHOT_DIR}/"}"
    database="$stage/${relative_path%.zst}"
    mkdir -p "$(dirname "$database")"
    zstd -q -d -c -- "$archive" >"$database"
    verify_sqlite "$database"
    count="$((count + 1))"
  done < <(find "$SNAPSHOT_DIR" -type f -name '*.sqlite.zst' -print0)

  (( count > 0 )) || fail "no SQLite archives found in snapshot: ${SNAPSHOT_DIR}"
  echo "Verified ${count} SQLite database(s) in snapshot: ${SNAPSHOT_DIR}"
}

main "$@"
