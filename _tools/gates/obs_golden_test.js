/**
 * ============================================================================
 *  obs_golden_test.js —— 观测编码器「golden-vector」单测（storm 6 / rootLag 1 / plan 3+2K）
 * ============================================================================
 * 性质：**纯 node、零依赖、不需要游戏、不需要浏览器**（`vm` 里加载 `vantage_observe.js`，
 *       喂**构造的假 adapter / 假树 / 假 zone**，逐字段断言）。
 *
 * 为什么要有：`实现度对账-代码vs文档-2026-10-17.md:49-51` 判这三段「产出但未接入」；
 *   本单测是**接入之前**的前置证据：**先把"编码器本身对不对"钉死**，再接网络槽位。
 *
 * 字段权威（⛔ 本文件的期望值只许来自这里，不许来自实现）：
 *   · 定稿字段表 `docs/Vantage躲弹实现/02-实现/实施方案/阶段2-3观测字段表-定稿-2026-10-12.md`
 *       - §3.2 根滞后 1 维（`:252-262`）：rootLag = (tNow − rootAbsT) ÷ 10.0
 *       - §3.3 上帧计划 `3 + 2·K_fire`（`:264-277`）：Q0 leafId / Q1 stale(0,1) / Q2 nFire / Q3.. (nodeId,back)×K
 *                                    无计划退化值 = Q0 −1 · Q1 1 · Q2 0 · 空位 −1
 *       - §3.4 毒雾 6 维（`:279-294`）：S0 active / S1-S4 安全区 4 条边(左,右,上,下) / S5 nextDir
 *   · 毒雾真源形状 `game_core/js/7b2ed8ad3598d7321f8f3d2b04b1eac8.js:40`（`StormZone.getCorners()`）
 *       ⟹ 返回 **8 个扁平数字**：stormStartRight/stormEndRight/stormStartBottom/stormEndBottom/
 *          stormStartLeft/stormEndLeft/stormStartTop/stormEndTop
 *       ⟹ **没有** minX/maxX/minY/maxY，**也不是** `{x,y}` 点对象
 *   · 安全区 = 矩形 **[stormEndLeft, stormStartRight] × [stormEndTop, stormStartBottom]**
 *       ⟹ 出处 `game_core/js/vantage_sandbox.js:3955`（毒雾判死模块的注释，`_i4` 探针验过）
 *   · 游戏 side 编码 **0=右 1=下 2=左 3=上**
 *       ⟹ 出处①`StormZone.update`（同 `7b2ed8ad…js:40`）：case0→TilesRight / case1→TilesBottom /
 *                case2→TilesLeft / case3→TilesTop
 *       ⟹ 出处②实测 `_tools/headless/_i4_probe_spec_1_4d.log:24`：`side=2 RBLT=0010`（L 计数 +1）
 *   · 编码器自己声明的 dir 口径（`vantage_observe.js:596`）：**0=右 1=左 2=上 3=下，−1=不可知**
 *
 * 跑法：`node _tools/gates/obs_golden_test.js`      （退出码：0=全 PASS，1=有 FAIL）
 * ⛔ 纪律：**断言不许按实现改**。实现错 ⟹ 本测试就报 FAIL（那是它的本职工作）。
 * ============================================================================
 */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.resolve(__dirname, '..', '..');
var SRC_PATH = path.join(ROOT, 'game_core', 'js', 'vantage_observe.js');

// ── 结果收集 ────────────────────────────────────────────────────────────
var ROWS = [];
function check(name, ok, detail) { ROWS.push({ name: name, ok: !!ok, detail: detail }); }
function show(v) {
    if (typeof v === 'number') return String(v);
    if (v === undefined) return 'undefined';
    try { return JSON.stringify(v); } catch (e) { return String(v); }
}
function eq(name, actual, expected) {
    check(name, show(actual) === show(expected), 'expected=' + show(expected) + ' actual=' + show(actual));
}

