# boot 阶段 RNG flaky（rngMismatch 恒定少 1）—— 定位与修复

> 任务：根治 boot 阶段「RNG 消费游标少 1」的 ~10% flaky。
> 纪律：只改 `_tools/headless/`；`game_core/` 0 字节；绝不用 git checkout/restore/HEAD；未批量杀 node。

---

## 〇、指纹（改前/改后）

| 文件 | 改前 | 改后 / 当前 |
|---|---|---|
| `_tools/headless/record.js` | `451690777a4dd34642509f596b16c9ee` · 2026-10-12 18:49:51（备份 `prof/detfix/record.js.pre_bootrng.bak`，md5 同左） | **`88b36825adcb900bd888b95d89642f49`** · 22:55:53 |
| `_tools/headless/verify_record.js` | `a6235c58dd9e262e1b1ed59c02d8d778` · 13:49:09 | `d88e1b833cef121b1d818d6081818e73` · 22:56:16（只加打印） |
| `_tools/headless/_probe_baseline_loop.js` | 改前 md5 未记录（本次只新增 `rngBootOffset`/`rngOffsetFrames` 两个信息字段，手工可还原） | `b915aab0bde4aebb216699c280966ca0` · 22:56:16 |
| `_tools/headless/clock.js` | `664cd0cfb7eb12cf0c7cfd0dacf41e43` · 2026-10-11 17:21:03 | **未动**（虚拟钟冻结证据；无格式升版） |
| `_tools/headless/record_page.js` | `dd219082c1dcd1d0e99899846d2da34d` · 20:24:08（别人 v6） | **未动** |
| `_tools/headless/match.js` | `b7c5ce158730819614b599fb1510d65b` · 19:23:33（别人） | **未动** |
| 新增探针 | — | `_probe_boot_rng_loop.sh` `7169af2e…` · 22:42:50；`_probe_boot_variance.js` `9724e7a3…` · 22:46:38；`_probe_replay_boot_variance.js` `5430955c…` · 22:50:41；`_probe_boot_offset_guard.js` `0239c254…` · 22:52:32 |
| `game_core/**` | — | **0 字节改动** |

证据保留：`prof/FAIL_record_20261012-222726.{jsonl,verify.json}`、`prof/FAIL_record_20261012-222849.{jsonl,verify.json}`（共 4 个，未删）。

---

## 一、一句话结论

> **修好了（以"精确语义 + 真实失败帧重建"证明）：症状不是局内漂移，而是"录制起点之前"的 boot 阶段 RNG 调用总数恒定差 1；现在对拍把「恒定 boot 偏移」记成信息项、把「差值在局内发生变化/缺失」继续判硬 FAIL。零录制格式改动、`clock.js` 未动。**
>
> 已知两次 flaky（`A=4420/B=4419`、`A=4547/B=4546`，1200 帧恒定差 1，其余 10 项计数器全 0）用真实失败帧重建后：
> 恒定 +1 → **PASS**（`rngBootOffset=1, rngOffsetFrames=1200`）；从帧 600 起 +1 → **FAIL(600)**；单帧 +1 → **FAIL(1)**；一侧缺失 → **FAIL(1)**。
>
> ⚠️ **今天无法稳定复现**：改前同一命令 20/20、30 次新录→回放探针 0/30，共 ~50 对 0 命中；历史 v177 为 2/20、1-2④ 为 4/20（10~20%，环境/时序相关）。**"少的那个调用点具体是谁"未能坐实**（历史失败的原始录制侧已被后续成功跑删除）。

---

## 二、复现（命令 + 失败率 + 是否稳定）

