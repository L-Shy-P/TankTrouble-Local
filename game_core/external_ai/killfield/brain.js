/**
 * 粗版 Killfield 大脑（B 方案：先上车，再补 MPC）
 * ---------------------------------------------------------------------------
 * 三件事（正好是 Killfield 的三根支柱，先不带上层的 MPC 前瞻）：
 *   ① 走位：用「逆杀戮场」（field.js）看**哪些格子能打到对手**，往更好的射击位走；
 *   ② 开火：用密度场给出的「从我这格该朝哪个角度打」+ 我现在朝向的误差 → 对准了就开火；
 *   ③ 躲弹：用 risk.js 的反射几何 + 我们自己批量模拟出来的候选轨迹 → 挑最不容易挨打的走法。
 *
 * 轨迹不是估算出来的：直接用页面里现成的适配器批量模拟（Rust 优先、JS 兜底），
 * 所以候选走的是**我们真实的物理**。
 *
 * 上层 MPC（18 个计划、开火后延续、弹药/机动/自杀等权重）留到下一步补。
 */
'use strict';

import * as C from './constants.js';
import { buildGameView, buildGameViewFromWallShapes, buildCombatView, snapshotFromGameController } from './gameView.js';
import { InverseDensityFieldBuilder } from './field.js';
import { reflectiveClosest, incomingRisk } from './risk.js';

const HORIZON_FRAMES = 30;        // 有子弹时的前瞻：0.6 秒（0.24 秒只侧移 1 米，躲不出 1.6 米挨打半径）
const HORIZON_IDLE = 12;          // 场上没子弹时只用 12 帧：大势是赶路，省一半批量模拟开销
const FIELD_RAYS = 512;           // 逆杀戮场的射线数（JS 版性能决定，见方案文档）
const HIT_RADIUS_M = 1.6;         // 我们的有效挨打半径（车半宽 1.5 + 子弹半径 0.25，取保守值）
const AIM_TOLERANCE = 7 * Math.PI / 180;   // 朝向误差小于这个就认为"对准了"
const FIRE_COOLDOWN_FRAMES = 10;  // 开火冷却（我们的枪有弹药/射速限制，别浪费）
const STUCK_FRAMES = 6;           // 连续这么多帧几乎没位移 → 换转向

/** 9 个候选移动（顺序 = 油门×3+转向，与 Killfield/外接动作表一致）。 */
function candidateOps() {
    var ops = [];
    for (var m = 0; m < 9; m++) {
        var throttle = Math.floor(m / 3), turn = m % 3;
        ops.push({
            name: 'kf' + m, movement: m, throttle: throttle, turn: turn,
            inputs: { forward: throttle === 2, back: throttle === 0, left: turn === 0, right: turn === 2 }
        });
    }
    return ops;
}

