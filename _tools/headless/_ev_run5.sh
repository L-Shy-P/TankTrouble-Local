#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/../.." || exit 1
LOGD=_tools/headless/_ev_logs
node _tools/headless/_ev_align_delta.js --frames 1800 --tag v1 --ctrl drive --fire 0 --ai 0 --vant 2 > "$LOGD/align_v1.log" 2>&1
echo "v1 done $(date '+%T')" >> "$LOGD/jr_suite_status.log"
node _tools/headless/_ev_align_delta.js --frames 1800 --tag v2 --ctrl drive --fire 0 --ai 0 --vant 3 > "$LOGD/align_v2.log" 2>&1
echo "v2 done $(date '+%T')" >> "$LOGD/jr_suite_status.log"
node _tools/headless/_ev_align_delta.js --frames 1800 --tag v3 --ctrl drive --fire 0 --ai 1 --vant 2 > "$LOGD/align_v3.log" 2>&1
echo "v3 done $(date '+%T')" >> "$LOGD/jr_suite_status.log"