// ── 加载编码器（Node 环境：把 window 指到 sandbox 本身）──────────────────
function loadObserve(opts) {
    opts = opts || {};
    var sandbox = {
        console: { log: function () { }, warn: function () { }, error: function () { } },
        // 出处：`阶段2-3观测字段表-定稿-2026-10-12.md:283`（ZONE_TYPES.STORM = 3）+ 图块 10 m
        Constants: { MAZE_TILE_SIZE: { m: 10 }, ZONE_TYPES: { STORM: 3 } }
    };
    sandbox.window = sandbox;
    if (opts.vantageTreeGlobals) sandbox.VantageTree = opts.vantageTreeGlobals;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SRC_PATH, 'utf8'), sandbox, { filename: SRC_PATH });
    if (!sandbox.VantageObserve) throw new Error('vantage_observe.js 没有挂上 VantageObserve（加载失败）');
    return sandbox;
}

// ── 假 adapter（只实现编码器真会调的读取口；没有的一律不实现）────────────
function makeAdapter(over) {
    var base = {
        getMaze: function () { return { getWidth: function () { return 8; }, getHeight: function () { return 5; } }; }, // 8×5 格 ×10m = 80×40 m
        getMatchConfig: function () { return { symmetric: true, storm: 1, crateTypes: [], maxActivePlayerCount: 2 }; },
        getTankState: function () { return null; },
        getAiId: function () { return 'vantage_1'; },
        getTanks: function () { return {}; },
        getProjectiles: function () { return []; },
        getTraps: function () { return {}; },
        getCollectibles: function () { return {}; },
        getCounters: function () { return null; },
        getState: function () { return 'in round'; },
        getDeaths: function () { return []; },
        getZones: function () { return {}; },
        getUpgradeByPlayerIdAndType: function () { return null; }
    };
    if (over) for (var k in over) if (Object.prototype.hasOwnProperty.call(over, k)) base[k] = over[k];
    return base;
}

/**
 * 假 STORM zone —— **形状逐字照抄真游戏**（`7b2ed8ad…js:40` 的 `StormZone`）：
 *   · getType()  === Constants.ZONE_TYPES.STORM (3)
 *   · getCorners() → 8 个扁平数字（名字形如 stormStartRight / stormEndLeft …）
 *   · getField('expansionSequence') → 扩张序列（游戏侧编码 0=右 1=下 2=左 3=上）
 *   · getField('expansionTiles{Right,Bottom,Left,Top}') → 已扩格数
 */
function makeStormZone(o) {
    o = o || {};
    var seq = o.seq || [2];
    var tiles = { expansionTilesRight: o.r | 0, expansionTilesBottom: o.b | 0, expansionTilesLeft: o.l | 0, expansionTilesTop: o.tp | 0 };
    var corners = o.corners;
    return {
        getType: function () { return 3; }, // Constants.ZONE_TYPES.STORM
        getField: function (name) {
            if (name === 'expansionSequence') return seq;
            if (tiles[name] !== undefined) return tiles[name];
            return undefined;
        },
        getCorners: function () { return corners; }
    };
}

/** 真形状的 getCorners()：安全区 = [stormEndLeft, stormStartRight] × [stormEndTop, stormStartBottom] */
var CORNERS_A = {
    stormStartRight: 61.5, stormEndRight: 80.5,
    stormStartBottom: 26.5, stormEndBottom: 40.5,
    stormStartLeft: -0.5, stormEndLeft: 12.5,
    stormStartTop: -0.5, stormEndTop: 8.5
};
// 期望的安全区 4 条边（左,右,上,下）⟹ 出处 `vantage_sandbox.js:3955`
var SAFE_A = { eL: 12.5, eR: 61.5, eT: 8.5, eB: 26.5 };

// ── 假树 ────────────────────────────────────────────────────────────────
var DIAG = { tNow: 30.5, rootAbsT: 28.0 }; // 树时钟 30.5 s、根对应 28.0 s ⟹ 滞后 2.5 s
function makeTree(diag, rows) {
    return {
        rows: rows || [],
        dumpDiagnostics: function () { return diag; }
    };
}
// 节点行（`VantageTree.collectAgentNodes` 的只读快照形状；只用来让整帧 encode 跑得像真的）
var NODE_ROWS = [
    { id: 1, parentId: null, opIndex: -1, depth: 0, tGlobal: 0.0, x: 10, y: 10, rot: 0.0, hasGrown: true, nChildren: 1, invalid: false },
    { id: 2, parentId: 1, opIndex: 3, depth: 1, tGlobal: 0.5, x: 12, y: 10, rot: 0.5, hasGrown: false, nChildren: 0, invalid: false, fullDead: false, fullDeathFrame: 0 }
];

