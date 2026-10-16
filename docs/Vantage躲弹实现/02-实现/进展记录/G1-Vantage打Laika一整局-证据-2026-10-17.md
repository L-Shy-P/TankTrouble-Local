# `G1`：`Vantage` 打 `Laika` —— 【一整局跑通】的证据（`2026-10-17` 夜）

> **本文只记一次实跑的原始证据**，判决口径 = 母任务给的四条判据。
> **本轮没改任何产品代码**（`game_core/` 一行未动、`policy_server_graph.py` 一行未动），
> 只新增两个**探针脚本**（都在 `_tools/headless/`，`_` 前缀 = 临时/探针）：
> · 页面侧：`_tools/headless/_g1_inject.js`
> · 驱动侧：`_tools/headless/_g1_vs_laika.js`（Node）
> **产出**：`D:/vt_run/g1/frames_final.jsonl`（`2844` 行逐帧记录）· `summary_final.json` · `run_final.log`

---

## 〇、一句话

⭐ **跑通了**：`aiCount:1`（`Laika` = `6148530`）+ `vantCount:1`（`vantage_1`）的 `2` 人局，
**`2844` 帧**走到 `between rounds`，**胜者 = `vantage_1`（`Vantage` 赢）**；
`Laika` 全程在动、在开枪；`Vantage` 由【树 + 神经网络桥】每帧驱动（`2843/2843` 帧都上了策略服务端）。

---

## 一、四条判据

### 判据 1 ⭐ 一局真的打完（有明确胜者）

**`ROUND_ENDED` 事件原文**（页面内 `RoundModel._EVENTS.ROUND_ENDED` 监听器抄下来的）：
```json
{"n":2843,"evt":"ROUND_ENDED","playerIds":["vantage_1"],
 "scores":[{"playerId":"6148530","type":0,"value":0},{"playerId":"6148530","type":1,"value":0},
           {"playerId":"vantage_1","type":0,"value":0},{"playerId":"vantage_1","type":1,"value":1}]}
```
- **`type 0 = KILL` · `type 1 = VICTORY`**（出处：`SCORE_TYPES:{KILL:0,VICTORY:1}` —— `cache/cdn_tanktrouble_com/ab3b5cc046f0290a6e1fcffbdee2a485.js` 原版常量；计分逻辑 `game_core/game_modes_decoded.js` 的 `BootCampGameMode.getScoreStates` 与 `ROUND_ENDED` 分支）
- **`vantage_1` 的 `VICTORY = 1`、`6148530` 的 `VICTORY = 0`** ⟹ **明确胜者 = `Vantage`** ✓✓
- 结束状态：`GameManager.getGameController().getState() = 'between rounds'`（`GameModel._STATES.BETWEEN_ROUNDS`）✓
- 死因（`TANK_KILLED` 原文）：`{"killer":"6148530","victim":"6148530"}` —— **`Laika` 被自己的反弹弹打死**（自伤，不给 `KILL` 分）。
- 从最后一死到 `ROUND_ENDED` 间隔 `2843-2662 = 181` 帧 ≈ `3s` = `Constants.ROUND_FINISHING_DURATION`。

### 判据 2 ⭐ `Laika` 真的在动、在开枪

| 指标 | 值（`6148530`） | 出处 |
|---|---|---|
| 位姿变化帧数 | **`715/2661`（`27%`）** | `frames_final.jsonl` 逐帧 `pl` |
| 不同位姿个数 | **`649`** | 同上 |
| 累计位移 | **`72.11`** 单位（单帧最大 `0.27`） | 同上 |
| 子弹在空中的帧数 | **`2797/2844`** | 逐帧 `projBy["6148530"] > 0` |
| 开火的弹数（`_bulletsFired`） | **`0 → 4`** | 逐帧 `wep["6148530"].fired` |

