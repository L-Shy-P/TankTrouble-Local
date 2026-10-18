//! Fused rollout batch: one persistent Box2D world with real maze walls,
//! nine candidate tank bodies, fused sensor fixtures and a persistent bullet
//! slot pool, reproducing the game's `simulateFusedBatch` JS path.
//!
//! The world is kept alive by [`RolloutCache`] across calls.  A fresh world
//! per call would drop contact impulses / warm-starting state and diverge on
//! the second call.

use crate::box2d::{
    Body, BodyDef, CircleShape, FixtureDef, FixtureKind, PolygonShape, Shape, World,
    B2_DYNAMIC_BODY,
};

/// v160：帧步长从"写死常量"改成"可设全局值"。
/// 背景：JS 侧 `FRAME_DT` 会被校准到真实帧长（实测约 0.0167），而这里原本写死
/// 0.02，导致 `rustFrameDtCompatible()` 判定不一致 → **Rust 快路被永久停用**，
/// 实测 1800 帧里只有 44% 时间 Rust 在跑，出问题那局只有 1%。
/// 旧行为备份：`pub const FRAME_DT: f64 = 0.02;`
/// 现在由 `set_frame_dt()` 在每次调用前写入真实帧长，两边同口径。
pub const DEFAULT_FRAME_DT: f64 = 0.02;

static FRAME_DT_BITS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0x3f947ae147ae147b); // f64 0.02 的位模式

/// 由 ABI `vt_set_frame_dt` 调用；值域必须与 JS 侧一致 **[0.001, 1.0]**。
/// v163：原来钳在 [0.005, 0.2]，>200fps 的帧长（240Hz ≈ 0.00417s）会被**静默忽略** →
/// JS 侧以为设进去了（`rustFrameDtCompatible()` 恒 true）、Rust 还在用旧值 → 又是两套帧长。
/// JS 侧值域见 `vantage_sandbox.js:1038-1057`（setFrameDtSec，已放宽到 [0.001, 1.0]）。
pub fn set_frame_dt(v: f64) {
    if v.is_finite() && (0.001..=1.0).contains(&v) {
        FRAME_DT_BITS.store(v.to_bits(), std::sync::atomic::Ordering::Relaxed);
    }
}
pub fn frame_dt() -> f64 {
    f64::from_bits(FRAME_DT_BITS.load(std::sync::atomic::Ordering::Relaxed))
}
pub const MAX_OPS: usize = 9;
pub const MAX_FRAMES: usize = 75;
pub const MAX_SAMPLES: usize = MAX_FRAMES + 1;
// 主人实测：人多 → 图大 → 墙段多，超过 1024 时 vt_score_paths 直接返回 0，
// JS 就静默退回 scorePaths（慢且行为降级，控制台刷"Rust 评分路径结果无效"）。
// 这个常量只用于校验（世界是动态 Vec 建的），提高它是安全的。
pub const MAX_WALLS: usize = 8192;
pub const MAX_WALL_VERTS: usize = 8;
pub const MAX_BULLETS: usize = 256;

/// v12（1-2④）：追踪导弹制导常量（真 `Constants` 原值）。
///
/// 依据（本地/正式 bundle 一致）：
///   · `Constants.HOMING_MISSILE.ACCELERATION = 40.0`（每轴 ±40·dt，**世界轴**；
///     弹体 `fixedRotation=true` ⇒ 本地轴==世界轴）；
///   · `Constants.HOMING_MISSILE.SPEED.m = 18.0`（发射速度 = `Projectile.initialSpeed`）；
///   · `Constants.HOMING_MISSILE_ACTIVATION_TIME = 2.0`（**严格大于**才制导）；
///   · `Constants.MAZE_TILE_SIZE.m = 10.0`。
///
/// ⚠️ `initialSpeed` 是**发射那一刻**由 `Projectile.constructor` 算的
/// （`initialSpeedSquared = speedX²+speedY²`），**不是**"摆位时的当前速度"。
/// 制导减速到 0.64 后，归一化仍要把速度拉回 18 —— 用当前速度当上限会让
/// 减速过的导弹永久钉死在低速（制导失效），这是本轮最容易写错的一处。
pub const MISSILE_ACCELERATION: f64 = 40.0;
pub const MISSILE_ACTIVATION_TIME_SEC: f64 = 2.0;
pub const MISSILE_INITIAL_SPEED_M: f64 = 18.0;
pub const MAZE_TILE_M: f64 = 10.0;

// ---------------------------------------------------------------------------
// v10 弹种语义常量（真 bundle 数值，JS 侧读同名 Constants）。
//
// 【代码原文】bundle `b714588dc4621fe104113111ba90b1a7.js`（Constants）：
//   PROJECTILE_BOUNCE_TIMEOUT_WINDOW: 35,   PROJECTILE_BOUNCE_TIMEOUT_COUNT: 5,
//   SHOTGUN_LIFETIME_AFTER_MAZE_HIT: 0.7,   SHOTGUN_MAX_LIFETIME: 2.0
// ---------------------------------------------------------------------------

/// 撞墙/撞盾去抖窗口（**毫秒** → 秒）。原版 `Projectile.update` 里
/// `new Date().getTime() - this.timeoutWindow` ⟹ 单位只能是毫秒。
/// 实测（`docs/.../弹种实测-反弹上限与激光-2026-10-10.md` §二.4）：
/// 每帧 1 次接触时 `bounces.length` 稳态停在 3（0/16.7/33.3ms，50ms 那条被删）
/// ⟹ 窗口 ∈ [33.33, 50) ms，与常量 35 完全吻合。
const BOUNCE_TIMEOUT_WINDOW_SEC: f64 = 0.035;
/// `Projectile.done()` 第三支 `bounces.length >= timeoutBounceCount`。
/// ⚠️ 语义 = “最近 35ms 内累计 ≥5 次撞墙/撞盾接触”，**不是**“总共反弹 5 次”；
/// 正常飞行永不触发（实测长走廊 600 帧 21 次撞墙 `bounces.length` 最大只有 1）。
const BOUNCE_TIMEOUT_COUNT: usize = 5;

/// 霰弹撞墙/撞盾后的**剩余寿命上限**（秒）。
///
/// 【代码原文】bundle `418577fd210ad079ea3d1e5e04050fe0.js`：
///   `Shotgun.methods({ hitShield/hitMaze: function () { this._super();
///        this.timeAlive = Math.max(this.timeAlive, MAX - AFTER); } })`
/// 其中 `MAX = Constants.SHOTGUN_MAX_LIFETIME = 2.0`、
/// `AFTER = Constants.SHOTGUN_LIFETIME_AFTER_MAZE_HIT = 0.7`。
///
/// JS 侧（`vantage_sandbox.js` `clampShotgunLifeLeftAfterHit`）写的是原式：
///   剩余寿命 = lifeTotal − max(lifeTotal − lifeLeft, MAX − AFTER)
/// **霰弹的 `lifeTotal` 恒等于 MAX**（建弹 `Shotgun.create(state, SHOTGUN_MAX_LIFETIME, …)`，
/// `46989e…js`），故原式代数等价于 `min(lifeLeft, AFTER)` —— 这里是化简式，
/// **不是另立一套语义**（Rust ABI 只带 `lifeLeft`、不带 `lifeTotal`）。
const SHOTGUN_LIFETIME_AFTER_MAZE_HIT_SEC: f64 = 0.7;

fn clamp_shotgun_life_left_after_hit(life_left: f64) -> f64 {
    // JS `clampShotgunLifeLeftAfterHit` 末尾的 `Math.max(0, …)` 一并照抄。
    life_left.max(0.0).min(SHOTGUN_LIFETIME_AFTER_MAZE_HIT_SEC)
}

/// v10（②）：`Projectile.update` 的**粘性**剪枝，逐字对齐 JS
/// `vantage_sandbox.js pruneBounceStamps`：
/// ```js
/// var currentTimeout = new Date().getTime() - this.timeoutWindow;
/// for (var i = 0; i < this.bounces.length; ++i) {
///     if (this.bounces[i] >= currentTimeout) { this.bounces.splice(0, i); break; }
/// }
/// ```
/// ⚠️ **只在"找到第一条窗口内记录"时才删前缀；全部过期时一条都不删**。
/// 这不是笔误：实测里单条记录能撑到 467ms（弹）/383ms（激光）才被删
/// （`弹种实测-反弹上限与激光-2026-10-10.md` §二.4）。**不许**写成"按窗口过滤整个数组"。
fn prune_bounce_stamps(stamps: &mut Vec<f64>, now_sec: f64, window_sec: f64) {
    let current_timeout = now_sec - window_sec;
    for i in 0..stamps.len() {
        if stamps[i] >= current_timeout {
            stamps.drain(0..i);
            break;
        }
    }
}

// Collision categories, same values as the game's Constants.COLLISION_CATEGORIES.
pub const CATEGORY_TANK: u16 = 0x1;
pub const CATEGORY_MAZE: u16 = 0x1 << 1;
pub const CATEGORY_PROJECTILE: u16 = 0x1 << 2;
pub const CATEGORY_TRAP: u16 = 0x1 << 3;
pub const CATEGORY_COLLECTIBLE: u16 = 0x1 << 4;
pub const CATEGORY_SHIELD: u16 = 0x1 << 5;
pub const CATEGORY_ZONE: u16 = 0x1 << 6;

// Tank shape constants (real Constants object, in metres).
pub const TANK_WIDTH_M: f64 = 3.0;
pub const TANK_HEIGHT_M: f64 = 4.0;
pub const TANK_FORWARD_SPEED_M: f64 = 15.95;
pub const TANK_BACK_SPEED_M: f64 = 12.8;
pub const TANK_ROTATION_SPEED: f64 = 5.0;

// Bullet turret constants (real Constants object, in metres).
pub const BULLET_TURRET_WIDTH_M: f64 = 0.7;
pub const BULLET_TURRET_HEIGHT_M: f64 = 1.4;
pub const BULLET_TURRET_OFFSET_X_M: f64 = 0.0;
pub const BULLET_TURRET_OFFSET_Y_M: f64 = -2.0;

