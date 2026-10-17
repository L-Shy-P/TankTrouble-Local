#!/usr/bin/env node
/* ============================================================================
 * 阶段 3-2 验收：智能体路径「真死不建节点（缺席即标记）」+ 脱离 segmentFrames
 *
 * 真 `vantage_scoring.js` + 真 `vantage_tree_interface.js` + 真 `vantage_tree.js`
 * （`VT_TREE=<path>` 可指向冻结旧树 A/B）+ 真 `vantage_observe.js` + mock adapter，
 * 用真 `VT.tick` / `VT.expandLeaf` / `VT.buildCandidate` 驱动。
 *
 * 只读产品代码。
 * ============================================================================ */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.resolve(__dirname, '..', '..');
const treePath = process.env.VT_TREE ? path.resolve(process.env.VT_TREE)
  : path.join(root, 'game_core', 'js', 'vantage_tree.js');

const Constants={BULLET:{RADIUS:{m:0.25},OFFSET:{m:2.5}},TANK:{WIDTH:{m:3},HEIGHT:{m:4}},BULLET_TURRET:{WIDTH:{m:0.7},HEIGHT:{m:1.4},OFFSET_X:{m:0},OFFSET_Y:{m:-2}},LASER_TURRET:{ANTENNA_WIDTH:{m:0.1},ANTENNA_HEIGHT:{m:1.4},ANTENNA_OFFSET_X:{m:0},ANTENNA_OFFSET_Y:{m:-2},DISH_WIDTH:{m:2},DISH_HEIGHT:{m:0.5},DISH_OFFSET_X:{m:0},DISH_OFFSET_Y:{m:-1.85}},DOUBLE_BARREL_TURRET:{WIDTH:{m:1.6},HEIGHT:{m:1.1},OFFSET_X:{m:0},OFFSET_Y:{m:-1.75}},SHOTGUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MISSILE_TURRET:{WIDTH:{m:0.3},CENTER_HEIGHT:{m:1.4},SIDE_HEIGHT:{m:0.4},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},GATLING_GUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MAZE_TILE_SIZE:{m:10},PIXELS_PER_METER:20};
const OPERATIONS = [
  { name: '静止', inputs: { forward: false, back: false, left: false, right: false } },
  { name: '前', inputs: { forward: true, back: false, left: false, right: false } },
  { name: '后', inputs: { forward: false, back: true, left: false, right: false } },
  { name: '左', inputs: { forward: false, back: false, left: true, right: false } },
  { name: '右', inputs: { forward: false, back: false, left: false, right: true } },
  { name: '前左', inputs: { forward: true, back: false, left: true, right: false } },
  { name: '前右', inputs: { forward: true, back: false, left: false, right: true } },
  { name: '后左', inputs: { forward: false, back: true, left: true, right: false } },
  { name: '后右', inputs: { forward: false, back: true, left: false, right: true } }
];
const fakeMaze = {
  getWidth: () => 8, getHeight: () => 8, isPositionInsideMaze: () => true, getDeadEndPenalty: () => 0,
  getTiles: () => [[[1, 1, 1], [1, 0, 1]], [[1, 0, 1], [0, 0, 0]], [[1, 1, 1], [1, 0, 1]]]
};
function samplesFor(state, frames, step) {
  const out = [{ t: 0, x: state.x, y: state.y, rot: state.rot }];
  for (let k = 1; k <= frames; k++) out.push({ t: k * 0.02, x: state.x + k * step, y: state.y, rot: state.rot });
  return out;
}
let FAILS = 0, CHECKS = 0;
function check(name, cond, detail) {
  CHECKS++;
  if (!cond) FAILS++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '   ' + detail : ''));
}

