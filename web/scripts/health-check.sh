#!/bin/bash
# RangerAI Health Check Script v1.0
# Usage: bash /opt/rangerai-web/scripts/health-check.sh

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
ERRORS=0

echo -e "${YELLOW}=== RangerAI Health Check ===${NC}"
echo "$(date '+%Y-%m-%d %H:%M:%S')"

# 1. Service Status
echo -e "\n${YELLOW}[1/5] Service Status${NC}"
for svc in rangerai-web rangerai-ws rangerai-agent rangerai-fileserver; do
  STATUS=$(systemctl is-active "$svc" 2>/dev/null || echo "not found")
  if [ "$STATUS" = "active" ]; then
    echo -e "  ${GREEN}✓ $svc: active${NC}"
  else
    echo -e "  ${RED}✗ $svc: $STATUS${NC}"
    ERRORS=$((ERRORS + 1))
  fi
done

# 2. Port Check
echo -e "\n${YELLOW}[2/5] Port Check${NC}"
declare -A PORTS=( [3000]="static-server" [3001]="file-server" [3002]="api-server" [3005]="ws-realtime" [18789]="openclaw-gateway" )
for port in "${!PORTS[@]}"; do
  if ss -tlnp | grep -q ":$port "; then
    echo -e "  ${GREEN}✓ :$port (${PORTS[$port]}): LISTENING${NC}"
  else
    echo -e "  ${RED}✗ :$port (${PORTS[$port]}): DOWN${NC}"
    ERRORS=$((ERRORS + 1))
  fi
done

# 3. Frontend Hash Consistency
echo -e "\n${YELLOW}[3/5] Frontend Hash${NC}"
SRC_HASH=$(grep -oE 'index-[^"]+\.js' /opt/rangerai-agent/dist/index.html 2>/dev/null | head -1)
LIVE_HASH=$(curl -s --max-time 5 http://127.0.0.1:3000/ | grep -oE 'index-[^"]+\.js' | head -1)
CDN_HASH=$(curl -s --max-time 5 https://ranger.voyage/ | grep -oE 'index-[^"]+\.js' | head -1)
echo "  Source: $SRC_HASH"
echo "  Live:   $LIVE_HASH"
echo "  CDN:    $CDN_HASH"
if [ "$SRC_HASH" = "$LIVE_HASH" ] && [ "$LIVE_HASH" = "$CDN_HASH" ]; then
  echo -e "  ${GREEN}✓ All hashes match${NC}"
else
  echo -e "  ${YELLOW}⚠ Hash mismatch (CDN may be caching)${NC}"
fi

# 4. API Health
echo -e "\n${YELLOW}[4/5] API Health${NC}"
API_STATUS=$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" http://127.0.0.1:3002/api/health 2>/dev/null || echo "000")
if [ "$API_STATUS" = "200" ]; then
  echo -e "  ${GREEN}✓ API /health: 200 OK${NC}"
else
  echo -e "  ${RED}✗ API /health: HTTP $API_STATUS${NC}"
  ERRORS=$((ERRORS + 1))
fi

# 5. Disk & Memory
echo -e "\n${YELLOW}[5/5] System Resources${NC}"
DISK_USAGE=$(df -h / | awk 'NR==2 {print $5}')
MEM_USAGE=$(free -h | awk 'NR==2 {printf "%s/%s (%s%%)", $3, $2, int($3/$2*100)}')
echo "  Disk: $DISK_USAGE used"
echo "  Memory: $MEM_USAGE"

# Summary
echo ""
if [ $ERRORS -eq 0 ]; then
  echo -e "${GREEN}=== All checks passed ✓ ===${NC}"
else
  echo -e "${RED}=== $ERRORS check(s) failed ✗ ===${NC}"
fi