**坐标原文（抽样，`x,y,rot`）**：
```
frame   3 ( 25.10, 24.21, r 0.014)   frame 200 ( 27.24, 20.31, r 2.769)
frame 600 ( 33.16, 28.26, r 5.929)   frame 1000 ( 33.90, 34.31, r 5.464)
frame 1800 ( 41.47, 36.11, r 5.899)  frame 2600 ( 32.91, 33.23, r 7.971)
frame 2660 ( 37.26, 36.86, r 9.963)  ← 死前最后一帧
```
**弹丸计数原文**：`frame 200 {"6148530":1}` · `frame 1000 {"6148530":2}` · `frame 2600 {"6148530":5}` · `frame 2660 {"6148530":4}`

### 判据 3 ⭐ `Vantage` 那边真的每帧在提交输入

- **机制**：`VantageAIManager.update` **每帧无条件** `gameController.setInputState(newInputState)`
  （出处：`game_core/js/ai_vantage.js`，注释写着"v5 每帧无条件提交…重复提交无害"）✓
- **每帧提交物实测**（读 `AIManager.storedStates` 的 `forward/back/left/right/fire`）：
  **`2843/2844` 帧有提交记录**（缺的那 `1` 帧是开树之前的 `f=0`），其中 **`257` 帧非零**（模式分布：`f×23 / fl×69 / fr×45 / b×55 / bl×29 / l×30 / r×5 / br×1`）
- **策略上行**：**`2843/2843` 次请求全部拿到 `nodeId`、`0` 个越界、`0` 个 `err`** ⟹ 每帧都在问策略、每帧都在回写动作 ✓
- **`Vantage` 自己也在动**：位姿变化 `257/2842` 帧（有姿态的帧数 = `2842`）、不同位姿 `258` 个、累计位移 `46.99` 单位
  ```6:…, frame 600 ( 3.46, 19.82, r-1.208) → frame 1800 ( 11.79,  8.98, r-3.689) → frame 2600 ( 13.04, 11.02, r-3.689)```
  （⚠️ 见 §四：**它大部分帧输入全零**，移动是"成段"的，不是每帧都在动）

### 判据 4 ⭐ 帧数与墙钟

| 项 | 值 |
|---|---|
| 记录帧数 | **`2844`**（`f=0 … 2843`） |
| 墙钟 | **`54.6 s`**（含服务端预热 `~1s` + 浏览器启动 ~3s） ⟹ 单帧约 `17.8 ms` |
| 其中 | `step`（页面读观测+回写）中位 **`6 ms`** · `ask`（服务端一问一答）中位 **`6 ms`** |
| 地图 | `7 × 5`（原版随机建图，人数 `2` ⟹ `(2+4)×U(1,1.5)` 截断所得） |
| 观测规模 | 节点行数 `N`：`0 → 1000`（撞上限）；`bulletRows` 恒 `≤ 5` |

---

## 二、品质三数（**速度与品质同报**）

| 项 | 值 | 说明 |
|---|---|---|
| `lp_finite` | **`2843/2843` = `100%`** | 每一次请求都拿到有限 `lp` |
| `nodeId < N` | **`2843/2843`**，越界 `0`、`err` `0` | `distinct_nodeIds = 386`（不是恒等常量） |
| 观测哈希是否在变 | **`unique 1616/2844`**（前半 `962/1421`、后半 `655/1422`） | 哈希 = 对**上行三段（node+opp+global）每个数**做 FNV-1a；**后半段重复是因为树已满 `1000` 且 token 量化**（`435` 个不同 commit 节点，不是冻结） |
| 服务端 `stderr` | 只有 `2` 条 `UserWarning`（`enable_nested_tensor` / `requires_grad` 转标量）+ `CKPT_NONE`；**无异常、无 `Traceback`** | 未 `DEVNULL` ✓ |
| 页面错误 / `step` 错误 | **`0` / `0`** | |

### 我实际送了几段、`N` 是多少（**母任务要求必报**）