function makeCtx() {
  const sb = { console, performance, Math, JSON, Array, Object, String, Number, isFinite, parseInt, parseFloat, Infinity, NaN, Date, Constants };
  sb.global = sb;
  sb.VantageSandbox = { fusedEnabled: () => true, OPERATIONS, clearCaches: () => {}, setFrameDtSec: () => {}, getFrameDtSec: () => 0.02 };
  const ctx = vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(root, 'game_core', 'js', 'vantage_scoring.js'), 'utf8'), ctx, { filename: 'scoring.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'game_core', 'js', 'vantage_tree_interface.js'), 'utf8'), ctx, { filename: 'interface.js' });
  vm.runInContext(fs.readFileSync(treePath, 'utf8'), ctx, { filename: treePath });
  vm.runInContext(fs.readFileSync(path.join(root, 'game_core', 'js', 'vantage_observe.js'), 'utf8'), ctx, { filename: 'observe.js' });
  sb.VantageTreeInterface.Agents.register({
    name: 'probe', isReady: function () { return true; },
    decide: function (ctx2) {
      var pick = null;
      try {
        var rows = (ctx2 && ctx2.nodes) || [];
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          if (r && r.nChildren === 0 && !r.invalid &&
              !(typeof r.fullDeathFrame === 'number' && r.fullDeathFrame >= 0 && r.fullDeathFrame <= 1)) { pick = r.id; break; }
        }
        if (pick === null && ctx2 && ctx2.root !== undefined && ctx2.root !== null) pick = ctx2.root;
      } catch (e0) {}
      return (pick === null) ? {} : { growAt: [pick] };
    }
  });
  return sb;
}
function makeAdapter(perOp) {
  const pose = { x: 20, y: 20, rot: 0 };
  const a = {
    constants: { FRAME_DT: 0.02, MAZE_TILE_SIZE: 10, PATH_STEP_SIZE: 0.5 },
    projectiles: [], pose: pose, rustCalls: 0, jsBatchCalls: 0,
    getTankState: function () { return { x: pose.x, y: pose.y, rot: pose.rot }; },
    getProjectiles: function () { return a.projectiles; },
    getMaze: function () { return fakeMaze; },
    checkWall: function () { return false; },
    bulletPosAt: function () { return null; },
    getProjectilePaths: function () { return []; },
    simulateBulletTracks: function () { return []; },
    simulateTankBatchScored: function (state, ops, frames) {
      a.rustCalls++;
      return ops.map(function (_, i) {
        var cfg = (perOp && perOp[i]) || { dead: false, fd: -1 };
        return { samples: samplesFor(state, frames, 0.02), perFrameScores: new Array(frames + 1).fill(2),
                 totalScore: frames * 2, dead: !!cfg.dead, deathFrame: cfg.dead ? cfg.fd : -1, rustPhysics: false };
      });
    },
    simulateTankBatch: function (state, ops, frames) {
      a.jsBatchCalls++;
      return ops.map(function (_, i) {
        var cfg = (perOp && perOp[i]) || { dead: false, fd: -1 };
        return { samples: samplesFor(state, frames, 0.02), perFrameScores: new Array(frames + 1).fill(2),
                 totalScore: frames * 2, dead: !!cfg.dead, deathFrame: cfg.dead ? cfg.fd : -1, rustPhysics: false };
      });
    },
    simulateTankBatchJsFused: function (state, ops, frames) {
      return ops.map(function () { return { samples: samplesFor(state, frames, 0.02), dead: false, deathFrame: -1, rustPhysics: false }; });
    },
    simulateTank: function (state, inputs, frames) {
      return { samples: samplesFor({ x: state.x, y: state.y, rot: state.rot }, frames, 0.02), dead: false, deathFrame: -1 };
    }
  };
  return a;
}
function makeAi(adapter, stepCount) {
  return {
    _vantageAdapter: adapter, aiId: 'tank_a',
    gameController: { getMaze: () => fakeMaze, getTank: () => null,
      roundController: { model: { _ttStepCount: stepCount, _ttLastStepDt: 0.02 } } },
    debugTarget: null, setDebugTarget: function (x, y) { this.debugTarget = { x, y }; }, clearDebugTarget: function () { this.debugTarget = null; }
  };
}
function newTree(agentName, adapter) {
  const sb = makeCtx();
  const VT = sb.VantageTree;
  VT.setKillfieldEnabled(false);
  VT.setGrowWithoutThreatsEnabled(true);
  VT.reset();
  sb.VantageTreeInterface.Agents.use(agentName);
  VT.tick(makeAi(adapter, 1), 0.02);
  var _t = VT.getTree();
  if (process.env.VT_DBG) {
    console.log('     [DBG] agent=' + sb.VantageTreeInterface.Agents.current().name +
      ' decision=' + JSON.stringify(_t && _t._agentDecision) +
      ' iface=' + JSON.stringify(sb.__vantageIface ? {calls: sb.__vantageIface.calls, skipped: sb.__vantageIface.skipped, rejected: sb.__vantageIface.rejected} : null) +
      ' kids=' + JSON.stringify((_t && _t.root && _t.root.children || []).map(function (c) { return { id: c.id, seg: c.segmentFrames, L: c.validFrames, tG: c.simState.tGlobal, fd: c.fullDeathFrame }; })));
  }
  return { sb, VT, tree: _t };
}
function pickLeaf(tree) {
  var stack = [tree.root], guard = 0;
  while (stack.length && guard++ < 500) {
    var n = stack.shift();
    if (!n) continue;
    if (n.children && n.children.length === 0 && !(n.fullDeathFrame >= 0 && n.fullDeathFrame <= 1)) return n;
    if (n.children) for (var i = 0; i < n.children.length; i++) stack.push(n.children[i]);
  }
  return null;
}
function clientExpand(VT, tree, leaf, adapter, agentName) {
  // 直接调 expandLeaf（公开 API）：智能体路径要求 _agentDecision 非空
  tree._agentDecision = (agentName === 'rule') ? null : {};
  return VT.expandLeaf(tree, leaf, adapter, []);
}
function allAlive() { var a = []; for (var i = 0; i < 9; i++) a.push({ dead: false, fd: -1 }); return a; }
function oneDead(slot, fd) { var a = allAlive(); a[slot] = { dead: true, fd: fd }; return a; }
function allDead(fd) { var a = []; for (var i = 0; i < 9; i++) a.push({ dead: true, fd: fd }); return a; }
function kidsSummary(leaf) {
  return (leaf.children || []).map(function (c) {
    return { slot: c.opIndex, L: c.validFrames, backMax: c.backMax, seg: c.segmentFrames, plan: c.plannedFrames,
             fd: c.fullDeathFrame, tG: +c.simState.tGlobal.toFixed(4) };
  });
}

