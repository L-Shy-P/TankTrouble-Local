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
