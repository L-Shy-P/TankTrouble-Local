/**
 * 我们的 gameView：把**我们游戏**的迷宫，翻译成 Killfield 的 field.js 需要的样子。
 * ---------------------------------------------------------------------------
 * field.js 只读这几样（见 InverseDensityFieldBuilder 构造函数）：
 *   game.scale      一格的世界尺寸（我们的 MAZE_TILE_SIZE.m = 10）
 *   game.wallHalfT  墙的半厚（我们的墙就是整格方块 → 0）
 *   game.walls      [[x1,y1,x2,y2], ...] 墙的 AABB（世界坐标）
 *   game.reachable  [{x,y}, ...] 可走格
 *   game.maze       二维数组（field.js 只用它的长宽）
 *   game.wallHit(x,y) 某点是否在墙里（他们用来剔除落在墙内的采样点）
 *
 * 我们的迷宫接口（和 vantage_tree 里杀戮场用的是同一套）：
 *   maze.getWidth() / maze.getHeight() / maze.isPositionInsideMaze({x,y})
 * 其中 isPositionInsideMaze(tile) 为真 = 该格可走；墙 = 整格不可走。
 */
'use strict';

import { units } from './constants.js';

/**
 * 从我们的迷宫构造 field.js 需要的视图。
 * @param {Object} maze 我们的迷宫（getWidth/getHeight/isPositionInsideMaze）
 * @param {Object} opt  { tileM } 覆盖格子尺寸（默认取常量表）
 */
export function buildGameView(maze, opt) {
    opt = opt || {};
    const tileM = opt.tileM || units().TILE_M;
    const w = maze.getWidth();
    const h = maze.getHeight();

    const walkable = (x, y) => {
        if (x < 0 || y < 0 || x >= w || y >= h) return false;
        return !!maze.isPositionInsideMaze({ x: x, y: y });
    };

    // 墙 = 不可走的整格 → 转成 AABB（世界坐标）
    const walls = [];
    const reachable = [];
    const grid = [];
    for (let x = 0; x < w; x++) {
        grid[x] = [];
        for (let y = 0; y < h; y++) {
            const open = walkable(x, y);
            grid[x][y] = open ? 1 : 0;
            if (open) {
                reachable.push({ x: x, y: y });
            } else {
                walls.push([x * tileM, y * tileM, (x + 1) * tileM, (y + 1) * tileM]);
            }
        }
    }

    return {
        scale: tileM,
        wallHalfT: 0,
        walls: walls,
        reachable: reachable,
        maze: grid,
        /** 某点是否落在墙里（墙是整格方块，直接看落在哪一格）。 */
        wallHit: function (x, y) {
            const cx = Math.floor(x / tileM), cy = Math.floor(y / tileM);
            if (cx < 0 || cy < 0 || cx >= w || cy >= h) return true;   // 界外当墙
            return !walkable(cx, cy);
        },
        /**
         * field.js 的 guidanceEnvelope 需要它：从某格出发的 BFS 距离，
         * 返回二维数组 distances[cellX][cellY]（不可达 = null）。
         * 他们的接口是 distMap(x, y) —— 注意是**两参数**、二维数组。
         */
        distMap: function (fx, fy) {
            const dist = new Array(w);
            for (let x = 0; x < w; x++) {
                dist[x] = new Array(h).fill(null);
            }
            if (!walkable(fx, fy)) return dist;
            dist[fx][fy] = 0;
            const queue = [[fx, fy]];
            let head = 0;
            while (head < queue.length) {
                const cur = queue[head++];
                const d = dist[cur[0]][cur[1]];
                const nb = [[cur[0], cur[1] - 1], [cur[0] + 1, cur[1]], [cur[0], cur[1] + 1], [cur[0] - 1, cur[1]]];
                for (let i = 0; i < 4; i++) {
                    const nx = nb[i][0], ny = nb[i][1];
                    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                    if (!walkable(nx, ny)) continue;
                    if (dist[nx][ny] !== null) continue;
                    dist[nx][ny] = d + 1;
                    queue.push([nx, ny]);
                }
            }
            return dist;
        },

        /** 便捷：世界坐标 → 格坐标 */
        cellOf: function (x, y) {
            return [Math.floor(x / tileM), Math.floor(y / tileM)];
        },
        width: w,
        height: h
    };
}

