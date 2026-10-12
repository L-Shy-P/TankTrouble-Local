# 记录器 v6：`freshRoundData` 强制 expanded 视图（`VERSION 5→6`）· 2026-10-12 晚

> **性质**：父代理 2026-10-12 第二轮裁决后派发的施工报告（前两份：`日期校正与NaN-复核-2026-10-12.md`、`记录器修wpn与rot-2026-10-12.md`）。
> **纪律**：产品代码 0 字节改动（`game_core/` 仍是 `vtmaze.rs` 上轮那两行注释）；未用 `git checkout/restore/HEAD`；未批量杀 node；行尾先验后改（`record_page.js` = 全 CRLF，**且我这次又踩了一次"模板串里不能有反引号"** —— 见 §三-注）。

## 〇、指纹（本轮改前 / 改后，mtime + md5）

| 文件 | 改前 | 改后 | 说明 |
|---|---|---|---|
| `_tools/headless/record_page.js` | `688faf322bea6453d4797f5540a73929` · 19:39 | **`dd219082c1dcd1d0e99899846d2da34d`** · 20:2x | ① `VERSION 5→6` ② `freshRoundData()` 改调 `roundController.getRoundState(true)`（两处改，CRLF 保持 460/0） |
| `docs/…/进展记录/hidden哨兵分析-2026-10-12.md` | `87cc37bdd692b4e65b1a16aef1cd1f24` | **`50560a787218bb7a3b399b3a49521a49`** | ③ 只加注（v6 + 更正 + 旧录制状态） |
| `docs/…/进展记录/hidden哨兵拆分-验收-2026-10-12.md` | `0f5c22ffab7d5337169119c52fb07c04` | **`005faf61b8f9d4a02d87992390245b5e`** | ③ 只加注（同上） |
| `docs/…/进展记录/确定性修复-2026-10-10.md` | `b48c6c6261ad6c41e23e6329be1de77c` | **`d9c6b28e51fcd67817649499f7b16128`** | ④ 给那处**本就过期**的 `record_page.js` 钉加注新 md5（原文未删，CRLF 保持） |
| `_tools/headless/_i4x_premise_getRoundState.js`（新） | — | `e0d7…`（见文件） | 前提实测 v1（同帧 before/after） |
| `_tools/headless/_i4x_premise2_getRoundState.js`（新） | — | `3ba3…`（见文件） | 前提实测 v2（A/B 对拍 + 钩子真实调用计数） |
| `_tools/headless/_i4x_clear_flags.js`（新） | — | `—`（见文件） | 「清 sticky 标志」场景：老/新两条取数路径同帧对照 |
| `_tools/headless/_i4x_pair.js`（新，含 `--crate` / `--clear`） | — | `615b50cc2244b426120f34de3a736a52` | 配对实测（模型真值 vs 老路径 vs 新路径 vs 录制帧） |
| `_tools/headless/_i4x_v6_check.js`（新） | — | `706051a6cf076926a2327e5691b03bca` | 专项守卫（`wpn`/`wpnN`/`col` 变异 + v5 录制兼容性） |
| `_tools/headless/prof/detfix/hsguard_*.jsonl` | v5（19:40） | v6（20:2x，4 次重跑） | `_probe_hs_guard.js` 自建自用产物 |
| 证据 | — | `_i4x_prof/*.json|jsonl`、`_dtmp/ratio_*.log`、`_dtmp/clear_flags.log`、`_dtmp/i4x_v6_check.log`、`_dtmp/reg1200x20_v6.log` | 全部新证据；`_i4_prof/` 原归档 mtime 仍 12:24~12:32 |

## 一、一句话结论

