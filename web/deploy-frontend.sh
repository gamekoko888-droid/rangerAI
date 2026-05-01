#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# RangerAI Frontend Deploy Script v8 — Permission-Safe Deploy
# Usage: bash /opt/rangerai-agent/deploy-frontend.sh
#        (works with both admin and root users)
#
# v8 Changes:
#   - Fix permission issue: use rsync instead of cp -f to avoid
#     "Permission denied" when admin overwrites root-owned files
#   - chown all deployed files to admin:admin after merge
#   - Remove sudo requirement for normal deploy operations
#   - Use sudo only for systemctl restart (with fallback)
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

BUILD_DIR="/opt/rangerai-web/dist-standalone"
DIST_DIR="/opt/rangerai-agent/dist"
BACKUP_DIR="/opt/rangerai-agent/dist-backups"
SERVICE="rangerai-web"
GRACE_HOURS=24

log() { echo "[$(date '+%H:%M:%S')] $1"; }
die() { log "FATAL: $1"; exit 1; }

# ── Pre-flight checks ──
[ -d "$BUILD_DIR" ] || die "Build dir not found: $BUILD_DIR"
[ -f "$BUILD_DIR/index.html" ] || die "No index.html in build dir"
[ -d "$DIST_DIR" ] || die "Dist dir not found: $DIST_DIR"

# ── Extract active entry from NEW build ──
NEW_ENTRY=$(grep -oP 'index-[A-Za-z0-9_-]+\.js' "$BUILD_DIR/index.html" | head -1)
[ -n "$NEW_ENTRY" ] || die "Cannot find entry JS in new build"
log "New entry: $NEW_ENTRY"

# ── Backup current dist ──
STAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"
cp "$DIST_DIR/index.html" "$BACKUP_DIR/index.html.$STAMP" 2>/dev/null || true
log "Backed up current index.html"

# ── Merge new build into dist using rsync (permission-safe) ──
log "Merging new build..."
# rsync --no-perms --no-owner --no-group avoids permission issues
# --chmod ensures new files are writable by admin
rsync -a --no-perms --no-owner --no-group --chmod=F644,D755 \
  "$BUILD_DIR/index.html" "$DIST_DIR/index.html"
# DISABLED: # DISABLED: static-server.cjs is standalone CJS, not build output
# # rsync -a --no-perms --no-owner --no-group --chmod=F644,D755 \
# DISABLED: static-server.cjs is standalone CJS, not build output
#   "$BUILD_DIR/static-server.cjs" "$DIST_DIR/static-server.cjs" 2>/dev/null || true
mkdir -p "$DIST_DIR/assets"
rsync -a --no-perms --no-owner --no-group --chmod=F644,D755 \
  "$BUILD_DIR/assets/" "$DIST_DIR/assets/"

# Ensure all files in dist are owned by admin (prevents future permission issues)
chown -R admin:admin "$DIST_DIR/" 2>/dev/null || true
log "Merge complete (permission-safe)"

# ── Verify critical entry file exists ──
if [ ! -f "$DIST_DIR/assets/$NEW_ENTRY" ]; then
  die "CRITICAL: Entry file $NEW_ENTRY missing after merge! Deploy aborted."
fi
log "Entry file verified: $DIST_DIR/assets/$NEW_ENTRY"

# ── Generate .gz pre-compressed files ──
log "Generating .gz pre-compressed files..."
GZ_COUNT=0
cd "$DIST_DIR/assets"
for f in *.js *.css; do
  [ -f "$f" ] || continue
  if [ ! -f "$f.gz" ] || [ "$f" -nt "$f.gz" ]; then
    gzip -9 -k -f "$f"
    GZ_COUNT=$((GZ_COUNT + 1))
  fi
done
log "Generated $GZ_COUNT new .gz files"

# ── Auto-cleanup old build chunks ──
log "Cleaning up old chunks (grace: ${GRACE_HOURS}h)..."

# Find all files referenced by current build
REFERENCED=$(mktemp)
grep -oP '[a-zA-Z0-9._-]+\.(js|css)' "$DIST_DIR/index.html" >> "$REFERENCED" 2>/dev/null || true
ENTRY_FILE="$DIST_DIR/assets/$NEW_ENTRY"
if [ -f "$ENTRY_FILE" ]; then
  grep -oP '[a-zA-Z0-9._-]+\.(js|css)' "$ENTRY_FILE" >> "$REFERENCED" 2>/dev/null || true
  # 2-level deep: check chunks referenced by entry's chunks
  for chunk in $(grep -oP '[a-zA-Z0-9._-]+\.js' "$ENTRY_FILE" 2>/dev/null | sort -u); do
    CHUNK_FILE="$DIST_DIR/assets/$chunk"
    if [ -f "$CHUNK_FILE" ]; then
      grep -oP '[a-zA-Z0-9._-]+\.(js|css)' "$CHUNK_FILE" >> "$REFERENCED" 2>/dev/null || true
    fi
  done