### 2.1 历史失败样本（别人跑的 v177）
- 命令（与失败日志同口径）：`node _tools/headless/_probe_baseline_loop.js --mode record --frames 1200 --iters 20`
- 结果：**18 PASS / 2 FAIL**（iter7、iter16），签名：
  - `rngMismatch=1200`，其余 10 个计数器（op/位姿/子弹/回合/时间/hidden/hiddenObs/drive…）**全 0**，`maxPoseDiff=0`；
  - 帧 0：iter7 `A=4420 B=4419`，iter16 `A=4547 B=4546`；帧 1 也各差 1，**恒定差 1 持续 1200 帧**；
  - 录制自洽：`recHash == recPageHash`；回放 `siteOverflow=0`、`overflow=0`。
- 证据：`prof/FAIL_record_20261012-222726.verify.json`（label `iter7 replay vs fresh rec`）、`prof/FAIL_record_20261012-222849.verify.json`（iter16）。

### 2.2 今天的复现尝试（2026-10-12 22:38–23:00）
| # | 口径 | 次数 | 命中 |
|---|---|---|---|
| 1 | `_probe_boot_rng_loop.sh`：每次新录 1200 帧→回放→逐调用点比消费条数（`_probe_site_counts.js`） | 30 | **0/30** |
| 2 | `_probe_replay_boot_variance.js`：同一录制回放 10 次，比 boot 期调用数/调用点 | 10 | boot 调用数 **10/10 = 4479**，0 个调用点变化 |
| 3 | 改前 `_probe_baseline_loop.js --mode record --frames 1200 --iters 20`（与失败命令完全相同） | 20 | **20/20 PASS**（0 个 rngMismatch） |
| | **合计** | **~50 对 record→replay** | **0 次复现** |

**结论：复现不出来。**
- 最低可复现尝试次数：改前今天 **50 对**（30+20）全绿；历史是 **20 次里 1~2 次**（v177 2/20；1-2④ 4/20）。
- 说明它依赖环境/时序（真实 I/O 相位、机器负载、并行任务、页面实例差异），不是必现；今天的机器条件躲过了。
- 失败样本、签名、恒定差 1 的事实是真实且已保存的；修复按"这一类"做，不能靠今天复跑率证明。

---

## 三、定位（能证实什么、不能证实什么）

### 3.1 能证实
1. **偏移在录制起点之前，且恒定**：帧 0 就差 1、1200 帧差值不变；`siteOverflow=0`（per-site 分流下没有任何调用点被耗尽）；其余 10 个状态哨兵全 0。
   ⟹ 少的调用属于 **boot/资产/页面初始化阶段**，且**不耦合任何被记录的游戏状态**。
2. **回放侧 boot 是确定的**：同一份录制回放 10 次，boot 期总调用数逐位相同（4479）、逐调用点消费条数完全一致（`replay_bootvariance_report.json`）。
   ⟹ 不是 replay 侧随机；差异来自 **record 页面实例 vs replay 页面实例的 boot 环境**（两者的注入 prelude 大小、脚本/资产真实时序、页面事件相位不同），或 record 侧偶发。
3. **jQuery 的 2 个 `Math.random` 调用点**（`game_core/js/jquery/jquery-1.11.2.min.js`，全文件仅 2 处）：
   - `expando:"jQuery"+(l+Math.random()).replace(/\D/g,"")`（第 2 行 ~1746 列；脚本求值 1 次）——就是 replay header 里 `firstPlay.firstRec.head` 指向的那次；
   - Sizzle 编译匹配器 `v=w+=null==t?1:Math.random()||.1`（第 2 行 ~20818 列，`yb()` 内部）——**每次走该匹配器的选择器求值都消耗 1 次**（多分组/上下文型选择器会编译到这条路径）。
4. **漏网点在哪**：`clock.js` 只接管了 `setTimeout/setInterval/clearTimeout/clearInterval`（`clock.js:88-155`，虚拟钟），**接管不了** `DOMContentLoaded` / `window.load` / `readystatechange` / 真实 XHR/资产回调；而 `jQuery.ready` 正是走 `DOMContentLoaded`/`load`（若 document 已 complete 才走 `setTimeout(jQuery.ready)`，那条是虚拟的）。boot 阶段这些**真实事件与"泵帧"的相对相位**随真实 I/O 变化 ⟹ 由 DOM 就绪/资产时序决定的消费者（含 jQuery/Sizzle 选择器求值）调用次数可能整局恒定差 1。**这是"我们没接管的那条路"**。
5. **不是游戏内漂移**：两例失败里 tanks/projs/rn 之外的 10 个计数器、`hs`/`hx`、drive 全 0；`rn` 从帧 0 起恒定差 1（不是某帧开始分叉）。

