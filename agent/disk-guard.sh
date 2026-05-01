#!/bin/bash
# disk-guard.sh — Iter-AF (v25.25)
# 预防性日志清理：当特定大文件超阈值时自动截断
# 由 OpenClaw cron 每天凌晨 3 点触发

LOG_FILE="/opt/rangerai-agent/logs/disk-cleanup.log"
TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")

log() { echo "[$TIMESTAMP] $1" >> "$LOG_FILE"; }

# 1. gateway-memory-monitor.log 超 50MB 截断到最后 1MB
GW_LOG="/var/log/gateway-memory-monitor.log"
if [ -f "$GW_LOG" ]; then
  SIZE=$(du -m "$GW_LOG" 2>/dev/null | cut -f1)
  if [ "${SIZE:-0}" -gt 50 ]; then
    tail -c 1048576 "$GW_LOG" > /tmp/gw-log-tail.tmp && mv /tmp/gw-log-tail.tmp "$GW_LOG"
    log "CLEANED gateway-memory-monitor.log (was ${SIZE}MB)"
  else
    log "OK gateway-memory-monitor.log ${SIZE}MB"
  fi
fi

# 2. rangerai-agent logs 超 500MB 清理 7 天前文件
AGENT_LOG_SIZE=$(du -sm /opt/rangerai-agent/logs/ 2>/dev/null | cut -f1)
if [ "${AGENT_LOG_SIZE:-0}" -gt 500 ]; then
  find /opt/rangerai-agent/logs/ -name "*.log" -mtime +7 -delete
  log "CLEANED old logs (was ${AGENT_LOG_SIZE}MB)"
fi

# 3. 总磁盘使用检查
DISK_PCT=$(df / | tail -1 | awk "{print $5}" | tr -d "%")
log "DISK_USAGE=${DISK_PCT}%"
if [ "${DISK_PCT:-0}" -gt 85 ]; then
  log "WARN disk ${DISK_PCT}% > 85%"
fi
log "disk-guard done"
