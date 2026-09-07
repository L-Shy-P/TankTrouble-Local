/**
 * Vantage 评分与基准时间模块（阶段②）
 *
 * 2026-08-16 v17：折线反弹次数恢复为 5。20 次反弹会让角弹误差累积，
 * 无树模式躲弹能力因此下降；8s 长视界需要真实子弹模拟，不能靠加反弹次数。
 * 2026-08-16 v18：滚动评分支持 threat.track（bullet-only Box2D 逐帧轨迹）。
 *   threatBulletPos：有 track 时按帧索引取 Box2D 轨迹（不插值），
 *   无 track 时回退旧 bulletPosAt 折线。死亡判定仍走旧 checkDeath。
 * 2026-08-23 v24（单世界融合死亡权威）：
 *   scorePaths 批量分支不再用旧 checkDeath；死亡帧由融合世界的
 *   传感器接触批量结果提供，存活帧走 scoreFrameAlive（跳过 checkDeath）。
 *   scorePath/scoreRollout 旧路径原样保留，作为融合世界关闭时的回退。
 * 2026-08-23 v25（弹簧绳距离评分 + 开关）：
 *   新增 springRopeLength/springRopeFrameScore/getMazeWallEnv；
 *   墙距 = 可见图最短路径，直线不穿墙时退化为欧氏距离；
 *   scorePath/scoreRollout/scorePaths 在 lanePenaltyFrame 之后加入
 *   弹簧绳距离分；参数 springRopeEnabled/DNear/DRef/ClearanceCap 进 cfg。
 * 2026-08-23 v26（评分模块增量缓存接口）：
 *   新增 scoreRolloutCached(adapter, samples, tGlobalStart, inputs, frames,
 *   threats, cfg, prevCache)；返回 {result, cache}。
 *   无 prevCache 时全量计算并写缓存；有 prevCache 时按 added/removed 子弹
 *   增量更新角度并集、弹簧绳乘积、车道 max、死亡重查，不模拟坦克。
 * 2026-09-07 v31（配合树 v78 / 沙箱 v33 / 桥 v10）：
 *   vt_score_paths 接入 rolloutNine；scorePaths 保持 JS 回退路径不变。
 * 2026-08-23 v28（缺失折线的真实子弹兜底为直线威胁，杜绝“从视野消失”）：
 *   getProjectilePaths 瞬态丢弃折线时，computeThreats 仍为当前真实
 *   projectile 生成当前位置+速度方向的直线 fallback threat；
 *   Box2D 轨迹生成后自然替换为精确弹道。修复死亡瞬间 threatCount=0。
 * 2026-08-23 v27（弹簧绳修复：符号 + 可见图预计算 + 默认关）：
 *   弹簧绳距离分改为扣分；getMazeWallEnv 预计算角点可见性；
 *   springRopeEnabled 默认 false。
 * 2026-08-16 v22：lanePenalty 有 track 时改用 Box2D 轨迹，raycast 折线仅作无 track 回退。
 * 2026-08-21 v23（双源基准性能）：
 *   occlusionIntervals 先按 R_ABS/R_SEMI 单趟粗筛：远弹不进角带求交；
 *   lanePenaltyFrame 给每条 threat 建一次轨迹包围盒，整盒距坦克 >3.5m
 *   时直接跳过——9×75 rollout 的评分部分从 ~40ms 降到 ~7ms（Node 实测）。
 * 2026-08-16 v21：卡墙惩罚 + 新弹 anchorOffset + scoreRollout 重评分。
 *   ① 非静止操作在 75 帧模拟中连续两帧位姿几乎不变（位移<5cm 且转角
 *      <0.05rad）时，每帧额外扣 stuckPenalty（默认4.0）——阻止 AI 用
 *      “倒车进墙角”换取躲避评分。
 *   ② threatBulletPos/lanePenaltyFrame 支持 threat.anchorOffset，
 *      新弹局部追加进旧树后仍可用旧根时间轴正确查询。
 *
 * 「拷贝区」内的函数为逐字节复制自 js/ai_tactics.js 的成品几何系统
 * （旋转余量包络 = 调试器 F8 安全区背后的遮蔽角计算），请勿手改。
 * 来源行区间（ai_tactics.js）：
 *   getCfg/DEFAULT_BEHAVIOR      L8-43
 *   坦克尺寸/子弹半径            L3489-3599
 *   点到线段距离                 L4704-4716
 *   旋转余量包络几何核心         L4744-5027
 * 拷贝区依赖游戏全局 Constants（游戏是唯一权威），在游戏页/测试 iframe 内均可用。
 *
 * 「拷贝区2」为逐字节复制自根目录《无墙壁子弹危险区域调试器.html》的精确角度遮蔽系统
 * （对称矩形 + 遮蔽半角 asin(有效半宽/距离) + sin/cos 角带求交 + 区间合并），
 * v3 起遮蔽角以拷贝区2 为准（正面/背面完全对称；主人 2026-08-14 指认的成品）。
 */