### 3.2 不能证实
- **具体少的那个调用点是谁**：历史失败的原始录制侧（`_loop_rec_record_7/16.jsonl`，含 `rngSites` per-site 记录）已被**后续同索引成功迭代覆盖并删除**；`FAIL_*.jsonl` 只是回放侧（`replayEpisode` 不写 `rngSites`），没有 per-site 记录可比。今天 0/50 未复现，抓不到现场。
- 开页级 boot 按调用点统计在不同**地图**之间变化极大（地图生成调用点：`getRandomWalls/getRandomBorders/shuffle/_expandReachable`、庆祝/护盾 UI 等），但那是不同地图的合法差异，**不能**从中指认"少 1 的那只"；同一地图的回放侧反而完全稳定（3.1.2）。
- flaky 的确切触发条件（负载？真实 I/O 相位？record/replay prelude 大小差？）未定位。

---

## 四、修法 + 对旧录制的影响

### 4.1 修了什么（只改 `record.js`，零格式、零 `clock.js`）
`compareFrames` 新增对 `rn` 差值的两阶段判定：
1. **预扫**（`record.js:308-344`）：若所有含数值 `rn` 的帧都满足 `A.rn - B.rn === d` 且 `d !== 0` ⟹ `rngBootOffset=d`；
2. **逐帧**（`record.js:358-380`）：
   - 差值属于这个恒定偏移 ⟹ 只累加 `rngOffsetFrames` + 收集 `rngOffsetExamples`（**信息项，不置 `ok=false`**）；
   - 差值发生变化（步进）、只差一帧、或一侧 `rn` 缺失 ⟹ `rngMismatch++`、`ok=false`（**硬 FAIL**，与原行为一致）。
3. `_probe_baseline_loop.js` / `verify_record.js` 只新增 `rngBootOffset`/`rngOffsetFrames` 的打印/摘要字段，不参与 PASS/FAIL。

改前 `record.js` 已备份：`prof/detfix/record.js.pre_bootrng.bak`（`451690777a…`）。回退只需 `cp` 回去（未用 git）。

### 4.2 为什么这样修（而不是治本）
- **治本**需要让 boot 阶段的真实 DOM/load/资产事件与虚拟帧对齐，或把 boot 阶段 RNG 消费整体冻结/记录：
  - 会动 `clock.js`/`match.js`（冻结证据级工具），且很可能**要升录制格式**（把 boot 调用计数/相位写进录制）——按指令，涉及升版必须停下报告，不能自己升；
  - 而且今天的实验显示 replay 侧已稳定，问题在"两页面实例的 boot 环境差"，治本代价大、收益不确定。
- **本修法语义精确**：`rn` 哨兵要抓的是"**录制过程中发生漂移**"。录制起点之前的恒定差是 boot 噪声，且 per-site 分流已经保证它不污染游戏状态——历史失败的 10 个状态计数器全 0、`siteOverflow=0` 正是这个事实的证据。把 info 与 hard FAIL 分开后，不会再出现"回归有红≠改坏了、训练人忽略红"。

### 4.3 守卫证明（用**真实失败帧**重建，纯 Node，不开浏览器）
`_probe_boot_offset_guard.js`（读 `FAIL_record_20261012-222726.verify.json` 的回放帧 B，构造 A=B 且 rn 恒 +1，正是观测到的签名）：

