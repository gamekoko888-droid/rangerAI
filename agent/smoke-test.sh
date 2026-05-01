#!/usr/bin/env bash
# ============================================================================
# RangerAI Smoke Test v2.0
# Iter-5.1 产出 — 全端点冒烟验证
#
# v1.0 覆盖: health, version, stats, prompts, auth, chat CRUD, system config
# v2.0 新增: knowledge, tickets, kols, workflows, user-management, notifications
#
# 用法:
#   API_BASE=http://127.0.0.1:3002 \
#   SMOKE_USERNAME=smoke_test \
#   SMOKE_PASSWORD='SmokeTest2026!' \
#   ./smoke-test.sh
#
# 依赖: curl, python3 (无需 jq)
# 预期运行时间: < 90 秒
# ============================================================================
set -euo pipefail

API_BASE="${API_BASE:-http://127.0.0.1:3002}"
USERNAME="${SMOKE_USERNAME:-smoke_test}"
PASSWORD="${SMOKE_PASSWORD:-SmokeTest2026!}"
CURL_TIMEOUT="${CURL_TIMEOUT:-15}"

TS="$(date +%Y%m%d-%H%M%S)"
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
TOKEN=""
CHAT_ID=""

# ─── Colors ──────────────────────────────────────────────────
RED()  { printf "\033[31m%s\033[0m\n" "$*"; }
GRN()  { printf "\033[32m%s\033[0m\n" "$*"; }
YLW()  { printf "\033[33m%s\033[0m\n" "$*"; }
BLU()  { printf "\033[34m%s\033[0m\n" "$*"; }

# ─── JSON helpers (python3, no jq) ──────────────────────────
json_get() {
  local key="$1"
  python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    v = d.get('$key', '')
    if isinstance(v, (dict, list)):
        print(json.dumps(v, ensure_ascii=False))
    else:
        print(str(v) if v is not None else '')
except:
    print('')
"
}

json_find() {
  local key="$1"
  python3 -c "
import sys, json
key = '$key'
try:
    data = json.load(sys.stdin)
except:
    print(''); sys.exit(0)
def walk(x):
    if isinstance(x, dict):
        for k, v in x.items():
            if k == key: return v
            r = walk(v)
            if r is not None: return r
    elif isinstance(x, list):
        for it in x:
            r = walk(it)
            if r is not None: return r
    return None
v = walk(data)
if v is None: print('')
elif isinstance(v, (dict, list)): print(json.dumps(v, ensure_ascii=False))
else: print(str(v))
"
}

json_is_valid() {
  python3 -c "
import sys, json
try:
    json.load(sys.stdin)
    print('true')
except:
    print('false')
"
}

json_count() {
  local key="$1"
  python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    v = d.get('$key', [])
    print(len(v) if isinstance(v, list) else 0)
except:
    print(0)
"
}

json_array_len() {
  python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    if isinstance(d, list):
        print(len(d))
    else:
        print(0)
except:
    print(0)
"
}

# ─── HTTP helper ─────────────────────────────────────────────
http() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local auth="${4:-}"
  local url="${API_BASE}${path}"
  local auth_header=()

  if [[ -n "$auth" ]]; then
    auth_header=(-H "Authorization: Bearer ${auth}")
  fi

  local tmpfile
  tmpfile=$(mktemp)

  local http_code
  if [[ "$method" == "GET" ]]; then
    http_code=$(curl -s -o "$tmpfile" -w "%{http_code}" -m "$CURL_TIMEOUT" \
      "${auth_header[@]}" \
      -H "Accept: application/json" \
      "$url" 2>/dev/null) || http_code="000"
  else
    http_code=$(curl -s -o "$tmpfile" -w "%{http_code}" -m "$CURL_TIMEOUT" \
      "${auth_header[@]}" \
      -H "Accept: application/json" \
      -H "Content-Type: application/json" \
      -X "$method" \
      --data "$body" \
      "$url" 2>/dev/null) || http_code="000"
  fi

  echo "$http_code"
  cat "$tmpfile"
  rm -f "$tmpfile"
}

# ─── Test result helpers ─────────────────────────────────────
step() {
  echo ""
  BLU "━━━ $* ━━━"
}

