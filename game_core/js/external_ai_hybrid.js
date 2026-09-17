/**
 * 外接 AI · Hybrid 观测构造器 + 动作映射（P1 骨架）
 * ---------------------------------------------------------------------------
 * 参考实现：game_core/参考AI/Hybrid/killfield-main/engine/src/duel_obs.rs
 *          （schema 24：观测 1028 维 / 动作 18 个）
 * 工作副本：game_core/external_ai/hybrid/（模型与推理；参考工程只读）
 * 方案文档：docs/Vantage躲弹实现/外接AI接入方案-Hybrid.md
 *
 * 本文件只做两件事：
 *   ① 把我们游戏的状态按他们的布局填成 1028 维观测；
 *   ② 把他们选出的 18 号动作翻译成我们的输入（前后左右 + 开火）。
 *
 * 分阶段：
 *   P1（本文件）：地图 7 通道 / 自身 12 / 对手 12 / 子弹槽 10×10 / 阶段 / 动作历史 / 闲置；
 *                射线 16、导航 10、瞄准辅助 5+5、威胁汇总 3、子弹"会不会打到我"先填 0（P2 补齐）。
 *   P2：射线、导航、瞄准辅助、威胁汇总、子弹威胁判定。
 *   P3：dodge 先验 9 个（用我们自己的评分，不搬他们的 score.rs）。
 *
 * 约定（来自他们的代码，必须一致）：
 *   · 朝向：世界朝向 = (sin(rot), -cos(rot))，与他们的 (rot-90°) 同构；
 *   · to_own_frame(rot,dx,dy) = (dx*cos(f)+dy*sin(f), -dx*sin(f)+dy*cos(f))，f = rot-π/2；
 *   · 动作：throttle(0 后,1 中,2 前) × turn(0 左,1 中,2 右) → 移动码 m = throttle*3+turn；
 *           action = m*2 + fire；
 *   · 地图：每格 7 通道 = [存在, 上墙, 右墙, 下墙, 左墙, 我在格, 敌在格]，
 *           下标 = (x*MAP_H + y)*7（x 主序，与他们的编码器一致）。
 */
