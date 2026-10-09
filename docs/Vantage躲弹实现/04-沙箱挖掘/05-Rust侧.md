# 05 - Rust 侧（`game_core/rust/vantage_core/src/`）

> **本文性质**：**只读**挖掘报告。写这份文档的过程里**没有修改任何代码文件**。
> **证据规则**：凡标【代码原文】的，都是逐字/近逐字摘录，并带 `文件:行号`；
> 凡标【解释，未验证】的，都是我的推断，**不是定案**，动手前必须复核。
> **本轮实际执行过的只读验证**（结果见 §六）：
> `node diff_rollout_bridge.js`（通过）、`diff_rollout_rescore_edge.js`（通过）、
> `diff_shrapnel_no_bounce.js` / `diff_shrapnel_lifetime_zero.js` / `diff_tree_death_blind.js` /
> `diff_rust_frame_dt_sync.js`（通过）、
> `diff_rescore_bridge.js` / `diff_score_paths_bridge.js`（**在版本闸门就中止**）、
> `diff_shrapnel_wall_stop.js`（**在文档路径处中止**）、
> `diff_box2d.js` / `diff_rollout.js` / `diff_rescore.js`（**cargo 链接失败**）；
> 以及一次 `cargo build --release --target wasm32-unknown-unknown`（输出目录改到临时目录）
> —— 产出的 wasm 与仓库里 `game_core/js/wasm/vantage_core.wasm` **字节完全相同**。
> **没有跑过 `cargo test`**（链接器不可用，见 §六.1）。
>
> **"只读"自证**：`game_core/rust/vantage_core/src/*.rs` 8 个文件的 mtime 全程保持 `Oct 4 04:04` 未变；
> 唯一新增的文件就是本文。`git status` 里那一堆 `M` 是**任务开始前就存在的**工作区改动，不是本次产生的。

一句话结论（**先看这个**）：
**Rust 侧不是一个"影子实现"，而是 4 个热路径 ABI + 1 个实验 ABI + 2 个零调用者 ABI；
它自己搬了一套 Box2D 子集（含 CCD）；`tree.rs` 那 1690 行树结构【没有任何 ABI 入口、没有任何调用方】——
跑在游戏里的是 JS 树。**

---

## 一、模块总览表（文件 / 行数 / 职责）

行数用 `wc -l` 实测，合计 **13281** 行（与任务书给的数字一致）。

| 文件 | 行数 | 职责（**原文引用**为主） | 我的定位 |
|---|---:|---|---|
| `lib.rs` | 1758 | `//! vantage_core: Rust/WASM sidecar for Vantage dodge logic.` / `//! Contains geometry/scoring helpers, the fused rollout batch, and the` / `//! incremental rescore + fused sensor/CCD death-verification core for tree` / `//! nodes with already-stored rollout samples.  No NN lives here.`（`lib.rs:1-5`） | **ABI 入口层**：8 个 `#[no_mangle] extern "C"` 里的 7 个在这里；另含 `Rect` 与 `build_wall_rects_vec`（`lib.rs:677-757`）；993 行之后全是 `#[cfg(test)] mod tests`（`lib.rs:993`） |
| `box2d.rs` | 3966 | `//! Minimal Box2D subset translated from the game's JS Box2D` / `//! (game_core/js/f1a5ef972c273fb89a098cb50b0f22e7.js).` / `//! The translation intentionally mirrors the JS implementation line-by-line` / `//! for the supported feature subset.  Public API names are Rustic; internal` / `//! function and field names keep the JS flavour so the diff is easy to review.`（`box2d.rs:1-5`） | **自研 Box2D 子集**（碰撞 + 求解器 + CCD/TOI），**不含关节/射线/查询/休眠**（见 §四.5） |
| `rollout.rs` | 1227 | `//! Fused rollout batch: one persistent Box2D world with real maze walls,` / `//! nine candidate tank bodies, fused sensor fixtures and a persistent bullet` / `//! slot pool, reproducing the game's simulateFusedBatch JS path.`（`rollout.rs:1-3`） | `vt_rollout_batch` / `vt_score_paths` 的**物理引擎**；也是**弹种语义**（破片）落地处 |
| `rescore.rs` | 2107 | `//! Incremental rescoring + death-verification core for Vantage tree nodes` / `//! that already have stored rolloutSamples.`（`rescore.rs:1-2`）；`//! The critical architectural guarantee is that tank trajectories are never` / `//! re-simulated here.`（`rescore.rs:4-5`） | `vt_rescore_nodes` 的**纯计算评分**（遮蔽弧/卡墙/车道）+ **保守粗筛** + **专用验证世界的死亡复核** |
| `scoring.rs` | 1413 | `//! Scoring / geometry core (phase 1).` … `//! It deliberately contains no tree, no NN, no death decision, and no WASM` / `//! C ABI exports.`（`scoring.rs:1-12`） | 遮蔽区间 `occlusionIntervals`/`exactOcclusion`、车道惩罚、弹簧绳、`scoreFrameAlive` 的 Rust 镜像 |
| `score_paths.rs` | 732 | `//! Nine-operation scored rollout path (vt_score_paths, ABI v6).` … `//! It reuses the existing fused rollout world … for tank samples and candidate death` / `//! frames, and the existing pure scoring core`（`score_paths.rs:1-8`） | **`vt_score_paths` 的实现在这个文件**（不在 lib.rs）；= `rollout::run_rollout_batch` + `rescore::score_stored_node` 的组合 |
| `tree.rs` | 1690 | `//! Prediction-tree core (phase 2).` / `//! This module mirrors the pure tree-structure parts of` / `//! game_core/js/vantage_tree.js v68:`（`tree.rs:1-4`）；`//! The module deliberately contains no tank simulation, no NN and no death` / `//! decision. All rollout data is supplied through RolloutProvider.`（`tree.rs:14-15`） | ⚠️ **见 §四.4：1690 行，零 ABI 入口、零调用方。** |
| `minimal.rs` | 388 | `//! Minimal, decision-only bridge for the Vantage dodge tree.` … `//! This module is intentionally much smaller than crate::tree: it takes` / `//! already-scored 75-frame rollouts, trims each candidate with exactly the` / `//! same probeSegment / buildCandidate / pickBestChildByRolloutTotal` / `//! pure-computation rules as JS v68`（`minimal.rs:1-6`） | `vt_minimal_decide` 的实现；**它没有调用 `tree.rs`**，只 `use crate::tree::{ProbeResult, EVAL_FRAMES};`（`minimal.rs:13`），函数体是自己重写的（`minimal.rs:66` `fn probe_segment`、`minimal.rs:148` `fn build_candidate`、`minimal.rs:195` `fn pick_best`） |

`lib.rs:9-15` 的模块声明（**原文**）：

```rust
pub mod box2d;
pub mod minimal;
pub mod rescore;
pub mod rollout;
pub mod score_paths;
pub mod scoring;
pub mod tree;
```

---

## 二、ABI 完整清单

### 2.0 判定方法（先说清楚，免得又被"看起来有"骗）

【代码原文】`#[no_mangle]` 在整个 `src/` 里只出现 **8 次**：

```
lib.rs:18   vt_version
lib.rs:41   vt_set_frame_dt
lib.rs:69   vt_rollout_batch
lib.rs:293  vt_rescore_nodes
lib.rs:782  vt_build_wall_rects
lib.rs:832  vt_sweep_danger_frames
lib.rs:930  vt_minimal_decide
score_paths.rs:209   vt_score_paths
```

【代码原文 / 实测】我解析了 **仓库里那份 wasm 的 Export Section**，恰好 9 项：
`memory` + 上面 8 个函数，**多一个都没有**（也没有 `tree.rs` 的任何符号）。

```
memory, vt_build_wall_rects, vt_minimal_decide, vt_rescore_nodes,
vt_rollout_batch, vt_score_paths, vt_sweep_danger_frames, vt_version, vt_set_frame_dt
```

【实测】`cargo build --release --target wasm32-unknown-unknown`（输出目录重定向到临时目录）
产出的 wasm 与 `game_core/js/wasm/vantage_core.wasm`
**大小相同（202181 字节）、sha256 前缀相同（`9dfc82901051971f`）**
⟹ **仓库里的 wasm 就是当前 `src/` 的构建产物**，本文对源码的描述适用于线上那份 wasm。

### 2.1 `vt_version() -> u32`　（`lib.rs:18-26`）

【代码原文】函数体只有三行注释 + 一个字面量：

```rust
pub extern "C" fn vt_version() -> u32 {
    // v7：两个 ABI 各加了一个 `occlusion_enabled` 尾参（把遮蔽开关接进 Rust）。
    // v8：新增 `vt_set_frame_dt`（不改既有 ABI 签名，只加一个 setter）。
    // v9：`vt_rollout_batch` / `vt_score_paths` 的弹体数组各增加一个与
    //     `bullet_count` 等长的 `bullet_is_shrapnel: *const u8`，把真游戏
    //     `WeaponTypes.MINE=4` 的破片语义带进 Rust（见 rollout.rs `BulletInput`
    //     与《待查清单》§13.3 / §19）。
    9
}
```

返回 **`9`**（当前 ABI 版本）。

### 2.2 `vt_set_frame_dt(dt: f64)`　（`lib.rs:28-44`）

【代码原文】文档注释（节选，`lib.rs:28-40`）：