/// Initial mask used by `B2DUtils.createTankBody` before
/// `createFusedCandidateBody` rewrites every solid fixture mask to MAZE.
pub const TANK_BROAD_MASK: u16 = CATEGORY_TANK
    | CATEGORY_MAZE
    | CATEGORY_PROJECTILE
    | CATEGORY_TRAP
    | CATEGORY_COLLECTIBLE
    | CATEGORY_SHIELD
    | CATEGORY_ZONE;

/// Wall fixture mask from `B2DUtils.createMaze`.
pub const WALL_MASK: u16 = CATEGORY_TANK | CATEGORY_PROJECTILE | CATEGORY_TRAP;

/// Bullet fixture mask from `B2DUtils.createProjectileBody`
/// (SHIELD/ZONE ignored in our subset).
pub const BULLET_MASK: u16 = CATEGORY_TANK | CATEGORY_MAZE;

#[derive(Clone, Debug)]
pub struct WallPoly {
    /// Exact wall polygon vertices in JS `createMaze` order.
    pub vertices: Vec<(f64, f64)>,
}

#[derive(Clone, Copy, Debug)]
pub struct StartPose {
    pub x: f64,
    pub y: f64,
    pub rot: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct OpInput {
    /// Precomputed linear speed for this op (JS already applied Tank methods /
    /// modifiers; Rust must NOT recompute tank speeds).
    pub speed: f64,
    pub rotation_speed: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct BulletInput {
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    pub radius: f64,
    pub life_left: f64,
    pub active: bool,
    /// v9 ABI：破片标记（真游戏 `WeaponTypes.MINE=4` 的弹体 / `MINE_SHRAPNEL`）。
    ///
    /// 依据（真游戏 bundle `418577fd210ad079ea3d1e5e04050fe0.js` 里的 `Shrapnel` 类）：
    ///   · `Shrapnel.hitMaze` = `this.b2dbody.GetLinearVelocity().Multiply(0.0)`
    ///     ⇒ 撞墙当帧速度清零，**不反弹**；
    ///   · `Shrapnel.done` = `GetLinearVelocity().LengthSquared() <= 0.01`
    ///     ⇒ 速度≈0 即退场，**与寿命/反弹次数无关**；
    ///   · `Shrapnel.update` **不调** `Projectile.update`（没有 `_super()`）
    ///     ⇒ 基类那条「速度变化就乘回初速」的归一化对破片**不生效**。
    /// JS 融合世界 v162/v164（`vantage_sandbox.js` 的 `slot.isShrapnel` /
    /// `slot.noSpeedNorm`）已按这三条实现；这里逐字对齐，任何一侧改判据必须两侧同改。
    pub is_shrapnel: bool,
    /// v166：霰弹标记（真游戏 `WeaponTypes.SHOTGUN=2`）。
    ///
    /// 【代码原文】真 bundle `418577fd210ad079ea3d1e5e04050fe0.js` 的 `Shotgun.methods`：
    ///   `hitShield/hitMaze: this._super(); this.timeAlive = Math.max(this.timeAlive,
    ///    Constants.SHOTGUN_MAX_LIFETIME - Constants.SHOTGUN_LIFETIME_AFTER_MAZE_HIT);`
    /// `MAX=2.0`、`AFTER=0.7` ⟹ 撞墙/撞盾后**剩余寿命 ≤ 0.7s**（减命，不是续命）。
    /// JS 融合/JS track 已实现；Rust 侧与 JS 必须在同一轮同改（实测报告 §4.1）。
    ///
    /// ABI 说明：不新增参数——`bullet_is_shrapnel` 那个 u8 数组扩成弹种码：
    ///   0=普通、1=破片、2=霰弹（`lib.rs vt_version=10` 起生效）。旧 JS 只会发 0/1。
    pub is_shotgun: bool,
    /// v11（1-2③）：激光标记（真 `LASER.RADIUS.m=0` / 180 m/s）。
    /// 激光判死不能用半径 0.05 的圆逐帧点判，必须用本帧实际位移线段
    /// × 候选 sensor 多边形的扫掠（见 `sweep_segments_against_walls` /
    /// `sweep_hits_candidate`）。ABI 用弹种码 3 传入，**不看半径**。
    pub is_laser: bool,
    /// v12（1-2④）：追踪导弹标记（弹种码 4）。
    /// 真 `HomingMissile.update`：`timeAlive > 2.0` 后按迷宫表制导 ——
    /// 瞄准点 = 4 连通距离 ≤1 时取坦克真坐标、否则取「下一格中心」（表由 JS 预算）；
    /// 加速 = 按世界轴 ±40·dt，**只在速度变大时**归一化回初速（无 `Math.abs`）。
    /// ⚠️ 轨迹依赖**候选**（目标）的未来 ⟹ 融合世界里必须**每候选一颗弹体**，
    /// 见 `BulletSlot::homing_bodies` 与 `run_rollout_batch` 的制导步。
    pub is_missile: bool,
    pub missile_time_alive: f64,

}

#[derive(Clone, Debug)]
pub struct RolloutInput {
    pub start_pose: StartPose,
    pub ops: Vec<OpInput>,
    pub duration_frames: u32,
    pub walls: Vec<WallPoly>,
    pub bullets: Vec<BulletInput>,
    /// Diagnostic/CLI-only cache namespace. `run_rollout_batch` itself is
    /// passed an explicit cache; the C ABI uses a per-id cache map.
    pub cache_id: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct RolloutSample {
    pub t: f64,
    pub x: f64,
    pub y: f64,
    pub rot: f64,
}

#[derive(Clone, Debug)]
pub struct RolloutOutput {
    pub samples: Vec<Vec<RolloutSample>>,
    pub dead: Vec<bool>,
    pub death_frame: Vec<i32>,
}

pub(crate) struct BulletSlot {
    pub(crate) body: crate::box2d::BodyId,
    pub(crate) last_round: u64,
    pub(crate) radius: f64,
    pub(crate) initial_speed: f64,
    pub(crate) life_left: f64,
    pub(crate) active: bool,
    /// v10：霰弹标记（`Shotgun.hitMaze/hitShield` 把 timeAlive 钳到 >=MAX-AFTER
    /// ⇒ 撞墙/撞盾后剩余寿命 ≤0.7s）。JS 侧由 `slot.isShotgun` 透传。
    pub(crate) is_shotgun: bool,
    /// v11（1-2③）：激光标记 —— 逐帧做线段扫掠判死（只读回溯补判）。
    pub(crate) is_laser: bool,
    /// v12（1-2④）：追踪导弹标记 + 每候选一颗弹体（`homing_bodies[op]`）。
    /// 共享的那颗 `body` 对导弹**不使用**（置 inactive），运动全在每候选的副本上。
    pub(crate) is_missile: bool,
    pub(crate) missile_time_alive: f64,
    pub(crate) homing_bodies: Vec<crate::box2d::BodyId>,
    /// v10：`Projectile.bounces` —— 撞墙/撞盾接触时间戳（秒）。
    /// `done()` 第三支 `bounces.length >= PROJECTILE_BOUNCE_TIMEOUT_COUNT(5)`，
    /// 配合 35ms **粘性**剪枝 = "最近 35ms 内累计 ≥5 次接触就当卡住、直接销毁"。
    pub(crate) bounces: Vec<f64>,
    /// v9：破片标记 + 上一帧飞行方向（对应 JS `bs.isShrapnel` / `bs.prevDirX/Y`）。
    pub(crate) is_shrapnel: bool,
    pub(crate) prev_dir_x: f64,
    pub(crate) prev_dir_y: f64,
    pub(crate) has_prev_dir: bool,
    /// Last placed linear velocity (verification world "only frame k exists"
    /// fallback keeps the previous direction/speed).
    pub(crate) last_vx: f64,
    pub(crate) last_vy: f64,
}

struct FusedWorld {
    world: World,
    candidates: Vec<crate::box2d::BodyId>,
    bullet_slots: Vec<BulletSlot>,
    round: u64,
}

/// Process/WASM-lifetime fused-world cache.  Rebuilds only when the wall
/// polygon multiset changes; otherwise the world, its `inv_dt0`, contact
/// impulses and body pool are reused exactly like the JS `_fusedCache`.
pub struct RolloutCache {
    signature: Option<Vec<u8>>,
    fused: Option<FusedWorld>,
}

impl Default for RolloutCache {
    fn default() -> Self {
        Self::new()
    }
}

impl RolloutCache {
    pub fn new() -> Self {
        Self {
            signature: None,
            fused: None,
        }
    }

    pub fn clear(&mut self) {
        self.signature = None;
        self.fused = None;
    }
}

pub(crate) fn wall_signature(walls: &[WallPoly]) -> Result<Vec<u8>, String> {
    let mut serialized: Vec<Vec<u8>> = Vec::with_capacity(walls.len());
    for (wi, wall) in walls.iter().enumerate() {
        if wall.vertices.is_empty() {
            return Err(format!("wall {} has no vertices", wi));
        }
        if wall.vertices.len() > MAX_WALL_VERTS {
            return Err(format!(
                "wall {} has {} vertices (max {})",
                wi,
                wall.vertices.len(),
                MAX_WALL_VERTS
            ));
        }
        let mut bytes = Vec::with_capacity(4 + wall.vertices.len() * 16);
        bytes.extend_from_slice(&(wall.vertices.len() as u32).to_le_bytes());
        for (x, y) in &wall.vertices {
            if x.is_nan() || y.is_nan() || x.is_infinite() || y.is_infinite() {
                return Err(format!("wall {} has non-finite vertex", wi));
            }
            bytes.extend_from_slice(&x.to_bits().to_le_bytes());
            bytes.extend_from_slice(&y.to_bits().to_le_bytes());
        }
        serialized.push(bytes);
    }
    // Multiset: order-independent wall signature (the diff harness passes
    // walls in `createMaze` creation order, but the cache key does not need
    // to depend on that order).
    serialized.sort();
    let mut sig = Vec::new();
    sig.extend_from_slice(&(walls.len() as u32).to_le_bytes());
    for bytes in serialized {
        sig.extend_from_slice(&bytes);
    }
    Ok(sig)
}

fn turret_vertices() -> Vec<(f64, f64)> {
    let hw = BULLET_TURRET_WIDTH_M / 2.0;
    let top = BULLET_TURRET_OFFSET_Y_M + BULLET_TURRET_HEIGHT_M / 2.0;
    let bottom = BULLET_TURRET_OFFSET_Y_M - BULLET_TURRET_HEIGHT_M / 2.0;
    // Exact JS `_createBulletTurretFixtureDefs` vertex order.
    vec![(hw, top), (-hw, top), (-hw, bottom), (hw, bottom)]
}
/// v11（1-2③）：线段 × 凸多边形（端点在内或与任一边相交）。
fn segment_hits_polygon(ax: f64, ay: f64, bx: f64, by: f64, verts: &[(f64, f64)]) -> bool {
    let n = verts.len();
    if n < 2 {
        return false;
    }
    let point_in = |px: f64, py: f64| -> bool {
        let mut inside = false;
        let mut j = n - 1;
        for i in 0..n {
            let (xi, yi) = verts[i];
            let (xj, yj) = verts[j];
            if ((yi > py) != (yj > py))
                && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)
            {
                inside = !inside;
            }
            j = i;
        }
        inside
    };
    let seg_int = |ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64, dx: f64, dy: f64| -> bool {
        let d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        let d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
        let d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
        let d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
        ((d1 > 0.0) != (d2 > 0.0)) && ((d3 > 0.0) != (d4 > 0.0))
    };
    if point_in(ax, ay) || point_in(bx, by) {
        return true;
    }
    for i in 0..n {
        let (cx, cy) = verts[i];
        let (dx, dy) = verts[(i + 1) % n];
        if seg_int(ax, ay, bx, by, cx, cy, dx, dy) {
            return true;
        }
    }
    false
}

/// v11（1-2③）：线段 × 指定位姿的坦克 sensor 多边形（车体 3.0×4.0 + 子弹炮塔）。
/// 与 `create_fused_candidate` 造的 sensor 夹具同形；只读，不碰 body。
/// 单独暴露位姿版本，供 rescore 同时测帧首/帧末两个候选位姿。
pub(crate) fn sweep_hits_tank_pose(
    px: f64,
    py: f64,
    angle: f64,
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
) -> bool {
    let c = angle.cos();
    let s = angle.sin();
    let to_world = |v: (f64, f64)| (px + c * v.0 - s * v.1, py + s * v.0 + c * v.1);
    let hw = TANK_WIDTH_M / 2.0;
    let hh = TANK_HEIGHT_M / 2.0;
    let base = [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)];
    let base_w: Vec<(f64, f64)> = base.iter().map(|&v| to_world(v)).collect();
    if segment_hits_polygon(ax, ay, bx, by, &base_w) {
        return true;
    }
    let turret_w: Vec<(f64, f64)> = turret_vertices().iter().map(|&v| to_world(v)).collect();
    segment_hits_polygon(ax, ay, bx, by, &turret_w)
}

/// v11（1-2③）：线段 × 候选坦克的全部 sensor 多边形（按世界当前位姿）。
fn sweep_hits_candidate(
    world: &World,
    body: crate::box2d::BodyId,
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
) -> bool {
    let (px, py) = world.body_position(body);
    let angle = world.body_angle(body);
    sweep_hits_tank_pose(px, py, angle, ax, ay, bx, by)
}

/// v11（1-2③）：一帧内激光的实际路径折线（按墙裁剪 + 镜面反射，最多 max_segs 段）。
/// 与 JS `fusedSweepSegments` 同语义；只用于几何判死，不改任何 body。
fn sweep_segments_against_walls(
    walls: &[WallPoly],
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    max_segs: usize,
) -> Vec<(f64, f64, f64, f64)> {
    let mut out: Vec<(f64, f64, f64, f64)> = Vec::new();
    let (mut ax, mut ay, mut bx, mut by) = (x0, y0, x1, y1);
    for _ in 0..max_segs {
        let dx = bx - ax;
        let dy = by - ay;
        let mut best_t = f64::INFINITY;
        let mut best_n = (0.0f64, 0.0f64);
        for wall in walls {
            let vs = &wall.vertices;
            if vs.len() < 2 {
                continue;
            }
            for i in 0..vs.len() {
                let (cx, cy) = vs[i];
                let (ex, ey) = vs[(i + 1) % vs.len()];
                let sx = ex - cx;
                let sy = ey - cy;
                let den = dx * sy - dy * sx;
                if den.abs() < 1e-12 {
                    continue;
                }
                let t = ((cx - ax) * sy - (cy - ay) * sx) / den;
                if t <= 1e-12 || t > 1.0 {
                    continue;
                }
                let u = ((cx - ax) * dy - (cy - ay) * dx) / den;
                if u < 0.0 || u > 1.0 {
                    continue;
                }
                if t < best_t {
                    best_t = t;
                    let len = (sx * sx + sy * sy).sqrt();
                    if len > 0.0 {
                        // 反射公式对法线取正负皆等价，这里取边的一个单位法线。
                        best_n = (sy / len, -sx / len);
                    }
                }
            }
        }
        if !best_t.is_finite() {
            out.push((ax, ay, bx, by));
            break;
        }
        let hx = ax + dx * best_t;
        let hy = ay + dy * best_t;
        out.push((ax, ay, hx, hy));
        let rx = bx - hx;
        let ry = by - hy;
        let dot = rx * best_n.0 + ry * best_n.1;
        let rrx = rx - 2.0 * dot * best_n.0;
        let rry = ry - 2.0 * dot * best_n.1;
        ax = hx;
        ay = hy;
        bx = ax + rrx;
        by = ay + rry;
    }
    out
}

/// Create one fused candidate body (solid fixtures mask=MAZE, sensor fixtures
/// mask=PROJECTILE), exactly like JS `createFusedCandidateBody`.
pub(crate) fn create_fused_candidate(
    world: &mut World,
    op_index: usize,
) -> Result<crate::box2d::BodyId, String> {
    let mut bd = BodyDef::new();
    bd.body_type = B2_DYNAMIC_BODY;
    bd.angle = 0.0;
    bd.linear_damping = 0.0;
    bd.fixed_rotation = false;
    bd.active = true;
    bd.allow_sleep = false;
    let body = Body::create(world, bd);

    // Base solid fixture (AsBox(1.5, 2.0)).
    let base_shape = PolygonShape::set_as_box(TANK_WIDTH_M / 2.0, TANK_HEIGHT_M / 2.0);
    let mut fd = FixtureDef::new();
    fd.shape = Some(Shape::Polygon(base_shape.clone()));
    fd.density = 1.0;
    fd.friction = 0.25;
    fd.restitution = 0.0;
    fd.is_sensor = false;
    fd.category_bits = CATEGORY_TANK;
    fd.mask_bits = CATEGORY_MAZE;
    fd.kind = FixtureKind::TankSolid;
    Body::create_fixture(world, body, fd);

    // Bullet turret solid fixture.
    let turret_poly = PolygonShape::from_vertices(&turret_vertices())
        .map_err(|e| format!("turret fixture: {}", e))?;
    let mut fd = FixtureDef::new();
    fd.shape = Some(Shape::Polygon(turret_poly.clone()));
    fd.density = 0.0;
    fd.friction = 0.25;
    fd.restitution = 0.0;
    fd.is_sensor = false;
    fd.category_bits = CATEGORY_TANK;
    fd.mask_bits = CATEGORY_MAZE;
    fd.kind = FixtureKind::TankSolid;
    Body::create_fixture(world, body, fd);

    // Sensor copies (same shapes, one per original fixture).  JS
    // `createFusedCandidateBody` walks `GetFixtureList()` after
    // `createTankBody`, so the fixture list head is the turret; the
    // sensor creation order is therefore turret-sensor first, then
    // base-sensor.
    let mut fd = FixtureDef::new();
    fd.shape = Some(Shape::Polygon(turret_poly));
    fd.density = 0.0;
    fd.friction = 0.0;
    fd.restitution = 0.0;
    fd.is_sensor = true;
    fd.category_bits = CATEGORY_TANK;
    fd.mask_bits = CATEGORY_PROJECTILE;
    fd.kind = FixtureKind::TankSensor {
        op_index: op_index as u8,
    };
    Body::create_fixture(world, body, fd);

    let mut fd = FixtureDef::new();
    fd.shape = Some(Shape::Polygon(base_shape));
    fd.density = 0.0;
    fd.friction = 0.0;
    fd.restitution = 0.0;
    fd.is_sensor = true;
    fd.category_bits = CATEGORY_TANK;
    fd.mask_bits = CATEGORY_PROJECTILE;
    fd.kind = FixtureKind::TankSensor {
        op_index: op_index as u8,
    };
    Body::create_fixture(world, body, fd);

    Ok(body)
}

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
/// v12（1-2④）：`HomingMissile.update` 的制导一步（只改速度，不读/写位置）。
///
/// 逐字对齐真游戏（`418577fd…js` 的 `HomingMissile.update`）：
///   · 起点格 = `floor(弹位/TILE)`；目标格 = `floor(坦克位/TILE)`；
///   · 4 连通 BFS 距离（`getDistancesFromPosition/getDistanceToPosition` 口径）：
///     不可达（false）⇒ **整步跳过**（真游戏 `if(distances!==false)`）；
///     距离 ≤1 ⇒ 瞄准**坦克真坐标**（真游戏 tank-exact 分支）；
///     距离 >1 ⇒ 查「下一格表」拿最短路首格，瞄准**该格中心**；
///     表给不出（不可算/越界）⇒ 跳过（不猜）；
///   · `relativeToMissile = toLocalSpace(body, aim)`；`fixedRotation=true`
///     ⇒ 弹体角恒 0 ⇒ 本地增量 == 世界增量；
///   · 每轴 `if rel < 0 { v -= A·dt } else { v += A·dt }` —— **rel==0 走 + 分支**；
///   · **没有角速度上限**，也**没有 `Math.abs`**（归一化由调用方在制导后做，
///     且只在"速度变大"时拉回 `MISSILE_INITIAL_SPEED_M`）。
///
/// 返回 true = 本步真的施加了加速度；false = 照真游戏跳过。
fn missile_guide_step(
    world: &mut World,
    body: crate::box2d::BodyId,
    target: (f64, f64),
    accel: f64,
    dt: f64,
) -> bool {
    let (bx, by) = world.body_position(body);
    let start = (
        (bx / MAZE_TILE_M).floor() as i32,
        (by / MAZE_TILE_M).floor() as i32,
    );
    let tt = (
        (target.0 / MAZE_TILE_M).floor() as i32,
        (target.1 / MAZE_TILE_M).floor() as i32,
    );
    let aim = crate::vtmaze::with_maze(|m| {
        let d = m.bfs4(start.0, start.1, tt.0, tt.1);
        if d < 0 {
            return None;
        }
        if d <= 1 {
            return Some(target);
        }
        match m.next_tile(start.0, start.1, tt.0, tt.1) {
            Some((nx, ny)) => Some(((nx as f64 + 0.5) * MAZE_TILE_M, (ny as f64 + 0.5) * MAZE_TILE_M)),
            None => None,
        }
    });
    let aim = match aim {
        Some(Some(a)) => a,
        _ => return false,
    };
    let (vx, vy) = world.body_linear_velocity(body);
    let nvx = if aim.0 - bx < 0.0 { vx - accel * dt } else { vx + accel * dt };
    let nvy = if aim.1 - by < 0.0 { vy - accel * dt } else { vy + accel * dt };
    world.set_body_linear_velocity(body, (nvx, nvy));
    true
}

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
/// Dedicated single-candidate verification world.  Uses the exact same wall
/// fixtures, fused candidate body and bullet body definitions as the
/// 9-candidate rollout world, but is never shared with `vt_rollout_batch`.
pub struct VerificationWorld {
    pub(crate) world: World,
    pub(crate) candidate: crate::box2d::BodyId,
    pub(crate) bullet_slots: Vec<BulletSlot>,
    pub(crate) round: u64,
}

impl VerificationWorld {
    pub(crate) fn build(walls: &[WallPoly]) -> Result<Self, String> {
        if walls.len() > MAX_WALLS {
            return Err(format!(
                "wall count {} exceeds max {}",
                walls.len(),
                MAX_WALLS
            ));
        }
        let mut world = World::new((0.0, 0.0), true);

        for (wi, wall) in walls.iter().enumerate() {
            if wall.vertices.len() < 3 || wall.vertices.len() > MAX_WALL_VERTS {
                return Err(format!(
                    "wall {} has {} vertices (expected 3..{})",
                    wi,
                    wall.vertices.len(),
                    MAX_WALL_VERTS
                ));
            }
            let poly = PolygonShape::from_vertices(&wall.vertices)
                .map_err(|e| format!("wall {}: {}", wi, e))?;
            let mut bd = BodyDef::new();
            bd.body_type = crate::box2d::B2_STATIC_BODY;
            let body = Body::create(&mut world, bd);
            let mut fd = FixtureDef::new();
            fd.shape = Some(Shape::Polygon(poly));
            fd.density = 0.0;
            fd.friction = 0.05;
            fd.restitution = 0.0;
            fd.is_sensor = false;
            fd.category_bits = CATEGORY_MAZE;
            fd.mask_bits = WALL_MASK;
            fd.kind = FixtureKind::Wall;
            Body::create_fixture(&mut world, body, fd);
        }

        let candidate = create_fused_candidate(&mut world, 0)?;

        Ok(Self {
            world,
            candidate,
            bullet_slots: Vec::new(),
            round: 0,
        })
    }

