//! Scoring / geometry core (phase 1).
//!
//! This module mirrors the pure computation parts of
//! `game_core/js/vantage_scoring.js`:
//! - `exactGeom`
//! - `occlusionIntervals` / `exactOcclusion`
//! - `lanePenaltyFrame`
//! - `springRopeLength` / `springRopeFrameScore`
//! - `scoreFrameAlive`
//!
//! It deliberately contains no tree, no NN, no death decision, and no WASM
//! C ABI exports. All values follow the JS copy-area formulas and the JS
//! runtime `Constants` defaults documented below.

use std::collections::HashSet;

use crate::Rect;

pub const TWO_PI: f64 = std::f64::consts::PI * 2.0;

/// Default geometry constants. These are the JS runtime values behind
/// `Constants` (all `*.m` are `px / 20.0`).
pub const BULLET_RADIUS_M: f64 = 5.0 / 20.0; // 0.25 m
pub const TANK_WIDTH_M: f64 = 60.0 / 20.0; // 3.0 m
pub const TANK_HEIGHT_M: f64 = 80.0 / 20.0; // 4.0 m
pub const BULLET_TURRET_OFFSET_Y_M: f64 = -40.0 / 20.0; // -2.0 m
pub const BULLET_TURRET_HEIGHT_M: f64 = 28.0 / 20.0; // 1.4 m
pub const BULLET_OFFSET_M: f64 = 50.0 / 20.0; // 2.5 m

/// Default spring-rope parameters (JS `SCORING_DEFAULTS`).
pub const SPRING_ROPE_D_NEAR_DEFAULT: f64 = 4.0;
pub const SPRING_ROPE_D_REF_DEFAULT: f64 = 30.0;
pub const SPRING_ROPE_CLEARANCE_CAP_DEFAULT: f64 = 8.0;

/// Track frame interval used by `threat.track` lookups (sandbox `FRAME_DT`).
pub const TRACK_DT: f64 = 0.02;

/// Lane penalty coarse-filter radius (`> 3.5m` box skip in JS).
const LANE_SKIP_RADIUS: f64 = 3.5;

/// Copy-area 2 rotation shift: free interval heading = atan2 angle + 90°.
const ROT_SHIFT: f64 = std::f64::consts::FRAC_PI_2;

// ---------------------------------------------------------------------------
// 1. Basic geometry (`exactGeom`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ExactGeom {
    pub tank_half_width: f64,
    pub tank_body_half_back: f64,
    pub tank_half_forward: f64,
    pub rect_half_height: f64,
    pub effective_half_width: f64,
    pub effective_half_height: f64,
    pub r_abs: f64,
    pub r_semi: f64,
    pub geo_offset: f64,
}

