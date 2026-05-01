#!/bin/bash
# clean-manus.sh — Remove Manus-injected scripts from production index.html
# Run after `pnpm run build` and before deploying to Alibaba Cloud
#
# Usage: bash scripts/clean-manus.sh

set -e

INDEX_FILE="dist/public/index.html"

if [ ! -f "$INDEX_FILE" ]; then
  echo "Error: $INDEX_FILE not found. Run 'pnpm run build' first."
  exit 1
fi

echo "Cleaning Manus remnants from $INDEX_FILE..."

# 1. Remove debug-collector.js script tag
sed -i '/<script src="\/__manus__\/debug-collector.js"/d' "$INDEX_FILE"

# 2. Remove the entire manus-runtime inline script block
# This is a multi-line script that starts with <script id="manus-runtime"> 
# and ends with </script> — it can be huge (300KB+)
python3 -c "
import re
with open('$INDEX_FILE', 'r') as f:
    content = f.read()

# Remove <script id=\"manus-runtime\">...</script> (including multi-line)
content = re.sub(r'<script id=\"manus-runtime\">.*?</script>', '', content, flags=re.DOTALL)

# Remove any empty lines left behind
content = re.sub(r'\n\s*\n\s*\n', '\n\n', content)

with open('$INDEX_FILE', 'w') as f:
    f.write(content)
"

# 3. Remove __manus__ directory if it exists
rm -rf dist/public/__manus__

# Report result
NEW_SIZE=$(wc -c < "$INDEX_FILE")
echo "Done. index.html size: ${NEW_SIZE} bytes"
echo "Removed: debug-collector.js, manus-runtime inline script, __manus__ directory"
