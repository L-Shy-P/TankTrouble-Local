---

## 三、同类字段扫描（`_tools/headless/` 里「读了 schema 不存在的键」）

**判据**：以 `game_core/js/886d0eb67c4552b1a7ded075a1e79dba.js` 的 `MessageSchemas` 为**唯一 schema 依据**
（它同时就是 `getRoundState()` 产出的键集合 —— 实测印证见 §2.1：弹的键、坦克的键与 schema 逐字一致）。

| 结构 | schema 键 | 扫描到的读取点 | 判定 |
|---|---|---|---|
| **`projectileStates`** | `id, playerId, type, x, y, speedX, speedY` | `match.js:116`（`rot`） | 🔴 **本轮已修**（§二） |
| | | `record_page.js:108`（`rot: p.rotation`） | ⚠️ **未改**：录制里 `projs[].rot` 恒 `undefined`（JSON 丢键，已有录制为证）。其 md5 被 3 份文档钉住（`hidden哨兵分析…:21` 等），且带 `VERSION` 版本纪律 ⟹ 建议**单独一轮**（要改就同时决定是否补 `rot` 派生 + 升 VERSION） |
| | | `_ev_match.js:116`（同款） | ⚠️ 冻结证据副本，未改 |
| | | 🔴 **`_i4_probe_spec_1_4c.js:105`：`vx: this.sub(p.vx)`** | **新发现（同类第 3 处）**：schema 里**没有 `vx`**（是 `speedX`）⟹ `p.vx = undefined`；该文件的 `sub()` 对 `undefined` **显式返回 `null`** ⟹ **`vx` 恒为 `null`**（同一行的 `vy: this.sub(p.speedY)` 却是**对的**）。**后果【推断】**：`:247` 的反弹判据 `dv = Math.hypot(vx 差, vy 差)` 实际只用 `vy` 分量，而正打（head-on）反弹主要变的是 **vx 符号** ⟹ 可能**漏检 flip**；`inV/outV` 打印出的 vx 是 `null`。**建议复核 1-4 报告里引用 1_4c 的数字**。对照：同族探针 `_i4_probe_spec_1_4b.js:118` 写的是 `p.speedX` ✓（一个改对一个没改） |
| **`tankStates`** | `playerId, x, y, forward, back, rotation, left, right, fireDown, locked` | `match.js:110-114`、`record_page.js:89-95`、`_baseline_multiai_vant2.js:29-33`、`…missile.js:29-33`、`_probe_phase0_cfg.js:53` | ✅ **全部命中 schema** |
| **`trapStates`** | `id, playerId, type, x, y, speedX, speedY, fieldsJSON` | `_probe_adapter_2_1_getters.js:84`（`.length`） | ✅ 无字段级读取 ⟹ 无发现 |
| **`zoneStates`** | `id, type, tiles[{x,y}], fieldsJSON` | `_probe_adapter_2_1_getters.js:86`（`.length`）；`_i4_probe_spec_1_4*.js` 的 `zones()` 走 `gc.getZones()` **真对象** | ✅ 无发现 |
| **`collectibleStates`**（顺带） | `id, type, x, y, rotation` | `_i4_probe_spec_1_4b/c/d/f.js`（`id/type/x/y`） | ✅ 命中（`rotation` 是**道具**的，不是弹的） |
| **`weaponStates`**（顺带） | `id, playerId, type, **fieldsJSON**` | `match.js:118-121`、`record_page.js:206-210`、`_i4_probe_spec_1_4b.js:104-106`、`1_4c:97-99`、`1_4d:56-58`、`1_4e:27` | ⚠️ **亚 schema 坑**：`fieldsJSON` 的内层键**按武器种类不同**（bundle 里逐个武器类实测）：`BULLET{_numBullets,_triggerPulled,_bulletsFired,_timeAlive}` / `DOUBLE_BARREL{_numBullets,_triggerPulled,_leftBarrel}` / `SHOTGUN{_numBullets,_triggerPulled,_reloadTime}` / `LASER{_fired,_timeSinceFire}` / `HOMING{_launched,_activationTime}` / `MINE{_numMines,_triggerPulled}` / `GATLING{_numBullets,_triggerPulled,_weaponCharge,_timeSinceFire,_newBurst}` ⟹ **非 BULLET 弹种的 `bullets/fired/alive`（或 `num/mines/launched`）会给 `undefined`**。`record_page.js` 的 `wpn` 是回放对拍的**决定性哨兵**，同局两种武器时它只对 BULLET 有意义。**未改**（改了就变录制格式）⟹ 建议单独定 |
| 好先例 | —— | `_probe_phase0_cfg.js:54`：`Object.keys(d.weaponStates[0])` **先把实际键打出来** | ✅ 建议做成探针纪律 |

