#!/usr/bin/env node
/* ============================================================================
 * 阶段 3-3 验收：接口契约（picks / 删 growTimes / growAt 只消费 [0]）
 *
 * 真 `vantage_scoring.js` + 真 `vantage_tree_interface.js` + 真 `vantage_tree.js`
 * （`VT_TREE=` / `VT_IFACE=` 可指向冻结旧文件做 A/B）+ 真 `vantage_observe.js` +
 * mock adapter，用真 `VT.tick` 驱动；格式层直接调真 `VantageTreeInterface`。
 *
 * 只读产品代码（本探针不写任何产品文件）。
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
/* 建一棵"有可生长叶"的树；decideFn 可配。返回 {sb,VT,tree,decideCalls} */
function newHarness(setupDecision) {
  const sb = makeCtx();
  const VT = sb.VantageTree;
  const state = { calls: 0, callsA: 0, callsB: 0, decision: setupDecision || {} };
  sb.VantageTreeInterface.Agents.register({
    name: 'probe', isReady: function () { return true; },
    decide: function (ctx) {
      state.calls++;
      if (ctx && ctx.phase === 'B') state.callsB++; else state.callsA++;
      return state.decision;
    }
  });
  VT.setKillfieldEnabled(false);
  VT.setGrowWithoutThreatsEnabled(true);
  VT.reset();
  sb.VantageTreeInterface.Agents.use('probe');
  const adapter = makeAdapter();
  VT.tick(makeAi(adapter, 1), 0.02);
  const tree = VT.getTree();
  state.calls = 0; state.callsA = 0; state.callsB = 0;
  return { sb, VT, tree, adapter, state,
    tick: function (n) { VT.tick(makeAi(adapter, n || 2), 0.02); } };
}

/* ---------- S0 源码接线 ---------- */
function s0() {
  console.log('--- S0 源码接线 ---');
  const iface = fs.readFileSync(ifacePath, 'utf8');
  const tree = fs.readFileSync(treePath, 'utf8');
  check('validateBundle 接 picks（含逐项 illegal）', iface.indexOf("illegal.push('生长picks[' + pi + '].nodeId')") >= 0 &&
    iface.indexOf("illegal.push('生长picks[' + pi + '].back')") >= 0);
  check('validateDecision 接 picks 且无 growTimes', iface.indexOf('out.picks = pk;') >= 0 &&
    iface.indexOf('out.growTimes') < 0);
  check('树侧 checkBundleSemantics 有 picks[0] 目标 + back 范围 + 非叶响亮拒绝',
    tree.indexOf('targetBack = clean.picks[0].back;') >= 0 && tree.indexOf('越界 [0,') >= 0 &&
    tree.indexOf('在非叶节点上生长（expandLeaf 会拒绝）') >= 0);
  check('树侧 growStep 只消费 picks[0]/growAt[0] 且删了 growTimes', tree.indexOf('[_dec.picks[0].nodeId];   // ★ 只消费 [0]') >= 0 &&
    tree.indexOf('_agentDecision.growTimes') < 0);
}

/* ---------- S1 格式层：picks / growTimes ---------- */
function s1_format() {
  console.log('--- S1 格式层（validateBundle / validateDecision）---');
  const sb = makeCtx(), I = sb.VantageTreeInterface;
  const b1 = I.validateBundle({ picks: [{ nodeId: 1, back: 0 }], growAt: [1], select: 2, junk: 9 });
  check('bundle：picks 通过且 growTimes/junk 不在 clean', b1.ok && Array.isArray(b1.clean.picks) &&
    b1.clean.growTimes === undefined && b1.clean.junk === undefined, JSON.stringify(b1.clean));
  const b2 = I.validateBundle({ picks: [{ nodeId: null, back: 0 }, { nodeId: 3, back: -1 }] });
  check('bundle：非法 pick 逐项报出（nodeId / back）', !b2.ok &&
    b2.illegal.join(',').indexOf('生长picks[0].nodeId') >= 0 && b2.illegal.join(',').indexOf('生长picks[1].back') >= 0,
    JSON.stringify(b2.illegal));
  const b3 = I.validateBundle({ picks: 'x' });
  check('bundle：picks 非数组 → illegal（不静默）', !b3.ok && b3.illegal.indexOf('生长picks') >= 0);
  const d = I.validateDecision({ growAt: [1, 2], growTimes: 99, select: 7, junk: 1, picks: [{ nodeId: 1, back: 4 }] });
  check('decision：growTimes 已删除（不再 99→8，直接 undefined）', d.growTimes === undefined, 'growTimes=' + d.growTimes);
  check('decision：picks 保留（不截断多元素）+ growAt/select 兼容', d.picks.length === 1 && d.picks[0].back === 4 &&
    Array.isArray(d.growAt) && d.select === 7 && d.junk === undefined);
}

