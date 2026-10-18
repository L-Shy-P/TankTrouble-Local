# 实测：奖励字段补齐（hit / crate / t_min / aim / still / empty_fire）— 2026-10-18

> 任务：`_tools/training/rewards.py` 读 16 个 `r.<字段>`，但 `_tools/eval/run_scenes_30.js` 的 `S30_DUMP=1`
> 导出的逐帧 `r` 里没有 `hit` / `crate` / `t_min`，`aim` 疑似恒 0，`still`/`empty_fire` 只在终局帧有值。
> 本轮把这些全部补齐并**逐帧实测**。⛔ 未改 `game_core/` 任何文件。

## 一、改了什么

| 文件 | 改动 |
|---|---|
| `_tools/headless/_g1_inject.js` | 只读导出：① 逐帧事件录 `out.ev`（`TANK_DEADLY_COLLISION`/`COLLECTIBLE_DESTROYED`/`PROJECTILE_SHIELD_COLLISION`/`TANK_KILLED`/`PROJECTILE_DESTROYED`/`TIMEOUT`）② `out.mper`（子弹每帧米数）③ `meta.k`（`Constants` 里的子弹速度/炮口偏移/半径/坦克半高/格边长） |
| `_tools/eval/run_scenes_30.js` | 逐帧 `r` 补齐 `hit` / `crate` / `t_min` / `t_min_death` / `aim` / `still` / `empty_fire` / `draw` / `selfkill`，另加 `dbg`（诊断）；修 `kill` / `death` 的归属 |
| `_tools/training/rewards_dump_audit.py` | **新增**：把 `episodes.jsonl` 逐帧过 `rewards.explain()`，输出「非零帧数 / 合计贡献 / **原始量非零帧** / 权重」+ `rewards.STATS` |

## 二、每个字段的数据源与口径

| 字段 | 数据源 | 口径 |
|---|---|---|
| `hit` | `TANK_DEADLY_COLLISION` 事件的 `data.projectile.getPlayerId()` / `data.tankA.getPlayerId()` | 本帧 `shooter=我方 且 victim≠我方` 的次数 |
| `crate` | `COLLECTIBLE_DESTROYED` 事件（`Pickup` 自带 `playerId`） | 本帧 `picker=我方` 的次数 |
| `t_min` | 炮口位置 + 最近存活对手位置 + `out.mper` | `ceil((dist(炮口→对手外壳))/mper)`，取**最近一次真发射那一帧**的值（`rewards._speed_part` 的 `T_kill` 也从"最近一次真发射"起算）；算不出 ⟹ `null` |
| `t_min_death` | 同上，起点换成**对手炮口**、终点是**我方外壳** | 距离对称 ⟹ 同一公式 |
| `aim` | `o.pl` 位姿 | 最近存活对手是否在**炮口方向**±20°：**炮口方向 = `rot − π/2`**（原代码用 `rot`，恒偏 90°） |
| `still` / `empty_fire` | `o.sub`（`mgr.storedStates`）/ `obs.global[15]=ammoLeft` | `still`=四个方向键全 false；`empty_fire`=**`ammoLeft===0`**（修：`-1` 是"取不到"哨兵，旧写法 `<=0` 会误判） |

### ⛔ 结构性结论：`hit_nonlethal` 永远是 0（不是没采到）
`game_core/js/82e43ebfcdffdaf490dbe79c9c119d29.js` 的 `TANK_DEADLY_COLLISION` 分支**无条件**执行
`killTank(kill)` + `destroyProjectile(...)` ⟹ **子弹碰到坦克必然致死** ⟹ `hit == kill` ⟹ `hit - kill = 0`。
实测（一次性探针）：1 次 `deadly`(shooter=vantage_1/victim=laikaX_1) 之后 `gc.getTanks()` 里**已无该坦克**。

### ⛔ 结构性结论：`obs.global[4]`（crateMask）**不能**用来判"捡道具"
实测两场 dump 的 `global[4]` **恒 127**（= 场景开了 7 种箱子类型的位掩码，`cfg.crateTypes` 拼出来的**配置**），
一局内不变 ⟹ 它跟"场上还有几个箱子"无关。

## 三、`aim` 恒 0 的根因（已实测证明）
`rot` **不是**炮口方向。实测（7 个 rotation × 各打一枪，7/7 一致、残差 0.0°）：
- 子弹速度方向 = `rot − 90°`；炮口位置角 = `rot − 90°`；炮口距车心 2.81 m（=2.5 偏移 + 一帧 0.30 m）；子弹速度 18.00 m/s
- 每帧位移 = 18 × 16.6667ms = **0.3000 m/帧**（相邻帧实测 0.2999）

⟹ 旧代码 `atan2(dy,dx) − rot` **恒偏 90°**。同一批数据两种口径对比：
| 场次 | 有角差的帧 | 新口径 `rot−90°` 命中±20° | 旧口径 `rot` 命中±20° |
|---|---|---|---|
| ① dummy8_001 | 96 | 0 | **0** |
| ② p2_clear_crates_20101 | 121 | **16** | **0** |

