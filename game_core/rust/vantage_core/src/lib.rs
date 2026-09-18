//! vantage_core: Rust/WASM sidecar for Vantage dodge logic.
//!
//! Contains geometry/scoring helpers, the fused rollout batch, and the
//! incremental rescore + fused sensor/CCD death-verification core for tree
//! nodes with already-stored rollout samples.  No NN lives here.

#![allow(clippy::missing_safety_doc)]

pub mod box2d;
pub mod minimal;
pub mod rescore;
pub mod rollout;
pub mod score_paths;
pub mod scoring;
pub mod tree;

/// Fixed ABI version.
#[no_mangle]
pub extern "C" fn vt_version() -> u32 {
    // v7：两个 ABI 各加了一个 `occlusion_enabled` 尾参（把遮蔽开关接进 Rust）。
    7
}

/// Flat-buffer fused rollout batch ABI.
///
/// All geometry/velocities are `f64` (JS numbers are doubles). Fixed limits:
/// ops <= 9, durationFrames <= 75 (samples = durationFrames + 1), walls <=
/// 1024, 3..8 vertices per wall, bullets <= 256 (0-radius laser allowed).
///
/// Output layout (all caller-owned):
/// - `out_x`, `out_y`, `out_rot`: candidate-major, index
///   `op_index * (duration_frames + 1) + frame`.
/// - `out_dead`, `out_death_frame`: one element per op.
///
/// `cache_id` keys the persistent fused world (JS `_fusedCache` is keyed by
/// maze + aiId; pass a stable per-AI id from JS). Walls with the same
/// signature and the same `cache_id` reuse one world and its warm-starting
/// state; a different `cache_id` gets an independent world.
///
/// Returns 1 on success, 0 on bad input (null pointer, invalid length, or a
/// panic caught inside the rollout).
#[no_mangle]
pub extern "C" fn vt_rollout_batch(
    cache_id: u64,
    start_x: f64,
    start_y: f64,
    start_rot: f64,
    op_speed: *const f64,
    op_rot_speed: *const f64,
    op_count: u32,
    wall_vert_counts: *const u32,
    wall_verts: *const f64,
    wall_count: u32,
    bullet_x: *const f64,
    bullet_y: *const f64,
    bullet_vx: *const f64,
    bullet_vy: *const f64,
    bullet_radius: *const f64,
    bullet_life_left: *const f64,
    bullet_active: *const u8,
    bullet_count: u32,
    duration_frames: u32,
    out_x: *mut f64,
    out_y: *mut f64,
    out_rot: *mut f64,
    out_dead: *mut u8,
    out_death_frame: *mut i32,
) -> i32 {
    use rollout::{
        BulletInput, OpInput, RolloutCache, RolloutInput, StartPose, WallPoly, MAX_BULLETS,
        MAX_FRAMES, MAX_OPS, MAX_WALLS,
    };

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if op_count == 0 || op_count > MAX_OPS as u32 {
            return 0;
        }
        if duration_frames > MAX_FRAMES as u32 {
            return 0;
        }
        if wall_count > MAX_WALLS as u32 {
            return 0;
        }
        if bullet_count > MAX_BULLETS as u32 {
            return 0;
        }
        if op_speed.is_null()
            || op_rot_speed.is_null()
            || wall_vert_counts.is_null()
            || wall_verts.is_null()
            || bullet_x.is_null()
            || bullet_y.is_null()
            || bullet_vx.is_null()
            || bullet_vy.is_null()
            || bullet_radius.is_null()
            || bullet_life_left.is_null()
            || bullet_active.is_null()
            || out_x.is_null()
            || out_y.is_null()
            || out_rot.is_null()
            || out_dead.is_null()
            || out_death_frame.is_null()
        {
            return 0;
        }

        let op_count_u = op_count as usize;
        let wall_count_u = wall_count as usize;
        let bullet_count_u = bullet_count as usize;
        let duration_u = duration_frames as usize;
        let sample_stride = duration_u + 1;

        let op_speed_slice = unsafe { std::slice::from_raw_parts(op_speed, op_count_u) };
        let op_rot_speed_slice = unsafe { std::slice::from_raw_parts(op_rot_speed, op_count_u) };

        // Read wall vertex counts and validate before summing.
        let wall_vert_counts_slice =
            unsafe { std::slice::from_raw_parts(wall_vert_counts, wall_count_u) };
        let mut total_wall_verts = 0usize;
        for &c in wall_vert_counts_slice {
            if c < 3 || c as usize > 8 {
                return 0;
            }
            total_wall_verts += c as usize;
            if total_wall_verts > MAX_WALLS * 8 {
                return 0;
            }
        }
        let wall_verts_slice =
            unsafe { std::slice::from_raw_parts(wall_verts, total_wall_verts * 2) };

        let bullet_x_slice = unsafe { std::slice::from_raw_parts(bullet_x, bullet_count_u) };
        let bullet_y_slice = unsafe { std::slice::from_raw_parts(bullet_y, bullet_count_u) };
        let bullet_vx_slice = unsafe { std::slice::from_raw_parts(bullet_vx, bullet_count_u) };
        let bullet_vy_slice = unsafe { std::slice::from_raw_parts(bullet_vy, bullet_count_u) };
        let bullet_radius_slice =
            unsafe { std::slice::from_raw_parts(bullet_radius, bullet_count_u) };
        let bullet_life_left_slice =
            unsafe { std::slice::from_raw_parts(bullet_life_left, bullet_count_u) };
        let bullet_active_slice =
            unsafe { std::slice::from_raw_parts(bullet_active, bullet_count_u) };

        let mut walls = Vec::with_capacity(wall_count_u);
        let mut offset = 0usize;
        for &vc in wall_vert_counts_slice {
            let mut verts = Vec::with_capacity(vc as usize);
            for _ in 0..vc {
                verts.push((wall_verts_slice[offset], wall_verts_slice[offset + 1]));
                offset += 2;
            }
            walls.push(WallPoly { vertices: verts });
        }

        let ops: Vec<OpInput> = (0..op_count_u)
            .map(|i| OpInput {
                speed: op_speed_slice[i],
                rotation_speed: op_rot_speed_slice[i],
            })
            .collect();

        let bullets: Vec<BulletInput> = (0..bullet_count_u)
            .map(|i| BulletInput {
                x: bullet_x_slice[i],
                y: bullet_y_slice[i],
                vx: bullet_vx_slice[i],
                vy: bullet_vy_slice[i],
                radius: bullet_radius_slice[i],
                life_left: bullet_life_left_slice[i],
                active: bullet_active_slice[i] != 0,
            })
            .collect();

        let input = RolloutInput {
            start_pose: StartPose {
                x: start_x,
                y: start_y,
                rot: start_rot,
            },
            ops,
            duration_frames,
            walls,
            bullets,
            cache_id,
        };

        static CACHES: std::sync::OnceLock<
            std::sync::Mutex<std::collections::HashMap<u64, RolloutCache>>,
        > = std::sync::OnceLock::new();
        let mut caches_guard = CACHES
            .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let cache = caches_guard.entry(cache_id).or_default();
        let output = match rollout::run_rollout_batch(cache, &input) {
            Ok(o) => o,
            Err(_) => return 0,
        };

        let out_x_slice =
            unsafe { std::slice::from_raw_parts_mut(out_x, op_count_u * sample_stride) };
        let out_y_slice =
            unsafe { std::slice::from_raw_parts_mut(out_y, op_count_u * sample_stride) };
        let out_rot_slice =
            unsafe { std::slice::from_raw_parts_mut(out_rot, op_count_u * sample_stride) };
        let out_dead_slice = unsafe { std::slice::from_raw_parts_mut(out_dead, op_count_u) };
        let out_death_frame_slice =
            unsafe { std::slice::from_raw_parts_mut(out_death_frame, op_count_u) };

        for op in 0..op_count_u {
            let samples = &output.samples[op];
            for (frame, sample) in samples.iter().enumerate() {
                let idx = op * sample_stride + frame;
                out_x_slice[idx] = sample.x;
                out_y_slice[idx] = sample.y;
                out_rot_slice[idx] = sample.rot;
            }
            out_dead_slice[op] = if output.dead[op] { 1 } else { 0 };
            out_death_frame_slice[op] = output.death_frame[op];
        }
        1
    }));

    match result {
        Ok(v) => v,
        Err(_) => 0,
    }
}

