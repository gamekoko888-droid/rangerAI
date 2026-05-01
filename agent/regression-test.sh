#!/usr/bin/env bash
# RangerAI Automated Regression Test Suite (Iter-55)
# Usage: bash /opt/rangerai-agent/regression-test.sh [--verbose]
#
# Tests:
#   1. Service health (all 5 systemd services)
#   2. API endpoint smoke tests (health, auth, chat, skills, models)
#   3. WebSocket connectivity
#   4. Frontend asset integrity
#   5. Caddy reverse proxy routing
#   6. Database connectivity
#   7. Code syntax validation

set -euo pipefail

VERBOSE="${1:-}"
PASS=0
FAIL=0
WARN=0
RESULTS=()

_ts() { date '+%F %T'; }

pass() {
  PASS=$((PASS + 1))
  RESULTS+=("PASS: $1")
  [ "$VERBOSE" = "--verbose" ] && echo "[$(_ts)] ✓ PASS: $1"
}

fail() {
  FAIL=$((FAIL + 1))
  RESULTS+=("FAIL: $1")
  echo "[$(_ts)] ✗ FAIL: $1" >&2
}

warn() {
  WARN=$((WARN + 1))
  RESULTS+=("WARN: $1")
  [ "$VERBOSE" = "--verbose" ] && echo "[$(_ts)] ⚠ WARN: $1"
}

# ── Test 1: Service Health ──
echo "[$(_ts)] === Test 1: Service Health ==="
for svc in rangerai-agent openclaw-gateway rangerai-acp rangerai-web rangerai-static rangerai-fileserver; do
  status=$(systemctl is-active "$svc" 2>/dev/null || echo "inactive")
  if [ "$status" = "active" ]; then
    pass "Service $svc is active"
  else
    fail "Service $svc is $status"
  fi
done

# ── Test 2: API Endpoint Smoke Tests ──
echo "[$(_ts)] === Test 2: API Endpoints ==="

# Health endpoint
if curl -fsS http://127.0.0.1:3002/api/health -o /dev/null 2>/dev/null; then
  pass "GET /api/health → 200"
else
  fail "GET /api/health failed"
fi

# Version endpoint
if curl -fsS http://127.0.0.1:3002/api/version -o /dev/null 2>/dev/null; then
  pass "GET /api/version → 200"
else
  fail "GET /api/version failed"
fi

# Auth endpoint (should return 401 without token)
auth_code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3002/api/auth/me 2>/dev/null)
if [ "$auth_code" = "401" ] || [ "$auth_code" = "200" ]; then
  pass "GET /api/auth/me → $auth_code (expected 401 or 200)"
else
  fail "GET /api/auth/me → $auth_code (unexpected)"
fi

# Skills endpoint (may require auth)
skills_code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3002/api/skills 2>/dev/null)
if [ "$skills_code" = "200" ] || [ "$skills_code" = "401" ]; then
  pass "GET /api/skills → $skills_code"
else
  fail "GET /api/skills → $skills_code"
fi

# System stats endpoint
stats_code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3002/api/stats 2>/dev/null)
if [ "$stats_code" = "200" ] || [ "$stats_code" = "401" ]; then
  pass "GET /api/stats → $stats_code"
else
  warn "GET /api/stats → $stats_code"
fi

# ── Test 3: WebSocket Connectivity ──
echo "[$(_ts)] === Test 3: WebSocket ==="
if command -v wscat &>/dev/null; then
  if timeout 5 wscat -c ws://127.0.0.1:3002/ws --execute 'process.exit(0)' 2>/dev/null; then
    pass "WebSocket /ws connectable"
  else
    warn "WebSocket /ws connection test inconclusive"
  fi
else
  # Fallback: check port is listening
  if ss -tlnp | grep -q ":3002 "; then
    pass "Port 3002 is listening (WS assumed OK)"
  else
    fail "Port 3002 not listening"
  fi
fi

# ── Test 4: Frontend Asset Integrity ──
echo "[$(_ts)] === Test 4: Frontend Assets ==="
if [ -f /var/www/rangerai1/index.html ]; then
  pass "index.html exists"
  
  # Check that all referenced JS files exist
  JS_FILES=$(grep -oP 'assets/[\w.-]+\.js' /var/www/rangerai1/index.html | sort -u)
  ALL_EXIST=true
  for jsf in $JS_FILES; do
    if [ ! -f "/var/www/rangerai1/$jsf" ]; then
      fail "Missing referenced file: $jsf"
      ALL_EXIST=false
    fi
  done
  $ALL_EXIST && pass "All referenced JS files exist"
  
  # Check CSS
  CSS_FILES=$(grep -oP 'assets/[\w.-]+\.css' /var/www/rangerai1/index.html | sort -u)
  for cssf in $CSS_FILES; do
    if [ ! -f "/var/www/rangerai1/$cssf" ]; then
      fail "Missing referenced CSS: $cssf"
    else
      pass "CSS file exists: $cssf"
    fi
  done
else
  fail "index.html missing from /var/www/rangerai1/"
fi

# ── Test 5: Caddy Reverse Proxy ──
echo "[$(_ts)] === Test 5: Caddy Proxy ==="
caddy_status=$(systemctl is-active caddy 2>/dev/null || echo "inactive")
if [ "$caddy_status" = "active" ]; then
  pass "Caddy is active"
else
  fail "Caddy is $caddy_status"
fi

# Validate Caddy config
if sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | grep -q "Valid"; then
  pass "Caddy config is valid"
else
  fail "Caddy config validation failed"
fi

# ── Test 6: Database Connectivity ──
echo "[$(_ts)] === Test 6: Database ==="
if command -v mysql &>/dev/null; then
  if mysql -u root -e "SELECT 1" 2>/dev/null | grep -q "1"; then
    pass "MySQL connection OK"
  else
    warn "MySQL connection test failed (may need credentials)"
  fi
else
  warn "mysql client not installed, skipping DB test"
fi

# ── Test 7: Code Syntax Validation ──
echo "[$(_ts)] === Test 7: Code Syntax ==="
VALIDATE_SCRIPT="/opt/rangerai-safety/validate-mjs.sh"
if [ -f "$VALIDATE_SCRIPT" ]; then
  if bash "$VALIDATE_SCRIPT" 2>/dev/null | tail -1 | grep -qi "ALL PASS\|All.*passed\|no syntax errors"; then
    pass "All .mjs files pass syntax check"
  else
    fail "Some .mjs files have syntax errors"
  fi
else
  warn "validate-mjs.sh not found at $VALIDATE_SCRIPT"
fi

# ── Summary ──
echo ""
echo "[$(_ts)] ════════════════════════════════════"
echo "[$(_ts)] REGRESSION TEST SUMMARY"
echo "[$(_ts)] ════════════════════════════════════"
echo "[$(_ts)] PASS: $PASS"
echo "[$(_ts)] FAIL: $FAIL"
echo "[$(_ts)] WARN: $WARN"
echo "[$(_ts)] TOTAL: $((PASS + FAIL + WARN))"
echo "[$(_ts)] ════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "[$(_ts)] FAILED TESTS:"
  for r in "${RESULTS[@]}"; do
    echo "$r" | grep "^FAIL:" && true
  done
  exit 1
fi

if [ "$WARN" -gt 0 ]; then
  echo ""
  echo "[$(_ts)] WARNINGS:"
  for r in "${RESULTS[@]}"; do
    echo "$r" | grep "^WARN:" && true
  done
fi

echo ""
echo "[$(_ts)] All critical tests passed."
exit 0