/// Mirror of JS `exactGeom()`.
pub fn exact_geom() -> ExactGeom {
    let bullet_r = BULLET_RADIUS_M;
    let half_w = TANK_WIDTH_M * 0.5;
    let half_back = TANK_HEIGHT_M * 0.5;
    let half_forward = half_back
        .max(BULLET_TURRET_OFFSET_Y_M.abs() + BULLET_TURRET_HEIGHT_M * 0.5)
        .max(BULLET_OFFSET_M + bullet_r);
    let rect_half_h = (half_forward + half_back) * 0.5;
    ExactGeom {
        tank_half_width: half_w,
        tank_body_half_back: half_back,
        tank_half_forward: half_forward,
        rect_half_height: rect_half_h,
        effective_half_width: half_w + bullet_r,
        effective_half_height: rect_half_h + bullet_r,
        r_abs: half_w + bullet_r,
        r_semi: (rect_half_h * rect_half_h + half_w * half_w).sqrt() + bullet_r,
        geo_offset: (half_forward - half_back) * 0.5,
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TankPose {
    pub x: f64,
    pub y: f64,
    pub rot: f64,
}

impl TankPose {
    pub fn new(x: f64, y: f64, rot: f64) -> Self {
        Self { x, y, rot }
    }

    fn point(&self) -> Point {
        Point {
            x: self.x,
            y: self.y,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Interval {
    pub start: f64,
    pub end: f64,
    pub width: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OcclusionResult {
    pub free_intervals: Vec<Interval>,
    pub occluded_rad: f64,
}

// ---------------------------------------------------------------------------
// 2. Occlusion intervals (`occlusionIntervals` / `exactOcclusion`)
// ---------------------------------------------------------------------------

fn norm_angle(a: f64) -> f64 {
    let t = TWO_PI;
    ((a % t) + t) % t
}

/// JS `norm` inside `mergeIntervals`: maps to `(-π, π]`.
fn norm_half(a: f64) -> f64 {
    let mut a = a;
    while a > std::f64::consts::PI {
        a -= TWO_PI;
    }
    while a < -std::f64::consts::PI {
        a += TWO_PI;
    }
    a
}

fn gap_width(start: f64, end: f64) -> f64 {
    let w = norm_half(end - start);
    if w < 0.0 {
        w + TWO_PI
    } else {
        w
    }
}

#[derive(Debug, Clone, Copy)]
struct Ev {
    a: f64,
    is_start: bool,
}

fn merge_intervals(intervals: &[Interval]) -> Vec<Interval> {
    if intervals.is_empty() {
        return Vec::new();
    }

    let mut evts: Vec<Ev> = Vec::new();
    for iv in intervals {
        let mut s = iv.start;
        let mut e = iv.end;
        while s < 0.0 {
            s += TWO_PI;
        }
        while s >= TWO_PI {
            s -= TWO_PI;
        }
        while e < 0.0 {
            e += TWO_PI;
        }
        while e >= TWO_PI {
            e -= TWO_PI;
        }

        if s <= e {
            evts.push(Ev {
                a: s,
                is_start: true,
            });
            evts.push(Ev {
                a: e,
                is_start: false,
            });
        } else {
            // Wraps across 0: [s, 2π) ∪ [0, e].
            evts.push(Ev {
                a: 0.0,
                is_start: true,
            });
            evts.push(Ev {
                a: e,
                is_start: false,
            });
            evts.push(Ev {
                a: s,
                is_start: true,
            });
            evts.push(Ev {
                a: TWO_PI,
                is_start: false,
            });
        }
    }

    evts.sort_by(|a, b| {
        a.a.partial_cmp(&b.a)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| match (a.is_start, b.is_start) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => std::cmp::Ordering::Equal,
            })
    });

    let mut merged: Vec<Interval> = Vec::new();
    let mut depth = 0i32;
    let mut cur_start: f64 = -1.0;
    for ev in evts {
        if ev.is_start {
            if depth == 0 {
                cur_start = ev.a;
            }
            depth += 1;
        } else {
            depth -= 1;
            if depth == 0 && cur_start >= 0.0 {
                merged.push(Interval {
                    start: cur_start,
                    end: ev.a,
                    width: 0.0,
                });
                cur_start = -1.0;
            }
        }
    }

    // Merge a first interval starting at 0 with a last interval ending at 2π.
    if merged.len() >= 2 {
        let first = merged[0];
        let last = merged[merged.len() - 1];
        if first.start.abs() < 0.001 && (last.end - TWO_PI).abs() < 0.001 {
            merged[0] = Interval {
                start: last.start,
                end: first.end,
                width: 0.0,
            };
            merged.pop();
        }
    }

    merged
}

fn find_gaps(merged: &[Interval]) -> Vec<Interval> {
    if merged.is_empty() {
        return vec![Interval {
            start: 0.0,
            end: TWO_PI,
            width: 0.0,
        }];
    }

    let mut gaps = Vec::new();
    for i in 0..merged.len().saturating_sub(1) {
        gaps.push(Interval {
            start: merged[i].end,
            end: merged[i + 1].start,
            width: 0.0,
        });
    }

    let first = merged[0];
    let last = merged[merged.len() - 1];
    if first.start > 0.001 || last.end < TWO_PI - 0.001 {
        gaps.push(Interval {
            start: last.end,
            end: first.start + TWO_PI,
            width: 0.0,
        });
    }

    gaps
}

fn test_arc(raw_arcs: &mut Vec<Interval>, a_lo: f64, a_hi: f64, b_lo: f64, b_hi: f64) {
    let lo = a_lo.max(b_lo);
    let hi = a_hi.min(b_hi);
    if lo >= hi - 1e-9 {
        return;
    }
    let lo = norm_angle(lo);
    let hi = norm_angle(hi);
    if lo < hi {
        raw_arcs.push(Interval {
            start: lo,
            end: hi,
            width: 0.0,
        });
    } else {
        raw_arcs.push(Interval {
            start: lo,
            end: TWO_PI,
            width: 0.0,
        });
        raw_arcs.push(Interval {
            start: 0.0,
            end: hi,
            width: 0.0,
        });
    }
}

/// JS copy-area 2 `exactOcclusion` (called with the geometry centre and the
/// bullets that survived the R_SEMI coarse filter).
fn exact_occlusion(px: f64, py: f64, bullets: &[Point]) -> OcclusionResult {
    let geo = exact_geom();
    let tpi = TWO_PI;

    if bullets.is_empty() {
        return OcclusionResult {
            free_intervals: vec![Interval {
                start: 0.0,
                end: tpi,
                width: tpi,
            }],
            occluded_rad: 0.0,
        };
    }

    let r_abs2 = geo.r_abs * geo.r_abs;
    for b in bullets {
        let dx = px - b.x;
        let dy = py - b.y;
        if dx * dx + dy * dy < r_abs2 {
            return OcclusionResult {
                free_intervals: Vec::new(),
                occluded_rad: tpi,
            };
        }
    }

    let r_semi2 = geo.r_semi * geo.r_semi;
    let mut in_semi = false;
    for b in bullets {
        let dx = px - b.x;
        let dy = py - b.y;
        if dx * dx + dy * dy < r_semi2 {
            in_semi = true;
            break;
        }
    }
    if !in_semi {
        return OcclusionResult {
            free_intervals: vec![Interval {
                start: 0.0,
                end: tpi,
                width: tpi,
            }],
            occluded_rad: 0.0,
        };
    }

    let mut raw_arcs: Vec<Interval> = Vec::new();
    for b in bullets {
        let dx = b.x - px;
        let dy = b.y - py;
        let d = (dx * dx + dy * dy).sqrt();
        if d <= 1e-9 {
            continue;
        }
        let a_w = (geo.effective_half_width / d).min(1.0).asin();
        let a_h = (geo.effective_half_height / d).min(1.0).asin();
        if a_w + a_h < std::f64::consts::FRAC_PI_2 - 1e-9 {
            continue;
        }
        if a_w >= std::f64::consts::FRAC_PI_2 - 1e-9 {
            raw_arcs.push(Interval {
                start: 0.0,
                end: tpi,
                width: 0.0,
            });
            continue;
        }

        let theta = dy.atan2(dx);
        let sin_b = [
            theta - a_w,
            theta + a_w,
            theta + std::f64::consts::PI - a_w,
            theta + std::f64::consts::PI + a_w,
        ];
        let cos_b = [
            theta + std::f64::consts::FRAC_PI_2 - a_h,
            theta + std::f64::consts::FRAC_PI_2 + a_h,
            theta + 3.0 * std::f64::consts::FRAC_PI_2 - a_h,
            theta + 3.0 * std::f64::consts::FRAC_PI_2 + a_h,
        ];

        for sa in (0..4).step_by(2) {
            for sb in (0..4).step_by(2) {
                test_arc(
                    &mut raw_arcs,
                    sin_b[sa],
                    sin_b[sa + 1],
                    cos_b[sb],
                    cos_b[sb + 1],
                );
                test_arc(
                    &mut raw_arcs,
                    sin_b[sa] + tpi,
                    sin_b[sa + 1] + tpi,
                    cos_b[sb],
                    cos_b[sb + 1],
                );
                test_arc(
                    &mut raw_arcs,
                    sin_b[sa],
                    sin_b[sa + 1],
                    cos_b[sb] - tpi,
                    cos_b[sb + 1] - tpi,
                );
            }
        }
    }

    let merged = merge_intervals(&raw_arcs);
    let gaps = find_gaps(&merged);
    let mut free = Vec::new();
    let mut free_rad = 0.0;
    for g in gaps {
        let w = gap_width(g.start, g.end);
        if w <= 1e-9 {
            continue;
        }
        let s = norm_angle(g.start + ROT_SHIFT);
        free.push(Interval {
            start: s,
            end: s + w,
            width: w,
        });
        free_rad += w;
    }

    OcclusionResult {
        free_intervals: free,
        occluded_rad: tpi - free_rad,
    }
}

/// Mirror of JS `occlusionIntervals`.
///
/// `tank.rot` follows the game convention: forward vector is
/// `(sin(rot), -cos(rot))`.
pub fn occlusion_intervals(tank: &TankPose, bullets: &[Point]) -> OcclusionResult {
    let geo = exact_geom();
    let gx = tank.x + tank.rot.sin() * geo.geo_offset;
    let gy = tank.y - tank.rot.cos() * geo.geo_offset;

    let abs_r2 = geo.r_abs * geo.r_abs;
    let semi_r2 = geo.r_semi * geo.r_semi;
    let mut near = Vec::new();

    for b in bullets {
        let dx = b.x - gx;
        let dy = b.y - gy;
        let d2 = dx * dx + dy * dy;
        if d2 < abs_r2 {
            return OcclusionResult {
                free_intervals: Vec::new(),
                occluded_rad: TWO_PI,
            };
        }
        if d2 < semi_r2 {
            near.push(*b);
        }
    }

    if near.is_empty() {
        return OcclusionResult {
            free_intervals: vec![Interval {
                start: 0.0,
                end: TWO_PI,
                width: TWO_PI,
            }],
            occluded_rad: 0.0,
        };
    }

    exact_occlusion(gx, gy, &near)
}

// ---------------------------------------------------------------------------
// 3. Lane penalty (`lanePenaltyFrame`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct TrackFrame {
    pub x: f64,
    pub y: f64,
    pub alive: bool,
}

impl TrackFrame {
    pub fn new(x: f64, y: f64, alive: bool) -> Self {
        Self { x, y, alive }
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Threat {
    pub id: i64,
    pub track: Option<Vec<TrackFrame>>,
    pub path: Option<Vec<Point>>,
    pub speed: f64,
    pub anchor_offset: f64,
}

impl Threat {
    pub fn new(id: i64) -> Self {
        Self {
            id,
            track: None,
            path: None,
            speed: 0.0,
            anchor_offset: 0.0,
        }
    }

    pub fn with_path(mut self, path: Vec<Point>, speed: f64) -> Self {
        self.path = Some(path);
        self.speed = speed;
        self
    }

    pub fn with_track(mut self, track: Vec<TrackFrame>) -> Self {
        self.track = Some(track);
        self
    }

    pub fn with_anchor_offset(mut self, anchor_offset: f64) -> Self {
        self.anchor_offset = anchor_offset;
        self
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LanePerBullet {
    pub id: i64,
    pub chord: f64,
    pub d_min: f64,
    pub p: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LaneResult {
    pub penalty: f64,
    pub per_bullet: Vec<LanePerBullet>,
}

#[derive(Debug, Clone, Copy)]
struct BBox {
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
}

fn threat_lane_box(th: &Threat) -> Option<BBox> {
    let mut box_ = BBox {
        min_x: f64::INFINITY,
        max_x: f64::NEG_INFINITY,
        min_y: f64::INFINITY,
        max_y: f64::NEG_INFINITY,
    };
    let mut any = false;

    if let Some(track) = &th.track {
        if !track.is_empty() {
            for p in track {
                if !p.alive {
                    break;
                }
                box_.min_x = box_.min_x.min(p.x);
                box_.max_x = box_.max_x.max(p.x);
                box_.min_y = box_.min_y.min(p.y);
                box_.max_y = box_.max_y.max(p.y);
                any = true;
            }
            return if any { Some(box_) } else { None };
        }
    }

    if let Some(path) = &th.path {
        for p in path {
            box_.min_x = box_.min_x.min(p.x);
            box_.max_x = box_.max_x.max(p.x);
            box_.min_y = box_.min_y.min(p.y);
            box_.max_y = box_.max_y.max(p.y);
            any = true;
        }
    }

    if any {
        Some(box_)
    } else {
        None
    }
}

fn lane_clip(p_d: f64, q_d: f64, t_a: &mut f64, t_b: &mut f64, ok: &mut bool) {
    if p_d == 0.0 {
        if q_d < 0.0 {
            *ok = false;
        }
        return;
    }
    let r = q_d / p_d;
    if p_d < 0.0 {
        if r > *t_b {
            *ok = false;
            return;
        }
        if r > *t_a {
            *t_a = r;
        }
    } else {
        if r < *t_a {
            *ok = false;
            return;
        }
        if r < *t_b {
            *t_b = r;
        }
    }
}

/// Mirror of JS `lanePenaltyFrame`.
///
/// `lane_ratio` corresponds to `cfg.lanePenaltyRatio` in JS; the Rust API
/// passes it explicitly (JS default is 0.5, Rust callers pass 0 to disable).
pub fn lane_penalty_frame(
    tank: &TankPose,
    threats: &[Threat],
    t_sec: f64,
    lane_ratio: f64,
) -> LaneResult {
    let geo = exact_geom();
    let full_max = TWO_PI * TWO_PI;
    let cx = tank.x + tank.rot.sin() * geo.geo_offset;
    let cy = tank.y - tank.rot.cos() * geo.geo_offset;
    let sin_r = tank.rot.sin();
    let cos_r = tank.rot.cos();
    let hw = geo.effective_half_width;
    let hh = geo.effective_half_height;
    let skip_r2 = LANE_SKIP_RADIUS * LANE_SKIP_RADIUS;

    let mut penalty = 0.0f64;
    let mut per_bullet = Vec::new();

    for th in threats {
        let q = t_sec - th.anchor_offset;
        if q < 0.0 {
            continue;
        }

        let lane_box = match threat_lane_box(th) {
            Some(b) => b,
            None => continue,
        };

        let cbx = if lane_box.min_x > cx {
            lane_box.min_x - cx
        } else if lane_box.max_x < cx {
            lane_box.max_x - cx
        } else {
            0.0
        };
        let cby = if lane_box.min_y > cy {
            lane_box.min_y - cy
        } else if lane_box.max_y < cy {
            lane_box.max_y - cy
        } else {
            0.0
        };
        if cbx * cbx + cby * cby > skip_r2 {
            per_bullet.push(LanePerBullet {
                id: th.id,
                chord: 0.0,
                d_min: (cbx * cbx + cby * cby).sqrt(),
                p: 0.0,
            });
            continue;
        }

        let mut using_track = false;
        let pts: Option<Vec<Point>> = if let Some(track) = &th.track {
            if !track.is_empty() {
                using_track = true;
                let idx0 = ((q / TRACK_DT).round()).max(0.0) as usize;
                let stride = if track.len() > 96 { 4 } else { 1 };
                let mut pts = Vec::new();
                let mut i = idx0;
                while i < track.len() {
                    let sp = &track[i];
                    if !sp.alive {
                        break;
                    }
                    pts.push(Point { x: sp.x, y: sp.y });
                    i += stride;
                }
                if pts.len() >= 2 {
                    Some(pts)
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        let pts = match pts {
            Some(pts) => pts,
            None => {
                // JS: a present, non-empty track is authoritative. If its
                // queried future frames are exhausted (or only one is alive),
                // the bullet has no lane signal; do not fall back to path.
                if using_track {
                    continue;
                }
                // Fallback: polyline path + speed (JS v22 fallback).
                let path = match &th.path {
                    Some(p) => p,
                    None => continue,
                };
                if path.len() < 2 || th.speed <= 0.0 {
                    continue;
                }
                let s0 = th.speed * q;
                let mut pts = Vec::new();
                let mut cum = 0.0;
                for i in 0..path.len() - 1 {
                    let a = path[i];
                    let b = path[i + 1];
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
                    pts.push(Point {
                        x: a.x + (b.x - a.x) * f0,
                        y: a.y + (b.y - a.y) * f0,
                    });
                    pts.push(Point { x: b.x, y: b.y });
                    cum += seg_len;
                }
                if pts.len() < 2 {
                    continue;
                }
                pts
            }
        };

        let mut chord = 0.0;
        let mut d_min2 = f64::INFINITY;
        for i in 0..pts.len() - 1 {
            let p0 = pts[i];
            let p1 = pts[i + 1];
            let u0 = (p0.x - cx) * cos_r + (p0.y - cy) * sin_r;
            let v0 = (p0.x - cx) * sin_r - (p0.y - cy) * cos_r;
            let u1 = (p1.x - cx) * cos_r + (p1.y - cy) * sin_r;
            let v1 = (p1.x - cx) * sin_r - (p1.y - cy) * cos_r;

            let du = u1 - u0;
            let dv = v1 - v0;
            let l2 = du * du + dv * dv;
            let tt = if l2 > 0.0 {
                (-(u0 * du + v0 * dv) / l2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let cu = u0 + du * tt;
            let cv = v0 + dv * tt;
            d_min2 = d_min2.min(cu * cu + cv * cv);

            let mut t_a = 0.0;
            let mut t_b = 1.0;
            let mut ok = true;
            lane_clip(-du, u0 + hw, &mut t_a, &mut t_b, &mut ok);
            lane_clip(du, hw - u0, &mut t_a, &mut t_b, &mut ok);
            lane_clip(-dv, v0 + hh, &mut t_a, &mut t_b, &mut ok);
            lane_clip(dv, hh - v0, &mut t_a, &mut t_b, &mut ok);
            if ok && t_b > t_a {
                chord += l2.sqrt() * (t_b - t_a);
            }
        }

        if chord <= 1e-6 {
            per_bullet.push(LanePerBullet {
                id: th.id,
                chord: 0.0,
                d_min: d_min2.sqrt(),
                p: 0.0,
            });
            continue;
        }

        let d_min = d_min2.sqrt();
        let prox = (1.0 - d_min / geo.r_semi).max(0.0);
        let chord_frac = (chord / (2.0 * hh)).min(1.0);
        let p = lane_ratio * full_max * (0.5 * prox + 0.5 * chord_frac);
        if p > penalty {
            penalty = p;
        }
        per_bullet.push(LanePerBullet {
            id: th.id,
            chord,
            d_min,
            p,
        });
    }

    LaneResult {
        penalty,
        per_bullet,
    }
}

// ---------------------------------------------------------------------------
// 4. Spring rope (`springRopeLength` / `springRopeFrameScore`)
// ---------------------------------------------------------------------------

fn dist(a: Point, b: Point) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    (dx * dx + dy * dy).sqrt()
}

fn rect_f64(r: &Rect) -> (f64, f64, f64, f64) {
    (
        r.min_x as f64,
        r.min_y as f64,
        r.max_x as f64,
        r.max_y as f64,
    )
}

/// JS `segmentEntersRectInterior`: Liang-Barsky with open boundaries, so a
/// segment that only touches an edge or corner is considered clear.
fn segment_enters_rect_interior(a: Point, b: Point, r: &Rect) -> bool {
    let (min_x, min_y, max_x, max_y) = rect_f64(r);
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let mut t0 = 0.0;
    let mut t1 = 1.0;

    if dx.abs() < 1e-12 {
        if a.x <= min_x || a.x >= max_x {
            return false;
        }
    } else {
        let mut tx0 = (min_x - a.x) / dx;
        let mut tx1 = (max_x - a.x) / dx;
        if tx0 > tx1 {
            std::mem::swap(&mut tx0, &mut tx1);
        }
        if tx0 > t0 {
            t0 = tx0;
        }
        if tx1 < t1 {
            t1 = tx1;
        }
        if t0 >= t1 {
            return false;
        }
    }

    if dy.abs() < 1e-12 {
        if a.y <= min_y || a.y >= max_y {
            return false;
        }
    } else {
        let mut ty0 = (min_y - a.y) / dy;
        let mut ty1 = (max_y - a.y) / dy;
        if ty0 > ty1 {
            std::mem::swap(&mut ty0, &mut ty1);
        }
        if ty0 > t0 {
            t0 = ty0;
        }
        if ty1 < t1 {
            t1 = ty1;
        }
        if t0 >= t1 {
            return false;
        }
    }

    t0 < 1.0 && t1 > 0.0
}

fn segment_is_clear(a: Point, b: Point, rects: &[Rect]) -> bool {
    let min_x = a.x.min(b.x);
    let max_x = a.x.max(b.x);
    let min_y = a.y.min(b.y);
    let max_y = a.y.max(b.y);
    for r in rects {
        let (r_min_x, r_min_y, r_max_x, r_max_y) = rect_f64(r);
        if max_x <= r_min_x || min_x >= r_max_x || max_y <= r_min_y || min_y >= r_max_y {
            continue;
        }
        if segment_enters_rect_interior(a, b, r) {
            return false;
        }
    }
    true
}

fn key_point(p: Point) -> String {
    let x = if p.x == 0.0 { 0.0 } else { p.x };
    let y = if p.y == 0.0 { 0.0 } else { p.y };
    format!("{:.6},{:.6}", x, y)
}

fn add_candidate(points: &mut Vec<Point>, seen: &mut HashSet<String>, p: Point) -> bool {
    let key = key_point(p);
    if !seen.insert(key) {
        return false;
    }
    points.push(p);
    true
}

fn astar_spring_rope(rects: &[Rect], points: &[Point], goal: usize) -> f64 {
    let n = points.len();
    let mut g = vec![f64::INFINITY; n];
    let mut f = vec![f64::INFINITY; n];
    let mut closed = vec![false; n];
    let mut open: Vec<usize> = Vec::new();

    g[0] = 0.0;
    f[0] = dist(points[0], points[goal]);
    open.push(0);

    while !open.is_empty() {
        let mut best = 0usize;
        let mut best_f = f[open[0]];
        for (i, &oi) in open.iter().enumerate() {
            if f[oi] < best_f {
                best_f = f[oi];
                best = i;
            }
        }
        let cur = open.remove(best);
        if cur == goal {
            return g[goal];
        }
        if closed[cur] {
            continue;
        }
        closed[cur] = true;

        for j in 0..n {
            if j == cur || closed[j] {
                continue;
            }
            if !segment_is_clear(points[cur], points[j], rects) {
                continue;
            }
            let edge_len = dist(points[cur], points[j]);
            let g_new = g[cur] + edge_len;
            if g_new < g[j] {
                g[j] = g_new;
                f[j] = g_new + dist(points[j], points[goal]);
                open.push(j);
            }
        }
    }

    f64::INFINITY
}

/// Mirror of JS `springRopeLength` (with `rects` supplied by the caller).
///
/// `d_ref` is the corner filter radius (`cfg.springRopeDRef` / JS default 30).
pub fn spring_rope_length(rects: &[Rect], a: Point, b: Point, d_ref: f64) -> f64 {
    let euclid = dist(a, b);
    if rects.is_empty() {
        return euclid;
    }
    if segment_is_clear(a, b, rects) {
        return euclid;
    }

    let mut points = vec![a, b];
    let mut seen = HashSet::new();
    seen.insert(key_point(a));
    seen.insert(key_point(b));

    for r in rects {
        let (min_x, min_y, max_x, max_y) = rect_f64(r);
        for c in [
            Point { x: min_x, y: min_y },
            Point { x: max_x, y: min_y },
            Point { x: min_x, y: max_y },
            Point { x: max_x, y: max_y },
        ] {
            if dist(a, c) <= d_ref || dist(b, c) <= d_ref {
                add_candidate(&mut points, &mut seen, c);
            }
        }
    }

    astar_spring_rope(rects, &points, 1)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpringRopeConfig {
    pub d_near: f64,
    pub d_ref: f64,
    pub clearance_cap: f64,
}

impl Default for SpringRopeConfig {
    fn default() -> Self {
        Self {
            d_near: SPRING_ROPE_D_NEAR_DEFAULT,
            d_ref: SPRING_ROPE_D_REF_DEFAULT,
            clearance_cap: SPRING_ROPE_CLEARANCE_CAP_DEFAULT,
        }
    }
}

impl SpringRopeConfig {
    pub fn new(d_near: f64, d_ref: f64, clearance_cap: f64) -> Self {
        Self {
            d_near,
            d_ref,
            clearance_cap,
        }
    }
}

fn threat_bullet_pos(th: &Threat, t_sec: f64) -> Option<Point> {
    let q = t_sec - th.anchor_offset;
    if q < 0.0 {
        return None;
    }

    if let Some(track) = &th.track {
        if !track.is_empty() {
            let idx = (q / TRACK_DT).round();
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
            return Some(Point { x: s.x, y: s.y });
        }
    }

    let path = th.path.as_ref()?;
    if path.len() < 2 || th.speed <= 0.0 {
        return None;
    }

    // JS `adapter.bulletPosAt` total-length guard.
    let mut total_len = 0.0;
    for i in 0..path.len() - 1 {
        total_len += dist(path[i], path[i + 1]);
    }
    if q * th.speed > total_len + 0.05 {
        return None;
    }

    // JS `positionOnProjectilePath`.
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
            return Some(Point {
                x: a.x + dx * u,
                y: a.y + dy * u,
            });
        }
        elapsed += seg_time;
    }

    Some(Point {
        x: path[path.len() - 1].x,
        y: path[path.len() - 1].y,
    })
}

/// Mirror of JS `springRopeFrameScore` v28.
///
/// Returns a positive danger deduction (`clearance_cap * p`); callers subtract
/// it from the frame score.
pub fn spring_rope_frame_score(
    rects: &[Rect],
    tank: &TankPose,
    threats: &[Threat],
    t_sec: f64,
    cfg: &SpringRopeConfig,
) -> f64 {
    let mut product = 1.0;
    for th in threats {
        let pos = match threat_bullet_pos(th, t_sec) {
            Some(p) => p,
            None => continue,
        };
        let tank_pt = tank.point();
        if dist(tank_pt, pos) >= cfg.d_ref {
            continue;
        }
        let d = spring_rope_length(rects, tank_pt, pos, cfg.d_ref);
        let w = ((cfg.d_ref - d) / (cfg.d_ref - cfg.d_near)).clamp(0.0, 1.0);
        product *= 1.0 - w;
        if w >= 1.0 {
            return cfg.clearance_cap;
        }
    }
    cfg.clearance_cap * (1.0 - product)
}

// ---------------------------------------------------------------------------
// 5. Alive frame net score (`scoreFrameAlive`)
// ---------------------------------------------------------------------------

/// Module-level scoring parameters (kept separate from the JS tactics cfg).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScoringConfig {
    pub lane_penalty_ratio: f64,
    pub spring_rope: SpringRopeConfig,
}

impl Default for ScoringConfig {
    fn default() -> Self {
        Self {
            lane_penalty_ratio: 0.0,
            spring_rope: SpringRopeConfig::default(),
        }
    }
}

/// Mirror of the JS v28 alive-frame net formula:
/// `frameNet = fr.frameScore - lane.penalty - spring`.
///
/// `lane_penalty` and `spring_danger` are computed by the caller (they are
/// already positive deduction values). `cfg` is accepted for JS-signature
/// compatibility; the net formula itself is config-independent.
pub fn score_frame_alive(
    tank: &TankPose,
    bullet_points: &[Point],
    lane_penalty: f64,
    spring_danger: f64,
    _cfg: &ScoringConfig,
) -> f64 {
    let occ = occlusion_intervals(tank, bullet_points);
    let frame_score: f64 = occ
        .free_intervals
        .iter()
        .map(|iv| iv.width * iv.width)
        .sum();
    frame_score - lane_penalty - spring_danger
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_close(a: f64, b: f64, eps: f64) {
        assert!((a - b).abs() < eps, "expected {} to be close to {}", a, b);
    }

    fn tank_at_origin() -> TankPose {
        TankPose::new(0.0, 0.0, 0.0)
    }

    #[test]
    fn exact_geom_matches_js_defaults() {
        let g = exact_geom();
        assert_close(g.tank_half_width, 1.5, 1e-12);
        assert_close(g.tank_body_half_back, 2.0, 1e-12);
        assert_close(g.tank_half_forward, 2.75, 1e-12);
        assert_close(g.rect_half_height, 2.375, 1e-12);
        assert_close(g.effective_half_width, 1.75, 1e-12);
        assert_close(g.effective_half_height, 2.625, 1e-12);
        assert_close(g.r_abs, 1.75, 1e-12);
        assert_close(g.r_semi, 3.059025631780529, 1e-12);
        assert_close(g.geo_offset, 0.375, 1e-12);
    }

    #[test]
    fn no_bullets_full_free_circle() {
        let r = occlusion_intervals(&tank_at_origin(), &[]);
        assert_eq!(r.free_intervals.len(), 1);
        let iv = r.free_intervals[0];
        assert_close(iv.start, 0.0, 1e-12);
        assert_close(iv.end, TWO_PI, 1e-12);
        assert_close(iv.width, TWO_PI, 1e-12);
        assert_close(r.occluded_rad, 0.0, 1e-12);

        let cfg = ScoringConfig::default();
        let net = score_frame_alive(&tank_at_origin(), &[], 0.0, 0.0, &cfg);
        assert_close(net, TWO_PI * TWO_PI, 1e-12);
    }

    #[test]
    fn bullet_inside_r_abs_full_occlusion() {
        // rot=0 -> geometry centre is (0, -0.375). Bullet at (1, 0) is within
        // R_ABS of that centre.
        let r = occlusion_intervals(&tank_at_origin(), &[Point::new(1.0, 0.0)]);
        assert!(r.free_intervals.is_empty());
        assert_close(r.occluded_rad, TWO_PI, 1e-12);
    }

    #[test]
    fn bullet_outside_r_semi_free_circle() {
        let r = occlusion_intervals(&tank_at_origin(), &[Point::new(10.0, 0.0)]);
        assert_eq!(r.free_intervals.len(), 1);
        assert_close(r.free_intervals[0].width, TWO_PI, 1e-12);
        assert_close(r.occluded_rad, 0.0, 1e-12);
    }

    #[test]
    fn known_right_bullet_matches_js_copy_area_2() {
        // JS standard case: tank at origin rot=0, bullet at positive-right
        // 2.8 m. The JS v3.1 comment lists the four occluded-arc heading
        // rotations (57.7°/122.3°/237.7°/302.3°); here we compare the full
        // interval output produced by the JS function.
        let r = occlusion_intervals(&tank_at_origin(), &[Point::new(2.8, 0.0)]);
        assert_eq!(r.free_intervals.len(), 4);
        let expect = [
            (2.371998795773166, 4.177459166509715, 1.805460370736549),
            (4.466980844120595, 5.224069771752079, 0.757088927631484),
            (5.513591449362959, 7.319051820099508, 1.805460370736549),
            (1.325388190530802, 2.082477118162286, 0.757088927631484),
        ];
        for (iv, (s, e, w)) in r.free_intervals.iter().zip(expect.iter()) {
            assert_close(iv.start, *s, 1e-9);
            assert_close(iv.end, *e, 1e-9);
            assert_close(iv.width, *w, 1e-9);
        }
        let free_sum: f64 = r.free_intervals.iter().map(|iv| iv.width).sum();
        assert_close(free_sum, 5.125098596736066, 1e-9);
        assert_close(r.occluded_rad, 1.15808671044352, 1e-9);
        assert_close(r.occluded_rad, TWO_PI - free_sum, 1e-12);
    }

    #[test]
    fn lane_penalty_path_through_tank() {
        let tank = tank_at_origin();
        let threats = vec![
            Threat::new(1).with_path(vec![Point::new(0.0, -10.0), Point::new(0.0, 10.0)], 20.0)
        ];
        let r = lane_penalty_frame(&tank, &threats, 0.0, 0.5);
        assert_close(r.penalty, 19.739208802178716, 1e-9);
        assert_eq!(r.per_bullet.len(), 1);
        assert_eq!(r.per_bullet[0].id, 1);
        assert_close(r.per_bullet[0].chord, 5.25, 1e-9);
        assert_close(r.per_bullet[0].d_min, 0.0, 1e-9);
        assert_close(r.per_bullet[0].p, 19.739208802178716, 1e-9);
    }

    #[test]
    fn lane_penalty_far_track_zero() {
        let tank = tank_at_origin();
        let threats = vec![Threat::new(2).with_path(
            vec![Point::new(100.0, 100.0), Point::new(100.0, 120.0)],
            20.0,
        )];
        let r = lane_penalty_frame(&tank, &threats, 0.0, 0.5);
        assert_close(r.penalty, 0.0, 1e-12);
        assert_eq!(r.per_bullet.len(), 1);
        assert_close(r.per_bullet[0].chord, 0.0, 1e-12);
        assert_close(r.per_bullet[0].p, 0.0, 1e-12);
        assert_close(r.per_bullet[0].d_min, 141.68676940702684, 1e-6);
    }

    #[test]
    fn lane_penalty_multiple_threats_takes_max_not_sum() {
        let tank = tank_at_origin();
        let threats = vec![
            Threat::new(1).with_path(vec![Point::new(0.0, -10.0), Point::new(0.0, 10.0)], 20.0),
            Threat::new(2).with_path(vec![Point::new(0.0, -10.0), Point::new(0.0, 10.0)], 20.0),
        ];
        let r = lane_penalty_frame(&tank, &threats, 0.0, 0.5);
        let single = 19.739208802178716;
        assert_close(r.penalty, single, 1e-9);
        assert_close(r.penalty, r.per_bullet[0].p.max(r.per_bullet[1].p), 1e-12);
        assert!(r.penalty < 2.0 * single);
    }

    #[test]
    fn lane_penalty_track_uses_frame_index() {
        let tank = tank_at_origin();
        let track = vec![
            TrackFrame::new(0.0, -10.0, true),
            TrackFrame::new(0.0, 10.0, true),
        ];
        let threats = vec![Threat::new(3).with_track(track)];
        let r = lane_penalty_frame(&tank, &threats, 0.0, 0.5);
        assert_close(r.penalty, 19.739208802178716, 1e-9);
        assert_eq!(r.per_bullet.len(), 1);
        assert_close(r.per_bullet[0].chord, 5.25, 1e-9);
        assert_close(r.per_bullet[0].p, 19.739208802178716, 1e-9);
    }

    #[test]
    fn lane_penalty_ratio_zero_disables_penalty() {
        let tank = tank_at_origin();
        let threats = vec![
            Threat::new(1).with_path(vec![Point::new(0.0, -10.0), Point::new(0.0, 10.0)], 20.0)
        ];
        let r = lane_penalty_frame(&tank, &threats, 0.0, 0.0);
        assert_close(r.penalty, 0.0, 1e-12);
        assert_close(r.per_bullet[0].chord, 5.25, 1e-9);
        assert_close(r.per_bullet[0].p, 0.0, 1e-12);
    }

    #[test]
    fn spring_rope_no_wall_is_euclidean() {
        let a = Point::new(0.0, 0.0);
        let b = Point::new(3.0, 4.0);
        assert_close(spring_rope_length(&[], a, b, 30.0), 5.0, 1e-12);
    }

    #[test]
    fn spring_rope_vertical_wall_detours_and_matches_analytic() {
        // One vertical wall: x in [2,3], y in [-10,10]. The straight segment
        // enters it, so the shortest clear path goes around a corner.
        let rects = [Rect::new(2.0, -10.0, 3.0, 10.0)];
        let a = Point::new(0.0, 0.0);
        let b = Point::new(5.0, 0.0);
        let d = spring_rope_length(&rects, a, b, 30.0);
        let analytic = 2.0 * (104.0f64).sqrt() + 1.0; // ~21.39607805437114
        assert!(d > 5.0);
        assert_close(d, analytic, 1e-9);
    }

    #[test]
    fn spring_rope_zero_d_ref_filters_all_corners() {
        let rects = [Rect::new(2.0, -10.0, 3.0, 10.0)];
        let a = Point::new(0.0, 0.0);
        let b = Point::new(5.0, 0.0);
        assert!(spring_rope_length(&rects, a, b, 0.0).is_infinite());
    }

    #[test]
    fn spring_rope_frame_score_defaults_cap_when_w_is_one() {
        let tank = tank_at_origin();
        let threats =
            vec![Threat::new(1).with_path(vec![Point::new(1.0, 0.0), Point::new(1.0, 1.0)], 10.0)];
        let cfg = SpringRopeConfig::default();
        assert_close(
            spring_rope_frame_score(&[], &tank, &threats, 0.0, &cfg),
            8.0,
            1e-12,
        );
    }

    #[test]
    fn alive_net_score_subtracts_lane_and_spring() {
        let tank = tank_at_origin();
        let cfg = ScoringConfig::default();
        let net = score_frame_alive(&tank, &[], 2.5, 0.5, &cfg);
        assert_close(net, TWO_PI * TWO_PI - 3.0, 1e-12);
    }
}