/// Flat-buffer incremental rescore + death-verification ABI (v5).
///
/// See `rescore.rs` for the pure struct definitions.  All geometry is `f64`.
/// Fixed limits: nodes <= 512, samples per node <= 76, scored frames <= 75,
/// threats <= 64, track/path points per threat <= 4096, walls <= 1024.
///
/// The tank trajectories are NOT re-simulated: `samples_x/y/rot` are the
/// already-stored `rolloutSamples` (node-major, `sample_counts[ni]` samples).
/// The dedicated verification world is keyed by `cache_id` + wall signature
/// and is independent from the `vt_rollout_batch` fused world.
///
/// Incremental inputs (v4):
/// - `prev_per_frame_scores`: node-major, `node_count * 75` values (stride
///   75); MAY be null.  When non-null, the first `scored_frames` values for
///   each node are used as that node's previous scores; frames beyond the
///   node's scored length are ignored.  A node only uses the cached path when
///   its previous-score length equals its scored frame count.
/// - `threat_is_new`: one `u8` per threat; MAY be null only when
///   `threat_count == 0`.  Non-zero marks a threat as newly added since the
///   previous scores were computed.
///
/// Outputs:
/// - `out_per_frame_scores`: node-major, `node_count * 75` values; frames
///   beyond a node's actual scored frames are zero-padded.
/// - `out_total_score`, `out_death_frame`, `out_verified_frames`: one per node.
/// - `out_ok`: one per node, 1 = ok, 0 = fallback needed (e.g. spring rope
///   scoring is unsupported by the Rust core).
///
/// Returns 1 when the call itself is valid (including the spring-rope
/// fallback case, where `out_ok` is zeroed), 0 on bad pointers/sizes or an
/// internal error.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn vt_rescore_nodes(
    cache_id: u64,
    node_count: u32,
    sample_counts: *const u32,
    samples_x: *const f64,
    samples_y: *const f64,
    samples_rot: *const f64,
    start_t: *const f64,
    moving: *const u8,
    frames: *const u32,
    wall_vert_counts: *const u32,
    wall_verts: *const f64,
    wall_count: u32,
    threat_count: u32,
    threat_track_counts: *const u32,
    track_x: *const f64,
    track_y: *const f64,
    track_alive: *const u8,
    threat_path_counts: *const u32,
    path_x: *const f64,
    path_y: *const f64,
    anchor_offset: *const f64,
    speed: *const f64,
    bullet_radius: *const f64,
    life_left_seconds: *const f64,
    death_penalty: f64,
    stuck_penalty: f64,
    stuck_dist_eps: f64,
    stuck_rot_eps: f64,
    lane_penalty_ratio: f64,
    spring_rope_enabled: u8,
    occlusion_enabled: u8,
    prev_per_frame_scores: *const f64,
    threat_is_new: *const u8,
    node_has_prev_scores: *const u8,
    prev_death_frame: *const i32,
    out_per_frame_scores: *mut f64,
    out_total_score: *mut f64,
    out_death_frame: *mut i32,
    out_verified_frames: *mut u32,
    out_ok: *mut u8,
) -> i32 {
    use rescore::{
        RescoreConfig, RescoreNodeInput, RescoreThreatInput, TankPoseLike, ThreatPathPoint,
        ThreatTrackPoint, MAX_RESCORE_FRAMES, MAX_RESCORE_NODES, MAX_RESCORE_PATH_POINTS,
        MAX_RESCORE_SAMPLES, MAX_RESCORE_THREATS, MAX_RESCORE_TRACK_POINTS,
    };
    use rollout::{VerificationCache, WallPoly, MAX_WALLS};

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if node_count == 0 || node_count > MAX_RESCORE_NODES as u32 {
            return 0;
        }
        if threat_count > MAX_RESCORE_THREATS as u32 {
            return 0;
        }
        if wall_count > MAX_WALLS as u32 {
            return 0;
        }
        if sample_counts.is_null()
            || samples_x.is_null()
            || samples_y.is_null()
            || samples_rot.is_null()
            || start_t.is_null()
            || moving.is_null()
            || frames.is_null()
            || wall_vert_counts.is_null()
            || wall_verts.is_null()
            || node_has_prev_scores.is_null()
            || prev_death_frame.is_null()
            || out_per_frame_scores.is_null()
            || out_total_score.is_null()
            || out_death_frame.is_null()
            || out_verified_frames.is_null()
            || out_ok.is_null()
        {
            return 0;
        }
        if threat_count > 0
            && (threat_track_counts.is_null()
                || track_x.is_null()
                || track_y.is_null()
                || track_alive.is_null()
                || threat_path_counts.is_null()
                || path_x.is_null()
                || path_y.is_null()
                || anchor_offset.is_null()
                || speed.is_null()
                || bullet_radius.is_null()
                || life_left_seconds.is_null()
                || threat_is_new.is_null())
        {
            return 0;
        }

        let node_count_u = node_count as usize;
        let threat_count_u = threat_count as usize;
        let wall_count_u = wall_count as usize;

        let sample_counts_slice =
            unsafe { std::slice::from_raw_parts(sample_counts, node_count_u) };
        let mut total_samples = 0usize;
        for &c in sample_counts_slice {
            if c == 0 || c as usize > MAX_RESCORE_SAMPLES {
                return 0;
            }
            total_samples += c as usize;
            if total_samples > MAX_RESCORE_NODES * MAX_RESCORE_SAMPLES {
                return 0;
            }
        }

        let frames_slice = unsafe { std::slice::from_raw_parts(frames, node_count_u) };
        for &f in frames_slice {
            if f as usize > MAX_RESCORE_FRAMES {
                return 0;
            }
        }

        // Read wall vertex counts and validate before summing.
        let wall_vert_counts_slice =
            unsafe { std::slice::from_raw_parts(wall_vert_counts, wall_count_u) };
        let mut total_wall_verts = 0usize;
        for &c in wall_vert_counts_slice {
            if c < 3 || c as usize > 8 {
                return 0;
            }
            total_wall_verts += c as usize;
            if total_wall_verts > MAX_WALLS * 8 {
                return 0;
            }
        }
        let wall_verts_slice =
            unsafe { std::slice::from_raw_parts(wall_verts, total_wall_verts * 2) };

        let samples_x_slice = unsafe { std::slice::from_raw_parts(samples_x, total_samples) };
        let samples_y_slice = unsafe { std::slice::from_raw_parts(samples_y, total_samples) };
        let samples_rot_slice = unsafe { std::slice::from_raw_parts(samples_rot, total_samples) };
        let start_t_slice = unsafe { std::slice::from_raw_parts(start_t, node_count_u) };
        let moving_slice = unsafe { std::slice::from_raw_parts(moving, node_count_u) };

        let mut walls = Vec::with_capacity(wall_count_u);
        let mut offset = 0usize;
        for &vc in wall_vert_counts_slice {
            let mut verts = Vec::with_capacity(vc as usize);
            for _ in 0..vc {
                verts.push((wall_verts_slice[offset], wall_verts_slice[offset + 1]));
                offset += 2;
            }
            walls.push(WallPoly { vertices: verts });
        }

        let has_prev_scores_slice =
            unsafe { std::slice::from_raw_parts(node_has_prev_scores, node_count_u) };
        let prev_death_slice =
            unsafe { std::slice::from_raw_parts(prev_death_frame, node_count_u) };
        let mut any_has_prev = false;
        for ni in 0..node_count_u {
            if has_prev_scores_slice[ni] != 0 {
                any_has_prev = true;
            }
            let pdf = prev_death_slice[ni];
            if !(-1..=MAX_RESCORE_FRAMES as i32).contains(&pdf) {
                return 0;
            }
        }
        if any_has_prev && prev_per_frame_scores.is_null() {
            return 0;
        }

        let prev_pfs_slice = if prev_per_frame_scores.is_null() {
            None
        } else {
            Some(unsafe {
                std::slice::from_raw_parts(prev_per_frame_scores, node_count_u * MAX_RESCORE_FRAMES)
            })
        };

        let mut nodes = Vec::with_capacity(node_count_u);
        let mut sample_offset = 0usize;
        for ni in 0..node_count_u {
            let sc = sample_counts_slice[ni] as usize;
            let mut samples = Vec::with_capacity(sc);
            for _ in 0..sc {
                samples.push(TankPoseLike::new(
                    samples_x_slice[sample_offset],
                    samples_y_slice[sample_offset],
                    samples_rot_slice[sample_offset],
                ));
                sample_offset += 1;
            }
            let scored = (frames_slice[ni] as usize).min(sc.saturating_sub(1));
            let has_prev = has_prev_scores_slice[ni] != 0;
            let previous_scores = if has_prev {
                let slice = prev_pfs_slice.as_ref().unwrap();
                let base = ni * MAX_RESCORE_FRAMES;
                Some(slice[base..base + scored].to_vec())
            } else {
                None
            };
            let previous_death_frame = if has_prev {
                Some(prev_death_slice[ni])
            } else {
                None
            };
            let node = RescoreNodeInput::new(
                samples,
                moving_slice[ni] != 0,
                start_t_slice[ni],
                frames_slice[ni] as usize,
            );
            let node = match previous_scores {
                Some(p) => node.with_previous_scores(p),
                None => node,
            };
            let node = match previous_death_frame {
                Some(d) => node.with_previous_death_frame(d),
                None => node,
            };
            nodes.push(node);
        }

        let threats = if threat_count_u > 0 {
            let threat_track_counts_slice =
                unsafe { std::slice::from_raw_parts(threat_track_counts, threat_count_u) };
            let threat_path_counts_slice =
                unsafe { std::slice::from_raw_parts(threat_path_counts, threat_count_u) };
            let mut total_track = 0usize;
            let mut total_path = 0usize;
            for ti in 0..threat_count_u {
                let tc = threat_track_counts_slice[ti] as usize;
                let pc = threat_path_counts_slice[ti] as usize;
                if tc > MAX_RESCORE_TRACK_POINTS || pc > MAX_RESCORE_PATH_POINTS {
                    return 0;
                }
                total_track += tc;
                total_path += pc;
                if total_track > MAX_RESCORE_THREATS * MAX_RESCORE_TRACK_POINTS
                    || total_path > MAX_RESCORE_THREATS * MAX_RESCORE_PATH_POINTS
                {
                    return 0;
                }
            }

            let track_x_slice = unsafe { std::slice::from_raw_parts(track_x, total_track) };
            let track_y_slice = unsafe { std::slice::from_raw_parts(track_y, total_track) };
            let track_alive_slice = unsafe { std::slice::from_raw_parts(track_alive, total_track) };
            let path_x_slice = unsafe { std::slice::from_raw_parts(path_x, total_path) };
            let path_y_slice = unsafe { std::slice::from_raw_parts(path_y, total_path) };
            let anchor_offset_slice =
                unsafe { std::slice::from_raw_parts(anchor_offset, threat_count_u) };
            let speed_slice = unsafe { std::slice::from_raw_parts(speed, threat_count_u) };
            let bullet_radius_slice =
                unsafe { std::slice::from_raw_parts(bullet_radius, threat_count_u) };
            let life_left_slice =
                unsafe { std::slice::from_raw_parts(life_left_seconds, threat_count_u) };

            let mut threats = Vec::with_capacity(threat_count_u);
            let mut track_offset = 0usize;
            let mut path_offset = 0usize;
            for ti in 0..threat_count_u {
                let tc = threat_track_counts_slice[ti] as usize;
                let pc = threat_path_counts_slice[ti] as usize;
                let track = if tc > 0 {
                    let mut v = Vec::with_capacity(tc);
                    for j in 0..tc {
                        v.push(ThreatTrackPoint::new(
                            track_x_slice[track_offset + j],
                            track_y_slice[track_offset + j],
                            track_alive_slice[track_offset + j] != 0,
                        ));
                    }
                    track_offset += tc;
                    Some(v)
                } else {
                    None
                };
                let path = if pc > 0 {
                    let mut v = Vec::with_capacity(pc);
                    for j in 0..pc {
                        v.push(ThreatPathPoint::new(
                            path_x_slice[path_offset + j],
                            path_y_slice[path_offset + j],
                        ));
                    }
                    path_offset += pc;
                    Some(v)
                } else {
                    None
                };
                // Laser radius 0.0 is legal in the game.
                if bullet_radius_slice[ti] < 0.0 || bullet_radius_slice[ti].is_nan() {
                    return 0;
                }
                let threat_is_new_slice =
                    unsafe { std::slice::from_raw_parts(threat_is_new, threat_count_u) };
                threats.push(RescoreThreatInput {
                    id: ti as i64,
                    track,
                    path,
                    speed: speed_slice[ti],
                    anchor_offset: anchor_offset_slice[ti],
                    bullet_radius: bullet_radius_slice[ti],
                    life_left_seconds: life_left_slice[ti],
                    is_new: threat_is_new_slice[ti] != 0,
                });
            }
            threats
        } else {
            Vec::new()
        };

        let cfg = RescoreConfig {
            death_penalty,
            stuck_penalty,
            stuck_dist_eps,
            stuck_rot_eps,
            lane_penalty_ratio,
            spring_rope_enabled: spring_rope_enabled != 0,
            occlusion_enabled: occlusion_enabled != 0,
        };

        static CACHES: std::sync::OnceLock<
            std::sync::Mutex<std::collections::HashMap<u64, VerificationCache>>,
        > = std::sync::OnceLock::new();
        let mut caches_guard = CACHES
            .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let cache = caches_guard.entry(cache_id).or_default();

        let per_frame_stride = MAX_RESCORE_FRAMES;
        let out_pfs_slice = unsafe {
            std::slice::from_raw_parts_mut(out_per_frame_scores, node_count_u * per_frame_stride)
        };
        let out_total_slice =
            unsafe { std::slice::from_raw_parts_mut(out_total_score, node_count_u) };
        let out_death_slice =
            unsafe { std::slice::from_raw_parts_mut(out_death_frame, node_count_u) };
        let out_verified_slice =
            unsafe { std::slice::from_raw_parts_mut(out_verified_frames, node_count_u) };
        let out_ok_slice = unsafe { std::slice::from_raw_parts_mut(out_ok, node_count_u) };
        out_pfs_slice.fill(0.0);
        out_total_slice.fill(0.0);
        out_death_slice.fill(-1);
        out_verified_slice.fill(0);
        out_ok_slice.fill(0);

        match rescore::rescore_nodes(cache, &walls, &nodes, &threats, &cfg) {
            Ok(outputs) => {
                for (ni, out) in outputs.iter().enumerate() {
                    let base = ni * per_frame_stride;
                    for (fi, v) in out.per_frame_scores.iter().enumerate() {
                        if fi >= per_frame_stride {
                            break;
                        }
                        out_pfs_slice[base + fi] = *v;
                    }
                    out_total_slice[ni] = out.total_score;
                    out_death_slice[ni] = out.death_frame;
                    out_verified_slice[ni] = out.verified_frames;
                    out_ok_slice[ni] = 1;
                }
                1
            }
            Err(rescore::RescoreError::SpringRopeUnsupported) => {
                // Call is valid; per-node ok=0 signals JS fallback.
                1
            }
            Err(_) => 0,
        }
    }));

    match result {
        Ok(v) => v,
        Err(_) => 0,
    }
}

