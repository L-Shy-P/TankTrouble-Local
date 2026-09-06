//! Incremental rescoring + death-verification core for Vantage tree nodes
//! that already have stored `rolloutSamples`.
//!
//! The critical architectural guarantee is that tank trajectories are never
//! re-simulated here.  Scoring is a pure function over the stored samples;
//! the danger coarse filter only reads threat tracks/paths; and only frames
//! that the coarse filter marks as dangerous are verified against a
//! game-identical fused sensor/CCD world.

use crate::box2d::FixtureKind;
use crate::rollout::{VerificationCache, WallPoly, CATEGORY_PROJECTILE};
use crate::scoring::{self, Point, TankPose, Threat, TrackFrame};

/// Frame duration used by both the stored samples and the verification world.
pub const RESCORE_DT: f64 = 0.02;

/// Small safety margin for the danger coarse filter.  False positives are
/// allowed; false negatives are not.
pub const DANGER_MARGIN: f64 = 0.15;

/// Maximum number of nodes accepted by the C ABI.
pub const MAX_RESCORE_NODES: usize = 512;
/// Maximum number of stored samples per node (75 frames + 1).
pub const MAX_RESCORE_SAMPLES: usize = 76;
/// Maximum number of scored frames per node.
pub const MAX_RESCORE_FRAMES: usize = 75;
/// Maximum number of threats accepted by the C ABI.
pub const MAX_RESCORE_THREATS: usize = 64;
/// Upper bound for flat threat track / path buffers.
pub const MAX_RESCORE_TRACK_POINTS: usize = 4096;
pub const MAX_RESCORE_PATH_POINTS: usize = 4096;

/// Frames per coarse skip block for the danger pre-filter and the
/// incremental affected-frame mask.  Blocks are conservative: tank boxes
/// cover the actual stored sample positions (including rotation), and threat
/// boxes cover the actual track points inside the same time interval.
pub const COARSE_BLOCK_FRAMES: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TankPoseLike {
    pub x: f64,
    pub y: f64,
    pub rot: f64,
}

impl TankPoseLike {
    pub fn new(x: f64, y: f64, rot: f64) -> Self {
        Self { x, y, rot }
    }

    fn to_scoring(self) -> TankPose {
        TankPose::new(self.x, self.y, self.rot)
    }

