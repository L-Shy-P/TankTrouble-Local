//! Minimal, decision-only bridge for the Vantage dodge tree.
//!
//! This module is intentionally much smaller than [`crate::tree`]: it takes
//! already-scored 75-frame rollouts, trims each candidate with exactly the
//! same `probeSegment` / `buildCandidate` / `pickBestChildByRolloutTotal`
//! pure-computation rules as JS v68, and returns the selected op index plus
//! the actual segment length to execute.
//!
//! No death decision is made here; `dead` / `death_frame` are supplied by the
//! caller and are only used for the same segment-trimming and candidate
//! ordering semantics as `buildCandidate`.

use crate::tree::{ProbeResult, EVAL_FRAMES};

/// Fixed C-ABI candidate count (the 9 Vantage operations).
pub const C_ABI_CANDIDATE_COUNT: usize = 9;
/// Fixed C-ABI per-candidate score length (same as [`EVAL_FRAMES`]).
pub const C_ABI_FRAMES: usize = EVAL_FRAMES;

/// Operation names in the same order as [`crate::tree::standard_operations`].
pub fn operation_name_for_index(index: usize) -> &'static str {
    const NAMES: [&str; C_ABI_CANDIDATE_COUNT] = [
        "静止", "前", "后", "左", "右", "前左", "前右", "后左", "后右",
    ];
    NAMES.get(index).copied().unwrap_or("?")
}