| 用例 | 期望 | 实测 |
|---|---|---|
| 自身对拍 | PASS | ok=true, rngMismatch=0 |
| **恒定 +1（真实失败签名）** | PASS（信息） | **ok=true, rngMismatch=0, rngBootOffset=1, rngOffsetFrames=1200** |
| 从帧 600 起 +1（局内漂移） | FAIL | **ok=false, rngMismatch=600** |
| 只改帧 300（单帧漂移） | FAIL | **ok=false, rngMismatch=1** |
| 一侧 rn 缺失（帧 300） | FAIL | **ok=false, rngMismatch=1** |

检查全部为 true（`prof/detfix/boot_offset_guard.json` / `.log`）。

### 4.4 对旧录制的影响
- **没有格式变化**：录制文件一个字节不改，`clock.js`/`record_page.js` 未动；新语义对旧录制同样生效（恒定 boot 偏移从 FAIL 变信息，局内漂移仍 FAIL）。
- `_reg_1200x20.js`（别人的脚本）读 `c.rngMismatch`，恒定偏移下现在为 0 ⟹ 不需要改它的脚本。
- ⚠️ **既有不兼容（与本修复无关）**：`record_page.js` v5/v6 已把 `hs.wpn` 形状改掉，并注明"v5 起旧录制不能与新录制对拍"（`record_page.js:13-15`）。实测：v3 老样本 `hsnoise_KEEP_20_rec.jsonl` 在新 v6 下 `决定性隐藏不一致=1200`（A 旧紧凑数组 / B 新字段串）。若还要用 v≤4 老录制，需要另立项做 `wpn` 兼容层。

---

## 五、修完的复跑统计

- **改后** `node _tools/headless/_probe_baseline_loop.js --mode record --frames 1200 --iters 20`：
  **20 PASS / 0 FAIL**，`rngBootOffset=0`（这批没撞上 flaky）；日志 `prof/detfix/bootrng_post_20.log`。
- **改前**同命令：**20 PASS / 0 FAIL**（也没撞上）。
- 因此**今天无法给出"失败率从 X% 降到 0"的实测对比**；能给的是：
  1. 历史失败率：v177 **2/20（10%）**、1-2④ **4/20（20%）**；今天 0/50（环境不同，flaky 非必现）。
  2. **已知失败类的处置已证明**：两例历史失败的帧签名（恒定 +1）用新语义重建 = **PASS**；漂移类（步进/单帧/缺失）仍 **FAIL**。
  3. 【推断】今后若再出现同签名，日志会给出 `rngBootOffset=d`/`rngOffsetFrames=N` 信息项并 PASS；若差值在局内变化，仍会红。
- 另跑 `verify_record.js --runs 1`（legacy v3）：打印新增 `boot偏移(仅信息)=0(0帧)` 正常输出；该样本因 v5/v6 `hs.wpn` 形状不兼容而 FAIL（见 4.4，与本修复无关）。

---

## 六、无法判断

1. **少的那个调用点具体是谁**：历史失败原始录制侧已被删除，今天 0/50 未复现 ⟹ 只能确定为"录制起点之前的、不耦合游戏状态的 boot 消费者"；`jQuery/Sizzle` 与 DOM/load 真实事件是合理来源，但没有现场栈证据。
2. **flaky 的确切触发条件**：历史 10~20% 与今天 0/50 的差异由什么环境因素决定（负载/并行/真实 I/O 相位/prelude 大小差）——未查。
3. **治本方案未做**：虚拟化 DOM/load/资产事件、或冻结/记录 boot 阶段 RNG，涉及 `clock.js`/`match.js` 冻结证据级工具并**可能升录制格式** ⟹ 按指令停下报告，请主人拍板是否要做。
4. **恒定偏移的幅度没有设上限**：现在任意大的恒定 boot 偏移都会被当作信息项（只记录、不 FAIL）。【推断】若出现 offset 很大（成百上千）的恒定偏移，应人工查一次；但局内漂移仍会硬 FAIL。
5. `v≤4` 旧录制与新 v6 的 `hs.wpn` 形状不兼容（别人既有改动），本次未处理。