场次 ① 修好也是 0，原因是**测得**的：`aimDeg` p25/p50/p75 = −173.8°（炮口背对最近对手），
且整局只移动了 0.0263 m（`progress` 原始量合计）⟹ 坦克基本没转。

## 四、逐帧实测表（`rewards.explain(fr,{})`，权重取缺省）

### ① 父代理指定那一场：`dummy8_001`（97 帧，Vantage 第 97 帧自爆）
| 奖惩项 | 非零帧数 | 合计贡献 | 原始量非零帧 |
|---|---|---|---|
| **hit → `hit_nonlethal`** | 0 | 0.0000 | 0 |
| **crate** | 0 | 0.0000 | 0 |
| **speed** | 0 | 0.0000 | 0 |
| **fast_death** | 0 | 0.0000 | 0 |
| **aim** | 0 | 0.0000 | 0 |
| **still** | **81** | **−0.8100** | 81 |
| **empty_fire** | 0 | 0.0000 | 0 |
| selfkill | 1 | −1.5000 | 1 |
| spawn | 1 | 0.0200 | 1 |
| survive | 97 | 0.9700 | 97 |
| 总奖励 | | **−1.319474** | |

### ② 补充：`p2_clear_crates_20101`（302 帧，victory，真对手）
| 奖惩项 | 非零帧数 | 合计贡献 | 原始量非零帧 |
|---|---|---|---|
| **hit → `hit_nonlethal`** | 0 | 0.0000 | 0 |
| **crate** | 0 | 0.0000 | 0 |
| **speed** | 0 | 0.0000 | 0 |
| **fast_death** | 0 | 0.0000 | 0 |
| **aim** | **16** | **0.1600** | 16 |
| **still** | **77** | **−0.7700** | 77 |
| **empty_fire** | 0 | 0.0000 | 0 |
| win | 1 | 3.0000 | 1 |
| survive | 302 | 3.0200 | 302 |
| progress | 87 | 0.0856 | 94 |
| camp | 43 | −2.1500 | 43 |
| 总奖励 | | **3.345560** | |

## 五、每个 0 的**原因**（区分"真 0"和"没采到"）
| 项 | 场次① | 场次② |
|---|---|---|
| `hit` | `ev_total.deadlyMine=0`（唯一 deadly 是**我打我自己**：`deadlySelf=1`） | `deadlyOppSelf=1`（对手自爆）⟹ 我方 0 次命中 |
| `crate` | `item` 段 97 帧**全零**、`crates_max=0` ⟹ 场上从来没有箱子 | `item` 段 302 帧**全零**、`crates_max=0` ⟹ 同上 |
| `speed` | 本帧 `kill=0`（我方无击杀）⟹ 根本不进公式 | 同左（对手**自爆**，不是我杀的） |
| `fast_death` | `death=0`（是自爆，归 `selfkill`） | `death=0`（我没死） |
| `aim` | `aimDeg` p50=−173.8°（炮口背对） | 16 帧命中 ±20° |
| `empty_fire` | `ammoLeft` 取值 ∈ [4,5]，从不为 0 ⟹ 想开火时**确实有子弹** | `ammoLeft` 恒 5 |

## 六、顺手修掉的 3 个归属错（都是"白给奖励/白扣"级）
1. **`still`/`empty_fire` 只在终局帧有值**：终局覆盖是**整块替换 `r`** ⟹ 其余帧的逐帧字段全丢。
   改成 `Object.assign` 增量覆盖。实测：结果行 `still_frames=81/77`、逐帧 `r.still` 为 1 的帧=**81/77**、
   `execStill=true` 的帧=**81/77**，`still(r)` 与 `execStill` **不一致帧 = 0 / 399**。
2. **自爆被同时记 `selfkill` 与 `death`**（−1.5 + −1.0 = −2.5）：现在按事件归属互斥。
3. **对手自爆被记成我方 `kill`**（白拿 +1.0）：`p2_clear_crates_20101` 实测就是这种
   （`deadly` 是 `shooter=对手/victim=对手`），修后该场 `kill` 从 1 → **0**，总奖励 1.8157 → 3.3456 里不再含这笔。

## 七、还没验到的（说实话）
- `hit` / `speed` / `fast_death` 在**评测路径**两场里都拿不到非零：我方 302 帧里**一枪没打出去**
  （`fire_on_frames=265` 但 `_bulletsFired` 不变、`ammoLeft` 恒 5）⟹ 这是"射击帧没落到 commitNode 段"那条老问题，
  与本轮字段补齐无关。**数据源本身是通的**（一次性探针：`deadly shooter=vantage_1/victim=laikaX_1` 命中并被移除）。
- `crate` 的事件通路**已验证可用**（一次性探针：`spawnCrate` 放到我车位置 ⟹ `pickup picker=vantage_1 ctype=0`），
  但两场真实对局里**没有任何箱子**（`item` 段全零）⟹ 实测值只能是 0。
- `speed` 的完整链路（有 `t_min` + 有击杀 + `T_kill≤T_min+Δ`）**一次都没跑过**，标【未验证】。
- 同一场景 `p2_clear_crates_20101` 跑两次：`still_frames` 125 vs 77、`camp` 84 vs 43 ⟹ **评测路径行为不可复现**（待查）。