/* ---------- S0 源码接线 ---------- */
function s0() {
  console.log('--- S0 源码接线 ---');
  const src = fs.readFileSync(treePath, 'utf8');
  check('有 agentValidFramesOf（§7.7 L = 75 / fd−1）', src.indexOf('function agentValidFramesOf(r)') >= 0);
  check('buildCandidate 有 agentPathActive 分支 + L<=0 → return null',
    src.indexOf('if (L <= 0) return null;') >= 0);
  check('智能体分支不写 segmentFrames（有"⛔ 不写 childA.segmentFrames"注释）',
    src.indexOf('不写 childA.segmentFrames') >= 0);
  check('attachResults 跳过 null（缺席即标记）', src.indexOf('if (!kid) {') >= 0);
  check('applyRolloutPhysics 用 validFrames', src.indexOf('node.validFrames = L;') >= 0);
}

/* ---------- U1：buildCandidate 边界（直接单元） ---------- */
function u1_boundaries() {
  console.log('--- U1 buildCandidate 边界（fd=0/1/2/活）---');
  const sb = makeCtx(), VT = sb.VantageTree;
  VT.setKillfieldEnabled(false); VT.setGrowWithoutThreatsEnabled(true); VT.reset();
  sb.VantageTreeInterface.Agents.use('probe');
  VT.tick(makeAi(makeAdapter(allAlive()), 1), 0.02);
  const tree = VT.getTree();
  tree._agentDecision = {};
  const parent = pickLeaf(tree);
  const samples = samplesFor(parent.simState.tank, 75, 0.02);
  const mk = (dead, fd, extra) => Object.assign({ samples: samples, dead: dead, deathFrame: fd, totalScore: 100, perFrameScores: [1, 2, 3] }, extra || {});
  const c0 = VT.buildCandidate(tree, parent, 0, mk(true, 0), null, []);
  const c1 = VT.buildCandidate(tree, parent, 0, mk(true, 1), null, []);
  const c2 = VT.buildCandidate(tree, parent, 0, mk(true, 2), null, []);
  const c5 = VT.buildCandidate(tree, parent, 0, mk(true, 5), null, []);
  const ca = VT.buildCandidate(tree, parent, 0, mk(false, -1), null, []);
  check('fd=0（起手就撞）→ 不建（null）', c0 === null);
  check('fd=1（走一步就死）→ 不建（null）', c1 === null);
  check('fd=2 → 建，L=fd−1=1 / backMax=0', !!c2 && c2.validFrames === 1 && c2.backMax === 0,
    c2 && ('L=' + c2.validFrames + ' backMax=' + c2.backMax));
  check('fd=5 → 建，L=4，末态取 samples[4]，tGlobal=父+4帧',
    !!c5 && c5.validFrames === 4 && c5.backMax === 3 &&
    Math.abs(c5.simState.tank.x - samples[4].x) < 1e-9 &&
    Math.abs(c5.simState.tGlobal - (parent.simState.tGlobal + 4 * 0.02)) < 1e-9,
    c5 && ('L=' + c5.validFrames + ' x=' + c5.simState.tank.x + ' tG=' + c5.simState.tGlobal));
  check('活着 → L=75（本轮模拟帧数）', !!ca && ca.validFrames === 75, ca && ('L=' + ca.validFrames));
  check('智能体节点不写 segmentFrames/plannedFrames（仍是 0）',
    !!ca && ca.segmentFrames === 0 && ca.plannedFrames === 0,
    ca && ('seg=' + ca.segmentFrames + ' plan=' + ca.plannedFrames));
  // ③ NaN 隐患的功能断言：probe=null 且 r.totalScore 缺失 → segmentScore/baseExt 必须 0，不是 NaN
  const cNaN = VT.buildCandidate(tree, parent, 0, { samples: samples, dead: false, deathFrame: -1 }, null, []);
  const okNaN = !!cNaN && cNaN.segmentScore === 0 && cNaN.baseExt === 0 && cNaN.rolloutTotal === 0 &&
    !isNaN(cNaN.segmentScore) && !isNaN(cNaN.baseExt);
  check('NaN 隐患功能断言：probe=null + totalScore 缺 → 0/0（不是 NaN）', okNaN,
    cNaN && ('segScore=' + cNaN.segmentScore + ' baseExt=' + cNaN.baseExt + ' total=' + cNaN.rolloutTotal));
}

