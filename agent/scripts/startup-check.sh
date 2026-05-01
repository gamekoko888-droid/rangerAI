#!/bin/bash
AGENT_DIR="/opt/rangerai-agent"
ERRORS=0
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Running startup integrity check..."

# Required source modules
REQUIRED_MODULES=(
  "api-server.mjs" "lib/logger.mjs" "lib/context.mjs" "lib/metrics-collector.mjs"
  "modules/http-router.mjs" "modules/ws-handler.mjs" "modules/worker-manager.mjs"
  "modules/event-buffer.mjs" "modules/routes/infra-routes.mjs"
  "modules/routes/admin-routes.mjs" "modules/routes/task-routes.mjs"
  "modules/routes/static-routes.mjs" "auth.mjs" "api/auth-api.mjs"
)
for mod in "${REQUIRED_MODULES[@]}"; do
  if [ ! -f "$AGENT_DIR/$mod" ]; then
    echo "  ERROR: Missing: $mod"; ERRORS=$((ERRORS + 1))
  fi
done

# Check node_modules exists
if [ ! -d "$AGENT_DIR/node_modules" ]; then
  echo "  ERROR: node_modules missing"; ERRORS=$((ERRORS + 1))
fi

# Check actual npm dependencies used by the project
for dep in mysql2 ws redis; do
  if [ ! -d "$AGENT_DIR/node_modules/$dep" ]; then
    echo "  ERROR: Missing dep: $dep"; ERRORS=$((ERRORS + 1))
  fi
done

# Check log directory
[ ! -d "$AGENT_DIR/logs" ] && mkdir -p "$AGENT_DIR/logs"

# Check file permissions
if [ ! -r "$AGENT_DIR/api-server.mjs" ]; then
  echo "  ERROR: api-server.mjs not readable"; ERRORS=$((ERRORS + 1))
fi

if [ $ERRORS -gt 0 ]; then
  echo "  FAILED: $ERRORS errors. Aborting."; exit 1
else
  echo "  PASSED: All integrity checks passed ($((${#REQUIRED_MODULES[@]} + 3)) items verified)."; exit 0
fi
