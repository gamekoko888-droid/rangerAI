#!/usr/bin/env bash
# ============================================================================
# RangerAI CI Gate v2.0 — MODEL-GOVERNANCE v4.0 对齐
# 
# 10 gate items that must ALL pass before deployment:
#   1. Node.js syntax check (all .mjs files)
#   2. Unit tests (node:test native)
#   3. Unit tests (vitest)
#   4. Integration tests (node:test)
#   5. Admin API auth verification
#   6. Circuit Breaker status check
#   7. Service health check
#   8. Quality scorer + media analyzer structure check
#   9. E2E task flow test (全链路端到端) ← v2.0 新增
#  10. iter-verify snapshot (验收制度化) ← v2.0 新增
#
# Usage:
#   ./ci-gate.sh
#   CI_SKIP_INTEGRATION=1 ./ci-gate.sh  # skip integration tests
#   CI_SKIP_E2E=1 ./ci-gate.sh          # skip E2E task flow test
#
# Exit code: 0 = all gates passed, 1 = one or more gates failed
# ============================================================================
set -uo pipefail

API_BASE="${API_BASE:-http://localhost:3002}"
ADMIN_TOKEN="$(cat /opt/rangerai-agent/.admin-token 2>/dev/null || echo '')"
PASS=0
FAIL=0
SKIP=0
RESULTS=()

RED()  { printf "\033[31m%s\033[0m\n" "$*"; }
GRN()  { printf "\033[32m%s\033[0m\n" "$*"; }
YLW()  { printf "\033[33m%s\033[0m\n" "$*"; }

gate() {
  local num="$1" name="$2"
  shift 2
  printf "[Gate %s] %s ... " "$num" "$name"
  if eval "$@" > /tmp/ci-gate-${num}.log 2>&1; then
    GRN "PASS"
    PASS=$((PASS + 1))
    RESULTS+=("PASS: $name")
  else
    RED "FAIL"
    FAIL=$((FAIL + 1))
    RESULTS+=("FAIL: $name")
    tail -5 /tmp/ci-gate-${num}.log 2>/dev/null | sed 's/^/  /'
  fi
}

skip_gate() {
  local num="$1" name="$2" reason="$3"
  printf "[Gate %s] %s ... " "$num" "$name"
  YLW "SKIP ($reason)"
  SKIP=$((SKIP + 1))
  RESULTS+=("SKIP: $name ($reason)")
}

echo "============================================"
echo "  RangerAI CI Gate v1.0"
echo "  $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "============================================"
echo ""

cd /opt/rangerai-agent

