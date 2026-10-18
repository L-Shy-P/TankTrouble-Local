//! v12（1-2④）：追踪导弹用的迷宫表（"下一格表" + 4 连通 BFS 距离）。
//!
//! 设计依据（2026-10-12 批准，见 `docs/.../1-2④施工-第3轮-2026-10-12.md` §一；
//!   该文档原名 `1-2④施工-第3轮-2026-10-13.md`，2026-10-12 日期校正时改名）：
//!   · **不在 Rust 里复刻 jKstra 的双向 Dijkstra**（`HomingMissile.update` 的瞄准点走
//!     `maze.getShortestPathWithGraph()[0]`，而那是 out/in 迭代器轮流推进的双向搜索，
//!     **平局走哪条路是实现细节**）⟹ 由 JS 用**游戏自己的 API** 整表预计算后一次性传进来。
//!   · Rust 只做两件**无平局歧义**的事：① 查表得"下一格"；② 4 连通 BFS 算距离
//!     （`maze.getDistancesFromPosition/getDistanceToPosition` 的口径 = `_traverseCloseTiles`）。
//!   · 表按 `maze_id` 缓存：id 变了就重建（= maze 变更的失效机制）。
//!
//! flags 每格 1 字节（与 JS `VantageSandbox.buildNextTileTable` 约定）：
//!   bit0 = reachable（`maze.getDistancesFromPosition({x,y}) !== false`）
//!   bit1 = left wall（`tiles[x][y][2]`）   bit2 = top wall（`tiles[x][y][1]`）
//!   bit3 = floor（`tiles[x][y][0]`，给图顶点集合用；本模块的 BFS 不用它）
//! next_tile：`w*h*w*h`，下标 `fromIdx*(w*h)+toIdx`，值 = 下一格下标；`NO_TILE` = 不可算
//!   （不可达格 / 4 连通距离 ≤1 ⟹ 真游戏走 tank-exact 分支、根本不查最短路）。

pub const NO_TILE: u8 = 255;
const FLAG_REACHABLE: u8 = 1;
const FLAG_LEFT_WALL: u8 = 2;
const FLAG_TOP_WALL: u8 = 4;

#[derive(Clone, Default)]
pub struct MazeTable {
    pub id: u32,
    pub w: usize,
    pub h: usize,
    pub flags: Vec<u8>,
    pub next_tile: Vec<u8>,
    pub ready: bool,
}

