#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# RangerAI Rollback Script
# Usage: ./scripts/rollback.sh [commit-hash]
# Without args: rolls back to previous commit
# ═══════════════════════════════════════════════════════════════
set -e

AGENT_DIR="/opt/rangerai-agent"
WEB_DIR="/opt/rangerai-web"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1"; }

TARGET=${1:-"HEAD~1"}

log "Rolling back agent to $TARGET..."
cd "$AGENT_DIR"
git stash 2>/dev/null || true
git checkout "$TARGET" -- . 2>/dev/null || git reset --hard "$TARGET"
log "  ✓ Agent rolled back"

log "Rolling back web to $TARGET..."
cd "$WEB_DIR"
git stash 2>/dev/null || true
git checkout "$TARGET" -- . 2>/dev/null || git reset --hard "$TARGET"
log "  ✓ Web rolled back"

log "Rebuilding frontend..."
cd "$WEB_DIR" && npx vite build --config vite.config.standalone.ts 2>&1 | tail -3

log "Restarting agent..."
sudo /usr/local/bin/safe-restart-rangerai 2>&1 || true
sleep 8

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3002/api/health 2>/dev/null)
if [ "$HTTP_CODE" = "200" ]; then
  log "✅ Rollback complete, health check passed"
else
  log "⚠ Rollback complete but health check returned $HTTP_CODE"
fi
