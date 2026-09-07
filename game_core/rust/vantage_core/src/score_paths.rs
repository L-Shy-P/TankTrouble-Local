//! Nine-operation scored rollout path (`vt_score_paths`, ABI v6).
//!
//! This module is the Rust CPU counterpart of the JS `scorePaths` hot path
//! used by `VantageTree.rolloutNine`.  It reuses the existing fused rollout
//! world (`rollout::run_rollout_batch`) for tank samples and candidate death
//! frames, and the existing pure scoring core (`rescore::score_stored_node`,
//! which itself delegates occlusion scoring to `scoring::score_frame_alive`)
//! for per-frame f64 scores.  No new death detector is introduced here.

use crate::rescore::{
    self, RescoreConfig, RescoreNodeInput, RescoreThreatInput, TankPoseLike, ThreatPathPoint,
    ThreatTrackPoint,
};
use crate::rollout::{
    run_rollout_batch, BulletInput, OpInput, RolloutCache, RolloutInput, RolloutSample,
    StartPose, WallPoly, MAX_BULLETS, MAX_FRAMES, MAX_OPS, MAX_WALLS,
};

pub const MAX_SCORE_PATHS_THREATS: usize = 64;
pub const MAX_SCORE_PATHS_TRACK_POINTS: usize = 4096;
pub const MAX_SCORE_PATHS_PATH_POINTS: usize = 4096;