// ========================================================================
// 一、字段名/顺序：⛔ 期望值硬写在测试里（来自定稿字段表），⛔ 不从实现里读
// ========================================================================
var DOC_STORM_FIELDS = ['active', 'edgeL', 'edgeR', 'edgeT', 'edgeB', 'nextDir']; // 定稿 §3.4（S0,S1-S4,S5）
var DOC_PLAN_HEAD = ['planLeafId', 'planStale', 'nFire'];                              // 定稿 §3.3（Q0,Q1,Q2）

function groupStormFields(VO) {
    eq('storm.STORM_DIM', VO.STORM_DIM, 6);
    eq('storm.STORM_FIELDS（与定稿 §3.4 逐字对拍）', VO.STORM_FIELDS, DOC_STORM_FIELDS);
    eq('rootLag.ROOTLAG_DIM', VO.ROOTLAG_DIM, 1);
    eq('plan.planDim(4) = 3+2·4', VO.planDim(4), 11);
    eq('plan.planDim(0) = 3', VO.planDim(0), 3);
}

// ========================================================================
// 二、storm：6 维 · 字段顺序 · 取值 · nextDir 口径
// ========================================================================
function encodeStormWith(zone, opts) {
    var box = loadObserve({});
    var VO = box.VantageObserve;
    var enc = VO.encode({
        adapter: makeAdapter({ getZones: function () { return zone ? { z1: zone } : {}; } }),
        tree: null, horizonSec: 10, K_death: 1, frameDt: 1 / 60,
        normalize: !!(opts && opts.normalize)
    });
    return { VO: VO, enc: enc, storm: enc.storm };
}

function groupStorm() {
    // ── 2.1 有风暴（真形状）─────────────────────────────────────────────
    // 游戏 side 2 = 左（出处见文件头）⟹ 编码器声明口径 0=右 1=左 2=上 3=下 ⟹ 期望 dir = 1
    var zone = makeStormZone({ seq: [2], corners: CORNERS_A });
    var r = encodeStormWith(zone, { normalize: false });
    var tok = r.storm.token;

    check('storm.token 是 6 维单 token（M=1）', Array.isArray(tok) && tok.length === 6 && r.storm.dim === 6,
        'len=' + (tok ? tok.length : 'null') + ' dim=' + r.storm.dim + ' token=' + show(tok));

    // 顺序对拍：把 6 个字段故意做成互不相同的值 ⟹ 位置错位必被抓到
    var EXPECT_A = [1, SAFE_A.eL, SAFE_A.eR, SAFE_A.eT, SAFE_A.eB, 1];
    eq('storm.token 全 6 位（顺序=STORM_FIELDS，值按真源形状解析）', show(tok), show(EXPECT_A));

    // 逐位点名（便于报告直接引用"哪一位错"）
    eq('storm.active', tok && tok[0], 1);
    eq('storm.edgeL(安全区左边=stormEndLeft)', tok && tok[1], SAFE_A.eL);
    eq('storm.edgeR(安全区右边=stormStartRight)', tok && tok[2], SAFE_A.eR);
    eq('storm.edgeT(安全区上边=stormEndTop)', tok && tok[3], SAFE_A.eT);
    eq('storm.edgeB(安全区下边=stormStartBottom)', tok && tok[4], SAFE_A.eB);
    eq('storm.nextDir(游戏 side 2=左 ⟹ 编码器声明口径的 1=左)', tok && tok[5], 1);

    // ── 2.2 契约：storm 段不许 return 一个「什么都不带」的对象 ──────────────
    check('storm 段带 raw 诊断（eL/eR/eT/eB）', r.storm.raw && typeof r.storm.raw === 'object',
        'raw=' + show(r.storm.raw));

    // ── 2.3 无风暴 ⟹ 退化值 [0,0,0,0,0,-1]（定稿 §3.4：active=0；dir=−1=不可知）──
    var r0 = encodeStormWith(null, {});
    eq('storm 无风暴退化值', show(r0.storm.token), show([0, 0, 0, 0, 0, -1]));

    // ── 2.4 normalize=true：÷ 世界宽/高（80×40 m；出处 vantage_observe.js 文件头"归一化按地图物理尺寸"）──
    var rn = encodeStormWith(makeStormZone({ seq: [2], corners: CORNERS_A }), { normalize: true });
    var EXPECT_N = [1, SAFE_A.eL / 80, SAFE_A.eR / 80, SAFE_A.eT / 40, SAFE_A.eB / 40, 1];
    eq('storm normalize=true（÷80/÷40）', show(rn.storm.token), show(EXPECT_N));

    // ── 2.5 nextDir 全 4 个游戏 side 的映射表（逐条打印：一眼看出错位）──────
    //     游戏 side（出处见文件头）= 0:右 1:下 2:左 3:上
    //     编码器声明 dir 口径（vantage_observe.js:596）= 0:右 1:左 2:上 3:下
    var GAME_SIDE_NAME = { 0: '右', 1: '下', 2: '左', 3: '上' };
    var EXPECT_DIR = { 0: 0, 1: 3, 2: 1, 3: 2 }; // 游戏 side ⟹ 同"方向"的 dir 码
    var mapRows = [];
    for (var side = 0; side < 4; side++) {
        var rs = encodeStormWith(makeStormZone({ seq: [side], corners: CORNERS_A }), {});
        var got = rs.storm.token ? rs.storm.token[5] : undefined;
        mapRows.push({ side: side, gameSays: GAME_SIDE_NAME[side], expectDir: EXPECT_DIR[side], actualDir: got });
        eq('storm.nextDir 映射 side=' + side + '（游戏"' + GAME_SIDE_NAME[side] + '"⟹dir ' + EXPECT_DIR[side] + '）', got, EXPECT_DIR[side]);
    }
    console.log('  ── nextDir 映射表（游戏 side ⟹ dir）──────────────');
    for (var mi = 0; mi < mapRows.length; mi++) {
        var m = mapRows[mi];
        console.log('     side=' + m.side + '(游戏' + m.gameSays + ')  期望dir=' + m.expectDir + '  实际dir=' + m.actualDir +
            (m.expectDir === m.actualDir ? '  ✅' : '  ❌'));
    }

    // ── 2.6 dir=−1 分支（序列拿不到 ⟹ 不许编，定稿 §3.4 "−1=不可知"）──────
    var rz = encodeStormWith({ getType: function () { return 3; }, getCorners: function () { return CORNERS_A; } }, {});
    eq('storm 拿不到 expansionSequence ⟹ nextDir=−1', rz.storm.token && rz.storm.token[5], -1);
}

