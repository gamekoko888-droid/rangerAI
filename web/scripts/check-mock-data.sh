#!/bin/bash
# Mock数据防复发检查脚本 v2
# 用法：bash scripts/check-mock-data.sh [target_dir]
# 在 CI / 部署前运行，检测已知虚假数据字符串

TARGET_DIR="${1:-client/src}"
FOUND=0

# 已知必须清除的虚假数据（DailyReportsV2 相关）
FAKE_PATTERNS=(
  "524\.8万"
  "48,720单"
  "GamerPro ROI 达 628"
  "MENA 市场调研"
  "3/4-3/10"
  "代充组工单积压持续加剧，周均积压45单"
  "FC金币库存周均低于安全线"
  "TikTok店铺周营收突码35万"
  "CPS推广新增8个主播"
  "美区 FC 金币销量"
)

# 合法的 Mock 标注白名单（这些页面尚未对接真实数据，属已知待办）
WHITELIST_FILES=(
  "KolDetail.tsx"
  "CeoDashboard.tsx"
)

echo "检查 Mock 数据残留..."
for pattern in "${FAKE_PATTERNS[@]}"; do
  result=$(grep -rn "$pattern" "$TARGET_DIR" 2>/dev/null | grep -v ".bak" | grep -v ".deprecated" | grep -v "check-mock-data.sh")
  if [ -n "$result" ]; then
    # 过滤白名单文件
    filtered=""
    while IFS= read -r line; do
      skip=0
      for wl in "${WHITELIST_FILES[@]}"; do
        if echo "$line" | grep -q "$wl"; then
          skip=1
          break
        fi
      done
      if [ $skip -eq 0 ]; then
        filtered="$filtered\n$line"
      fi
    done <<< "$result"

    if [ -n "$filtered" ] && [ "$filtered" != "\n" ]; then
      echo "FAIL: $pattern"
      echo -e "$filtered"
      FOUND=$((FOUND + 1))
    fi
  fi
done

if [ $FOUND -eq 0 ]; then
  echo "PASS: 未发现非白名单 Mock 数据，检查通过"
  exit 0
else
  echo ""
  echo "WARN: 共发现 $FOUND 处非白名单 Mock 数据，请替换为真实数据后再部署"
  exit 1
fi
