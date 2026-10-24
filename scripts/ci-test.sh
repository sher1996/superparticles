#!/usr/bin/env bash
# Run an npm test script; on failure, surface the failing tests as a GitHub
# annotation so the cause is readable without downloading the full log.
set -o pipefail
log="$(mktemp)"
if npm run "$1" 2>&1 | tee "$log"; then
  exit 0
fi
summary="$(grep -E '^not ok|^ +error:|^ +[A-Za-z]*Error|expected|actual|Timeout|duration_ms' "$log" | grep -v '^ *at ' | head -60 | tr '\n' ' ' | cut -c1-3500)"
echo "::error title=npm run $1 failed::${summary:-$(tail -c 2000 "$log" | tr '\n' ' ')}"
exit 1