(function (global) {
    'use strict';

    var MAP_W = 12, MAP_H = 10, MAP_C = 7;
    var MAP_DIM = MAP_W * MAP_H * MAP_C;      // 840
    var RAY_COUNT = 16;                        // 840..856
    var SELF_OFFSET = 856, SELF_DIM = 12;      // 856..868
    var OPP_OFFSET = 868, OPP_DIM = 12;        // 868..880
    var NAV_OFFSET = 880, NAV_DIM = 10;        // 880..890
    var AIM_SELF_OFFSET = 890, AIM_DIM = 5;    // 890..895
    var AIM_OPP_OFFSET = 895;                  // 895..900
    var BULLET_OFFSET = 900, BULLET_SLOTS = 10, BULLET_DIM = 10;   // 900..1000
    var THREAT_OFFSET = 1000, THREAT_DIM = 3;  // 1000..1003
    var PHASE_OFFSET = 1003, PHASE_DIM = 4;    // 1003..1007
    var LAST_ACTION_OFFSET = 1007, LAST_ACTION_DIM = 3;            // 1007..1010
    var SELF_THREAT_OFFSET = 1010;             // 1010..1011
    var OLDER_ACTIONS_OFFSET = 1011, OLDER_ACTIONS_DIM = 6;        // 1011..1017
    var CHANGE_RATE_OFFSET = 1017;             // 1017
    var DODGE_OFFSET = 1018, DODGE_DIM = 9;    // 1018..1027
    var IDLE_STREAK_OFFSET = 1027;             // 1027
    var OBS_DIM = 1028;
    var ACTION_COUNT = 18;
    var IDLE_STREAK_CAP = 25;

    /**
     * 把**我们的世界**（y 朝下、屏幕系）整体镜像到**他们的世界**（y 朝上、右手系）。
     * ----------------------------------------------------------------------
     * 为什么必须做：他们的 `to_own_frame` 定义 +y 是"左"，而那个 +y 是在
     * y 朝上的右手系里；我们的世界 y 朝下，同一个公式作用在我们的数字上会把
     * "左/右"反过来（AI 会往错的一边躲）。
     * 镜像映射（等距变换）：x' = x，y' = (地图高 - y)，rot' = π - rot，
     * 速度 (vx, vy) → (vx, -vy)，角速度取反；地图行也随之翻转（第 y 行 → 第 h-1-y 行），
     * 这样墙、坦克、子弹全都在同一个镜像系里，彼此一致。
     * 镜像后再用他们的编码器逐式照抄，就是"同一个物理局面在他们的眼里"。
     */
    function mirrorToTheirFrame(s) {
        var h = Math.max(1, (s.maze && s.maze.h) | 0);
        var hM = h * ((s.units && s.units.tileM) || 10);
        function pose(p) {
            if (!p) return p;
            return {
                x: p.x,
                y: hM - p.y,
                rot: Math.PI - p.rot,
                vx: p.vx || 0,
                vy: -(p.vy || 0),
                turn: -(p.turn || 0),
                ammoFrac: p.ammoFrac,
                canFire: p.canFire,
                alive: p.alive,
                hitSomething: p.hitSomething,
                wallSliding: p.wallSliding
            };
        }
        var out = {
            maze: {
                w: s.maze.w,
                h: h,
                walkable: function (x, y) {
                    if (typeof s.maze.walkable !== 'function') return true;
                    return !!s.maze.walkable(x, h - 1 - y);
                }
            },
            self: pose(s.self),
            opp: pose(s.opp),
            bullets: (s.bullets || []).map(function (b) {
                return {
                    x: b.x, y: hM - b.y, vx: b.vx || 0, vy: -(b.vy || 0),
                    mine: b.mine, bounced: b.bounced, lifeFrac: b.lifeFrac,
                    threatMe: b.threatMe, threatThem: b.threatThem, etaMe: b.etaMe
                };
            }),
            phase: s.phase, clockFrac: s.clockFrac, dodge9: s.dodge9,
            idleStreak: s.idleStreak, changeRate: s.changeRate, actions: s.actions
        };
        return out;
    }

    /** 世界向量 → 自身系（+x 前，+y 左）。与 duel_obs.rs::to_own_frame 同构。 */
    function toOwnFrame(rot, dx, dy) {
        var facing = rot - Math.PI / 2;
        var s = Math.sin(facing), c = Math.cos(facing);
        return [dx * c + dy * s, -dx * s + dy * c];
    }

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
    function clamp01(v) { return clamp(v, 0, 1); }

    /** 归一化用的量纲。能从游戏 Constants 拿的就拿，拿不到用兜底值。 */
    function makeUnits(constants) {
        var tileM = 10, bulletSpeed = 20, turnRate = 0.06, bulletLifetime = 3;
        try {
            if (constants) {
                if (constants.MAZE_TILE_SIZE && constants.MAZE_TILE_SIZE.m) tileM = constants.MAZE_TILE_SIZE.m;
                if (constants.BULLET && constants.BULLET.SPEED && constants.BULLET.SPEED.m) bulletSpeed = constants.BULLET.SPEED.m;
                if (constants.BULLET && constants.BULLET.LIFETIME !== undefined) bulletLifetime = constants.BULLET.LIFETIME;
                if (constants.TANK) {
                    var tr = constants.TANK.TURN_SPEED || constants.TANK.ROTATION_SPEED || constants.TANK.TURN_RATE;
                    if (typeof tr === 'number' && tr > 0) turnRate = tr;
                }
            }
        } catch (eUnits) {}
        return {
            tileM: tileM,
            speedScale: bulletSpeed,      // 与他们的 MAX_BULLET_SPEED_CELLS*scale 同量纲（米/秒）
            turnRate: turnRate,           // 每帧弧度（转速归一化用）
            bulletLifetime: bulletLifetime
        };
    }

    /**
     * 构造 1028 维观测。
     * @param {Object} s 状态快照：
     *   { maze: {w,h,walkable(x,y)},
     *     self: {x,y,rot,vx,vy,turn,ammoFrac,canFire,alive,hitSomething,wallSliding},
     *     opp:  同 self,
     *     bullets: [{x,y,vx,vy,mine,bounced,lifeFrac,threatMe,threatThem,etaMe}],
     *     phase: [4 个 0/1], clockFrac, dodge9: [9], idleStreak, changeRate,
     *     actions: [最近 3 个动作的三元组] }
     * @param {Object} opt { units, constants }
     * @returns {{values: Float32Array, bulletMask: Array, warnings: Array}}
     */
    function buildObservation(s, opt) {
        opt = opt || {};
        var units = opt.units || makeUnits(opt.constants);
        var v = new Float32Array(OBS_DIM);
        var mask = new Array(BULLET_SLOTS);
        var warnings = [];
        var i, j;
        for (i = 0; i < BULLET_SLOTS; i++) mask[i] = false;
        if (!s || !s.maze || !s.self || !s.opp) {
            return { values: v, bulletMask: mask, warnings: ['缺少状态快照（maze/self/opp）'] };
        }

        // 先把我们的状态镜像到他们的坐标系（否则左右会反），再逐式照抄他们的编码器。
        s = mirrorToTheirFrame(s);
        var maze = s.maze;
        var w = Math.max(1, maze.w | 0), h = Math.max(1, maze.h | 0);
        if (w > MAP_W || h > MAP_H) warnings.push('地图 ' + w + 'x' + h + ' 超出 12x10，只填前 12x10 格');
        var worldW = w * units.tileM, worldH = h * units.tileM;
        var span = worldW + worldH;
        var self = s.self, opp = s.opp;

        // ---- 地图：存在 / 四壁 / 我在格 / 敌在格 -------------------------------
        function walk(x, y) {
            if (x < 0 || y < 0 || x >= w || y >= h) return false;
            if (typeof maze.walkable === 'function') return !!maze.walkable(x, y);
            return true;
        }
        var myCellX = clamp(Math.floor(self.x / units.tileM), 0, MAP_W - 1);
        var myCellY = clamp(Math.floor(self.y / units.tileM), 0, MAP_H - 1);
        var opCellX = clamp(Math.floor(opp.x / units.tileM), 0, MAP_W - 1);
        var opCellY = clamp(Math.floor(opp.y / units.tileM), 0, MAP_H - 1);
        for (var x = 0; x < Math.min(w, MAP_W); x++) {
            for (var y = 0; y < Math.min(h, MAP_H); y++) {
                var base = (x * MAP_H + y) * MAP_C;
                var here = walk(x, y);
                v[base] = here ? 1 : 0;
                // 他们的"墙"是格与格之间的边；我们的"墙"是走不进去的格子 → 邻居不可走即视为有墙。
                v[base + 1] = walk(x, y - 1) ? 0 : 1;   // 上
                v[base + 2] = walk(x + 1, y) ? 0 : 1;   // 右
                v[base + 3] = walk(x, y + 1) ? 0 : 1;   // 下
                v[base + 4] = walk(x - 1, y) ? 0 : 1;   // 左
                v[base + 5] = (here && x === myCellX && y === myCellY) ? 1 : 0;
                v[base + 6] = (here && opp.alive && x === opCellX && y === opCellY) ? 1 : 0;
            }
        }

        // ---- 自身 12 项 -------------------------------------------------------
        var myOwn = toOwnFrame(self.rot, self.vx || 0, self.vy || 0);
        var facingX = Math.sin(self.rot), facingY = -Math.cos(self.rot);
        v[SELF_OFFSET] = clamp01(self.x / worldW);
        v[SELF_OFFSET + 1] = clamp01(self.y / worldH);
        v[SELF_OFFSET + 2] = facingX;
        v[SELF_OFFSET + 3] = facingY;
        v[SELF_OFFSET + 4] = clamp(myOwn[0] / units.speedScale, -1, 1);
        v[SELF_OFFSET + 5] = clamp(myOwn[1] / units.speedScale, -1, 1);
        v[SELF_OFFSET + 6] = clamp((self.turn || 0) / units.turnRate, -1, 1);
        v[SELF_OFFSET + 7] = clamp01(self.ammoFrac === undefined ? 1 : self.ammoFrac);
        v[SELF_OFFSET + 8] = self.canFire ? 1 : 0;
        v[SELF_OFFSET + 9] = self.alive ? 1 : 0;
        v[SELF_OFFSET + 10] = self.hitSomething ? 1 : 0;
        v[SELF_OFFSET + 11] = self.wallSliding ? 1 : 0;

        // ---- 对手 12 项（全部在"我的坐标系"里）--------------------------------
        var rel = toOwnFrame(self.rot, opp.x - self.x, opp.y - self.y);
        var opOwn = toOwnFrame(self.rot, opp.vx || 0, opp.vy || 0);
        var relHeading = opp.rot - self.rot;
        v[OPP_OFFSET] = clamp(rel[0] / span, -1, 1);
        v[OPP_OFFSET + 1] = clamp(rel[1] / span, -1, 1);
        v[OPP_OFFSET + 2] = Math.cos(relHeading);
        v[OPP_OFFSET + 3] = Math.sin(relHeading);
        v[OPP_OFFSET + 4] = clamp(opOwn[0] / units.speedScale, -1, 1);
        v[OPP_OFFSET + 5] = clamp(opOwn[1] / units.speedScale, -1, 1);
        v[OPP_OFFSET + 6] = clamp((opp.turn || 0) / units.turnRate, -1, 1);
        v[OPP_OFFSET + 7] = clamp01(opp.ammoFrac === undefined ? 1 : opp.ammoFrac);
        v[OPP_OFFSET + 8] = opp.canFire ? 1 : 0;
        v[OPP_OFFSET + 9] = opp.alive ? 1 : 0;
        v[OPP_OFFSET + 10] = opp.hitSomething ? 1 : 0;
        v[OPP_OFFSET + 11] = opp.wallSliding ? 1 : 0;

        // ---- 子弹槽 10×10 -----------------------------------------------------
        var bullets = s.bullets || [];
        var threatCount = 0;
        for (i = 0; i < bullets.length && i < BULLET_SLOTS; i++) {
            var b = bullets[i];
            var bbase = BULLET_OFFSET + i * BULLET_DIM;
            var bp = toOwnFrame(self.rot, b.x - self.x, b.y - self.y);
            var bv = toOwnFrame(self.rot, b.vx || 0, b.vy || 0);
            v[bbase] = clamp(bp[0] / span, -1, 1);
            v[bbase + 1] = clamp(bp[1] / span, -1, 1);
            v[bbase + 2] = clamp(bv[0] / units.speedScale, -1, 1);
            v[bbase + 3] = clamp(bv[1] / units.speedScale, -1, 1);
            v[bbase + 4] = b.mine ? 1 : 0;
            v[bbase + 5] = b.bounced ? 1 : 0;
            v[bbase + 6] = clamp01(b.lifeFrac === undefined ? 1 : b.lifeFrac);
            // +7 是否会打到我、+8 是否会打到对手：P2 补（先按调用方给的标志）
            if (b.threatMe) { v[bbase + 7] = 1; threatCount++; }
            if (b.threatThem) v[bbase + 8] = 1;
            v[bbase + 9] = (!b.threatMe || b.etaMe === undefined) ? 1 : clamp01(b.etaMe);
            mask[i] = true;
        }
        v[SELF_THREAT_OFFSET] = clamp01(threatCount / BULLET_SLOTS);

        // ---- 阶段 / 时钟 ------------------------------------------------------
        var phase = s.phase || [1, 0, 0, 0];
        for (i = 0; i < PHASE_DIM; i++) v[PHASE_OFFSET + i] = phase[i] ? 1 : 0;
        v[PHASE_OFFSET + PHASE_DIM - 1] = clamp01(s.clockFrac === undefined ? 0 : s.clockFrac);

        // ---- 动作历史：最近一帧 + 更早两帧 + 换手率 ---------------------------
        var acts = s.actions || [];
        for (i = 0; i < LAST_ACTION_DIM; i++) {
            v[LAST_ACTION_OFFSET + i] = clamp01(acts.length > 0 ? acts[0][i] : 0);
            v[OLDER_ACTIONS_OFFSET + i] = clamp01(acts.length > 1 ? acts[1][i] : 0);
            v[OLDER_ACTIONS_OFFSET + LAST_ACTION_DIM + i] = clamp01(acts.length > 2 ? acts[2][i] : 0);
        }
        v[CHANGE_RATE_OFFSET] = clamp01(s.changeRate === undefined ? 0 : s.changeRate);

        // ---- dodge 先验 9 个（P3 用我们自己的评分；现在允许外部传入）----------
        var dodge = s.dodge9 || [];
        for (i = 0; i < DODGE_DIM; i++) v[DODGE_OFFSET + i] = clamp01(dodge[i] === undefined ? 0 : dodge[i]);

        // ---- 闲置帧数 --------------------------------------------------------
        v[IDLE_STREAK_OFFSET] = clamp01((s.idleStreak || 0) / IDLE_STREAK_CAP);

        // ---- 有限性自检（NaN/越界一律修正并记警告，不把脏数据喂进模型）-------
        var bad = 0;
        for (j = 0; j < OBS_DIM; j++) {
            if (!isFinite(v[j])) { v[j] = 0; bad++; }
            else if (v[j] > 1.0000001 || v[j] < -1.0000001) { v[j] = clamp(v[j], -1, 1); bad++; }
        }
        if (bad) warnings.push('观测里有 ' + bad + ' 个越界/NaN 已修正');

        return { values: v, bulletMask: mask, warnings: warnings };
    }

    /** 动作号 → 我们的输入（throttle 0 后/1 中/2 前，turn 0 左/1 中/2 右，fire 0/1）。 */
    function actionToInputs(action) {
        var a = clamp(action | 0, 0, ACTION_COUNT - 1);
        var m = Math.floor(a / 2);
        var throttle = Math.floor(m / 3);
        var turn = m % 3;
        return {
            action: a,
            movement: m,
            throttle: throttle,
            turn: turn,
            fire: (a % 2) === 1,
            forward: throttle === 2,
            back: throttle === 0,
            left: turn === 0,
            right: turn === 2
        };
    }

    /** 我们的操作 → 移动码（把最近动作写进观测历史时用）。 */
    function inputsToMovement(inputs) {
        var throttle = inputs.forward ? 2 : (inputs.back ? 0 : 1);
        var turn = inputs.left ? 0 : (inputs.right ? 2 : 1);
        return throttle * 3 + turn;
    }

    global.VantageExternalHybrid = {
        OBS_DIM: OBS_DIM,
        ACTION_COUNT: ACTION_COUNT,
        BULLET_SLOTS: BULLET_SLOTS,
        MAP_W: MAP_W,
        MAP_H: MAP_H,
        OFFSETS: {
            MAP: 0, RAY: 840, SELF: SELF_OFFSET, OPPONENT: OPP_OFFSET, NAV: NAV_OFFSET,
            AIM_SELF: AIM_SELF_OFFSET, AIM_OPPONENT: AIM_OPP_OFFSET, BULLETS: BULLET_OFFSET,
            THREAT: THREAT_OFFSET, PHASE: PHASE_OFFSET, LAST_ACTION: LAST_ACTION_OFFSET,
            SELF_THREAT_COUNT: SELF_THREAT_OFFSET, OLDER_ACTIONS: OLDER_ACTIONS_OFFSET,
            CHANGE_RATE: CHANGE_RATE_OFFSET, DODGE: DODGE_OFFSET, IDLE_STREAK: IDLE_STREAK_OFFSET
        },
        toOwnFrame: toOwnFrame,
        mirrorToTheirFrame: mirrorToTheirFrame,
        makeUnits: makeUnits,
        buildObservation: buildObservation,
        actionToInputs: actionToInputs,
        inputsToMovement: inputsToMovement
    };

    console.log('[Vantage 外接AI] Hybrid 观测构造器已加载（P1：地图/自身/对手/子弹槽/阶段/历史；射线·导航·瞄准·威胁待 P2，dodge 先验待 P3）');
})(typeof window !== 'undefined' ? window : this);
