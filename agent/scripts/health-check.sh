#!/bin/bash
# RangerAI Health Check & Alert Script
# Run via cron every 5 minutes

LOG_FILE="/var/log/rangerai-health.log"
ALERT_FILE="/tmp/rangerai-alert-sent"
TS=$(date '+%Y-%m-%d %H:%M:%S')

check_service() {
    local name=$1
    local port=$2
    local path=${3:-"/"}
    
    if curl -sf --max-time 5 "http://127.0.0.1:${port}${path}" > /dev/null 2>&1; then
        echo "${TS} [OK] ${name} (port ${port})" >> "$LOG_FILE"
        return 0
    else
        echo "${TS} [FAIL] ${name} (port ${port})" >> "$LOG_FILE"
        return 1
    fi
}

check_process() {
    local name=$1
    if systemctl is-active --quiet "$name" 2>/dev/null; then
        echo "${TS} [OK] ${name} service active" >> "$LOG_FILE"
        return 0
    else
        echo "${TS} [FAIL] ${name} service down" >> "$LOG_FILE"
        return 1
    fi
}

FAILURES=0

# Check core services
check_process "rangerai-agent" || ((FAILURES++))
# rangerai-static is not a systemd service; check process directly
if pgrep -f "static-server" > /dev/null 2>&1; then
    echo "${TS} [OK] static-server process running" >> "$LOG_FILE"
else
    echo "${TS} [FAIL] static-server process not found" >> "$LOG_FILE"
    ((FAILURES++))
fi
check_process "caddy" || ((FAILURES++))
check_process "openclaw-gateway" || ((FAILURES++))

# Check HTTP endpoints
check_service "Frontend" 3001 "/" || ((FAILURES++))
check_service "API" 3002 "/api/stats" || ((FAILURES++))

# Check disk space (alert if < 10%)
DISK_USAGE=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
if [ "$DISK_USAGE" -gt 90 ]; then
    echo "${TS} [WARN] Disk usage at ${DISK_USAGE}%" >> "$LOG_FILE"
    ((FAILURES++))
fi

# Check memory (alert if < 10% free)
MEM_FREE_PCT=$(free | awk '/Mem:/ {printf "%.0f", $7/$2*100}')
if [ "$MEM_FREE_PCT" -lt 10 ]; then
    echo "${TS} [WARN] Memory free at ${MEM_FREE_PCT}%" >> "$LOG_FILE"
    ((FAILURES++))
fi

# Check for crash loops (more than 3 restarts in last hour)
RESTARTS=$(journalctl -u rangerai-agent --since "1 hour ago" 2>/dev/null | grep -c "Started\|Stopped" 2>/dev/null || echo 0)
RESTARTS=$(echo "$RESTARTS" | head -1 | tr -dc "0-9")
RESTARTS=${RESTARTS:-0}
if [ "$RESTARTS" -gt 6 ]; then
    echo "${TS} [WARN] Agent restarted ${RESTARTS} times in last hour (crash loop?)" >> "$LOG_FILE"
    ((FAILURES++))
fi

if [ "$FAILURES" -gt 0 ]; then
    echo "${TS} [ALERT] ${FAILURES} health check failures detected" >> "$LOG_FILE"
    
    # Auto-restart failed services
    for svc in rangerai-agent caddy openclaw-gateway; do
        if ! systemctl is-active --quiet "$svc" 2>/dev/null; then
            echo "${TS} [AUTO-HEAL] Restarting ${svc}" >> "$LOG_FILE"
            systemctl restart "$svc" 2>/dev/null || true
        fi
    done
else
    echo "${TS} [OK] All health checks passed" >> "$LOG_FILE"
    # Clear alert flag
    rm -f "$ALERT_FILE"
fi

# Rotate log if > 10MB
if [ -f "$LOG_FILE" ] && [ $(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null) -gt 10485760 ]; then
    tail -1000 "$LOG_FILE" > "${LOG_FILE}.tmp"
    mv "${LOG_FILE}.tmp" "$LOG_FILE"
fi