1. **前提成立** ✅ —— `getRoundState(true)`（真 expanded 调用）**无副作用**：同帧 before/after 的 `rn/rc/模型真值计数/wpnKeys/col/projN` 全同；**A/B 对拍**（同一 RNG 带、同一输入，唯一差别 = 处理组每帧多调一次，钩子实测调用 **150 次**）**150 帧全 0 差异**（含 `rng`）。
2. **改了**：`freshRoundData()` 现在走 `gc.roundController.getRoundState(true)`（**强制 expanded**）+ `VERSION 5→6`。
3. 🔴 **但必须先说一个纠正**：**我上一轮那条"`hs.wpn`/`hs.col` 只在 expanded 帧有值"有一半是错的** ——
   - **`hs.col` 从来不受影响**：`collectibleStates` 是 `RoundModel.getRoundState` 的**基本字段**（在 `if (expandedState)` **之前**就填好，`_i4_tmp/_i4_game_roundmodel.js:543-550`）；实测 299 帧"有道具"的帧里，录制 `col` 为 0 的 **0 帧**；还有 178 帧"`wpn=[]` 但 `col=1`"的铁证。
   - **上一轮我报的"39/150、185/300、480~997/1200 空帧 / 33.5% 活跃帧失明"不是 expanded 失明**：那些帧是**模型里确实没有武器**（坦克被打死 → `weapons` 被销毁；或回合间隙）。我拿 `st ∈ {in round, counting down}` 当"应该有武器"，这个代理指标是错的。**配对实测**（模型真值 `Object.keys(model.weapons).length` vs 录制 `hs.wpn`，300/1200 帧）显示：**普通无头局里老路径也从来不空**（见 §四-3）。
   - **失明是真的、但需要触发条件**：`GameController.clearExpandedRoundStateBits()` 被调过之后（= **在线客户端发送 expanded 状态后做的事**），老路径 `gc.getRoundState()` 的 `weaponStates` **恒空**；本地无头局没人调它 ⟹ 从未发生。
4. **收益（触发场景下）**：老路径 **97/118 帧失明（82.2%）→ 新路径 0/118（0%）** ✅（§四-3）；**普通局：两边都是 0 失明**（改动=0 收益，但也不算坏事）。
5. **旧录制**：**v5 录制实测【逐帧仍然相同】⟹ 可继续用**；v4 及更早仍**不能**对拍（`wpn` 形状变了）。

---

## 二、前提验证（`getRoundState(true)` 有没有副作用）

### 2.1 静态（读源码）

| 事实 | 位置 |
|---|---|
| `RoundModel.getRoundState(expandedState)`：① `expandedState |= trapCreated‖weaponCreated‖…`（**只改局部变量**）② 命中缓存就返回 ③ 否则**新建** `RoundState`（读 `tanks/projectiles/collectibles`，expanded 时补 `_getExpandedRoundState`）④ **唯一的写** = `this.cachedRoundState = rs` | `_tools/headless/_i4_tmp/_i4_game_roundmodel.js:513-557`；`_getExpandedRoundState` = `:559-606` |
| 它**不会**碰 `trapCreated/weaponCreated/…` 这些 sticky 标志（只有 `clearExpandedRoundStateBits()` 会清） | `:608-616` |
| `RoundController.getRoundState(expandedState)`：`expandedState |= !this.initialRoundStateSent` ⟹ 传 `true` 就**强制 expanded** | `_i4_tmp/_i4_game_roundcontroller.js:245-248` |
| 🔴 **本轮的坑**：`GameController.getRoundState()` **没有参数、忽略实参**：`getRoundState:function(){ return this.roundController.getRoundState(this.playerAdded); }` ⟹ **`gc.getRoundState(true)` 与 `gc.getRoundState()` 完全等价** | `game_core/js/ce217c9b090cc73ce0e1faa13d20ca15.js`（minified，函数体已抠出核对） |
| 我第一版 v6 就是写成 `gc.getRoundState(true)` ⟹ **实测 no-op**（配对实测：新老路径逐帧相同）；已改成 `gc.roundController.getRoundState(true)` | —— |

### 2.2 实测 A：同一帧 before / after（`_i4x_premise_getRoundState.js`，`_i4x_prof/_i4x_premise.json`）

```
before = { rn:4405, rnCalls:4405, rc:"rc-d375-6", state:"in round",
           raw:{tanks:2,projs:1,weapons:2,traps:0,collectibles:0},
           wpnKeys:[["tank_a",-1,"_bulletsFired|_numBullets|_timeAlive|_triggerPulled"],["tank_b",…]],
           wpnN:2, colN:0, projN:1 }
调 3 次 gc.getRoundState(true)  →  called:true
after  = 与 before 【逐字段全同】（sameFrame.identical = true）
```
⟹ 同一帧、连调 3 次，**游戏状态 / RNG 消费 / 模型真值 / 武器键集合** 全都没变。

