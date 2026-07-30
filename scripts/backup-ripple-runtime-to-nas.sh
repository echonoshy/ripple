#!/usr/bin/env bash
set -Eeuo pipefail

# Create verified, logical SQLite snapshots from the local Ripple runtime and
# publish them to NAS. The live databases must stay on a local filesystem;
# never copy their sqlite-wal/sqlite-shm sidecars to NAS.

MODE="${RIPPLE_BACKUP_MODE:-control}"
SOURCE_DIR="${RIPPLE_BACKUP_SOURCE:-/root/ripple/.ripple}"
NAS_MOUNT="${RIPPLE_BACKUP_NAS_MOUNT:-/nas}"
DEST_ROOT="${RIPPLE_BACKUP_DEST:-/nas/ripple-data/backups/ripple-local}"
RETENTION_DAYS="${RIPPLE_BACKUP_RETENTION_DAYS:-7}"
CONTROL_DB="${RIPPLE_BACKUP_CONTROL_DB:-${SOURCE_DIR}/ripple.sqlite}"
AUDIT_LOG="${RIPPLE_BACKUP_AUDIT_LOG:-${SOURCE_DIR}/audit.jsonl}"
CODEX_SQLITE_ROOT="${RIPPLE_BACKUP_CODEX_SQLITE_ROOT:-${SOURCE_DIR}/codex-sqlite}"
STAGING_ROOT="${RIPPLE_BACKUP_STAGING_ROOT:-${SOURCE_DIR}/backup-staging}"
LOCK_FILE="${RIPPLE_BACKUP_LOCK_FILE:-${SOURCE_DIR}/backup.lock}"

timestamp="$(date -u '+%Y%m%d-%H%M%S')"
retention_minutes="$((RETENTION_DAYS * 24 * 60))"
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

is_mounted() {
  if command -v findmnt >/dev/null 2>&1; then
    findmnt --mountpoint "$1" >/dev/null 2>&1
    return
  fi
  mountpoint -q "$1"
}

require_commands() {
  local command
  for command in sqlite3 zstd rsync sha256sum flock find; do
    command -v "$command" >/dev/null 2>&1 || fail "required command is missing: ${command}"
  done
}

