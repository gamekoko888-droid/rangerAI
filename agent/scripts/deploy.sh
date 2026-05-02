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

# ─── Resolve admin JWT token ───
resolve_token() {
    # Priority 1: Explicit JWT env vars (set by deploy/CI pipeline)
    if [ -n "$ADMIN_JWT" ]; then
        echo "$ADMIN_JWT"
        return
    fi
    if [ -n "$CI_AUTH_TOKEN" ]; then
        echo "$CI_AUTH_TOKEN"
        return
    fi
    # Priority 2: Token file (must contain an admin JWT)
    if [ -f "$HOME/.rangerai-ci-token" ]; then
        cat "$HOME/.rangerai-ci-token"
        return
    fi
    # Priority 3: Login API using admin credentials; never log credentials
    local login_user=""
    local login_pass=""
    if [ -n "$ADMIN_EMAIL" ] && [ -n "$ADMIN_PASSWORD" ]; then
        login_user="$ADMIN_EMAIL"
        login_pass="$ADMIN_PASSWORD"
    elif [ -n "$ADMIN_USERNAME" ] && [ -n "$ADMIN_PASSWORD" ]; then
        login_user="$ADMIN_USERNAME"
        login_pass="$ADMIN_PASSWORD"
    elif [ -n "$RANGERAI_USER" ] && [ -n "$RANGERAI_PASS" ]; then
        login_user="$RANGERAI_USER"
        login_pass="$RANGERAI_PASS"
    fi
    if [ -n "$login_user" ] && [ -n "$login_pass" ]; then
        curl -s -X POST http://127.0.0.1:3002/api/auth/login \
            -H "Content-Type: application/json" \
            -d "{\"username\":\"$login_user\",\"password\":\"$login_pass\"}" \
            | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null
        return
    fi
    echo ""
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
  HEALTH_BODY=$(curl -s -m 5 http://127.0.0.1:3002/api/health 2>/dev/null)
  if [ -n "$HEALTH_BODY" ] && echo "$HEALTH_BODY" | grep -q '"status"'; then
    HEALTH_SUMMARY=$(echo "$HEALTH_BODY" | head -c 500)
    log "  ✓ Health check passed (attempt $i) — $HEALTH_SUMMARY"
    break
  fi
  if [ "$i" = "$MAX_RETRIES" ]; then
    fail "Health check failed after $MAX_RETRIES attempts (last body: ${HEALTH_BODY:0:200})"
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

# ── Step 8: Admin services status check ──
log "Step 8: Admin services status..."
TOKEN=$(resolve_token)
if [ -z "$TOKEN" ]; then
  fail "services/status check requires admin JWT. Set ADMIN_JWT, CI_AUTH_TOKEN, ADMIN_EMAIL/ADMIN_PASSWORD, ADMIN_USERNAME/ADMIN_PASSWORD, RANGERAI_USER/RANGERAI_PASS, or ~/.rangerai-ci-token"
fi
SS_TMP=$(mktemp)
SS_HTTP_CODE=$(curl -s -m 10 -o "$SS_TMP" -w "%{http_code}" http://127.0.0.1:3002/api/admin/services/status \
    -H "Authorization: Bearer $TOKEN" 2>/dev/null || echo "000")
SS_BODY=$(cat "$SS_TMP" 2>/dev/null)
rm -f "$SS_TMP"
SS_SUMMARY=$(echo "$SS_BODY" | head -c 500)
log "  Services status raw response summary — $SS_SUMMARY"
SS_CODE=$(echo "$SS_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d.get('ok') else 'FAIL')" 2>/dev/null || echo "PARSE_ERR")
if [ "$SS_HTTP_CODE" = "200" ] && [ "$SS_CODE" = "OK" ]; then
  log "  ✓ Services status OK"
else
  fail "services/status check failed (HTTP $SS_HTTP_CODE, parsed=$SS_CODE)"
fi

log "═══ Deploy pipeline completed successfully ═══"
echo ""
echo "✅ Deploy complete! All checks passed."
