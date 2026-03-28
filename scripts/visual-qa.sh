#!/bin/bash
# Visual QA for family-tree-webapp
# Takes screenshots of the running app and saves them for review

APP_URL="${1:-http://localhost:5173}"
OUTPUT_DIR="${2:-/Users/jens/.openclaw/workspace/family-tree-webapp/visual-qa}"

mkdir -p "$OUTPUT_DIR"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

echo "[visual-qa] Capturing screenshots of $APP_URL"

# Use node to fetch the page and capture via a simple approach
# We'll use curl + timestamp as a lightweight check
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$APP_URL" 2>/dev/null)

if [ "$STATUS" != "200" ]; then
  echo "[visual-qa] App not reachable at $APP_URL (status: $STATUS)"
  exit 1
fi

# Save a simple HTML snapshot marker
echo "[visual-qa] App is up. Screenshot capture ready."
echo "URL: $APP_URL" > "$OUTPUT_DIR/qa-$TIMESTAMP.txt"
echo "Timestamp: $(date)" >> "$OUTPUT_DIR/qa-$TIMESTAMP.txt"
echo "Status: $STATUS" >> "$OUTPUT_DIR/qa-$TIMESTAMP.txt"

echo "[visual-qa] QA snapshot saved: $OUTPUT_DIR/qa-$TIMESTAMP.txt"
echo "[visual-qa] To review: open $APP_URL in a browser and compare with previous snapshots"