impl MazeTable {
    #[inline]
    pub fn inside(&self, x: i32, y: i32) -> bool {
        x >= 0 && y >= 0 && (x as usize) < self.w && (y as usize) < self.h
    }
    #[inline]
    pub fn reachable(&self, x: i32, y: i32) -> bool {
        self.inside(x, y) && (self.flags[y as usize * self.w + x as usize] & FLAG_REACHABLE) != 0
    }
    /// 真游戏 `tiles[x][y][2] == 0`：左墙不存在 ⟹ 可以向左走。
    #[inline]
    pub fn left_open(&self, x: i32, y: i32) -> bool {
        self.inside(x, y) && (self.flags[y as usize * self.w + x as usize] & FLAG_LEFT_WALL) == 0
    }
    /// 真游戏 `tiles[x][y][1] == 0`：上墙不存在 ⟹ 可以向上走。
    #[inline]
    pub fn top_open(&self, x: i32, y: i32) -> bool {
        self.inside(x, y) && (self.flags[y as usize * self.w + x as usize] & FLAG_TOP_WALL) == 0
    }
    /// 世界坐标 → 格（与 `HomingMissile.update` 的 `Math.floor(x/TILE)` 同口径）。
    #[inline]
    pub fn tile_of(&self, x: f64, y: f64, tile_m: f64) -> (i32, i32) {
        ((x / tile_m).floor() as i32, (y / tile_m).floor() as i32)
    }
    /// 4 连通 BFS 距离（与 JS `getDistancesFromPosition` + `getDistanceToPosition` 同口径）。
    /// 起点或终点不是 reachable 格 → `-1`（= JS 的 `false`）。
    pub fn bfs4(&self, sx: i32, sy: i32, tx: i32, ty: i32) -> i32 {
        if !self.reachable(sx, sy) || !self.reachable(tx, ty) {
            return -1;
        }
        if sx == tx && sy == ty {
            return 0;
        }
        let n = self.w * self.h;
        let mut dist = vec![i32::MAX; n];
        let mut queue: std::collections::VecDeque<(i32, i32)> = std::collections::VecDeque::new();
        dist[sy as usize * self.w + sx as usize] = 0;
        queue.push_back((sx, sy));
        while let Some((cx, cy)) = queue.pop_front() {
            let d = dist[cy as usize * self.w + cx as usize];
            if cx == tx && cy == ty {
                return d;
            }
            // 四个方向 —— 与 `_createGraph` / `_traverseCloseTiles` 同一套墙条件。
            let mut try_push = |nx: i32, ny: i32, q: &mut std::collections::VecDeque<(i32, i32)>| {
                let idx = ny as usize * self.w + nx as usize;
                if dist[idx] == i32::MAX {
                    dist[idx] = d + 1;
                    q.push_back((nx, ny));
                }
            };
            if cx > 0 && self.left_open(cx, cy) { try_push(cx - 1, cy, &mut queue); }
            if (cx as usize) < self.w - 1 && self.left_open(cx + 1, cy) { try_push(cx + 1, cy, &mut queue); }
            if cy > 0 && self.top_open(cx, cy) { try_push(cx, cy - 1, &mut queue); }
            if (cy as usize) < self.h - 1 && self.top_open(cx, cy + 1) { try_push(cx, cy + 1, &mut queue); }
        }
        -1
    }
    /// 查「下一格」表（`from → to`）。返回 `None` = 该格对在真游戏里**不查最短路**
    /// （不可达 / 距离 ≤1 / 表未覆盖）⟹ 调用方要走 `tank-exact` 分支或直接跳过。
    pub fn next_tile(&self, fx: i32, fy: i32, tx: i32, ty: i32) -> Option<(i32, i32)> {
        if !self.inside(fx, fy) || !self.inside(tx, ty) {
            return None;
        }
        let n = self.w * self.h;
        let fi = fy as usize * self.w + fx as usize;
        let ti = ty as usize * self.w + tx as usize;
        let v = *self.next_tile.get(fi * n + ti)?;
        if v == NO_TILE {
            return None;
        }
        let v = v as usize;
        if v >= n {
            return None;
        }
        Some(((v % self.w) as i32, (v / self.w) as i32))
    }
}

static MAZE: std::sync::OnceLock<std::sync::Mutex<MazeTable>> = std::sync::OnceLock::new();

fn cell() -> &'static std::sync::Mutex<MazeTable> {
    MAZE.get_or_init(|| std::sync::Mutex::new(MazeTable::default()))
}

/// `vt_set_maze` 的实现：整表替换（id 变了就重建 = 失效机制）。
pub fn set_maze(id: u32, w: usize, h: usize, flags: Vec<u8>, next_tile: Vec<u8>) -> bool {
    if w == 0 || h == 0 || w * h > 4096 {
        return false;
    }
    if flags.len() != w * h || next_tile.len() != w * h * w * h {
        return false;
    }
    let mut g = match cell().lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    g.id = id;
    g.w = w;
    g.h = h;
    g.flags = flags;
    g.next_tile = next_tile;
    g.ready = true;
    true
}

/// 只读访问缓存表（未设置时返回 None）。
pub fn with_maze<R>(f: impl FnOnce(&MazeTable) -> R) -> Option<R> {
    let g = match cell().lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    if !g.ready {
        return None;
    }
    Some(f(&g))
}

pub fn maze_id() -> u32 {
    with_maze(|m| m.id).unwrap_or(0)
}
