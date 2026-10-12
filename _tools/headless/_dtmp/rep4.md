---

## 二、活②：`match.js` 的 `projs[].rot` 恒 NaN

### 2.1 核实（**实测**，不是照抄）

- **探针**：`_tools/headless/_rot_probe.js`（本轮新建，只读产品代码；用 `Match` 真开一局、真开火、逐帧读 `roundState`）
- **改前证据**：`_tools/headless/_dtmp/rot_probe_before.log`

```json
"raw": { "keys": ["id","playerId","speedX","speedY","type","x","y"],
         "hasRotation": false, "rotationRaw": "undefined" },
"tankKeys": ["back","fireDown","forward","left","locked","playerId","right","rotation","x","y"],
"snapshotProj": {"id":"b-7dac-9","owner":"tank_a","x":12.62…,"y":21.34…,"rot":null,"type":-1},
"snapshotJSON": "…,\"rot\":null,…",
"recompute": { "expr":"+(+(p.rotation)).toFixed(4)", "result_isNaN": true, "result":"NaN" }
```

⟹ **确认**：`projectileStates` 的序列化 schema（`game_core/js/886d0eb67c4552b1a7ded075a1e79dba.js`：
`projectileStates:[{id:'string',playerId:'string',type:'int8',x:'float32',y:'float32',speedX:'float32',speedY:'float32'}]`）**没有 `rotation`**；
`match.js:116` 读 `p.rotation` ⟹ `undefined` ⟹ `+(+undefined).toFixed(4)` = **`NaN`**。
（对照：`tankStates` 的 schema **确实有 `rotation`** ⟹ `match.js:114` 那行的 `rot` 是好的。**弹没有、坦克有**。）

**旁证（已有产物里就摆着）**：`_tools/headless/prof/base400.jsonl` 的帧记录里 `projs` 条目是
`{"id":"b-9878-10","owner":"tank_b","x":15.088…,"y":27.171…,"type":-1}` —— **根本没有 `rot` 键**。
根因：`record_page.js:108` 写的是 `rot: p.rotation`（`undefined`）⟹ `JSON.stringify` **直接丢键**。

**⚠️ 比"NaN"更隐蔽的一层（本轮新查明）**：`NaN` 一过 JSON 边界（CDP / `JSON.stringify`）就变 **`null`**；谁再 `+rot` 强转 → **`0`**
—— 一个**看着完全正常的数**（"朝向 +x"）。也就是说这个字段不只是"恒 NaN"，是**恒为垃圾值、且会伪装成合法值**。

### 2.2 消费方 grep（改法的依据）

| 候选消费方 | 实际读法 | 结论 |
|---|---|---|
| `match.js:565`（CLI 简报） | `projs: s.projectiles.length` | 只取**条数** |
| `_tools/headless/demo_shot.js:23` | `projectiles: s.projectiles.length` | 只取**条数** |
| `_tools/headless/record.js:392` | `JSON.stringify(a.projs) !== JSON.stringify(b.projs)` 整串比 | rot 两边都是 `null` ⟹ 恒等；对拍实际只覆盖 id/x/y/type |
| `_baseline_multiai_vant2.js:33`、`…missile.js:50` | `.map(p => ({id, x, y}))` | **本来就没取 rot**（先例） |
| `_i3_*` / `_i4_*` 探针的 `bullets()` | 自己另写映射，读 `p.speedX/speedY` | 不读 rot |
| `docs/…/05-挖掘-第二轮/W4-无头环境能力.md:345` | 把 `projs` 记为简报字段 | 不涉及 rot |

⟹ **`snapshot().projectiles[*].rot` 全仓零消费方。**

### 2.3 改法：**(a) 删掉**（并说明为什么不是 atan2）

1. **无消费方** ⟹ 父指令 (b)「有人要用弹的朝向」的前提不成立。
2. **改 atan2 有真回归风险**：会给所有快照/录制**新增一个字段**，而 `record.js:392` 是**整串 JSON 比**；该项目已反复踩过"一边有一边没有 = 逐帧假 FAIL"（见 `record.js:362-390` 的三处注释）⟹ 旧录制 vs 新回放会开始刷 `projMismatch`。
3. **朝向的原料没丢**：`speedX`/`speedY` 就在 schema 里，谁要谁算。我在注释里写清了**两套约定**（实测对照见 `_dtmp/rot_probe_*.log` 的 `track`/`motion`）：

   | 用途 | 公式 | 同一颗弹实测 |
   |---|---|---|
   | **速度方向**（与 `x/y` 同一坐标系，y 向下） | `Math.atan2(speedY, speedX)` | `-2.0668` rad ✓ 与逐帧位移反推 `atan2(Δy,Δx)` 一致 |
   | **与 `tankStates[].rotation` 同约定**（forward = `(sin r, −cos r)`） | `Math.atan2(speedX, −speedY)` | `-0.4960` rad |

   🔴 **架构 AI 建议的 `atan2(speedY, speedX)` 与坦克 `rotation` 不是同一套约定** —— 将来拿它跟坦克朝向比会造新的坑（本项目"按名字推语义"的老坑）。

### 2.4 改动 + 验证（含**反向验证**）

**改动**（1 处：`_tools/headless/match.js:115-116`，行尾仍 CRLF）：把
`return { id: p.id, owner: p.playerId, x: p.x, y: p.y, rot: +(+p.rotation).toFixed(4), type: p.type };`
改为 `return { id: p.id, owner: p.playerId, x: p.x, y: p.y, type: p.type };`，并在其上加了 8 行注释（说明 schema 没有 `rotation`、NaN→null→0 的降级链、两套 atan2 约定）。
`md5 43a8ec65203f7f9c9654932ce17f6f63 → b7c5ce158730819614b599fb1510d65b`（CRLF 594 个，保持）

**反向验证（纪律③：证明"改前会错、改后才对"）**

| 口径 | 改前 `_dtmp/rot_probe_before.log` | 改后 `_dtmp/rot_probe_after.log` |
|---|---|---|
| 快照 `projectiles[0]` | `{id, owner, x, y, rot: null, type}` | `{id, owner, x, y, type}`（**无 rot 键**） |
| 快照 JSON | `…,"rot":null,…` | `…,"type":-1}` |
| 旧表达式 `+(+p.rotation).toFixed(4)` | `NaN`（`result_isNaN: true`） | ——（已删） |
| `projectileStates[0]` 原始键 | 无 `rotation` | 无 `rotation`（**schema 事实**） |

**其它验证**：`node --check _tools/headless/match.js → OK`；`node _tools/headless/match.js --frames 120 → exit=0, ok=true, pageErrors=[], vtStats.errorCount=0`。

**⚠️ 本轮真踩到的坑（如实记录）**：第一版插进 `SNAPSHOT` 模板字面量里的注释**带了反引号**（`` `rot: +(+p.rotation).toFixed(4)` ``），
**把模板字面量提前闭合** ⟹ `node --check` 立刻报 `SyntaxError: Unexpected identifier 'rot'`；改成无反引号版本后复测 OK。
⟹ **这就是"改注释也必须真跑一遍 `node --check`"的现场证据**（注释在模板字面量里，也是代码）。