    fn point(self) -> Point {
        Point::new(self.x, self.y)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ThreatTrackPoint {
    pub x: f64,
    pub y: f64,
    pub alive: bool,
}

impl ThreatTrackPoint {
    pub fn new(x: f64, y: f64, alive: bool) -> Self {
        Self { x, y, alive }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ThreatPathPoint {
    pub x: f64,
    pub y: f64,
}

impl ThreatPathPoint {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RescoreNodeInput {
    pub samples: Vec<TankPoseLike>,
    pub moving: bool,
    pub start_t: f64,
    pub frames: usize,
    /// Previous per-frame net scores for this node.  When `Some` and its
    /// length equals `scored_frames()`, only frames affected by newly-added
    /// threats are recomputed; unaffected frames are copied verbatim.
    pub previous_scores: Option<Vec<f64>>,
}

impl RescoreNodeInput {
    pub fn new(samples: Vec<TankPoseLike>, moving: bool, start_t: f64, frames: usize) -> Self {
        Self {
            samples,
            moving,
            start_t,
            frames,
            previous_scores: None,
        }
    }

    pub fn with_previous_scores(mut self, previous_scores: Vec<f64>) -> Self {
        self.previous_scores = Some(previous_scores);
        self
    }

    pub fn scored_frames(&self) -> usize {
        self.frames.min(self.samples.len().saturating_sub(1))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RescoreThreatInput {
    pub id: i64,
    pub track: Option<Vec<ThreatTrackPoint>>,
    pub path: Option<Vec<ThreatPathPoint>>,
    pub speed: f64,
    pub anchor_offset: f64,
    pub bullet_radius: f64,
    pub life_left_seconds: f64,
    /// True when this threat is newly added since the node's previous
    /// per-frame scores were computed.  Only `is_new` threats contribute to
    /// the incremental affected-frame mask.
    pub is_new: bool,
}

impl RescoreThreatInput {
    pub fn new(id: i64) -> Self {
        Self {
            id,
            track: None,
            path: None,
            speed: 0.0,
            anchor_offset: 0.0,
            bullet_radius: scoring::BULLET_RADIUS_M,
            life_left_seconds: 10.0,
            is_new: false,
        }
    }

    pub fn with_track(mut self, track: Vec<ThreatTrackPoint>) -> Self {
        self.track = Some(track);
        self
    }

    pub fn with_path(mut self, path: Vec<ThreatPathPoint>, speed: f64) -> Self {
        self.path = Some(path);
        self.speed = speed;
        self
    }

    pub fn with_anchor_offset(mut self, anchor_offset: f64) -> Self {
        self.anchor_offset = anchor_offset;
        self
    }

    pub fn with_bullet_radius(mut self, radius: f64) -> Self {
        self.bullet_radius = radius;
        self
    }

    pub fn with_life_left_seconds(mut self, life_left_seconds: f64) -> Self {
        self.life_left_seconds = life_left_seconds;
        self
    }

    pub fn with_is_new(mut self, is_new: bool) -> Self {
        self.is_new = is_new;
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RescoreConfig {
    pub death_penalty: f64,
    pub stuck_penalty: f64,
    pub stuck_dist_eps: f64,
    pub stuck_rot_eps: f64,
    pub lane_penalty_ratio: f64,
    pub spring_rope_enabled: bool,
}

impl Default for RescoreConfig {
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeathSource {
    None,
    FusedSensorContact,
}

impl DeathSource {
    pub fn as_i32(self) -> i32 {
        match self {
            DeathSource::None => 0,
            DeathSource::FusedSensorContact => 1,
        }
    }

    pub fn from_i32(v: i32) -> Self {
        match v {
            1 => DeathSource::FusedSensorContact,
            _ => DeathSource::None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RescoreNodeOutput {
    pub per_frame_scores: Vec<f64>,
    pub total_score: f64,
    pub death_frame: i32,
    pub verified_frames: u32,
    pub death_frame_source: DeathSource,
}

impl RescoreNodeOutput {
    pub fn empty() -> Self {
        Self {
            per_frame_scores: Vec::new(),
            total_score: 0.0,
            death_frame: -1,
            verified_frames: 0,
            death_frame_source: DeathSource::None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum RescoreError {
    SpringRopeUnsupported,
    InvalidNode(String),
    InvalidThreat(String),
    Verification(String),
}

impl std::fmt::Display for RescoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RescoreError::SpringRopeUnsupported => {
                write!(f, "spring rope scoring is not supported by the Rust core")
            }
            RescoreError::InvalidNode(m) => write!(f, "invalid rescore node: {}", m),
            RescoreError::InvalidThreat(m) => write!(f, "invalid rescore threat: {}", m),
            RescoreError::Verification(m) => write!(f, "verification failed: {}", m),
        }
    }
}

impl std::error::Error for RescoreError {}

// ---------------------------------------------------------------------------
// Threat bullet position (exact JS `threatBulletPos` semantics)
// ---------------------------------------------------------------------------

pub fn threat_bullet_pos(th: &RescoreThreatInput, t_sec: f64) -> Option<Point> {
    let q = t_sec - th.anchor_offset;
    if q < 0.0 {
        return None;
    }

    if let Some(track) = &th.track {
        if !track.is_empty() {
            let idx = (q / RESCORE_DT).round();
            if idx < 0.0 {
                return None;
            }
            let idx = idx as usize;
            if idx >= track.len() {
                return None;
            }
            let s = &track[idx];
            if !s.alive {
                return None;
            }
            return Some(Point::new(s.x, s.y));
        }
    }

    let path = th.path.as_ref()?;
    if path.len() < 2 || th.speed <= 0.0 {
        return None;
    }

    let mut total_len = 0.0;
    for i in 0..path.len() - 1 {
        total_len += dist_pt(path[i], path[i + 1]);
    }
    if q * th.speed > total_len + 0.05 {
        return None;
    }

    let mut elapsed = 0.0;
    for i in 0..path.len() - 1 {
        let a = path[i];
        let b = path[i + 1];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let seg_len = (dx * dx + dy * dy).sqrt();
        let seg_time = seg_len / th.speed;
        if elapsed + seg_time >= q {
            let u = if seg_time > 0.0 {
                (q - elapsed) / seg_time
            } else {
                0.0
            };
            return Some(Point::new(a.x + dx * u, a.y + dy * u));
        }
        elapsed += seg_time;
    }

    Some(Point::new(path[path.len() - 1].x, path[path.len() - 1].y))
}

fn dist_pt(a: ThreatPathPoint, b: ThreatPathPoint) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    (dx * dx + dy * dy).sqrt()
}

// ---------------------------------------------------------------------------
// Scoring path (pure, no death decision)
// ---------------------------------------------------------------------------

fn to_scoring_threats(threats: &[RescoreThreatInput]) -> Vec<Threat> {
    threats
        .iter()
        .map(|th| {
            let mut s = Threat::new(th.id);
            s.speed = th.speed;
            s.anchor_offset = th.anchor_offset;
            if let Some(track) = &th.track {
                s.track = Some(
                    track
                        .iter()
                        .map(|p| TrackFrame::new(p.x, p.y, p.alive))
                        .collect(),
                );
            }
            if let Some(path) = &th.path {
                s.path = Some(path.iter().map(|p| Point::new(p.x, p.y)).collect());
            }
            s
        })
        .collect()
}

fn norm_angle_delta(delta: f64) -> f64 {
    delta.sin().atan2(delta.cos())
}

fn is_stuck_pose(prev: TankPoseLike, cur: TankPoseLike, cfg: &RescoreConfig) -> bool {
    let dx = cur.x - prev.x;
    let dy = cur.y - prev.y;
    let dist2 = dx * dx + dy * dy;
    if dist2 > cfg.stuck_dist_eps * cfg.stuck_dist_eps {
        return false;
    }
    let dr = norm_angle_delta(cur.rot - prev.rot);
    dr.abs() < cfg.stuck_rot_eps
}

// ---------------------------------------------------------------------------
// Incremental affected-frame mask (conservative for default cfg)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
struct TailBox {
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
}

impl TailBox {
    fn new_inf() -> Self {
        Self {
            min_x: f64::INFINITY,
            max_x: f64::NEG_INFINITY,
            min_y: f64::INFINITY,
            max_y: f64::NEG_INFINITY,
        }
    }

    fn add(&mut self, x: f64, y: f64) {
        self.min_x = self.min_x.min(x);
        self.max_x = self.max_x.max(x);
        self.min_y = self.min_y.min(y);
        self.max_y = self.max_y.max(y);
    }

    fn is_empty(&self) -> bool {
        self.min_x > self.max_x || self.min_y > self.max_y
    }

    fn distance_to_point(&self, x: f64, y: f64) -> f64 {
        let dx = if self.min_x > x {
            self.min_x - x
        } else if self.max_x < x {
            self.max_x - x
        } else {
            0.0
        };
        let dy = if self.min_y > y {
            self.min_y - y
        } else if self.max_y < y {
            self.max_y - y
        } else {
            0.0
        };
        (dx * dx + dy * dy).sqrt()
    }

    fn distance_to_box(&self, other: &TailBox) -> f64 {
        if self.is_empty() || other.is_empty() {
            return f64::INFINITY;
        }
        let dx = if self.min_x > other.max_x {
            self.min_x - other.max_x
        } else if other.min_x > self.max_x {
            other.min_x - self.max_x
        } else {
            0.0
        };
        let dy = if self.min_y > other.max_y {
            self.min_y - other.max_y
        } else if other.min_y > self.max_y {
            other.min_y - self.max_y
        } else {
            0.0
        };
        (dx * dx + dy * dy).sqrt()
    }
}

/// A conservative chunk of one threat's track, expressed in threat-local
/// `q` time (`q = t_sec - anchor_offset`).  Only frames whose `q` falls inside
/// `[q0, q1]` may be skipped with this chunk.
#[derive(Clone, Copy, Debug)]
struct ThreatCoarseChunk {
    q0: f64,
    q1: f64,
    bbox: TailBox,
}

impl ThreatCoarseChunk {
    fn overlaps(&self, q0: f64, q1: f64) -> bool {
        self.q0 <= q1 && q0 <= self.q1
    }
}

/// Build conservative `[q, bbox]` chunks from a threat's Box2D track.
///
/// The chunk time range is widened by half a frame on each side because
/// `threat_bullet_pos` rounds `q / RESCORE_DT` to the nearest track index.
/// Dead track points are excluded from the bbox (they have no bullet
/// position, so they can never create danger).  If a chunk has no alive
/// points it is dropped; frames in that chunk fall back to exact checking.
fn threat_track_coarse_chunks(
    th: &RescoreThreatInput,
    block_frames: usize,
) -> Vec<ThreatCoarseChunk> {
    let track = match &th.track {
        Some(t) if !t.is_empty() => t,
        _ => return Vec::new(),
    };
    let dt = RESCORE_DT;
    let half = dt * 0.5;
    let mut chunks = Vec::new();
    let mut s = 0usize;
    while s < track.len() {
        let e = (s + block_frames).min(track.len() - 1);
        // Cover the half-frame rounding window: `threat_bullet_pos` uses
        // `round(q / dt)`, so q at e+0.5 may already map to e+1.  Including
        // the next alive track point makes the bbox conservative for that
        // boundary case.
        let e_cover = (e + 1).min(track.len() - 1);
        let mut bbox = TailBox::new_inf();
        for p in &track[s..=e_cover] {
            if p.alive {
                bbox.add(p.x, p.y);
            }
        }
        if !bbox.is_empty() {
            chunks.push(ThreatCoarseChunk {
                q0: (s as f64 * dt - half).max(0.0),
                q1: e_cover as f64 * dt + half,
                bbox,
            });
        }
        if e == track.len() - 1 {
            break;
        }
        s = e + 1;
    }
    chunks
}

/// Conservative bounding box of a threat's remaining track/path points from
/// `t_sec` onward.  Used only for incremental-mask lane/tail reach checks; it
/// deliberately mirrors the lane-penalty sampling windows from `scoring.rs`
/// without calling the JS lane logic itself.
fn threat_tail_box_from(th: &RescoreThreatInput, t_sec: f64) -> Option<TailBox> {
    let q = t_sec - th.anchor_offset;

    if let Some(track) = &th.track {
        if !track.is_empty() {
            let idx = if q < 0.0 {
                0usize
            } else {
                (q / RESCORE_DT).round().max(0.0) as usize
            };
            let mut box_ = TailBox::new_inf();
            for s in track.iter().skip(idx) {
                if !s.alive {
                    break;
                }
                box_.add(s.x, s.y);
            }
            return if box_.is_empty() { None } else { Some(box_) };
        }
    }

    let path = th.path.as_ref()?;
    if path.len() < 2 || th.speed <= 0.0 {
        return None;
    }

    if q < 0.0 {
        // Before anchor: the whole path is still "remaining".  This is a
        // deliberate false-positive region (lane scoring skips q < 0).
        let mut box_ = TailBox::new_inf();
        for p in path {
            box_.add(p.x, p.y);
        }
        return Some(box_);
    }

    let s0 = q * th.speed;
    let mut cum = 0.0;
    let mut box_ = TailBox::new_inf();
    for i in 0..path.len() - 1 {
        let a = &path[i];
        let b = &path[i + 1];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let seg_len = (dx * dx + dy * dy).sqrt();
        if seg_len <= 0.0 {
            continue;
        }
        if cum + seg_len <= s0 {
            cum += seg_len;
            continue;
        }
        let f0 = if cum >= s0 { 0.0 } else { (s0 - cum) / seg_len };
        box_.add(a.x + (b.x - a.x) * f0, a.y + (b.y - a.y) * f0);
        box_.add(b.x, b.y);
        cum += seg_len;
    }
    if box_.is_empty() {
        None
    } else {
        Some(box_)
    }
}

/// Frame mask (`mask[i]` for frame `i`, `1..=scored_frames`) of frames that
/// may be affected by newly-added threats.  The mask is conservative for the
/// default config (`lane_penalty_ratio == 0`, spring disabled): it may contain
/// false positives but no false negatives.
pub fn new_threat_affected_frames(
    node: &RescoreNodeInput,
    threats: &[RescoreThreatInput],
    cfg: &RescoreConfig,
) -> Vec<bool> {
    let max_i = node.scored_frames();
    let mut mask = vec![false; max_i + 1];
    if max_i == 0 {
        return mask;
    }

    let geo = scoring::exact_geom();
    let occ_radius = geo.r_semi + 0.25;
    let lane_radius = 3.5 + geo.geo_offset + 0.25;

    // Lane pressure uses the threat's whole future tail from every frame, so
    // a per-chunk bbox can never be conservative enough.  Keep the exact
    // per-frame path whenever lane scoring is enabled.
    if cfg.lane_penalty_ratio > 0.0 {
        for i in 1..=max_i {
            let s = node.samples[i];
            let t_sec = node.start_t + i as f64 * RESCORE_DT;
            let gx = s.x + s.rot.sin() * geo.geo_offset;
            let gy = s.y - s.rot.cos() * geo.geo_offset;

            for th in threats.iter().filter(|th| th.is_new) {
                match threat_bullet_pos(th, t_sec) {
                    Some(p) => {
                        let dx = p.x - gx;
                        let dy = p.y - gy;
                        if dx * dx + dy * dy <= occ_radius * occ_radius {
                            mask[i] = true;
                            break;
                        }
                    }
                    None => {
                        if let Some(tb) = threat_tail_box_from(th, t_sec) {
                            if tb.distance_to_point(gx, gy) <= occ_radius {
                                mask[i] = true;
                                break;
                            }
                        }
                    }
                }

                if let Some(tb) = threat_tail_box_from(th, t_sec) {
                    if tb.distance_to_point(gx, gy) <= lane_radius {
                        mask[i] = true;
                        break;
                    }
                }
            }
        }
        return mask;
    }

    // Lane is disabled: occlusion impact is instantaneous.  Coarse-skip
    // whole 16-frame blocks whose actual geometric-center box is farther than
    // occ_radius from the new threat's track chunk.  The tank center box is
    // built from the stored samples, so forward + rotation motion is included
    // exactly.  Path-only threats fall back to the exact per-frame path.
    for th in threats.iter().filter(|th| th.is_new) {
        let chunks = threat_track_coarse_chunks(th, COARSE_BLOCK_FRAMES);
        if chunks.is_empty() {
            for i in 1..=max_i {
                if mask[i] {
                    continue;
                }
                let s = node.samples[i];
                let t_sec = node.start_t + i as f64 * RESCORE_DT;
                let gx = s.x + s.rot.sin() * geo.geo_offset;
                let gy = s.y - s.rot.cos() * geo.geo_offset;
                match threat_bullet_pos(th, t_sec) {
                    Some(p) => {
                        let dx = p.x - gx;
                        let dy = p.y - gy;
                        if dx * dx + dy * dy <= occ_radius * occ_radius {
                            mask[i] = true;
                        }
                    }
                    None => {
                        if let Some(tb) = threat_tail_box_from(th, t_sec) {
                            if tb.distance_to_point(gx, gy) <= occ_radius {
                                mask[i] = true;
                            }
                        }
                    }
                }
            }
            continue;
        }

        let mut block_start = 1usize;
        while block_start <= max_i {
            let block_end = (block_start + COARSE_BLOCK_FRAMES - 1).min(max_i);
            let mut center_box = TailBox::new_inf();
            for k in block_start..=block_end {
                let sk = node.samples[k];
                center_box.add(
                    sk.x + sk.rot.sin() * geo.geo_offset,
                    sk.y - sk.rot.cos() * geo.geo_offset,
                );
            }

            let q0 = node.start_t + block_start as f64 * RESCORE_DT - th.anchor_offset;
            let q1 = node.start_t + block_end as f64 * RESCORE_DT - th.anchor_offset;

            let mut any_overlap = false;
            let mut all_overlap_far = true;
            for ch in &chunks {
                if !ch.overlaps(q0, q1) {
                    continue;
                }
                any_overlap = true;
                if ch.bbox.distance_to_box(&center_box) <= occ_radius {
                    all_overlap_far = false;
                    break;
                }
            }

            if any_overlap && all_overlap_far {
                block_start = block_end + 1;
                continue;
            }

            for i in block_start..=block_end {
                if mask[i] {
                    continue;
                }
                let s = node.samples[i];
                let t_sec = node.start_t + i as f64 * RESCORE_DT;
                let gx = s.x + s.rot.sin() * geo.geo_offset;
                let gy = s.y - s.rot.cos() * geo.geo_offset;
                match threat_bullet_pos(th, t_sec) {
                    Some(p) => {
                        let dx = p.x - gx;
                        let dy = p.y - gy;
                        if dx * dx + dy * dy <= occ_radius * occ_radius {
                            mask[i] = true;
                        }
                    }
                    None => {
                        if let Some(tb) = threat_tail_box_from(th, t_sec) {
                            if tb.distance_to_point(gx, gy) <= occ_radius {
                                mask[i] = true;
                            }
                        }
                    }
                }
            }
            block_start = block_end + 1;
        }
    }

    mask
}

pub fn score_stored_node<F>(
    node: &RescoreNodeInput,
    threats: &[RescoreThreatInput],
    cfg: &RescoreConfig,
    bullet_pos_at: F,
) -> Result<RescoreNodeOutput, RescoreError>
where
    F: Fn(&RescoreThreatInput, f64) -> Option<Point>,
{
    if cfg.spring_rope_enabled {
        return Err(RescoreError::SpringRopeUnsupported);
    }
    if node.start_t.is_nan() || node.start_t.is_infinite() {
        return Err(RescoreError::InvalidNode(
            "start_t is non-finite".to_string(),
        ));
    }
    if node.samples.len() < 2 {
        return Ok(RescoreNodeOutput::empty());
    }

    let scoring_threats = to_scoring_threats(threats);
    let scoring_cfg = scoring::ScoringConfig::default();
    let max_i = node.scored_frames();

    let use_previous = node
        .previous_scores
        .as_ref()
        .map(|p| p.len() == max_i && p.iter().all(|v| v.is_finite()))
        .unwrap_or(false);
    let affected = if use_previous {
        new_threat_affected_frames(node, threats, cfg)
    } else {
        vec![false; max_i + 1]
    };

    let mut total_score = 0.0;
    let mut per_frame_scores = Vec::with_capacity(max_i);
    let mut prev_pose = node.samples[0];

    for i in 1..=max_i {
        let s = node.samples[i];

        if use_previous && !affected[i] {
            let v = node.previous_scores.as_ref().unwrap()[i - 1];
            total_score += v;
            per_frame_scores.push(v);
            prev_pose = s;
            continue;
        }

        let t_sec = node.start_t + i as f64 * RESCORE_DT;
        let bullet_positions: Vec<Point> = threats
            .iter()
            .filter_map(|th| bullet_pos_at(th, t_sec))
            .collect();

        let tank_pose = s.to_scoring();
        let lane_penalty = if cfg.lane_penalty_ratio > 0.0 {
            scoring::lane_penalty_frame(&tank_pose, &scoring_threats, t_sec, cfg.lane_penalty_ratio)
                .penalty
        } else {
            0.0
        };

        let mut frame_net = scoring::score_frame_alive(
            &tank_pose,
            &bullet_positions,
            lane_penalty,
            0.0,
            &scoring_cfg,
        );

        if node.moving && is_stuck_pose(prev_pose, s, cfg) {
            frame_net -= cfg.stuck_penalty;
        }

        total_score += frame_net;
        per_frame_scores.push(frame_net);
        prev_pose = s;
    }

    Ok(RescoreNodeOutput {
        per_frame_scores,
        total_score,
        death_frame: -1,
        verified_frames: 0,
        death_frame_source: DeathSource::None,
    })
}

// ---------------------------------------------------------------------------
// Danger coarse filter (conservative, no false negatives)
// ---------------------------------------------------------------------------

fn point_segment_distance(p: Point, a: Point, b: Point) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let len2 = dx * dx + dy * dy;
    let t = if len2 > 0.0 {
        (((p.x - a.x) * dx + (p.y - a.y) * dy) / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let cx = a.x + dx * t;
    let cy = a.y + dy * t;
    let ex = p.x - cx;
    let ey = p.y - cy;
    (ex * ex + ey * ey).sqrt()
}

fn segment_segment_distance(a: Point, b: Point, c: Point, d: Point) -> f64 {
    let d1x = b.x - a.x;
    let d1y = b.y - a.y;
    let d2x = d.x - c.x;
    let d2y = d.y - c.y;
    let rx = a.x - c.x;
    let ry = a.y - c.y;

    let aa = d1x * d1x + d1y * d1y;
    let ee = d2x * d2x + d2y * d2y;
    let f = d2x * rx + d2y * ry;
    let eps = 1e-12;

    let (mut s, mut t);
    if aa <= eps && ee <= eps {
        return (rx * rx + ry * ry).sqrt();
    }
    if aa <= eps {
        s = 0.0;
        t = (f / ee).clamp(0.0, 1.0);
    } else {
        let cc = d1x * rx + d1y * ry;
        if ee <= eps {
            t = 0.0;
            s = (-cc / aa).clamp(0.0, 1.0);
        } else {
            let bb = d1x * d2x + d1y * d2y;
            let denom = aa * ee - bb * bb;
            s = if denom.abs() > eps {
                ((bb * f - cc * ee) / denom).clamp(0.0, 1.0)
            } else {
                0.0
            };
            t = (bb * s + f) / ee;
            if t < 0.0 {
                t = 0.0;
                s = (-cc / aa).clamp(0.0, 1.0);
            } else if t > 1.0 {
                t = 1.0;
                s = ((bb - cc) / aa).clamp(0.0, 1.0);
            }
        }
    }

    let cx = a.x + d1x * s;
    let cy = a.y + d1y * s;
    let ex = c.x + d2x * t;
    let ey = c.y + d2y * t;
    let dx = cx - ex;
    let dy = cy - ey;
    (dx * dx + dy * dy).sqrt()
}

/// Conservative danger flags for one stored node.
///
/// Returns one `u8` per stored sample.  Index 0 is always 0; index `i >= 1`
/// means "frame i is a candidate death frame" (step `i-1` -> `i`).
pub fn danger_frames_for_node(node: &RescoreNodeInput, threats: &[RescoreThreatInput]) -> Vec<u8> {
    danger_frames_for_samples(&node.samples, threats, node.start_t, RESCORE_DT)
}

/// Lower-level conservative filter with explicit start time and frame dt.
pub fn danger_frames_for_samples(
    samples: &[TankPoseLike],
    threats: &[RescoreThreatInput],
    start_t: f64,
    dt: f64,
) -> Vec<u8> {
    let chunks: Vec<Vec<ThreatCoarseChunk>> = threats
        .iter()
        .map(|th| threat_track_coarse_chunks(th, COARSE_BLOCK_FRAMES))
        .collect();
    danger_frames_for_samples_with_chunks(samples, threats, start_t, dt, &chunks)
}

fn exact_danger_at_frame(
    samples: &[TankPoseLike],
    th: &RescoreThreatInput,
    i: usize,
    start_t: f64,
    dt: f64,
    radius: f64,
) -> bool {
    let tank_prev = samples[i - 1];
    let tank_cur = samples[i];
    let t_prev = start_t + (i - 1) as f64 * dt;
    let t_cur = start_t + i as f64 * dt;
    let p_prev = threat_bullet_pos(th, t_prev);
    let p_cur = threat_bullet_pos(th, t_cur);
    if p_prev.is_none() && p_cur.is_none() {
        return false;
    }

    let min_dist = match (p_prev, p_cur) {
        (Some(a), Some(b)) => segment_segment_distance(tank_prev.point(), tank_cur.point(), a, b),
        (Some(a), None) | (None, Some(a)) => {
            point_segment_distance(a, tank_prev.point(), tank_cur.point())
        }
        (None, None) => return false,
    };

    min_dist <= radius
}

fn danger_frames_for_samples_with_chunks(
    samples: &[TankPoseLike],
    threats: &[RescoreThreatInput],
    start_t: f64,
    dt: f64,
    chunks_by_threat: &[Vec<ThreatCoarseChunk>],
) -> Vec<u8> {
    let mut flags = vec![0u8; samples.len()];
    if samples.len() < 2 {
        return flags;
    }
    let max_i = samples.len() - 1;
    let geo = scoring::exact_geom();
    let envelope = geo.r_semi;

    for (ti, th) in threats.iter().enumerate() {
        let chunks = &chunks_by_threat[ti];
        let radius = envelope + th.bullet_radius + DANGER_MARGIN + th.speed.max(0.0) * dt;

        if chunks.is_empty() {
            // No Box2D track (or all-dead track): exact per-frame fallback.
            for i in 1..=max_i {
                if flags[i] == 0 && exact_danger_at_frame(samples, th, i, start_t, dt, radius) {
                    flags[i] = 1;
                }
            }
            continue;
        }

        let mut block_start = 1usize;
        while block_start <= max_i {
            let block_end = (block_start + COARSE_BLOCK_FRAMES - 1).min(max_i);
            // Danger frame i uses samples[i-1] and samples[i]; the tank box
            // therefore spans samples[block_start-1 ..= block_end].  This
            // exactly covers forward + rotation paths stored in the samples.
            let mut tank_box = TailBox::new_inf();
            for k in (block_start - 1)..=block_end {
                tank_box.add(samples[k].x, samples[k].y);
            }

            let q0 = start_t + (block_start as f64 - 1.0) * dt - th.anchor_offset;
            let q1 = start_t + block_end as f64 * dt - th.anchor_offset;

            let mut any_overlap = false;
            let mut all_overlap_far = true;
            for ch in chunks {
                if !ch.overlaps(q0, q1) {
                    continue;
                }
                any_overlap = true;
                if ch.bbox.distance_to_box(&tank_box) <= radius {
                    all_overlap_far = false;
                    break;
                }
            }

            if any_overlap && all_overlap_far {
                // Whole block is safe for this threat.
                block_start = block_end + 1;
                continue;
            }

            for i in block_start..=block_end {
                if flags[i] == 0 && exact_danger_at_frame(samples, th, i, start_t, dt, radius) {
                    flags[i] = 1;
                }
            }
            block_start = block_end + 1;
        }
    }

    flags
}

// ---------------------------------------------------------------------------
// Death verification (game-identical fused sensor/CCD)
// ---------------------------------------------------------------------------

/// Verify candidate death frames against the dedicated fused verification
/// world.  Only frames whose `danger_flags[i] == 1` are simulated.
pub fn verify_death_for_node(
    cache: &mut VerificationCache,
    walls: &[WallPoly],
    node: &RescoreNodeInput,
    threats: &[RescoreThreatInput],
    danger_flags: &[u8],
) -> Result<(i32, u32), RescoreError> {
    if node.samples.len() < 2 {
        return Ok((-1, 0));
    }
    let max_steps = node.frames.min(node.samples.len() - 1);
    if max_steps == 0 {
        return Ok((-1, 0));
    }

    let mut any_danger = false;
    for k in 0..max_steps {
        if danger_flags.get(k + 1).copied().unwrap_or(0) != 0 {
            any_danger = true;
            break;
        }
    }
    if !any_danger {
        return Ok((-1, 0));
    }

    let vw = cache
        .ensure_world(walls)
        .map_err(RescoreError::Verification)?;
    let candidate = vw.candidate;

    let mut prev_vel: Vec<Option<(f64, f64)>> = vec![None; threats.len()];
    let mut verified_frames: u32 = 0;

    for k in 0..max_steps {
        if danger_flags.get(k + 1).copied().unwrap_or(0) == 0 {
            continue;
        }

        let p0 = node.samples[k];
        let p1 = node.samples[k + 1];

        vw.round += 1;
        let round = vw.round;

        vw.world.set_active(candidate, true);
        vw.world
            .set_position_and_angle(candidate, p0.x, p0.y, p0.rot);
        vw.world.set_body_linear_velocity(
            candidate,
            ((p1.x - p0.x) / RESCORE_DT, (p1.y - p0.y) / RESCORE_DT),
        );
        vw.world
            .set_body_angular_velocity(candidate, norm_angle_delta(p1.rot - p0.rot) / RESCORE_DT);
        vw.world.set_body_awake(candidate, true);

        for (ti, th) in threats.iter().enumerate() {
            let t_k = node.start_t + k as f64 * RESCORE_DT;
            let t_k1 = node.start_t + (k + 1) as f64 * RESCORE_DT;
            let pos_k = threat_bullet_pos(th, t_k);
            let pos_k1 = threat_bullet_pos(th, t_k1);

            let pos_k = match pos_k {
                Some(p) => p,
                None => continue,
            };

            let radius = th.bullet_radius;
            let slot_idx = vw.acquire_bullet_slot(radius);
            let body = vw.bullet_slots[slot_idx].body;

            let (vx, vy) = match pos_k1 {
                Some(p1) => ((p1.x - pos_k.x) / RESCORE_DT, (p1.y - pos_k.y) / RESCORE_DT),
                None => prev_vel[ti].unwrap_or((0.0, 0.0)),
            };

            let initial_speed = (vx * vx + vy * vy).sqrt();
            vw.world.set_position_and_angle(body, pos_k.x, pos_k.y, 0.0);
            vw.world.set_body_linear_velocity(body, (vx, vy));
            vw.world.set_body_angular_velocity(body, 0.0);
            vw.world.set_body_awake(body, true);

            let q_life = (t_k - th.anchor_offset).max(0.0);
            let life_left = (th.life_left_seconds - q_life).max(0.0);
            let active = initial_speed > 0.0 && life_left > 0.0;
            vw.bullet_slots[slot_idx].initial_speed = initial_speed;
            vw.bullet_slots[slot_idx].life_left = life_left;
            vw.bullet_slots[slot_idx].active = active;
            vw.bullet_slots[slot_idx].last_vx = vx;
            vw.bullet_slots[slot_idx].last_vy = vy;
            if initial_speed > 0.0 {
                prev_vel[ti] = Some((vx, vy));
            }
            if !active {
                vw.world.set_active(body, false);
            }
        }
        vw.park_unused_bullets();

        vw.world.step(RESCORE_DT, 10, 10);
        verified_frames += 1;

        // Bullet lifetime / renormalization, exactly like JS.
        for slot_idx in 0..vw.bullet_slots.len() {
            let slot = &mut vw.bullet_slots[slot_idx];
            if slot.last_round != round || !vw.world.body_is_active(slot.body) {
                continue;
            }
            slot.life_left -= RESCORE_DT;
            if slot.life_left <= 0.0 {
                slot.active = false;
                vw.world.set_active(slot.body, false);
                continue;
            }
            let (vx, vy) = vw.world.body_linear_velocity(slot.body);
            let len = (vx * vx + vy * vy).sqrt();
            if len == 0.0 {
                slot.active = false;
                vw.world.set_active(slot.body, false);
                continue;
            }
            let len_sq = len * len;
            let init_sq = slot.initial_speed * slot.initial_speed;
            if (len_sq - init_sq).abs() > 0.01 {
                let scale = slot.initial_speed / len;
                vw.world
                    .set_body_linear_velocity(slot.body, (vx * scale, vy * scale));
            }
        }

        // Fused sensor death scan.
        let contacts = vw.world.contacts().to_vec();
        let mut hit = false;
        for contact in contacts {
            if !contact.is_touching() {
                continue;
            }
            let fa = contact.fixture_a;
            let fb = contact.fixture_b;
            let (sensor_op, other_cat) = match vw.world.fixture_kind(fa) {
                FixtureKind::TankSensor { op_index } => {
                    (*op_index as usize, vw.world.fixture_category_bits(fb))
                }
                _ => match vw.world.fixture_kind(fb) {
                    FixtureKind::TankSensor { op_index } => {
                        (*op_index as usize, vw.world.fixture_category_bits(fa))
                    }
                    _ => continue,
                },
            };
            if sensor_op == 0 && other_cat == CATEGORY_PROJECTILE {
                hit = true;
                break;
            }
        }

        if hit {
            return Ok(((k + 1) as i32, verified_frames));
        }
    }

    Ok((-1, verified_frames))
}

// ---------------------------------------------------------------------------
// Full rescore entry point (scoring + danger + verification)
// ---------------------------------------------------------------------------

pub fn rescore_nodes(
    cache: &mut VerificationCache,
    walls: &[WallPoly],
    nodes: &[RescoreNodeInput],
    threats: &[RescoreThreatInput],
    cfg: &RescoreConfig,
) -> Result<Vec<RescoreNodeOutput>, RescoreError> {
    if cfg.spring_rope_enabled {
        return Err(RescoreError::SpringRopeUnsupported);
    }

    // Precompute coarse track chunks once for the whole batch.  The danger
    // pre-filter can then skip far-away frame blocks without re-reading the
    // track per node.  (Path-only threats simply fall back to exact checks.)
    let danger_chunks: Vec<Vec<ThreatCoarseChunk>> = threats
        .iter()
        .map(|th| threat_track_coarse_chunks(th, COARSE_BLOCK_FRAMES))
        .collect();

    let mut outputs = Vec::with_capacity(nodes.len());
    for node in nodes {
        let mut out = score_stored_node(node, threats, cfg, threat_bullet_pos)?;
        if node.scored_frames() > 0 && node.samples.len() >= 2 {
            let danger = danger_frames_for_samples_with_chunks(
                &node.samples,
                threats,
                node.start_t,
                RESCORE_DT,
                &danger_chunks,
            );
            let (death_frame, verified_frames) =
                verify_death_for_node(cache, walls, node, threats, &danger)?;
            if death_frame > 0 {
                let death_idx = death_frame as usize;
                if death_idx <= out.per_frame_scores.len() {
                    let mut alive: Vec<f64> = out.per_frame_scores.drain(..death_idx - 1).collect();
                    let new_total = alive.iter().sum::<f64>() - cfg.death_penalty;
                    alive.push(-cfg.death_penalty);
                    out.per_frame_scores = alive;
                    out.total_score = new_total;
                }
                out.death_frame = death_frame;
                out.verified_frames = verified_frames;
                out.death_frame_source = DeathSource::FusedSensorContact;
            } else {
                out.verified_frames = verified_frames;
            }
        }
        outputs.push(out);
    }

    Ok(outputs)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rollout::{
        run_rollout_batch, BulletInput, OpInput, RolloutCache, RolloutInput, StartPose,
    };

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

    fn path_pts(pts: &[(f64, f64)]) -> Vec<ThreatPathPoint> {
        pts.iter()
            .map(|(x, y)| ThreatPathPoint::new(*x, *y))
            .collect()
    }

    fn static_node(frames: usize) -> RescoreNodeInput {
        let samples = (0..=frames)
            .map(|_| TankPoseLike::new(5.0, 8.0, 0.0))
            .collect();
        RescoreNodeInput::new(samples, false, 0.0, frames)
    }

    #[test]
    fn threat_bullet_pos_track_then_path_fallback() {
        let th = RescoreThreatInput::new(1)
            .with_track(vec![ThreatTrackPoint::new(0.0, 0.0, true)])
            .with_path(path_pts(&[(0.0, 0.0), (0.0, 10.0)]), 10.0);
        assert_eq!(threat_bullet_pos(&th, 0.0), Some(Point::new(0.0, 0.0)));
        assert_eq!(threat_bullet_pos(&th, 0.03), None); // track exhausted, no fallback

        let th = RescoreThreatInput::new(2).with_path(path_pts(&[(0.0, 0.0), (0.0, 10.0)]), 10.0);
        assert_eq!(threat_bullet_pos(&th, 0.0), Some(Point::new(0.0, 0.0)));
        assert_eq!(threat_bullet_pos(&th, 0.5), Some(Point::new(0.0, 5.0)));
        assert_eq!(threat_bullet_pos(&th, 1.05), None); // total length guard
    }

    #[test]
    fn scoring_track_matches_hardcoded_js_values() {
        // JS reference: real VantageScoring.scorePaths in Node vm, static tank
        // at (5,8) rot=0, 75 stored samples, track bullet moving +x at y=12
        // (always far enough away to leave the full free-circle score).
        let track: Vec<ThreatTrackPoint> = (0..=75)
            .map(|i| {
                let t = i as f64 * 0.02;
                ThreatTrackPoint::new(5.0 + t * 18.0, 12.0, true)
            })
            .collect();
        let node = static_node(75);
        let threats = vec![RescoreThreatInput::new(1)
            .with_track(track)
            .with_bullet_radius(0.25)];
        let cfg = RescoreConfig::default();
        let out = score_stored_node(&node, &threats, &cfg, threat_bullet_pos).unwrap();
        let expected: Vec<f64> = vec![
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
        ];
        assert_eq!(out.per_frame_scores.len(), expected.len());
        for (a, b) in out.per_frame_scores.iter().zip(expected.iter()) {
            assert!((a - b).abs() < 1e-12, "track score {} vs {}", a, b);
        }
        assert!((out.total_score - 2960.881320326803).abs() < 1e-12);
    }

    #[test]
    fn scoring_path_matches_hardcoded_js_values() {
        // JS reference: static tank at (5,8) rot=0, path bullet crossing from
        // (5,-10) to (5,10) at 10 m/s.  Only the final frames (bullet near the
        // tank envelope) differ from the full free-circle score.
        let node = static_node(75);
        let threats = vec![RescoreThreatInput::new(1)
            .with_path(path_pts(&[(5.0, -10.0), (5.0, 10.0)]), 10.0)
            .with_bullet_radius(0.25)];
        let cfg = RescoreConfig::default();
        let out = score_stored_node(&node, &threats, &cfg, threat_bullet_pos).unwrap();
        let expected: Vec<f64> = vec![
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            39.47841760435743,
            9.443335622221936,
            7.665741589284684,
            5.659172068887242,
        ];
        assert_eq!(out.per_frame_scores.len(), expected.len());
        for (a, b) in out.per_frame_scores.iter().zip(expected.iter()) {
            assert!((a - b).abs() < 1e-12, "path score {} vs {}", a, b);
        }
        assert!((out.total_score - 2865.214316794125).abs() < 1e-12);
    }

    #[test]
    fn danger_filter_no_false_negative_for_crossing_path() {
        let samples: Vec<TankPoseLike> =
            (0..=75).map(|_| TankPoseLike::new(0.0, 0.0, 0.0)).collect();
        let node = RescoreNodeInput::new(samples, false, 0.0, 75);
        let threats = vec![RescoreThreatInput::new(1)
            .with_path(path_pts(&[(0.0, -10.0), (0.0, 10.0)]), 10.0)
            .with_bullet_radius(0.25)];
        let flags = danger_frames_for_node(&node, &threats);
        for i in 33..=67 {
            assert_eq!(flags[i], 1, "frame {} should be dangerous", i);
        }
        assert_eq!(flags[0], 0);
    }

    #[test]
    fn danger_filter_empty_when_threat_exhausted() {
        let samples: Vec<TankPoseLike> =
            (0..=75).map(|_| TankPoseLike::new(0.0, 0.0, 0.0)).collect();
        let node = RescoreNodeInput::new(samples, false, 0.0, 75);
        let threats = vec![RescoreThreatInput::new(1)
            .with_path(path_pts(&[(0.0, 0.0), (0.0, 0.1)]), 1.0)
            .with_bullet_radius(0.25)];
        let flags = danger_frames_for_node(&node, &threats);
        for (i, f) in flags.iter().enumerate().skip(1) {
            if i > 15 {
                assert_eq!(*f, 0, "frame {} should not be dangerous", i);
            }
        }
    }

    #[test]
    fn verification_matches_fused_batch_head_on() {
        let walls = arena_walls();
        let mut rollout_cache = RolloutCache::new();
        let input = RolloutInput {
            start_pose: StartPose {
                x: 5.0,
                y: 8.0,
                rot: 0.0,
            },
            ops: vec![OpInput {
                speed: 0.0,
                rotation_speed: 0.0,
            }],
            duration_frames: 40,
            walls: walls.clone(),
            bullets: vec![BulletInput {
                x: 5.0,
                y: 12.0,
                vx: 0.0,
                vy: -18.0,
                radius: 0.25,
                life_left: 10.0,
                active: true,
            }],
            cache_id: 0,
        };
        let rollout = run_rollout_batch(&mut rollout_cache, &input).unwrap();
        assert!(rollout.death_frame[0] > 0, "fused batch should die");

        let node = RescoreNodeInput::new(
            rollout.samples[0]
                .iter()
                .map(|s| TankPoseLike::new(s.x, s.y, s.rot))
                .collect(),
            false,
            0.0,
            40,
        );
        let threats = vec![RescoreThreatInput::new(1)
            .with_path(path_pts(&[(5.0, 12.0), (5.0, -10.0)]), 18.0)
            .with_bullet_radius(0.25)
            .with_life_left_seconds(10.0)];
        let danger = danger_frames_for_node(&node, &threats);
        let mut cache = VerificationCache::new();
        let (death_frame, verified) =
            verify_death_for_node(&mut cache, &walls, &node, &threats, &danger).unwrap();
        assert_eq!(death_frame, rollout.death_frame[0]);
        assert!(verified > 0);
    }

    #[test]
    fn verification_radius_change_and_warm_persistence_do_not_panic() {
        let walls = arena_walls();
        let samples: Vec<TankPoseLike> =
            (0..=5).map(|_| TankPoseLike::new(5.0, 8.0, 0.0)).collect();
        let node = RescoreNodeInput::new(samples, false, 0.0, 5);
        let mk_threats = |radius| {
            vec![RescoreThreatInput::new(1)
                .with_path(path_pts(&[(5.0, 12.0), (5.0, -10.0)]), 18.0)
                .with_bullet_radius(radius)
                .with_life_left_seconds(10.0)]
        };
        let mut cache = VerificationCache::new();

        let danger = danger_frames_for_node(&node, &mk_threats(0.25));
        let r1 =
            verify_death_for_node(&mut cache, &walls, &node, &mk_threats(0.25), &danger).unwrap();
        let r2 =
            verify_death_for_node(&mut cache, &walls, &node, &mk_threats(0.1), &danger).unwrap();
        let r3 =
            verify_death_for_node(&mut cache, &walls, &node, &mk_threats(0.1), &danger).unwrap();
        assert_eq!(r1, r2);
        assert_eq!(r2, r3);
    }

    #[test]
    fn rescore_nodes_spring_rope_is_explicitly_unsupported() {
        let cfg = RescoreConfig {
            spring_rope_enabled: true,
            ..RescoreConfig::default()
        };
        let err = rescore_nodes(
            &mut VerificationCache::new(),
            &arena_walls(),
            &[static_node(1)],
            &[],
            &cfg,
        )
        .unwrap_err();
        assert_eq!(err, RescoreError::SpringRopeUnsupported);
    }

    #[test]
    fn incremental_mask_far_away_new_bullet_is_empty() {
        let node = static_node(75);
        let prev = score_stored_node(&node, &[], &RescoreConfig::default(), threat_bullet_pos)
            .unwrap()
            .per_frame_scores;
        let new_threat = RescoreThreatInput::new(9)
            .with_path(path_pts(&[(100.0, 100.0), (100.0, 80.0)]), 10.0)
            .with_is_new(true);
        let node_prev = node.with_previous_scores(prev.clone());

        let mask = new_threat_affected_frames(
            &node_prev,
            &[new_threat.clone()],
            &RescoreConfig::default(),
        );
        assert!(mask.iter().skip(1).all(|b| !b), "far bullet marked a frame");

        let out = score_stored_node(
            &node_prev,
            &[new_threat],
            &RescoreConfig::default(),
            threat_bullet_pos,
        )
        .unwrap();
        assert_eq!(out.per_frame_scores, prev);
        assert_eq!(out.total_score, prev.iter().sum::<f64>());
    }

    #[test]
    fn incremental_mask_crossing_new_bullet_matches_full_recompute() {
        let node = static_node(75);
        let prev = score_stored_node(&node, &[], &RescoreConfig::default(), threat_bullet_pos)
            .unwrap()
            .per_frame_scores;
        let threat = RescoreThreatInput::new(1)
            .with_path(path_pts(&[(5.0, -10.0), (5.0, 10.0)]), 10.0)
            .with_bullet_radius(0.25)
            .with_is_new(true);

        let incremental = score_stored_node(
            &node.clone().with_previous_scores(prev),
            &[threat.clone()],
            &RescoreConfig::default(),
            threat_bullet_pos,
        )
        .unwrap();
        let full = score_stored_node(
            &node,
            &[threat],
            &RescoreConfig::default(),
            threat_bullet_pos,
        )
        .unwrap();
        assert_eq!(incremental.per_frame_scores, full.per_frame_scores);
        assert_eq!(incremental.total_score, full.total_score);
        assert_eq!(incremental.death_frame, full.death_frame);
    }

    #[test]
    fn danger_coarse_skip_matches_exact_for_moving_rotating_tank() {
        let samples: Vec<TankPoseLike> = (0..=75)
            .map(|i| {
                let t = i as f64 * RESCORE_DT;
                TankPoseLike::new(
                    5.0 + t * 0.4,
                    8.0 + (t * 2.1).sin() * 1.5,
                    (t * 1.7).cos() * 0.8,
                )
            })
            .collect();
        let node = RescoreNodeInput::new(samples.clone(), true, 0.0, 75);

        let tracks = vec![
            // Far away parallel track: should be all zero and is the exact
            // case the coarse skip is designed to accelerate.
            (0..=100)
                .map(|i| ThreatTrackPoint::new(20.0 + i as f64 * 0.05, 30.0, true))
                .collect::<Vec<_>>(),
            // Crossing track that intersects the moving/rotating node path.
            (0..=100)
                .map(|i| ThreatTrackPoint::new(4.0 + i as f64 * 0.03, 8.5, true))
                .collect::<Vec<_>>(),
            // Track that dies halfway through.
            (0..=100)
                .map(|i| ThreatTrackPoint::new(4.0 + i as f64 * 0.03, 8.0, i < 40))
                .collect::<Vec<_>>(),
        ];

        let geo = scoring::exact_geom();
        let envelope = geo.r_semi;
        for track in tracks {
            let th = RescoreThreatInput::new(1)
                .with_track(track)
                .with_bullet_radius(0.25)
                .with_life_left_seconds(10.0);
            let chunks = threat_track_coarse_chunks(&th, COARSE_BLOCK_FRAMES);
            let coarse = danger_frames_for_samples_with_chunks(
                &samples,
                &[th.clone()],
                node.start_t,
                RESCORE_DT,
                &[chunks],
            );
            let radius =
                envelope + th.bullet_radius + DANGER_MARGIN + th.speed.max(0.0) * RESCORE_DT;
            let mut brute = vec![0u8; samples.len()];
            for i in 1..samples.len() {
                if exact_danger_at_frame(&samples, &th, i, node.start_t, RESCORE_DT, radius) {
                    brute[i] = 1;
                }
            }
            assert_eq!(coarse, brute, "coarse danger differs from exact");
        }
    }

    #[test]
    fn affected_mask_coarse_skip_matches_exact_for_occlusion_only() {
        let samples: Vec<TankPoseLike> = (0..=75)
            .map(|i| {
                let t = i as f64 * RESCORE_DT;
                TankPoseLike::new(
                    5.0 + t * 0.4,
                    8.0 + (t * 2.1).sin() * 1.5,
                    (t * 1.7).cos() * 0.8,
                )
            })
            .collect();
        let node = RescoreNodeInput::new(samples, true, 0.0, 75);
        let geo = scoring::exact_geom();
        let occ_radius = geo.r_semi + 0.25;

        let tracks = vec![
            (0..=100)
                .map(|i| ThreatTrackPoint::new(20.0 + i as f64 * 0.05, 30.0, true))
                .collect::<Vec<_>>(),
            (0..=100)
                .map(|i| ThreatTrackPoint::new(4.0 + i as f64 * 0.03, 8.5, true))
                .collect::<Vec<_>>(),
            (0..=100)
                .map(|i| ThreatTrackPoint::new(4.0 + i as f64 * 0.03, 8.0, i < 40))
                .collect::<Vec<_>>(),
        ];

        for track in tracks {
            let th = RescoreThreatInput::new(1)
                .with_track(track)
                .with_bullet_radius(0.25)
                .with_life_left_seconds(10.0)
                .with_is_new(true);
            let coarse = new_threat_affected_frames(
                &node.clone().with_previous_scores(vec![0.0; 75]),
                &[th.clone()],
                &RescoreConfig::default(),
            );
            let mut brute = vec![false; 76];
            for i in 1..=75 {
                let s = node.samples[i];
                let t_sec = node.start_t + i as f64 * RESCORE_DT;
                let gx = s.x + s.rot.sin() * geo.geo_offset;
                let gy = s.y - s.rot.cos() * geo.geo_offset;
                match threat_bullet_pos(&th, t_sec) {
                    Some(p) => {
                        let dx = p.x - gx;
                        let dy = p.y - gy;
                        brute[i] = dx * dx + dy * dy <= occ_radius * occ_radius;
                    }
                    None => {
                        if let Some(tb) = threat_tail_box_from(&th, t_sec) {
                            brute[i] = tb.distance_to_point(gx, gy) <= occ_radius;
                        }
                    }
                }
            }
            assert_eq!(coarse, brute, "coarse affected mask differs from exact");
        }
    }

    #[test]
    fn incremental_mask_lane_enabled_is_conservative_and_matches_full() {
        let node = static_node(75);
        let cfg = RescoreConfig {
            lane_penalty_ratio: 0.5,
            ..RescoreConfig::default()
        };
        let prev = score_stored_node(&node, &[], &cfg, threat_bullet_pos)
            .unwrap()
            .per_frame_scores;
        let threat = RescoreThreatInput::new(1)
            .with_path(path_pts(&[(5.0, -10.0), (5.0, 10.0)]), 10.0)
            .with_bullet_radius(0.25)
            .with_is_new(true);

        let mask = new_threat_affected_frames(
            &node.clone().with_previous_scores(prev.clone()),
            &[threat.clone()],
            &cfg,
        );
        let full = score_stored_node(&node, &[threat.clone()], &cfg, threat_bullet_pos).unwrap();
        let incremental = score_stored_node(
            &node.with_previous_scores(prev.clone()),
            &[threat],
            &cfg,
            threat_bullet_pos,
        )
        .unwrap();

        for i in 1..=full.per_frame_scores.len() {
            if (full.per_frame_scores[i - 1] - prev[i - 1]).abs() > 1e-15 {
                assert!(mask[i], "frame {} differs but was not marked affected", i);
            }
        }
        assert_eq!(incremental.per_frame_scores, full.per_frame_scores);
        assert_eq!(incremental.total_score, full.total_score);
        assert_eq!(incremental.death_frame, full.death_frame);
    }

    #[test]
    fn rescore_nodes_previous_scores_path_matches_full_for_death_scene() {
        let walls = arena_walls();
        let samples: Vec<TankPoseLike> =
            (0..=40).map(|_| TankPoseLike::new(5.0, 8.0, 0.0)).collect();
        let node = RescoreNodeInput::new(samples, false, 0.0, 40);
        let threat = RescoreThreatInput::new(1)
            .with_path(path_pts(&[(5.0, 12.0), (5.0, -10.0)]), 18.0)
            .with_bullet_radius(0.25)
            .with_life_left_seconds(10.0)
            .with_is_new(true);
        let cfg = RescoreConfig::default();

        let prev = score_stored_node(&node, &[], &cfg, threat_bullet_pos)
            .unwrap()
            .per_frame_scores;
        let incremental = rescore_nodes(
            &mut VerificationCache::new(),
            &walls,
            &[node.clone().with_previous_scores(prev)],
            &[threat.clone()],
            &cfg,
        )
        .unwrap();
        let full = rescore_nodes(
            &mut VerificationCache::new(),
            &walls,
            &[node],
            &[threat],
            &cfg,
        )
        .unwrap();

        assert_eq!(incremental[0].per_frame_scores, full[0].per_frame_scores);
        assert_eq!(incremental[0].total_score, full[0].total_score);
        assert_eq!(incremental[0].death_frame, full[0].death_frame);
        assert!(full[0].death_frame > 0, "test scene should die");
    }
}
