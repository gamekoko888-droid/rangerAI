#!/bin/bash
# =============================================================================
# rangerai-agent 健康监控脚本
# 路径:    /opt/rangerai-agent/monitor.sh
# 版本:    1.0.0
# 用途:    持续检查 /health 端点，自动重启 + Telegram 故障告警
# =============================================================================

HEALTH_URL="http://localhost:3001/health"
SERVICE_NAME="rangerai-agent"
LOG_FILE="/var/log/rangerai-monitor.log"
CHECK_INTERVAL=30
RESTART_WAIT=5
MAX_FAIL_COUNT=2
CURL_TIMEOUT=5
CURL_MAX_TIME=10

GATEWAY_URL="http://localhost:18789/api/message"
# 从 secrets 文件加载 token，禁止明文硬编码
set -a; source /opt/rangerai-agent/agent-secrets.env 2>/dev/null; set +a
GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:?GATEWAY_TOKEN未设置，请检查agent-secrets.env}"
TELEGRAM_TO="1319598857"

fail_count=0
alert_sent=0

log() {
    local level="$1"
    local msg="$2"
    local timestamp
    timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
    printf "[%s] [%-5s] %s\n" "$timestamp" "$level" "$msg" | tee -a "$LOG_FILE"
}

check_health() {
    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" \
        --connect-timeout "$CURL_TIMEOUT" --max-time "$CURL_MAX_TIME" \
        "$HEALTH_URL" 2>/dev/null)
    if [[ "$http_code" == "200" ]]; then
        return 0
    else
        log "WARN" "健康检查响应异常 (HTTP $http_code)"
        return 1
    fi
}

send_telegram() {
    local message="$1"
    curl -s --connect-timeout 10 --max-time 15 \
        -X POST "$GATEWAY_URL" \
        -H "Authorization: Bearer $GATEWAY_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"channel\":\"telegram\",\"to\":\"$TELEGRAM_TO\",\"message\":\"$message\"}" \
        > /dev/null 2>&1
    local exit_code=$?
    if [[ $exit_code -eq 0 ]]; then
        log "INFO" "Telegram 消息发送成功"
        return 0
    else
        log "ERROR" "Telegram 发送失败 (curl exit=$exit_code)"
        return 1
    fi
}

restart_service() {
    log "WARN" "正在执行: systemctl restart $SERVICE_NAME ..."
    systemctl restart "$SERVICE_NAME" || log "ERROR" "restart 命令返回错误"
    log "INFO" "等待 ${RESTART_WAIT}s 服务就绪..."
    sleep "$RESTART_WAIT"
}

cleanup() {
    log "INFO" "监控脚本收到终止信号，正常退出。"
    exit 0
}
trap cleanup SIGTERM SIGINT SIGHUP

mkdir -p "$(dirname "$LOG_FILE")"

log "INFO" "══════════════════════════════════"
log "INFO" "rangerai-agent 监控脚本启动 (PID=$$)"
log "INFO" "检查间隔: ${CHECK_INTERVAL}s | 失败阈值: ${MAX_FAIL_COUNT}次"
log "INFO" "══════════════════════════════════"

while true; do
    if check_health; then
        if [[ "$fail_count" -gt 0 ]]; then
            log "INFO" "服务恢复正常 ✅ (之前连续失败 ${fail_count} 次)"
            if [[ "$alert_sent" -eq 1 ]]; then
                send_telegram "✅ rangerai-agent 已恢复正常
时间: $(date '+%Y-%m-%d %H:%M:%S')
服务器: 阿里云 ECS"
            fi
        fi
        fail_count=0
        alert_sent=0
    else
        fail_count=$((fail_count + 1))
        log "WARN" "健康检查失败 — 连续第 ${fail_count} 次 (阈值: ${MAX_FAIL_COUNT})"

        if [[ "$fail_count" -ge "$MAX_FAIL_COUNT" && "$alert_sent" -eq 0 ]]; then
            restart_service
            log "INFO" "重启后验证健康状态..."
            if check_health; then
                log "INFO" "重启后恢复正常 ✅，无需告警"
                fail_count=0
                alert_sent=0
            else
                log "ERROR" "重启后仍无响应，触发 Telegram 告警"
                send_telegram "⚠️ rangerai-agent 故障告警
时间: $(date '+%Y-%m-%d %H:%M:%S')
状态: 连续 ${fail_count} 次失败，自动重启后仍无响应
端点: $HEALTH_URL
请检查: journalctl -u rangerai-agent -n 50"
                alert_sent=1
                log "ERROR" "告警已发送，本故障周期不再重复 (alert_sent=1)"
            fi
        fi
    fi

    sleep "$CHECK_INTERVAL"
done