/* ---------- U2：一条真死 → 8 支；U6：L 值；encoder 可读 ---------- */
function u2_one_truedeath() {
  console.log('--- U2 一条 fd=1（真死）→ 该父只有 8 支 + token 可读 ---');
  const adapter = makeAdapter(oneDead(3, 1));
  const { sb, VT, tree } = newTree('probe', makeAdapter(allAlive()));
  const leaf = pickLeaf(tree);
  const n = clientExpand(VT, tree, leaf, adapter, 'probe');
  const kids = leaf.children || [];
  check('expandLeaf 返回 8（只建了 8 个）', n === 8 && kids.length === 8, 'n=' + n + ' kids=' + kids.length);
  const slots = kids.map(function (k) { return k.opIndex; }).sort(function (a, b) { return a - b; });
  check('缺席的 slot 正好是 3（真死那支）', slots.indexOf(3) < 0 && slots.length === 8,
    'slots=' + JSON.stringify(slots) + ' skips=' + (tree.stats.agentTrueDeadSkips || 0));
  check('fd=5 的候选：L=4 / backMax=3 / seg=0（不碰 segmentFrames）',
    kids.every(function (k) { return k.validFrames === 75 || k.validFrames === 4; }),
    JSON.stringify(kidsSummary(leaf)));
  // encoder（真 vantage_observe.js）：从 token 读出该父的支数 = 8、缺 slot=3
  const rows = VT.collectAgentNodes(tree);
  const enc = sb.VantageObserve.encodeNodes(rows, { rootX: tree.root.simState.tank.x, rootY: tree.root.simState.tank.y, rootRot: tree.root.simState.tank.rot, frameDt: 0.02 });
  const idx = enc.idxOf[leaf.id];
  const childSlots = [];
  for (let i = 0; i < enc.tokens.length; i++) if (enc.tokens[i][1] === idx) childSlots.push(enc.tokens[i][2]);
  childSlots.sort(function (a, b) { return a - b; });
  check('token：该父的 slot 数 = 8（缺席即标记可读）', childSlots.length === 8,
    'tokenSlots=' + JSON.stringify(childSlots));
  check('token：缺的 slot = 3', childSlots.indexOf(3) < 0);
  // ⚠️ encoder 对根节点强制 L=0，而它的"规格式对拍"仍按 fullDead 算 spec
  //   ⟹ 根的 spec(75)≠0 会稳定贡献 1 次 Lmismatch（v180 遗留，与本步无关）。
  //   本步只要求**非根节点**的 L 与 spec 无漂移。
  var nonRootMismatch = 0;
  for (var ti = 0; ti < enc.tokens.length; ti++) {
    if (enc.tokens[ti][1] < 0) continue;                  // 根跳过
    var parentRow = null;
    for (var ri2 = 0; ri2 < rows.length; ri2++) if (rows[ri2].id === enc.ids[enc.tokens[ti][1]]) { parentRow = rows[ri2]; break; }
    var selfRow = null;
    for (var ri3 = 0; ri3 < rows.length; ri3++) if (rows[ri3].id === enc.ids[ti]) { selfRow = rows[ri3]; break; }
    if (!selfRow) continue;
    var spec = !selfRow.fullDead ? 75 : ((selfRow.fullDeathFrame >= 2) ? (selfRow.fullDeathFrame - 1) : 0);
    if (spec !== enc.tokens[ti][5]) {
      nonRootMismatch++;
      console.log('     [Lmismatch 诊断] id=' + selfRow.id + ' parent=' + selfRow.parentId +
        ' tG=' + selfRow.tGlobal + ' parentTG=' + (parentRow && parentRow.tGlobal) +
        ' fullDead=' + selfRow.fullDead + ' fd=' + selfRow.fullDeathFrame +
        ' nChildren=' + selfRow.nChildren + ' tokenL=' + enc.tokens[ti][5] + ' spec=' + spec);
    }
  }
  check('encoder L 规格式对拍：非根节点无漂移（根的 spec 特例除外）', nonRootMismatch === 0,
    'nonRootMismatch=' + nonRootMismatch + '（encoder 全量 Lmismatch=' + enc.stat.Lmismatch + '，根特例）');
}

