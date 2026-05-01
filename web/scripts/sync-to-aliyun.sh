#!/bin/bash
# ============================================================
# RangerAI 前端源码同步脚本 v2
# 用途: 将 Manus sandbox 中的前端源码同步到阿里云 /opt/rangerai-web/
# 用法: bash scripts/sync-to-aliyun.sh [--deploy]
# ============================================================
set -e

REMOTE_HOST="8.219.186.244"
REMOTE_PASS="Joseph1991@"
REMOTE_DIR="/opt/rangerai-web"
LOCAL_DIR="/home/ubuntu/rangerai-web"
ARCHIVE="/tmp/rangerai-web-sync.tar.gz"
DEPLOY_AFTER_SYNC=false

if [ "$1" = "--deploy" ]; then
    DEPLOY_AFTER_SYNC=true
fi

log() { echo "[SYNC] $1"; }

# Step 1: Test SSH
log "Testing SSH connection..."
sshpass -p "$REMOTE_PASS" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 root@$REMOTE_HOST 'echo OK' || { echo "SSH failed"; exit 1; }
log "SSH OK"

# Step 2: Package source (exclude heavy dirs)
log "Packaging source code..."
cd /home/ubuntu
tar czf "$ARCHIVE" \
    --exclude='rangerai-web/node_modules' \
    --exclude='rangerai-web/dist' \
    --exclude='rangerai-web/.git' \
    --exclude='rangerai-web/.manus-logs' \
    --exclude='rangerai-web/.webdev' \
    --exclude='rangerai-web/.env*' \
    rangerai-web/
log "Package: $(du -h $ARCHIVE | cut -f1)"

# Step 3: Upload in chunks (avoids SCP disconnection on large files)
log "Uploading in chunks..."
cd /tmp && rm -f _sc_*
split -b 50000 "$ARCHIVE" _sc_
for f in _sc_*; do
    sshpass -p "$REMOTE_PASS" scp -o StrictHostKeyChecking=no "$(pwd)/$f" root@$REMOTE_HOST:/tmp/$f || { echo "Upload failed: $f"; exit 1; }
    log "  Uploaded $f"
done
rm -f _sc_*
log "Upload complete"

# Step 4: Remote merge + extract + replace
log "Remote extract and replace..."
sshpass -p "$REMOTE_PASS" ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=15 root@$REMOTE_HOST bash -s << 'REMOTE_SCRIPT'
set -e
cd /tmp
cat _sc_* > rangerai-web-sync.tar.gz
rm -f _sc_*

# Backup
TS=$(date +%Y%m%d%H%M%S)
if [ -f /opt/rangerai-web/package.json ]; then
    cp -r /opt/rangerai-web /opt/rangerai-web-backup-$TS
fi

# Extract
rm -rf /tmp/rw-extract
mkdir -p /tmp/rw-extract
cd /tmp/rw-extract && tar xzf /tmp/rangerai-web-sync.tar.gz

# Handle nested dir
if [ -d /tmp/rw-extract/rangerai-web ]; then
    SRC=/tmp/rw-extract/rangerai-web
else
    SRC=/tmp/rw-extract
fi

# Replace
rm -rf /opt/rangerai-web
mv "$SRC" /opt/rangerai-web

# Cleanup
rm -rf /tmp/rw-extract /tmp/rangerai-web-sync.tar.gz

# Verify
echo "FILES: $(find /opt/rangerai-web -type f | wc -l)"
echo "MARKER: $(head -1 /opt/rangerai-web/client/src/pages/Home.tsx)"

# Clean old backups (keep 3)
ls -dt /opt/rangerai-web-backup-* 2>/dev/null | tail -n +4 | xargs -r rm -rf
REMOTE_SCRIPT

# Step 5: Optional deploy
if [ "$DEPLOY_AFTER_SYNC" = true ]; then
    log "Deploying..."
    sshpass -p "$REMOTE_PASS" ssh -o StrictHostKeyChecking=no root@$REMOTE_HOST 'bash /opt/rangerai-agent/deploy-frontend.sh'
fi

rm -f "$ARCHIVE"
log "==============================="
log "Sync complete!"
log "==============================="
