# 奖惩 10 条落地 + 零 double-count（`2026-10-17` 夜 · 实施子代理）

> 派单：父代理「把奖励做成 10 条全部落地 + 零 double-count」
> 工程约束（父代理原文）：**奖励逻辑抽到新文件 `_tools/training/rewards.py`；`train_ppo_online.py` 只改 `reward_of()` 一处**
> 铁律依据：`AGENTS.md:1508`（铁律零）· `子代理通用背景.md §2`（四条铁律）

---

## 〇、改了哪些文件 + `md5`（前 → 后）

| 文件 | 前 `md5` | 后 `md5` | 说明 |
|---|---|---|---|
| `_tools/training/train_ppo_online.py` | `320cac09 981dc5246c207598be8527f3` | `2fb1d2f3 4380bb3572d89e0b280abdc4` | **只动 `reward_of()`**：删掉 13 行权重乘法 ⟹ 改为 `return _rewards.reward_of(f, cfg)`（`git diff` 里这一个 hunk 是我的，其余 hunk 是另一代理的 `pg_grow`/`ent_grow`） |
| `_tools/training/rewards.py` | ——（新增） | `65b3968d 58ed739f341aaf4a4413800b` | ⭐ 奖励合成**唯一入口**（616 行，含逐项出处登记 `WEIGHT_SRC`/`INFERRED`） |
| `_tools/training/rewards_selftest.py` | ——（新增） | `9e1f1786 31c8b6854ad756382a558481` | ⭐ 手算对拍（`==` 逐位相等） |
| `_tools/training/vt_buffer.py` | `cf82e3f9 f1372eaf64c5645ea27fe1d7` | **同左（我没改）** | 另一代理 `21:51` 已改过它（`act.grow`）⟹ 按派单"grep 确认没人动过"，我**没碰**；`t_min` 直通也因此**没加**（见 §四-10） |
| `docs/.../奖励10条落地与零double-count-2026-10-17.md` | ——（新增） | 本文 | |

**`chrome` 起止**：开工时 `chrome.exe = 0`；中途另一代理起了采集器 ⟹ 收工时 `chrome.exe = 20`（**不是我的进程**；按纪律「⛔ 不批量杀 `chrome`」我没有杀，也**没有**起过任何一个 chrome）。

**磁盘**：`C:` 开工 `6.3G` 可用 → 收工 `6.3G`（未变）；`D:` 开工 `5.9G` 可用 → 收工 `5.4G`（**掉的是另一代理的采集产出**；我只写了 `D:/vt_run/rewards_final.log` 16 KB + `rewards_selftest.log` 9 KB + `rw_smoke{,2,3}_*.log`）。

---

## 一、一句话结论

**10 条里 9 条真的落地了（且每一条都用手算样本逐位验算过），第 10 条（速通 `speed`/`fast_death`）公式与验算都到位、但真实管线缺 `T_min` 数据源 ⟹ 实机贡献恒 0，按铁律零判「未实现」；double-count 5 处全部修干净（`legal` 实扣已回到 `-0.05`、一次击杀正好 `1.0`、双死只算 `draw`），每一处都有计数器可核。**

---

## 二、⭐ 10 条总表（可核对）

> 「主人原话」= `02-实现/进展记录/奖惩审计与实机三现象-2026-10-17.md:11-20` 记录的**主人要求**原文（我逐字抄，未改写）。
> 「权重」= **实际生效值**（来自 `train_ppo_online.DEFAULTS` 或 `rewards.EXTRA_DEFAULTS`；若走 `--w-xxx` 覆盖则以覆盖值为准）。
> 「实现位置」= `rewards.py` 行号（md5 `65b3968d…`）+ 原始事件来源。