export function createKillfieldBrain(gc, myId, opt) {
    opt = opt || {};
    var adapter = opt.adapter || null;          // 页面里传 VantageSandbox 适配器；不传就退化成纯几何
    var tileM = (opt.tileM || C.units().TILE_M);
    var field = null, fieldCell = null, fieldBudget = 2;   // 每帧最多新建几格（开局可多给）
    var navCache = null, navCacheKey = null;               // 到敌人格的 BFS 距离表（赶路用）
    var unitDivisor = 1;                                    // 融合世界几何的单位系数（正常 1；像素系会是 20）
    var diagLogged = false;
    var ops = candidateOps();
    var fireCooldown = 0;
    var lastPos = null, stuck = 0;
    var stats = { frames: 0, fieldBuilds: 0, fieldHits: 0, fires: 0, dodges: 0 };
    var lastPicked = null;

    /** 量一下融合世界的墙几何有没有单位问题：范围比迷宫大很多就是"像素系"，除以那个比值。
     *  （自己量、不猜；比值会打印在自检行里。） */
    function detectUnitDivisor(shapes, maze, tileM) {
        var expected = Math.max(maze.getWidth(), maze.getHeight()) * tileM;
        var maxCoord = 0;
        for (var i = 0; i < shapes.length; i++) {
            var verts = shapes[i] && shapes[i].verts;
            if (!verts) continue;
            for (var k = 0; k < verts.length; k++) {
                var v = verts[k];
                if (!v) continue;
                if (Math.abs(v.x) > maxCoord) maxCoord = Math.abs(v.x);
                if (Math.abs(v.y) > maxCoord) maxCoord = Math.abs(v.y);
            }
        }
        if (!isFinite(expected) || expected <= 0 || maxCoord <= 0) return 1;
        var ratio = maxCoord / expected;
        if (ratio > 3) return Math.round(ratio);
        return 1;
    }

    var viewCache = null, viewMazeRef = null, viewFromWalls = false;
    // v4 修"K 看到的地图是错的"：视图缓存要**分来源**。原来第一帧如果墙几何
    // 拿不到（坦克 body 还没建好），会走"把整格当墙"的旧逻辑建一张**错图**，
    // 然后被 viewCache 缓存住——后面墙几何可用了也直接命中缓存，**整局都用错图**。
    // 现在：墙几何来源的视图和 fallback 来源的视图分开标记，
    // fallback 视图一旦建过、后面拿到真墙几何就立刻重建（不再沿用）。

    function mazeView() {
        var maze = gc.getMaze ? gc.getMaze() : null;
        if (!maze) return null;
        var vs = (typeof globalThis !== 'undefined') ? globalThis.VantageSandbox : null;
        var shapes = null;
        try {
            if (vs && typeof vs.getFusedWallShapes === 'function') {
                shapes = vs.getFusedWallShapes(gc, myId);
            }
        } catch (eWalls) {}
        var haveWalls = !!(shapes && shapes.length);
        if (viewCache && viewMazeRef === maze && viewFromWalls === haveWalls) return viewCache;
        if (haveWalls) {
            unitDivisor = detectUnitDivisor(shapes, maze, tileM);
            viewCache = buildGameViewFromWallShapes(shapes, maze, { tileM: tileM, unitDivisor: unitDivisor });
            viewMazeRef = maze;
            viewFromWalls = true;
            return viewCache;
        }
        // 拿不到真墙几何 → 走 fallback（标 viewFromWalls=false，下次拿到真几何会重建）
        viewCache = buildGameView(maze, { tileM: tileM });
        viewMazeRef = maze;
        viewFromWalls = false;
        return viewCache;
    }

    /** 取（或建）敌人所在格的逆杀戮场；每帧最多新建 fieldBudget 格。 */
    /** 从敌人格出发的 BFS 距离（二维表）——往它那边赶的梯度；敌人换格才重算。 */
    function navFieldFor(enemyCell, view) {
        var key = 'nav' + enemyCell[0] * 10000 + enemyCell[1];
        if (navCache && navCacheKey === key) return navCache;
        navCache = view.distMap(enemyCell[0], enemyCell[1]);
        navCacheKey = key;
        return navCache;
    }

    function fieldFor(enemyCell, view) {
        var key = enemyCell[0] * 10000 + enemyCell[1];
        if (field && fieldCell === key) { stats.fieldHits++; return field; }
        if (fieldBudget <= 0) { stats.fieldHits++; return field; }   // 预算用完 → 先用旧场
        fieldBudget--;
        var b = new InverseDensityFieldBuilder(view, FIELD_RAYS, 2, 3 * C.FPS, 7, false);
        field = b.build(enemyCell);
        fieldCell = key;
        stats.fieldBuilds++;
        return field;
    }

    /** 每帧预算重置（开局可以给多一点，让常见格先算好）。 */
    function beginFrame() {
        fieldBudget = opt.fieldBudgetPerFrame === undefined ? 1 : opt.fieldBudgetPerFrame;
    }

    /** 用适配器批量模拟 9 个候选；失败就返回 null（调用方退化成"只躲不预测"）。 */
    function rolloutCandidates(state, threats, horizonFrames) {
        if (!adapter) return null;
        var frames = horizonFrames || HORIZON_FRAMES;
        var optIn = { startPose: state, threats: threats || [], tGlobal: 0, cfg: {} };
        try {
            if (typeof adapter.simulateTankBatchScored === 'function') {
                var r = adapter.simulateTankBatchScored(state, ops, frames, optIn);
                if (r && r.length === ops.length) return r;
            }
        } catch (e1) {}
        try {
            if (typeof adapter.simulateTankBatch === 'function') {
                var j = adapter.simulateTankBatch(state, ops, frames, optIn);
                if (j && j.length === ops.length) return j;
            }
        } catch (e2) {}
        return null;
    }

    /** 子弹快照（我们自己算，不依赖游戏内部结构之外的字段）。 */
    function bulletList() {
        var out = [];
        var list = gc.getProjectiles ? gc.getProjectiles() : {};
        for (var id in list) {
            if (!list.hasOwnProperty(id)) continue;
            var p = list[id];
            if (!p) continue;
            var done = false;
            try { done = !!(p.done && p.done()); } catch (e) {}
            if (done) continue;
            var owner = null;
            try { owner = p.getPlayerId ? p.getPlayerId() : p.playerId; } catch (e2) {}
            out.push({
                id: id,
                x: p.getX(), y: p.getY(),
                vx: (p.getSpeedX ? p.getSpeedX() : 0), vy: (p.getSpeedY ? p.getSpeedY() : 0),
                mine: String(owner) === String(myId),
                bounced: !!(p.bounces && p.bounces.length > 0)
            });
        }
        return out;
    }

    /**
     * 给一条候选轨迹打分：
     *   躲弹（子弹路径与轨迹的最近距离）＋ 走位（终点格的"能打到对手"程度）－ 乱撞惩罚。
     */
    /** 候选轨迹采样换算到米制（防单位不一致）。 */
    function toMeters(samples) {
        if (unitDivisor === 1) return samples;
        var out = [];
        for (var i = 0; i < samples.length; i++) {
            var s = samples[i];
            out.push(s ? { x: s.x / unitDivisor, y: s.y / unitDivisor, rot: s.rot } : s);
        }
        return out;
    }

    function scoreTrajectory(samples, boxes, enemyBullets, view, me, enemy, nav) {
        var i, k, b, score = 0, minClear = Infinity;
        var step = tileM / 4;                 // 采样步长约 2.5 米
        for (i = 0; i < enemyBullets.length; i++) {
            b = enemyBullets[i];
            var speed = Math.hypot(b.vx, b.vy);
            if (speed < 1e-6) continue;
            var dt = 0.02;
            for (k = 1; k < samples.length; k++) {
                var s = samples[k];
                if (!s) continue;
                // 子弹第 k 帧的直线位置（0.24 秒内几乎不会反弹，够了；反弹交给 risk 兜底）
                var bx = b.x + b.vx * dt * k, by = b.y + b.vy * dt * k;
                var d = Math.hypot(s.x - bx, s.y - by);
                if (d < minClear) minClear = d;
            }
        }
        // 躲弹：挨打半径内是重罚；越宽松越好
        if (minClear < HIT_RADIUS_M) score -= 1000 * (HIT_RADIUS_M - minClear + 1);
        else score += Math.min(minClear, 5 * tileM);

        // 走位：终点格"从这里打对手"的覆盖度（逆杀戮场；它只依赖迷宫与敌人格）
        var end = samples[samples.length - 1];
        if (end && field) {
            var cx = Math.floor(end.x / tileM), cy = Math.floor(end.y / tileM);
            score += 40 * field.relativeSuccessAt([cx, cy]);
        }

        // 机动：线性奖励真的走出去。踩过大坑：原来写成「位移 < tileM/4（2.5 米）就扣 30 分」，
        // 而 30 帧最多只能走 2.4 米 → 9 个候选全被扣同样的分 → 平局乱选 → 主人看到的原地抽搐。
        var first = samples[0];
        if (first && end) {
            var moved = Math.hypot(end.x - first.x, end.y - first.y);
            score += 24 * (moved / tileM);
            // v3 修远距抽搐：直线"靠近敌人"这一项**永远算**——原来只在 BFS 不可用时才算，
            // 而 BFS 项在 12 帧前瞻里根本跨不出一格（d0===d1，加 0 分），等于远距离
            // 完全没有方向梯度 → 前进后退同分 → 平局乱选 → 主人看到的"原地前后抽搐"。
            var straightDelta = Math.hypot(end.x - enemy.x, end.y - enemy.y) -
                Math.hypot(first.x - enemy.x, first.y - enemy.y);
            score -= 12 * straightDelta;   // 靠近 = 正分，远离 = 负分
            // BFS 项叠加在直线之上：跨过格边界时额外加分（用真实可走步数）
            if (nav) {
                var mCell = [Math.floor(first.x / tileM), Math.floor(first.y / tileM)];
                var eCell = [Math.floor(end.x / tileM), Math.floor(end.y / tileM)];
                var d0 = (nav[mCell[0]] && nav[mCell[0]][mCell[1]] !== null) ? nav[mCell[0]][mCell[1]] : null;
                var d1 = (nav[eCell[0]] && nav[eCell[0]][eCell[1]] !== null) ? nav[eCell[0]][eCell[1]] : null;
                if (d0 !== null && d1 !== null) score += 60 * (d0 - d1);
            }
        }
        return score;
    }

    function update(dt) {
        beginFrame();
        stats.frames++;
        var tank = gc.getTank ? gc.getTank(myId) : null;
        if (!tank) return idle();
        var me = { x: tank.getX(), y: tank.getY(), rot: tank.getRotation() };
        var view = mazeView();
        if (!view) return idle();

        // 敌人（单挑；多坦克时取最近的一个）
        var enemy = null, enemyId = null, best = Infinity;
        var tanks = gc.getTanks ? gc.getTanks() : {};
        for (var pid in tanks) {
            if (!tanks.hasOwnProperty(pid)) continue;
            if (String(pid) === String(myId)) continue;
            var t = tanks[pid];
            if (!t) continue;
            var d = Math.hypot(t.getX() - me.x, t.getY() - me.y);
            if (d < best) { best = d; enemy = { x: t.getX(), y: t.getY(), rot: t.getRotation(), tank: t }; enemyId = pid; }
        }
        if (!enemy) return idle();

        if (!diagLogged) {
            diagLogged = true;
            var bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
            for (var wi = 0; wi < view.walls.length; wi++) {
                var wb = view.walls[wi];
                if (wb[0] < bx0) bx0 = wb[0];
                if (wb[2] > bx1) bx1 = wb[2];
                if (wb[1] < by0) by0 = wb[1];
                if (wb[3] > by1) by1 = wb[3];
            }
            var mz = gc.getMaze ? gc.getMaze() : null;
            console.log('[K] 自检: 迷宫=' + (mz ? mz.getWidth() : '?') + 'x' + (mz ? mz.getHeight() : '?') +
                ' 墙来源=' + (viewFromWalls ? '融合世界(正确)' : '格近似(错误!)') +
                '格@' + tileM + 'm 墙块=' + view.walls.length + ' 可达格=' + view.reachable.length +
                ' 墙范围=[' + bx0.toFixed(1) + ',' + by0.toFixed(1) + ']~[' + bx1.toFixed(1) + ',' + by1.toFixed(1) + ']' +
                ' 单位系数=' + unitDivisor + ' 我=(' + me.x.toFixed(1) + ',' + me.y.toFixed(1) + ')' +
                ' 敌=(' + enemy.x.toFixed(1) + ',' + enemy.y.toFixed(1) + ')');
        }
        var enemyCell = [Math.floor(enemy.x / tileM), Math.floor(enemy.y / tileM)];
        fieldFor(enemyCell, view);
        var nav = navFieldFor(enemyCell, view);

        // ② 开火判断：从我这格该朝哪打（密度场给的瞄准角），误差小就打
        var myCell = [Math.floor(me.x / tileM), Math.floor(me.y / tileM)];
        var fire = false;
        if (fireCooldown > 0) fireCooldown--;
        // 密度场的角度是**世界角**（0 = +x），我们自己的 rot 是另一套（朝向 = (sin rot, -cos rot)）。
        // 换算：世界角 θ ↔ 我们的 rot = θ + 90°。这里统一在世界角里比误差。
        var theirHeading = Math.atan2(-Math.cos(me.rot), Math.sin(me.rot));
        var aim = field ? field.bestAimAt(myCell, theirHeading) : [null, 0];
        if (aim[0] !== null) {
            var err = Math.abs(Math.atan2(Math.sin(aim[0] - theirHeading), Math.cos(aim[0] - theirHeading)));
            // 自杀检查（主人实测"对着墙发子弹自杀"）：我们的世界里子弹**反弹后**会打死自己
            // （未反弹的自弹无害），所以在它自己的版本里贴墙开枪可能没事，在我们这里会死。
            // 开火前先用反射几何算一遍：这一枪反弹回来会不会打到我。
            var selfHit = false;
            try {
                var hx = Math.sin(me.rot), hy = -Math.cos(me.rot);
                var muzzle = 2.5;                      // 枪口前移（Constants.BULLET.OFFSET.m）
                var bulletPerFrame = C.units().BULLETSPEED * (tileM / 50);
                var res = reflectiveClosest(me.x + hx * muzzle, me.y + hy * muzzle,
                    hx, hy, bulletPerFrame, C.FPS * 2, 2, view.walls, me.x, me.y);
                selfHit = res.bounces >= 1 && res.distance < HIT_RADIUS_M && res.frame < C.FPS * 1.2;
            } catch (eSelf) { selfHit = false; }
            if (err < AIM_TOLERANCE && fireCooldown === 0 && aim[1] > 0.02 && !selfHit) {
                fire = true;
                fireCooldown = FIRE_COOLDOWN_FRAMES;
                stats.fires++;
            }
        }

        // ③ 躲弹 + 走位：批量模拟 9 个候选，挑分最高的
        var bullets = bulletList();
        var enemyBullets = bullets.filter(function (b) { return !b.mine; });
        var horizon = enemyBullets.length ? HORIZON_FRAMES : HORIZON_IDLE;
        var rolls = rolloutCandidates({ x: me.x, y: me.y, rot: me.rot }, [], horizon);
        var picked = null;
        if (rolls) {
            var bestScore = -Infinity;
            for (var i = 0; i < rolls.length; i++) {
                var samples = rolls[i] && rolls[i].samples;
                if (!samples || !samples.length) continue;
                samples = toMeters(samples);
                var sc = scoreTrajectory(samples, view.walls, enemyBullets, view, me, enemy, nav);
                if (sc > bestScore) { bestScore = sc; picked = ops[i]; }
            }
        }
        // 没有批量模拟（或全失败）→ 退化成"原地不动 + 靠 risk 判断要不要转向"
        if (!picked) {
            var risk = 0;
            try {
                risk = incomingRisk(buildCombatView(snapshotFromGameController(gc, myId, { dt: dt || 0.02, tileM: tileM })), view.walls);
            } catch (eR) {}
            picked = ops[risk > 0.3 ? 6 : 4];   // 有风险就往前左（乱走也比挨打强），否则静止
        }

        // 卡住检测：连续几帧几乎没位移 → 强制转向
        if (lastPos) {
            var moved = Math.hypot(me.x - lastPos.x, me.y - lastPos.y);
            if (moved < 0.05) stuck++; else stuck = 0;
        }
        lastPos = { x: me.x, y: me.y };
        if (stuck >= STUCK_FRAMES) {
            picked = ops[8];                    // 前右，先离开墙
            stuck = 0;
        }
        lastPicked = picked;
        var inp = picked.inputs;
        return {
            forward: !!inp.forward, back: !!inp.back, left: !!inp.left, right: !!inp.right,
            fire: fire, movement: picked.movement
        };
    }

    function idle() {
        return { forward: false, back: false, left: false, right: false, fire: false, movement: 4 };
    }

    return {
        update: update,
        reset: function () {
            field = null; fieldCell = null; fireCooldown = 0; stuck = 0; lastPos = null; lastPicked = null;
            navCache = null; navCacheKey = null; diagLogged = false;
            viewCache = null; viewMazeRef = null; viewFromWalls = false;
        },
        stats: stats,
        getField: function () { return field; },
        getLastMovement: function () { return lastPicked ? lastPicked.movement : 4; },
        /** 供测试/调试：手动注入适配器 */
        setAdapter: function (a) { adapter = a; }
    };
}

export default { createKillfieldBrain: createKillfieldBrain };
