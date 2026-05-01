#!/bin/bash
# disk-cleanup.sh — RangerAI Production Disk Cleanup
# Cleans stale frontend backup dirs, old log files, and temp files
# Safe: keeps the 3 most recent backups

set -euo pipefail
LOG_PREFIX="[disk-cleanup]"
TS=$(date +%Y%m%d-%H%M%S)

echo "$LOG_PREFIX Starting cleanup at $TS"

# 1. Clean stale frontend backup directories (keep last 3)
BACKUP_DIR="/opt/rangerai-agent/dist"
ASSET_BACKUPS=$(ls -td "$BACKUP_DIR"/assets.bak-* 2>/dev/null || true)
ASSET_COUNT=$(echo "$ASSET_BACKUPS" | grep -c "assets.bak" 2>/dev/null || echo 0)

if [ "$ASSET_COUNT" -gt 3 ]; then
  REMOVE_COUNT=$((ASSET_COUNT - 3))
  echo "$LOG_PREFIX Found $ASSET_COUNT asset backups, removing $REMOVE_COUNT (keeping 3 newest)"
  echo "$ASSET_BACKUPS" | tail -n "$REMOVE_COUNT" | while read -r dir; do
    echo "$LOG_PREFIX  Removing: $(basename "$dir")"
    rm -rf "$dir"
  done
else
  echo "$LOG_PREFIX Asset backups: $ASSET_COUNT (no cleanup needed, threshold: 3)"
fi

# Clean index.html backups (keep last 3)
HTML_BACKUPS=$(ls -t "$BACKUP_DIR"/index.html.bak-* 2>/dev/null || true)
HTML_COUNT=$(echo "$HTML_BACKUPS" | grep -c "index.html.bak" 2>/dev/null || echo 0)

if [ "$HTML_COUNT" -gt 3 ]; then
  REMOVE_COUNT=$((HTML_COUNT - 3))
  echo "$LOG_PREFIX Found $HTML_COUNT HTML backups, removing $REMOVE_COUNT"
  echo "$HTML_BACKUPS" | tail -n "$REMOVE_COUNT" | while read -r f; do
    rm -f "$f"
  done
fi

# 2. Clean old backend module backups (keep last 2 per file)
for dir in /opt/rangerai-agent /opt/rangerai-agent/modules /opt/rangerai-agent/worker; do
  BAKS=$(ls "$dir"/*.bak-* 2>/dev/null | sort -r || true)
  if [ -n "$BAKS" ]; then
    # Group by base name, keep 2 newest per group
    echo "$BAKS" | sed 's/\.bak-[0-9]*$//' | sort -u | while read -r base; do
      MATCHES=$(ls "${base}".bak-* 2>/dev/null | sort -r || true)
      COUNT=$(echo "$MATCHES" | wc -l)
      if [ "$COUNT" -gt 2 ]; then
        echo "$MATCHES" | tail -n $((COUNT - 2)) | while read -r old; do
          echo "$LOG_PREFIX  Removing old backup: $(basename "$old")"
          rm -f "$old"
        done
      fi
    done
  fi
done

# 3. Clean old log files (compress logs older than 7 days, delete older than 30 days)
LOG_DIR="/opt/rangerai-agent/logs"
if [ -d "$LOG_DIR" ]; then
  # Compress logs older than 7 days
  find "$LOG_DIR" -name "*.log" -mtime +7 -not -name "*.gz" -exec gzip {} \; 2>/dev/null || true
  COMPRESSED=$(find "$LOG_DIR" -name "*.gz" -mtime +7 2>/dev/null | wc -l)
  echo "$LOG_PREFIX Compressed $COMPRESSED log files older than 7 days"
  
  # Delete compressed logs older than 30 days
  DELETED=$(find "$LOG_DIR" -name "*.gz" -mtime +30 -delete -print 2>/dev/null | wc -l)
  echo "$LOG_PREFIX Deleted $DELETED compressed logs older than 30 days"
fi

# 4. Clean /opt/rangerai-agent/backups (keep last 5)
BACKUP_ARCHIVE="/opt/rangerai-agent/backups"
if [ -d "$BACKUP_ARCHIVE" ]; then
  ARCHIVE_COUNT=$(ls "$BACKUP_ARCHIVE"/ 2>/dev/null | wc -l)
  if [ "$ARCHIVE_COUNT" -gt 5 ]; then
    REMOVE_COUNT=$((ARCHIVE_COUNT - 5))
    echo "$LOG_PREFIX Found $ARCHIVE_COUNT archived backups, removing $REMOVE_COUNT"
    ls -t "$BACKUP_ARCHIVE"/ | tail -n "$REMOVE_COUNT" | while read -r item; do
      rm -rf "$BACKUP_ARCHIVE/$item"
    done
  fi
fi

# 5. Clean deleted OpenClaw session files
find /opt/openclaw-data/sessions/ -name "*.deleted" -mtime +1 -delete 2>/dev/null || true

# Report
echo "$LOG_PREFIX Cleanup complete."
echo "$LOG_PREFIX Disk usage: $(df -h / | tail -1 | awk '{print $3 " used / " $2 " total (" $5 ")"}')"
