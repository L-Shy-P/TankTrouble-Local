#!/usr/bin/env bash
# ② v167 门四路对齐：A/B 都在【字节相同的冻结副本】上跑，只差 tree 的那一行门 + 版本串
set -u
cd "$(dirname "$0")/../.." || exit 1
LOGD=_tools/headless/_ev_logs; PG=_tools/headless/_ev_pg
export EV_GAME_DIR="$PWD/$PG/game_core"
show() { echo "--- [$1] tree md5=$(md5sum "$PG/game_core/js/vantage_tree.js" | cut -d' ' -f1) version=$(grep -o "TREE_VERSION = '[^']*'" "$PG/game_core/js/vantage_tree.js" | head -1)"; }
# A 对照：副本 = 与产品逐字节相同（把产品文件拷回去）
cp game_core/js/vantage_tree.js "$PG/game_core/js/vantage_tree.js"
show control >> "$LOGD/run3_ctl.log"
echo "===== [ctl-copy] start $(date '+%F %T') =====" >> "$LOGD/run3_ctl.log"
node _tools/headless/_ev_align_delta.js --frames 900 --tag ctlcp --match=_ev_match >> "$LOGD/run3_ctl.log" 2>&1
echo "===== [ctl-copy] end $(date '+%F %T') =====" >> "$LOGD/run3_ctl.log"
# B 实验：门改回 v167（shift <= 1.0）
cp "$PG/vantage_tree.v173ev167gate.js" "$PG/game_core/js/vantage_tree.js"
show gate >> "$LOGD/run3_gate.log"
echo "===== [ev167gate] start $(date '+%F %T') =====" >> "$LOGD/run3_gate.log"
node _tools/headless/_ev_align_delta.js --frames 900 --tag ev167gate --match=_ev_match >> "$LOGD/run3_gate.log" 2>&1
echo "===== [ev167gate] end $(date '+%F %T') =====" >> "$LOGD/run3_gate.log"
# 还原副本为产品字节
cp game_core/js/vantage_tree.js "$PG/game_core/js/vantage_tree.js"
echo "COPY RESTORED md5=$(md5sum "$PG/game_core/js/vantage_tree.js"|cut -d' ' -f1) (product=$(md5sum game_core/js/vantage_tree.js|cut -d' ' -f1))" >> "$LOGD/run3_gate.log"
echo "RUN3 DONE $(date '+%F %T')" >> "$LOGD/jr_suite_status.log"
