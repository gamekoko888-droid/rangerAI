#!/usr/bin/env bash
set -euo pipefail

# migrate-provider.sh
# Usage:
#   migrate-provider.sh OLD_PREFIX NEW_PREFIX [--apply]
# Default is dry-run (no changes). Use --apply to modify.

if [[ ${1:-} == "" || ${2:-} == "" ]]; then
  echo "Usage: $0 OLD_PREFIX NEW_PREFIX [--apply]" >&2
  exit 2
fi

OLD_PREFIX="$1"
NEW_PREFIX="$2"
MODE="dry-run"
if [[ ${3:-} == "--apply" ]]; then
  MODE="apply"
fi

# Normalize: remove trailing slashes for consistent matching
OLD_PREFIX="${OLD_PREFIX%/}"
NEW_PREFIX="${NEW_PREFIX%/}"

replace_prefix() {
  # Replace prefix when it is a path segment prefix: ^OLD/...
  local s="$1"
  if [[ "$s" =~ ^${OLD_PREFIX}/ ]]; then
    printf '%s' "${NEW_PREFIX}/${s#${OLD_PREFIX}/}"
  else
    printf '%s' "$s"
  fi
}

CRON_JSON="$(openclaw cron list --json)"
JOB_IDS=( $(printf '%s' "$CRON_JSON" | jq -r '.jobs[]?.id') )

changed=0

echo "MODE: $MODE"
echo "Scanning OpenClaw cron jobs for model prefix '$OLD_PREFIX' -> '$NEW_PREFIX'" 

for id in "${JOB_IDS[@]}"; do
  job_json="$(printf '%s' "$CRON_JSON" | jq -c --arg id "$id" '.jobs[] | select(.id==$id)')"

  kind="$(printf '%s' "$job_json" | jq -r '.payload.kind')"
  if [[ "$kind" != "agentTurn" ]]; then
    continue
  fi

  name="$(printf '%s' "$job_json" | jq -r '.name')"
  model="$(printf '%s' "$job_json" | jq -r '.payload.model // empty')"

  if [[ -z "$model" ]]; then
    continue
  fi

  new_model="$(replace_prefix "$model")"
  if [[ "$new_model" == "$model" ]]; then
    continue
  fi

  changed=$((changed+1))
  echo "- MATCH: $name ($id) model: '$model' -> '$new_model'"

  if [[ "$MODE" == "apply" ]]; then
    openclaw cron edit "$id" --model "$new_model" >/dev/null
    echo "  UPDATED"
  else
    echo "  DRY-RUN (no change)"
  fi

done

echo "Done. Matched $changed job(s)."
if [[ "$MODE" == "dry-run" ]]; then
  echo "Tip: run with '--apply' to perform updates."
fi