- **`3` 段**：`node`（**`N` 行 × `10`**，`N = 真实节点数 = segs.node 行数`，**两者严格相等**）、`opp`（`1 × 15`）、`global`（`1 × 38`）
- 载荷：`{"N": N, "seed": <帧号+1>, "segs": {...}}` —— **`seed` 每帧不同、可复现**
- ⛔ **`bullet` 段【没送】**：`VantageObserve` 的 `BULLET_DIM = 7`（`game_core/js/vantage_observe.js:54`），
  而网络槽位是 `6`（`_tools/training/net_v2_fixed.py:7`）⟹ 送了会被服务端"段超容量"**显式拒绝**（这是它的设计）
- `item` / `mem` 段：**没有生产端**，也不送（沿用现状）

---

## 三、怎么复现（一条命令）

```bash
cd <仓库根>
G1_MAX_FRAMES=12000 G1_MAX_SEC=700 G1_TAG=final timeout 840 \
  node _tools/headless/_g1_vs_laika.js        # 产出写 D:/vt_run/g1/
```
- 每帧：`window.__g1.step(nodeId)` 读观测+回写决策 → 一问一答问服务端 → `m.pump(1)` 泵 1 帧
- 收工：脚本自己 `chrome` 关到 `0`、服务端 `stdin.end()` 后退出（`SRV_EXIT code=0`）

---

## 四、⚠️ 未解决 / 下一轮必须先解决

1. ⚠️⚠️ **`Vantage` 一枪未发**（`wep["vantage_1"].fired` 全程 `0`、`proj_frames = 0`）。
   原因：我给的 bundle 只有 `picks[0]`（路线目标），**`picks[1..]`（= 射击帧）是空的**。
   试了两版"附射击帧"，**都失败**（各 70 帧冒烟，`D:/vt_run/g1/frames_fire_smoke*.jsonl`）：
   - 版一 `picks[1] = {nodeId: 路线目标, back: 1e9}` ⟹ **不触发开火**（执行帧算在"目标节点段首"、与当前游标对不上）
   - 版二 `picks[1] = {nodeId: 根节点 id, back: 1e9}` ⟹ **整车静止、输入全零**
     （`tv.commitId` 冻在 `1`、`commitFrame` 恒 `0`；与游戏自带的"0 帧自杀（炮口贴墙）"拒绝理由吻合 ⟹
     疑似 `agentFireSelfHit` 拒绝该射击帧 ⟹ 该帧 `B:重试超限` ⟹ **整包 B 被丢弃 ⟹ 连路线都没了**）
   ⟹ ⭐ **结论：射击帧必须由策略【连同路线一起】给出，且要落在路线上、且不能炮口贴墙** ——
   这是"动作头要含射击帧"的设计输入，**不属于本轮 `G1`**。
2. ⚠️ **`Vantage` 的输入 `91%` 帧全零**（`2586/2844`），移动是"成段"的
   （一段几帧在动，然后几百帧静止：`frame 600~1400` 位姿完全不变）。
   原因：`VantageTree.getDesiredOperation()` 在"没有 B 路线"的帧返回 `commitNode.inputs`，
   而 commit 段内输入恒定/多为空 ⟹ **"每帧提交"≠"每帧在动"**。
   ⚠️ 这会让 `PPO` 的"移动"信号很稀疏，**训练器设计时要考虑**（不是本轮判据）。
3. ⚠️ **人数 `2` 时地图极小**（`7×5` / `6×5` / `8×4`，实测三局）⟹ `Laika` 常自杀、局均帧数波动大
   （实测 `380` / `550` / `2844` 帧）⟹ **`G4` 的"局均帧数"必须按人数分档实测**。
4. ℹ️ `Match.open({humanIds: []})` **可以**起一局（`2` 名 AI 玩家、无人类），`control:false` 即可 ——
   即"纯 `Vantage` vs `Laika`"，**不需要拿 `tank_a` 当陪衬**（旧脚本用的是 `③` 人局 + 站着不动的 `tank_a`）。
