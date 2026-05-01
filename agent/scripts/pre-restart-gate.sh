#!/bin/bash
# [R36-T4] Pre-restart syntax gate
# Runs before systemd restarts services to catch syntax errors early
# Exit 1 = block restart, Exit 0 = allow restart

PROJECT_DIR="/opt/rangerai-agent"
FAIL=0

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [R36-T4] Running pre-restart syntax gate..."

# Check critical entry points only (fast, <2s)
CRITICAL_MODULES=(
  "server.mjs"
  "api-server.mjs"
  "ws-realtime.mjs"
  "worker/index.mjs"
  "worker/user-message-handler.mjs"
  "worker/knowledge-injector.mjs"
  "worker/openclaw-handler.mjs"
  "worker/context-window-manager.mjs"
  "worker/event-stream.mjs"
  "modules/http-router.mjs"
  "modules/ws-handler.mjs"
  "modules/worker-manager.mjs"
)

for mod in "${CRITICAL_MODULES[@]}"; do
  if [ -f "$PROJECT_DIR/$mod" ]; then
    if ! node --check "$PROJECT_DIR/$mod" 2>/dev/null; then
      echo "  ✗ BLOCKED: Syntax error in $mod"
      FAIL=$((FAIL + 1))
    fi
  fi
done

if [ "$FAIL" -gt 0 ]; then
  echo "  ✗ RESTART BLOCKED: $FAIL critical module(s) have syntax errors"
  echo "  Fix the errors before restarting."
  exit 1
fi

# Quick health check: can we import the entry point?
echo "  ✓ PASS: All critical modules syntax OK"
exit 0
