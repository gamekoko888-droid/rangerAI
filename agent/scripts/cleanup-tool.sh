#!/bin/bash
# ─── RangerAI Data Cleanup Tool ───
# Cleans up smoke test data, stale workflows, and orphaned records.
set -e

DB_PATH="/opt/rangerai-agent/rangerai.db"
ACTION="${1:-dry-run}"

echo "═══════════════════════════════════════════"
echo "  RangerAI Cleanup Tool ($ACTION mode)"
echo "═══════════════════════════════════════════"

# ─── 1. Count smoke test workflows ───
echo ""
echo "▶ Smoke test workflows:"
SMOKE_WF=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM workflows WHERE name LIKE 'smoke-wf-%';" 2>/dev/null || echo "0")
echo "  Found: $SMOKE_WF smoke-test workflows"

# ─── 2. Count smoke test users ───
echo ""
echo "▶ Smoke test users:"
SMOKE_USERS=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM users WHERE username LIKE 'smoke%';" 2>/dev/null || echo "0")
echo "  Found: $SMOKE_USERS smoke-test users"

# ─── 3. Count stale knowledge docs ───
echo ""
echo "▶ Test knowledge docs:"
TEST_DOCS=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM knowledge_docs WHERE category = 'test';" 2>/dev/null || echo "0")
echo "  Found: $TEST_DOCS test knowledge docs"

if [ "$ACTION" = "clean" ]; then
    echo ""
    echo "═══════════════════════════════════════════"
    echo "  Cleaning..."
    echo "═══════════════════════════════════════════"
    
    # Backup first
    BACKUP_NAME="rangerai-pre-cleanup-$(date +%Y%m%d-%H%M%S).db"
    cp "$DB_PATH" "/opt/rangerai-agent/backups/$BACKUP_NAME"
    echo "  ✓ Backup: $BACKUP_NAME"
    
    # Clean smoke workflows
    sqlite3 "$DB_PATH" "DELETE FROM workflows WHERE name LIKE 'smoke-wf-%';"
    echo "  ✓ Deleted $SMOKE_WF smoke-test workflows"
    
    # Clean test knowledge docs
    sqlite3 "$DB_PATH" "DELETE FROM knowledge_docs WHERE category = 'test';"
    echo "  ✓ Deleted $TEST_DOCS test knowledge docs"
    
    echo ""
    echo "  ✓ Cleanup complete. Smoke test users preserved (may be referenced)."
else
    echo ""
    echo "═══════════════════════════════════════════"
    echo "  DRY RUN — no changes made."
    echo "  Run with 'clean' argument to execute:"
    echo "  bash cleanup-tool.sh clean"
fi