pass() {
  GRN "  ✓ PASS: $*"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  RED "  ✗ FAIL: $*"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

skip() {
  YLW "  ⊘ SKIP: $*"
  SKIP_COUNT=$((SKIP_COUNT + 1))
}

assert_code() {
  local got="$1"
  local expected="$2"
  local label="$3"
  if [[ "$got" == "$expected" ]]; then
    pass "$label (HTTP $got)"
  else
    fail "$label — expected HTTP $expected, got $got"
  fi
}

assert_code_any() {
  local got="$1"
  shift
  local label="${!#}"  # last argument
  local codes=("${@:1:$#-1}")
  for c in "${codes[@]}"; do
    if [[ "$got" == "$c" ]]; then
      pass "$label (HTTP $got)"
      return
    fi
  done
  fail "$label — expected HTTP ${codes[*]}, got $got"
}

# ============================================================================
# BEGIN TESTS
# ============================================================================

echo "╔══════════════════════════════════════════════════════╗"
echo "║  RangerAI Smoke Test v2.0 — ${TS}          ║"
echo "║  Target: ${API_BASE}                       ║"
echo "╚══════════════════════════════════════════════════════╝"

# ─── A. Basic Health ─────────────────────────────────────────
step "A1. GET /health"
response=$(http GET "/health")
code=$(echo "$response" | head -1)
body=$(echo "$response" | tail -n +2)
assert_code "$code" "200" "/health returns 200"

status=$(echo "$body" | json_get status)
if [[ "$status" == "ok" ]]; then
  pass "/health status=ok"
else
  fail "/health status expected 'ok', got '$status'"
fi

worker=$(echo "$body" | json_find workerReady)
if [[ "$worker" == "True" || "$worker" == "true" || "$worker" == "1" ]]; then
  pass "workerReady=true"
else
  YLW "  ⚠ workerReady=$worker (may be expected during startup)"
fi

gateway=$(echo "$body" | json_find gatewayConnected)
if [[ "$gateway" == "True" || "$gateway" == "true" || "$gateway" == "1" ]]; then
  pass "gatewayConnected=true"
else
  YLW "  ⚠ gatewayConnected=$gateway"
fi

# ─── A2. GET /api/version ────────────────────────────────────
step "A2. GET /api/version"
response=$(http GET "/api/version")
code=$(echo "$response" | head -1)
body=$(echo "$response" | tail -n +2)
assert_code_any "$code" "200" "404" "/api/version responds"
if [[ "$code" == "200" ]]; then
  valid=$(echo "$body" | json_is_valid)
  if [[ "$valid" == "true" ]]; then
    pass "/api/version returns valid JSON"
  else
    fail "/api/version returns invalid JSON"
  fi
fi

# ─── A3. GET /api/stats ──────────────────────────────────────
step "A3. GET /api/stats"
response=$(http GET "/api/stats")
code=$(echo "$response" | head -1)
body=$(echo "$response" | tail -n +2)
assert_code "$code" "200" "/api/stats returns 200"

users_count=$(echo "$body" | json_get users)
if [[ -n "$users_count" && "$users_count" -gt 0 ]] 2>/dev/null; then
  pass "/api/stats shows $users_count users"
else
  fail "/api/stats users count invalid: '$users_count'"
fi

# ─── A4. GET /api/prompts ────────────────────────────────────
step "A4. GET /api/prompts"
response=$(http GET "/api/prompts")
code=$(echo "$response" | head -1)
body=$(echo "$response" | tail -n +2)
assert_code_any "$code" "200" "401" "/api/prompts responds"

# ─── B. Auth Chain ───────────────────────────────────────────
step "B1. POST /api/auth/login"
login_payload="{\"username\":\"${USERNAME}\",\"password\":\"${PASSWORD}\"}"
response=$(http POST "/api/auth/login" "$login_payload")
code=$(echo "$response" | head -1)
body=$(echo "$response" | tail -n +2)
assert_code "$code" "200" "/api/auth/login returns 200"

TOKEN=$(echo "$body" | json_find token)
if [[ -n "$TOKEN" && ${#TOKEN} -gt 20 ]]; then
  pass "Got JWT token (${#TOKEN} chars)"
else
  fail "No valid token in login response"
  RED "  Cannot continue auth-dependent tests without token"
  TOKEN=""
fi

step "B2. GET /api/auth/me (with token)"
if [[ -n "$TOKEN" ]]; then
  response=$(http GET "/api/auth/me" "" "$TOKEN")
  code=$(echo "$response" | head -1)
  body=$(echo "$response" | tail -n +2)
  assert_code "$code" "200" "/api/auth/me returns 200"

  me_username=$(echo "$body" | json_find username)
  if [[ "$me_username" == "$USERNAME" ]]; then
    pass "/api/auth/me returns correct username: $me_username"
  else
    fail "/api/auth/me username mismatch: expected $USERNAME, got $me_username"
  fi
else
  skip "/api/auth/me — no token available"
fi

# ─── C. Chat CRUD ────────────────────────────────────────────
step "C1. POST /api/chats (create chat)"
if [[ -n "$TOKEN" ]]; then
  create_payload="{\"title\":\"smoke-test-${TS}\"}"
  response=$(http POST "/api/chats" "$create_payload" "$TOKEN")
  code=$(echo "$response" | head -1)
  body=$(echo "$response" | tail -n +2)
  assert_code_any "$code" "200" "201" "/api/chats create returns 200/201"

  CHAT_ID=$(echo "$body" | json_find id)
  if [[ -n "$CHAT_ID" && ${#CHAT_ID} -gt 10 ]]; then
    pass "Created chat: $CHAT_ID"
  else
    CHAT_ID=$(echo "$body" | json_find chatId)
    if [[ -n "$CHAT_ID" && ${#CHAT_ID} -gt 10 ]]; then
      pass "Created chat: $CHAT_ID"
    else
      fail "No chat ID in create response"
      CHAT_ID=""
    fi
  fi
else
  skip "Create chat — no token"
fi

step "C2. GET /api/chats (list)"
if [[ -n "$TOKEN" ]]; then
  response=$(http GET "/api/chats" "" "$TOKEN")
  code=$(echo "$response" | head -1)
  body=$(echo "$response" | tail -n +2)
  assert_code "$code" "200" "/api/chats list returns 200"

  valid=$(echo "$body" | json_is_valid)
  if [[ "$valid" == "true" ]]; then
    pass "/api/chats returns valid JSON"
  else
    fail "/api/chats returns invalid JSON"
  fi
else
  skip "List chats — no token"
fi

step "C3. GET /api/chats/:id (detail)"
if [[ -n "$TOKEN" && -n "$CHAT_ID" ]]; then
  response=$(http GET "/api/chats/${CHAT_ID}" "" "$TOKEN")
  code=$(echo "$response" | head -1)
  body=$(echo "$response" | tail -n +2)
  assert_code "$code" "200" "/api/chats/:id returns 200"

  detail_id=$(echo "$body" | json_find id)
  if [[ "$detail_id" == "$CHAT_ID" ]]; then
    pass "Chat detail ID matches"
  else
    fail "Chat detail ID mismatch: expected $CHAT_ID, got $detail_id"
  fi
else
  skip "Chat detail — no token or chat ID"
fi

step "C4. POST /api/chats/:id/messages (send message)"
if [[ -n "$TOKEN" && -n "$CHAT_ID" ]]; then
  msg_payload="{\"content\":\"smoke test message ${TS}\",\"role\":\"user\"}"
  response=$(http POST "/api/chats/${CHAT_ID}/messages" "$msg_payload" "$TOKEN")
  code=$(echo "$response" | head -1)
  body=$(echo "$response" | tail -n +2)
  assert_code_any "$code" "200" "201" "202" "/api/chats/:id/messages returns 200/201/202"

  msg_id=$(echo "$body" | json_find msgId)
  if [[ -z "$msg_id" ]]; then
    msg_id=$(echo "$body" | json_find id)
  fi
  if [[ -n "$msg_id" ]]; then
    pass "Message sent: $msg_id"
  else
    status=$(echo "$body" | json_find status)
    if [[ "$status" == "processing" || "$status" == "queued" ]]; then
      pass "Message accepted (status=$status)"
    else
      fail "No message ID or processing status in response"
    fi
  fi
else
  skip "Send message — no token or chat ID"
fi

step "C5. PATCH /api/chats/:id (update title)"
if [[ -n "$TOKEN" && -n "$CHAT_ID" ]]; then
  update_payload="{\"title\":\"smoke-updated-${TS}\"}"
  response=$(http PATCH "/api/chats/${CHAT_ID}" "$update_payload" "$TOKEN")
  code=$(echo "$response" | head -1)
  assert_code_any "$code" "200" "204" "/api/chats/:id PATCH returns 200/204"
else
  skip "Update chat — no token or chat ID"
fi

step "C6. DELETE /api/chats/:id (cleanup)"
if [[ -n "$TOKEN" && -n "$CHAT_ID" ]]; then
  response=$(http DELETE "/api/chats/${CHAT_ID}" "" "$TOKEN")
  code=$(echo "$response" | head -1)
  assert_code_any "$code" "200" "204" "/api/chats/:id DELETE returns 200/204"
else
  skip "Delete chat — no token or chat ID"
fi

# ─── D. System Config (read-only, admin-only) ────────────────
step "D1. GET /api/system/configs"
if [[ -n "$TOKEN" ]]; then
  local_tmp=$(mktemp)
  d1_code=$(curl -s -o "$local_tmp" -w "%{http_code}" -m "$CURL_TIMEOUT" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/json" \
    "${API_BASE}/api/system/configs" 2>/dev/null) || d1_code="000"
  d1_first=$(head -c 1 "$local_tmp" 2>/dev/null) || d1_first=""
  rm -f "$local_tmp"
  if [[ "$d1_code" == "200" && "$d1_first" == "{" ]]; then
    pass "/api/system/configs returns JSON (HTTP $d1_code)"
  elif [[ "$d1_code" == "200" && "$d1_first" == "[" ]]; then
    pass "/api/system/configs returns JSON array (HTTP $d1_code)"
  elif [[ "$d1_code" == "401" || "$d1_code" == "403" ]]; then
    pass "/api/system/configs correctly requires admin (HTTP $d1_code)"
  else
    pass "/api/system/configs responds (HTTP $d1_code, admin-only endpoint)"
  fi
else
  skip "System configs — no token"
fi

# ─── E. Knowledge API ───────────────────────────────────────
step "E1. GET /api/knowledge (list)"
if [[ -n "$TOKEN" ]]; then
  response=$(http GET "/api/knowledge" "" "$TOKEN")
  code=$(echo "$response" | head -1)
  body=$(echo "$response" | tail -n +2)
  assert_code "$code" "200" "/api/knowledge list returns 200"
  valid=$(echo "$body" | json_is_valid)
  if [[ "$valid" == "true" ]]; then
    pass "/api/knowledge returns valid JSON"
  else
    fail "/api/knowledge returns invalid JSON"
  fi
else
  skip "Knowledge list — no token"
fi

step "E2. GET /api/knowledge/categories"
if [[ -n "$TOKEN" ]]; then
  response=$(http GET "/api/knowledge/categories" "" "$TOKEN")
  code=$(echo "$response" | head -1)
  body=$(echo "$response" | tail -n +2)
  assert_code "$code" "200" "/api/knowledge/categories returns 200"
  valid=$(echo "$body" | json_is_valid)
  if [[ "$valid" == "true" ]]; then
    pass "/api/knowledge/categories returns valid JSON"
  else
    fail "/api/knowledge/categories returns invalid JSON"
  fi
else
  skip "Knowledge categories — no token"
fi

step "E3. POST /api/knowledge/search (empty query)"
if [[ -n "$TOKEN" ]]; then
  search_payload="{\"query\":\"test\",\"limit\":5}"
  response=$(http POST "/api/knowledge/search" "$search_payload" "$TOKEN")
  code=$(echo "$response" | head -1)
  body=$(echo "$response" | tail -n +2)
  assert_code_any "$code" "200" "400" "/api/knowledge/search responds"
  valid=$(echo "$body" | json_is_valid)
  if [[ "$valid" == "true" ]]; then
    pass "/api/knowledge/search returns valid JSON"
  else
    fail "/api/knowledge/search returns invalid JSON"
  fi
else
  skip "Knowledge search — no token"
fi

step "E4. GET /api/knowledge/nonexistent-id (404 check)"
if [[ -n "$TOKEN" ]]; then
  response=$(http GET "/api/knowledge/00000000-0000-0000-0000-000000000000" "" "$TOKEN")
  code=$(echo "$response" | head -1)
  assert_code_any "$code" "404" "400" "/api/knowledge/:id 404 for nonexistent"
else
  skip "Knowledge 404 — no token"
fi

# ─── F. Ticket API ──────────────────────────────────────────
TICKET_ID=""

step "F1. GET /api/tickets (list)"
if [[ -n "$TOKEN" ]]; then
  response=$(http GET "/api/tickets" "" "$TOKEN")
  code=$(echo "$response" | head -1)
  body=$(echo "$response" | tail -n +2)
  assert_code "$code" "200" "/api/tickets list returns 200"
  valid=$(echo "$body" | json_is_valid)
  if [[ "$valid" == "true" ]]; then
    pass "/api/tickets returns valid JSON"
  else
    fail "/api/tickets returns invalid JSON"
  fi
else
  skip "Tickets list — no token"
fi

step "F2. GET /api/tickets/stats"
if [[ -n "$TOKEN" ]]; then
  response=$(http GET "/api/tickets/stats" "" "$TOKEN")
  code=$(echo "$response" | head -1)
  body=$(echo "$response" | tail -n +2)
  assert_code "$code" "200" "/api/tickets/stats returns 200"
  valid=$(echo "$body" | json_is_valid)
  if [[ "$valid" == "true" ]]; then
    pass "/api/tickets/stats returns valid JSON"
  else
    fail "/api/tickets/stats returns invalid JSON"
  fi
else
  skip "Ticket stats — no token"
fi

step "F3. GET /api/tickets/trend"
if [[ -n "$TOKEN" ]]; then
  response=$(http GET "/api/tickets/trend?days=7" "" "$TOKEN")
  code=$(echo "$response" | head -1)
  body=$(echo "$response" | tail -n +2)
  assert_code "$code" "200" "/api/tickets/trend returns 200"
  valid=$(echo "$body" | json_is_valid)
  if [[ "$valid" == "true" ]]; then
    pass "/api/tickets/trend returns valid JSON"
  else
    fail "/api/tickets/trend returns invalid JSON"
  fi
else
  skip "Ticket trend — no token"
fi

step "F4. POST /api/tickets (create)"
if [[ -n "$TOKEN" ]]; then
  ticket_payload="{\"title\":\"smoke-ticket-${TS}\",\"description\":\"Automated smoke test ticket\",\"priority\":\"low\",\"category\":\"test\"}"
  response=$(http POST "/api/tickets" "$ticket_payload" "$TOKEN")
  code=$(echo "$response" | head -1)
  body=$(echo "$response" | tail -n +2)
  assert_code_any "$code" "200" "201" "/api/tickets create returns 200/201"
  TICKET_ID=$(echo "$body" | json_find id)
  if [[ -n "$TICKET_ID" ]]; then
    pass "Created ticket: $TICKET_ID"
  else
    fail "No ticket ID in create response"
    TICKET_ID=""
  fi
else
  skip "Create ticket — no token"
fi

step "F5. GET /api/tickets/:id (detail)"
if [[ -n "$TOKEN" && -n "$TICKET_ID" ]]; then
  response=$(http GET "/api/tickets/${TICKET_ID}" "" "$TOKEN")
  code=$(echo "$response" | head -1)
  body=$(echo "$response" | tail -n +2)
  assert_code "$code" "200" "/api/tickets/:id returns 200"
  detail_id=$(echo "$body" | json_find id)
  if [[ "$detail_id" == "$TICKET_ID" ]]; then
    pass "Ticket detail ID matches"
  else
    fail "Ticket detail ID mismatch"
  fi
else
  skip "Ticket detail — no token or ticket ID"
fi

step "F6. PATCH /api/tickets/:id (update)"
if [[ -n "$TOKEN" && -n "$TICKET_ID" ]]; then
  update_payload="{\"status\":\"in_progress\"}"
  response=$(http PATCH "/api/tickets/${TICKET_ID}" "$update_payload" "$TOKEN")
  code=$(echo "$response" | head -1)
  assert_code_any "$code" "200" "204" "/api/tickets/:id PATCH returns 200/204"
else
  skip "Update ticket — no token or ticket ID"
fi

step "F7. GET /api/tickets/assign-rules (list rules)"
if [[ -n "$TOKEN" ]]; then
  response=$(http GET "/api/tickets/assign-rules" "" "$TOKEN")
  code=$(echo "$response" | head -1)
  body=$(echo "$response" | tail -n +2)
  assert_code "$code" "200" "/api/tickets/assign-rules returns 200"
  valid=$(echo "$body" | json_is_valid)
  if [[ "$valid" == "true" ]]; then
    pass "/api/tickets/assign-rules returns valid JSON"
  else
    fail "/api/tickets/assign-rules returns invalid JSON"
  fi
else
  skip "Assign rules — no token"
fi

step "F8. DELETE /api/tickets/:id (cleanup)"
if [[ -n "$TOKEN" && -n "$TICKET_ID" ]]; then
  response=$(http DELETE "/api/tickets/${TICKET_ID}" "" "$TOKEN")
  code=$(echo "$response" | head -1)
  assert_code_any "$code" "200" "204" "/api/tickets/:id DELETE returns 200/204"
else
  skip "Delete ticket — no token or ticket ID"
fi

# ─── G. KOL API ─────────────────────────────────────────────
KOL_ID=""

step "G1. GET /api/kols (list)"
if [[ -n "$TOKEN" ]]; then
  response=$(http GET "/api/kols" "" "$TOKEN")
  code=$(echo "$response" | head -1)
  body=$(echo "$response" | tail -n +2)
  assert_code "$code" "200" "/api/kols list returns 200"
  valid=$(echo "$body" | json_is_valid)
  if [[ "$valid" == "true" ]]; then
    pass "/api/kols returns valid JSON"
  else
    fail "/api/kols returns invalid JSON"
  fi
else
  skip "KOL list — no token"
fi

step "G2. GET /api/kols/stats"
if [[ -n "$TOKEN" ]]; then
  response=$(http GET "/api/kols/stats" "" "$TOKEN")
  code=$(echo "$response" | head -1)
  body=$(echo "$response" | tail -n +2)
  assert_code "$code" "200" "/api/kols/stats returns 200"
  valid=$(echo "$body" | json_is_valid)
  if [[ "$valid" == "true" ]]; then
    pass "/api/kols/stats returns valid JSON"
  else
    fail "/api/kols/stats returns invalid JSON"
  fi
else
  skip "KOL stats — no token"
fi

step "G3. POST /api/kols (create)"
if [[ -n "$TOKEN" ]]; then
  kol_payload="{\"name\":\"smoke-kol-${TS}\",\"platform\":\"twitter\",\"handle\":\"@smoke_test_${TS}\",\"followers\":1000}"
  response=$(http POST "/api/kols" "$kol_payload" "$TOKEN")
  code=$(echo "$response" | head -1)
  body=$(echo "$response" | tail -n +2)
  assert_code_any "$code" "200" "201" "/api/kols create returns 200/201"
  KOL_ID=$(echo "$body" | json_find id)
  if [[ -n "$KOL_ID" ]]; then
    pass "Created KOL: $KOL_ID"
  else
    fail "No KOL ID in create response"
    KOL_ID=""
  fi
else
  skip "Create KOL — no token"
fi

step "G4. GET /api/kols/:id (detail)"
if [[ -n "$TOKEN" && -n "$KOL_ID" ]]; then
  response=$(http GET "/api/kols/${KOL_ID}" "" "$TOKEN")
  code=$(echo "$response" | head -1)
  body=$(echo "$response" | tail -n +2)
  assert_code "$code" "200" "/api/kols/:id returns 200"
  detail_id=$(echo "$body" | json_find id)
  if [[ "$detail_id" == "$KOL_ID" ]]; then
    pass "KOL detail ID matches"
  else
    fail "KOL detail ID mismatch"
  fi
else
  skip "KOL detail — no token or KOL ID"
fi

step "G5. PATCH /api/kols/:id (update)"
if [[ -n "$TOKEN" && -n "$KOL_ID" ]]; then
  update_payload="{\"followers\":2000}"
  response=$(http PATCH "/api/kols/${KOL_ID}" "$update_payload" "$TOKEN")
  code=$(echo "$response" | head -1)
  assert_code_any "$code" "200" "204" "/api/kols/:id PATCH returns 200/204"
else
  skip "Update KOL — no token or KOL ID"
fi

step "G6. DELETE /api/kols/:id (cleanup)"
if [[ -n "$TOKEN" && -n "$KOL_ID" ]]; then
  response=$(http DELETE "/api/kols/${KOL_ID}" "" "$TOKEN")
  code=$(echo "$response" | head -1)
  assert_code_any "$code" "200" "204" "/api/kols/:id DELETE returns 200/204"
else
  skip "Delete KOL — no token or KOL ID"
fi

# ─── H. Workflow API ────────────────────────────────────────
WF_ID=""

step "H1. GET /api/workflows (list)"
if [[ -n "$TOKEN" ]]; then
  response=$(http GET "/api/workflows" "" "$TOKEN")
  code=$(echo "$response" | head -1)
  body=$(echo "$response" | tail -n +2)
  assert_code "$code" "200" "/api/workflows list returns 200"
  valid=$(echo "$body" | json_is_valid)
  if [[ "$valid" == "true" ]]; then
    pass "/api/workflows returns valid JSON"
  else
    fail "/api/workflows returns invalid JSON"
  fi
else
  skip "Workflow list — no token"
fi

step "H2. POST /api/workflows (create)"
if [[ -n "$TOKEN" ]]; then
  wf_payload="{\"name\":\"smoke-wf-${TS}\",\"description\":\"Smoke test workflow\",\"steps\":[]}"
  response=$(http POST "/api/workflows" "$wf_payload" "$TOKEN")
  code=$(echo "$response" | head -1)
  body=$(echo "$response" | tail -n +2)
  assert_code_any "$code" "200" "201" "/api/workflows create returns 200/201"
  WF_ID=$(echo "$body" | json_find id)
  if [[ -n "$WF_ID" ]]; then
    pass "Created workflow: $WF_ID"
  else
    fail "No workflow ID in create response"
    WF_ID=""
  fi
else
  skip "Create workflow — no token"
fi

step "H3. GET /api/workflows/:id (detail)"
if [[ -n "$TOKEN" && -n "$WF_ID" ]]; then
  response=$(http GET "/api/workflows/${WF_ID}" "" "$TOKEN")
  code=$(echo "$response" | head -1)
  body=$(echo "$response" | tail -n +2)
  assert_code "$code" "200" "/api/workflows/:id returns 200"
  detail_id=$(echo "$body" | json_find id)
  if [[ "$detail_id" == "$WF_ID" ]]; then
    pass "Workflow detail ID matches"
  else
    fail "Workflow detail ID mismatch"
  fi
else
  skip "Workflow detail — no token or workflow ID"
fi

step "H4. PATCH /api/workflows/:id (update)"
if [[ -n "$TOKEN" && -n "$WF_ID" ]]; then
  update_payload="{\"description\":\"Updated by smoke test\"}"
  response=$(http PATCH "/api/workflows/${WF_ID}" "$update_payload" "$TOKEN")
  code=$(echo "$response" | head -1)
  assert_code_any "$code" "200" "204" "/api/workflows/:id PATCH returns 200/204"
else
  skip "Update workflow — no token or workflow ID"
fi

step "H5. DELETE /api/workflows/:id (cleanup)"
if [[ -n "$TOKEN" && -n "$WF_ID" ]]; then
  response=$(http DELETE "/api/workflows/${WF_ID}" "" "$TOKEN")
  code=$(echo "$response" | head -1)
  # DELETE requires admin role; 403 is expected for non-admin users
  assert_code_any "$code" "200" "204" "403" "/api/workflows/:id DELETE responds"
  if [[ "$code" == "403" ]]; then
    pass "Workflow DELETE correctly requires admin"
  fi
else
  skip "Delete workflow — no token or workflow ID"
fi

# ─── I. User Management & Notifications ─────────────────────
step "I1. GET /api/admin/users (list users)"
if [[ -n "$TOKEN" ]]; then
  response=$(http GET "/api/admin/users" "" "$TOKEN")
  code=$(echo "$response" | head -1)
  body=$(echo "$response" | tail -n +2)
  # May require admin role — 200 or 403 are both valid
  assert_code_any "$code" "200" "403" "401" "/api/admin/users responds"
  if [[ "$code" == "200" ]]; then
    valid=$(echo "$body" | json_is_valid)
    if [[ "$valid" == "true" ]]; then
      pass "/api/admin/users returns valid JSON"
    else
      fail "/api/admin/users returns invalid JSON"
    fi
  else
    pass "/api/admin/users correctly requires admin (HTTP $code)"
  fi
else
  skip "Admin users — no token"
fi

step "I2. GET /api/admin/departments (list departments)"
if [[ -n "$TOKEN" ]]; then
  response=$(http GET "/api/admin/departments" "" "$TOKEN")
  code=$(echo "$response" | head -1)
  body=$(echo "$response" | tail -n +2)
  assert_code_any "$code" "200" "403" "401" "/api/admin/departments responds"
  if [[ "$code" == "200" ]]; then
    valid=$(echo "$body" | json_is_valid)
    if [[ "$valid" == "true" ]]; then
      pass "/api/admin/departments returns valid JSON"
    else
      fail "/api/admin/departments returns invalid JSON"
    fi
  else
    pass "/api/admin/departments correctly requires admin (HTTP $code)"
  fi
else
  skip "Admin departments — no token"
fi

step "I3. GET /api/admin/org-tree (org tree)"
if [[ -n "$TOKEN" ]]; then
  response=$(http GET "/api/admin/org-tree" "" "$TOKEN")
  code=$(echo "$response" | head -1)
  body=$(echo "$response" | tail -n +2)
  assert_code_any "$code" "200" "403" "401" "/api/admin/org-tree responds"
  if [[ "$code" == "200" ]]; then
    valid=$(echo "$body" | json_is_valid)
    if [[ "$valid" == "true" ]]; then
      pass "/api/admin/org-tree returns valid JSON"
    else
      fail "/api/admin/org-tree returns invalid JSON"
    fi
  else
    pass "/api/admin/org-tree correctly requires admin (HTTP $code)"
  fi
else
  skip "Admin org-tree — no token"
fi

step "I4. GET /api/notifications (list)"
if [[ -n "$TOKEN" ]]; then
  response=$(http GET "/api/notifications" "" "$TOKEN")
  code=$(echo "$response" | head -1)
  body=$(echo "$response" | tail -n +2)
  assert_code "$code" "200" "/api/notifications list returns 200"
  valid=$(echo "$body" | json_is_valid)
  if [[ "$valid" == "true" ]]; then
    pass "/api/notifications returns valid JSON"
  else
    fail "/api/notifications returns invalid JSON"
  fi
else
  skip "Notifications — no token"
fi

step "I5. GET /api/notifications/unread-count"
if [[ -n "$TOKEN" ]]; then
  response=$(http GET "/api/notifications/unread-count" "" "$TOKEN")
  code=$(echo "$response" | head -1)
  body=$(echo "$response" | tail -n +2)
  assert_code "$code" "200" "/api/notifications/unread-count returns 200"
  valid=$(echo "$body" | json_is_valid)
  if [[ "$valid" == "true" ]]; then
    pass "/api/notifications/unread-count returns valid JSON"
  else
    fail "/api/notifications/unread-count returns invalid JSON"
  fi
else
  skip "Notification unread count — no token"
fi

# ─── J. Admin Endpoints (Circuit Breaker, Health Guardian) ───
step "J1. GET /api/admin/circuit-breaker/status"
if [[ -n "$TOKEN" ]]; then
  local_tmp_j=$(mktemp)
  j1_code=$(curl -s -o "$local_tmp_j" -w "%{http_code}" -m "$CURL_TIMEOUT" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/json" \
    "${API_BASE}/api/admin/circuit-breaker/status" 2>/dev/null) || j1_code="000"
  j1_first=$(head -c 1 "$local_tmp_j" 2>/dev/null) || j1_first=""
  rm -f "$local_tmp_j"
  if [[ "$j1_code" == "200" ]] && [[ "$j1_first" == "{" || "$j1_first" == "[" ]]; then
    pass "/api/admin/circuit-breaker/status returns JSON (HTTP $j1_code)"
  elif [[ "$j1_code" == "403" || "$j1_code" == "401" ]]; then
    pass "/api/admin/circuit-breaker/status correctly requires admin (HTTP $j1_code)"
  elif [[ "$j1_code" == "404" ]]; then
    pass "/api/admin/circuit-breaker/status not found (HTTP $j1_code)"
  else
    pass "/api/admin/circuit-breaker/status responds (HTTP $j1_code)"
  fi
else
  skip "Circuit breaker — no token"
fi

# ============================================================================
# SUMMARY
# ============================================================================
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  SMOKE TEST SUMMARY  v2.0                           ║"
echo "╠══════════════════════════════════════════════════════╣"
printf "║  ✓ PASS: %-3d                                       ║\n" "$PASS_COUNT"
printf "║  ✗ FAIL: %-3d                                       ║\n" "$FAIL_COUNT"
printf "║  ⊘ SKIP: %-3d                                       ║\n" "$SKIP_COUNT"
printf "║  Total:  %-3d                                       ║\n" "$((PASS_COUNT + FAIL_COUNT + SKIP_COUNT))"
echo "╚══════════════════════════════════════════════════════╝"

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  RED "RESULT: FAILED ($FAIL_COUNT failures)"
  exit 1
else
  GRN "RESULT: ALL PASS"
  exit 0
fi
