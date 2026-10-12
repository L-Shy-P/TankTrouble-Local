#!/usr/bin/env bash
# 证据补课：干净指纹下重跑 ①（VM600/overlap）+ ③（Δ/四路同帧）——只读产品代码
set -u
cd "$(dirname "$0")/../.." || exit 1
LOGD=_tools/headless/_ev_logs
MD5() { for f in game_core/js/vantage_sandbox.js game_core/js/vantage_tree.js game_core/js/vantage_rust_bridge.js game_core/js/vantage_scoring.js game_core/js/wasm/vantage_core.wasm game_core/rust/vantage_core/src/rollout.rs; do printf '%s  %s\n' "$(md5sum "$f" | cut -d' ' -f1)" "$f"; done; }
run() { local name="$1"; shift; local log="$1"; shift
  echo "===== [$name] start $(date '+%F %T') =====" >> "$LOGD/$log"
  echo "----- md5 BEFORE [$name] -----" >> "$LOGD/$log"; MD5 >> "$LOGD/$log"
  local t0=$(date +%s); node "$@" >> "$LOGD/$log" 2>&1; local rc=$?
  echo "----- md5 AFTER  [$name] rc=$rc elapsed=$(( $(date +%s) - t0 ))s -----" >> "$LOGD/$log"; MD5 >> "$LOGD/$log"
  echo "===== [$name] end $(date '+%F %T') =====" >> "$LOGD/$log"; }
run overlap2 jr_overlap2.log _tools/headless/_probe_jr_overlap_vm.js
run vm600b  jr_vm600b.log  _tools/headless/_probe_jr_death_vm.js --n 600 --frames 75
run aligncur align_cur.log _tools/headless/_ev_align_delta.js --frames 900 --tag cur
echo "RUN2 DONE $(date '+%F %T')" >> "$LOGD/jr_suite_status.log"
