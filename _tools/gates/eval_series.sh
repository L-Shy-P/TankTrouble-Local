#!/usr/bin/env bash
# 评测序列（父代理 2026-10-17 夜）：对多个 ckpt 跑同一套 30 场景 ⟹ 胜率曲线
set -u
ROOT="C:/Users/L_Shy_P user/Desktop/Code/Python/Projects/TankTrouble Local"; cd "$ROOT"
LOG="${EVAL_LOG:-D:/vt_run/eval_series.log}"
for tag in "$@"; do
  DIST="D:/vt_run/dist/$tag"
  CK="$DIST/ckpt/model_latest.pt"
  if [ ! -f "$CK" ]; then echo "[$(date +%H:%M:%S)] SKIP $tag（没有 $CK）" | tee -a "$LOG"; continue; fi
  echo "[$(date +%H:%M:%S)] === EVAL $tag start ckpt=$CK ===" | tee -a "$LOG"
  mkdir -p "D:/vt_run/eval_run/$tag"
  VT_CKPT="$CK" PYTHONIOENCODING=utf-8 timeout 3600 node _tools/eval/run_scenes_30.js --all --cap 3600 \
     > "D:/vt_run/eval_run/$tag/scenes.jsonl" 2> "D:/vt_run/eval_run/$tag/scenes.err"
  echo "[$(date +%H:%M:%S)] $tag run EXIT=$? lines=$(wc -l < D:/vt_run/eval_run/$tag/scenes.jsonl 2>/dev/null)" | tee -a "$LOG"
  py -3.13 _tools/eval/evaluate_30.py --ingest "D:/vt_run/eval_run/$tag/scenes.jsonl" 2>&1 | tail -20 | tee -a "$LOG"
done
echo "[$(date +%H:%M:%S)] SERIES_DONE" | tee -a "$LOG"