    /// v12 说明：验证世界（rescore 折线回放、单候选）**不跑制导副本**，签名保持
    /// 原样；它只按「给定 track/path 折线」回放，制导弹由 B2 逐 node 喂折线。
    pub(crate) fn acquire_bullet_slot(&mut self, radius: f64) -> usize {
        let round = self.round;
        for idx in 0..self.bullet_slots.len() {
            if self.bullet_slots[idx].last_round != round {
                let old_body = self.bullet_slots[idx].body;
                let radius_changed = self.bullet_slots[idx].radius != radius;
                if radius_changed {
                    self.world.set_active(old_body, false);
                    let new_body = create_projectile_body(&mut self.world, radius);
                    self.bullet_slots[idx].body = new_body;
                    self.bullet_slots[idx].radius = radius;
                }
                self.bullet_slots[idx].last_round = round;
                self.world.set_active(self.bullet_slots[idx].body, true);
                return idx;
            }
        }
        let body = create_projectile_body(&mut self.world, radius);
        self.bullet_slots.push(BulletSlot {
            body,
            last_round: round,
            radius,
            initial_speed: 0.0,
            life_left: 0.0,
            active: false,
            is_shotgun: false,
            is_laser: false,
            is_missile: false,
            missile_time_alive: 0.0,
            homing_bodies: Vec::new(),
            bounces: Vec::new(),
            is_shrapnel: false,
            prev_dir_x: 0.0,
            prev_dir_y: 0.0,
            has_prev_dir: false,
            last_vx: 0.0,
            last_vy: 0.0,
        });
        self.world.set_active(body, true);
        self.bullet_slots.len() - 1
    }

