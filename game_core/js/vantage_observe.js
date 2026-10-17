/**
 * ============================================================================
 *  vantage_observe.js —— 阶段 2-3 · 【观测编码器】（v195 · 2026-10-13）
 * ============================================================================
 *
 * 定位（《总体路线方针》阶段 2 的定位）：**只加不改语义**。
 * 本文件是一个【纯读 / 纯函数】模块：
 *   · 只从 `SandboxAdapter` 的现有取数能力 + `VantageTree.collectAgentNodes()` 构造 token 数组；
 *   · **绝不写任何全局状态**，绝不调评分 / 判死 / 树 / 融合世界；
 *   · 🔴 **绝不碰 `VantageTree.noteDeath`** —— 那会 `_frozen = true` **把树定死**。
 *
 * 字段表出处：`docs/Vantage躲弹实现/02-实现/实施方案/阶段2-3观测字段表-定稿-2026-10-12.md`
 *   · 节点 token 10 维（uid · parentIdx · slot · depth · tRel · L · dx/dy/dRot · hasGrown）
 *   · 子弹 token  7 维（x,y,vx,vy,θ,type,lifeLeft）× **动态 M（不截断）**
 *   · 根滞后 1 维 · 上帧计划 3+2·K_fire · 全局段 · 毒雾段 6 维
 *
 * ⚠️ 单位（**实测过的，不是猜的**，见 `_tools/headless/_probe_2_3_units_v2.js`）：
 *   游戏 raw 世界坐标 = **米**（8×5 格 × 10 m/格 = 80×40 m；实测夹具世界包围盒 80.8×40.8；
 *   坦克 AABB 3.48×4.90；子弹单帧位移 ÷ 游戏时钟 == 上报 |speed| **ratio 恒 1.0000**）。
 *   ⟹ **本编码器不做任何 px↔m 换算**（⛔ 绝不许"偷偷除以 20"）。
 *   归一化是**显式开关** `opts.normalize`（默认 **false** = 原样透出）；打开时按地图物理尺寸归一化。
 * ============================================================================
 */