validate_configuration() {
  case "$MODE" in
    control|codex-state) ;;
    *) fail "RIPPLE_BACKUP_MODE must be control or codex-state, got: ${MODE}" ;;
  esac

  [[ "$RETENTION_DAYS" =~ ^[1-9][0-9]*$ ]] || fail "RIPPLE_BACKUP_RETENTION_DAYS must be a positive integer"
  [[ -d "$SOURCE_DIR" ]] || fail "source directory does not exist: ${SOURCE_DIR}"
  [[ -d "$NAS_MOUNT" ]] || fail "NAS mount directory does not exist: ${NAS_MOUNT}"
  is_mounted "$NAS_MOUNT" || fail "NAS mount is not mounted: ${NAS_MOUNT}"

  case "$DEST_ROOT" in
    "$NAS_MOUNT"/*) ;;
    *) fail "destination must live under ${NAS_MOUNT}: ${DEST_ROOT}" ;;
  esac

  if [[ "$MODE" == "control" ]]; then
    [[ -f "$CONTROL_DB" ]] || fail "control-plane database does not exist: ${CONTROL_DB}"
  else
    [[ -d "$CODEX_SQLITE_ROOT" ]] || fail "Codex SQLite root does not exist: ${CODEX_SQLITE_ROOT}"
  fi
}

backup_sqlite() {
  local source_db="$1"
  local snapshot_db="$2"
  local integrity_result
  local foreign_key_result

  mkdir -p "$(dirname "$snapshot_db")"
  sqlite3 -readonly -cmd '.timeout 10000' "$source_db" ".backup '${snapshot_db}'"

  integrity_result="$(sqlite3 -readonly "$snapshot_db" 'PRAGMA integrity_check;')"
  [[ "$integrity_result" == "ok" ]] || fail "SQLite integrity check failed for ${source_db}"

  foreign_key_result="$(sqlite3 -readonly "$snapshot_db" 'PRAGMA foreign_key_check;')"
  [[ -z "$foreign_key_result" ]] || fail "SQLite foreign key check failed for ${source_db}"

  # The copied database retains WAL journal mode. Read-only validation can
  # create empty sidecars next to the snapshot; .backup has already merged
  # the consistent image, so these files must never be published.
  rm -f -- "${snapshot_db}-wal" "${snapshot_db}-shm"
  zstd -q -T0 -3 --rm "$snapshot_db"
}

compress_audit_log() {
  [[ -f "$AUDIT_LOG" ]] || return
  cp --reflink=auto -- "$AUDIT_LOG" "$stage/audit.jsonl"
  zstd -q -T0 -3 --rm "$stage/audit.jsonl"
}

write_metadata() {
  local db_count="$1"
  cat >"$stage/metadata.json" <<EOF
{
  "created_at": "$(date -u --iso-8601=seconds)",
  "kind": "${MODE}",
  "retention_days": ${RETENTION_DAYS},
  "sqlite_databases": ${db_count},
  "source_dir": "${SOURCE_DIR}"
}
EOF
}

write_checksums() {
  (
    cd "$stage"
    find . -type f ! -name 'SHA256SUMS' ! -name 'COMPLETE' -print0 \
      | sort -z \
      | xargs -0 sha256sum >SHA256SUMS
  )
}

publish_snapshot() {
  local snapshot_root="$DEST_ROOT/$MODE"
  local incoming_root="$DEST_ROOT/.incoming"
  local incoming="$incoming_root/${MODE}-${timestamp}-$$"
  local destination="$snapshot_root/$timestamp"

  mkdir -p "$snapshot_root" "$incoming_root"
  [[ ! -e "$destination" ]] || fail "snapshot destination already exists: ${destination}"
  [[ ! -e "$incoming" ]] || fail "temporary snapshot destination already exists: ${incoming}"
  mkdir -m 0700 "$incoming"

  rsync -a --chmod=Du=rwx,Dgo=,Fu=rw,Fgo= -- "$stage/" "$incoming/"
  (
    cd "$incoming"
    sha256sum -c SHA256SUMS >/dev/null
  ) || fail "checksum verification failed after NAS transfer"

  printf 'completed_at=%s\n' "$(date -u --iso-8601=seconds)" >"$incoming/COMPLETE"
  mv -- "$incoming" "$destination"
  echo "Published verified ${MODE} snapshot: ${destination}"
}

prune_snapshots() {
  local snapshot_root="$DEST_ROOT/$MODE"
  local candidate
  local basename

  [[ -d "$snapshot_root" ]] || return
  while IFS= read -r -d '' candidate; do
    basename="$(basename "$candidate")"
    [[ "$basename" =~ ^[0-9]{8}-[0-9]{6}$ ]] || continue
    [[ -f "$candidate/COMPLETE" && -f "$candidate/SHA256SUMS" ]] || continue
    rm -rf -- "$candidate"
    echo "Pruned expired ${MODE} snapshot: ${candidate}"
  done < <(find "$snapshot_root" -mindepth 1 -maxdepth 1 -type d -mmin "+${retention_minutes}" -print0)
}

backup_control() {
  backup_sqlite "$CONTROL_DB" "$stage/ripple.sqlite"
  compress_audit_log
  write_metadata 1
}

backup_codex_state() {
  local source_db
  local relative_path
  local snapshot_db
  local count=0

  while IFS= read -r -d '' source_db; do
    relative_path="${source_db#"${CODEX_SQLITE_ROOT}/"}"
    snapshot_db="$stage/$relative_path"
    backup_sqlite "$source_db" "$snapshot_db"
    count="$((count + 1))"
  done < <(
    find "$CODEX_SQLITE_ROOT" -type f \
      \( -name 'state_5.sqlite' -o -name 'goals_1.sqlite' -o -name 'memories_1.sqlite' \) \
      -print0
  )

  (( count > 0 )) || fail "no Codex state SQLite databases found under ${CODEX_SQLITE_ROOT}"
  write_metadata "$count"
}

main() {
  umask 077
  require_commands
  validate_configuration
  mkdir -p "$STAGING_ROOT"

  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    echo "Another Ripple local backup is already running; exiting."
    exit 0
  fi

  stage="$(mktemp -d "${STAGING_ROOT}/.${MODE}-${timestamp}.XXXXXX")"
  trap cleanup EXIT

  echo "=== Ripple ${MODE} NAS backup started at $(date -u --iso-8601=seconds) ==="
  echo "Source: ${SOURCE_DIR}"
  echo "Destination: ${DEST_ROOT}/${MODE}/${timestamp}"

  if [[ "$MODE" == "control" ]]; then
    backup_control
  else
    backup_codex_state
  fi
  write_checksums
  publish_snapshot
  prune_snapshots

  echo "=== Ripple ${MODE} NAS backup finished at $(date -u --iso-8601=seconds) ==="
}

main "$@"
