# RangerAI Health Check Script (R39 updated)
# Uses x-internal-call header for authenticated endpoints
PASS=0; FAIL=0; TOTAL=0
check() {
  local name=$1 cmd=$2
  TOTAL=$((TOTAL+1))
  if eval "$cmd" > /dev/null 2>&1; then
    echo "[PASS] $name"
    PASS=$((PASS+1))
  else
    echo "[FAIL] $name"
    FAIL=$((FAIL+1))
  fi
}
# Services
check 'rangerai-agent' 'systemctl is-active rangerai-agent'
check 'rangerai-ws' 'systemctl is-active rangerai-ws'
check 'caddy' 'systemctl is-active caddy'
check 'rangerai-fileserver' 'systemctl is-active rangerai-fileserver'
# Ports
check 'port-3001' 'curl -sf http://127.0.0.1:3001/health'
check 'port-3002' 'curl -sf http://127.0.0.1:3002/api/health'
check 'port-3005' 'curl -sf http://127.0.0.1:3005/health'
# API endpoints (with internal auth)
check 'api-status' 'curl -sf -H "x-internal-call: 1" http://127.0.0.1:3002/api/system/status'
check 'api-health-detail' 'curl -sf -H "x-internal-call: 1" http://127.0.0.1:3002/api/system/health-detail'
check 'api-stats' 'curl -sf -H "x-internal-call: 1" http://127.0.0.1:3002/api/stats'
check 'api-stats-routing' 'curl -sf -H "x-internal-call: 1" http://127.0.0.1:3002/api/stats/routing'
check 'api-agent-metrics' 'curl -sf -H "x-internal-call: 1" http://127.0.0.1:3002/api/system/agent-metrics'
check 'api-observability' 'curl -sf http://127.0.0.1:3002/api/observability/final-answer-stats'
echo ""
echo "Result: $PASS/$TOTAL passed, $FAIL failed"