fi
# Always keep vendor/shared chunks
ls "$DIST_DIR/assets/" | grep -E '^vendor-|^katex|^KaTeX|\.woff|\.woff2|\.ttf|\.png|\.jpg|\.svg|\.ico|\.webp' >> "$REFERENCED" 2>/dev/null || true
sort -u "$REFERENCED" -o "$REFERENCED"

DEL_COUNT=0
DEL_SIZE=0
GRACE_MIN=$((GRACE_HOURS * 60))

for f in "$DIST_DIR/assets/"*; do
  [ -f "$f" ] || continue
  BASENAME=$(basename "$f")
  BASE_NO_GZ="${BASENAME%.gz}"
  
  # Skip if referenced by current build
  if grep -qF "$BASE_NO_GZ" "$REFERENCED" 2>/dev/null; then
    continue
  fi
  
  # Skip if within grace period
  if [ "$(find "$f" -mmin -$GRACE_MIN 2>/dev/null)" ]; then
    continue
  fi
  
  # Delete old unreferenced file
  FSIZE=$(stat -c%s "$f" 2>/dev/null || echo 0)
  DEL_SIZE=$((DEL_SIZE + FSIZE))
  rm -f "$f"
  DEL_COUNT=$((DEL_COUNT + 1))
done

rm -f "$REFERENCED"
DEL_MB=$((DEL_SIZE / 1024 / 1024))
log "Cleaned up $DEL_COUNT old files (${DEL_MB}MB recovered)"

# ── Restart static server (try sudo, fallback to direct) ──
log "Restarting $SERVICE..."
if command -v sudo &>/dev/null && sudo -n true 2>/dev/null; then
  sudo systemctl restart "$SERVICE"
elif [ "$(id -u)" -eq 0 ]; then
  systemctl restart "$SERVICE"
else
  log "⚠️ Cannot restart $SERVICE — no sudo/root access. Service may serve stale content."
  log "   Run manually: sudo systemctl restart $SERVICE"
fi
sleep 3

# ── Verify ──
LIVE_ENTRY=$(curl -s http://127.0.0.1:3000/ | grep -oP 'index-[A-Za-z0-9_-]+\.js' | head -1)
if [ "$LIVE_ENTRY" = "$NEW_ENTRY" ]; then
  log "✅ Deploy successful! Active: $LIVE_ENTRY"
else
  log "⚠️ Entry mismatch: expected $NEW_ENTRY, got $LIVE_ENTRY"
fi

# ── Verify entry JS returns correct content-type ──
ENTRY_CT=$(curl -s -o /dev/null -w '%{content_type}' "http://127.0.0.1:3000/assets/$NEW_ENTRY")
if echo "$ENTRY_CT" | grep -q 'javascript'; then
  log "✅ Entry JS content-type: $ENTRY_CT"
else
  log "❌ Entry JS content-type WRONG: $ENTRY_CT (expected javascript)"
  log "   This means the JS file is missing or being served as HTML fallback!"
fi

# ── Final stats ──
TOTAL_FILES=$(ls "$DIST_DIR/assets/" | wc -l)
TOTAL_SIZE=$(du -sh "$DIST_DIR/assets/" | cut -f1)
log "Assets: $TOTAL_FILES files, $TOTAL_SIZE"

# ── Route verification ──
log "Verifying routes..."
FAIL=0
for route in / /ceo /team /kols /inventory /admin /stats /tasks /tickets /data-analytics /daily-reports /tiktok-partners /tiktok-scripts /ops-efficiency /dashboard /data-upload /price-monitor /knowledge /workflows /prompts /notifications; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3000$route")
  if [ "$CODE" != "200" ]; then
    log "  ❌ $route → $CODE"
    FAIL=$((FAIL + 1))
  fi
done
if [ $FAIL -eq 0 ]; then
  log "✅ All 21 routes verified (200 OK)"
else
  log "⚠️ $FAIL routes failed"
fi

log "Deploy v8 complete!"
