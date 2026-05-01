#!/bin/bash
# Enhanced Watchdog v2: health check + error rate monitoring + DingTalk alerts
SERVICE=$1
PORT=$2
HEALTH_PATH=${3:-/api/health}
FAIL_COUNT_FILE="/tmp/watchdog-${SERVICE}-fails"
ERROR_RATE_FILE="/tmp/watchdog-${SERVICE}-errors"
MAX_FAILS=3
MAX_ERROR_RATE=20  # errors per minute threshold

# Initialize
[ ! -f "$FAIL_COUNT_FILE" ] && echo 0 > "$FAIL_COUNT_FILE"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# ── Alert Function (defined before first use) ──
send_alert() {
    local TITLE="$1"
    local MSG="$2"
    # DingTalk webhook (if configured in secrets)
    WEBHOOK_URL=$(python3 -c "
import json
try:
    with open('/opt/rangerai-agent/agent-secrets.json') as f:
        d = json.load(f)
    print(d.get('DINGTALK_WEBHOOK', ''))
except: pass
" 2>/dev/null)
    
    if [ -n "$WEBHOOK_URL" ]; then
        curl -s -X POST "$WEBHOOK_URL" \
            -H 'Content-Type: application/json' \
            -d "{\"msgtype\":\"text\",\"text\":{\"content\":\"[RangerAI Alert] ${TITLE}: ${MSG} at ${TIMESTAMP}\"}}" \
            > /dev/null 2>&1
    fi
}


# ── Health Check ──
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "http://127.0.0.1:${PORT}${HEALTH_PATH}" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
    echo 0 > "$FAIL_COUNT_FILE"
else
    FAILS=$(cat "$FAIL_COUNT_FILE")
    FAILS=$((FAILS + 1))
    echo "$FAILS" > "$FAIL_COUNT_FILE"
    echo "[$TIMESTAMP] ${SERVICE} health check failed (${HTTP_CODE}), count: ${FAILS}/${MAX_FAILS}" >> /var/log/rangerai-watchdog.log

    if [ "$FAILS" -ge "$MAX_FAILS" ]; then
        echo "[$TIMESTAMP] RESTART: ${SERVICE} failed ${MAX_FAILS} consecutive checks" >> /var/log/rangerai-watchdog.log
        systemctl restart "$SERVICE"
        echo 0 > "$FAIL_COUNT_FILE"
        send_alert "Service Restart" "${SERVICE} restarted after ${MAX_FAILS} consecutive health check failures"
    fi
fi

# ── Error Rate Check (only for services with JSON logs) ──
LOG_FILE="/var/log/${SERVICE}.log"
if [ -f "$LOG_FILE" ]; then
    # Count errors in last 2 minutes
    RECENT_ERRORS=$(awk -v cutoff="$(date -u -d '2 minutes ago' '+%Y-%m-%dT%H:%M')" '$0 ~ /"level":"error"/ && $0 > cutoff' "$LOG_FILE" 2>/dev/null | wc -l)
    
    PREV_ERRORS=$(cat "$ERROR_RATE_FILE" 2>/dev/null || echo 0)
    echo "$RECENT_ERRORS" > "$ERROR_RATE_FILE"
    
    if [ "$RECENT_ERRORS" -gt "$MAX_ERROR_RATE" ] && [ "$RECENT_ERRORS" -gt "$PREV_ERRORS" ]; then
        echo "[$TIMESTAMP] ERROR_SPIKE: ${SERVICE} has ${RECENT_ERRORS} errors in last 2 min (threshold: ${MAX_ERROR_RATE})" >> /var/log/rangerai-watchdog.log
        send_alert "Error Spike" "${SERVICE}: ${RECENT_ERRORS} errors in last 2 minutes (threshold: ${MAX_ERROR_RATE})"


    fi
fi

