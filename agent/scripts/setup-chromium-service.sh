#!/bin/bash
# setup-chromium-service.sh — Install and enable the Chromium headless service
# Run once on the server: bash agent/scripts/setup-chromium-service.sh

set -e

SERVICE_FILE="/etc/systemd/system/rangerai-chromium.service"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "[setup] Installing Chromium headless service..."

# Copy service file
sudo cp "$SCRIPT_DIR/rangerai-chromium.service" "$SERVICE_FILE"

# Reload systemd
sudo systemctl daemon-reload

# Enable and start
sudo systemctl enable rangerai-chromium
sudo systemctl restart rangerai-chromium

# Verify
sleep 2
if curl -s http://127.0.0.1:9222/json/version > /dev/null 2>&1; then
  echo "[setup] ✅ Chromium headless running on port 9222"
else
  echo "[setup] ⚠️  Chromium may still be starting..."
  sleep 3
  curl -s http://127.0.0.1:9222/json/version || echo "[setup] ❌ Failed to start"
fi
