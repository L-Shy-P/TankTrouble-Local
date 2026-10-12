#!/usr/bin/env bash
# ② v167 门四路对齐（长回合场景 v4：人+2AI+1vantage，1800 帧）——冻结副本 A/B
set -u
cd "$(dirname "$0")/../.." || exit 1
LOGD=_tools/headless/_ev_logs; PG=_tools/headless/_ev_pg
export EV_GAME_DIR="$PWD/$PG/game_core"
echo "--- ctrl tree md5=$(md5sum "$PG/game_core/js/vantage_tree.js"|cut -d' ' -f1)" >> "$LOGD/align_ab_long.log"
node _tools/headless/_ev_align_delta.js --frames 1800 --tag ctl4 --ctrl drive --fire 1 --ai 2 --vant 1 --match=_ev_match > "$LOGD/align_ctl4.log" 2>&1
cp "$PG/vantage_tree.v173ev167gate.js" "$PG/game_core/js/vantage_tree.js"
echo "--- gate tree md5=$(md5sum "$PG/game_core/js/vantage_tree.js"|cut -d' ' -f1)" >> "$LOGD/align_ab_long.log"
node _tools/headless/_ev_align_delta.js --frames 1800 --tag gate4 --ctrl drive --fire 1 --ai 2 --vant 1 --match=_ev_match > "$LOGD/align_gate4.log" 2>&1
cp game_core/js/vantage_tree.js "$PG/game_core/js/vantage_tree.js"
echo "COPY RESTORED md5=$(md5sum "$PG/game_core/js/vantage_tree.js"|cut -d' ' -f1) product=$(md5sum game_core/js/vantage_tree.js|cut -d' ' -f1)" >> "$LOGD/align_ab_long.log"
echo "RUN7 DONE $(date '+%F %T')" >> "$LOGD/jr_suite_status.log"