/// Axis-aligned wall rectangle, same coordinate and shape as the C ABI
/// `vt_build_wall_rects` output records.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub min_x: f32,
    pub min_y: f32,
    pub max_x: f32,
    pub max_y: f32,
}

impl Rect {
    pub fn new(min_x: f32, min_y: f32, max_x: f32, max_y: f32) -> Self {
        Self {
            min_x,
            min_y,
            max_x,
            max_y,
        }
    }
}

/// Internal wall-rectangle builder shared by the C ABI and `scoring`.
///
/// Generates rectangles in exactly the order `vt_build_wall_rects` has always
/// emitted them: top walls, left walls (i outer, j inner), then bottom boundary
/// (last row, i ascending), then right boundary (last column, j ascending).
pub(crate) fn build_wall_rects_vec(
    tiles: &[u8],
    width: u32,
    height: u32,
    tile_size: f32,
    wall_width: f32,
) -> Vec<Rect> {
    let hw = wall_width * 0.5;
    let height_u = height as usize;
    let mut rects = Vec::new();

    let mut i = 0u32;
    while i < width {
        let mut j = 0u32;
        while j < height {
            let idx = (i as usize * height_u + j as usize) * 3;

            if tiles[idx + 1] == 1 {
                rects.push(Rect::new(
                    i as f32 * tile_size - hw,
                    j as f32 * tile_size - hw,
                    (i + 1) as f32 * tile_size + hw,
                    j as f32 * tile_size + hw,
                ));
            }
            if tiles[idx + 2] == 1 {
                rects.push(Rect::new(
                    i as f32 * tile_size - hw,
                    j as f32 * tile_size - hw,
                    i as f32 * tile_size + hw,
                    (j + 1) as f32 * tile_size + hw,
                ));
            }
            j += 1;
        }
        i += 1;
    }

    // Bottom boundary (last row): floor tiles generate an outer rect.
    let last_j = height - 1;
    i = 0;
    while i < width {
        let idx = (i as usize * height_u + last_j as usize) * 3;
        if tiles[idx] == 1 {
            rects.push(Rect::new(
                i as f32 * tile_size - hw,
                height as f32 * tile_size - hw,
                (i + 1) as f32 * tile_size + hw,
                height as f32 * tile_size + hw,
            ));
        }
        i += 1;
    }

    // Right boundary (last column): floor tiles generate an outer rect.
    let last_i = width - 1;
    let mut j = 0u32;
    while j < height {
        let idx = (last_i as usize * height_u + j as usize) * 3;
        if tiles[idx] == 1 {
            rects.push(Rect::new(
                width as f32 * tile_size - hw,
                j as f32 * tile_size - hw,
                width as f32 * tile_size + hw,
                (j + 1) as f32 * tile_size + hw,
            ));
        }
        j += 1;
    }

    rects
}

