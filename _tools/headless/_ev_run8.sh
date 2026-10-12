#!/usr/bin/env bash
# ② 复现尝试：v167 门 + 长回合场景，跑 4 次（冻结副本；产品代码未动）
set -u
cd "$(dirname "$0")/../.." || exit 1
LOGD=_tools/headless/_ev_logs; PG=_tools/headless/_ev_pg
export EV_GAME_DIR="$PWD/$PG/game_core"
cp "$PG/vantage_tree.v173ev167gate.js" "$PG/game_core/js/vantage_tree.js"
echo "gate tree md5=$(md5sum "$PG/game_core/js/vantage_tree.js"|cut -d' ' -f1)" >> "$LOGD/align_gate4x.log"
i=0
for tag in g1 g2 g3 g4; do
  i=$((i+1))
  node _tools/headless/_ev_align_delta.js --frames 1800 --tag $tag --ctrl drive --fire 1 --ai 2 --vant 1 --match=_ev_match > "$LOGD/align_$tag.log" 2>&1
  echo "  [$tag] done $(date '+%T')" >> "$LOGD/align_gate4x.log"
done
cp game_core/js/vantage_tree.js "$PG/game_core/js/vantage_tree.js"
echo "COPY RESTORED md5=$(md5sum "$PG/game_core/js/vantage_tree.js"|cut -d' ' -f1) product=$(md5sum game_core/js/vantage_tree.js|cut -d' ' -f1)" >> "$LOGD/align_gate4x.log"
echo "RUN8 DONE $(date '+%F %T')" >> "$LOGD/jr_suite_status.log"
