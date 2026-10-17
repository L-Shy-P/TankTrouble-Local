# ⚠️ `_multiai_vant2_missile.jsonl` 是哪条基线？

> 放在这里是为了让后来的人**先读到**这条说明；**不要删本文件，也不要改上面那条基线**（它是证据）。

## 一句话

| 基线文件 | 对应配置 | 用途 |
|---|---|---|
| **`_multiai_vant2_missile.jsonl`**（+ `.rng.json` / `.meta.json`） | **旧 `DEFAULT_EXP`**：`maxNodes=500 / warmupMaxNodes=500 / nodeCap=false / horizonSec=8 / refineBeyond=true`（testbench ≤ v103） | **A/B 因果证明的证据**：`换回旧 testbench ⟹ 0/600 PASS`。**勿删** |
| **`_multiai_vant2_missile_v179.jsonl`**（+ `.rng.json` / `.meta.json`） | **新默认**：`maxNodes=1000 / warmupMaxNodes=1000 / nodeCap=true / horizonSec=10 / refineBeyond=false`（testbench v104 起，tree v179 录制） | **当前口径**；`_baseline_multiai_vant2_missile.js --mode verify` 的**默认基线** |

## 同一场景（`--missile-frames 60,120,180`、vant=2 / ai=1 / 600 帧）的三种预期

| 环境 | 基线 | 预期 |
|---|---|---|
| 旧 testbench（`99b9c432`） | 旧 `_multiai_vant2_missile.jsonl` | **0/600 PASS** |
| 新 testbench（`5d45a196`，v104） | 旧 `_multiai_vant2_missile.jsonl` | **541/600**（首个分歧 f=60 `nodes 496→505`；**按设计漂移**，不是 bug） |
| 新 testbench（v104） | 新 `_multiai_vant2_missile_v179.jsonl` | **0/600 PASS** |

## 出处

`docs/Vantage躲弹实现/02-实现/进展记录/阶段2-A1A2预算闸门-2026-10-12.md` **§七.5**。

## 重录新基线（只在确实要重建时）

```bash
node _tools/headless/_baseline_multiai_vant2_missile.js --mode record \
  --out _tools/headless/prof/_multiai_vant2_missile_v179.jsonl \
  --frames 600 --missile-frames 60,120,180
```
