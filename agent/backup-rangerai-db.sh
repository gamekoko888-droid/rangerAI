#!/bin/bash
# RangerAI Database Backup Script
# Runs daily via crontab, keeps 7 days of rolling backups
# Usage: bash /opt/rangerai-agent/backup-rangerai-db.sh

set -euo pipefail

# Configuration
DB_PATH="/opt/rangerai-agent/rangerai.db"
BACKUP_DIR="/opt/rangerai-agent/backups/db"
RETENTION_DAYS=3
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/rangerai_${TIMESTAMP}.db"

# Ensure backup directory exists
mkdir -p "${BACKUP_DIR}"

# Check if database exists
if [ ! -f "${DB_PATH}" ]; then
  echo "[$(date)] ERROR: Database not found at ${DB_PATH}"
  exit 1
fi

# Use sqlite3 .backup for safe online backup (no locking issues)
if command -v sqlite3 &> /dev/null; then
  sqlite3 "${DB_PATH}" ".backup '${BACKUP_FILE}'"
else
  # Fallback: cp (less safe but works without sqlite3)
  cp "${DB_PATH}" "${BACKUP_FILE}"
fi

# Verify backup
if [ -f "${BACKUP_FILE}" ] && [ -s "${BACKUP_FILE}" ]; then
  BACKUP_SIZE=$(stat -c%s "${BACKUP_FILE}" 2>/dev/null || stat -f%z "${BACKUP_FILE}")
  DB_SIZE=$(stat -c%s "${DB_PATH}" 2>/dev/null || stat -f%z "${DB_PATH}")
  echo "[$(date)] OK: Backup created ${BACKUP_FILE} (${BACKUP_SIZE} bytes, original ${DB_SIZE} bytes)"
else
  echo "[$(date)] ERROR: Backup file is empty or missing"
  exit 1
fi

# Cleanup: remove backups older than RETENTION_DAYS
find "${BACKUP_DIR}" -name "rangerai_*.db" -mtime +${RETENTION_DAYS} -delete 2>/dev/null || true
REMAINING=$(ls -1 "${BACKUP_DIR}"/rangerai_*.db 2>/dev/null | wc -l)
echo "[$(date)] Cleanup done. ${REMAINING} backups retained."