(function(global) {
    'use strict';

    // ==================== 拷贝区开始（ai_tactics.js 逐字节复制，勿手改） ====================
    function getCfg() {
        if (typeof TankTroubleAIStrength !== 'undefined') {
            var resolved = TankTroubleAIStrength.resolve();
            if (resolved && resolved.behavior) {
                return resolved.behavior;
            }
        }
        return DEFAULT_BEHAVIOR;
    }

    /** ai_strength_config 未加载时的兜底（仍启用动态躲弹等核心逻辑） */
    var DEFAULT_BEHAVIOR = {
        enabled: true,
        smartDodge: true,
        dynamicDodge: true,
        comboDodge: true,
        dodgeRequireMovement: false,
        dodgeDisplacementWeight: 0.4,
        dodgeSafetySampleDt: 0.025,
        dodgeRepeatPenalty: 2.0,
        dodgeGoalPeriod: 120,
        dodgeInputDuration: 280,
        dodgeUrgentTime: 1.65,
        dodgeUrgentDistance: 12,
        parallelCognition: true,
        temporalDodge: true,
        tacticalShoot: true,
        shotDrivenStance: true,
        requireMinRicochet: true,
        cornerRicochet: true,
        sameAngleCooldownMs: 300,
        proactiveShoot: false,
        immediateActionReplan: true,
        respectShootGoalPeriod: true,
        postShotRepositionMs: 520
    };
    function getTankHalfWidth() {
        return Constants.TANK.WIDTH.m * 0.5;
    }

    /** 车体矩形后半长（中心到车尾，不含炮管前伸） */
    function getTankBodyHalfLength() {
        return Constants.TANK.HEIGHT.m * 0.5;
    }

    /** 车体半长 + 炮塔/炮管前伸（取对称圆盘半径，单位：本地 px） */
    function tankForwardHalfLengthPx() {
        if (typeof Constants === 'undefined' || !Constants.TANK) return 40;
        var bodyHalf = Constants.TANK.HEIGHT.px * 0.5;
        var front = bodyHalf;
        var turretTip, muzzle;
        if (Constants.BULLET_TURRET) {
            turretTip = Math.abs(Constants.BULLET_TURRET.OFFSET_Y.px) +
                Constants.BULLET_TURRET.HEIGHT.px * 0.5;
            if (turretTip > front) front = turretTip;
        }
        if (Constants.BULLET) {
            muzzle = (Constants.BULLET.OFFSET && Constants.BULLET.OFFSET.px) || 0;
            if (Constants.BULLET.RADIUS && Constants.BULLET.RADIUS.px) {
                muzzle += Constants.BULLET.RADIUS.px;
            }
            if (muzzle > front) front = muzzle;
        }
        return Math.max(bodyHalf, front);
    }

    function getTankHalfLength() {
        return tankForwardHalfLengthPx() * Constants.METERS_PER_PIXEL;
    }

    /**
     * 规划/OBB 用非对称矩形包络：前向含炮管，后向仅车体。
     */
    function getTankHullHalfExtents(cfg) {
        return {
            halfW: getTankHalfWidth(),
            halfForward: getTankHalfLength(),
            halfBack: getTankBodyHalfLength()
        };
    }

    /** 包络矩形最远两角距离 = 黄圆直径 */
    function getTankMaxDiagonal(cfg) {
        var e = getTankHullHalfExtents(cfg);
        return Math.sqrt(
            (e.halfForward + e.halfBack) * (e.halfForward + e.halfBack) +
            (4 * e.halfW * e.halfW)
        );
    }

    function getTankHullHalfExtentsPx(spriteScale) {
        var s = spriteScale !== undefined ? spriteScale : 1;
        var ppm = Constants.PIXELS_PER_METER || 20;
        var e = getTankHullHalfExtents();
        return {
            hw: e.halfW * ppm * s,
            halfForward: e.halfForward * ppm * s,
            halfBack: e.halfBack * ppm * s,
            hl: e.halfForward * ppm * s
        };
    }

    function getTankBodyRadius() {
        return getTankHalfWidth();
    }

    function getTankReachExtent(cfg) {
        var diag = getTankMaxDiagonal(cfg);
        var slack = cfg.dodgeBodySlack !== undefined ? cfg.dodgeBodySlack : 0.15;
        return diag * 0.5 + getBulletBodyRadius() + slack;
    }

    function closestPointOnTankOBB(bx, by, cx, cy, rot) {
        var hull = getTankHullHalfExtents();
        var halfW = hull.halfW;
        var halfF = hull.halfForward;
        var halfB = hull.halfBack;
        var dx = bx - cx;
        var dy = by - cy;
        var fX = Math.sin(rot);
        var fY = -Math.cos(rot);
        var rX = Math.cos(rot);
        var rY = Math.sin(rot);
        var localF = dx * fX + dy * fY;
        var localR = dx * rX + dy * rY;
        if (localF > halfF) localF = halfF;
        else if (localF < -halfB) localF = -halfB;
        if (localR > halfW) localR = halfW;
        else if (localR < -halfW) localR = -halfW;
        return {
            x: cx + fX * localF + rX * localR,
            y: cy + fY * localF + rY * localR
        };
    }

    function bulletMarginToTankAt(bx, by, cx, cy, rot, cfg) {
        var cp = closestPointOnTankOBB(bx, by, cx, cy, rot);
        var dx = bx - cp.x;
        var dy = by - cp.y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        var slack = cfg.dodgeBodySlack !== undefined ? cfg.dodgeBodySlack : 0.15;
        return dist - getBulletBodyRadius() - slack;
    }

    function getBulletBodyRadius() {
        return Constants.BULLET.RADIUS.m;
    }
    function minDistancePointToSegment(px, py, ax, ay, bx, by) {
        var dx = bx - ax;
        var dy = by - ay;
        var len2 = dx * dx + dy * dy;
        var u = len2 > 0.0001 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
        if (u < 0) u = 0;
        else if (u > 1) u = 1;
        var cx = ax + u * dx;
        var cy = ay + u * dy;
        dx = px - cx;
        dy = py - cy;
        return Math.sqrt(dx * dx + dy * dy);
    }
    var TWO_PI = Math.PI * 2;

    /** 与 OBB 包络一致的凸四边形（车体矩形 + 炮管前伸） */
    function getTankHeptagonLocal(cfg) {
        var e = getTankHullHalfExtents(cfg);
        var hw = e.halfW;
        var hf = e.halfForward;
        var hb = e.halfBack;
        return [
            { f: -hb, r: -hw },
            { f: -hb, r: hw },
            { f: hf, r: hw },
            { f: hf, r: -hw }
        ];
    }

    function localToWorldOffset(lf, lr, rot) {
        var s = Math.sin(rot);
        var c = Math.cos(rot);
        return { x: s * lf + c * lr, y: -c * lf + s * lr };
    }

    function heptagonWorldVertices(cx, cy, rot, localVerts) {
        var out = [];
        var i, o;
        for (i = 0; i < localVerts.length; i++) {
            o = localToWorldOffset(localVerts[i].f, localVerts[i].r, rot);
            out.push({ x: cx + o.x, y: cy + o.y });
        }
        return out;
    }

    function pointToConvexPolygonDist(px, py, verts) {
        var minD = Number.MAX_VALUE;
        var i, j, d;
        for (i = 0; i < verts.length; i++) {
            j = (i + 1) % verts.length;
            d = minDistancePointToSegment(px, py, verts[i].x, verts[i].y, verts[j].x, verts[j].y);
            if (d < minD) minD = d;
        }
        return minD;
    }

    function pointInConvexPolygon(px, py, verts) {
        var n = verts.length;
        var i, j, cp, sign = 0;
        for (i = 0; i < n; i++) {
            j = (i + 1) % n;
            cp = (verts[j].x - verts[i].x) * (py - verts[i].y) -
                (verts[j].y - verts[i].y) * (px - verts[i].x);
            if (Math.abs(cp) < 1e-9) continue;
            if (sign === 0) sign = cp > 0 ? 1 : -1;
            else if ((cp > 0 ? 1 : -1) !== sign) return false;
        }
        return true;
    }

    function marginHeptagonAtRotation(cx, cy, theta, bx, by, localVerts, cfg) {
        var verts = heptagonWorldVertices(cx, cy, theta, localVerts);
        var dist = pointToConvexPolygonDist(bx, by, verts);
        var slack = cfg.dodgeBodySlack !== undefined ? cfg.dodgeBodySlack : 0.15;
        var expand = getBulletBodyRadius() + slack;
        if (pointInConvexPolygon(bx, by, verts)) {
            return -dist - expand;
        }
        return dist - expand;
    }

    function combinedMarginAtRotation(cx, cy, theta, bullets, localVerts, cfg) {
        var minM = Number.MAX_VALUE;
        var i, m;
        for (i = 0; i < bullets.length; i++) {
            m = marginHeptagonAtRotation(
                cx, cy, theta, bullets[i].x, bullets[i].y, localVerts, cfg
            );
            if (m < minM) minM = m;
        }
        return minM;
    }

    function safetyRotationSampleCount(cfg) {
        return cfg.safetyRotationSamples !== undefined ? cfg.safetyRotationSamples : 12;
    }

    /** 离散朝向采样求 margin 包络（仅用于脚下单点分类，O(angles×bullets)） */
    function marginEnvelopeOverRotation(cx, cy, bullets, localVerts, cfg) {
        var count = safetyRotationSampleCount(cfg);
        var globalMin = Number.MAX_VALUE;
        var globalMax = -Number.MAX_VALUE;
        var i, m, theta;
        for (i = 0; i < count; i++) {
            theta = i * TWO_PI / count;
            m = combinedMarginAtRotation(cx, cy, theta, bullets, localVerts, cfg);
            if (m < globalMin) globalMin = m;
            if (m > globalMax) globalMax = m;
        }
        return { min: globalMin, max: globalMax };
    }

    /**
     * 双圆半径（以子弹为圆心）：
     * 红：半径 = 半宽 → 直径 = 车宽
     * 黄：半径 = 包络最大对角线/2 → 覆盖斜向碰弹假安全区
     */
    function getTankZoneRadii(localVerts, cfg) {
        cfg = cfg || getCfg();
        return {
            abs: getTankHalfWidth(),
            semi: getTankMaxDiagonal(cfg) * 0.5
        };
    }

    function dist2d(ax, ay, bx, by) {
        var dx = ax - bx;
        var dy = ay - by;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function pointInAnyAbsDisk(px, py, bullets, rAbs) {
        var i;
        for (i = 0; i < bullets.length; i++) {
            if (dist2d(px, py, bullets[i].x, bullets[i].y) <= rAbs + 1e-6) return true;
        }
        return false;
    }

    /** ∃弹 rAbs → 绝对；全在 rSemi 外 → 安全；否则 margin 包络。 */
    function classifyPointMultiBullet(px, py, bullets, localVerts, cfg, radii) {
        radii = radii || getTankZoneRadii(localVerts, cfg);
        if (!bullets || !bullets.length) return 0;
        if (pointInAnyAbsDisk(px, py, bullets, radii.abs)) return 2;

        var i, d, anySemi = false;
        for (i = 0; i < bullets.length; i++) {
            d = dist2d(px, py, bullets[i].x, bullets[i].y);
            if (d > radii.semi + 1e-6) continue;
            anySemi = true;
            break;
        }
        if (!anySemi) return 0;

        var env = marginEnvelopeOverRotation(px, py, bullets, localVerts, cfg);
        if (env.max < 0) return 2;
        if (env.min >= 0) return 0;
        return 1;
    }

    function buildCircleSafetyZones(bullets, localVerts, cfg) {
        var radii = getTankZoneRadii(localVerts, cfg);
        var circles = [];
        var i;
        for (i = 0; i < bullets.length; i++) {
            circles.push({
                x: bullets[i].x,
                y: bullets[i].y,
                rAbs: radii.abs,
                rSemi: radii.semi
            });
        }
        return { radii: radii, circles: circles };
    }

    function countSemiDiskHits(px, py, bullets, rSemi) {
        var n = 0;
        var i, d;
        for (i = 0; i < bullets.length; i++) {
            d = dist2d(px, py, bullets[i].x, bullets[i].y);
            if (d <= rSemi + 1e-6) n++;
        }
        return n;
    }

    /**
     * F8 可视化着色：完整黄/红圆盘 + 多黄升格
     * ∃红盘→2；无黄盘→0；≤2 层黄盘→1（整圆）；≥3 层黄盘→margin 包络
     */
    function classifySafetyZoneVisual(px, py, bullets, cfg) {
        cfg = cfg || getCfg();
        var localVerts = getTankHeptagonLocal(cfg);
        var radii = getTankZoneRadii(localVerts, cfg);
        if (pointInAnyAbsDisk(px, py, bullets, radii.abs)) return 2;
        var n = countSemiDiskHits(px, py, bullets, radii.semi);
        if (n === 0) return 0;
        if (n <= 2) return 1;
        return classifyPointMultiBullet(px, py, bullets, localVerts, cfg, radii);
    }

    /**
     * F8 脚下/单点分类（margin 包络，非整圆可视化）
     */
    function classifySafetyZoneLevel(px, py, bullets, cfg) {
        cfg = cfg || getCfg();
        var localVerts = getTankHeptagonLocal(cfg);
        return classifyPointMultiBullet(px, py, bullets, localVerts, cfg);
    }

    /**
     * 仅几何圆盘并集（无 margin 升格），调试用。
     */
    function classifySafetyDiskUnion(px, py, circles, radii) {
        if (!circles || !circles.length || !radii) return 0;
        var rAbs = radii.abs;
        var rSemi = radii.semi;
        var inSemi = false;
        var i, d;
        for (i = 0; i < circles.length; i++) {
            d = dist2d(px, py, circles[i].x, circles[i].y);
            if (d <= rAbs + 1e-6) return 2;
            if (d <= rSemi + 1e-6) inSemi = true;
        }
        return inSemi ? 1 : 0;
    }

    /** 本时刻全部在场子弹（不限 AIUtils 威胁过滤） */
    function collectInstantBulletPositions(ai, cfg) {
        var out = [];
        if (!ai || !ai.gameController) return out;
        var projectiles = ai.gameController.getProjectiles();
        if (!projectiles) return out;
        var pid, p, owner;
        for (pid in projectiles) {
            if (!projectiles.hasOwnProperty(pid)) continue;
            p = projectiles[pid];
            if (!p || !p.getX || !p.getY) continue;
            owner = p.getPlayerId ? p.getPlayerId() : (p.playerId || null);
            out.push({
                id: pid,
                x: p.getX(),
                y: p.getY(),
                playerId: owner
            });
        }
        return out;
    }

    /**
     * 单点三类（多弹 OR）：combined(θ)=min_i margin_i(θ)
     * 绝对危险 max<0；真安全 min≥0；半危险 否则。
     */
    function classifyPointRotationZones(cx, cy, bullets, localVerts, cfg) {
        var lvl = classifyPointMultiBullet(cx, cy, bullets, localVerts, cfg);
        if (lvl === 2) return 'absolute';
        if (lvl === 1) return 'semi';
        return 'safe';
    }

    /** 双圆可视化：每弹黄/红两圆；脚下分类仍用 margin 包络。 */
    function buildInstantSafetyZonesViz(ai, tank, cfg) {
        if (!ai || !tank) return null;
        cfg = cfg || getCfg();

        var bullets = collectInstantBulletPositions(ai, cfg);
        var localVerts = getTankHeptagonLocal(cfg);
        var tx = tank.getX();
        var ty = tank.getY();
        var tankClass = classifyPointRotationZones(tx, ty, bullets, localVerts, cfg);
        var tankEnv = bullets.length
            ? marginEnvelopeOverRotation(tx, ty, bullets, localVerts, cfg) : null;

        if (!bullets.length) {
            return {
                mode: 'circles',
                bulletCount: 0,
                tankClass: 'safe',
                tankEnvelope: null,
                radii: null,
                circles: [],
                bullets: []
            };
        }

        var zones = buildCircleSafetyZones(bullets, localVerts, cfg);

        return {
            mode: 'circles',
            bulletCount: bullets.length,
            tankClass: tankClass,
            tankEnvelope: tankEnv,
            radii: zones.radii,
            circles: zones.circles,
            rotationSamples: safetyRotationSampleCount(cfg),
            bullets: bullets
        };
    }
    // ==================== 拷贝区结束 ====================

    // ============================================================
    // 评分与基准时间层（阶段②新增，只认沙箱适配器接口）
    // 设计见 docs/Vantage躲弹实现/02-评分与基准时间.md
    // ============================================================

    /** 本模块自己的参数默认值（与拷贝区的 tactics cfg 分开，互不污染） */
    var SCORING_DEFAULTS = {
        hitRadius: 10,          // 危险距离 D_hit（米，1 格）：威胁窗口判定圈（v4.2 固定圈一判到底）
        baseTimeMin: 0.02,      // 下限 = 1 帧（v7.1：弹快出圈时窗口自然收缩到 1 帧，
                                //   "最低 12 帧"是 v7 对已入圈弹误加 K_post 所致，已修）
        kPostSec: 0.24,         // v7 K_post = 首弹入圈后再多看的余量（秒，12 帧 = 0.24s ≈ 弹清空
                                //   坦克局部区时长：18m/s×0.24s=4.3m ≈ 车长 2 倍；防漏"躲进
                                //   弹道延长线"式死亡，又不回到 75 帧长窗老路）
        baseTimeMax: 1.5,       // 基准时间上限 T_max（秒）= 无威胁默认值
        lanePenaltyRatio: 0.5,  // v7.3 车道压分系数（主人定标"单帧影响 = 遮蔽的
                                //   0.5~1.0 倍"指【总】影响；v7.2 曾按每弹求和 +
                                //   0.75 → 多弹穿身打爆量级 → 未死亡大负分、
                                //   AI 宕机。v7.3：多弹取 max + 0.5 = "稍微"）
        deathPenalty: 100000,   // 死亡扣分（定稿，不再动）
        stuckPenalty: 4.0,      // v19：非静止操作中连续两帧位姿几乎不变 = 卡墙/被顶住，
                                //      每帧额外扣 4.0（75 帧最多 300，足够压过躲进墙角的收益）
        stuckDistEps: 0.05,     // 卡墙判定：位移 < 5cm/帧（正常前进≈32cm/帧）
        stuckRotEps: 0.05,      // 且转角 < 0.05 rad/帧（正常转向=0.1 rad/帧）
        rotationSamples: 72,    // 遮蔽角朝向采样数（5°/步；调试器渲染用 360）
        densityA: 1.0,          // 密集权重系数 a（v4 起仅供 details 参考，不进基准公式）
        densityB: 3.0,          // 密集权重衰减 b（仅供 details 参考）
        pathBounces: 5,         // 子弹折线反弹次数（恢复原值；折线角弹越多次误差越大）
        pathMaxLenTiles: 30,    // 子弹折线最大长度（格数）
        springRopeEnabled: false,     // v27：弹簧绳修复后暂默认关，面板可开
        springRopeDNear: 4,           // v25：距离权重饱和近距（米）
        springRopeDRef: 30,           // v25：距离权重归零参考距（米）
        springRopeClearanceCap: 8.0   // v25：单帧距离分上限（约角度满分 20%）
    };

    function mergeCfg(overrides) {
        var cfg = {};
        var k;
        for (k in SCORING_DEFAULTS) {
            if (SCORING_DEFAULTS.hasOwnProperty(k)) cfg[k] = SCORING_DEFAULTS[k];
        }
        if (overrides) {
            for (k in overrides) {
                if (overrides.hasOwnProperty(k)) cfg[k] = overrides[k];
            }
        }
        return cfg;
    }

    // ------------------------------------------------------------
    // 弹簧绳距离评分（v25）
    // ------------------------------------------------------------

    var _mazeWallEnvCacheMaze = null;
    var _mazeWallEnvCacheEnv = null;

    function _rect(minX, minY, maxX, maxY) {
        return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
    }

    function _intervalsOverlapOrTouch(a0, a1, b0, b1) {
        return a0 <= b1 + 1e-9 && b0 <= a1 + 1e-9;
    }

    /** 合并共线且贴合/重叠的轴对齐矩形，仅合并同向长条。 */
    function mergeMazeRects(rects) {
        var out = rects.slice();
        var changed = true;
        var i, j, a, b, merged;
        while (changed) {
            changed = false;
            for (i = 0; i < out.length; i++) {
                a = out[i];
                for (j = i + 1; j < out.length; j++) {
                    b = out[j];
                    if (Math.abs(a.minY - b.minY) < 1e-9 &&
                        Math.abs(a.maxY - b.maxY) < 1e-9 &&
                        _intervalsOverlapOrTouch(a.minX, a.maxX, b.minX, b.maxX)) {
                        merged = _rect(
                            Math.min(a.minX, b.minX),
                            a.minY,
                            Math.max(a.maxX, b.maxX),
                            a.maxY
                        );
                        out.splice(j, 1);
                        out[i] = merged;
                        changed = true;
                        break;
                    }
                    if (Math.abs(a.minX - b.minX) < 1e-9 &&
                        Math.abs(a.maxX - b.maxX) < 1e-9 &&
                        _intervalsOverlapOrTouch(a.minY, a.maxY, b.minY, b.maxY)) {
                        merged = _rect(
                            a.minX,
                            Math.min(a.minY, b.minY),
                            a.maxX,
                            Math.max(a.maxY, b.maxY)
                        );
                        out.splice(j, 1);
                        out[i] = merged;
                        changed = true;
                        break;
                    }
                }
                if (changed) break;
            }
        }
        return out;
    }

    /**
     * 解析 maze 为轴对齐填充矩形数组（纯 JS）。
     * 口径与 B2DUtils.createMaze 的连续墙 collider 对齐：
     *   tile[1]=顶墙 → 横向矩形；tile[2]=左墙 → 纵向矩形；
     *   最右/最下边界由 tile[0] 补齐。矩形合并共线贴合段；
     *   交叉处允许重叠，几何位置贴合真实 Box2D 墙。
     */
    function getMazeWallEnv(adapter) {
        if (!adapter || typeof adapter.getMaze !== 'function') {
            return { rects: [], width: 0, height: 0, corners: [], cornerKeyToIndex: {}, cornerVisibility: [] };
        }
        var maze = adapter.getMaze();
        if (!maze) return { rects: [], width: 0, height: 0, corners: [], cornerKeyToIndex: {}, cornerVisibility: [] };
        if (_mazeWallEnvCacheMaze === maze) return _mazeWallEnvCacheEnv;

        var tiles = maze.getTiles ? maze.getTiles() : null;
        var width = maze.getWidth ? maze.getWidth() : (tiles ? tiles.length : 0);
        var height = maze.getHeight ? maze.getHeight()
            : (tiles && tiles[0] ? tiles[0].length : 0);
        if (!tiles || !width || !height) {
            var empty = {
                rects: [], width: width, height: height,
                corners: [], cornerKeyToIndex: {}, cornerVisibility: []
            };
            _mazeWallEnvCacheMaze = maze;
            _mazeWallEnvCacheEnv = empty;
            return empty;
        }

        var T = Constants.MAZE_TILE_SIZE.m;
        var W = Constants.MAZE_WALL_WIDTH.m;
        var hw = W * 0.5;
        var rects = [];
        var i, j;
        for (i = 0; i < width; i++) {
            for (j = 0; j < height; j++) {
                if (tiles[i][j][1] === 1) {
                    rects.push(_rect(
                        i * T - hw,
                        j * T - hw,
                        (i + 1) * T + hw,
                        j * T + hw
                    ));
                }
                if (tiles[i][j][2] === 1) {
                    rects.push(_rect(
                        i * T - hw,
                        j * T - hw,
                        i * T + hw,
                        (j + 1) * T + hw
                    ));
                }
            }
        }
        var lastI = width - 1;
        var lastJ = height - 1;
        for (i = 0; i < width; i++) {
            if (tiles[i][lastJ][0] === 1) {
                rects.push(_rect(
                    i * T - hw,
                    height * T - hw,
                    (i + 1) * T + hw,
                    height * T + hw
                ));
            }
        }
        for (j = 0; j < height; j++) {
            if (tiles[lastI][j][0] === 1) {
                rects.push(_rect(
                    width * T - hw,
                    j * T - hw,
                    width * T + hw,
                    (j + 1) * T + hw
                ));
            }
        }

        var mergedRects = mergeMazeRects(rects);
        // v27：去重角点 + 预计算角点两两可见性（只按 maze 缓存一次）。
        var corners = [];
        var cornerKeyToIndex = {};
        var ci, cj, cr, cx0, cy0, cx1, cy1, key;
        for (ci = 0; ci < mergedRects.length; ci++) {
            cr = mergedRects[ci];
            cx0 = cr.minX; cy0 = cr.minY;
            cx1 = cr.maxX; cy1 = cr.maxY;
            key = cx0.toFixed(6) + ',' + cy0.toFixed(6);
            if (!cornerKeyToIndex.hasOwnProperty(key)) {
                cornerKeyToIndex[key] = corners.length;
                corners.push({ x: cx0, y: cy0 });
            }
            key = cx1.toFixed(6) + ',' + cy0.toFixed(6);
            if (!cornerKeyToIndex.hasOwnProperty(key)) {
                cornerKeyToIndex[key] = corners.length;
                corners.push({ x: cx1, y: cy0 });
            }
            key = cx0.toFixed(6) + ',' + cy1.toFixed(6);
            if (!cornerKeyToIndex.hasOwnProperty(key)) {
                cornerKeyToIndex[key] = corners.length;
                corners.push({ x: cx0, y: cy1 });
            }
            key = cx1.toFixed(6) + ',' + cy1.toFixed(6);
            if (!cornerKeyToIndex.hasOwnProperty(key)) {
                cornerKeyToIndex[key] = corners.length;
                corners.push({ x: cx1, y: cy1 });
            }
        }
        var cornerVisibility = [];
        for (ci = 0; ci < corners.length; ci++) {
            cornerVisibility[ci] = [];
            for (cj = 0; cj < corners.length; cj++) {
                if (ci === cj) continue;
                if (segmentIsClear(corners[ci].x, corners[ci].y,
                        corners[cj].x, corners[cj].y, mergedRects)) {
                    cornerVisibility[ci].push({
                        to: cj,
                        len: _dist(corners[ci].x, corners[ci].y,
                            corners[cj].x, corners[cj].y)
                    });
                }
            }
        }

        var env = {
            rects: mergedRects,
            width: width,
            height: height,
            corners: corners,
            cornerKeyToIndex: cornerKeyToIndex,
            cornerVisibility: cornerVisibility
        };
        _mazeWallEnvCacheMaze = maze;
        _mazeWallEnvCacheEnv = env;
        return env;
    }

    function _dist2(ax, ay, bx, by) {
        var dx = bx - ax;
        var dy = by - ay;
        return dx * dx + dy * dy;
    }

    function _dist(ax, ay, bx, by) {
        return Math.sqrt(_dist2(ax, ay, bx, by));
    }

    /**
     * 线段是否进入矩形内部（贴边/贴角允许通过）。
     * 用 Liang-Barsky 开区间判断，线段与边界重合不算进入内部。
     */
    function segmentEntersRectInterior(ax, ay, bx, by, r) {
        var dx = bx - ax;
        var dy = by - ay;
        var t0 = 0;
        var t1 = 1;
        var tx0, tx1, ty0, ty1, tmp;

        if (Math.abs(dx) < 1e-12) {
            if (ax <= r.minX || ax >= r.maxX) return false;
        } else {
            tx0 = (r.minX - ax) / dx;
            tx1 = (r.maxX - ax) / dx;
            if (tx0 > tx1) { tmp = tx0; tx0 = tx1; tx1 = tmp; }
            if (tx0 > t0) t0 = tx0;
            if (tx1 < t1) t1 = tx1;
            if (t0 >= t1) return false;
        }

        if (Math.abs(dy) < 1e-12) {
            if (ay <= r.minY || ay >= r.maxY) return false;
        } else {
            ty0 = (r.minY - ay) / dy;
            ty1 = (r.maxY - ay) / dy;
            if (ty0 > ty1) { tmp = ty0; ty0 = ty1; ty1 = tmp; }
            if (ty0 > t0) t0 = ty0;
            if (ty1 < t1) t1 = ty1;
            if (t0 >= t1) return false;
        }

        return t0 < 1 && t1 > 0;
    }

    function segmentIsClear(ax, ay, bx, by, rects) {
        var minX = ax < bx ? ax : bx;
        var maxX = ax > bx ? ax : bx;
        var minY = ay < by ? ay : by;
        var maxY = ay > by ? ay : by;
        for (var i = 0; i < rects.length; i++) {
            var r = rects[i];
            // 包围盒粗筛：线段 AABB 与墙矩形不相交则不可能进入内部。
            if (maxX <= r.minX || minX >= r.maxX ||
                maxY <= r.minY || minY >= r.maxY) continue;
            if (segmentEntersRectInterior(ax, ay, bx, by, r)) return false;
        }
        return true;
    }

    function _addCandidate(points, seen, x, y) {
        var key = x.toFixed(6) + ',' + y.toFixed(6);
        if (seen[key]) return;
        seen[key] = true;
        points.push({ x: x, y: y });
    }

    function astarSpringRope(env, points, cornerIdx, goal) {
        var rects = env.rects;
        var n = points.length;
        var g = new Array(n);
        var f = new Array(n);
        var closed = new Array(n);
        var open = [];
        var i, j, best, bestF, cur, gNew, ci, cj, vi, edgeLen;
        for (i = 0; i < n; i++) {
            g[i] = Infinity;
            f[i] = Infinity;
            closed[i] = false;
        }
        g[0] = 0;
        f[0] = _dist(points[0].x, points[0].y, points[goal].x, points[goal].y);
        open.push(0);
        while (open.length) {
            best = -1;
            bestF = Infinity;
            for (i = 0; i < open.length; i++) {
                if (f[open[i]] < bestF) {
                    bestF = f[open[i]];
                    best = i;
                }
            }
            cur = open.splice(best, 1)[0];
            if (cur === goal) return g[goal];
            if (closed[cur]) continue;
            closed[cur] = true;
            ci = cornerIdx[cur];
            for (j = 0; j < n; j++) {
                if (j === cur || closed[j]) continue;
                cj = cornerIdx[j];
                edgeLen = null;
                if (ci >= 0 && cj >= 0) {
                    // 角点-角点直接查预计算可见性表。
                    var vis = env.cornerVisibility[ci];
                    for (vi = 0; vi < vis.length; vi++) {
                        if (vis[vi].to === cj) { edgeLen = vis[vi].len; break; }
                    }
                    if (edgeLen === null) continue;
                } else {
                    if (!segmentIsClear(points[cur].x, points[cur].y,
                            points[j].x, points[j].y, rects)) continue;
                    edgeLen = _dist(points[cur].x, points[cur].y,
                        points[j].x, points[j].y);
                }
                gNew = g[cur] + edgeLen;
                if (gNew < g[j]) {
                    g[j] = gNew;
                    f[j] = gNew + _dist(points[j].x, points[j].y,
                        points[goal].x, points[goal].y);
                    open.push(j);
                }
            }
        }
        return Infinity;
    }

    /** 弹簧绳长度：A 到 B 在墙外可见图中的最短路；直线不穿墙时返回欧氏距离。 */
    function springRopeLength(adapter, ax, ay, bx, by, dRef) {
        var env = getMazeWallEnv(adapter);
        var euclid = _dist(ax, ay, bx, by);
        if (!env.rects.length) return euclid;
        if (segmentIsClear(ax, ay, bx, by, env.rects)) return euclid;

        if (dRef === undefined || dRef === null) dRef = SCORING_DEFAULTS.springRopeDRef;
        var points = [{ x: ax, y: ay }, { x: bx, y: by }];
        var cornerIdx = [-1, -1];
        var seen = {};
        var i, c, before;
        seen[ax.toFixed(6) + ',' + ay.toFixed(6)] = true;
        seen[bx.toFixed(6) + ',' + by.toFixed(6)] = true;
        for (i = 0; i < env.corners.length; i++) {
            c = env.corners[i];
            if (_dist(ax, ay, c.x, c.y) <= dRef || _dist(bx, by, c.x, c.y) <= dRef) {
                before = points.length;
                _addCandidate(points, seen, c.x, c.y);
                if (points.length > before) cornerIdx.push(i);
            }
        }
        return astarSpringRope(env, points, cornerIdx, 1);
    }

    /** 单帧弹簧绳距离分：多弹概率式合成后乘 clearanceCap。 */
    function springRopeFrameScore(adapter, tankState, threats, tGlobalSec, cfg) {
        cfg = mergeCfg(cfg);
        if (!cfg.springRopeEnabled) return 0;
        if (!threats || !threats.length || !tankState) return 0;
        var product = 1;
        var i, pos, d, w;
        for (i = 0; i < threats.length; i++) {
            var th = threats[i];
            if (!th) continue;
            pos = threatBulletPos(adapter, th, tGlobalSec);
            if (!pos) continue;
            d = _dist(tankState.x, tankState.y, pos.x, pos.y);
            if (d >= cfg.springRopeDRef) continue;
            d = springRopeLength(adapter, tankState.x, tankState.y, pos.x, pos.y, cfg.springRopeDRef);
            w = (cfg.springRopeDRef - d) / (cfg.springRopeDRef - cfg.springRopeDNear);
            if (w < 0) w = 0;
            else if (w > 1) w = 1;
            product *= (1 - w);
            if (w >= 1) return cfg.springRopeClearanceCap;
        }
        return cfg.springRopeClearanceCap * (1 - product);
    }


    // ------------------------------------------------------------
    // 遮蔽角 / 剩余角
    // ------------------------------------------------------------

    // ==================== 拷贝区2 开始（无墙壁子弹危险区域调试器.html 逐字节复制，勿手改） ====================
    // 来源：项目根目录 无墙壁子弹危险区域调试器.html
    //   L104-114 常量推导 / L226-393 testPointExact + mergeIntervals/findGaps/testArc
    //   + testTankCollision（L381-392，仅检验器交叉验证用，已移入遮蔽角数值检验器.html）
    // v5 定稿（2026-08-15 主人指认）：遮蔽角数值正主 = testPointExact 精确解析法
    //   （asin 半角 + sin/cos 角带求交 + 区间合并，输出精确弧段边界）；
    //   drawBlockedArcs 的 360 采样只是渲染近似，v4.2 曾改用的 72 采样
    //   （5°量化 + 矩形中心错位 0.375m）是"细分错误角度"的双重根因，均已废弃。

    /** 对称矩形几何常量（与调试器同公式：前伸含炮口，总高中点对称） */
    function exactGeom() {
        var bulletR = Constants.BULLET.RADIUS.m;
        var halfW = Constants.TANK.WIDTH.m * 0.5;
        var halfBack = Constants.TANK.HEIGHT.m * 0.5;
        var halfForward = Math.max(halfBack,
            Math.abs(Constants.BULLET_TURRET.OFFSET_Y.m) + Constants.BULLET_TURRET.HEIGHT.m * 0.5,
            Constants.BULLET.OFFSET.m + bulletR);
        var rectHalfH = (halfForward + halfBack) * 0.5;
        return {
            HALF_W: halfW,
            RECT_HALF_H: rectHalfH,
            EFF_HALF_W: halfW + bulletR,
            EFF_HALF_H: rectHalfH + bulletR,
            R_ABS: halfW + bulletR,
            R_SEMI: Math.sqrt(rectHalfH * rectHalfH + halfW * halfW) + bulletR,
            // 车体中心 → 对称矩形几何中心的偏移（沿朝向朝前，调试器 L109 同公式）
            GEO_OFFSET: (halfForward - halfBack) * 0.5
        };
    }

    // 调试器同名全局常量与 testTankCollision（L381-392）已随采样法一并废弃，
    // 交叉验证用副本在根目录《遮蔽角数值检验器.html》。

function norm(a) { while(a>Math.PI) a-=2*Math.PI; while(a<-Math.PI) a+=2*Math.PI; return a; }

function gapWidth(g) {
    var w = norm(g.end - g.start);
    return w < 0 ? w + 2*Math.PI : w;
}
function gapCenter(g) {
    var w = gapWidth(g);
    return norm(g.start + w/2);
}

function mergeIntervals(intervals) {
    if (intervals.length === 0) return [];
    // 标准化到 [0, 2π)
    var evts = [];
    for (var i = 0; i < intervals.length; i++) {
        var s = intervals[i].start, e = intervals[i].end;
        // 标准化
        while (s < 0) s += 2*Math.PI;
        while (s >= 2*Math.PI) s -= 2*Math.PI;
        while (e < 0) e += 2*Math.PI;
        while (e >= 2*Math.PI) e -= 2*Math.PI;

        if (s <= e) {
            evts.push({type:'s', a:s, idx:i}, {type:'e', a:e, idx:i});
        } else {
            // 跨越0: [s, 2π) ∪ [0, e]
            evts.push({type:'s', a:0, idx:i}, {type:'e', a:e, idx:i});
            evts.push({type:'s', a:s, idx:i}, {type:'e', a:2*Math.PI, idx:i});
        }
    }
    evts.sort(function(a,b) { return a.a - b.a || (a.type === 's' ? -1 : 1); });

    var merged = [], depth = 0, curStart = -1;
    for (var i = 0; i < evts.length; i++) {
        if (evts[i].type === 's') {
            if (depth === 0) curStart = evts[i].a;
            depth++;
        } else {
            depth--;
            if (depth === 0 && curStart >= 0) {
                merged.push({start: curStart, end: evts[i].a});
                curStart = -1;
            }
        }
    }

    // 合并首尾相连
    if (merged.length >= 2) {
        var first = merged[0], last = merged[merged.length-1];
        if (Math.abs(first.start) < 0.001 && Math.abs(last.end - 2*Math.PI) < 0.001) {
            merged[0] = {start: last.start, end: first.end};
            merged.pop();
        }
    }
    return merged;
}

function findGaps(merged) {
    if (merged.length === 0) return [{start:0, end:2*Math.PI}];
    var gaps = [];
    for (var i = 0; i < merged.length-1; i++)
        gaps.push({start: merged[i].end, end: merged[i+1].start});
    // 首尾间隙
    var first = merged[0], last = merged[merged.length-1];
    if (first.start > 0.001 || last.end < 2*Math.PI - 0.001) {
        if (last.end < 2*Math.PI - 0.001 || first.start > 0.001)
            gaps.push({start: last.end, end: first.start + 2*Math.PI});
    }
    return gaps;
}

function testArc(rawArcs, aLo, aHi, bLo, bHi, theta, idx, dist, aW, aH, TPI) {
    var lo = Math.max(aLo, bLo);
    var hi = Math.min(aHi, bHi);
    if (lo >= hi - 1e-9) return;
    lo = ((lo % TPI) + TPI) % TPI;
    hi = ((hi % TPI) + TPI) % TPI;
    if (lo < hi) {
        rawArcs.push({ start: lo, end: hi, phi: theta, beta: Math.max(aW,aH), idx: idx, dist: dist });
    } else {
        rawArcs.push({ start: lo, end: TPI, phi: theta, beta: Math.max(aW,aH), idx: idx, dist: dist });
        rawArcs.push({ start: 0, end: hi, phi: theta, beta: Math.max(aW,aH), idx: idx, dist: dist });
    }
}

    /** 区间角归一化到 [0, 2π)（角度与游戏 rot 同 convention：矩形宽轴角 = 游戏 rot，已推导验证） */
    function normAngle(a) {
        var T = Math.PI * 2;
        return ((a % T) + T) % T;
    }

    /**
     * 精确矩形角度遮蔽（testPointExact 同源，bullets 作参数）。
     * 返回 {freeIntervals:[{start,end,width}...], occludedRad}
     * 全遮蔽 → freeIntervals=[]；无威胁 → 整圆一段。
     */
    function exactOcclusion(px, py, bulletsArr) {
        var TPI = Math.PI * 2;
        var i, dx, dy;
        if (!bulletsArr || bulletsArr.length === 0) {
            return { freeIntervals: [{ start: 0, end: TPI, width: TPI }], occludedRad: 0 };
        }
        for (i = 0; i < bulletsArr.length; i++) {
            dx = px - bulletsArr[i].x; dy = py - bulletsArr[i].y;
            if (dx * dx + dy * dy < exactGeom().R_ABS * exactGeom().R_ABS) {
                return { freeIntervals: [], occludedRad: TPI };   // 在红圆内 → 全遮蔽
            }
        }
        var inSemi = false;
        var geo = exactGeom();
        for (i = 0; i < bulletsArr.length; i++) {
            dx = px - bulletsArr[i].x; dy = py - bulletsArr[i].y;
            if (dx * dx + dy * dy < geo.R_SEMI * geo.R_SEMI) { inSemi = true; break; }
        }
        if (!inSemi) {
            return { freeIntervals: [{ start: 0, end: TPI, width: TPI }], occludedRad: 0 };
        }

        var rawArcs = [];
        for (i = 0; i < bulletsArr.length; i++) {
            var b = bulletsArr[i];
            dx = b.x - px; dy = b.y - py;
            var D = Math.sqrt(dx * dx + dy * dy);
            if (D <= 1e-9) continue;
            var aW = Math.asin(Math.min(1, geo.EFF_HALF_W / D));
            var aH = Math.asin(Math.min(1, geo.EFF_HALF_H / D));
            if (aW + aH < Math.PI / 2 - 1e-9) continue;
            if (aW >= Math.PI / 2 - 1e-9) {
                rawArcs.push({ start: 0, end: TPI, phi: Math.atan2(dy, dx), beta: Math.PI / 2, idx: i, dist: D });
                continue;
            }
            var theta = Math.atan2(dy, dx);
            var sinB = [theta - aW, theta + aW, theta + Math.PI - aW, theta + Math.PI + aW];
            var cosB = [theta + Math.PI/2 - aH, theta + Math.PI/2 + aH, theta + 3*Math.PI/2 - aH, theta + 3*Math.PI/2 + aH];
            for (var sa = 0; sa < 4; sa += 2) {
                for (var sb = 0; sb < 4; sb += 2) {
                    // 直接交集
                    testArc(rawArcs, sinB[sa], sinB[sa+1], cosB[sb], cosB[sb+1], theta, i, D, aW, aH, TPI);
                    // sin +2π 移位
                    testArc(rawArcs, sinB[sa]+TPI, sinB[sa+1]+TPI, cosB[sb], cosB[sb+1], theta, i, D, aW, aH, TPI);
                    // cos -2π 移位
                    testArc(rawArcs, sinB[sa], sinB[sa+1], cosB[sb]-TPI, cosB[sb+1]-TPI, theta, i, D, aW, aH, TPI);
                }
            }
        }

        var merged = mergeIntervals(rawArcs);
        var gaps = findGaps(merged);
        var free = [];
        var freeRad = 0;
        // 角度换算（v3.1 修正）：弧段角 ψ = 前向轴在（x右/y下）atan2 坐标系的角度，
        // 游戏 rot 的前向向量 (sin rot, −cos rot) 的 atan2 角 = rot − π/2，
        // 故 rot = ψ + 90°。已用算例验证：子弹在正右 2.8m 时，四段遮蔽弧 +90° 后
        // 恰好落在车体四角指向来弹的 rot（57.7°/122.3°/237.7°/302.3°）。
        // 区间转换保持宽度：起点归一化到 [0,2π)，终点 = 起点 + 宽度（可超 2π，
        // 回绕由 headingInFreeIntervals / drawWedge 按周期性处理）。
        var ROT_SHIFT = Math.PI / 2;
        for (i = 0; i < gaps.length; i++) {
            var w = gapWidth(gaps[i]);
            if (w <= 1e-9) continue;
            var s = normAngle(gaps[i].start + ROT_SHIFT);
            free.push({ start: s, end: s + w, width: w });
            freeRad += w;
        }
        return { freeIntervals: free, occludedRad: TPI - freeRad };
    }
    // ==================== 拷贝区2 结束 ====================

    /**
     * 遮蔽角几何（v5：精确解析法正主 = 拷贝区2 exactOcclusion）。
     * 关键修正①：v4.2 采样法（72 样本 5° 量化）废弃——边界误差直达 ±2.5°，
     *   是主人实测"细分错误角度"根因之一。
     * 关键修正②：对称矩形以几何中心为中心（调试器 L109 GEO_OFFSET），
     *   车体中心须沿朝向前移 0.375m 再算——此前直接用车体中心，
     *   遮蔽几何整体前移，近距离角度边界系统性偏差。
     * @param {Object} tankState - {x, y, rot}（车体中心位姿，游戏坐标）
     * @param {Array} bulletPositions - [{x, y}...]
     * @param {Object} cfg - 本模块参数（保留 rotationSamples 字段但已不使用）
     * @returns {Object} {exact, freeIntervals, occludedRad, sampleCount}
     */
    function occlusionIntervals(tankState, bulletPositions, cfg) {
        cfg = mergeCfg(cfg);
        var geo = exactGeom();
        // 车体中心 → 几何中心（沿朝向前移 GEO_OFFSET；游戏朝向向量 (sin, -cos)）
        var gx = tankState.x + Math.sin(tankState.rot) * geo.GEO_OFFSET;
        var gy = tankState.y - Math.cos(tankState.rot) * geo.GEO_OFFSET;
        // v23 性能：exactOcclusion 的数学保证——R_SEMI 之外的子弹不可能产生
        // 遮蔽弧。先单趟粗筛，远弹场景（双源基准 20 弹）不必每帧每候选把
        // 全场子弹喂进角带求交；命中集合仍原样进拷贝区函数，判据零改动。
        var near = null;
        var absR2 = geo.R_ABS * geo.R_ABS;
        var semiR2 = geo.R_SEMI * geo.R_SEMI;
        var i, b, dx, dy, d2;
        if (bulletPositions && bulletPositions.length) {
            for (i = 0; i < bulletPositions.length; i++) {
                b = bulletPositions[i];
                if (!b) continue;
                dx = b.x - gx; dy = b.y - gy;
                d2 = dx * dx + dy * dy;
                if (d2 < absR2) {
                    return { exact: true, freeIntervals: [], occludedRad: TWO_PI, sampleCount: 0 };
                }
                if (d2 < semiR2) {
                    if (!near) near = [];
                    near.push(b);
                }
            }
        }
        if (!near || !near.length) {
            return {
                exact: true,
                freeIntervals: [{ start: 0, end: TWO_PI, width: TWO_PI }],
                occludedRad: 0,
                sampleCount: 0
            };
        }
        var r = exactOcclusion(gx, gy, near);
        return {
            exact: true,
            freeIntervals: r.freeIntervals,
            occludedRad: r.occludedRad,
            sampleCount: 0
        };
    }

    /** 朝向是否落在某段剩余角内（一致性断言用，处理回绕） */
    function headingInFreeIntervals(rot, freeIntervals) {
        var a = ((rot % TWO_PI) + TWO_PI) % TWO_PI;
        var i, iv, end;
        for (i = 0; i < freeIntervals.length; i++) {
            iv = freeIntervals[i];
            end = iv.end;
            if (a >= iv.start && a < Math.min(end, TWO_PI)) return true;
            if (end > TWO_PI && a < end - TWO_PI) return true; // 回绕段
        }
        return false;
    }

    // ------------------------------------------------------------
    // 单帧评分（V5 定稿：死亡走游戏同源判定，存活算剩余角平方和）
    // ------------------------------------------------------------

    /**
     * @param {Object} adapter - 沙箱适配器（死亡检测唯一权威入口）
     * @param {Object} tankState - {x, y, rot}
     * @param {Array} bulletPositions - 该帧所有子弹位置 [{x, y}...]
     * @param {Object} cfg - 本模块参数（可省略）
     * @returns {Object} {dead, frameScore, occludedRad, freeIntervals, sampleCount}
     */
    /**
     * 存活帧评分：不调用 checkDeath（批量融合世界已经判过死亡）。
     * 只在批量评分路径内使用；单路径 scorePath 仍走 scoreFrame。
     */
    function scoreFrameAlive(adapter, tankState, bulletPositions, cfg) {
        cfg = mergeCfg(cfg);
        var geo = occlusionIntervals(tankState, bulletPositions, cfg);
        var frameScore = 0;
        var i;
        for (i = 0; i < geo.freeIntervals.length; i++) {
            frameScore += geo.freeIntervals[i].width * geo.freeIntervals[i].width;
        }
        return {
            dead: false,
            frameScore: frameScore,
            occludedRad: geo.occludedRad,
            freeIntervals: geo.freeIntervals,
            sampleCount: geo.sampleCount
        };
    }

    function scoreFrame(adapter, tankState, bulletPositions, cfg) {
        cfg = mergeCfg(cfg);
        var dead = adapter.checkDeath(tankState, bulletPositions);
        if (dead) {
            return {
                dead: true,
                frameScore: -cfg.deathPenalty,
                occludedRad: TWO_PI,
                freeIntervals: [],
                sampleCount: 0
            };
        }
        return scoreFrameAlive(adapter, tankState, bulletPositions, cfg);
    }

    // ------------------------------------------------------------
    // 车道压分（v7.2 主人设计，2026-08-15）：子弹轨迹穿车，每帧叠加扣分
    // ------------------------------------------------------------

    /**
     * v7.3 车道压分：对坦克当前（模拟帧）位姿，检查每颗子弹的【未来折线】
     * 是否穿过坦克的膨胀矩形（同遮蔽角几何：中心=几何中心，边=有效半宽/半高）。
     * 穿过则扣分——轨迹离矩形中心越近、穿越弦越长，扣得越多：
     *   每弹 p = ratio × (2π)² × ( 0.5·贴心率 + 0.5·穿越弦率 )
     *   总 penalty = max(各弹 p)——多弹取最危险者而非求和（主人定标"单帧
     *   总影响 = 遮蔽的 0.5~1.0 倍"；v7.2 求和版反弹多的场景 3 弹穿身 =
     *   2.25×满分 → 未死亡大负分 → AI 宕机胡乱操作，主人打回）。
     * 物理意义：折线编码子弹远期未来，与模拟帧坦克求交 = 长视界压力信号，
     * "稍微"赋予提前看路能力（ratio=0.5）——主导权仍在遮蔽分。
     * @param {Object} tankState - {x, y, rot}（车体中心位姿，游戏坐标）
     * @param {Array} threats - computeThreats 输出（用 path/speed）
     * @param {number} tSec - 当前时刻（秒）——只取子弹在该时刻之后的折线段
     * @param {Object} cfg - 本模块参数（lanePenaltyRatio）
     * @returns {Object} {penalty, perBullet:[{id, chord, dMin, p}]}
     */
    /**
     * v23：每条 threat 的轨迹包围盒只算一次并挂在 th._laneBox 上。
     * 车道压分只在轨迹进入坦克膨胀矩形时才有非零值；若整条轨迹包围盒
     * 离矩形中心都超过安全半径，该弹这一帧可直接跳过，不用把几百个
     * 轨迹点逐段做 Liang-Barsky 裁剪。轨迹点是直线段序列，包围盒包含
     * 所有线段，因此跳过不会漏判。
     */
    function threatLaneBox(th) {
        if (th._laneBox) return th._laneBox;
        var arr = th.track && th.track.length ? th.track : (th.path || []);
        var box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
        var i, p;
        for (i = 0; i < arr.length; i++) {
            p = arr[i];
            if (!p || p.alive === false) break;
            if (p.x < box.minX) box.minX = p.x;
            if (p.x > box.maxX) box.maxX = p.x;
            if (p.y < box.minY) box.minY = p.y;
            if (p.y > box.maxY) box.maxY = p.y;
        }
        if (box.minX > box.maxX || box.minY > box.maxY) return null;
        th._laneBox = box;
        return box;
    }

    function lanePenaltyFrame(tankState, threats, tSec, cfg) {
        cfg = mergeCfg(cfg);
        var geo = exactGeom();
        var fullMax = TWO_PI * TWO_PI;   // 角度遮蔽满分 (2π)²≈39.5（freeIntervals 一段整圆）
        // 车体中心 → 矩形几何中心（沿朝向前移 GEO_OFFSET，同 occlusionIntervals）
        var cx = tankState.x + Math.sin(tankState.rot) * geo.GEO_OFFSET;
        var cy = tankState.y - Math.cos(tankState.rot) * geo.GEO_OFFSET;
        var sinR = Math.sin(tankState.rot), cosR = Math.cos(tankState.rot);
        var HW = geo.EFF_HALF_W, HH = geo.EFF_HALF_H;   // 膨胀半宽/半高（含弹半径）
        var penalty = 0;
        var perBullet = [];
        var t, i, j;
        for (t = 0; t < threats.length; t++) {
            var th = threats[t];
            if (!th) continue;
            var q = tSec - (th.anchorOffset || 0);
            if (q < 0) continue;
            // v23 粗包围盒快跳：车道压分只在轨迹离车中心足够近时才可能非零。
            var laneBox = threatLaneBox(th);
            if (!laneBox) continue;
            var skipR2 = 3.5 * 3.5;   // > 膨胀矩形半对角（≈3.16m），留 0.34m 余量
            var cbx = laneBox.minX > cx ? laneBox.minX - cx : (laneBox.maxX < cx ? laneBox.maxX - cx : 0);
            var cby = laneBox.minY > cy ? laneBox.minY - cy : (laneBox.maxY < cy ? laneBox.maxY - cy : 0);
            if (cbx * cbx + cby * cby > skipR2) {
                perBullet.push({
                    id: th.id, chord: 0,
                    dMin: Math.sqrt(cbx * cbx + cby * cby), p: 0
                });
                continue;
            }
            var pts = null;
            // v22：有 Box2D 逐帧轨迹时，车道压分不再使用 raycast 折线。
            if (th.track && th.track.length) {
                var dtTrack = 0.02;   // 轨迹帧率与 sandbox FRAME_DT 一致
                var idx0 = Math.max(0, Math.round(q / dtTrack));
                var stride = th.track.length > 96 ? 4 : 1;   // 0.08s/点，车道宽度量级足够
                pts = [];
                for (i = idx0; i < th.track.length; i += stride) {
                    var sp = th.track[i];
                    if (!sp || sp.alive === false) break;
                    pts.push({ x: sp.x, y: sp.y });
                }
                if (pts.length < 2) continue;
            } else {
                if (!th.path || th.path.length < 2 || !(th.speed > 0)) continue;
                // —— 折线上从子弹 tSec 时刻位置起的【未来段】：弧长 s0 = speed×tSec ——
                var s0 = th.speed * q;
                pts = [];          // 未来段折点（世界坐标）
                var cum = 0;
                for (i = 0; i < th.path.length - 1; i++) {
                    var a = th.path[i], b2 = th.path[i + 1];
                    var segLen = Math.sqrt((b2.x - a.x) * (b2.x - a.x) + (b2.y - a.y) * (b2.y - a.y));
                    if (segLen <= 0) continue;
                    if (cum + segLen <= s0) { cum += segLen; continue; }   // 整段已过
                    var f0 = cum >= s0 ? 0 : (s0 - cum) / segLen;          // 段内起点比例
                    pts.push({ x: a.x + (b2.x - a.x) * f0, y: a.y + (b2.y - a.y) * f0 });
                    pts.push({ x: b2.x, y: b2.y });
                    cum += segLen;
                }
                if (pts.length < 2) continue;   // 子弹已飞完折线 → 无未来段
            }
            // —— 逐段变换到矩形局部系（u=右半宽轴，v=前半高轴），裁剪求穿越弦长 ——
            var chord = 0;
            var dMin2 = Infinity;   // 折线到矩形中心最小距离²（含段外垂足）
            for (i = 0; i < pts.length - 1; i++) {
                var p0 = pts[i], p1 = pts[i + 1];
                var u0 = (p0.x - cx) * cosR + (p0.y - cy) * sinR;
                var v0 = (p0.x - cx) * sinR - (p0.y - cy) * cosR;
                var u1 = (p1.x - cx) * cosR + (p1.y - cy) * sinR;
                var v1 = (p1.x - cx) * sinR - (p1.y - cy) * cosR;
                // 段到中心(0,0)最小距离²（标准点到线段距离）
                var du = u1 - u0, dv = v1 - v0;
                var L2 = du * du + dv * dv;
                var tt = L2 > 0 ? Math.max(0, Math.min(1, -(u0 * du + v0 * dv) / L2)) : 0;
                var cu = u0 + du * tt, cv = v0 + dv * tt;
                dMin2 = Math.min(dMin2, cu * cu + cv * cv);
                // Liang-Barsky 裁剪到 [-HW,HW]×[-HH,HH]，取内部长度
                var tA = 0, tB = 1, ok = true;
                var clip = function(pD, qD) {   // pD·t ≤ qD
                    if (pD === 0) { if (qD < 0) ok = false; return; }   // 平行且界外 → 整段弃
                    var r = qD / pD;
                    if (pD < 0) { if (r > tB) { ok = false; return; } if (r > tA) tA = r; }
                    else { if (r < tA) { ok = false; return; } if (r < tB) tB = r; }
                };
                clip(-du, u0 + HW); clip(du, HW - u0);
                clip(-dv, v0 + HH); clip(dv, HH - v0);
                if (ok && tB > tA) chord += Math.sqrt(L2) * (tB - tA);
            }
            if (chord <= 1e-6) {
                perBullet.push({ id: th.id, chord: 0, dMin: Math.sqrt(dMin2), p: 0 });
                continue;   // 不穿车不扣（主人机制：穿过坦克才扣）
            }
            var dMin = Math.sqrt(dMin2);
            var prox = Math.max(0, 1 - dMin / geo.R_SEMI);            // 贴心率：过中心=1，贴边≈0.15+
            var chordFrac = Math.min(1, chord / (2 * HH));            // 弦率：纵贯=1
            var p = cfg.lanePenaltyRatio * fullMax * (0.5 * prox + 0.5 * chordFrac);
            if (p > penalty) penalty = p;   // v7.3：多弹取 max（最危险弹道），不求和
            perBullet.push({ id: th.id, chord: chord, dMin: dMin, p: p });
        }
        return { penalty: penalty, perBullet: perBullet };
    }

    // ------------------------------------------------------------
    // 威胁窗口（基准时间的第 1 层输入，v4.2 固定圈一判到底）
    // ------------------------------------------------------------

    /**
     * 对每颗子弹算「威胁窗口结束时长」（v4.3 = v4.2 固定圈 + 视界截断）：
     * 固定危险圈 = 以坦克当前位置为圆心、半径 D_hit（10m）的圆。
     * 窗口 = 子弹沿折线处于圈内的时段；tEnd = 最后一次离开圈的时刻（线性插值）。
     * 防漏论证：本游戏弹速（≥18m/s）恒大于坦克最大速（15.95m/s）——
     * 圈外的弹坦克永远追不上，圈外时段不可能发生任何操作下的相撞。
     * v4.3 修复（2026-08-15 主人实测"恒 75 帧"根因）：采样截断在
     * t > baseTimeMax（1.5s 视界）——此前对 300m 全折线（含 5 次反弹）取
     * 最后出圈时刻，封闭迷宫里反弹折线经常折返重入圈，tEnd 被拖到 8~10s，
     * 基准永远钳在上限。截断后窗口语义 = 「1.5s 视界内的威胁时段」，
     * 与 computeBaseTime 的钳制上限严格同源（视界外窗口本就不进公式）。
     * @param {Object} adapter - 沙箱适配器
     * @param {Object} tankState - {x, y, rot}
     * @param {Object} cfg - 本模块参数（hitRadius/baseTimeMax/pathBounces/pathMaxLenTiles）
     * @returns {Array} [{id, path, speed, x, y, tEnd, tIn, hasWindow, closestDist, closestX, closestY}...]
     *   tEnd = 窗口结束时长（秒）；hasWindow=false → 视界内无关弹
     *   tIn  = v7 首次进入固定圈的时刻（秒，穿入段插值；t=0 已在圈内 → 0；
     *          视界内不入圈 → null）——基准时间 min(tIn)+K_post 的输入
     */
    function computeThreats(adapter, tankState, cfg) {
        cfg = mergeCfg(cfg);
        var consts = adapter.constants;
        var maxLen = cfg.pathMaxLenTiles * consts.MAZE_TILE_SIZE;
        var paths = adapter.getProjectilePaths(cfg.pathBounces, maxLen);
        var D = cfg.hitRadius;
        var tHorizon = cfg.baseTimeMax;   // v4.3：视界 = 基准上限，窗外时段不采样
        var step = consts.MAZE_TILE_SIZE * consts.PATH_STEP_SIZE;
        var threats = [];
        var i, pp;
        for (i = 0; i < paths.length; i++) {
            pp = paths[i];
            if (!pp.path || pp.path.length < 2 || pp.speed <= 0) continue;
            var best = null;          // 折线上离坦克当前位置最近的点（威胁表/渲染用）
            var tEnd = null;          // 窗口结束时长；null = 从未入窗（无关弹）
            var tIn = null;           // v7：首次进入固定圈的时刻；null = 视界内不入圈
            var lastInT = -1;         // 最后一次处于圈内的采样时刻
            var prevIn = null;        // 上一采样是否在圈内
            var tPrev = 0, dPrev = 0;
            var cum = 0;
            var done = false;         // 视界外/首窗锁定 后停止采样该弹
            var j, k, ax, ay, bx, by, dx, dy, segLen, n, t, px, py, d;
            for (j = 0; j < pp.path.length - 1 && !done; j++) {
                ax = pp.path[j].x; ay = pp.path[j].y;
                bx = pp.path[j + 1].x; by = pp.path[j + 1].y;
                dx = bx - ax; dy = by - ay;
                segLen = Math.sqrt(dx * dx + dy * dy);
                if (segLen <= 0) continue;
                n = Math.max(1, Math.ceil(segLen / step));
                for (k = 0; k <= n; k++) {
                    var frac = k / n;
                    px = ax + dx * frac;
                    py = ay + dy * frac;
                    var L = cum + segLen * frac;
                    t = L / pp.speed;
                    if (t > tHorizon) { done = true; break; }   // 视界截断
                    var ddx = px - tankState.x, ddy = py - tankState.y;
                    d = Math.sqrt(ddx * ddx + ddy * ddy);
                    if (!best || d < best.d) best = { d: d, t: t, px: px, py: py };
                    var inD = d <= D;
                    if (inD) {
                        lastInT = t;
                        // v7：首入圈时刻 tIn（穿入段线性插值；首采样即在圈内 → 0）
                        if (tIn === null) {
                            tIn = (prevIn === false)
                                ? tPrev + (dPrev - D) / (dPrev - d) * (t - tPrev)
                                : 0;
                        }
                    } else if (prevIn === true) {
                        // 刚穿出固定圈：相邻采样间线性插值精确化
                        tEnd = tPrev + (D - dPrev) / (d - dPrev) * (t - tPrev);
                        // v4.4 首窗锁定：首次出圈即定窗——反弹折返重入圈不再拉长
                        // tEnd（主人实测"递减→重置"循环的根因；弹真弹回来时
                        // 滚动时域重算自然开新窗，此处无需追踪后续段）
                        done = true; break;
                    }
                    prevIn = inD; tPrev = t; dPrev = d;
                }
                cum += segLen;
            }
            // 视界末端仍在圈内（长追击/视界内未出窗）→ tEnd = 最后圈内时刻
            if (lastInT >= 0 && tEnd === null) tEnd = lastInT;
            threats.push({
                id: pp.id,
                path: pp.path,
                speed: pp.speed,
                x: pp.x,
                y: pp.y,
                tEnd: tEnd,
                tIn: tIn,             // v7：首入圈时刻（秒）；null = 视界内不入圈
                hasWindow: tEnd !== null,
                closestDist: best.d,
                closestX: best.px,   // 折线上离坦克当前位置最近点（渲染器画标记用）
                closestY: best.py
            });
        }

        // v28 关键兜底：任何“当前真实存在”的 projectile 都不能从视野消失。
        // getProjectilePaths 的折线健康校验可能在反弹/贴墙瞬态帧丢弃折线；
        // 旧逻辑此时 threat 为空，但树签名已经推进，接下来几帧不会再重试，
        // AI 会对真实子弹完全失明（实测：死亡瞬间 threatCount=0 而坦克被杀）。
        // 这里对缺失折线的 projectile 用“当前位置+当前速度方向”造一条
        // 短直线威胁，保证至少能看见它；后续 Box2D 轨迹会替换成精确路径。
        var seenIds = {};
        for (i = 0; i < threats.length; i++) {
            if (threats[i] && threats[i].id !== undefined) seenIds[threats[i].id] = true;
        }
        var rawProjectiles = null;
        try {
            rawProjectiles = adapter.getProjectiles ? adapter.getProjectiles() : null;
        } catch (eProj) {
            rawProjectiles = null;
        }
        if (rawProjectiles && rawProjectiles.length) {
            var pi;
            for (pi = 0; pi < rawProjectiles.length; pi++) {
                var pr = rawProjectiles[pi];
                if (!pr || pr.id === undefined || seenIds[pr.id]) continue;
                var spd = 0;
                var spx = pr.speedX || 0;
                var spy = pr.speedY || 0;
                if (spx !== 0 || spy !== 0) {
                    spd = Math.sqrt(spx * spx + spy * spy);
                } else if (typeof pr.speed === 'number') {
                    spd = pr.speed;
                }
                if (spd <= 0) continue;
                var ux = spx / spd;
                var uy = spy / spd;
                var horizon = Math.min(maxLen, spd * tHorizon);
                var fallbackPath = [
                    { x: pr.x, y: pr.y },
                    { x: pr.x + ux * horizon, y: pr.y + uy * horizon }
                ];
                var dx0 = pr.x - tankState.x;
                var dy0 = pr.y - tankState.y;
                var dNow = Math.sqrt(dx0 * dx0 + dy0 * dy0);
                var fallbackTIn = null;
                var fallbackTEnd = null;
                if (dNow <= D) {
                    fallbackTIn = 0;
                    fallbackTEnd = tHorizon;
                } else {
                    fallbackTIn = Math.max(0, (dNow - D) / spd);
                    if (fallbackTIn <= tHorizon) fallbackTEnd = Math.min(tHorizon, fallbackTIn + 0.1);
                }
                threats.push({
                    id: pr.id,
                    path: fallbackPath,
                    speed: spd,
                    x: pr.x,
                    y: pr.y,
                    tEnd: fallbackTEnd,
                    tIn: fallbackTIn,
                    hasWindow: fallbackTEnd !== null,
                    closestDist: dNow,
                    closestX: pr.x,
                    closestY: pr.y,
                    fallbackPath: true
                });
                seenIds[pr.id] = true;
            }
        }
        return threats;
    }

    // ------------------------------------------------------------
    // 基准时间（v7.1 决策段长：min(候选)，见 02 文档二·十节）
    // ------------------------------------------------------------

    /**
     * v7.1：基准时间 = 决策段长（最早威胁候选），见 02 文档二·十节。
     *   T* = clamp( min_i cand(i) , 1帧 , T_max )
     *   cand = tIn + K_post（将入圈弹：弹到后再看余量，防躲进弹道延长线）
     *        | tEnd            （已入圈弹：弹穿出圈即安全，弹快走完→窗口缩到 1 帧）
     *   无任何威胁弹（tIn 全 null）→ T_max（走位自由期，粗精度长窗）。
     * 基准弹 = 候选最早者——它决定当前决策段的倒计时；第一颗弹到达前是自由
     * 走位期（操作分化小），到达后才开始考试。恒定操作假设在短窗内重新成立，
     * "先 A 后 B"两段解由滚动时域每帧重选自然涌现（v4 max(tEnd) 被远弹绑架、
     * 贴脸仍 75 帧的结构性死因见文档）。
     * @param {Array} threats - computeThreats 的输出（v7 起每弹含 tIn）
     * @param {Object} cfg - 本模块参数（可省略）
     * @param {Object} consts - 沙箱常量表（取 FRAME_DT）
     * @returns {Object} {baseTimeSec, baseTimeFrames, baseBulletId, densityWeightSum, threatCount, details}
     */
    function computeBaseTime(threats, cfg, consts) {
        cfg = mergeCfg(cfg);
        var frameDt = consts.FRAME_DT;
        var tMax = cfg.baseTimeMax;
        // ① 收集将入圈的弹（tIn !== null；已在圈内 = 0 也算）
        var incomings = [];
        var i;
        for (i = 0; i < threats.length; i++) {
            if (threats[i].tIn !== null && threats[i].tIn !== undefined) incomings.push(threats[i]);
        }
        // ② 无弹将入圈 → 默认 = 上限（走位自由期：无死亡可能，长窗仅耗走位分）
        if (incomings.length === 0) {
            return {
                baseTimeSec: tMax,
                baseTimeFrames: Math.max(1, Math.round(tMax / frameDt)),
                baseBulletId: null,
                densityWeightSum: 0,
                threatCount: 0,
                details: {
                    hitRadius: cfg.hitRadius,
                    perBullet: perBulletDetails(threats),
                    minCandidate: null,
                    baseKind: null,
                    kPostSec: cfg.kPostSec,
                    tEndRaw: null,
                    weights: [],
                    clampedLow: false,
                    clampedHigh: false,
                    defaultUsed: true
                }
            };
        }
        // ③ v7.1 候选基准：每颗威胁弹取最早"它不再需要被看"的时刻——
        //    将入圈（tIn>0）：tIn + K_post（弹到后再看余量，防躲进弹道延长线）
        //    已在圈（tIn=0）：tEnd（弹穿出圈时刻——出圈后弹速>车速追不上=安全，
        //      折返由滚动时域开新窗兜底；视界内未出圈 → tMax）。弹快走完时
        //      候选自然趋 0 → 钳到 1 帧（主人实测"最低应 1 帧"的正确形态）
        var bestCand = null, bestIdx = -1;
        for (i = 0; i < incomings.length; i++) {
            var th = incomings[i];
            var cand = (th.tIn > 0)
                ? th.tIn + cfg.kPostSec
                : ((th.tEnd !== null && th.tEnd !== undefined) ? th.tEnd : tMax);
            if (bestCand === null || cand < bestCand) { bestCand = cand; bestIdx = i; }
        }
        // ④ T* = clamp(最早候选, T_floor=1帧, T_max)
        var tRaw = bestCand;
        var baseTime = Math.min(tMax, Math.max(cfg.baseTimeMin, tRaw));
        // ⑤ 密集权重（仅供阶段③参考，不进基准公式；锚 = 基准弹）
        var anchorTIn = incomings[bestIdx].tIn;
        var weightSum = 0;
        var weightItems = [];
        for (i = 0; i < incomings.length; i++) {
            var delta = incomings[i].tIn - anchorTIn;
            var w = cfg.densityA * Math.exp(-cfg.densityB * delta);
            weightSum += w;
            weightItems.push({ id: incomings[i].id, delta: delta, weight: w });
        }
        return {
            baseTimeSec: baseTime,
            baseTimeFrames: Math.max(1, Math.round(baseTime / frameDt)),
            baseBulletId: incomings[bestIdx].id,
            densityWeightSum: weightSum,
            threatCount: incomings.length,
            details: {
                hitRadius: cfg.hitRadius,
                perBullet: perBulletDetails(threats, incomings),
                minCandidate: tRaw,
                baseKind: incomings[bestIdx].tIn > 0 ? 'tIn+K_post' : 'tEnd(已入圈)',
                kPostSec: cfg.kPostSec,
                tEndRaw: tRaw,
                weights: weightItems,
                clampedLow: tRaw < cfg.baseTimeMin,
                clampedHigh: tRaw > tMax,
                defaultUsed: false
            }
        };
    }

    /** details.perBullet 构造：每颗子弹的窗口判定结果 */
    function perBulletDetails(threats, windows) {
        var out = [];
        for (var i = 0; i < threats.length; i++) {
            out.push({
                id: threats[i].id,
                tEnd: threats[i].tEnd,
                tIn: threats[i].tIn !== undefined ? threats[i].tIn : null,
                hasWindow: threats[i].hasWindow,
                closestDist: threats[i].closestDist
            });
        }
        return out;
    }

    // ------------------------------------------------------------
    // 路径评分（阶段③树节点的主力接口）
    // ------------------------------------------------------------

    /**
     * 从父节点状态出发，按固定操作模拟 frames 帧，逐帧评分求和。
     * 注意：samples[0] 是父节点末态（父节点已计过分），从 samples[1] 开始计。
     * @param {Object} adapter - 沙箱适配器
     * @param {Object} parentSimState - 父节点状态 {tank:{x,y,rot}, tGlobal}
     * @param {Object} inputs - 操作 {forward, back, left, right}
     * @param {number} frames - 模拟帧数
     * @param {Array} threats - 子弹折线 [{path, speed}...]（computeThreats 输出可直接用）
     * @param {Object} cfg - 本模块参数（可省略）
     * @returns {Object} {totalScore, dead, deathFrame, perFrameScores, frameCount}
     */
    /**
     * v18：子弹位置数据源选择器。
     * 树锚定后 threats 会带 track（bullet-only Box2D 逐帧轨迹）；
     * 查询严格按帧索引取最近物理帧，不做任何插值（主人要求 Box2D 数据源）。
     * 无 track 的威胁（提交切片中的过渡态/制导导弹）回退旧折线。
     */
    function threatBulletPos(adapter, th, tSec) {
        if (!th) return null;
        // v31：新弹后补进旧树时带 anchorOffset（相对旧根锚的时间偏移）。
        var q = tSec - (th.anchorOffset || 0);
        if (q < 0) return null;
        var tr = th.track;
        if (tr && tr.length) {
            var dt = (adapter && adapter.constants && adapter.constants.FRAME_DT) || 0.02;
            var idx = Math.round(q / dt);
            if (idx < 0 || idx >= tr.length) return null;   // 轨迹耗尽=预测中已消失，不回退折线
            var s = tr[idx];
            if (!s || s.alive === false) return null;
            return { x: s.x, y: s.y };
        }
        if (th.path && th.speed && adapter && adapter.bulletPosAt) {
            return adapter.bulletPosAt(th.path, th.speed, q);
        }
        return null;
    }

    /** v19 卡墙扣分：只看前后两帧位姿是否几乎没变（位移与转角都过小）。 */
    function isStuckPose(prev, cur, cfg) {
        if (!prev || !cur) return false;
        var dx = cur.x - prev.x, dy = cur.y - prev.y;
        var dist2 = dx * dx + dy * dy;
        if (dist2 > cfg.stuckDistEps * cfg.stuckDistEps) return false;
        var dr = cur.rot - prev.rot;
        dr = Math.atan2(Math.sin(dr), Math.cos(dr));
        return Math.abs(dr) < cfg.stuckRotEps;
    }

    function isMovingInputs(inputs) {
        return !!(inputs && (inputs.forward || inputs.back || inputs.left || inputs.right));
    }

    /**
     * v21：不重新模拟坦克，直接对已有 rolloutSamples 重算评分。
     * 新弹出现后 tree 用它刷新“下一段 9 候选”的 subtreeBest，
     * 让 AI 在新弹一出现就能换操作，而不是等新分数慢慢沿金线传上来。
     */
    function scoreRollout(adapter, samples, tGlobalStart, inputs, frames, threats, cfg) {
        cfg = mergeCfg(cfg);
        if (!samples || !samples.length) return null;
        var totalScore = 0;
        var perFrameScores = [];
        var dead = false;
        var deathFrame = -1;
        var moving = isMovingInputs(inputs);
        var prevPose = samples[0] || null;
        var maxI = Math.min(frames || samples.length - 1, samples.length - 1);
        for (var i = 1; i <= maxI; i++) {
            var s = samples[i];
            if (!s) break;
            var tGlobal = (tGlobalStart || 0) + i * 0.02;
            var bulletPositions = [];
            for (var b = 0; b < threats.length; b++) {
                var pos = threatBulletPos(adapter, threats[b], tGlobal);
                if (pos) bulletPositions.push(pos);
            }
            var fr = scoreFrame(adapter, { x: s.x, y: s.y, rot: s.rot }, bulletPositions, cfg);
            if (fr.dead) {
                dead = true;
                deathFrame = i;
                totalScore -= cfg.deathPenalty;
                perFrameScores.push(fr.frameScore);   // 死亡帧只记一次 -deathPenalty
                break;
            }
            var lane = lanePenaltyFrame({ x: s.x, y: s.y, rot: s.rot }, threats, tGlobal, cfg);
            var spring = springRopeFrameScore(adapter,
                { x: s.x, y: s.y, rot: s.rot }, threats, tGlobal, cfg);
            var frameNet = fr.frameScore - lane.penalty - spring;
            if (moving && isStuckPose(prevPose, s, cfg)) frameNet -= cfg.stuckPenalty;
            totalScore += frameNet;
            perFrameScores.push(frameNet);
            prevPose = s;
        }
        return {
            totalScore: totalScore,
            dead: dead,
            deathFrame: deathFrame,
            perFrameScores: perFrameScores,
            frameCount: perFrameScores.length
        };
    }


    // ------------------------------------------------------------
    // v26：scoreRolloutCached —— 评分模块增量缓存
    // ------------------------------------------------------------

    function _emptyCachedFrame() {
        return {
            activeBullets: [],
            bulletArcs: {},
            freeIntervals: [{ start: 0, end: TWO_PI, width: TWO_PI }],
            springWeights: {},
            springSurvivor: 1,
            laneByBullet: {},
            lanePenalty: 0,
            stuckPenalty: 0,
            net: 0,
            dead: false
        };
    }

    /** 把任意角度区间（start/end/width）拆成 [0,2π) 内的规范线段并合并。 */
    function _canonicalSegments(intervals) {
        var segs = [];
        var i, iv, w, s, e, rem;
        for (i = 0; i < (intervals ? intervals.length : 0); i++) {
            iv = intervals[i];
            if (!iv) continue;
            w = (iv.width !== undefined && iv.width !== null) ? iv.width : (iv.end - iv.start);
            if (w <= 1e-12) continue;
            s = ((iv.start % TWO_PI) + TWO_PI) % TWO_PI;
            e = s + w;
            if (e <= TWO_PI + 1e-9) {
                segs.push({ start: s, end: Math.min(e, TWO_PI) });
            } else {
                segs.push({ start: s, end: TWO_PI });
                rem = e - TWO_PI;
                if (rem > 1e-9) segs.push({ start: 0, end: Math.min(rem, TWO_PI) });
            }
        }
        segs.sort(function(a, b) {
            return a.start - b.start || a.end - b.end;
        });
        var merged = [];
        for (i = 0; i < segs.length; i++) {
            if (!merged.length || segs[i].start > merged[merged.length - 1].end + 1e-9) {
                merged.push({ start: segs[i].start, end: segs[i].end });
            } else if (segs[i].end > merged[merged.length - 1].end) {
                merged[merged.length - 1].end = segs[i].end;
            }
        }
        return merged;
    }

    function _cloneFreeIntervals(list) {
        var out = [];
        var i;
        for (i = 0; i < (list ? list.length : 0); i++) {
            out.push({ start: list[i].start, end: list[i].end, width: list[i].width });
        }
        return out;
    }

    /** 规范线段转回 occlusionIntervals 风格：若首段贴 0、末段贴 2π，合并成回绕区间。 */
    function _segmentsToFreeIntervals(segs) {
        var out = [];
        var i;
        if (!segs || !segs.length) return out;
        var firstAt0 = Math.abs(segs[0].start) < 1e-9;
        var lastAt2pi = Math.abs(segs[segs.length - 1].end - TWO_PI) < 1e-9;
        if (segs.length > 1 && firstAt0 && lastAt2pi) {
            var last = segs[segs.length - 1];
            var first = segs[0];
            for (i = 1; i < segs.length - 1; i++) {
                if (segs[i].end - segs[i].start > 1e-9) {
                    out.push({ start: segs[i].start, end: segs[i].end, width: segs[i].end - segs[i].start });
                }
            }
            out.push({
                start: last.start,
                end: last.start + (TWO_PI - last.start) + first.end,
                width: (TWO_PI - last.start) + first.end
            });
        } else {
            for (i = 0; i < segs.length; i++) {
                if (segs[i].end - segs[i].start > 1e-9) {
                    out.push({ start: segs[i].start, end: segs[i].end, width: segs[i].end - segs[i].start });
                }
            }
        }
        return out;
    }

    /** 单颗弹的 freeIntervals 转成“被遮蔽区间”（blocked arcs）。 */
    function _freeToBlocked(freeIntervals) {
        var segs = _canonicalSegments(freeIntervals || []);
        var blocked = [];
        var cursor = 0;
        var i;
        for (i = 0; i < segs.length; i++) {
            if (segs[i].start > cursor + 1e-9) {
                blocked.push({ start: cursor, end: segs[i].start });
            }
            if (segs[i].end > cursor) cursor = segs[i].end;
        }
        if (cursor < TWO_PI - 1e-9) {
            blocked.push({ start: cursor, end: TWO_PI });
        }
        return blocked;
    }

    /** 从 free 规范线段中减去 blocked 弧段，返回合并后的规范线段。 */
    function _subtractSegments(freeSegs, blockedArcs) {
        var out = freeSegs.slice();
        var i, j, b, seg, next;
        for (i = 0; i < (blockedArcs ? blockedArcs.length : 0); i++) {
            b = blockedArcs[i];
            next = [];
            for (j = 0; j < out.length; j++) {
                seg = out[j];
                if (b.end <= seg.start + 1e-9 || b.start >= seg.end - 1e-9) {
                    next.push(seg);
                    continue;
                }
                if (b.start <= seg.start + 1e-9 && b.end >= seg.end - 1e-9) {
                    continue;
                }
                if (b.start > seg.start + 1e-9) {
                    next.push({ start: seg.start, end: Math.min(b.start, seg.end) });
                }
                if (b.end < seg.end - 1e-9) {
                    next.push({ start: Math.max(b.end, seg.start), end: seg.end });
                }
            }
            out = next;
        }
        return _canonicalSegments(out);
    }

    /** 由剩余子弹的 blocked arcs 重新求并集后的 freeIntervals。 */
    function _freeFromBlockedMap(blockedMap) {
        var segs = [{ start: 0, end: TWO_PI }];
        var id;
        for (id in blockedMap) {
            if (blockedMap.hasOwnProperty(id)) {
                segs = _subtractSegments(segs, blockedMap[id]);
            }
        }
        return _segmentsToFreeIntervals(segs);
    }

    function _clamp01(v) {
        return v < 0 ? 0 : (v > 1 ? 1 : v);
    }

    function _activeThreatIds(adapter, samples, tGlobalStart, maxI, threats) {
        var ids = [];
        var seen = {};
        var i, b, th, tGlobal;
        for (b = 0; b < (threats ? threats.length : 0); b++) {
            th = threats[b];
            if (!th || th.id === undefined || th.id === null) continue;
            for (i = 1; i <= maxI; i++) {
                tGlobal = (tGlobalStart || 0) + i * 0.02;
                if (threatBulletPos(adapter, th, tGlobal)) {
                    ids.push(th.id);
                    break;
                }
            }
        }
        ids.sort(function(a, b) {
            return String(a) < String(b) ? -1 : (String(a) > String(b) ? 1 : 0);
        });
        return ids;
    }

    function _threatsById(threats) {
        var map = {};
        var i;
        for (i = 0; i < (threats ? threats.length : 0); i++) {
            if (threats[i]) map[threats[i].id] = threats[i];
        }
        return map;
    }

    /** 单帧全量计算，结果与 scoreRollout 同语义，并填充 cache 帧对象。 */
    function _computeCachedFrame(adapter, samples, i, tGlobalStart, threats, cfg, prevPose, moving) {
        var s = samples[i];
        if (!s) return null;
        var tGlobal = (tGlobalStart || 0) + i * 0.02;
        var tank = { x: s.x, y: s.y, rot: s.rot };
        var activeIds = [];
        var bulletPositions = [];
        var b, th, pos;
        for (b = 0; b < (threats ? threats.length : 0); b++) {
            th = threats[b];
            if (!th) continue;
            pos = threatBulletPos(adapter, th, tGlobal);
            if (pos) {
                activeIds.push(th.id);
                bulletPositions.push(pos);
            }
        }
        var fr = scoreFrame(adapter, tank, bulletPositions, cfg);
        var fc = _emptyCachedFrame();
        fc.activeBullets = activeIds;
        if (fr.dead) {
            fc.dead = true;
            fc.freeIntervals = [];
            fc.net = -cfg.deathPenalty;
            return fc;
        }

        var geo = exactGeom();
        var gx = tank.x + Math.sin(tank.rot) * geo.GEO_OFFSET;
        var gy = tank.y - Math.cos(tank.rot) * geo.GEO_OFFSET;
        var semiR2 = geo.R_SEMI * geo.R_SEMI;
        var j, id, dx, dy, dTank, dSpring, w;
        for (j = 0; j < activeIds.length; j++) {
            id = activeIds[j];
            pos = bulletPositions[j];
            dx = pos.x - gx;
            dy = pos.y - gy;
            if (dx * dx + dy * dy < semiR2) {
                var single = occlusionIntervals(tank, [pos], cfg);
                fc.bulletArcs[id] = _freeToBlocked(single.freeIntervals);
            }
            dTank = Math.sqrt((pos.x - tank.x) * (pos.x - tank.x) + (pos.y - tank.y) * (pos.y - tank.y));
            if (cfg.springRopeEnabled && dTank < cfg.springRopeDRef) {
                dSpring = springRopeLength(adapter, tank.x, tank.y, pos.x, pos.y, cfg.springRopeDRef);
                w = (cfg.springRopeDRef - dSpring) / (cfg.springRopeDRef - cfg.springRopeDNear);
                w = _clamp01(w);
                fc.springWeights[id] = w;
                fc.springSurvivor *= (1 - w);
            }
        }

        var laneRes = lanePenaltyFrame(tank, threats, tGlobal, cfg);
        var li, lp;
        for (li = 0; li < laneRes.perBullet.length; li++) {
            lp = laneRes.perBullet[li];
            fc.laneByBullet[lp.id] = lp.p;
            if (lp.p > fc.lanePenalty) fc.lanePenalty = lp.p;
        }

        if (moving && isStuckPose(prevPose, s, cfg)) {
            fc.stuckPenalty = cfg.stuckPenalty;
        }
        fc.freeIntervals = _cloneFreeIntervals(fr.freeIntervals);
        var angleScore = 0;
        var ai;
        for (ai = 0; ai < fc.freeIntervals.length; ai++) {
            angleScore += fc.freeIntervals[ai].width * fc.freeIntervals[ai].width;
        }
        var springScore = cfg.springRopeEnabled ? cfg.springRopeClearanceCap * (1 - fc.springSurvivor) : 0;
        fc.net = angleScore - springScore - fc.lanePenalty - fc.stuckPenalty;
        fc.dead = false;
        return fc;
    }

    /** 在已有存活帧 cache 上做 added/removed 增量更新。 */
    function _applyIncrementalToFrame(adapter, fc, tank, tGlobal, cfg, addedIds, removedIds, threatsById) {
        var geo = exactGeom();
        var gx = tank.x + Math.sin(tank.rot) * geo.GEO_OFFSET;
        var gy = tank.y - Math.cos(tank.rot) * geo.GEO_OFFSET;
        var semiR2 = geo.R_SEMI * geo.R_SEMI;
        var deathPrefilter = (adapter && adapter.constants && adapter.constants.DEATH_PREFILTER_RADIUS) || 4;
        var needDeathCheck = false;
        var i, id, th, pos, dx, dy, dTank, dSpring, w;

        for (i = 0; i < addedIds.length; i++) {
            id = addedIds[i];
            th = threatsById[id];
            if (!th) continue;
            pos = threatBulletPos(adapter, th, tGlobal);
            if (!pos) continue;
            if (fc.activeBullets.indexOf(id) < 0) fc.activeBullets.push(id);

            dx = pos.x - gx;
            dy = pos.y - gy;
            if (dx * dx + dy * dy < semiR2) {
                var single = occlusionIntervals(tank, [pos], cfg);
                var blocked = _freeToBlocked(single.freeIntervals);
                fc.bulletArcs[id] = blocked;
                fc.freeIntervals = _segmentsToFreeIntervals(
                    _subtractSegments(_canonicalSegments(fc.freeIntervals), blocked)
                );
            }

            dTank = Math.sqrt((pos.x - tank.x) * (pos.x - tank.x) + (pos.y - tank.y) * (pos.y - tank.y));
            if (cfg.springRopeEnabled && dTank < cfg.springRopeDRef) {
                dSpring = springRopeLength(adapter, tank.x, tank.y, pos.x, pos.y, cfg.springRopeDRef);
                w = (cfg.springRopeDRef - dSpring) / (cfg.springRopeDRef - cfg.springRopeDNear);
                w = _clamp01(w);
                fc.springWeights[id] = w;
            }

            var laneRes = lanePenaltyFrame(tank, [th], tGlobal, cfg);
            var p = laneRes.perBullet && laneRes.perBullet.length ? laneRes.perBullet[0].p : 0;
            fc.laneByBullet[id] = p;
            if (p > fc.lanePenalty) fc.lanePenalty = p;

            if (dTank <= deathPrefilter) needDeathCheck = true;
        }

        for (i = 0; i < removedIds.length; i++) {
            id = removedIds[i];
            var idx = fc.activeBullets.indexOf(id);
            if (idx >= 0) fc.activeBullets.splice(idx, 1);
            if (fc.bulletArcs.hasOwnProperty(id)) {
                delete fc.bulletArcs[id];
                fc.freeIntervals = _freeFromBlockedMap(fc.bulletArcs);
            }
            if (fc.springWeights.hasOwnProperty(id)) {
                delete fc.springWeights[id];
            }
            if (fc.laneByBullet.hasOwnProperty(id)) {
                var oldP = fc.laneByBullet[id];
                delete fc.laneByBullet[id];
                if (Math.abs(fc.lanePenalty - oldP) < 1e-12) {
                    fc.lanePenalty = 0;
                    var k;
                    for (k in fc.laneByBullet) {
                        if (fc.laneByBullet.hasOwnProperty(k) && fc.laneByBullet[k] > fc.lanePenalty) {
                            fc.lanePenalty = fc.laneByBullet[k];
                        }
                    }
                }
            }
        }

        var survivor = 1;
        var sw;
        for (sw in fc.springWeights) {
            if (fc.springWeights.hasOwnProperty(sw)) survivor *= (1 - fc.springWeights[sw]);
        }
        fc.springSurvivor = survivor;

        if (needDeathCheck) {
            var positions = [];
            var b, tid, tpos;
            for (b = 0; b < fc.activeBullets.length; b++) {
                tid = fc.activeBullets[b];
                th = threatsById[tid];
                if (!th) continue;
                tpos = threatBulletPos(adapter, th, tGlobal);
                if (tpos) positions.push(tpos);
            }
            if (adapter.checkDeath(tank, positions)) {
                fc.dead = true;
                fc.net = -cfg.deathPenalty;
                return fc;
            }
        }

        var angleScore = 0;
        var ai;
        for (ai = 0; ai < fc.freeIntervals.length; ai++) {
            angleScore += fc.freeIntervals[ai].width * fc.freeIntervals[ai].width;
        }
        var springScore = cfg.springRopeEnabled ? cfg.springRopeClearanceCap * (1 - fc.springSurvivor) : 0;
        fc.net = angleScore - springScore - fc.lanePenalty - fc.stuckPenalty;
        fc.dead = false;
        return fc;
    }

    /**
     * v26：评分模块增量缓存接口。
     * prevCache 为 null 时全量计算并写缓存；否则按 added/removed 子弹逐帧增量更新。
     * 不模拟坦克，samples 必须来自调用方已有 rolloutSamples。
     */
    function scoreRolloutCached(adapter, samples, tGlobalStart, inputs, frames, threats, cfg, prevCache) {
        cfg = mergeCfg(cfg);
        if (!samples || !samples.length) return null;
        var moving = isMovingInputs(inputs);
        var maxI = Math.min(frames || samples.length - 1, samples.length - 1);
        var totalScore = 0;
        var perFrameScores = [];
        var dead = false;
        var deathFrame = -1;
        var prevPose = samples[0] || null;

        if (!prevCache) {
            var cache0 = {
                sig: '',
                frames: [null],
                maxFrame: 0,
                events: { addedIds: [], removedIds: [] }
            };
            var currentIds0 = _activeThreatIds(adapter, samples, tGlobalStart, maxI, threats);
            cache0.sig = currentIds0.join(',');
            for (var i0 = 1; i0 <= maxI; i0++) {
                var s0 = samples[i0];
                if (!s0) break;
                var fc0 = _computeCachedFrame(adapter, samples, i0, tGlobalStart, threats, cfg, prevPose, moving);
                cache0.frames[i0] = fc0;
                if (fc0.dead) {
                    dead = true;
                    deathFrame = i0;
                    totalScore += fc0.net;
                    perFrameScores.push(fc0.net);
                    break;
                }
                totalScore += fc0.net;
                perFrameScores.push(fc0.net);
                prevPose = s0;
            }
            cache0.maxFrame = cache0.frames.length - 1;
            return {
                result: {
                    totalScore: totalScore,
                    dead: dead,
                    deathFrame: deathFrame,
                    perFrameScores: perFrameScores,
                    frameCount: perFrameScores.length
                },
                cache: cache0
            };
        }

        var cache = prevCache;
        if (!cache.frames || !cache.frames.length) cache.frames = [null];
        var oldIds = cache.sig ? String(cache.sig).split(',') : [];
        var currentIds = _activeThreatIds(adapter, samples, tGlobalStart, maxI, threats);
        var oldSet = {};
        var currentSet = {};
        var i, k;
        for (i = 0; i < oldIds.length; i++) if (oldIds[i] !== '') oldSet[oldIds[i]] = true;
        for (i = 0; i < currentIds.length; i++) currentSet[currentIds[i]] = true;
        var addedIds = [];
        var removedIds = [];
        for (i = 0; i < currentIds.length; i++) {
            if (!oldSet[currentIds[i]]) addedIds.push(currentIds[i]);
        }
        for (i = 0; i < oldIds.length; i++) {
            if (oldIds[i] !== '' && !currentSet[oldIds[i]]) removedIds.push(oldIds[i]);
        }
        var threatsById = _threatsById(threats);

        for (i = 1; i <= maxI; i++) {
            var s = samples[i];
            if (!s) break;
            var tGlobal = (tGlobalStart || 0) + i * 0.02;
            var tank = { x: s.x, y: s.y, rot: s.rot };
            var oldFc = cache.frames[i];
            var fc;
            if (!oldFc) {
                fc = _computeCachedFrame(adapter, samples, i, tGlobalStart, threats, cfg, prevPose, moving);
                cache.frames[i] = fc;
            } else if (oldFc.dead) {
                if (addedIds.length || removedIds.length) {
                    fc = _computeCachedFrame(adapter, samples, i, tGlobalStart, threats, cfg, prevPose, moving);
                    cache.frames[i] = fc;
                } else {
                    fc = oldFc;
                }
            } else {
                fc = oldFc;
                if (addedIds.length || removedIds.length) {
                    fc = _applyIncrementalToFrame(adapter, fc, tank, tGlobal, cfg, addedIds, removedIds, threatsById);
                    cache.frames[i] = fc;
                }
            }

            if (fc.dead) {
                dead = true;
                deathFrame = i;
                totalScore += fc.net;
                perFrameScores.push(fc.net);
                break;
            }
            totalScore += fc.net;
            perFrameScores.push(fc.net);
            prevPose = s;
        }

        if (dead) {
            cache.frames.length = deathFrame + 1;
        } else {
            cache.frames.length = maxI + 1;
        }
        cache.sig = currentIds.join(',');
        cache.maxFrame = cache.frames.length - 1;
        cache.events = { addedIds: addedIds, removedIds: removedIds };

        return {
            result: {
                totalScore: totalScore,
                dead: dead,
                deathFrame: deathFrame,
                perFrameScores: perFrameScores,
                frameCount: perFrameScores.length
            },
            cache: cache
        };
    }

    function scorePath(adapter, parentSimState, inputs, frames, threats, cfg) {
        cfg = mergeCfg(cfg);
        var sim = adapter.simulateTank(parentSimState.tank, inputs, frames, {
            startPose: parentSimState.tank,
            threats: threats,
            tGlobal: parentSimState.tGlobal
        });
        var samples = sim.samples;
        var totalScore = 0;
        var perFrameScores = [];
        var dead = false;
        var deathFrame = -1;
        var i, b;
        var moving = isMovingInputs(inputs);
        var prevPose = samples[0] || null;
        for (i = 1; i < samples.length; i++) {
            var s = samples[i];
            var tGlobal = parentSimState.tGlobal + s.t;
            var bulletPositions = [];
            for (b = 0; b < threats.length; b++) {
                var pos = threatBulletPos(adapter, threats[b], tGlobal);
                if (pos) bulletPositions.push(pos);
            }
            var fr = scoreFrame(adapter, { x: s.x, y: s.y, rot: s.rot }, bulletPositions, cfg);
            if (fr.dead) {
                dead = true;
                deathFrame = i;
                totalScore -= cfg.deathPenalty;
                perFrameScores.push(fr.frameScore);   // 死亡帧只记一次 -deathPenalty
                break;
            }
            // v7.2 车道压分叠加（主人设计）：子弹未来折线穿车 → 每帧扣分
            //   （贴心率×弦率，量级 = 遮蔽满分的 0.5~1.0 倍）——短窗内的
            //   长视界压力信号，占道越久扣越多
            var lane = lanePenaltyFrame({ x: s.x, y: s.y, rot: s.rot }, threats, tGlobal, cfg);
            var spring = springRopeFrameScore(adapter,
                { x: s.x, y: s.y, rot: s.rot }, threats, tGlobal, cfg);
            var frameNet = fr.frameScore - lane.penalty - spring;
            // v19 卡墙惩罚：非静止操作却连续两帧几乎不动（顶墙/被墙吸住）。
            if (moving && isStuckPose(prevPose, s, cfg)) {
                frameNet -= cfg.stuckPenalty;
            }
            totalScore += frameNet;
            perFrameScores.push(frameNet);
            prevPose = s;
        }
        return {
            totalScore: totalScore,
            dead: dead,
            deathFrame: deathFrame,
            perFrameScores: perFrameScores,
            frameCount: perFrameScores.length,
            samples: samples   // 树（阶段③）：子节点末态位姿取 samples[帧]（v13）
        };
    }

    // ------------------------------------------------------------
    // 批量评分（单世界融合沙箱路径；旧单路径 scorePath 保留作对照/回退）
    // ------------------------------------------------------------

    /**
     * 一次批量模拟 + 评分。operations 是 {name, inputs} 数组。
     * 优先使用 adapter.simulateTankBatch；不可用则逐个回退 scorePath。
     */
    function scorePaths(adapter, parentSimState, operations, frames, threats, cfg) {
        cfg = mergeCfg(cfg);
        var results = [];
        var batch = null;
        if (adapter.simulateTankBatch) {
            try {
                batch = adapter.simulateTankBatch(parentSimState.tank, operations, frames, {
                    startPose: parentSimState.tank,
                    threats: threats,
                    tGlobal: parentSimState.tGlobal
                });
            } catch (eBatch) {
                batch = null;
            }
        }

        if (!batch || batch.length !== operations.length) {
            for (var fj = 0; fj < operations.length; fj++) {
                results.push(scorePath(adapter, parentSimState,
                    operations[fj].inputs, frames, threats, cfg));
            }
            return results;
        }

        var i, b, j;
        for (j = 0; j < operations.length; j++) {
            results.push({
                totalScore: 0,
                dead: false,
                deathFrame: -1,
                perFrameScores: [],
                frameCount: 0,
                samples: batch[j].samples,
                // v29：Rust 物理预测的死亡帧只是候选；透传给树，
                // 最终执行路线由 JS 融合世界确认。
                rustPhysics: batch[j].rustPhysics === true
            });
        }
        var frameDt = (adapter.constants && adapter.constants.FRAME_DT)
            ? adapter.constants.FRAME_DT : 0.02;
        for (i = 1; i <= frames; i++) {
            var tGlobal = parentSimState.tGlobal + i * frameDt;
            var bulletPositions = [];
            for (b = 0; b < threats.length; b++) {
                var pos = threatBulletPos(adapter, threats[b], tGlobal);
                if (pos) bulletPositions.push(pos);
            }

            for (j = 0; j < operations.length; j++) {
                var r = results[j];
                if (r.dead) continue;
                var s = batch[j].samples[i];
                if (!s) continue;

                // v24：融合世界的传感器接触就是死亡判定权威，批量结果里已带
                // dead/deathFrame。存活帧跳过 checkDeath，直接用批量死亡结果。
                if (batch[j].dead && batch[j].deathFrame === i) {
                    r.dead = true;
                    r.deathFrame = i;
                    // 死亡帧只扣一次、只记一次 -deathPenalty。
                    r.totalScore -= cfg.deathPenalty;
                    r.perFrameScores.push(-cfg.deathPenalty);
                    r.frameCount = r.perFrameScores.length;
                    continue;
                }
                var fr = scoreFrameAlive(adapter,
                    { x: s.x, y: s.y, rot: s.rot }, bulletPositions, cfg);
                var lane = lanePenaltyFrame(
                    { x: s.x, y: s.y, rot: s.rot }, threats, tGlobal, cfg);
                var spring = springRopeFrameScore(adapter,
                    { x: s.x, y: s.y, rot: s.rot }, threats, tGlobal, cfg);
                var frameNet = fr.frameScore - lane.penalty - spring;
                // v19 卡墙惩罚：非静止操作却连续两帧几乎不动（顶墙/被墙吸住）。
                if (isMovingInputs(operations[j].inputs) &&
                    isStuckPose(batch[j].samples[i - 1], s, cfg)) {
                    frameNet -= cfg.stuckPenalty;
                }
                r.totalScore += frameNet;
                r.perFrameScores.push(frameNet);
                r.frameCount = r.perFrameScores.length;
            }
        }

        for (j = 0; j < results.length; j++) {
            results[j].samples = batch[j].samples;
        }
        return results;
    }

    // ------------------------------------------------------------
    // 节点数值结构（未雨绸缪：阶段③的节点把全部数值装进这一个对象）
    // ------------------------------------------------------------

    /**
     * 创建一个空的节点数值容器。阶段③建树时每个节点一份：
     * 基准时间、评分、沙箱模拟状态都是这个节点的属性，一起存取。
     */
    function createNodeValues() {
        return {
            id: null,             // 节点编号（阶段③分配）
            parentId: null,       // 父节点编号
            depth: 0,             // 深度（帧数）
            inputs: null,         // 产生本节点的操作（9 种之一）
            simState: null,       // 沙箱节点状态 {tank:{x,y,rot}, tGlobal}
            baseTime: null,       // 本节点重算的基准时间结果（滚动时域）
            score: null,          // scorePath 的结果
            status: 'pending'     // pending / alive / dead（阶段③维护）
        };
    }

    // ------------------------------------------------------------
    // 导出
    // ------------------------------------------------------------

    global.VantageScoring = {
        computeThreats: computeThreats,
        computeBaseTime: computeBaseTime,
        scoreFrame: scoreFrame,
        scoreFrameAlive: scoreFrameAlive,
        lanePenaltyFrame: lanePenaltyFrame,
        getMazeWallEnv: getMazeWallEnv,
        springRopeLength: springRopeLength,
        springRopeFrameScore: springRopeFrameScore,
        scorePath: scorePath,
        scorePaths: scorePaths,
        scoreRollout: scoreRollout,
        scoreRolloutCached: scoreRolloutCached,
        occlusionIntervals: occlusionIntervals,
        headingInFreeIntervals: headingInFreeIntervals,
        createNodeValues: createNodeValues,
        exactGeom: exactGeom,
        DEFAULTS: SCORING_DEFAULTS
    };

    console.log('[Vantage Scoring] 模块已加载（v31：vt_score_paths 接入 rolloutNine + scorePaths 透传 rustPhysics 候选标记 + v28 兜底直线威胁）');

})(typeof window !== 'undefined' ? window : this);