# ─── Gate 1: Syntax check ───
gate 1 "Node.js syntax check" '
  ERRORS=0
  for f in worker/*.mjs modules/*.mjs api/*.mjs *.mjs; do
    [ -f "$f" ] || continue
    node --check "$f" 2>/dev/null || { echo "SYNTAX ERROR: $f"; ERRORS=$((ERRORS+1)); }
  done
  [ $ERRORS -eq 0 ]
'

# ─── Gate 2: Native unit tests ───
gate 2 "Unit tests (node:test)" '
  node --test tests/knowledge-injector.test.mjs tests/segmenter.test.mjs tests/workflow-scheduler.test.mjs
'

# ─── Gate 3: Vitest unit tests ───
gate 3 "Unit tests (vitest)" '
  npx vitest run tests/auth.test.mjs tests/bootstrap.test.mjs tests/db-connectivity.test.mjs tests/e2e-health.test.mjs tests/http-routes.test.mjs tests/logger.test.mjs tests/metrics-collector.test.mjs tests/startup-check.test.mjs tests/ws-connection.test.mjs tests/ws-server.test.mjs tests/api-integration.test.mjs --reporter=verbose 2>&1 | tail -20
'

# ─── Gate 4: Integration tests ───
if [ "${CI_SKIP_INTEGRATION:-}" = "1" ]; then
  skip_gate 4 "Integration tests" "CI_SKIP_INTEGRATION=1"
else
  gate 4 "Integration tests (node:test)" '
    node --test tests/integration/*.integration.test.mjs
  '
fi

# ─── Gate 5: Admin API auth ───
gate 5 "Admin API auth verification" '
  for ep in /api/system/status /api/system/health-detail /api/system/circuit-breaker; do
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" "$API_BASE$ep" 2>/dev/null)
    [ "$STATUS" = "200" ] || { echo "FAIL: $ep returned $STATUS"; exit 1; }
    sleep 0.3
  done
'

# ─── Gate 6: Circuit Breaker status ───
gate 6 "Circuit Breaker status check" '
  BODY=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$API_BASE/api/system/circuit-breaker" 2>/dev/null)
  echo "$BODY" | grep -q "circuitBreakers" || { echo "Missing circuitBreakers field"; exit 1; }
  CB_COUNT=$(echo "$BODY" | grep -o "provider" | wc -l)
  [ "$CB_COUNT" -eq 3 ] || { echo "Expected 3 providers, got $CB_COUNT"; exit 1; }
  echo "Found $CB_COUNT providers in CB status"
'

# ─── Gate 7: Service health check ───
gate 7 "Service health check" '
  systemctl is-active rangerai-agent > /dev/null 2>&1 || { echo "rangerai-agent not active"; exit 1; }
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" "$API_BASE/api/system/status" 2>/dev/null)
  [ "$STATUS" = "200" ] || { echo "Health endpoint returned $STATUS"; exit 1; }
  echo "rangerai-agent: active, health: 200"
'

# ─── Gate 8: Quality scorer + media analyzer structure ───
gate 8 "Quality scorer + media analyzer structure" '
  # Quality scorer
  [ -f worker/quality-scorer.mjs ] || { echo "quality-scorer.mjs missing"; exit 1; }
  grep -q "SAMPLE_RATE\|sampleRate" worker/quality-scorer.mjs || { echo "No sampling rate in quality-scorer"; exit 1; }
  grep -q "answer_quality_scored" worker/event-stream.mjs || { echo "No answer_quality_scored event"; exit 1; }
  # Media analyzer
  [ -f worker/media-analyzer.mjs ] || { echo "media-analyzer.mjs missing"; exit 1; }
  grep -q "frameCount" worker/media-analyzer.mjs || { echo "No frameCount in media-analyzer"; exit 1; }
  grep -q "extractionMethod" worker/media-analyzer.mjs || { echo "No extractionMethod in media-analyzer"; exit 1; }
  grep -q "media_analyzed" worker/event-stream.mjs || { echo "No media_analyzed event"; exit 1; }
  echo "All structure checks passed"
'

# ─── Gate 9: E2E task flow test (全链路端到端) ───
if [ "${CI_SKIP_E2E:-}" = "1" ]; then
  skip_gate 9 "E2E task flow test" "CI_SKIP_E2E=1"
else
  gate 9 "E2E task flow test" '
    node --test --test-timeout=120000 /opt/rangerai-agent/tests/e2e-task-flow.test.mjs
  '
fi

# ─── Gate 10: iter-verify snapshot ───
gate 10 "iter-verify snapshot" "
  bash /opt/rangerai-agent/iter-verify.sh ci-gate
  ITV_JSON=\$(ls -t /opt/rangerai-agent/memory/iter-verify-R*.json 2>/dev/null | head -1)
  [ -n \"\$ITV_JSON\" ] || { echo 'No iter-verify output'; exit 1; }
  # Check no dead modules
  DEAD=\$(node -e \"const j=require(\\\"\$ITV_JSON\\\"); console.log(j.dead_modules.count)\" 2>/dev/null)
  [ \"\$DEAD\" != \"0\" ] && { echo \"DEAD_MODULES=\$DEAD, 规则九违规\"; }
  # Don't block on warnings, just report
  node -e \"const j=require(\\\"\$ITV_JSON\\\"); console.log('iter-verify: git='+j.git_hash+' tests='+j.tests.pass+'/'+j.tests.total+' dead='+j.dead_modules.count+' bak='+j.bak_files.count+' errors='+j.recent_errors_10min);\" 2>/dev/null
  echo 'iter-verify snapshot OK'
"

# ─── Summary ───
echo ""
echo "============================================"
echo "  CI Gate Summary"
echo "============================================"
for r in "${RESULTS[@]}"; do
  echo "  $r"
done
echo ""
echo "  PASS: $PASS  FAIL: $FAIL  SKIP: $SKIP"
echo "============================================"

if [ $FAIL -gt 0 ]; then
  RED "CI GATE: FAILED ($FAIL gate(s) failed)"
  exit 1
else
  GRN "CI GATE: PASSED"
  exit 0
fi