/* ---------- S2 picks 只消费 [0] ---------- */
function s2_picks_only_first() {
  console.log('--- S2 picks 多给 → 只消费 [0]，多给的忽略 ---');
  const h = newHarness();
  const leaves = pickLeaves(h.tree);
  check('前置：至少 2 个可生长叶', leaves.length >= 2, 'leaves=' + leaves.length);
  const A = leaves[0], B = leaves[1];
  h.state.decision = { picks: [{ nodeId: A.id, back: 0 }, { nodeId: B.id, back: 0 }, { nodeId: B.id, back: 0 }] };
  h.tick(2);
  check('只给 [0] 生长（A 有 9 个子、B 还是 0）', A.children.length > 0 && B.children.length === 0,
    'A.kids=' + A.children.length + ' B.kids=' + B.children.length);
  check('多给的 2 个被忽略并记 extras', (h.tree.stats.ifacePickExtras || 0) === 2,
    'ifacePickExtras=' + h.tree.stats.ifacePickExtras);
  check('A 相只调 1 次（合法包不重试；B 相另算）', h.state.callsA === 1, 'callsA=' + h.state.callsA + ' callsB=' + h.state.callsB);
}

/* ---------- S3 back 边界（0 / L−1 / L 越界） ---------- */
function s3_back_bounds() {
  console.log('--- S3 Pick.back 边界 ---');
  for (const tc of [{ back: 0, wantCalls: 1, tag: 'back=0（执行 L 帧）' },
                     { back: 74, wantCalls: 1, tag: 'back=L−1=74（执行 1 帧）' },
                     { back: 75, wantCalls: 3, tag: 'back=L=75（越界，拒绝）' }]) {
    const h = newHarness();
    const leaf = pickLeaves(h.tree)[0];
    h.state.decision = { picks: [{ nodeId: leaf.id, back: tc.back }] };
    h.tick(2);
    check(tc.tag + ' → A 相帧内重试次数=' + tc.wantCalls, h.state.callsA === tc.wantCalls,
      'callsA=' + h.state.callsA + ' callsB=' + h.state.callsB + ' kids=' + leaf.children.length);
  }
}

/* ---------- S4 growAt 只消费 [0] + 非叶响亮拒绝 ---------- */
function s4_growat() {
  console.log('--- S4 growAt 只消费 [0] / 非叶响亮拒绝 ---');
  const h1 = newHarness();
  const leaf1 = pickLeaves(h1.tree)[0];
  h1.state.decision = { growAt: [leaf1.id, 999999] };   // [1] 不存在，但只校验 [0]
  h1.tick(2);
  check('growAt=[合法叶, 不存在] → 只校验 [0]：不重试、[0] 生长', h1.state.callsA === 1 && leaf1.children.length > 0,
    'callsA=' + h1.state.callsA + ' kids=' + leaf1.children.length);
  check('growAt 多给的 1 个被忽略并记 extras', (h1.tree.stats.ifaceGrowAtExtras || 0) === 1,
    'ifaceGrowAtExtras=' + h1.tree.stats.ifaceGrowAtExtras);
  const h2 = newHarness();
  const root = h2.tree.root;
  h2.state.decision = { growAt: [root.id] };            // 非叶：旧代码会静默 expand-fail
  h2.tick(2);
  check('growAt=[非叶根] → A 相语义拒绝（重试 3 次后规则兜底），不再静默', h2.state.callsA === 3,
    'callsA=' + h2.state.callsA + ' callsB=' + h2.state.callsB);
}

/* ---------- S5 selftest 假绿（成因） ---------- */
function s5_selftest_falsegreen() {
  console.log('--- S5 selftest 假绿的成因（只查证，不改该文件）---');
  const st = fs.readFileSync(path.join(root, 'game_core', 'vantage_selftest.html'), 'utf8');
  const direct = /I\.validateDecision\(I\.Agents\.use\('selftest'\)\.decide\(\{\}\)\)/.test(st);
  const hasGrowTimesCase = /growTimes 99\s*→\s*8/.test(st);
  check('selftest 直接调 validateDecision（绕开 validateBundle）', direct && hasGrowTimesCase,
    'direct=' + direct + ' case=' + hasGrowTimesCase);
  const sb = makeCtx(), I = sb.VantageTreeInterface;
  const d = I.validateDecision({ growAt: [1, 2], growTimes: 99, select: 7, junk: 1 });
  check('旧断言“growTimes 99→8”在新契约下会 FAIL（d.growTimes=undefined）⟹ 假绿暴露为真红',
    d.growTimes === undefined, 'growTimes=' + d.growTimes);
  const b = I.validateBundle({ growAt: [1], growTimes: 99 });
  check('根因：validateBundle 白名单从来就没有 growTimes（树里那段永不可达）',
    b.ok && b.clean.growTimes === undefined, JSON.stringify(b.clean));
}

