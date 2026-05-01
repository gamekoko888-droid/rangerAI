#!/bin/bash
# Pre-compress static assets with gzip (max compression level 9)
# Run after vite build to generate .gz files alongside originals
# Usage: ./precompress.sh [directory]

DIR="${1:-/opt/rangerai-agent/dist}"

echo "=== Pre-compressing assets in $DIR ==="

COMPRESSED=0
SKIPPED=0

# Compress JS, CSS, HTML, JSON, SVG, TXT, XML, MAP files
find "$DIR" -type f \( \
  -name "*.js" -o -name "*.css" -o -name "*.html" -o \
  -name "*.json" -o -name "*.svg" -o -name "*.txt" -o \
  -name "*.xml" -o -name "*.map" -o -name "*.mjs" \
\) | while read -r file; do
  # Skip if .gz already exists and is newer than source
  gz_file="${file}.gz"
  if [ -f "$gz_file" ] && [ "$gz_file" -nt "$file" ]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  
  # Compress with max level
  gzip -9 -k -f "$file"
  COMPRESSED=$((COMPRESSED + 1))
done

# Report results
TOTAL_GZ=$(find "$DIR" -name "*.gz" | wc -l)
ORIG_SIZE=$(find "$DIR" -type f ! -name "*.gz" | xargs du -sb 2>/dev/null | awk '{s+=$1}END{print s}')
GZ_SIZE=$(find "$DIR" -name "*.gz" | xargs du -sb 2>/dev/null | awk '{s+=$1}END{print s}')

echo "Pre-compressed files: $TOTAL_GZ"
echo "Original total: $(echo "scale=1; ${ORIG_SIZE:-0}/1048576" | bc)MB"
echo "Compressed total: $(echo "scale=1; ${GZ_SIZE:-0}/1048576" | bc)MB"
if [ "${ORIG_SIZE:-0}" -gt 0 ]; then
  RATIO=$(echo "scale=1; $GZ_SIZE * 100 / $ORIG_SIZE" | bc)
  echo "Compression ratio: ${RATIO}%"
fi
echo "=== Done ==="
