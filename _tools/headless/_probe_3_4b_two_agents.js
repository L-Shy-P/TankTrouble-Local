#!/usr/bin/env node
/* ============================================================================
 * 阶段 3-4b 验收：A/B 两个**独立注册**的智能体（不是"同一对象 + phase 区分"）
 *
 * 真 scoring + 真 interface + 真 tree + 真 observe + mock adapter，真 VT.tick 驱动。
 * 证明：
 *   P1 两个不同实现各自被调用、各自的输出被采纳（A 的生长 / B 的路线）
 *   P2 旧单智能体模式仍兼容（一个默认 agent → A/B 两相都调它）
 *   P3 §5 硬门：默认槽是 rule 时，分工槽被忽略、规则版行为不变
 *   P4 假阳率（"B 是独立对象"信号）
 * ============================================================================ */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.resolve(__dirname, '..', '..');
const treePath = process.env.VT_TREE ? path.resolve(process.env.VT_TREE) : path.join(root, 'game_core', 'js', 'vantage_tree.js');
const ifacePath = process.env.VT_IFACE ? path.resolve(process.env.VT_IFACE) : path.join(root, 'game_core', 'js', 'vantage_tree_interface.js');

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
const fakeMaze = { getWidth: () => 8, getHeight: () => 8, isPositionInsideMaze: () => true, getDeadEndPenalty: () => 0,
  getTiles: () => [[[1, 1, 1], [1, 0, 1]], [[1, 0, 1], [0, 0, 0]], [[1, 1, 1], [1, 0, 1]]] };