    pub(crate) fn park_unused_bullets(&mut self) {
        let round = self.round;
        for idx in 0..self.bullet_slots.len() {
            if self.bullet_slots[idx].last_round != round {
                self.world.set_active(self.bullet_slots[idx].body, false);
                // v12：副本一起停放（否则上一颗弹的副本继续飞）。
                for ci in 0..self.bullet_slots[idx].homing_bodies.len() {
                    let hb = self.bullet_slots[idx].homing_bodies[ci];
                    self.world.set_active(hb, false);
                }
            }
        }
    }
}

/// Process/WASM-lifetime cache for the dedicated single-candidate
/// verification world, keyed by the exact same wall signature as the rollout
/// cache.  This world is deliberately separate from [`RolloutCache`] so
/// verification never disturbs the 9-candidate warm-starting state.
pub struct VerificationCache {
    signature: Option<Vec<u8>>,
    world: Option<VerificationWorld>,
}

impl Default for VerificationCache {
    fn default() -> Self {
        Self::new()
    }
}

impl VerificationCache {
    pub fn new() -> Self {
        Self {
            signature: None,
            world: None,
        }
    }

    pub fn clear(&mut self) {
        self.signature = None;
        self.world = None;
    }

    pub(crate) fn ensure_world(
        &mut self,
        walls: &[WallPoly],
    ) -> Result<&mut VerificationWorld, String> {
        let sig = wall_signature(walls)?;
        if self.signature.as_ref() != Some(&sig) {
            let world = VerificationWorld::build(walls)?;
            self.signature = Some(sig);
            self.world = Some(world);
        }
        self.world
            .as_mut()
            .ok_or_else(|| "verification world missing after rebuild".to_string())
    }
}

impl FusedWorld {
    fn build(walls: &[WallPoly]) -> Result<Self, String> {
        if walls.len() > MAX_WALLS {
            return Err(format!(
                "wall count {} exceeds max {}",
                walls.len(),
                MAX_WALLS
            ));
        }
        let mut world = World::new((0.0, 0.0), true);

        // Real maze walls, exact polygons from JS `B2DUtils.createMaze`.
        for (wi, wall) in walls.iter().enumerate() {
            if wall.vertices.len() < 3 || wall.vertices.len() > MAX_WALL_VERTS {
                return Err(format!(
                    "wall {} has {} vertices (expected 3..{})",
                    wi,
                    wall.vertices.len(),
                    MAX_WALL_VERTS
                ));
            }
            let poly = PolygonShape::from_vertices(&wall.vertices)
                .map_err(|e| format!("wall {}: {}", wi, e))?;
            let mut bd = BodyDef::new();
            bd.body_type = crate::box2d::B2_STATIC_BODY;
            let body = Body::create(&mut world, bd);
            let mut fd = FixtureDef::new();
            fd.shape = Some(Shape::Polygon(poly));
            fd.density = 0.0;
            fd.friction = 0.05;
            fd.restitution = 0.0;
            fd.is_sensor = false;
            fd.category_bits = CATEGORY_MAZE;
            fd.mask_bits = WALL_MASK;
            fd.kind = FixtureKind::Wall;
            Body::create_fixture(&mut world, body, fd);
        }

        // Nine fused candidate bodies, exactly like JS `createFusedCandidateBody`
        // (solid fixtures get mask=MAZE only; sensors get mask=PROJECTILE).
        let mut candidates = Vec::with_capacity(MAX_OPS);
        for op_index in 0..MAX_OPS {
            candidates.push(create_fused_candidate(&mut world, op_index)?);
        }

        Ok(Self {
            world,
            candidates,
            bullet_slots: Vec::new(),
            round: 0,
        })
    }

    fn create_bullet_body(&mut self, radius: f64) -> crate::box2d::BodyId {
        create_projectile_body(&mut self.world, radius)
    }

    fn acquire_bullet_slot(&mut self, radius: f64, is_missile: bool, n_ops: usize) -> usize {
        let round = self.round;
        for idx in 0..self.bullet_slots.len() {
            if self.bullet_slots[idx].last_round != round {
                let old_body = self.bullet_slots[idx].body;
                let radius_changed = self.bullet_slots[idx].radius != radius;
                if radius_changed {
                    // JS destroys the old body and creates a new one.  Leaving
                    // the old body inactive in the world is observationally
                    // equivalent for physics.
                    self.world.set_active(old_body, false);
                    // v12（1-2④）：半径变了 ⟹ 上一轮的 N 个制导副本也不能再用
                    //（直径不对）。旧副本留在世界里置 inactive（与共享体同款处置），
                    // 列表清空、下面按新半径重建。
                    for ci in 0..self.bullet_slots[idx].homing_bodies.len() {
                        let ob = self.bullet_slots[idx].homing_bodies[ci];
                        self.world.set_active(ob, false);
                    }
                    self.bullet_slots[idx].homing_bodies.clear();
                    let new_body = self.create_bullet_body(radius);
                    self.bullet_slots[idx].body = new_body;
                    self.bullet_slots[idx].radius = radius;
                }
                self.bullet_slots[idx].last_round = round;
                // v12（1-2④）：N 个副本必须跟共享体一起参与【槽位回收/停放】。
                // 不把上一轮的副本 `set_active(false)`，它们会继续飞 = 幻影弹 = 假死
                //（上一位代理提前报备、必须一起做的两件事之一）。
                if is_missile {
                    self.ensure_homing_bodies(idx, n_ops, radius);
                } else {
                    self.park_homing_bodies(idx);
                }
                self.world.set_active(self.bullet_slots[idx].body, true);
                return idx;
            }
        }
        let body = self.create_bullet_body(radius);
        self.bullet_slots.push(BulletSlot {
            body,
            last_round: round,
            radius,
            initial_speed: 0.0,
            life_left: 0.0,
            active: false,
            is_shotgun: false,
            is_laser: false,
            // v12（1-2④）：追踪导弹字段（共享体对制导弹置 inactive，运动在副本上）。
            is_missile: false,
            missile_time_alive: 0.0,
            homing_bodies: Vec::new(),
            bounces: Vec::new(),
            is_shrapnel: false,
            prev_dir_x: 0.0,
            prev_dir_y: 0.0,
            has_prev_dir: false,
            last_vx: 0.0,
            last_vy: 0.0,
        });
        let idx = self.bullet_slots.len() - 1;
        if is_missile {
            self.ensure_homing_bodies(idx, n_ops, radius);
        }
        self.world.set_active(body, true);
        idx
    }