### 2.3 实测 B：A/B 对拍（`_i4x_premise2_getRoundState.js`，`_i4x_prof/_i4x_premise2.json`）

做法：控制组录 150 帧；处理组用**同一 RNG 带 + 同一输入计划**回放，唯一差别 = **每帧多调一次**（用 `Match.prototype.open` 打补丁把钩子塞进 `window.__vtAfter`）。

```
hookAfterPump = { calls: 150, err: null }        ← 钩子真的被调了 150 次（v1 探针看到 0 是 CDP 值拷贝的假象）
ctl = { v:5, frames:150, wpnNonEmpty:118 }
trt = { frames:150, wpnNonEmpty:118 }
A/B = { ok:true, hidden:0, pose:0, proj:0, rng:0, op:0, drive:0, time:0, state:0, maxPoseDiff:0 }
```
⟹ **唯一差别 = 多调一次**，结果**逐帧全 0 差异** ⟹ **无副作用** ✅（前提成立）

### 2.4 触发场景：老路径会失明（`_i4x_clear_flags.js`，`_i4x_prof/_i4x_clear_flags.json`）

调一次 `gc.clearExpandedRoundStateBits()`（GameController 那个：同时清 `playerAdded` 与 sticky 标志），同一帧内对照两条路径：

| 时点 | 模型真值 `model.weapons` | 老路径 `gc.getRoundState()` | 新路径 `rc.getRoundState(true)` |
|---|---|---|---|
| 清标志前 | 2 | 2 | 2 |
| **清后同帧** | 2 | **0** ❌ | **2** ✅ |
| 清后 1~6 帧 | 2 | **0** ❌ | **2** ✅ |
| 清后第 36 帧 | 2 | **0** ❌ | **2** ✅ |

⟹ **老路径一旦被清标志就持续失明；新路径不受影响** —— 这就是 v6 改动的**存在意义**（虽然本地无头局没人触发）。

---

## 三、改了什么（带行号）

| # | 行号（改后） | 内容 |
|---|---|---|
| 1 | `:5-13` | `const VERSION = 6;` + 注释写清**为什么升**（sticky 标志被清后老路径 `weaponStates` 恒空；并警示 `gc.getRoundState(true)` 是 no-op、必须调 `roundController`）+ 安全性已实测 |
| 2 | `:71-82` | `freshRoundData()`：`return data(gc.getRoundState())` → **`return data((gc.roundController && gc.roundController.getRoundState) ? gc.roundController.getRoundState(true) : gc.getRoundState())`**（+ 8 行注释：为什么不能写 `gc.getRoundState(true)`、为什么必须 expanded、安全性、`col` 与之无关） |

**⚠️ 注（本轮又踩一次的老坑）**：我第一版把"源码：`getRoundState:function(){…}`"这段**带反引号**写进了页面模板串（`PAGE_SRC`）⟹ 模板串提前闭合、`node --check` 立刻 `SyntaxError: Unexpected identifier 'getRoundState'` ⟹ 已改成无反引号（并把校验脚本升级为"**模板串内反引号数必须为 0**"，见 §四-4）。
`node --check record_page.js` / `record.js` 均 OK；CRLF 保持（460 个 `\r\n`，0 个孤立 LF）。

---

## 四、三条验证的证据 + 「有值帧占比」前后对照

### 4.1 `hs` 守卫

**（a）官方 `_probe_hs_guard.js --frames 300`**（4 次重跑）：

