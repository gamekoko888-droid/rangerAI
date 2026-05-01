#!/bin/bash
# RangerAI Database Backup Script
# Usage: bash /opt/rangerai-agent/scripts/backup-db.sh
# Recommended: Add to crontab: 0 3 * * * /opt/rangerai-agent/scripts/backup-db.sh

BACKUP_DIR="/opt/backups/mysql"
RETENTION_DAYS=7
DATE=$(date +%Y%m%d_%H%M%S)
MYSQL_PASS=$(docker inspect mysql-rangerai --format "{{range .Config.Env}}{{println .}}{{end}}" | grep MYSQL_ROOT_PASSWORD | cut -d= -f2)

mkdir -p "$BACKUP_DIR"

echo "[$(date)] Starting MySQL backup..."
docker exec mysql-rangerai mysqldump -uroot -p"$MYSQL_PASS" --all-databases --single-transaction --routines --triggers > "$BACKUP_DIR/rangerai_full_$DATE.sql" 2>/dev/null

if [ $? -eq 0 ]; then
  gzip "$BACKUP_DIR/rangerai_full_$DATE.sql"
  SIZE=$(du -h "$BACKUP_DIR/rangerai_full_$DATE.sql.gz" | cut -f1)
  echo "[$(date)] Backup completed: rangerai_full_$DATE.sql.gz ($SIZE)"
  
  # Clean old backups
  find "$BACKUP_DIR" -name "*.sql.gz" -mtime +$RETENTION_DAYS -delete
  echo "[$(date)] Cleaned backups older than $RETENTION_DAYS days"
else
  echo "[$(date)] ERROR: Backup failed!"
  exit 1
fi