/// Build wall rectangles from maze tile data.
///
/// `tiles` layout: `[width][height][3]` with `tile[0] = floor`,
/// `tile[1] = top wall`, `tile[2] = left wall`. Each output rect is
/// `[minX, minY, maxX, maxY]` (4 `f32`). The geometry mirrors
/// `game_core/js/vantage_scoring.js` `getMazeWallEnv` before rectangle merging.
///
/// Returns the number of rects that would be written, capped at `out_capacity`.
/// Passing `out = null` returns 0.
#[no_mangle]
pub extern "C" fn vt_build_wall_rects(
    tiles: *const u8,
    width: u32,
    height: u32,
    tile_size: f32,
    wall_width: f32,
    out: *mut f32,
    out_capacity: u32,
) -> u32 {
    if tiles.is_null() || out.is_null() || width == 0 || height == 0 || out_capacity == 0 {
        return 0;
    }

    // Guard against usize overflow when computing flat indices.
    let total_cells = width as u64 * height as u64 * 3u64;
    if total_cells > usize::MAX as u64 {
        return 0;
    }

    let tiles_slice = unsafe { std::slice::from_raw_parts(tiles, total_cells as usize) };
    let rects = build_wall_rects_vec(tiles_slice, width, height, tile_size, wall_width);

    let write_count = (rects.len() as u64).min(out_capacity as u64) as usize;
    for (idx, rect) in rects.iter().take(write_count).enumerate() {
        let base = unsafe { out.add(idx * 4) };
        unsafe {
            *base = rect.min_x;
            *base.add(1) = rect.min_y;
            *base.add(2) = rect.max_x;
            *base.add(3) = rect.max_y;
        }
    }

    if rects.len() as u64 > out_capacity as u64 {
        out_capacity
    } else {
        rects.len() as u32
    }
}