(function (global) {
    'use strict';

    // ── 字段表里的两个硬约定（写死，不许在别处再定义一遍）──────────────
    /**
     * ★★ 子弹角约定（**全仓唯一真源**）。
     *   选 **B = `atan2(speedX, -speedY)`** —— 与 `Tank.getRotation()` **同一套**。
     *   游戏朝向：`Tank.update` 每帧写 `SetLinearVelocity(sin(rot)*speed, -cos(rot)*speed)`
     *   ⟹ 前向 = `(sin θ, -cos θ)` ⟹ `atan2(sinθ·s, cosθ·s) = θ` ✅
     *   代码内佐证：`vantage_tree.js` 的 `moveTargetScore` 里
     *     `var desiredRot = Math.atan2(dx, -dy);   // 游戏朝向：sin(rot), -cos(rot)`
     *   ⛔ 另一个约定 `atan2(speedY, speedX)`（数学极角）**本仓不用** —— 用了就等于
     *     在一份观测里混两套角，而自己坦克/对手的角度全是 B。
     */
    var THETA_CONVENTION = 'atan2(speedX,-speedY)';

    /** 子弹角度（唯一实现；调试页/探针/自证**都必须调这里**，不许各写一遍） */
    function bulletTheta(speedX, speedY) {
        return Math.atan2(speedX, -(speedY));
    }

    /** 角度 wrap 到 (-π, π]（周期量必须 wrap；§16.6 问题 4） */
    function wrapPi(a) {
        if (!isFinite(a)) return 0;
        var x = Math.atan2(Math.sin(a), Math.cos(a));
        return x;
    }

    // ── 维度常量（供调用方算总维数 / 建张量，**不许在别处再写死**）──────
    var NODE_DIM = 10;      // 见 NODE_FIELDS
    var BULLET_DIM = 7;     // 见 BULLET_FIELDS
    var STORM_DIM = 6;
    var ROOTLAG_DIM = 1;
    var DEATH_DIM = 7;   // P2: death 7 dims; P5: x K_death (param)
    function deathDim(k) { return DEATH_DIM * Math.max(1, (k | 0)); }

    var NODE_FIELDS = ['uid', 'parentIdx', 'slot', 'depth', 'tRel', 'L', 'dx', 'dy', 'dRot', 'hasGrown'];
    var BULLET_FIELDS = ['x', 'y', 'vx', 'vy', 'theta', 'type', 'lifeLeft'];
    var STORM_FIELDS = ['active', 'edgeL', 'edgeR', 'edgeT', 'edgeB', 'nextDir'];
    var GLOBAL_FIELDS = [
        // 地图配置 6
        'mapW', 'mapH', 'symmetric', 'stormOn', 'crateMask', 'maxPlayers',
        // 自己坦克 12
        'selfX', 'selfY', 'selfRot', 'kFwd', 'kBack', 'kLeft', 'kRight', 'kLocked',
        'wpnType', 'ammoLeft', 'shieldOn', 'shieldLife',
        // 回合/时间 3
        'timeType', 'timeLeft', 'roundState',
        // 死亡事件 7（× K_death；P2/P5；字段名见 DEATH_DIM 注释）
        'dVictimIdx', 'dX', 'dY', 'dRot', 'dKillerIdx', 'dDeadlyType', 'dTAge',
        // ⭐ 全发原则（§16.7）新增 7 维：**一律【追加到末尾】**⟹ 旧位 0..27 一个都不动（下游硬编码零影响）
        //   selfFire/wpnCool/wpnReload/queueLen（自己开火键 + 武器冷却/装填/排队）
        //   nextCrateSec（道具刷新「何时」；🚩 作弊项 §15.4#1）—— 「在哪」永久不可得（报告 §十一）
        //   wpnKnown（**布尔，非哨兵**：0=取不到 / 1=取到了；本字段没有第三个状态）
        'wpnDefaultType', 'queue0Type', 'queue1Type', 'queue2Type',
        'selfFire', 'wpnCool', 'wpnReload', 'queueLen',
        'nextCrateSec', 'wpnKnown',
        // C5（裁决 2026-10-14，完整版 +4）：武器类型的**事实全发**（都不是作弊项：§15.4a 自己的武器状态公开）
        //   wpnDefaultType = 没捡过道具时默认武器 type；queue<i>Type = 第 i 个排队武器 type
        //   ⚠️ 空位 vs 普通弹（-1 都是 -1）**可区分**：空位 ⟺ i >= queueLen（queueLen 已在同段）
    ];
    // 逐对手 **13 维**（原 8 + 新增 5；全发原则）：
    //   位置2/角度1/移动键4/存活1 | oFire（§9.2#2 按键情况）/ oUpgradeMask（§9.2#2 携带道具）
    //   / oWpnType + oAmmoLeft（§9.2#2 剩余子弹；**oAmmoLeft 是作弊项** §15.4c）
    //   ⚠️ 新增 5 维一律**追加在末尾** ⟹ 原有 8 维位置不变
    var OPP_FIELDS = ['ox', 'oy', 'orot', 'oFwd', 'oBack', 'oLeft', 'oRight', 'oAlive',
                      'oFire', 'oUpgradeMask', 'oWpnType', 'oAmmoLeft', 'oWpnKnown',
                      'oShieldLife', 'oShieldWeak'];
    // 🔴 契约：oWpnType 只在 oWpnKnown = 1 时有效（Constants.WEAPON_TYPES.BULLET = -1）
    // 逐道具 3 维 × M_col ；逐地雷 3 维 × M_mine
    var COL_FIELDS = ['cx', 'cy', 'cType'];
    var MINE_FIELDS = ['mx', 'my', 'mState'];

    /** 上帧计划维度 = 3 + 2·K_fire（`K_fire` 是常量参数，**不许把 4 写进布局**） */
    var PLAN_HEAD_DIM = 3;
    function planDim(kFire) { return PLAN_HEAD_DIM + 2 * (kFire | 0); }

    // ── 小工具（全部纯函数）────────────────────────────────────────────
    function num(x, dft) { return (typeof x === 'number' && isFinite(x)) ? x : (dft === undefined ? 0 : dft); }
    function bin(b) { return b ? 1 : 0; }
    /** 🔴 武器字段取数（v196 修）：真框架 getFields() 交的是**带下划线前缀的声明名**（Classy.listOwnFields），
     *  而框架的 getField(name) 会自己补下划线。观测只拿到 fields ⟹ **两种键都试（下划线版优先）**，取不到给 −1（不冒充）。 */
    function wfGet(fields, name, dft) {
        var d = (dft === undefined) ? -1 : dft;
        if (!fields) return d;
        var v = fields['_' + name];
        if (typeof v === 'number' && isFinite(v)) return v;
        v = fields[name];
        if (typeof v === 'number' && isFinite(v)) return v;
        return d;
    }
    function upOf(a, p, t) { var u = null; try { if (typeof a.getUpgradeByPlayerIdAndType === 'function') u = a.getUpgradeByPlayerIdAndType(p, t); } catch (e1) { } if (!u) { try { var n2 = Number(p); if (isFinite(n2)) u = a.getUpgradeByPlayerIdAndType(n2, t); } catch (e2) { } } return u ? u : null; }
    function keyList(map) {
        var out = [];
        try { for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k)) out.push(k); } catch (e) {}
        return out;
    }
    function callf(o, name, dft) {
        try { if (o && typeof o[name] === 'function') { var v = o[name](); return (v === undefined) ? dft : v; } } catch (e) {}
        return dft;
    }

    /** 地图物理尺寸（**米**）。A-1 实测：raw 世界坐标就是米。 */
    function mapSizeOf(maze) {
        var tile = 10;
        try {
            if (typeof Constants !== 'undefined' && Constants.MAZE_TILE_SIZE &&
                typeof Constants.MAZE_TILE_SIZE.m === 'number') tile = Constants.MAZE_TILE_SIZE.m;
        } catch (e) {}
        var w = callf(maze, 'getWidth', 8), h = callf(maze, 'getHeight', 5);
        return { w: num(w, 8) * tile, h: num(h, 5) * tile, tile: tile, tilesW: num(w, 8), tilesH: num(h, 5) };
    }

    // ========================================================================
    // 一、节点 token（10 维/节点）
    // ========================================================================
    /**
     * @param {Array} rows  `VantageTree.collectAgentNodes(tree)` 的**原始行**（只读快照）
     * @param {Object} opts `{rootX, rootY, rootRot, mapW, mapH, horizonSec, normalize}`
     * @returns {Object} `{tokens:Array<Array<number>>, ids:Array, stat:Object}`
     *
     * 规则（**逐条都出自裁决**）：
     *  1. **过滤 `invalid`**（失效节点不进观测，§8.0 第 1 条）。⛔ **不过滤 `exhausted`** ——
     *     主人裁决恰恰要智能体看见"生过 + 无分支"（那就是真死信号）。
     *  2. `parentIdx` = 父节点**在本帧 token 数组里的下标**（根 = −1）⟹ 分叉结构由
     *     `(parentIdx, slot)` 联合表达（§16.4 裁决："分支数量就在那摆着呢"）。
     *  3. ⛔ **不发** `死亡帧`（2026-10-13 裁决：`fullDeathFrame` 统计了 9 个下级 ⟹ 违反"只看我是谁"）；
     *     ⛔ **不发** `子节点数` / `分叉掩码`。
     *  4. `L` = 本节点相对**父节点**前进的帧数（§7.7）：有父 ⟹ 由 `tGlobal` 差 ÷ FRAME_DT 得；
     *     根（无父）⟹ 0。⚠️ 与"规格式"`fullDead ? (fd>=2?fd-1:0) : 75` 的**对拍**由自证探针做。
     */
    function encodeNodes(rows, opts) {
        opts = opts || {};
        var horizon = num(opts.horizonSec, 10) || 10;
        var mapW = num(opts.mapW, 0), mapH = num(opts.mapH, 0);
        var norm = !!opts.normalize;
        var rX = num(opts.rootX, 0), rY = num(opts.rootY, 0), rRot = num(opts.rootRot, 0);
        var fdt = num(opts.frameDt, 0.02) || 0.02;

        var live = [];
        for (var i = 0; i < (rows || []).length; i++) {
            var r = rows[i];
            if (!r || r.invalid) continue;              // ← 规则 1
            live.push(r);
        }
        // id → 本帧下标
        var idxOf = {};
        for (var j = 0; j < live.length; j++) idxOf[live[j].id] = j;

        var tokens = [], ids = [];
        var stat = { n: live.length, droppedInvalid: (rows || []).length - live.length,
                     maxDepth: 0, hasGrownTrue: 0, noChildHasGrownTrue: 0, noChildHasGrownFalse: 0,
                     Lmismatch: 0, slotMissing: 0, parentMissing: 0 };
        for (var k = 0; k < live.length; k++) {
            var n = live[k];
            var pi = (n.parentId === null || n.parentId === undefined) ? -1 : ((idxOf[n.parentId] === undefined) ? -1 : idxOf[n.parentId]);
            if (pi < 0 && n.parentId !== null && n.parentId !== undefined) stat.parentMissing++;

            var slot = (typeof n.opIndex === 'number') ? n.opIndex : -1;
            if (slot < 0) {
                stat.slotMissing++;
                // 兜底：用 opName 在 OPERATIONS 里的顺序反查（⚠️ 只是兜底，真源是 opIndex）
                try {
                    var OPS = (global.VantageSandbox && global.VantageSandbox.OPERATIONS) || null;
                    if (OPS && n.opName) for (var oi = 0; oi < OPS.length; oi++) if (OPS[oi].name === n.opName) { slot = oi; break; }
                } catch (eSlot) {}
            }

            // L：本节点相对父节点前进的帧数（根 = 0）
            var L = 0;
            var parent = (pi >= 0) ? live[pi] : null;
            if (parent && typeof n.tGlobal === 'number' && typeof parent.tGlobal === 'number') {
                L = Math.round((n.tGlobal - parent.tGlobal) / fdt);
                // 规格式对拍（只统计，不覆盖）
                var spec = !n.fullDead ? 75 : ((n.fullDeathFrame >= 2) ? (n.fullDeathFrame - 1) : 0);
                if (spec !== L) stat.Lmismatch++;
            }

            var tG = num(n.tGlobal, 0);
            var dxw = num(n.x, 0) - rX, dyw = num(n.y, 0) - rY;
            var dRot = wrapPi(num(n.rot, 0) - rRot);
            var dx = norm && mapW ? (dxw / mapW) : dxw;
            var dy = norm && mapH ? (dyw / mapH) : dyw;
            var dRn = norm ? (dRot / Math.PI) : dRot;         // 周期量：归一化只是除以 π
            var hasGrown = (n.hasGrown === true) ? 1 : 0;

            var nc = num(n.nChildren, 0);
            if (hasGrown) { stat.hasGrownTrue++; if (nc === 0) stat.noChildHasGrownTrue++; }
            else if (nc === 0) stat.noChildHasGrownFalse++;
            if (num(n.depth, 0) > stat.maxDepth) stat.maxDepth = num(n.depth, 0);

            tokens.push([
                num(n.id, 0),                                   // uid
                pi,                                             // parentIdx（数组下标）
                slot,                                           // 来路槽位 0..8
                num(n.depth, 0),                                // depth
                (tG / horizon),                                 // tRel（秒 ÷ 时间上限秒）
                L,                                              // L
                dx, dy, dRn,                                    // 末态位移（相对根）
                hasGrown                                        // hasGrown（动态参数）
            ]);
            ids.push(n.id);
        }
        return { tokens: tokens, ids: ids, idxOf: idxOf, stat: stat, dim: NODE_DIM, fields: NODE_FIELDS,
                     // ★ 根的真实位姿（= 喂给 dx/dy 的那个基准）⟹ 调试页只需这一份 enc 就能还原绝对坐标
                     rootRef: { x: rX, y: rY, rot: rRot } };
    }

    // ========================================================================
    // 二、子弹 token（7 维/颗 · **动态 M，绝不截断**）
    // ========================================================================
    /**
     * @param {Object} adapter SandboxAdapter（只调 getProjectiles）
     * @param {Object} opts `{mapW, mapH, normalize}`
     * 出处：主人裁决「角度得有，因为会角弹」+ B5「不加 bounces/deadlyToOwner/stopped」+ A3-O1「动态 M 不用 K」
     */
    function encodeBullets(adapter, opts) {
        opts = opts || {};
        var mapW = num(opts.mapW, 0), mapH = num(opts.mapH, 0), norm = !!opts.normalize;
        var list = [];
        try { list = adapter.getProjectiles() || []; } catch (e) { list = []; }
        var tokens = [], stat = { n: list.length, typeVals: {}, thetaNonZero: 0, lifeNonZero: 0, degenerateSpeed: 0 };
        for (var i = 0; i < list.length; i++) {
            var p = list[i];
            var vx = num(p.speedX, 0), vy = num(p.speedY, 0);
            var theta = bulletTheta(vx, vy);
            var ty = (typeof p.type === 'number') ? p.type : -99;
            stat.typeVals[ty] = (stat.typeVals[ty] || 0) + 1;
            if (Math.abs(theta) > 1e-9) stat.thetaNonZero++;
            var ll = (typeof p.lifeLeft === 'number') ? p.lifeLeft : -1;
            if (Math.abs(ll) > 1e-9) stat.lifeNonZero++;
            if (Math.abs(vx) < 1e-9 && Math.abs(vy) < 1e-9) stat.degenerateSpeed++;   // atan2(0,0)=0 ⟹ 角退化
            var x = num(p.x, 0), y = num(p.y, 0);
            tokens.push([
                norm && mapW ? x / mapW : x,
                norm && mapH ? y / mapH : y,
                vx, vy,
                theta,
                ty,
                ll
            ]);
        }
        return { tokens: tokens, stat: stat, dim: BULLET_DIM, fields: BULLET_FIELDS, thetaConvention: THETA_CONVENTION };
    }

    // ========================================================================
    // 三、根滞后（1 维）
    // ========================================================================
    /** 定义 = `现在 − 树根对应的真实时刻`，**不带 anchorOffset**（那是"锚点年龄"，另一个量）。 */
    function encodeRootLag(tree, horizonSec) {
        var d = null;
        // ⚠️ `VantageTree.getTree()` 返回的是【视图对象】，**不带 dumpDiagnostics** ⟹
        //    必须走【模块级】的 `VantageTree.dumpDiagnostics()`（它内部读 `_tree`）。
        try { if (global.VantageTree && typeof global.VantageTree.dumpDiagnostics === 'function') d = global.VantageTree.dumpDiagnostics(); } catch (e) {}
        if ((!d || typeof d.tNow !== 'number' || typeof d.rootAbsT !== 'number') && tree && typeof tree.dumpDiagnostics === 'function') {
            try { d = tree.dumpDiagnostics(); } catch (e2) {}
        }
        if (!d || typeof d.tNow !== 'number' || typeof d.rootAbsT !== 'number') {
            return { value: null, dim: ROOTLAG_DIM, available: false,
                     why: d ? ('keys=' + Object.keys(d).slice(0, 12).join(',')) : 'dumpDiagnostics=null' };
        }
        var lag = d.tNow - d.rootAbsT;
        var h = num(horizonSec, 10) || 10;
        return { value: lag / h, raw: lag, dim: ROOTLAG_DIM, available: true, tNow: d.tNow, rootAbsT: d.rootAbsT };
    }

    // ========================================================================
    // 四、上帧计划（3 + 2·K_fire）
    // ========================================================================
    /**
     * @param {Object|null} plan `{leafId, stale, fires:[{nodeId, back}...]}`
     * @param {Number} K_fire 上限（**参数**；超限只截断到 K_fire，`nFire` 记**真实**条数，不撒谎）
     */
    function encodePlan(plan, K_fire) {
        var K = (K_fire | 0);
        var out = [];
        if (!plan) { out.push(-1, 1, 0); for (var a = 0; a < 2 * K; a++) out.push(-1); return { token: out, dim: planDim(K) }; }
        var fires = plan.fires || [];
        out.push(num(plan.leafId, -1), bin(plan.stale), fires.length);
        for (var i = 0; i < K; i++) {
            var f = fires[i];
            out.push(f ? num(f.nodeId, -1) : -1, f ? num(f.back, -1) : -1);
        }
        return { token: out, dim: planDim(K), truncated: Math.max(0, fires.length - K) };
    }

    // ========================================================================
    // 五、全局 token（地图配置 / 自己坦克 / 对手 / 道具 / 地雷 / 时间回合 / 死亡事件）
    // ========================================================================
    function encodeGlobal(adapter, opts) {
        opts = opts || {};
        var norm = !!opts.normalize;
        var mapW = num(opts.mapW, 0), mapH = num(opts.mapH, 0);
        var g = [];
        var diag = {};

        // ── 地图配置 6 ──
        var maze = null; try { maze = adapter.getMaze(); } catch (e) {}
        var ms = mapSizeOf(maze);
        var cfg = null; try { cfg = adapter.getMatchConfig(); } catch (e) {}
        var crateMask = 0;
        try { var ct = cfg && cfg.crateTypes; if (ct) for (var ci = 0; ci < ct.length; ci++) { var v = ct[ci]; if (typeof v === 'number' && v >= 0 && v < 31) crateMask |= (1 << v); } } catch (eCT) {}
        g.push(ms.tilesW, ms.tilesH,                       // 宽/高（**格**，一局内不变）
               bin(cfg && cfg.symmetric),
               bin(cfg && cfg.storm),
               crateMask,
               num(cfg && cfg.maxActivePlayerCount, 0));

        // ── 自己坦克 12 ──
        var ts = null; try { ts = adapter.getTankState(); } catch (e) {}
        var ammoLeft = null;
        try {
            var am = ts && ts.ammo;
            if (am) ammoLeft = (typeof am.remainingByDifference === 'number') ? am.remainingByDifference
                             : ((typeof am.numBullets === 'number') ? am.numBullets : (typeof am.numMines === 'number' ? am.numMines : null));
        } catch (eAM) {}
        var shOn = 0, shLife = 0;
        try { var sh = ts && ts.shield; if (sh) { shOn = 1; var _sl = num(sh.lifetime, 0); shLife = (_sl > 0) ? _sl : 0; } } catch (eSH) {}
        g.push(norm && mapW ? num(ts && ts.x, 0) / mapW : num(ts && ts.x, 0),
               norm && mapH ? num(ts && ts.y, 0) / mapH : num(ts && ts.y, 0),
               num(ts && ts.rot, 0),
               bin(ts && ts.forward), bin(ts && ts.back), bin(ts && ts.left), bin(ts && ts.right),
               bin(ts && ts.locked),
               num(am && am.type, -1), num(ammoLeft, -1),
               shOn, shLife);
        diag.ammoLeft = ammoLeft; diag.shield = shOn;

        // ── 新增 4 维（全发原则 §16.7）：自己的开火键 + 武器冷却/装填/排队 ──
        //   数据源：`ts.fireDown`（sandbox:4249 已在 getTankState 里透出）
        //          + `adapter.getWeaponStates(aiId).active.fields`（字段名以游戏源码为准：
        //            `_timeSinceFire` / `_reloadTime` / `_triggerPulled` / `_numBullets` / `_bulletsFired`
        //            —— 全仓 grep 实测存在，见报告 §二#3）
        //   ⛔ 取不到一律给 **−1（未知）**，不用 0 冒充"真的没有"
        var selfFire = (ts && typeof ts.fireDown === 'boolean') ? (ts.fireDown ? 1 : 0) : -1;
        var wpnCool = -1, wpnReload = -1, queueLen = -1;
        try {
            var ws = adapter.getWeaponStates ? adapter.getWeaponStates(adapter.getAiId ? adapter.getAiId() : undefined) : null;
            var wf = ws && ws.active ? ws.active.fields : null;
            if (wf) {
                wpnCool = wfGet(wf, 'timeSinceFire');
                wpnReload = wfGet(wf, 'reloadTime');
            }
            if (ws && ws.queued && typeof ws.queued.length === 'number') queueLen = ws.queued.length;
        } catch (eWS) { }
        // ⚠️ 这 4 维的 push 挪到**死亡段之后**（= 与 GLOBAL_FIELDS 的"追加到末尾"一致）

        // ── 对手 8 × N_opp（**P4：按稳定玩家索引排序**，不再用 keyList 的当前顺序）──
        var selfId = null; try { selfId = adapter.getAiId ? adapter.getAiId() : null; } catch (eId) {}
        var tanks = null; try { tanks = adapter.getTanks(); } catch (eT) {}
        var pIdx = stablePlayerIndex(adapter);
        // ★ 遍历**稳定表的全部对手**（含已死的）⟹ 死者的 oAlive=0 仍在 token 里（原来恒 1 假活，§9.2#2）
        var oppIds = pIdx.order.slice();
        var UP_TYPES = [0, 1, 2, 3, 4];     // LASER_AIMER/SPAWN_SHIELD/SHIELD/AIMER/SPEED_BOOST（Constants.UPGRADE_TYPES）
        var opp = [];
        for (var oi2 = 0; oi2 < oppIds.length; oi2++) {
            var oid = oppIds[oi2];
            var t = tanks ? tanks[oid] : null;
            if (!t) {                                          // ★ 已死/不存在的对手：存活位 0，其余一律 −1（未知，不用 0 冒充）
                // v198 修：占位**从 OPP_FIELDS.length 推**（原来硬写 12 ⟹ 加维后死者行错位）
                var ph = []; for (var pi2 = 0; pi2 < OPP_FIELDS.length; pi2++) ph.push(-1);
                ph[7] = 0;   // OPP_FIELDS[7] === oAlive（死者位 = 0，其余 −1）
                opp.push.apply(opp, ph);
                continue;
            }
            // ── §9.2#2 全发：开火键（数据源 = Tank.getFireDown，sandbox:4249 已在别处透出同源 getter）──
            var of = callf(t, 'getFireDown', undefined);
            var oFire = (typeof of === 'boolean') ? (of ? 1 : 0) : -1;
            // ── 携带道具（数据源 = adapter.getUpgradeByPlayerIdAndType，逐个类型位查询）──
            var upMask = -1;
            try {
                if (typeof adapter.getUpgradeByPlayerIdAndType === 'function') {
                    upMask = 0;
                    for (var ut = 0; ut < UP_TYPES.length; ut++) {
                        if (upOf(adapter, oid, UP_TYPES[ut])) upMask |= (1 << UP_TYPES[ut]);
                    }
                }
            } catch (eUM) { upMask = -1; }
            // ── 剩余子弹 + 弹种（数据源 = adapter.getWeaponStates(pid).active.fields）──
            var oWpn = -1, oAmmo = -1;
            try {
                var ows = adapter.getWeaponStates ? adapter.getWeaponStates(oid) : null;
                var owf = ows && ows.active ? ows.active.fields : null;
                if (ows && ows.active) oWpn = num(ows.active.type, -1);
                if (owf) {
                    var nb = wfGet(owf, 'numBullets', null), bf2 = wfGet(owf, 'bulletsFired', null), nm2 = wfGet(owf, 'numMines', null);
                    if (nb !== null && bf2 !== null) oAmmo = nb - bf2;
                    else if (nb !== null) oAmmo = nb;
                    else if (nm2 !== null) oAmmo = nm2;
                }
            } catch (eOA) { }
            var oShLife = -1, oShWeak = -1;
            try {
                var oUp = upOf(adapter, oid, 2);
                if (oUp && typeof oUp.getField === 'function') {
                    var lf2 = oUp.getField('lifetime');
                    if (typeof lf2 === 'number') oShLife = lf2;
                    var wk2 = oUp.getField('weakened');
                    if (typeof wk2 === 'boolean') oShWeak = wk2 ? 1 : 0; else if (typeof wk2 === 'number') oShWeak = wk2;
                }
            } catch (eOS) { }
            // v198 修：⛔ token 里绝不许出现 null ⟹ 兜底统一 −1（“无盾”与“取不到”都是 −1，报告登记“真字段名待查”）
            if (!(typeof oShLife === "number" && isFinite(oShLife))) oShLife = -1;
            if (!(typeof oShWeak === "number" && isFinite(oShWeak))) oShWeak = -1;
            if (oShLife !== -1) oShLife = (oShLife > 0) ? oShLife : 0;   // v199: 寿命不可能为负（无盾=-1 是哨兵）⟹ 只在有盾分支 max(0,x)
            opp.push(norm && mapW ? num(callf(t, 'getX', 0), 0) / mapW : num(callf(t, 'getX', 0), 0),
                     norm && mapH ? num(callf(t, 'getY', 0), 0) / mapH : num(callf(t, 'getY', 0), 0),
                     num(callf(t, 'getRotation', 0), 0),
                     bin(callf(t, 'getForward', false)), bin(callf(t, 'getBack', false)),
                     bin(callf(t, 'getLeft', false)), bin(callf(t, 'getRight', false)),
                     1,
                     oFire, upMask, oWpn, oAmmo, (ows && ows.active && typeof ows.active.type === 'number') ? 1 : 0, oShLife, oShWeak);
        }
        diag.oppIds = oppIds;
        diag.playerIdx = pIdx.idxOf;
        diag.oppLenMismatch = (opp.length !== oppIds.length * OPP_FIELDS.length) ? (opp.length + " / " + (oppIds.length * OPP_FIELDS.length)) : 0;
        diag.oppAlive = oppIds.filter(function (k2) { return !!(tanks && tanks[k2]); }).length;

        // ── 道具 3 × M_col ──
        var col = null; try { col = adapter.getCollectibles(); } catch (eC2) {}
        var colTok = [];
        var ck = keyList(col);
        for (var c2 = 0; c2 < ck.length; c2++) {
            var cc = col[ck[c2]]; if (!cc) continue;
            colTok.push(norm && mapW ? num(callf(cc, 'getX', 0), 0) / mapW : num(callf(cc, 'getX', 0), 0),
                        norm && mapH ? num(callf(cc, 'getY', 0), 0) / mapH : num(callf(cc, 'getY', 0), 0),
                        num(callf(cc, 'getType', -1), -1));
        }
        diag.nCollectibles = ck.length;

        // ── 地雷 3 × M_mine（作弊全开：隐形之后也知道，§15.2 应用区域 #3）──
        var traps = null; try { traps = adapter.getTraps(); } catch (eTr) {}
        var mineTok = [];
        var tk2 = keyList(traps);
        for (var m2 = 0; m2 < tk2.length; m2++) {
            var mm = traps[tk2[m2]]; if (!mm) continue;
            // 状态码：0=未触发 1=已触发未爆 2=已爆（取游戏自己的位；取不到给 −1）
            var st = -1;
            try {
                var det = mm.getField('detonated'), tri = mm.getField('tripped'), act = mm.getField('activated');
                st = det ? 2 : (tri ? 1 : (act ? 1 : 0));
            } catch (eSt) {}
            mineTok.push(norm && mapW ? num(callf(mm, 'getX', 0), 0) / mapW : num(callf(mm, 'getX', 0), 0),
                         norm && mapH ? num(callf(mm, 'getY', 0), 0) / mapH : num(callf(mm, 'getY', 0), 0),
                         st);
        }
        diag.nMines = tk2.length;

        // ── 时间 / 回合 3 ──
        var counters = null; try { counters = adapter.getCounters(); } catch (eCo) {}
        var timeType = -1, timeLeft = 0;
        if (counters && counters.length) { timeType = num(counters[0].type, -1); timeLeft = num(counters[0].currentTime, 0); }
        var stateStr = null; try { stateStr = adapter.getState(); } catch (eSt2) {}
        // 回合状态：0=between rounds 1=counting down 2=in round 3=ended，其它 −1（**原字符串另存 diag**）
        var STATE_CODES = { 'between rounds': 0, 'counting down': 1, 'in round': 2, 'ended': 3 };
        var rstate = (stateStr && STATE_CODES[stateStr] !== undefined) ? STATE_CODES[stateStr] : -1;
        g.push(timeType, timeLeft, rstate);
        diag.stateStr = stateStr; diag.timeType = timeType;

        // ── 死亡事件 7 × K_death（P1/P2/P3；最近 K_death 次，旧→新）──
        //   P1：victim/killer 走**稳定整数索引**（自车=0、对手=1..N）⟹ 不再把字符串 id 喂 num()（旧代码恒 −1）
        //   P3：tAge = **树时钟秒 ÷ horizon**（与 tRel / rootLag 同一基准）；首见时戳，故首帧为 0
        var deaths = null; try { deaths = adapter.getDeaths(); } catch (eD) {}
        var kDeath = Math.max(1, (opts.K_death | 0) || 1);
        var nD = deaths ? deaths.length : 0;
        var tNow = (typeof opts.tNowSec === 'number' && isFinite(opts.tNowSec)) ? opts.tNowSec : null;
        var hz = (typeof opts.horizonSec === 'number' && opts.horizonSec > 0) ? opts.horizonSec : 10;
        for (var di2 = kDeath - 1; di2 >= 0; di2--) {
            var rec = (nD - 1 - di2 >= 0) ? deaths[nD - 1 - di2] : null;      // 旧 → 新
            if (!rec) {                                                        // 不足 ⟹ 用 −1 占位（不撒谎）
                g.push(-1, 0, 0, 0, -1, -1, -1);
                continue;
            }
            var vIdx = (rec.victimPlayerId != null && pIdx.idxOf[String(rec.victimPlayerId)] !== undefined)
                ? pIdx.idxOf[String(rec.victimPlayerId)] : -1;
            var kIdx;
            if (rec.killerPlayerId == null || rec.killerPlayerId === undefined) kIdx = -1;   // 无来源（区域致死等）
            else if (pIdx.idxOf[String(rec.killerPlayerId)] !== undefined) kIdx = pIdx.idxOf[String(rec.killerPlayerId)];
            else kIdx = -2;                                                                   // 有来源但不在索引表里
            var age = -1;
            if (tNow !== null) {
                var dKey = String(rec.victimPlayerId) + '@' + String(rec.tWallMs);
                if (_deathSeenAt[dKey] === undefined) _deathSeenAt[dKey] = tNow;
                age = (tNow - _deathSeenAt[dKey]) / hz;      // ★ 与 tRel/rootLag 同款：树时钟秒 ÷ horizon
            }
            g.push(vIdx,
                   (typeof rec.x === 'number') ? (norm && mapW ? rec.x / mapW : rec.x) : 0,
                   (typeof rec.y === 'number') ? (norm && mapH ? rec.y / mapH : rec.y) : 0,
                   num(rec.rot, 0),
                   kIdx,
                   num(rec.deadlyType, -1),
                   age);
        }
        diag.nDeaths = nD;
        // ── ⭐ 追加段 7 维（必须在死亡段之后 ⟹ 与 `GLOBAL_FIELDS` 的末尾顺序一致）──
        //   ① 自己开火键 + 武器冷却/装填/排队（§9.2#2 / §15.4a / §9.2#11）
        var cSec = -1;   // 「在哪刷」永久不可得 ⟹ 不再有 cNx/cNy
        try {
            var ci = adapter.getCrateSpawnInfo ? adapter.getCrateSpawnInfo() : null;   // v193 新增 getter（纯读）
            if (ci) {
                // 「何时」：只在**倒计时真的在走**时才有意义（游戏：场上箱子数 < MAX_CRATES 才 -= dt）
                if (ci.counting && typeof ci.spawnDuration === 'number') cSec = ci.spawnDuration;
                // 「在哪」：只在 symmetric 局可算（确定性）；非对称局 = Math.random 现场抽 ⟹ 原理不可知 ⟹ −1
                diag.crate = { count: ci.count, maxCrates: ci.maxCrates, counting: ci.counting,
                               symmetric: ci.symmetric };
            } else { diag.crate = null; }
        } catch (eCR) { diag.crate = { err: String((eCR && eCR.message) || eCR) }; }
        var dftType = (ws && ws.default && typeof ws.default.type === 'number') ? ws.default.type : -1;
        var q0 = (ws && ws.queued && ws.queued[0] && typeof ws.queued[0].type === 'number') ? ws.queued[0].type : -1;
        var q1 = (ws && ws.queued && ws.queued[1] && typeof ws.queued[1].type === 'number') ? ws.queued[1].type : -1;
        var q2 = (ws && ws.queued && ws.queued[2] && typeof ws.queued[2].type === 'number') ? ws.queued[2].type : -1;
        g.push(dftType, q0, q1, q2, selfFire, wpnCool, wpnReload, queueLen, cSec, (ws && ws.active && typeof ws.active.type === 'number') ? 1 : 0);
        diag.selfFire = selfFire; diag.queueLen = queueLen;
        diag.crateSec = cSec; diag.crateNext = null;   // 永久不可得（报告 §十一）
        diag.K_death = kDeath;
        diag.tNowSec = tNow;

        return { globalTok: g, oppTok: opp, colTok: colTok, mineTok: mineTok,
                 // P5：死亡维度按 **K_death 参数**算（`GLOBAL_FIELDS` 只列一份 7 维字段名）
                 dim: (GLOBAL_FIELDS.length - DEATH_DIM) + deathDim(kDeath) + opp.length + colTok.length + mineTok.length,
                 baseDim: (GLOBAL_FIELDS.length - DEATH_DIM) + deathDim(kDeath), diag: diag };
    }

    // ========================================================================
    // P4（§9.2#12）：**玩家稳定整数索引表**
    //   自车 = 0；对手 = 1..N。**顺序跨帧不变**：索引只按"玩家自己的稳定 id"的**字典序**分配，
    //   绝不依赖 `getTanks()` 的对象键顺序（那个顺序在有人死亡/复活时可能变）。
    //   ⚠️ 已分配的索引**永不复用/永不移位**（新 id 只能追加到末尾）⟹ 有人死亡/复活也不变。
    //   死亡事件（P1/P2）与对手段（P4）共用同一张表。
    // ========================================================================
    var _playerIdxOf = {};          // id(str) → 索引
    var _playerIdxOrder = [];       // 已分配顺序（调试/导出用）
    var _deathSeenAt = {};          // P3：死亡事件 key → 首次被观测到时的**树时钟秒**（tNow）

    function stablePlayerIndex(adapter) {
        var selfId = null;
        try { selfId = adapter.getAiId ? adapter.getAiId() : null; } catch (e0) {}
        var tanks = null; try { tanks = adapter.getTanks(); } catch (e1) {}
        var live = keyList(tanks);
        var fresh = [];
        for (var i = 0; i < live.length; i++) {
            var k = String(live[i]);
            if (selfId !== null && selfId !== undefined && k === String(selfId)) continue;
            if (_playerIdxOf[k] === undefined) fresh.push(k);
        }
        // ★ 新 id 按字典序追加（同一批内确定性；不同帧到达也不会让已分配的索引移位）
        fresh.sort();
        for (var j = 0; j < fresh.length; j++) {
            _playerIdxOf[fresh[j]] = _playerIdxOrder.length + 1;
            _playerIdxOrder.push(fresh[j]);
        }
        var idxOf = { };
        if (selfId !== null && selfId !== undefined) idxOf[String(selfId)] = 0;
        for (var m = 0; m < _playerIdxOrder.length; m++) idxOf[_playerIdxOrder[m]] = _playerIdxOf[_playerIdxOrder[m]];
        // oppIds = **当前存活**的对手，按索引升序（= 稳定顺序）
        var oppIds = [];
        for (var n2 = 0; n2 < live.length; n2++) {
            var kk = String(live[n2]);
            if (selfId !== null && selfId !== undefined && kk === String(selfId)) continue;
            oppIds.push(kk);
        }
        oppIds.sort(function (a, b) { return (_playerIdxOf[a] || 999) - (_playerIdxOf[b] || 999); });
        return { selfId: selfId, oppIds: oppIds, idxOf: idxOf, order: _playerIdxOrder.slice(),
                 assigned: { self: (selfId === null || selfId === undefined) ? null : 0 } };
    }

    /** 仅测试用：清空索引表/死亡首见表（跨局复位；产品路径不调用）。 */
    function _resetStableIds() { _playerIdxOf = {}; _playerIdxOrder = []; _deathSeenAt = {}; return true; }

    // ========================================================================
    // 六、毒雾段（6 维）—— 作弊全开：**下次方向=已实现**；⚠️**「何时出现」未实现**（本地 training_mode.js:1971 gc.storm=false 跑不到；无风暴时输出 [0,0,0,0,0,-1]）
    // ========================================================================
    /**
     * ⚠️ 状态：**取数已通，产品侧 1-4-d 未落地**（本地版默认无毒雾）。
     * 字段：`active` + 风暴边 4 条 + `nextDir`（0=右 1=左 2=上 3=下，−1=不可知）
     * 真源：`adapter.getZones()` → `Constants.ZONE_TYPES.STORM`(=3) → `getCorners()`/`getTiles()`/
     *       `_expansionSequence` / `_expansionTiles{Top,Bottom,Left,Right}` / `_expansionTime`
     */
    function encodeStorm(adapter, opts) {
        opts = opts || {};
        var worldW = num(opts.worldW, 0), worldH = num(opts.worldH, 0);
        var norm = !!opts.normalize;
        var zones = null; try { zones = adapter.getZones(); } catch (e) {}
        var STORM = 3; try { if (typeof Constants !== 'undefined' && Constants.ZONE_TYPES) STORM = Constants.ZONE_TYPES.STORM; } catch (eS) {}
        var z = null;
        var zk = keyList(zones);
        for (var i = 0; i < zk.length; i++) { var zz = zones[zk[i]]; if (zz && num(callf(zz, 'getType', -1), -1) === STORM) { z = zz; break; } }
        if (!z) return { token: [0, 0, 0, 0, 0, -1], dim: STORM_DIM, active: false, diag: { nZones: zk.length } };

        // 边界：优先 getCorners()（连续移动，不是跳格）；真源形状见下一行的 ★ 说明
        // ★★ 真源形状（`7b2ed8ad3598d7321f8f3d2b04b1eac8.js:40` 的 `StormZone.getCorners()`；真机实测 `_tools/headless/_i4_probe_spec_1_4d.log:9`）：
        //    返回 **8 个扁平数字** stormStartRight/stormEndRight/stormStartBottom/stormEndBottom/
        //    stormStartLeft/stormEndLeft/stormStartTop/stormEndTop —— ⛔ 没有 minX/maxX，⛔ 也不是 {x,y} 点对象。
        //    安全区 = 矩形 **[stormEndLeft, stormStartRight] × [stormEndTop, stormStartBottom]**
        //    出处：`game_core/js/vantage_sandbox.js:3955`（毒雾判死模块注释，`_i4` 探针验过）
        //    ⚠️ 真机那次 `_i4_probe_spec_1_4d.log:9` 的 `corners` 里没有 minX 这类键 ⟹ 旧代码走"点对象"分支
        //       对 `number` 取 `pt.x`/`pt[0]` 全是 undefined ⟹ 4 条边恒 0（已由 golden 单测钉住）
        var corners = callf(z, 'getCorners', null);
        var eL = 0, eR = 0, eT = 0, eB = 0, cornersOk = false;
        // ★ 先按真源形状解析（8 个扁平数字）；解析成功 ⟹ `cornersOk = true` ⟹ 下面的兼容兜底一律不再覆盖
        try {
            var cr = corners;
            if (cr && typeof cr === 'object' &&
                typeof cr.stormEndLeft === 'number' && typeof cr.stormStartRight === 'number' &&
                typeof cr.stormEndTop === 'number' && typeof cr.stormStartBottom === 'number') {
                eL = cr.stormEndLeft; eR = cr.stormStartRight;
                eT = cr.stormEndTop; eB = cr.stormStartBottom; cornersOk = true;
            }
        } catch (eCRN) {}
        try {
            if (!cornersOk && corners && typeof corners === 'object') {
                if (typeof corners.minX === 'number') { eL = corners.minX; eR = corners.maxX; eT = corners.minY; eB = corners.maxY; }
                else {
                    var mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, any = false;
                    for (var c in corners) {
                        var pt = corners[c];
                        var px = (pt && typeof pt.x === 'number') ? pt.x : (pt && typeof pt[0] === 'number' ? pt[0] : null);
                        var py = (pt && typeof pt.y === 'number') ? pt.y : (pt && typeof pt[1] === 'number' ? pt[1] : null);
                        if (px === null || py === null) continue;
                        any = true;
                        if (px < mnx) mnx = px; if (px > mxx) mxx = px;
                        if (py < mny) mny = py; if (py > mxy) mxy = py;
                    }
                    if (any) { eL = mnx; eR = mxx; eT = mny; eB = mxy; }
                }
            }
        } catch (eCN) {}

        // 下次方向：从游戏的扩张序列 + 已扩格数推（拿不到就给 −1，⛔ **不编**）
        var nextDir = -1, diag = { nZones: zk.length, cornersOk: cornersOk };
        try {
            var seq = z.getField ? z.getField('expansionSequence') : z._expansionSequence;
            if (!seq) seq = z._expansionSequence;
            var tR = num(z.getField ? z.getField('expansionTilesRight') : z._expansionTilesRight, 0);
            var tL = num(z.getField ? z.getField('expansionTilesLeft') : z._expansionTilesLeft, 0);
            var tT = num(z.getField ? z.getField('expansionTilesTop') : z._expansionTilesTop, 0);
            var tB = num(z.getField ? z.getField('expansionTilesBottom') : z._expansionTilesBottom, 0);
            var done = tR + tL + tT + tB;
            diag.seqLen = seq ? seq.length : null; diag.done = done;
            diag.counts = { r: tR, l: tL, t: tT, b: tB };
            if (seq && seq.length && done < seq.length) {
                var nxt = seq[done];
                // ★ 游戏的 side 编码（`StormZone.update` 的 switch，`7b2ed8ad3598d7321f8f3d2b04b1eac8.js:40`）：
                //   0 → `_expansionTilesRight += 1`（右）· 1 → Bottom（下）· 2 → Left（左）· 3 → Top（上）
                //   实测佐证：`_tools/headless/_i4_probe_spec_1_4d.log:24` `side=2 RBLT=0010`（第 3 位 L 计数 +1 ⟹ side2=左）
                //   本段 dir 口径（见函数头注释）：**0=右 1=左 2=上 3=下，−1=不可知**
                var SIDE2DIR = { 0: 0, 1: 3, 2: 1, 3: 2 }; // 游戏 side ⟹ 本段 dir（右→0 · 下→3 · 左→1 · 上→2）
                if (typeof nxt === 'number' && SIDE2DIR[nxt] !== undefined) nextDir = SIDE2DIR[nxt];
            }
        } catch (eSeq) {}

        return {
            token: [1,
                    norm && worldW ? eL / worldW : eL, norm && worldW ? eR / worldW : eR,
                    norm && worldH ? eT / worldH : eT, norm && worldH ? eB / worldH : eB,
                    nextDir],
            dim: STORM_DIM, active: true, diag: diag, raw: { eL: eL, eR: eR, eT: eT, eB: eB }
        };
    }

    // ========================================================================
    // 七、整帧编码
    // ========================================================================
    /**
     * @param {Object} ctx `{adapter, tree, plan, K_fire, normalize, horizonSec}`
     * ⚠️ `tree` 可为 null（只要节点段；**只调 `tree.dumpDiagnostics` 与只读采集口**）。
     */
    function encode(ctx) {
        ctx = ctx || {};
        var adapter = ctx.adapter;
        var normalize = !!ctx.normalize;
        var horizonSec = num(ctx.horizonSec, 10) || 10;
        var K_fire = (ctx.K_fire === undefined) ? 4 : (ctx.K_fire | 0);

        var maze = null; try { maze = adapter.getMaze(); } catch (e) {}
        var ms = mapSizeOf(maze);

        // 节点：**只走被批准的唯一只读入口**
        var nodeRes = { tokens: [], ids: [], stat: {}, dim: NODE_DIM };
        try {
            var VTO = global.VantageTree;
            if (ctx.tree && VTO && typeof VTO.collectAgentNodes === 'function') {
                var rows = VTO.collectAgentNodes(ctx.tree);
                var rootXY = null;
                for (var ri = 0; ri < rows.length; ri++) if (rows[ri].parentId === null || rows[ri].parentId === undefined) { rootXY = rows[ri]; break; }
                nodeRes = encodeNodes(rows, {
                    rootX: rootXY ? rootXY.x : 0, rootY: rootXY ? rootXY.y : 0, rootRot: rootXY ? rootXY.rot : 0,
                    mapW: ms.w, mapH: ms.h, horizonSec: horizonSec,
                    frameDt: (ctx.frameDt !== undefined) ? ctx.frameDt : 0.02, normalize: normalize
                });
                nodeRes.nRows = rows.length;
            }
        } catch (eN) { nodeRes.err = String((eN && eN.message) || eN); }

        var bulRes = encodeBullets(adapter, { mapW: ms.w, mapH: ms.h, normalize: normalize });
        var lagRes = ctx.tree ? encodeRootLag(ctx.tree, horizonSec) : { value: null, dim: ROOTLAG_DIM, available: false };
        var planRes = encodePlan(ctx.plan || null, K_fire);
        // P3/P5：把树时钟"现在"（秒）与 K_death 一起透传进全局段（tAge 与 tRel/rootLag 同基准）
        var K_death = (ctx.K_death === undefined) ? 1 : (ctx.K_death | 0);
        var tNowSec = (lagRes && typeof lagRes.tNow === 'number') ? lagRes.tNow : null;
        var gRes = encodeGlobal(adapter, { mapW: ms.w, mapH: ms.h, normalize: normalize,
                                          K_death: K_death, horizonSec: horizonSec, tNowSec: tNowSec });
        var stRes = encodeStorm(adapter, { worldW: ms.w, worldH: ms.h, normalize: normalize });

        var total = nodeRes.tokens.length * NODE_DIM + bulRes.tokens.length * BULLET_DIM +
                    ROOTLAG_DIM + planRes.dim + gRes.dim + STORM_DIM;
        return {
            nodes: nodeRes, bullets: bulRes,
            rootLag: lagRes, plan: planRes,
            global: gRes, storm: stRes,
            mapSize: ms, rootPose: (nodeRes.rootRef || { x: 0, y: 0, rot: 0 }),
            dims: { node: nodeRes.tokens.length * NODE_DIM, bullet: bulRes.tokens.length * BULLET_DIM,
                    rootLag: ROOTLAG_DIM, plan: planRes.dim, global: gRes.dim, storm: STORM_DIM, total: total },
            horizonSec: horizonSec, thetaConvention: THETA_CONVENTION, normalize: normalize
        };
    }

    // ========================================================================
    // 八、★ 纯 token → 世界（给调试页用；**"左边画 token 解出来的世界"的唯一实现**）
    // ========================================================================
    /**
     * ⛔ **本函数只读 `enc`（= 一次 `encode()` 的返回值），绝不碰 `gc` / `adapter` / 游戏对象。**
     * 判据（第三步要求 #2）：**左边画的东西必须从【和右边同一份数据】来** ——
     *   因为 `buildScene` 的入参就是右边那份 `enc`，**"另取一份世界"在结构上不可能发生**。
     *
     * 坐标怎么从 token 还原成世界：
     *   · 节点 `x,y` 是**相对根**的位移 ⟹ 绝对位姿 = `rootPose + (dx,dy)`
     *   · 节点 `rot` 是**相对根**的转角   ⟹ 绝对转角 = `rootPose.rot + dRot`
     *   · 子弹 `x,y` 本来就是绝对量；航向直接读 `θ`
     *   ⚠️ 根自己的 token 是 `[uid,-1,slot,0,0,0,0,0,0,*]` ⟹ 还原出来正好落在 `rootPose` ✅（可当自检）
     */
    function buildScene(enc) {
        enc = enc || {};
        var rp = enc.rootPose || { x: 0, y: 0, rot: 0 };
        var nt = (enc.nodes && enc.nodes.tokens) || [];
        var bt = (enc.bullets && enc.bullets.tokens) || [];
        var nodes = [];
        for (var i = 0; i < nt.length; i++) {
            var t = nt[i];
            nodes.push({
                idx: i, uid: t[0], parentIdx: t[1], slot: t[2], depth: t[3],
                tRel: t[4], L: t[5],
                x: rp.x + t[6], y: rp.y + t[7], rot: rp.rot + t[8],
                hasGrown: t[9]
            });
        }
        var bullets = [];
        for (var j = 0; j < bt.length; j++) {
            var b = bt[j];
            bullets.push({ idx: j, x: b[0], y: b[1], vx: b[2], vy: b[3],
                           theta: b[4], type: b[5], lifeLeft: b[6] });
        }
        var byP = {};
        for (var k = 0; k < nodes.length; k++) {
            var pi = nodes[k].parentIdx;
            if (pi < 0) continue;
            (byP[pi] = byP[pi] || []).push(nodes[k].slot);
        }
        var branches = [], missingSlots = [];
        for (var pk in byP) {
            var slots = byP[pk].slice().sort(function (a, c) { return a - c; });
            var uniq = [];
            for (var s = 0; s < slots.length; s++) if (uniq.indexOf(slots[s]) < 0) uniq.push(slots[s]);
            var miss = [];
            for (var q = 0; q < 9; q++) if (uniq.indexOf(q) < 0) miss.push(q);
            var rec = { parentIdx: Number(pk), nChildren: uniq.length, slots: uniq, missing: miss };
            branches.push(rec);
            if (miss.length && miss.length < 9) missingSlots.push(rec);
        }
        // 替代信号（阶段 3-2 之前的过渡口径）：真死子节点 `L === 1`
        var shortL = [];
        for (var m = 0; m < nodes.length; m++) if (nodes[m].L === 1) shortL.push(nodes[m].idx);
        return {
            rootPose: rp, nodes: nodes, bullets: bullets,
            branches: branches, missingSlots: missingSlots, shortL: shortL,
            mapSize: enc.mapSize || null,
            stat: { N: nodes.length, M: bullets.length, nBranches: branches.length,
                    nMissing: missingSlots.length, nShortL: shortL.length,
                    total: (enc.dims && enc.dims.total) || 0 }
        };
    }

    global.VantageObserve = {
        VERSION: 'v199',
        NODE_DIM: NODE_DIM, BULLET_DIM: BULLET_DIM, STORM_DIM: STORM_DIM, ROOTLAG_DIM: ROOTLAG_DIM,
        NODE_FIELDS: NODE_FIELDS, BULLET_FIELDS: BULLET_FIELDS, STORM_FIELDS: STORM_FIELDS,
        GLOBAL_FIELDS: GLOBAL_FIELDS, OPP_FIELDS: OPP_FIELDS, COL_FIELDS: COL_FIELDS, MINE_FIELDS: MINE_FIELDS,
        THETA_CONVENTION: THETA_CONVENTION,
        bulletTheta: bulletTheta, wrapPi: wrapPi, mapSizeOf: mapSizeOf, planDim: planDim,
        encodeNodes: encodeNodes, encodeBullets: encodeBullets, encodeRootLag: encodeRootLag,
        encodePlan: encodePlan, encodeGlobal: encodeGlobal, encodeStorm: encodeStorm,
        encode: encode, buildScene: buildScene,
    };

    console.log('[Vantage Observe] 模块已加载（v199 · 阶段2-3 观测编码器；**纯读**：只走 adapter 取数 + VantageTree.collectAgentNodes；' +
        '节点 ' + NODE_DIM + ' 维 / 子弹 ' + BULLET_DIM + ' 维动态M / 根滞后 1 / 上帧计划 3+2K / 全局段 / 毒雾 6；' +
        '子弹角约定=' + THETA_CONVENTION + '（与 Tank.rotation 同套）；⛔ 绝不调 noteDeath）');
})(typeof window !== 'undefined' ? window : this);
