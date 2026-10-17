#!/bin/bash
# 阶段 3-0（v181）：全量 diff_*.js 套件（**独立输出名，不动任何历史 summary/log**）
cd "/c/Users/L_Shy_P user/Desktop/Code/Python/Projects/TankTrouble Local"
out=_tools/headless/prof/3-5_all_diffs_summary.txt
: > "$out"
for f in game_core/rust/diff_*.js; do
  n=$(basename "$f" .js)
  timeout 240 node "$f" > "_tools/headless/prof/3-5_all_$n.log" 2>&1
  e=$?
  if [ $e -eq 0 ]; then st=PASS
  elif [ $e -eq 124 ]; then st=TIMEOUT
  elif grep -q "link.exe\|linker\|cargo run failed" "_tools/headless/prof/3-5_all_$n.log"; then st=ENV_NO_MSVC
  else st="FAIL($e)"; fi
  echo "$st $n" >> "$out"
done
echo DONE >> "$out"