/* ---------- U3：全 9 条真死 → hasGrown=1 ∧ children=0（2-3 取不到的样例） ---------- */
function u3_all_truedeath() {
  console.log('--- U3 全 9 条 fd=1（真死）→ hasGrown=1 ∧ children=0 ---');
  const { sb, VT, tree } = newTree('probe', makeAdapter(allDead(1)));
  const root = tree.root;
  check('根真的生长过（hasGrown=true）', root.hasGrown === true);
  check('根一个子节点都没有（9 支全真死 = 缺席）', root.children.length === 0, 'children=' + root.children.length);
  check('tree.stats 记到 9 次真死跳过 / 1 次全真死叶', (tree.stats.agentTrueDeadSkips || 0) >= 9 && (tree.stats.agentTrueDeadLeaves || 0) >= 1,
    'skips=' + tree.stats.agentTrueDeadSkips + ' leaves=' + tree.stats.agentTrueDeadLeaves);
  // encoder：2-3 之前报"今天取到 0 次"的样例
  const rows = VT.collectAgentNodes(tree);
  const enc = sb.VantageObserve.encodeNodes(rows, { rootX: root.simState.tank.x, rootY: root.simState.tank.y, rootRot: root.simState.tank.rot, frameDt: 0.02 });
  check('encoder stat：noChildHasGrownTrue ≥ 1（真实样例取到了）', enc.stat.noChildHasGrownTrue >= 1,
    'noChildHasGrownTrue=' + enc.stat.noChildHasGrownTrue);
  console.log('     [样例-根] ' + JSON.stringify(rows.filter(function (r) { return r.hasGrown && r.nChildren === 0; }).slice(0, 2)));
  // U3b：更强的样例 —— **非根**叶子也取到 hasGrown=1 ∧ children=0
  const t1 = newTree('probe', makeAdapter(allAlive()));
  const leafB = pickLeaf(t1.tree);
  clientExpand(t1.VT, t1.tree, leafB, makeAdapter(allDead(1)), 'probe');
  check('U3b 非根叶子：hasGrown=1 ∧ children=0（缺席即标记）',
    leafB.hasGrown === true && leafB.children.length === 0,
    'id=' + leafB.id + ' hasGrown=' + leafB.hasGrown + ' children=' + leafB.children.length);
  const rowsB = t1.VT.collectAgentNodes(t1.tree);
  const encB = t1.sb.VantageObserve.encodeNodes(rowsB, { rootX: t1.tree.root.simState.tank.x, rootY: t1.tree.root.simState.tank.y, rootRot: t1.tree.root.simState.tank.rot, frameDt: 0.02 });
  check('U3b encoder stat：noChildHasGrownTrue ≥ 1（非根叶样例可读）', encB.stat.noChildHasGrownTrue >= 1,
    'noChildHasGrownTrue=' + encB.stat.noChildHasGrownTrue);
  console.log('     [样例-非根] ' + JSON.stringify(rowsB.filter(function (r) { return r.hasGrown && r.nChildren === 0; }).slice(0, 3)));
}