| # | 项 | 主人原话 | 权重 | 出处标注 | 实现位置（文件:行号） | 实际生效值（验算） |
|---|---|---|---|---|---|---|
| 1 | `kill` 击杀对手 | **击杀对手加分** | `w_kill=+1.0` | 权重【无出处、待主人拍】；口径**有出处**（`TANK_KILLED` 的 `killer/victim`，`_collect_tmp.js:112` `rKill++`） | `rewards.py:510`（合成）+ `rewards.py:224` 之外的事件源：`_collect_tmp.js:108-115` | **一次击杀 ⟹ `_rew` 增量正好 `+1.0`**（`== 1.0`，hex `0x1.0p+0`）✅ selftest ep9003 |
| 2 | `selfkill` 自杀 | **自杀惩罚**（自己子弹打自己） | `w_selfkill=-1.5` | 【无出处、待主人拍】；**强于 `death`** 符合主人原话 | `rewards.py:514` | 1 次 = `-1.5`（`!=` 推断，事件 `killer===victim===我方`）✅ selftest ep9001 t=4 |
| 3 | `death` 被击杀 | **死亡惩罚**（被别人子弹打死，**弱于自杀**） | `w_death=-1.0` | 【无出处、待主人拍】；`-1.0 > -1.5` ⟹ **确实弱于自杀** ✅ | `rewards.py:516` | 1 次 = `-1.0` ✅ ep9004 t=0 / ep death |
| 4 | `win` 胜利 | **胜利奖励**（可能按人数缩放） | `w_win=+3.0` | 【有出处（主人 `2026-10-17` 原话）】「胜利的奖励绝对需要最大」；⚠️ **"按人数缩放"未做**（见 §四-4） | `rewards.py:522` | 1 次 = `+3.0`（**旧的 `result=+1` 已被抑制 ⟹ 不是 +4.0**）✅ ep win |
| 5 | `lose` 失败 | **失败惩罚** | `w_lose=-1.0` | 【无出处、待主人拍】 | `rewards.py:523` | 1 次 = `-1.0`（**旧的 `result=-1` 已抑制 ⟹ 不是 -2.0**）✅ ep lose |
| 6 | `draw` 平局 | **平局规则**（`1v1` 击杀与被杀刚好相抵；`1v1` 平局扣分） | `w_draw=-0.5` | 【无出处、待主人拍】；口径=**父代理派单原文**（`ended && 仅2坦克 && 双方皆死`） | `rewards.py:296`（判定）+ `rewards.py:524`（合成） | 双死 1v1 ⟹ `-0.5`，**`result` 那一路 = 0.0**（`parts["result"][2]==0.0`）✅ ep9004；⚠️ 另两处边界：我赢了但对手死 ⟹ **不给** `draw`（ep9014 `_rew==3.0`）；双方皆死但无 `-0.25` 信号 ⟹ **不给** `draw` 并计数（ep9015） |
| 7 | `crate` 捡道具 | **捡道具奖励**（后期逐渐移除） | `w_crate=+0.05`（× `scale`） | 【无出处、待主人拍】；口径=**推断**（`INFERRED["crate"]`）：我方**格内**消失 1 个 ⟹ 记 1 | `rewards.py:224`（差分+格判定）+ `rewards.py:546`（合成+衰减） | 我方格内消失 1 个 ⟹ `+0.05`（raw 与归一化坐标**两种都验过**：ep9001 t=1、ep9017）✅ |
| 8 | `death_storm` 被毒雾杀 | **被毒雾杀死 = 自杀惩罚** | `w_death_storm=-1.5` | 【无出处、待主人拍】；口径=**【推断】**（`TANK_KILLED` 且 `killer` 缺失） | `rewards.py:518` | 1 次 = `-1.5`（**与自杀同权** ✓ 符合原话）✅ ep death_storm |
| 9 | `kill_storm` 毒雾杀对手 | **对手被毒雾杀死 = 我方击杀奖励** | `w_kill_storm=+1.0` | 【无出处、待主人拍】；口径=**【推断】**（同上） | `rewards.py:511` | 1 次 = `+1.0`（**与击杀同权** ✓）✅ ep9001 t=3 |
| 10 | `speed` 速通 / `fast_death` 死得太快 | **速通奖励**（击杀用时 vs 路线最短用时+时限） | `w_speed=+0.5` / `w_fast_death=-0.5` | 权重【无出处、待主人拍】；**时限 `Δ=60` 帧** = 父代理派单原文；公式 = 派单原文 `0.5×(1−(T_kill−T_min)/Δ)` | `rewards.py:358`（speed）/ `:395`（fast_death）/ `:338`（`T_min` 取数）；`:551-553`（合成） | 🔴 **公式与验算 OK（ep9009/9010/9012 逐位相等），但真实管线里 `T_min` 不存在 ⟹ 实机贡献恒 `0.0`**，计 `speed_blocked_no_tmin`。详见 §四-10 |