```
run1: CHECKS {…,"e2e_caught":false} => FAIL     ← 失败原因恒为 nudgeResult={err:'no movable tank by n=141'}
run2: CHECKS {…,"e2e_caught":true}  => ALL_PASS
run3: … => ALL_PASS
run4: … => ALL_PASS
```
⟹ **前 6 项（`hs.col`/`hs.rnd` 被改必 FAIL、`hx.tf` 被改必 PASS、可见位姿必 FAIL、legacy 白名单 2 项）4/4 全通过**；
第 7 项 `e2e_caught` 是**探针自身的 flake**：它在**随机迷宫**里给坦克试 8 个 ±3/±1.5 偏移，全落墙里就报 `no movable tank by n=141` —— 与本改动无关（【推断】，但失败原因字符串 + 随机地图足以说明）。

**（b）专项守卫 `_i4x_v6_check.js`**（`_i4x_prof/_i4x_v6_check.json`）：

| 注入 | 结果 | 判定 |
|---|---|---|
| 基线（v6 录 → v6 回放） | `ok=true`，所有计数 0 | ✅ v6 自洽 |
| 改某帧 `hs.wpn[0][2]` 里的 `_bulletsFired=1` → `=2` | `ok=false, hidden=1` | ✅ **`wpn` 是决定性的** |
| 改某帧 `hs.wpnN` 2 → 3 | `ok=false, hidden=1` | ✅ `wpnN` 决定性 |
| **改某帧 `hs.col` 0 → 1** | `ok=false, hidden=1` | ✅ **`col` 也是决定性的** |
| `projs` 里是否还有 `rot` 键 | `rotKeyPresent=false`（条目 = `{id,owner,x,y,type}`） | ✅ 上轮的 `rot` 删除仍生效 |

### 4.2 `20×1200` 回归（v6）

```
$ node _tools/headless/_reg_1200x20.js --runs=20 --frames=1200 --dir=/tmp/vt_reg1200
{"done":true,"pass":20,"fail":0,"frames":1200,"runs":20,"wallMs":205222}
```
20 行逐次 `"ok":true`，`op/pose/proj/time/hidden/drive/rng/state` 与 `maxPoseDiff` **全 0**（日志 `_dtmp/reg1200x20_v6.log`）✅

### 4.3 ★「有值帧占比」前后对照（配对实测：模型真值 vs 两条取数路径 vs 录制帧）

探针 `_tools/headless/_i4x_pair.js`：**同一帧内**取 ① 模型真值 `Object.keys(model.weapons).length` ② 老路径 `gc.getRoundState()`（= v5 行为）③ 新路径 `rc.getRoundState(true)` ④ 录制帧里的 `hs.wpn`（**每次采样前清 `cachedRoundState`**，否则会读到过期缓存 —— 这是我自己先踩的一个探针坑）。

| 场景 | 模型里有武器的帧 | **老路径失明**（= 老路径空但模型有） | **新路径/录制失明** |
|---|---|---|---|
| **普通无头局**（300 帧 + 1 个真 crate） | 90 | **0（0%）** | **0（0%）** |
| **触发场景**：第 20 帧调一次 `gc.clearExpandedRoundStateBits()`（300 帧 + 1 个真 crate） | 118 | **97（82.2%）** ❌ | **0（0%）** ✅ |

触发场景的逐帧样例（清标志之后）：
```
{ mv:1, mc:1, mt:1, nonExp:0, exp:1, nonExpC:1, expC:1, st:'in round' }   ← 模型有 1 件武器、1 个道具
                                                          ↑ 老路径武器空（失明）  ↑ 新路径=1 ✅
                                                            ↑ 道具（col）两条路径都=1 ⟹ col 不受 expanded 影响
```
⟹ **结论**：**改动在"标志被清"的触发场景下把失明从 82.2% 降到 0%**；**普通局两边都是 0**（本地无头局没人调 `clearExpandedRoundStateBits()`，所以 v5→v6 在这些局里是"零可见差异"）。
**我上一轮报的 33.5% 等数字作废**（那是"模型里没武器"的合法空，不是失明）—— 更正已写进两份 `hidden` 文档。

### 4.4 附加：本轮起探针纪律