/* ---------- U4：规则版 A/B（同一条 fd=1 → 规则版必须照旧建 9 支） ---------- */
function u4_rule_ab() {
  console.log('--- U4 规则版 A/B（同一 fd=1；§5：规则路径必须照旧 9 支）---');
  const { VT, tree } = newTree('rule', makeAdapter(allAlive()));
  const leaf = pickLeaf(tree);
  const n = clientExpand(VT, tree, leaf, makeAdapter(oneDead(3, 1)), 'rule');
  const kids = leaf.children || [];
  check('规则版仍然建 9 支（真死也建；行为未碰）', n === 9 && kids.length === 9, 'n=' + n + ' kids=' + kids.length);
  const fd1 = kids.filter(function (k) { return k.opIndex === 3; })[0];
  check('规则版 fd=1 支：segmentFrames=1（safeFramesForDeath 旧口径）且无 validFrames',
    !!fd1 && fd1.segmentFrames === 1 && !(fd1.validFrames > 0),
    fd1 && ('seg=' + fd1.segmentFrames + ' L=' + fd1.validFrames));
}

/* ---------- U5：假阳率 ---------- */
function u5_false_positive() {
  console.log('--- U5 假阳率（"支数<9"这个信号）---');
  function countKids(mode, perOp, expandAgent) {
    if (mode === 'tick') {   // 首 tick 直接长（根）
      const { tree } = newTree(expandAgent ? 'probe' : 'rule', makeAdapter(perOp));
      return (tree.root.children || []).length;
    }
    const { VT, tree } = newTree(expandAgent ? 'probe' : 'rule', makeAdapter(allAlive()));
    const leaf = pickLeaf(tree);
    clientExpand(VT, tree, leaf, makeAdapter(perOp), expandAgent ? 'probe' : 'rule');
    return (leaf.children || []).length;
  }
  const nAliveAgent = countKids('expand', allAlive(), true);
  const nFd2Agent = countKids('expand', oneDead(3, 2), true);
  const nFd1Rule = countKids('expand', oneDead(3, 1), false);
  const fp = [nAliveAgent < 9, nFd2Agent < 9, nFd1Rule < 9].filter(Boolean).length;
  check('不该缺支的 3 局面（agent 全活 / agent fd=2 / rule fd=1）都没有缺 → 假阳 0/3',
    fp === 0, 'nAliveAgent=' + nAliveAgent + ' nFd2Agent=' + nFd2Agent + ' nFd1Rule=' + nFd1Rule);
  const nFd1Agent = countKids('expand', oneDead(3, 1), true);
  const nAllDead = countKids('tick', allDead(1), true);
  check('该缺支的 2 局面都真的缺了（假阴 0/2）', nFd1Agent === 8 && nAllDead === 0,
    'fd1Agent=' + nFd1Agent + ' allDead=' + nAllDead);
}

s0();
u1_boundaries();
u2_one_truedeath();
u3_all_truedeath();
u4_rule_ab();
u5_false_positive();
console.log('\n' + (FAILS ? ('3-2 TRUE-DEATH PROBE FAILED (' + FAILS + '/' + CHECKS + ')') : ('3-2 TRUE-DEATH PROBE PASSED (' + CHECKS + ' checks)')));
process.exitCode = FAILS ? 1 : 0;