**另三条与奖励强相关（不在 10 条里，但主人点过 / 父代理裁定过）**

| 项 | 原话/出处 | 权重 | 实现位置 | 实际生效值 |
|---|---|---|---|---|
| `legal` 重罚 | 【无出处、待主人拍】"每次被拒 `-0.05`" | `w_legal_pen=0.05`（`legal` 是**负数计数**） | `rewards.py:566` | **被拒 1 次 ⟹ `_rew` 增量正好 `-0.05`**（`== -0.05`）✅ ep9002；🔴 旧的 `w_legal=1.0` **已退役**（若 `cfg["w_legal"]!=0` 会一次性打告警并计数） |
| `empty_fire` 空射 | 【有出处（主人 `2026-10-17` 原话）】"没子弹仍扣扳机 = 纯错" | `w_empty_fire=-0.10` | `rewards.py:567` | 1 次 = `-0.10` ✅ ep empty_fire |
| `spawn`/`aim` | 父代理裁定 (B)/(B-2)【无出处、待主人拍】 | `+0.02` / `+0.01` | `rewards.py:569/571` | 各按次数线性计 ✅ ep spawn+aim（2 发 + 1 次瞄准 = `0.05`） |
| `survive` | 【无出处、待主人拍】旧口径（不在主人 10 条里） | `w_survive=1.0`（采集器每帧写 `r["survive"]=0.01` ⟹ 每帧实得 `0.01`） | `rewards.py:564` | selftest 用合成值 `survive=1.0` 验得 `+1.0`；**真实数据每帧 `0.01`**（值来自采集器，不由本文件决定） |

---

## 三、⭐⭐ 零 double-count：5 处，逐条修 + 逐条验算

| # | 症状 | 根因（文件:行号） | 修法 | 验算（`rewards_selftest.py`） |
|---|---|---|---|---|
| **D1** | `legal` 被两个权重各乘一次 ⟹ 实扣 `-1.05` | 旧 `train_ppo_online.py:412` `w_legal*r["legal"]` + 旧 `:420` `w_legal_pen*r["legal"]` | **只保留 `w_legal_pen`**；`w_legal` 退役，若 `!=0` 就**一次性 stderr 告警 + 计数** `legal_legacy_w_ignored` | `ep9002`：`_rew == -0.05`（hex `-0x1.999999999999ap-5`）；旧口径会是 `-1.05` |
| **D2** | `hit` 与 `kill` 同一事件双计 ⟹ 一次击杀实得 `1.2` | `_collect_tmp.js:112` `rKill++; hitNow++;` ⟹ `hit ⊇ kill` | `hit` 改成**命中但未致死** = `max(0, hit−kill)`；`hit>0 && hit<kill` ⟹ **直接抛错**；`hit==0 && kill>0` ⟹ 计 `hit_absent_with_kill` | `ep9003`（`kill=1, hit=1`）：`_rew == 1.0`；`hit_all_lethal_suppressed==1`；反例 `ep(hit=1,kill=2)` 抛错 ✅ |
| **D3** | 终局帧 `result` 与 `win`/`lose` 各给一次 ⟹ 胜实得 `+4.0` / 负 `-2.0` | 旧 `:411`（`w_result`）+ 旧 `:419`（`w_win`/`w_lose`） | 终局帧只要有 `win>0‖lose>0‖draw>0` ⟹ **`result` 权重项置 0**，计数 `result_suppressed_win/lose/draw` | `ep win` ⟹ `3.0`；`ep lose` ⟹ `-1.0`；`ep9014`（我赢且对手死）⟹ `3.0` |
| **D4** | 双死 1v1：`result=-0.25`（`_collect_tmp.js:214` `won===-1` 分支）+ 若再给 `draw` ⟹ 双记 | 同上 | 双死**只走 `draw`**，`result` 置 0（派单原文） | `ep9004 t=1`：`parts["result"]=(value=0.0, weight=1.0, contrib=0.0)`、`parts["draw"][2]==-0.5`，`_rew == -0.5` |
| **D5** | 采集器若**直供** `crate`/`draw`，训练侧再自己算 ⟹ 双记 | `_collect_tmp.js:188` 现在写的是字面量 `crate:0,draw:0`（**恒 0**） | **采集器优先**：`r["crate"]>0` / `r["draw"]>0` ⟹ 用采集器的，本文件的推断值丢弃（计 `crate_from_collector`/`draw_from_collector`） | `ep9016`（直供 `draw=1`）⟹ `_rew == -0.5`（只一次） |

