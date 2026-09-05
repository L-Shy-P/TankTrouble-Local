//! vantage_core: minimal, read-only Rust/WASM sidecar for Vantage dodge logic.
//!
//! Phase 1 contains only geometry/data helpers. It deliberately contains no NN
//! and no exact collision/death logic; death authority stays in the JS sandbox.

#![allow(clippy::missing_safety_doc)]

pub mod box2d;
pub mod minimal;
pub mod scoring;
pub mod tree;

/// Fixed ABI version.
#[no_mangle]
pub extern "C" fn vt_version() -> u32 {
    1
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
        assert_eq!(vt_version(), 1);
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
