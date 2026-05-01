#!/bin/bash
# Load environment variables
# - Non-sensitive config: /opt/rangerai-agent/.env (can be readable by service user)
# - Sensitive secrets:   /opt/rangerai-agent/agent-secrets.env (root-only 600)

set -a
# shellcheck disable=SC1091
[ -f /opt/rangerai-agent/.env ] && source /opt/rangerai-agent/.env
# shellcheck disable=SC1091
[ -f /opt/rangerai-agent/agent-secrets.env ] && source /opt/rangerai-agent/agent-secrets.env
set +a

# Start the server
exec node /opt/rangerai-agent/server.mjs
