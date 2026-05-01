#!/bin/bash
# RangerAI Metrics Dashboard — Quick operational overview
# Usage: metrics-dashboard.sh [--json]

JSON_MODE=false
[[ "$1" == "--json" ]] && JSON_MODE=true

# Colors
R='\033[0;31m'; G='\033[0;32m'; Y='\033[1;33m'; B='\033[0;34m'; NC='\033[0m'

collect_metrics() {
    # System metrics
    UPTIME=$(uptime -p)
    LOAD=$(cat /proc/loadavg | awk '{print $1, $2, $3}')
    MEM_TOTAL=$(free -m | awk '/Mem:/{print $2}')
    MEM_USED=$(free -m | awk '/Mem:/{print $3}')
    MEM_PCT=$((MEM_USED * 100 / MEM_TOTAL))
    DISK_PCT=$(df / | awk 'NR==2{print $5}' | tr -d '%')
    
    # Service status
    SERVICES_UP=0
    SERVICES_TOTAL=5
    for svc in rangerai-web rangerai-agent rangerai-ws rangerai-fileserver openclaw-gateway; do
        systemctl is-active --quiet $svc 2>/dev/null && SERVICES_UP=$((SERVICES_UP + 1))
    done
    
    # Error rates (last hour)
    AGENT_ERRORS=$(grep -c '"level":"error"' /var/log/rangerai-agent.log 2>/dev/null || echo 0)
    WS_ERRORS=$(grep -c '"level":"error"' /var/log/rangerai-ws.log 2>/dev/null || echo 0)
    AGENT_TOTAL=$(wc -l < /var/log/rangerai-agent.log 2>/dev/null || echo 1)
    WS_TOTAL=$(wc -l < /var/log/rangerai-ws.log 2>/dev/null || echo 1)
    
    # Gateway metrics
    GW_PID=$(pgrep -f "openclaw" | head -1 2>/dev/null || echo "N/A")
    GW_MEM=$(ps -p $GW_PID -o rss= 2>/dev/null | awk '{printf "%.0f", $1/1024}' || echo "N/A")
    
    # Recent conversation count (last 24h from SQLite)
    CONV_24H=$(sqlite3 /opt/rangerai-agent/rangerai.db "SELECT COUNT(*) FROM messages WHERE created_at > datetime('now', '-1 day')" 2>/dev/null || echo "N/A")
    
    # Knowledge search errors (last hour)
    KB_ERRORS=$(grep -c "fts5.*syntax error" /var/log/rangerai-ws.log 2>/dev/null || echo 0)
    
    # Docker containers
    DOCKER_RUNNING=$(docker ps -q 2>/dev/null | wc -l || echo 0)
    
    # Log sizes
    LOG_TOTAL=$(du -sm /var/log/rangerai-*.log 2>/dev/null | awk '{sum+=$1}END{print sum}')
    
    if $JSON_MODE; then
        cat << ENDJSON
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "system": {
    "uptime": "$UPTIME",
    "load": "$LOAD",
    "memory_pct": $MEM_PCT,
    "disk_pct": $DISK_PCT
  },
  "services": {
    "up": $SERVICES_UP,
    "total": $SERVICES_TOTAL
  },
  "errors": {
    "agent": $AGENT_ERRORS,
    "ws": $WS_ERRORS,
    "kb_fts": $KB_ERRORS
  },
  "conversations_24h": "$CONV_24H",
  "gateway": {
    "pid": "$GW_PID",
    "memory_mb": "$GW_MEM"
  },
  "docker_containers": $DOCKER_RUNNING,
  "log_size_mb": ${LOG_TOTAL:-0}
}
ENDJSON
    else
        echo ""
        echo -e "${B}╔══════════════════════════════════════════════╗${NC}"
        echo -e "${B}║     RangerAI Operational Dashboard           ║${NC}"
        echo -e "${B}║     $(date '+%Y-%m-%d %H:%M:%S %Z')              ║${NC}"
        echo -e "${B}╚══════════════════════════════════════════════╝${NC}"
        echo ""
        echo -e "${B}── System ──────────────────────────────────────${NC}"
        echo -e "  Uptime:     $UPTIME"
        echo -e "  Load:       $LOAD"
        [[ $MEM_PCT -gt 85 ]] && C=$R || C=$G
        echo -e "  Memory:     ${C}${MEM_USED}/${MEM_TOTAL}MB (${MEM_PCT}%)${NC}"
        [[ $DISK_PCT -gt 80 ]] && C=$R || C=$G
        echo -e "  Disk:       ${C}${DISK_PCT}%${NC}"
        echo ""
        echo -e "${B}── Services (${SERVICES_UP}/${SERVICES_TOTAL}) ─────────────────────────────${NC}"
        for svc in rangerai-web rangerai-agent rangerai-ws rangerai-fileserver openclaw-gateway; do
            if systemctl is-active --quiet $svc 2>/dev/null; then
                echo -e "  ${G}●${NC} $svc"
            else
                echo -e "  ${R}●${NC} $svc"
            fi
        done
        echo ""
        echo -e "${B}── Error Rates ─────────────────────────────────${NC}"
        echo -e "  Agent errors:     $AGENT_ERRORS / $AGENT_TOTAL lines"
        echo -e "  WS errors:        $WS_ERRORS / $WS_TOTAL lines"
        [[ $KB_ERRORS -gt 0 ]] && C=$R || C=$G
        echo -e "  KB FTS errors:    ${C}${KB_ERRORS}${NC}"
        echo ""
        echo -e "${B}── Business ────────────────────────────────────${NC}"
        echo -e "  Conversations (24h): $CONV_24H"
        echo -e "  Gateway memory:      ${GW_MEM}MB (PID: $GW_PID)"
        echo -e "  Docker containers:   $DOCKER_RUNNING"
        echo -e "  Log disk usage:      ${LOG_TOTAL:-0}MB"
        echo ""
    fi
}

collect_metrics