/// Conservative danger coarse filter for rollout node frames.
///
/// Guarantees no false negatives: if this function leaves a node frame at 0,
/// the bullet cannot be within `margin` of the node under the conservative
/// max-move bound. It deliberately allows false positives and performs no
/// exact collision or death decision.
///
/// `out_flags` has length `node_frames`; the caller zeroes it. Returns the
/// number of node frames marked dangerous (1).
#[no_mangle]
pub extern "C" fn vt_sweep_danger_frames(
    node_x: *const f32,
    node_y: *const f32,
    _node_rot: *const f32,
    node_t0: f32,
    node_dt: f32,
    node_frames: u32,
    bullet_x: *const f32,
    bullet_y: *const f32,
    bullet_vx: *const f32,
    bullet_vy: *const f32,
    bullet_alive: *const u8,
    bullet_t0: f32,
    bullet_dt: f32,
    bullet_frames: u32,
    margin: f32,
    out_flags: *mut u8,
) -> u32 {
    if node_frames == 0 || bullet_frames == 0 {
        return 0;
    }
    if node_x.is_null() || node_y.is_null() || _node_rot.is_null() {
        return 0;
    }
    if bullet_x.is_null()
        || bullet_y.is_null()
        || bullet_vx.is_null()
        || bullet_vy.is_null()
        || bullet_alive.is_null()
    {
        return 0;
    }
    if out_flags.is_null() {
        return 0;
    }

    let node_half = node_dt * 0.5;
    let bullet_half = bullet_dt * 0.5;
    let overlap = node_half + bullet_half;
    let mut danger_count: u32 = 0;

    unsafe {
        let mut k = 0u32;
        while k < node_frames {
            let tn = node_t0 + k as f32 * node_dt;
            let nx = *node_x.add(k as usize);
            let ny = *node_y.add(k as usize);
            let mut danger = false;

            let mut j = 0u32;
            while j < bullet_frames {
                if *bullet_alive.add(j as usize) == 0 {
                    j += 1;
                    continue;
                }

                let tb = bullet_t0 + j as f32 * bullet_dt;
                if (tn - tb).abs() <= overlap {
                    let bx = *bullet_x.add(j as usize);
                    let by = *bullet_y.add(j as usize);
                    let dx = bx - nx;
                    let dy = by - ny;
                    let speed =
                        (*bullet_vx.add(j as usize)).abs() + (*bullet_vy.add(j as usize)).abs();
                    let max_move = speed * overlap;
                    if (dx * dx + dy * dy).sqrt() <= margin + max_move {
                        danger = true;
                        break;
                    }
                }
                j += 1;
            }

            if danger {
                *out_flags.add(k as usize) = 1;
                danger_count += 1;
            }
            k += 1;
        }
    }

    danger_count
}

