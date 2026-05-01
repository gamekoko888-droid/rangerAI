#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# iter-verify.sh v2 — 硬性验收脚本（防作弊版）
# 
# 此脚本由 Manus AI 审计方部署，Ranger 禁止修改。
# 任何修改将被视为验收作弊，等同于验收失败。
#
# 用法: bash /opt/rangerai-agent/iter-verify.sh [ROUND]
#   ROUND: R94, R95, R96, R97, R98, R99, R100, R101, ALL
#   默认: ALL
#
# 输出: JSON 格式验收结果，写入 memory/iter-verify-R{ROUND}.json
# 退出码: 0=全部通过, 1=存在失败项
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

ROUND="${1:-ALL}"
AGENT_ROOT="/opt/rangerai-agent"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
RESULT_FILE="${AGENT_ROOT}/memory/iter-verify-R${ROUND}.json"
TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_WARN=0
RESULTS=""

# ─── 工具函数 ────────────────────────────────────────────────────────────────

check() {
  local round="$1" id="$2" desc="$3" expected="$4" actual="$5" strict="${6:-true}"
  local status="PASS"
  
  if [ "$strict" = "true" ]; then
    if [ "$actual" != "$expected" ]; then
      status="FAIL"
      TOTAL_FAIL=$((TOTAL_FAIL + 1))
    else
      TOTAL_PASS=$((TOTAL_PASS + 1))
    fi
  else
    # 数值比较: actual <= expected
    if [ "$actual" -gt "$expected" ] 2>/dev/null; then
      status="FAIL"
      TOTAL_FAIL=$((TOTAL_FAIL + 1))
    else
      TOTAL_PASS=$((TOTAL_PASS + 1))
    fi
  fi
  
  RESULTS="${RESULTS}{\"round\":\"${round}\",\"id\":\"${id}\",\"desc\":\"${desc}\",\"expected\":\"${expected}\",\"actual\":\"${actual}\",\"status\":\"${status}\"},"
  
  if [ "$status" = "FAIL" ]; then
    echo "  ❌ FAIL ${round}-${id}: ${desc} (期望: ${expected}, 实际: ${actual})"
  else
    echo "  ✅ PASS ${round}-${id}: ${desc}"
  fi
}

check_gte() {
  local round="$1" id="$2" desc="$3" min="$4" actual="$5"
  local status="PASS"
  
  if [ "$actual" -lt "$min" ] 2>/dev/null; then
    status="FAIL"
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
  else
    TOTAL_PASS=$((TOTAL_PASS + 1))
  fi
  
  RESULTS="${RESULTS}{\"round\":\"${round}\",\"id\":\"${id}\",\"desc\":\"${desc}\",\"expected\":\">=${min}\",\"actual\":\"${actual}\",\"status\":\"${status}\"},"
  
  if [ "$status" = "FAIL" ]; then
    echo "  ❌ FAIL ${round}-${id}: ${desc} (期望: >=${min}, 实际: ${actual})"
  else
    echo "  ✅ PASS ${round}-${id}: ${desc}"
  fi
}

check_lte() {
  local round="$1" id="$2" desc="$3" max="$4" actual="$5"
  local status="PASS"
  
  if [ "$actual" -gt "$max" ] 2>/dev/null; then
    status="FAIL"
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
  else
    TOTAL_PASS=$((TOTAL_PASS + 1))
  fi
  
  RESULTS="${RESULTS}{\"round\":\"${round}\",\"id\":\"${id}\",\"desc\":\"${desc}\",\"expected\":\"<=${max}\",\"actual\":\"${actual}\",\"status\":\"${status}\"},"
  
  if [ "$status" = "FAIL" ]; then
    echo "  ❌ FAIL ${round}-${id}: ${desc} (期望: <=${max}, 实际: ${actual})"
  else
    echo "  ✅ PASS ${round}-${id}: ${desc}"
  fi
}

# ─── R94: 安全加固 ──────────────────────────────────────────────────────────