```
/// v160：把 JS 侧校准后的真实帧步长写进 Rust。
/// 背景：`rollout.rs FRAME_DT` / `rescore.rs RESCORE_DT` 原本写死 0.02，而 JS 侧
/// `FRAME_DT` 会被校准到实测值（约 0.0167）。两边不一致时同一批弹会被算成两条不同
/// 弹道，于是 `rustFrameDtCompatible()` 直接停用 Rust 快路——实测 1800 帧里只有 44%
/// 时间 Rust 在跑，出问题那局只有 1%。
/// 值域钳在 [0.005, 0.2]，越界会被忽略（保持上一次的值）。
```

【代码原文】函数体：`rollout::set_frame_dt(dt);`（`lib.rs:42-44`）。

| 参数 | 含义 |
|---|---|
| `dt` | 帧步长（秒）。**全局量**，一次设定、整局不变（注释原话："帧步长是「一次设定、整局不变」的全局量，语义上就是全局"）。 |

返回 **void**。钳位实现在 `rollout.rs:26-29`（`frame_dt()` 在 `rollout.rs:31`）。

### 2.3 `vt_rollout_batch(...) -> i32`　（`lib.rs:46-260`）

【代码原文】签名（`lib.rs:69-101`，参数名逐字）：

```rust
pub extern "C" fn vt_rollout_batch(
    cache_id: u64,
    start_x: f64, start_y: f64, start_rot: f64,
    op_speed: *const f64, op_rot_speed: *const f64, op_count: u32,
    wall_vert_counts: *const u32, wall_verts: *const f64, wall_count: u32,
    bullet_x: *const f64, bullet_y: *const f64, bullet_vx: *const f64,
    bullet_vy: *const f64, bullet_radius: *const f64,
    bullet_life_left: *const f64, bullet_active: *const u8,
    bullet_is_shrapnel: *const u8, bullet_count: u32,
    duration_frames: u32,
    out_x: *mut f64, out_y: *mut f64, out_rot: *mut f64,
    out_dead: *mut u8, out_death_frame: *mut i32,
) -> i32
```

【代码原文】文档注释里的关键句子（`lib.rs:46-68`）：

```
/// All geometry/velocities are `f64` (JS numbers are doubles). Fixed limits:
/// ops <= 9, durationFrames <= 75 (samples = durationFrames + 1), walls <=
/// 1024, 3..8 vertices per wall, bullets <= 256 (0-radius laser allowed).
/// `cache_id` keys the persistent fused world (JS `_fusedCache` is keyed by
/// maze + aiId; pass a stable per-AI id from JS).
/// Returns 1 on success, 0 on bad input (null pointer, invalid length, or a
/// panic caught inside the rollout).
```

| 参数 | 含义（依据：`lib.rs:120-206` 的取值代码 + `rollout.rs` 的结构体字段） |
|---|---|
| `cache_id` | 融合世界的持久化键。`lib.rs:219-229` 用 `static CACHES: OnceLock<Mutex<HashMap<u64, RolloutCache>>>` 按 id 取世界。 |
| `start_x/y/rot` | 9 个候选坦克的共同起点位姿（`rollout.rs:89-93` `StartPose`）。 |
| `op_speed` / `op_rot_speed` | 长度 = `op_count` 的 f64 数组：**每个操作预先算好的**线性速度 / 角速度。`rollout.rs:98-102` 注释：`/// Precomputed linear speed for this op (JS already applied Tank methods / modifiers; Rust must NOT recompute tank speeds)`。**即 Rust 不自己算车速度。** |
| `op_count` | 1..=9（`lib.rs:104-106`）。 |
| `wall_vert_counts` / `wall_verts` | 墙多边形：每面墙 3..8 个顶点，`wall_verts` 是所有墙顶点 `(x,y)` 展平（`lib.rs:175-197`）。 |
| `bullet_*` | 长度 = `bullet_count` 的**当前场上弹体**快照（位置/速度/半径/剩余寿命/是否活跃/是否破片，`lib.rs:162-205`）。 |
| `duration_frames` | 0..=75；输出每组样本数 = `duration_frames + 1`（`lib.rs:141`）。 |
| `out_x/out_y/out_rot` | op-major：下标 `op_index * (duration_frames + 1) + frame`（`lib.rs:60-62`）。 |
| `out_dead` / `out_death_frame` | 每 op 一个；`out_dead` 是 0/1，`out_death_frame` 是 i32（`lib.rs:63-65`）。 |

返回 **1 = 成功，0 = 入参非法或内部错误（含 panic 被 `catch_unwind` 兜住）**。

**弹种语义只有破片一位**：`is_shrapnel: bullet_is_shrapnel_slice[i] != 0`（`lib.rs:202`）。
`lib.rs:52-56` 原文：`/// v9: bullet_is_shrapnel is one u8 per bullet (MINE shrapnel semantics: wall hit zeroes velocity and deactivates the bullet; speed^2 <= 0.01 also deactivates; no initial-speed renormalization).`

### 2.4 `vt_rescore_nodes(...) -> i32`　（`lib.rs:262-292` 文档 / `lib.rs:293-672` 函数体）

【代码原文】签名（`lib.rs:293-346`，逐字）：

```rust
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn vt_rescore_nodes(
    cache_id: u64,
    node_count: u32,
    sample_counts: *const u32,
    samples_x: *const f64, samples_y: *const f64, samples_rot: *const f64,
    start_t: *const f64, moving: *const u8, frames: *const u32,
    wall_vert_counts: *const u32, wall_verts: *const f64, wall_count: u32,
    threat_count: u32,
    threat_track_counts: *const u32,
    track_x: *const f64, track_y: *const f64, track_alive: *const u8,
    threat_path_counts: *const u32,
    path_x: *const f64, path_y: *const f64,
    anchor_offset: *const f64, speed: *const f64,
    bullet_radius: *const f64, life_left_seconds: *const f64,
    death_penalty: f64, stuck_penalty: f64, stuck_dist_eps: f64, stuck_rot_eps: f64,
    lane_penalty_ratio: f64, spring_rope_enabled: u8, occlusion_enabled: u8,
    prev_per_frame_scores: *const f64, threat_is_new: *const u8,
    node_has_prev_scores: *const u8, prev_death_frame: *const i32,
    out_per_frame_scores: *mut f64, out_total_score: *mut f64,
    out_death_frame: *mut i32, out_verified_frames: *mut u32, out_ok: *mut u8,
) -> i32
```

【代码原文】文档注释关键句（`lib.rs:262-292`）：

```
/// The tank trajectories are NOT re-simulated: `samples_x/y/rot` are the
/// already-stored `rolloutSamples` (node-major, `sample_counts[ni]` samples).
/// The dedicated verification world is keyed by `cache_id` + wall signature
/// and is independent from the `vt_rollout_batch` fused world.
/// - `prev_per_frame_scores`: node-major, `node_count * 75` values (stride
///   75); MAY be null.
/// - `threat_is_new`: one `u8` per threat; MAY be null only when
///   `threat_count == 0`.
/// - `out_ok`: one per node, 1 = ok, 0 = fallback needed (e.g. spring rope
///   scoring is unsupported by the Rust core).
/// Returns 1 when the call itself is valid (including the spring-rope
/// fallback case, where `out_ok` is zeroed), 0 on bad pointers/sizes or an
/// internal error.
```

| 参数/输出 | 含义 |
|---|---|
| `node_count` | ≤ 512（`rescore.rs:25` `MAX_RESCORE_NODES`；`lib.rs:345` 校验） |
| `sample_counts` | 每节点样本数；必须 1..=76（`rescore.rs:27` `MAX_RESCORE_SAMPLES`） |
| `samples_*` | 节点展平的**已存轨迹**（不回放、不重模拟） |
| `start_t` | 每节点起点的**绝对时间（秒）**（`rescore.rs:89-105` `RescoreNodeInput`） |
| `moving` | 每节点"这轮是否有操作"；影响卡墙惩罚（`rescore.rs:871` `if node.moving && is_stuck_pose(...)`） |
| `frames` | 每节点要评多少帧（≤75，`rescore.rs:29`） |
| 威胁组 | 每个威胁 = `track`（逐帧 x/y/alive）**或** `path`（折线）+ `anchorOffset` + `speed` + `bulletRadius` + `lifeLeftSeconds` |
| `threat_is_new` | 增量：哪些威胁是"上一轮之后新加的" |
| `node_has_prev_scores` / `prev_per_frame_scores` / `prev_death_frame` | 增量评分缓存 |
| 惩罚/开关 | `death_penalty` / `stuck_penalty` / `stuck_dist_eps` / `stuck_rot_eps` / `lane_penalty_ratio` / `spring_rope_enabled` / `occlusion_enabled` |
| `out_*` | 帧分（node-major，stride **75**，不足补 0）、总分、死亡帧、**实际验证过的帧数**、`out_ok` |

【代码原文】`lib.rs:637-641` —— 初始化：`out_pfs_slice.fill(0.0); out_total_slice.fill(0.0); out_death_slice.fill(-1); out_verified_slice.fill(0); out_ok_slice.fill(0);`
【代码原文】`lib.rs:660-663` —— `Err(rescore::RescoreError::SpringRopeUnsupported) => { // Call is valid; per-node ok=0 signals JS fallback. 1 }`。

### 2.5 `vt_build_wall_rects(...) -> u32`　（`lib.rs:773-830`）

【代码原文】签名（`lib.rs:782-790`）：

```rust
pub extern "C" fn vt_build_wall_rects(
    tiles: *const u8, width: u32, height: u32,
    tile_size: f32, wall_width: f32,
    out: *mut f32, out_capacity: u32,
) -> u32
```