// ========================================================================
// 三、rootLag：1 维 · 取值 = (tNow − rootAbsT) ÷ horizon
// ========================================================================
function encodeWithDiag(diag, opts) {
    opts = opts || {};
    var tree = makeTree(diag, NODE_ROWS);
    var box = loadObserve({
        // 真跑路径：`VantageTree` 是**模块级**对象，dumpDiagnostics 挂在它上面（不是 getTree() 的视图）
        vantageTreeGlobals: opts.withModuleTree
            ? { dumpDiagnostics: function () { return diag; }, collectAgentNodes: function (t) { return t.rows; } }
            : undefined
    });
    var VO = box.VantageObserve;
    var enc = VO.encode({
        adapter: makeAdapter({}), tree: opts.treeNull ? null : tree,
        horizonSec: (opts.horizonSec === undefined ? 10 : opts.horizonSec),
        K_death: 1, frameDt: 1 / 60, K_fire: 4
    });
    return { VO: VO, enc: enc, lag: enc.rootLag };
}

function groupRootLag() {
    // ── 3.1 主路径（模块级 VantageTree.dumpDiagnostics）─────────────────
    var a = encodeWithDiag({ tNow: 30.5, rootAbsT: 28.0 }, { withModuleTree: true });
    eq('rootLag.dim', a.lag.dim, 1);
    eq('rootLag.available', a.lag.available, true);
    eq('rootLag.value = (30.5−28.0)/10 = 0.25', a.lag.value, 0.25);
    eq('rootLag.tNow 透出（必须等于构造值）', a.lag.tNow, 30.5);
    eq('rootLag.rootAbsT 透出（必须等于构造值）', a.lag.rootAbsT, 28.0);
    eq('enc.dims.rootLag', a.enc.dims.rootLag, 1);

    // ── 3.2 换一个 tNow：值必须跟着变（防"恒 0 / 写死"）─────────────────
    var b = encodeWithDiag({ tNow: 31.25, rootAbsT: 28.0 }, { withModuleTree: true });
    eq('rootLag.value 第二样本 (31.25−28.0)/10 = 0.325', b.lag.value, 0.325);

    // ── 3.3 不变量：根=现在 ⟹ 滞后 0（定稿 §3.2"树的根永远=现在"）────────
    var c = encodeWithDiag({ tNow: 12.0, rootAbsT: 12.0 }, { withModuleTree: true });
    eq('rootLag 根=现在 ⟹ 0', c.lag.value, 0);

    // ── 3.4 horizonSec 参数化（1 帧 1 个 horizon 的缩放；调用点全传 10）────
    var d = encodeWithDiag({ tNow: 30.5, rootAbsT: 28.0 }, { withModuleTree: true, horizonSec: 5 });
    eq('rootLag horizonSec=5 ⟹ 2.5/5 = 0.5', d.lag.value, 0.5);

    // ── 3.5 树对象自带 dumpDiagnostics 的兜底路径（getTree() 视图没有它）──
    var e = encodeWithDiag({ tNow: 40.0, rootAbsT: 37.5 }, { withModuleTree: false });
    eq('rootLag 兜底(tree.dumpDiagnostics).value (40−37.5)/10', e.lag.value, 0.25);
    eq('rootLag 兜底路径.dim', e.lag.dim, 1);

    // ── 3.6 ⚠️ tree 为 null 的退化分支：**dim 也必须还是 1**（否则下游拼张量算不出宽）
    //     现状：`vantage_observe.js:697` 的退化对象里**没有 dim 键** ⟹ 这里会 FAIL
    var f = encodeWithDiag(null, { treeNull: true });
    eq('rootLag(tree=null) 退化分支.dim', f.lag.dim, 1);
    eq('rootLag(tree=null) 退化分支.available', f.lag.available, false);
}

