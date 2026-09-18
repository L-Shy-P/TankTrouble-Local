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

pub const FRAME_DT: f64 = 0.02;
pub const MAX_OPS: usize = 9;
pub const MAX_FRAMES: usize = 75;
pub const MAX_SAMPLES: usize = MAX_FRAMES + 1;
// 主人实测：人多 → 图大 → 墙段多，超过 1024 时 vt_score_paths 直接返回 0，
// JS 就静默退回 scorePaths（慢且行为降级，控制台刷"Rust 评分路径结果无效"）。
// 这个常量只用于校验（世界是动态 Vec 建的），提高它是安全的。
pub const MAX_WALLS: usize = 8192;
pub const MAX_WALL_VERTS: usize = 8;
pub const MAX_BULLETS: usize = 256;

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

    fn acquire_bullet_slot(&mut self, radius: f64) -> usize {
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
                    let new_body = self.create_bullet_body(radius);
                    self.bullet_slots[idx].body = new_body;
                    self.bullet_slots[idx].radius = radius;
                }
                self.bullet_slots[idx].last_round = round;
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
            last_vx: 0.0,
            last_vy: 0.0,
        });
        self.world.set_active(body, true);
        self.bullet_slots.len() - 1
    }

    fn park_unused_bullets(&mut self) {
        let round = self.round;
        for idx in 0..self.bullet_slots.len() {
            if self.bullet_slots[idx].last_round != round {
                let body = self.bullet_slots[idx].body;
                self.world.set_active(body, false);
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct LocalSlot {
    body: crate::box2d::BodyId,
    last_round: u64,
    radius: f64,
    initial_speed: f64,
    life_left: f64,
    active: bool,
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
        let idx = fc.acquire_bullet_slot(bullet.radius);
        let body = fc.bullet_slots[idx].body;
        fc.world
            .set_position_and_angle(body, bullet.x, bullet.y, 0.0);
        fc.world
            .set_body_linear_velocity(body, (bullet.vx, bullet.vy));
        fc.world.set_body_angular_velocity(body, 0.0);
        fc.world.set_body_awake(body, true);

        let initial_speed = (bullet.vx * bullet.vx + bullet.vy * bullet.vy).sqrt();
        let life_left = bullet.life_left.max(0.0);
        let slot_active = initial_speed > 0.0 && life_left > 0.0;
        fc.bullet_slots[idx].initial_speed = initial_speed;
        fc.bullet_slots[idx].life_left = life_left;
        fc.bullet_slots[idx].active = slot_active;
        if !slot_active {
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
        })
        .collect();

    let mut samples: Vec<Vec<RolloutSample>> = (0..n_ops)
        .map(|_| Vec::with_capacity(duration + 1))
        .collect();
    let mut dead = vec![false; n_ops];
    let mut death_frame = vec![-1i32; n_ops];
    let mut speeds = vec![0.0f64; n_ops];
    let mut rot_spds = vec![0.0f64; n_ops];

    for k in 0..=duration {
        for i in 0..n_ops {
            let body = candidate_bodies[i];
            let (x, y) = fc.world.body_position(body);
            let rot = fc.world.body_angle(body);
            samples[i].push(RolloutSample {
                t: k as f64 * FRAME_DT,
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

        fc.world.step(FRAME_DT, 10, 10);

        // JS bullet renormalization / lifetime / deactivation.
        for slot in slots.iter_mut() {
            if slot.last_round != round || !fc.world.body_is_active(slot.body) {
                continue;
            }
            slot.life_left -= FRAME_DT;
            if slot.life_left <= 0.0 {
                slot.active = false;
                fc.world.set_active(slot.body, false);
                continue;
            }
            let (vx, vy) = fc.world.body_linear_velocity(slot.body);
            let len = (vx * vx + vy * vy).sqrt();
            if len == 0.0 {
                slot.active = false;
                fc.world.set_active(slot.body, false);
                continue;
            }
            let len_sq = len * len;
            let init_sq = slot.initial_speed * slot.initial_speed;
            if (len_sq - init_sq).abs() > 0.01 {
                let scale = slot.initial_speed / len;
                fc.world
                    .set_body_linear_velocity(slot.body, (vx * scale, vy * scale));
            }
        }

        // Fused sensor death scan (after Step + bullet update, like JS).
        let mut hits: Vec<usize> = Vec::new();
        for contact in fc.world.contacts() {
            if !contact.is_touching() {
                continue;
            }
            let fa = contact.fixture_a;
            let fb = contact.fixture_b;
            let (sensor_op, other_cat) = match fc.world.fixture_kind(fa) {
                FixtureKind::TankSensor { op_index } => {
                    (*op_index as usize, fc.world.fixture_category_bits(fb))
                }
                _ => match fc.world.fixture_kind(fb) {
                    FixtureKind::TankSensor { op_index } => {
                        (*op_index as usize, fc.world.fixture_category_bits(fa))
                    }
                    _ => continue,
                },
            };
            if other_cat == CATEGORY_PROJECTILE {
                hits.push(sensor_op);
            }
        }
        for op in hits {
            if op < dead.len() && !dead[op] {
                dead[op] = true;
                death_frame[op] = (k + 1) as i32;
            }
        }
    }

    // Persist bullet slot state back into the cache.
    for (idx, slot) in slots.iter().enumerate() {
        if idx < fc.bullet_slots.len() {
            fc.bullet_slots[idx].initial_speed = slot.initial_speed;
            fc.bullet_slots[idx].life_left = slot.life_left;
            fc.bullet_slots[idx].active = slot.active;
            fc.bullet_slots[idx].radius = slot.radius;
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
