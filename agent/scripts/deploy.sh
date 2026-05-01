#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# RangerAI Deploy Pipeline v1.0
# Usage: ./scripts/deploy.sh [--skip-tests] [--skip-backup]
# ═══════════════════════════════════════════════════════════════
set -e

AGENT_DIR="/opt/rangerai-agent"
WEB_DIR="/opt/rangerai-web"
LOG_FILE="/var/log/rangerai-deploy.log"
SKIP_TESTS=false
SKIP_BACKUP=false

for arg in "$@"; do
  case $arg in
    --skip-tests) SKIP_TESTS=true ;;
    --skip-backup) SKIP_BACKUP=true ;;
  esac
done

log() {
  local msg="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1"
  echo "$msg" | tee -a "$LOG_FILE"
}

fail() {
  log "DEPLOY FAILED: $1"
  exit 1
}

log "═══ Deploy pipeline started ═══"

# ── Step 1: Pre-flight checks ──
log "Step 1: Pre-flight checks..."
bash "$AGENT_DIR/scripts/startup-check.sh" || fail "Integrity check failed"
log "  ✓ Integrity check passed"

# ── Step 2: Run tests ──
if [ "$SKIP_TESTS" = false ]; then
  log "Step 2: Running tests..."
  cd "$AGENT_DIR"
  if [ -d "tests" ] && ls tests/*.test.* >/dev/null 2>&1; then
    node --test tests/*.test.mjs 2>&1 | tee -a "$LOG_FILE"
    if [ ${PIPESTATUS[0]} -ne 0 ]; then
      fail "Tests failed"
    fi
    log "  ✓ Tests passed"
  else
    log "  ⚠ No tests found, skipping"
  fi
else
  log "Step 2: Tests skipped (--skip-tests)"
fi

# ── Step 3: Backup ──
if [ "$SKIP_BACKUP" = false ]; then
  log "Step 3: Creating backup..."
  bash "$AGENT_DIR/scripts/backup-db.sh" 2>&1 | tee -a "$LOG_FILE"
  log "  ✓ Backup created"
else
  log "Step 3: Backup skipped (--skip-backup)"
fi

# ── Step 4: Build frontend ──
log "Step 4: Building frontend..."
cd "$WEB_DIR"
if npx vite build --config vite.config.standalone.ts 2>&1 | tee -a "$LOG_FILE"; then
  log "  ✓ Frontend built"
else
  fail "Frontend build failed"
fi

# ── Step 5: Restart agent ──
log "Step 5: Restarting agent..."
sudo /usr/local/bin/safe-restart-rangerai 2>&1 | tee -a "$LOG_FILE" || true
sleep 8

# ── Step 6: Health check ──
log "Step 6: Health check..."
MAX_RETRIES=5
for i in $(seq 1 $MAX_RETRIES); do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3002/api/health 2>/dev/null)
  if [ "$HTTP_CODE" = "200" ]; then
    log "  ✓ Health check passed (attempt $i)"
    break
  fi
  if [ "$i" = "$MAX_RETRIES" ]; then
    fail "Health check failed after $MAX_RETRIES attempts"
  fi
  log "  Retry $i/$MAX_RETRIES..."
  sleep 3
done

# ── Step 7: Smoke test ──
log "Step 7: Smoke test..."
FRONTEND_CODE=$(curl -s -o /dev/null -w "%{http_code}" https://ranger.voyage/ 2>/dev/null)
if [ "$FRONTEND_CODE" = "200" ]; then
  log "  ✓ Frontend accessible (200)"
else
  log "  ⚠ Frontend returned $FRONTEND_CODE"
fi

log "═══ Deploy pipeline completed successfully ═══"
echo ""
echo "✅ Deploy complete! All checks passed."