`record_page.js` 的模板串内**不允许出现反引号**（我这次又踩一次）⟹ 校验脚本已加一条：
```python
i=t.index('const PAGE_SRC = `'); j=t.index('\n`;', i); assert t[i:j].count('`')==0
```
（本轮用它抓出了自己刚写进去的 2 个反引号）

---

## 五、旧录制实测状态（v5 / v4）

| 录制版本 | 读取 | 回放 | **与新(v6)回放对拍** | 结论 |
|---|---|---|---|---|
| **v5**（`_i4x_prof/v5_sample.jsonl`，原 `v5_rec.jsonl`，150 帧） | ✅ | ✅ `v5old_replay_ok=true` | **✅ `ok=true`、hidden=0、其余全 0** | **仍可当基线**（因为 v5→v6 的差异在本地局不可达；实测逐帧相同） |
| **v4**（`_i4x_prof/v4_sample.jsonl` = 原 `prof/detfix/split_check.jsonl`） | ✅ | ✅ | ❌ `hidden=200/200` 帧全 FAIL，其余计数全 0（例子：`wpn:[["tank_a",-1,5,0,2.017]]` vs `wpn:[["tank_a",-1,"_bulletsFired=0,…"]]`） | **不能当基线**（`wpn` 形状在 v4→v5 就变了） |
| v1（无 `hs`） | ✅ | ✅ | ✅（`hs` 比较被跳过；模拟验证：任一侧删 `hs/hx` → 仍 `ok`） | 仍可对可见量 |

⟹ **`VERSION 5→6` 的实际代价 = 0 条旧录制作废**（v5 实测仍逐帧相同）；真正作废的是 v4 及更早（那些在上一次 v4→v5 时就已经不能对拍了）。

---

## 六、未解决 / 遗留

1. ⚠️ **"失明"在本地无头局不可达**（`playerAdded=true` + sticky 标志长期为真 ⟹ 老路径本来就带 expanded 字段）⟹ **本次改动是"防未来/防在线路径"的稳健性改动，不是当前可观测 bug 的修复**。若父代理要"最小 diff"，一行可回退：`freshRoundData` 改回 `data(gc.getRoundState())` + `VERSION` 回 5（改前 md5 `688faf322bea6453d4797f5540a73929` 已留档）。
   **我的建议：保留**（成本已付、零回归、语义更明确；且在线路径确实会调 `clearExpandedRoundStateBits`）。
2. ⚠️ **`_probe_hs_guard.js` 的第 7 项 `e2e_caught` 是 flake**：它在随机迷宫里试 8 个偏移挪坦克，全落墙里就失败（实测 4 次里 1 次）。建议把 nudge 改成"用 `maze.getRandomUnusedPosition` 找一个真的空位"或"失败时记为 SKIP 而不是 FAIL"（**未改**：它是别人写的守卫脚本）。
3. ℹ️ **上一轮的两处判断已更正**（`col` 不受 expanded 影响；"空 wpn 帧"= 模型没武器）—— 更正写进本报告 §一-3 + 两份 `hidden` 文档批注。
4. ℹ️ 我 `pair` 探针的第一版读到了**过期的 `cachedRoundState`**（`getRoundState(true)` 命中同一帧里更早建好的 expanded 缓存），导致 `blindWpn_expanded0=44` 的假象；已在采样前清缓存修正。**这条值得进探针纪律**：*读 expanded 视图前必须先清 `model.cachedRoundState`*（产品里的 `freshRoundData()` 本来就是这么做的）。
5. ℹ️ **别的代理的进程仍在跑**（`_baseline_multiai_vant2_missile.js --mode record`，18:51 起、持有 127.0.0.1:8000 的 python）—— 我只读不杀；我的 20×1200 与它共存跑完（205 s）✓。
6. ✅ 本轮**产品代码 0 字节改动**；`_i4_prof/` 原归档未动；`/tmp/vt_reg1200` 与我这轮的 `vt-chrome-*` 已清（见交付消息）。

*（本报告由清理/修复子代理写于 2026-10-12 晚；证据：`_i4x_prof/_i4x_premise.json`、`_i4x_premise2.json`、`_i4x_clear_flags.json`、`_i4x_pair_300_crate.json`、`_i4x_v6_check.json`、`_dtmp/ratio_*.log`、`_dtmp/hs_guard_v6.log`、`_dtmp/reg1200x20_v6.log`。）*