function samplesFor(state, frames, step) {
  const out = [{ t: 0, x: state.x, y: state.y, rot: state.rot }];
  for (let k = 1; k <= frames; k++) out.push({ t: k * 0.02, x: state.x + k * step, y: state.y, rot: state.rot });
  return out;
}
let FAILS = 0, CHECKS = 0;
function check(name, cond, detail) {
  CHECKS++; if (!cond) FAILS++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '   ' + detail : ''));
}
function makeAdapter() {
  const pose = { x: 20, y: 20, rot: 0 };
  const a = { constants: { FRAME_DT: 0.02, MAZE_TILE_SIZE: 10, PATH_STEP_SIZE: 0.5 }, projectiles: [], pose: pose,
    getTankState: function () { return { x: pose.x, y: pose.y, rot: pose.rot }; },
    getProjectiles: function () { return a.projectiles; },
    getMaze: function () { return fakeMaze; },
    checkWall: function () { return false; }, bulletPosAt: function () { return null; },
    getProjectilePaths: function () { return []; }, simulateBulletTracks: function () { return []; },
    simulateTankBatchScored: function (state, ops, frames) {
      return ops.map(function () { return { samples: samplesFor(state, frames, 0.02), perFrameScores: new Array(frames + 1).fill(2), totalScore: frames * 2, dead: false, deathFrame: -1, rustPhysics: false }; });
    },
    simulateTankBatch: function (state, ops, frames) {
      return ops.map(function () { return { samples: samplesFor(state, frames, 0.02), perFrameScores: new Array(frames + 1).fill(2), totalScore: frames * 2, dead: false, deathFrame: -1, rustPhysics: false }; });
    },
    simulateTankBatchJsFused: function (state, ops, frames) {
      return ops.map(function () { return { samples: samplesFor(state, frames, 0.02), dead: false, deathFrame: -1, rustPhysics: false }; });
    },
    simulateTank: function (state, inputs, frames) { return { samples: samplesFor({ x: state.x, y: state.y, rot: state.rot }, frames, 0.02), dead: false, deathFrame: -1 }; }
  };
  return a;
}
function makeAi(adapter, stepCount) {
  return { _vantageAdapter: adapter, aiId: 'tank_a',
    gameController: { getMaze: () => fakeMaze, getTank: () => null,
      roundController: { model: { _ttStepCount: stepCount, _ttLastStepDt: 0.02 } } },
    debugTarget: null, setDebugTarget: function (x, y) { this.debugTarget = { x, y }; }, clearDebugTarget: function () { this.debugTarget = null; } };
}
function makeCtx() {
  const sb = { console, performance, Math, JSON, Array, Object, String, Number, isFinite, parseInt, parseFloat, Infinity, NaN, Date, Constants };
  sb.global = sb;
  sb.VantageSandbox = { fusedEnabled: () => true, OPERATIONS, clearCaches: () => {}, setFrameDtSec: () => {}, getFrameDtSec: () => 0.02 };
  const ctx = vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(root, 'game_core', 'js', 'vantage_scoring.js'), 'utf8'), ctx, { filename: 'scoring.js' });
  vm.runInContext(fs.readFileSync(ifacePath, 'utf8'), ctx, { filename: 'interface.js' });
  vm.runInContext(fs.readFileSync(treePath, 'utf8'), ctx, { filename: 'tree.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'game_core', 'js', 'vantage_observe.js'), 'utf8'), ctx, { filename: 'observe.js' });
  return sb;
}
function pickLeaves(tree) {
  const out = [];
  (function rec(n) { if (!n) return; if (n.children && n.children.length === 0 && !(n.fullDeathFrame >= 0 && n.fullDeathFrame <= 1)) out.push(n); if (n.children) n.children.forEach(rec); })(tree.root);
  return out;
}
function makeAgent(name, getDecision, calls) {
  return { name: name, isReady: function () { return true; },
    decide: function (ctx) { calls.push({ agent: name, phase: ctx.phase, nodes: ctx.nodes.length, ids: ctx.nodes.map(function (r) { return r.id; }) }); return getDecision(); } };
}
/* 建树（A/B 都返回 {}，只搭台） */
function setupTree(sb, VT, adapter) {
  VT.setKillfieldEnabled(false);
  VT.setGrowWithoutThreatsEnabled(true);
  VT.reset();
  VT.tick(makeAi(adapter, 1), 0.02);
  let st = 1;
  for (let i = 0; i < 8; i++) {
    const t0 = VT.getTree();
    if (t0 && t0.commitNode && t0.commitNode.children && t0.commitNode.children.length) break;
    VT.tick(makeAi(adapter, ++st), 0.02);
  }
  return st;
}

/* ---------- P1：两个不同实现，各自被调用、各自被采纳 ---------- */
function p1_independent() {
  console.log('--- P1 A/B 两个独立实现 ---');
  const sb = makeCtx(), VT = sb.VantageTree, I = sb.VantageTreeInterface;
  const growCalls = [], routeCalls = [];
  // 搭台阶段两个 agent 都返回 {}（真正的实现 behavioral 在 setup 之后覆盖）
  const growAgent = makeAgent('grow-net', function () { return {}; }, growCalls);
  const routeAgent = makeAgent('route-net', function () { return {}; }, routeCalls);
  I.Agents.register(growAgent, 'A');
  I.Agents.register(routeAgent, 'B');
  I.Agents.use('grow-net', 'A');
  I.Agents.use('route-net', 'B');
  const adapter = makeAdapter();
  setupTree(sb, VT, adapter);
  const tree = VT.getTree();
  const leaf = pickLeaves(tree)[0];
  const cmt = tree.commitNode;
  const routeUsed0 = tree.stats.agentRouteUsed || 0;
  cmt.tEndSec = 0;                              // 强制段末 → commit 消费 B 的路线
  // 用对象引用让 decide 返回"各自实现"的输出
  growAgent.decide = function (ctx) { growCalls.push({ agent: 'grow-net', phase: ctx.phase }); return { picks: [{ nodeId: leaf.id, back: 0 }] }; };
  routeAgent.decide = function (ctx) { routeCalls.push({ agent: 'route-net', phase: ctx.phase }); return { picks: [{ nodeId: cmt.children[0].id, back: 0 }] }; };
  VT.tick(makeAi(adapter, 99), 0.02);
  check('A/B 是**两个不同对象**', growAgent !== routeAgent);
  check('A 只被 A 相调用', growCalls.length >= 1 && growCalls.every(function (c) { return c.phase === 'A'; }),
    JSON.stringify(growCalls.map(function (c) { return c.phase; })));
  check('B 只被 B 相调用', routeCalls.length >= 1 && routeCalls.every(function (c) { return c.phase === 'B'; }),
    JSON.stringify(routeCalls.map(function (c) { return c.phase; })));
  check('A 的输出被采纳（指定叶子长出 9 个子节点）', leaf.children.length === 9,
    'kids=' + leaf.children.length);
  check('B 的输出被采纳（路线命中 agentRouteUsed）', (VT.getTree().stats.agentRouteUsed || 0) === routeUsed0 + 1,
    'routeUsed=' + routeUsed0 + '→' + VT.getTree().stats.agentRouteUsed);
  check('接口 current(role) 各自取到不同实现',
    I.Agents.current('A') === growAgent && I.Agents.current('B') === routeAgent);
}

/* ---------- P2：旧单智能体模式兼容 ---------- */
function p2_single_agent_compat() {
  console.log('--- P2 旧单智能体兼容（一个默认 agent，A/B 两相都调它）---');
  const sb = makeCtx(), VT = sb.VantageTree, I = sb.VantageTreeInterface;
  const soloCalls = [];
  const solo = makeAgent('solo', function () { return {}; }, soloCalls);
  I.Agents.register(solo);
  I.Agents.use('solo');
  const adapter = makeAdapter();
  setupTree(sb, VT, adapter);
  soloCalls.length = 0;
  VT.tick(makeAi(adapter, 99), 0.02);
  const phases = soloCalls.map(function (c) { return c.phase; });
  check('单智能体模式：A/B 两相各调它 1 次（回退默认槽兼容）',
    phases.length === 2 && phases[0] === 'A' && phases[1] === 'B', JSON.stringify(phases));
  check('current("A") === current("B") === 同一个对象（未注册分工槽）',
    I.Agents.current('A') === solo && I.Agents.current('B') === solo);
}

/* ---------- P3：§5 硬门（默认 rule → 分工槽被忽略） ---------- */
function p3_rule_gate() {
  console.log('--- P3 §5 硬门：默认槽=rule 时分工槽被忽略 ---');
  const sb = makeCtx(), VT = sb.VantageTree, I = sb.VantageTreeInterface;
  const growCalls = [], routeCalls = [];
  const growAgent = makeAgent('grow-net', function () { return {}; }, growCalls);
  const routeAgent = makeAgent('route-net', function () { return {}; }, routeCalls);
  I.Agents.register(growAgent, 'A');
  I.Agents.register(routeAgent, 'B');
  I.Agents.use('rule');                       // ★ 切回规则版（默认槽）
  const adapter = makeAdapter();
  setupTree(sb, VT, adapter);
  growCalls.length = 0; routeCalls.length = 0;
  VT.tick(makeAi(adapter, 99), 0.02);
  check('规则模式下：A/B 两相都不调（硬门 current(role) 返回 rule）',
    growCalls.length === 0 && routeCalls.length === 0 &&
    I.Agents.current('A').name === 'rule' && I.Agents.current('B').name === 'rule',
    'A=' + growCalls.length + ' B=' + routeCalls.length);
  check('规则模式下树照常长/提交（没有被分工槽污染）', !!VT.getTree() && VT.getTree().nodeCount > 0,
    'nodeCount=' + (VT.getTree() && VT.getTree().nodeCount));
}

/* ---------- P4：假阳率 ---------- */
function p4_false_positive() {
  console.log('--- P4 假阳率（"B 是独立对象"信号）---');
  // 信号 = "A 相被调对象 !== B 相被调对象"
  const sb1 = makeCtx(), I1 = sb1.VantageTreeInterface;
  const calls1 = [];
  const solo = makeAgent('solo', function () { return {}; }, calls1);
  I1.Agents.register(solo); I1.Agents.use('solo');
  const sigSingle = I1.Agents.current('A') !== I1.Agents.current('B');
  check('不该响：单智能体模式 → 信号 false（假阳 0/1）', sigSingle === false);
  const sb2 = makeCtx(), I2 = sb2.VantageTreeInterface;
  const g = makeAgent('g', function () { return {}; }, []);
  const r = makeAgent('r', function () { return {}; }, []);
  I2.Agents.register(g, 'A'); I2.Agents.register(r, 'B');
  I2.Agents.use('g', 'A'); I2.Agents.use('r', 'B');
  const sigTwo = I2.Agents.current('A') !== I2.Agents.current('B');
  check('该响：两个独立实现 → 信号 true（假阴 0）', sigTwo === true);
  const sb3 = makeCtx(), I3 = sb3.VantageTreeInterface;
  const same = makeAgent('same', function () { return {}; }, []);
  I3.Agents.register(same, 'A'); I3.Agents.register(same, 'B');
  I3.Agents.use('same', 'A'); I3.Agents.use('same', 'B');
  const sigSame = I3.Agents.current('A') !== I3.Agents.current('B');
  check('不该响：两个槽注册同一对象 → 信号 false（不是真独立）', sigSame === false);
}

/* ---------- S0 源码接线 ---------- */
function s0() {
  console.log('--- S0 源码接线 ---');
  const iface = fs.readFileSync(ifacePath, 'utf8');
  const tree = fs.readFileSync(treePath, 'utf8');
  check('接口：_byRole + register(a, role) + use(name, role) + current(role)',
    iface.indexOf('_byRole: { A: null, B: null }') >= 0 && iface.indexOf('register: function (a, role)') >= 0 &&
    iface.indexOf('use: function (name, role)') >= 0 && iface.indexOf('current: function (role)') >= 0);
  check('接口：规则版硬门（默认 rule → current(role) 返回 rule）',
    iface.indexOf("if (this._cur && this._cur.name === 'rule') return this._cur;") >= 0);
  check('树：agentSeam 按 phase 取独立 agent', tree.indexOf('Agents.current(phase)') >= 0);
  check('树：ctx.phase 保留为上下文标记（不是区分机制）',
    tree.indexOf("phase: phase,") >= 0 && tree.indexOf("var phase = (ctx && ctx.phase === 'B') ? 'B' : 'A';") >= 0);
}

s0(); p1_independent(); p2_single_agent_compat(); p3_rule_gate(); p4_false_positive();
console.log('\n' + (FAILS ? ('3-4b TWO-AGENT PROBE FAILED (' + FAILS + '/' + CHECKS + ')') : ('3-4b TWO-AGENT PROBE PASSED (' + CHECKS + ' checks)')));
process.exitCode = FAILS ? 1 : 0;
