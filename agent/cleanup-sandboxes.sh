#!/bin/bash
# RangerAI Sandbox Cleanup - runs every 6 hours
# NOTE(2026-03-06): 为避免引发“worker 异常重连/WS 断连风暴”，本脚本不再自动重启 openclaw-gateway / rangerai-agent。
# 仅记录异常指标到日志，供人工处理。

set -euo pipefail

LOG="/var/log/rangerai-cleanup.log"
TS=$(date "+%Y-%m-%d %H:%M:%S")

# Count containers
COUNT=$(docker ps -q --filter "name=openclaw-sbx" | wc -l)
echo "[$TS] Sandbox containers: $COUNT" >> "$LOG"

# Remove containers older than 2 hours
if [ "$COUNT" -gt 10 ]; then
  OLD=$(docker ps --filter "name=openclaw-sbx" --format "{{.ID}} {{.RunningFor}}" | grep -E "hours|days|weeks" | awk "{print \$1}")
  if [ -n "$OLD" ]; then
    REMOVED=$(echo "$OLD" | xargs docker rm -f 2>/dev/null | wc -l)
    echo "[$TS] Removed $REMOVED old containers" >> "$LOG"
  fi
fi

# If still more than 50, force cleanup all
COUNT2=$(docker ps -q --filter "name=openclaw-sbx" | wc -l)
if [ "$COUNT2" -gt 50 ]; then
  docker rm -f $(docker ps -q --filter "name=openclaw-sbx") 2>/dev/null || true
  echo "[$TS] Force cleaned all sandbox containers (was $COUNT2)" >> "$LOG"
fi

# Docker prune
docker system prune -f >> /dev/null 2>&1 || true
echo "[$TS] Cleanup complete" >> "$LOG"

# v20.3: Check OpenClaw browser service health (log only)
BROWSER_ERRORS=$(cat /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log 2>/dev/null | grep -c "Can\x27t reach the OpenClaw browser control" 2>/dev/null || echo 0)
BROWSER_ERRORS=$(echo "$BROWSER_ERRORS" | head -n 1 | tr -cd '0-9')
BROWSER_ERRORS=${BROWSER_ERRORS:-0}
if [ "$BROWSER_ERRORS" -gt 5 ]; then
  echo "[$TS] WARN: Browser service unhealthy ($BROWSER_ERRORS errors). (no auto-restart)" >> "$LOG"
  echo "[$TS] ACTION: Please inspect OpenClaw Gateway/Browser. Suggest: check openclaw status + gateway logs." >> "$LOG"
fi

# v20.4: Gateway memory monitoring (log only)
GATEWAY_PID=$(pgrep -f openclaw-gateway -o 2>/dev/null || true)
if [ -n "$GATEWAY_PID" ]; then
  GATEWAY_RSS=$(grep VmRSS /proc/$GATEWAY_PID/status 2>/dev/null | awk "{print \$2}" || true)
  if [ -n "$GATEWAY_RSS" ]; then
    if [ "$GATEWAY_RSS" -gt 1572864 ]; then
      echo "[$TS] WARN: Gateway RSS ${GATEWAY_RSS}kB > 1.5GB. (no auto-restart)" >> "$LOG"
      echo "[$TS] ACTION: Consider manual gateway restart during maintenance window." >> "$LOG"
    else
      echo "[$TS] Gateway RSS: ${GATEWAY_RSS}kB (OK)" >> "$LOG"
    fi
  fi
fi