export default { buildGameView: buildGameView };

/**
 * 给 risk.js / score.js 用的"战场视图"。
 * 口径换算（很重要）：
 *   · 我们的弹速是**米/秒**，他们的算法要**米/帧** → 乘 dt；
 *   · 剩余寿命同理折算成**帧**；
 *   · 坦克位置/朝向直接用世界坐标（我们的 y 朝下没关系：风险与弹道都是几何量，
 *     只要墙盒和坐标在同一套系里就自洽；field.js 只在"格"层面工作）。
 * @param {Object} st {me:{x,y,rot,alive}, enemy:{...}, bullets:[{x,y,vx,vy,lifeLeft,removed}], scale, dt}
 */
export function buildCombatView(st) {
    const dt = st.dt || 0.02;
    const mk = (t) => (t ? { x: t.x, y: t.y, rotation: t.rot, alive: t.alive !== false } : null);
    return {
        scale: st.scale,
        tanks: [mk(st.me), mk(st.enemy)],
        bullets: (st.bullets || []).map((b) => ({
            x: b.x,
            y: b.y,
            xSpeed: (b.vx || 0) * dt,
            ySpeed: (b.vy || 0) * dt,
            lifetime: (b.lifeLeft === undefined ? 3 : b.lifeLeft) / dt,
            removed: !!b.removed
        }))
    };
}

/** 从我们的 gameController 抓一份战场快照（引擎相关的一小段，集中在这里）。 */
export function snapshotFromGameController(gc, myId, opt) {
    opt = opt || {};
    const dt = opt.dt || 0.02;
    const tanks = gc.getTanks ? gc.getTanks() : {};
    const me = gc.getTank ? gc.getTank(myId) : null;
    let enemy = null;
    for (const pid in tanks) {
        if (!tanks.hasOwnProperty(pid)) continue;
        if (String(pid) === String(myId)) continue;
        enemy = tanks[pid];
        break;
    }
    const one = (t) => {
        if (!t) return null;
        const v = { x: t.getX(), y: t.getY(), rot: t.getRotation(), alive: true };
        try {
            const body = t.getB2DBody ? t.getB2DBody() : null;
            if (body && body.GetLinearVelocity) {
                const lv = body.GetLinearVelocity();
                v.vx = lv.x; v.vy = lv.y;
            }
        } catch (e) {}
        return v;
    };
    const bullets = [];
    const list = gc.getProjectiles ? gc.getProjectiles() : {};
    for (const id in list) {
        if (!list.hasOwnProperty(id)) continue;
        const p = list[id];
        if (!p) continue;
        let done = false;
        try { done = !!(p.done && p.done()); } catch (e2) {}
        if (done) continue;
        let left = 3;
        try {
            const life = p.lifetime, alive = p.getTimeAlive ? p.getTimeAlive() : p.timeAlive;
            if (typeof life === 'number' && typeof alive === 'number') left = Math.max(0, life - alive);
        } catch (e3) {}
        bullets.push({
            x: p.getX(), y: p.getY(),
            vx: p.getSpeedX ? p.getSpeedX() : 0,
            vy: p.getSpeedY ? p.getSpeedY() : 0,
            lifeLeft: left
        });
    }
    return {
        me: one(me),
        enemy: one(enemy),
        bullets: bullets,
        scale: opt.tileM || units().TILE_M,
        dt: dt
    };
}

/**
 * 按**融合世界的墙多边形**建视图（首选；和 V 用的是同一份墙）。
 * 我们的墙不是"整格"，而是"格与格之间的薄矩形"——所以必须用真实几何，
 * 否则 AI 眼里的地图是空的（主人实测：K 乱开枪、抽搐，就是这个原因）。
 * @param {Array} wallShapes [{verts:[{x,y},...]}, ...]
 * @param {Object} maze 我们的迷宫（只用来算可达格与 BFS）
 * @param {Object} opt {tileM}
 */
