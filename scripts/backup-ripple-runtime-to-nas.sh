#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_DIR="${RIPPLE_BACKUP_SOURCE:-/home/lake/workspace/ripple/.ripple}"
NAS_MOUNT="${RIPPLE_BACKUP_NAS_MOUNT:-/nas}"
DEST_ROOT="${RIPPLE_BACKUP_DEST:-/nas/ripple-backups/ripple-runtime}"
DEST_CURRENT="${DEST_ROOT}/current"
LOG_DIR="${DEST_ROOT}/logs"
LOCK_FILE="${DEST_ROOT}/.backup.lock"

timestamp="$(date '+%Y%m%d-%H%M%S')"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

is_mounted() {
  if command -v findmnt >/dev/null 2>&1; then
    findmnt --mountpoint "$1" >/dev/null 2>&1
    return
  fi
  mountpoint -q "$1"
}

case "$DEST_ROOT" in
  "$NAS_MOUNT"/*) ;;
  *) fail "destination must live under ${NAS_MOUNT}: ${DEST_ROOT}" ;;
esac

[[ -d "$SOURCE_DIR" ]] || fail "source directory does not exist: ${SOURCE_DIR}"
[[ -d "$NAS_MOUNT" ]] || fail "NAS mount directory does not exist: ${NAS_MOUNT}"
is_mounted "$NAS_MOUNT" || fail "NAS mount is not mounted: ${NAS_MOUNT}"
command -v rsync >/dev/null 2>&1 || fail "rsync is required"
command -v flock >/dev/null 2>&1 || fail "flock is required"

umask 077
mkdir -p "$DEST_ROOT" "$DEST_CURRENT" "$LOG_DIR"

log_file="${LOG_DIR}/backup-${timestamp}.log"
exec > >(tee -a "$log_file") 2>&1
ln -sfn "$(basename "$log_file")" "${LOG_DIR}/latest.log"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another Ripple runtime backup is already running; exiting."
  exit 0
fi

echo "=== Ripple runtime NAS backup started at $(date -Is) ==="
echo "Source:      ${SOURCE_DIR}/"
echo "Destination: ${DEST_CURRENT}/"
echo "Log:         ${log_file}"
echo

rsync_status=0
rsync \
  -aH \
  --checksum \
  --delete \
  --delete-excluded \
  --human-readable \
  --itemize-changes \
  --stats \
  --exclude='sandboxes-cache/' \
  "${SOURCE_DIR}/" \
  "${DEST_CURRENT}/" || rsync_status=$?

if [[ "$rsync_status" -eq 24 ]]; then
  echo
  echo "WARNING: rsync reported vanished files while copying active runtime state."
  echo "This simple backup tolerates that; the next scheduled run will resync changed files."
elif [[ "$rsync_status" -ne 0 ]]; then
  fail "rsync failed with exit code ${rsync_status}"
fi

cat >"${DEST_ROOT}/last-success.txt" <<EOF
completed_at=$(date -Is)
source=${SOURCE_DIR}
destination=${DEST_CURRENT}
mode=rsync-checksum-mirror
excluded=sandboxes-cache/
rsync_exit=${rsync_status}
EOF

echo
echo "=== Ripple runtime NAS backup finished at $(date -Is) ==="
