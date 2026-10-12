#!/usr/bin/env bash
# ③ 当前 build Δ/四路（真实 game_core）+ ② A/B（冻结副本：产品门 vs v167 门）
set -u
cd "$(dirname "$0")/../.." || exit 1
LOGD=_tools/headless/_ev_logs; PG=_tools/headless/_ev_pg
MD5() { for f in game_core/js/vantage_sandbox.js game_core/js/vantage_tree.js game_core/js/wasm/vantage_core.wasm; do printf '%s  %s\n' "$(md5sum "$f" | cut -d' ' -f1)" "$f"; done; }
run() { local name="$1"; shift; local log="$1"; shift
  echo "===== [$name] start $(date '+%F %T') =====" >> "$LOGD/$log"
  echo "----- md5 BEFORE [$name] -----" >> "$LOGD/$log"; MD5 >> "$LOGD/$log"
  local t0=$(date +%s); node "$@" >> "$LOGD/$log" 2>&1; local rc=$?
  echo "----- md5 AFTER  [$name] rc=$rc elapsed=$(( $(date +%s) - t0 ))s -----" >> "$LOGD/$log"; MD5 >> "$LOGD/$log"
  echo "===== [$name] end $(date '+%F %T') =====" >> "$LOGD/$log"; }

run deltacur deltas_cur.log _tools/headless/_ev_align_delta.js --frames 900 --tag cur --ctrl drive

export EV_GAME_DIR="$PWD/$PG/game_core"
echo "--- copy tree md5=$(md5sum "$PG/game_core/js/vantage_tree.js"|cut -d' ' -f1)" >> "$LOGD/deltas_ab.log"
run ctlcp deltas_ab.log _tools/headless/_ev_align_delta.js --frames 900 --tag ctlcp --ctrl drive --match=_ev_match
cp "$PG/vantage_tree.v173ev167gate.js" "$PG/game_core/js/vantage_tree.js"
echo "--- copy tree md5(gate)=$(md5sum "$PG/game_core/js/vantage_tree.js"|cut -d' ' -f1)" >> "$LOGD/deltas_ab.log"
run gate167 deltas_ab.log _tools/headless/_ev_align_delta.js --frames 900 --tag ev167gate --ctrl drive --match=_ev_match
cp game_core/js/vantage_tree.js "$PG/game_core/js/vantage_tree.js"
echo "COPY RESTORED md5=$(md5sum "$PG/game_core/js/vantage_tree.js"|cut -d' ' -f1) product=$(md5sum game_core/js/vantage_tree.js|cut -d' ' -f1)" >> "$LOGD/deltas_ab.log"
echo "RUN4 DONE $(date '+%F %T')" >> "$LOGD/jr_suite_status.log"
