#!/bin/bash
# safe-edit-worker.sh — Worker crash 防护脚本
# 用法: safe-edit-worker.sh <修改脚本.py>
# 1. 自动备份当前 agent-worker.mjs
# 2. 执行修改脚本
# 3. 用 node --check 验证语法
# 4. 语法错误则自动回滚
# 5. 成功则重启 rangerai-agent

set -e

WORKER="/opt/rangerai-agent/agent-worker.mjs"
BACKUP="${WORKER}.bak.$(date +%s)"
EDIT_SCRIPT="$1"

if [ -z "$EDIT_SCRIPT" ]; then
  echo "用法: $0 <修改脚本.py>"
  exit 1
fi

echo "[1/5] 备份 $WORKER → $BACKUP"
cp "$WORKER" "$BACKUP"

echo "[2/5] 执行修改脚本: $EDIT_SCRIPT"
python3 "$EDIT_SCRIPT"

echo "[3/5] 语法检查..."
if node --check "$WORKER" 2>/dev/null; then
  echo "✅ 语法检查通过"
else
  echo "❌ 语法错误！自动回滚..."
  cp "$BACKUP" "$WORKER"
  echo "已回滚到备份: $BACKUP"
  exit 1
fi

echo "[4/5] 重启 rangerai-agent..."
systemctl restart rangerai-agent
sleep 2

echo "[5/5] 验证服务状态..."
if systemctl is-active --quiet rangerai-agent; then
  echo "✅ rangerai-agent 运行正常"
  # 等待 worker 启动
  sleep 3
  if journalctl -u rangerai-agent --since "5 seconds ago" --no-pager | grep -q "Worker ready"; then
    echo "✅ Worker 启动成功"
  else
    echo "⚠️ Worker 可能还在启动中，请手动检查: journalctl -u rangerai-agent -f"
  fi
else
  echo "❌ 服务启动失败！回滚..."
  cp "$BACKUP" "$WORKER"
  systemctl restart rangerai-agent
  echo "已回滚并重启"
  exit 1
fi

echo ""
echo "完成！备份保存在: $BACKUP"
