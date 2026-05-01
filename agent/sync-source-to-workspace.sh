#!/bin/bash
# Sync RangerAI source code to workspace for Ranger to read
DEST=/home/admin/.openclaw/workspace/rangerai-source

mkdir -p $DEST/worker $DEST/config $DEST/modules $DEST/lib

# Sync worker files (only .mjs/.js, no backups)
find /opt/rangerai-agent/worker -maxdepth 1 \( -name '*.mjs' -o -name '*.js' \) ! -name '*.bak*' -exec cp {} $DEST/worker/ \;

# Sync config
cp /opt/rangerai-agent/config/*.json $DEST/config/ 2>/dev/null

# Sync modules
find /opt/rangerai-agent/modules -maxdepth 1 \( -name '*.mjs' -o -name '*.js' \) ! -name '*.bak*' -exec cp {} $DEST/modules/ \;

# Sync lib
find /opt/rangerai-agent/lib -maxdepth 1 \( -name '*.mjs' -o -name '*.js' \) ! -name '*.bak*' -exec cp {} $DEST/lib/ \;

# Copy key docs
cp /opt/rangerai-agent/package.json $DEST/ 2>/dev/null

echo "[$(date)] Source synced to workspace"
