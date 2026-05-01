#!/bin/bash
# RangerAI 任务质量监控脚本
# 用法: bash quality-monitor.sh [hours=24] [--json]
# 依赖: MySQL 容器 mysql-rangerai

HOURS=${1:-24}
JSON_MODE=0
[[ "$2" == "--json" ]] && JSON_MODE=1

MYSQL="docker exec mysql-rangerai mysql -u root -pRangerAI2026! rangerai -e"

echo "=== RangerAI 任务质量监控 | 过去 ${HOURS}h ==="
echo "生成时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# ── 1. 模型路由分布 ──────────────────────────────────────────
echo "【1】模型路由分布（assistant 消息）"
$MYSQL "
SELECT 
  COALESCE(model, 'NULL/未记录') as model,
  COALESCE(routeCategory, 'unknown') as category,
  COUNT(*) as count,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 1) as pct
FROM messages 
WHERE role='assistant' 
  AND timestamp >= NOW() - INTERVAL ${HOURS} HOUR
GROUP BY model, routeCategory
ORDER BY count DESC;
" 2>/dev/null
echo ""

# ── 2. Token 消耗统计 ─────────────────────────────────────────
echo "【2】Token 消耗（按模型，仅含有效记录）"
$MYSQL "
SELECT 
  COALESCE(model, 'unknown') as model,
  COUNT(*) as messages,
  SUM(COALESCE(tokens,0)) as total_tokens,
  ROUND(AVG(COALESCE(tokens,0))) as avg_tokens,
  MAX(COALESCE(tokens,0)) as max_tokens
FROM messages 
WHERE role='assistant' 
  AND timestamp >= NOW() - INTERVAL ${HOURS} HOUR
  AND tokens IS NOT NULL AND tokens > 0
GROUP BY model
ORDER BY total_tokens DESC;
" 2>/dev/null
echo ""

# ── 3. 失败率（task_error 事件）─────────────────────────────
echo "【3】失败率（基于 workflow_runs / 估算）"
$MYSQL "
SELECT 
  DATE_FORMAT(timestamp, '%Y-%m-%d %H:00') as hour_bucket,
  COUNT(*) as total_msgs,
  SUM(CASE WHEN metadata LIKE '%error%' OR metadata LIKE '%fail%' THEN 1 ELSE 0 END) as est_errors
FROM messages 
WHERE role='assistant' 
  AND timestamp >= NOW() - INTERVAL ${HOURS} HOUR
GROUP BY hour_bucket
ORDER BY hour_bucket DESC
LIMIT 24;
" 2>/dev/null
echo ""

# ── 4. 活跃会话数 ────────────────────────────────────────────
echo "【4】活跃对话数（过去 ${HOURS}h 新增/活跃 chats）"
$MYSQL "
SELECT 
  COUNT(DISTINCT chatId) as active_chats,
  COUNT(*) as total_messages,
  COUNT(DISTINCT DATE(timestamp)) as active_days
FROM messages 
WHERE timestamp >= NOW() - INTERVAL ${HOURS} HOUR;
" 2>/dev/null
echo ""

# ── 5. 路由分类趋势（按小时）─────────────────────────────────
echo "【5】路由分类趋势（最近 12h，每小时）"
$MYSQL "
SELECT 
  DATE_FORMAT(timestamp, '%m-%d %H:00') as hour_bucket,
  COALESCE(routeCategory, 'unknown') as category,
  COUNT(*) as count
FROM messages 
WHERE role='assistant'
  AND timestamp >= NOW() - INTERVAL 12 HOUR
GROUP BY hour_bucket, category
ORDER BY hour_bucket DESC, count DESC;
" 2>/dev/null
echo ""

# ── 6. Claude vs GPT 消耗对比 ────────────────────────────────
echo "【6】Claude vs GPT 分配比（过去 ${HOURS}h）"
$MYSQL "
SELECT 
  CASE 
    WHEN model LIKE '%claude%' THEN 'Claude'
    WHEN model LIKE '%gpt%' THEN 'GPT'
    WHEN model LIKE '%gemini%' THEN 'Gemini'
    ELSE 'Other/NULL'
  END as provider,
  COUNT(*) as count,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 1) as pct
FROM messages 
WHERE role='assistant' 
  AND timestamp >= NOW() - INTERVAL ${HOURS} HOUR
GROUP BY provider
ORDER BY count DESC;
" 2>/dev/null
echo ""

echo "=== 监控完成 ==="