> ⚠️ **D5 的隐含纪律**：本文件的 `crate`/`draw` 推断**只在采集器还没实现时才起作用**；一旦采集器（另一代理）把真值写进 `r`，训练侧自动让位（不会 2 倍）。

---

## 四、⭐⭐⭐ 实际生效值验算（hand-computed vs code，`==` 逐位相等）

跑法：`PYTHONIOENCODING=utf-8 py -3.13 _tools/training/rewards_selftest.py` ⟹ 末行 `ALL_OK`，日志 `D:/vt_run/rewards_selftest.log`。
判据**不是** `approx`：总和按 `rewards.ITEMS` **同一顺序**累加（浮点加法不结合），再比 `==` 与 `float.hex()`。

### 4.1 手算样本 `ep9001`（5 帧，一次把所有可共存项都撞到）

| t | 触发 | 手算（逐项 `weight×value`） | 代码 `_rew` | hex |
|---|---|---|---|---|
| 0 | 存活 + 真发射 1 发 + 场上 1 个道具在**我方格**（我 `(12,22)`→格(1,2)；道具 `(15,25)`→格(1,2)） | `survive 1.0×1.0 + spawn 0.02×1.0` | `1.02` | `0x1.051eb851eb852p+0` |
| 1 | 该道具**我方格内消失** + 被拒 1 次 + 没子弹扣扳机 | `crate 0.05×1 + survive 1.0 + legal 0.05×(−1) + empty_fire (−0.10)×1` | `0.9` | `0x1.ccccccccccccdp-1` |
| 2 | 击杀 1 次（采集器同事件也把 `hit` +1）+ 瞄准命中 | `kill 1.0×1 + hit_nonlethal 0.2×0 + survive 1.0 + aim 0.01×1` | `2.01` | `0x1.0147ae147ae14p+1` |
| 3 | 对手被毒雾杀（推断口径） | `kill_storm 1.0×1 + survive 1.0` | `2.0` | `0x1.0000000000000p+1` |
| 4 | 终局：自杀死 + 1v1 双方皆死 + `result=-0.25` | `selfkill (−1.5)×1 + draw (−0.5)×1 + result 1.0×0（抑制）` | `-2.0` | `-0x1.0000000000000p+1` |

**代码输出**：`[1.02, 0.9, 2.01, 2.0, -2.0]`——**与手算逐位相等** ✅

### 4.2 三条必须证明的断言

