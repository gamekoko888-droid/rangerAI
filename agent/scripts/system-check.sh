#!/bin/bash

TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")
REPORT="System Check Report - ${TIMESTAMP}\n\n"

# 1. 检查服务状态
REPORT+="Service Status:\n"
SERVICES=("openclaw-gateway" "caddy" "redis-ranger")
for SERVICE in "${SERVICES[@]}"; do
  STATUS=$(systemctl is-active $SERVICE)
  REPORT+="  ${SERVICE}: ${STATUS}\n"
done
REPORT+="\n"

# 2. 检查磁盘使用率
DISK_USAGE=$(df -h / | awk 'NR==2 {print $5}' | sed 's/%//')
REPORT+="Disk Usage: ${DISK_USAGE}%\n"
if (( $(echo "${DISK_USAGE} > 80" | bc -l) )); then
  REPORT+="  WARNING: Disk usage exceeds 80%\n"
fi
REPORT+="\n"

# 3. 检查内存使用率
MEM_TOTAL=$(free | awk 'NR==2 {print $2}')
MEM_USED=$(free | awk 'NR==2 {print $3}')
MEM_USAGE=$((MEM_USED * 100 / MEM_TOTAL))
REPORT+="Memory Usage: ${MEM_USAGE}%\n"
if (( $(echo "${MEM_USAGE} > 90" | bc -l) )); then
  REPORT+="  WARNING: Memory usage exceeds 90%\n"
fi
REPORT+="\n"

# 4. 检查 ranger.voyage 是否返回 200
HTTP_STATUS=$(curl -o /dev/null -s -w '%{http_code}' https://ranger.voyage | sed 's/"//g')
REPORT+="ranger.voyage HTTP Status: ${HTTP_STATUS}\n"
if [ "$HTTP_STATUS" -ne "200" ]; then
  REPORT+="  WARNING: ranger.voyage did not return 200 OK\n"
fi
REPORT+="\n"

echo -e "$REPORT"