【代码原文】文档（`lib.rs:773-781`）：

```
/// `tiles` layout: `[width][height][3]` with `tile[0] = floor`,
/// `tile[1] = top wall`, `tile[2] = left wall`. Each output rect is
/// `[minX, minY, maxX, maxY]` (4 `f32`). The geometry mirrors
/// `game_core/js/vantage_scoring.js` `getMazeWallEnv` before rectangle merging.
/// Returns the number of rects that would be written, capped at `out_capacity`.
/// Passing `out = null` returns 0.
```

返回 **"本应写出的矩形数"（被 `out_capacity` 截断）**；`out=null` → 0。

### 2.6 `vt_sweep_danger_frames(...) -> u32`　（`lib.rs:823-915`）

【代码原文】签名（`lib.rs:832-851`）：

```rust
pub extern "C" fn vt_sweep_danger_frames(
    node_x: *const f32, node_y: *const f32, _node_rot: *const f32,
    node_t0: f32, node_dt: f32, node_frames: u32,
    bullet_x: *const f32, bullet_y: *const f32,
    bullet_vx: *const f32, bullet_vy: *const f32, bullet_alive: *const u8,
    bullet_t0: f32, bullet_dt: f32, bullet_frames: u32,
    margin: f32,
    out_flags: *mut u8,
) -> u32
```

【代码原文】文档（`lib.rs:823-831`）：

```
/// Guarantees no false negatives: if this function leaves a node frame at 0,
/// the bullet cannot be within `margin` of the node under the conservative
/// max-move bound. It deliberately allows false positives and performs no
/// exact collision or death decision.
/// `out_flags` has length `node_frames`; the caller zeroes it. Returns the
/// number of node frames marked dangerous (1).
```

**注意 `_node_rot` 带下划线且函数体只做空指针检查（`lib.rs:853-855`），从不使用它** ——【解释，未验证】
即"旋转"没有进入这条粗筛的几何，粗筛只用点 + `max_move = (|vx|+|vy|) * overlap` 的 L1 上界（`lib.rs:892-898`）。

### 2.7 `vt_minimal_decide(...) -> i32`　（`lib.rs:917-990`）

【代码原文】签名（`lib.rs:930-942`）：

```rust
pub extern "C" fn vt_minimal_decide(
    total_scores: *const f64, dead_flags: *const u8, death_frames: *const i64,
    per_frame_scores: *const f64,
    candidate_count: u32, frames_per_candidate: u32,
    epsilon: f64, t_min: u32, t_max: u32,
    out_selected_index: *mut i32, out_segment_frames: *mut i32,
) -> i32
```

【代码原文】`candidate_count` 必须 **恰等于 9**、`frames_per_candidate` 必须 **恰等于 75**
（`lib.rs:945-949`，常量在 `minimal.rs:16-19`：`C_ABI_CANDIDATE_COUNT: usize = 9`、`C_ABI_FRAMES: usize = EVAL_FRAMES`，而 `EVAL_FRAMES = 75`（`tree.rs:24-25`））。
`out_selected_index` = 选中的操作下标；`out_segment_frames` = 该候选**实际执行段长**。

### 2.8 `vt_score_paths(...) -> i32`　（`score_paths.rs:145-624`）

【代码原文】签名（`score_paths.rs:209-268`）——**注意它不在 `lib.rs`**：

```rust
pub extern "C" fn vt_score_paths(
    cache_id: u64,
    start_x: f64, start_y: f64, start_rot: f64, start_t: f64,
    op_speed: *const f64, op_rot_speed: *const f64, op_moving: *const u8, op_count: u32,
    wall_vert_counts: *const u32, wall_verts: *const f64, wall_count: u32,
    bullet_x: *const f64, bullet_y: *const f64, bullet_vx: *const f64,
    bullet_vy: *const f64, bullet_radius: *const f64, bullet_life_left: *const f64,
    bullet_active: *const u8, bullet_is_shrapnel: *const u8, bullet_count: u32,
    duration_frames: u32,
    threat_count: u32,
    threat_track_counts: *const u32,
    track_x: *const f64, track_y: *const f64, track_alive: *const u8,
    threat_path_counts: *const u32, path_x: *const f64, path_y: *const f64,
    threat_anchor_offset: *const f64, threat_speed: *const f64,
    death_penalty: f64, stuck_penalty: f64, stuck_dist_eps: f64, stuck_rot_eps: f64,
    lane_penalty_ratio: f64, spring_rope_enabled: u8, occlusion_enabled: u8,
    out_x: *mut f64, out_y: *mut f64, out_rot: *mut f64,
    out_per_frame_scores: *mut f64, out_total_score: *mut f64,
    out_death_frame: *mut i32, out_ok: *mut u8,
) -> i32
```

【代码原文】文档（`score_paths.rs:200-208`）：

```
/// Returns 1 on success, 0 on bad input or an unsupported configuration
/// (lane > 0 / spring rope), in which case JS must fall back to the real
/// `VantageScoring.scorePaths` path.
```

【代码原文】两条硬拒绝（`score_paths.rs:311-313`）：

```rust
if lane_penalty_ratio > 0.0 || spring_rope_enabled != 0 {
    return 0;
}
```

与 `run_score_paths` 内部同样的两道拒绝（`score_paths.rs:93-105`）。

---

## 三、Rust ↔ JS 对等关系表

| # | Rust ABI | JS 调用者（**实测 grep**） | JS 侧被替代的老实现 | 语义是否一致 | 已知不一致 / 备注 |
|---|---|---|---|---|---|
| 1 | `vt_version` | `vantage_rust_bridge.js:139` `version()` | — | ✅ | 返回 9；**两个 diff 脚本却要求 10** → 见 §六.2 |
| 2 | `vt_set_frame_dt` | `vantage_rust_bridge.js:173-176` `setFrameDt()` ← `vantage_sandbox.js:1057-1060`（在 `rustFrameDtCompatible()` 里，**每批调用前**） | 无 | ✅（同一全局量） | ⚠️ 但 JS 把 Rust 样本的 `t` 写成 `frame * 0.02` 硬编码（`vantage_sandbox.js:1319`、`2347`），而 JS 融合路径写 `k * FRAME`（`vantage_sandbox.js:1617`，在 `simulateFusedBatch` 内；另 `473` 在 `simulateTankClone` 内） → 见 §六.3 |
| 3 | `vt_rollout_batch` | `vantage_rust_bridge.js:397` `rolloutBatch()` ← `vantage_sandbox.js:1287` `simulateRustBatch()`（`1242-1329`） | `simulateFusedBatch()`（`vantage_sandbox.js:1332`）——**JS 融合世界** | ✅（**实测通过**，见下） | ⚠️ JS 侧包装把 `hitWall` 恒置 `false`（`vantage_sandbox.js:1321`），但 JS 融合路径**也**恒置 `false`（`1864`，在 `simulateFusedBatch` 内）→ **这条两边一致，不是差异**。真差异是时间戳硬编码，见 §六.3 |
| 4 | `vt_score_paths` | `vantage_rust_bridge.js:1399` `scorePaths()` ← `vantage_sandbox.js:2305` `simulateTankBatchScored()`（`2211-2363`） | `VantageScoring.scorePaths`（`vantage_scoring.js:2426`） | ✅（设计意图一致） | **本轮无法验证**：`diff_score_paths_bridge.js:317` 卡在版本闸门。JS 侧也自己先拒绝 `springRopeEnabled` / `lanePenaltyRatio > 0`（`vantage_sandbox.js:2221-2222`），与 Rust 侧一致 |
| 5 | `vt_rescore_nodes` | `vantage_rust_bridge.js:931` `rescoreNodes()` ← `vantage_sandbox.js:2470` `rescoreTankSamples()`（`2380-…`） | `VantageScoring.scorePaths` 逐节点重算（`vantage_tree.js:2673`（`由 refreshFusedLayer 回退原 VantageScoring.scorePaths。`）与 `vantage_tree.js:2729` `function tryRustRescoreLayer`） | ⚠️ **部分不一致**（见下） | **本轮无法用 diff 脚本验证**：`diff_rescore_bridge.js:284` 卡在版本闸门；但 `diff_rollout_rescore_edge.js` **通过**（0 误差） |
| 6 | `vt_build_wall_rects` | **无**（只有 `vantage_rust_bridge.js:1483` 暴露，`grep` 全仓无第 3 方调用） | `VantageScoring.getMazeWallEnv`（`vantage_scoring.js:641`） | 未比对 | 【解释，未验证】这是"预备接口"，JS 从未切过来 |
| 7 | `vt_sweep_danger_frames` | **无**（只有 `vantage_rust_bridge.js:1542` 暴露） | `VantageTree._coarse`（`vantage_tree.js:8213` 起，含 `nodeCoarseBox` / `threatCoarseBox` / `bulletCannotReach` 等） | 未比对 | 同上；且 Rust 函数**无视 `_node_rot`** |
| 8 | `vt_minimal_decide` | `vantage_rust_bridge.js:1719` `minimalDecide()` ← `vantage_tree.js:4410` `tryRustMinimalSelect()` | JS 的 `probeSegment` / `buildCandidate` / `pickBestChildByRolloutTotal`（`vantage_tree.js:3679` `function probeSegment`） | 未比对 | 【代码原文】**实验开关门控**：`vantage_tree.js:4387` `if (!tree || !tree.cfg || !tree.cfg.rustMinimalEnabled) return null;` ——【解释，未验证】默认路径仍是 JS 选 |

