#!/usr/bin/env bash
# 证据补课①：用【当前 build】重跑 JS/Rust 判死频率四件套（只读产品代码；不改任何既有文件）
set -u
cd "$(dirname "$0")/../.." || exit 1
LOGD=_tools/headless/_ev_logs
mkdir -p "$LOGD" _tools/headless/_ev_prof
MD5() { for f in game_core/js/vantage_sandbox.js game_core/js/vantage_tree.js game_core/js/vantage_rust_bridge.js game_core/js/vantage_scoring.js game_core/js/wasm/vantage_core.wasm game_core/rust/vantage_core/src/rollout.rs; do printf '%s  %s\n' "$(md5sum "$f" | cut -d' ' -f1)" "$f"; done; }
run() { # name, log, cmd...
  local name="$1"; shift; local log="$1"; shift
  echo "===== [$name] start $(date '+%F %T') =====" >> "$LOGD/$log"
  echo "----- md5 BEFORE [$name] -----" >> "$LOGD/$log"; MD5 >> "$LOGD/$log"
  local t0=$(date +%s)
  node "$@" >> "$LOGD/$log" 2>&1; local rc=$?
  echo "----- md5 AFTER  [$name] rc=$rc elapsed=$(( $(date +%s) - t0 ))s -----" >> "$LOGD/$log"; MD5 >> "$LOGD/$log"
  echo "===== [$name] end $(date '+%F %T') =====" >> "$LOGD/$log"
}
run vm600  jr_vm600.log  _tools/headless/_probe_jr_death_vm.js --n 600 --frames 75
run tree2400 jr_tree2400.log _tools/headless/_probe_jr_death_tree.js --frames 2400 --out _tools/headless/_ev_prof/jr_tree2400.json
run realApproach jr_real_approach.log _tools/headless/_probe_jr_death_real.js --mode enriched --bucket approach --mind 3 --maxd 12 --frames 2600 --every 5 --out _tools/headless/_ev_prof/jr_real_approach.json
run realContact jr_real_contact.log _tools/headless/_probe_jr_death_real.js --mode enriched --bucket contact --frames 2000 --every 5 --out _tools/headless/_ev_prof/jr_real_contact.json
echo "ALL DONE $(date '+%F %T')" >> "$LOGD/jr_suite_status.log"