/* ---------- S6 A/B 现状（为 3-4 铺路） ---------- */
function s6_ab_status() {
  console.log('--- S6 A/B 现状（3-4 已拆：同 tick 两次调用）---');
  const tree = fs.readFileSync(treePath, 'utf8');
  const aCall = (tree.match(/agentSeam\(tree, adapter, tree\.root\.simState, evalThreats, VantageSandbox\.OPERATIONS, 'A'\)/g) || []).length;
  const bCall = (tree.match(/agentSeam\(tree, adapter, tree\.root\.simState, evalThreats, VantageSandbox\.OPERATIONS, 'B'\)/g) || []).length;
  const seamDefs = (tree.match(/function agentSeam\(tree, adapter, simState, threats, ops, phase\)/g) || []).length;
  check('A/B 各 1 个调用点 + 1 个定义（同 tick 两次调用）', aCall === 1 && bCall === 1 && seamDefs === 1,
    'A=' + aCall + ' B=' + bCall + ' defs=' + seamDefs);
  check('B 移出 canAddTreeNodes 数量闸门（源码注释 + 位置在闸门之后）',
    tree.indexOf('数量闸门之外') >= 0 && tree.indexOf("OPERATIONS, 'B')") > tree.indexOf("OPERATIONS, 'A')"));
  check('growStep 消费 picks/growAt（A 的生长）', tree.indexOf('_dec.picks[0].nodeId') >= 0 && tree.indexOf('_dec.growAt') >= 0);
  check('agentSelectOverride 优先消费 B 的 picks[0]/select', tree.indexOf('t._agentDecisionB') >= 0 &&
    tree.indexOf('decB.picks') >= 0);
  check('生长禁止切片：B 之前抽干 _expandSlice', tree.indexOf('grow-slice-unfinished') >= 0);
}

/* ---------- S7 假阳率 ---------- */
function s7_false_positive() {
  console.log('--- S7 假阳率（"只消费 [0] 记 extras" 信号）---');
  const h1 = newHarness();
  const l1 = pickLeaves(h1.tree)[0];
  h1.state.decision = { picks: [{ nodeId: l1.id, back: 0 }] };   // 单元素
  h1.tick(2);
  const sig1 = (h1.tree.stats.ifacePickExtras || 0) > 0 || (h1.tree.stats.ifaceGrowAtExtras || 0) > 0;
  const h2 = newHarness();
  const l2 = pickLeaves(h2.tree)[0];
  h2.state.decision = { growAt: [l2.id] };                       // 单元素旧格式
  h2.tick(2);
  const sig2 = (h2.tree.stats.ifacePickExtras || 0) > 0 || (h2.tree.stats.ifaceGrowAtExtras || 0) > 0;
  const h3 = newHarness();
  h3.VT.reset();
  h3.sb.VantageTreeInterface.Agents.use('rule');                 // 规则模式（无 decide）
  const sig3 = false; // 规则模式没有 _agentDecision，不会有 extras
  check('不该报的 3 局面（单元素 picks / 单元素 growAt / 规则模式）假阳 0/3',
    !sig1 && !sig2 && !sig3, 'sig1=' + sig1 + ' sig2=' + sig2 + ' sig3=' + sig3);
  const h4 = newHarness();
  const l4 = pickLeaves(h4.tree)[0];
  h4.state.decision = { picks: [{ nodeId: l4.id, back: 0 }, { nodeId: l4.id, back: 1 }] };
  h4.tick(2);
  check('该报的 1 局面（2 元素 picks）信号响了（假阴 0）',
    (h4.tree.stats.ifacePickExtras || 0) === 1, 'extras=' + h4.tree.stats.ifacePickExtras);
}

s0(); s1_format(); s2_picks_only_first(); s3_back_bounds(); s4_growat(); s5_selftest_falsegreen(); s6_ab_status(); s7_false_positive();
console.log('\n' + (FAILS ? ('3-3 CONTRACT PROBE FAILED (' + FAILS + '/' + CHECKS + ')') : ('3-3 CONTRACT PROBE PASSED (' + CHECKS + ' checks)')));
process.exitCode = FAILS ? 1 : 0;