### 3.1 第 3 行"✅"的实证

【实测】`node game_core/rust/diff_rollout_bridge.js`：

```
scene            : bridge head-on bullet, call 1
  ops compared   : 9
  samples per op : 76
  max position err: 0.000000000e+0 m at
  max angle err   : 0.000000000e+0 rad at
scene            : bridge head-on bullet, call 2 (warm)
  ...
DIFF ROLLOUT BRIDGE PASSED
```

即：**9 操作 × 76 帧，位置与角度误差都是 0**（含第二次调用——即**持久世界的热启动/接触冲量复用也一致**）。

对应地，`diff_rollout_rescore_edge.js` 也通过：

```
  max per-frame err: 0.000000000e+0
  max total err    : 0.000000000e+0
DIFF ROLLOUT/RESCORE EDGE PASSED
```

### 3.2 第 5 行"部分不一致"的证据

【代码原文】`rescore.rs` 里 `is_shrapnel` **只出现 1 次，且在测试里**：

```
rescore.rs:1658:                is_shrapnel: false,
```

即 `verify_death_for_node()` 的逐帧循环里**只有**基类那条归一化（`rescore.rs:1191-1215`）：

```rust
            let len_sq = len * len;
            let init_sq = slot.initial_speed * slot.initial_speed;
            if (len_sq - init_sq).abs() > 0.01 {
                let scale = slot.initial_speed / len;
                vw.world
                    .set_body_linear_velocity(slot.body, (vx * scale, vy * scale));
            }
```

**没有** `rollout.rs:852-886` 那一段破片判据。
而 JS 侧**自己的**融合世界是有破片判据的（`vantage_sandbox.js:1749-1767`），
且 JS 的死亡权威路径正是它（`vantage_sandbox.js:2365-2369` `simulateTankBatchJsFused` → `simulateFusedBatch`）。

【解释，未验证】所以：**当威胁是地雷破片时，`vt_rescore_nodes` 的验证世界会把它当普通反弹弹来模拟，
而 JS 权威把它当"撞墙即停"。** 影响面我没有验证——因为验证世界是**逐帧从 track 摆位、只 Step 一帧**
（`rescore.rs:1114-1150`），而 `threat_bullet_pos` 在 track 的 `alive=false` 时直接返回 `None`（`rescore.rs:303-309`），
**可能**使得破片的"消失"由 `alive` 标志先兜住了。**这条必须实测确认，不能当结论用。**

---

## 四、关键实现（含原文）

### 4.1 `create_projectile_body` —— 在哪里、原文、和 JS 的差

**位置**：`game_core/rust/vantage_core/src/rollout.rs:327-360`（**不在 `box2d.rs`，也不在 `lib.rs`**）。

【代码原文】完整函数（`rollout.rs:327-360`，含文档注释）：

```rust
/// Create a projectile body identical to JS `B2DUtils.createProjectileBody`
/// for the fused batch / verification world.
///
/// TODO(v9)：这里所有弹种都是「半径 `radius` 的圆 + restitution=1.0」。对普通弹
/// 正确，但另两个弹种不是这个形状/行为（卡点见《待查清单》§19）：
///   · LASER（真 `LASER.RADIUS.m=0`、180 m/s）：真实判定是逐帧的线段扫掠
///     （`Projectile` 基类 + Box2D CCD），不是半径 0.05 的圆。本轮 JS 侧仍用
///     档案 `radiusFallback: 0.05` 的退化护栏，Rust 从 bridge 收到同一个 0.05；
///     两边口径一致但都不对。要改必须 JS 融合世界与 Rust **同一轮**落线段×多边形。
///   · HOMING_MISSILE：`HomingMissile.update` 会按 maze BFS 图 2.0s 后制导，
///     融合世界没有对手未来轨迹/迷宫图/`timeAlive`，无法忠实复刻。
pub(crate) fn create_projectile_body(world: &mut World, radius: f64) -> crate::box2d::BodyId {
    let mut bd = BodyDef::new();
    bd.body_type = B2_DYNAMIC_BODY;
    bd.fixed_rotation = true;
    bd.active = true;
    bd.linear_damping = 0.0;
    bd.bullet = true;
    bd.allow_sleep = true;
    let body = Body::create(world, bd);
    let mut fd = FixtureDef::new();
    fd.shape = Some(Shape::Circle(CircleShape::new(radius)));
    fd.density = 0.01;
    fd.friction = 0.0;
    fd.restitution = 1.0;
    fd.is_sensor = false;
    fd.category_bits = CATEGORY_PROJECTILE;
    fd.mask_bits = BULLET_MASK;
    fd.kind = FixtureKind::Bullet;
    Body::create_fixture(world, body, fd);
    body
}
```

调用点（3 处）：`rollout.rs:424`（复用槽位且半径变了→建新体）、`rollout.rs:433`（新建槽位）、`rollout.rs:560`（`FusedWorld::create_bullet_body`）。

**JS 对照**：真实游戏的 `B2DUtils.createProjectileBody` 在
`game_core/js/b714588dc4621fe104113111ba90b1a7.js:5`（该文件第 5 行、第 8193 列；这是一个
`mod_pagespeed_...` 打包字符串，所以"行号"意义上整个 bundle 在一行里）。
【代码原文】逐字（我把它从压缩串里切出来的完整函数）：

```js
createProjectileBody:function(b2dworld,projectile,radius){
  var projectileFixtureDef=new Box2D.Dynamics.b2FixtureDef;
  projectileFixtureDef.density=0.01;
  projectileFixtureDef.friction=0.0;
  projectileFixtureDef.restitution=1.0;
  projectileFixtureDef.shape=new Box2D.Collision.Shapes.b2CircleShape(radius);
  projectileFixtureDef.userData={gameObject:projectile};
  projectileFixtureDef.filter=new Box2D.Dynamics.b2FilterData;
  projectileFixtureDef.filter.categoryBits=Constants.COLLISION_CATEGORIES.PROJECTILE;
  projectileFixtureDef.filter.maskBits=Constants.COLLISION_CATEGORIES.TANK|Constants.COLLISION_CATEGORIES.MAZE|Constants.COLLISION_CATEGORIES.SHIELD|Constants.COLLISION_CATEGORIES.ZONE;
  var projectileBodyDef=new Box2D.Dynamics.b2BodyDef;
  projectileBodyDef.type=Box2D.Dynamics.b2Body.b2_dynamicBody;
  projectileBodyDef.linearDamping=0.0;
  projectileBodyDef.fixedRotation=true;
  projectileBodyDef.active=true;
  projectileBodyDef.bullet=true;
  var box2dBody=b2dworld.CreateBody(projectileBodyDef);
  box2dBody.CreateFixture(projectileFixtureDef);
  box2dBody.SetPosition(Box2D.Common.Math.b2Vec2.Make(projectile.getX(),projectile.getY()));
  box2dBody.SetLinearVelocity(Box2D.Common.Math.b2Vec2.Make(projectile.getSpeedX(),projectile.getSpeedY()));
  return box2dBody;
}
```

**逐项对账**：

| 项 | JS（`b714…js:5`） | Rust（`rollout.rs:338-360`） | 判定 |
|---|---|---|---|
| `density` | `0.01` | `0.01` | ✅ |
| `friction` | `0.0` | `0.0` | ✅ |
| `restitution` | `1.0` | `1.0` | ✅ |
| `shape` | `b2CircleShape(radius)` | `Shape::Circle(CircleShape::new(radius))` | ✅ |
| `categoryBits` | `PROJECTILE` | `CATEGORY_PROJECTILE`（`rollout.rs:47`） | ✅ |
| `maskBits` | `TANK\|MAZE\|SHIELD\|ZONE` | `BULLET_MASK = CATEGORY_TANK \| CATEGORY_MAZE`（`rollout.rs:81`） | ⚠️ **少 SHIELD / ZONE**。Rust 自己在 `rollout.rs:79-80` 写明：`/// Bullet fixture mask from B2DUtils.createProjectileBody`（`/// (SHIELD/ZONE ignored in our subset).`）。**融合世界不造护盾/zone 夹具** →【解释，未验证】当前无差别；**但一旦加护盾夹具，这里会立刻变成静默不一致** |
| `type` | `b2_dynamicBody` | `B2_DYNAMIC_BODY` | ✅ |
| `linearDamping` | `0.0` | `0.0` | ✅ |
| `fixedRotation` | `true` | `true` | ✅ |
| `active` | `true` | `true` | ✅ |
| `bullet` | `true` | `true` | ✅（**这就是防穿的来源，见 §4.6**） |
| `allowSleep` | JS **没写** → 走 `b2BodyDef` 默认；【代码原文】`f1a5ef972c273fb89a098cb50b0f22e7.js:1`：`w.prototype.b2BodyDef=function(){...this.allowSleep=!0,...}` → **true** | `bd.allow_sleep = true;`（`rollout.rs:345`） | ✅ 值一致 |
| 摆位/摆速 | `SetPosition` + `SetLinearVelocity` 在函数内 | **不在函数内**，由调用方做（`rollout.rs:737-742`：`set_position_and_angle(body, bullet.x, bullet.y, 0.0)` + `set_body_linear_velocity(body, (bullet.vx, bullet.vy))`） | ⚠️ 拆分实现。**角度固定传 0.0**；JS 那边 `b2dBody` 的角度也没被设（`CreateBody` 后没 `SetAngle`），默认 0 —— 所以一致 |

