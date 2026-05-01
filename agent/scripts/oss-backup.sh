#!/bin/bash
set -e
BACKUP_DIR="/opt/rangerai-agent/backups/db"
OSS_BUCKET="oss://rangerai-backups"
OSS_PREFIX="db-backups"
LOG_FILE="/var/log/rangerai-oss-backup.log"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1" >> "$LOG_FILE"; }

if ! ossutil64 ls oss:// >/dev/null 2>&1; then
  log "ERROR: ossutil64 not configured"
  exit 1
fi

TODAY=$(date +%Y%m%d)
BACKUP_FILE=$(ls -t "$BACKUP_DIR"/rangerai_${TODAY}*.db 2>/dev/null | head -1)
if [ -z "$BACKUP_FILE" ]; then
  log "WARNING: No backup for $TODAY"
  exit 0
fi

FILENAME=$(basename "$BACKUP_FILE")
log "Uploading $FILENAME to $OSS_BUCKET/$OSS_PREFIX/"
ossutil64 cp "$BACKUP_FILE" "$OSS_BUCKET/$OSS_PREFIX/$FILENAME" --force 2>&1 | tee -a "$LOG_FILE"
log "OSS backup complete"
