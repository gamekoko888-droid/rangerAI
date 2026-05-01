#!/bin/bash
# cleanup-bak-files.sh — 清理 rangerai-agent 目录中的备份文件
# 保留最近 5 个，删除超过 7 天的旧备份
# 安全：只删除 .bak-* 和 .bak.* 格式的文件，不碰生产文件

TARGET_DIRS=(
  "/opt/rangerai-agent/worker"
  "/opt/rangerai-agent/modules"
  "/opt/rangerai-agent/services"
  "/opt/rangerai-agent"
)

DRY_RUN=${1:-""}
DELETED=0
KEPT=0

for dir in "${TARGET_DIRS[@]}"; do
  if [ ! -d "$dir" ]; then continue; fi

  # 找出所有 bak 文件，按源文件分组
  declare -A groups
  while IFS= read -r bakfile; do
    # 提取源文件名（去掉 .bak-* 或 .bak.* 后缀）
    base=$(basename "$bakfile")
    srcname=$(echo "$base" | sed -E 's/\.bak[-.].*$//')
    groups["$srcname"]+="$bakfile"$'\n'
  done < <(find "$dir" -maxdepth 1 -name "*.bak-*" -o -name "*.bak.*" 2>/dev/null | sort)

  for src in "${!groups[@]}"; do
    # 按时间排序，保留最新 5 个
    files=$(echo "${groups[$src]}" | grep -v '^$' | sort)
    total=$(echo "$files" | grep -c .)
    if [ "$total" -le 5 ]; then
      KEPT=$((KEPT + total))
      continue
    fi

    # 删除最旧的（total-5 个），但只删 7 天以上的
    to_delete=$(echo "$files" | head -n $((total - 5)))
    while IFS= read -r f; do
      if [ -z "$f" ]; then continue; fi
      # 检查文件年龄
      age_days=$(( ($(date +%s) - $(stat -c %Y "$f" 2>/dev/null || echo 0)) / 86400 ))
      if [ "$age_days" -ge 7 ]; then
        if [ "$DRY_RUN" = "--dry-run" ]; then
          echo "[DRY-RUN] Would delete: $f (${age_days}d old)"
        else
          rm -f "$f" && echo "[DELETED] $f (${age_days}d old)"
          DELETED=$((DELETED + 1))
        fi
      else
        KEPT=$((KEPT + 1))
      fi
    done <<< "$to_delete"
  done

  unset groups
done

echo ""
echo "完成：删除 $DELETED 个，保留 $KEPT 个"
echo "提示：使用 --dry-run 参数可预览不实际删除"