**结论（这句话请当结论用）**：`create_projectile_body` 的**体/夹具定义**与 JS `createProjectileBody` 逐项一致，
唯一实差是 **maskBits 缺 SHIELD/ZONE（已在注释里声明为"我们的子集不含"）**；
"弹种差异"（LASER 扫掠 / 导弹制导）**是两侧共同缺失**，Rust 注释里明确写了
"两边口径一致但都不对，要改必须 JS 与 Rust 同一轮落"。

另一处与"铁律"直接相关的原文（**JS 侧**，`vantage_sandbox.js:1089-1090`）：

```
//   铁律：动任何弹种，必须 JS 融合世界与 Rust（rollout.rs create_projectile_body）
//        同一次落同一语义，两边都留历史注释。
```

### 4.2 融合候选坦克 `create_fused_candidate`（`rollout.rs:250-292`）

【代码原文】文档 + 关键注释（`rollout.rs:249-251`、`rollout.rs:284-289`）：

```
/// Create one fused candidate body (solid fixtures mask=MAZE, sensor fixtures
/// mask=PROJECTILE), exactly like JS `createFusedCandidateBody`.
```

```
    // Sensor copies (same shapes, one per original fixture).  JS
    // `createFusedCandidateBody` walks `GetFixtureList()` after
    // `createTankBody`, so the fixture list head is the turret; the
    // sensor creation order is therefore turret-sensor first, then
    // base-sensor.
```

JS 对照：`vantage_sandbox.js:901-935` `createFusedCandidateBody`，
其"夹具链表是前插的"这一前提在 JS 侧写明于 `vantage_sandbox.js:951-954`
（`// v28：为 Rust 融合 rollouts 提取墙多边形。本 Box2D 修订的 body/ fixture 链表是前插的…`）。
**顺序敏感，两侧各自都写了理由** —— 属"同一次落同一语义"的正面例子。

### 4.3 破片（Shrapnel）语义怎么复刻的

**真源码依据**（Rust 注释自己引的就是这个 bundle）：

* `game_core/js/418577fd210ad079ea3d1e5e04050fe0.js:6`（col 146 起）
  【代码原文】：

```js
var Shrapnel=Projectile.subclass();
Shrapnel.methods({
  update:function(deltaTime){
    if(!this.isDeadlyToOwner()){this.makeDeadlyToOwner();}
    this.x=this.b2dbody.GetPosition().x;
    this.y=this.b2dbody.GetPosition().y;
    this.speedX=this.b2dbody.GetLinearVelocity().x;
    this.speedY=this.b2dbody.GetLinearVelocity().y;
  },
  hitShield:function(){var velocity=this.b2dbody.GetLinearVelocity();velocity.Multiply(0.0);},
  hitMaze:function(){var velocity=this.b2dbody.GetLinearVelocity();velocity.Multiply(0.0);},
  done:function(){var velocity=this.b2dbody.GetLinearVelocity();return velocity.LengthSquared()<=0.01;}
});
```

**四条可直接读出的语义**（我**没有**从函数名反推，是从函数体读的）：
1. `update` 里**没有** `_super()` 调用 → 基类 `Projectile.update` 的"速度乘回初速"归一化**不生效**。
   基类代码【代码原文】在同一 bundle：
   `if(Math.abs(this.b2dbody.GetLinearVelocity().LengthSquared()-this.initialSpeedSquared)>0.01){var velocity=...;var length=velocity.Length();if(length===0){this.stopped=true;}else{velocity.Multiply(this.initialSpeed/length);}}`
2. `hitMaze` **把速度乘 0**（不是"记一次反弹时间戳"——基类 `Projectile.hitMaze` 才是 `this.bounces.push(new Date().getTime())`）。
3. `done()` = `LengthSquared() <= 0.01`。
4. `hitShield` 也是速度乘 0。

**谁调用 `hitMaze`**：【代码原文】`game_core/js/82e43ebfcdffdaf490dbe79c9c119d29.js:1`（col 4334）：
`case RoundModel._EVENTS.PROJECTILE_MAZE_COLLISION:{data.projectile.hitMaze();break;}`
⟹ 真游戏是**事件驱动**的。

**地雷抛出 30 片**：【代码原文】`game_core/js/7b2ed8ad3598d7321f8f3d2b04b1eac8.js:1`（col 2174 `getProjectileStates`）：
`for(var i=0;i<Constants.MINE_NUM_SHRAPNEL;++i){var speed=Constants.MINE.MIN_SPEED.m+Math.random()*(...);var direction=Math.random()*Math.PI*2.0;...}`
**起点** = `this.x,this.y`（地雷中心点，无半径偏移）。
寿命传 0：【代码原文】`game_core/js/46989e393ad0e356ac8a0c6c53b362f9.js:1`（col 9532）：
`case Constants.WEAPON_TYPES.MINE:{projectile=Shrapnel.create(projectileState,0,...);b2dBody=B2DUtils.createProjectileBody(this.b2dworld,projectile,Constants.MINE_SHRAPNEL_RADIUS);break;}`

**Rust 侧怎么复刻**：【代码原文】`rollout.rs:823-886`（注释与代码；判据顺序逐条对齐 JS）：

```rust
        // v9：逐字对齐 JS 融合世界 v162/v164（`vantage_sandbox.js` 里
        // `bs.isShrapnel` / `bs.noSpeedNorm` 两段），判据顺序也一致：
        //   ① 寿命到期退场；
        //   ② 速度恰为 0 退场；
        //   ③ 破片：上一帧方向与本帧方向点积 `dot < 0.999`（约 >2.5°）⇒ 判撞墙，
        //      速度清零 + 停用（等价 `Shrapnel.hitMaze`，破片当帧消失、不反弹）；
        //   ④ 破片：速度² <= 0.01 即退场（等价 `Shrapnel.done`），且**不做**基类
        //      `Projectile.update` 的「速度乘回初速」归一化
        // 备注：③ 的「方向变化」是 JS v162 的启发式（不读真 `hitMaze` 事件）；
        //      JS / Rust 必须永远同步改，详见《待查清单》§13.3 / §19。
```

```rust
            if slot.is_shrapnel && slot.has_prev_dir {
                // JS v162：方向变了（约 >2.5°）就是撞墙了（restitution=1 会把它反射）。
                let dot = (vx / len) * slot.prev_dir_x + (vy / len) * slot.prev_dir_y;
                if dot < 0.999 {
                    fc.world.set_body_linear_velocity(slot.body, (0.0, 0.0));
                    slot.active = false;
                    fc.world.set_active(slot.body, false);
                    continue;
                }
            }
            if slot.is_shrapnel {
                slot.prev_dir_x = vx / len;
                slot.prev_dir_y = vy / len;
                slot.has_prev_dir = true;
            }
```

**JS 侧同一段**：【代码原文】`vantage_sandbox.js:1745-1767`（含实证数据注释）：

```
                // v162：破片撞墙即停 —— 复刻 `Shrapnel.hitMaze`（速度清零）。
                // 判据：飞行方向发生了可观测变化（Box2D 的 restitution=1.0 会把它反射），
                // 真实破片不会反弹，所以一旦方向变了就说明撞墙，立刻清零停住。
                // 实证依据：录制 vantage_record_1790925717252.json 地雷致死时
                //   placements=30/36/72、contacts=[]、dfs=[-1]、killer polyGap=1.22
                //   —— 破片在该停的地方弹走了，擦过 1.22 米 → 树全绿 → 死。
                if (bs.isShrapnel && bs.prevDirX !== null) {
                    var dot = (bv.x / blen) * bs.prevDirX + (bv.y / blen) * bs.prevDirY;
                    if (dot < 0.999) {           // 方向变了（约 >2.5°）就是撞墙了
                        bs.body.SetLinearVelocity(Box2D.Common.Math.b2Vec2.Make(0, 0));
                        bs.active = false;
                        bs.body.SetActive(false);
                        continue;
                    }
                }
                if (bs.isShrapnel) { bs.prevDirX = bv.x / blen; bs.prevDirY = bv.y / blen; }
```

【解释，未验证】**"撞墙"是推断的**：两侧都不是读真 `hitMaze` 事件，而是用"方向变了 ⇒ 撞墙"的启发式。
Rust 与 JS 用的判据字面相同（`dot < 0.999`）。**这条不是"复刻了 Shrapnel"，而是"复刻了 JS 对 Shrapnel 的近似"**——
不能对外说"Rust 精确保真了破片物理"。

**槽位复用时必须清零 prevDir**：【代码原文】`rollout.rs:729-737` 注释：
`// v9：槽位按 lastRound 轮询复用，每次摆位都必须重设弹种标记并清空上一帧方向。`（"残留方向会把新弹第一帧 `dot < 0.999` 误判成撞墙"）；
JS 对应 `vantage_sandbox.js:1538-1543`（`approx 分支`同一处理）。**这条是"同一次落同一语义"的正面例子。**

**寿命 0 的哨兵**：【代码原文】`diff_shrapnel_lifetime_zero.js:5-7`（测试文件，作历史依据）：
`// 原游戏 Projectile.constructor(state, lifetime, ...)；只有地雷破片传 0（Shrapnel.create(state, 0, ...)），它靠 done()（速度≈0）结束。`
JS 实现：`vantage_sandbox.js:304-305`（`NO_LIFETIME_SEC = 1e9`、`function lifetimeSecOf`）。
【解释，未验证】Rust 侧**没有**这个哨兵——`rollout.rs:745` 是 `let life_left = bullet.life_left.max(0.0);`，
寿命值由 JS 传进来（JS 已在 `lifetimeSecOf` 里换成 1e9）。**所以哨兵逻辑只在 JS 半边，Rust 是被动接收**。
若将来有别的调用方直接喂 `lifeLeft=0`，Rust 会当"已过期"（`rollout.rs:838-841` `slot.life_left -= frame_dt(); if slot.life_left <= 0.0 { 停用 }`）。