#[derive(Debug, Clone, PartialEq)]
pub struct CandidateInput {
    pub op_name: String,
    pub total_score: f64,
    pub dead: bool,
    pub death_frame: i64, // -1 = not dead
    pub per_frame_scores: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MinimalDecision {
    pub selected_index: usize,
    pub op_name: String,
    pub segment_frames: usize,
    pub candidates: Vec<MinimalCandidate>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MinimalCandidate {
    pub index: usize,
    pub op_name: String,
    pub planned_frames: usize,
    pub segment_frames: usize,
    pub segment_score: f64,
    pub rollout_total: f64,
    pub status: u8, // 0=alive, 1=dead
    pub full_death_frame: i64,
}

impl MinimalCandidate {
    fn is_dead(&self) -> bool {
        self.status == 1
    }
}

/// Equivalent of JS `probeSegment` / `tree::probe_segment_with_cfg`, but only
/// computes the fields needed for the minimal decision. It intentionally uses
/// the same first-divergence and `[tMin, tMax]` clamping rules.
fn probe_segment(
    candidates: &[CandidateInput],
    epsilon: f64,
    t_min: usize,
    t_max: usize,
) -> ProbeResult {
    let mut evaluated_frames = 0usize;
    for c in candidates {
        evaluated_frames = evaluated_frames.max(c.per_frame_scores.len());
    }

    if evaluated_frames == 0 {
        return ProbeResult {
            segment_frames: t_max,
            t_div: -1,
            t_div_found: false,
            spread_curve: Vec::new(),
            spread_peak: 0.0,
            evaluated_frames: 0,
            cum: None,
            epsilon,
            t_min,
            t_max,
        };
    }

    // Cumulative score rows, exactly like JS `probeSegment`.
    let mut cum: Vec<Vec<f64>> = Vec::with_capacity(candidates.len());
    for c in candidates {
        let mut row = vec![0.0; evaluated_frames + 1];
        for k in 1..=evaluated_frames {
            let prev = row[k - 1];
            row[k] = prev + c.per_frame_scores.get(k - 1).copied().unwrap_or(0.0);
        }
        cum.push(row);
    }

    let mut t_div = -1i32;
    let mut t_div_found = false;
    let mut spread_peak = 0.0f64;

    for k in 1..=evaluated_frames {
        let mut mx = f64::NEG_INFINITY;
        let mut mn = f64::INFINITY;
        for row in &cum {
            mx = mx.max(row[k]);
            mn = mn.min(row[k]);
        }
        let sp = mx - mn;
        if sp > spread_peak {
            spread_peak = sp;
        }
        if !t_div_found && sp > epsilon {
            t_div = k as i32;
            t_div_found = true;
        }
    }

    let seg_src = if t_div_found {
        t_div as usize
    } else {
        evaluated_frames
    };
    let segment_frames = seg_src.clamp(t_min, t_max);

    ProbeResult {
        segment_frames,
        t_div,
        t_div_found,
        spread_curve: Vec::new(),
        spread_peak,
        evaluated_frames,
        cum: Some(cum),
        epsilon,
        t_min,
        t_max,
    }
}

/// Build one trimmed candidate using exactly the JS `buildCandidate` death
/// semantics, except the segment score is computed directly as
/// `sum(per_frame_scores[0..actual])`.
fn build_candidate(
    input: &CandidateInput,
    index: usize,
    planned_frames: usize,
) -> MinimalCandidate {
    let mut actual_end = planned_frames;
    if input.dead {
        if input.death_frame == 1 {
            actual_end = 1;
        } else if input.death_frame >= 2 {
            // Saturating conversion keeps hostile i64 values panic-free.
            let fd_minus_one = usize::try_from(input.death_frame - 1).unwrap_or(usize::MAX);
            actual_end = fd_minus_one.min(planned_frames);
        }
    }

    let status =
        if input.dead && input.death_frame >= 0 && input.death_frame <= planned_frames as i64 {
            1u8
        } else {
            0u8
        };
    let full_death_frame = if input.dead { input.death_frame } else { -1 };

    let take = actual_end.min(input.per_frame_scores.len());
    let segment_score: f64 = input.per_frame_scores.iter().take(take).sum();

    MinimalCandidate {
        index,
        op_name: input.op_name.clone(),
        planned_frames,
        segment_frames: actual_end,
        segment_score,
        rollout_total: input.total_score,
        status,
        full_death_frame,
    }
}

/// Pick the best candidate using exactly the
/// `pickBestChildByRolloutTotal` rules:
/// - no invalid/exhausted candidates exist in this minimal module;
/// - when any candidate has `fullDeathFrame != 1`, candidates with
///   `fullDeathFrame == 1` are skipped;
/// - highest `rolloutTotal` wins;
/// - ties prefer alive over dead, then longer `segmentFrames` for dead,
///   then the smaller index.
fn pick_best(candidates: &[MinimalCandidate]) -> Option<usize> {
    let mut any_active = false;
    let mut all_true_dead = true;
    for c in candidates {
        any_active = true;
        if c.full_death_frame != 1 {
            all_true_dead = false;
            break;
        }
    }
    if !any_active {
        all_true_dead = false;
    }

    let mut best: Option<usize> = None;
    let mut best_total = f64::NEG_INFINITY;

    for (idx, c) in candidates.iter().enumerate() {
        if !all_true_dead && c.full_death_frame == 1 {
            continue;
        }
        let total = c.rollout_total;
        if best.is_none() || total > best_total {
            best = Some(idx);
            best_total = total;
            continue;
        }
        if total == best_total {
            let b_idx = best.unwrap();
            let b = &candidates[b_idx];
            let c_dead = c.is_dead();
            let b_dead = b.is_dead();
            if c_dead != b_dead {
                if !c_dead {
                    best = Some(idx);
                    best_total = total;
                }
                continue;
            }
            if c_dead && c.segment_frames > b.segment_frames {
                best = Some(idx);
                best_total = total;
                continue;
            }
            if idx < b_idx {
                best = Some(idx);
                best_total = total;
            }
        }
    }

    best
}

/// Minimal closed-loop decision:
///
/// 1. probe the segment length from all candidates;
/// 2. trim every candidate into planned/actual/segment score;
/// 3. pick the best candidate by rollout total.
///
/// Returns `None` when there are no candidates, or when the segment
/// configuration is invalid (`t_min > t_max`).
pub fn minimal_decide(
    candidates: &[CandidateInput],
    epsilon: f64,
    t_min: usize,
    t_max: usize,
) -> Option<MinimalDecision> {
    if candidates.is_empty() || t_min > t_max {
        return None;
    }

    let probe = probe_segment(candidates, epsilon, t_min, t_max);
    let planned_frames = probe.segment_frames;

    let built: Vec<MinimalCandidate> = candidates
        .iter()
        .enumerate()
        .map(|(i, c)| build_candidate(c, i, planned_frames))
        .collect();

    let selected_index = pick_best(&built)?;

    Some(MinimalDecision {
        selected_index,
        op_name: built[selected_index].op_name.clone(),
        segment_frames: built[selected_index].segment_frames,
        candidates: built,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(name: &str, total: f64, dead: bool, fd: i64, pfs: Vec<f64>) -> CandidateInput {
        CandidateInput {
            op_name: name.to_string(),
            total_score: total,
            dead,
            death_frame: fd,
            per_frame_scores: pfs,
        }
    }

    fn flat75(v: f64) -> Vec<f64> {
        vec![v; EVAL_FRAMES]
    }

    #[test]
    fn all_same_total_picks_index_zero() {
        let candidates: Vec<CandidateInput> = (0..9)
            .map(|i| {
                let name = if i == 0 { "静止" } else { "前" };
                cand(name, 100.0, false, -1, flat75(1.0))
            })
            .collect();
        let d = minimal_decide(&candidates, 9.869604401089358, 3, 30).unwrap();
        assert_eq!(d.selected_index, 0);
        assert_eq!(d.op_name, "静止");
        assert_eq!(d.segment_frames, 30);
        assert_eq!(d.candidates.len(), 9);
        assert_eq!(d.candidates[0].planned_frames, 30);
        assert_eq!(d.candidates[0].segment_frames, 30);
        assert_eq!(d.candidates[0].status, 0);
    }

    #[test]
    fn higher_total_picks_forward() {
        let mut candidates: Vec<CandidateInput> = (0..9)
            .map(|i| {
                cand(
                    if i == 0 { "静止" } else { "前" },
                    100.0,
                    false,
                    -1,
                    flat75(0.0),
                )
            })
            .collect();
        candidates[1].total_score = 200.0;
        let d = minimal_decide(&candidates, 9.869604401089358, 3, 30).unwrap();
        assert_eq!(d.selected_index, 1);
        assert_eq!(d.op_name, "前");
    }

    #[test]
    fn skips_fd1_when_non_fd1_exists() {
        let candidates = vec![
            cand("静止", 999.0, true, 1, flat75(1.0)),
            cand("前", 100.0, false, -1, flat75(1.0)),
        ];
        let d = minimal_decide(&candidates, 9.869604401089358, 3, 30).unwrap();
        assert_eq!(d.selected_index, 1);
        assert_eq!(d.op_name, "前");
    }

    #[test]
    fn fd5_with_planned_30_gives_segment_4_and_dead_status() {
        let candidates = vec![cand("前", 100.0, true, 5, flat75(1.0))];
        let d = minimal_decide(&candidates, 9.869604401089358, 3, 30).unwrap();
        assert_eq!(d.selected_index, 0);
        assert_eq!(d.segment_frames, 4);
        assert_eq!(d.candidates[0].planned_frames, 30);
        assert_eq!(d.candidates[0].segment_frames, 4);
        assert_eq!(d.candidates[0].status, 1);
        assert_eq!(d.candidates[0].full_death_frame, 5);
        assert_eq!(d.candidates[0].segment_score, 4.0);
    }

    #[test]
    fn alive_high_total_beats_dead_low_total() {
        let candidates = vec![
            cand("静止", 50.0, true, 5, flat75(1.0)),
            cand("前", 100.0, false, -1, flat75(1.0)),
        ];
        let d = minimal_decide(&candidates, 9.869604401089358, 3, 30).unwrap();
        assert_eq!(d.selected_index, 1);
        assert_eq!(d.op_name, "前");
        assert_eq!(d.candidates[0].status, 1);
        assert_eq!(d.candidates[1].status, 0);
    }

    #[test]
    fn empty_input_returns_none() {
        assert!(minimal_decide(&[], 9.869604401089358, 3, 30).is_none());
    }

    #[test]
    fn invalid_t_range_returns_none() {
        let candidates = vec![cand("静止", 100.0, false, -1, flat75(1.0))];
        assert!(minimal_decide(&candidates, 9.869604401089358, 30, 3).is_none());
    }
}
