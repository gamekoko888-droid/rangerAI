#!/bin/bash
# RangerAI Frontend Deploy Script v2.0
# Added: Pre-compression, old asset cleanup, better verification
# Usage: sudo bash /opt/rangerai-web/scripts/deploy-frontend.sh
set -euo pipefail
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
SRC_DIR="/opt/rangerai-web"
PROD_DIR="/opt/rangerai-agent/dist"
BUILD_DIR="/opt/rangerai-web/dist"
PRECOMPRESS="/opt/rangerai-web/scripts/precompress.sh"
# How many old backup sets to keep (each set = index.html.bak + assets.bak)
KEEP_BACKUPS=3

echo -e "${YELLOW}=== RangerAI Frontend Deploy v2.0 ===${NC}"
echo "$(date '+%Y-%m-%d %H:%M:%S')"

# Step 1: Backup
TS=$(date +%Y%m%d-%H%M%S)
echo -e "\n${YELLOW}[1/7] Backing up current production...${NC}"
if [ -f "$PROD_DIR/index.html" ]; then
  cp "$PROD_DIR/index.html" "$PROD_DIR/index.html.bak-$TS"
  cp -r "$PROD_DIR/assets" "$PROD_DIR/assets.bak-$TS" 2>/dev/null || true
  echo -e "${GREEN}  ✓ Backup created: bak-$TS${NC}"
else
  echo -e "${YELLOW}  ⚠ No existing production files to backup${NC}"
fi

# Step 2: Build
echo -e "\n${YELLOW}[2/7] Building frontend...${NC}"
cd "$SRC_DIR"
BUILD_OUTPUT=$(npx vite build --config vite.config.standalone.ts 2>&1)
BUILD_EXIT=$?
if [ $BUILD_EXIT -ne 0 ]; then
  echo -e "${RED}  ✗ Build FAILED! Aborting deployment.${NC}"
  echo "$BUILD_OUTPUT" | tail -20
  exit 1
fi
echo -e "${GREEN}  ✓ Build succeeded${NC}"

# Step 3: Verify build output
echo -e "\n${YELLOW}[3/7] Verifying build output...${NC}"
if [ ! -f "$BUILD_DIR/index.html" ]; then
  echo -e "${RED}  ✗ Build output missing index.html! Aborting.${NC}"
  exit 1
fi
NEW_HASH=$(grep -oE 'index-[^"]+\.js' "$BUILD_DIR/index.html" | head -1)
echo -e "${GREEN}  ✓ New build hash: $NEW_HASH${NC}"

# Step 4: Deploy (clean deploy — remove old assets, copy fresh)
echo -e "\n${YELLOW}[4/7] Deploying to production...${NC}"
rm -rf "$PROD_DIR/assets"
cp -r "$BUILD_DIR/assets" "$PROD_DIR/assets"
cp "$BUILD_DIR/index.html" "$PROD_DIR/index.html"
echo -e "${GREEN}  ✓ Files deployed${NC}"

# Step 5: Pre-compress assets
echo -e "\n${YELLOW}[5/7] Pre-compressing assets...${NC}"
if [ -x "$PRECOMPRESS" ]; then
  bash "$PRECOMPRESS" "$PROD_DIR" 2>&1 | tail -5
  GZ_COUNT=$(find "$PROD_DIR" -name "*.gz" | wc -l)
  echo -e "${GREEN}  ✓ $GZ_COUNT pre-compressed files ready${NC}"
else
  echo -e "${YELLOW}  ⚠ precompress.sh not found, skipping${NC}"
fi

# Step 6: Restart and verify
echo -e "\n${YELLOW}[6/7] Restarting static server...${NC}"
systemctl restart rangerai-web
sleep 2
LIVE_HASH=$(curl -s http://127.0.0.1:3000/ | grep -oE 'index-[^"]+\.js' | head -1)
if [ "$LIVE_HASH" = "$NEW_HASH" ]; then
  echo -e "${GREEN}  ✓ Port 3000: $LIVE_HASH (matches)${NC}"
else
  echo -e "${RED}  ✗ Port 3000: $LIVE_HASH (expected $NEW_HASH)${NC}"
fi

# Check gzip is working
GZ_CHECK=$(curl -s -H 'Accept-Encoding: gzip' -D - "http://127.0.0.1:3000/assets/$NEW_HASH" -o /dev/null 2>&1 | grep -ci 'Content-Encoding: gzip' || true)
if [ "$GZ_CHECK" -gt 0 ]; then
  echo -e "${GREEN}  ✓ Pre-compression active (gzip served)${NC}"
else
  echo -e "${YELLOW}  ⚠ Pre-compression not detected${NC}"
fi

# Check external
EXT_HASH=$(curl -s https://ranger.voyage/ | grep -oE 'index-[^"]+\.js' | head -1)
if [ "$EXT_HASH" = "$NEW_HASH" ]; then
  echo -e "${GREEN}  ✓ CDN: $EXT_HASH (matches)${NC}"
else
  echo -e "${YELLOW}  ⚠ CDN: $EXT_HASH (may need 1-2 min for cache refresh)${NC}"
fi

# Step 7: Cleanup old backups (keep only KEEP_BACKUPS most recent)
echo -e "\n${YELLOW}[7/7] Cleaning up old backups...${NC}"
mapfile -t BACKUP_DIRS < <(ls -td "$PROD_DIR"/assets.bak-* 2>/dev/null)
BACKUP_COUNT=${#BACKUP_DIRS[@]}
if [ "$BACKUP_COUNT" -gt "$KEEP_BACKUPS" ]; then
  REMOVED=0
  for ((i=KEEP_BACKUPS; i<BACKUP_COUNT; i++)); do
    BAK_TS=$(basename "${BACKUP_DIRS[$i]}" | sed 's/assets.bak-//')
    rm -rf "${BACKUP_DIRS[$i]}"
    rm -f "$PROD_DIR/index.html.bak-$BAK_TS"
    REMOVED=$((REMOVED + 1))
  done
  echo -e "${GREEN}  ✓ Removed $REMOVED old backup(s), kept $KEEP_BACKUPS${NC}"
else
  echo -e "${CYAN}  ℹ $BACKUP_COUNT backup(s) exist, no cleanup needed${NC}"
fi

# Summary
echo -e "\n${YELLOW}--- Service Health ---${NC}"
for svc in rangerai-web rangerai-ws rangerai-agent; do
  STATUS=$(systemctl is-active $svc 2>/dev/null || echo "unknown")
  if [ "$STATUS" = "active" ]; then
    echo -e "  ${GREEN}✓ $svc: $STATUS${NC}"
  else
    echo -e "  ${RED}✗ $svc: $STATUS${NC}"
  fi
done

# Disk usage
ASSETS_SIZE=$(du -sh "$PROD_DIR/assets" 2>/dev/null | cut -f1)
TOTAL_SIZE=$(du -sh "$PROD_DIR" 2>/dev/null | cut -f1)
echo -e "\n${CYAN}  Assets: $ASSETS_SIZE | Total dist: $TOTAL_SIZE${NC}"

echo -e "\n${GREEN}=== Deploy Complete ==="
echo -e "Backup: bak-$TS | Hash: $NEW_HASH${NC}"