### 4.4 ★ `tree.rs` 是什么（1690 行）—— 重大发现

**先给结论**：

> **`tree.rs` 是把 JS `vantage_tree.js` v68 的"纯树结构"逻辑移植到 Rust 的产物，
> 但它【没有任何 ABI 入口、也没有任何调用方】，因此不参与线上运行。
> 线上跑的树仍然是 JS 那棵。**

**证据链（全部可复现）**：

1. **它自己说不跑物理**：【代码原文】`tree.rs:14-15`
   `//! The module deliberately contains no tank simulation, no NN and no death` / `//! decision. All rollout data is supplied through RolloutProvider.`
   再往上 `tree.rs:1-4` 写明它镜像的是 `game_core/js/vantage_tree.js v68` 的哪些函数。

2. **没有 `#[no_mangle]`**：【实测】`grep -rn "no_mangle" src/` 只命中 `lib.rs`（7 处）与 `score_paths.rs`（1 处），
   `tree.rs` **一处都没有**。wasm 的 Export Section 里也没有任何 tree 符号。

3. **没有任何 ABI 调用它**：【实测】`grep -rn "crate::tree\|tree::" src/ | grep -v "^src/tree.rs"` 只有三行，
   且全是 `minimal.rs` 的**注释**与一行 `use`：
   ```
   src/minimal.rs:3://! This module is intentionally much smaller than [`crate::tree`]: ...
   src/minimal.rs:13:use crate::tree::{ProbeResult, EVAL_FRAMES};
   src/minimal.rs:20:/// Operation names in the same order as [`crate::tree::standard_operations`].
   ```
   即真正被 `use` 的只有 **一个结构体 `ProbeResult` 和一个常量 `EVAL_FRAMES`**。

4. **`minimal.rs` 没有复用 `tree.rs` 的函数**：【代码原文】`minimal.rs:63-64`
   `/// Equivalent of JS probeSegment / tree::probe_segment_with_cfg, but only` / `/// computes the fields needed for the minimal decision.`
   → 它**照抄了一份**（`minimal.rs:66` `fn probe_segment`、`minimal.rs:148` `fn build_candidate`、`minimal.rs:195` `fn pick_best`），
   而不是调 `tree.rs` 的对应函数。

5. **4 个 `bin/` 目标也都不用它**：【实测】`grep -rn "tree::\|Tree::" src/bin/*.rs` **零命中**。
   （`src/bin/` 里是 `box2d_trace.rs` / `rescore_trace.rs` / `rollout_trace.rs` / `vantage_headless.rs`，
   最后一个只调 `vantage_core::minimal::{minimal_decide, ...}`。）

6. **`tree.rs` 内部函数对外零引用**：【实测】逐函数 grep `src/`（排除 `tree.rs` 自身）：
   `attach_results` / `pick_best_child_by_rollout_total` / `commit_path_of` / `route_avg_of_leaf` /
   `best_route_leaf_in_subtree` / `grow_step` / `is_true_dead_node` / `pick_retreat_leaf` /
   `apply_retreat_after_expand` / `commit` → **全部 0 引用**。

7. **它只被 `cargo test` 用到**：【代码原文】`tree.rs:1362` `mod tests`（文件末 328 行是测试）。

**它里面到底有什么**（结构，不逐行；`grep -n "^pub fn"` 的结果）：
`tree.rs:202 standard_operations`（9 个操作）、`411 probe_segment`、`494 build_candidate`、`588 attach_results`、
`612 pick_best_child_by_rollout_total`、`742 commit_path_of`、`798 route_avg_of_leaf`、
`818 best_route_leaf_in_subtree`、`848 is_true_dead_node`、`867 pick_retreat_leaf`、
`918 apply_retreat_after_expand`、`1047 grow_step`、`1159 commit`，
外加 `340 active_node_count`、`677 pick_best_subtree`、`727 pick_route_child`、`1011 pick_grow_leaf`、
`1080 recompute_next_for_children`、`1159 commit`。
配置默认值【代码原文】`tree.rs:116-128`：`epsilon: PI*PI, t_min: 3, t_max: 30, horizon_sec: 8.0, max_nodes: 500, lane_penalty_ratio: 0.0, spring_rope_enabled: false`。

**它和 JS 侧的树是什么关系**：
【解释，未验证】它是 **JS 规则版树的"镜像副本"**，属半成品移植（`tree.rs:1` 自称 `Prediction-tree core (phase 2).`）。
**目前的状态是"两边各有一棵树的代码，但只有 JS 那棵在跑"。**
⟹ 这一条对"智能体版要不要 Rust 落树"是**直接的决策输入**：
**Rust 侧现在有一个 1690 行的树骨架可复用，但它与 JS 树是否仍然同步、是否还符合 v68 之后的语义，
没有任何测试或对拍在保它**（唯一的消费者 `minimal.rs` 只借了两个符号）。
**别把"Rust 里已经有树"当成"Rust 树可用"** —— 它连 ABI 都没接。

### 4.5 `box2d.rs` 复刻度（3966 行自研 Box2D）

【代码原文】`box2d.rs:1-5` 自称"按行镜像 JS 实现，只覆盖被用到的子集"（原文见 §一表格）。

**已实现**（`grep -n "^pub fn\|^fn \|^struct \|^impl \|^pub struct"` 的实际产物）：

| 层 | 内容 | 行号锚点 |
|---|---|---|
| 常量/设置 | `B2_LINEAR_SLOP` / `B2_ANGULAR_SLOP` / `B2_POLYGON_RADIUS` / `B2_AABB_*` / `B2_MAX_TRANSLATION=8.0` / `B2_MAX_ROTATION` / `B2_CONTACT_BAUMGARTE=0.2` / `B2_MAX_LINEAR_CORRECTION=0.2` / `B2_VELOCITY_THRESHOLD=0.0` / `JS_NUMBER_MIN_VALUE=5e-324` | `box2d.rs:19-41` |
| 数学 | `Vec2` / `Mat22` / `Transform` / `Sweep` / `AABB` + 一整套 `b2_*` 自由函数 | `box2d.rs:94-448` |
| 形状 | `PolygonShape`（含质心）/ `CircleShape` / `Shape` 枚举 | `box2d.rs:456-655` |
| 距离 | `DistanceProxy` / `Simplex*` / `b2_distance` | `box2d.rs:663-1150` |
| **TOI/CCD** | `SeparationFunction` / `ToiInput` / `b2_time_of_impact` | `box2d.rs:1157-1405` |
| 流形 | `ContactID` / `ManifoldPoint` / `Manifold` / `WorldManifold` / `clip_segment_to_line` / `edge_separation` / `find_max_separation` / `find_incident_edge` / `collide_polygons` / `collide_polygon_and_circle` | `box2d.rs:1412-1972` |
| 动力学 | `BodyDef` / `FixtureDef` / `Fixture` / `Body` | `box2d.rs:1982-2136` |
| 求解 | `Contact` / `TimeStep` / `ContactConstraint*` / `World` / `solve` / `solve_velocity_constraints` / `solve_position_constraints` / `solve_toi` / `solve_toi_island` | `box2d.rs:2143-3694` |

**明确没有的**（【实测】`grep -in "raycast\|joint\|query" box2d.rs` 只有 **2 行**，且都是注释里说"没有关节"）：

- `box2d.rs:2833` `/// Simplified JS b2Island.SolveTOI for our island (no joints).`
- `box2d.rs:2921` `/// Simplified JS b2World.SolveTOI.  Our world has no joints, so the`
⟹ **没有 `RayCast`、没有 `QueryShape`、没有关节、没有宽相（broadphase）。**

**休眠（sleep）也没实现**：【实测】`sleep_time` 只在 `box2d.rs:2093`（字段声明）和 `box2d.rs:2335`（`sleep_time: 0.0`）出现，
**没有任何地方更新它、也没有任何地方把 body 置为 asleep**；
`World` 的 `allow_sleep` 字段被显式标 `#[allow(dead_code)]`（`box2d.rs:2289`）；
`Body::create` 里 `if def.allow_sleep { body.flags |= BODY_E_ALLOW_SLEEP_FLAG; }`（`box2d.rs:2343-2345`）只是记了旗标。
【解释，未验证】对融合世界**可能**无影响，因为每批开始会把候选体 `set_body_awake(true)`（`rollout.rs:717`）
且弹体也 `set_body_awake(true)`（`rollout.rs:742`）、速度每帧重设。**但"子弹在 JS 里会睡、在 Rust 里不会"这条没有实测过。**

**宽相/性能说明**（【代码原文】`box2d.rs:2585-2587`）：

```
        // JS `b2World.Step`: new fixtures -> FindNewContacts, Collide,
        // Solve, SolveTOI, then inv_dt0.  Our O(n^2) broadphase needs
        // fixture AABBs refreshed before use, so we update them first.
```

⟹ **Rust 是 O(n²) 粗暴宽相**，不是 JS Box2D 的树形宽相。语义上靠 AABB 测试等价，**但性能特征不同**。