#[derive(Clone, Debug)]
pub struct ScorePathsThreat {
    pub track: Option<Vec<ThreatTrackPoint>>,
    pub path: Option<Vec<ThreatPathPoint>>,
    pub speed: f64,
    pub anchor_offset: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct ScorePathsConfig {
    pub death_penalty: f64,
    pub stuck_penalty: f64,
    pub stuck_dist_eps: f64,
    pub stuck_rot_eps: f64,
    pub lane_penalty_ratio: f64,
    pub spring_rope_enabled: bool,
}

impl Default for ScorePathsConfig {
    fn default() -> Self {
        Self {
            death_penalty: 0.0,
            stuck_penalty: 4.0,
            stuck_dist_eps: 0.05,
            stuck_rot_eps: 0.05,
            lane_penalty_ratio: 0.0,
            spring_rope_enabled: false,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ScorePathsInput {
    pub cache_id: u64,
    pub start_pose: StartPose,
    pub start_t: f64,
    pub ops: Vec<OpInput>,
    pub op_moving: Vec<bool>,
    pub duration_frames: usize,
    pub walls: Vec<WallPoly>,
    pub bullets: Vec<BulletInput>,
    pub threats: Vec<ScorePathsThreat>,
    pub cfg: ScorePathsConfig,
}

#[derive(Clone, Debug)]
pub struct ScorePathsOutput {
    pub samples: Vec<RolloutSample>,
    pub per_frame_scores: Vec<f64>,
    pub total_score: f64,
    pub death_frame: i32,
}

/// Run one scored nine-operation rollout through the persistent fused world.
///
/// The tank trajectories and death frames come from `run_rollout_batch`
/// (fused sensor + CCD, the same Rust death candidate the JS bridge already
/// exposes as `rolloutBatch`).  Per-frame alive scores are computed with the
/// f64 exact occlusion scorer via `rescore::score_stored_node`.
pub fn run_score_paths(
    cache: &mut RolloutCache,
    input: &ScorePathsInput,
) -> Result<Vec<ScorePathsOutput>, String> {
    // Keep the Rust path strictly conservative: only the configurations the
    // JS fallback contract allows.  lane > 0 and spring rope are handled by
    // JS `scorePaths`; the JS adapter also pre-checks these and returns null.
    if input.cfg.spring_rope_enabled {
        return Err("spring rope scoring is not supported by vt_score_paths".to_string());
    }
    if input.cfg.lane_penalty_ratio > 0.0 {
        return Err("lane penalty > 0 is not supported by vt_score_paths".to_string());
    }
    if input.ops.is_empty() || input.ops.len() > MAX_OPS {
        return Err("op count out of range".to_string());
    }
    if input.op_moving.len() != input.ops.len() {
        return Err("op_moving length mismatch".to_string());
    }
    if input.duration_frames > MAX_FRAMES {
        return Err("duration frames out of range".to_string());
    }

    let rollout_input = RolloutInput {
        start_pose: input.start_pose,
        ops: input.ops.clone(),
        duration_frames: input.duration_frames as u32,
        walls: input.walls.clone(),
        bullets: input.bullets.clone(),
        cache_id: input.cache_id,
    };
    let rollout = run_rollout_batch(cache, &rollout_input)?;

    let rescore_threats: Vec<RescoreThreatInput> = input
        .threats
        .iter()
        .enumerate()
        .map(|(i, th)| RescoreThreatInput {
            id: i as i64,
            track: th.track.clone(),
            path: th.path.clone(),
            speed: th.speed,
            anchor_offset: th.anchor_offset,
            bullet_radius: crate::scoring::BULLET_RADIUS_M,
            life_left_seconds: 10.0,
            is_new: false,
        })
        .collect();

    let rescore_cfg = RescoreConfig {
        death_penalty: input.cfg.death_penalty,
        stuck_penalty: input.cfg.stuck_penalty,
        stuck_dist_eps: input.cfg.stuck_dist_eps,
        stuck_rot_eps: input.cfg.stuck_rot_eps,
        lane_penalty_ratio: input.cfg.lane_penalty_ratio,
        spring_rope_enabled: input.cfg.spring_rope_enabled,
    };

    let mut outputs = Vec::with_capacity(input.ops.len());
    for (op, samples) in rollout.samples.iter().enumerate() {
        let pose_samples: Vec<TankPoseLike> = samples
            .iter()
            .map(|s| TankPoseLike::new(s.x, s.y, s.rot))
            .collect();
        let node = RescoreNodeInput::new(
            pose_samples,
            input.op_moving[op],
            input.start_t,
            input.duration_frames,
        );
        let scored = rescore::score_stored_node(
            &node,
            &rescore_threats,
            &rescore_cfg,
            rescore::threat_bullet_pos,
        )
        .map_err(|e| e.to_string())?;

        let death_frame = rollout.death_frame[op];
        let (per_frame_scores, total_score) = if death_frame > 0 {
            let d = death_frame as usize;
            if d > scored.per_frame_scores.len() {
                return Err("death frame exceeds scored frames".to_string());
            }
            let mut alive: Vec<f64> = scored.per_frame_scores[..d - 1].to_vec();
            let total = alive.iter().sum::<f64>() - input.cfg.death_penalty;
            alive.push(-input.cfg.death_penalty);
            (alive, total)
        } else {
            (scored.per_frame_scores.clone(), scored.total_score)
        };

        outputs.push(ScorePathsOutput {
            samples: samples.clone(),
            per_frame_scores,
            total_score,
            death_frame,
        });
    }

    Ok(outputs)
}

/// Flat-buffer scored rollout ABI (v6): `vt_score_paths`.
///
/// Inputs mirror `VantageRustBridge.scorePaths`:
/// - parent pose `(start_x, start_y, start_rot)` and `start_t` (seconds)
/// - `op_count` operations, each with precomputed `speed` / `rotation_speed`
///   (JS already applied Tank methods/modifiers) and a `moving` flag
/// - persistent fused-world walls and real bullet inputs (the same values
///   accepted by `vt_rollout_batch`)
/// - `threat_count` scoring threats with either `track` or `path`
/// - scoring config (death/stuck/lane/spring)
///
/// Outputs (caller-owned):
/// - `out_x/y/rot`: candidate-major samples, `op_count * (frames + 1)` each
/// - `out_per_frame_scores`: candidate-major, `op_count * 75` f64 values,
///   zero-padded beyond the actual scored length
/// - `out_total_score`, `out_death_frame`, `out_ok`: one per op
///
/// Returns 1 on success, 0 on bad input or an unsupported configuration
/// (lane > 0 / spring rope), in which case JS must fall back to the real
/// `VantageScoring.scorePaths` path.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn vt_score_paths(
    cache_id: u64,
    start_x: f64,
    start_y: f64,
    start_rot: f64,
    start_t: f64,
    op_speed: *const f64,
    op_rot_speed: *const f64,
    op_moving: *const u8,
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
    threat_count: u32,
    threat_track_counts: *const u32,
    track_x: *const f64,
    track_y: *const f64,
    track_alive: *const u8,
    threat_path_counts: *const u32,
    path_x: *const f64,
    path_y: *const f64,
    threat_anchor_offset: *const f64,
    threat_speed: *const f64,
    death_penalty: f64,
    stuck_penalty: f64,
    stuck_dist_eps: f64,
    stuck_rot_eps: f64,
    lane_penalty_ratio: f64,
    spring_rope_enabled: u8,
    out_x: *mut f64,
    out_y: *mut f64,
    out_rot: *mut f64,
    out_per_frame_scores: *mut f64,
    out_total_score: *mut f64,
    out_death_frame: *mut i32,
    out_ok: *mut u8,
) -> i32 {
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
        if threat_count > MAX_SCORE_PATHS_THREATS as u32 {
            return 0;
        }
        if op_speed.is_null()
            || op_rot_speed.is_null()
            || op_moving.is_null()
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
            || out_per_frame_scores.is_null()
            || out_total_score.is_null()
            || out_death_frame.is_null()
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
                || threat_anchor_offset.is_null()
                || threat_speed.is_null())
        {
            return 0;
        }
        if !start_x.is_finite()
            || !start_y.is_finite()
            || !start_rot.is_finite()
            || !start_t.is_finite()
            || !death_penalty.is_finite()
            || !stuck_penalty.is_finite()
            || !stuck_dist_eps.is_finite()
            || !stuck_rot_eps.is_finite()
            || !lane_penalty_ratio.is_finite()
        {
            return 0;
        }
        if lane_penalty_ratio > 0.0 || spring_rope_enabled != 0 {
            return 0;
        }

        let op_count_u = op_count as usize;
        let wall_count_u = wall_count as usize;
        let bullet_count_u = bullet_count as usize;
        let threat_count_u = threat_count as usize;
        let duration_u = duration_frames as usize;
        let sample_stride = duration_u + 1;

        let op_speed_slice = unsafe { std::slice::from_raw_parts(op_speed, op_count_u) };
        let op_rot_speed_slice = unsafe { std::slice::from_raw_parts(op_rot_speed, op_count_u) };
        let op_moving_slice = unsafe { std::slice::from_raw_parts(op_moving, op_count_u) };
        for &v in op_speed_slice {
            if !v.is_finite() {
                return 0;
            }
        }
        for &v in op_rot_speed_slice {
            if !v.is_finite() {
                return 0;
            }
        }

        // Walls (same validation as vt_rollout_batch).
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
        for i in 0..bullet_count_u {
            if !bullet_x_slice[i].is_finite()
                || !bullet_y_slice[i].is_finite()
                || !bullet_vx_slice[i].is_finite()
                || !bullet_vy_slice[i].is_finite()
                || !bullet_radius_slice[i].is_finite()
                || !bullet_life_left_slice[i].is_finite()
                || bullet_radius_slice[i] < 0.0
            {
                return 0;
            }
        }

        // Threats (scoring only; death verification uses the real bullet
        // inputs above through the existing fused rollout world).
        let mut total_track = 0usize;
        let mut total_path = 0usize;
        let mut track_counts = Vec::with_capacity(threat_count_u);
        let mut path_counts = Vec::with_capacity(threat_count_u);
        if threat_count_u > 0 {
            let track_counts_slice =
                unsafe { std::slice::from_raw_parts(threat_track_counts, threat_count_u) };
            let path_counts_slice =
                unsafe { std::slice::from_raw_parts(threat_path_counts, threat_count_u) };
            for ti in 0..threat_count_u {
                let tc = track_counts_slice[ti] as usize;
                let pc = path_counts_slice[ti] as usize;
                if tc > MAX_SCORE_PATHS_TRACK_POINTS || pc > MAX_SCORE_PATHS_PATH_POINTS {
                    return 0;
                }
                total_track += tc;
                total_path += pc;
                if total_track > MAX_SCORE_PATHS_THREATS * MAX_SCORE_PATHS_TRACK_POINTS
                    || total_path > MAX_SCORE_PATHS_THREATS * MAX_SCORE_PATHS_PATH_POINTS
                {
                    return 0;
                }
                track_counts.push(tc);
                path_counts.push(pc);
            }
        }

        let track_x_slice = if total_track > 0 {
            Some(unsafe { std::slice::from_raw_parts(track_x, total_track) })
        } else {
            None
        };
        let track_y_slice = if total_track > 0 {
            Some(unsafe { std::slice::from_raw_parts(track_y, total_track) })
        } else {
            None
        };
        let track_alive_slice = if total_track > 0 {
            Some(unsafe { std::slice::from_raw_parts(track_alive, total_track) })
        } else {
            None
        };
        let path_x_slice = if total_path > 0 {
            Some(unsafe { std::slice::from_raw_parts(path_x, total_path) })
        } else {
            None
        };
        let path_y_slice = if total_path > 0 {
            Some(unsafe { std::slice::from_raw_parts(path_y, total_path) })
        } else {
            None
        };
        let threat_anchor_slice = if threat_count_u > 0 {
            Some(unsafe { std::slice::from_raw_parts(threat_anchor_offset, threat_count_u) })
        } else {
            None
        };
        let threat_speed_slice = if threat_count_u > 0 {
            Some(unsafe { std::slice::from_raw_parts(threat_speed, threat_count_u) })
        } else {
            None
        };
        if let (Some(anchor), Some(speed)) = (threat_anchor_slice, threat_speed_slice) {
            for ti in 0..threat_count_u {
                if !anchor[ti].is_finite() || !speed[ti].is_finite() {
                    return 0;
                }
            }
        }

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
        let op_moving: Vec<bool> = op_moving_slice.iter().map(|v| *v != 0).collect();
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

        let mut threats = Vec::with_capacity(threat_count_u);
        let mut track_offset = 0usize;
        let mut path_offset = 0usize;
        for ti in 0..threat_count_u {
            let tc = track_counts[ti];
            let pc = path_counts[ti];
            let track = if tc > 0 {
                let mut v = Vec::with_capacity(tc);
                for j in 0..tc {
                    let idx = track_offset + j;
                    v.push(ThreatTrackPoint::new(
                        track_x_slice.as_ref().unwrap()[idx],
                        track_y_slice.as_ref().unwrap()[idx],
                        track_alive_slice.as_ref().unwrap()[idx] != 0,
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
                    let idx = path_offset + j;
                    v.push(ThreatPathPoint::new(
                        path_x_slice.as_ref().unwrap()[idx],
                        path_y_slice.as_ref().unwrap()[idx],
                    ));
                }
                path_offset += pc;
                Some(v)
            } else {
                None
            };
            threats.push(ScorePathsThreat {
                track,
                path,
                speed: threat_speed_slice.unwrap()[ti],
                anchor_offset: threat_anchor_slice.unwrap()[ti],
            });
        }

        let input = ScorePathsInput {
            cache_id,
            start_pose: StartPose {
                x: start_x,
                y: start_y,
                rot: start_rot,
            },
            start_t,
            ops,
            op_moving,
            duration_frames: duration_u,
            walls,
            bullets,
            threats,
            cfg: ScorePathsConfig {
                death_penalty,
                stuck_penalty,
                stuck_dist_eps,
                stuck_rot_eps,
                lane_penalty_ratio,
                spring_rope_enabled: spring_rope_enabled != 0,
            },
        };


        static CACHES: std::sync::OnceLock<
            std::sync::Mutex<std::collections::HashMap<u64, RolloutCache>>,
        > = std::sync::OnceLock::new();
        let mut caches_guard = CACHES
            .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let cache = caches_guard.entry(cache_id).or_default();
        let outputs = match run_score_paths(cache, &input) {
            Ok(o) => o,
            Err(_) => return 0,
        };

        let out_x_slice =
            unsafe { std::slice::from_raw_parts_mut(out_x, op_count_u * sample_stride) };
        let out_y_slice =
            unsafe { std::slice::from_raw_parts_mut(out_y, op_count_u * sample_stride) };
        let out_rot_slice =
            unsafe { std::slice::from_raw_parts_mut(out_rot, op_count_u * sample_stride) };
        let out_pfs_slice = unsafe {
            std::slice::from_raw_parts_mut(out_per_frame_scores, op_count_u * MAX_FRAMES)
        };
        let out_total_slice =
            unsafe { std::slice::from_raw_parts_mut(out_total_score, op_count_u) };
        let out_death_slice =
            unsafe { std::slice::from_raw_parts_mut(out_death_frame, op_count_u) };
        let out_ok_slice = unsafe { std::slice::from_raw_parts_mut(out_ok, op_count_u) };

        out_pfs_slice.fill(0.0);
        out_total_slice.fill(0.0);
        out_death_slice.fill(-1);
        out_ok_slice.fill(0);

        for (op, out) in outputs.iter().enumerate() {
            for (frame, sample) in out.samples.iter().enumerate() {
                let idx = op * sample_stride + frame;
                out_x_slice[idx] = sample.x;
                out_y_slice[idx] = sample.y;
                out_rot_slice[idx] = sample.rot;
            }
            let pfs_base = op * MAX_FRAMES;
            for (fi, v) in out.per_frame_scores.iter().enumerate() {
                if fi >= MAX_FRAMES {
                    break;
                }
                out_pfs_slice[pfs_base + fi] = *v;
            }
            out_total_slice[op] = out.total_score;
            out_death_slice[op] = out.death_frame;
            out_ok_slice[op] = 1;
        }

        1
    }));

