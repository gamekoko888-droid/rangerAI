#!/bin/bash
# ─── CI Gate Script for RangerAI ───
# Run before every deploy/commit to catch common issues.
# Exit code 0 = all checks pass, non-zero = blocked.
#
# Auth: Uses CI_AUTH_TOKEN env var, or reads from ~/.rangerai-ci-token file,
#       or falls back to RANGERAI_USER + RANGERAI_PASS env vars.
#       NEVER hardcode credentials in this script.
set -e
PROJECT_DIR="/opt/rangerai-agent"
FAIL=0
WARN=0
echo "═══════════════════════════════════════════"
echo "  RangerAI CI Gate Check"
echo "═══════════════════════════════════════════"

# ─── Resolve auth token ───
resolve_token() {
    # Priority 1: Explicit JWT env vars (set by CI/deploy pipeline)
    if [ -n "$ADMIN_JWT" ]; then
        echo "$ADMIN_JWT"
        return
    fi
    if [ -n "$CI_AUTH_TOKEN" ]; then
        echo "$CI_AUTH_TOKEN"
        return
    fi
    # Priority 2: Token file (created by `rangerai-login` or manually; must be a JWT)
    if [ -f "$HOME/.rangerai-ci-token" ]; then
        cat "$HOME/.rangerai-ci-token"
        return
    fi
    # Priority 3: Login API using admin/user credentials; never log credentials
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
    # Never read credentials from project config files
    echo ""
}

# ─── 1. No .bak/.bak-* files in working directory ───
echo ""
echo "▶ [1/7] Checking for backup file residue..."
BAK_COUNT=$(find "$PROJECT_DIR" -maxdepth 2 \( -name "*.bak" -o -name "*.bak-*" -o -name "*.orig" -o -name "*.pre-fix" \) \
    -not -path "*/.archive*" -not -path "*/node_modules/*" -not -path "*/backups/*" 2>/dev/null | wc -l)
if [ "$BAK_COUNT" -gt 0 ]; then
    echo "  ✗ FAIL: Found $BAK_COUNT backup files in working directory"
    find "$PROJECT_DIR" -maxdepth 2 \( -name "*.bak" -o -name "*.bak-*" -o -name "*.orig" -o -name "*.pre-fix" \) \
        -not -path "*/.archive*" -not -path "*/node_modules/*" -not -path "*/backups/*" 2>/dev/null | head -5
    FAIL=$((FAIL + 1))
else
    echo "  ✓ PASS: No backup file residue"
fi

# ─── 2. Unit tests must pass ───
echo ""
echo "▶ [2/7] Running unit tests..."
cd "$PROJECT_DIR"
if npm test --silent 2>&1 | tail -10 | grep -qiE "pass|passing|✓"; then
    TEST_RESULT=$(npm test --silent 2>&1 | tail -3)
    echo "  ✓ PASS: $TEST_RESULT"
else
    echo "  ✗ FAIL: Unit tests failed"
    npm test --silent 2>&1 | tail -10
    FAIL=$((FAIL + 1))
fi

# ─── 3. Smoke tests must pass ───
echo ""
echo "▶ [3/7] Running smoke tests..."
SMOKE_FOUND=0
for smoke_path in "$PROJECT_DIR/tests/smoke-test.sh" "$PROJECT_DIR/smoke-test.sh"; do
    if [ -f "$smoke_path" ]; then
        SMOKE_FOUND=1
        SMOKE_RESULT=$(bash "$smoke_path" 2>&1 | tail -5)
        if echo "$SMOKE_RESULT" | grep -q "RESULT: ALL PASS"; then
            PASS_COUNT=$(echo "$SMOKE_RESULT" | grep -oP '\d+ passed' | head -1)
            echo "  ✓ PASS: Smoke tests ($PASS_COUNT)"
        elif echo "$SMOKE_RESULT" | grep -q "FAIL\|fail\|Error"; then
            echo "  ✗ FAIL: Smoke tests failed"
            echo "$SMOKE_RESULT"
            FAIL=$((FAIL + 1))
        else
            echo "  ⚠ WARN: Smoke test result unclear"
            echo "$SMOKE_RESULT"
            WARN=$((WARN + 1))
        fi
        break
    fi
done
if [ "$SMOKE_FOUND" -eq 0 ]; then
    echo "  ⚠ WARN: No smoke-test.sh found in tests/ or project root"
    WARN=$((WARN + 1))
fi

# ─── 4. All required routes respond ───
echo ""
echo "▶ [4/7] Checking critical API routes..."
TOKEN=$(resolve_token)
if [ -z "$TOKEN" ]; then
    echo "  ⚠ WARN: No auth token available. Set CI_AUTH_TOKEN, RANGERAI_USER/RANGERAI_PASS,"
    echo "          or create ~/.rangerai-ci-token. Skipping authenticated route checks."
    WARN=$((WARN + 1))