**保真度怎么被验的**：【代码原文 / 只读】`box2d.rs` 自带单测：
`box2d.rs:3898` `fn ccd_smoke_bullet_circle_does_not_tunnel_through_thin_wall()`、
`box2d.rs:3926` `fn toi_target_uses_fraction_of_total_radius()`、
`box2d.rs:3861` `fn b2_time_of_impact_box_into_thin_wall()`。
**但这些测试本轮跑不了**（见 §六.1）。
JS↔Rust 的差分验证靠 `game_core/rust/diff_box2d.js`，它头部写
`// Runs several scenes (free motion + CCD collision scenes), compares [x, y, angle] after every frame, and fails if any scene exceeds 1e-6.`
—— **本轮同样跑不了**（cargo 链接失败）。

### 4.6 有没有防穿（CCD / bullet flag）？——有

**结论：有，而且是三件套齐全。**

1. **弹体打了 bullet 旗标**：【代码原文】`rollout.rs:344` `bd.bullet = true;`（在 `create_projectile_body` 里）。
   对应 JS `b2BodyDef.bullet=true`（`b714…js:5`）。
2. **旗标进入 body flags**：【代码原文】`box2d.rs:2337-2339`：
   ```rust
   if def.bullet {
       body.flags |= BODY_E_BULLET_FLAG;
   }
   ```
   （`BODY_E_BULLET_FLAG: u32 = 8;`，`box2d.rs:72`）
3. **contact 被标 continuous**：【代码原文】`box2d.rs:2763-2773`：
   ```rust
   if body_a_type != B2_DYNAMIC_BODY
       || body_a_bullet
       || body_b_type != B2_DYNAMIC_BODY
       || body_b_bullet
   {
       contact.flags |= CONTACT_E_CONTINUOUS_FLAG;
   } else {
       contact.flags &= !CONTACT_E_CONTINUOUS_FLAG;
   }
   ```
   （注释 `box2d.rs:2727-2730` 写明"`sensor` and `continuous` flags follow the same conditions"，即与 JS Box2D 同条件。）
4. **真跑了 TOI**：【代码原文】`World::step`（`box2d.rs:2583-2613`）里
   `self.solve(&step);`（`box2d.rs:2606`）与 `self.solve_toi(&step);`（`box2d.rs:2612`）；
   `solve_toi`（`box2d.rs:2924`）里筛 `if c.is_sensor() || !c.is_enabled() || !c.is_continuous() { continue; }`；
   `compute_toi`（`box2d.rs:2815-2831`）→ `b2_time_of_impact`（`box2d.rs:1297`），
   `input.tolerance = B2_LINEAR_SLOP;`（`box2d.rs:2827`）。

【解释，未验证】所以**弹对墙是 CCD 的**；而**候选坦克的 solid 夹具没打 bullet**（`create_fused_candidate` 里 `BodyDef` 没设 `bd.bullet`）
→ 坦克靠离散碰撞。这与 JS 一致（`createTankBody` 的 `tankBodyDef` 也没设 bullet）。

---

## 五、【解释】

> 本节**全部是推断**，不是定案。

1. **【解释，未验证】Rust 的定位是"物理 + 几何 + 评分加速器"，不是"完整宿主"。**
   8 个 ABI 里，4 个在线上热路径（`rollout` / `score_paths` / `rescore` / `set_frame_dt`），
   1 个是实验（`minimal_decide`），**2 个零调用者**（`build_wall_rects` / `sweep_danger_frames`），
   1 个是版本查询。没有任何"决策"落在 Rust —— 选路/生长全在 JS。

2. **【解释，未验证】Rust 侧现在唯一"活着"的弹种语义差异就是破片。**
   `LASER` 扫掠与 `HOMING_MISSILE` 制导**两侧都没做**，Rust 注释把卡点写得很清楚
   （`rollout.rs:327-337`、`vantage_sandbox.js:1109-1126`），
   且明确要求"要改必须 JS 与 Rust 同一轮落"。所以**要新增弹种，现在有明确的落点**。

3. **【解释，未验证】`tree.rs` 的实际风险不是"它在跑"，而是"它看起来像在跑"。**
   一个 1690 行的树、带完整 `#[cfg(test)]`、`pub mod tree;` 挂在 lib 根上，
   很容易被误当成"Rust 侧已有树，接个 ABI 就能用"。
   但从 §4.4 的证据看：它连 `minimal.rs` 都不复用，自 v68 之后**没有任何保真机制**。
   **动它之前必须先做一次"Rust tree vs JS tree 对拍"，否则等于新写。**

4. **【解释，未验证】"同一次落同一语义"的工程实现方式，在本仓库里已经有两处范本**：
   （a）**把 JS 侧的判据写成 Rust 文本断言**——`game_core/rust/diff_shrapnel_wall_stop.js:44-56`
   直接读 `rollout.rs` 源码字符串，断言 `dot < 0.999`、`len_sq <= 0.01`、`Shrapnel.hitMaze` 等字面量必须存在，
   其注释明说：`// 只测 JS 文本不够——上一版就是「JS 对、Rust 错」导致树按假绿选路。`
   （b）**真差分对拍**——`diff_rollout_bridge.js` 跑真 JS 融合世界 vs 真 wasm，逐帧比位置/角度，容差 `POS_TOL = 1e-9`。
   **这两条合起来才构成"同一次落同一语义"的可执行定义。**

5. **【解释，未验证】帧步长（`vt_set_frame_dt`）是"跨语言全局量"的第一个案例，它的处理方式可以当模板**：
   值域在 Rust 侧钳（`rollout.rs:26-29`）、JS 侧每次调用前同步（`vantage_sandbox.js:1057-1060`）、
   并有专门的回归脚本（`diff_rust_frame_dt_sync.js`）。
   代价：**JS 侧留下了两处 `frame * 0.02` 硬编码**（见 §六.3）。

---

## 六、未解决 / 矛盾

> **纪律**：读不懂、自相矛盾、或没有证据的，一律列在这里，**不猜**。

### 六.1 【未解决】本机跑不了 `cargo test` / 三个原生差分脚本 —— **Rust 单测全部处于"未验证"状态**

【实测】`cargo run --release --bin box2d_trace` 与 `node diff_box2d.js` 都失败，错误是**链接器**：

```
error: linking with `link.exe` failed: exit code: 1
  = note: link: missing operand after '@...\linker-arguments'
          Try 'link --help' for more information.
note: `link.exe` returned an unexpected error
note: in the Visual Studio installer, ensure the "C++ build tools" workload is selected
```

注意 `link: missing operand` / `link: extra operand` 是 **GNU coreutils 的 `link`** 的报错口径，不是 MSVC `link.exe`。
【解释，未验证】即 `PATH` 上先撞到了一个同名的别的 `link`。
**后果**：`box2d.rs` / `rollout.rs` / `rescore.rs` / `scoring.rs` / `tree.rs` / `minimal.rs` / `score_paths.rs` / `lib.rs`
里那 7 组 `#[cfg(test)] mod tests` **一次都没在这台机器上跑过**。
**`wasm32-unknown-unknown` 目标不需要宿主链接器，所以 wasm 能构建。**
这与 `AGENTS.md` 里"`diff_*` 因缺 MSVC 跑不了"的记录一致。

### 六.2 【矛盾】两个差分脚本的版本闸门写的是 10，而 `vt_version()` 返回 9

【代码原文】

- `game_core/rust/diff_rescore_bridge.js:284-286`
  ```js
  if (globalBridge.version() !== 10) {
    throw new Error('expected wasm ABI v9, got ' + globalBridge.version());
  }
  ```
- `game_core/rust/diff_score_paths_bridge.js:317-319`：**同样的 `!== 10` + 同样的 "expected wasm ABI v9" 文案**。

【实测】`node diff_rescore_bridge.js` → `Error: expected wasm ABI v9, got 9`（**在闸门处就退出，一行真比对都没跑**）；
`node diff_score_paths_bridge.js` 同。
而 `vt_version()` 返回 `9`（`lib.rs:26`）。
另外 `diff_rollout_rescore_edge.js:269` 写的是 `!== 9`（**能跑，且通过**），但它的报错文案写的是 `'expected ABI v10, got '` —— **文案与判据互相矛盾**。
⟹ **`vt_rescore_nodes` / `vt_score_paths` 目前没有任何可执行的差分对拍在保**。
【解释，未验证】看起来是"有人准备升 v10 但 Rust 没升（或反过来）"，**是脚本侧的窟窿，不是 Rust 侧的证据**。
**未解决：到底该是 9 还是 10，本文不下判断。**

### 六.3 【未解决】JS 把 Rust 样本的时间戳硬编码成 `frame * 0.02`

【代码原文】JS 融合路径（`FRAME = _frameDtSec`）：
- `vantage_sandbox.js:1617` `t: k * FRAME,`
- `vantage_sandbox.js:473` `t: i * FRAME,`（在 `simulateTankClone` 内，非融合路径）

Rust 快路径：
- `vantage_sandbox.js:1319` `return { t: frame * 0.02, x: s.x, y: s.y, rot: s.rot };`
- `vantage_sandbox.js:2347` `return { t: frame * 0.02, x: s.x, y: s.y, rot: s.rot };`

而 `t` 是被用到的：【代码原文】`vantage_sandbox.js:2656-2659`
`var lastSample = samples[samples.length - 1] || parentSimState.tank;` … `parentSimState.tGlobal + (lastSample.t || 0)`。
【解释，未验证】当 `_frameDtSec != 0.02` 时（v160 的整套前提就是"JS 会校准到约 0.0167 且已传进 Rust"），
**Rust 快路与 JS 融合路径给出的 `tGlobal` 增量会不同**（0.02/帧 vs 0.0167/帧）。
**未解决：这是不是已被上游消化（比如 `tGlobal` 只用于显示）、还是活的 bug —— 本文没有判定，需要一次实测。**