    match result {
        Ok(v) => v,
        Err(_) => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arena_walls() -> Vec<WallPoly> {
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

    fn path_threat(path: &[(f64, f64)], speed: f64) -> ScorePathsThreat {
        ScorePathsThreat {
            track: None,
            path: Some(
                path.iter()
                    .map(|(x, y)| ThreatPathPoint::new(*x, *y))
                    .collect(),
            ),
            speed,
            anchor_offset: 0.0,
        }
    }

    #[test]
    fn score_paths_alive_far_bullet_matches_full_circle() {
        let input = ScorePathsInput {
            cache_id: 991,
            start_pose: StartPose {
                x: 5.0,
                y: 8.0,
                rot: 0.0,
            },
            start_t: 0.0,
            ops: vec![OpInput {
                speed: 0.0,
                rotation_speed: 0.0,
            }],
            op_moving: vec![false],
            duration_frames: 3,
            walls: arena_walls(),
            bullets: Vec::new(),
            threats: vec![path_threat(&[(50.0, 50.0), (51.0, 50.0)], 20.0)],
            cfg: ScorePathsConfig::default(),
        };
        let mut cache = RolloutCache::new();
        let outs = run_score_paths(&mut cache, &input).unwrap();
        assert_eq!(outs.len(), 1);
        assert_eq!(outs[0].death_frame, -1);
        assert_eq!(outs[0].per_frame_scores.len(), 3);
        let full = std::f64::consts::PI * 2.0;
        for v in &outs[0].per_frame_scores {
            assert!((v - full * full).abs() < 1e-12);
        }
        assert!((outs[0].total_score - 3.0 * full * full).abs() < 1e-12);
    }

    #[test]
    fn score_paths_rejects_lane_and_spring_config() {
        let mut input = ScorePathsInput {
            cache_id: 992,
            start_pose: StartPose {
                x: 5.0,
                y: 8.0,
                rot: 0.0,
            },
            start_t: 0.0,
            ops: vec![OpInput {
                speed: 0.0,
                rotation_speed: 0.0,
            }],
            op_moving: vec![false],
            duration_frames: 1,
            walls: Vec::new(),
            bullets: Vec::new(),
            threats: Vec::new(),
            cfg: ScorePathsConfig::default(),
        };
        let mut cache = RolloutCache::new();

        input.cfg.lane_penalty_ratio = 0.5;
        assert!(run_score_paths(&mut cache, &input).is_err());
        input.cfg.lane_penalty_ratio = 0.0;
        input.cfg.spring_rope_enabled = true;
        assert!(run_score_paths(&mut cache, &input).is_err());
    }
}