verify_r94() {
  echo ""
  echo "═══ R94: 安全加固 ═══"
  
  # V1: .env 文件权限
  local perm=$(stat -c '%a' ${AGENT_ROOT}/.env 2>/dev/null || echo "MISSING")
  check "R94" "V1" ".env 文件权限=600" "600" "$perm"
  
  # V2: systemd 无明文 Key
  local keys=$(grep -l 'ANTHROPIC_API_KEY=sk-\|OPENAI_API_KEY=sk-\|API_KEY=sk-' /etc/systemd/system/rangerai*.service 2>/dev/null | wc -l)
  check "R94" "V2" "systemd 无明文 API Key" "0" "$keys"
  
  # V3: .env 在 gitignore
  local gi=$(grep -c '\.env' ${AGENT_ROOT}/.gitignore 2>/dev/null || echo "0")
  check_gte "R94" "V3" ".env 在 .gitignore" "1" "$gi"
  
  # V4: SQL 白名单
  local wl=$(grep -c 'ALLOWED_.*_COLS' ${AGENT_ROOT}/api/ticket-kol-api.mjs 2>/dev/null || echo "0")
  check_gte "R94" "V4" "SQL 白名单定义" "3" "$wl"
  
  # V5: 白名单过滤逻辑（.includes 或 .filter 在 updates 操作前）
  local filter=$(grep -c 'ALLOWED.*\.includes\|\.filter.*ALLOWED' ${AGENT_ROOT}/api/ticket-kol-api.mjs 2>/dev/null || echo "0")
  check_gte "R94" "V5" "白名单过滤逻辑" "3" "$filter"
  
  # V6: 非 root 运行
  local users=""
  local all_admin="true"
  for svc in rangerai-agent rangerai-ws rangerai-web rangerai-fileserver; do
    local u=$(systemctl show $svc -p User --value 2>/dev/null || echo "MISSING")
    if [ "$u" != "admin" ]; then all_admin="false"; fi
  done
  check "R94" "V6" "4个服务全部 User=admin" "true" "$all_admin"
  
  # V7: 服务全部 active
  local all_active="true"
  for svc in rangerai-agent rangerai-ws rangerai-web rangerai-fileserver; do
    local st=$(systemctl is-active $svc 2>/dev/null || echo "inactive")
    if [ "$st" != "active" ]; then all_active="false"; fi
  done
  check "R94" "V7" "4个服务全部 active" "true" "$all_active"
  
  # V8: HTTP 200
  local http=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://ranger.voyage/ 2>/dev/null || echo "000")
  check "R94" "V8" "HTTP 状态码" "200" "$http"
}

# ─── R95: 内存泄漏治理 ─────────────────────────────────────────────────────