**覆盖说明**：`_tools/headless/**`（排除 `_ev_pg/` `_i4_tmp/` `_dtmp/` 三个非脚本目录）里凡出现
`tankStates|projectileStates|trapStates|zoneStates|collectibleStates|weaponStates|upgradeStates|counterStates` 的读取点都逐个核过；
`upgradeStates` 的读取（`1_4b:91`/`1_4c:84`/`1_4d:56`/`1_4e:27`：`playerId/type/id + f._lifetime`）与 `UpgradeState{id,playerId,type,fieldsJSON}` 及 upgrade 内层字段一致 ✅。

---

## 四、无法判断 / 遗留（**请父代理逐条裁**）

1. 🔴 **`game_core/rust/vantage_core/src/vtmaze.rs:3` 旧名引用未改**（全仓最后一处"按文件名的代码引用"）
   —— 该行：`设计依据（2026-10-13 批准，见 docs/.../1-2④施工-第3轮-2026-10-13.md §一）`。
   **按父指令「别碰 `game_core/` 里除那一处注释以外的任何东西」我停手上报。** 修法 = 1 行注释改成 `-2026-10-12`；
   代价 = `.rs` mtime 变化 ⟹ 下次 build 触发 `vantage_core` 重编（注释不影响代码生成，wasm 字节预期不变，但会扰动正在跑的阶段 2-1）。
   被引文档 `1-2④施工-第3轮-2026-10-12.md:2` 已留旧名注记 ⟹ 按旧名仍能检索到，断链不致命。
2. ⚠️ **4 行《2026-10-13 实测更正｜原文保留作对照》引文标记未改**（`1-2④施工-2026-10-12.md:34,35,72,76`）——
   与 `AGENTS.md:171` + `权威版-2026-10-07.md:1788` **逐字对应**；要改必须三处同改（其中 2 处是权威文档）⟹ 需要一句指示。
3. ⚠️ **代码注释里的日期戳 `2026-10-15`（正在被另一个代理写）**：`game_core/js/vantage_tree.js:802`（`TREE_VERSION='v175'` 那行）与
   `game_core/rust/diff_tree_low_eval_frames.js:11` 现在都写 `// 2026-10-15 …`。
   **系统时间实测 = `Mon Oct 12 19:2x 2026`**（`date`）⟹ 这两处**也是未来日期**。**未改**（非文件引用；且正在活跃写入，改了就白改）。
4. 🔴 **本轮回合进行中又冒出一个未来日期文件**：`docs/Vantage躲弹实现/02-实现/进展记录/阶段2-1-adapter取数-2026-10-12.md（原名 `…-2026-10-15.md`）`
   （19754 B，mtime **2026-10-12 19:21**，全仓 0 引用）。**我没改它**（怕与正在写它的代理打架）。
   ⟹ **"未来日期"还在持续产生**（10-13/14 → **15**）；`.workbuddy/memory/2026-10-11.md:28` 里"施工侧 14 份未改"的记录也已过期。
   **建议**：要么让写它的代理自己改，要么给下一轮一张新清单。
5. ⚠️ **三处同类字段未改**：`record_page.js:108`（rot）/ `_ev_match.js:116` / **`_i4_probe_spec_1_4c.js:105`（vx 恒 null）**（理由见 §三）；
   其中 `1_4c` 的 `vx` **可能已经影响 `1-4规格核查与实测-2026-10-12.md` 引用的反弹数字**（【推断】，未复跑）⟹ 建议 1-4 执笔人核一遍。
6. ℹ️ 三份交换文档的"暂未改名"历史表述：**只加了「已执行」补记**（不改别人的结论）。若执笔侧要重写该段，以本报告 §1.1 清单为准。
7. ℹ️ 行尾：2 份原 CRLF 已还原（§〇）；全 `docs/` 扫过，未发现本轮碰过的文件有"孤立 CR"之类异常（全仓只有 1 份含孤立 CR，不是本轮文件）。
8. ℹ️ 本轮**没跑** 600 帧的 `_baseline_multiai_vant2*.js --mode verify`：那两份基线依赖 `TREE_VERSION`，而**同时有别的代理**在改
   `vantage_tree.js`（v174→v175），此刻跑出的 FAIL/PASS 归因不清。改过的两处都只是**注释里的文档名**，语法检查 + `match.js` 冒烟已覆盖。

---

*（本报告由清理/修复子代理写于 2026-10-12；证据日志在 `_tools/headless/_dtmp/`：`rename_dryrun.txt` / `rename_apply.log` / `rot_probe_before.log` / `rot_probe_after.log` / `match_smoke_after2.log` / `fingerprint_before.txt` / `fingerprint_table.txt` / `eol_check.py`）*
