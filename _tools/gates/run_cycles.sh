#!/usr/bin/env bash
# 整夜循环驱动（父代理 2026-10-17 夜）：采集(K局,带VT_CKPT) → 训练(--resume同一ckpt) → 下一轮用新ckpt
set -u
ROOT="C:/Users/L_Shy_P user/Desktop/Code/Python/Projects/TankTrouble Local"; cd "$ROOT"
CYCLES=${CYCLES:-8}; K=${K:-8}; CAP=${CAP:-1500}; EPOCHS=${EPOCHS:-2}; LR=${LR:-0.0001}
LOG="D:/vt_run/cycles.log"; CKPT="D:/vt_run/seed/ckpt/last.pt"
mkdir -p D:/vt_run/seed
# ① 先产一份种子 ckpt（含 optimizer 状态，供 --resume）
if [ ! -f "$CKPT" ]; then
  rm -rf D:/vt_run/seed
  py -3.13 _tools/training/train_ppo_online.py --mode smoke --out D:/vt_run/seed --seed 11 --epochs 1 --minibatch 8 >/dev/null 2>&1
fi
echo "[$(date +%H:%M:%S)] START cycles=$CYCLES K=$K CAP=$CAP EPOCHS=$EPOCHS LR=$LR ckpt=$CKPT" | tee -a "$LOG"
for i in $(seq 1 $CYCLES); do
  OUT="D:/vt_run/cyc_$i"; COLL="D:/vt_run/collect_$i"
  rm -rf "$OUT" "$COLL"; mkdir -p "$COLL"
  echo "[$(date +%H:%M:%S)] --- cycle $i/$CYCLES collect K=$K cap=$CAP ckpt=$CKPT" | tee -a "$LOG"
  VT_CKPT="$CKPT" C_OUT="$COLL" C_ROUNDS=$K C_CAP=$CAP PYTHONIOENCODING=utf-8 timeout 3000 node _tools/headless/_collect_tmp.js 2>&1 | grep -E "^SUMMARY|ROUND_END" | tee -a "$LOG"
  echo "[$(date +%H:%M:%S)] --- cycle $i train (resume=$CKPT)" | tee -a "$LOG"
  py -3.13 _tools/training/train_ppo_online.py --mode episodes --episodes-json "$COLL/episodes.jsonl" \
    --out "$OUT" --resume "$CKPT" --allow-cfg-override --bootstrap zero --epochs $EPOCHS --minibatch 8 --lr $LR \
    > "$OUT.jsonl" 2> "$OUT.err"
  rc=$?
  grep -E "cycle [0-9]+ 完成" "$OUT.err" | tail -2 | tee -a "$LOG"
  echo "[$(date +%H:%M:%S)] --- cycle $i train EXIT=$rc" | tee -a "$LOG"
  if [ -f "$OUT/ckpt/last.pt" ]; then CKPT="$OUT/ckpt/last.pt"; echo "[$(date +%H:%M:%S)] next ckpt=$CKPT" | tee -a "$LOG";
  else echo "[$(date +%H:%M:%S)] ⚠️ 没有新 ckpt，沿用旧的" | tee -a "$LOG"; fi
done
echo "[$(date +%H:%M:%S)] ALL_DONE" | tee -a "$LOG"