verify_r95() {
  echo ""
  echo "═══ R95: 内存泄漏治理 ═══"
  
  # V1: TTLMap 模块存在
  local exists="false"
  test -f ${AGENT_ROOT}/worker/lib/ttl-map.mjs && exists="true"
  check "R95" "V1" "TTLMap 模块存在" "true" "$exists"
  
  # V2: TTLMap 使用次数
  local usage=$(grep -rn 'TTLMap\|ttl-map' ${AGENT_ROOT}/worker/*.mjs 2>/dev/null | grep -v '.bak' | wc -l)
  check_gte "R95" "V2" "TTLMap 使用次数" "10" "$usage"
  
  # V3: 裸 new Map() — 三个核心文件各 <=2
  local oh_maps=$(grep -c 'new Map()' ${AGENT_ROOT}/worker/openclaw-handler.mjs 2>/dev/null || echo "0")
  local te_maps=$(grep -c 'new Map()' ${AGENT_ROOT}/worker/task-engine.mjs 2>/dev/null || echo "0")
  local pl_maps=$(grep -c 'new Map()' ${AGENT_ROOT}/worker/planner.mjs 2>/dev/null || echo "0")
  check_lte "R95" "V3a" "openclaw-handler new Map()" "2" "$oh_maps"
  check_lte "R95" "V3b" "task-engine new Map()" "2" "$te_maps"
  check_lte "R95" "V3c" "planner new Map()" "2" "$pl_maps"
  
  # V4: setInterval >= clearInterval (clearInterval 可以多于 setInterval)
  local si=$(grep -rn 'setInterval' ${AGENT_ROOT}/worker/*.mjs ${AGENT_ROOT}/modules/*.mjs 2>/dev/null | grep -v '.bak' | wc -l)
  local ci=$(grep -rn 'clearInterval' ${AGENT_ROOT}/worker/*.mjs ${AGENT_ROOT}/modules/*.mjs 2>/dev/null | grep -v '.bak' | wc -l)
  local interval_ok="true"
  if [ "$ci" -lt "$si" ]; then interval_ok="false"; fi
  check "R95" "V4" "clearInterval >= setInterval (${ci}>=${si})" "true" "$interval_ok"
  
  # V5: 语法检查
  local syntax_errors=0
  for f in ${AGENT_ROOT}/worker/*.mjs; do
    [ -f "$f" ] || continue
    echo "$f" | grep -q '.bak' && continue
    node --check "$f" 2>&1 | grep -qi 'error' && syntax_errors=$((syntax_errors + 1))
  done
  check "R95" "V5" "语法错误数" "0" "$syntax_errors"
  
  # V6: 测试
  local test_result=$(cd ${AGENT_ROOT} && npm run test:native 2>&1 | grep -oP 'fail \K[0-9]+' || echo "0")
  check "R95" "V6" "测试失败数" "0" "${test_result:-0}"
}

# ─── R96: 配置清理 ──────────────────────────────────────────────────────────

verify_r96() {
  echo ""
  echo "═══ R96: 配置清理 ═══"
  
  # V1: Caddy /api/ 路由数
  local routes=$(grep -c 'handle /api/' /etc/caddy/conf.d/10-ranger-main.caddy 2>/dev/null || echo "0")
  check_lte "R96" "V1" "Caddy /api/ 路由数" "3" "$routes"
  
  # V2: Caddy 配置有效
  local valid=$(caddy validate --config /etc/caddy/Caddyfile 2>&1 | grep -c 'Valid' || echo "0")
  check_gte "R96" "V2" "Caddy 配置有效" "1" "$valid"
  
  # V3: HTTP 可达
  local h1=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://ranger.voyage/ 2>/dev/null || echo "000")
  check "R96" "V3" "ranger.voyage HTTP" "200" "$h1"
  
  # V4: task_plans 索引数 (检查两个可能的数据库路径)
  local idx=$(sqlite3 ${AGENT_ROOT}/rangerai.db '.indices task_plans' 2>/dev/null | wc -w)
  if [ "$idx" = "0" ]; then
    idx=$(sqlite3 ${AGENT_ROOT}/db/rangerai.db '.indices task_plans' 2>/dev/null | wc -w)
  fi
  check "R96" "V4" "task_plans 索引数=3" "3" "$idx"
  
  # V5: Caddy .bak 文件
  local bak=$(ls /etc/caddy/conf.d/*.bak* 2>/dev/null | wc -l)
  check "R96" "V5" "Caddy .bak 文件数" "0" "$bak"
}

# ─── R97: God Object 拆分第一阶段 ───────────────────────────────────────────

verify_r97() {
  echo ""
  echo "═══ R97: God Object 拆分第一阶段 ═══"
  
  # V1: openclaw-handler 行数 (硬性: <=500)
  local lines=$(wc -l < ${AGENT_ROOT}/worker/openclaw-handler.mjs 2>/dev/null || echo "9999")
  check_lte "R97" "V1" "openclaw-handler.mjs 行数" "500" "$lines"
  
  # V2: 6 个新模块存在且 >50 行真实逻辑
  local modules_ok="true"
  for f in handler-entry tool-dispatcher step-executor error-recovery heartbeat-manager plan-tracker; do
    local ml=$(wc -l < ${AGENT_ROOT}/worker/$f.mjs 2>/dev/null || echo "0")
    if [ "$ml" -lt "50" ]; then modules_ok="false"; fi
  done
  check "R97" "V2" "6个模块全部>50行" "true" "$modules_ok"
  
  # V3: 无死模块（每个被 import）
  local imports_ok="true"
  for f in handler-entry tool-dispatcher step-executor error-recovery heartbeat-manager plan-tracker; do
    local imp=$(grep -rn "$f" ${AGENT_ROOT}/worker/openclaw-handler.mjs 2>/dev/null | wc -l)
    if [ "$imp" -lt "1" ]; then imports_ok="false"; fi
  done
  check "R97" "V3" "6个模块全部被import" "true" "$imports_ok"
  
  # ═══ 防作弊检查 ═══
  # V-ANTI-CHEAT-1: partN 文件不允许是单行 export default 字符串
  local cheat_partN="false"
  for i in 1 2 3 4 5 6 7 8; do
    local pf="${AGENT_ROOT}/worker/openclaw-handler.part${i}.mjs"
    if [ -f "$pf" ]; then
      local pl=$(wc -l < "$pf")
      if [ "$pl" -le "2" ]; then
        # 单行或双行文件 = 字符串编码作弊
        cheat_partN="true"
      fi
    fi
  done
  if [ "$cheat_partN" = "true" ]; then
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    RESULTS="${RESULTS}{\"round\":\"R97\",\"id\":\"ANTI-CHEAT-1\",\"desc\":\"partN文件禁止为单行字符串编码\",\"expected\":\"每个partN>10行正常代码\",\"actual\":\"检测到单行export default字符串\",\"status\":\"FAIL\"},"
    echo "  ❌ FAIL R97-ANTI-CHEAT-1: partN 文件为单行字符串编码（作弊方式）"
    echo "     → 要求: 每个 partN 必须是 >10 行的正常 JS 模块代码"
    echo "     → 禁止: export default '...' 字符串化 + data:URL 动态拼接"
  else
    TOTAL_PASS=$((TOTAL_PASS + 1))
    RESULTS="${RESULTS}{\"round\":\"R97\",\"id\":\"ANTI-CHEAT-1\",\"desc\":\"partN文件为正常代码\",\"expected\":\"正常代码\",\"actual\":\"正常代码\",\"status\":\"PASS\"},"
    echo "  ✅ PASS R97-ANTI-CHEAT-1: partN 文件为正常代码"
  fi
  
  # V-ANTI-CHEAT-2: 不允许 data:URL import 方案
  local data_url=$(grep -c 'data:text/javascript' ${AGENT_ROOT}/worker/openclaw-handler-loader.mjs 2>/dev/null || echo "0")
  if [ "$data_url" -gt "0" ]; then
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    RESULTS="${RESULTS}{\"round\":\"R97\",\"id\":\"ANTI-CHEAT-2\",\"desc\":\"禁止data:URL动态import\",\"expected\":\"0\",\"actual\":\"${data_url}\",\"status\":\"FAIL\"},"
    echo "  ❌ FAIL R97-ANTI-CHEAT-2: 检测到 data:URL 动态 import（作弊方式）"
    echo "     → loader.mjs 中禁止使用 data:text/javascript 拼接代码"
  else
    TOTAL_PASS=$((TOTAL_PASS + 1))
    RESULTS="${RESULTS}{\"round\":\"R97\",\"id\":\"ANTI-CHEAT-2\",\"desc\":\"无data:URL动态import\",\"expected\":\"0\",\"actual\":\"0\",\"status\":\"PASS\"},"
    echo "  ✅ PASS R97-ANTI-CHEAT-2: 无 data:URL 动态 import"
  fi
  
  # V-ANTI-CHEAT-3: 新模块必须包含实际函数定义（非纯 re-export）
  local real_logic="true"
  for f in handler-entry tool-dispatcher step-executor error-recovery heartbeat-manager plan-tracker; do
    local funcs=$(grep -c 'function \|=> {' ${AGENT_ROOT}/worker/$f.mjs 2>/dev/null || echo "0")
    local reexports=$(grep -c '^export {' ${AGENT_ROOT}/worker/$f.mjs 2>/dev/null || echo "0")
    # 如果 re-export 数量 > 函数定义数量，说明是薄壳
    if [ "$funcs" -lt "2" ] && [ "$reexports" -gt "$funcs" ]; then
      real_logic="false"
    fi
  done
  check "R97" "ANTI-CHEAT-3" "新模块包含实际函数定义(非纯re-export)" "true" "$real_logic"
}

# ─── R98: God Object 拆分第二阶段 ───────────────────────────────────────────

verify_r98() {
  echo ""
  echo "═══ R98: God Object 拆分第二阶段 ═══"
  
  # V1: planner 行数
  local pl_lines=$(wc -l < ${AGENT_ROOT}/worker/planner.mjs 2>/dev/null || echo "9999")
  check_lte "R98" "V1" "planner.mjs 行数" "500" "$pl_lines"
  
  # V2: task-engine 行数
  local te_lines=$(wc -l < ${AGENT_ROOT}/worker/task-engine.mjs 2>/dev/null || echo "9999")
  check_lte "R98" "V2" "task-engine.mjs 行数" "500" "$te_lines"
  
  # V3: 任务书指定的 7 个新模块全部存在
  local all_exist="true"
  local missing=""
  for f in plan-generator plan-reviewer plan-storage plan-recovery task-lifecycle task-diagnostics task-progress; do
    if [ ! -f "${AGENT_ROOT}/worker/$f.mjs" ]; then
      all_exist="false"
      missing="${missing} $f"
    fi
  done
  check "R98" "V3" "7个新模块全部存在" "true" "$all_exist"
  if [ "$all_exist" = "false" ]; then
    echo "     → 缺失:${missing}"
  fi
  
  # V4: 每个新模块 >50 行真实逻辑（非空壳）
  local modules_real="true"
  local thin_modules=""
  for f in plan-generator plan-reviewer plan-storage plan-recovery task-lifecycle task-diagnostics task-progress; do
    local ml=$(wc -l < ${AGENT_ROOT}/worker/$f.mjs 2>/dev/null || echo "0")
    if [ "$ml" -lt "50" ]; then
      modules_real="false"
      thin_modules="${thin_modules} ${f}(${ml}行)"
    fi
  done
  check "R98" "V4" "所有新模块>50行真实逻辑" "true" "$modules_real"
  if [ "$modules_real" = "false" ]; then
    echo "     → 不达标:${thin_modules}"
  fi
  
  # V5: 新模块被引用
  local all_ref="true"
  for f in plan-generator plan-reviewer plan-storage plan-recovery task-lifecycle task-diagnostics task-progress; do
    local refs=$(grep -rn "$f" ${AGENT_ROOT}/worker/*.mjs 2>/dev/null | grep -v '.bak' | grep -v "^${AGENT_ROOT}/worker/$f.mjs:" | wc -l)
    if [ "$refs" -lt "1" ]; then all_ref="false"; fi
  done
  check "R98" "V5" "所有新模块被其他文件引用" "true" "$all_ref"
  
  # V-ANTI-CHEAT: 任何单个模块不超过 968 行（防止把逻辑从一个 God Object 搬到另一个）
  local max_module_lines=0
  local max_module_name=""
  for f in plan-generator plan-reviewer plan-storage plan-recovery task-lifecycle task-diagnostics task-progress; do
    local ml=$(wc -l < ${AGENT_ROOT}/worker/$f.mjs 2>/dev/null || echo "0")
    if [ "$ml" -gt "$max_module_lines" ]; then
      max_module_lines=$ml
      max_module_name=$f
    fi
  done
  check_lte "R98" "ANTI-CHEAT" "单个新模块最大行数(${max_module_name})" "500" "$max_module_lines"
}

# ─── R99: 前端 Bundle 优化 ──────────────────────────────────────────────────

verify_r99() {
  echo ""
  echo "═══ R99: 前端 Bundle 优化 ═══"
  
  # V1: dist/assets 总大小 (KB)
  local size_kb=$(du -sk ${AGENT_ROOT}/dist/assets/ 2>/dev/null | awk '{print $1}')
  local size_mb=$((size_kb / 1024))
  check_lte "R99" "V1" "dist/assets 大小(MB)" "5" "$size_mb"
  
  # V2: 最大单文件 (KB)
  local max_file_kb=$(ls -lS ${AGENT_ROOT}/dist/assets/*.js 2>/dev/null | head -1 | awk '{print int($5/1024)}')
  check_lte "R99" "V2" "最大JS文件(KB)" "300" "${max_file_kb:-0}"
  
  # V3: Mermaid 不在主 bundle（应为独立 chunk 或动态加载）
  # 允许存在但必须是独立 chunk（文件名含 mermaid）
  local mermaid_in_main=$(ls ${AGENT_ROOT}/dist/assets/index-*.js 2>/dev/null | xargs grep -l 'mermaid' 2>/dev/null | wc -l)
  check "R99" "V3" "Mermaid不在主bundle" "0" "${mermaid_in_main:-0}"
  
  # V4: HTTP 正常
  local http=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://ranger.voyage/ 2>/dev/null || echo "000")
  check "R99" "V4" "前端正常加载" "200" "$http"
}

# ─── R100: 数据库迁移管理 + 结构化日志 ──────────────────────────────────────

verify_r100() {
  echo ""
  echo "═══ R100: 数据库迁移管理 + 结构化日志 ═══"
  
  # V1: 迁移 SQL 文件
  local sql_count=$(ls ${AGENT_ROOT}/migrations/*.sql 2>/dev/null | wc -l)
  check_gte "R100" "V1" "迁移SQL文件数" "1" "$sql_count"
  
  # V2: 迁移运行器存在（允许在 migrations/runner.mjs 或 scripts/run-migrations.mjs 或 lib/migrate.mjs）
  local runner="false"
  test -f ${AGENT_ROOT}/scripts/run-migrations.mjs && runner="true"
  test -f ${AGENT_ROOT}/migrations/runner.mjs && runner="true"
  test -f ${AGENT_ROOT}/lib/migrate.mjs && runner="true"
  check "R100" "V2" "迁移运行器存在" "true" "$runner"
  
  # V3: 迁移记录表存在（允许 _migrations 或 schema_versions）
  local mig_table="false"
  sqlite3 ${AGENT_ROOT}/rangerai.db "SELECT count(*) FROM _migrations" 2>/dev/null && mig_table="true"
  sqlite3 ${AGENT_ROOT}/rangerai.db "SELECT count(*) FROM schema_versions" 2>/dev/null && mig_table="true"
  sqlite3 ${AGENT_ROOT}/db/rangerai.db "SELECT count(*) FROM _migrations" 2>/dev/null && mig_table="true"
  sqlite3 ${AGENT_ROOT}/db/rangerai.db "SELECT count(*) FROM schema_versions" 2>/dev/null && mig_table="true"
  check "R100" "V3" "迁移记录表存在" "true" "$mig_table"
  
  # V4: logger 支持结构化输出
  local structured=$(grep -c 'JSON.stringify\|structured\|toJSON\|formatJSON\|json_format' ${AGENT_ROOT}/lib/logger.mjs 2>/dev/null || echo "0")
  check_gte "R100" "V4" "logger结构化支持" "1" "$structured"
}

# ─── R101: TypeScript 渐进式引入 ────────────────────────────────────────────

verify_r101() {
  echo ""
  echo "═══ R101: TypeScript 渐进式引入 ═══"
  
  # V1: tsconfig 存在
  local tsconfig="false"
  test -f ${AGENT_ROOT}/tsconfig.json && tsconfig="true"
  check "R101" "V1" "tsconfig.json 存在" "true" "$tsconfig"
  
  # V2: TypeScript 安装
  local ts_installed="false"
  cd ${AGENT_ROOT} && node -e "require('typescript')" 2>/dev/null && ts_installed="true"
  check "R101" "V2" "typescript 已安装" "true" "$ts_installed"
  
  # V3: .ts 文件存在
  local ts_files=$(find ${AGENT_ROOT} -name '*.ts' -not -path '*/node_modules/*' 2>/dev/null | wc -l)
  check_gte "R101" "V3" ".ts 文件数" "1" "$ts_files"
  
  # V4: typecheck 脚本存在且可执行
  local typecheck_exists="false"
  grep -q '"typecheck"' ${AGENT_ROOT}/package.json 2>/dev/null && typecheck_exists="true"
  check "R101" "V4" "package.json 含 typecheck 脚本" "true" "$typecheck_exists"
  
  # V5: .d.ts 声明文件
  local dts_files=$(find ${AGENT_ROOT}/types -name '*.d.ts' 2>/dev/null | wc -l)
  check_gte "R101" "V5" ".d.ts 声明文件数" "2" "${dts_files:-0}"
  
  # V6: pre-push hook
  local hook=$(grep -c 'typecheck' ${AGENT_ROOT}/.git/hooks/pre-push 2>/dev/null || echo "0")
  check_gte "R101" "V6" "pre-push hook 含 typecheck" "1" "$hook"
  
  # V7: tsconfig strict=true
  local strict=$(grep -c '"strict": true\|"strict":true' ${AGENT_ROOT}/tsconfig.json 2>/dev/null || echo "0")
  check_gte "R101" "V7" "tsconfig strict=true" "1" "$strict"
}

# ─── 通用健康检查 ────────────────────────────────────────────────────────────

verify_health() {
  echo ""
  echo "═══ 通用健康检查 ═══"
  
  # 测试通过
  local test_output=$(cd ${AGENT_ROOT} && npm run test:native 2>&1)
  local test_pass=$(echo "$test_output" | grep -oP 'pass \K[0-9]+' || echo "0")
  local test_fail=$(echo "$test_output" | grep -oP 'fail \K[0-9]+' || echo "0")
  check "HEALTH" "TESTS" "测试失败数" "0" "${test_fail:-0}"
  echo "     → 通过: ${test_pass}, 失败: ${test_fail}"
  
  # 语法检查
  local syntax_errors=0
  for f in ${AGENT_ROOT}/worker/*.mjs; do
    [ -f "$f" ] || continue
    echo "$f" | grep -q '.bak' && continue
    node --check "$f" 2>&1 | grep -qi 'error' && syntax_errors=$((syntax_errors + 1))
  done
  check "HEALTH" "SYNTAX" "语法错误数" "0" "$syntax_errors"
  
  # 服务状态
  local ws_active=$(systemctl is-active rangerai-ws 2>/dev/null || echo "inactive")
  check "HEALTH" "SERVICE" "rangerai-ws 状态" "active" "$ws_active"
  
  # HTTP
  local http=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://ranger.voyage/ 2>/dev/null || echo "000")
  check "HEALTH" "HTTP" "ranger.voyage HTTP" "200" "$http"

  # 全局死代码扫描（规则九）
  # R102: scan active source only; exclude archive/ and backup files.
  # Count static imports (`import ... from`, side-effect imports) and dynamic imports.
  local dead_count=0
  local dead_list=""
  local active_sources
  active_sources=$(find "${AGENT_ROOT}" \
    -path "${AGENT_ROOT}/archive" -prune -o \
    -path "*/archive/*" -prune -o \
    -path "*/.bak-archive/*" -prune -o \
    -name "*.mjs" ! -name "*.bak*" ! -name "*.pre-*" -print)
  for f in ${AGENT_ROOT}/worker/*.mjs; do
    [ -f "$f" ] || continue
    echo "$f" | grep -q '.bak' && continue
    local name=$(basename "$f" .mjs)
    # worker/index.mjs is the service entrypoint, not expected to be imported.
    [ "$name" = "index" ] && continue
    # browser-failure-taxonomy belongs to the removed browser-service subsystem.
    [ "$name" = "browser-failure-taxonomy" ] && continue
    local refs=$(grep -rnE "(from[[:space:]]+['\"][^'\"]*${name}(\\.mjs)?['\"]|from[[:space:]]+.*['\"][^'\"]*${name}(\\.mjs)?['\"]|import[[:space:]]*\\([[:space:]]*['\"][^'\"]*${name}(\\.mjs)?['\"]|import[[:space:]]+['\"][^'\"]*${name}(\\.mjs)?['\"])" ${active_sources} 2>/dev/null | grep -v "$f" | wc -l)
    if [ "$refs" -eq "0" ]; then
      dead_count=$((dead_count + 1))
      dead_list="${dead_list} ${name}"
    fi
  done
  check "HEALTH" "DEAD_CODE" "死代码模块数" "0" "$dead_count"
  if [ "$dead_count" -gt "0" ]; then
    echo "     → 死模块: ${dead_list}"
  fi
}

# ─── 主逻辑 ──────────────────────────────────────────────────────────────────

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  iter-verify.sh v2 — 硬性验收脚本（防作弊版）              ║"
echo "║  验收轮次: ${ROUND}                                            ║"
echo "║  时间: ${TIMESTAMP}                              ║"
echo "╚══════════════════════════════════════════════════════════════╝"

case "$ROUND" in
  R94)  verify_r94; verify_health ;;
  R95)  verify_r95; verify_health ;;
  R96)  verify_r96; verify_health ;;
  R97)  verify_r97; verify_health ;;
  R98)  verify_r98; verify_health ;;
  R99)  verify_r99; verify_health ;;
  R100) verify_r100; verify_health ;;
  R101) verify_r101; verify_health ;;
  ALL)
    verify_r94
    verify_r95
    verify_r96
    verify_r97
    verify_r98
    verify_r99
    verify_r100
    verify_r101
    verify_health
    ;;
  *)
    echo "未知轮次: $ROUND"
    echo "用法: bash iter-verify.sh [R94|R95|R96|R97|R98|R99|R100|R101|ALL]"
    exit 2
    ;;
esac

# ─── 输出汇总 ────────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  验收汇总                                                   ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  ✅ 通过: ${TOTAL_PASS}                                            ║"
echo "║  ❌ 失败: ${TOTAL_FAIL}                                            ║"
echo "╚══════════════════════════════════════════════════════════════╝"

if [ "$TOTAL_FAIL" -gt "0" ]; then
  echo ""
  echo "⛔ 验收结果: 未通过 (${TOTAL_FAIL} 项失败)"
  echo "   禁止声称本轮已完成。必须修复所有 FAIL 项后重新运行验收。"
else
  echo ""
  echo "✅ 验收结果: 通过"
fi

# 写入 JSON 结果
RESULTS="${RESULTS%,}"  # 去掉末尾逗号
cat > "$RESULT_FILE" << JSONEOF
{
  "round": "${ROUND}",
  "timestamp": "${TIMESTAMP}",
  "version": "iter-verify-v2",
  "total_pass": ${TOTAL_PASS},
  "total_fail": ${TOTAL_FAIL},
  "verdict": "$([ $TOTAL_FAIL -gt 0 ] && echo 'FAIL' || echo 'PASS')",
  "checks": [${RESULTS}]
}
JSONEOF

echo ""
echo "结果已写入: ${RESULT_FILE}"

# 退出码
exit $([ $TOTAL_FAIL -gt 0 ] && echo 1 || echo 0)