else
    ROUTES_OK=0
    ROUTES_FAIL=0
    for route in "/api/health" "/api/skills" "/api/stats" "/api/prompts" "/api/knowledge" "/api/workflows" "/api/system/health-detail" "/api/admin/services/status"; do
        STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:3002${route}" -H "Authorization: Bearer $TOKEN" 2>/dev/null)
        CONTENT_TYPE=$(curl -s -o /dev/null -w "%{content_type}" "http://127.0.0.1:3002${route}" -H "Authorization: Bearer $TOKEN" 2>/dev/null)
        if [ "$STATUS" = "200" ] && echo "$CONTENT_TYPE" | grep -qi "json"; then
            ROUTES_OK=$((ROUTES_OK + 1))
        else
            echo "  ✗ $route → HTTP $STATUS (expected 200+JSON)"
            ROUTES_FAIL=$((ROUTES_FAIL + 1))
        fi
    done
    if [ "$ROUTES_FAIL" -gt 0 ]; then
        echo "  ✗ FAIL: $ROUTES_FAIL routes not responding correctly"
        FAIL=$((FAIL + 1))
    else
        echo "  ✓ PASS: All $ROUTES_OK critical routes OK"
    fi
fi

# ─── 5. No syntax errors in key modules ───
echo ""
echo "▶ [5/7] Checking module syntax (ALL .mjs files)..."
SYNTAX_FAIL=0
SYNTAX_OK=0
SYNTAX_ERRORS=""
# [R36-T4] Check ALL .mjs files, not just hardcoded list
while IFS= read -r mod; do
    REL_PATH="${mod#$PROJECT_DIR/}"
    node --check "$mod" 2>/tmp/syntax_err.txt
    if [ $? -ne 0 ]; then
        ERR_MSG=$(cat /tmp/syntax_err.txt | head -3)
        echo "  ✗ Syntax error in $REL_PATH"
        echo "    $ERR_MSG"
        SYNTAX_ERRORS="${SYNTAX_ERRORS}\n  - ${REL_PATH}: ${ERR_MSG}"
        SYNTAX_FAIL=$((SYNTAX_FAIL + 1))
    else
        SYNTAX_OK=$((SYNTAX_OK + 1))
    fi
done < <(find "$PROJECT_DIR" -name "*.mjs" -not -path "*/node_modules/*" -not -path "*/.git/*" -type f)
if [ "$SYNTAX_FAIL" -gt 0 ]; then
    echo "  ✗ FAIL: $SYNTAX_FAIL/$((SYNTAX_OK + SYNTAX_FAIL)) modules have syntax errors"
    echo "  Errors:$SYNTAX_ERRORS"
    FAIL=$((FAIL + 1))
else
    echo "  ✓ PASS: All $SYNTAX_OK modules syntax OK"
fi

# ─── 6. API 404 guard check (no SPA HTML for /api/*) ───
echo ""
echo "▶ [6/7] Checking API 404 guard..."
FAKE_API_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:3002/api/nonexistent-route-test" 2>/dev/null)
FAKE_API_CT=$(curl -s -o /dev/null -w "%{content_type}" "http://127.0.0.1:3002/api/nonexistent-route-test" 2>/dev/null)
if [ "$FAKE_API_RESPONSE" = "404" ] && echo "$FAKE_API_CT" | grep -qi "json"; then
    echo "  ✓ PASS: Unmatched /api/* returns 404 JSON"
else
    echo "  ✗ FAIL: /api/nonexistent-route-test returned HTTP $FAKE_API_RESPONSE (expected 404+JSON)"
    FAIL=$((FAIL + 1))
fi

# ─── 7. Full-stack health check (Iter-12A) ───
echo ""
echo "▶ [7/7] Running full-stack health check..."
HEALTH_CHECK="$PROJECT_DIR/scripts/health-check.mjs"
if [ -f "$HEALTH_CHECK" ]; then
    HC_OUTPUT=$(cd "$PROJECT_DIR" && node "$HEALTH_CHECK" --format=json 2>&1)
    HC_EXIT=$?
    HC_STATUS=$(echo "$HC_OUTPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','UNKNOWN'))" 2>/dev/null)
    HC_SUMMARY=$(echo "$HC_OUTPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('summary',''))" 2>/dev/null)
    if [ "$HC_EXIT" -eq 0 ]; then
        echo "  ✓ PASS: Health check — $HC_SUMMARY"
    elif [ "$HC_EXIT" -eq 1 ]; then
        echo "  ⚠ WARN: Health check — $HC_SUMMARY"
        WARN=$((WARN + 1))
    else
        echo "  ✗ FAIL: Health check — $HC_SUMMARY"
        FAIL=$((FAIL + 1))
    fi
else
    echo "  ⚠ WARN: health-check.mjs not found at $HEALTH_CHECK"
    WARN=$((WARN + 1))
fi

# ─── Summary ───
echo ""
echo "═══════════════════════════════════════════"
if [ "$FAIL" -gt 0 ]; then
    echo "  ✗ BLOCKED: $FAIL check(s) failed, $WARN warning(s)"
    echo "  Fix the issues above before deploying."
    exit 1
else
    echo "  ✓ ALL CHECKS PASSED ($WARN warning(s))"
    echo "  Safe to deploy."
    exit 0
fi
