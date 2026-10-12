#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/../.." || exit 1
LOGD=_tools/headless/_ev_logs
node _tools/headless/_ev_align_delta.js --frames 1800 --tag v4 --ctrl drive --fire 1 --ai 2 --vant 1 > "$LOGD/align_v4.log" 2>&1
node _tools/headless/_ev_align_delta.js --frames 1800 --tag v5 --ctrl drive --fire 0 --ai 2 --vant 1 > "$LOGD/align_v5.log" 2>&1
echo "RUN6 DONE $(date '+%F %T')" >> "$LOGD/jr_suite_status.log"