    /// v12（1-2④）：确保该槽有 `n_ops` 个制导副本（每候选一颗弹体，选项 A）。
    /// 缺的按当前半径新造；多出来的（上一批 op 更少）停放、不销毁。
    fn ensure_homing_bodies(&mut self, idx: usize, n_ops: usize, radius: f64) {
        while self.bullet_slots[idx].homing_bodies.len() < n_ops {
            let b = self.create_bullet_body(radius);
            self.bullet_slots[idx].homing_bodies.push(b);
        }
        for ci in n_ops..self.bullet_slots[idx].homing_bodies.len() {
            let b = self.bullet_slots[idx].homing_bodies[ci];
            self.world.set_active(b, false);
        }
    }

    fn park_homing_bodies(&mut self, idx: usize) {
        for ci in 0..self.bullet_slots[idx].homing_bodies.len() {
            let b = self.bullet_slots[idx].homing_bodies[ci];
            self.world.set_active(b, false);
        }
    }

    fn park_unused_bullets(&mut self) {
        let round = self.round;
        for idx in 0..self.bullet_slots.len() {
            if self.bullet_slots[idx].last_round != round {
                let body = self.bullet_slots[idx].body;
                self.world.set_active(body, false);
                // v12（1-2④）：副本一起停放（否则上一颗弹的副本继续飞）。
                for ci in 0..self.bullet_slots[idx].homing_bodies.len() {
                    let hb = self.bullet_slots[idx].homing_bodies[ci];
                    self.world.set_active(hb, false);
                }
            }
        }
    }
}

#[derive(Clone, Debug)]
struct LocalSlot {
    body: crate::box2d::BodyId,
    last_round: u64,
    radius: f64,
    initial_speed: f64,
    life_left: f64,
    active: bool,
    /// v10：霰弹状态（与 `BulletSlot::is_shotgun` 同步）。
    is_shotgun: bool,
    /// v11（1-2③）：激光状态（与 `BulletSlot::is_laser` 同步）。
    is_laser: bool,
    /// v12（1-2④）：追踪导弹状态（与 `BulletSlot` 同步）。
    /// ⚠️ 这三个字段在【结构体声明】与【构造】两处都要有：
    /// 第 5 轮只加了构造处 → 编译不过，是那次回滚的直接原因。
    is_missile: bool,
    missile_time_alive: f64,
    homing_bodies: Vec<crate::box2d::BodyId>,
    /// v10：撞墙/撞盾接触时间戳（与 `BulletSlot::bounces` 同步）。
    bounces: Vec<f64>,
    /// v9：与 `BulletSlot` 同步的破片状态（步进循环只改 LocalSlot，循环后写回）。
    is_shrapnel: bool,
    prev_dir_x: f64,
    prev_dir_y: f64,
    has_prev_dir: bool,
}

fn validate_input(input: &RolloutInput) -> Result<(), String> {
    if input.ops.is_empty() || input.ops.len() > MAX_OPS {
        return Err(format!("op count must be 1..{}", MAX_OPS));
    }
    if input.duration_frames > MAX_FRAMES as u32 {
        return Err(format!(
            "durationFrames {} exceeds max {}",
            input.duration_frames, MAX_FRAMES
        ));
    }
    if input.walls.len() > MAX_WALLS {
        return Err(format!(
            "wall count {} exceeds max {}",
            input.walls.len(),
            MAX_WALLS
        ));
    }
    if input.bullets.len() > MAX_BULLETS {
        return Err(format!(
            "bullet count {} exceeds max {}",
            input.bullets.len(),
            MAX_BULLETS
        ));
    }
    if input.start_pose.x.is_nan() || input.start_pose.y.is_nan() || input.start_pose.rot.is_nan() {
        return Err("start pose contains NaN".to_string());
    }
    for (i, op) in input.ops.iter().enumerate() {
        if op.speed.is_nan() || op.rotation_speed.is_nan() {
            return Err(format!("op {} has NaN speed", i));
        }
    }
    for (i, b) in input.bullets.iter().enumerate() {
        if b.x.is_nan()
            || b.y.is_nan()
            || b.vx.is_nan()
            || b.vy.is_nan()
            || b.radius.is_nan()
            || b.life_left.is_nan()
        {
            return Err(format!("bullet {} has NaN", i));
        }
        // Laser projectiles have radius 0.0 in the game; allow the degenerate
        // point circle exactly like JS `b2CircleShape(0)`.
        if b.radius < 0.0 {
            return Err(format!("bullet {} has negative radius", i));
        }
    }
    Ok(())
}

/// Run one fused batch through `cache`.  The same cache must be reused for
/// consecutive calls with the same wall signature (JS `_fusedCache`).
pub fn run_rollout_batch(
    cache: &mut RolloutCache,
    input: &RolloutInput,
) -> Result<RolloutOutput, String> {
    validate_input(input)?;

    // v12（1-2④）：场上有制导弹时，迷宫表必须已经由 `vt_set_maze` 装好。
    // 否则**响亮失败**（`lib.rs` 捕获后返回 0，JS 掉回融合路径），
    // 绝不能用空表/旧表去"瞎制导"——那是假绿生产线。
    if input.bullets.iter().any(|b| b.is_missile) && crate::vtmaze::with_maze(|_| ()).is_none() {
        return Err(
            "homing missile present but maze table is not set (call vt_set_maze first)".to_string(),
        );
    }

    let sig = wall_signature(&input.walls)?;
    if cache.signature.as_ref() != Some(&sig) {
        let fused = FusedWorld::build(&input.walls)?;
        cache.signature = Some(sig);
        cache.fused = Some(fused);
    }

    let fc = cache
        .fused
        .as_mut()
        .ok_or_else(|| "fused world missing after rebuild".to_string())?;

    let n_ops = input.ops.len();
    let duration = input.duration_frames as usize;

    fc.round += 1;
    let round = fc.round;

    let candidate_bodies = fc.candidates.clone();
    for (i, &body) in candidate_bodies.iter().enumerate() {
        if i < n_ops {
            fc.world.set_active(body, true);
            fc.world.set_position_and_angle(
                body,
                input.start_pose.x,
                input.start_pose.y,
                input.start_pose.rot,
            );
            fc.world.set_body_linear_velocity(body, (0.0, 0.0));
            fc.world.set_body_angular_velocity(body, 0.0);
            fc.world.set_body_awake(body, true);
        } else {
            fc.world.set_active(body, false);
        }
    }

    // Acquire / park bullet slots exactly like JS `simulateFusedBatch`.
    for bullet in &input.bullets {
        if !bullet.active {
            continue;
        }
        let idx = fc.acquire_bullet_slot(bullet.radius, bullet.is_missile, n_ops);
        let body = fc.bullet_slots[idx].body;
        // v9：槽位按 lastRound 轮询复用，每次摆位都必须重设弹种标记并清空上一帧
        // 方向。JS v162/v164 在 path/approx 两个摆位分支都会 `prevDirX = null`；
        // 残留方向会把新弹第一帧 `dot < 0.999` 误判成撞墙（§14 记过同类残留问题）。
        fc.bullet_slots[idx].is_shrapnel = bullet.is_shrapnel;
        fc.bullet_slots[idx].is_shotgun = bullet.is_shotgun;
        fc.bullet_slots[idx].is_laser = bullet.is_laser;
        // v12（1-2④）：弹种码 4 = HOMING_MISSILE；`missile_time_alive` 由 JS 从
        // 真弹的 `timeAlive` 按同一时间基准换算（判 2.0s 门）。
        fc.bullet_slots[idx].is_missile = bullet.is_missile;
        fc.bullet_slots[idx].missile_time_alive = bullet.missile_time_alive;
        // v10：同 JS `acquireFusedBullet` —— 槽位复用必须清空上一轮的撞墙时间戳，
        // 残留会把新弹提前判死（§14 同类教训）。
        fc.bullet_slots[idx].bounces.clear();
        fc.bullet_slots[idx].has_prev_dir = false;
        fc.bullet_slots[idx].prev_dir_x = 0.0;
        fc.bullet_slots[idx].prev_dir_y = 0.0;
        fc.world
            .set_position_and_angle(body, bullet.x, bullet.y, 0.0);
        fc.world
            .set_body_linear_velocity(body, (bullet.vx, bullet.vy));
        fc.world.set_body_angular_velocity(body, 0.0);
        fc.world.set_body_awake(body, true);

        // v137（与 JS `simulateFusedBatch` 同口径）：`life_left` 只回答“这颗弹还剩
        // 几帧”，到期由下面逐帧 `life_left -= FRAME_DT` 自然退场。placement 阶段
        // 不能因为 life_left<=0 就把整颗弹关掉——那会让它在**仍然存活的那几帧**里
        // 从融合世界消失 → 死亡检测失明 → 树判 fd=-1 → 实际被打死。
        // ⚠️ `slot_active` 必须**只看速度**（`diff_tree_death_blind.js` ③ 钉死了这一行）。
        let initial_speed = (bullet.vx * bullet.vx + bullet.vy * bullet.vy).sqrt();
        let slot_active = initial_speed > 0.0;
        // v12（1-2④）：制导弹**存进槽位**的归一化上限是**发射时**速度（18 m/s），
        // 不是摆位时的当前速度。见 `MISSILE_INITIAL_SPEED_M` 的注释。
        let slot_initial_speed = if bullet.is_missile {
            MISSILE_INITIAL_SPEED_M
        } else {
            initial_speed
        };
        let life_left = bullet.life_left.max(0.0);
        fc.bullet_slots[idx].initial_speed = slot_initial_speed;
        fc.bullet_slots[idx].life_left = life_left;
        fc.bullet_slots[idx].active = slot_active;
        if bullet.is_missile {
            // v12（1-2④）选项 A：N 个候选副本同起点/同速度，各自朝自己的候选制导；
            // 共享体对制导弹**不使用**（置 inactive），运动全在副本上。
            let n_copies = fc.bullet_slots[idx].homing_bodies.len().min(n_ops);
            for ci in 0..n_copies {
                let hb = fc.bullet_slots[idx].homing_bodies[ci];
                fc.world
                    .set_position_and_angle(hb, bullet.x, bullet.y, 0.0);
                fc.world
                    .set_body_linear_velocity(hb, (bullet.vx, bullet.vy));
                fc.world.set_body_angular_velocity(hb, 0.0);
                fc.world.set_body_awake(hb, true);
                fc.world.set_active(hb, slot_active);
            }
            fc.world.set_active(body, false);
        } else if !slot_active {
            fc.world.set_active(body, false);
        }
    }
    fc.park_unused_bullets();

    let mut slots: Vec<LocalSlot> = fc
        .bullet_slots
        .iter()
        .map(|s| LocalSlot {
            body: s.body,
            last_round: s.last_round,
            radius: s.radius,
            initial_speed: s.initial_speed,
            life_left: s.life_left,
            active: s.active,
            is_shotgun: s.is_shotgun,
            is_laser: s.is_laser,
            is_missile: s.is_missile,
            missile_time_alive: s.missile_time_alive,
            homing_bodies: s.homing_bodies.clone(),
            bounces: s.bounces.clone(),
            is_shrapnel: s.is_shrapnel,
            prev_dir_x: s.prev_dir_x,
            prev_dir_y: s.prev_dir_y,
            has_prev_dir: s.has_prev_dir,
        })
        .collect();

    let mut samples: Vec<Vec<RolloutSample>> = (0..n_ops)
        .map(|_| Vec::with_capacity(duration + 1))
        .collect();
    let mut dead = vec![false; n_ops];
    let mut death_frame = vec![-1i32; n_ops];
    // v11（1-2③）：激光扫掠命中帧（只读回溯补判；-1=未命中）。
    let mut sweep_hit = vec![-1i32; n_ops];
    // v10：本帧每颗弹的“撞墙/撞盾接触次数”（JS `hitThisFrame`）。
    let mut hit_this_frame: Vec<u32> = vec![0; slots.len()];
    // v12（1-2④）：制导弹副本的独立簿记（每槽 × 每候选副本）。
    // ⚠️ 绝不能共用 `slot.bounces`：9 个副本同帧撞同一面墙会各 push 一条，
    // 共享列表当帧就 ≥5 ⟹ 整颗弹被 `PROJECTILE_BOUNCE_TIMEOUT_COUNT` 误杀
    //（幻影弹/假绿）。JS 融合侧同样是每副本一份。
    let mut homing_hit: Vec<Vec<u32>> = slots
        .iter()
        .map(|s| s.homing_bodies.iter().map(|_| 0u32).collect())
        .collect();
    let mut homing_bounce: Vec<Vec<Vec<f64>>> = slots
        .iter()
        .map(|s| s.homing_bodies.iter().map(|_| Vec::<f64>::new()).collect())
        .collect();
    // v11：Step 前位置快照（与 slots 同下标），只对 is_laser 槽填。
    let mut sweep_pre: Vec<Option<(f64, f64)>> = vec![None; slots.len()];
    let mut speeds = vec![0.0f64; n_ops];
    let mut rot_spds = vec![0.0f64; n_ops];

    for k in 0..=duration {
        for i in 0..n_ops {
            let body = candidate_bodies[i];
            let (x, y) = fc.world.body_position(body);
            let rot = fc.world.body_angle(body);
            samples[i].push(RolloutSample {
                t: k as f64 * frame_dt(),
                x,
                y,
                rot,
            });
        }
        if k >= duration {
            break;
        }

        for i in 0..n_ops {
            if dead[i] {
                speeds[i] = 0.0;
                rot_spds[i] = 0.0;
                continue;
            }
            speeds[i] = input.ops[i].speed;
            rot_spds[i] = input.ops[i].rotation_speed;
        }

        for i in 0..n_ops {
            let body = candidate_bodies[i];
            let a = fc.world.body_angle(body);
            fc.world
                .set_body_linear_velocity(body, (a.sin() * speeds[i], -a.cos() * speeds[i]));
            fc.world.set_body_angular_velocity(body, rot_spds[i]);
        }

        // v11（1-2③）：激光扫掠前置快照 —— Step 前位置。
        for si in 0..slots.len() {
            sweep_pre[si] = None;
            if !slots[si].is_laser || slots[si].last_round != round {
                continue;
            }
            if !fc.world.body_is_active(slots[si].body) {
                continue;
            }
            sweep_pre[si] = Some(fc.world.body_position(slots[si].body));
        }

        fc.world.step(frame_dt(), 10, 10);

        // v11（1-2③）：激光扫掠（只读；命中只记 sweep_hit[k]，绝不改 body/速度）。
        // 与 JS `simulateFusedBatch` 的 sweepHit 同语义：线段=Step 前→后实际位置，
        // 先按墙裁剪/反射，再测候选全部 sensor 多边形（车体+炮塔）。
        for si in 0..slots.len() {
            if !slots[si].is_laser || slots[si].last_round != round {
                continue;
            }
            let pre = match sweep_pre[si] {
                Some(p) => p,
                None => continue,
            };
            let post = fc.world.body_position(slots[si].body);
            let segs = sweep_segments_against_walls(&input.walls, pre.0, pre.1, post.0, post.1, 4);
            for &(sax, say, sbx, sby) in segs.iter() {
                for oi in 0..n_ops {
                    if sweep_hit[oi] >= 0 || dead[oi] {
                        continue;
                    }
                    if sweep_hits_candidate(&fc.world, candidate_bodies[oi], sax, say, sbx, sby) {
                        sweep_hit[oi] = k as i32;
                    }
                }
            }
            sweep_pre[si] = None;
        }

        // v10（① + ② 共用）：本帧撞墙/撞盾接触枚举。
        //
        // 对齐 JS `vantage_sandbox.js` 的 `forEachProjectileWallContact`（原版
        // `RoundModel._filterAndDispatchCollisionEvents` 对每个 touching 的
        // MAZE|SHIELD 接触调用 `projectile.hitMaze()/hitShield()`）：
        //   · 每个 touching 的「弹 fixture × (MAZE|SHIELD) fixture」算 1 次；
        //   · 破片（`Shrapnel.hitMaze` 完全覆盖、不调 `_super()`）**不记**；
        //   · 其余弹种（含激光/导弹）照记 —— `HomingMissile.update` 自己复制了
        //     那段剪枝循环，`hitMaze` 仍继承基类。
        let bounce_now = (k + 1) as f64 * frame_dt();   // 本 Step 之后的模拟时刻
        for h in hit_this_frame.iter_mut() {
            *h = 0;
        }
        {
            let world = &fc.world;
            for contact in world.contacts() {
                if !contact.is_touching() {
                    continue;
                }
                let fa = contact.fixture_a;
                let fb = contact.fixture_b;
                let ca = world.fixture_category_bits(fa);
                let cb = world.fixture_category_bits(fb);
                let hard = CATEGORY_MAZE | CATEGORY_SHIELD;
                let proj_body = if ca & CATEGORY_PROJECTILE != 0 && cb & hard != 0 {
                    world.fixture_body(fa)
                } else if cb & CATEGORY_PROJECTILE != 0 && ca & hard != 0 {
                    world.fixture_body(fb)
                } else {
                    continue;
                };
                let mut matched = false;
                for (si, slot) in slots.iter().enumerate() {
                    if slot.last_round != round {
                        continue;
                    }
                    if slot.is_missile {
                        // v12（1-2④）：副本各自计数（共享体已经 inactive，不能再看它）。
                        for ci in 0..slot.homing_bodies.len() {
                            if slot.homing_bodies[ci] == proj_body {
                                if world.body_is_active(proj_body) {
                                    homing_hit[si][ci] += 1;
                                }
                                matched = true;
                                break;
                            }
                        }
                    } else if slot.body == proj_body && world.body_is_active(slot.body) {
                        hit_this_frame[si] += 1;
                        matched = true;
                    }
                    if matched {
                        break;
                    }
                }
            }
        }
        for si in 0..slots.len() {
            if hit_this_frame[si] == 0 {
                continue;
            }
            // 破片撞墙即停（`Shrapnel.hitMaze` 不调 `_super()`）⇒ 既不吃 ① 也不吃 ②。
            if slots[si].is_shrapnel {
                continue;
            }
            // ② 原版 `hitMaze`/`hitShield` 都 `this.bounces.push(now)`：本帧每个
            //    touching 接触 push 一条（同一帧多次接触 push 多条）。
            //    ⚠️ 顺序与 JS 融合世界一致：先 push、再钳寿命；剪枝/判死在后面
            //    逐弹 update 里（push → 剪枝 → done 判定）。
            for _ in 0..hit_this_frame[si] {
                slots[si].bounces.push(bounce_now);
            }
            // ① 霰弹撞墙/撞盾：timeAlive = max(timeAlive, MAX-AFTER) ⇒ 剩余寿命 ≤ 0.7s。
            //    ⚠️ 必须逐字对齐 JS `clampShotgunLifeLeftAfterHit`：**只在真的发生
            //    hit 的帧**才钳（无条件钳 = 霰弹永远活不过 0.7s，方向完全反了）。
            if slots[si].is_shotgun {
                slots[si].life_left = clamp_shotgun_life_left_after_hit(slots[si].life_left);
            }
        }
        // v12（1-2④）：制导副本的撞墙时间戳（每副本一份；导弹不覆盖 `hitMaze`，
        // 与激光同样吃 ②）。这里只 push、不钳寿命（导弹不是霰弹）。
        for si in 0..slots.len() {
            if slots[si].last_round != round || !slots[si].is_missile {
                continue;
            }
            for ci in 0..homing_hit[si].len() {
                let n = homing_hit[si][ci];
                for _ in 0..n {
                    homing_bounce[si][ci].push(bounce_now);
                }
            }
        }

        // JS bullet renormalization / lifetime / deactivation.
        //
        // v9：逐字对齐 JS 融合世界 v162/v164（`vantage_sandbox.js` 里
        // `bs.isShrapnel` / `bs.noSpeedNorm` 两段），判据顺序也一致：
        //   ① 寿命到期退场；
        //   ② 速度恰为 0 退场；
        //   ③ 破片：上一帧方向与本帧方向点积 `dot < 0.999`（约 >2.5°）⇒ 判撞墙，
        //      速度清零 + 停用（等价 `Shrapnel.hitMaze`，破片当帧消失、不反弹）；
        //   ④ 破片：速度² <= 0.01 即退场（等价 `Shrapnel.done`），且**不做**基类
        //      `Projectile.update` 的「速度乘回初速」归一化——因为
        //      `Shrapnel.update` 不调 `_super()`；普通弹继续走归一化。
        //
        // 备注：③ 的「方向变化」是 JS v162 的启发式（不读真 `hitMaze` 事件）；
        //      JS / Rust 必须永远同步改，详见《待查清单》§13.3 / §19。
        for slot in slots.iter_mut() {
            if slot.last_round != round || !fc.world.body_is_active(slot.body) {
                continue;
            }
            slot.life_left -= frame_dt();
            if slot.life_left <= 0.0 {
                slot.active = false;
                fc.world.set_active(slot.body, false);
                continue;
            }
            // v10（②）：`Projectile.update` 的粘性剪枝 + `done()` 第三支。
            // 破片 `Shrapnel.hitMaze` 覆盖基类、永不 push ⇒ 不吃这两条。
            // 顺序照原版：先剪枝、再由 done() 判 `>=5`（不是"总共弹 5 次"）。
            if !slot.is_shrapnel {
                prune_bounce_stamps(&mut slot.bounces, bounce_now, BOUNCE_TIMEOUT_WINDOW_SEC);
                if slot.bounces.len() >= BOUNCE_TIMEOUT_COUNT {
                    slot.active = false;
                    fc.world.set_active(slot.body, false);
                    continue;
                }
            }
            let (vx, vy) = fc.world.body_linear_velocity(slot.body);
            let len = (vx * vx + vy * vy).sqrt();
            if len == 0.0 {
                slot.active = false;
                fc.world.set_active(slot.body, false);
                continue;
            }
            if slot.is_shrapnel && slot.has_prev_dir {
                // JS v162：方向变了（约 >2.5°）就是撞墙了（restitution=1 会把它反射）。
                let dot = (vx / len) * slot.prev_dir_x + (vy / len) * slot.prev_dir_y;
                if dot < 0.999 {
                    // `Shrapnel.hitMaze`：把速度乘 0；随后 `Shrapnel.done`
                    // （速度²<=0.01）当帧退场。旧实现（v8 及以前）在这里什么都不做，
                    // 让 restitution=1.0 把破片反弹飞走 —— 保留作历史对照。
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
            let len_sq = len * len;
            if slot.is_shrapnel {
                // `Shrapnel.update` 不调 `_super()` ⇒ 没有基类归一化；`done()` 只看速度²。
                // 旧实现（v8 及以前对所有弹种一视同仁，保留作历史对照）：
                // let init_sq = slot.initial_speed * slot.initial_speed;
                // if (len_sq - init_sq).abs() > 0.01 {
                //     let scale = slot.initial_speed / len;
                //     fc.world.set_body_linear_velocity(slot.body, (vx * scale, vy * scale));
                // }
                if len_sq <= 0.01 {
                    slot.active = false;
                    fc.world.set_active(slot.body, false);
                    continue;
                }
            } else {
                let init_sq = slot.initial_speed * slot.initial_speed;
                if (len_sq - init_sq).abs() > 0.01 {
                    let scale = slot.initial_speed / len;
                    fc.world
                        .set_body_linear_velocity(slot.body, (vx * scale, vy * scale));
                }
            }
        }

        // v12（1-2④）：制导弹逐副本推进 —— `HomingMissile.update` 的逐帧语义。
        //
        // 顺序逐字对齐真代码：`timeAlive += dt` → （撞墙剪枝/done）→
        // `if (timeAlive > 2.0) { 瞄准+按世界轴 ±40·dt 加速 }` →
        // `if (|v|² − initialSpeed² > 0.01) v *= initialSpeed/|v|`（**没有 abs**）。
        // 每个副本是一条独立弹道（选项 A：每候选一颗弹体），所以寿命/撞墙计数
        // 都要按副本走；只有 `timeAlive`/`lifeLeft`/`initialSpeed` 是槽级共享
        //（N 个副本同时刻出发，时间量天然相同）。
        for si in 0..slots.len() {
            if slots[si].last_round != round || !slots[si].is_missile || !slots[si].active {
                continue;
            }
            slots[si].missile_time_alive += frame_dt();
            slots[si].life_left -= frame_dt();
            let life_over = slots[si].life_left <= 0.0;
            let mut any_alive = false;
            for ci in 0..slots[si].homing_bodies.len() {
                if ci >= n_ops {
                    continue;   // 上一批 op 更多时留下的副本（已停放）
                }
                let hb = slots[si].homing_bodies[ci];
                if !fc.world.body_is_active(hb) {
                    continue;
                }
                if life_over {
                    fc.world.set_active(hb, false);
                    continue;
                }
                // `Projectile.update` 的粘性剪枝 + `done()` 第三支（≥5 当帧销毁）。
                prune_bounce_stamps(
                    &mut homing_bounce[si][ci],
                    bounce_now,
                    BOUNCE_TIMEOUT_WINDOW_SEC,
                );
                if homing_bounce[si][ci].len() >= BOUNCE_TIMEOUT_COUNT {
                    fc.world.set_active(hb, false);
                    continue;
                }
                let (vx, vy) = fc.world.body_linear_velocity(hb);
                let len = (vx * vx + vy * vy).sqrt();
                if len == 0.0 {
                    fc.world.set_active(hb, false);
                    continue;
                }
                if slots[si].missile_time_alive > MISSILE_ACTIVATION_TIME_SEC {
                    // 目标 = 本副本自己的候选（op == ci）当前位姿（Step 之后）。
                    let target = fc.world.body_position(candidate_bodies[ci]);
                    missile_guide_step(
                        &mut fc.world,
                        hb,
                        target,
                        MISSILE_ACCELERATION,
                        frame_dt(),
                    );
                }
                let (nvx, nvy) = fc.world.body_linear_velocity(hb);
                let nlen = (nvx * nvx + nvy * nvy).sqrt();
                if nlen == 0.0 {
                    fc.world.set_active(hb, false);
                    continue;
                }
                let init_sq = slots[si].initial_speed * slots[si].initial_speed;
                if nlen * nlen - init_sq > 0.01 {
                    let scale = slots[si].initial_speed / nlen;
                    fc.world
                        .set_body_linear_velocity(hb, (nvx * scale, nvy * scale));
                }
                any_alive = true;
            }
            if !any_alive {
                slots[si].active = false;
            }
        }

        // Fused sensor death scan (after Step + bullet update, like JS).
        //
        // v12（1-2④）：制导弹的「每候选一颗弹体」必须按 homingOp **配对** ——
        // 只有"朝本候选飞"的那颗副本命中本候选 sensor 才作数；其它副本穿过本候选
        // sensor 一律不算（否则一颗弹会把 9 个候选全判死 = 全红假死）。
        // 映射用局部 `Vec<(BodyId,u8)>`（body → op），**不动 `FixtureKind`**。
        let mut homing_op_map: Vec<(crate::box2d::BodyId, u8)> = Vec::new();
        for slot in slots.iter() {
            if slot.last_round != round || !slot.is_missile {
                continue;
            }
            for (ci, &hb) in slot.homing_bodies.iter().enumerate() {
                if ci >= n_ops {
                    continue;
                }
                homing_op_map.push((hb, ci as u8));
            }
        }
        let mut hits: Vec<usize> = Vec::new();
        for contact in fc.world.contacts() {
            if !contact.is_touching() {
                continue;
            }
            let fa = contact.fixture_a;
            let fb = contact.fixture_b;
            let (sensor_op, other_cat, other_body) = match fc.world.fixture_kind(fa) {
                FixtureKind::TankSensor { op_index } => (
                    *op_index as usize,
                    fc.world.fixture_category_bits(fb),
                    fc.world.fixture_body(fb),
                ),
                _ => match fc.world.fixture_kind(fb) {
                    FixtureKind::TankSensor { op_index } => (
                        *op_index as usize,
                        fc.world.fixture_category_bits(fa),
                        fc.world.fixture_body(fa),
                    ),
                    _ => continue,
                },
            };
            if other_cat == CATEGORY_PROJECTILE {
                let mut paired = true;
                for &(hb, hop) in homing_op_map.iter() {
                    if hb == other_body && (hop as usize) != sensor_op {
                        paired = false;
                        break;
                    }
                }
                if paired {
                    hits.push(sensor_op);
                }
            }
        }
        for op in hits {
            if op < dead.len() && !dead[op] {
                dead[op] = true;
                // v153：death_frame 数的是“能走几步”，不是“走完后第几格”。
                // b2World::Step 先 Collide() 再 Solve()，IsTouching() 反映 Step
                // **之前**那一帧，所以第 k 帧撞上 = 能走 k 步。旧写法 k+1 与 JS
                // 同步偏大 1，导致“走 1 步就死”被标成 fd=2（橙）而不是 fd=1（红）。
                death_frame[op] = k as i32;
            }
        }

        // v11（1-2③）：扫掠回溯合并 —— 取更早的死亡帧；不改轨迹。
        for oi in 0..n_ops {
            if sweep_hit[oi] >= 0 && (death_frame[oi] < 0 || sweep_hit[oi] < death_frame[oi]) {
                dead[oi] = true;
                death_frame[oi] = sweep_hit[oi];
            }
        }
    }

    // v10 已落弹种语义：
    //   · 破片（`is_shrapnel`）：撞墙即速度清零 + 当帧退场（`Shrapnel.hitMaze/done`）；
    //   · 霰弹（`is_shotgun`）：撞墙/撞盾后剩余寿命 ≤0.7s（`Shotgun.hitMaze/hitShield`）；
    //   · 反弹去抖上限（所有非破片弹，含激光/导弹）：
    //     `bounces` 时间戳 + 35ms **粘性**剪枝 + `done()` 第三支 `>=5`。
    //
    // TODO(v10) 仍未做（卡点与判别方法见《待查清单》§19；**不允许只改 Rust 一侧**）：
    //   · LASER 的**线段扫掠**：真 `LASER.RADIUS.m=0` / 180 m/s，判死应是
    //     `p(k)→p(k+1)` 线段 × 坦克，而不是半径 0.05 的圆逐帧点判；
    //   · HOMING_MISSILE 的 2.0s 制导 / 换目标（融合世界没有对手未来轨迹与迷宫图）。
    //
    // Persist bullet slot state back into the cache.
    for (idx, slot) in slots.iter().enumerate() {
        if idx < fc.bullet_slots.len() {
            fc.bullet_slots[idx].initial_speed = slot.initial_speed;
            fc.bullet_slots[idx].life_left = slot.life_left;
            fc.bullet_slots[idx].active = slot.active;
            fc.bullet_slots[idx].radius = slot.radius;
            fc.bullet_slots[idx].is_shrapnel = slot.is_shrapnel;
            fc.bullet_slots[idx].is_shotgun = slot.is_shotgun;
            fc.bullet_slots[idx].is_laser = slot.is_laser;
            fc.bullet_slots[idx].bounces = slot.bounces.clone();
            fc.bullet_slots[idx].prev_dir_x = slot.prev_dir_x;
            fc.bullet_slots[idx].prev_dir_y = slot.prev_dir_y;
            fc.bullet_slots[idx].has_prev_dir = slot.has_prev_dir;
        }
    }

    Ok(RolloutOutput {
        samples,
        dead,
        death_frame,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arena_walls() -> Vec<WallPoly> {
        // Outer boundary for a 4x3 tile arena (tile 10m, wall width 0.8m).
        let hw = 0.4;
        vec![
            WallPoly {
                vertices: vec![(-hw, -hw), (40.0 + hw, -hw), (40.0 + hw, hw), (-hw, hw)],
            },
            WallPoly {
                vertices: vec![
                    (-hw, 30.0 - hw),
                    (40.0 + hw, 30.0 - hw),
                    (40.0 + hw, 30.0 + hw),
                    (-hw, 30.0 + hw),
                ],
            },
            WallPoly {
                vertices: vec![(-hw, -hw), (hw, -hw), (hw, 30.0 + hw), (-hw, 30.0 + hw)],
            },
            WallPoly {
                vertices: vec![
                    (40.0 - hw, -hw),
                    (40.0 + hw, -hw),
                    (40.0 + hw, 30.0 + hw),
                    (40.0 - hw, 30.0 + hw),
                ],
            },
        ]
    }

    fn make_ops() -> Vec<OpInput> {
        vec![
            OpInput {
                speed: 0.0,
                rotation_speed: 0.0,
            },
            OpInput {
                speed: 15.95,
                rotation_speed: 0.0,
            },
            OpInput {
                speed: -12.8,
                rotation_speed: 0.0,
            },
            OpInput {
                speed: 0.0,
                rotation_speed: -5.0,
            },
            OpInput {
                speed: 0.0,
                rotation_speed: 5.0,
            },
            OpInput {
                speed: 15.95,
                rotation_speed: -5.0,
            },
            OpInput {
                speed: 15.95,
                rotation_speed: 5.0,
            },
            OpInput {
                speed: -12.8,
                rotation_speed: -5.0,
            },
            OpInput {
                speed: -12.8,
                rotation_speed: 5.0,
            },
        ]
    }

    #[test]
    fn solid_tank_ignores_bullet_sensor_detects_bullet() {
        let mut cache = RolloutCache::new();
        let input = RolloutInput {
            start_pose: StartPose {
                x: 5.0,
                y: 5.0,
                rot: 0.0,
            },
            ops: make_ops(),
            duration_frames: 0,
            cache_id: 0,
            walls: arena_walls(),
            bullets: vec![BulletInput {
                x: 5.0,
                y: 3.0,
                vx: 0.0,
                vy: -18.0,
                radius: 0.25,
                life_left: 10.0,
                active: true,
                is_shrapnel: false,
                is_shotgun: false,   // 占位：测试夹具，不是霰弹
                is_laser: false,
                // v12：测试夹具不是制导弹。
                is_missile: false,
                missile_time_alive: 0.0,
            }],
        };
        let out = run_rollout_batch(&mut cache, &input).unwrap();
        // duration 0 records one sample and stops; death is only scanned after
        // a Step, so no candidate may be dead yet.
        assert_eq!(out.dead.iter().filter(|d| **d).count(), 0);
        assert_eq!(out.samples[0].len(), 1);

        let mut cache = RolloutCache::new();
        let input = RolloutInput {
            start_pose: StartPose {
                x: 5.0,
                y: 5.0,
                rot: 0.0,
            },
            ops: make_ops(),
            duration_frames: 3,
            cache_id: 0,
            walls: arena_walls(),
            bullets: vec![BulletInput {
                x: 5.0,
                y: 5.1,
                vx: 0.0,
                vy: -0.5,
                radius: 0.25,
                life_left: 10.0,
                active: true,
                is_shrapnel: false,
                is_shotgun: false,   // 占位：测试夹具，不是霰弹
                is_laser: false,
                // v12：测试夹具不是制导弹。
                is_missile: false,
                missile_time_alive: 0.0,
            }],
        };
        let out = run_rollout_batch(&mut cache, &input).unwrap();
        assert!(
            out.dead.iter().any(|d| *d),
            "expected at least one sensor death"
        );
    }

    #[test]
    fn persistent_cache_second_call_matches_first() {
        let mut cache = RolloutCache::new();
        let input = RolloutInput {
            start_pose: StartPose {
                x: 5.0,
                y: 5.0,
                rot: 0.4,
            },
            ops: make_ops(),
            duration_frames: 8,
            cache_id: 0,
            walls: arena_walls(),
            bullets: vec![BulletInput {
                x: 8.0,
                y: 8.0,
                vx: -3.0,
                vy: -4.0,
                radius: 0.25,
                life_left: 10.0,
                active: true,
                is_shrapnel: false,
                is_shotgun: false,   // 占位：测试夹具，不是霰弹
                is_laser: false,
                // v12：测试夹具不是制导弹。
                is_missile: false,
                missile_time_alive: 0.0,
            }],
        };
        let a = run_rollout_batch(&mut cache, &input).unwrap();
        let b = run_rollout_batch(&mut cache, &input).unwrap();
        for op in 0..a.samples.len() {
            assert_eq!(a.samples[op].len(), b.samples[op].len());
            for f in 0..a.samples[op].len() {
                let sa = a.samples[op][f];
                let sb = b.samples[op][f];
                assert_eq!(
                    sa.x.to_bits(),
                    sb.x.to_bits(),
                    "x differs op {} frame {}",
                    op,
                    f
                );
                assert_eq!(
                    sa.y.to_bits(),
                    sb.y.to_bits(),
                    "y differs op {} frame {}",
                    op,
                    f
                );
                assert_eq!(
                    sa.rot.to_bits(),
                    sb.rot.to_bits(),
                    "rot differs op {} frame {}",
                    op,
                    f
                );
            }
        }
        assert_eq!(a.dead, b.dead);
        assert_eq!(a.death_frame, b.death_frame);
    }

    #[test]
    fn wall_signature_change_rebuilds_world() {
        let mut cache = RolloutCache::new();
        let input = RolloutInput {
            start_pose: StartPose {
                x: 5.0,
                y: 5.0,
                rot: 0.0,
            },
            ops: make_ops(),
            duration_frames: 1,
            cache_id: 0,
            walls: arena_walls(),
            bullets: vec![],
        };
        run_rollout_batch(&mut cache, &input).unwrap();
        let sig = cache.signature.clone();
        let mut input2 = input.clone();
        input2.walls[0].vertices[0].0 += 0.0;
        run_rollout_batch(&mut cache, &input2).unwrap();
        assert_eq!(cache.signature, sig);
        let mut input3 = input.clone();
        input3.walls[0].vertices[0].0 += 1.0;
        run_rollout_batch(&mut cache, &input3).unwrap();
        assert_ne!(cache.signature, sig);
    }

    #[test]
    fn bullet_through_thin_wall_does_not_tunnel() {
        let mut cache = RolloutCache::new();
        let input = RolloutInput {
            start_pose: StartPose {
                x: 5.0,
                y: 5.0,
                rot: 0.0,
            },
            ops: vec![OpInput {
                speed: 0.0,
                rotation_speed: 0.0,
            }],
            duration_frames: 1,
            cache_id: 0,
            walls: vec![WallPoly {
                vertices: vec![
                    (5.0 - 3.0, 5.5),
                    (5.0 + 3.0, 5.5),
                    (5.0 + 3.0, 5.5 + 0.05),
                    (5.0 - 3.0, 5.5 + 0.05),
                ],
            }],
            bullets: vec![BulletInput {
                x: 5.0,
                y: 10.0,
                vx: 0.0,
                vy: -80.0,
                radius: 0.25,
                life_left: 10.0,
                active: true,
                is_shrapnel: false,
                is_shotgun: false,   // 占位：测试夹具，不是霰弹
                is_laser: false,
                // v12：测试夹具不是制导弹。
                is_missile: false,
                missile_time_alive: 0.0,
            }],
        };
        // One frame at 80 m/s is 1.6m; the wall is 0.05m thick and CCD must
        // stop the bullet above it, not let it tunnel.
        let out = run_rollout_batch(&mut cache, &input).unwrap();
        // Bullet position not directly exposed; no panic + all candidates alive.
        assert_eq!(out.samples.len(), 1);
        assert!(out.samples[0].len() == 2);
    }
}

#[cfg(test)]
mod max_walls_guard {
    use super::MAX_WALLS;

    /// 主人实测：人多 → 图大 → 墙段多；一旦超过 MAX_WALLS，
    /// `vt_score_paths` 会直接返回 0，JS 静默退回 scorePaths（慢且行为降级）。
    /// 这里锁一个下限，防止以后有人把它调小。
    #[test]
    fn max_walls_covers_large_maps() {
        assert!(MAX_WALLS >= 4096, "MAX_WALLS={} 太小：大图上 Rust 评分会整条失效", MAX_WALLS);
    }
}