// ========================================================================
// 四、plan：3+2·K_fire · 给定 ctx.plan 时往返一致
// ========================================================================
function encodePlanWith(plan, K) {
    var box = loadObserve({});
    var VO = box.VantageObserve;
    var enc = VO.encode({
        adapter: makeAdapter({}), tree: makeTree(DIAG, NODE_ROWS),
        horizonSec: 10, K_death: 1, frameDt: 1 / 60, K_fire: K, plan: plan
    });
    return { VO: VO, enc: enc, plan: enc.plan };
}

/** 编码器的对外布局（定稿 §3.3）：[leafId, stale, nFire, (nodeId,back)×K] */
function decodePlanToken(tok, K) {
    var fires = [];
    for (var i = 0; i < K; i++) {
        var nodeId = tok[3 + 2 * i], back = tok[3 + 2 * i + 1];
        if (nodeId === -1 && back === -1) continue;
        fires.push({ nodeId: nodeId, back: back });
    }
    return { leafId: tok[0], stale: tok[1], nFire: tok[2], fires: fires };
}

function groupPlan() {
    // ── 4.1 维度 = 3 + 2·K_fire（K 是参数，不许把 4 写进布局）──────────────
    var Ks = [0, 1, 4, 8];
    for (var i = 0; i < Ks.length; i++) {
        var K = Ks[i];
        var r = encodePlanWith(null, K);
        eq('plan.dim (K_fire=' + K + ') = 3+2·K', r.plan.dim, 3 + 2 * K);
        eq('enc.dims.plan (K_fire=' + K + ')', r.enc.dims.plan, 3 + 2 * K);
        check('plan.token 长度 == dim (K_fire=' + K + ')',
            Array.isArray(r.plan.token) && r.plan.token.length === 3 + 2 * K,
            'len=' + (r.plan.token ? r.plan.token.length : 'null'));
    }

    // ── 4.2 无计划 ⟹ 退化值（定稿 §3.3 右列：Q0 −1 / Q1 1 / Q2 0 / 空位 −1）──
    var r0 = encodePlanWith(null, 4);
    eq('plan 无计划退化值 token', show(r0.plan.token), show([-1, 1, 0, -1, -1, -1, -1, -1, -1, -1, -1]));

    // ── 4.3 ★ 往返一致：给定 ctx.plan ⟹ 输出 == 输入 ────────────────────
    var PLAN = { leafId: 37, stale: 1, fires: [{ nodeId: 12, back: 3 }, { nodeId: 40, back: 0 }] };
    var r1 = encodePlanWith(PLAN, 4);
    var EXPECT = [37, 1, 2, 12, 3, 40, 0, -1, -1, -1, -1];
    eq('plan 给定 ctx.plan=K_fire 4 ⟹ 逐位等于期望', show(r1.plan.token), show(EXPECT));

    var back = decodePlanToken(r1.plan.token, 4);
    eq('plan 往返：leafId', back.leafId, PLAN.leafId);
    eq('plan 往返：stale', back.stale, PLAN.stale);
    eq('plan 往返：nFire', back.nFire, PLAN.fires.length);
    eq('plan 往返：fires', show(back.fires), show(PLAN.fires));

    // ── 4.4 K_fire=4、只给 1 个射击点 ⟹ 其余全 −1（空位=未用，不是 0）──────
    var r2 = encodePlanWith({ leafId: 5, stale: 0, fires: [{ nodeId: 9, back: 1 }] }, 4);
    eq('plan 单射击点 + 空位补 −1', show(r2.plan.token), show([5, 0, 1, 9, 1, -1, -1, -1, -1, -1, -1]));

    // ── 4.5 超 K_fire：**必须计数上报**（铁律"截断不计数=静默丢数据"）────────
    var BIG = { leafId: 1, stale: 0, fires: [{ nodeId: 1, back: 0 }, { nodeId: 2, back: 0 }, { nodeId: 3, back: 0 }, { nodeId: 4, back: 0 }, { nodeId: 5, back: 0 }, { nodeId: 6, back: 0 }] };
    var r3 = encodePlanWith(BIG, 4);
    eq('plan 超限：dim 仍是 3+2·4', r3.plan.dim, 11);
    eq('plan 超限：truncated 计数 = 6−4', r3.plan.truncated, 2);
    eq('plan 超限：nFire 报真实条数（不撒谎）', r3.plan.token[2], 6);

    // ── 4.6 整帧总维数自洽：node·10 + bullet·7 + 1 + plan + global + 6 ─────
    var r4 = encodePlanWith(PLAN, 4);
    var d = r4.enc.dims;
    var sum = d.node + d.bullet + d.rootLag + d.plan + d.global + d.storm;
    eq('enc.dims.total == 各段之和', d.total, sum);
    check('node 段行数×10 与 dims.node 一致', d.node === r4.enc.nodes.tokens.length * 10,
        'rows=' + r4.enc.nodes.tokens.length + ' dims.node=' + d.node);
    console.log('  ── 关键数值（Plan 组）────────────────────────');
    console.log('     K_fire=4 ⟹ plan.dim=' + r4.plan.dim + '  token=' + show(r4.plan.token));
    console.log('     各段 dims=' + show(d));
}