| 断言 | 手算 | 代码 | 判定 |
|---|---|---|---|
| `legal=1` ⟹ `legal` 贡献**正好 `−0.05`** | `0.05×(−1) = −0.05` | `_rew == -0.05`（hex `-0x1.999999999999ap-5`） | ✅ 不是 `−1.05` |
| 一次击杀 ⟹ 总贡献**正好 `1.0`** | `kill 1.0×1 + hit_nonlethal 0.2×(1−1=0) = 1.0` | `_rew == 1.0`（hex `0x1.0000000000000p+0`） | ✅ 不是 `1.2` |
| 双死 1v1 ⟹ **只算 `draw`**，`result` 贡献 `0` | `draw (−0.5)×1 + result 1.0×0` | `_rew == -0.5`；`parts["result"][2]==0.0` | ✅ |

### 4.3 其余分项（每项一局，`done=True`）

| 项 | 手算 | 代码 | 判定 |
|---|---|---|---|
| `win`（`result=+1` 同时在场） | `3.0×1`（`result` 抑制） | `3.0` | ✅ |
| `lose`（`result=-1` 同时在场） | `(−1.0)×1` | `-1.0` | ✅ |
| `death` | `(−1.0)×1` | `-1.0` | ✅ |
| `death_storm` | `(−1.5)×1` | `-1.5` | ✅ |
| `hit` 命中未致死（`hit=2, kill=1`） | `kill 1.0 + hit 0.2×1` | `1.2` | ✅ |
| `empty_fire` | `(−0.10)×1` | `-0.1` | ✅ |
| `spawn`×2 + `aim`×1 | `0.02×2 + 0.01×1` | `0.05` | ✅ |
| `survive` | `1.0×1` | `1.0` | ✅ |
| `speed`（`T_kill=2, T_min=1, Δ=60`） | `kill 1.0 + 0.5×(1−1/60)` | `1.4916666666666667`（hex `0x1.7dddddddddddep+0`） | ✅ |
| `fast_death`（`T_death=1, T_min'=1`） | `death (−1.0) + (−0.5)×1` | `-1.5` | ✅ |
| `crate` 衰减（`progress=0/0.5/1`） | `0.05 / 0.025 / 0.0` | `0.05 / 0.025 / 0.0` | ✅ |
| `crate`（**归一化坐标** `norm=true`） | `0.05×1` | `0.05` | ✅ |

### 4.4 真代码路径（不是只测函数）

`JSON → vt_buffer.decode_episode → EpisodeBuffer.append_episode → train_ppo_online.prepare_targets()`

```
buffer 局数=13 帧数=18  tails={'done': 13, 'v_next_used': 0, 'zeroed': 0, 'truncated': 0}
_rew（真路径）= [1.02, 0.9, 2.01, 2.0, -2.0, 3.0, -1.0, -1.0, -1.5, 1.2, -0.1, 0.05, 1.0, 3.0, -1.5, -0.5, 0.0, 0.05]
_rew（手算）  = [1.02, 0.9, 2.01, 2.0, -2.0, 3.0, -1.0, -1.0, -1.5, 1.2, -0.1, 0.05, 1.0, 3.0, -1.5, -0.5, 0.0, 0.05]
逐位相等 = True（长度 18 vs 18） ； 幂等复跑逐位相等 = True
```

再加一次**整个训练器**真跑（CPU，产出写 `D:`）：

```
py -3.13 _tools/training/train_ppo_online.py --mode smoke --device cpu --no-auto-resume --out D:/vt_run/rw_smoke3
⟹ SMOKE_OK step=2 cycles=2 frames_trained=186 kl_first=0.2168 delta_max=1.106e-02
stderr 里能看到 [rewards] 的开机告警（EXTRA_DEFAULTS / w_legal 退役 / 道具几何计数）
```

单帧开销：`reward_of` = **25.6 µs/帧**（2 万次实测），相对 1.6 ms/样本 **≈1.6%**。

---

## 五、⚠️ 未实现 / 推断口径 / 待接线（逐条列清）

### 5.1 🔴 未实现（1 条）