export function buildGameViewFromWallShapes(wallShapes, maze, opt) {
    opt = opt || {};
    const tileM = opt.tileM || units().TILE_M;
    const div = opt.unitDivisor || 1;          // 万一墙几何和我们的米制不一致（像素系 = 20），用它对齐
    const w = maze.getWidth(), h = maze.getHeight();
    const walkable = (x, y) => {
        if (x < 0 || y < 0 || x >= w || y >= h) return false;
        try { return !!maze.isPositionInsideMaze({ x: x, y: y }); } catch (e) { return false; }
    };
    const boxes = [];
    for (let i = 0; i < (wallShapes || []).length; i++) {
        const sh = wallShapes[i];
        const verts = sh && sh.verts;
        if (!verts || !verts.length) continue;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let k = 0; k < verts.length; k++) {
            const v = verts[k];
            if (!v) continue;
            if (v.x < minX) minX = v.x;
            if (v.x > maxX) maxX = v.x;
            if (v.y < minY) minY = v.y;
            if (v.y > maxY) maxY = v.y;
        }
        if (isFinite(minX) && isFinite(maxX) && isFinite(minY) && isFinite(maxY)) {
            boxes.push([minX / div, minY / div, maxX / div, maxY / div]);
        }
    }
    return makeView(boxes, maze, tileM, w, h, walkable);
}

/** 视图的公共部分（墙盒 + 可达格 + BFS + wallHit），两种建法共用。 */
function makeView(boxes, maze, tileM, w, h, walkable, adj) {
    const reachable = [];
    const grid = [];
    for (let x = 0; x < w; x++) {
        grid[x] = [];
        for (let y = 0; y < h; y++) {
            const open = walkable(x, y);
            grid[x][y] = open ? 1 : 0;
            if (open) reachable.push({ x: x, y: y });
        }
    }
    function inBox(px, py, b) {
        return px >= b[0] && px <= b[2] && py >= b[1] && py <= b[3];
    }
    // 空间索引：墙盒按"覆盖到的格子"登记，wallHit 只查该格 → 大图上不会退化成
    // "每点遍历全部墙盒"（原来的写法在 40x30 图上每次建场要几千万次盒测试）。
    const cellBoxes = {};
    for (let bi = 0; bi < boxes.length; bi++) {
        const b = boxes[bi];
        const x0 = Math.floor(b[0] / tileM), x1 = Math.floor(b[2] / tileM);
        const y0 = Math.floor(b[1] / tileM), y1 = Math.floor(b[3] / tileM);
        for (let cx = x0; cx <= x1; cx++) {
            for (let cy = y0; cy <= y1; cy++) {
                const key = cx + ',' + cy;
                (cellBoxes[key] || (cellBoxes[key] = [])).push(b);
            }
        }
    }
    return {
        scale: tileM,
        wallHalfT: 0,
        walls: boxes,
        reachable: reachable,
        maze: grid,
        wallHit: function (x, y) {
            const list = cellBoxes[Math.floor(x / tileM) + ',' + Math.floor(y / tileM)];
            if (!list) return false;
            for (let i = 0; i < list.length; i++) if (inBox(x, y, list[i])) return true;
            return false;
        },
        distMap: function (fx, fy) {
            const dist = new Array(w);
            for (let x = 0; x < w; x++) dist[x] = new Array(h).fill(null);
            if (!walkable(fx, fy)) return dist;
            dist[fx][fy] = 0;
            const queue = [[fx, fy]];
            let head = 0;
            while (head < queue.length) {
                const cur = queue[head++];
                const d = dist[cur[0]][cur[1]];
                const nb = [[cur[0], cur[1] - 1], [cur[0] + 1, cur[1]], [cur[0], cur[1] + 1], [cur[0] - 1, cur[1]]];
                for (let i = 0; i < 4; i++) {
                    const nx = nb[i][0], ny = nb[i][1];
                    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                    // **权威邻接**：相邻两格能不能走，由墙标志决定（和游戏自身 BFS 同一套规则）；
                    // 没有 adj 时才退化成"只看格子可走"（旧行为）。
                    if (!walkable(nx, ny) || dist[nx][ny] !== null) continue;
                    if (adj && !adj(cur[0], cur[1], nx, ny)) continue;
                    dist[nx][ny] = d + 1;
                    queue.push([nx, ny]);
                }
            }
            return dist;
        },
        cellOf: function (x, y) { return [Math.floor(x / tileM), Math.floor(y / tileM)]; },
        /** 权威邻接判断（有墙标志时为真规则）。 */
        canGo: adj ? function (x, y, nx, ny) {
            if (!walkable(nx, ny)) return false;
            return !!adj(x, y, nx, ny);
        } : function (x, y, nx, ny) { return !!walkable(nx, ny); },
        width: w,
        height: h
    };
}

