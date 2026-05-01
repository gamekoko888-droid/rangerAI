#!/bin/bash
# RangerAI Backend Deploy Script v1.0
# Usage: bash /opt/rangerai-web/scripts/deploy-backend.sh [service]
# service: ws | agent | all (default: all)

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

TARGET="${1:-all}"

echo -e "${YELLOW}=== RangerAI Backend Deploy ===${NC}"
echo "$(date '+%Y-%m-%d %H:%M:%S') | Target: $TARGET"

restart_service() {
  local svc=$1
  echo -e "\n${YELLOW}Restarting $svc...${NC}"
  systemctl restart "$svc"
  sleep 2
  STATUS=$(systemctl is-active "$svc" 2>/dev/null || echo "unknown")
  if [ "$STATUS" = "active" ]; then
    echo -e "${GREEN}  ✓ $svc: active${NC}"
  else
    echo -e "${RED}  ✗ $svc: $STATUS${NC}"
    echo "  Recent logs:"
    journalctl -u "$svc" --no-pager -n 10
    return 1
  fi
}

check_syntax() {
  local file=$1
  echo -e "  Checking syntax: $file"
  if node --check "$file" 2>/dev/null; then
    echo -e "${GREEN}  ✓ Syntax OK${NC}"
  else
    echo -e "${RED}  ✗ Syntax error in $file! Aborting.${NC}"
    exit 1
  fi
}

case "$TARGET" in
  ws)
    check_syntax /opt/rangerai-agent/ws-realtime.mjs
    restart_service rangerai-ws
    ;;
  agent)
    check_syntax /opt/rangerai-agent/api-server.mjs
    restart_service rangerai-agent
    ;;
  all)
    check_syntax /opt/rangerai-agent/ws-realtime.mjs
    check_syntax /opt/rangerai-agent/api-server.mjs
    restart_service rangerai-ws
    restart_service rangerai-agent
    ;;
  *)
    echo -e "${RED}Unknown target: $TARGET${NC}"
    echo "Usage: $0 [ws|agent|all]"
    exit 1
    ;;
esac

# Port check
echo -e "\n${YELLOW}--- Port Check ---${NC}"
for port in 3000 3002 3005; do
  if ss -tlnp | grep -q ":$port "; then
    echo -e "  ${GREEN}✓ Port $port: LISTENING${NC}"
  else
    echo -e "  ${RED}✗ Port $port: DOWN${NC}"
  fi
done

echo -e "\n${GREEN}=== Backend Deploy Complete ===${NC}"