/// Minimal closed-loop decision bridge for the 9-operation, 75-frame
/// rollout scoring array.
///
/// All arrays are caller-owned flat buffers:
/// - `total_scores`, `dead_flags`, `death_frames`: one element per candidate
/// - `per_frame_scores`: candidate-major, `frames_per_candidate` values each
/// - `candidate_count` and `frames_per_candidate` are validated and must be
///   [`minimal::C_ABI_CANDIDATE_COUNT`] and [`minimal::C_ABI_FRAMES`].
///
/// `out_selected_index` and `out_segment_frames` receive the selected op index
/// and the selected candidate's actual segment length. Returns 1 on success,
/// 0 on any null pointer / length / decision error. This function never
/// allocates cross-language memory and never unwinds a panic into WASM.
#[no_mangle]
pub extern "C" fn vt_minimal_decide(
    total_scores: *const f64,
    dead_flags: *const u8,
    death_frames: *const i64,
    per_frame_scores: *const f64,
    candidate_count: u32,
    frames_per_candidate: u32,
    epsilon: f64,
    t_min: u32,
    t_max: u32,
    out_selected_index: *mut i32,
    out_segment_frames: *mut i32,
) -> i32 {
    use minimal::{minimal_decide, CandidateInput, C_ABI_CANDIDATE_COUNT, C_ABI_FRAMES};

    if candidate_count as usize != C_ABI_CANDIDATE_COUNT
        || frames_per_candidate as usize != C_ABI_FRAMES
    {
        return 0;
    }
    if total_scores.is_null()
        || dead_flags.is_null()
        || death_frames.is_null()
        || per_frame_scores.is_null()
        || out_selected_index.is_null()
        || out_segment_frames.is_null()
    {
        return 0;
    }

    let count = C_ABI_CANDIDATE_COUNT;
    let frames = C_ABI_FRAMES;

    let total_scores = unsafe { std::slice::from_raw_parts(total_scores, count) };
    let dead_flags = unsafe { std::slice::from_raw_parts(dead_flags, count) };
    let death_frames = unsafe { std::slice::from_raw_parts(death_frames, count) };
    let per_frame_scores = unsafe { std::slice::from_raw_parts(per_frame_scores, count * frames) };

    let candidates: Vec<CandidateInput> = (0..count)
        .map(|i| {
            let base = i * frames;
            CandidateInput {
                op_name: minimal::operation_name_for_index(i).to_string(),
                total_score: total_scores[i],
                dead: dead_flags[i] != 0,
                death_frame: death_frames[i],
                per_frame_scores: per_frame_scores[base..base + frames].to_vec(),
            }
        })
        .collect();

    match minimal_decide(&candidates, epsilon, t_min as usize, t_max as usize) {
        Some(decision) => unsafe {
            *out_selected_index = decision.selected_index as i32;
            *out_segment_frames = decision.segment_frames as i32;
            1
        },
        None => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_f32_close(a: f32, b: f32) {
        assert!((a - b).abs() < 1e-5, "expected {} to be close to {}", a, b);
    }

    fn make_tiles(width: u32, height: u32) -> Vec<u8> {
        vec![0u8; width as usize * height as usize * 3]
    }

    fn set_tile(tiles: &mut [u8], width: u32, height: u32, i: u32, j: u32, c: usize, value: u8) {
        let idx = (i as usize * height as usize + j as usize) * 3 + c;
        assert!(idx < tiles.len());
        tiles[idx] = value;
        let _ = width;
    }

    fn get_tile(tiles: &[u8], width: u32, height: u32, i: u32, j: u32, c: usize) -> u8 {
        let idx = (i as usize * height as usize + j as usize) * 3 + c;
        let _ = width;
        tiles[idx]
    }

    #[test]
    fn test_version() {
        assert_eq!(vt_version(), 7);
    }

    #[test]
    fn test_vt_rescore_nodes_single_node_no_threats() {
        let sample_counts = [3u32];
        let samples_x = [5.0f64, 5.0, 5.0];
        let samples_y = [8.0f64, 8.0, 8.0];
        let samples_rot = [0.0f64; 3];
        let start_t = [0.0f64];
        let moving = [0u8];
        let frames = [2u32];
        let wall_counts = [0u32];
        let wall_verts = [0.0f64];
        let has_prev = [0u8; 64];
        let prev_death = [-1i32; 64];
        let mut out_pfs = vec![0.0f64; 64 * 75];
        let mut out_total = vec![0.0f64; 64];
        let mut out_death = vec![0i32; 64];
        let mut out_verified = vec![0u32; 64];
        let mut out_ok = vec![0u8; 64];

        let ok = vt_rescore_nodes(
            0,
            1,
            sample_counts.as_ptr(),
            samples_x.as_ptr(),
            samples_y.as_ptr(),
            samples_rot.as_ptr(),
            start_t.as_ptr(),
            moving.as_ptr(),
            frames.as_ptr(),
            wall_counts.as_ptr(),
            wall_verts.as_ptr(),
            0,
            0,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0.0,
            4.0,
            0.05,
            0.05,
            0.0,
            0,
            1,
            std::ptr::null(),
            std::ptr::null(),
            has_prev.as_ptr(),
            prev_death.as_ptr(),
            out_pfs.as_mut_ptr(),
            out_total.as_mut_ptr(),
            out_death.as_mut_ptr(),
            out_verified.as_mut_ptr(),
            out_ok.as_mut_ptr(),
        );

        assert_eq!(ok, 1);
        assert_eq!(out_ok[0], 1);
        assert_eq!(out_death[0], -1);
        assert_eq!(out_verified[0], 0);
        assert_eq!(out_pfs[0], 39.47841760435743);
        assert_eq!(out_pfs[1], 39.47841760435743);
        assert_eq!(out_total[0], 78.95683520871486);
        assert_eq!(out_pfs[2], 0.0);
    }

    #[test]
    fn test_vt_rescore_nodes_previous_scores_and_is_new_params() {
        let sample_counts = [3u32];
        let samples_x = [5.0f64, 5.0, 5.0];
        let samples_y = [8.0f64, 8.0, 8.0];
        let samples_rot = [0.0f64; 3];
        let start_t = [0.0f64];
        let moving = [0u8];
        let frames = [2u32];
        let wall_counts = [0u32];
        let wall_verts = [0.0f64];
        let mut prev = vec![0.0f64; 75];
        prev[0] = 39.47841760435743;
        prev[1] = 39.47841760435743;
        let threat_is_new: [u8; 0] = [];
        let has_prev = [1u8];
        let prev_death = [-1i32];
        let mut out_pfs = vec![0.0f64; 64 * 75];
        let mut out_total = vec![0.0f64; 64];
        let mut out_death = vec![0i32; 64];
        let mut out_verified = vec![0u32; 64];
        let mut out_ok = vec![0u8; 64];

        let ok = vt_rescore_nodes(
            0,
            1,
            sample_counts.as_ptr(),
            samples_x.as_ptr(),
            samples_y.as_ptr(),
            samples_rot.as_ptr(),
            start_t.as_ptr(),
            moving.as_ptr(),
            frames.as_ptr(),
            wall_counts.as_ptr(),
            wall_verts.as_ptr(),
            0,
            0,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0.0,
            4.0,
            0.05,
            0.05,
            0.0,
            0,
            1,
            prev.as_ptr(),
            threat_is_new.as_ptr(),
            has_prev.as_ptr(),
            prev_death.as_ptr(),
            out_pfs.as_mut_ptr(),
            out_total.as_mut_ptr(),
            out_death.as_mut_ptr(),
            out_verified.as_mut_ptr(),
            out_ok.as_mut_ptr(),
        );

        assert_eq!(ok, 1);
        assert_eq!(out_ok[0], 1);
        assert_eq!(out_pfs[0], prev[0]);
        assert_eq!(out_pfs[1], prev[1]);
        assert_eq!(out_total[0], prev[0] + prev[1]);
        assert_eq!(out_pfs[2], 0.0);
    }

    #[test]
    fn test_vt_rescore_nodes_rejects_missing_threat_is_new() {
        // threat_count > 0 requires threat_is_new to be non-null.
        let sample_counts = [3u32];
        let samples_x = [5.0f64, 5.0, 5.0];
        let samples_y = [8.0f64, 8.0, 8.0];
        let samples_rot = [0.0f64; 3];
        let start_t = [0.0f64];
        let moving = [0u8];
        let frames = [2u32];
        let wall_counts = [0u32];
        let wall_verts = [0.0f64];
        let has_prev = [0u8; 64];
        let prev_death = [-1i32; 64];
        let mut out_pfs = vec![0.0f64; 64 * 75];
        let mut out_total = vec![0.0f64; 64];
        let mut out_death = vec![0i32; 64];
        let mut out_verified = vec![0u32; 64];
        let mut out_ok = vec![0u8; 64];

        let ok = vt_rescore_nodes(
            0,
            1,
            sample_counts.as_ptr(),
            samples_x.as_ptr(),
            samples_y.as_ptr(),
            samples_rot.as_ptr(),
            start_t.as_ptr(),
            moving.as_ptr(),
            frames.as_ptr(),
            wall_counts.as_ptr(),
            wall_verts.as_ptr(),
            0,
            1,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0.0,
            4.0,
            0.05,
            0.05,
            0.0,
            0,
            1,
            std::ptr::null(),
            std::ptr::null(),
            has_prev.as_ptr(),
            prev_death.as_ptr(),
            out_pfs.as_mut_ptr(),
            out_total.as_mut_ptr(),
            out_death.as_mut_ptr(),
            out_verified.as_mut_ptr(),
            out_ok.as_mut_ptr(),
        );

        assert_eq!(ok, 0);
    }

    #[test]
    fn test_vt_minimal_decide_writes_outputs() {
        let mut totals = [100.0f64; 9];
        totals[1] = 200.0;
        let dead = [0u8; 9];
        let death = [-1i64; 9];
        let pfs = [1.0f64; 9 * 75];
        let mut selected = -1i32;
        let mut segment = -1i32;

        let ok = vt_minimal_decide(
            totals.as_ptr(),
            dead.as_ptr(),
            death.as_ptr(),
            pfs.as_ptr(),
            9,
            75,
            9.869604401089358,
            3,
            30,
            &mut selected,
            &mut segment,
        );
        assert_eq!(ok, 1);
        assert_eq!(selected, 1);
        assert_eq!(segment, 30);
    }

    #[test]
    fn test_vt_minimal_decide_rejects_bad_lengths_or_null() {
        let totals = [100.0f64; 9];
        let dead = [0u8; 9];
        let death = [-1i64; 9];
        let pfs = [1.0f64; 9 * 75];
        let mut selected = -1i32;
        let mut segment = -1i32;

        // Wrong candidate count.
        assert_eq!(
            vt_minimal_decide(
                totals.as_ptr(),
                dead.as_ptr(),
                death.as_ptr(),
                pfs.as_ptr(),
                8,
                75,
                9.869604401089358,
                3,
                30,
                &mut selected,
                &mut segment
            ),
            0
        );

        // Null output pointer.
        assert_eq!(
            vt_minimal_decide(
                totals.as_ptr(),
                dead.as_ptr(),
                death.as_ptr(),
                pfs.as_ptr(),
                9,
                75,
                9.869604401089358,
                3,
                30,
                std::ptr::null_mut(),
                &mut segment
            ),
            0
        );
    }

    #[test]
    fn test_wall_rects_3x3_top_and_left() {
        let width: u32 = 3;
        let height: u32 = 3;
        let tile_size: f32 = 10.0;
        let wall_width: f32 = 0.8;
        let hw = wall_width * 0.5;

        let mut tiles = make_tiles(width, height);
        set_tile(&mut tiles, width, height, 1, 1, 1, 1); // top wall at (1,1)
        set_tile(&mut tiles, width, height, 1, 1, 2, 1); // left wall at (1,1)

        let mut out = vec![0f32; 4 * 4];
        let count = vt_build_wall_rects(
            tiles.as_ptr(),
            width,
            height,
            tile_size,
            wall_width,
            out.as_mut_ptr(),
            4,
        );

        assert_eq!(count, 2);

        // Loop order: i outer, j inner; top wall is pushed before left wall.
        // Top wall at tile (1,1): x from 1*T-hw to 2*T+hw, y from 1*T-hw to 1*T+hw.
        assert_f32_close(out[0], 1.0 * tile_size - hw);
        assert_f32_close(out[1], 1.0 * tile_size - hw);
        assert_f32_close(out[2], 2.0 * tile_size + hw);
        assert_f32_close(out[3], 1.0 * tile_size + hw);

        // Left wall at tile (1,1): x from 1*T-hw to 1*T+hw, y from 1*T-hw to 2*T+hw.
        assert_f32_close(out[4], 1.0 * tile_size - hw);
        assert_f32_close(out[5], 1.0 * tile_size - hw);
        assert_f32_close(out[6], 1.0 * tile_size + hw);
        assert_f32_close(out[7], 2.0 * tile_size + hw);
    }

    #[test]
    fn test_wall_rects_capacity_clamps() {
        let width: u32 = 2;
        let height: u32 = 2;
        let mut tiles = make_tiles(width, height);
        // Two top walls -> total 2 rects, but capacity only 1.
        set_tile(&mut tiles, width, height, 0, 0, 1, 1);
        set_tile(&mut tiles, width, height, 1, 0, 1, 1);

        let mut out = vec![0f32; 4];
        let count = vt_build_wall_rects(
            tiles.as_ptr(),
            width,
            height,
            10.0,
            0.8,
            out.as_mut_ptr(),
            1,
        );
        assert_eq!(count, 1);
        assert_eq!(out[0], -0.4);
        assert_eq!(out[1], -0.4);
        assert_eq!(out[2], 10.4);
        assert_eq!(out[3], 0.4);
    }

    #[test]
    fn test_wall_rects_boundary_floor_rows() {
        let width: u32 = 3;
        let height: u32 = 3;
        let tile_size: f32 = 10.0;
        let wall_width: f32 = 0.8;
        let hw = wall_width * 0.5;

        let mut tiles = make_tiles(width, height);
        // Bottom boundary: floor tile at (1, last_j) should add an outer rect.
        set_tile(&mut tiles, width, height, 1, height - 1, 0, 1);
        // Right boundary: floor tile at (last_i, 1) should add an outer rect.
        set_tile(&mut tiles, width, height, width - 1, 1, 0, 1);

        let mut out = vec![0f32; 4 * 4];
        let count = vt_build_wall_rects(
            tiles.as_ptr(),
            width,
            height,
            tile_size,
            wall_width,
            out.as_mut_ptr(),
            4,
        );
        assert_eq!(count, 2);

        // First pushed: bottom boundary for i=1.
        assert_f32_close(out[0], 1.0 * tile_size - hw);
        assert_f32_close(out[1], 3.0 * tile_size - hw);
        assert_f32_close(out[2], 2.0 * tile_size + hw);
        assert_f32_close(out[3], 3.0 * tile_size + hw);

        // Then right boundary for j=1.
        assert_f32_close(out[4], 3.0 * tile_size - hw);
        assert_f32_close(out[5], 1.0 * tile_size - hw);
        assert_f32_close(out[6], 3.0 * tile_size + hw);
        assert_f32_close(out[7], 2.0 * tile_size + hw);
    }

    #[test]
    fn test_sweep_danger_approaching_within_window() {
        let node_x = [0.0f32];
        let node_y = [0.0f32];
        let node_rot = [0.0f32];
        let bullet_x = [2.0f32];
        let bullet_y = [0.0f32];
        let bullet_vx = [50.0f32];
        let bullet_vy = [0.0f32];
        let bullet_alive = [1u8];
        let mut flags = [0u8; 1];

        let count = vt_sweep_danger_frames(
            node_x.as_ptr(),
            node_y.as_ptr(),
            node_rot.as_ptr(),
            0.0,
            0.02,
            1,
            bullet_x.as_ptr(),
            bullet_y.as_ptr(),
            bullet_vx.as_ptr(),
            bullet_vy.as_ptr(),
            bullet_alive.as_ptr(),
            0.0,
            0.02,
            1,
            1.5,
            flags.as_mut_ptr(),
        );

        assert_eq!(count, 1);
        assert_eq!(flags[0], 1);
    }

    #[test]
    fn test_sweep_danger_time_no_overlap() {
        let node_x = [0.0f32];
        let node_y = [0.0f32];
        let node_rot = [0.0f32];
        let bullet_x = [0.0f32];
        let bullet_y = [0.0f32];
        let bullet_vx = [0.0f32];
        let bullet_vy = [0.0f32];
        let bullet_alive = [1u8];
        let mut flags = [0u8; 1];

        let count = vt_sweep_danger_frames(
            node_x.as_ptr(),
            node_y.as_ptr(),
            node_rot.as_ptr(),
            0.0,
            0.02,
            1,
            bullet_x.as_ptr(),
            bullet_y.as_ptr(),
            bullet_vx.as_ptr(),
            bullet_vy.as_ptr(),
            bullet_alive.as_ptr(),
            10.0,
            0.02,
            1,
            100.0,
            flags.as_mut_ptr(),
        );

        assert_eq!(count, 0);
        assert_eq!(flags[0], 0);
    }

    #[test]
    fn test_sweep_danger_alive_zero_skips() {
        let node_x = [0.0f32];
        let node_y = [0.0f32];
        let node_rot = [0.0f32];
        let bullet_x = [0.0f32];
        let bullet_y = [0.0f32];
        let bullet_vx = [0.0f32];
        let bullet_vy = [0.0f32];
        let bullet_alive = [0u8];
        let mut flags = [0u8; 1];

        let count = vt_sweep_danger_frames(
            node_x.as_ptr(),
            node_y.as_ptr(),
            node_rot.as_ptr(),
            0.0,
            0.02,
            1,
            bullet_x.as_ptr(),
            bullet_y.as_ptr(),
            bullet_vx.as_ptr(),
            bullet_vy.as_ptr(),
            bullet_alive.as_ptr(),
            0.0,
            0.02,
            1,
            100.0,
            flags.as_mut_ptr(),
        );

        assert_eq!(count, 0);
        assert_eq!(flags[0], 0);
    }

    #[test]
    fn test_sweep_danger_far_bullet_with_time_overlap() {
        let node_x = [0.0f32];
        let node_y = [0.0f32];
        let node_rot = [0.0f32];
        let bullet_x = [1000.0f32];
        let bullet_y = [0.0f32];
        let bullet_vx = [0.0f32];
        let bullet_vy = [0.0f32];
        let bullet_alive = [1u8];
        let mut flags = [0u8; 1];

        let count = vt_sweep_danger_frames(
            node_x.as_ptr(),
            node_y.as_ptr(),
            node_rot.as_ptr(),
            0.0,
            0.02,
            1,
            bullet_x.as_ptr(),
            bullet_y.as_ptr(),
            bullet_vx.as_ptr(),
            bullet_vy.as_ptr(),
            bullet_alive.as_ptr(),
            0.0,
            0.02,
            1,
            1.0,
            flags.as_mut_ptr(),
        );

        assert_eq!(count, 0);
        assert_eq!(flags[0], 0);
    }

    #[test]
    fn test_sweep_danger_margin_equal_distance_not_missed() {
        let node_x = [0.0f32];
        let node_y = [0.0f32];
        let node_rot = [0.0f32];
        let bullet_x = [3.0f32];
        let bullet_y = [0.0f32];
        let bullet_vx = [0.0f32];
        let bullet_vy = [0.0f32];
        let bullet_alive = [1u8];
        let mut flags = [0u8; 1];

        let count = vt_sweep_danger_frames(
            node_x.as_ptr(),
            node_y.as_ptr(),
            node_rot.as_ptr(),
            0.0,
            0.02,
            1,
            bullet_x.as_ptr(),
            bullet_y.as_ptr(),
            bullet_vx.as_ptr(),
            bullet_vy.as_ptr(),
            bullet_alive.as_ptr(),
            0.0,
            0.02,
            1,
            3.0,
            flags.as_mut_ptr(),
        );

        assert_eq!(count, 1);
        assert_eq!(flags[0], 1);
    }

    #[test]
    fn test_null_pointer_protection_wall_rects() {
        let width: u32 = 3;
        let height: u32 = 3;
        let mut tiles = make_tiles(width, height);
        set_tile(&mut tiles, width, height, 1, 1, 1, 1);
        let mut out = vec![0f32; 4];

        assert_eq!(
            vt_build_wall_rects(
                std::ptr::null(),
                width,
                height,
                10.0,
                0.8,
                out.as_mut_ptr(),
                4
            ),
            0
        );
        assert_eq!(
            vt_build_wall_rects(tiles.as_ptr(), 0, height, 10.0, 0.8, out.as_mut_ptr(), 4),
            0
        );
        assert_eq!(
            vt_build_wall_rects(tiles.as_ptr(), width, 0, 10.0, 0.8, out.as_mut_ptr(), 4),
            0
        );
        assert_eq!(
            vt_build_wall_rects(
                tiles.as_ptr(),
                width,
                height,
                10.0,
                0.8,
                std::ptr::null_mut(),
                4
            ),
            0
        );
        assert_eq!(get_tile(&tiles, width, height, 1, 1, 1), 1);
    }

    #[test]
    fn test_null_pointer_protection_sweep() {
        let node_x = [0.0f32];
        let node_y = [0.0f32];
        let node_rot = [0.0f32];
        let bullet_x = [0.0f32];
        let bullet_y = [0.0f32];
        let bullet_vx = [0.0f32];
        let bullet_vy = [0.0f32];
        let bullet_alive = [1u8];
        let mut flags = [0u8; 1];

        // Null node_x.
        assert_eq!(
            vt_sweep_danger_frames(
                std::ptr::null(),
                node_y.as_ptr(),
                node_rot.as_ptr(),
                0.0,
                0.02,
                1,
                bullet_x.as_ptr(),
                bullet_y.as_ptr(),
                bullet_vx.as_ptr(),
                bullet_vy.as_ptr(),
                bullet_alive.as_ptr(),
                0.0,
                0.02,
                1,
                1.0,
                flags.as_mut_ptr()
            ),
            0
        );

        // Null bullet_alive.
        assert_eq!(
            vt_sweep_danger_frames(
                node_x.as_ptr(),
                node_y.as_ptr(),
                node_rot.as_ptr(),
                0.0,
                0.02,
                1,
                bullet_x.as_ptr(),
                bullet_y.as_ptr(),
                bullet_vx.as_ptr(),
                bullet_vy.as_ptr(),
                std::ptr::null(),
                0.0,
                0.02,
                1,
                1.0,
                flags.as_mut_ptr()
            ),
            0
        );

        // Null out_flags.
        assert_eq!(
            vt_sweep_danger_frames(
                node_x.as_ptr(),
                node_y.as_ptr(),
                node_rot.as_ptr(),
                0.0,
                0.02,
                1,
                bullet_x.as_ptr(),
                bullet_y.as_ptr(),
                bullet_vx.as_ptr(),
                bullet_vy.as_ptr(),
                bullet_alive.as_ptr(),
                0.0,
                0.02,
                1,
                1.0,
                std::ptr::null_mut()
            ),
            0
        );

        // node_frames == 0.
        assert_eq!(
            vt_sweep_danger_frames(
                node_x.as_ptr(),
                node_y.as_ptr(),
                node_rot.as_ptr(),
                0.0,
                0.02,
                0,
                bullet_x.as_ptr(),
                bullet_y.as_ptr(),
                bullet_vx.as_ptr(),
                bullet_vy.as_ptr(),
                bullet_alive.as_ptr(),
                0.0,
                0.02,
                1,
                1.0,
                flags.as_mut_ptr()
            ),
            0
        );

        // bullet_frames == 0.
        assert_eq!(
            vt_sweep_danger_frames(
                node_x.as_ptr(),
                node_y.as_ptr(),
                node_rot.as_ptr(),
                0.0,
                0.02,
                1,
                bullet_x.as_ptr(),
                bullet_y.as_ptr(),
                bullet_vx.as_ptr(),
                bullet_vy.as_ptr(),
                bullet_alive.as_ptr(),
                0.0,
                0.02,
                0,
                1.0,
                flags.as_mut_ptr()
            ),
            0
        );
        assert_eq!(flags[0], 0);
    }
}