**第 10 条 `speed` / `fast_death`：公式与验算都到位，但**真实管线拿不到 `T_min`** ⟹ 实机贡献**恒 `0.0`**。**

- 缺什么：`T_min` = "子弹从我方到对手的**最短飞行帧数**"，必须由页面内 `AIUtils.checkFiringPath` / `B2DUtils.calculateProjectilePath` 求出 `L_min` 再 `ceil(L_min / v_bullet / 0.02)`。
- 为什么不实现：那是**采集侧（`_collect_tmp.js` / `inject_fire.js`）**的活，而这两个文件**父代理明确划给另一代理**（"⛔ 不碰"）。
  ⛔ 我也**没有**拿"直线距离"或任何常数顶替（派单原话：读不到弹道/速度就显式报错并计数）。
- 现状：`rewards.py:338` `_tmin()` 会读 `r["t_min"]` / `f["t_min"]`（>0 且有限才用）；读不到 ⟹ 该项 `0.0` + 计 `speed_blocked_no_tmin`（**每次首次出现打一行 stderr**）。
- 还有两道**接线**没通（都属别人的文件）：
  1. `vt_buffer.OPTIONAL_REWARD_KEYS`（`vt_buffer.py:42`）里**没有** `t_min`/`t_min_death` ⟹ 即使采集器发了，`decode_frame()` 也会**丢掉**。
  2. 采集器 `_collect_tmp.js:188` 的 `r` 里没有 `t_min` 字段。
- `T_kill` 起点口径是**推断**（`INFERRED["speed"]`）：`T_kill = 击杀帧 − 最近一次真发射帧`（`r["spawn"]>0`，退化到 `act.fire==1` 时计 `speed_fire_ref_from_intent`）。**待主人拍**：起点该不该是"本回合第 0 帧"。

### 5.2 ⚠️ 推断口径（3 条，全部已登记 + 计数）

| 项 | 推断的是什么 | 依据 | 计数器 |
|---|---|---|---|
| `crate` | **归属**：只认"我方**格内**消失"（不是 `getCollectibles()` 的直接归属） | 派单原文 + `item` 段位置与 `global[6]/[7]` 同源（`vantage_observe.js:341,446` 同一个 `norm`） | `crate_attr_mine` / `crate_attr_ambiguous` / `crate_vanished_adjacent` / `crate_cell_out_of_range` / `crate_units_ambiguous` / `crate_geom_bad_tiles` |
| `kill_storm` | 用"`TANK_KILLED` 里 `killer` 缺失"代表"毒雾杀" | `_collect_tmp.js:109` 注释自认【推断】 | 采集器侧 `summary.legalByCls`/`kill_storm` 计数不在我手；训练侧按 `r["kill_storm"]` 直取 |
| `death_storm` | 同上 | 同上 | 同上 |
| `draw` | `me_dead` 的两条来源：① 本局任一帧 `death|selfkill|death_storm>0`（**优先**）② global 死亡段 `dVictimIdx==0` **且位置非零且 deadlyType≠0**（防"空死亡段全零"误判） | `vantage_observe.js` P4 稳定索引表"自车=0" | `me_dead_from_death_seg` / `draw_structural` / `draw_structural_no_result_signal` / `draw_conflict_winlose` / `draw_history_unknown` |
| `hit_nonlethal` | `hit − kill`（依赖采集器"`hit` 含致命击杀"的约定） | `_collect_tmp.js:112` | `hit_all_lethal_suppressed` / `hit_nonlethal_events` / `hit_absent_with_kill`（+ 不一致时**抛错**） |

### 5.3 ⚠️ 已实现但**实机运行时次数 = 0 / 未测**（按铁律零第②条，只能写"未验证"）