// ========================================================================
// 主流程
// ========================================================================
function main() {
    var box = loadObserve({});
    var VO = box.VantageObserve;
    console.log('=== obs_golden_test · vantage_observe.js VERSION=' + VO.VERSION + ' ===');
    console.log('    源文件: ' + SRC_PATH);
    console.log('');

    console.log('── 组一：字段名/顺序 vs 定稿字段表 ─────────────');
    groupStormFields(VO);
    console.log('');
    console.log('── 组二：storm 6 维 ───────────────────────────');
    groupStorm();
    console.log('');
    console.log('── 组三：rootLag 1 维 ─────────────────────────');
    groupRootLag();
    console.log('');
    console.log('── 组四：plan 3+2·K_fire ──────────────────────');
    groupPlan();
    console.log('');

    console.log('=== 逐条结果 ===');
    var pass = 0, fail = 0;
    for (var i = 0; i < ROWS.length; i++) {
        var r = ROWS[i];
        if (r.ok) pass++; else fail++;
        console.log((r.ok ? '[PASS] ' : '[FAIL] ') + r.name + '   ' + (r.ok ? '' : '⟵ ' + r.detail));
    }
    console.log('');
    console.log('RESULT ' + (fail === 0 ? 'PASS' : 'FAIL') + '  total=' + ROWS.length + ' pass=' + pass + ' fail=' + fail);
    if (fail) {
        console.log('FAILING_CHECKS:');
        for (var j = 0; j < ROWS.length; j++) if (!ROWS[j].ok) console.log('  · ' + ROWS[j].name + ' | ' + ROWS[j].detail);
    }
    process.exit(fail === 0 ? 0 : 1);
}

main();