### 六.4 【未解决】`vt_rescore_nodes` 的验证世界不携带破片标记

见 §3.2。事实是清楚的（`rescore.rs` 里 `is_shrapnel` 只在测试里出现一次）；
**影响面未验证**（可能被 track 的 `alive=false` 提前兜住）。
详见 §3.2 的机制描述。**不许当成"已确认 bug"，也不许当成"没事"。**

### 六.5 【未解决】`vt_build_wall_rects` / `vt_sweep_danger_frames` 的语义没有对照物

- 两个 ABI **零调用者**（§三 表第 6/7 行）。
- `vt_build_wall_rects` 的文档说它"mirrors `getMazeWallEnv` before rectangle merging"（`lib.rs:766-767`），
  但 **JS 侧的 `getMazeWallEnv` 会做矩形合并**（`vantage_scoring.js:641`），
  Rust 明确说自己是"合并之前"的状态 ⟹ **两者本来就不同**，但**没有任何测试/对拍证明"合并前"就够了**。
- `vt_sweep_danger_frames` 的 `_node_rot` 参数**从不使用**（§2.6），
  而 JS 的对应物 `VantageTree._coarse` 里有 `nodeScoringCoarseBox` / `bulletsAffectNode` 一类带朝向的框（`vantage_tree.js:8213-8225`）。
  **未解决：这条粗筛的"无假阴"承诺在坦克旋转时会怎样？**（旋转的坦克外接圆 ≥ 任何朝向的矩形，所以点 + `max_move` 的界**可能**仍然保守；**但我没有验算**。）

### 六.6 【未解决】休眠（sleep）语义：JS 有、Rust 没有

`box2d.rs` 的 `sleep_time` 从不更新、`allow_sleep` 从不被读（§4.5）。
**未解决：融合世界缓存跨批复用时，JS 侧某颗弹会不会已经 asleep 而 Rust 侧还醒着？**
没有实测。

### 六.7 【未解决】`docs` 路径迁移把 `diff_shrapnel_wall_stop.js` 弄坏了

【实测】`node diff_shrapnel_wall_stop.js` 在
`docs\Vantage躲弹实现\待查清单-不确定项与判别方法.md` 处 ENOENT 退出。
而该文档实际在 `docs/Vantage躲弹实现/03-踩坑与待查/待查与审计/待查清单-不确定项与判别方法.md`。
这与 `docs/Vantage躲弹实现/README.md` 头部自述"**移动后那些路径已经失效**……**本次没有改它们**"是同一件事。
**⟹ 破片这条铁律目前的自动化守卫是【跑不起来】的**（只剩 `diff_shrapnel_no_bounce.js` / `diff_shrapnel_lifetime_zero.js` 还能跑）。

### 六.8 我**没有**做的事（明说，避免误读）

- 没有逐行读完 `box2d.rs`（3966 行）的求解器数学（`solve_velocity_constraints` / `position_solver_manifold` 等）。
  本文关于 box2d 的结论**只覆盖**：模块边界、有没有 CCD、有没有 raycast/joint/query/sleep、宽相复杂度、"按行镜像"的自述。
  **求解器的数值保真度我没有验证**（唯一的证据是 `diff_rollout_bridge.js` 在它的场景里 0 误差）。
- 没有逐行读完 `scoring.rs` 的遮蔽弧/车道/弹簧绳公式。
  本文只到"它镜像 `vantage_scoring.js` 的哪几个函数"这一层。
- 没有验证 `tree.rs` 与 `vantage_tree.js` **当前**是否仍然语义等价（§4.4 只证明了它"没在跑"，没证明它"对"）。
- 没有跑 `cargo test`（§六.1）。
- 没有改任何代码文件。

---

## 七、对"新功能要不要 JS + Rust 双落"的判断依据

### 7.1 铁律原文（先摆证据）

**JS 侧**（`game_core/js/vantage_sandbox.js:1089-1090`）：

```
//   铁律：动任何弹种，必须 JS 融合世界与 Rust（rollout.rs create_projectile_body）
//        同一次落同一语义，两边都留历史注释。
```

**项目级**（`AGENTS.md`，2026-10-07 第九轮定案 #6）：

> 「**除非你能保证 Rust 能完美替换 JS，否则还是得它兜底。**」
> **保留 JS 兜底，不翻转权威**。新功能按铁律 **JS + Rust 双落**（工作量按两遍算）。

### 7.2 从代码里能拿到的**判断依据**（不是我的偏好，是代码事实）

| 依据 | 代码位置 | 对"要不要双落"的含义 |
|---|---|---|
| **A. Rust 是"加速器/候选"，JS 融合是"死亡权威"** | 【代码原文】`vantage_sandbox.js:1048-1049`：`Rust 只是候选、JS 融合才是死亡权威，但**选路**用的是 Rust 结论——这就是"树显示安全却死了"的物理引擎错位来源。` | ⟹ **凡是会改变"选路"的功能，就必须双落**：单落 Rust 会让"选路"和"权威"分叉；单落 JS 会让树看不到它 |
| **B. 每条 Rust 快路都有 `null` 回退** | `simulateRustBatch` 里一串 `return null` 护栏（`vantage_sandbox.js:1243/1244/1245/1246/1249/1252/1255`）、`simulateTankBatchScored` 同（`2212-2229`）、`rescoreTankSamples` 同（`2381-2385`） | ⟹ **JS 侧是"必备件"**：新功能若只落 Rust、不回退，等于让回退路径丢功能（回退时行为静默变化） |
| **C. Rust 侧的"能力清单"是硬编码常量** | 弹种只有一位 `is_shrapnel`（`lib.rs:88-89`、`rollout.rs:105-125`）；`LASER`/`HOMING_MISSILE` 没有字段可传（`rollout.rs:327-337`） | ⟹ **加一个"弹种语义"= 改 ABI 签名 + 升 `vt_version` + 改 `diff_*` 闸门**；不是"改个 if" |
| **D. 跨语全局量只有 `frame_dt` 一个先例** | `lib.rs:28-44`、`rollout.rs:26-31`、`vantage_sandbox.js:1053-1060` | ⟹ 若新功能引入"整局不变的全局量"，应仿它：**Rust 侧 setter + 值域钳 + JS 每批同步 + 专门回归脚本** |
| **E. "同语义"在本仓库已有可执行定义** | （a）源码文本断言：`diff_shrapnel_wall_stop.js:44-56`；（b）逐帧数值对拍：`diff_rollout_bridge.js`（`POS_TOL = 1e-9`，实测 0 误差） | ⟹ **"双落"完成的判据 = 同时有 (a) 两侧判据字面同源 + (b) 一份能跑通的差分对拍**；**只有注释相同不算** |
| **F. 有 2 个 ABI 零调用者、1 个 ABI 默认关** | `build_wall_rects` / `sweep_danger_frames` 无调用者；`minimal_decide` 受 `tree.cfg.rustMinimalEnabled` 门控（`vantage_tree.js:4387`） | ⟹ **"先落 Rust 再慢慢切"在本仓库是失败模式**：接口会烂在那里，且没人发现 |
| **G. 对拍本身会烂** | §六.2（版本闸门卡死）、§六.7（文档路径失效） | ⟹ 双落之后**必须挂一个能跑的守卫**；否则下一次 `vt_version` 一动，"两边同语义"就只剩注释 |

### 7.3 三条可操作的判据（**我的归纳**，供主人裁）

> 以下三条是【解释，未验证】的归纳，**不是主人定案**。权威序位仍是：主人原话 ＞ 权威版 ＞ 其它。

1. **它会不会改变"选路/生长"看到的东西？**
   **会** → **必须双落**（依据 A）。
   **不会，只影响"权威判定"** → **至少 JS 必须落**，Rust 可后补，但必须让 Rust 回退（依据 B）。
2. **它要不要新的跨语言字段？**
   **要** → **先定 ABI（签名 + 版本 + 闸门 + 对拍）再写实现**（依据 C、E、G）。
   **不要**（只是既有字段换算法）→ 仍要跑一份对拍，且**两侧注释都要写清"另一侧在哪一行"**（铁律原话）。
3. **它今天有没有一条能自动跑的对拍？**
   **没有** → **先补一条**。§六.2 / §六.7 说明：**没有守卫的"双落"会在几周内退化成"两边各写各的"**。

### 7.4 一个必须写进结论的坑（针对本文任务书里的措辞）

任务书与铁律都写「Rust（`rollout.rs create_projectile_body`）」——
【实测】**这个函数确实存在**，在 `game_core/rust/vantage_core/src/rollout.rs:338`，
但它 `pub(crate)`、**不是 ABI**；它只被 `rollout.rs` 内部三处调用（`424` / `433` / `560`）。
**⟹ 走 ABI 给 Rust 喂弹种，走的是 `BulletInput.is_shrapnel` 这一位（`rollout.rs:105-125`），不是"改 `create_projectile_body`"。**
要落一个新弹种，**改动面 = `BulletInput` 字段 + `lib.rs`/`score_paths.rs` 的 ABI 参数 + `vt_version` + JS `_projProfile` + JS 摆放分支 + `diff_*` 守卫**，
**不是**在 `create_projectile_body` 里加个 if。这条差别值得单独记一笔。