/**
 * 权威墙几何：**直接从迷宫的 tile 标志建墙**。
 * ---------------------------------------------------------------------------
 * 这个游戏（含物理引擎 B2DUtils.createMaze）的墙是"格与格之间的薄矩形"，
 * 由 tile 标志描述：`tiles[i][j][1]===1` → 该格**上边**有墙（水平），
 * `tiles[i][j][2]===1` → 该格**左边**有墙（垂直）。物理引擎就是这么建墙的。
 * 所以这里也这么建 —— 不再依赖融合世界、不再需要猜单位（像素/米），
 * 也不会受"坦克 body 还没建好"的影响（K 开局撞墙的根因之一）。
 * 厚度用 `Constants.MAZE_WALL_WIDTH.m`。
 */
export function buildGameViewFromTiles(maze, opt) {
    opt = opt || {};
    const tileM = opt.tileM || units().TILE_M;
    const wallW = (opt.wallWidth && opt.wallWidth > 0) ? opt.wallWidth : 0.8;
    const half = wallW / 2;
    const tiles = (maze && typeof maze.getTiles === 'function') ? maze.getTiles() : null;
    if (!tiles || !tiles.length || !tiles[0]) return null;
    const w = tiles.length, h = tiles[0].length;

    // `tiles[x][y][0] === 1` = **这一格存在**（游戏 _createGraph 就是这么判的）。
    // 拿不到标志时退化成 isPositionInsideMaze（两者等价，但前者更直接）。
    const tileExists = (x, y) => {
        if (x < 0 || y < 0 || x >= w || y >= h) return false;
        const c = tiles[x][y];
        if (c && (c[0] === 0 || c[0] === 1)) return c[0] === 1;
        try { return !!maze.isPositionInsideMaze({ x: x, y: y }); } catch (e) { return false; }
    };
    const walkable = tileExists;

    // **权威邻接**（逐字对应游戏 Maze._traverseCloseTiles / _createGraph）：
    //   左 (x-1,y): tiles[x][y][2]   == 0
    //   右 (x+1,y): tiles[x+1][y][2] == 0
    //   上 (x,y-1): tiles[x][y][1]   == 0
    //   下 (x,y+1): tiles[x][y+1][1] == 0
    // ★ K 之前只按 isPositionInsideMaze 建图、从不看墙标志 → 会径直穿墙（开局撞墙的根因）。
    const adj = (x, y, nx, ny) => {
        if (nx === x - 1 && ny === y) { const c = tiles[x][y]; return !!c && c[2] === 0; }
        if (nx === x + 1 && ny === y) { const c = tiles[x + 1] && tiles[x + 1][y]; return !!c && c[2] === 0; }
        if (nx === x && ny === y - 1) { const c = tiles[x][y]; return !!c && c[1] === 0; }
        if (nx === x && ny === y + 1) { const c = tiles[x][y + 1]; return !!c && c[1] === 0; }
        return false;
    };

    const boxes = [];
    for (let i = 0; i < w; i++) {
        for (let j = 0; j < h; j++) {
            const cell = tiles[i][j];
            if (!cell) continue;
            // 上边墙：[i*tile - half, j*tile - half] ~ [(i+1)*tile + half, j*tile + half]
            if (cell[1] === 1) {
                boxes.push([i * tileM - half, j * tileM - half, (i + 1) * tileM + half, j * tileM + half]);
            }
            // 左边墙：[i*tile - half, j*tile - half] ~ [i*tile + half, (j+1)*tile + half]
            if (cell[2] === 1) {
                boxes.push([i * tileM - half, j * tileM - half, i * tileM + half, (j + 1) * tileM + half]);
            }
        }
    }
    // 外边界兜底（保证关得住；即使 tile 标志有缺漏也不会跑出去）
    const W = w * tileM, H = h * tileM;
    boxes.push([-half, -half, W + half, half]);            // 上
    boxes.push([-half, H - half, W + half, H + half]);     // 下
    boxes.push([-half, -half, half, H + half]);            // 左
    boxes.push([W - half, -half, W + half, H + half]);     // 右

    const view = makeView(boxes, maze, tileM, w, h, walkable, adj);
    view.source = 'tiles';
    view.tiles = tiles;
    view.tileCount = w * h;
    view.wallCells = boxes.length;
    return view;
}