| 项 | 代码 | 手算 | 实机次数 |
|---|---|---|---|
| `draw`（双死 1v1） | ✅ `rewards.py:296` | ✅ `ep9004 / ep9014 / ep9015 / ep9016` | ❓ **0**（审计文档记"30 局全未决"，本轮我没跑采集） |
| `crate`（捡道具） | ✅ `rewards.py:224` | ✅ `ep9001 t=1` + `ep9017` | ❓ **未测**（真数据里 `item` 段有货、`global[0]/[1]=8/5` 是正整数，理论可算；但没跑真局） |
| `crate` 线性衰减 | ✅ 钩子已实现 | ✅ `progress=0/0.5/1` | 🔴 **未生效**：训练器**没把轮次传进来**（`cfg` 里没有 `train_progress01`）⟹ 默认 `crate_decay_train_rounds=0`（不衰减），计 `crate_decay_unavailable_frames`。接线只需父文件加一行（**我按约束没加**） |

### 5.4 ⚠️ 口径与主人原话的差异（**不糊**，逐条写明）

1. **第 4 条"胜利奖励（可能按人数缩放）"**：**没有人数缩放**（`w_win=3.0` 固定）。主人原话带"可能"⟹ **待主人拍**：要不要 `× (players−1)` 或 `÷(players−1)`。
2. **第 6 条"`1v1` 击杀与被杀刚好相抵"**：本实现**没有**做"相抵"的算术（`kill + lose`/`death` 各自独立加权，`+1.0` 与 `-1.0` 恰好相消是**权重的巧合**，不是代码里的相抵规则）。若主人要的是"显式相抵"（例如净击杀为 0 就不给分），需要另拍口径。
3. **第 7 条"后期逐渐移除"**：钩子已实现（线性到 0），**未接线**（见 5.3）。
4. **`survive` 的尺度**：采集器每帧写 `0.01`（`_collect_tmp.js:187`），`w_survive=1.0` ⟹ 每帧实得 `0.01`。这是**旧口径**，不在主人 10 条里，我没动。

### 5.5 我**没有**改的东西（纪律留痕）

- ⛔ 没碰 `net_v2_fixed.py` / `policy_server_graph.py` / `inject_fire.js` / `_collect_tmp.js`（另一代理在改；`_collect_tmp.js` 的 md5 在我这轮里从 `c44b6249` 变成 `1e38f3b1`，**不是我改的**）。
- ⛔ 没碰 `game_core/`、`_tools/eval/`。
- ⛔ 没碰 `vt_buffer.py`（开工时还是干净的，`21:51` 被另一代理改过 ⟹ 我按"grep 确认没被别人动过"直接放弃改动，代价是 `t_min` 直通没加，见 5.1）。
- ⛔ 没在 `train_ppo_online.py` 的 `DEFAULTS` 里加键（那是 `reward_of()` 以外的位置）⟹ `w_speed`/`w_fast_death`/`speed_delta_frames`/`crate_decay_train_rounds` 的缺省值放在 `rewards.EXTRA_DEFAULTS`（`rewards.py:52`），**开机即打印**（`[rewards] 缺省来自 rewards.EXTRA_DEFAULTS…`），⛔ 不悄悄生效。

---

## 六、怎么复现本文所有数

```bash
# 1) 手算对拍（逐位相等 + 反例）
PYTHONIOENCODING=utf-8 py -3.13 _tools/training/rewards_selftest.py      # 末行应为 ALL_OK
# 2) 整个训练器真跑一次
PYTHONIOENCODING=utf-8 py -3.13 _tools/training/train_ppo_online.py --mode smoke --device cpu \
    --no-auto-resume --out D:/vt_run/rw_smoke3 --sample-frames 5         # 应见 SMOKE_OK
# 3) 真跑采集后，看这些计数器就知道哪一项真的生效了（都在 stderr 的 [rewards] 行里）
#    hit_all_lethal_suppressed / speed_blocked_no_tmin / crate_attr_mine / draw_structural
#    result_suppressed_win|lose|draw / legal_legacy_w_ignored / crate_decay_unavailable_frames
```

---

🔴 铁律提醒（转告父代理）：持续任务不得停 —— 手里必须始终有子代理在跑；且不得自己编任务跑偏。
