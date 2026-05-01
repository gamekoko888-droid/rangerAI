#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="/opt/rangerai-agent/logs/daily-diagnosis.log"
mkdir -p "$(dirname "$LOG_FILE")"

# Timestamp header
now="$(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "" >> "$LOG_FILE"
echo "===== DAILY_DIAGNOSIS $now =====" >> "$LOG_FILE"

alert=0

# 1) Gateway status
{
  echo "[gateway] systemd: $(systemctl is-active openclaw-gateway.service 2>/dev/null || true)";
  echo "[gateway] health: $(openclaw gateway health 2>/dev/null | tr -d '\n' | head -c 400)";
} >> "$LOG_FILE" 2>&1 || true

# 2) API balance (OpenRouter remaining)
remaining=""
{
  if command -v curl >/dev/null 2>&1; then
    remaining="$(curl -fsS http://127.0.0.1:3001/api/balance | jq -r '.openrouter.remaining' 2>/dev/null || true)"
  fi
  echo "[api] openrouter.remaining: ${remaining:-unknown}";
} >> "$LOG_FILE" 2>&1 || true

# Alert threshold
if [[ -n "${remaining:-}" ]]; then
  # numeric compare via awk (handles floats)
  if awk -v r="$remaining" 'BEGIN{exit !(r < 2.0)}'; then
    alert=1
  fi
fi

# 3) Embedding index status (best-effort)
# Current codebase doesn't expose a formal embedding index endpoint.
# We log a placeholder so future work can wire it in.
{
  echo "[embedding] status: not_implemented";
} >> "$LOG_FILE" 2>&1 || true

# 4) Last 24h error logs
{
  echo "[logs] rangerai-agent errors (24h):";
  journalctl -q -u rangerai-agent --since '24 hours ago' --no-pager | grep -i -E 'error|exception|fail' | tail -n 80 || echo "(none)";
  echo "[logs] openclaw-gateway errors (24h):";
  journalctl -q -u openclaw-gateway.service --since '24 hours ago' --no-pager | grep -i -E 'error|exception|fail' | tail -n 80 || echo "(none)";
} >> "$LOG_FILE" 2>&1 || true

if [[ $alert -eq 1 ]]; then
  echo "[ALERT] API balance low: openrouter.remaining=$remaining" >> "$LOG_FILE"
fi

echo "===== END DAILY_DIAGNOSIS =====" >> "$LOG_FILE"
